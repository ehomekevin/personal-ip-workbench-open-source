import * as C from '@workbench/contracts';
import type { JsonObject, RuntimeSchema } from '@workbench/contracts';

export const WORKBENCH_RESOURCE_URI = 'ui://personal-ip-workbench/0.1.0.html';
export const BUSINESS_RESOURCE_PREFIX = 'workbench://personal-ip-workbench/';
export type WorkbenchMethod = 'GET' | 'POST' | 'PATCH' | 'PUT';
export interface BridgeRequestOptions { signal?: AbortSignal; idempotencyKey?: string }
export interface ToolRoute {
  name: string; method: WorkbenchMethod; path: string; bodySchema?: RuntimeSchema<unknown>; query: string[];
  idempotent: boolean; destructive: boolean; openWorld: boolean; execution_mode?: 'service_adapter' | 'host_session';
  inputSchema: Record<string, unknown>;
}
const string = { type: 'string', minLength: 1 }, nullable = { type: ['string', 'null'] }, integer = { type: 'integer', minimum: 1 };
const custom = (required: string[], properties: Record<string, Record<string, unknown>>) => C.objectSchema<unknown>(required, properties);
const routes: ToolRoute[] = [];
function add(name: string, method: WorkbenchMethod, path: string, bodySchema?: RuntimeSchema<unknown>, query = '', flags: Partial<Pick<ToolRoute, 'idempotent' | 'destructive' | 'openWorld' | 'execution_mode'>> = {}) {
  const params = [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]!);
  const extras: Record<string, unknown> = Object.fromEntries(params.map(key => [key, string]));
  const required = [...params];
  const idempotent = flags.idempotent ?? method !== 'GET';
  if (method !== 'GET' && idempotent) { extras.idempotency_key = { ...string, maxLength: 200 }; required.push('idempotency_key'); }
  const queryKeys = query ? query.split(',') : [];
  for (const key of queryKeys) extras[key] = ['limit', 'after_seq', 'window'].includes(key) ? { type: 'integer', minimum: key === 'after_seq' ? 0 : 1, ...(key === 'limit' ? { maximum: 500 } : {}) } : key === 'favorite' ? { type: 'boolean' } : string;
  const merge = (schema: Record<string, unknown>) => ({ ...schema, type: 'object', properties: { ...(schema.properties as object ?? {}), ...extras }, required: [...(schema.required as string[] ?? []), ...required], additionalProperties: false });
  const original = bodySchema?.jsonSchema ?? { type: 'object', properties: {}, required: [] };
  const inputSchema = original.oneOf ? { type: 'object', oneOf: (original.oneOf as Record<string, unknown>[]).map(merge) } : merge(original);
  routes.push({ name, method, path, bodySchema, query: queryKeys, idempotent, destructive: flags.destructive ?? false, openWorld: flags.openWorld ?? false, ...flags, inputSchema });
}
add('get_identity', 'GET', '/api/v1/identity');
add('get_speech_input_configuration','GET','/api/v1/settings/speech-input');
add('configure_speech_input','PUT','/api/v1/settings/speech-input',C.ConfigureSpeechInputSchema);
add('start_speech_input','POST','/api/v1/speech-inputs',C.StartSpeechInputSchema,'',{openWorld:true,execution_mode:'service_adapter'});
add('get_speech_input','GET','/api/v1/speech-inputs/{id}');
add('send_speech_input_chunk','POST','/api/v1/speech-inputs/{id}/chunks',C.SpeechInputChunkSchema,'',{openWorld:true});
add('send_speech_input_batch','POST','/api/v1/speech-inputs/{id}/chunk-batches',C.SpeechInputBatchSchema,'',{openWorld:true});
add('cancel_speech_input','POST','/api/v1/speech-inputs/{id}/cancel',C.CancelSpeechInputSchema);
add('adopt_speech_input','POST','/api/v1/speech-inputs/{id}/adoption',C.AdoptSpeechInputSchema);
add('link_speech_input_topic','POST','/api/v1/speech-inputs/{id}/topic-link',C.LinkSpeechInputTopicSchema);
add('transcribe_speech_recording','POST','/api/v1/speech-recordings',C.TranscribeRecordingSchema,'',{openWorld:true,execution_mode:'service_adapter'});
add('ensure_topic_viewpoints','POST','/api/v1/topics/{id}/viewpoints',C.EnsureTopicViewpointsSchema);
add('get_account_research','GET','/api/v1/accounts/{id}/research');
add('list_writing_runs','GET','/api/v1/topics/{id}/writing-runs',undefined,'summary');
add('start_writing_run','POST','/api/v1/topics/{id}/writing-runs',C.StartWritingFlowSchema,'',{execution_mode:'service_adapter'});
add('get_writing_run','GET','/api/v1/writing-runs/{id}');
add('advance_writing_run','POST','/api/v1/writing-runs/{id}/actions',C.WritingFlowActionSchema);
add('prepare_writing_export','POST','/api/v1/writing-runs/{id}/export-preparations',C.WritingExportActionSchema);
add('commit_writing_export','POST','/api/v1/writing-runs/{id}/exports',C.WritingExportActionSchema);

add('get_overview', 'GET', '/api/v1/overview', undefined, 'date,timezone');
add('get_settings', 'GET', '/api/v1/settings');
add('get_configuration','GET','/api/v1/settings/configuration');
add('save_operating_preferences','PUT','/api/v1/settings/configuration',C.SaveOperatingPreferencesSchema);
add('check_configuration','POST','/api/v1/settings/configuration/checks',C.ConfigurationCheckSchema,'',{openWorld:true});
add('save_voice_configuration','PUT','/api/v1/settings/configuration/voice',C.SaveVoiceConfigurationSchema);
add('start_executor_login','POST','/api/v1/settings/configuration/login',C.ExecutorLoginSchema,'',{openWorld:true});
add('save_owner_account_configuration','POST','/api/v1/settings/configuration/accounts',C.SaveOwnerAccountConfigurationSchema);
add('configure_api_fallback','PUT','/api/v1/settings/configuration/api-fallback',C.SaveApiFallbackSchema,'',{openWorld:true});
add('discover_owner_account','POST','/api/v1/settings/configuration/accounts/discover',C.DiscoverOwnerAccountSchema,'',{openWorld:true});
add('get_skill_library', 'GET', '/api/v1/settings/skills/library');
add('get_local_skill', 'GET', '/api/v1/settings/skills/library/{id}');
add('find_skill_samples', 'GET', '/api/v1/settings/skills/samples', undefined, 'query');
add('get_skill_settings', 'GET', '/api/v1/settings/skills');
add('put_skill_settings', 'PUT', '/api/v1/settings/skills', C.PutSkillSettingsSchema);
add('create_skill_draft', 'POST', '/api/v1/settings/skills/drafts', C.CreateSkillDraftSchema, '', { execution_mode: 'service_adapter' });
add('get_publishing_settings', 'GET', '/api/v1/settings/publishing');
add('create_publishing_connection', 'POST', '/api/v1/settings/publishing/connections', C.CreatePublishingConnectionSchema);
add('patch_publishing_connection', 'PATCH', '/api/v1/settings/publishing/connections/{id}', C.PatchPublishingConnectionSchema);
add('apply_publishing_connection', 'POST', '/api/v1/settings/publishing/connections/{id}/apply', C.ApplyPublishingConnectionSchema);
add('check_publishing_connection', 'POST', '/api/v1/settings/publishing/connections/{id}/check', C.CheckPublishingConnectionSchema);
add('set_publishing_connection_enabled', 'PUT', '/api/v1/settings/publishing/connections/{id}/enabled', C.SetPublishingConnectionEnabledSchema);
add('set_default_publishing_account', 'PUT', '/api/v1/settings/publishing/defaults', C.SetDefaultPublishingAccountSchema);
// 模型工具不接受任意存储路径。目录配置仍由主服务的独立设置入口办理。
add('patch_settings', 'PATCH', '/api/v1/settings', custom(['expected_version'], { expected_version: integer, timezone: string, default_executor: { type: 'string', enum: ['codex', 'claude'] }, api_fallback_enabled: { type: 'boolean' } }), '', { destructive: true });
add('list_topics', 'GET', '/api/v1/topics', undefined, 'cursor,status');
add('get_topic', 'GET', '/api/v1/topics/{id}');
add('get_topic_operations','GET','/api/v1/topics/{id}/operations');
add('save_topic_operations','PUT','/api/v1/topics/{id}/operations',C.SaveTopicOperationsSchema);
add('ensure_topic_operations','POST','/api/v1/topics/{id}/operations/ensure',C.EnsureTopicOperationsSchema,'',{execution_mode:'service_adapter'});
add('decide_topic_operations','POST','/api/v1/topics/{id}/operations/decision',C.DecideTopicOperationsSchema);
add('create_topic', 'POST', '/api/v1/topics', C.CreateTopicSchema);
add('approve_core', 'POST', '/api/v1/topics/{id}/core-approvals', custom(['revision_id'], { revision_id: string }));
add('create_document', 'POST', '/api/v1/documents', custom(['kind', 'initial_text'], { kind: string, initial_text: { type: 'string' }, owner_entity_id: nullable }));
add('get_document', 'GET', '/api/v1/documents/{id}');
add('save_document', 'POST', '/api/v1/documents/{id}/revisions', C.SaveRevisionSchema);
add('list_revisions', 'GET', '/api/v1/documents/{id}/revisions', undefined, 'cursor');
add('get_revision', 'GET', '/api/v1/documents/{id}/revisions/{revision_id}');
add('restore_revision', 'POST', '/api/v1/documents/{id}/restores', custom(['expected_revision_id', 'revision_id'], { expected_revision_id: nullable, revision_id: string }));
add('merge_candidate', 'POST', '/api/v1/documents/{id}/merges', custom(['expected_revision_id', 'candidate_id', 'merged_text'], { expected_revision_id: nullable, candidate_id: string, merged_text: { type: 'string' } }));
add('adopt_candidate', 'POST', '/api/v1/candidates/{id}/adoption', custom(['expected_revision_id'], { expected_revision_id: nullable }));
add('get_candidate', 'GET', '/api/v1/candidates/{id}');
add('list_candidates', 'GET', '/api/v1/documents/{id}/candidates');
add('create_variant', 'POST', '/api/v1/topics/{id}/variants', C.CreateVariantSchema);
add('align_core', 'POST', '/api/v1/variants/{id}/core-alignment', custom(['expected_revision_id', 'confirmed_core_revision_id'], { expected_revision_id: nullable, confirmed_core_revision_id: string }));
add('list_sources', 'GET', '/api/v1/sources');
add('list_source_records', 'GET', '/api/v1/source-records', undefined, 'order,source,category,date,query,cursor,favorite,curated,limit');
add('get_source_record', 'GET', '/api/v1/source-records/{id}');
add('create_source_record', 'POST', '/api/v1/source-records', C.CreateSourceRecordSchema, '', { openWorld: true });
add('mark_source_record', 'PUT', '/api/v1/source-records/{id}/marks', C.SourceMarksSchema, '', { idempotent: false });
add('start_source_sync', 'POST', '/api/v1/sources/{id}/sync', C.SourceSyncSchema, '', { openWorld: true });
add('link_topic_source', 'POST', '/api/v1/topics/{id}/sources', C.LinkTopicSourceSchema);
add('list_accounts', 'GET', '/api/v1/accounts', undefined, 'role,platform,identity_status,cursor');
add('check_account_identity', 'POST', '/api/v1/accounts/{id}/identity-check', C.AccountIdentityCheckSchema, '', { openWorld: true });
add('read_benchmark_sync', 'GET', '/api/v1/accounts/{id}/feed-sync');
add('sync_benchmark_works', 'POST', '/api/v1/accounts/{id}/feed-sync', C.BenchmarkSyncSchema, '', { openWorld: true });
add('read_benchmark_material_statistics','GET','/api/v1/accounts/material-statistics-refresh');
add('refresh_benchmark_material_statistics','POST','/api/v1/accounts/material-statistics-refresh',C.BenchmarkStatisticsRefreshSchema,'',{openWorld:true});
add('reproject_benchmark_materials','POST','/api/v1/accounts/{id}/material-reprojection',C.BenchmarkMaterialReprojectionSchema);
add('create_account', 'POST', '/api/v1/accounts', C.CreateAccountSchema, '', { openWorld: true });
add('list_works', 'GET', '/api/v1/works', undefined, 'platform,account_id,identity_status,topic_id,cursor,limit');
add('get_work', 'GET', '/api/v1/works/{id}');
add('import_work', 'POST', '/api/v1/works/import', C.ImportExistingWorkSchema, '', { openWorld: true });
add('check_work_identity', 'POST', '/api/v1/works/{id}/identity-check', C.WorkIdentityCheckSchema, '', { openWorld: true });
add('list_work_snapshots', 'GET', '/api/v1/works/{id}/snapshots', undefined, 'metric_keys,window,cursor,limit');
add('list_account_snapshots', 'GET', '/api/v1/accounts/{id}/snapshots', undefined, 'cursor,limit');
add('collect_metrics', 'POST', '/api/v1/works/{id}/collections', C.CollectionSchema, '', { openWorld: true });
add('collect_account_metrics', 'POST', '/api/v1/accounts/{id}/collections', C.AccountCollectionSchema, '', { openWorld: true });
add('list_comparisons', 'GET', '/api/v1/comparisons', undefined, 'platform,account_id,created_start,created_end,cursor,limit');
add('get_comparison', 'GET', '/api/v1/comparisons/{id}');
add('create_comparison', 'POST', '/api/v1/comparisons', { jsonSchema: C.COMPARISON_JSON_SCHEMA, parse: value => value });
add('list_jobs', 'GET', '/api/v1/jobs', undefined, 'kind,state,target_id,cursor,limit');
add('get_job', 'GET', '/api/v1/jobs/{id}');
add('get_job_events', 'GET', '/api/v1/jobs/{id}/events', undefined, 'after_seq,limit');
add('cancel_job', 'POST', '/api/v1/jobs/{id}/cancel', C.CancelJobSchema, '', { destructive: true });
add('resume_host_run', 'POST', '/api/v1/jobs/{id}/resume', custom(['expected_version', 'native_task_binding_id'], { expected_version: integer, native_task_binding_id: string }), '', { execution_mode: 'host_session' });
// 此入口与 native resume 共用服务路由，但服务必须验证原任务 mode。
add('resume_service_job', 'POST', '/api/v1/jobs/{id}/resume', custom(['expected_version'], { expected_version: integer, executor: { type: 'string', enum: ['codex', 'claude'] }, input: { type: 'object' } }), '', { execution_mode: 'service_adapter' });
add('begin_host_run', 'POST', '/api/v1/host-runs', C.BeginHostRunSchema, '', { execution_mode: 'host_session' });
add('submit_host_output', 'POST', '/api/v1/host-runs/{job_id}/outputs', C.ReceiveHostOutputSchema, '', { execution_mode: 'host_session' });
add('list_host_receipts', 'GET', '/api/v1/host-runs/{job_id}/receipts', undefined, 'state,cursor,limit');
add('get_host_receipt', 'GET', '/api/v1/host-result-receipts/{id}');
for (const [name, path, schema] of [
  ['service_modify_document', '/api/v1/documents/{id}/ai-edits', C.DocumentGenerationSchema],
  ['service_generate_variant', '/api/v1/variants/{id}/generation', C.VariantGenerationSchema],
  ['service_recommend_topics', '/api/v1/topic-recommendations', C.TopicRecommendationSchema],
  ['service_recommend_accounts', '/api/v1/account-recommendations', C.AccountRecommendationSchema],
  ['service_research_account', '/api/v1/accounts/{id}/research', C.ResearchSchema],
  ['service_generate_wiki', '/api/v1/wiki-generations', C.WikiGenerationSchema],
  ['service_generate_report', '/api/v1/retro-reports', C.ReportGenerationSchema],
] as const) add(name, 'POST', path, schema, '', { execution_mode: 'service_adapter' });
add('list_recommendations', 'GET', '/api/v1/recommendation-runs', undefined, 'kind,state,cursor');
add('get_recommendation', 'GET', '/api/v1/recommendation-runs/{id}');
add('adopt_recommendation', 'POST', '/api/v1/recommendation-candidates/{id}/adoption', C.RecommendationAdoptionSchema);
add('list_content_plans', 'GET', '/api/v1/variants/{id}/content-plans');
add('get_content_plan_revision', 'GET', '/api/v1/content-plans/{id}/revisions/{revision_id}');
add('create_content_plan', 'POST', '/api/v1/content-plans', C.CreateContentPlanSchema);
add('patch_content_plan', 'PATCH', '/api/v1/content-plans/{id}', C.PatchContentPlanSchema);
add('create_production_plan', 'POST', '/api/v1/production-plans', C.CreateProductionPlanSchema);
add('get_production_plan', 'GET', '/api/v1/production-plans/{id}');
add('get_production_plan_revision', 'GET', '/api/v1/production-plans/{id}/revisions/{revision_id}');
add('patch_production_plan', 'PATCH', '/api/v1/production-plans/{id}', C.PatchProductionPlanSchema);
add('render_content_plan', 'POST', '/api/v1/content-plans/{id}/renders', C.ContentRenderSchema);
add('render_production_plan', 'POST', '/api/v1/production-plans/{id}/renders', C.ProductionRenderSchema);
add('generate_asset', 'POST', '/api/v1/asset-generations', C.AssetGenerationSchema, '', { openWorld: true });
add('query_image_task', 'POST', '/api/v1/jobs/{id}/image-query', C.ImageQuerySchema);
add('list_assets', 'GET', '/api/v1/assets', undefined, 'topic_id');
add('get_artifact', 'GET', '/api/v1/artifacts/{id}');
add('list_schedules', 'GET', '/api/v1/schedules', undefined, 'start,end,timezone,view,cursor,limit');
add('schedule_publication', 'POST', '/api/v1/schedules', C.CreateScheduleSchema);
add('patch_schedule', 'PATCH', '/api/v1/schedules/{id}', C.PatchScheduleSchema);
add('cancel_schedule', 'POST', '/api/v1/schedules/{id}/cancel', C.PublicationExpectedVersionSchema, '', { destructive: true });
add('publish', 'POST', '/api/v1/publication-batches', C.CreatePublicationBatchSchema, '', { openWorld: true });
for (const resource of ['batches', 'intents']) {
  add('list_publication_' + resource, 'GET', '/api/v1/publication-' + resource, undefined, 'platform,account_id,state,topic_id,cursor,limit');
  add('get_publication_' + (resource === 'batches' ? 'batch' : 'intent'), 'GET', '/api/v1/publication-' + resource + '/{id}');
}
for (const operation of ['retry', 'continue']) add(operation + '_publication', 'POST', '/api/v1/publication-intents/{id}/' + operation, C.PublicationExpectedVersionSchema, '', { openWorld: true });
add('reconcile_publication', 'POST', '/api/v1/publication-intents/{id}/reconcile', C.PublicationReconcileSchema, '', { openWorld: true });
for (const [resource, singular] of [['reports', 'report'], ['actions', 'action']] as const) {
  add('list_retro_' + resource, 'GET', '/api/v1/retro-' + resource, undefined, 'platform,status,topic_id,comparison_run_id,cursor,limit');
  add('get_retro_' + singular, 'GET', '/api/v1/retro-' + resource + '/{id}');
}
add('create_retro_action', 'POST', '/api/v1/retro-reports/{id}/actions', C.CreateRetroActionSchema);
add('adopt_retro_action', 'POST', '/api/v1/retro-actions/{id}/adoptions', C.AdoptRetroActionSchema);
add('link_adoption_work', 'POST', '/api/v1/retro-adoptions/{id}/works', C.LinkAdoptionWorkSchema);
add('create_adoption_comparison', 'POST', '/api/v1/retro-adoptions/{id}/comparisons', C.CreateAdoptionComparisonSchema);
add('create_adoption_evaluation', 'POST', '/api/v1/retro-adoptions/{id}/evaluations', C.CreateAdoptionEvaluationSchema);
add('create_business_event', 'POST', '/api/v1/business-events', C.CreateBusinessEventSchema);
add('list_business_events', 'GET', '/api/v1/business-events', undefined, 'topic_id,work_id,cursor,limit');
add('put_daily_plan', 'PUT', '/api/v1/daily-plans/{local_date}', C.PutDailyPlanSchema);
add('list_knowledge', 'GET', '/api/v1/knowledge', undefined, 'kind,query,cursor');
add('search', 'GET', '/api/v1/search', undefined, 'query,types,cursor');
export const WORKBENCH_TOOL_ROUTES: readonly ToolRoute[] = routes;
export const OPEN_WORKBENCH_SCHEMA = C.OpenWorkbenchSchema;
export const CONTEXT_SCHEMA = C.objectSchema<JsonObject>([], { topic_id: string, variant_id: string, document_id: string, job_id: string, source_ids: { type: 'array', maxItems: 100, items: string } });
export const UPLOAD_ASSET_SCHEMA = C.objectSchema<JsonObject>(['filename', 'mime_type', 'base64', 'sha256', 'purpose', 'idempotency_key'], { filename: { ...string, maxLength: 200 }, mime_type: { ...string, maxLength: 200 }, base64: { type: 'string', maxLength: 5_592_408 }, sha256: { type: 'string', minLength: 64, maxLength: 64 }, topic_id: string, purpose: { type: 'string', maxLength: 2000 }, idempotency_key: { ...string, maxLength: 200 } });
export const MCP_RESULT_JSON_SCHEMA = { type: 'object', additionalProperties: false, required: ['identity', 'data', 'request_id'], properties: {
  identity: { type: 'object', additionalProperties: false, required: ['workspace_id', 'service_instance_id', 'contract_version'], properties: { workspace_id: string, service_instance_id: string, contract_version: { const: C.CONTRACT_VERSION } } },
  data: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'array', items: {} }, { type: 'null' }], description: '对应固定 HTTP 资源的原始业务投影；游标、revision、receipt、未知量 null 均保持原值。' }, request_id: { type: ['string', 'null'] },
  error: { type: 'object', additionalProperties: false, required: ['code', 'message', 'retryable', 'details', 'request_id'], properties: { code: { type: 'string', enum: Object.keys(C.ERROR_HTTP) }, message: { type: 'string' }, retryable: { type: 'boolean' }, details: { type: 'object', additionalProperties: true }, request_id: string } },
  status: { type: 'integer', enum: [...new Set(Object.values(C.ERROR_HTTP))] },
} };
const outputSchema = MCP_RESULT_JSON_SCHEMA;
export const MCP_TOOL_INVENTORY = [
  ...routes.map(route => ({ name: route.name, title: route.name, description: `Use this when the user wants to ${route.name.replaceAll('_', ' ')} in the bound workbench.${route.execution_mode ? ` Execution is fixed to ${route.execution_mode}; no fallback.` : ''}`, inputSchema: route.inputSchema, outputSchema, annotations: { readOnlyHint: route.method === 'GET', destructiveHint: route.destructive, openWorldHint: route.openWorld, idempotentHint: route.method === 'GET' || route.idempotent }, _meta: { ui: { visibility: ['model', 'app'] } } })),
  { name: 'get_context', title: '当前工作台上下文', description: 'Use this when the user wants to read the bound workspace identity, capabilities, selected fixed sources and entities.', inputSchema: CONTEXT_SCHEMA.jsonSchema, outputSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } },
  { name: 'open_workbench', title: '打开个人 IP 工作台', description: 'Use this when the user wants to open a page of the shared workbench. This does not start generation, sync or publication.', inputSchema: OPEN_WORKBENCH_SCHEMA.jsonSchema, outputSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, _meta: { ui: { resourceUri: WORKBENCH_RESOURCE_URI, visibility: ['model', 'app'] } } },
  { name: 'upload_asset', title: '上传已选择的素材文件', description: 'Use this from the app to import an explicitly selected local file through the existing assets API. It accepts bytes, never a filesystem path or remote URL.', inputSchema: UPLOAD_ASSET_SCHEMA.jsonSchema, outputSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true }, _meta: { ui: { visibility: ['app'] } } },
];
export function validateToolInput(route: ToolRoute, value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new C.ContractError('VALIDATION_ERROR', '工具需要 JSON 对象');
  const input = value as JsonObject;
  const schemas = (route.inputSchema.oneOf as Record<string, unknown>[] | undefined) ?? [route.inputSchema];
  const required = [...route.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]!);
  if (route.method !== 'GET' && route.idempotent) required.push('idempotency_key');
  if (route.inputSchema.oneOf) {
    // Preserve each branch's required fields and limits; the body parser also applies its refinements.
    const matches = schemas.filter(schema => {
      try { C.objectSchema(schema.required as string[], schema.properties as Record<string, Record<string, unknown>>).parse(input); return true; }
      catch (error) { if (error instanceof C.ContractError) return false; throw error; }
    });
    if (matches.length !== 1) throw new C.ContractError('VALIDATION_ERROR', '工具输入必须符合唯一完整分支');
  } else C.objectSchema(required, schemas[0]!.properties as Record<string, Record<string, unknown>>).parse(input);
  for (const key of required.filter(k => k !== 'idempotency_key')) if (/[\/\\\x00-\x1f]/.test(String(input[key])) || input[key] === '.' || input[key] === '..') throw new C.ContractError('VALIDATION_ERROR', '实体身份必须是单一路径段', { field: key });
  const excluded = new Set([...required, ...route.query, 'idempotency_key']);
  const body = Object.fromEntries(Object.entries(input).filter(([key]) => !excluded.has(key)));
  route.bodySchema?.parse(body);
  return input;
}
export function routeRequest(route: ToolRoute, input: JsonObject): { method: WorkbenchMethod; path: string; body?: unknown; idempotencyKey?: string } {
  validateToolInput(route, input);
  const keys = [...route.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]!);
  const path = route.path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(String(input[key])));
  const query = new URLSearchParams(); for (const key of route.query) if (input[key] !== undefined) query.set(key, String(input[key]));
  const excluded = new Set([...keys, ...route.query, 'idempotency_key']);
  return { method: route.method, path: path + (query.size ? '?' + query : ''), ...(route.method !== 'GET' ? { body: Object.fromEntries(Object.entries(input).filter(([key]) => !excluded.has(key))) } : {}), ...(typeof input.idempotency_key === 'string' ? { idempotencyKey: input.idempotency_key } : {}) };
}
export function resolveWorkbenchRoute(method: WorkbenchMethod, path: string, body: unknown, options: BridgeRequestOptions = {}): { name: string; input: JsonObject } {
  if (!path.startsWith('/api/v1/') || path.includes('#') || /[\\\x00-\x1f]/.test(path)) throw new C.ContractError('VALIDATION_ERROR', '仅允许已登记业务路由');
  if (body !== undefined && (method === 'GET' || !body || typeof body !== 'object' || Array.isArray(body))) throw new C.ContractError('VALIDATION_ERROR', '业务路由正文必须是明确的 JSON 对象');
  const url = new URL(path, 'http://workbench.invalid');
  for (const route of routes) {
    if (method !== route.method) continue;
    const keys: string[] = [];
    const pattern = '^' + route.path.split('/').map(segment => { const match = /^\{([^}]+)\}$/.exec(segment); if (match) { keys.push(match[1]!); return '([^/]+)'; } return segment; }).join('/') + '$';
    const match = new RegExp(pattern).exec(url.pathname); if (!match) continue;
    const input = { ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}) } as JsonObject;
    keys.forEach((key, i) => { input[key] = decodeURIComponent(match[i + 1]!); });
    for (const [key, value] of url.searchParams) {
      if (!route.query.includes(key) || url.searchParams.getAll(key).length !== 1) throw new C.ContractError('VALIDATION_ERROR', '业务查询字段未登记', { field: key });
      if (key === 'favorite' && !['true', 'false'].includes(value)) throw new C.ContractError('VALIDATION_ERROR', '布尔查询字段无效', { field: key });
      input[key] = ['limit', 'after_seq', 'window'].includes(key) ? Number(value) : key === 'favorite' ? value === 'true' : value;
    }
    if (options.idempotencyKey && method !== 'GET' && route.idempotent) input.idempotency_key = options.idempotencyKey;
    else if (method !== 'GET' && route.idempotent) input.idempotency_key = crypto.randomUUID();
    if (route.name === 'resume_host_run' && !('native_task_binding_id' in input)) continue;
    validateToolInput(route, input); return { name: route.name, input };
  }
  throw new C.ContractError('CAPABILITY_UNVERIFIED', '该业务操作未登记 MCP 工具', { method, path: url.pathname });
}
