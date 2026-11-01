import type { JsonValue, RequestContext, ServiceIdentity, RuntimeSchema, WorkspaceSettings, PatchSettingsRequest, SettingsResponse, CreateTopicRequest, TopicDetail, CreateDocumentRequest, DocumentSnapshot, SaveRevisionRequest, SaveRevisionResponse, EntityId, ExpectedRevision, ImportWorkRequest, PreparationShotInput, ExpectedVersion, ServiceConfiguration, ExecutorHealth, WorkspacePaths } from '@workbench/contracts';
import type { DatabaseSync } from '@workbench/storage/connection';
import type { AgentReadiness, AgentRunInput, AgentRunHandle, AgentResult, AdapterEvent, CapabilityDescription, SourceBatch, JsonObject, MetricsResult, PublishInput, PublishResult, HostObserverHandle, NativeIdentity, NativeObservation } from '@workbench/contracts';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface RouteRequest { context: RequestContext; params: Record<string, string>; query: URLSearchParams; body: unknown; headers: Readonly<Record<string, string | undefined>>; signal?: AbortSignal; stream?: AsyncIterable<Uint8Array> }
export interface RouteResponse { status?: number; body: unknown; headers?: Record<string, string>; stream?: AsyncIterable<Uint8Array> }
export interface RouteDefinition<T = unknown> { method: HttpMethod; path: string; owner: string; mutation?: boolean; idempotent?: boolean; bodyFormat?: 'json' | 'stream' | 'none'; /** JSON body cap in bytes; defaults to 8 MiB. */ maxJsonBytes?: number; schema?: RuntimeSchema<T>; handle(request: RouteRequest & { body: T }): Promise<RouteResponse> | RouteResponse }
export interface RouteRegistrar { register<T>(route: RouteDefinition<T>): void }
export interface ModuleHealth { module: string; status: 'ready' | 'blocked' | 'degraded'; details?: Record<string, JsonValue> }
export interface ApplicationModule { id: string; initialize?(): Promise<void> | void; register(registrar: RouteRegistrar): void; health(): Promise<ModuleHealth> | ModuleHealth; beginClose?(): void; close?(): Promise<void> | void }
export interface ExecutorHealthQuery { refresh?:boolean; wait_for?:'codex'|'claude' }
export interface ApplicationContext { db: DatabaseSync; identity: ServiceIdentity; config: Readonly<ServiceConfiguration>; paths: Readonly<WorkspacePaths>; getExecutorHealth(query?:boolean|ExecutorHealthQuery): Promise<ExecutorHealth[]>; reader_feedback?: ReaderFeedbackPort }
export type ModuleFactory = (context: ApplicationContext) => ApplicationModule;
export interface ServicePort { identity(): ServiceIdentity; health(): Promise<ModuleHealth[]> }
export interface SettingsPort { get(context: RequestContext): Promise<SettingsResponse>; patch(context: RequestContext, input: PatchSettingsRequest): Promise<SettingsResponse> }
// D07-010：PSET-03 由唯一 Application service 实现；本阶段只交付公共签名。
export interface PublishingSettingsPort {
  get(context: RequestContext): Promise<import('@workbench/contracts').PublishingSettingsResponse>;
  create(context: RequestContext, input: import('@workbench/contracts').CreatePublishingConnectionRequest): Promise<import('@workbench/contracts').PublishingConnectionResponse>;
  patch(context: RequestContext, id: EntityId, input: import('@workbench/contracts').PatchPublishingConnectionRequest): Promise<import('@workbench/contracts').PublishingConnectionResponse>;
  apply(context: RequestContext, id: EntityId, input: import('@workbench/contracts').ApplyPublishingConnectionRequest): Promise<import('@workbench/contracts').PublishingConnectionResponse>;
  check(context: RequestContext, id: EntityId, input: import('@workbench/contracts').CheckPublishingConnectionRequest): Promise<import('@workbench/contracts').PublishingCheckResponse>;
  setEnabled(context: RequestContext, id: EntityId, input: import('@workbench/contracts').SetPublishingConnectionEnabledRequest): Promise<import('@workbench/contracts').PublishingConnectionResponse>;
  setDefault(context: RequestContext, input: import('@workbench/contracts').SetDefaultPublishingAccountRequest): Promise<import('@workbench/contracts').PublishingSettingsResponse>;
}
export interface DocumentPort { create(context: RequestContext, input: CreateDocumentRequest): Promise<DocumentSnapshot>; get(context: RequestContext, id: EntityId): Promise<DocumentSnapshot>; save(context: RequestContext, id: EntityId, input: SaveRevisionRequest): Promise<SaveRevisionResponse>; restore(context: RequestContext, id: EntityId, input: ExpectedRevision & { revision_id: EntityId }): Promise<SaveRevisionResponse>; approveCore(context: RequestContext, topicId: EntityId, revisionId: EntityId): Promise<{ approval_id: EntityId; revision_id: EntityId }> }
export interface TopicPort { create(context: RequestContext, input: CreateTopicRequest): Promise<TopicDetail>; get(context: RequestContext, id: EntityId): Promise<TopicDetail> }
export interface IdentityPort { importWork(context: RequestContext, input: ImportWorkRequest): Promise<{ work_id: EntityId; identity_status: string }>; resolveCanonical(context: RequestContext, workId: EntityId): Promise<EntityId> }
export interface PreparationPort { get(context: RequestContext, planId: EntityId): Promise<{ id: EntityId; topic_id: EntityId; head_plan_revision_id: EntityId; version: number; shots: PreparationShotInput[] }>; revise(context: RequestContext, planId: EntityId, input: ExpectedVersion & { base_plan_revision_id: EntityId; shots: PreparationShotInput[] }): Promise<{ plan_revision_id: EntityId; version: number }> }
export interface WorkspacePort { get(context: RequestContext): Promise<WorkspaceSettings> }
export interface AgentPort { describe(): Promise<CapabilityDescription[]>; checkReadiness(): Promise<AgentReadiness>; start(input: AgentRunInput): Promise<AgentRunHandle>; streamEvents(handle: AgentRunHandle): AsyncIterable<AdapterEvent | AgentResult>; requestInput(handle: AgentRunHandle, input: JsonObject): Promise<void>; cancel(handle: AgentRunHandle): Promise<JsonObject>; resume(handle: AgentRunHandle, input: JsonObject): Promise<AgentRunHandle> }
export interface SourcePort { describe(): Promise<CapabilityDescription[]>; fetchBatch(checkpoint: JsonObject | null): Promise<SourceBatch>; fetchDetail(recordId: EntityId): Promise<JsonObject>; resolveIdentity(input: JsonObject): Promise<JsonObject>; normalize(input: JsonObject): Promise<JsonObject> }
export interface MetricsPort { describe(): Promise<CapabilityDescription[]>; resolveWork(url: string): Promise<JsonObject>; fetchWorkMetrics(identity: JsonObject): Promise<MetricsResult>; fetchAccountMetrics?(identity: JsonObject): Promise<MetricsResult> }
// Caller supplies its verified, published owner work; this port never selects benchmark works.
export interface ReaderFeedbackWork { id: string; platform: import('@workbench/contracts').Platform; url: string | null; platform_item_id: string | null }
export interface ReaderFeedbackCollection { status: 'collected' | 'empty' | 'unsupported' | 'unavailable'; feedback: import('@workbench/contracts').ReaderFeedback[]; limitations: string[] }
export interface ReaderFeedbackPort { collect(work: ReaderFeedbackWork, options?: { signal?: AbortSignal }): Promise<ReaderFeedbackCollection> }
export interface PublisherPort { describe(): Promise<CapabilityDescription[]>; validateInput(input: PublishInput): Promise<JsonObject>; prepareDraft(input: PublishInput): Promise<PublishResult>; submit(input: PublishInput): Promise<PublishResult>; queryResult(input: PublishInput): Promise<PublishResult>; cancel?(input: PublishInput): Promise<PublishResult> }
export interface MediaGeneratorPort { describe(): Promise<CapabilityDescription[]>; submit(input: JsonObject): Promise<JsonObject>; query(providerTaskId: string): Promise<JsonObject>; cancel?(providerTaskId: string): Promise<JsonObject> }
export interface RendererPort { describe(): Promise<CapabilityDescription[]>; render(input: { production_plan_revision_id?: EntityId; content_plan_revision_id?: EntityId; preset: string; mode: 'preview' | 'export'; manifest: JsonObject }): Promise<JsonObject> }
export interface HostTaskObserverPort { describe(): Promise<CapabilityDescription[]>; bindNativeTask(identity: NativeIdentity): Promise<HostObserverHandle>; observe(handle: HostObserverHandle): AsyncIterable<NativeObservation>; reattach(handle: HostObserverHandle): Promise<NativeObservation>; requestInterrupt?(handle: HostObserverHandle): Promise<JsonObject> }

export type { ComparisonPort } from '@workbench/contracts';
