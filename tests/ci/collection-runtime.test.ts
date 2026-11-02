import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION } from '../../packages/contracts/src/index.ts';
import { configureDatabase, migrateDatabase } from '../../packages/storage/src/connection/index.ts';
import { TikHubAdapter } from '../../packages/adapters/src/tikhub/index.ts';
import { AccountChecks } from '../../packages/domain/src/sources/account-checks.ts';
import { readCollectionTargets, createCollectionRuntime } from '../../apps/service/src/bootstrap/collection-runtime.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';

const artifactRoot = fileURLToPath(new URL('../../.ci-artifacts/', import.meta.url));
function fixture() {
  const db = new DatabaseSync(':memory:'); configureDatabase(db); migrateDatabase(db);
  const root = mkdtempSync(join(process.platform === 'darwin' ? artifactRoot : tmpdir(), 'collection-'));
  const identity = { workspace_id: randomUUID(), service_instance_id: randomUUID(), contract_version: CONTRACT_VERSION };
  const paths = { state_root: root, media_root: join(root, 'media'), managed_notes_root: join(root, 'notes'), source_vault_root: null };
  db.prepare("INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,'test','UTC',?,'demo',1)").run(identity.workspace_id, identity.workspace_id, JSON.stringify(paths));
  db.prepare("INSERT INTO accounts(id,workspace_id,platform,role,name,canonical_url,identity_status) VALUES ('owner',?,'x','owner','示例工作台AI','https://x.com/egg_2rich','pending')").run(identity.workspace_id);
  const context = { db, identity, paths, config: { ...identity, paths, title: 'test', timezone: 'UTC', mode: 'demo', listen: { host: '127.0.0.1', port: 4318 } }, getExecutorHealth: async () => [] } as ApplicationContext;
  return { context, db, root, request: () => ({ ...identity, request_id: randomUUID(), idempotency_key: randomUUID(), request_identity_ref: 'internal_rule' }), close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
if (process.platform === 'darwin') mkdirSync(artifactRoot, { recursive: true });

test('X 实际平台格式核对严格绑定用户名；不回显密钥、不请求任意URL', async () => {
  let calls = 0, profile = 'Egg_2rich';
  const adapter = new TikHubAdapter({ token_provider: () => 'PRIVATE_SENTINEL', fetcher: async (url, init) => { calls++; assert.equal(String(url), 'https://api.tikhub.io/api/v1/twitter/web/fetch_user_profile?screen_name=egg_2rich'); assert.equal(init!.method, 'GET'); return new Response(JSON.stringify({ code: 200, data: { profile, rest_id: '1000000000000000001', status: 'active', token: 'PRIVATE_SENTINEL' } })); } });
  const result = await adapter.resolveAccount('https://x.com/egg_2rich'); assert.equal(result.platform_account_id, '1000000000000000001'); assert.ok(!result.raw_body.includes('PRIVATE_SENTINEL'));
  await assert.rejects(adapter.resolveAccount('https://wrong.invalid/egg_2rich')); await assert.rejects(adapter.resolveAccount('https://x.com/home')); assert.equal(calls, 1);
  profile = 'someone_else'; await assert.rejects(adapter.resolveAccount('https://x.com/egg_2rich'), /身份.*不符/);
});

test('账号核对真实SQLite幂等落库；未知/冲突/模拟身份不能升级真实工作区', async () => {
  const f = fixture(); try {
    let calls = 0; const resolveAccount = async () => { calls++; return { platform: 'x' as const, platform_account_id: '123', canonical_url: 'https://x.com/egg_2rich', checked_at: '2026-10-12T12:00:00Z', raw_body: '{"actual_fixture":true}', evidence_kind: 'internal_rule' as const }; };
    const checks = new AccountChecks(f.context, { resolveAccount }), request = f.request();
    const result = await checks.check(request, 'owner'); assert.equal(result.identity_status, 'confirmed'); assert.equal(f.db.prepare("SELECT platform_account_id FROM accounts WHERE id='owner'").get()!.platform_account_id, '123');
    assert.deepEqual(await checks.check(request, 'owner'), result); assert.equal(calls, 1); assert.equal(readdirSync(join(f.root, 'raw-responses')).length, 1);
    const evidence = JSON.parse(String(f.db.prepare("SELECT locator FROM evidence_links WHERE owner_id='owner'").get()!.locator)); assert.equal(readFileSync(evidence.raw_response_ref.path, 'utf8'), '{"actual_fixture":true}');
    const realChecks = new AccountChecks({ ...f.context, config: { ...f.context.config, mode: 'real' } }, { resolveAccount }); await assert.rejects(realChecks.check(f.request(), 'owner'), { code: 'CAPABILITY_UNVERIFIED' });
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM evidence_links').get()!.count, 1);
  } finally { f.close(); }
});

test('本人公众号认证按AppID幂等落库，保存专属依据，不产生发布权限与发布计划', async () => {
  const f = fixture(); try {
    const url = 'https://mp.weixin.qq.com/s/owner-fixture', appId = 'wx' + '0'.repeat(16); let calls = 0;
    f.db.prepare("UPDATE accounts SET platform='wechat',canonical_url=? WHERE id='owner'").run(url);
    const checks = new AccountChecks(f.context, { resolveAccount: async () => { throw new Error('must_not_call_tikhub'); } }, {
      resolveAccount: async (id, inputUrl) => { calls++; assert.equal(id, 'owner'); assert.equal(inputUrl, url); return { platform: 'wechat', platform_account_id: appId, canonical_url: url, checked_at: '2026-10-12T12:00:00Z', raw_body: '{"authentication":"passed"}', evidence_kind: 'internal_rule' }; },
    });
    const request = f.request(), result = await checks.check(request, 'owner');
    assert.equal(result.platform_account_id, appId); assert.deepEqual(await checks.check(request, 'owner'), result); assert.equal(calls, 1);
    const source = f.db.prepare("SELECT kind,url FROM sources WHERE external_id='wechat_account_identity'").get()!;
    assert.equal(source.kind, 'wechat_official'); assert.equal(source.url, 'https://api.weixin.qq.com/cgi-bin/stable_token');
    const evidence = JSON.parse(String(f.db.prepare("SELECT locator FROM evidence_links WHERE owner_id='owner'").get()!.locator));
    assert.equal(evidence.kind, 'wechat_appid_authentication');
    for (const table of ['publishing_capability_evidence', 'publication_intents', 'schedules']) assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM ' + table).get()!.count, 0);
    f.db.prepare("UPDATE accounts SET role='benchmark',identity_status='pending',platform_account_id=NULL WHERE id='owner'").run();
    await assert.rejects(checks.check(f.request(), 'owner'), { code: 'CAPABILITY_UNSUPPORTED' }); assert.equal(calls, 1);
  } finally { f.close(); }
});

test('采集启动配置绑定工作区与已核对账号；不接收原始密钥或伪造身份', () => {
  const f = fixture(); try {
    const path = join(f.root, 'targets.json');
    const target = { target_id: 'owner', platform: 'x', scope: 'account', platform_work_id: null, platform_account_id: '123', url: null, identity_evidence_ref: 'internal-identity', endpoint_key: 'x_account', params: { rest_id: '123' }, metrics: [], observation: { basis: 'unknown', evidence_ref: null } };
    const config = { config_version: 1, workspace_id: f.context.identity.workspace_id, targets: [target] };
    writeFileSync(path, JSON.stringify(config)); assert.throws(() => readCollectionTargets(f.context, path), { code: 'CAPABILITY_UNVERIFIED' });
    f.db.prepare("UPDATE accounts SET identity_status='confirmed',platform_account_id='123' WHERE id='owner'").run(); assert.equal(readCollectionTargets(f.context, path).length, 1);
    writeFileSync(path, JSON.stringify({ ...config, api_key: 'PRIVATE_SENTINEL' })); assert.throws(() => readCollectionTargets(f.context, path), { code: 'VALIDATION_ERROR' });
    writeFileSync(path, JSON.stringify({ ...config, workspace_id: randomUUID() })); assert.throws(() => readCollectionTargets(f.context, path), { code: 'VALIDATION_ERROR' });
    assert.equal(createCollectionRuntime(f.context, {}).credentialPresent(), false);
  } finally { f.close(); }
});
