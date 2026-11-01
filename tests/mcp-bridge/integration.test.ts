import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ContractError, type JsonObject } from '../../packages/contracts/src/index.ts';
import { resolveWorkbenchRoute, WORKBENCH_RESOURCE_URI, MCP_TOOL_INVENTORY, BUSINESS_RESOURCE_PREFIX } from '../../packages/host-bridge/src/core/tools.ts';
import { fixture, call, checked, evidence } from './harness.ts';

test('真实 HTTP / SQLite / Markdown 与多 stdio MCP 共享状态', async t => {
  const f = await fixture();
  try {
    const a = await f.connect(), b = await f.connect();
    const originalBoot = f.app.boot_id;
    const created = await call(a, 'create_document', { kind: 'wiki', initial_text: '初始固定正文', idempotency_key: 'document-create' });
    assert.equal(created.result.isError, undefined);
    const documentId = String(created.data.document_id), initialRevision = String(created.data.head_revision_id);
    await t.test('工具清单、原型资源、受限 mapper 与不可伪造观察', async () => checked('inventory-resources-route-boundaries', async () => {
      const list = await a.client.listTools();
      assert.equal(list.tools.length, MCP_TOOL_INVENTORY.length);
      for (const tool of list.tools) { assert.ok(tool.inputSchema); assert.ok(tool.outputSchema); assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean'); }
      assert.ok(!list.tools.some(tool => /observer|renew|binding|proxy|sql/.test(tool.name)));
      const ui = await a.client.readResource({ uri: WORKBENCH_RESOURCE_URI });
      assert.equal(ui.contents[0]!.mimeType, 'text/html;profile=mcp-app');
      assert.ok('text' in ui.contents[0]!);
      assert.equal((await call(a, 'open_workbench', { page: 'create', topic_id: randomUUID() })).error?.code, 'NOT_FOUND');
      const opened = await call(a, 'open_workbench', { page: 'today' }); assert.equal(opened.data.resource_uri, WORKBENCH_RESOURCE_URI);
      assert.equal((opened.data.capabilities as JsonObject[]).find(cap => cap.operation === 'native_task_tracking')!.status, 'unverified');
      assert.throws(() => resolveWorkbenchRoute('POST', '/api/v1/host-task-observers', {}, {}), e => e instanceof ContractError && e.code === 'CAPABILITY_UNVERIFIED');
      assert.throws(() => resolveWorkbenchRoute('GET', 'https://example.com', undefined), e => e instanceof ContractError);
      assert.throws(() => resolveWorkbenchRoute('GET', '/api/v1/documents/a%2Fb', undefined), e => e instanceof ContractError);
      assert.throws(() => resolveWorkbenchRoute('GET', '/api/v1/topics?secret=x', undefined), e => e instanceof ContractError);
      assert.equal((await call(a, 'register_observer', {})).error?.code, 'CAPABILITY_UNVERIFIED');
      assert.equal((await call(a, 'patch_settings', { expected_version: 1, paths: { state_root: '/tmp/other' }, idempotency_key: randomUUID() })).error?.code, 'VALIDATION_ERROR');
      evidence('tool-resource-inventory.json', { scope: 'internal_rule', tools: list.tools, resources: (await a.client.listResources()).resources, templates: (await a.client.listResourceTemplates()).resourceTemplates, real_hosts: 'not_run' });
    }));
    await t.test('并发 expected revision、跨入口读回、不可变 Markdown', async () => checked('multi-client-revision-conflict', async () => {
      const responses = await Promise.all([call(a, 'save_document', { id: documentId, expected_revision_id: initialRevision, text: '入口 A 保存', origin: 'human', idempotency_key: 'save-a' }), call(b, 'save_document', { id: documentId, expected_revision_id: initialRevision, text: '入口 B 保存', origin: 'human', idempotency_key: 'save-b' })]);
      assert.equal(responses.filter(r => !r.result.isError).length, 1);
      assert.equal(responses.find(r => r.result.isError)?.error?.code, 'REVISION_CONFLICT');
      assert.ok(responses.find(r => r.result.isError)?.error?.request_id);
      const head = (await call(b, 'get_document', { id: documentId })).data;
      const committed = responses.find(r => !r.result.isError)!;
      assert.equal(head.head_revision_id, committed.data.revision_id);
      const revision = f.app.context.db.prepare('SELECT file_path,sha256 FROM document_revisions WHERE id=?').get(String(head.head_revision_id))!;
      const markdown = readFileSync(String(revision.file_path), 'utf8'); assert.ok(markdown.includes(String(head.text)));
      const resource = await a.client.readResource({ uri: BUSINESS_RESOURCE_PREFIX + 'documents/' + documentId + '/revisions/' + head.head_revision_id });
      assert.ok('text' in resource.contents[0]! && resource.contents[0].text.includes(String(head.text)));
      evidence('shared-state-integration.json', { scope: 'internal_rule', identity: f.app.identity, mcp_process_count: 2, service_boot_id: originalBoot, database_count: 1, responses, head, markdown_hash: revision.sha256 });
    }));
    await t.test('跨客户端幂等、重连和同一主服务重启', async () => checked('idempotency-reconnect-service-restart', async () => {
      const replay = await call(b, 'create_document', { kind: 'wiki', initial_text: '初始固定正文', idempotency_key: 'document-create' });
      assert.deepEqual(replay.data, created.data);
      assert.equal((await call(a, 'create_document', { kind: 'wiki', initial_text: '不同正文', idempotency_key: 'document-create' })).error?.code, 'IDEMPOTENCY_CONFLICT');
      await a.client.close(); const reconnected = await f.connect();
      assert.equal((await call(reconnected, 'get_document', { id: documentId })).identity.workspace_id, f.config.workspace_id);
      assert.equal(f.app.boot_id, originalBoot);
      const before = (await call(b, 'get_document', { id: documentId })).data;
      await f.restart(); assert.notEqual(f.app.boot_id, originalBoot);
      assert.deepEqual((await call(b, 'get_document', { id: documentId })).data, before);
      assert.equal(Number(f.app.context.db.prepare('SELECT COUNT(*) n FROM documents').get()!.n), 1);
      assert.equal(f.app.context.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    }));
    await t.test('实际素材字节经 MCP 与既有 multipart API 传输并核对 hash', async () => checked('media-upload-resource-real-file-hash', async () => {
      const bytes = Buffer.from('WP23 用户选择的本地素材文件\n', 'utf8'), sha256 = createHash('sha256').update(bytes).digest('hex');
      const input = { filename: 'source-note.txt', mime_type: 'text/plain', base64: bytes.toString('base64'), sha256, purpose: 'isolated internal_rule media transfer', idempotency_key: 'upload-user-file' };
      const uploaded = await call(b, 'upload_asset', input); assert.equal(uploaded.result.isError, undefined);
      assert.equal(uploaded.data.sha256, sha256);
      const replay = await call(b, 'upload_asset', input); assert.equal(replay.data.asset_id, uploaded.data.asset_id);
      const resource = await b.client.readResource({ uri: BUSINESS_RESOURCE_PREFIX + 'assets/' + uploaded.data.asset_id + '/content' });
      assert.ok('blob' in resource.contents[0]!); assert.equal(Buffer.from((resource.contents[0] as { blob: string }).blob, 'base64').toString('utf8'), bytes.toString('utf8'));
      assert.equal((await call(b, 'upload_asset', { ...input, sha256: '0'.repeat(64), idempotency_key: 'bad-hash' })).error?.code, 'VALIDATION_ERROR');
      assert.equal((await call(b, 'upload_asset', { ...input, filename: '../note.txt', idempotency_key: 'bad-path' })).error?.code, 'VALIDATION_ERROR');
      evidence('media-transfer-integration.json', { scope: 'internal_rule', upload_result: uploaded.data, resource_sha256: sha256, input_bytes: bytes.length, actual_host_file_upload: 'unverified', actual_host_media_preview: 'unverified' });
    }));
    await t.test('错误主服务/工作区/契约版本拒绝', async () => checked('wrong-service-identity-rejected', async () => {
      await assert.rejects(f.connect({ identity: { ...f.app.identity, service_instance_id: randomUUID() } }));
      await assert.rejects(f.connect({ identity: { ...f.app.identity, workspace_id: randomUUID() } }));
      await assert.rejects(f.connect({ identity: { ...f.app.identity, contract_version: 'obsolete' } as never }));
      const http = await f.http('POST', '/api/v1/documents', { kind: 'wiki', initial_text: '不可写' }, { 'X-Service-Instance-Id': randomUUID() }); assert.equal(http.body.error && (http.body.error as JsonObject).code, 'WORKSPACE_INSTANCE_MISMATCH');
      assert.equal(Number(f.app.context.db.prepare('SELECT COUNT(*) n FROM documents').get()!.n), 1);
      evidence('service-identity-tests.json', { scope: 'internal_rule', result: 'passed', identity: f.app.identity, tested: ['service_instance_id', 'workspace_id', 'contract_version', 'HTTP mutation identity'], rejected_write_count: 4 });
    }));
    await t.test('已接线 WP11/12/14/16/19/20 正式边界', async () => checked('existing-business-http-boundaries', async () => {
      for (const tool of ['list_sources', 'list_source_records', 'list_works', 'get_overview', 'list_retro_reports', 'list_knowledge', 'list_schedules', 'list_publication_intents']) assert.equal((await call(b, tool, {})).result.isError, undefined, tool);
      assert.equal((await call(b, 'get_artifact', { id: randomUUID() })).error?.code, 'NOT_FOUND');
      assert.equal((await call(b, 'get_candidate', { id: randomUUID() })).error?.code, 'NOT_FOUND');
      const generate = await call(b, 'service_modify_document', { id: documentId, base_revision_id: String((await call(b, 'get_document', { id: documentId })).data.head_revision_id), source_ids: [], instruction: '显式服务委托', executor: 'codex', idempotency_key: 'service-only' });
      assert.equal(generate.result.isError, undefined);
      const job = ((await call(b, 'get_job', { id: String(generate.data.job_id) })).data.job as JsonObject);
      assert.equal(job.execution_mode, 'service_adapter');
      assert.notEqual(job.state, 'succeeded', 'queued delegation is not provider success');
      assert.equal(Number(f.app.context.db.prepare("SELECT COUNT(*) n FROM jobs WHERE execution_mode='host_session'").get()!.n), 0);
    }));
  } finally { await f.cleanup(); }
});
