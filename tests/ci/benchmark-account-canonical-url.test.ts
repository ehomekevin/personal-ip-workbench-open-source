import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../documents/harness.ts';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { AccountChecks } from '../../packages/domain/src/sources/account-checks.ts';
import { BenchmarkSync } from '../../packages/domain/src/sources/benchmark-sync.ts';
import { TikHubAdapter } from '../../packages/adapters/src/tikhub/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { Jobs } from '../../packages/domain/src/jobs/index.ts';

const registeredUrl = 'https://www.x.com/bench', canonicalUrl = 'https://x.com/bench';
const at = '2026-10-13T00:00:00Z';
const profile = (uid = '123') => ({ code: 200, data: { status: 'active', profile: 'bench', rest_id: uid, name: '对标作者' } });
function setup() {
  const f = fixture(), sources = new Sources(f.context());
  const id = sources.createAccount(f.request(), { role: 'benchmark', platform: 'x', url: registeredUrl, name: '登记名' }).account_id;
  return { ...f, sources, id };
}
type Fixture = ReturnType<typeof setup>;
const account = (f: Fixture) => f.context().db.prepare('SELECT * FROM accounts WHERE workspace_id=? AND id=?').get(f.config.workspace_id, f.id)!;
const rawFiles = (f: Fixture) => readdirSync(join(f.context().paths.state_root, 'raw-responses'));
function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
const worker = (f: Fixture, sync: BenchmarkSync) => new DurableWorker(f.context(), [{
  registration: { kind: 'benchmark_sync', execution_mode: 'programmatic', recovery: 'read_only' },
  async execute(e) {
    await sync.execute(e.claim.job.id, JSON.parse(e.claim.job.input_manifest), { fence: e.claim.fence, signal: e.signal, checkpoint: e.checkpoint });
    return { documents: [], recommendations: [] };
  },
}]);

test('www.x.com 登记经平台核对保存规范主页，重启后 feed 使用正确账号；既绑作品原 URL 和身份保留', async () => {
  const f = setup();
  try {
    assert.equal(account(f).canonical_url, registeredUrl);
    assert.equal(account(f).identity_status, 'pending');
    const workId = randomUUID(), workUrl = registeredUrl + '/status/101';
    f.context().db.prepare("INSERT INTO works(id,workspace_id,platform,platform_work_id,account_id,url,origin,identity_status) VALUES (?,?,'x','101',?,?,'import','confirmed')")
      .run(workId, f.config.workspace_id, f.id, workUrl);
    const work = () => f.context().db.prepare('SELECT url,platform,platform_work_id,account_id,identity_status,canonical_work_id FROM works WHERE id=?').get(workId)!;
    const originalWork = work(), calls: URL[] = [];
    const adapter = new TikHubAdapter({ fixture: true, token_provider: () => 'fake-token', clock: () => Date.parse(at), fetcher: async (raw, init) => {
      const url = new URL(String(raw)); calls.push(url);
      assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error');
      assert.equal(url.searchParams.get('screen_name'), 'bench');
      if (url.pathname.endsWith('/fetch_user_profile')) return new Response(JSON.stringify(profile()));
      assert.equal(url.pathname, '/api/v1/twitter/web/fetch_user_post_tweet');
      return new Response(JSON.stringify({ code: 200, data: { timeline: [{ tweet_id: '101', text: '已核对作品', created_at: at, author: { id_str: '123', screen_name: 'bench', name: '对标作者' }, favorites: 0 }] } }));
    } });
    const result = await new AccountChecks(f.context(), adapter).check(f.request(), f.id);
    assert.equal(result.platform_account_id, '123');
    assert.equal(account(f).canonical_url, canonicalUrl);
    assert.equal(account(f).platform_account_id, '123');
    assert.equal(account(f).identity_status, 'confirmed');
    assert.deepEqual(work(), originalWork);
    const evidence = JSON.parse(String(f.context().db.prepare("SELECT locator FROM evidence_links WHERE owner_type='account' AND owner_id=?").get(f.id)!.locator));
    assert.equal(evidence.canonical_url, canonicalUrl); assert.equal(evidence.platform_account_id, '123');
    f.reopen();
    assert.equal(account(f).canonical_url, canonicalUrl);
    const sync = new BenchmarkSync(f.context(), {
      credentialPresent: () => adapter.credentialPresent(),
      fetchBenchmarkFeed: async (url, platform, uid, signal, cursor) => {
        assert.equal(url, canonicalUrl); assert.equal(platform, 'x'); assert.equal(uid, '123');
        return adapter.fetchBenchmarkFeed(url, platform, uid, signal, cursor);
      },
    });
    const job = sync.enqueue(f.request(), f.id);
    assert.equal((await worker(f, sync).runOnce())!.state, 'committed', JSON.stringify(new Jobs(f.context()).get(f.request(), job.job_id).error));
    const record = new Sources(f.context()).records(f.request()).items[0]!;
    assert.equal(record.author_account_id, f.id); assert.equal(record.work_id, workId);
    assert.equal(record.canonical_url, canonicalUrl + '/status/101');
    assert.deepEqual(work(), originalWork);
    assert.equal(sync.status(f.request(), f.id).inserted, 1);
    assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM snapshots').get()!.n, 1);
    assert.deepEqual(calls.map(url => url.pathname), ['/api/v1/twitter/web/fetch_user_profile', '/api/v1/twitter/web/fetch_user_post_tweet']);
  } finally { f.cleanup(); }
});

test('已有平台 UID 不匹配时拒绝采用 adapter 的规范地址，不改原账号', async () => {
  const f = setup();
  try {
    f.context().db.prepare("UPDATE accounts SET platform_account_id='123',identity_status='confirmed' WHERE id=?").run(f.id);
    const before = account(f);
    const adapter = new TikHubAdapter({ fixture: true, token_provider: () => 'fake-token', fetcher: async () => new Response(JSON.stringify(profile('456'))) });
    await assert.rejects(new AccountChecks(f.context(), adapter).check(f.request(), f.id), { code: 'CAPABILITY_UNVERIFIED' });
    assert.deepEqual(account(f), before);
    assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM evidence_links').get()!.n, 0);
    assert.deepEqual(rawFiles(f), []);
  } finally { f.cleanup(); }
});

test('同一幂等请求并发重放只采用已提交规范地址与 UID，迟到响应不能重写身份', async () => {
  const f = setup();
  try {
    const first = gate(), second = gate(), started = gate(); let calls = 0;
    const adapter = new TikHubAdapter({ fixture: true, token_provider: () => 'fake-token', fetcher: async () => {
      const call = ++calls; if (call === 2) started.release();
      await (call === 1 ? first.wait : second.wait);
      return new Response(JSON.stringify(profile(call === 1 ? '123' : '456')));
    } });
    const checks = new AccountChecks(f.context(), adapter), request = f.request();
    const pendingFirst = checks.check(request, f.id), pendingSecond = checks.check(request, f.id);
    await started.wait; first.release();
    const result = await pendingFirst, committed = account(f);
    second.release();
    assert.deepEqual(await pendingSecond, result);
    assert.deepEqual(await checks.check(request, f.id), result);
    assert.equal(calls, 2);
    assert.equal(committed.canonical_url, canonicalUrl); assert.equal(committed.platform_account_id, '123');
    assert.deepEqual(account(f), committed);
    assert.equal(f.context().db.prepare("SELECT COUNT(*) n FROM evidence_links WHERE owner_type='account'").get()!.n, 1);
    assert.equal(rawFiles(f).length, 1);
  } finally { f.cleanup(); }
});

test('非重放的并发确认在规范地址变化后拒绝旧读取，不增加第二份身份依据', async () => {
  const f = setup();
  try {
    const first = gate(), second = gate(), started = gate(); let calls = 0;
    const adapter = new TikHubAdapter({ fixture: true, token_provider: () => 'fake-token', fetcher: async () => {
      const call = ++calls; if (call === 2) started.release();
      await (call === 1 ? first.wait : second.wait);
      return new Response(JSON.stringify(profile()));
    } });
    const checks = new AccountChecks(f.context(), adapter);
    const pendingFirst = checks.check(f.request(), f.id), pendingSecond = checks.check(f.request(), f.id);
    const rejected = assert.rejects(pendingSecond, { code: 'VERSION_CONFLICT' });
    await started.wait; first.release(); await pendingFirst;
    const committed = account(f); second.release(); await rejected;
    assert.equal(committed.canonical_url, canonicalUrl); assert.equal(committed.platform_account_id, '123');
    assert.deepEqual(account(f), committed);
    assert.equal(f.context().db.prepare("SELECT COUNT(*) n FROM evidence_links WHERE owner_type='account'").get()!.n, 1);
    assert.equal(rawFiles(f).length, 1);
  } finally { f.cleanup(); }
});

test('核对等待期间账号地址与 UID 变化时保留新记录，旧响应不能越过身份校验', async () => {
  const f = setup();
  try {
    const started = gate(), release = gate();
    const adapter = new TikHubAdapter({ fixture: true, token_provider: () => 'fake-token', fetcher: async () => {
      started.release(); await release.wait; return new Response(JSON.stringify(profile()));
    } });
    const pending = new AccountChecks(f.context(), adapter).check(f.request(), f.id);
    const rejected = assert.rejects(pending, { code: 'VERSION_CONFLICT' });
    await started.wait;
    f.context().db.prepare("UPDATE accounts SET canonical_url='https://x.com/other',platform_account_id='999',identity_status='confirmed' WHERE id=?").run(f.id);
    const changed = account(f); release.release(); await rejected;
    assert.deepEqual(account(f), changed);
    assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM evidence_links').get()!.n, 0);
    assert.deepEqual(rawFiles(f), []);
  } finally { f.cleanup(); }
});
