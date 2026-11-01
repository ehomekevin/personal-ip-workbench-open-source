import type { EntityId, ExpectedRevision, ExpectedVersion, ContentFormat, Platform, JsonObject, Sha256, InputHash, WorkbenchPage } from './common.ts';
import type { JobsRow, JobAttemptsRow } from './entities.ts';
export interface WorkspacePaths { source_vault_root: string | null; managed_notes_root: string; state_root: string; media_root: string }
export interface WorkspaceSettings { workspace_id: EntityId; title: string; timezone: string; mode: 'real' | 'demo'; paths: WorkspacePaths; version: number; default_executor: 'codex' | 'claude'; api_fallback_enabled: boolean }
export interface ExecutorHealth { executor_id: string; status: 'unconfigured' | 'unverified' | 'supported' | 'unsupported' | 'degraded'; runtime_version: string | null; auth_state: string; billing_route: string | null; limitations: string[] }
// 用户勾选几个就提交几个；服务只按此配置上限同时执行，其余排队。调度、领取与执行器槽位三处共用。
export const DEFAULT_CONCURRENT_GENERATIONS = 5, MAX_CONCURRENT_GENERATIONS = 10;
export function maxConcurrentGenerations(config: { max_concurrent_generations?: number } | undefined): number { return config?.max_concurrent_generations ?? DEFAULT_CONCURRENT_GENERATIONS; }
// 公众号配图真实生图提交按渠道计数；默认各 2 次，服务配置可在 0–20 内覆盖，超出需人工放开；配 null 表示不限次数（只计数不拦截）。
export const DEFAULT_IMAGE_GENERATION_LIMIT = 2, MAX_IMAGE_GENERATION_LIMIT = 20;
export type ImageGenerationLimits = { codex?: number | null; agy?: number | null };
export function imageGenerationLimit(config: { image_generation_limits?: ImageGenerationLimits } | undefined, provider: 'codex' | 'agy'): number | null { const limit = config?.image_generation_limits?.[provider]; return limit === undefined ? DEFAULT_IMAGE_GENERATION_LIMIT : limit; }
export interface SettingsResponse extends WorkspaceSettings { executors: ExecutorHealth[]; capabilities: JsonObject[]; max_concurrent_generations?: number }
export interface ServiceConfiguration { workspace_id: EntityId; service_instance_id: EntityId; title: string; mode: 'real' | 'demo'; timezone: string; paths: WorkspacePaths; listen: { host: '127.0.0.1'; port: number }; default_executor?: 'codex' | 'claude'; api_fallback_enabled?: boolean; max_concurrent_generations?: number; image_generation_limits?: ImageGenerationLimits; web_fetch?: WebFetchConfiguration }
/** 网络找图抓取：代理 fake-IP 环境下的 DoH 二次解析端点与 fake-IP 段；不配置即用默认。 */
export interface WebFetchConfiguration { doh_resolvers?: string[]; fake_ip_ranges?: string[] }
// 当前 Spec 只明确路径和时区的配置语义；其他配置须经 D07 增补。
export interface PatchSettingsRequest extends ExpectedVersion { timezone?: string; paths?: Partial<WorkspacePaths>; default_executor?: 'codex' | 'claude'; api_fallback_enabled?: boolean }
export interface CreateTopicRequest { title: string; category: string; audience: string; source_ids: EntityId[]; angle?: string; expected_effort_min?: number }
export interface CreateDocumentRequest { kind: string; owner_entity_id?: EntityId | null; initial_text: string }
export interface SaveRevisionRequest extends ExpectedRevision { text: string; origin: 'human' }
export interface RestoreRevisionRequest extends ExpectedRevision { revision_id: EntityId }
export interface ApproveCoreRequest { revision_id: EntityId }
export interface CreateVariantRequest { platform: Platform; format: ContentFormat; variant_key?: string }
export interface CoreAlignmentRequest extends ExpectedRevision { confirmed_core_revision_id: EntityId }
export interface AdoptCandidateRequest extends ExpectedRevision {}
export interface PreparationShotInput { shot_key: string; position: number; title: string; kind: string; duration_ms: number; narration_revision_id?: EntityId | null; subtitle_revision_id?: EntityId | null; source_requirement: JsonObject; asset_refs?: ShotAssetRef[] }
export interface ShotAssetRef { asset_id: EntityId; role: string; in_ms?: number | null; out_ms?: number | null }
export type CreateProductionPlanRequest = import('./production.ts').CreateFrozenProductionPlanRequest;
export interface PatchPreparationPlanRequest extends ExpectedVersion { base_plan_revision_id: EntityId; shots: PreparationShotInput[] }
export interface DocumentSnapshot { document_id: EntityId; head_revision_id: EntityId | null; version: number; text: string; hash: Sha256 | null; save_state: 'committed' | 'empty' | 'needs_repair' }
export interface SaveRevisionResponse { document_id: EntityId; revision_id: EntityId; write_intent_id: EntityId; version: number; hash: Sha256; save_state: 'committed' }
export interface TopicReadState { core_revision_id:EntityId|null; core_version:number; core_confirmed:boolean; variants:{id:EntityId;platform:Platform;format:ContentFormat;document_id:EntityId;head_revision_id:EntityId|null;parent_revision_id:EntityId|null;document_version:number;based_on_core_revision_id:EntityId}[] }
export interface TopicSummary { id: EntityId; title: string; category: string; audience: string; angle: string; expected_effort_min: number; core_document_id: EntityId; status: 'active' | 'paused' | 'archived'; version: number; read_state?:TopicReadState }
export interface TopicDetail extends TopicSummary { source_ids:EntityId[]; core: DocumentSnapshot; core_approval: JsonObject | null; variants: JsonObject[]; assets: JsonObject[]; preparation_plan_id: EntityId; preparation_head_revision_id: EntityId; shots: PreparationShotInput[] }
export interface OverviewResponse {
  budget_min:number;
  effort_min:number;
  recent_news:import('./sources.ts').SourceRecordSummary[]; local_date: string; timezone: string; updated_at: string; plan: JsonObject | null; items: JsonObject[]; topics: TopicSummary[]; jobs: JsonObject[]; actions: JsonObject[] }
export interface ImportWorkRequest { platform: Platform; url: string; topic_id?: EntityId | null; format?: ContentFormat | null }
// D07-006：任务输入始终冻结；resume.input 仅交给原任务的恢复协议校验。
export interface CancelJobRequest extends ExpectedVersion {}
export interface ResumeJobRequest extends ExpectedVersion { input?: JsonObject; executor?: string; native_task_binding_id?: EntityId; recovery_action?: 'query_original' }
export interface JobDetailResponse { job: JobsRow; attempts: JobAttemptsRow[]; checkpoint: JsonObject | null; artifacts: JsonObject[]; error: JsonObject | null; receipts: JsonObject[] }
export type OpenWorkbenchRequest =
  | { page: WorkbenchPage; topic_id?: EntityId; variant_id?: EntityId; settings_view?: never; platform?: never; account_id?: never }
  | { page: 'settings'; settings_view: 'publishing'; platform: Platform; account_id?: EntityId; topic_id?: never; variant_id?: never }
  | { page: 'settings'; settings_view: 'skills'; platform?: never; account_id?: never; topic_id?: never; variant_id?: never };
export interface FrozenInputManifest { schema_version: string; workspace_id: EntityId; source_ids: EntityId[]; revision_ids: EntityId[]; asset_ids: EntityId[]; input_hash: InputHash; [key: string]: unknown }
