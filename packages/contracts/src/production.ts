import type { JsonObject, Platform } from './common.ts';
import type { PreparationShotInput } from './requests.ts';
export interface RendererIdentity { id: string; version: string }
export interface TextSegment { start: number; end: number }
export interface ContentAssetRef { asset_id: string; hash: string; role: string; crop?: JsonObject }
export interface ContentUnit { unit_key: string; position: number; kind: 'card'|'block'|'illustration'|'post'; text_revision_id?: string|null; text_segment?: TextSegment; asset_refs: ContentAssetRef[]; layout: JsonObject; reply_to_unit_key?: string|null }
export type PlanContentFormat = 'text'|'thread'|'article'|'image_post';
export interface ContentPlanFields { variant_revision_id: string; format: PlanContentFormat; units: ContentUnit[]; title_revision_id?: string|null; caption_revision_id?: string|null; cover_asset_id?: string|null; preset: string; renderer: RendererIdentity }
export interface CreateContentPlanRequest extends ContentPlanFields { variant_id: string }
export interface PatchContentPlanRequest extends ContentPlanFields { expected_version: number; base_content_revision_id: string }
export interface ProductionShot extends PreparationShotInput { asset_refs?: Array<{asset_id:string;role:string;in_ms?:number|null;out_ms?:number|null;hash?:string}> }
export interface VariantProductionFields { variant_revision_id:string; script_revision_id:string; shots:ProductionShot[]; preset:string;renderer:RendererIdentity }
export interface CreateVariantProductionPlanRequest extends VariantProductionFields { scope:'variant';topic_id:string;variant_id:string;source_preparation_revision_id?:string|null }
export type CreateFrozenProductionPlanRequest = {scope:'topic_preparation';topic_id:string;shots:PreparationShotInput[]} | CreateVariantProductionPlanRequest;
export interface PatchVariantProductionPlanRequest extends VariantProductionFields { expected_version:number;base_plan_revision_id:string }
export interface FrozenTextRef { revision_id:string;document_id:string;sha256:string;file_path:string;purpose:string }
export interface FrozenAssetRef { asset_id:string;sha256:string;file_path:string;mime:string;size_bytes:number;duration_ms:number|null;kind:string }
export interface FrozenShot extends ProductionShot { id:string;asset_refs:Array<{asset_id:string;role:string;hash:string;in_ms:number|null;out_ms:number|null}> }
export interface FrozenPlanInput { schema_version:'plan-input.v1';plan_kind:'content'|'production';workspace_id:string;topic_id:string;plan_id:string;plan_revision_id:string;variant_id:string;platform:Platform;format:PlanContentFormat|'short_video'|'long_video';variant_revision_id:string;script_revision_id:string|null;core_revision_id:string;core_approval_id:string;source_preparation_revision_id:string|null;title_revision_id:string|null;caption_revision_id:string|null;cover_asset_id:string|null;units:ContentUnit[];shots:FrozenShot[];texts:FrozenTextRef[];assets:FrozenAssetRef[];preset:string;renderer:RendererIdentity;input_hash:string }
export interface ResolvedPlanInput extends FrozenPlanInput { resolved_texts:Array<FrozenTextRef & {text:string}> }
export interface ContentPlanSnapshot {id:string;variant_id:string;head_content_revision_id:string;version:number;revisions:Array<{id:string;revision_no:number;input_hash:string}>;head:FrozenPlanInput;state:PlanExecutionState;execution?:PlanExecutionSnapshot}
export interface ProductionPlanSnapshot {id:string;topic_id:string;scope:'topic_preparation'|'variant';variant_id:string|null;head_plan_revision_id:string;version:number;shots:PreparationShotInput[];revisions:Array<{id:string;revision_no:number;input_hash:string}>;head:FrozenPlanInput|null;state:PlanExecutionState;execution?:PlanExecutionSnapshot}
export interface SanitizedPlanInput extends Omit<FrozenPlanInput,'texts'|'assets'> {texts:Array<Omit<FrozenTextRef,'file_path'>>;assets:Array<Omit<FrozenAssetRef,'file_path'>>}
export type PlanExecutionState='ready_to_render'|'rendering'|'preview_ready'|'export_ready'|'waiting_input'|'failed';
export interface PlanExecutionSnapshot {jobs:Array<{id:string;state:import('./common.ts').JobState;plan_revision_id:string;created_at:string}>;artifacts:Array<{id:string;status:string;kind:string;plan_revision_id:string;sha256:string;producer_version:string;created_at:string;stale:boolean}>}
