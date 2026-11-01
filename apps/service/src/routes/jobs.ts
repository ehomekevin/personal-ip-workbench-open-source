import {ImageGenerationWorkflow} from '@workbench/domain/artifact-execution';
import {ImageQuerySchema} from '@workbench/contracts';
import { CancelJobSchema, ResumeJobSchema, type JobState } from '@workbench/contracts';
import { ArtifactExecution } from '@workbench/domain/artifact-execution';
import { Jobs } from '@workbench/domain/jobs';
import type { HostRuns } from '@workbench/domain/host-runs';
import { ResultCommit } from '@workbench/domain/result-commit';
import { DEFAULT_HEARTBEAT_MS } from '@workbench/storage/jobs';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
import { authenticateHostRequest } from './host-auth.ts';

export function createJobsModule(context: ApplicationContext, hostRuns?:HostRuns): ApplicationModule {
  const jobs = new Jobs(context), results = hostRuns?.results??new ResultCommit(context);
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  return { id: 'jobs', initialize() {
      jobs.recoverExpired(); results.recover();
      recoveryTimer = setInterval(() => { try { jobs.recoverExpired(); results.recover(); } catch { /* 持久 pending 留在数据库，health 显示 degraded；不制造成功。 */ } }, DEFAULT_HEARTBEAT_MS); recoveryTimer.unref();
    }, close() { if (recoveryTimer) clearInterval(recoveryTimer); },
    register(registrar) {
      registrar.register({method:'POST',path:'/api/v1/jobs/{id}/image-query',owner:'IMAGE-PROVIDER-AGY-INTEGRATION',mutation:true,idempotent:true,schema:ImageQuerySchema,handle:r=>({status:202,body:new ImageGenerationWorkflow(context).recover(r.context,r.params.id!,r.body.expected_version)})});
      registrar.register({ method: 'GET', path: '/api/v1/jobs', owner: 'WP-09', handle: request => ({ body: jobs.list(request.context,
        { ...(request.query.has('kind') ? { kind: request.query.get('kind')! } : {}), ...(request.query.has('state') ? { state: request.query.get('state')! } : {}),
          ...(request.query.has('target_id') ? { target_id: request.query.get('target_id')! } : {}), ...(request.query.has('cursor') ? { cursor: request.query.get('cursor')! } : {}),
          ...(request.query.has('limit') ? { limit: Number(request.query.get('limit')) } : {}) }) }) });
      registrar.register({ method: 'GET', path: '/api/v1/jobs/{id}', owner: 'WP-09', handle: request => ({ body: jobs.get(request.context, request.params.id!) }) });
      registrar.register({ method: 'POST', path: '/api/v1/jobs/{id}/cancel', owner: 'WP-09', mutation: true, idempotent: true, schema: CancelJobSchema,
        handle: async request => {const job=jobs.cancel(request.context,request.params.id!,request.body);if(job.kind==='media_generate'&&job.state==='reconciling'){try{await new ArtifactExecution(context).reconcileCancelled(request.context,job.id);}catch{/* 逻辑撤销已保存；物理归属不明时保留 reconciling，不报告取消完成。 */}}return {body:jobs.get(request.context,job.id).job};} });
      registrar.register({ method: 'POST', path: '/api/v1/jobs/{id}/resume', owner: 'WP-09', mutation: true, idempotent: true, schema: ResumeJobSchema,
        handle: request => ({ body: !request.body.recovery_action&&hostRuns&&jobs.get(request.context,request.params.id!).job.execution_mode==='host_session'?hostRuns.resume(request.context,authenticateHostRequest(context,hostRuns,request.headers,'connection'),request.params.id!,request.body):jobs.resume(request.context, request.params.id!, request.body) }) });
      registrar.register({ method: 'GET', path: '/api/v1/jobs/{id}/events', owner: 'WP-09', handle: request => ({ body: jobs.events(request.context, request.params.id!, Number(request.query.get('after_seq') ?? 0), Number(request.query.get('limit') ?? 100)) }) });
    },
    health() {
      const workspace = context.identity.workspace_id;
      const pending = Number(context.db.prepare("SELECT COUNT(*) AS n FROM result_receipts WHERE workspace_id=? AND state='pending'").get(workspace)!.n);
      const counts = context.db.prepare('SELECT state,COUNT(*) AS n FROM jobs WHERE workspace_id=? GROUP BY state').all(workspace);
      return { module: 'jobs', status: pending ? 'degraded' : 'ready', details: { pending_receipts: pending,
        states: Object.fromEntries(counts.map(row => [row.state as JobState, Number(row.n)])), host_tracking: 'WP-17 / unverified' } };
    },
  };
}
