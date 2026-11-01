import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { startApplication } from '../../apps/service/src/bootstrap/application.ts';
import { createWorksModule } from '../../apps/service/src/routes/works.ts';
import { createMetricsModule } from '../../apps/service/src/routes/metrics.ts';
import { createJobsModule } from '../../apps/service/src/routes/jobs.ts';
import { Metrics } from '../../packages/domain/src/metrics/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { metricsHandler } from '../../apps/service/src/worker/handlers/metrics/index.ts';
import { fixture, ownWork, adapter, target, evidence } from './harness.ts';

test('随机端口正式HTTP：导入/筛选/采集/快照/账户/identity状态/跨启动恢复', async () => {
  const f = fixture(); let app: Awaited<ReturnType<typeof startApplication>> | undefined;
  try {
    const work = await ownWork(f), provider = adapter([target(work), target(work, { scope: 'account' })], async () => new Response(JSON.stringify({ data: { like_count: 0 } })));
    f.closeDb(); const factories = [createWorksModule, context => createMetricsModule(context, { adapter: provider, run_worker: false }), createJobsModule] satisfies NonNullable<Parameters<typeof startApplication>[1]>['moduleFactories'];
    app = await startApplication(f.config, { port: 0, moduleFactories: factories }); const actualPort = app.address.port; assert.notEqual(actualPort, 4318); const events: unknown[] = [];
    const call = async (method: string, path: string, body?: unknown, key: string = randomUUID()) => {
      const response = await fetch(`http://127.0.0.1:${app!.address.port}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': f.config.workspace_id, 'X-Service-Instance-Id': f.config.service_instance_id, 'Idempotency-Key': key }, body: body === undefined ? undefined : JSON.stringify(body) });
      const value = await response.json() as Record<string, unknown>; events.push({ method, path, status: response.status, result_hash: createHash('sha256').update(JSON.stringify(value)).digest('hex'), observed_at: new Date().toISOString() }); return { response, value };
    };
    const imported = await call('POST', '/api/v1/works/import', { platform: 'douyin', platform_work_id: '555' }); assert.equal(imported.response.status, 201); const pendingId = String(imported.value.work_id);
    const list = await call('GET', '/api/v1/works?identity_status=pending'); assert.equal((list.value.items as unknown[]).length, 1);
    assert.equal((await call('POST', `/api/v1/works/${pendingId}/collections`, {})).response.status, 422);
    assert.equal((await call('POST', `/api/v1/works/${pendingId}/identity-check`, { job_id: randomUUID() })).value.error && true, true);
    const collection = await call('POST', `/api/v1/works/${work.work_id}/collections`, {}, 'http-collect-one'); assert.equal(collection.response.status, 202); assert.equal((await call('POST', `/api/v1/works/${work.work_id}/collections`, {}, 'http-collect-one')).value.job_id, collection.value.job_id);
    const metrics = new Metrics(app.context, { adapter: provider }), worker = new DurableWorker(app.context, [metricsHandler(metrics)]); await worker.runOnce();
    const snapshots = await call('GET', `/api/v1/works/${work.work_id}/snapshots?metric_keys=like`); const first = (snapshots.value.items as Array<Record<string, unknown>>)[0]!; assert.equal((first.metrics as Array<Record<string, unknown>>)[0]!.value, '0'); assert.equal(first.observed_at, null); assert.equal(first.observed_age_s, null);
    assert.equal((await call('POST', `/api/v1/accounts/${work.account_id}/collections`, {})).response.status, 202); await worker.runOnce(); assert.equal(((await call('GET', `/api/v1/accounts/${work.account_id}/snapshots`)).value.items as unknown[]).length, 1);
    await app.close(); app = undefined; app = await startApplication(f.config, { port: 0, moduleFactories: factories }); assert.equal(((await call('GET', '/api/v1/works')).value.items as unknown[]).length, 2); assert.equal(((await call('GET', `/api/v1/works/${work.work_id}/snapshots`)).value.items as unknown[]).length, 1);
    evidence('http-verification.json', { evidence_kind: 'internal_rule', result: 'passed', captured_at: new Date().toISOString(), actual_port: actualPort, restarted_port: app.address.port, calls: events, actual_platform_calls: 0, fixtures_only: true, roots_cleaned: true });
  } finally { await app?.close(); f.cleanup(); }
});
