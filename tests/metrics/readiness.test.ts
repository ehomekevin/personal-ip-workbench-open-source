import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { JsonObject } from '../../packages/contracts/src/index.ts';
import { Metrics } from '../../packages/domain/src/metrics/index.ts';
import { Jobs } from '../../packages/domain/src/jobs/index.ts';
import { Works } from '../../packages/domain/src/works/index.ts';
import { TikHubAdapter } from '../../packages/adapters/src/tikhub/index.ts';
import { transaction } from '../../packages/storage/src/connection/index.ts';
import { queueJobInTransaction } from '../../packages/storage/src/jobs/index.ts';
import { listWorkSnapshots } from '../../packages/storage/src/metrics/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { metricsHandler } from '../../apps/service/src/worker/handlers/metrics/index.ts';
import { createMetricsModule } from '../../apps/service/src/routes/metrics.ts';
import { fixture, ownWork, adapter, target, mapping } from './harness.ts';

const published = '2026-10-01T00:00:00.000Z';
const countJobs = (f: ReturnType<typeof fixture>) => Number(f.context().db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='metrics_collect'").get()!.n);
async function anotherWork(f: ReturnType<typeof fixture>, accountId: string, platformId: string) {
  const works = new Works(f.context()), url = `https://x.com/owner/status/${platformId}`;
  const imported = await works.importWork(f.request(), { platform: 'x', url });
  works.resolveVerified(f.request(), imported.work_id, { platform_work_id: platformId, account_id: accountId, evidence: { evidence_kind: 'internal_rule', fixture: true } });
  works.registerPlatformMetadata(f.request(), imported.work_id, { published_at: published, format: 'text', evidence: { evidence_kind: 'internal_rule', fixture: true } });
  return { work_id: imported.work_id, account_id: accountId, platform_id: platformId, url };
}
function legacyQueue(f: ReturnType<typeof fixture>, metrics: Metrics, workId: string, seconds: number, now: number) {
  const identity = metrics.identity('work', workId);
  return transaction(f.context().db, () => queueJobInTransaction(f.context().db, f.config.workspace_id, {
    kind: 'metrics_collect', target_id: workId, execution_mode: 'programmatic', entrypoint: 'standalone_web', presentation: 'background', due_at: new Date(Date.parse(published) + seconds * 1000).toISOString(), retry_policy: { recovery: 'read_only', max_attempts: 3 },
    input_manifest: { schema_version: 'wp12-metrics-v1', mode: 'none', targets: [], source_ids: [], scope: 'work', source_target_id: workId, identity: identity as unknown as JsonObject, target_window: seconds, schedule_key: `${workId}:${published}:${seconds}` },
  }, now));
}

test('自动观察需凭据、已选核对目标和有效映射；partial ready只排对应作品，tick幂等', async () => {
  const f = fixture(); try {
    const work = await ownWork(f, { id: '1', published_at: published }), missing = await anotherWork(f, work.account_id, '2');
    const now = Date.parse(published) + 29 * 3600_000, neverFetch: typeof fetch = async () => { throw new Error('must_not_fetch'); };
    const absent = new Metrics(f.context(), { clock: () => now, adapter: adapter([], neverFetch) });
    assert.deepEqual(absent.scheduleWindows(), []); assert.equal(countJobs(f), 0);
    assert.deepEqual(absent.readiness().auto_observation.blocked_reasons, { missing_selected_verified_target: 2 });
    const noCredential = new Metrics(f.context(), { clock: () => now, adapter: new TikHubAdapter({ targets: [target(work)], token_provider: () => null, fetcher: neverFetch }) });
    assert.deepEqual(noCredential.scheduleWindows(), []); assert.equal(noCredential.readiness().reason, 'missing_config');
    for (const metrics of [[], [mapping('like', null)], [{ ...mapping(), mapping_evidence_ref: null }], [{ ...mapping(), unsupported: true }]]) {
      const unverified = new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work, { metrics })], neverFetch) });
      assert.deepEqual(unverified.scheduleWindows(), []); assert.equal(unverified.readiness().reason, 'missing_verified_metric_mapping');
    }
    assert.equal(countJobs(f), 0);
    const ready = new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work)], neverFetch) });
    const schedules = ready.scheduleWindows(); assert.equal(schedules.length, 3); assert.ok(schedules.every(item => item.work_id === work.work_id));
    assert.deepEqual(ready.scheduleWindows(), schedules); assert.equal(countJobs(f), 3);
    assert.equal(ready.readiness().auto_observation.ready_works, 1); assert.equal(ready.readiness().auto_observation.blocked_works, 1);
    assert.equal(new Set(schedules.map(item => item.target_window)).size, 3); assert.ok(!schedules.some(item => item.work_id === missing.work_id));
    const module = createMetricsModule(f.context(), { adapter: ready.adapter, clock: () => now, run_worker: false });
    assert.equal((await module.health()).status, 'degraded');
  } finally { f.cleanup(); }
});

test('131个遗留未ready自动任务不耗attempt、不饿死后面的ready任务；手动采集保持', async () => {
  const f = fixture(); try {
    const work = await ownWork(f, { published_at: published }); let now = Date.parse(published) + 29 * 3600_000, calls = 0;
    const blocked = new Metrics(f.context(), { clock: () => now, adapter: adapter([], async () => { throw new Error('must_not_fetch'); }) });
    for (let i = 0; i < 131; i++) legacyQueue(f, blocked, work.work_id, 86400, now);
    const worker = new DurableWorker(f.context(), [metricsHandler(blocked)], { clock: () => now });
    for (let i = 0; i < 3; i++) assert.equal(await worker.runOnce(), null);
    assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM job_attempts').get()!.n, 0);
    assert.equal(blocked.readiness().auto_observation.queued_blocked, 131);
    now += 1000;
    const jobs = new Jobs(f.context(), { clock: () => now, registrations: [metricsHandler(blocked).registration, { kind: 'document_modify', execution_mode: 'service_adapter', recovery: 'read_only' }] });
    const document = jobs.enqueue(f.request(), { kind: 'document_modify', target_id: null, execution_mode: 'service_adapter', entrypoint: 'standalone_web', presentation: 'foreground_dialog', input_manifest: { mode: 'none', targets: [], source_ids: [] } });
    assert.equal(jobs.claim('ready-document')?.job.id, document.id);
    const manualOnly = new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work, { scope: 'account' })], async () => { calls++; return new Response(JSON.stringify({ data: { like_count: 2 } })); }) });
    const manual = manualOnly.collectAccount(f.request(), work.account_id, {});
    const manualWorker = new DurableWorker(f.context(), [metricsHandler(manualOnly)], { clock: () => now });
    assert.deepEqual(await manualWorker.runOnce(), { job_id: manual.job_id, state: 'committed' }); assert.equal(calls, 1);
    assert.equal(f.context().db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='metrics_collect' AND state='queued'").get()!.n, 131);
    assert.equal(manualOnly.jobs.get(f.request(), manual.job_id).job.state, 'succeeded');
  } finally { f.cleanup(); }
});

test('首次配置只推进当前真实窗口；旧queued窗口保留并明确elapsed，一次tick仅一次请求', async () => {
  const f = fixture(); try {
    const work = await ownWork(f, { published_at: published }); const now = Date.parse(published) + 180 * 3600_000; let calls = 0;
    const absent = new Metrics(f.context(), { clock: () => now, adapter: adapter([], async () => { throw new Error('must_not_fetch'); }) });
    const oldJobs = [86400, 259200, 604800].map(seconds => legacyQueue(f, absent, work.work_id, seconds, now));
    assert.equal(await new DurableWorker(f.context(), [metricsHandler(absent)], { clock: () => now }).runOnce(), null);
    const ready = new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work)], async () => { calls++; return new Response(JSON.stringify({ data: { like_count: 2 } })); }, () => now) });
    assert.deepEqual(ready.scheduleWindows().map(item => item.job_id), [oldJobs[2]!.id]); assert.equal(countJobs(f), 3);
    assert.deepEqual(ready.readiness().auto_observation.queued_blocked_reasons, { observation_window_elapsed: 2 });
    const worker = new DurableWorker(f.context(), [metricsHandler(ready)], { clock: () => now });
    assert.deepEqual(await worker.runOnce(), { job_id: oldJobs[2]!.id, state: 'committed' }); assert.equal(calls, 1);
    assert.equal(await worker.runOnce(), null); assert.equal(calls, 1); assert.equal(countJobs(f), 3);
    assert.equal(ready.jobs.get(f.request(), oldJobs[0]!.id).attempts.length, 0); assert.equal(ready.jobs.get(f.request(), oldJobs[1]!.id).attempts.length, 0);
    const snapshot = listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id)[0]!;
    assert.equal(snapshot.target_window, 604800); assert.equal(snapshot.observed_at, null); assert.equal(snapshot.observed_age_s, null);
    assert.equal(snapshot.observed_time_basis, 'unknown');
    const freshWork = await anotherWork(f, work.account_id, '456');
    const late = new Metrics(f.context(), { clock: () => now, adapter: adapter([target(freshWork)], async () => { throw new Error('must_not_fetch'); }) });
    assert.deepEqual(late.scheduleWindows().map(item => item.target_window), [604800]);
  } finally { f.cleanup(); }
});

test('已ready作品三个真实窗口各只采一次，重复tick及重启不增加任务或请求', async () => {
  const f = fixture(); try {
    const work = await ownWork(f, { published_at: published }); let now = Date.parse(published), calls = 0;
    const create = () => new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work)], async () => { calls++; return new Response(JSON.stringify({ data: { like_count: calls } })); }, () => now) });
    let metrics = create(); const original = metrics.scheduleWindows(); assert.equal(original.length, 3);
    for (const hours of [24, 72, 168]) {
      now = Date.parse(published) + hours * 3600_000;
      const worker = new DurableWorker(f.context(), [metricsHandler(metrics)], { clock: () => now });
      assert.equal((await worker.runOnce())?.state, 'committed'); assert.equal(await worker.runOnce(), null);
      metrics.scheduleWindows(); assert.equal(countJobs(f), 3);
      f.reopen(); metrics = create(); metrics.scheduleWindows(); assert.equal(countJobs(f), 3);
    }
    assert.equal(calls, 3); assert.deepEqual(listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id).map(snapshot => snapshot.target_window), [86400, 259200, 604800]);
    assert.equal(f.context().db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='metrics_collect' AND state='succeeded'").get()!.n, 3);
  } finally { f.cleanup(); }
});

test('自动retry失去目标后不恢复、不改写历史；重新配置后按原有上限推进', async () => {
  const f = fixture(); try {
    const work = await ownWork(f, { published_at: published }); let now = Date.parse(published) + 29 * 3600_000, calls = 0;
    const configured = new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work)], async () => { calls++; return new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }); }, () => now) });
    const job = configured.scheduleWindows()[0]!;
    assert.equal((await new DurableWorker(f.context(), [metricsHandler(configured)], { clock: () => now }).runOnce())?.state, 'waiting_quota');
    now += 60_001;
    const absent = new Metrics(f.context(), { clock: () => now, adapter: adapter([], async () => { throw new Error('must_not_fetch'); }) });
    assert.equal(absent.resumeDueRetries(), 0); assert.equal(absent.jobs.get(f.request(), job.job_id).attempts.length, 1); assert.equal(calls, 1);
    const restored = new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work)], async () => { calls++; return new Response(JSON.stringify({ data: { like_count: 5 } })); }, () => now) });
    assert.equal(restored.resumeDueRetries(), 1); assert.equal(restored.resumeDueRetries(), 0);
    assert.equal((await new DurableWorker(f.context(), [metricsHandler(restored)], { clock: () => now }).runOnce())?.state, 'committed');
    assert.equal(restored.jobs.get(f.request(), job.job_id).attempts.length, 2); assert.equal(calls, 2);
  } finally { f.cleanup(); }
});

test('已持久raw恢复验证归属和hash，移除target后只重放；伪checkpoint不触发请求', async () => {
  const f = fixture(); try {
    const work = await ownWork(f, { published_at: published }); let now = Date.parse(published) + 29 * 3600_000, calls = 0;
    const ready = new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work)], async () => { calls++; return new Response(JSON.stringify({ data: { like_count: 4 } })); }, () => now) });
    const job = ready.scheduleWindows()[0]!, claim = ready.jobs.claim('crash')!;
    assert.equal(claim.job.id, job.job_id);
    await assert.rejects(ready.executeCollection({ claim, signal: new AbortController().signal, checkpoint(value) { ready.jobs.checkpoint(claim.fence, value); if (value.response) throw new Error('crash_after_raw'); } }), /crash_after_raw/);
    const saved = ready.jobs.get(f.request(), job.job_id).checkpoint!;
    const absent = new Metrics(f.context(), { clock: () => now, adapter: adapter([], async () => { throw new Error('must_not_fetch'); }) });
    assert.equal(absent.automaticReadiness(claim.job, saved).ready, true);
    assert.equal(absent.automaticReadiness(claim.job, { response: {} }).reason, 'saved_response_invalid');
    const foreign = structuredClone(saved); (foreign.response as JsonObject).target_id = randomUUID();
    assert.equal(absent.automaticReadiness(claim.job, foreign).reason, 'saved_response_invalid');
    const invalidHash = structuredClone(saved); (invalidHash.response as JsonObject).raw_sha256 = '0'.repeat(64);
    assert.equal(absent.automaticReadiness(claim.job, invalidHash).reason, 'saved_response_invalid');
    now += 60_001;
    assert.equal((await new DurableWorker(f.context(), [metricsHandler(absent)], { clock: () => now }).runOnce())?.state, 'committed');
    assert.equal(calls, 1); assert.equal(listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id).length, 1);
    writeFileSync((saved.response as JsonObject).raw_path as string, '{}');
    assert.equal(absent.automaticReadiness(claim.job, saved).reason, 'saved_response_invalid'); assert.equal(calls, 1);
  } finally { f.cleanup(); }
});
