import { CollectionSchema, AccountCollectionSchema, ContractError } from '@workbench/contracts';
import { Metrics, type MetricsOptions } from '@workbench/domain/metrics';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
import { DurableWorker } from '../worker/core/index.ts';
import { metricsHandler } from '../worker/handlers/metrics/index.ts';

export function createMetricsModule(context: ApplicationContext, options: MetricsOptions & { poll_ms?: number; run_worker?: boolean } = {}): ApplicationModule {
  const metrics = new Metrics(context, options), worker = new DurableWorker(context, [metricsHandler(metrics)], options.clock ? { clock: options.clock } : {});
  let timer: ReturnType<typeof setInterval> | undefined, active: Promise<void> | null = null, closing = false, lastTickError: string | null = null, lastTickAt: string | null = null;
  const tick = () => { if (active || closing) return; active = (async () => { metrics.scheduleWindows(); metrics.resumeDueRetries(); await worker.runOnce(); lastTickError = null; lastTickAt = new Date().toISOString(); })().catch(error => { lastTickError = error instanceof ContractError ? error.code : 'internal_tick_failed'; }).finally(() => { active = null; }); };
  return { id: 'metrics', initialize() { metrics.scheduleWindows(); if (options.run_worker !== false) { timer = setInterval(tick, options.poll_ms ?? 1000); timer.unref(); tick(); } }, async close() { closing = true; if (timer) clearInterval(timer); await active; }, register(registrar) {
    registrar.register({ method: 'GET', path: '/api/v1/works/{id}/snapshots', owner: 'WP-12', handle: request => ({ body: metrics.workSnapshots(request.context, request.params.id!, { ...(request.query.has('metric_keys') ? { metric_keys: request.query.get('metric_keys')!.split(',') } : {}), ...(request.query.has('window') ? { window: Number(request.query.get('window')) } : {}), ...(request.query.has('cursor') ? { cursor: request.query.get('cursor')! } : {}), ...(request.query.has('limit') ? { limit: Number(request.query.get('limit')) } : {}) }) }) });
    registrar.register({ method: 'POST', path: '/api/v1/works/{id}/collections', owner: 'WP-12', mutation: true, idempotent: true, schema: CollectionSchema, handle: request => ({ status: 202, body: metrics.collectWork(request.context, request.params.id!, request.body) }) });
    registrar.register({ method: 'GET', path: '/api/v1/accounts/{id}/snapshots', owner: 'WP-12', handle: request => ({ body: metrics.accountSnapshots(request.context, request.params.id!, { ...(request.query.has('cursor') ? { cursor: request.query.get('cursor')! } : {}), ...(request.query.has('limit') ? { limit: Number(request.query.get('limit')) } : {}) }) }) });
    registrar.register({ method: 'POST', path: '/api/v1/accounts/{id}/collections', owner: 'WP-12', mutation: true, idempotent: true, schema: AccountCollectionSchema, handle: request => ({ status: 202, body: metrics.collectAccount(request.context, request.params.id!, request.body) }) });
  }, health: () => { const readiness = metrics.readiness(); return { module: 'metrics', status: lastTickError ? 'degraded' : !readiness.ready_targets ? 'blocked' : readiness.auto_observation.enabled && readiness.auto_observation.blocked_works ? 'degraded' : 'ready', details: { ...readiness, last_tick_at: lastTickAt, last_tick_error: lastTickError } }; } };
}
