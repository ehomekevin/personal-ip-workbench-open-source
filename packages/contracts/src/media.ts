import type { ContentFormat, JsonObject, Platform } from './common.ts';
import type {ImageGenerationRequest} from './image-providers.ts';
export interface ArtifactOutput {artifact_id:string;variant_id:string;variant_revision_id:string;content_plan_revision_id:string|null;production_plan_revision_id:string|null;manifest_path:string;sha256:string;kind:string;producer_version:string}
export interface ArtifactFile {relative_path:string;file_ref:string;sha256:string;size_bytes:number;mime:string;metadata:JsonObject|null}
export interface ArtifactManifest {schema_version:'artifact-manifest.v1';artifact_id:string;job_id:string;attempt_id:string;attempt_generation:number;workspace_id:string;topic_id:string;variant_id:string;variant_revision_id:string;content_plan_revision_id:string|null;production_plan_revision_id:string|null;script_revision_id:string|null;core_revision_id:string;core_approval_id:string;source_preparation_revision_id:string|null;plan_id:string;input_hash:string;platform:Platform;format:ContentFormat;mode:'preview'|'export';status:'preview_ready'|'export_ready';publishable:boolean;kind:string;producer_version:string;renderer:{id:string;version:string};preset_snapshot:JsonObject;input_plan:JsonObject;files:ArtifactFile[];provenance:JsonObject[];limitations:string[];created_at:string}

export interface ContentRenderRequest {content_plan_revision_id:string;preset:string;mode:'preview'|'export'}
export interface ProductionRenderRequest {production_plan_revision_id:string;preset:string;mode:'preview'|'export'}
export interface H3AssetGenerationRequest {topic_id:string;purpose:string;prompt:string;input_asset_ids:string[];generator:'h3'}
export type AssetGenerationRequest = H3AssetGenerationRequest|ImageGenerationRequest;
