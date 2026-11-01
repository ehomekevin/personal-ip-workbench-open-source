import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTRACT_VERSION, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { configureDatabase, migrateDatabase } from '../../packages/storage/src/connection/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';
import type { PublishingRuntimeSnapshot } from '../../packages/domain/src/publishing-settings/runtime.ts';
import { createPublishingRuntime, readLegacyPublishingImport, guardPublishingTransport } from '../../apps/service/src/bootstrap/publishing-runtime.ts';
import { X_PUBLISHER_VERSION } from '../../packages/adapters/src/publishers/x/index.ts';

function fixture() {
  const db = new DatabaseSync(':memory:'); configureDatabase(db); migrateDatabase(db);
  const w = randomUUID(), s = randomUUID(), root = mkdtempSync(join(tmpdir(), 'pset03-runtime-'));
  const paths = { state_root: join(root, 'state'), media_root: join(root, 'media'), managed_notes_root: join(root, 'notes'), source_vault_root: null };
  const config: ServiceConfiguration = { workspace_id: w, service_instance_id: s, title: '配置测试', timezone: 'UTC', mode: 'demo', paths, listen: { host: '127.0.0.1', port: 4318 } };
  db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,?,?,?,?,1)').run(w,w,'配置测试','UTC',JSON.stringify(paths),'demo');
  db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES ('owner-x',?,'x','123','owner','测试本人','https://x.com/test','confirmed')").run(w);
  const context: ApplicationContext = { db, config, paths, identity: { workspace_id: w, service_instance_id: s, contract_version: CONTRACT_VERSION }, getExecutorHealth: async () => [] };
  const snapshot: PublishingRuntimeSnapshot = { workspace_id: w, connection_id: 'connection-x', connection_version: 1, config_revision: 1, account_id: 'owner-x', platform_account_id: '123', platform: 'x', route: 'x_v2', credential_ref: { kind: 'environment', name: 'X_TOKEN' }, capabilities: [] };
  return { context, snapshot, root, cleanup() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('启动拒绝畸形引用名单，只访问显式名称并固定 resolver', () => {
  const f = fixture(); try {
    for (const raw of ['', 'null', '{}', '["X_TOKEN","X_TOKEN"]', '["_TOKEN"]', '["X_TOKEN",1]']) assert.throws(() => createPublishingRuntime(f.context, { env: { WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON: raw } }), { code: 'VALIDATION_ERROR' });
    const accesses: string[] = [], env = new Proxy({ WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON: '["X_TOKEN"]', X_TOKEN: 'PRIVATE_SENTINEL' }, { get(target, key: string) { accesses.push(key); return target[key as keyof typeof target]; }, ownKeys() { throw new Error('environment_enumeration_forbidden'); } });
    const runtime = createPublishingRuntime(f.context, { env });
    assert.deepEqual(accesses, ['WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON', 'WORKBENCH_LOCAL_SETTINGS_ENABLED', 'X_TOKEN']);
    env.X_TOKEN = 'CHANGED_VALUE';
    assert.equal(runtime.credentialReady(f.snapshot.credential_ref), true);
    assert.equal(runtime.credentialReady({ kind: 'environment', name: 'OTHER_TOKEN' }), false);
    const candidate = runtime.hydrate(f.snapshot); assert.equal(candidate.bindings.length, 2); assert.ok(candidate.bindings.every(b => !b.supported));
    assert.ok(!JSON.stringify(runtime.credentialReferences).includes('PRIVATE_SENTINEL'));
    assert.deepEqual(accesses, ['WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON', 'WORKBENCH_LOCAL_SETTINGS_ENABLED', 'X_TOKEN']);
    assert.deepEqual(createPublishingRuntime(f.context, { env: {} }).credentialReferences, []);
  } finally { f.cleanup(); }
});

test('公众号私有引用仅用于绑定账号与官方路线，认证通过也不提升发布能力', async () => {
  const f = fixture(); try {
    mkdirSync(join(f.context.paths.state_root, 'private-credentials'), { recursive: true, mode: 0o700 });
    const path = join(realpathSync(f.context.paths.state_root), 'private-credentials/wechat.json'), appId = 'wx1111111111111111';
    const config = { schema_version: 1, workspace_id: f.context.identity.workspace_id, account_id: 'owner-x', canonical_url: 'https://mp.weixin.qq.com/s/fixture', app_id: appId, app_secret: 'A'.repeat(32), proxy: { address: 'http://proxy.example.invalid:8443', username: 'fixture', password: 'PRIVATE_PROXY_PASSWORD' } };
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    f.context.db.prepare("UPDATE accounts SET platform='wechat',platform_account_id=?,canonical_url=? WHERE id='owner-x'").run(appId, config.canonical_url);
    let calls = 0;
    const runtime = createPublishingRuntime(f.context, { env: { WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON: '["WORKBENCH_WECHAT_CREDENTIALS"]', WORKBENCH_WECHAT_CREDENTIALS: path }, fetcher: async () => { calls++; return new Response(JSON.stringify({ access_token: 'PRIVATE_SHORT_TOKEN', expires_in: 7200 })); } });
    const snapshot = { ...f.snapshot, platform: 'wechat' as const, route: 'wechat_official' as const, platform_account_id: appId, credential_ref: { kind: 'environment' as const, name: 'WORKBENCH_WECHAT_CREDENTIALS' } };
    assert.equal(runtime.credentialReady(snapshot.credential_ref), true);
    const bindings = runtime.hydrate(snapshot).bindings; assert.equal(bindings.length, 1); assert.equal(bindings[0]!.supported, false);
    const checked = await runtime.check(snapshot); assert.equal(checked.identity, 'passed'); assert.equal(checked.permissions, 'unavailable'); assert.equal(calls, 1);
    assert.equal(runtime.hydrate(snapshot).bindings[0]!.supported, false);
    assert.equal((await runtime.check({ ...snapshot, platform: 'x', route: 'x_v2' })).identity, 'failed'); assert.equal(calls, 1);
    config.account_id = 'other-account'; writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    assert.throws(() => runtime.hydrate(snapshot), { code: 'CAPABILITY_UNVERIFIED' }); assert.equal(calls, 1);
    assert.ok(!JSON.stringify(checked).includes('PRIVATE_SHORT_TOKEN'));
  } finally { f.cleanup(); }
});

test('只读身份检查固定 GET endpoint，无提交权限推断、无原始 provider 数据', async () => {
  const f = fixture(); try {
    const calls: { url: string; init: RequestInit }[] = [];
    const runtime = createPublishingRuntime(f.context, { env: { WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON: '["X_TOKEN"]', X_TOKEN: 'PRIVATE_SENTINEL' }, fetcher: async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(JSON.stringify({ data: { id: '123', name: 'PRIVATE_SENTINEL' } }), { status: 200 }); } });
    const result = await runtime.check(f.snapshot);
    assert.equal(result.identity, 'passed'); assert.equal(result.reachability, 'passed'); assert.equal(result.permissions, 'unavailable');
    assert.equal(calls.length, 1); assert.equal(calls[0]!.url, 'https://api.x.com/2/users/me'); assert.equal(calls[0]!.init.method, 'GET'); assert.equal(calls[0]!.init.redirect, 'error'); assert.equal(calls[0]!.init.body, undefined);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
    for (const [platform, route] of [['wechat', 'wechat_official'], ['douyin', 'douyin_open']] as const) {
      const unavailable = await runtime.check({ ...f.snapshot, platform, route });
      assert.equal(unavailable.identity, 'unavailable'); assert.equal(unavailable.permissions, 'unavailable'); assert.equal(unavailable.reachability, 'unavailable'); assert.equal(calls.length, 1);
    }
    const missing = await runtime.check({ ...f.snapshot, credential_ref: null }); assert.equal(missing.reachability, 'unavailable'); assert.equal(calls.length, 1);
  } finally { f.cleanup(); }
});

test('已尝试的X额度/服务错误限制连接；计划中的unavailable与HTTP身份拒绝分别记录', async () => {
  const f = fixture(); try {
    for (const status of [429, 500, 503]) {
      const runtime = createPublishingRuntime(f.context, { env: { WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON: '["X_TOKEN"]', X_TOKEN: 'PRIVATE_SENTINEL' }, fetcher: async (_url, init) => {
        assert.equal(init?.method, 'GET'); return new Response(JSON.stringify({ error: 'PRIVATE_SENTINEL' }), { status });
      } });
      const check = await runtime.check(f.snapshot);
      assert.equal(check.identity, 'unavailable'); assert.equal(check.permissions, 'unavailable'); assert.equal(check.reachability, 'failed');
      assert.ok(check.limitations.length); assert.ok(!JSON.stringify(check).includes('PRIVATE_SENTINEL'));
    }
    for (const status of [401, 403]) {
      const runtime = createPublishingRuntime(f.context, { env: { WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON: '["X_TOKEN"]', X_TOKEN: 'PRIVATE_SENTINEL' }, fetcher: async () => new Response('{}', { status }) });
      const check = await runtime.check(f.snapshot);
      assert.equal(check.identity, 'failed'); assert.equal(check.permissions, 'failed'); assert.equal(check.reachability, 'passed');
    }
  } finally { f.cleanup(); }
});

test('查询失败和身份不符均脱敏，不刷新授权、不把读取成功当作发布成功', async () => {
  const f = fixture(); try {
    for (const scenario of ['mismatch', 'forbidden', 'network', 'large']) {
      const runtime = createPublishingRuntime(f.context, { env: { WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON: '["X_TOKEN"]', X_TOKEN: 'PRIVATE_SENTINEL' }, fetcher: async () => {
        if (scenario === 'network') throw new Error('PRIVATE_SENTINEL');
        return new Response(scenario === 'large' ? 'A'.repeat(65537) : JSON.stringify({ data: { id: '999' }, error: 'PRIVATE_SENTINEL' }), { status: scenario === 'forbidden' ? 403 : 200 });
      } });
      const result = await runtime.check(f.snapshot); assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL')); assert.notEqual(result.identity, 'passed'); assert.notEqual(result.permissions, 'passed');
    }
  } finally { f.cleanup(); }
});

test('旧格式导入固定文件快照、合并同账号形式，supported只保留诊断声明', () => {
  const f = fixture(); try {
    const runtime = createPublishingRuntime(f.context, { env: { WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON: '["X_TOKEN","OTHER_TOKEN"]', X_TOKEN: 'PRIVATE_SENTINEL' } });
    const entry = (format: string, name = 'X_TOKEN') => ({ platform: 'x', adapter_version: X_PUBLISHER_VERSION, account: { account_id: 'owner-x', platform_account_id: '123', format, host_id: 'historical-host', identity_evidence_ref: 'historical-identity' }, credential_env: name, capabilities: ['prepareDraft', 'submit', 'queryResult'].map(operation => ({ operation, status: 'supported', evidence_kind: 'real_platform', evidence_ref: 'historical-proof', verified_at: '2026-10-10T12:00:00.000Z' })) });
    const file = join(f.root, 'legacy.json'), config = { config_version: 1, identity: f.context.identity, publishers: [entry('text'), entry('thread')] };
    writeFileSync(file, JSON.stringify(config));
    assert.equal(readLegacyPublishingImport(f.context, runtime, { WORKBENCH_PUBLISHERS_CONFIG_PATH: file }), undefined);
    const env = { WORKBENCH_PUBLISHERS_IMPORT_LEGACY: '1', WORKBENCH_PUBLISHERS_CONFIG_PATH: file }, imported = readLegacyPublishingImport(f.context, runtime, env)!;
    assert.equal(imported.connections.length, 1); assert.match(imported.sha256, /^[a-f0-9]{64}$/); assert.equal(imported.connections[0]!.credential_ref!.name, 'X_TOKEN');
    assert.ok(!JSON.stringify(imported).includes('PRIVATE_SENTINEL')); assert.ok(!JSON.stringify(imported).includes('historical-proof'));
    config.publishers[1] = entry('thread', 'OTHER_TOKEN'); writeFileSync(file, JSON.stringify(config)); assert.throws(() => readLegacyPublishingImport(f.context, runtime, env), { code: 'VALIDATION_ERROR' });
    config.publishers = [entry('text', 'UNDECLARED_TOKEN')]; writeFileSync(file, JSON.stringify(config)); assert.throws(() => readLegacyPublishingImport(f.context, runtime, env), { code: 'VALIDATION_ERROR' });
    assert.throws(() => readLegacyPublishingImport(f.context, runtime, { ...env, WORKBENCH_PUBLISHERS_CONFIG_PATH: 'relative.json' }), { code: 'VALIDATION_ERROR' });
  } finally { f.cleanup(); }
});


test('每个厂商写请求即时门控，停用后多步骤后续POST被拒；POST只读查询仍可恢复', async () => {
  const f = fixture(); try {
    for (const [route, format, writes, reads] of [
      ['x_v2', 'text', ['create_post'], ['lookup_post']],
      ['wechat_official', 'article', ['material/add_material?type=image', 'media/uploadimg', 'draft/add', 'freepublish/submit'], ['draft/get', 'freepublish/get']],
      ['douyin_open', 'short_video', ['upload_video', 'create_video'], ['video_basic_info']],
    ] as const) {
      const calls: string[] = [], guards: string[] = []; let enabled = true;
      const transport = guardPublishingTransport({ evidence_kind: 'internal_rule', async request(request) { calls.push(request.operation); return { status: 200, payload: {} }; } }, { ...f.snapshot, route, beforeExternalWrite(actualFormat, operation) { guards.push(actualFormat + ':' + operation); if (!enabled) throw new Error('disabled'); } }, format);
      const request = (operation: string, method: 'GET' | 'POST' = 'POST') => ({ operation, method, url: 'https://official-fixture.invalid', headers: {}, signal: new AbortController().signal });
      await transport.request(request(writes[0])); assert.equal(calls.length, 1); assert.equal(guards.length, 1);
      enabled = false;
      for (const operation of writes) assert.throws(() => transport.request(request(operation)), /disabled/);
      for (const operation of reads) await transport.request(request(operation, route === 'x_v2' ? 'GET' : 'POST'));
      assert.equal(calls.length, 1 + reads.length); assert.equal(guards.length, 1 + writes.length);
      for (const unknown of ['unknown_write', 'constructor', 'toString']) assert.throws(() => transport.request(request(unknown)), { code: 'CAPABILITY_UNSUPPORTED' });
    }
    const noGuard = guardPublishingTransport({ evidence_kind: 'internal_rule', async request() { throw new Error('must_not_call'); } }, f.snapshot, 'text');
    assert.throws(() => noGuard.request({ operation: 'create_post', method: 'POST', url: 'https://official-fixture.invalid', headers: {}, signal: new AbortController().signal }), { code: 'CAPABILITY_UNVERIFIED' });
  } finally { f.cleanup(); }
});
