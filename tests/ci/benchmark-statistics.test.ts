import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContractError, type BenchmarkStatisticsRefreshRequest } from '../../packages/contracts/src/index.ts';
import { canonicalJson, sha256 } from '../../packages/storage/src/connection/index.ts';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { BenchmarkSync } from '../../packages/domain/src/sources/benchmark-sync.ts';
import { BenchmarkStatistics, type BenchmarkStatisticsClient } from '../../packages/domain/src/sources/benchmark-statistics.ts';
import { TikHubAdapter } from '../../packages/adapters/src/tikhub/index.ts';
import { BenchmarkStatisticsAdapter, parseBenchmarkStatistics, type BenchmarkStatisticsResult } from '../../packages/adapters/src/tikhub/benchmark-statistics.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { fixture } from '../documents/harness.ts';

const collectionAt = '2026-10-13T00:00:00.000Z', statisticAt = '2026-10-13T02:00:00.000Z';
async function stored(counts = [3]) {
  const f = fixture();
  try {
    const context = f.context(), db = context.db, sources = new Sources(context), feeds = new Map<string, string>(), accounts: string[] = [];
    let offset = 0;
    for (let i = 0; i < counts.length; i++) {
      const sec = 'MS4w' + String(i).padStart(21, '0'), uid = String(1000 + i), url = 'https://www.douyin.com/user/' + sec;
      const account = sources.createAccount(f.request(), { role: 'benchmark', platform: 'douyin', url, name: '隔离账号' + i }).account_id; accounts.push(account);
      db.prepare("UPDATE accounts SET platform_account_id=?,identity_status='confirmed' WHERE id=?").run(uid, account);
      const aweme_list = Array.from({ length: counts[i]! }, () => ({ aweme_id: String(300000 + offset++), desc: '平台说明与正文', create_time: 1720000000, author: { uid, sec_uid: sec, nickname: '隔离作者' }, statistics: { digg_count: 1, play_count: 0 }, video: { duration: 5000, cover: { url_list: ['https://p3-pc.douyinpic.com/c.jpg'] }, play_addr: { url_list: ['https://v5-dy.zjcdn.com/v.mp4'] } } }));
      feeds.set(sec, JSON.stringify({ code: 200, data: { aweme_list, has_more: false } }));
    }
    const sync = new BenchmarkSync(context, new TikHubAdapter({ fixture: true, clock: () => Date.parse(collectionAt), token_provider: () => 'isolated-feed', fetcher: async u => new Response(feeds.get(new URL(String(u)).searchParams.get('sec_user_id')!)!) }));
    const worker = new DurableWorker(context, [{ registration: { kind: 'benchmark_sync', execution_mode: 'programmatic', recovery: 'read_only' }, async execute(e) { await sync.execute(e.claim.job.id, JSON.parse(e.claim.job.input_manifest), { fence: e.claim.fence, signal: e.signal, checkpoint: e.checkpoint }); return { documents: [], recommendations: [] }; } }]);
    for (const id of accounts) { sync.enqueue(f.request(), id); assert.equal((await worker.runOnce())?.state, 'committed'); }
    const rows = db.prepare('SELECT * FROM source_records ORDER BY external_id').all();
    return { ...f, accounts, rows, sources };
  } catch (error) { f.cleanup(); throw error; }
}
type Stored = Awaited<ReturnType<typeof stored>>;
function result(ids: string[], values: (string | number | null)[] = ids.map((_id, i) => i ? String(i * 10) : '0'), collectedAt = statisticAt): BenchmarkStatisticsResult {
  const raw_body = JSON.stringify({ code: 200, data: { statistics_list: ids.map((aweme_id, i) => ({ aweme_id, play_count: values[i] })) } });
  return { raw_body, collected_at: collectedAt, evidence_kind: 'internal_rule', statistics: parseBenchmarkStatistics(raw_body, ids) };
}
const metricKey = (f: Stored, row: Record<string, unknown>) => `benchmark-play-count.v1:${f.config.workspace_id}:${row.author_account_id}:${row.external_id}`;
const metricRows = (f: Stored) => f.context().db.prepare("SELECT key,value FROM application_metadata WHERE key LIKE 'benchmark-play-count.v1:%' ORDER BY key").all();
function unchanged(f: Stored): string {
  const db = f.context().db, tables = ['source_records', 'source_locations', 'user_source_marks', 'works', 'jobs', 'job_attempts', 'snapshots', 'metric_values', 'sync_checkpoints', 'index_entries'];
  return sha256(canonicalJson({ tables: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])), history: db.prepare("SELECT key,value FROM application_metadata WHERE key LIKE 'benchmark-sync.v1:%' OR key LIKE 'benchmark-result.v1:%' ORDER BY key").all() }));
}
async function settled(action: BenchmarkStatistics, f: Stored) {
  for (let i = 0; i < 100; i++) { await new Promise(resolve => setTimeout(resolve, 5)); const state = action.status(f.request()); if (state && !['queued', 'running'].includes(state.state)) return state; }
  throw new Error('Isolated statistics operation did not settle');
}
function operation(f: Stored, id: string): any { return JSON.parse(String(f.context().db.prepare('SELECT value FROM application_metadata WHERE key=?').get(`benchmark-statistics-refresh.v1:${f.config.workspace_id}:${id}`)!.value)); }

test('166个可信作品来自7账号，固定scope冻结为50/50/50/16；真实0和正数独立存证且正文、marks、历史与snapshot保持', async t => {
  const f = await stored([24, 24, 24, 24, 24, 24, 22]); let action: BenchmarkStatistics | undefined;
  try {
    const row = f.rows[0]!, payload = JSON.parse(String(row.payload)); payload.body = '人工完整转写'; payload.provider_metadata.curation = { selected: true, status: 'active', rank: 1, reason: '人工核对' };
    f.context().db.prepare('UPDATE source_records SET payload=? WHERE id=?').run(canonicalJson(payload), row.id!); f.sources.marks(f.request(), String(row.id), { favorite: true, read: true });
    const before = unchanged(f), calls: string[][] = [];
    action = new BenchmarkStatistics(f.context(), { async fetch(ids) { assert.equal(f.context().db.isTransaction, false); const current = action!.status(f.request())!; const saved = operation(f, current.refresh_id), batch = saved.batches[calls.length]; assert.equal(batch.state, 'sending'); assert.equal(JSON.parse(readFileSync(batch.request_ref.path, 'utf8')).request_fingerprint, batch.request_fingerprint); calls.push([...ids]); return result(ids); } });
    const request = f.request('stats-166'), startAt = performance.now(), accepted = action.start(request), freezeMs = performance.now() - startAt;
    assert.equal(accepted.state, 'queued'); assert.equal(accepted.matched_count, 166); assert.equal(accepted.batch_count, 4); assert.equal(calls.length, 0);
    assert.deepEqual(action.start(request), accepted); const completed = await settled(action, f);
    assert.equal(completed.state, 'succeeded'); assert.equal(completed.updated_count, 166); assert.equal(completed.completed_batches, 4); assert.equal(completed.remote_attempts, 4); assert.deepEqual(calls.map(ids => ids.length), [50, 50, 50, 16]); assert.equal(new Set(calls.flat()).size, 166);
    assert.equal(unchanged(f), before); assert.equal(metricRows(f).length, 166);
    const values = metricRows(f).map(row => JSON.parse(String(row.value))); assert.ok(values.some(row => row.value === '0')); assert.ok(values.some(row => row.value === '10'));
    for (const metric of values) { assert.equal(metric.schema_version, 'benchmark-play-count/1'); assert.equal(metric.source_kind, 'tikhub_douyin_video_statistics'); assert.equal(metric.observed_at, null); assert.equal(metric.observed_time_basis, 'unknown'); assert.equal(metric.collected_at, statisticAt); assert.equal(sha256(readFileSync(metric.raw_response_ref.path)), metric.raw_response_ref.sha256); assert.ok(metric.request_fingerprint); }
    assert.deepEqual(action.start(request), accepted); assert.equal(calls.length, 4);
    t.diagnostic(`166-target synchronous freeze/start ${freezeMs.toFixed(1)} ms; completed fake operation ${(performance.now() - startAt).toFixed(1)} ms`);
  } finally { await action?.close(); f.cleanup(); }
});

test('running时不同key复用同intent；closed等待active且同key不产生第二次provider调用', async () => {
  const f = await stored([1]); let action: BenchmarkStatistics | undefined;
  try {
    let release!: (value: BenchmarkStatisticsResult) => void, calls = 0;
    action = new BenchmarkStatistics(f.context(), { async fetch(ids) { calls++; return await new Promise(resolve => { release = resolve; }); } });
    const first = action.start(f.request('first')), queued = action.start(f.request('second')); assert.equal(queued.refresh_id, first.refresh_id);
    await new Promise(resolve => setImmediate(resolve)); const running = action.start(f.request('third')); assert.equal(running.refresh_id, first.refresh_id); assert.equal(running.state, 'running'); assert.equal(calls, 1);
    let closed = false; const closing = action.close().then(() => { closed = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
    release(result([String(f.rows[0]!.external_id)])); await closing; assert.equal(closed, true); assert.equal(calls, 1); assert.equal(action.status(f.request())!.state, 'succeeded');
  } finally { await action?.close(); f.cleanup(); }
});

test('partial/missing/invalid不会清除已有可信统计，专用stats的真实0可覆盖旧正数', async () => {
  const f = await stored([3]); let action: BenchmarkStatistics | undefined;
  try {
    let phase = 0;
    action = new BenchmarkStatistics(f.context(), { async fetch(ids) {
      if (phase === 0) return result(ids, ['10', '20', '30']);
      const raw_body = JSON.stringify({ code: 200, data: { statistics_list: [{ aweme_id: ids[0], play_count: 0 }, { aweme_id: ids[2], play_count: '-1' }] } });
      return { raw_body, collected_at: '2026-10-13T03:00:00.000Z', evidence_kind: 'internal_rule', statistics: parseBenchmarkStatistics(raw_body, ids) };
    } });
    action.start(f.request('baseline')); assert.equal((await settled(action, f)).state, 'succeeded'); const old = metricRows(f), oldByKey = new Map(old.map(row => [String(row.key), String(row.value)])); phase = 1;
    action.start(f.request('partial')); const partial = await settled(action, f); assert.equal(partial.state, 'partial'); assert.equal(partial.updated_count, 1); assert.equal(partial.missing_count, 1); assert.equal(partial.invalid_count, 1); assert.equal(partial.retained_count, 2);
    const op = operation(f, partial.refresh_id), requested = op.batches[0].aweme_ids;
    for (const row of f.rows) { const current = String(f.context().db.prepare('SELECT value FROM application_metadata WHERE key=?').get(metricKey(f, row))!.value); if (row.external_id === requested[0]) assert.equal(JSON.parse(current).value, '0'); else assert.equal(current, oldByKey.get(metricKey(f, row))); }
  } finally { await action?.close(); f.cleanup(); }
});

test('返回后UID变化为stale，不将统计写入新身份；已有plays保持', async () => {
  const f = await stored([2]); let action: BenchmarkStatistics | undefined;
  try {
    let phase = 0;
    action = new BenchmarkStatistics(f.context(), { async fetch(ids) { const feed = result(ids, ids.map(() => '100')); if (phase) f.context().db.prepare('UPDATE accounts SET platform_account_id=? WHERE id=?').run('999', f.accounts[0]!); return feed; } });
    action.start(f.request('identity-baseline')); await settled(action, f); const before = metricRows(f); phase = 1;
    action.start(f.request('identity-changed')); const state = await settled(action, f); assert.equal(state.state, 'partial'); assert.equal(state.stale_count, 2); assert.equal(state.updated_count, 0); assert.deepEqual(metricRows(f), before);
  } finally { await action?.close(); f.cleanup(); }
});

test('timeout/network unknown持久阻止不同key重付；重启initialize只看回执不远调', async () => {
  const f = await stored([2]); let action: BenchmarkStatistics | undefined;
  try {
    let calls = 0; const client: BenchmarkStatisticsClient = { async fetch() { calls++; throw new ContractError('CAPABILITY_UNVERIFIED', 'network outcome unknown'); } };
    action = new BenchmarkStatistics(f.context(), client); const accepted = action.start(f.request('unknown'));
    const unknown = await settled(action, f); assert.equal(unknown.state, 'unknown'); assert.equal(unknown.remote_attempts, 1); assert.equal(metricRows(f).length, 0);
    const same = action.start(f.request('new-after-unknown')); assert.equal(same.refresh_id, accepted.refresh_id); assert.equal(same.state, 'unknown'); assert.equal(calls, 1);
    await action.close(); f.reopen(); action = new BenchmarkStatistics(f.context(), client); await action.initialize();
    assert.equal(action.status(f.request())!.state, 'unknown'); assert.equal(action.start(f.request('new-after-restart')).refresh_id, accepted.refresh_id); assert.equal(calls, 1); assert.equal(metricRows(f).length, 0);
  } finally { await action?.close(); f.cleanup(); }
});

test('真实adapter fake timeout变unknown；已有metric不清除，也不按freshkey自动重试', async () => {
  const f = await stored([1]); let action: BenchmarkStatistics | undefined;
  try {
    let calls = 0;
    const adapter = new BenchmarkStatisticsAdapter({ fixture: true, token_provider: () => 'isolated-statistics', timeout_ms: 5, fetcher: async () => { calls++; return await new Promise<Response>(() => {}); } });
    action = new BenchmarkStatistics(f.context(), adapter); const accepted = action.start(f.request('timed-out')); const state = await settled(action, f); assert.equal(state.state, 'unknown'); assert.equal(calls, 1);
    assert.equal(action.start(f.request('after-timeout')).refresh_id, accepted.refresh_id); assert.equal(calls, 1);
  } finally { await action?.close(); f.cleanup(); }
});

test('已保存result在应用前中断：恢复应用已有50项，未发送后续批次不补付', async () => {
  const f = await stored([28, 28]); let action: BenchmarkStatistics | undefined;
  try {
    let calls = 0; const client: BenchmarkStatisticsClient = { async fetch(ids) { calls++; return result(ids, ids.map(() => '88')); } };
    class Interrupted extends BenchmarkStatistics { protected override beforeApply() { throw new Error('isolated crash after saved result'); } }
    action = new Interrupted(f.context(), client); const accepted = action.start(f.request('interrupted')); assert.equal((await settled(action, f)).state, 'unknown'); assert.equal(metricRows(f).length, 0); assert.equal(calls, 1);
    const saved = operation(f, accepted.refresh_id); assert.ok(saved.batches[0].result_ref); assert.equal(saved.batches[1].state, 'not_sent');
    await action.close(); f.reopen(); action = new BenchmarkStatistics(f.context(), client); await action.initialize();
    const recovered = action.status(f.request())!; assert.equal(recovered.state, 'partial'); assert.equal(recovered.updated_count, 50); assert.equal(recovered.retained_count, 6); assert.equal(recovered.completed_batches, 1); assert.equal(calls, 1); assert.equal(metricRows(f).length, 50);
    await action.initialize(); assert.equal(calls, 1); assert.equal(metricRows(f).length, 50);
  } finally { await action?.close(); f.cleanup(); }
});

for (const damage of ['raw', 'result_fingerprint', 'link'] as const) test(`恢复拒绝损坏 ${damage} 的saved receipt，保持unknown且不重打`, async () => {
  const f = await stored([1]); let action: BenchmarkStatistics | undefined;
  try {
    let calls = 0; const client: BenchmarkStatisticsClient = { async fetch(ids) { calls++; return result(ids); } };
    class Interrupted extends BenchmarkStatistics { protected override beforeApply() { throw new Error('isolated saved result stop'); } }
    action = new Interrupted(f.context(), client); const accepted = action.start(f.request()); await settled(action, f); await action.close();
    const batch = operation(f, accepted.refresh_id).batches[0];
    if (damage === 'raw') writeFileSync(batch.raw_response_ref.path, '{}');
    if (damage === 'result_fingerprint') { const saved = JSON.parse(readFileSync(batch.result_ref.path, 'utf8')); saved.request_fingerprint = sha256('{}'); writeFileSync(batch.result_ref.path, JSON.stringify(saved)); }
    if (damage === 'link') { const copy = join(f.root, 'saved-stat-result.json'); writeFileSync(copy, readFileSync(batch.result_ref.path)); unlinkSync(batch.result_ref.path); symlinkSync(copy, batch.result_ref.path); }
    f.reopen(); action = new BenchmarkStatistics(f.context(), client); await action.initialize(); assert.equal(action.status(f.request())!.state, 'unknown'); assert.equal(metricRows(f).length, 0); assert.equal(calls, 1);
    assert.equal(action.start(f.request('damaged-fresh-key')).refresh_id, accepted.refresh_id); assert.equal(calls, 1);
  } finally { await action?.close(); f.cleanup(); }
});

test('foreign ID或normalized与raw不一致不写任何统计，当前scope不会被返回内容扩展', async () => {
  for (const foreign of [true, false]) {
    const f = await stored([1]); let action: BenchmarkStatistics | undefined;
    try {
      let calls = 0;
      action = new BenchmarkStatistics(f.context(), { async fetch(ids) { calls++; const raw_body = JSON.stringify({ code: 200, data: { statistics_list: [{ aweme_id: foreign ? '99999999' : ids[0], play_count: '100' }] } }); return { raw_body, collected_at: statisticAt, evidence_kind: 'internal_rule', statistics: [{ aweme_id: ids[0]!, play_count: '200' }] }; } });
      action.start(f.request()); assert.equal((await settled(action, f)).state, 'unknown'); assert.equal(metricRows(f).length, 0); assert.equal(calls, 1);
    } finally { await action?.close(); f.cleanup(); }
  }
});

test('权限/额度失败保存失败状态，保留历史并停止剩余批次', async () => {
  const f = await stored([28, 28]); let action: BenchmarkStatistics | undefined;
  try {
    let calls = 0; action = new BenchmarkStatistics(f.context(), { async fetch() { calls++; throw new ContractError('QUOTA_EXHAUSTED', 'isolated quota exhausted'); } });
    const before = unchanged(f); action.start(f.request()); const state = await settled(action, f); assert.equal(state.state, 'failed'); assert.equal(state.remote_attempts, 1); assert.equal(state.completed_batches, 1); assert.equal(state.retained_count, 56); assert.equal(calls, 1); assert.equal(unchanged(f), before); assert.equal(metricRows(f).length, 0);
  } finally { await action?.close(); f.cleanup(); }
});

test('固定workspace空body严格拒绝IDs/path/额外field、错误身份与无效key', async () => {
  const f = await stored([1]); let action: BenchmarkStatistics | undefined;
  try {
    let calls = 0; action = new BenchmarkStatistics(f.context(), { async fetch(ids) { calls++; return result(ids); } });
    for (const body of [{ ids: ['300000'] }, { aweme_ids: ['300000'] }, { account_id: f.accounts[0] }, { path: f.context().paths.state_root }, { payload: {} }, null, []]) assert.throws(() => action!.start(f.request(), body as unknown as BenchmarkStatisticsRefreshRequest), { code: 'VALIDATION_ERROR' });
    for (const key of ['workspace_id', 'service_instance_id', 'contract_version']) assert.throws(() => action!.start({ ...f.request(), [key]: randomUUID() }), { code: 'WORKSPACE_INSTANCE_MISMATCH' });
    assert.throws(() => action!.start({ ...f.request(), idempotency_key: null }), { code: 'VALIDATION_ERROR' }); assert.throws(() => action!.start(f.request('x'.repeat(201))), { code: 'VALIDATION_ERROR' }); assert.equal(action.status(f.request()), null); assert.equal(calls, 0);
  } finally { await action?.close(); f.cleanup(); }
});

test('超过200目标或7账号在enqueue前拒绝，provider零调用', async () => {
  for (const counts of [[29, 29, 29, 29, 29, 29, 27], [1, 1, 1, 1, 1, 1, 1, 1]]) {
    const f = await stored(counts); let action: BenchmarkStatistics | undefined;
    try { let calls = 0; action = new BenchmarkStatistics(f.context(), { async fetch(ids) { calls++; return result(ids); } }); assert.throws(() => action!.start(f.request()), { code: 'CAPABILITY_UNSUPPORTED' }); assert.equal(calls, 0); assert.equal(action.status(f.request()), null); }
    finally { await action?.close(); f.cleanup(); }
  }
});

test('real服务拒绝internal_rule统计结果，不将fixture值登记为真实平台plays', async () => {
  const f = await stored([1]); let action: BenchmarkStatistics | undefined;
  try {
    let calls = 0; action = new BenchmarkStatistics(f.context(), { async fetch(ids) { calls++; const saved = result(ids); f.context().db.prepare("UPDATE workspaces SET mode='real' WHERE id=?").run(f.config.workspace_id); return saved; } });
    action.start(f.request()); assert.equal((await settled(action, f)).state, 'unknown'); assert.equal(metricRows(f).length, 0); assert.equal(calls, 1);
  } finally { await action?.close(); f.cleanup(); }
});
