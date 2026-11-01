import type { JsonObject, Platform, Sha256, ListQuery } from './common.ts';
import type { RawResponseRef } from './adapters.ts';
import type { SourceRecordsRow, SourceLocationsRow, AccountsRow } from './entities.ts';
import { objectSchema } from './validation.ts';
export interface AccountIdentityCheckResponse { account_id: string; identity_status: 'confirmed'; platform_account_id: string; checked_at: string; limitations: string[] }
export const AccountIdentityCheckSchema = objectSchema<Record<string, never>>([], {});
import { PLATFORMS } from './common.ts';
import { ContractError } from './errors.ts';

export interface SourceRecordPayload { title:string; summary:string; body:string|null; category:string; author_name:string|null; reply_author_name:string|null; quoted_author_name:string|null; external_links:string[]; media:JsonObject[]; identity_status:'pending'|'confirmed'; parser_warnings:string[]; provider_metadata:JsonObject; page_images?:Record<string,SourcePageImages> }
/** 资讯原文一次受控抓取的配图缓存：按原文 URL 记录，抓取失败也记录，避免重复抓取。 */
export interface SourcePageImage { url:string; kind:'og'|'twitter'|'inline' }
export interface SourcePageImages { captured_at:string; final_url:string|null; page_title:string|null; site_name:string|null; author:string|null; images:SourcePageImage[]; error:string|null; truncated?:boolean }
/** Saved platform addresses, never refreshed by rendering. Field paths are relative to the raw work. */
export interface PlatformVideoCandidate extends JsonObject { url:string; source_field:string }
export interface PlatformVideoMedia extends JsonObject {
 type:'video'; play_url:string; play_source_field:string; play_candidates:PlatformVideoCandidate[];
 /** Platform-declared Unix seconds retained verbatim; malformed/missing expiry stays unknown. */
 cdn_url_expired:string|number|null; expires_at:string|null; expiry_source_field:string|null;
}
export interface NormalizedSourceRecord { external_id:string|null; canonical_url:string|null; record_kind:string; published_at:string|null; payload:SourceRecordPayload; identity?:{ platform:Platform; platform_work_id:string|null; account_id:string|null; evidence:JsonObject }|null }
export interface SourceLocationInput { external_id:string|null; kind:string; relative_path:string|null; source_url:string|null; capture_time:string|null; sha256:Sha256; parser_version:string; availability:'available'|'offline'|'parse_error'; raw_response_ref:RawResponseRef|null }
export interface CreateSourceRecordRequest { url?:string; title?:string; text?:string; category?:string }
export interface SourceMarksRequest { favorite?:boolean; read?:boolean }
export interface LinkTopicSourceRequest { record_id:string; usage:string; locator?:string|null }
export interface CreateAccountRequest { role:'owner'|'benchmark'; platform:Platform; url:string; name:string }
export interface SourceSyncRequest { stream?:'items'|'events'|'hot-topics'|'dailies'|'creator-feed' }
export interface IndexRunRequest { roots:string[]; mode:'initial'|'incremental'; batch_size?:number }
export interface SourceLocationSummary extends Omit<SourceLocationsRow,'raw_response_ref'> { raw_response_ref:RawResponseRef|null }
export interface SourceCuration {rank:number;score:number|null;reason:string;selected:true;status:'active';generated_at:string|null;type?:'event'|'practice';lane?:'hot'|'practical'|'practice';stale_after?:string|null;source_updated_at?:string|null;current?:boolean;}
export interface SourceRecordSummary extends Omit<SourceRecordsRow,'payload'> { title:string; summary:string; category:string; author_name:string|null; reply_author_name:string|null; quoted_author_name:string|null; favorite:boolean; read:boolean; source_name:string; source_locations:SourceLocationSummary[];curation?:SourceCuration|null;metrics?:JsonObject|null;metric_sources?:JsonObject|null;preview_url?:string|null;format?:string|null;media_type?:'video'|'image'|'text'|'unknown';duration_ms?:string|null }
export interface SourceRecordDetail extends SourceRecordSummary { body:string|null; external_links:string[]; media:JsonObject[]; parser_warnings:string[];creator?:JsonObject|null;benchmark?:JsonObject|null }
export interface AccountPlatformProfile {
 platform:Platform; platform_account_id:string; display_name:string|null; display_id:string|null;
 avatar_url:string|null; banner_url:string|null; bio:string|null; website:string|null; public_location:string|null;
 followers:string|null; following:string|null; works:string|null; likes:string|null;
 verified:boolean|null; verification_label:string|null; joined_at:string|null; collected_at:string;
 evidence_kind:'real_platform'|'internal_rule'; raw_response_ref:RawResponseRef|null;
}
export interface AccountSummary extends AccountsRow { collection_status:'not_collected'|'available'; work_count:number;profile?:AccountPlatformProfile|null }
export interface BenchmarkSyncRequest {scope?:'latest_page'|'older_page'}
export const BenchmarkSyncSchema=objectSchema<BenchmarkSyncRequest>([],{scope:{type:'string',enum:['latest_page','older_page']}});
export type BenchmarkMaterialReprojectionRequest=Record<string,never>;
export const BenchmarkMaterialReprojectionSchema=objectSchema<BenchmarkMaterialReprojectionRequest>([],{});
export interface BenchmarkMaterialReprojectionResponse {
 projection_id:string;projection_version:string;account_id:string;matched_count:number;updated_count:number;unchanged_count:number;
 items:Array<{record_id:string;source_location_id:string;job_id:string;before_payload_sha256:Sha256;after_payload_sha256:Sha256;raw_response_ref:RawResponseRef;media_type:'video'|'image'|'text'|'unknown';duration_ms:string|null;preview_url:string|null}>;
}
export type BenchmarkStatisticsRefreshRequest=Record<string,never>;
export const BenchmarkStatisticsRefreshSchema=objectSchema<BenchmarkStatisticsRefreshRequest>([],{});
export type BenchmarkStatisticsRefreshState='queued'|'running'|'succeeded'|'partial'|'failed'|'unknown';
export interface BenchmarkStatisticsRefreshResponse {refresh_id:string;state:BenchmarkStatisticsRefreshState;matched_count:number;batch_count:number}
export interface BenchmarkStatisticsRefreshStatus extends BenchmarkStatisticsRefreshResponse {
 completed_batches:number;updated_count:number;missing_count:number;stale_count:number;invalid_count:number;retained_count:number;
 remote_attempts:number;started_at:string;finished_at:string|null;error:string|null;
}
export interface BenchmarkStatisticsRefreshStatusResponse {current:BenchmarkStatisticsRefreshStatus|null}
export interface KnowledgeSummary { id:string; kind:'source'|'note'|'wiki'; title:string; document_id:string|null; source_record_id:string|null; head_revision_id:string|null; content_status:string }
export interface SearchHit { id:string; type:'source'|'note'|'wiki'|'topic'|'work'|'account'; title:string; score:number; snippet:string; locator:JsonObject }
const text = {type:'string'};
const nonempty = {type:'string',minLength:1};
export const CreateSourceRecordSchema=objectSchema<CreateSourceRecordRequest>([],{url:nonempty,title:text,text:nonempty,category:text}, value=>{ if (!(typeof value.url==='string'&&value.url.trim()) && !(typeof value.text==='string'&&value.text.trim())) throw new ContractError('VALIDATION_ERROR','至少提供链接或正文'); });
export const SourceMarksSchema=objectSchema<SourceMarksRequest>([],{favorite:{type:'boolean'},read:{type:'boolean'}},value=>{if(!Object.keys(value).length)throw new ContractError('VALIDATION_ERROR','至少更新一个标记');});
export const LinkTopicSourceSchema=objectSchema<LinkTopicSourceRequest>(['record_id','usage'],{record_id:nonempty,usage:nonempty,locator:{type:['string','null']}});
export const CreateAccountSchema=objectSchema<CreateAccountRequest>(['role','platform','url','name'],{role:{type:'string',enum:['owner','benchmark']},platform:{type:'string',enum:[...PLATFORMS]},url:nonempty,name:nonempty});
export const SourceSyncSchema=objectSchema<SourceSyncRequest>([],{stream:{type:'string',enum:['items','events','hot-topics','dailies','creator-feed']}});
export const IndexRunSchema=objectSchema<IndexRunRequest>(['roots','mode'],{roots:{type:'array',items:nonempty,minItems:1},mode:{type:'string',enum:['initial','incremental']},batch_size:{type:'integer',minimum:1,maximum:500}});

export interface SourceRecordsQuery extends ListQuery { curated?:boolean; source?:string; category?:string; date?:string; query?:string; favorite?:boolean; order?:'captured_desc'|'published_desc' }
export interface CreateSourceRecordResponse {record_id:string}
export interface CreateAccountResponse {account_id:string;identity_status:string;collection_status:string}
export interface EnqueuedJobResponse {job_id:string}
