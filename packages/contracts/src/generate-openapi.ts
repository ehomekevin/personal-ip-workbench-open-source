import { SKILL_RESPONSE_SCHEMAS } from './skills.ts';
import { ACCOUNT_RESEARCH_RESPONSE_SCHEMAS } from './account-research.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import * as PublicContracts from './index.ts';
import { API_RESOURCES } from './resources.ts';
import { CONTRACT_VERSION, JOB_EVENT_TYPES, JOB_STATES, EXECUTION_MODES, ENTRYPOINTS, PRESENTATIONS, ATTEMPT_STATES } from './common.ts';
import { ERROR_HTTP } from './errors.ts';
import { CreateTopicSchema, PatchSettingsSchema, SaveRevisionSchema, CancelJobSchema, ResumeJobSchema } from './validation.ts';
import { CreateSourceRecordSchema, SourceMarksSchema, LinkTopicSourceSchema, CreateAccountSchema, AccountIdentityCheckSchema,BenchmarkSyncSchema,BenchmarkMaterialReprojectionSchema,BenchmarkStatisticsRefreshSchema, SourceSyncSchema, IndexRunSchema } from './sources.ts';
import { ImportExistingWorkSchema, CollectionSchema, AccountCollectionSchema, WorkIdentityCheckSchema } from './metrics.ts';
import { PutDailyPlanSchema } from './daily-plans.ts';
import { CreateRetroActionSchema,AdoptRetroActionSchema,LinkAdoptionWorkSchema,CreateAdoptionComparisonSchema,CreateAdoptionEvaluationSchema,CreateBusinessEventSchema } from './retro.ts';
import { COMPARISON_JSON_SCHEMA } from './comparisons.ts';
import * as PublishingSettingsContracts from './publishing-settings-validation.ts';
const ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
const string = { type: 'string' }; const nullableString = { type: ['string', 'null'] }; const json = { type: 'object', additionalProperties: true };
const entityProperties = { id: string, workspace_id: string, created_at: { ...string, format: 'date-time' }, updated_at: { ...string, format: 'date-time' } };
const jobProperties = { ...entityProperties, kind: string, target_id: nullableString, executor_id: nullableString,
  entrypoint: { enum: ENTRYPOINTS }, execution_mode: { enum: EXECUTION_MODES }, current_attempt_id: nullableString,
  attempt_generation: { type: 'integer', minimum: 0 }, input_manifest: string, input_hash: string,
  state: { enum: JOB_STATES }, due_at: nullableString, retry_policy: string, presentation: { enum: PRESENTATIONS },
  cancel_requested_at: nullableString, version: { type: 'integer', minimum: 1 } };
const attemptProperties = { ...entityProperties, job_id: string, attempt_no: { type: 'integer', minimum: 1 },
  attempt_generation: { type: 'integer', minimum: 0 }, state: { enum: ATTEMPT_STATES }, lease_owner: string,
  lease_until: { ...string, format: 'date-time' }, host_connection_id: nullableString, native_task_binding_id: nullableString,
  output_deadline: nullableString, output_hash: nullableString, checkpoint: string, runtime_session_id: nullableString,
  runtime_turn_id: nullableString, error: nullableString };
// SQLite 行中的 JSON 字段仍为序列化字符串；HTTP 解码字段在投影处显式覆盖。
const registry=JSON.parse(readFileSync(new URL('../../storage/src/schema/registry.json',import.meta.url),'utf8')) as Record<string,{fields:Record<string,string>}>;
function rowSchema(table:string,overrides:Record<string,unknown>={},omit:string[]=[]){
  const properties:Record<string,unknown>={...entityProperties};
  for(const [key,kind] of Object.entries(registry[table]!.fields))properties[key]={type:kind.startsWith('n')?(kind.endsWith('?')?['number','null']:'number'):(kind.endsWith('?')?['string','null']:'string')};
  Object.assign(properties,overrides);for(const key of omit)delete properties[key];
  return {type:'object',required:Object.keys(properties),properties};
}
function pageSchema(item:string){return {type:'object',required:['items','next_cursor','has_more','last_success_at'],properties:{items:{type:'array',items:ref(item)},next_cursor:nullableString,has_more:{type:'boolean'},last_success_at:nullableString}};}
const curationSchema={type:['object','null'],additionalProperties:false,required:['rank','score','reason','selected','status','generated_at'],properties:{rank:{type:'integer',minimum:1},score:{type:['number','null'],minimum:0,maximum:100},reason:string,selected:{const:true},status:{const:'active'},generated_at:nullableString,type:{enum:['event','practice']},lane:{enum:['hot','practical','practice']},stale_after:nullableString,source_updated_at:nullableString,current:{type:'boolean'}}};
const sourceExtra={curation:curationSchema,title:string,summary:string,category:string,author_name:nullableString,reply_author_name:nullableString,quoted_author_name:nullableString,favorite:{type:'boolean'},read:{type:'boolean'},source_name:string,source_locations:{type:'array',items:ref('SourceLocationSummary')},metrics:{type:['object','null'],additionalProperties:true},metric_sources:{type:['object','null'],additionalProperties:true},preview_url:nullableString,format:nullableString,media_type:{enum:['video','image','text','unknown']},duration_ms:{type:['string','null'],pattern:'^[0-9]+$'}};
const typedSchemas:Record<string,unknown>={
 EnsureViewpointsRequest:PublicContracts.EnsureTopicViewpointsSchema.jsonSchema,
 SpeechInputSnapshot:{type:'object',additionalProperties:false,required:['id','state','provider','model','partial_text','final_text','duration_ms','estimated_afp','request_id','log_id','error','source_record_id','created_at'],properties:{id:string,state:{enum:['starting','recording','finalizing','final','cancelled','failed','unknown']},provider:{const:'ark_agent_plan'},model:{const:'doubao-seed-asr-2.0'},partial_text:string,final_text:nullableString,duration_ms:{type:'number',minimum:0,maximum:PublicContracts.SPEECH_INPUT_DERIVED_LIMITS.max_duration_ms},estimated_afp:{type:'number',minimum:0,maximum:PublicContracts.SPEECH_INPUT_DERIVED_LIMITS.max_estimated_afp},request_id:string,log_id:nullableString,error:nullableString,source_record_id:nullableString,created_at:string,accepted_sequence:{type:'integer',minimum:0,maximum:PublicContracts.SPEECH_INPUT_DERIVED_LIMITS.max_sequence},cancellation:PublicContracts.CancelSpeechInputSchema.jsonSchema,cleanup_state:{type:['string','null'],enum:[...PublicContracts.SPEECH_CLEANUP_STATES,null]},cleaned_text:nullableString,cleanup_error:nullableString,cleanup_job_id:nullableString,linked_topic_ids:{type:'array',items:string}}},
 SpeechInputConfiguration:{type:'object',additionalProperties:false,required:['enabled','credential_present','connection','setup_url','limits'],properties:{enabled:{type:'boolean'},credential_present:{type:'boolean'},connection:{enum:['unverified','verified']},setup_url:nullableString,limits:{type:'object',additionalProperties:false,required:Object.keys(PublicContracts.SPEECH_INPUT_LIMITS),properties:Object.fromEntries(Object.entries(PublicContracts.SPEECH_INPUT_LIMITS).map(([key,value])=>[key,{const:value}]))}}},
 ConfigureSpeechInputRequest:PublicContracts.ConfigureSpeechInputSchema.jsonSchema,StartSpeechInputRequest:PublicContracts.StartSpeechInputSchema.jsonSchema,SpeechInputChunkRequest:PublicContracts.SpeechInputChunkSchema.jsonSchema,SpeechInputBatchRequest:PublicContracts.SpeechInputBatchSchema.jsonSchema,CancelSpeechInputRequest:PublicContracts.CancelSpeechInputSchema.jsonSchema,AdoptSpeechInputRequest:PublicContracts.AdoptSpeechInputSchema.jsonSchema,LinkSpeechInputTopicRequest:PublicContracts.LinkSpeechInputTopicSchema.jsonSchema,TranscribeRecordingRequest:PublicContracts.TranscribeRecordingSchema.jsonSchema,EmptySpeechInputRequest:{type:'object',properties:{},additionalProperties:false},
 WritingRun:{type:'object',required:['schema_version','id','version','topic_id','document_id','input_revision_id','phase','execution_policy','rule_snapshot','stages','decisions','exports'],properties:{schema_version:{const:'writing-flow/1'},id:string,version:{type:'integer'},topic_id:string,document_id:string,input_revision_id:nullableString,phase:string,execution_policy:PublicContracts.TEXT_EXECUTION_POLICY_SCHEMA,rule_snapshot:json,stages:{type:'array',items:json},decisions:{type:'array',items:json},exports:{type:'array',items:json}},additionalProperties:true},
 WritingRunSummary:{type:'object',required:['id','version','topic_id','phase','skill','exports','current_job'],properties:{id:string,version:{type:'integer'},topic_id:string,phase:string,skill:string,exports:{type:'array',items:json},current_job:json},additionalProperties:false},
 WritingRunList:{type:'object',required:['items','targets'],properties:{items:{type:'array',items:{oneOf:[ref('WritingRun'),ref('WritingRunSummary')]}},targets:{type:'array',items:json}},additionalProperties:false},WritingExportResponse:{type:'object',required:['revision_id','relative_path','state'],properties:{revision_id:string,relative_path:string,state:{enum:['prepared','committed']}},additionalProperties:true},
 TopicOperations:PublicContracts.SaveTopicOperationsSchema.jsonSchema.properties && (PublicContracts.SaveTopicOperationsSchema.jsonSchema.properties as Record<string,unknown>).data,
 OperationsCandidateData:PublicContracts.OperationsCandidateSchema.jsonSchema,
 OperationsCandidateView:{type:'object',required:['id','status','base_operations_revision_id','data','feedback'],properties:{id:string,status:{enum:['pending','adopted','rejected','conflict']},base_operations_revision_id:nullableString,data:ref('OperationsCandidateData'),feedback:{type:'array',items:((PublicContracts.SaveTopicOperationsSchema.jsonSchema.properties as Record<string,any>).data.properties.feedback.items)}}},
 OperationsAutomation:{type:'object',required:['source_version','input_version','state','job_id','job_version','candidate','limitations','feedback_status','error'],properties:{source_version:string,input_version:string,state:{enum:['missing','queued','running','waiting_input','waiting_quota','failed','candidate','confirmed','rejected','stale','blocked']},job_id:nullableString,job_version:{type:['integer','null']},candidate:{anyOf:[ref('OperationsCandidateView'),{type:'null'}]},limitations:{type:'array',items:string},feedback_status:string,error:nullableString}},
 TopicOperationsSnapshot:{type:'object',required:['topic_id','document','data'],properties:{topic_id:string,document:{anyOf:[ref('DocumentSnapshot'),{type:'null'}]},data:ref('TopicOperations'),automation:ref('OperationsAutomation')}},
 SaveTopicOperationsRequest:PublicContracts.SaveTopicOperationsSchema.jsonSchema,
 VoiceReadinessResponse:{type:'object',required:['identity','status','message','profile','running','pending'],additionalProperties:false,properties:{identity:ref('ServiceIdentity'),status:{enum:['ready','offline','unconfigured','input_changed']},message:string,profile:{type:['object','null'],additionalProperties:false,required:['id','skill_name','skill_sha256','reference_sha256','template_sha256'],properties:{id:string,skill_name:string,skill_sha256:string,reference_sha256:string,template_sha256:string}},running:{type:['integer','null'],minimum:0},pending:{type:['integer','null'],minimum:0}}},
 HostConnectionView:{type:'object',additionalProperties:false,required:['id','host_surface','runtime_version','connection_mode','plugin_version','status'],properties:{id:string,host_surface:string,runtime_version:string,connection_mode:string,plugin_version:string,status:string}},
 HostCapabilityRecordView:{type:'object',additionalProperties:false,required:['id','host_surface','runtime_version','connection_mode','plugin_version','operation','status','limitations','verified_at','evidence_ref','version'],properties:{id:string,host_surface:string,runtime_version:string,connection_mode:string,plugin_version:string,operation:string,status:{enum:['unconfigured','unverified','supported','unsupported','degraded']},limitations:{type:'array',items:string},verified_at:nullableString,evidence_ref:nullableString,version:{type:'integer',minimum:1}}},
 HostCapabilitiesResponse:{type:'object',additionalProperties:false,required:['identity','connections','capabilities'],properties:{identity:ref('ServiceIdentity'),connections:{type:'array',items:ref('HostConnectionView')},capabilities:{type:'array',items:ref('HostCapabilityRecordView')}}},
 SourceLocationSummary:rowSchema('source_locations',{raw_response_ref:{type:['object','null'],additionalProperties:true}}),
 SourceRecordSummary:rowSchema('source_records',sourceExtra,['payload']),
 SourceRecordDetail:rowSchema('source_records',{...sourceExtra,body:nullableString,external_links:{type:'array',items:string},media:{type:'array',items:json},parser_warnings:{type:'array',items:string},creator:{type:['object','null'],additionalProperties:true},benchmark:{type:['object','null'],additionalProperties:true}},['payload']),
 SourceRecordPage:pageSchema('SourceRecordSummary'),
 Source:rowSchema('sources',{capability_status:nullableString,last_error:nullableString}),SourcesPage:pageSchema('Source'),
 CreateSourceRecordResponse:{type:'object',required:['record_id'],properties:{record_id:string}},
 AccountSummary:rowSchema('accounts',{collection_status:{enum:['not_collected','available']},work_count:{type:'integer'},profile:{type:['object','null'],additionalProperties:true}}),AccountPage:pageSchema('AccountSummary'),
 CreateAccountResponse:{type:'object',required:['account_id','identity_status','collection_status'],properties:{account_id:string,identity_status:string,collection_status:string}},
 BenchmarkSyncStatus:{type:'object',required:['last_success_at','source_id','latest_job','trigger','scope','automatic'],properties:{last_success_at:nullableString,source_id:nullableString,latest_job:{type:['object','null']},trigger:{const:'manual'},scope:{enum:['latest_page','older_page']},automatic:{const:false}},additionalProperties:true},
 EnqueuedJobResponse:{type:'object',required:['job_id'],properties:{job_id:string}},
 KnowledgeSummary:{type:'object',required:['id','kind','title','document_id','source_record_id','head_revision_id','content_status'],properties:{id:string,kind:{enum:['source','note','wiki']},title:string,document_id:nullableString,source_record_id:nullableString,head_revision_id:nullableString,content_status:string}},
 KnowledgePage:pageSchema('KnowledgeSummary'),
 SearchHit:{type:'object',required:['id','type','title','score','snippet','locator'],properties:{id:string,type:{enum:['source','note','wiki','topic','work','account']},title:string,score:{type:'number'},snippet:string,locator:json}},SearchPage:pageSchema('SearchHit'),
 WorkView:rowSchema('works',{source_work_id:string,account_role:nullableString,aliases:{type:'array',items:{type:'object',required:['alias_work_id','source_url','resolution_evidence'],properties:{alias_work_id:string,source_url:string,resolution_evidence:json}}}}),WorksPage:pageSchema('WorkView'),
 MetricDefinition:rowSchema('metric_definitions'),
 MetricView:{type:'object',required:['id','key','value','availability','reason','definition'],properties:{id:string,key:string,value:nullableString,availability:{enum:['available','not_collected','unavailable','unsupported','invalid']},reason:nullableString,definition:ref('MetricDefinition')}},
 SnapshotView:rowSchema('snapshots',{source_work_id:string,canonical_work_id:string,published_at:nullableString,identity_mapping:json,evidence_kind:string,metrics:{type:'array',items:ref('MetricView')}}),SnapshotsPage:pageSchema('SnapshotView'),
 AccountSnapshotView:rowSchema('account_snapshots',{source_id:string,collection_request_id:string,request_fingerprint:string,raw_sha256:string,metrics:{type:'array',items:ref('MetricView')},evidence_kind:string}),AccountSnapshotsPage:pageSchema('AccountSnapshotView'),
 ImportExistingWorkResponse:{type:'object',required:['work_id','identity_status','platform_work_id_candidate'],properties:{work_id:string,identity_status:string,platform_work_id_candidate:nullableString}},
 CollectionResponse:{type:'object',required:['job_id','state','target_window'],properties:{job_id:string,state:{enum:JOB_STATES},target_window:{type:['integer','null'],description:'持久化单位为秒；请求 target_window 的单位为小时。'}}},
 DailyPlanItem:rowSchema('daily_plan_items'),DailyPlan:rowSchema('daily_plans',{items:{type:'array',items:ref('DailyPlanItem')},effort_min:{type:'integer'}}),
 ComparisonRun:{type:'object',required:['id','workspace_id','created_at','query_spec','selected_snapshot_ids','selected_inputs_by_cohort','excluded_work_ids','excluded_reasons','definition_versions','result'],properties:{id:string,workspace_id:string,created_at:string,query_spec:json,selected_snapshot_ids:{type:'array',items:string},selected_inputs_by_cohort:{type:'array',items:json},excluded_work_ids:{type:'array',items:string},excluded_reasons:{type:'array',items:json},definition_versions:{type:'array',items:json},result:json}},ComparisonPage:pageSchema('ComparisonRun'),
 BusinessEvent:rowSchema('business_events'),BusinessEventsPage:pageSchema('BusinessEvent')
};
const schemas: Record<string, unknown> = {
  ServiceIdentity: { type: 'object', additionalProperties: false, required: ['workspace_id', 'service_instance_id', 'contract_version'], properties: { workspace_id: { ...string, format: 'uuid' }, service_instance_id: { ...string, format: 'uuid' }, contract_version: { const: CONTRACT_VERSION } } },
  Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message', 'retryable', 'details', 'request_id'], properties: { code: { enum: Object.keys(ERROR_HTTP) }, message: string, retryable: { type: 'boolean' }, details: json, request_id: string } } } },
  Page: { type: 'object', required: ['items', 'next_cursor', 'has_more', 'last_success_at'], properties: { items: { type: 'array', items: json }, next_cursor: nullableString, has_more: { type: 'boolean' }, last_success_at: nullableString } },
  ...typedSchemas,
  ...SKILL_RESPONSE_SCHEMAS,
  ...ACCOUNT_RESEARCH_RESPONSE_SCHEMAS,
  WorkIdentityCheckRequest:WorkIdentityCheckSchema.jsonSchema,
  CreateTopicRequest: CreateTopicSchema.jsonSchema,
  CreateSourceRecordRequest: CreateSourceRecordSchema.jsonSchema,
  SourceMarksRequest: SourceMarksSchema.jsonSchema,
  LinkTopicSourceRequest: LinkTopicSourceSchema.jsonSchema,
  AccountIdentityCheckRequest: AccountIdentityCheckSchema.jsonSchema,
  BenchmarkSyncRequest:BenchmarkSyncSchema.jsonSchema,
  BenchmarkStatisticsRefreshRequest:BenchmarkStatisticsRefreshSchema.jsonSchema,
  BenchmarkStatisticsRefreshResponse:{type:'object',additionalProperties:false,required:['refresh_id','state','matched_count','batch_count'],properties:{refresh_id:{...string,format:'uuid'},state:{enum:['queued','running','succeeded','partial','failed','unknown']},matched_count:{type:'integer',minimum:0,maximum:200},batch_count:{type:'integer',minimum:0,maximum:4}}},
  BenchmarkStatisticsRefreshStatus:{type:'object',additionalProperties:false,required:['refresh_id','state','matched_count','batch_count','completed_batches','updated_count','missing_count','stale_count','invalid_count','retained_count','remote_attempts','started_at','finished_at','error'],properties:{refresh_id:{...string,format:'uuid'},state:{enum:['queued','running','succeeded','partial','failed','unknown']},matched_count:{type:'integer',minimum:0},batch_count:{type:'integer',minimum:0,maximum:4},completed_batches:{type:'integer',minimum:0},updated_count:{type:'integer',minimum:0},missing_count:{type:'integer',minimum:0},stale_count:{type:'integer',minimum:0},invalid_count:{type:'integer',minimum:0},retained_count:{type:'integer',minimum:0},remote_attempts:{type:'integer',minimum:0,maximum:4},started_at:{...string,format:'date-time'},finished_at:nullableString,error:nullableString}},
  BenchmarkStatisticsRefreshStatusResponse:{type:'object',additionalProperties:false,required:['current'],properties:{current:{anyOf:[ref('BenchmarkStatisticsRefreshStatus'),{type:'null'}]}}},
  BenchmarkMaterialReprojectionRequest:BenchmarkMaterialReprojectionSchema.jsonSchema,
  BenchmarkMaterialReprojectionResponse:{type:'object',additionalProperties:false,required:['projection_id','projection_version','account_id','matched_count','updated_count','unchanged_count','items'],properties:{projection_id:{...string,format:'uuid'},projection_version:string,account_id:string,matched_count:{type:'integer',minimum:0},updated_count:{type:'integer',minimum:0},unchanged_count:{type:'integer',minimum:0},items:{type:'array',items:{type:'object',additionalProperties:false,required:['record_id','source_location_id','job_id','before_payload_sha256','after_payload_sha256','raw_response_ref','media_type','duration_ms','preview_url'],properties:{record_id:string,source_location_id:string,job_id:string,before_payload_sha256:{...string,pattern:'^[a-f0-9]{64}$'},after_payload_sha256:{...string,pattern:'^[a-f0-9]{64}$'},raw_response_ref:{type:'object',additionalProperties:false,required:['path','sha256','adapter_version'],properties:{path:string,sha256:{...string,pattern:'^[a-f0-9]{64}$'},adapter_version:string}},media_type:{enum:['video','image','text','unknown']},duration_ms:nullableString,preview_url:nullableString}}}}},
  AccountIdentityCheckResponse:{type:'object',required:['account_id','identity_status','platform_account_id','checked_at','limitations'],properties:{account_id:string,identity_status:{const:'confirmed'},platform_account_id:string,checked_at:{type:'string',format:'date-time'},limitations:{type:'array',items:string}},additionalProperties:false},
  CreateAccountRequest: CreateAccountSchema.jsonSchema,
  SourceSyncRequest: SourceSyncSchema.jsonSchema,
  IndexRunRequest: IndexRunSchema.jsonSchema,
  ImportExistingWorkRequest: ImportExistingWorkSchema.jsonSchema,
  CollectionRequest: CollectionSchema.jsonSchema,
  AccountCollectionRequest: AccountCollectionSchema.jsonSchema,
  CreateComparisonRequest: COMPARISON_JSON_SCHEMA,
  PutDailyPlanRequest:PutDailyPlanSchema.jsonSchema,
  CreateRetroActionRequest:CreateRetroActionSchema.jsonSchema,
  AdoptRetroActionRequest:AdoptRetroActionSchema.jsonSchema,
  LinkAdoptionWorkRequest:LinkAdoptionWorkSchema.jsonSchema,
  CreateAdoptionComparisonRequest:CreateAdoptionComparisonSchema.jsonSchema,
  CreateAdoptionEvaluationRequest:CreateAdoptionEvaluationSchema.jsonSchema,
  CreateBusinessEventRequest:CreateBusinessEventSchema.jsonSchema,
  SaveRevisionRequest: SaveRevisionSchema.jsonSchema,
  PatchSettingsRequest: PatchSettingsSchema.jsonSchema,
  CancelJobRequest: CancelJobSchema.jsonSchema,
  ResumeJobRequest: ResumeJobSchema.jsonSchema,
  JobRow: { type: 'object', additionalProperties: false, required: Object.keys(jobProperties), properties: jobProperties },
  JobAttemptRow: { type: 'object', additionalProperties: false, required: Object.keys(attemptProperties), properties: attemptProperties },
  JobsPage: { type: 'object', required: ['items', 'next_cursor', 'has_more', 'last_success_at'], properties: {
    items: { type: 'array', items: ref('JobRow') }, next_cursor: nullableString, has_more: { type: 'boolean' }, last_success_at: nullableString } },
  JobDetailResponse: { type: 'object', additionalProperties: false, required: ['job', 'attempts', 'checkpoint', 'artifacts', 'error', 'receipts'], properties: {
    job: ref('JobRow'), attempts: { type: 'array', items: ref('JobAttemptRow') }, checkpoint: { type: ['object', 'null'], additionalProperties: true },
    artifacts: { type: 'array', items: json }, error: { type: ['object', 'null'], additionalProperties: true }, receipts: { type: 'array', items: json } } },
  SettingsResponse: { type: 'object', required: ['workspace_id', 'title', 'timezone', 'mode', 'paths', 'version', 'default_executor', 'api_fallback_enabled', 'executors', 'capabilities'], properties: { workspace_id: string, title: string, timezone: string, mode: { enum: ['real', 'demo'] }, paths: { type: 'object', required: ['source_vault_root', 'managed_notes_root', 'state_root', 'media_root'], additionalProperties: false, properties: { source_vault_root: nullableString, managed_notes_root: string, state_root: string, media_root: string } }, version: { type: 'integer', minimum: 1 }, default_executor: { enum: ['codex', 'claude'] }, api_fallback_enabled: { type: 'boolean' }, executors: { type: 'array', items: json }, capabilities: { type: 'array', items: json }, max_concurrent_generations: { type: 'integer', minimum: 1, maximum: 10, readOnly: true, description: '服务配置的生成任务并发上限（只读，改动需编辑服务配置并重启）' } } },
  TopicReadState:{type:'object',required:['core_revision_id','core_version','core_confirmed','variants'],properties:{core_revision_id:nullableString,core_version:{type:'integer'},core_confirmed:{type:'boolean'},variants:{type:'array',items:{type:'object',required:['id','platform','format','document_id','head_revision_id','parent_revision_id','document_version','based_on_core_revision_id'],properties:{id:string,platform:string,format:string,document_id:string,head_revision_id:nullableString,parent_revision_id:nullableString,document_version:{type:'integer'},based_on_core_revision_id:string}}}}},
  TopicSummary:{type:'object',required:['id','title','category','audience','angle','expected_effort_min','core_document_id','status','version'],properties:{id:string,title:string,category:string,audience:string,angle:string,expected_effort_min:{type:'integer'},core_document_id:string,status:{enum:['active','paused','archived']},version:{type:'integer'},read_state:ref('TopicReadState')}},
  TopicsPage:{type:'object',required:['items','next_cursor','has_more','last_success_at'],properties:{items:{type:'array',items:ref('TopicSummary')},next_cursor:nullableString,has_more:{type:'boolean'},last_success_at:nullableString}},
  OverviewResponse: { type: 'object', required: ['local_date', 'timezone', 'updated_at', 'plan', 'items', 'topics', 'jobs', 'actions','budget_min','effort_min','recent_news'], properties: { budget_min:{type:'integer'},effort_min:{type:'integer'},recent_news:{type:'array',items:json},local_date: string, timezone: string, updated_at: string, plan: { type: ['object', 'null'] }, items: { type: 'array', items: json }, topics: { type: 'array', items: ref('TopicSummary') }, jobs: { type: 'array', items: json }, actions: { type: 'array', items: json } } },
  JobEvent: { type: 'object', required: ['job_id', 'seq', 'attempt_no', 'type', 'occurred_at', 'payload'], properties: { job_id: string, seq: { type: 'integer', minimum: 1 }, attempt_no: { type: 'integer', minimum: 1 }, type: { enum: JOB_EVENT_TYPES }, occurred_at: { ...string, format: 'date-time' }, payload: json } },
  JobEventsPage: { type: 'object', required: ['events', 'last_seq', 'has_more'], properties: { events: { type: 'array', items: ref('JobEvent') }, last_seq: { type: 'integer', minimum: 0 }, has_more: { type: 'boolean' } } },
};
for(const name of ['SourceRecordSummary','SourceRecordDetail'] as const){const schema=schemas[name] as {required:string[]};schema.required=schema.required.filter(field=>!['curation','metrics','metric_sources','preview_url','format','media_type','duration_ms','creator','benchmark'].includes(field));}
{const schema=schemas.AccountSummary as {required:string[]};schema.required=schema.required.filter(field=>field!=='profile');}
// D07-008：公共 RuntimeSchema 与 HTTP 入参采用同一字段定义。
for(const [name,value] of Object.entries(PublicContracts))if(!(name in PublishingSettingsContracts)&&name.endsWith('Schema')&&value&&typeof value==='object'&&'jsonSchema' in value)schemas[name.replace(/Schema$/,'Request')]=value.jsonSchema;
Object.assign(schemas,{
 GenerationAccepted:{type:'object',required:['job_id'],properties:{job_id:string,document_id:string,report_id:string,run_id:string},additionalProperties:false},
 HistoricalRevision:{type:'object',required:['document_id','revision_id','parent_revision_id','text','hash'],properties:{document_id:string,revision_id:string,parent_revision_id:nullableString,text:string,hash:string}},
 SanitizedPlanInput:{type:'object',required:['schema_version','plan_kind','workspace_id','plan_id','plan_revision_id','variant_id','variant_revision_id','input_hash','texts','assets','units','shots'],properties:{schema_version:{const:'plan-input.v1'},plan_kind:{enum:['content','production']},workspace_id:string,plan_id:string,plan_revision_id:string,variant_id:string,variant_revision_id:string,input_hash:string,texts:{type:'array',items:{type:'object',required:['revision_id','document_id','sha256','purpose'],properties:{revision_id:string,document_id:string,sha256:string,purpose:string},additionalProperties:false}},assets:{type:'array',items:{type:'object',required:['asset_id','sha256','mime','size_bytes','duration_ms','kind'],properties:{asset_id:string,sha256:string,mime:string,size_bytes:{type:'integer'},duration_ms:{type:['integer','null']},kind:string},additionalProperties:false}},units:{type:'array',items:json},shots:{type:'array',items:json}}},
 PlanSnapshot:{type:'object',required:['id','version','state'],properties:{id:string,version:{type:'integer'},state:{enum:['ready_to_render','rendering','preview_ready','export_ready','waiting_input','failed']},head:{anyOf:[ref('SanitizedPlanInput'),{type:'null'}]},execution:{type:'object',required:['jobs','artifacts'],properties:{jobs:{type:'array',items:json},artifacts:{type:'array',items:json}}}}},
 PublicationIntentView:rowSchema('publication_intents',{progress:{},platform:string,format:string,topic_id:string,phase:string,continuation:{type:['object','null']},retryability:json,job:ref('JobRow'),manifest:json,members:{type:'array',items:rowSchema('publication_members')},attempts:{type:'array',items:rowSchema('publication_attempts')}}),
 RecommendationRun:rowSchema('recommendation_runs',{input_manifest:json,candidates:{type:'array',items:json}}),
 ArtifactResponse:{type:'object',required:['artifact_id','sha256','manifest'],properties:{artifact_id:string,sha256:string,manifest:json}},
 HostRunView:{type:'object',required:['job_id','attempt_id','attempt_generation','version','native_task_binding_id','observer_id','observer_epoch','input_manifest','input_hash','output_schema','lease_until','output_deadline'],properties:{job_id:string,attempt_id:string,attempt_generation:{type:'integer'},version:{type:'integer'},native_task_binding_id:string,observer_id:string,observer_epoch:string,input_manifest:json,input_hash:string,output_schema:json,lease_until:string,output_deadline:nullableString}},
 HostResultReceiptView:{type:'object',required:['receipt_id','job_id','attempt_id','attempt_generation','state','input_hash','output_hash','results','quarantine_reason','files'],properties:{receipt_id:string,job_id:string,attempt_id:string,attempt_generation:{type:'integer',minimum:1},state:{enum:['pending','committed','quarantined']},input_hash:string,output_hash:string,results:json,quarantine_reason:nullableString,files:{type:'array',items:{type:'object',required:['intent_id','state','hash','error'],properties:{intent_id:string,state:string,hash:string,error:{type:['object','null'],additionalProperties:true}}}}}},
 HostResultReceiptsPage:pageSchema('HostResultReceiptView'),
});
const implementedRequests: Record<string, string> = {
 'POST /api/v1/topics/{id}/viewpoints':'EnsureViewpointsRequest','POST /api/v1/topics/{id}/writing-runs':'StartWritingFlowRequest','POST /api/v1/writing-runs/{id}/actions':'WritingFlowActionRequest','POST /api/v1/writing-runs/{id}/switch-executor':'SwitchWritingExecutorRequest','POST /api/v1/writing-runs/{id}/export-preparations':'WritingExportActionRequest','POST /api/v1/writing-runs/{id}/exports':'WritingExportActionRequest',
 'POST /api/v1/media/voice':'VoiceSampleRequest','POST /api/v1/media/voice/{id}/recover':'VoiceRecoverRequest','PUT /api/v1/settings/skills':'PutSkillSettingsRequest','POST /api/v1/settings/skills/drafts':'CreateSkillDraftRequest',
 'POST /api/v1/works/{id}/identity-check':'WorkIdentityCheckRequest',
 'POST /api/v1/settings/publishing/connections':'CreatePublishingConnectionRequest',
 'PATCH /api/v1/settings/publishing/connections/{id}':'PatchPublishingConnectionRequest',
 'POST /api/v1/settings/publishing/connections/{id}/apply':'ApplyPublishingConnectionRequest',
 'POST /api/v1/settings/publishing/connections/{id}/check':'CheckPublishingConnectionRequest',
 'PUT /api/v1/settings/publishing/connections/{id}/enabled':'SetPublishingConnectionEnabledRequest',
 'PUT /api/v1/settings/publishing/defaults':'SetDefaultPublishingAccountRequest',
 'PUT /api/v1/daily-plans/{local_date}':'PutDailyPlanRequest','POST /api/v1/retro-reports/{id}/actions':'CreateRetroActionRequest','POST /api/v1/retro-actions/{id}/adoptions':'AdoptRetroActionRequest','POST /api/v1/retro-adoptions/{id}/works':'LinkAdoptionWorkRequest','POST /api/v1/retro-adoptions/{id}/comparisons':'CreateAdoptionComparisonRequest','POST /api/v1/retro-adoptions/{id}/evaluations':'CreateAdoptionEvaluationRequest','POST /api/v1/business-events':'CreateBusinessEventRequest',
 'POST /api/v1/source-records':'CreateSourceRecordRequest', 'PUT /api/v1/source-records/{id}/marks':'SourceMarksRequest', 'POST /api/v1/topics/{id}/sources':'LinkTopicSourceRequest', 'POST /api/v1/accounts/{id}/feed-sync':'BenchmarkSyncRequest', 'POST /api/v1/accounts/{id}/identity-check':'AccountIdentityCheckRequest', 'POST /api/v1/accounts':'CreateAccountRequest', 'POST /api/v1/sources/{id}/sync':'SourceSyncRequest', 'POST /api/v1/index-runs':'IndexRunRequest', 'POST /api/v1/works/import':'ImportExistingWorkRequest', 'POST /api/v1/works/{id}/collections':'CollectionRequest', 'POST /api/v1/accounts/{id}/collections':'AccountCollectionRequest', 'POST /api/v1/comparisons':'CreateComparisonRequest', 'POST /api/v1/topics': 'CreateTopicRequest', 'POST /api/v1/documents/{id}/revisions': 'SaveRevisionRequest', 'PATCH /api/v1/settings': 'PatchSettingsRequest', 'PUT /api/v1/settings/configuration':'SaveOperatingPreferencesRequest','POST /api/v1/settings/configuration/checks':'ConfigurationCheckRequest','PUT /api/v1/settings/configuration/voice':'SaveVoiceConfigurationRequest','POST /api/v1/settings/configuration/login':'ExecutorLoginRequest','POST /api/v1/settings/configuration/accounts':'SaveOwnerAccountConfigurationRequest','POST /api/v1/settings/configuration/accounts/discover':'DiscoverOwnerAccountRequest','PUT /api/v1/settings/configuration/api-fallback':'SaveApiFallbackRequest', 'POST /api/v1/jobs/{id}/cancel': 'CancelJobRequest', 'POST /api/v1/jobs/{id}/resume': 'ResumeJobRequest' };
Object.assign(implementedRequests,{
 'POST /api/v1/accounts/material-statistics-refresh':'BenchmarkStatisticsRefreshRequest',
 'PUT /api/v1/settings/speech-input':'ConfigureSpeechInputRequest','POST /api/v1/speech-inputs':'StartSpeechInputRequest','POST /api/v1/speech-inputs/{id}/chunks':'SpeechInputChunkRequest','POST /api/v1/speech-inputs/{id}/cleanup':'RecleanupSpeechInputRequest','POST /api/v1/speech-inputs/{id}/chunk-batches':'SpeechInputBatchRequest','POST /api/v1/speech-inputs/{id}/cancel':'CancelSpeechInputRequest','POST /api/v1/speech-inputs/{id}/adoption':'AdoptSpeechInputRequest','POST /api/v1/speech-inputs/{id}/topic-link':'LinkSpeechInputTopicRequest','POST /api/v1/speech-recordings':'TranscribeRecordingRequest',
 'POST /api/v1/accounts/{id}/material-reprojection':'BenchmarkMaterialReprojectionRequest',
 'PUT /api/v1/topics/{id}/operations':'SaveTopicOperationsRequest',
 'POST /api/v1/topics/{id}/operations/ensure':'EnsureTopicOperationsRequest','POST /api/v1/topics/{id}/operations/decision':'DecideTopicOperationsRequest',
 'POST /api/v1/documents/{id}/ai-edits':'DocumentGenerationRequest','POST /api/v1/variants/{id}/generation':'VariantGenerationRequest','POST /api/v1/topics/{id}/variants':'CreateVariantRequest','POST /api/v1/wiki-generations':'WikiGenerationRequest','POST /api/v1/retro-reports':'ReportGenerationRequest','POST /api/v1/accounts/{id}/research':'ResearchRequest','POST /api/v1/topic-recommendations':'TopicRecommendationRequest','POST /api/v1/account-recommendations':'AccountRecommendationRequest','POST /api/v1/recommendation-candidates/{id}/adoption':'RecommendationAdoptionRequest',
 'POST /api/v1/content-plans':'CreateContentPlanRequest','PATCH /api/v1/content-plans/{id}':'PatchContentPlanRequest','POST /api/v1/production-plans':'CreateProductionPlanRequest','PATCH /api/v1/production-plans/{id}':'PatchProductionPlanRequest','POST /api/v1/content-plans/{id}/renders':'ContentRenderRequest','POST /api/v1/production-plans/{id}/renders':'ProductionRenderRequest','POST /api/v1/asset-generations':'AssetGenerationRequest',
 'POST /api/v1/host-task-observers':'RegisterObserverRequest','POST /api/v1/host-task-observers/{id}/bindings':'BindNativeTaskRequest','POST /api/v1/native-task-bindings/{id}/observations':'ObserveNativeTaskRequest','POST /api/v1/native-task-bindings/{id}/reattach':'ReattachNativeTaskRequest','POST /api/v1/host-runs':'BeginHostRunRequest','POST /api/v1/host-runs/{job_id}/renewals':'RenewHostRunRequest','POST /api/v1/host-runs/{job_id}/outputs':'ReceiveHostOutputRequest',
 'POST /api/v1/publication-batches':'CreatePublicationBatchRequest','POST /api/v1/schedules':'CreateScheduleRequest','PATCH /api/v1/schedules/{id}':'PatchScheduleRequest','POST /api/v1/schedules/{id}/cancel':'PublicationExpectedVersionRequest','POST /api/v1/publication-intents/{id}/retry':'PublicationExpectedVersionRequest','POST /api/v1/publication-intents/{id}/continue':'PublicationExpectedVersionRequest','POST /api/v1/publication-intents/{id}/reconcile':'PublicationReconcileRequest'
});
const responseSchemas: Record<string, string> = {
 'GET /api/v1/topics':'TopicsPage',
 'GET /api/v1/accounts/{id}/research':'AccountResearchView',
 'POST /api/v1/topics/{id}/viewpoints':'DocumentSnapshot','GET /api/v1/topics/{id}/writing-runs':'WritingRunList','POST /api/v1/topics/{id}/writing-runs':'WritingRun','GET /api/v1/writing-runs/{id}':'WritingRun','POST /api/v1/writing-runs/{id}/actions':'WritingRun','POST /api/v1/writing-runs/{id}/switch-executor':'WritingRun','POST /api/v1/writing-runs/{id}/export-preparations':'WritingExportResponse','POST /api/v1/writing-runs/{id}/exports':'WritingExportResponse', 'GET /api/v1/media/voice':'VoiceReadinessResponse','POST /api/v1/media/voice':'EnqueuedJobResponse','POST /api/v1/media/voice/{id}/recover':'EnqueuedJobResponse', 'GET /api/v1/settings/skills/library':'SkillLibraryResponse',
 'GET /api/v1/settings/skills/library/{id}':'LocalSkillDetail',
 'GET /api/v1/settings/skills/samples':'SkillSamplePage',
 'GET /api/v1/settings/skills':'SkillSettingsResponse','PUT /api/v1/settings/skills':'SkillSettingsResponse','POST /api/v1/settings/skills/drafts':'GenerationAccepted', 'GET /api/v1/identity': 'ServiceIdentity', 'GET /api/v1/settings': 'SettingsResponse', 'PATCH /api/v1/settings': 'SettingsResponse', 'GET /api/v1/overview': 'OverviewResponse', 'GET /api/v1/jobs/{id}/events': 'JobEventsPage',
 'GET /api/v1/settings/publishing':'PublishingSettingsResponse',
 'POST /api/v1/settings/publishing/connections':'PublishingConnectionResponse',
 'PATCH /api/v1/settings/publishing/connections/{id}':'PublishingConnectionResponse',
 'POST /api/v1/settings/publishing/connections/{id}/apply':'PublishingConnectionResponse',
 'POST /api/v1/settings/publishing/connections/{id}/check':'PublishingCheckResponse',
 'PUT /api/v1/settings/publishing/connections/{id}/enabled':'PublishingConnectionResponse',
 'PUT /api/v1/settings/publishing/defaults':'PublishingSettingsResponse',
  'GET /api/v1/host-capabilities':'HostCapabilitiesResponse',
  'GET /api/v1/jobs': 'JobsPage', 'GET /api/v1/jobs/{id}': 'JobDetailResponse', 'POST /api/v1/jobs/{id}/cancel': 'JobRow', 'POST /api/v1/jobs/{id}/resume': 'JobRow' };
Object.assign(responseSchemas,{
 'POST /api/v1/accounts/material-statistics-refresh':'BenchmarkStatisticsRefreshResponse','GET /api/v1/accounts/material-statistics-refresh':'BenchmarkStatisticsRefreshStatusResponse',
 'GET /api/v1/settings/speech-input':'SpeechInputConfiguration','PUT /api/v1/settings/speech-input':'SpeechInputConfiguration','POST /api/v1/speech-inputs':'SpeechInputSnapshot','GET /api/v1/speech-inputs/{id}':'SpeechInputSnapshot','POST /api/v1/speech-inputs/{id}/chunks':'SpeechInputSnapshot','POST /api/v1/speech-inputs/{id}/cleanup':'SpeechInputSnapshot','POST /api/v1/speech-inputs/{id}/chunk-batches':'SpeechInputSnapshot','POST /api/v1/speech-inputs/{id}/cancel':'SpeechInputSnapshot','POST /api/v1/speech-inputs/{id}/adoption':'SpeechInputSnapshot','POST /api/v1/speech-inputs/{id}/topic-link':'SpeechInputSnapshot','POST /api/v1/speech-recordings':'SpeechInputSnapshot',
 'POST /api/v1/accounts/{id}/material-reprojection':'BenchmarkMaterialReprojectionResponse',
 'GET /api/v1/topics/{id}/operations':'TopicOperationsSnapshot','PUT /api/v1/topics/{id}/operations':'TopicOperationsSnapshot',
 'POST /api/v1/topics/{id}/operations/ensure':'TopicOperationsSnapshot','POST /api/v1/topics/{id}/operations/decision':'TopicOperationsSnapshot',
 'GET /api/v1/sources':'SourcesPage','GET /api/v1/source-records':'SourceRecordPage','GET /api/v1/source-records/{id}':'SourceRecordDetail','POST /api/v1/source-records':'CreateSourceRecordResponse','PUT /api/v1/source-records/{id}/marks':'SourceRecordDetail','POST /api/v1/sources/{id}/sync':'EnqueuedJobResponse',
 'POST /api/v1/accounts/{id}/feed-sync':'EnqueuedJobResponse','GET /api/v1/accounts/{id}/feed-sync':'BenchmarkSyncStatus','GET /api/v1/accounts':'AccountPage','POST /api/v1/accounts/{id}/identity-check':'AccountIdentityCheckResponse', 'POST /api/v1/accounts':'CreateAccountResponse','GET /api/v1/knowledge':'KnowledgePage','GET /api/v1/search':'SearchPage','POST /api/v1/index-runs':'EnqueuedJobResponse',
 'POST /api/v1/works/import':'ImportExistingWorkResponse','GET /api/v1/works':'WorksPage','GET /api/v1/works/{id}':'WorkView','GET /api/v1/works/{id}/snapshots':'SnapshotsPage','GET /api/v1/accounts/{id}/snapshots':'AccountSnapshotsPage','POST /api/v1/works/{id}/collections':'CollectionResponse','POST /api/v1/accounts/{id}/collections':'CollectionResponse',
 'GET /api/v1/comparisons':'ComparisonPage','GET /api/v1/comparisons/{id}':'ComparisonRun','POST /api/v1/comparisons':'ComparisonRun','POST /api/v1/retro-adoptions/{id}/comparisons':'ComparisonRun',
 'PUT /api/v1/daily-plans/{local_date}':'DailyPlan','POST /api/v1/business-events':'BusinessEvent','GET /api/v1/business-events':'BusinessEventsPage'
});
Object.assign(responseSchemas,{'GET /api/v1/documents/{id}/revisions/{revision_id}':'HistoricalRevision','GET /api/v1/recommendation-runs/{id}':'RecommendationRun','GET /api/v1/content-plans/{id}/revisions/{revision_id}':'SanitizedPlanInput','GET /api/v1/production-plans/{id}':'PlanSnapshot','GET /api/v1/production-plans/{id}/revisions/{revision_id}':'SanitizedPlanInput','GET /api/v1/artifacts/{id}':'ArtifactResponse','GET /api/v1/publication-intents/{id}':'PublicationIntentView','POST /api/v1/host-runs':'HostRunView','POST /api/v1/host-runs/{job_id}/renewals':'HostRunView'});
Object.assign(responseSchemas,{'POST /api/v1/host-runs/{job_id}/outputs':'HostResultReceiptView','GET /api/v1/host-runs/{job_id}/receipts':'HostResultReceiptsPage','GET /api/v1/host-result-receipts/{id}':'HostResultReceiptView'});
for(const key of Object.keys(implementedRequests))if(/RecommendationRequest|GenerationRequest|ResearchRequest/.test(implementedRequests[key]!))responseSchemas[key]='GenerationAccepted';
const created201=new Set(['POST /api/v1/speech-inputs','POST /api/v1/topics','POST /api/v1/source-records','POST /api/v1/accounts','POST /api/v1/works/import','POST /api/v1/comparisons','POST /api/v1/retro-reports/{id}/actions','POST /api/v1/retro-actions/{id}/adoptions','POST /api/v1/retro-adoptions/{id}/works','POST /api/v1/retro-adoptions/{id}/comparisons','POST /api/v1/retro-adoptions/{id}/evaluations','POST /api/v1/business-events']);
const queued202=new Set(['POST /api/v1/accounts/material-statistics-refresh','POST /api/v1/speech-recordings','POST /api/v1/topics/{id}/writing-runs','POST /api/v1/accounts/{id}/feed-sync','POST /api/v1/sources/{id}/sync','POST /api/v1/index-runs','POST /api/v1/works/{id}/collections','POST /api/v1/accounts/{id}/collections']);
for(const resource of API_RESOURCES){const key=resource.method+' '+resource.path;if('implementation_owner' in resource&&['WP-16','WP-17','WP-18','WP-19','WP-20'].includes(resource.implementation_owner)&&resource.method==='POST'){if(/generation|ai-edits|recommendations$|research$|renders$|publication-batches$|retry$|continue$|reconcile$|retro-reports$/.test(resource.path))queued202.add(key);else if(!resource.path.endsWith('/renewals')&&!resource.path.endsWith('/reattach')&&!resource.path.endsWith('/cancel'))created201.add(key);}}
const queryFields:Record<string,string[]>={
 'GET /api/v1/topics/{id}/writing-runs':['summary'],
 'GET /api/v1/host-capabilities':['host_surface','connection_mode','runtime_version','plugin_version'],
 'GET /api/v1/overview':['date','timezone'],
 'GET /api/v1/source-records':['curated','source','category','date','query','favorite','order','cursor'],
 'GET /api/v1/accounts':['role','platform','identity_status','cursor'],
 'GET /api/v1/knowledge':['kind','query','cursor'],'GET /api/v1/search':['query','types','cursor'],
 'GET /api/v1/works':['platform','account_id','identity_status','topic_id','cursor','limit'],
 'GET /api/v1/works/{id}/snapshots':['metric_keys','window','cursor','limit'],'GET /api/v1/accounts/{id}/snapshots':['cursor','limit'],
 'GET /api/v1/comparisons':['platform','account_id','created_start','created_end','cursor','limit'],
 'GET /api/v1/retro-reports':['platform','status','topic_id','comparison_run_id','cursor','limit'],'GET /api/v1/retro-actions':['platform','status','topic_id','comparison_run_id','cursor','limit'],
 'GET /api/v1/business-events':['topic_id','work_id','cursor','limit']
};
const hostConnectionOperations=new Set(['POST /api/v1/host-runs','POST /api/v1/host-runs/{job_id}/outputs','GET /api/v1/host-runs/{job_id}/receipts','GET /api/v1/host-result-receipts/{id}']);
const hostObserverOperations=new Set(['POST /api/v1/host-task-observers','POST /api/v1/host-task-observers/{id}/bindings','POST /api/v1/native-task-bindings/{id}/observations','POST /api/v1/native-task-bindings/{id}/reattach','POST /api/v1/host-runs/{job_id}/renewals']);
schemas.StudioBriefRequest=PublicContracts.StudioBriefSchema.jsonSchema;
implementedRequests['POST /api/v1/image-studio/brief']='StudioBriefRequest';
schemas.StudioGenerationRequest=PublicContracts.StudioGenerationSchema.jsonSchema;
implementedRequests['POST /api/v1/image-studio/generations']='StudioGenerationRequest';
schemas.StudioAdoptRequest=PublicContracts.StudioAdoptSchema.jsonSchema;
implementedRequests['POST /api/v1/image-studio/slots/{id}/adopt']='StudioAdoptRequest';
schemas.StudioConfirmRequest=PublicContracts.StudioConfirmSchema.jsonSchema;
implementedRequests['POST /api/v1/image-studio/confirm-final']='StudioConfirmRequest';
schemas.StudioWebImportRequest=PublicContracts.StudioWebImportSchema.jsonSchema;
implementedRequests['POST /api/v1/image-studio/web-imports']='StudioWebImportRequest';
Object.assign(schemas,PublicContracts.STUDIO_RESPONSE_SCHEMAS);
Object.assign(responseSchemas,{'GET /api/v1/image-studio':'StudioSnapshot','POST /api/v1/image-studio/brief':'StudioBrief','POST /api/v1/image-studio/generations':'StudioGenerationAccepted','POST /api/v1/image-studio/slots/{id}/adopt':'StudioSnapshot','POST /api/v1/image-studio/confirm-final':'StudioSnapshot','GET /api/v1/topics/{id}/web-image-candidates':'StudioWebImageCandidates','POST /api/v1/image-studio/web-imports':'StudioWebImportResult'});
queryFields['GET /api/v1/image-studio']=['topic_id'];
queryFields['GET /api/v1/topics/{id}/web-image-candidates']=['refresh'];
queued202.add('POST /api/v1/image-studio/generations');
created201.add('POST /api/v1/image-studio/web-imports');
schemas.ImagePlanRunRequest=PublicContracts.ImagePlanRunSchema.jsonSchema;
implementedRequests['POST /api/v1/image-studio/plan/runs']='ImagePlanRunRequest';
schemas.ImagePlanItemUpdateRequest=PublicContracts.ImagePlanItemUpdateSchema.jsonSchema;
implementedRequests['POST /api/v1/image-studio/plan/items/{id}']='ImagePlanItemUpdateRequest';
schemas.ImagePlanConfirmRequest=PublicContracts.ImagePlanConfirmSchema.jsonSchema;
implementedRequests['POST /api/v1/image-studio/plan/confirm']='ImagePlanConfirmRequest';
Object.assign(schemas,PublicContracts.IMAGE_PLAN_RESPONSE_SCHEMAS);
Object.assign(responseSchemas,{'GET /api/v1/image-studio/plan':'ImagePlanSnapshot','POST /api/v1/image-studio/plan/runs':'ImagePlanSnapshot','POST /api/v1/image-studio/plan/items/{id}':'ImagePlanSnapshot','POST /api/v1/image-studio/plan/confirm':'ImagePlanSnapshot'});
queryFields['GET /api/v1/image-studio/plan']=['topic_id'];
schemas.ImagePlanItemCreateRequest=PublicContracts.ImagePlanItemCreateSchema.jsonSchema;
implementedRequests['POST /api/v1/image-studio/plan/items']='ImagePlanItemCreateRequest';
schemas.StudioAssetVersionRequest=PublicContracts.StudioAssetVersionSchema.jsonSchema;
implementedRequests['POST /api/v1/image-studio/asset-versions']='StudioAssetVersionRequest';
Object.assign(responseSchemas,{'POST /api/v1/image-studio/plan/items':'ImagePlanSnapshot','POST /api/v1/image-studio/asset-versions':'StudioAssetVersionResult'});
created201.add('POST /api/v1/image-studio/plan/items');created201.add('POST /api/v1/image-studio/asset-versions');
schemas.ArticleLayoutOpenRequest=PublicContracts.ArticleLayoutOpenSchema.jsonSchema;implementedRequests['POST /api/v1/article-layout']='ArticleLayoutOpenRequest';
schemas.ArticleLayoutSaveRequest=PublicContracts.ArticleLayoutSaveSchema.jsonSchema;implementedRequests['POST /api/v1/article-layout/saves']='ArticleLayoutSaveRequest';
schemas.ArticleLayoutImageSyncRequest=PublicContracts.ArticleLayoutImageSyncSchema.jsonSchema;implementedRequests['POST /api/v1/article-layout/image-syncs']='ArticleLayoutImageSyncRequest';
schemas.ArticleLayoutConfirmRequest=PublicContracts.ArticleLayoutConfirmSchema.jsonSchema;implementedRequests['POST /api/v1/article-layout/confirmations']='ArticleLayoutConfirmRequest';
Object.assign(schemas,PublicContracts.ARTICLE_LAYOUT_RESPONSE_SCHEMAS);
Object.assign(responseSchemas,{'GET /api/v1/article-layout':'ArticleLayoutView','POST /api/v1/article-layout':'ArticleLayoutView','POST /api/v1/article-layout/saves':'ArticleLayoutSaveResult','POST /api/v1/article-layout/image-syncs':'ArticleLayoutView','POST /api/v1/article-layout/confirmations':'ArticleLayoutView'});
queryFields['GET /api/v1/article-layout']=['topic_id'];
schemas.ArticleLayoutVisualRenderRequest=PublicContracts.ArticleLayoutVisualRenderSchema.jsonSchema;implementedRequests['POST /api/v1/article-layout/visual-renders']='ArticleLayoutVisualRenderRequest';
schemas.ArticleLayoutVisualCheckRequest=PublicContracts.ArticleLayoutVisualCheckSchema.jsonSchema;implementedRequests['POST /api/v1/article-layout/visual-checks']='ArticleLayoutVisualCheckRequest';
schemas.ArticleLayoutVisualQueryRequest=PublicContracts.ArticleLayoutVisualQuerySchema.jsonSchema;
implementedRequests['POST /api/v1/article-layout/visual-queries']='ArticleLayoutVisualQueryRequest';implementedRequests['POST /api/v1/article-layout/visual-cancellations']='ArticleLayoutVisualQueryRequest';
Object.assign(responseSchemas,{'POST /api/v1/article-layout/visual-renders':'ArticleLayoutVisualRenderView','POST /api/v1/article-layout/visual-checks':'ArticleLayoutVisualJobView','POST /api/v1/article-layout/visual-queries':'ArticleLayoutVisualJobView','POST /api/v1/article-layout/visual-cancellations':'ArticleLayoutVisualJobView','GET /api/v1/article-layout/visual-status':'ArticleLayoutVisualStatus'});
queryFields['GET /api/v1/article-layout/visual-status']=['topic_id'];
schemas.SaveImageProviderSettingsRequest=PublicContracts.SaveImageProviderSettingsSchema.jsonSchema;
schemas.ImageGenerationRequest=PublicContracts.ImageGenerationSchema.jsonSchema;
schemas.ImageQueryRequest=PublicContracts.ImageQuerySchema.jsonSchema;
schemas.ImageProviderSettingsResponse={type:'object',additionalProperties:false,required:['version','default_provider','channels'],properties:{version:{type:'integer',minimum:1},default_provider:{enum:['agy','codex']},channels:{type:'array',items:{type:'object',required:['provider','label','enabled','configured','identity','connection','permission','model','operations','last_job_id','last_asset_id','limitations'],properties:{provider:{enum:['agy','codex']},label:string,enabled:{type:'boolean'},configured:{type:'boolean'},identity:string,connection:string,permission:string,model:nullableString,operations:{type:'object',required:['generation','reference_edit','mask','writing'],additionalProperties:false,properties:{generation:string,reference_edit:string,mask:string,writing:string}},last_job_id:nullableString,last_asset_id:nullableString,limitations:{type:'array',items:string},verification:{type:'object',required:['state','reason','message','checked_at'],additionalProperties:false,properties:{state:{enum:['not_run','passed','failed','inconclusive']},reason:{enum:['quota','login','connection','unconfigured',null]},message:nullableString,checked_at:nullableString}},executor:{type:['object','null'],required:['status','auth_state'],additionalProperties:false,properties:{status:string,auth_state:string}},budget:{type:'object',required:['used','limit','remaining'],additionalProperties:false,properties:{used:{type:'integer',minimum:0},limit:{type:['integer','null'],minimum:0},remaining:{type:['integer','null'],minimum:0}}}}}}}};
implementedRequests['PUT /api/v1/settings/image-providers']='SaveImageProviderSettingsRequest';
implementedRequests['POST /api/v1/jobs/{id}/image-query']='ImageQueryRequest';
responseSchemas['GET /api/v1/settings/image-providers']='ImageProviderSettingsResponse';
responseSchemas['PUT /api/v1/settings/image-providers']='ImageProviderSettingsResponse';
responseSchemas['POST /api/v1/settings/image-providers/{id}/verify']='ImageProviderSettingsResponse';
responseSchemas['POST /api/v1/jobs/{id}/image-query']='EnqueuedJobResponse';
queued202.add('POST /api/v1/jobs/{id}/image-query');
const securitySchemes={HostConnectionCredential:{type:'apiKey',in:'header',name:'X-Host-Connection-Credential',description:'由受信宿主连接持有；不能代替observer凭据。'},HostObserverBearer:{type:'http',scheme:'bearer',description:'由受信原生任务观察程序持有；只能执行observer角色操作。'}};
const paths: Record<string, Record<string, unknown>> = {};
// 新合同集中追加，保留既有 schemas 的顺序及完整语义。
for (const [name, value] of Object.entries(PublishingSettingsContracts)) if (name.endsWith('Schema') && value && typeof value === 'object' && 'jsonSchema' in value)
  schemas[name.replace(/Schema$/, 'Request')] = value.jsonSchema;
Object.assign(schemas, PublishingSettingsContracts.PUBLISHING_SETTINGS_RESPONSE_SCHEMAS);
for (const resource of API_RESOURCES) {
  const key = resource.method + ' ' + resource.path;
  const parameters: Record<string, unknown>[] = [...resource.path.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1], in: 'path', required: true, schema: string }));
  if (resource.path !== '/api/v1/identity') parameters.push({ name: 'X-Workspace-Id', in: 'header', required: true, schema: { ...string, format: 'uuid' } }, { name: 'X-Service-Instance-Id', in: 'header', required: resource.method !== 'GET', schema: { ...string, format: 'uuid' } });
  if (resource.method !== 'GET') parameters.push({ name: 'Idempotency-Key', in: 'header', required: 'idempotent' in resource && resource.idempotent === true, description: '已登记接口的必填要求与运行时 idempotent 标记一致；reserved 接口随模块契约补齐。整个规范请求 hash 与输出 hash 分开。', schema: { ...string, minLength: 1, maxLength: 200 } });
  if (resource.path.startsWith('/api/v1/host-runs') || resource.path.startsWith('/api/v1/host-result-receipts') || key === 'POST /api/v1/jobs/{id}/resume') {
    for (const name of ['X-Host-Surface','X-Host-Runtime-Version','X-Host-Connection-Mode','X-Host-Plugin-Version']) parameters.push({ name, in: 'header', required: false, schema: { ...string, minLength: 1, maxLength: 200 }, description: 'MCP 连接描述四项成组传递；提供任一项就必须完整匹配受信凭据实际所属连接。既有 WP17 直连程序可省略整组。' });
  }
  for(const name of queryFields[key]??[])parameters.push({name,in:'query',required:['GET /api/v1/image-studio','GET /api/v1/image-studio/plan','GET /api/v1/article-layout','GET /api/v1/article-layout/visual-status'].includes(key)&&name==='topic_id',schema:name==='limit'||name==='window'?{type:'integer'}:['favorite','curated'].includes(name)?{type:'boolean'}:name==='order'?{enum:['captured_desc','published_desc']}:string});
  const success=created201.has(key)?'201':queued202.has(key)?'202':'200';
  const responses: Record<string, unknown> = { [success]: { description: '同步结果；业务终态以已提交实体为准。', content: { 'application/json': { schema: responseSchemas[key] ? ref(responseSchemas[key]!) : {} } } } };
  if(key==='POST /api/v1/production-plans')responses['200']={description:'topic_preparation 已存在时返回固定准备计划；variant 创建为201。',content:{'application/json':{schema:ref('PlanSnapshot')}}};
  if(key==='POST /api/v1/host-runs/{job_id}/outputs'){delete responses['201'];responses['200']={description:'统一输出提交收据',content:{'application/json':{schema:ref('HostResultReceiptView')}}};}
  for (const status of new Set(Object.values(ERROR_HTTP))) responses[String(status)] = { description: '统一契约错误。AUTH/QUOTA 的真实 provider HTTP 映射由对应适配器补齐。', content: { 'application/json': { schema: ref('Error') } } };
  const operation: Record<string, unknown> = { operationId: resource.method.toLowerCase() + '_' + resource.path.replace(/[^a-zA-Z0-9]+/g, '_'), parameters, responses, 'x-contract-source': resource.source, 'x-resource-status': resource.status, 'x-module-owner': resource.implementation_owner, 'x-response-schema-status': responseSchemas[key]?'dto_exported':'module_D07_required', 'x-request-schema-status': implementedRequests[key] ? 'runtime_schema_exported' : resource.method === 'GET' ? 'read_boundary' : 'module_D07_required' };
  if(hostConnectionOperations.has(key)){operation.security=[{HostConnectionCredential:[]}];operation['x-host-auth-role']='connection';}
  if(hostObserverOperations.has(key)){operation.security=[{HostObserverBearer:[]}];operation['x-host-auth-role']='observer';}
  if(key==='POST /api/v1/jobs/{id}/resume'){parameters.push({name:'X-Host-Connection-Credential',in:'header',required:false,schema:{type:'string',minLength:1},description:'仅恢复host_session任务时必填；服务执行器恢复不使用宿主凭据。'});operation['x-host-auth-role']='connection_when_host_session';}
  if (implementedRequests[key]) operation.requestBody = { required: true, content: { 'application/json': { schema: ref(implementedRequests[key]!) } } };
  (paths[resource.path] ??= {})[resource.method.toLowerCase()] = operation;
}
const download=paths['/api/v1/artifacts/{id}/files/{file_ref}']?.get as Record<string,unknown>|undefined;if(download)download.responses={...download.responses as Record<string,unknown>,'200':{description:'受控文件流；仅workspace已提交成品中的不透明file_ref可下载。',content:{'application/octet-stream':{schema:{type:'string',format:'binary'}}}}};
const document = { openapi: '3.1.0', info: { title: '个人 IP 工作台公共契约', version: CONTRACT_VERSION, description: '资源枚举与已交付内部 schemas。reserved / module_D07_required 不是已实现能力；完整字段映射随领域 D07 串行补齐。' }, servers: [{ url: 'http://127.0.0.1:4318' }], paths, components: { schemas, securitySchemes } };
writeFileSync(new URL('../openapi.json', import.meta.url), JSON.stringify(document, null, 2) + '\n');
