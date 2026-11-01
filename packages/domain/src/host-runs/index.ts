import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ContractError, NATIVE_STATES, type RequestContext, type JsonObject, type NativeIdentity, type NativeState, type NativeTaskBindingsRow,
  type NativeTaskObservationsRow, type HostTaskObserversRow, type JobsRow, type JobAttemptsRow, type ResumeJobRequest, type Page,
  type RegisterObserverRequest, type BindNativeTaskRequest, type ObserveNativeTaskRequest, type ReattachNativeTaskRequest,
  type BeginHostRunRequest, type RenewHostRunRequest, type HostRunView } from '@workbench/contracts';
import type { ApplicationContext } from '../ports/index.ts';
import { ResultCommit, type FrozenResultInput, type ReceiveOutput, type ReceiptView } from '../result-commit/index.ts';
import { canonicalJson, sha256, inputHash, transaction, lookupIdempotency, claimIdempotency, commitIdempotency } from '@workbench/storage/connection';
import { assertContext, getDocumentRow, getRevisionRow, assertCoreFreshness, decodePageCursor, encodePageCursor } from '@workbench/storage/revisions';
import { ManagedFiles, parseRevision } from '@workbench/storage/files';
import { workspaceSettings } from '@workbench/storage/settings';
import { getJob, getAttempt, queueJobInTransaction, startAttemptInTransaction, appendEvent, revokeAttemptInTransaction, fenceReason, systemClock, type Clock } from '@workbench/storage/jobs';
import { getConnection, getCapability, getObserver, getBinding, getObservation, assertIdentity, identityOf, sameIdentity, assertTracking, assertFresh, rfc3339, bindingRows,
  DEFAULT_TRACKING_PROFILE, type TrackingTimeProfile } from '@workbench/storage/host-tracking';
import { TrustedObserverAuthority, type TrustedObserverProgram, type TrustedHostPrincipal, type HostTaskObserverProgram } from '@workbench/adapters/host-observer';

export type { RegisterObserverRequest, BindNativeTaskRequest, ObserveNativeTaskRequest, ReattachNativeTaskRequest, BeginHostRunRequest, RenewHostRunRequest, HostRunView } from '@workbench/contracts';
export interface HostRunsOptions { clock?: Clock; profile?: TrackingTimeProfile; trustedPrograms?: readonly TrustedObserverProgram[] }
const terminal = new Set<NativeState>(['completed', 'failed', 'interrupted', 'auth_required', 'quota_exhausted']);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: unknown, required: string[], optional: string[] = []): void {
  if (!record(value) || required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new ContractError('VALIDATION_ERROR', '请求字段不符合原生任务 schema');
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && !!value.trim(); }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }

export class HostRuns {
  readonly context: ApplicationContext; readonly clock: Clock; readonly profile: TrackingTimeProfile; readonly authority: TrustedObserverAuthority; readonly results: ResultCommit;
  private readonly ready = new Set<string>();
  constructor(context: ApplicationContext, options: HostRunsOptions = {}) {
    this.context = context; this.clock = options.clock ?? systemClock; this.profile = Object.freeze({ ...(options.profile ?? DEFAULT_TRACKING_PROFILE) });
    if (Object.values(this.profile).some(value => !Number.isSafeInteger(value) || value < 0) || this.profile.lease_ms < 1 || this.profile.freshness_ms < 1 || this.profile.output_grace_ms < 1) throw new ContractError('VALIDATION_ERROR', '原生观察时间 profile 无效');
    this.authority = new TrustedObserverAuthority(options.trustedPrograms); this.results = new ResultCommit(context, { clock: this.clock, observerReady: (job, attempt) => this.observerReady(job, attempt) });
  }
  initialize(): void {
    this.ready.clear();
    transaction(this.context.db, () => this.context.db.prepare("UPDATE host_task_observers SET state='not_ready',updated_at=? WHERE workspace_id=? AND state IN ('active','ready','disconnected')").run(new Date(this.clock()).toISOString(), this.context.identity.workspace_id));
    this.recoverExpired(); this.results.recover();
  }
  private authorize(request: RequestContext, principal: TrustedHostPrincipal, role?: TrustedHostPrincipal['role']): void {
    this.authority.assert(principal, role); assertContext(this.context.db, request, this.context.identity.workspace_id);
    if (request.service_instance_id !== this.context.identity.service_instance_id) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '原生任务请求主服务身份不符');
    const connection = getConnection(this.context.db, request.workspace_id, principal.host_connection_id);
    if (connection.request_identity_ref !== principal.owner || connection.service_instance_id !== request.service_instance_id) throw new ContractError('AUTH_REQUIRED', '受信程序与逻辑连接归属不符');
  }
  private checkObserver(observer: HostTaskObserversRow, principal: TrustedHostPrincipal, epoch: string, requireReady = true): void {
    if (observer.host_connection_id !== principal.host_connection_id || observer.request_identity_ref !== principal.owner || observer.observer_epoch !== epoch) throw new ContractError('HOST_TASK_BINDING_INVALID', '观察 owner 或 epoch 已失效');
    if (requireReady && !['ready', 'active'].includes(observer.state)) throw new ContractError('HOST_OBSERVER_NOT_READY', '受信 observer 未就绪');
    assertTracking(getConnection(this.context.db, observer.workspace_id, observer.host_connection_id), getCapability(this.context.db, observer.workspace_id, observer.capability_record_id), this.context.identity.service_instance_id, observer.capability_version);
  }
  private associated(binding: NativeTaskBindingsRow, principal: TrustedHostPrincipal, epoch: string, requireReady = true): HostTaskObserversRow {
    const observer = getObserver(this.context.db, binding.workspace_id, binding.observer_id);
    if (binding.observer_epoch !== epoch || binding.host_connection_id !== principal.host_connection_id) throw new ContractError('HOST_TASK_BINDING_INVALID', '绑定 epoch 或连接失效');
    this.checkObserver(observer, principal, epoch, requireReady); assertIdentity(identityOf(binding)); return observer;
  }
  private mutate<T>(request: RequestContext, principal: TrustedHostPrincipal, operation: string, input: unknown, act: () => T): T {
    if (!request.idempotency_key) throw new ContractError('VALIDATION_ERROR', '缺少 Idempotency-Key');
    const body = { connection_id: principal.host_connection_id, owner: principal.owner, input };
    return transaction(this.context.db, () => {
      const old = lookupIdempotency(this.context.db, request.workspace_id, operation, request.idempotency_key!, body);
      if (old?.state === 'committed') return old.response as unknown as T;
      const claim = old ?? claimIdempotency(this.context.db, request.workspace_id, operation, request.idempotency_key!, body), result = act();
      commitIdempotency(this.context.db, request.workspace_id, claim.id, result as unknown as JsonObject); return result;
    });
  }
  register(request: RequestContext, principal: TrustedHostPrincipal, input: RegisterObserverRequest): HostTaskObserversRow {
    this.authorize(request, principal, 'observer'); exact(input, ['host_connection_id', 'observer_epoch', 'capability_record_id', 'capability_version']);
    if (!nonempty(input.observer_epoch) || !positive(input.capability_version) || input.host_connection_id !== principal.host_connection_id) throw new ContractError('HOST_TASK_BINDING_INVALID', '注册身份或 epoch 无效');
    return this.mutate(request, principal, 'host-observers.register', input, () => {
      const db = this.context.db, workspace = request.workspace_id, connection = getConnection(db, workspace, input.host_connection_id);
      assertTracking(connection, getCapability(db, workspace, input.capability_record_id), request.service_instance_id, input.capability_version);
      const old = db.prepare('SELECT * FROM host_task_observers WHERE workspace_id=? AND host_connection_id=? AND request_identity_ref=? AND observer_epoch=?').get(workspace, input.host_connection_id, principal.owner, input.observer_epoch) as unknown as HostTaskObserversRow | undefined;
      if (old) { if (old.state === 'superseded' || old.capability_record_id !== input.capability_record_id || old.capability_version !== input.capability_version) throw new ContractError('HOST_TASK_BINDING_INVALID', '旧 epoch 不可复活或替换能力版本');
        db.prepare("UPDATE host_task_observers SET state='ready',updated_at=? WHERE workspace_id=? AND id=?").run(new Date(this.clock()).toISOString(), workspace, old.id); return getObserver(db, workspace, old.id); }
      const previous = db.prepare("SELECT * FROM host_task_observers WHERE workspace_id=? AND host_connection_id=? AND state!='superseded'").all(workspace, input.host_connection_id) as unknown as HostTaskObserversRow[];
      for (const observer of previous) {
        for (const binding of bindingRows(db, workspace, input.host_connection_id).filter(b => b.observer_id === observer.id && b.state === 'active')) {
          this.ready.delete(binding.id);
          if (binding.current_attempt_id) { const attempt = getAttempt(db, workspace, binding.current_attempt_id); revokeAttemptInTransaction(db, workspace, attempt.job_id, 'OBSERVER_EPOCH_REPLACED', 'superseded', 'waiting_input', this.clock()); }
          else db.prepare("UPDATE native_task_bindings SET state='closed' WHERE workspace_id=? AND id=?").run(workspace, binding.id);
        }
        db.prepare("UPDATE host_task_observers SET state='superseded' WHERE workspace_id=? AND id=?").run(workspace, observer.id);
      }
      const id = randomUUID(); db.prepare("INSERT INTO host_task_observers(id,workspace_id,observer_epoch,host_connection_id,capability_record_id,capability_version,request_identity_ref,state) VALUES (?,?,?,?,?,?,?,'ready')")
        .run(id, workspace, input.observer_epoch, input.host_connection_id, input.capability_record_id, input.capability_version, principal.owner); return getObserver(db, workspace, id);
    });
  }
  bind(request: RequestContext, principal: TrustedHostPrincipal, observerId: string, input: BindNativeTaskRequest): NativeTaskBindingsRow {
    this.authorize(request, principal, 'observer'); exact(input, ['observer_epoch', 'native_identity']); assertIdentity(input.native_identity);
    return this.mutate(request, principal, 'host-observers.bind', { observer_id: observerId, ...input }, () => {
      const db = this.context.db, workspace = request.workspace_id, observer = getObserver(db, workspace, observerId); this.checkObserver(observer, principal, input.observer_epoch);
      const nativeExecutionId = input.native_identity.scope === 'turn' ? input.native_identity.native_turn_id : input.native_identity.native_task_id;
      if (db.prepare('SELECT id FROM jobs WHERE workspace_id=? AND id=?').get(workspace, nativeExecutionId)) throw new ContractError('HOST_TASK_BINDING_INVALID', '工作台 job ID 不能充当原生执行身份');
      const identical = bindingRows(db, workspace, principal.host_connection_id).filter(binding => sameIdentity(binding, input.native_identity));
      if (identical.some(binding => binding.state === 'active')) throw new ContractError('HOST_TASK_BINDING_INVALID', '原生身份已经有活跃绑定');
      for (const binding of identical) if (binding.current_attempt_id) {
        const attempt = getAttempt(db, workspace, binding.current_attempt_id);
        if (attempt.state !== 'succeeded' || !db.prepare("SELECT id FROM result_receipts WHERE workspace_id=? AND attempt_id=? AND state='committed'").get(workspace, attempt.id)) throw new ContractError('HOST_TASK_BINDING_INVALID', '该原生身份的前一任务没有 committed 结果');
      }
      const identity = input.native_identity, id = randomUUID();
      db.prepare("INSERT INTO native_task_bindings(id,workspace_id,observer_id,observer_epoch,host_connection_id,scope,native_namespace,native_session_id,native_turn_id,native_task_id,state) VALUES (?,?,?,?,?,?,?,?,?,?,'active')")
        .run(id, workspace, observerId, input.observer_epoch, observer.host_connection_id, identity.scope, identity.native_namespace, identity.native_session_id ?? null, identity.native_turn_id ?? null, identity.native_task_id ?? null);
      this.ready.add(id); return getBinding(db, workspace, id);
    });
  }
  private insertObservation(binding: NativeTaskBindingsRow, input: ObserveNativeTaskRequest, now: number): NativeTaskObservationsRow {
    exact(input, ['observer_epoch', 'sequence', 'native_state', 'observed_at', 'native_evidence_ref']);
    if (!positive(input.sequence) || !NATIVE_STATES.includes(input.native_state) || !nonempty(input.native_evidence_ref)) throw new ContractError('VALIDATION_ERROR', '原生观察字段无效');
    const at = new Date(now).toISOString(); assertFresh({ ...input, received_at: at }, now, this.profile);
    const previous = binding.latest_observation_id ? getObservation(this.context.db, binding.workspace_id, binding.latest_observation_id) : null;
    if (previous && (input.sequence <= previous.sequence || rfc3339(input.observed_at) < rfc3339(previous.observed_at))) throw new ContractError('HOST_OBSERVER_NOT_READY', '观察重放或乱序不能更新最新状态');
    if (previous && terminal.has(previous.native_state) && !terminal.has(input.native_state)) throw new ContractError('HOST_TASK_BINDING_INVALID', '原生终态不能被后续运行观察复活');
    if (binding.state === 'closed' && !terminal.has(input.native_state)) throw new ContractError('HOST_TASK_BINDING_INVALID', '封闭绑定不接受运行观察');
    const id = randomUUID(), db = this.context.db;
    db.prepare('INSERT INTO native_task_observations(id,workspace_id,binding_id,observer_id,observer_epoch,sequence,native_state,observed_at,received_at,native_evidence_ref) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, binding.workspace_id, binding.id, binding.observer_id, binding.observer_epoch, input.sequence, input.native_state, input.observed_at, at, input.native_evidence_ref);
    db.prepare('UPDATE native_task_bindings SET latest_observation_id=?,updated_at=? WHERE workspace_id=? AND id=?').run(id, at, binding.workspace_id, binding.id);
    return getObservation(db, binding.workspace_id, id);
  }
  observe(request: RequestContext, principal: TrustedHostPrincipal, bindingId: string, input: ObserveNativeTaskRequest): NativeTaskObservationsRow {
    this.authorize(request, principal, 'observer');
    return transaction(this.context.db, () => {
      const binding = getBinding(this.context.db, request.workspace_id, bindingId); this.associated(binding, principal, input.observer_epoch);
      const observation = this.insertObservation(binding, input, this.clock()); this.applyObservation(binding, observation); return observation;
    });
  }
  private applyObservation(binding: NativeTaskBindingsRow, observation: NativeTaskObservationsRow): void {
    if (!binding.current_attempt_id) {
      if (terminal.has(observation.native_state)) { this.ready.delete(binding.id); this.context.db.prepare("UPDATE native_task_bindings SET state='closed' WHERE workspace_id=? AND id=?").run(binding.workspace_id, binding.id); }
      return;
    }
    const db = this.context.db, attempt = getAttempt(db, binding.workspace_id, binding.current_attempt_id), job = getJob(db, binding.workspace_id, attempt.job_id), now = this.clock();
    if (job.state === 'succeeded' || attempt.state !== 'active' || job.current_attempt_id !== attempt.id || job.attempt_generation !== attempt.attempt_generation) {
      appendEvent(db, binding.workspace_id, job.id, 'phase_changed', { ignored_late_native_state: observation.native_state, observation_id: observation.id, attempt_id: attempt.id,
        ...(job.state === 'cancelled' && observation.native_state === 'interrupted' ? { logical_cancelled: true, native_termination_confirmed: true, native_evidence_ref: observation.native_evidence_ref } : {}) }, now, attempt.attempt_no); return;
    }
    const invalid = fenceReason(job, attempt, { job_id: job.id, attempt_id: attempt.id, attempt_generation: attempt.attempt_generation }, now);
    if (invalid) { this.expire(job, attempt, invalid, now); return; }
    if (observation.native_state === 'completed') {
      const deadline = Math.min(Date.parse(attempt.lease_until), Date.parse(observation.received_at) + this.profile.output_grace_ms, attempt.output_deadline ? Date.parse(attempt.output_deadline) : Infinity);
      db.prepare('UPDATE job_attempts SET output_deadline=?,updated_at=? WHERE workspace_id=? AND id=?').run(new Date(deadline).toISOString(), new Date(now).toISOString(), binding.workspace_id, attempt.id);
      db.prepare('UPDATE jobs SET version=version+1,updated_at=? WHERE workspace_id=? AND id=?').run(new Date(now).toISOString(), binding.workspace_id, job.id);
      appendEvent(db, binding.workspace_id, job.id, 'phase_changed', { phase: 'awaiting_output', output_deadline: new Date(deadline).toISOString(), observation_id: observation.id }, now, attempt.attempt_no);
    } else if (observation.native_state === 'disconnected') {
      this.ready.delete(binding.id); appendEvent(db, binding.workspace_id, job.id, 'phase_changed', { phase: 'disconnected', native_outcome: 'unknown', observation_id: observation.id }, now, attempt.attempt_no);
    } else if (terminal.has(observation.native_state)) {
      this.ready.delete(binding.id);
      const state = observation.native_state === 'auth_required' ? 'waiting_input' : observation.native_state === 'quota_exhausted' ? 'waiting_quota' : observation.native_state === 'interrupted' && job.cancel_requested_at ? 'cancelled' : 'failed';
      const reason = observation.native_state === 'interrupted' ? 'HOST_INTERRUPTED' : observation.native_state === 'auth_required' ? 'AUTH_REQUIRED' : observation.native_state === 'quota_exhausted' ? 'QUOTA_EXHAUSTED' : 'HOST_FAILED';
      revokeAttemptInTransaction(db, binding.workspace_id, job.id, reason, state === 'cancelled' ? 'cancelled' : 'failed', state, now);
      appendEvent(db, binding.workspace_id, job.id, state === 'waiting_input' ? 'needs_input' : state === 'waiting_quota' ? 'quota_exhausted' : state, { reason, observation_id: observation.id }, now, attempt.attempt_no);
    }
  }
  private admission(binding: NativeTaskBindingsRow, principal: TrustedHostPrincipal): NativeTaskObservationsRow {
    this.associated(binding, principal, binding.observer_epoch);
    if (binding.state !== 'active' || binding.current_attempt_id || !this.ready.has(binding.id)) throw new ContractError('HOST_TASK_BINDING_INVALID', '绑定不具备新任务准入权');
    if (!binding.latest_observation_id) throw new ContractError('HOST_OBSERVER_NOT_READY', '缺少实际原生运行观察');
    const observation = getObservation(this.context.db, binding.workspace_id, binding.latest_observation_id);
    if (observation.binding_id !== binding.id || observation.observer_id !== binding.observer_id || observation.observer_epoch !== binding.observer_epoch || !['running', 'waiting_tool'].includes(observation.native_state) || binding.last_renewed_observation_id === observation.id) throw new ContractError('HOST_OBSERVER_NOT_READY', '准入需要最新尚未消费的运行观察');
    assertFresh(observation, this.clock(), this.profile); return observation;
  }
  private freeze(request: RequestContext, input: BeginHostRunRequest, binding: NativeTaskBindingsRow): JsonObject {
    exact(input, ['kind', 'mode', 'targets', 'source_ids', 'instruction', 'request_context', 'native_task_binding_id', 'expected_version'], ['recommendation_kind']);
    if (!nonempty(input.instruction) || !['conversation', 'page_action'].includes(input.request_context) || !positive(input.expected_version) || !Array.isArray(input.targets) || !Array.isArray(input.source_ids) || !input.source_ids.every(nonempty) || new Set(input.source_ids).size !== input.source_ids.length) throw new ContractError('VALIDATION_ERROR', '固定任务输入无效');
    const allowed = input.mode === 'candidate' ? ['document_modify', 'variant_generate', 'wiki_generate', 'retro_generate'] : input.mode === 'initialize' ? ['variant_generate'] : input.mode === 'recommendation' ? [`${input.recommendation_kind}_recommendation`] : [];
    if (!allowed.includes(input.kind) || (input.mode === 'recommendation' ? !['topic', 'account'].includes(input.recommendation_kind ?? '') || input.targets.length : !input.targets.length || input.recommendation_kind !== undefined) || new Set(input.targets.map(target => target.document_id)).size !== input.targets.length) throw new ContractError('VALIDATION_ERROR', 'host_session 任务种类或目标集合无效');
    const db = this.context.db, materials: JsonObject[] = [], files = new ManagedFiles(workspaceSettings(db, request.workspace_id).paths);
    for (const [index, target] of input.targets.entries()) {
      exact(target, ['document_id', 'base_revision_id', 'core_revision_id']);
      if (!nonempty(target.document_id) || !(target.base_revision_id === null || nonempty(target.base_revision_id)) || !(target.core_revision_id === null || nonempty(target.core_revision_id))) throw new ContractError('VALIDATION_ERROR', '固定文稿身份无效');
      const document = getDocumentRow(db, request.workspace_id, target.document_id);
      if ((index === 0 && document.version !== input.expected_version) || document.head_revision_id !== target.base_revision_id) throw new ContractError('VERSION_CONFLICT', '开始时文稿版本或 base 已变化', { current_version: document.version });
      if (input.mode === 'initialize' && target.base_revision_id !== null) throw new ContractError('VALIDATION_ERROR', '初始化必须固定空 head');
      const variant = db.prepare('SELECT topic_id FROM variants WHERE workspace_id=? AND document_id=?').get(request.workspace_id, target.document_id);
      if (input.mode === 'initialize' && (!variant || !target.core_revision_id)) throw new ContractError('VALIDATION_ERROR', '初始化必须固定平台文稿与已确认核心');
      if (variant && target.core_revision_id) assertCoreFreshness(db, request.workspace_id, String(variant.topic_id), target.core_revision_id);
      for (const revisionId of [target.base_revision_id, target.core_revision_id].filter((id): id is string => id !== null)) {
        const revision = getRevisionRow(db, request.workspace_id, revisionId, revisionId === target.base_revision_id ? target.document_id : undefined);
        if (revision.file_path !== files.revisionPath(revision.document_id, revision.id)) throw new ContractError('INPUT_STALE', '固定材料路径与登记身份不符');
        const bytes = readFileSync(revision.file_path); if (sha256(bytes) !== revision.sha256) throw new ContractError('INPUT_STALE', '固定材料原始字节 hash 不符');
        const parsed = parseRevision(bytes.toString('utf8')); if (parsed.metadata.workspace_id !== request.workspace_id || parsed.metadata.document_id !== revision.document_id || parsed.metadata.revision_id !== revision.id) throw new ContractError('INPUT_STALE', '固定材料文件身份不符');
        materials.push({ document_id: revision.document_id, revision_id: revision.id, sha256: revision.sha256, text: parsed.text });
      }
    }
    if (input.mode === 'recommendation' && getObserver(db, request.workspace_id, binding.observer_id).capability_version !== input.expected_version) throw new ContractError('VERSION_CONFLICT', 'tracking 能力版本已变化');
    for (const source of input.source_ids) if (!db.prepare('SELECT id FROM source_records WHERE workspace_id=? AND id=?').get(request.workspace_id, source)) throw new ContractError('NOT_FOUND', '固定出处不存在');
    return { schema_version: 'wp17-input-v1', mode: input.mode, targets: input.targets as unknown as JsonObject[], source_ids: input.source_ids,
      ...(input.recommendation_kind ? { recommendation_kind: input.recommendation_kind } : {}), host_task: { instruction: input.instruction, request_context: input.request_context, materials } };
  }
  private outputSchema(frozen: FrozenResultInput): JsonObject {
    return { type: 'object', required: ['documents', 'recommendations'], additionalProperties: false, properties: {
      documents: { type: 'array', minItems: frozen.targets.length, maxItems: frozen.targets.length, items: { type: 'object', required: ['document_id', 'text'], additionalProperties: false, properties: { document_id: frozen.targets.length ? { type: 'string', enum: frozen.targets.map(target => target.document_id) } : { type: 'string' }, text: { type: 'string' } } } },
      recommendations: { type: 'array', ...(frozen.mode === 'recommendation' ? { minItems: 1 } : { maxItems: 0 }), items: { type: 'object', required: ['payload', 'source_ids', 'rationale'], additionalProperties: false, properties: { payload: { type: 'object' }, source_ids: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' } } } },
    } };
  }
  private view(job: JobsRow, attempt: JobAttemptsRow): HostRunView {
    const binding = getBinding(this.context.db, job.workspace_id, attempt.native_task_binding_id!), frozen = JSON.parse(job.input_manifest) as FrozenResultInput;
    return { job_id: job.id, attempt_id: attempt.id, attempt_generation: attempt.attempt_generation, version: job.version, native_task_binding_id: binding.id, observer_id: binding.observer_id, observer_epoch: binding.observer_epoch,
      input_manifest: JSON.parse(job.input_manifest), input_hash: job.input_hash, output_schema: this.outputSchema(frozen), lease_until: attempt.lease_until, output_deadline: attempt.output_deadline };
  }
  begin(request: RequestContext, principal: TrustedHostPrincipal, input: BeginHostRunRequest): HostRunView {
    this.authorize(request, principal, 'connection');
    exact(input, ['kind', 'mode', 'targets', 'source_ids', 'instruction', 'request_context', 'native_task_binding_id', 'expected_version'], ['recommendation_kind']);
    return this.mutate(request, principal, 'host-runs.begin', input, () => {
      const db = this.context.db, binding = getBinding(db, request.workspace_id, input.native_task_binding_id), observation = this.admission(binding, principal), manifest = this.freeze(request, input, binding), connection = getConnection(db, request.workspace_id, binding.host_connection_id);
      const entrypoint = connection.host_surface === 'codex_desktop' ? 'codex_plugin' : connection.host_surface === 'claude_code' ? 'claude_code_plugin' : 'claude_plugin';
      const job = queueJobInTransaction(db, request.workspace_id, { kind: input.kind, target_id: input.targets[0]?.document_id ?? null, entrypoint, execution_mode: 'host_session', input_manifest: manifest, retry_policy: { recovery: 'manual' }, presentation: input.request_context === 'conversation' ? 'host_conversation' : 'foreground_dialog' }, this.clock());
      if (binding.native_turn_id === job.id || binding.native_task_id === job.id) throw new ContractError('HOST_TASK_BINDING_INVALID', '工作台 job 不能作为原生执行身份');
      const claim = startAttemptInTransaction(db, request.workspace_id, job.id, principal.owner, this.clock(), { lease_ms: this.profile.lease_ms, host_connection_id: binding.host_connection_id, native_task_binding_id: binding.id });
      db.prepare('UPDATE native_task_bindings SET current_attempt_id=?,last_renewed_observation_id=? WHERE workspace_id=? AND id=?').run(claim.attempt.id, observation.id, request.workspace_id, binding.id); return this.view(claim.job, claim.attempt);
    });
  }
  renew(request: RequestContext, principal: TrustedHostPrincipal, jobId: string, input: RenewHostRunRequest): HostRunView {
    this.authorize(request, principal, 'observer'); exact(input, ['attempt_id', 'attempt_generation', 'observation_id', 'expected_version']);
    if (!nonempty(input.attempt_id) || !positive(input.attempt_generation) || !nonempty(input.observation_id) || !positive(input.expected_version)) throw new ContractError('VALIDATION_ERROR', '续期归属字段无效');
    return this.mutate(request, principal, 'host-runs.renew', { job_id: jobId, ...input }, () => {
      const db = this.context.db, job = getJob(db, request.workspace_id, jobId), attempt = getAttempt(db, request.workspace_id, input.attempt_id), now = this.clock();
      const invalid = fenceReason(job, attempt, { job_id: jobId, attempt_id: input.attempt_id, attempt_generation: input.attempt_generation }, now);
      if (job.execution_mode !== 'host_session' || invalid || attempt.lease_owner !== principal.owner) throw new ContractError('HOST_RUN_NOT_CURRENT', '原生续期执行归属已失效', { reason: invalid ?? 'OWNER_MISMATCH' });
      if (job.version !== input.expected_version) throw new ContractError('VERSION_CONFLICT', '任务版本已变化', { current_version: job.version });
      const binding = getBinding(db, request.workspace_id, attempt.native_task_binding_id!); this.associated(binding, principal, binding.observer_epoch);
      if (binding.current_attempt_id !== attempt.id || binding.state !== 'active' || !this.ready.has(binding.id) || attempt.output_deadline || binding.latest_observation_id !== input.observation_id || binding.last_renewed_observation_id === input.observation_id) throw new ContractError('HOST_OBSERVER_NOT_READY', '续期必须消费新的最新运行观察');
      const observation = getObservation(db, request.workspace_id, input.observation_id); assertFresh(observation, now, this.profile);
      if (observation.binding_id !== binding.id || observation.observer_id !== binding.observer_id || observation.observer_epoch !== binding.observer_epoch || !['running', 'waiting_tool'].includes(observation.native_state)) throw new ContractError('HOST_OBSERVER_NOT_READY', '续期观察不属于当前原生运行');
      db.prepare('UPDATE job_attempts SET lease_until=?,updated_at=? WHERE workspace_id=? AND id=?').run(new Date(now + this.profile.lease_ms).toISOString(), new Date(now).toISOString(), request.workspace_id, attempt.id);
      db.prepare('UPDATE native_task_bindings SET last_renewed_observation_id=? WHERE workspace_id=? AND id=?').run(observation.id, request.workspace_id, binding.id);
      db.prepare('UPDATE jobs SET version=version+1,updated_at=? WHERE workspace_id=? AND id=?').run(new Date(now).toISOString(), request.workspace_id, job.id);
      appendEvent(db, request.workspace_id, job.id, 'phase_changed', { phase: 'native_running', observation_id: observation.id, lease_until: new Date(now + this.profile.lease_ms).toISOString() }, now, attempt.attempt_no);
      return this.view(getJob(db, request.workspace_id, job.id), getAttempt(db, request.workspace_id, attempt.id));
    });
  }
  reattach(request: RequestContext, principal: TrustedHostPrincipal, bindingId: string, input: ReattachNativeTaskRequest): NativeTaskBindingsRow {
    this.authorize(request, principal, 'observer'); exact(input, ['observer_epoch', 'native_identity', 'observation']); assertIdentity(input.native_identity);
    return transaction(this.context.db, () => {
      const db = this.context.db, binding = getBinding(db, request.workspace_id, bindingId), observer = this.associated(binding, principal, input.observer_epoch, false);
      if (observer.state === 'superseded' || binding.state !== 'active' || !binding.current_attempt_id || !sameIdentity(binding, input.native_identity)) throw new ContractError('HOST_TASK_BINDING_INVALID', '重连不能更换原生身份或复活旧绑定');
      const attempt = getAttempt(db, request.workspace_id, binding.current_attempt_id), job = getJob(db, request.workspace_id, attempt.job_id), invalid = fenceReason(job, attempt, { job_id: job.id, attempt_id: attempt.id, attempt_generation: attempt.attempt_generation }, this.clock());
      if (invalid || attempt.lease_owner !== principal.owner) throw new ContractError('HOST_RUN_NOT_CURRENT', '重连时原执行期限或归属已失效', { reason: invalid ?? 'OWNER_MISMATCH' });
      if (!['running', 'waiting_tool', 'completed'].includes(input.observation.native_state)) throw new ContractError('HOST_OBSERVER_NOT_READY', '重连需要实际运行或完成观察');
      const observation = this.insertObservation(binding, { ...input.observation, observer_epoch: input.observer_epoch }, this.clock());
      db.prepare("UPDATE host_task_observers SET state='ready',updated_at=? WHERE workspace_id=? AND id=?").run(new Date(this.clock()).toISOString(), request.workspace_id, observer.id);
      this.ready.add(binding.id); this.applyObservation(binding, observation); return getBinding(db, request.workspace_id, binding.id);
    });
  }
  resume(request: RequestContext, principal: TrustedHostPrincipal, jobId: string, input: ResumeJobRequest): HostRunView {
    this.authorize(request, principal, 'connection');
    exact(input, ['expected_version'], ['input', 'executor', 'native_task_binding_id']);
    return this.mutate(request, principal, 'host-runs.resume', { job_id: jobId, ...input }, () => {
      const db = this.context.db, job = getJob(db, request.workspace_id, jobId);
      if (job.execution_mode !== 'host_session' || !['waiting_input', 'waiting_quota'].includes(job.state) || job.cancel_requested_at) throw new ContractError('HOST_RUN_NOT_CURRENT', '原生任务当前不可恢复');
      if (job.version !== input.expected_version) throw new ContractError('VERSION_CONFLICT', '任务版本已变化', { current_version: job.version });
      if (input.executor || (input.input && Object.keys(input.input).length) || !input.native_task_binding_id) throw new ContractError('VALIDATION_ERROR', '恢复必须保持固定输入并使用新原生绑定');
      const binding = getBinding(db, request.workspace_id, input.native_task_binding_id), observation = this.admission(binding, principal);
      const prior = db.prepare('SELECT b.* FROM native_task_bindings b JOIN job_attempts a ON a.workspace_id=b.workspace_id AND a.native_task_binding_id=b.id WHERE a.workspace_id=? AND a.job_id=?').all(request.workspace_id, jobId) as unknown as NativeTaskBindingsRow[];
      if (prior.some(old => sameIdentity(old, identityOf(binding))) || binding.native_turn_id === jobId || binding.native_task_id === jobId) throw new ContractError('HOST_TASK_BINDING_INVALID', '恢复必须使用新原生 turn 或 task 身份');
      if (inputHash(JSON.parse(job.input_manifest)) !== job.input_hash) throw new ContractError('INPUT_STALE', '恢复输入 hash 不符');
      const queued = revokeAttemptInTransaction(db, request.workspace_id, jobId, 'NEW_NATIVE_ATTEMPT', 'superseded', 'queued', this.clock());
      const claim = startAttemptInTransaction(db, request.workspace_id, queued.id, principal.owner, this.clock(), { lease_ms: this.profile.lease_ms, host_connection_id: binding.host_connection_id, native_task_binding_id: binding.id });
      db.prepare('UPDATE native_task_bindings SET current_attempt_id=?,last_renewed_observation_id=? WHERE workspace_id=? AND id=?').run(claim.attempt.id, observation.id, request.workspace_id, binding.id); return this.view(claim.job, claim.attempt);
    });
  }
  observerReady(job: JobsRow, attempt: JobAttemptsRow): boolean {
    if (job.execution_mode !== 'host_session' || !attempt.native_task_binding_id || !this.ready.has(attempt.native_task_binding_id)) return false;
    try {
      const binding = getBinding(this.context.db, job.workspace_id, attempt.native_task_binding_id), observer = getObserver(this.context.db, job.workspace_id, binding.observer_id);
      if (binding.state !== 'active' || binding.current_attempt_id !== attempt.id || observer.observer_epoch !== binding.observer_epoch || observer.request_identity_ref !== attempt.lease_owner || !['active', 'ready'].includes(observer.state) || !binding.latest_observation_id) return false;
      const observation = getObservation(this.context.db, job.workspace_id, binding.latest_observation_id);
      return observation.observer_id === binding.observer_id && observation.observer_epoch === binding.observer_epoch && ['running', 'waiting_tool', 'completed'].includes(observation.native_state);
    } catch { return false; }
  }
  submit(request: RequestContext, principal: TrustedHostPrincipal, jobId: string, input: ReceiveOutput): ReceiptView {
    this.authorize(request, principal, 'connection'); this.assertJobOwner(request, principal, jobId, input.attempt_id);
    return this.results.submit({ ...request, request_identity_ref: principal.owner }, jobId, input, principal.owner);
  }
  receive(request: RequestContext, principal: TrustedHostPrincipal, jobId: string, input: ReceiveOutput): ReceiptView {
    this.authorize(request, principal, 'connection'); this.assertJobOwner(request, principal, jobId, input.attempt_id);
    return this.results.receive({ ...request, request_identity_ref: principal.owner }, jobId, input, principal.owner);
  }
  private assertJobOwner(request: RequestContext, principal: TrustedHostPrincipal, jobId: string, attemptId: string): void {
    const job = getJob(this.context.db, request.workspace_id, jobId), attempt = getAttempt(this.context.db, request.workspace_id, attemptId);
    if (job.execution_mode !== 'host_session' || attempt.job_id !== jobId || attempt.lease_owner !== principal.owner || attempt.host_connection_id !== principal.host_connection_id) throw new ContractError('HOST_RUN_NOT_CURRENT', '输出不属于当前宿主逻辑连接');
  }
  receipts(request: RequestContext, principal: TrustedHostPrincipal, jobId: string, filters: { state?: string; cursor?: string; limit?: number } = {}): Page<ReceiptView> {
    this.authorize(request, principal, 'connection'); const job = getJob(this.context.db, request.workspace_id, jobId), limit = filters.limit ?? 50;
    if (job.execution_mode !== 'host_session' || !positive(limit) || limit > 200 || (filters.state && !['pending', 'committed', 'quarantined'].includes(filters.state))) throw new ContractError('VALIDATION_ERROR', '收据筛选参数无效');
    const owned = this.context.db.prepare('SELECT id FROM job_attempts WHERE workspace_id=? AND job_id=? AND host_connection_id=? AND lease_owner=?').get(request.workspace_id, jobId, principal.host_connection_id, principal.owner);
    if (!owned) throw new ContractError('AUTH_REQUIRED', '任务不属于当前宿主逻辑连接');
    const [created, id] = decodePageCursor(filters.cursor), conditions = ['workspace_id=?', 'job_id=?'], values: (string | number)[] = [request.workspace_id, jobId];
    if (filters.state) { conditions.push('state=?'); values.push(filters.state); } if (created) { conditions.push('(created_at>? OR (created_at=? AND id>?))'); values.push(created, created, id); }
    const rows = this.context.db.prepare(`SELECT id,attempt_id,created_at FROM result_receipts WHERE ${conditions.join(' AND ')} ORDER BY created_at,id LIMIT ?`).all(...values, limit + 1);
    const page = rows.slice(0, limit); for (const row of page) this.assertJobOwner(request, principal, jobId, String(row.attempt_id));
    const last = page.at(-1); return { items: page.map(row => this.results.read({ ...request, request_identity_ref: principal.owner }, String(row.id))), next_cursor: rows.length > limit && last ? encodePageCursor({ id: String(last.id), created_at: String(last.created_at) }) : null, has_more: rows.length > limit, last_success_at: null };
  }
  readReceipt(request: RequestContext, principal: TrustedHostPrincipal, id: string): ReceiptView {
    this.authorize(request, principal, 'connection'); const receipt = this.results.read(request, id); this.assertJobOwner(request, principal, receipt.job_id, receipt.attempt_id); return receipt;
  }
  private expire(job: JobsRow, attempt: JobAttemptsRow, reason: string, now: number): void {
    if (attempt.native_task_binding_id) this.ready.delete(attempt.native_task_binding_id);
    revokeAttemptInTransaction(this.context.db, job.workspace_id, job.id, reason, 'expired', 'waiting_input', now);
    appendEvent(this.context.db, job.workspace_id, job.id, 'needs_input', { reason, revoked_attempt_id: attempt.id }, now, attempt.attempt_no);
  }
  recoverExpired(): Array<{ job_id: string; reason: string }> {
    return transaction(this.context.db, () => {
      const rows = this.context.db.prepare("SELECT * FROM jobs WHERE workspace_id=? AND execution_mode='host_session' AND state='running'").all(this.context.identity.workspace_id) as unknown as JobsRow[];
      const expired: Array<{ job_id: string; reason: string }> = [];
      for (const job of rows) if (job.current_attempt_id) { const attempt = getAttempt(this.context.db, job.workspace_id, job.current_attempt_id), reason = fenceReason(job, attempt, { job_id: job.id, attempt_id: attempt.id, attempt_generation: attempt.attempt_generation }, this.clock()); if (reason) { this.expire(job, attempt, reason, this.clock()); expired.push({ job_id: job.id, reason }); } }
      return expired;
    });
  }
  async requestNativeInterrupt(request: RequestContext, principal: TrustedHostPrincipal, jobId: string, program?: Pick<HostTaskObserverProgram, 'requestInterrupt'>): Promise<{ logical_cancelled: boolean; native_interrupt: 'unsupported' | 'requested' | 'acknowledged' | 'unknown'; inference_stopped: false }> {
    this.authorize(request, principal, 'observer'); const job = getJob(this.context.db, request.workspace_id, jobId);
    const attempt = this.context.db.prepare('SELECT * FROM job_attempts WHERE workspace_id=? AND job_id=? ORDER BY attempt_no DESC LIMIT 1').get(request.workspace_id, jobId) as unknown as JobAttemptsRow | undefined;
    if (job.state !== 'cancelled' || !job.cancel_requested_at || !attempt?.native_task_binding_id || attempt.host_connection_id !== principal.host_connection_id || attempt.lease_owner !== principal.owner) throw new ContractError('HOST_RUN_NOT_CURRENT', '实际中断请求必须在逻辑取消后由原观察者发起');
    let state: 'unsupported' | 'requested' | 'acknowledged' | 'unknown' = program?.requestInterrupt ? 'requested' : 'unsupported', evidence: string | null = null;
    if (program?.requestInterrupt) {
      transaction(this.context.db, () => appendEvent(this.context.db, request.workspace_id, jobId, 'phase_changed', { logical_cancelled: true, native_interrupt: 'requested', inference_stopped: false }, this.clock(), attempt.attempt_no));
      try { const result = await program.requestInterrupt(identityOf(getBinding(this.context.db, request.workspace_id, attempt.native_task_binding_id))); state = result.acknowledged ? 'acknowledged' : 'unknown'; evidence = result.evidence_ref; } catch { state = 'unknown'; }
    }
    transaction(this.context.db, () => appendEvent(this.context.db, request.workspace_id, jobId, 'phase_changed', { logical_cancelled: true, native_interrupt: state, native_evidence_ref: evidence, inference_stopped: false }, this.clock(), attempt.attempt_no));
    return { logical_cancelled: true, native_interrupt: state, inference_stopped: false };
  }
}
