import { randomUUID } from 'node:crypto';
import { ContractError, type JsonObject, type RequestContext } from '@workbench/contracts';
import type { ApplicationContext } from '@workbench/domain/ports';
import { Jobs } from '@workbench/domain/jobs';
import { ResultCommit, type TypedOutput } from '@workbench/domain/result-commit';
import { DEFAULT_HEARTBEAT_MS, type Clock, type ClaimedJob, type JobRegistration, type ClaimOptions } from '@workbench/storage/jobs';

// 容量忙退回后的让出时间按连续次数指数增长，避免槽位长期占满时每 500ms 领取一次。
export const CAPACITY_BACKOFF_MS = 500, CAPACITY_BACKOFF_MAX_MS = 10_000;
export interface WorkerExecution { claim: ClaimedJob; signal: AbortSignal; checkpoint(value: JsonObject): void }
export interface WorkerHandler { registration: JobRegistration; execute(input: WorkerExecution): Promise<TypedOutput> }
// 唯一主服务消费显式登记的 handler；本模块不启动模型或平台调用，也不领取 host_session。
export class DurableWorker {
  readonly context: ApplicationContext; readonly handlers: readonly WorkerHandler[]; readonly owner: string;
  readonly jobs: Jobs; readonly results: ResultCommit;
  private cooldown = new Map<string, number>(); private busyStreak = new Map<string, number>(); readonly heartbeatMs: number;
  constructor(context: ApplicationContext, handlers: readonly WorkerHandler[], options: { owner?: string; clock?: Clock; heartbeat_ms?: number } = {}) {
    if (handlers.some(handler => !['programmatic', 'service_adapter'].includes(handler.registration.execution_mode))) throw new ContractError('VALIDATION_ERROR', 'worker 不能登记原生宿主任务');
    if (new Set(handlers.map(handler => `${handler.registration.execution_mode}:${handler.registration.kind}`)).size !== handlers.length) throw new ContractError('VALIDATION_ERROR', 'worker handler 重复');
    this.context = context; this.handlers = handlers; this.owner = options.owner ?? `worker:${randomUUID()}`;
    this.jobs = new Jobs(context, { registrations: handlers.map(handler => handler.registration), ...(options.clock ? { clock: options.clock } : {}) });
    this.results = new ResultCommit(context, options.clock ? { clock: options.clock } : {});
    this.heartbeatMs = options.heartbeat_ms ?? DEFAULT_HEARTBEAT_MS;
  }
  runOnce(options: { signal?: AbortSignal; claim?: ClaimOptions } = {}): Promise<{ job_id: string; state: string } | null> { return this.startNext(options) ?? Promise.resolve(null); }
  startNext(options: { signal?: AbortSignal; claim?: ClaimOptions } = {}): Promise<{ job_id: string; state: string }> | null {
    if (options.signal?.aborted) return null;
    for (const [id, until] of this.cooldown) if (until <= Date.now()) this.cooldown.delete(id);
    this.jobs.recoverExpired({ registered_only: true }); const claim = this.jobs.claim(this.owner, { ...options.claim, exclude_job_ids: [...this.cooldown.keys(), ...(options.claim?.exclude_job_ids ?? [])] }); if (!claim) return null;
    return this.execute(claim, options.signal);
  }
  private async execute(claim: ClaimedJob, signal?: AbortSignal): Promise<{ job_id: string; state: string }> {
    const handler = this.handlers.find(handler => handler.registration.kind === claim.job.kind && handler.registration.execution_mode === claim.job.execution_mode)!;
    const abort = new AbortController(); let checkpoint: JsonObject = JSON.parse(claim.attempt.checkpoint), capacityBusy = false;
    const previousHandle = checkpoint.agent_handle as JsonObject | undefined;
    let resumePending = !!previousHandle;
    const stopped = () => abort.abort(signal?.reason); signal?.addEventListener('abort', stopped, { once: true }); if (signal?.aborted) stopped();
    const timer = setInterval(() => {
      try { this.jobs.heartbeat(claim.fence, checkpoint); }
      catch { abort.abort(new Error('LEASE_REVOKED')); }
    }, this.heartbeatMs); timer.unref();
    try {
      if (checkpoint.resume_submission_unknown === true) throw new ContractError('RESULT_UNKNOWN', '此前恢复提交未取得新身份，先核对原请求，不重复提交', { no_new_turn_started: true });
      const output = await handler.execute({ claim, signal: abort.signal, checkpoint: value => {
        const nextHandle = value.agent_handle as JsonObject | undefined, result = value.result_manifest as JsonObject | undefined;
        if (resumePending && (result?.native_status === 'completed' || (typeof nextHandle?.runtime_turn_id === 'string' && !!nextHandle.runtime_turn_id && (nextHandle.runtime_session_id !== previousHandle?.runtime_session_id || nextHandle.runtime_turn_id !== previousHandle?.runtime_turn_id)))) resumePending = false;
        // handler 在 resume 前同步 checkpoint；先写保护，再允许可能提交的新调用，覆盖进程崩溃窗口。
        const persisted = this.jobs.checkpoint(claim.fence, { ...value, ...(previousHandle ? { resume_submission_unknown: resumePending } : {}) }); checkpoint = JSON.parse(persisted.checkpoint);
      } });
      const current = this.jobs.get(this.request(), claim.job.id).job;
      const result = this.results.submit(this.request(`worker-output:${claim.attempt.id}`), claim.job.id,
        { attempt_id: claim.attempt.id, attempt_generation: claim.attempt.attempt_generation, expected_version: current.version, input_hash: claim.job.input_hash, typed_output: output }, this.owner);
      return { job_id: claim.job.id, state: result.state };
    } catch (error) {
      if (error instanceof ContractError && error.details.resume_submission_unknown === true) {
        try { this.jobs.checkpoint(claim.fence, { ...checkpoint, resume_submission_unknown: true }); } catch { /* 失效 fence 无权写回。 */ }
      } else if (previousHandle && error instanceof ContractError && error.details.pre_submit_failure === true) {
        try { this.jobs.checkpoint(claim.fence, { ...checkpoint, resume_submission_unknown: false }); } catch { /* 未提交事实不能越过失效 fence。 */ }
      }
      if (error instanceof ContractError && error.details.executor_capacity_busy === true && error.details.pre_submit_failure === true) {
        const streak = (this.busyStreak.get(claim.job.id) ?? 0) + 1; capacityBusy = true; this.busyStreak.set(claim.job.id, streak);
        this.cooldown.set(claim.job.id, Date.now() + Math.min(CAPACITY_BACKOFF_MAX_MS, CAPACITY_BACKOFF_MS * 2 ** (streak - 1)));
        try { return { job_id: claim.job.id, state: this.jobs.deferCapacity(claim.fence, JSON.parse(claim.attempt.checkpoint)).state }; }
        catch { return { job_id: claim.job.id, state: this.jobs.get(this.request(), claim.job.id).job.state }; }
      }
      if (error instanceof ContractError && error.code === 'STORAGE_UNAVAILABLE') return { job_id: claim.job.id, state: 'pending_repair' };
      const code = error instanceof ContractError ? error.code : 'EXECUTION_FAILED';
      // 认证/额度错误本身不能证明副作用未发生；媒体/发布仍先核对实际结果。
      const state = ['media', 'external_side_effect'].includes(handler.registration.recovery) ? 'reconciling'
        : code === 'AUTH_REQUIRED' ? 'waiting_input' : code === 'QUOTA_EXHAUSTED' ? 'waiting_quota' : 'failed';
      try { const job = this.jobs.fail(claim.fence, { code, message: error instanceof Error ? error.message : '执行未完成',
        ...(error instanceof ContractError ? { details: error.details, retryable: error.retryable } : {}) }, state); return { job_id: job.id, state: job.state }; }
      catch { return { job_id: claim.job.id, state: this.jobs.get(this.request(), claim.job.id).job.state }; }
    } finally { clearInterval(timer); signal?.removeEventListener('abort', stopped); if (!capacityBusy) this.busyStreak.delete(claim.job.id); }
  }
  private request(key: string = randomUUID()): RequestContext {
    return { ...this.context.identity, request_id: randomUUID(), idempotency_key: key, request_identity_ref: this.owner };
  }
}
