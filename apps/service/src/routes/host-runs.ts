import { BeginHostRunSchema, RenewHostRunSchema, ReceiveHostOutputSchema } from '@workbench/contracts';
import { HostRuns, type HostRunsOptions } from '@workbench/domain/host-runs';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
import { createHostObserversModule } from './host-observers.ts';
import { authenticateHostRequest } from './host-auth.ts';

export function createHostRunsModule(context: ApplicationContext, runs: HostRuns): ApplicationModule {
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  return { id: 'host-runs', initialize() {
    runs.initialize(); recoveryTimer = setInterval(() => { try { runs.recoverExpired(); runs.results.recover(); } catch { /* 原始 pending 仍保留，health 可回查。 */ } }, Math.min(runs.profile.lease_ms, 10_000)); recoveryTimer.unref();
  }, close() { if (recoveryTimer) clearInterval(recoveryTimer); }, register(registrar) {
    registrar.register({ method: 'POST', path: '/api/v1/host-runs', owner: 'WP-17', mutation: true, idempotent: true,
      schema: BeginHostRunSchema,
      handle: request => ({ status: 201, body: runs.begin(request.context, authenticateHostRequest(context, runs, request.headers, 'connection'), request.body) }) });
    registrar.register({ method: 'POST', path: '/api/v1/host-runs/{job_id}/renewals', owner: 'WP-17', mutation: true, idempotent: true,
      schema: RenewHostRunSchema,
      handle: request => ({ body: runs.renew(request.context, authenticateHostRequest(context, runs, request.headers, 'observer'), request.params.job_id!, request.body) }) });
    registrar.register({ method: 'POST', path: '/api/v1/host-runs/{job_id}/outputs', owner: 'WP-17', mutation: true, idempotent: true,
      schema: ReceiveHostOutputSchema,
      handle: request => ({ body: runs.submit(request.context, authenticateHostRequest(context, runs, request.headers, 'connection'), request.params.job_id!, request.body) }) });
    registrar.register({ method: 'GET', path: '/api/v1/host-runs/{job_id}/receipts', owner: 'WP-17', handle: request => ({ body: runs.receipts(request.context, authenticateHostRequest(context, runs, request.headers, 'connection'), request.params.job_id!, {
      ...(request.query.has('state') ? { state: request.query.get('state')! } : {}), ...(request.query.has('cursor') ? { cursor: request.query.get('cursor')! } : {}), ...(request.query.has('limit') ? { limit: Number(request.query.get('limit')) } : {}),
    }) }) });
    registrar.register({ method: 'GET', path: '/api/v1/host-result-receipts/{id}', owner: 'WP-17', handle: request => ({ body: runs.readReceipt(request.context, authenticateHostRequest(context, runs, request.headers, 'connection'), request.params.id!) }) });
  }, health() { return { module: 'host-runs', status: 'blocked', details: { real_host_tracking: 'unverified', protocol: 'available', finalizer: 'WP-09',
    pending_receipts: Number(runs.context.db.prepare("SELECT COUNT(*) AS n FROM result_receipts r JOIN jobs j ON j.workspace_id=r.workspace_id AND j.id=r.job_id WHERE r.workspace_id=? AND j.execution_mode='host_session' AND r.state='pending'").get(runs.context.identity.workspace_id)!.n) } }; } };
}
export function createHostTrackingModules(context: ApplicationContext, options: HostRunsOptions = {}): ApplicationModule[] {
  const runs = new HostRuns(context, options); return [createHostObserversModule(context, runs), createHostRunsModule(context, runs)];
}
