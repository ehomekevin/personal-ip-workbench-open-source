import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Settings } from '../../packages/domain/src/settings/index.ts';
import { Documents } from '../../packages/domain/src/documents/index.ts';
import { setConnectorReference } from '../../packages/storage/src/settings/index.ts';
import { getRevisionRow, getIntent, prepareHumanRevision } from '../../packages/storage/src/revisions/index.ts';
import { ManagedFiles } from '../../packages/storage/src/files/index.ts';
import { sha256 } from '../../packages/storage/src/connection/index.ts';
import { startApplication } from '../../apps/service/src/bootstrap/application.ts';
import type { RunningApplication } from '../../apps/service/src/bootstrap/application.ts';
import type { SettingsResponse, ExecutorHealth } from '../../packages/contracts/src/index.ts';
import { fixture, writeEvidence } from '../documents/harness.ts';

const health = async (): Promise<ExecutorHealth[]> => [{ executor_id: 'codex', status: 'degraded', runtime_version: '26.9.0',
  auth_state: 'secret-canary-auth', billing_route: 'secret-canary-billing', limitations: ['secret-canary-error'] }];
test('设置拒绝悬空链接与不存在子尾部，不改变设置版本或创建目标目录', async () => {
  const f = fixture(); try {
    const settings = new Settings(f.context()); const before = await settings.get(f.request());
    const target = join(f.root, 'missing-target'); const alias = join(f.root, 'dangling-alias'); symlinkSync(target, alias);
    for (const paths of [{ source_vault_root: alias }, { source_vault_root: join(alias, 'child') }, { managed_notes_root: alias }, { media_root: join(alias, 'child') }]) {
      await assert.rejects(settings.patch(f.request(), { expected_version: before.version, paths }), { code: 'VALIDATION_ERROR' });
      assert.deepEqual(await settings.get(f.request()), before); assert.equal(existsSync(target), false);
    }
  } finally { f.cleanup(); }
});
test('settings real HTTP CAS, reload, original receipt replay and secret filtering', async () => {
  const f = fixture(); let app: RunningApplication | undefined;
  try {
    const connector = randomUUID();
    f.context().db.prepare("INSERT INTO connectors (id,workspace_id,kind,capability_status,config_ref,last_error) VALUES (?,?,'x','degraded','secret-canary-config',?)").run(connector, f.config.workspace_id, JSON.stringify({ token: 'secret-canary-token-cookie' }));
    assert.throws(() => setConnectorReference(f.context().db, f.config.workspace_id, connector, 'raw-secret-value'), { code: 'VALIDATION_ERROR' });
    f.closeDb(); app = await startApplication(f.config, { port: 0, executorHealth: health });
    const call = async (method: string, body?: unknown, key: string = randomUUID()) => {
      const response = await fetch(`http://127.0.0.1:${app!.address.port}/api/v1/settings`, { method,
        headers: { 'x-workspace-id': f.config.workspace_id, 'x-service-instance-id': f.config.service_instance_id,
          'idempotency-key': key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json(); return { status: response.status, body: result as SettingsResponse, raw: JSON.stringify(result) };
    };
    const initial = await call('GET'); assert.equal(initial.status, 200); assert.equal(initial.body.paths.source_vault_root, null);
    assert.equal(initial.raw.includes('secret-canary'), false); assert.equal(initial.body.capabilities.find(row=>row.connector_id===connector)?.config_ref, null);
    setConnectorReference(app.context.db, f.config.workspace_id, connector, 'env:WP08_FIXED_TOKEN_NAME');
    const referenced = await call('GET'); assert.equal(referenced.body.capabilities.find(row=>row.connector_id===connector)?.config_ref, 'env:WP08_FIXED_TOKEN_NAME');
    const key = 'settings-original'; const input = { expected_version: initial.body.version, timezone: 'Asia/Shanghai', default_executor: 'claude', api_fallback_enabled: true };
    const changed = await call('PATCH', input, key); assert.equal(changed.status, 200); assert.equal(changed.body.version, initial.body.version + 1);
    assert.equal(changed.body.default_executor, 'claude'); assert.equal(changed.body.api_fallback_enabled, true);
    assert.equal((await call('PATCH', { ...input, timezone: 'UTC' })).status, 409);
    assert.equal((await call('PATCH', { expected_version: changed.body.version, token: 'secret-canary' })).status, 400);
    assert.equal((await call('PATCH', { expected_version: changed.body.version, api_fallback_enabled: 'true' })).status, 400);
    assert.equal((await call('PATCH', { expected_version: changed.body.version, timezone: 'not/a-zone' })).status, 400);
    assert.equal((await call('PATCH', { expected_version: changed.body.version, paths: { state_root: join(f.root, 'other-state') } })).status, 400);
    const later = await call('PATCH', { expected_version: changed.body.version, timezone: 'UTC' }); assert.equal(later.status, 200);
    assert.deepEqual((await call('PATCH', input, key)).body, changed.body);
    assert.equal((await call('PATCH', { ...input, timezone: 'UTC' }, key)).status, 409);
    const previousBoot = app.boot_id; await app.close(); app = await startApplication(f.config, { port: 0, executorHealth: health });
    const refreshed = await call('GET'); assert.equal(refreshed.body.timezone, 'UTC'); assert.equal(refreshed.body.default_executor, 'claude');
    assert.equal(refreshed.body.version, later.body.version); assert.notEqual(app.boot_id, previousBoot);
    writeEvidence('settings-validation.json', { evidence_scope: 'internal_rule', result: 'passed', observed_at: new Date().toISOString(),
      contract_version: '0.1.1', actual_http: true, actual_service_restart: true, source_vault_root: null,
      cases: { get: 200, patch: 200, stale_version: 409, unknown_field: 400, non_boolean: 400, invalid_timezone: 400, state_root_hot_switch: 400,
        same_key_original_receipt: true, different_body_same_key: 409, persisted_reload: true, raw_secret_filtered: true, opaque_reference_only: true },
      initial_version: initial.body.version, final_version: refreshed.body.version, executors: refreshed.body.executors,
      automatic_paid_failover: 'not_implemented/not_authorized', real_executor_auth: 'not_run', settings_ui: 'not_run/WP-10' });
  } finally { await app?.close(); f.cleanup(); }
});

test('paths and timezone change does not move historical revisions; restart reads registered old path', async () => {
  const f = fixture(); let app: RunningApplication | undefined; try {
    f.closeDb(); app = await startApplication(f.config, { port: 0 });
    const documents = new Documents(app.context); const saved = await documents.create(f.request(), { kind: 'note', initial_text: '历史正文保留原位置' });
    const revision = getRevisionRow(app.context.db, f.config.workspace_id, saved.head_revision_id!); const bytes = readFileSync(revision.file_path);
    const pendingDoc = await documents.create(f.request(), { kind: 'note', initial_text: '中断前正文' });
    const pending = prepareHumanRevision(app.context.db, documents.files, f.request(), { document_id: pendingDoc.document_id,
      expected_revision_id: pendingDoc.head_revision_id, text: '改根前已登记的未提交正文' });
    const frozenPath = getIntent(app.context.db, f.config.workspace_id, pending.write_intent_id).path;
    const newNotes = join(f.root, 'future-notes'); const newMedia = join(f.root, 'future-media'); const settings = new Settings(app.context);
    const before = await settings.get(f.request()); const changed = await settings.patch(f.request(), { expected_version: before.version, paths: { managed_notes_root: newNotes, media_root: newMedia }, timezone: 'Asia/Shanghai' });
    assert.equal(changed.paths.managed_notes_root, newNotes); assert.equal(existsSync(newNotes), false); assert.deepEqual(readFileSync(revision.file_path), bytes);
    await assert.rejects(settings.patch(f.request(), { expected_version: changed.version, paths: { source_vault_root: f.config.paths.managed_notes_root } }), { code: 'VALIDATION_ERROR' });
    assert.equal((await settings.get(f.request())).paths.source_vault_root, null);
    const next = await documents.save(f.request(), saved.document_id, { expected_revision_id: saved.head_revision_id, text: '新目录中的新修订', origin: 'human' });
    assert.ok(getRevisionRow(app.context.db, f.config.workspace_id, next.revision_id).file_path.startsWith(newNotes));
    await app.close(); app = await startApplication(f.config, { port: 0 });
    const snapshot = await new Documents(app.context).get(f.request(), saved.document_id); assert.equal(snapshot.text, '新目录中的新修订');
    const currentRow = getRevisionRow(app.context.db, f.config.workspace_id, saved.head_revision_id!); assert.equal(currentRow.file_path, revision.file_path);
    const oldRead = new ManagedFiles(app.context.paths).readRevision(currentRow.file_path, currentRow.sha256 as ReturnType<typeof sha256>,
      { workspace_id: currentRow.workspace_id, document_id: currentRow.document_id, revision_id: currentRow.id });
    assert.ok(oldRead.content.endsWith('历史正文保留原位置')); assert.deepEqual(readFileSync(revision.file_path), bytes);
    const restoredPending = await new Documents(app.context).get(f.request(), pendingDoc.document_id);
    assert.equal(restoredPending.text, '改根前已登记的未提交正文'); assert.equal(restoredPending.head_revision_id, pending.revision_id);
    assert.equal(getRevisionRow(app.context.db, f.config.workspace_id, pending.revision_id).file_path, frozenPath);
    assert.ok(frozenPath.startsWith(f.config.paths.managed_notes_root));
    const restored = await new Documents(app.context).restore(f.request(), saved.document_id, { expected_revision_id: next.revision_id, revision_id: saved.head_revision_id! });
    assert.equal((await new Documents(app.context).get(f.request(), saved.document_id)).text, '历史正文保留原位置');
    assert.notEqual(restored.revision_id, saved.head_revision_id);
    writeEvidence('settings-path-preservation.json', { evidence_scope: 'internal_rule', result: 'passed', observed_at: new Date().toISOString(),
        old_revision_path: revision.file_path.replace(f.root, '<isolated-test-root>'), old_hash: sha256(bytes), registered_path_unchanged: true,
        old_file_unchanged: true, new_revision_uses_new_root_before_restart: true, actual_restart: true, history_move: false,
        source_vault_root: null, pending_before_patch_resumed_at_frozen_path: true, old_revision_restores_to_new_revision: true });
  } finally { await app?.close(); f.cleanup(); }
});
