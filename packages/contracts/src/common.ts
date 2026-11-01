export const CONTRACT_VERSION = '0.1.1' as const;
export type EntityId = string;
export type Rfc3339 = string;
export type DecimalString = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type Sha256 = string & { readonly __hash: 'sha256' };
export type RequestHash = string & { readonly __requestHash: true };
export type OutputHash = string & { readonly __outputHash: true };
export type InputHash = string & { readonly __inputHash: true };
export type ExpectedRevision = { expected_revision_id: EntityId | null };
export type ExpectedVersion = { expected_version: number };
export interface Page<T> { items: T[]; next_cursor: string | null; has_more: boolean; last_success_at: Rfc3339 | null }
export interface ListQuery { cursor?: string; limit?: number }
export interface ServiceIdentity { service_instance_id: EntityId; workspace_id: EntityId; contract_version: typeof CONTRACT_VERSION }
export interface RequestContext extends ServiceIdentity { request_id: EntityId; idempotency_key: string | null; request_identity_ref: string | null }
export const PLATFORMS = ['xiaohongshu', 'wechat', 'x', 'douyin', 'bilibili'] as const;
export type Platform = typeof PLATFORMS[number];
export const FORMATS = ['text', 'thread', 'article', 'image_post', 'short_video', 'long_video'] as const;
export type ContentFormat = typeof FORMATS[number];
export const CAPABILITY_STATUSES = ['unconfigured', 'unverified', 'supported', 'unsupported', 'degraded'] as const;
export type CapabilityStatus = typeof CAPABILITY_STATUSES[number];
export const EXECUTION_MODES = ['programmatic', 'service_adapter', 'host_session'] as const;
export type ExecutionMode = typeof EXECUTION_MODES[number];
export const ENTRYPOINTS = ['standalone_web', 'codex_plugin', 'claude_plugin', 'claude_code_plugin'] as const;
export type Entrypoint = typeof ENTRYPOINTS[number];
export const PRESENTATIONS = ['foreground_dialog', 'background', 'host_conversation'] as const;
export type Presentation = typeof PRESENTATIONS[number];
export const JOB_STATES = ['queued', 'running', 'waiting_input', 'waiting_quota', 'cancel_requested', 'reconciling', 'succeeded', 'failed', 'cancelled'] as const;
export type JobState = typeof JOB_STATES[number];
export const ATTEMPT_STATES = ['active', 'succeeded', 'failed', 'expired', 'cancelled', 'superseded'] as const;
export const NATIVE_STATES = ['running', 'waiting_tool', 'completed', 'failed', 'interrupted', 'auth_required', 'quota_exhausted', 'disconnected'] as const;
export type NativeState = typeof NATIVE_STATES[number];
export const JOB_EVENT_TYPES = ['queued', 'started', 'phase_changed', 'progress', 'candidate_ready', 'artifact_ready', 'needs_input', 'quota_exhausted', 'reconciling', 'succeeded', 'failed', 'cancelled'] as const;
export type JobEventType = typeof JOB_EVENT_TYPES[number];
export interface JobEvent { job_id: EntityId; seq: number; attempt_no: number; type: JobEventType; occurred_at: Rfc3339; payload: JsonObject }
export interface JobEventsPage { events: JobEvent[]; last_seq: number; has_more: boolean }
export type MetricAvailability = 'available' | 'not_collected' | 'unavailable' | 'unsupported' | 'invalid';
export type MetricValue = { availability: 'available'; value: DecimalString; reason?: string | null } | { availability: Exclude<MetricAvailability, 'available'>; value: null; reason: string };
export type ObservedTime = { observed_time_basis: 'unknown'; observed_at: null; observed_age_s: null; observed_time_reason: string } | { observed_time_basis: 'provider' | 'collector_verified'; observed_at: Rfc3339; observed_age_s: number | null; observed_time_reason?: string | null };
export type NativeIdentity = { scope: 'turn'; native_namespace: string; native_session_id: string; native_turn_id: string; native_task_id?: null } | { scope: 'task'; native_namespace: string; native_task_id: string; native_session_id?: string | null; native_turn_id?: null };
export interface ResultProvenance { job_id: EntityId; attempt_id: EntityId; attempt_generation: number; input_hash: InputHash; output_hash: OutputHash; result_receipt_id: EntityId }
export const WORKBENCH_PAGES = ['today', 'sources', 'create', 'schedule', 'retro', 'knowledge', 'settings'] as const;
export type WorkbenchPage = typeof WORKBENCH_PAGES[number];
