import { randomUUID } from 'node:crypto';
import { ContractError, DEFAULT_CONCURRENT_GENERATIONS, MAX_CONCURRENT_GENERATIONS, type JobsRow, type JobAttemptsRow, type JobEvent, type JobEventType, type JobEventsPage,
  type JsonObject, type ExecutionMode, type Entrypoint, type Presentation } from '@workbench/contracts';
import { type DatabaseSync, canonicalJson, inputHash, transaction } from '../connection/index.ts';

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();
export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_HEARTBEAT_MS = 10_000;
export interface JobRegistration { kind: string; execution_mode: Exclude<ExecutionMode, 'host_session'>; recovery: 'read_only' | 'media' | 'external_side_effect' | 'manual'; claimable?(job: JobsRow, checkpoint: JsonObject): boolean }
export interface QueueJobInput { kind: string; target_id?: string | null; executor_id?: string | null; entrypoint: Entrypoint; execution_mode: ExecutionMode;
  input_manifest: JsonObject; retry_policy: JsonObject; presentation: Presentation; due_at?: string | null }
export interface AttemptFence { job_id: string; attempt_id: string; attempt_generation: number; lease_owner: string }
export interface ClaimedJob { job: JobsRow; attempt: JobAttemptsRow; fence: AttemptFence }
export function getJob(db: DatabaseSync, workspaceId: string, jobId: string): JobsRow {
  const row = db.prepare('SELECT * FROM jobs WHERE workspace_id=? AND id=?').get(workspaceId, jobId);
  if (!row) throw new ContractError('NOT_FOUND', '任务不存在'); return row as unknown as JobsRow;
}
export function getAttempt(db: DatabaseSync, workspaceId: string, attemptId: string): JobAttemptsRow {
  const row = db.prepare('SELECT * FROM job_attempts WHERE workspace_id=? AND id=?').get(workspaceId, attemptId);
  if (!row) throw new ContractError('NOT_FOUND', '执行尝试不存在'); return row as unknown as JobAttemptsRow;
}
export function appendEvent(db: DatabaseSync, workspaceId: string, jobId: string, type: JobEventType, payload: JsonObject, now: number, attemptNo?: number): JobEvent {
  if (!db.isTransaction) throw new Error('job event requires domain transaction');
  const seq = Number(db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM job_events WHERE workspace_id=? AND job_id=?').get(workspaceId, jobId)!.seq);
  const attempt_no = attemptNo ?? Number(db.prepare('SELECT COALESCE(MAX(attempt_no),1) AS n FROM job_attempts WHERE workspace_id=? AND job_id=?').get(workspaceId, jobId)!.n);
  const occurred_at = new Date(now).toISOString();
  db.prepare('INSERT INTO job_events(id,workspace_id,job_id,seq,attempt_no,type,payload,occurred_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(), workspaceId, jobId, seq, attempt_no, type, canonicalJson(payload), occurred_at);
  return { job_id: jobId, seq, attempt_no, type, payload, occurred_at };
}
export function queueJobInTransaction(db: DatabaseSync, workspaceId: string, input: QueueJobInput, now: number): JobsRow {
  if (!db.isTransaction) throw new Error('job creation requires domain transaction');
  const id = randomUUID(), at = new Date(now).toISOString();
  if (input.due_at && !Number.isFinite(Date.parse(input.due_at))) throw new ContractError('VALIDATION_ERROR', '任务时间无效');
  db.prepare(`INSERT INTO jobs(id,workspace_id,kind,target_id,executor_id,entrypoint,execution_mode,current_attempt_id,attempt_generation,
    input_manifest,input_hash,state,due_at,retry_policy,presentation,cancel_requested_at,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,NULL,0,?,?,'queued',?,?,?,NULL,1,?,?)`)
    .run(id, workspaceId, input.kind, input.target_id ?? null, input.executor_id ?? null, input.entrypoint, input.execution_mode,
      canonicalJson(input.input_manifest), inputHash(input.input_manifest), input.due_at ?? null, canonicalJson(input.retry_policy), input.presentation, at, at);
  appendEvent(db, workspaceId, id, 'queued', { execution_mode: input.execution_mode }, now, 1); return getJob(db, workspaceId, id);
}
export function startAttemptInTransaction(db: DatabaseSync, workspaceId: string, jobId: string, leaseOwner: string, now: number,
  options: { lease_ms?: number; host_connection_id?: string; native_task_binding_id?: string; checkpoint?: JsonObject } = {}): ClaimedJob {
  if (!db.isTransaction) throw new Error('attempt creation requires domain transaction');
  const job = getJob(db, workspaceId, jobId);
  if (job.state !== 'queued' || job.cancel_requested_at || job.current_attempt_id) throw new ContractError('HOST_RUN_NOT_CURRENT', '任务不能建立新的尝试');
  if (!leaseOwner) throw new ContractError('VALIDATION_ERROR', '执行 owner 不可为空');
  const leaseMs = options.lease_ms ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new ContractError('VALIDATION_ERROR', 'lease 参数无效');
  const generation = job.attempt_generation + 1, id = randomUUID(), at = new Date(now).toISOString();
  const attemptNo = Number(db.prepare('SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM job_attempts WHERE workspace_id=? AND job_id=?').get(workspaceId, jobId)!.n);
  db.prepare(`INSERT INTO job_attempts(id,workspace_id,job_id,attempt_no,attempt_generation,state,lease_owner,lease_until,host_connection_id,
    native_task_binding_id,checkpoint,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?,?,?,?,?)`)
    .run(id, workspaceId, jobId, attemptNo, generation, leaseOwner, new Date(now + leaseMs).toISOString(), options.host_connection_id ?? null,
      options.native_task_binding_id ?? null, canonicalJson(options.checkpoint ?? {}), at, at);
  db.prepare("UPDATE jobs SET current_attempt_id=?,attempt_generation=?,state='running',version=version+1,updated_at=? WHERE workspace_id=? AND id=?")
    .run(id, generation, at, workspaceId, jobId);
  appendEvent(db, workspaceId, jobId, 'started', { attempt_id: id, attempt_generation: generation, lease_owner: leaseOwner }, now, attemptNo);
  return { job: getJob(db, workspaceId, jobId), attempt: getAttempt(db, workspaceId, id), fence: { job_id: jobId, attempt_id: id, attempt_generation: generation, lease_owner: leaseOwner } };
}
// 恢复动作保存在 job 的服务端策略中；queued 事件只是可核对的镜像，不能覆盖它。
// 不改变固定 input 或历史 attempt；新 verifier 另绑定自己的 fence。
const RECOVERY_INTENT_KEY = 'service_recovery_intent';
function recoveryUnknown(): never {
  throw new ContractError('RESULT_UNKNOWN', '恢复意图缺失、冲突或代次不符；未提交新任务', { no_new_turn_started: true, recovery_intent_invalid: true });
}
function jsonObject(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function setRecoveryIntentInTransaction(db: DatabaseSync, workspaceId: string, job: JobsRow, action: 'query_original' | 'resume', source: JobAttemptsRow): JsonObject {
  if (!db.isTransaction || job.state !== 'queued' || job.current_attempt_id || source.job_id !== job.id || source.workspace_id !== workspaceId) return recoveryUnknown();
  const intent: JsonObject = { schema: 'service-recovery-intent.v1', id: randomUUID(), action, workspace_id: workspaceId, job_id: job.id,
    input_hash: job.input_hash, executor_id: job.executor_id, queued_generation: job.attempt_generation,
    source_attempt_id: source.id, source_attempt_generation: source.attempt_generation, source_checkpoint_hash: inputHash(JSON.parse(source.checkpoint)) };
  const policy = JSON.parse(job.retry_policy) as JsonObject;
  db.prepare('UPDATE jobs SET retry_policy=? WHERE workspace_id=? AND id=?').run(canonicalJson({ ...policy, [RECOVERY_INTENT_KEY]: intent }), workspaceId, job.id);
  return intent;
}
function recoveryIntent(db: DatabaseSync, job: JobsRow): JsonObject | null {
  const policy = JSON.parse(job.retry_policy) as JsonObject;
  if (!(RECOVERY_INTENT_KEY in policy)) return null;
  const intent = policy[RECOVERY_INTENT_KEY];
  if (!jsonObject(intent) || intent.schema !== 'service-recovery-intent.v1' || typeof intent.id !== 'string' || !intent.id ||
    !['query_original', 'resume'].includes(String(intent.action)) || intent.workspace_id !== job.workspace_id || intent.job_id !== job.id ||
    intent.input_hash !== job.input_hash || intent.executor_id !== job.executor_id || !Number.isSafeInteger(intent.queued_generation) ||
    intent.queued_generation !== job.attempt_generation - (job.state === 'running' ? 1 : 0) || typeof intent.source_attempt_id !== 'string') return recoveryUnknown();
  const source = getAttempt(db, job.workspace_id, intent.source_attempt_id);
  if (source.job_id !== job.id || source.attempt_generation !== intent.source_attempt_generation || inputHash(JSON.parse(source.checkpoint)) !== intent.source_checkpoint_hash) return recoveryUnknown();
  if (intent.action === 'query_original' && (job.kind !== 'variant_generate' || job.execution_mode !== 'service_adapter' || job.executor_id !== 'codex')) return recoveryUnknown();
  return intent;
}
function hasQueryProvenance(db: DatabaseSync, job: JobsRow, checkpoint: JsonObject): boolean {
  return checkpoint.recovery_action !== undefined || checkpoint.recovery_intent !== undefined || !!db.prepare("SELECT 1 FROM job_events WHERE workspace_id=? AND job_id=? AND json_extract(payload,'$.recovery_action')='query_original' LIMIT 1").get(job.workspace_id, job.id);
}
function boundIntent(intent: JsonObject, attempt: JobAttemptsRow): JsonObject {
  return { ...intent, verifier_attempt_id: attempt.id, verifier_generation: attempt.attempt_generation, lease_owner: attempt.lease_owner };
}
export function assertWorkerRecoveryIntent(db: DatabaseSync, job: JobsRow, attempt: JobAttemptsRow, checkpoint: JsonObject): void {
  if (job.execution_mode !== 'service_adapter') { if (checkpoint.recovery_action !== undefined || checkpoint.recovery_intent !== undefined) recoveryUnknown(); return; }
  const intent = recoveryIntent(db, job);
  if (!intent) { if (hasQueryProvenance(db, job, checkpoint)) recoveryUnknown(); return; }
  if (job.current_attempt_id !== attempt.id || job.attempt_generation !== attempt.attempt_generation || attempt.job_id !== job.id ||
    !jsonObject(checkpoint.recovery_intent) || canonicalJson(checkpoint.recovery_intent) !== canonicalJson(boundIntent(intent, attempt)) ||
    (intent.action === 'query_original' ? checkpoint.recovery_action !== 'query_original' : checkpoint.recovery_action !== undefined)) recoveryUnknown();
}
// capacity 与 lease 重领沿用已验证动作，只为新的 queued generation 重新绑定。
export function requeueRecoveryIntentInTransaction(db: DatabaseSync, previous: JobsRow, attempt: JobAttemptsRow, queued: JobsRow): JsonObject {
  assertWorkerRecoveryIntent(db, previous, attempt, JSON.parse(attempt.checkpoint));
  const intent = recoveryIntent(db, previous); if (!intent) return {};
  const next: JsonObject = { ...intent, queued_generation: queued.attempt_generation };
  const policy = JSON.parse(queued.retry_policy) as JsonObject;
  db.prepare('UPDATE jobs SET retry_policy=? WHERE workspace_id=? AND id=?').run(canonicalJson({ ...policy, [RECOVERY_INTENT_KEY]: next }), queued.workspace_id, queued.id);
  return { recovery_intent_id: next.id, recovery_action: next.action, recovery_generation: next.queued_generation };
}
export interface ClaimOptions { exclude_job_ids?: readonly string[]; admit?(job: JobsRow, checkpoint: JsonObject): boolean; service_adapter_limit?: number }
export function jobResources(job: JobsRow): string[] {
  const manifest = JSON.parse(job.input_manifest) as JsonObject;
  const targets = Array.isArray(manifest.targets) ? manifest.targets : [];
  const keys = targets.flatMap(target => target && typeof target === 'object' && !Array.isArray(target) && typeof target.document_id === 'string' ? [`document:${target.document_id}`] : []);
  const flow = manifest.writing_flow;
  if (flow && typeof flow === 'object' && !Array.isArray(flow) && typeof flow.run_id === 'string') keys.push(`writing-run:${flow.run_id}`);
  if (!keys.length && job.target_id) keys.push(`target:${job.target_id}`);
  return [...new Set(keys)];
}
export function claimNextJob(db: DatabaseSync, workspaceId: string, owner: string, registrations: readonly JobRegistration[], now: number, leaseMs = DEFAULT_LEASE_MS, options: ClaimOptions = {}): ClaimedJob | null {
  return transaction(db, () => {
    const running = db.prepare("SELECT * FROM jobs WHERE workspace_id=? AND state='running' AND execution_mode='service_adapter'").all(workspaceId) as unknown as JobsRow[];
    const occupied = new Set(running.flatMap(jobResources));
    const limit = options.service_adapter_limit ?? DEFAULT_CONCURRENT_GENERATIONS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONCURRENT_GENERATIONS) throw new ContractError('VALIDATION_ERROR', '生成任务并发上限无效');
    // 双重限定 kind 与 execution_mode；即使 host 行使用同 kind，也不能进入 worker。
    const rows = db.prepare("SELECT * FROM jobs WHERE workspace_id=? AND state='queued' AND cancel_requested_at IS NULL AND execution_mode IN ('programmatic','service_adapter') AND (due_at IS NULL OR due_at<=?) ORDER BY created_at,id")
      .all(workspaceId, new Date(now).toISOString()) as unknown as JobsRow[];
    const job = rows.find(row => {
      const registration = registrations.find(reg => reg.kind === row.kind && reg.execution_mode === row.execution_mode);
      if (!registration) return false;
      if (options.exclude_job_ids?.includes(row.id)) return false;
      if (row.execution_mode === 'service_adapter' && (running.length >= limit || jobResources(row).some(key => occupied.has(key)))) return false;
      const previous = db.prepare('SELECT checkpoint FROM job_attempts WHERE workspace_id=? AND job_id=? ORDER BY attempt_no DESC LIMIT 1').get(workspaceId, row.id);
      const checkpoint = previous ? JSON.parse(String(previous.checkpoint)) : {};
      return (!registration.claimable || registration.claimable(row, checkpoint)) && (!options.admit || options.admit(row, checkpoint));
    });
    if (!job) return null;
    const previous = db.prepare('SELECT checkpoint FROM job_attempts WHERE workspace_id=? AND job_id=? ORDER BY attempt_no DESC LIMIT 1').get(workspaceId, job.id);
    const checkpoint: JsonObject = previous ? JSON.parse(String(previous.checkpoint)) : {};
    const intent = recoveryIntent(db, job);
    if (intent) {
      const mirrors = db.prepare("SELECT payload FROM job_events WHERE workspace_id=? AND job_id=? AND type='queued' AND json_extract(payload,'$.recovery_generation')=?").all(workspaceId, job.id, job.attempt_generation)
        .map(row => JSON.parse(String(row.payload)) as JsonObject);
      if (!mirrors.length || mirrors.some(row => row.recovery_intent_id !== intent.id || row.recovery_action !== intent.action)) recoveryUnknown();
      delete checkpoint.recovery_intent;
      if (intent.action === 'query_original') { checkpoint.recovery_action = 'query_original'; checkpoint.resume_submission_unknown = false; }
      else delete checkpoint.recovery_action;
    } else if (hasQueryProvenance(db, job, checkpoint)) recoveryUnknown();
    const claim = startAttemptInTransaction(db, workspaceId, job.id, owner, now, { lease_ms: leaseMs, checkpoint });
    if (!intent) return claim;
    checkpoint.recovery_intent = boundIntent(intent, claim.attempt);
    db.prepare('UPDATE job_attempts SET checkpoint=? WHERE workspace_id=? AND id=?').run(canonicalJson(checkpoint), workspaceId, claim.attempt.id);
    return { ...claim, attempt: getAttempt(db, workspaceId, claim.attempt.id) };
  });
}
export function fenceReason(job: JobsRow, attempt: JobAttemptsRow, fence: Omit<AttemptFence, 'lease_owner'>, now: number): string | null {
  if (attempt.job_id !== job.id || attempt.attempt_generation !== fence.attempt_generation) return 'ATTEMPT_IDENTITY_MISMATCH';
  if (job.cancel_requested_at || job.state === 'cancel_requested' || job.state === 'cancelled') return 'CANCEL_REQUESTED';
  if (job.current_attempt_id !== fence.attempt_id || job.attempt_generation !== fence.attempt_generation || attempt.state !== 'active' || job.state !== 'running') return 'ATTEMPT_NOT_CURRENT';
  const leaseUntil = Date.parse(attempt.lease_until), deadline = attempt.output_deadline === null ? null : Date.parse(attempt.output_deadline);
  if (!Number.isFinite(leaseUntil) || (deadline !== null && !Number.isFinite(deadline))) return 'INVALID_LEASE_TIME';
  if (leaseUntil <= now || (deadline !== null && deadline <= now)) return attempt.output_deadline ? 'HOST_OUTPUT_MISSING' : 'LEASE_EXPIRED';
  return null;
}
export function quarantinePendingInTransaction(db: DatabaseSync, workspaceId: string, jobId: string, reason: string, now: number): void {
  if (!db.isTransaction) throw new Error('quarantine requires domain transaction');
  const at = new Date(now).toISOString();
  db.prepare("UPDATE result_receipts SET state='quarantined',quarantine_reason=?,updated_at=? WHERE workspace_id=? AND job_id=? AND state='pending'").run(reason, at, workspaceId, jobId);
  db.prepare("UPDATE write_intents SET state='quarantined',error=?,updated_at=? WHERE workspace_id=? AND job_id=? AND state='pending'").run(canonicalJson({ code: reason }), at, workspaceId, jobId);
}
export function revokeAttemptInTransaction(db: DatabaseSync, workspaceId: string, jobId: string, reason: string, attemptState: 'failed' | 'expired' | 'cancelled' | 'superseded',
  jobState: JobsRow['state'], now: number): JobsRow {
  if (!db.isTransaction) throw new Error('attempt revocation requires domain transaction');
  const job = getJob(db, workspaceId, jobId); if (job.state === 'succeeded') return job;
  const at = new Date(now).toISOString();
  db.prepare('UPDATE jobs SET current_attempt_id=NULL,attempt_generation=attempt_generation+1,state=?,version=version+1,updated_at=? WHERE workspace_id=? AND id=?').run(jobState, at, workspaceId, jobId);
  if (job.current_attempt_id) {
    const attempt = getAttempt(db, workspaceId, job.current_attempt_id);
    if (attempt.state === 'active') db.prepare('UPDATE job_attempts SET state=?,error=?,updated_at=? WHERE workspace_id=? AND id=?').run(attemptState, canonicalJson({ code: reason }), at, workspaceId, attempt.id);
    if (attempt.native_task_binding_id) db.prepare("UPDATE native_task_bindings SET state='closed',updated_at=? WHERE workspace_id=? AND id=? AND state='active'").run(at, workspaceId, attempt.native_task_binding_id);
  }
  quarantinePendingInTransaction(db, workspaceId, jobId, reason, now); return getJob(db, workspaceId, jobId);
}
export function renewWorkerLease(db: DatabaseSync, workspaceId: string, fence: AttemptFence, now: number, leaseMs = DEFAULT_LEASE_MS, checkpoint?: JsonObject): JobAttemptsRow {
  return transaction(db, () => {
    const job = getJob(db, workspaceId, fence.job_id), attempt = getAttempt(db, workspaceId, fence.attempt_id);
    const reason = fenceReason(job, attempt, fence, now);
    if (job.execution_mode === 'host_session' || reason || attempt.lease_owner !== fence.lease_owner) throw new ContractError('HOST_RUN_NOT_CURRENT', 'worker lease 无效', { reason: reason ?? 'OWNER_MISMATCH' });
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new ContractError('VALIDATION_ERROR', 'lease 参数无效');
    db.prepare('UPDATE job_attempts SET lease_until=?,checkpoint=?,updated_at=? WHERE workspace_id=? AND id=?').run(new Date(now + leaseMs).toISOString(), canonicalJson(checkpoint ?? JSON.parse(attempt.checkpoint)), new Date(now).toISOString(), workspaceId, attempt.id);
    return getAttempt(db, workspaceId, attempt.id);
  });
}
export function saveWorkerCheckpoint(db: DatabaseSync, workspaceId: string, fence: AttemptFence, checkpoint: JsonObject, now: number): JobAttemptsRow {
  return transaction(db, () => {
    const job = getJob(db, workspaceId, fence.job_id), attempt = getAttempt(db, workspaceId, fence.attempt_id);
    const reason = fenceReason(job, attempt, fence, now);
    if (job.execution_mode === 'host_session' || reason || attempt.lease_owner !== fence.lease_owner) throw new ContractError('HOST_RUN_NOT_CURRENT', 'checkpoint 执行归属已失效', { reason: reason ?? 'OWNER_MISMATCH' });
    // checkpoint 是恢复依据；返回 callback 前提交，且不借此延长 lease。
    db.prepare('UPDATE job_attempts SET checkpoint=?,updated_at=? WHERE workspace_id=? AND id=?').run(canonicalJson(checkpoint), new Date(now).toISOString(), workspaceId, attempt.id);
    return getAttempt(db, workspaceId, attempt.id);
  });
}
export function readEvents(db: DatabaseSync, workspaceId: string, jobId: string, afterSeq = 0, limit = 100): JobEventsPage {
  getJob(db, workspaceId, jobId);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ContractError('VALIDATION_ERROR', '事件分页参数无效');
  const rows = db.prepare('SELECT * FROM job_events WHERE workspace_id=? AND job_id=? AND seq>? ORDER BY seq LIMIT ?').all(workspaceId, jobId, afterSeq, limit + 1);
  const events = rows.slice(0, limit).map(row => ({ job_id: String(row.job_id), seq: Number(row.seq), attempt_no: Number(row.attempt_no), type: row.type as JobEventType, occurred_at: String(row.occurred_at), payload: JSON.parse(String(row.payload)) as JsonObject }));
  return { events, last_seq: events.at(-1)?.seq ?? afterSeq, has_more: rows.length > limit };
}
