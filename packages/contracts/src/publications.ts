import type { JsonObject, JsonValue, PublishInput, PublicationIntentsRow, PublicationMembersRow, PublicationAttemptsRow, PublicationBatchesRow, SchedulesRow, JobsRow, Page, Presentation } from './index.ts';
export interface PublicationTarget { variant_id: string; variant_revision_id: string; account_id: string; core_approval_id: string; content_plan_revision_id?: string | null; artifact_id?: string | null }
export interface CreatePublicationBatchRequest { targets: PublicationTarget[]; presentation?: Presentation }
export interface CreateScheduleRequest extends PublicationTarget { due_at: string; timezone: string; local_time: string }
export type PatchScheduleRequest = { expected_version: number; operation: 'change_time'; due_at: string; timezone: string; local_time: string } | { expected_version: number; expected_intent_version: number; operation: 'replace_content'; target: PublicationTarget };
export type PublicationManifest = JsonObject & { schema_version: 'wp20-publication-v1'; mode: 'none'; targets: JsonValue[]; source_ids: string[]; intent_id: string; input: JsonObject; frozen: JsonObject; operation?: 'submit'|'query'|'finalize'; recovery_source?: {job_id:string;attempt_id:string|null;attempt_generation:number} }
export interface PublicationIntentView extends Omit<PublicationIntentsRow,'progress'> { progress: JsonValue; platform: string; format: string; topic_id: string; phase: string; continuation: JsonObject | null; retryability: JsonObject; job: JobsRow; manifest: PublicationManifest; members: PublicationMembersRow[]; attempts: PublicationAttemptsRow[] }
export interface PublicationBatchView extends PublicationBatchesRow { intents: PublicationIntentView[] }
export interface ScheduleView extends SchedulesRow { intent: PublicationIntentView }
export interface PublicationFilter { platform?: string; account_id?: string; state?: string; topic_id?: string; cursor?: string; limit?: number }
export interface ScheduleFilter { start?: string; end?: string; timezone?: string; view?: string; cursor?: string; limit?: number }
export interface FrozenPublication { target: PublicationTarget; input: Omit<PublishInput,'intent_id'|'idempotency_key'>; frozen: JsonObject; operation?: 'submit'|'query'|'finalize'; recovery_source?: {job_id:string;attempt_id:string|null;attempt_generation:number} }
export type PublicationPage = Page<PublicationIntentView>;
