import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContractError } from '../../packages/contracts/src/index.ts';
import { Works } from '../../packages/domain/src/works/index.ts';
import { Metrics } from '../../packages/domain/src/metrics/index.ts';
import { TikHubAdapter, normalizeMetric } from '../../packages/adapters/src/tikhub/index.ts';
import { transaction } from '../../packages/storage/src/connection/index.ts';
import { listSnapshotInputs, listWorkSnapshots, listAccountSnapshots, commitObservationInTransaction, ensureMetricsSourceInTransaction, MetricsRawFiles, type ObservationInput } from '../../packages/storage/src/metrics/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { metricsHandler } from '../../apps/service/src/worker/handlers/metrics/index.ts';
import { fixture, ownWork, adapter, target, mapping, evidence, preserveRaw } from './harness.ts';

const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, error => error instanceof ContractError && error.code === code);
test('完整导入body幂等：同短URL不同候选ID须冲突且不追加provenance', async () => {
  const f = fixture(); try {
    const works = new Works(f.context()), request = f.request('same-full-import-body');
    const first = await works.importWork(request, { platform: 'douyin', url: 'https://v.douyin.com/short/', platform_work_id: '111' });
    await assert.rejects(works.importWork(request, { platform: 'douyin', url: 'https://v.douyin.com/short/', platform_work_id: '222' }), error => error instanceof ContractError && error.code === 'IDEMPOTENCY_CONFLICT');
    assert.equal(works.get(f.request(), first.work_id).platform_work_id, null); assert.equal(f.context().db.prepare("SELECT COUNT(*) AS n FROM evidence_links WHERE owner_type='work' AND owner_id=?").get(first.work_id)!.n, 1);
  } finally { f.cleanup(); }
});
test('manual target24h不会消费未来24h计划，计划due语义保持', async () => {
  const f = fixture(); try {
    const published = '2026-10-10T00:00:00.000Z'; let now = Date.parse(published) + 3600_000, calls = 0;
    const work = await ownWork(f, { published_at: published }), metrics = new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work, { observation: { basis: 'collector_verified', evidence_ref: 'internal_rule' } })], async () => { calls++; return new Response(JSON.stringify({ data: { like_count: calls } })); }, () => now) });
    const manual = metrics.collectWork(f.request(), work.work_id, { target_window: 24 }), schedule = metrics.scheduleWindows(); assert.notEqual(schedule[0]!.job_id, manual.job_id);
    const worker = new DurableWorker(f.context(), [metricsHandler(metrics)], { clock: () => now }); await worker.runOnce(); now = Date.parse(published) + 24 * 3600_000; assert.ok(await worker.runOnce());
    const snapshots = listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id); assert.deepEqual(snapshots.map(snapshot => snapshot.observed_age_s), [3600, 86400]); assert.equal(calls, 2);
  } finally { f.cleanup(); }
});
test('worker外部signal仍受adapter deadline约束，timeout留raw并持久退避', async () => {
  const f = fixture(); try {
    const work = await ownWork(f); process.env.WP12_FIXTURE_TOKEN = 'isolated-fixture';
    let aborted = false, requestElapsedMs: number | null = null; const hanging: typeof fetch = async (_url, options) => new Promise<Response>((_resolve, reject) => {
      const requestStarted = performance.now();
      const guard = setTimeout(() => reject(new Error('deadline not applied')), 1000);
      options!.signal!.addEventListener('abort', () => { aborted = true; requestElapsedMs = performance.now() - requestStarted; clearTimeout(guard); reject(options!.signal!.reason); }, { once: true });
    });
    const provider = new TikHubAdapter({ targets: [target(work)], token_env: 'WP12_FIXTURE_TOKEN', fetcher: hanging, timeout_ms: 50, fixture: true }), metrics = new Metrics(f.context(), { adapter: provider }), worker = new DurableWorker(f.context(), [metricsHandler(metrics)]);
    const job = metrics.collectWork(f.request(), work.work_id, {}); assert.equal((await worker.runOnce())?.state, 'failed'); assert.equal(aborted, true);
    // 网络 deadline 不包括之后保存 raw、提交 SQLite 和计算退避的外置盘写入时间。
    assert.ok(requestElapsedMs !== null && requestElapsedMs < 1000);
    const snapshot = listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id)[0]!; assert.equal(snapshot.metrics[0]!.reason, 'request_timeout'); assert.ok(metrics.jobs.get(f.request(), job.job_id).checkpoint!.retry_at); assert.equal(metrics.resumeDueRetries(), 0);
  } finally { f.cleanup(); }
});
test('URL / ID pending 导入、无主题枚举、分页及清会话恢复', async () => {
  const f = fixture(); try {
    const works = new Works(f.context()), first = await works.importWork(f.request(), { platform: 'x', platform_work_id: '123' });
    const replay = await works.importWork(f.request(), { platform: 'x', url: 'https://x.com/i/status/123?utm_source=test' }); assert.equal(first.work_id, replay.work_id);
    const second = await works.importWork(f.request(), { platform: 'douyin', url: 'https://v.douyin.com/unknown/' });
    assert.equal(works.get(f.request(), first.work_id).platform_work_id, null); assert.equal(works.get(f.request(), first.work_id).topic_id, null);
    const page = works.list(f.request(), { limit: 1 }); assert.equal(page.items.length, 1); assert.equal(page.has_more, true);
    assert.equal(works.list(f.request(), { cursor: page.next_cursor!, limit: 1 }).items.length, 1);
    throwsCode(() => new Metrics(f.context()).collectWork(f.request(), first.work_id, {}), 'CAPABILITY_UNVERIFIED');
    await assert.rejects(works.importWork(f.request(), { platform: 'x', url: 'https://x.com/owner/status/123', platform_work_id: '456' }), /不一致/);
    f.reopen(); assert.equal(new Works(f.context()).list(f.request()).items.length, 2); assert.equal(new Works(f.context()).get(f.request(), second.work_id).identity_status, 'pending');
  } finally { f.cleanup(); }
});
test('零 / 字段缺失 / null / 权限 / unsupported / invalid 不混淆', () => {
  assert.equal(normalizeMetric({ data: { like_count: 0 } }, mapping(), 'x', 'work').value, '0');
  assert.equal(normalizeMetric({ data: {} }, mapping(), 'x', 'work').reason, 'missing_field');
  assert.equal(normalizeMetric({ data: { like_count: null } }, mapping(), 'x', 'work').reason, 'provider_null');
  assert.equal(normalizeMetric({}, mapping(), 'x', 'work', 'provider_permission_denied').availability, 'unavailable');
  assert.equal(normalizeMetric({}, { ...mapping(), unsupported: true }, 'x', 'work').availability, 'unsupported');
  assert.equal(normalizeMetric({}, mapping('unmapped', null), 'x', 'work').availability, 'not_collected');
  for (const value of [true, -1, 'NaN', '1e3', 9007199254740992]) assert.equal(normalizeMetric({ data: { like_count: value } }, mapping(), 'x', 'work').availability, 'invalid');
});
test('新实际请求同值保留观察，单次提交重放不重复；raw hash 冲突拒绝', async () => {
  const f = fixture(); try {
    const work = await ownWork(f), calls: string[] = [], metrics = new Metrics(f.context(), { adapter: adapter([target(work)], async () => { calls.push(randomUUID()); return new Response(JSON.stringify({ data: { like_count: 0 } })); }) });
    const worker = new DurableWorker(f.context(), [metricsHandler(metrics)]);
    const job = metrics.collectWork(f.request('collection-one'), work.work_id, {}); assert.equal(metrics.collectWork(f.request('collection-one'), work.work_id, {}).job_id, job.job_id);
    assert.equal((await worker.runOnce())?.state, 'committed'); assert.equal(metrics.jobs.get(f.request(), job.job_id).job.state, 'succeeded'); metrics.collectWork(f.request(), work.work_id, {}); await worker.runOnce();
    const snapshots = listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id); assert.equal(snapshots.length, 2); assert.equal(calls.length, 2); assert.notEqual(snapshots[0]!.collection_request_id, snapshots[1]!.collection_request_id); assert.equal(snapshots[0]!.metrics[0]!.value, '0'); assert.equal(snapshots[0]!.observed_at, null); assert.equal(snapshots[0]!.observed_age_s, null);
    const checkpoint = JSON.parse(String(f.context().db.prepare('SELECT checkpoint FROM job_attempts WHERE workspace_id=? AND job_id=?').get(f.config.workspace_id, job.job_id)!.checkpoint));
    const observation = checkpoint.response as ObservationInput, db = f.context().db;
    assert.equal(transaction(db, () => commitObservationInTransaction(db, f.config.workspace_id, ensureMetricsSourceInTransaction(db, f.config.workspace_id), observation)).replay, true);
    throwsCode(() => transaction(db, () => commitObservationInTransaction(db, f.config.workspace_id, ensureMetricsSourceInTransaction(db, f.config.workspace_id), { ...observation, raw_sha256: 'f'.repeat(64) })), 'IDEMPOTENCY_CONFLICT');
    evidence('snapshot-lineage.json', { evidence_kind: 'internal_rule', captured_at: new Date().toISOString(), snapshots: snapshots.map(s => ({ ...s, evidence_raw_path: preserveRaw(s), fixture_root_removed: true })), same_provider_body: JSON.parse(readFileSync(snapshots[0]!.raw_path, 'utf8')).body === JSON.parse(readFileSync(snapshots[1]!.raw_path, 'utf8')).body, actual_network_calls: 0, fixture_calls: calls.length });
  } finally { f.cleanup(); }
});
test('canonical / alias 保留原快照归属，作者冲突不改写历史', async () => {
  const f = fixture(); try {
    const work = await ownWork(f), works = new Works(f.context()), alias = await works.importWork(f.request(), { platform: 'x', url: work.url + '?source=alias' });
    works.resolveVerified(f.request(), alias.work_id, { platform_work_id: work.platform_id, account_id: work.account_id, evidence: { fixture: 'second-source' } });
    const metrics = new Metrics(f.context(), { adapter: adapter([target(work)], async () => new Response(JSON.stringify({ data: { like_count: 7 } }))) }), worker = new DurableWorker(f.context(), [metricsHandler(metrics)]);
    metrics.collectWork(f.request(), alias.work_id, {}); await worker.runOnce();
    assert.equal(works.list(f.request()).items.length, 1); assert.equal(works.get(f.request(), alias.work_id).aliases.length, 1);
    const snapshots = listSnapshotInputs(f.context().db, f.config.workspace_id); assert.equal(snapshots.length, 1); assert.equal(snapshots[0]!.source_work_id, alias.work_id); assert.equal(snapshots[0]!.canonical_work_id, work.work_id);
    const other = randomUUID(); f.context().db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'x','other','owner','other','https://x.com/other','confirmed')").run(other, f.config.workspace_id);
    throwsCode(() => works.resolveVerified(f.request(), work.work_id, { platform_work_id: work.platform_id, account_id: other, evidence: { fixture: 'conflict' } }), 'VALIDATION_ERROR');
    f.reopen(); assert.equal(listSnapshotInputs(f.context().db, f.config.workspace_id).length, 1); assert.equal(new Works(f.context()).get(f.request(), alias.work_id).id, work.work_id);
  } finally { f.cleanup(); }
});
test('实际 29h 不改成计划 24h，未来窗口持久且重启不重复', async () => {
  const f = fixture(); try {
    const published = '2026-10-01T00:00:00.000Z'; let now = Date.parse(published) + 29 * 3600_000;
    const work = await ownWork(f, { published_at: published }), metrics = new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work, { observation: { basis: 'collector_verified', evidence_ref: 'internal_rule:current-semantics' } })], async () => new Response(JSON.stringify({ data: { like_count: 12 } })), () => now) });
    const schedules = metrics.scheduleWindows(); assert.deepEqual(schedules.map(s => s.target_window), [86400, 259200, 604800]); assert.deepEqual(metrics.scheduleWindows(), schedules);
    const worker = new DurableWorker(f.context(), [metricsHandler(metrics)], { clock: () => now }); await worker.runOnce();
    const snapshot = listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id)[0]!; assert.equal(snapshot.target_window, 86400); assert.equal(snapshot.observed_age_s, 29 * 3600); assert.equal(snapshot.observed_time_basis, 'collector_verified');
    assert.equal(await worker.runOnce(), null); f.reopen(); const restored = new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work)], async () => { throw new Error('must_not_fetch'); }, () => now) }); assert.deepEqual(restored.scheduleWindows(), schedules);
    now += 10_000; evidence('age-scheduling-cases.json', { evidence_kind: 'internal_rule', captured_at: new Date().toISOString(), input: { published_at: published, simulated_now: new Date(now).toISOString() }, schedules, actual_age_s: snapshot.observed_age_s, target_window_s: snapshot.target_window, remaining_real_24h_72h_7d: 'not_collected', historical_curve_points: 1 });
  } finally { f.cleanup(); }
});
test('账户粉丝独立保存，未产生单篇增粉', async () => {
  const f = fixture(); try {
    const work = await ownWork(f), metrics = new Metrics(f.context(), { adapter: adapter([target(work, { scope: 'account', metrics: [mapping('followers', 'data.followers')] })], async () => new Response(JSON.stringify({ data: { followers: '10000000000000000000' } }))) }), worker = new DurableWorker(f.context(), [metricsHandler(metrics)]);
    metrics.collectAccount(f.request(), work.account_id, {}); assert.equal((await worker.runOnce())?.state, 'committed');
    assert.equal(listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id).length, 0); const accountSnapshots = listAccountSnapshots(f.context().db, f.config.workspace_id, work.account_id); assert.equal(accountSnapshots.length, 1); assert.equal(accountSnapshots[0]!.metrics[0]!.value, '10000000000000000000'); assert.ok(accountSnapshots[0]!.collection_request_id);
    f.reopen(); assert.equal(listAccountSnapshots(f.context().db, f.config.workspace_id, work.account_id).length, 1);
  } finally { f.cleanup(); }
});
test('429 raw / unavailable 保留，Retry-After 持久恢复使用新 request ID', async () => {
  const f = fixture(); try {
    let now = Date.now(), calls = 0; const work = await ownWork(f), create = () => new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work)], async () => ++calls === 1 ? new Response(JSON.stringify({ data: null }), { status: 429, headers: { 'Retry-After': '120' } }) : new Response(JSON.stringify({ data: { like_count: 9 } })), () => now) });
    let metrics = create(), worker = new DurableWorker(f.context(), [metricsHandler(metrics)], { clock: () => now }); const job = metrics.collectWork(f.request(), work.work_id, {}); assert.equal((await worker.runOnce())?.state, 'waiting_quota');
    assert.equal(listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id)[0]!.metrics[0]!.reason, 'provider_rate_limited'); assert.equal(metrics.resumeDueRetries(), 0);
    f.reopen(); now += 120_001; metrics = create(); assert.equal(metrics.resumeDueRetries(), 1); worker = new DurableWorker(f.context(), [metricsHandler(metrics)], { clock: () => now }); assert.equal((await worker.runOnce())?.state, 'committed');
    const rows = listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id); assert.equal(rows.length, 2); assert.notEqual(rows[0]!.collection_request_id, rows[1]!.collection_request_id); assert.equal(calls, 2); assert.equal(metrics.jobs.get(f.request(), job.job_id).attempts.length, 2);
    evidence('rate-limit-lineage.json', { evidence_kind: 'internal_rule', captured_at: new Date().toISOString(), snapshots: rows.map(row => ({ snapshot_id: row.id, request_id: row.collection_request_id, metrics: row.metrics, raw_sha256: row.raw_sha256, raw_ref: preserveRaw(row) })), retry_at: 'simulated 120 seconds after actual first call', state: metrics.jobs.get(f.request(), job.job_id).job.state });
  } finally { f.cleanup(); }
});
test('401 / HTTP200 平台权限错误保持 waiting_input，不自动重试', async () => {
  const f = fixture(); try {
    const work = await ownWork(f), metrics = new Metrics(f.context(), { adapter: adapter([target(work)], async () => new Response(JSON.stringify({ code: 403, data: null }))) }), worker = new DurableWorker(f.context(), [metricsHandler(metrics)]);
    metrics.collectWork(f.request(), work.work_id, {}); assert.equal((await worker.runOnce())?.state, 'waiting_input'); assert.equal(metrics.resumeDueRetries(), 0); assert.equal(listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id)[0]!.metrics[0]!.reason, 'provider_permission_denied');
  } finally { f.cleanup(); }
});
test('raw已持久化后中断，跨会话恢复重放响应而非再次请求', async () => {
  const f = fixture(); try {
    let now = Date.now(), calls = 0; const work = await ownWork(f), create = () => new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work)], async () => { calls++; return new Response(JSON.stringify({ data: { like_count: 4 } })); }, () => now) });
    let metrics = create(); const job = metrics.collectWork(f.request(), work.work_id, {}), claim = metrics.jobs.claim('fixture-crash')!;
    await assert.rejects(metrics.executeCollection({ claim, signal: new AbortController().signal, checkpoint(value) { metrics.jobs.checkpoint(claim.fence, value); if (value.response) throw new Error('injected after durable raw response'); } }), /injected/);
    assert.equal(calls, 1); assert.equal(listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id).length, 0);
    f.reopen(); now += 60_001; metrics = create(); const worker = new DurableWorker(f.context(), [metricsHandler(metrics)], { clock: () => now }); assert.equal((await worker.runOnce())?.state, 'committed'); assert.equal(calls, 1); assert.equal(listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id).length, 1); assert.equal(metrics.jobs.get(f.request(), job.job_id).attempts.length, 2);
  } finally { f.cleanup(); }
});
test('lease / cancel fence 拒绝晚到快照', async () => {
  const f = fixture(); try {
    const work = await ownWork(f); let metrics: Metrics, jobId = '';
    metrics = new Metrics(f.context(), { adapter: adapter([target(work)], async () => { const job = metrics.jobs.get(f.request(), jobId).job; metrics.jobs.cancel(f.request(), jobId, { expected_version: job.version }); return new Response(JSON.stringify({ data: { like_count: 4 } })); }) });
    jobId = metrics.collectWork(f.request(), work.work_id, {}).job_id; const worker = new DurableWorker(f.context(), [metricsHandler(metrics)]); assert.equal((await worker.runOnce())?.state, 'cancelled'); assert.equal(listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id).length, 0);
  } finally { f.cleanup(); }
});
test('缺配置零网络、未知观察不推测、real模式拒绝fixture', async () => {
  const f = fixture(); try {
    const work = await ownWork(f), previous = process.env.WP12_ABSENT_TOKEN; delete process.env.WP12_ABSENT_TOKEN; let calls = 0;
    const noConfig = new TikHubAdapter({ token_env: 'WP12_ABSENT_TOKEN', fetcher: async () => { calls++; throw new Error('must not call'); } }), metrics = new Metrics(f.context(), { adapter: noConfig }), worker = new DurableWorker(f.context(), [metricsHandler(metrics)]);
    metrics.collectWork(f.request(), work.work_id, {}); assert.equal((await worker.runOnce())?.state, 'waiting_input'); assert.equal(calls, 0); assert.equal(noConfig.credentialPresent(), false);
    const real = { ...f.context(), config: { ...f.config, mode: 'real' as const } }; throwsCode(() => new Metrics(real, { adapter: adapter([target(work)], async () => new Response('{}')) }), 'VALIDATION_ERROR');
    if (previous !== undefined) process.env.WP12_ABSENT_TOKEN = previous;
  } finally { f.cleanup(); }
});
test('raw hash / symlink / 跨根读取拒绝', () => {
  const f = fixture(); try {
    const raw = new MetricsRawFiles(f.config.paths.state_root), id = randomUUID(), saved = raw.write(id, '{"fixture":true}'); assert.equal(raw.read(saved.path, saved.sha256), '{"fixture":true}'); assert.deepEqual(raw.write(id, '{"fixture":true}'), saved);
    writeFileSync(saved.path, '{"fixture":false}'); throwsCode(() => raw.read(saved.path, saved.sha256), 'STORAGE_UNAVAILABLE');
    unlinkSync(saved.path); const outside = join(f.root, 'outside.json'); writeFileSync(outside, '{}'); symlinkSync(outside, saved.path); throwsCode(() => raw.read(saved.path, saved.sha256), 'STORAGE_UNAVAILABLE'); throwsCode(() => raw.read(outside, saved.sha256), 'STORAGE_UNAVAILABLE');
  } finally { f.cleanup(); }
});
