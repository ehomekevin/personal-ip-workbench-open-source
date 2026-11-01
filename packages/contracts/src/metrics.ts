import type { WorksRow, SnapshotsRow, AccountSnapshotsRow, MetricDefinitionsRow } from './entities.ts';
import type { Platform, ContentFormat, JsonObject, MetricAvailability } from './common.ts';
import { PLATFORMS, FORMATS } from './common.ts';
import { objectSchema } from './validation.ts';
import { ContractError } from './errors.ts';
export interface ImportExistingWorkRequest { platform:Platform; url?:string; platform_work_id?:string; topic_id?:string|null; format?:ContentFormat|null }
export interface CollectionRequest { target_window?:24|72|168|null; connector?:'tikhub' }
export interface AccountCollectionRequest { connector?:'tikhub' }
export const ImportExistingWorkSchema=objectSchema<ImportExistingWorkRequest>(['platform'],{platform:{type:'string',enum:[...PLATFORMS]},url:{type:'string',minLength:1},platform_work_id:{type:'string',minLength:1},topic_id:{type:['string','null']},format:{type:['string','null'],enum:[...FORMATS,null]}},value=>{if(!(typeof value.url==='string'&&value.url.trim())&&!(typeof value.platform_work_id==='string'&&value.platform_work_id.trim()))throw new ContractError('VALIDATION_ERROR','至少提供作品链接或平台作品 ID');});
export const CollectionSchema=objectSchema<CollectionRequest>([],{target_window:{type:['integer','null'],enum:[24,72,168,null]},connector:{type:'string',enum:['tikhub']}});
export const AccountCollectionSchema=objectSchema<AccountCollectionRequest>([],{connector:{type:'string',enum:['tikhub']}});

// 浏览器和存储共享同一份 HTTP 投影，DecimalString 不转成浮点数。
export interface WorkAliasView { alias_work_id:string; source_url:string; resolution_evidence:JsonObject }
export interface WorkView extends WorksRow { source_work_id:string; aliases:WorkAliasView[]; account_role:string|null }
export interface MetricView { id:string; key:string; value:string|null; availability:MetricAvailability; reason:string|null; definition:MetricDefinitionsRow }
export interface SnapshotView extends SnapshotsRow { source_work_id:string; canonical_work_id:string; published_at:string|null; identity_mapping:JsonObject; evidence_kind:string; metrics:MetricView[] }
export interface AccountSnapshotView extends AccountSnapshotsRow { source_id:string; collection_request_id:string; request_fingerprint:string; raw_sha256:string; metrics:MetricView[]; evidence_kind:string }
export interface ImportExistingWorkResponse { work_id:string; identity_status:string; platform_work_id_candidate:string|null }
export interface CollectionResponse { job_id:string; state:string; target_window:number|null }
export interface WorkIdentityCheckRequest { job_id:string }
export const WorkIdentityCheckSchema=objectSchema<WorkIdentityCheckRequest>(['job_id'],{job_id:{type:'string'}});
