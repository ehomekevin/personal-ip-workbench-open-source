import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ContractError, type RequestContext, type JsonObject, type JsonValue, type JobsRow, type JobAttemptsRow, type ResultReceiptsRow, type InputHash, type ArtifactOutput } from '@workbench/contracts';
import type { ApplicationContext } from '../ports/index.ts';
import { canonicalJson, inputHash, outputHash, sha256, transaction, lookupIdempotency, claimIdempotency, commitIdempotency } from '@workbench/storage/connection';
import { ManagedFiles, serializeRevision, parseRevision, type RevisionMetadata } from '@workbench/storage/files';
import { assertContext, getDocumentRow, getRevisionRow, assertCoreFreshness, compareAndSetHeadInTransaction, prepareRevisionFile } from '@workbench/storage/revisions';
import { getJob, getAttempt, fenceReason, appendEvent, systemClock, type Clock } from '@workbench/storage/jobs';
import { getReceipt, receiptForAttempt, receiptIntents, quarantineReceiptInTransaction } from '@workbench/storage/receipts';
import { validateArtifacts, verifyArtifact } from './media.ts';
import { workspaceSettings } from '@workbench/storage/settings';
import type { GeneratedAssetOutput } from '@workbench/contracts';
import { validateVoiceAssets, verifyVoiceAsset } from './voice.ts';
import {validateImageAssets,verifyImageAsset} from './image.ts';
import {ImageProviderSettings} from '../settings/image-providers.ts';
import {validateLayoutCheckOutput,verifyLayoutCheckOutput,type LayoutCheckOutput} from './article-layout.ts';

export interface FrozenTarget { document_id: string; base_revision_id: string | null; core_revision_id: string | null }
export interface FrozenResultInput { schema_version: string; mode: 'candidate' | 'initialize' | 'recommendation' | 'none'; targets: FrozenTarget[];
  source_ids: string[]; recommendation_kind?: 'topic' | 'account'; recommendation_run_id?: string }
export interface TypedOutput { documents: Array<{ document_id: string; text: string }>;
  recommendations: Array<{ payload: JsonObject; source_ids: string[]; rationale: string }>; artifacts?:ArtifactOutput[]; generated_assets?:GeneratedAssetOutput[]; layout_check?:LayoutCheckOutput }
export interface ReceiveOutput { attempt_id: string; attempt_generation: number; expected_version: number; input_hash: string; typed_output: TypedOutput }
export interface ReceiptView { receipt_id: string; job_id: string; attempt_id: string; attempt_generation: number; state: ResultReceiptsRow['state']; input_hash: string; output_hash: string;
  results: JsonObject; quarantine_reason: string | null; files: Array<{ intent_id: string; state: string; hash: string; error: JsonObject | null }> }
export type ObserverReadiness = (job: JobsRow, attempt: JobAttemptsRow) => boolean;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) throw new ContractError('VALIDATION_ERROR', '输出字段不符合固定 schema');
}
function frozenInput(job: JobsRow): FrozenResultInput {
  const value = JSON.parse(job.input_manifest);
  if (!object(value) || typeof value.schema_version !== 'string' || !['candidate', 'initialize', 'recommendation', 'none'].includes(String(value.mode)) || !Array.isArray(value.targets) || !Array.isArray(value.source_ids)
    || !value.source_ids.every(id => typeof id === 'string') || inputHash(value) !== job.input_hash) throw new ContractError('VALIDATION_ERROR', '任务固定输入或 hash 无效');
  const targets = value.targets as unknown[];
  for (const target of targets) {
    exact(target, ['document_id', 'base_revision_id', 'core_revision_id']);
    if (typeof target.document_id !== 'string' || !target.document_id || (target.base_revision_id !== null && typeof target.base_revision_id !== 'string') || (target.core_revision_id !== null && typeof target.core_revision_id !== 'string')) throw new ContractError('VALIDATION_ERROR', '固定文稿目标无效');
  }
  if (new Set(targets.map(target => (target as FrozenTarget).document_id)).size !== targets.length) throw new ContractError('VALIDATION_ERROR', '固定目标重复');
  if (value.mode === 'initialize' && targets.some(target => (target as FrozenTarget).base_revision_id !== null)) throw new ContractError('VALIDATION_ERROR', '初始化 base 必须固定为空');
  if (value.mode === 'recommendation' && (!['topic', 'account'].includes(String(value.recommendation_kind)) || targets.length)) throw new ContractError('VALIDATION_ERROR', '推荐输入种类无效');
  if ('recommendation_run_id' in value && (value.mode !== 'recommendation' || typeof value.recommendation_run_id !== 'string' || !value.recommendation_run_id)) throw new ContractError('VALIDATION_ERROR', '推荐运行身份无效');
  if ((value.mode === 'candidate' || value.mode === 'initialize') && !targets.length) throw new ContractError('VALIDATION_ERROR', '文稿任务需要固定目标');
  return value as unknown as FrozenResultInput;
}
function validateTypedOutput(value: unknown, frozen: FrozenResultInput, job:JobsRow): TypedOutput {
  const imageJob=JSON.parse(job.input_manifest).operation==='image_provider';
  exact(value, ['documents','recommendations',...(!imageJob&&object(value)&&'artifacts' in value?['artifacts']:[]),...(imageJob||object(value)&&'generated_assets' in value?['generated_assets']:[]),...(object(value)&&'layout_check' in value?['layout_check']:[])]);
  if(job.kind==='article_layout_check'&&!('layout_check' in value))throw new ContractError('VALIDATION_ERROR','视觉任务缺少专用结果引用');
  if('layout_check' in value){if(frozen.mode!=='none'||frozen.targets.length||'generated_assets' in value||'artifacts' in value)throw new ContractError('VALIDATION_ERROR','视觉输出不可混入文稿或媒体');validateLayoutCheckOutput(value.layout_check,job);}
  if('generated_assets' in value){if(frozen.mode!=='none'||'artifacts' in value)throw new ContractError('VALIDATION_ERROR','生成素材不能混入文稿或渲染结果');if(imageJob)validateImageAssets(value.generated_assets,job);else validateVoiceAssets(value.generated_assets,job);}
  if('artifacts' in value){if(frozen.mode!=='none')throw new ContractError('VALIDATION_ERROR','文稿与推荐不能提交媒体');validateArtifacts(value.artifacts,job);}
  if (!Array.isArray(value.documents) || !Array.isArray(value.recommendations)) throw new ContractError('VALIDATION_ERROR', '输出集合必须是数组');
  for (const document of value.documents) {
    exact(document, ['document_id', 'text']);
    if (typeof document.document_id !== 'string' || typeof document.text !== 'string') throw new ContractError('VALIDATION_ERROR', '文稿输出字段无效');
  }
  const ids = value.documents.map(document => (document as { document_id: string }).document_id);
  if (new Set(ids).size !== ids.length || ids.length !== frozen.targets.length || ids.some(id => !frozen.targets.some(target => target.document_id === id))) throw new ContractError('VALIDATION_ERROR', '输出文稿集合与固定目标不符');
  for (const recommendation of value.recommendations) {
    exact(recommendation, ['payload', 'source_ids', 'rationale']);
    if (!object(recommendation.payload) || !Array.isArray(recommendation.source_ids) || !recommendation.source_ids.every(id => typeof id === 'string' && frozen.source_ids.includes(id)) || typeof recommendation.rationale !== 'string') throw new ContractError('VALIDATION_ERROR', '推荐输出或出处无效');
    canonicalJson(recommendation.payload);
  }
  if (frozen.mode !== 'recommendation' && value.recommendations.length) throw new ContractError('VALIDATION_ERROR', '文稿任务不能提交推荐');
  if (frozen.mode === 'recommendation' && !value.recommendations.length) throw new ContractError('VALIDATION_ERROR', '推荐结果不可为空');
  return value as unknown as TypedOutput;
}
function purpose(job: JobsRow, frozen: FrozenResultInput): string {
  if (frozen.mode === 'recommendation' && job.kind === `${frozen.recommendation_kind}_recommendation`) return 'agent_recommendation';
  if (frozen.mode === 'none' && ['source_sync', 'benchmark_sync', 'source_index', 'metrics_collect', 'media_generate', 'publication', 'article_layout_check'].includes(job.kind)) return 'programmatic_result';
  if (frozen.mode === 'initialize' && job.kind === 'variant_generate') return 'agent_initialize';
  if (frozen.mode === 'candidate' && ['document_modify', 'variant_generate', 'wiki_generate', 'retro_generate', 'speech_cleanup', 'image_plan'].includes(job.kind)) return 'agent_candidate';
  throw new ContractError('VALIDATION_ERROR', '任务种类与输出用途不符');
}
export class ResultCommit {
  readonly context: ApplicationContext; readonly clock: Clock; readonly observerReady: ObserverReadiness;
  constructor(context: ApplicationContext, options: { clock?: Clock; observerReady?: ObserverReadiness } = {}) {
    this.context = context; this.clock = options.clock ?? systemClock;
    // 进程重启后默认不信任磁盘的旧 running 观察；WP-17 必须重新验证后提供 readiness。
    this.observerReady = options.observerReady ?? (() => false);
  }
  get files(): ManagedFiles { return new ManagedFiles(workspaceSettings(this.context.db, this.context.identity.workspace_id).paths); }
  private authorize(context: RequestContext): void {
    assertContext(this.context.db, context, this.context.identity.workspace_id);
    if (context.service_instance_id !== this.context.identity.service_instance_id) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '输出请求主服务身份不符');
  }
  private hostReady(job: JobsRow, attempt: JobAttemptsRow): boolean {
    if (job.execution_mode !== 'host_session') return true;
    if (!attempt.native_task_binding_id || !attempt.host_connection_id || !this.observerReady(job, attempt)) return false;
    const row = this.context.db.prepare(`SELECT b.current_attempt_id,b.state AS binding_state,o.state AS observer_state,c.status AS connection_state,
      c.service_instance_id,c.request_identity_ref,o.request_identity_ref AS observer_identity,
      o.host_connection_id AS observer_connection_id,b.host_connection_id AS binding_connection_id,
      h.status AS capability_status,h.version AS capability_version,o.capability_version AS observed_capability_version,
      h.operation,h.host_surface,h.runtime_version,h.connection_mode,h.plugin_version,
      c.host_surface AS connection_surface,c.runtime_version AS connection_runtime,c.connection_mode AS connection_mode_actual,c.plugin_version AS connection_plugin,
      n.native_state,n.native_evidence_ref,n.binding_id,n.observer_id,n.observer_epoch,
      b.observer_id AS binding_observer_id,b.observer_epoch AS binding_epoch
      FROM native_task_bindings b JOIN host_task_observers o ON o.workspace_id=b.workspace_id AND o.id=b.observer_id AND o.observer_epoch=b.observer_epoch
      JOIN host_connections c ON c.workspace_id=b.workspace_id AND c.id=b.host_connection_id
      JOIN host_capability_records h ON h.workspace_id=o.workspace_id AND h.id=o.capability_record_id
      JOIN native_task_observations n ON n.workspace_id=b.workspace_id AND n.id=b.latest_observation_id
      WHERE b.workspace_id=? AND b.id=? AND b.host_connection_id=?`).get(job.workspace_id, attempt.native_task_binding_id, attempt.host_connection_id);
    return !!row && row.current_attempt_id === attempt.id && row.binding_state === 'active' && ['active', 'ready'].includes(String(row.observer_state))
      && ['active', 'connected'].includes(String(row.connection_state)) && row.service_instance_id === this.context.identity.service_instance_id
      && row.request_identity_ref === attempt.lease_owner && row.observer_identity === attempt.lease_owner
      && row.observer_connection_id === row.binding_connection_id && row.binding_connection_id === attempt.host_connection_id
      && row.capability_status === 'supported' && row.capability_version === row.observed_capability_version
      && row.operation === 'native_task_tracking' && row.host_surface === row.connection_surface && row.runtime_version === row.connection_runtime
      && row.connection_mode === row.connection_mode_actual && row.plugin_version === row.connection_plugin
      && row.binding_id === attempt.native_task_binding_id && row.observer_id === row.binding_observer_id && row.observer_epoch === row.binding_epoch
      && ['running', 'waiting_tool', 'completed'].includes(String(row.native_state)) && typeof row.native_evidence_ref === 'string' && row.native_evidence_ref.length > 0;
  }
  read(context: RequestContext, receiptId: string): ReceiptView { this.authorize(context); return this.view(getReceipt(this.context.db, context.workspace_id, receiptId)); }
  private view(receipt: ResultReceiptsRow): ReceiptView {
    return { receipt_id: receipt.id, job_id: receipt.job_id, attempt_id: receipt.attempt_id, attempt_generation: receipt.attempt_generation,
      state: receipt.state, input_hash: receipt.input_hash, output_hash: receipt.output_hash, results: JSON.parse(receipt.result_ids), quarantine_reason: receipt.quarantine_reason,
      files: receiptIntents(this.context.db, receipt.workspace_id, receipt.id).map(intent => ({ intent_id: intent.id, state: intent.state, hash: intent.sha256, error: intent.error ? JSON.parse(intent.error) : null })) };
  }
  receive(context: RequestContext, jobId: string, input: ReceiveOutput, owner: string): ReceiptView {
    this.authorize(context); if (!context.idempotency_key) throw new ContractError('VALIDATION_ERROR', '缺少 Idempotency-Key');
    exact(input, ['attempt_id', 'attempt_generation', 'expected_version', 'input_hash', 'typed_output']);
    if (typeof input.attempt_id !== 'string' || !Number.isSafeInteger(input.attempt_generation) || input.attempt_generation < 1 || !Number.isSafeInteger(input.expected_version) || input.expected_version < 1 || typeof input.input_hash !== 'string') throw new ContractError('VALIDATION_ERROR', '输出归属字段无效');
    const db = this.context.db, workspace = context.workspace_id, operation = 'jobs.outputs', requestBody = { job_id: jobId, input };
    return transaction(db, () => {
      const job = getJob(db, workspace, jobId), attempt = getAttempt(db, workspace, input.attempt_id);
      if (attempt.job_id !== jobId || attempt.attempt_generation !== input.attempt_generation || !owner || attempt.lease_owner !== owner) throw new ContractError('HOST_RUN_NOT_CURRENT', '输出执行 owner 或代次不匹配');
      const frozen = frozenInput(job), typed = validateTypedOutput(input.typed_output, frozen, job), commitPurpose = purpose(job, frozen);
      if (input.input_hash !== job.input_hash) throw new ContractError('INPUT_STALE', '输出输入 hash 与冻结任务不符');
      const payload = { target: frozen.targets as unknown as JsonValue, commit_purpose: commitPurpose, input_hash: job.input_hash as InputHash, typed_output: typed as unknown as JsonValue };
      const hash = outputHash(payload), oldRequest = lookupIdempotency(db, workspace, operation, context.idempotency_key!, requestBody);
      const existing = receiptForAttempt(db, workspace, jobId, attempt.id, input.attempt_generation);
      if (existing) {
        if (existing.output_hash !== hash) throw new ContractError(job.execution_mode === 'host_session' ? 'HOST_RUN_OUTPUT_CONFLICT' : 'RESULT_OUTPUT_CONFLICT', '同一执行归属收到不同输出');
        if (existing.state === 'pending' && !fenceReason(job, attempt, { job_id: jobId, attempt_id: attempt.id, attempt_generation: input.attempt_generation }, this.clock()) && !this.hostReady(job, attempt)) throw new ContractError('HOST_OBSERVER_NOT_READY', 'pending 输出的原生 owner 或连接关联尚未就绪');
        const claim = oldRequest ?? claimIdempotency(db, workspace, operation, context.idempotency_key!, requestBody);
        const requests = JSON.parse(existing.idempotency_requests) as string[];
        if (!requests.includes(claim.id)) db.prepare('UPDATE result_receipts SET idempotency_requests=? WHERE workspace_id=? AND id=?').run(canonicalJson([...requests, claim.id]), workspace, existing.id);
        this.linkRequest(claim.id, existing); return this.view(existing);
      }
      if (oldRequest) throw new ContractError('STORAGE_UNAVAILABLE', '幂等请求缺少原收据');
      const now = this.clock(), invalid = fenceReason(job, attempt, { job_id: jobId, attempt_id: attempt.id, attempt_generation: input.attempt_generation }, now);
      if (!invalid && job.version !== input.expected_version) throw new ContractError('VERSION_CONFLICT', '输出任务版本已变化', { current_version: job.version });
      if (!invalid && !this.hostReady(job, attempt)) throw new ContractError('HOST_OBSERVER_NOT_READY', '原生观察绑定尚未重新就绪');
      for (const target of frozen.targets) {
        getDocumentRow(db, workspace, target.document_id);
        if (target.base_revision_id) getRevisionRow(db, workspace, target.base_revision_id, target.document_id);
        if (target.core_revision_id) getRevisionRow(db, workspace, target.core_revision_id);
        if (frozen.mode === 'initialize' && (!target.core_revision_id || !db.prepare('SELECT id FROM variants WHERE workspace_id=? AND document_id=?').get(workspace, target.document_id))) throw new ContractError('VALIDATION_ERROR', 'auto_initial 仅允许固定核心稿的平台文稿');
      }
      for (const source of frozen.source_ids) if (!db.prepare('SELECT id FROM source_records WHERE workspace_id=? AND id=?').get(workspace, source)) throw new ContractError('NOT_FOUND', '固定出处不存在');
      const claim = claimIdempotency(db, workspace, operation, context.idempotency_key!, requestBody), id = randomUUID(), at = new Date(now).toISOString();
      db.prepare(`INSERT INTO result_receipts(id,workspace_id,job_id,attempt_id,attempt_generation,input_hash,output_hash,commit_purpose,state,result_ids,quarantine_reason,idempotency_requests,output_payload,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'pending','{}',NULL,?,?,?,?)`).run(id, workspace, jobId, attempt.id, input.attempt_generation, job.input_hash, hash, commitPurpose, canonicalJson([claim.id]), canonicalJson(payload), at, at);
      for (const output of typed.documents) {
        const target = frozen.targets.find(target => target.document_id === output.document_id)!, document = getDocumentRow(db, workspace, target.document_id);
        const revisionId = randomUUID(), variant = db.prepare('SELECT topic_id FROM variants WHERE workspace_id=? AND document_id=?').get(workspace, document.id);
        const metadata: RevisionMetadata = { workspace_id: workspace, document_id: document.id, revision_id: revisionId, parent_revision_id: target.base_revision_id,
          topic_id: variant ? String(variant.topic_id) : null, kind: document.kind, source_ids: frozen.source_ids, created_at: at, origin: 'agent', change_kind: 'text',
          created_by: owner, based_on_core_revision_id: target.core_revision_id, restore_from_revision_id: null, merge_candidate_id: null,
          job_id: jobId, attempt_id: attempt.id, attempt_generation: input.attempt_generation, result_receipt_id: id };
        const content = serializeRevision(metadata, output.text);
        db.prepare(`INSERT INTO write_intents(id,workspace_id,document_id,expected_revision_id,planned_revision_id,path,sha256,pending_content,commit_purpose,
          result_receipt_id,job_id,attempt_id,attempt_generation,input_hash,output_hash,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
          .run(randomUUID(), workspace, document.id, target.base_revision_id, revisionId, this.files.revisionPath(document.id, revisionId), sha256(content), content,
            frozen.mode === 'initialize' ? 'agent_initialize' : 'agent_candidate', id, jobId, attempt.id, input.attempt_generation, job.input_hash, hash, at, at);
      }
      if (invalid) quarantineReceiptInTransaction(db, workspace, id, invalid, now);
      const receipt = getReceipt(db, workspace, id); this.linkRequest(claim.id, receipt); return this.view(receipt);
    });
  }
  private linkRequest(requestId: string, receipt: ResultReceiptsRow): void {
    const db = this.context.db;
    if (receipt.state === 'pending') db.prepare("UPDATE idempotency_requests SET response=? WHERE workspace_id=? AND id=? AND state='pending'").run(canonicalJson({ receipt_id: receipt.id }), receipt.workspace_id, requestId);
    else commitIdempotency(db, receipt.workspace_id, requestId, { receipt_id: receipt.id });
  }
  prepare(receiptId: string, onFile?: (index: number) => void): ReceiptView {
    const workspace = this.context.identity.workspace_id, receipt = getReceipt(this.context.db, workspace, receiptId);
    if (receipt.state !== 'pending') return this.view(receipt);
    for (const [index, intent] of receiptIntents(this.context.db, workspace, receiptId).entries()) { prepareRevisionFile(this.context.db, this.files, workspace, intent.id); onFile?.(index); }
    return this.view(getReceipt(this.context.db, workspace, receiptId));
  }
  // 正常和恢复唯一最终入口；同步文件 hash 核验在同一 SQLite 事务内执行。
  commitResult(receiptId: string): ReceiptView {
    const db = this.context.db, workspace = this.context.identity.workspace_id;
    return transaction(db, () => {
      const receipt = getReceipt(db, workspace, receiptId); if (receipt.state !== 'pending') return this.view(receipt);
      const job = getJob(db, workspace, receipt.job_id), attempt = getAttempt(db, workspace, receipt.attempt_id), now = this.clock();
      const invalid = fenceReason(job, attempt, { job_id: job.id, attempt_id: attempt.id, attempt_generation: receipt.attempt_generation }, now);
      if (invalid) { quarantineReceiptInTransaction(db, workspace, receiptId, invalid, now); return this.view(getReceipt(db, workspace, receiptId)); }
      if (!this.hostReady(job, attempt)) return this.view(receipt);
      const frozen = frozenInput(job), commitPurpose = purpose(job, frozen), intents = receiptIntents(db, workspace, receiptId);
      try {
        if (!receipt.output_payload) throw new ContractError('STORAGE_UNAVAILABLE', 'needs_repair：旧收据缺少固定输出 payload');
        const payload = JSON.parse(receipt.output_payload), typed = validateTypedOutput(payload.typed_output, frozen, job);
        if (receipt.input_hash !== job.input_hash || receipt.commit_purpose !== commitPurpose || payload.commit_purpose !== commitPurpose || payload.input_hash !== job.input_hash || canonicalJson(payload.target) !== canonicalJson(frozen.targets) || outputHash(payload) !== receipt.output_hash) throw new ContractError('STORAGE_UNAVAILABLE', 'needs_repair：固定输入与输出 hash 不符');
        if (intents.length !== typed.documents.length || new Set(intents.map(intent => intent.document_id)).size !== intents.length) throw new ContractError('STORAGE_UNAVAILABLE', 'needs_repair：多正文集合未完整登记');
        const verified = intents.map(intent => {
          const target = frozen.targets.find(target => target.document_id === intent.document_id), output = typed.documents.find(document => document.document_id === intent.document_id);
          if (!target || !output || intent.state !== 'pending' || intent.job_id !== job.id || intent.attempt_id !== attempt.id || intent.attempt_generation !== receipt.attempt_generation || intent.result_receipt_id !== receipt.id || intent.input_hash !== job.input_hash || intent.output_hash !== receipt.output_hash || intent.expected_revision_id !== target.base_revision_id || intent.commit_purpose !== (frozen.mode === 'initialize' ? 'agent_initialize' : 'agent_candidate')) throw new ContractError('STORAGE_UNAVAILABLE', 'needs_repair：文件意图归属不符');
          this.files.validateRevisionPath(intent.path, { workspace_id: workspace, document_id: intent.document_id, revision_id: intent.planned_revision_id });
          const bytes = readFileSync(intent.path);
          if (sha256(bytes) !== intent.sha256) throw new ContractError('STORAGE_UNAVAILABLE', 'needs_repair：正文原始字节 hash 不符');
          const content = bytes.toString('utf8'), parsed = parseRevision(content), metadata = parsed.metadata;
          if (parsed.text !== output.text || metadata.workspace_id !== workspace || metadata.document_id !== intent.document_id || metadata.revision_id !== intent.planned_revision_id || metadata.parent_revision_id !== target.base_revision_id
            || metadata.job_id !== job.id || metadata.attempt_id !== attempt.id || metadata.attempt_generation !== receipt.attempt_generation || metadata.result_receipt_id !== receipt.id || metadata.origin !== 'agent' || metadata.change_kind !== 'text' || metadata.based_on_core_revision_id !== target.core_revision_id || metadata.created_by !== attempt.lease_owner || canonicalJson(metadata.source_ids) !== canonicalJson(frozen.source_ids)) throw new ContractError('STORAGE_UNAVAILABLE', 'needs_repair：正文文件 hash 或归属不符');
          return { intent, metadata, target };
        });
        const artifacts=(typed.artifacts??[]).map(output=>({output,manifest:verifyArtifact(this.context,job,attempt,output)}));
        const imageAssets=JSON.parse(job.input_manifest).operation==='image_provider'?(typed.generated_assets??[]).map(output=>({output,...verifyImageAsset(this.context,job,attempt,output)})):[];
        const generatedAssets=JSON.parse(job.input_manifest).operation==='image_provider'?[]:(typed.generated_assets??[]).map(output=>({output,...verifyVoiceAsset(this.context,job,attempt,output)}));
        const layoutExecution=typed.layout_check?verifyLayoutCheckOutput(this.context,job,attempt,typed.layout_check):null;
        const commitTime = this.clock(), deadlineReached = fenceReason(job, attempt, { job_id: job.id, attempt_id: attempt.id, attempt_generation: receipt.attempt_generation }, commitTime);
        if (deadlineReached) { quarantineReceiptInTransaction(db, workspace, receiptId, deadlineReached, commitTime); return this.view(getReceipt(db, workspace, receiptId)); }
        const results: JsonObject = { documents: [], recommendations: [] }, at = new Date(commitTime).toISOString();
        // 数据库 trigger 要求 committed receipt；后续任何失败会回滚整组变更。
        db.prepare("UPDATE result_receipts SET state='committed',updated_at=? WHERE workspace_id=? AND id=?").run(at, workspace, receiptId);
        for (const { intent, metadata, target } of verified) {
          db.prepare(`INSERT INTO document_revisions(id,workspace_id,document_id,parent_revision_id,file_path,sha256,origin,change_kind,job_id,attempt_id,attempt_generation,result_receipt_id,based_on_core_revision_id,created_by,created_at,updated_at)
            VALUES (?,?,?,?,?,?,'agent','text',?,?,?,?,?,?,?,?)`).run(intent.planned_revision_id, workspace, intent.document_id, intent.expected_revision_id, intent.path, intent.sha256, job.id, attempt.id, receipt.attempt_generation, receipt.id, target.core_revision_id, metadata.created_by, metadata.created_at, metadata.created_at);
          const candidateId = randomUUID(); let adopted = false;
          const variant = db.prepare('SELECT topic_id FROM variants WHERE workspace_id=? AND document_id=?').get(workspace, intent.document_id);
          if (frozen.mode === 'initialize' && variant && target.core_revision_id) {
            let fresh = false;
            try { assertCoreFreshness(db, workspace, String(variant.topic_id), target.core_revision_id); fresh = true; }
            catch (error) { if (!(error instanceof ContractError) || !['INPUT_STALE', 'CORE_NOT_CONFIRMED'].includes(error.code)) throw error; }
            if (fresh) adopted = compareAndSetHeadInTransaction(db, workspace, intent.document_id, null, intent.planned_revision_id);
          }
          db.prepare(`INSERT INTO candidates(id,workspace_id,target_document_id,base_revision_id,revision_id,job_id,attempt_id,attempt_generation,result_receipt_id,status,adopted_revision_id,adoption_mode,adopted_at,adopted_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(candidateId, workspace, intent.document_id, target.base_revision_id, intent.planned_revision_id, job.id, attempt.id, receipt.attempt_generation, receiptId,
              adopted ? 'adopted' : 'pending', adopted ? intent.planned_revision_id : null, adopted ? 'auto_initial' : null, adopted ? at : null, adopted ? 'service:auto_initial' : null);
          if (adopted) db.prepare("UPDATE variants SET status='ready',based_on_core_revision_id=?,version=version+1,updated_at=? WHERE workspace_id=? AND document_id=?").run(target.core_revision_id, at, workspace, intent.document_id);
          (results.documents as JsonValue[]).push({ document_id: intent.document_id, revision_id: intent.planned_revision_id, candidate_id: candidateId, adopted, adoption_mode: adopted ? 'auto_initial' : null });
          db.prepare("UPDATE write_intents SET state='committed',pending_content=NULL,error=NULL,updated_at=? WHERE workspace_id=? AND id=?").run(at, workspace, intent.id);
        }
        if (typed.recommendations.length) {
          const runId = frozen.recommendation_run_id ?? randomUUID();
          if (frozen.recommendation_run_id) {
            const run = db.prepare('SELECT kind,input_manifest,job_id,status FROM recommendation_runs WHERE workspace_id=? AND id=?').get(workspace, runId);
            if (!run || run.kind !== frozen.recommendation_kind || run.input_manifest !== job.input_manifest || run.job_id !== job.id || run.status === 'succeeded') throw new ContractError('STORAGE_UNAVAILABLE', 'needs_repair：推荐运行归属与固定任务不符');
            db.prepare("UPDATE recommendation_runs SET status='succeeded',updated_at=? WHERE workspace_id=? AND id=?").run(at, workspace, runId);
          } else {
            // 旧任务没有预建运行，保留 WP09 原有提交行为。
            db.prepare("INSERT INTO recommendation_runs(id,workspace_id,kind,input_manifest,job_id,status) VALUES (?,?,?,?,?,'succeeded')").run(runId, workspace, frozen.recommendation_kind!, job.input_manifest, job.id);
          }
          results.recommendation_run_id = runId;
          for (const output of typed.recommendations) {
            const candidateId = randomUUID();
            db.prepare(`INSERT INTO recommendation_candidates(id,workspace_id,run_id,kind,payload,source_ids,rationale,attempt_id,attempt_generation,result_receipt_id,status)
              VALUES (?,?,?,?,?,?,?,?,?,?,'pending')`).run(candidateId, workspace, runId, frozen.recommendation_kind!, canonicalJson(output.payload), canonicalJson(output.source_ids), output.rationale, attempt.id, receipt.attempt_generation, receiptId);
            (results.recommendations as JsonValue[]).push({ candidate_id: candidateId, run_id: runId });
          }
        }
        if(artifacts.length){results.artifact_ids=artifacts.map(({output})=>output.artifact_id);for(const {output,manifest} of artifacts){db.prepare('INSERT INTO artifacts(id,workspace_id,variant_id,variant_revision_id,content_plan_revision_id,production_plan_revision_id,manifest_path,sha256,kind,status,producer_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(output.artifact_id,workspace,output.variant_id,output.variant_revision_id,output.content_plan_revision_id,output.production_plan_revision_id,output.manifest_path,output.sha256,output.kind,manifest.status,output.producer_version);appendEvent(db,workspace,job.id,'artifact_ready',{receipt_id:receiptId,artifact_id:output.artifact_id,sha256:output.sha256,status:manifest.status},commitTime,attempt.attempt_no);}}
        if(generatedAssets.length){results.asset_ids=generatedAssets.map(({output})=>output.asset_id);for(const {output,manifest,file_path}of generatedAssets){
          db.prepare("INSERT INTO assets(id,workspace_id,kind,origin,file_path,sha256,size_bytes,mime,duration_ms,status,job_id,generation_metadata) VALUES (?,?,'audio','h3',?,?,?,?,?,'ready',?,?)").run(output.asset_id,workspace,file_path,manifest.file_sha256,manifest.size_bytes,'audio/flac',manifest.duration_ms,job.id,canonicalJson(manifest.metadata));
          db.prepare('INSERT INTO topic_asset_links(id,workspace_id,topic_id,asset_id,purpose,evidence_kind) VALUES (?,?,?,?,?,?)').run(randomUUID(),workspace,manifest.topic_id,output.asset_id,'口播声音试听','generated');
          db.prepare("INSERT INTO asset_candidates(id,workspace_id,job_id,asset_id,status) VALUES (?,?,?,?,'pending')").run(randomUUID(),workspace,job.id,output.asset_id);
        }}
        if(imageAssets.length){results.asset_ids=imageAssets.map(({output})=>output.asset_id);for(const {output,manifest,file_path} of imageAssets){
          db.prepare("INSERT INTO assets(id,workspace_id,kind,origin,file_path,sha256,size_bytes,mime,dimensions,status,job_id,generation_metadata) VALUES (?,?,'image','agent',?,?,?,?,?,'ready',?,?)").run(output.asset_id,workspace,file_path,manifest.file_sha256,manifest.size_bytes,manifest.mime,canonicalJson({width:manifest.width,height:manifest.height}),job.id,canonicalJson(manifest.metadata));
          db.prepare('INSERT INTO topic_asset_links(id,workspace_id,topic_id,asset_id,purpose,evidence_kind) VALUES (?,?,?,?,?,?)').run(randomUUID(),workspace,manifest.topic_id,output.asset_id,String(manifest.metadata.purpose),'generated');
          new ImageProviderSettings(this.context).record(manifest.provider,job.id,output.asset_id,manifest.model,String(manifest.metadata.operation));
          appendEvent(db,workspace,job.id,'phase_changed',{phase:'image_ready',asset_id:output.asset_id,provider:manifest.provider,model:manifest.model,adoption:'pending'},commitTime,attempt.attempt_no);
        }}
        if(layoutExecution&&typed.layout_check)results.layout_check={...typed.layout_check};
        db.prepare('UPDATE result_receipts SET result_ids=? WHERE workspace_id=? AND id=?').run(canonicalJson(results), workspace, receiptId);
        db.prepare("UPDATE job_attempts SET state='succeeded',output_hash=?,updated_at=? WHERE workspace_id=? AND id=?").run(receipt.output_hash, at, workspace, attempt.id);
        if (attempt.native_task_binding_id) db.prepare("UPDATE native_task_bindings SET state='closed',updated_at=? WHERE workspace_id=? AND id=?").run(at, workspace, attempt.native_task_binding_id);
        db.prepare("UPDATE jobs SET state='succeeded',version=version+1,updated_at=? WHERE workspace_id=? AND id=?").run(at, workspace, job.id);
        appendEvent(db, workspace, job.id, typed.documents.length || typed.recommendations.length ? 'candidate_ready' : 'phase_changed', { receipt_id: receiptId, results }, commitTime, attempt.attempt_no);
        appendEvent(db, workspace, job.id, 'succeeded', { receipt_id: receiptId }, commitTime, attempt.attempt_no);
        for (const id of JSON.parse(receipt.idempotency_requests) as string[]) commitIdempotency(db, workspace, id, { receipt_id: receiptId });
        return this.view(getReceipt(db, workspace, receiptId));
      } catch (error) {
        // 仅核验阶段的异常可保留 pending；事务已开始提交时必须整体回滚。
        if (getReceipt(db, workspace, receiptId).state === 'committed') throw error;
        const detail = canonicalJson({ code: 'STORAGE_UNAVAILABLE', reason: 'needs_repair', message: error instanceof Error ? error.message : '输出不可核验' });
        db.prepare('UPDATE write_intents SET error=? WHERE workspace_id=? AND result_receipt_id=? AND state=\'pending\'').run(detail, workspace, receiptId);
        if (!intents.length && !db.prepare("SELECT id FROM job_events WHERE workspace_id=? AND job_id=? AND json_extract(payload,'$.receipt_id')=? AND json_extract(payload,'$.reason')='needs_repair'").get(workspace, job.id, receiptId)) appendEvent(db, workspace, job.id, 'phase_changed', { receipt_id: receiptId, reason: 'needs_repair', error: JSON.parse(detail) }, now, attempt.attempt_no);
        return this.view(receipt);
      }
    });
  }
  submit(context: RequestContext, jobId: string, input: ReceiveOutput, owner: string): ReceiptView {
    const receipt = this.receive(context, jobId, input, owner); if (receipt.state !== 'pending') return receipt;
    this.prepare(receipt.receipt_id); return this.commitResult(receipt.receipt_id);
  }
  recover(): Array<{ receipt_id: string; state: string; reason: string | null }> {
    const db = this.context.db, workspace = this.context.identity.workspace_id;
    const rows = db.prepare("SELECT id FROM result_receipts WHERE workspace_id=? AND state='pending' ORDER BY created_at,id").all(workspace);
    return rows.map(row => {
      const id = String(row.id);
      // 先 finalizer 检查当前归属；observer 未就绪、到期和已隔离都不能先写文件。
      let result = this.commitResult(id);
      if (result.state === 'pending') {
        const receipt = getReceipt(db, workspace, id), job = getJob(db, workspace, receipt.job_id), attempt = getAttempt(db, workspace, receipt.attempt_id);
        if (this.hostReady(job, attempt) && receipt.output_payload) {
          try { this.prepare(id); result = this.commitResult(id); }
          catch (error) { return { receipt_id: id, state: 'pending', reason: error instanceof Error ? error.message : 'needs_repair' }; }
        }
      }
      return { receipt_id: id, state: result.state, reason: result.quarantine_reason ?? (result.state === 'pending' ? 'OBSERVER_NOT_READY_OR_NEEDS_REPAIR' : null) };
    });
  }
}
