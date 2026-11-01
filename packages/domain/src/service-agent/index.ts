import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { relative, isAbsolute, sep } from 'node:path';
import { ContractError, type AgentRunInput, type AgentResult, type JsonObject, SaveApiFallbackSchema, TextExecutionPolicySchema, type ApiFallbackConfiguration } from '@workbench/contracts';
import type { ApplicationContext, AgentPort } from '../ports/index.ts';
import type { FrozenResultInput, TypedOutput } from '../result-commit/index.ts';
import { canonicalJson, inputHash, sha256 } from '@workbench/storage/connection';
import { ManagedFiles, parseRevision } from '@workbench/storage/files';
import { workspaceSettings } from '@workbench/storage/settings';
import type { ClaimedJob } from '@workbench/storage/jobs';
import { readWritingSkills } from '@workbench/adapters/agent/codex';

export type ServiceExecutor = 'codex' | 'claude';
export interface ServiceAgentPlan { executor_id: ServiceExecutor; cwd: string; fixed_input_hash: string; input: AgentRunInput; api_fallback?:ApiFallbackConfiguration }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function typedOutputSchema(frozen: FrozenResultInput): JsonObject {
  return { type: 'object', required: ['documents', 'recommendations'], additionalProperties: false, properties: {
    documents: { type: 'array', minItems: frozen.targets.length, maxItems: frozen.targets.length, items: { type: 'object', required: ['document_id', 'text'], additionalProperties: false, properties: { document_id: frozen.targets.length ? { type: 'string', enum: frozen.targets.map(target => target.document_id) } : { type: 'string' }, text: { type: 'string' } } } },
    // 原生 strict structured-output 不接受开放 object；正文 payload 作为 JSON 字符串，服务验证后转换。
    recommendations: { type: 'array', ...(frozen.mode === 'recommendation' ? { minItems: 1 } : { maxItems: 0 }), items: { type: 'object', required: ['payload_json', 'source_ids', 'rationale'], additionalProperties: false, properties: { payload_json: { type: 'string' }, source_ids: { type: 'array', ...(frozen.source_ids.length ? {} : { maxItems: 0 }), items: frozen.source_ids.length ? { type: 'string', enum: frozen.source_ids } : { type: 'string' } }, rationale: { type: 'string' } } } },
  } };
}
// 计划由服务固定；正文材料使用登记 revision 的原始字节 hash，不能取当前 head 替换旧输入。
export function buildServiceAgentPlan(context: ApplicationContext, claim: ClaimedJob, options: { staging_root: string }): ServiceAgentPlan {
  const job = claim.job; if (job.execution_mode !== 'service_adapter' || !['codex', 'claude'].includes(job.executor_id ?? '')) throw new ContractError('VALIDATION_ERROR', '必须明确固定 service_adapter 与执行器');
  const frozen = JSON.parse(job.input_manifest) as FrozenResultInput & { service_agent?: unknown;viewpoints_context?: unknown };
  if (inputHash(frozen) !== job.input_hash || typeof frozen.schema_version !== 'string' || !['candidate', 'initialize', 'recommendation'].includes(frozen.mode) || !Array.isArray(frozen.targets) || !Array.isArray(frozen.source_ids) || !frozen.source_ids.every(id => typeof id === 'string') || !object(frozen.service_agent)) throw new ContractError('INPUT_STALE', '服务任务缺少固定计划或输入 hash 不符');
  for (const target of frozen.targets) if (!object(target) || Object.keys(target).some(key => !['document_id', 'base_revision_id', 'core_revision_id'].includes(key)) || typeof target.document_id !== 'string' || !target.document_id || !(target.base_revision_id === null || typeof target.base_revision_id === 'string') || !(target.core_revision_id === null || typeof target.core_revision_id === 'string')) throw new ContractError('VALIDATION_ERROR', '固定目标 schema 不符');
  if (new Set(frozen.targets.map(target => target.document_id)).size !== frozen.targets.length || (frozen.mode === 'recommendation' ? frozen.targets.length || !['topic', 'account'].includes(frozen.recommendation_kind ?? '') : !frozen.targets.length)) throw new ContractError('VALIDATION_ERROR', '固定目标/推荐用途不符');
  const settings = frozen.service_agent; if (typeof settings.cwd !== 'string' || typeof settings.task_instruction !== 'string' || !settings.task_instruction.trim() || !Array.isArray(settings.allowed_tools) || settings.allowed_tools.length || Object.keys(settings).some(key => !['cwd', 'task_instruction', 'allowed_tools','api_fallback','execution_policy'].includes(key))) throw new ContractError('VALIDATION_ERROR', '固定服务计划只允许 cwd、指令与空工具范围');
  if(settings.api_fallback!==undefined){if(!object(settings.api_fallback))throw new ContractError('INPUT_STALE','API 回退计划无效');const {settings_version,...route}=settings.api_fallback;SaveApiFallbackSchema.parse({...route,expected_version:settings_version});}
  if(settings.execution_policy!==undefined)TextExecutionPolicySchema.parse(settings.execution_policy);
  readWritingSkills({ frozen: frozen as unknown as JsonObject });
  const root = realpathSync(options.staging_root), cwd = realpathSync(settings.cwd), rel = relative(root, cwd);
  if (!isAbsolute(settings.cwd) || cwd !== settings.cwd || lstatSync(settings.cwd).isSymbolicLink() || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ContractError('VALIDATION_ERROR', '任务 cwd 必须位于受信 staging_root');
  const files = new ManagedFiles(workspaceSettings(context.db, context.identity.workspace_id).paths), materials: JsonObject[] = [];
  for (const target of frozen.targets) for (const revisionId of [target.base_revision_id, target.core_revision_id].filter((id): id is string => !!id)) {
    const row = context.db.prepare('SELECT * FROM document_revisions WHERE workspace_id=? AND id=?').get(job.workspace_id, revisionId);
    if (!row || (revisionId === target.base_revision_id && row.document_id !== target.document_id) || row.file_path !== files.revisionPath(String(row.document_id), revisionId)) throw new ContractError('INPUT_STALE', '固定 revision 与登记文稿路径不符');
    const bytes = readFileSync(String(row.file_path)); if (sha256(bytes) !== row.sha256) throw new ContractError('INPUT_STALE', '固定 revision 原始文件 hash 不符');
    const parsed = parseRevision(bytes.toString('utf8')); if (parsed.metadata.workspace_id !== job.workspace_id || parsed.metadata.document_id !== row.document_id || parsed.metadata.revision_id !== revisionId) throw new ContractError('INPUT_STALE', '固定修订身份不符');
    materials.push({ document_id: String(row.document_id), revision_id: revisionId, sha256: String(row.sha256), text: parsed.text });
  }
  const viewpoints=frozen.viewpoints_context;
  if(viewpoints!==undefined){
    if(!object(viewpoints)||typeof viewpoints.topic_id!=='string'||typeof viewpoints.document_id!=='string'||typeof viewpoints.revision_id!=='string'||typeof viewpoints.text!=='string'||sha256(viewpoints.text)!==viewpoints.text_sha256)throw new ContractError('INPUT_STALE','固定观点的正文与 hash 不符');
    const row=context.db.prepare("SELECT r.*,d.kind,d.owner_entity_id FROM document_revisions r JOIN documents d ON d.workspace_id=r.workspace_id AND d.id=r.document_id WHERE r.workspace_id=? AND r.document_id=? AND r.id=?").get(job.workspace_id,viewpoints.document_id,viewpoints.revision_id);
    if(!row||row.kind!=='topic_viewpoints'||row.owner_entity_id!==viewpoints.topic_id||row.file_path!==files.revisionPath(viewpoints.document_id,viewpoints.revision_id))throw new ContractError('INPUT_STALE','固定观点不属于当前主题修订');
    const bytes=files.readRevision(String(row.file_path),String(row.sha256) as Parameters<typeof files.readRevision>[1],{workspace_id:job.workspace_id,document_id:viewpoints.document_id,revision_id:viewpoints.revision_id}),parsed=parseRevision(bytes.content);
    if(parsed.text!==viewpoints.text)throw new ContractError('INPUT_STALE','固定观点与登记修订正文不符');
    materials.push({document_id:viewpoints.document_id,revision_id:viewpoints.revision_id,sha256:String(row.sha256),text:parsed.text,purpose:'author_viewpoints',topic_id:viewpoints.topic_id});
  }
  return { executor_id: job.executor_id as ServiceExecutor, cwd, ...(settings.api_fallback?{api_fallback:settings.api_fallback as unknown as ApiFallbackConfiguration}:{}), fixed_input_hash: job.input_hash, input: { job_id: job.id, kind: job.kind, task_instruction: settings.task_instruction, target_document_id: frozen.targets[0]?.document_id ?? null, base_revision_id: frozen.targets[0]?.base_revision_id ?? null,
    ...(frozen.targets[0]?.core_revision_id ? { core_revision_id: frozen.targets[0].core_revision_id } : {}), input_manifest: { frozen: frozen as unknown as JsonObject, fixed_input_hash: job.input_hash, materials }, allowed_tools: [], output_schema: typedOutputSchema(frozen) } };
}
export function resultTypedOutput(result: AgentResult): TypedOutput {
  if (result.status !== 'completed' || result.asset_candidates.length || result.evidence_links.length || !object(result.resume_info.output)) throw new ContractError('VALIDATION_ERROR', '服务 Agent 结果种类无效');
  const value = result.resume_info.output; if (Object.keys(value).some(key => !['documents', 'recommendations'].includes(key)) || !Array.isArray(value.documents) || !Array.isArray(value.recommendations)) throw new ContractError('VALIDATION_ERROR', '结果不能指定路径、用途或提交 owner');
  const typed = JSON.parse(canonicalJson(value)) as { documents: TypedOutput['documents']; recommendations: unknown[] };
  typed.recommendations = typed.recommendations.map(recommendation => {
    if (!object(recommendation) || Object.keys(recommendation).some(key => !['payload_json', 'source_ids', 'rationale'].includes(key)) || typeof recommendation.payload_json !== 'string') throw new ContractError('VALIDATION_ERROR', '推荐输出字段不符');
    let payload: unknown; try { payload = JSON.parse(recommendation.payload_json); } catch { throw new ContractError('VALIDATION_ERROR', '推荐 payload JSON 无效'); }
    if (!object(payload)) throw new ContractError('VALIDATION_ERROR', '推荐 payload 必须为对象');
    return { payload, source_ids: recommendation.source_ids, rationale: recommendation.rationale };
  });
  return typed as TypedOutput;
}
export async function executorHealth(adapters: Readonly<Partial<Record<ServiceExecutor, AgentPort>>>): Promise<JsonObject[]> {
  return Promise.all(Object.entries(adapters).map(async ([executor, adapter]): Promise<JsonObject> => { try { const ready = await adapter!.checkReadiness(); return { executor_id: executor, status: 'ready', readiness: ready as unknown as JsonObject }; } catch (error) { return { executor_id: executor, status: 'blocked', error: error instanceof ContractError ? { code: error.code, details: error.details } : { code: 'RESULT_UNKNOWN' } }; } }));
}
