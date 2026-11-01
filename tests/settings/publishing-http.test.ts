import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startApplication, type RunningApplication } from '../../apps/service/src/bootstrap/application.ts';
import type { ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { assertExternalVolume } from '../../scripts/probes/runtime/mount-guard.ts';

async function fixture() {
  const evidence = resolve('.ci-artifacts/pset-03/http'); assertExternalVolume(resolve(import.meta.dirname, '../..')); mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, '.runtime-')), w = randomUUID(), s = randomUUID();
  const config: ServiceConfiguration = { workspace_id: w, service_instance_id: s, title: 'PSET03 隔离 HTTP', mode: 'demo', timezone: 'UTC', paths: { state_root: join(root, 'state'), managed_notes_root: join(root, 'notes'), media_root: join(root, 'media'), source_vault_root: null }, listen: { host: '127.0.0.1', port: 4318 } };
  const names = ['WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON', 'WORKBENCH_PUBLISHERS_IMPORT_LEGACY', 'PSET_TEST_TOKEN', 'PSET_SECOND_TOKEN'] as const;
  const original = names.map(name => [name, process.env[name]] as const);
  process.env.WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON = '["PSET_TEST_TOKEN","PSET_SECOND_TOKEN"]';
  delete process.env.WORKBENCH_PUBLISHERS_IMPORT_LEGACY; process.env.PSET_TEST_TOKEN = 'PRIVATE_HTTP_SENTINEL'; process.env.PSET_SECOND_TOKEN = 'PRIVATE_SECOND_SENTINEL';
  let app: RunningApplication | undefined;
  try { app = await startApplication(config, { port: 0, executorHealth: async () => [] }); }
  catch (error) { for (const [name, value] of original) if (value === undefined) delete process.env[name]; else process.env[name] = value; rmSync(root, { recursive: true, force: true }); throw error; }
  const owner = randomUUID();
  app.context.db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'wechat','test-app-id','owner','测试公众号','https://mp.weixin.qq.com/','confirmed')").run(owner, w);
  const identity = app.identity;
  return { owner, identity, config, get app() { return app!; }, async restart() { await app!.close(); app = await startApplication(config, { port: 0, executorHealth: async () => [] }); }, async request(method: string, path = '', body?: unknown, key = randomUUID(), headers: Record<string, string> = {}) {
    const result = await fetch('http://127.0.0.1:' + app!.address.port + '/api/v1/settings/publishing' + path, { method, headers: { 'content-type': 'application/json', 'x-workspace-id': w, 'x-service-instance-id': s, ...(method === 'GET' ? {} : { 'idempotency-key': key }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await result.text(); assert.ok(!text.includes('PRIVATE_HTTP_SENTINEL') && !text.includes('PRIVATE_SECOND_SENTINEL')); return { status: result.status, data: JSON.parse(text) };
  }, async cleanup() { try { await app?.close(); } finally { for (const [name, value] of original) if (value === undefined) delete process.env[name]; else process.env[name] = value; rmSync(root, { recursive: true, force: true }); } } };
}
const ref = { kind: 'environment', name: 'PSET_TEST_TOKEN' };

test('七项 HTTP 接口共用 SQLite：保存、生效、检查、默认、启停和重启 pending', async () => {
  const f = await fixture(); try {
    const initial = await f.request('GET'); assert.equal(initial.status, 200); assert.equal(initial.data.config_source, 'sqlite'); assert.equal(initial.data.version, 1); assert.deepEqual(initial.data.connections, []);
    const body = { expected_version: 1, account_id: f.owner, platform: 'wechat', route: 'wechat_official', credential_ref: ref }, key = randomUUID();
    const created = await f.request('POST', '/connections', body, key); assert.equal(created.status, 200); const id = created.data.connection.id;
    assert.equal(created.data.connection.enabled, false); assert.equal(created.data.connection.config_revision, 1); assert.equal(created.data.connection.runtime.active_config_revision, null);
    const replay = await f.request('POST', '/connections', body, key); assert.deepEqual(replay.data, created.data);
    assert.equal((await f.request('POST', '/connections', { ...body, expected_version: 2 }, key)).data.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await f.request('PUT', '/connections/' + id + '/enabled', { expected_version: 1, enabled: true })).data.error.code, 'CAPABILITY_UNVERIFIED');
    const applied = await f.request('POST', '/connections/' + id + '/apply', { expected_version: 1 }); assert.equal(applied.status, 200); assert.equal(applied.data.connection.runtime.state, 'active'); assert.equal(applied.data.connection.runtime.active_config_revision, 1); assert.ok(applied.data.connection.capabilities.every((c: { status: string }) => c.status !== 'supported'));
    const checked = await f.request('POST', '/connections/' + id + '/check', { expected_version: 1 }); assert.equal(checked.status, 200); assert.equal(checked.data.check.readonly, true); assert.equal(checked.data.check.identity, 'unavailable'); assert.equal(checked.data.applied_to_current, true);
    const enabled = await f.request('PUT', '/connections/' + id + '/enabled', { expected_version: 1, enabled: true }); assert.equal(enabled.status, 200); assert.equal(enabled.data.connection.version, 2);
    const noOp = await f.request('PUT', '/connections/' + id + '/enabled', { expected_version: 2, enabled: true }); assert.equal(noOp.data.connection.version, 2); assert.equal(noOp.data.settings_version, enabled.data.settings_version);
    const defaults = await f.request('PUT', '/defaults', { expected_version: enabled.data.settings_version, platform: 'wechat', format: 'article', account_id: f.owner }); assert.equal(defaults.status, 200); assert.equal(defaults.data.defaults[0].account_id, f.owner);
    const unchanged = await f.request('PUT', '/defaults', { expected_version: defaults.data.version, platform: 'wechat', format: 'article', account_id: f.owner }); assert.equal(unchanged.data.version, defaults.data.version);
    const patched = await f.request('PATCH', '/connections/' + id, { expected_version: 2, credential_ref: { kind: 'environment', name: 'PSET_SECOND_TOKEN' } }); assert.equal(patched.status, 200); assert.equal(patched.data.connection.config_revision, 2); assert.equal(patched.data.connection.runtime.state, 'pending'); assert.equal(patched.data.connection.runtime.active_config_revision, 1);
    assert.equal((await f.request('PATCH', '/connections/' + id, { expected_version: 2, credential_ref: null })).data.error.code, 'VERSION_CONFLICT');
    await f.restart();
    const restarted = await f.request('GET'); assert.equal(restarted.data.connections[0].config_revision, 2); assert.equal(restarted.data.connections[0].runtime.active_config_revision, 1); assert.equal(restarted.data.connections[0].runtime.state, 'pending'); assert.equal(restarted.data.defaults[0].account_id, f.owner);
    const disabled = await f.request('PUT', '/connections/' + id + '/enabled', { expected_version: 3, enabled: false }); assert.equal(disabled.status, 200); assert.equal(disabled.data.connection.enabled, false);
    const cleared = await f.request('PUT', '/defaults', { expected_version: disabled.data.settings_version, platform: 'wechat', format: 'article', account_id: null }); assert.equal(cleared.status, 200); assert.deepEqual(cleared.data.defaults, []);
  } finally { await f.cleanup(); }
});

test('HTTP 拒绝错服务、对标、异工作区与秘密字段，读取不重建绑定', async () => {
  const f = await fixture(); try {
    assert.equal((await f.request('GET', '', undefined, randomUUID(), { 'x-workspace-id': randomUUID() })).data.error.code, 'WORKSPACE_INSTANCE_MISMATCH');
    const body = { expected_version: 1, account_id: f.owner, platform: 'wechat', route: 'wechat_official', credential_ref: ref };
    assert.equal((await f.request('POST', '/connections', body, randomUUID(), { 'x-service-instance-id': randomUUID() })).data.error.code, 'WORKSPACE_INSTANCE_MISMATCH');
    assert.equal((await f.request('POST', '/connections', { ...body, token: 'PRIVATE_HTTP_SENTINEL' })).data.error.code, 'VALIDATION_ERROR');
    assert.equal((await f.request('POST', '/connections', { ...body, credential_ref: { kind: 'environment', name: 'UNDECLARED_TOKEN' } })).data.error.code, 'VALIDATION_ERROR');
    assert.equal((await f.request('POST', '/connections', { ...body, account_id: 'foreign-account' })).data.error.code, 'NOT_FOUND');
    f.app.context.db.prepare("UPDATE accounts SET role='benchmark' WHERE id=?").run(f.owner);
    const benchmark = await f.request('POST', '/connections', body); assert.equal(benchmark.status, 422); assert.equal(benchmark.data.error.code, 'CAPABILITY_UNVERIFIED');
    f.app.context.db.prepare("UPDATE accounts SET role='owner',identity_status='unverified' WHERE id=?").run(f.owner);
    assert.equal((await f.request('POST', '/connections', body)).data.error.code, 'CAPABILITY_UNVERIFIED');
    assert.equal(f.app.context.db.prepare('SELECT count(*) AS n FROM publishing_connections').get()!.n, 0);
    assert.equal(f.app.context.db.prepare('SELECT count(*) AS n FROM publication_intents').get()!.n, 0);
    assert.equal(f.app.context.db.prepare('SELECT count(*) AS n FROM publication_attempts').get()!.n, 0);
  } finally { await f.cleanup(); }
});
