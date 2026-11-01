import { ContractError, type RequestContext, type JobsRow, type JobAttemptsRow, type JsonObject, type CancelJobRequest, type ResumeJobRequest,
  type Page, type JobEventsPage, type JobState } from '@workbench/contracts';
import type { ApplicationContext } from '../ports/index.ts';
import { transaction, claimIdempotency, lookupIdempotency, commitIdempotency, canonicalJson, inputHash } from '@workbench/storage/connection';
import { assertContext, assertCoreFreshness, decodePageCursor, encodePageCursor } from '@workbench/storage/revisions';
import { appendEvent, getJob, getAttempt, queueJobInTransaction, revokeAttemptInTransaction, fenceReason,
  setRecoveryIntentInTransaction, requeueRecoveryIntentInTransaction, assertWorkerRecoveryIntent, claimNextJob, renewWorkerLease, saveWorkerCheckpoint, readEvents, systemClock, type QueueJobInput, type Clock, type JobRegistration, type AttemptFence, type ClaimOptions } from '@workbench/storage/jobs';

export const INTERNAL_REGISTRATIONS: readonly JobRegistration[] = [
  ...['source_sync', 'benchmark_sync', 'metrics_collect', 'source_index'].map(kind => ({ kind, execution_mode: 'programmatic' as const, recovery: 'read_only' as const })),
  ...['document_modify', 'variant_generate', 'wiki_generate', 'retro_generate', 'topic_recommendation', 'account_recommendation', 'speech_cleanup', 'image_plan'].map(kind => ({ kind, execution_mode: 'service_adapter' as const, recovery: 'read_only' as const })),
  { kind: 'media_generate', execution_mode: 'programmatic', recovery: 'media' },
  { kind: 'article_layout_check', execution_mode: 'programmatic', recovery: 'media' },
  { kind: 'publication', execution_mode: 'programmatic', recovery: 'external_side_effect' },
];
export interface JobDetail { job: JobsRow; attempts: JobAttemptsRow[]; checkpoint: JsonObject | null; artifacts: JsonObject[]; error: JsonObject | null; receipts: JsonObject[] }
function object(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value); }
// 检查原任务的固定条件；查询也不能把人工新稿或新核心稿当作旧任务的目标。
export function assertOriginalQueryTargets(context: ApplicationContext, job: JobsRow): void {
  const fixed: unknown = JSON.parse(job.input_manifest);
  if (!object(fixed) || inputHash(fixed) !== job.input_hash || !['initialize','candidate'].includes(String(fixed.mode)) || !Array.isArray(fixed.targets) || fixed.targets.length !== 1)
    throw new ContractError('INPUT_STALE','原任务固定目标不完整',{no_new_turn_started:true});
  const target = fixed.targets[0];
  if (!object(target) || typeof target.document_id !== 'string' || typeof target.core_revision_id !== 'string') throw new ContractError('INPUT_STALE','原任务修订身份不完整',{no_new_turn_started:true});
  const row = context.db.prepare('SELECT v.topic_id,v.id,d.head_revision_id FROM variants v JOIN documents d ON d.workspace_id=v.workspace_id AND d.id=v.document_id WHERE v.workspace_id=? AND v.id=? AND v.document_id=?').get(job.workspace_id,job.target_id,target.document_id);
  if (!row || row.head_revision_id !== target.base_revision_id || (fixed.mode === 'initialize' && row.head_revision_id !== null))
    throw new ContractError('REVISION_CONFLICT','平台稿已变化，保留当前稿；原结果未写入',{no_new_turn_started:true});
  assertCoreFreshness(context.db,job.workspace_id,String(row.topic_id),target.core_revision_id);
}
function assertOriginalQueryCheckpoint(job: JobsRow, checkpoint: JsonObject, workspace: string): void {
  const handle = checkpoint.agent_handle, frozen = JSON.parse(job.input_manifest) as JsonObject;
  const stale = () => { throw new ContractError('INPUT_STALE','原任务输入或原生身份绑定不完整，未提交新任务',{no_new_turn_started:true}); };
  if (!object(handle) || !object(handle.checkpoint)) return stale();
  const cp=handle.checkpoint, run=cp.run_input;
  if (!object(run) || !object(run.input_manifest) || !object(frozen.service_agent) || cp.workspace_id !== workspace || cp.executor_id !== job.executor_id || cp.cwd !== frozen.service_agent.cwd ||
    typeof handle.runtime_session_id !== 'string' || !handle.runtime_session_id || typeof handle.runtime_turn_id !== 'string' || !handle.runtime_turn_id ||
    handle.runtime_session_id !== cp.runtime_session_id || handle.runtime_turn_id !== cp.runtime_turn_id || run.job_id !== job.id || run.kind !== job.kind || checkpoint.fixed_input_hash !== job.input_hash ||
    run.input_manifest.fixed_input_hash !== job.input_hash || canonicalJson(run.input_manifest.frozen) !== canonicalJson(frozen) || cp.input_hash !== inputHash(run.input_manifest) || cp.run_input_hash !== inputHash(run)) return stale();
  const binding={executor_id:cp.executor_id,workspace_id:cp.workspace_id,cwd:cp.cwd,runtime_session_id:cp.runtime_session_id,runtime_turn_id:cp.runtime_turn_id,run_input_hash:cp.run_input_hash};
  if (cp.native_binding_hash !== inputHash(binding)) return stale();
}
export class Jobs {
  readonly context: ApplicationContext; readonly clock: Clock; readonly registrations: readonly JobRegistration[];
  constructor(context: ApplicationContext, options: { clock?: Clock; registrations?: readonly JobRegistration[] } = {}) {
    this.context = context; this.clock = options.clock ?? systemClock; this.registrations = options.registrations ?? INTERNAL_REGISTRATIONS;
  }
  private authorize(request: RequestContext): void {
    assertContext(this.context.db, request, this.context.identity.workspace_id);
    if (request.service_instance_id !== this.context.identity.service_instance_id) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '主服务身份不符');
  }
  enqueue(request: RequestContext, input: Omit<QueueJobInput, 'retry_policy'>): JobsRow {
    this.authorize(request);
    const registration = this.registrations.find(reg => reg.kind === input.kind && reg.execution_mode === input.execution_mode);
    if (!registration) throw new ContractError('CAPABILITY_UNVERIFIED', '任务种类或执行模式尚未登记');
    return transaction(this.context.db, () => queueJobInTransaction(this.context.db, request.workspace_id,
      { ...input, retry_policy: { recovery: registration.recovery, max_attempts: 3 } }, this.clock()));
  }
  get(request: RequestContext, id: string): JobDetail {
    this.authorize(request); const db = this.context.db, job = getJob(db, request.workspace_id, id);
    const attempts = db.prepare('SELECT * FROM job_attempts WHERE workspace_id=? AND job_id=? ORDER BY attempt_no').all(request.workspace_id, id) as unknown as JobAttemptsRow[];
    const last = attempts.at(-1);
    const receipts = db.prepare('SELECT id,attempt_id,attempt_generation,state,result_ids,quarantine_reason FROM result_receipts WHERE workspace_id=? AND job_id=? ORDER BY created_at,id').all(request.workspace_id, id)
      .map(row => ({ receipt_id: String(row.id), attempt_id: String(row.attempt_id), attempt_generation: Number(row.attempt_generation), state: String(row.state), result_ids: JSON.parse(String(row.result_ids)), quarantine_reason: row.quarantine_reason as string | null }));
    return { job, attempts, checkpoint: last ? JSON.parse(last.checkpoint) : null, error: last?.error ? JSON.parse(last.error) : null,
      artifacts: db.prepare("SELECT DISTINCT a.id,a.manifest_path,a.sha256 FROM artifacts a JOIN result_receipts r ON r.workspace_id=a.workspace_id JOIN json_each(r.result_ids,'$.artifact_ids') ids ON ids.value=a.id WHERE a.workspace_id=? AND r.job_id=? AND r.state='committed'").all(request.workspace_id, id) as JsonObject[], receipts };
  }
  list(request: RequestContext, filters: { kind?: string; state?: string; target_id?: string; cursor?: string; limit?: number } = {}): Page<JobsRow> {
    this.authorize(request); const limit = filters.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ContractError('VALIDATION_ERROR', '任务分页参数无效');
    const [createdAt, cursorId] = decodePageCursor(filters.cursor), conditions = ['workspace_id=?'], values: (string | number)[] = [request.workspace_id];
    for (const key of ['kind', 'state', 'target_id'] as const) if (filters[key] !== undefined) { conditions.push(`${key}=?`); values.push(filters[key]!); }
    if (createdAt) { conditions.push('(created_at>? OR (created_at=? AND id>?))'); values.push(createdAt, createdAt, cursorId); }
    const rows = this.context.db.prepare(`SELECT * FROM jobs WHERE ${conditions.join(' AND ')} ORDER BY created_at,id LIMIT ?`).all(...values, limit + 1) as unknown as JobsRow[];
    const items = rows.slice(0, limit), last = items.at(-1);
    return { items, next_cursor: rows.length > limit && last ? encodePageCursor(last) : null, has_more: rows.length > limit, last_success_at: null };
  }
  cancel(request: RequestContext, id: string, input: CancelJobRequest): JobsRow {
    this.authorize(request); return this.mutate(request, 'cancel', id, input, () => {
      const db = this.context.db, job = getJob(db, request.workspace_id, id); this.expected(job, input.expected_version);
      if (['succeeded', 'cancelled'].includes(job.state)) return job;
      const now = this.clock();
      db.prepare('UPDATE jobs SET cancel_requested_at=? WHERE workspace_id=? AND id=?').run(new Date(now).toISOString(), request.workspace_id, id);
      const recovery = JSON.parse(job.retry_policy).recovery;
      const reconcile = job.state !== 'queued' && (recovery === 'media' || recovery === 'external_side_effect');
      const result = revokeAttemptInTransaction(db, request.workspace_id, id, 'CANCEL_REQUESTED', 'cancelled', reconcile ? 'reconciling' : 'cancelled', now);
      appendEvent(db, request.workspace_id, id, reconcile ? 'reconciling' : 'cancelled', { reason: 'CANCEL_REQUESTED', native_interrupt: 'not_requested', side_effect_confirmation: reconcile ? 'pending' : 'not_applicable' }, now);
      return result;
    });
  }
  resume(request: RequestContext, id: string, input: ResumeJobRequest): JobsRow {
    this.authorize(request); return this.mutate(request, 'resume', id, input, () => {
      const db = this.context.db, job = getJob(db, request.workspace_id, id); this.expected(job, input.expected_version);
      const queryOnly = input.recovery_action === 'query_original';
      if (input.recovery_action !== undefined && !queryOnly) throw new ContractError('VALIDATION_ERROR','未知恢复动作');
      if (queryOnly) {
        if (['input','executor','native_task_binding_id'].some(key => key in input)) throw new ContractError('VALIDATION_ERROR','核对原结果不能改变输入或执行路线');
        if (job.kind !== 'variant_generate' || job.execution_mode !== 'service_adapter' || job.executor_id !== 'codex') throw new ContractError('CAPABILITY_UNSUPPORTED','该任务尚不支持只核对原结果',{no_new_turn_started:true});
        const last=db.prepare('SELECT checkpoint FROM job_attempts WHERE workspace_id=? AND job_id=? ORDER BY attempt_no DESC LIMIT 1').get(request.workspace_id,id);
        if (!last) throw new ContractError('RESULT_UNKNOWN','原任务尚无可核对的原生身份',{no_new_turn_started:true});
        assertOriginalQueryCheckpoint(job,JSON.parse(String(last.checkpoint)),request.workspace_id);
        // 不同幂等键重复核对已提交结果时，保留单一 receipt，不新建 verifier。
        if (job.state === 'succeeded') return job;
        assertOriginalQueryTargets(this.context,job);
      }
      if (job.execution_mode === 'host_session') throw new ContractError('CAPABILITY_UNVERIFIED', '原生任务恢复需要 WP-17 tracking 准入');
      const registration = this.registrations.find(reg => reg.kind === job.kind && reg.execution_mode === job.execution_mode);
      if (!registration || registration.recovery !== 'read_only') throw new ContractError('RESULT_UNKNOWN', '该任务必须先核对实际结果');
      if (!['failed', 'waiting_input', 'waiting_quota'].includes(job.state) || job.cancel_requested_at) throw new ContractError('HOST_RUN_NOT_CURRENT', '任务不能重试');
      if (input.native_task_binding_id || (input.input && Object.keys(input.input).length)) throw new ContractError('VALIDATION_ERROR', '固定内容输入变更需要新任务');
      if (job.execution_mode === 'service_adapter' && input.executor && input.executor !== job.executor_id) {
        const previous = db.prepare('SELECT checkpoint FROM job_attempts WHERE workspace_id=? AND job_id=? ORDER BY attempt_no DESC LIMIT 1').get(request.workspace_id, id);
        // 认证/额度错误、未返回 handle 都不能证明没有提交；只有执行前确认的事实允许换路线。
        if (!previous || JSON.parse(String(previous.checkpoint)).pre_submit_failure !== true) throw new ContractError('RESULT_UNKNOWN', '原任务提交结果尚未核清，必须保留原执行器和计费路线核对', { executor_id: job.executor_id, no_new_turn_started: true });
      }
      const now = this.clock();
      const result = revokeAttemptInTransaction(db, request.workspace_id, id, 'NEW_ATTEMPT', 'superseded', 'queued', now);
      if (input.executor) db.prepare('UPDATE jobs SET executor_id=? WHERE workspace_id=? AND id=?').run(input.executor, request.workspace_id, id);
      const queued = getJob(db, request.workspace_id, id);
      const source = db.prepare('SELECT * FROM job_attempts WHERE workspace_id=? AND job_id=? ORDER BY attempt_no DESC LIMIT 1').get(request.workspace_id, id) as unknown as JobAttemptsRow | undefined;
      const intent = queued.execution_mode === 'service_adapter' && source ? setRecoveryIntentInTransaction(db, request.workspace_id, queued, queryOnly ? 'query_original' : 'resume', source) : null;
      appendEvent(db, request.workspace_id, id, 'queued', { recovery: 'read_only', previous_generation: job.attempt_generation,
        recovery_action: queryOnly ? 'query_original' : 'resume', recovery_generation: result.attempt_generation, ...(intent ? { recovery_intent_id: intent.id } : {}) }, now);
      return { ...getJob(db, request.workspace_id, id) };
    });
  }
  private expected(job: JobsRow, expected: number): void {
    if (job.version !== expected) throw new ContractError('VERSION_CONFLICT', '任务版本已变化', { current_version: job.version });
  }
  private mutate<T extends JobsRow>(request: RequestContext, operation: string, id: string, input: unknown, act: () => T): T {
    if (!request.idempotency_key) throw new ContractError('VALIDATION_ERROR', '缺少 Idempotency-Key');
    const db = this.context.db, name = `jobs.${operation}`, body = { job_id: id, input };
    return transaction(db, () => {
      const old = lookupIdempotency(db, request.workspace_id, name, request.idempotency_key!, body);
      if (old?.state === 'committed') return old.response as unknown as T;
      const claim = claimIdempotency(db, request.workspace_id, name, request.idempotency_key!, body), result = act();
      commitIdempotency(db, request.workspace_id, claim.id, result as unknown as JsonObject); return result;
    });
  }
  claim(owner: string, options: ClaimOptions = {}) { return claimNextJob(this.context.db, this.context.identity.workspace_id, owner, this.registrations, this.clock(), undefined, options); }
  deferCapacity(fence: AttemptFence, previousCheckpoint: JsonObject): JobsRow {
    const db = this.context.db, workspace = this.context.identity.workspace_id;
    return transaction(db, () => {
      const job = getJob(db, workspace, fence.job_id), attempt = getAttempt(db, workspace, fence.attempt_id), now = this.clock();
      if (attempt.lease_owner !== fence.lease_owner || fenceReason(job, attempt, fence, now)) throw new ContractError('HOST_RUN_NOT_CURRENT', '容量等待归属失效');
      // 只有 adapter 明确未发 native submit 的容量冲突进入这里；恢复动作不能在让出时丢失。
      assertWorkerRecoveryIntent(db, job, attempt, previousCheckpoint);
      db.prepare('UPDATE job_attempts SET checkpoint=?,error=NULL WHERE workspace_id=? AND id=?').run(JSON.stringify(previousCheckpoint), workspace, attempt.id);
      const result = revokeAttemptInTransaction(db, workspace, job.id, 'EXECUTOR_CAPACITY_BUSY', 'superseded', 'queued', now);
      db.prepare('UPDATE job_attempts SET error=NULL WHERE workspace_id=? AND id=?').run(workspace, attempt.id);
      const recovery = requeueRecoveryIntentInTransaction(db, job, { ...attempt, checkpoint: canonicalJson(previousCheckpoint) }, result);
      appendEvent(db, workspace, job.id, 'queued', { reason: 'EXECUTOR_CAPACITY_BUSY', no_native_submit: true, ...recovery }, now, attempt.attempt_no); return getJob(db, workspace, job.id);
    });
  }
  heartbeat(fence: AttemptFence, checkpoint?: JsonObject) { return renewWorkerLease(this.context.db, this.context.identity.workspace_id, fence, this.clock(), undefined, checkpoint); }
  checkpoint(fence: AttemptFence, value: JsonObject) { return saveWorkerCheckpoint(this.context.db, this.context.identity.workspace_id, fence, value, this.clock()); }
  events(request: RequestContext, id: string, afterSeq = 0, limit = 100): JobEventsPage { this.authorize(request); return readEvents(this.context.db, request.workspace_id, id, afterSeq, limit); }
  fail(fence: AttemptFence, error: JsonObject, state: Extract<JobState, 'failed' | 'waiting_input' | 'waiting_quota' | 'reconciling'> = 'failed'): JobsRow {
    const db = this.context.db, workspace = this.context.identity.workspace_id;
    return transaction(db, () => {
      const job = getJob(db, workspace, fence.job_id), attempt = getAttempt(db, workspace, fence.attempt_id), now = this.clock();
      if (attempt.job_id !== job.id || attempt.attempt_generation !== fence.attempt_generation || attempt.lease_owner !== fence.lease_owner) throw new ContractError('HOST_RUN_NOT_CURRENT', '失败事件归属无效');
      // committed 后的晚到失败只记录观察事件，不回退已生效结果。
      if (job.state === 'succeeded') { appendEvent(db, workspace, job.id, 'phase_changed', { ignored_late_failure: true, attempt_id: attempt.id, error }, now, attempt.attempt_no); return job; }
      if (attempt.lease_owner !== fence.lease_owner || fenceReason(job, attempt, fence, now)) throw new ContractError('HOST_RUN_NOT_CURRENT', '失效 owner 不能改变任务');
      const result = revokeAttemptInTransaction(db, workspace, job.id, String(error.code ?? 'EXECUTION_FAILED'), 'failed', state, now);
      db.prepare('UPDATE job_attempts SET error=? WHERE workspace_id=? AND id=?').run(JSON.stringify(error), workspace, attempt.id);
      appendEvent(db, workspace, job.id, state === 'waiting_input' ? 'needs_input' : state === 'waiting_quota' ? 'quota_exhausted' : state === 'reconciling' ? 'reconciling' : 'failed', { error }, now, attempt.attempt_no); return result;
    });
  }
  recoverExpired(options: { registered_only?: boolean } = {}): Array<{ job_id: string; state: JobState; reason: string }> {
    const db = this.context.db, workspace = this.context.identity.workspace_id, now = this.clock();
    return transaction(db, () => {
      const jobs = db.prepare("SELECT j.* FROM jobs j JOIN job_attempts a ON a.workspace_id=j.workspace_id AND a.id=j.current_attempt_id WHERE j.workspace_id=? AND j.state='running' AND a.state='active' ORDER BY j.created_at,j.id")
        .all(workspace) as unknown as JobsRow[];
      return jobs.filter(job => {
        if (options.registered_only && !this.registrations.some(reg => reg.kind === job.kind && reg.execution_mode === job.execution_mode)) return false;
        const attempt = getAttempt(db, workspace, job.current_attempt_id!); return fenceReason(job, attempt, { job_id: job.id, attempt_id: attempt.id, attempt_generation: job.attempt_generation }, now) !== null;
      }).map(job => {
        const attempt = getAttempt(db, workspace, job.current_attempt_id!), policy = JSON.parse(job.retry_policy);
        const reason = fenceReason(job, attempt, { job_id: job.id, attempt_id: attempt.id, attempt_generation: job.attempt_generation }, now)!;
        const registration = this.registrations.find(reg => reg.kind === job.kind && reg.execution_mode === job.execution_mode);
        const executionAttempts = Number(db.prepare(`SELECT COUNT(*) AS n FROM job_attempts a WHERE a.workspace_id=? AND a.job_id=? AND NOT EXISTS
          (SELECT 1 FROM job_events e WHERE e.workspace_id=a.workspace_id AND e.job_id=a.job_id AND e.attempt_no=a.attempt_no AND e.type='queued' AND json_extract(e.payload,'$.reason')='EXECUTOR_CAPACITY_BUSY')`).get(workspace, job.id)!.n);
        const state: JobState = job.execution_mode === 'host_session' ? 'waiting_input'
          : registration?.recovery === 'read_only' && executionAttempts < Number(policy.max_attempts ?? 3) ? 'queued'
          : ['media', 'external_side_effect'].includes(registration?.recovery ?? '') ? 'reconciling' : 'waiting_input';
        // 先核恢复意图，再撤销；缺失/冲突的查询不能借重领退回普通恢复。
        if (state === 'queued') assertWorkerRecoveryIntent(db, job, attempt, JSON.parse(attempt.checkpoint));
        const revoked = revokeAttemptInTransaction(db, workspace, job.id, reason, 'expired', state, now);
        const recovery = state === 'queued' ? requeueRecoveryIntentInTransaction(db, job, attempt, revoked) : {};
        appendEvent(db, workspace, job.id, state === 'queued' ? 'queued' : state === 'reconciling' ? 'reconciling' : 'needs_input', { reason, revoked_attempt_id: attempt.id, ...recovery }, now, attempt.attempt_no);
        return { job_id: job.id, state, reason };
      });
    });
  }
}
