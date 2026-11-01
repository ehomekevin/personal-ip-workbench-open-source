import { randomUUID } from 'node:crypto';
import { ContractError, type JsonObject, type NormalizedSourceRecord, type SourceRecordPayload, type SourceLocationInput, type SourceRecordSummary, type SourceRecordDetail, type SourceLocationSummary, type Page } from '@workbench/contracts';
import { canonicalJson, type DatabaseSync } from '../connection/index.ts';
import { readTrustedBenchmarkPlayCount } from './benchmark-statistics.ts';
import { canonicalWorkId, resolveVerifiedWorkIdentityInTransaction } from '../identity/index.ts';

// schema v6 对旧行补 '{}'；读取时保持未知，不把缺失内容伪造成正文或作者。
export function readSourcePayload(row: Record<string, unknown>): SourceRecordPayload {
  const parsed: unknown = JSON.parse(String(row.payload));
  const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Partial<SourceRecordPayload> : {};
  const strings = (input: unknown): string[] => Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : [];
  const metadata = value.provider_metadata && typeof value.provider_metadata === 'object' && !Array.isArray(value.provider_metadata) ? value.provider_metadata : {};
  return { title: typeof value.title === 'string' ? value.title : String(row.canonical_url ?? row.external_id ?? '待补充资料'), summary: typeof value.summary === 'string' ? value.summary : '', body: typeof value.body === 'string' ? value.body : null,
    category: typeof value.category === 'string' ? value.category : '原始资料', author_name: typeof value.author_name === 'string' ? value.author_name : null, reply_author_name: typeof value.reply_author_name === 'string' ? value.reply_author_name : null, quoted_author_name: typeof value.quoted_author_name === 'string' ? value.quoted_author_name : null,
    external_links: strings(value.external_links), media: Array.isArray(value.media) ? value.media : [], identity_status: value.identity_status === 'confirmed' ? 'confirmed' : 'pending',
    parser_warnings: typeof value.title === 'string' ? strings(value.parser_warnings) : ['历史记录尚无结构化内容；保留原标识与出处。'], provider_metadata: metadata,
    ...(value.page_images && typeof value.page_images === 'object' && !Array.isArray(value.page_images) ? { page_images: value.page_images } : {}) };
}

export function sourceRow(db: DatabaseSync, workspace: string, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM sources WHERE workspace_id=? AND id=?').get(workspace, id); if (!row) throw new ContractError('NOT_FOUND', '资料源不存在'); return row;
}
export function ensureSource(db: DatabaseSync, workspace: string, kind: string, url: string, stream: string): string {
  if (!db.isTransaction) throw new Error('source creation requires transaction');
  const old = db.prepare('SELECT id FROM sources WHERE workspace_id=? AND kind=? AND url=?').get(workspace, kind, url); if (old) return String(old.id);
  let connector = db.prepare('SELECT id FROM connectors WHERE workspace_id=? AND kind=? AND config_ref=?').get(workspace, kind, url);
  if (!connector) { const id = randomUUID(); db.prepare("INSERT INTO connectors(id,workspace_id,kind,capability_status,config_ref) VALUES (?,?,?,'unverified',?)").run(id, workspace, kind, url); connector = { id }; }
  const id = randomUUID(); db.prepare('INSERT INTO sources(id,workspace_id,kind,connector_id,external_id,url,schema_version) VALUES (?,?,?,?,?,?,?)').run(id, workspace, kind, String(connector.id), stream, url, '1'); return id;
}
export function getCheckpoint(db: DatabaseSync, workspace: string, connector: string, stream: string): JsonObject | null {
  const row = db.prepare('SELECT cursor FROM sync_checkpoints WHERE workspace_id=? AND connector_id=? AND stream_key=?').get(workspace, connector, stream);
  return row?.cursor ? JSON.parse(String(row.cursor)) as JsonObject : null;
}
export function setCheckpoint(db: DatabaseSync, workspace: string, connector: string, stream: string, checkpoint: JsonObject, complete: boolean): void {
  if (!db.isTransaction) throw new Error('checkpoint requires batch transaction');
  const old = db.prepare('SELECT id,last_complete_at FROM sync_checkpoints WHERE workspace_id=? AND connector_id=? AND stream_key=?').get(workspace, connector, stream);
  const at = new Date().toISOString();
  if (old) db.prepare('UPDATE sync_checkpoints SET cursor=?,etag=?,watermark=?,last_complete_at=?,updated_at=? WHERE workspace_id=? AND id=?').run(canonicalJson(checkpoint), typeof checkpoint.etag === 'string' ? checkpoint.etag : null, typeof checkpoint.generated_at === 'string' ? checkpoint.generated_at : null, complete ? at : old.last_complete_at, at, workspace, String(old.id));
  else db.prepare('INSERT INTO sync_checkpoints(id,workspace_id,connector_id,stream_key,cursor,etag,watermark,last_complete_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), workspace, connector, stream, canonicalJson(checkpoint), typeof checkpoint.etag === 'string' ? checkpoint.etag : null, typeof checkpoint.generated_at === 'string' ? checkpoint.generated_at : null, complete ? at : null);
}
function resolveWork(db: DatabaseSync, workspace: string, record: NormalizedSourceRecord): string | null {
  if (!record.identity || !record.canonical_url) return null;
  const identity = record.identity;
  const existing = db.prepare('SELECT id FROM works WHERE workspace_id=? AND platform=? AND url=? ORDER BY canonical_work_id IS NOT NULL,id LIMIT 1').get(workspace, identity.platform, record.canonical_url);
  const id = existing ? String(existing.id) : randomUUID();
  if (!existing) db.prepare("INSERT INTO works(id,workspace_id,platform,url,origin,identity_status) VALUES (?,?,?,?,'import','pending')").run(id, workspace, identity.platform, record.canonical_url);
  if (identity.platform_work_id) resolveVerifiedWorkIdentityInTransaction(db, workspace, id, { platform_work_id: identity.platform_work_id, account_id: identity.account_id, evidence: identity.evidence });
  return canonicalWorkId(db, workspace, id);
}
export function upsertSourceRecord(db: DatabaseSync, workspace: string, sourceId: string, record: NormalizedSourceRecord, location: SourceLocationInput, options:{existing_record_id?:string;skip_url_dedup?:boolean;replace_platform_media?:boolean}={}): { record_id: string; location_id: string; inserted: boolean } {
  if (!db.isTransaction) throw new Error('ingest requires batch transaction'); sourceRow(db, workspace, sourceId);
  const work = resolveWork(db, workspace, record);
  let old = options.existing_record_id?db.prepare('SELECT * FROM source_records WHERE workspace_id=? AND id=?').get(workspace,options.existing_record_id):db.prepare('SELECT * FROM source_records WHERE workspace_id=? AND source_id=? AND external_id=?').get(workspace, sourceId, record.external_id);
  if(options.existing_record_id&&!old)throw new ContractError('NOT_FOUND','复用的来源记录不存在');
  if (!old && location.relative_path) old = db.prepare('SELECT r.* FROM source_records r JOIN source_locations l ON l.workspace_id=r.workspace_id AND l.record_id=r.id WHERE r.workspace_id=? AND l.kind=? AND l.relative_path=? AND r.source_id=? ORDER BY l.created_at DESC,l.id DESC LIMIT 1').get(workspace, location.kind, location.relative_path, sourceId);
  if (!old && work) { const matches = db.prepare('SELECT * FROM source_records WHERE workspace_id=? AND work_id IS NOT NULL ORDER BY id').all(workspace); old = matches.find(row => canonicalWorkId(db, workspace, String(row.work_id)) === work); }
  if (!old && record.canonical_url&&!options.skip_url_dedup) old = db.prepare('SELECT * FROM source_records WHERE workspace_id=? AND canonical_url=? ORDER BY created_at,id LIMIT 1').get(workspace, record.canonical_url);
  const id = old ? String(old.id) : randomUUID(), at = new Date().toISOString();
  // 来源资料只写 payload，绝不改人工 document head；摘要刷新不能清除已懒载正文。
  const oldPayload = old ? readSourcePayload(old) : null;
  const roleKeys = ['author_name','reply_author_name','quoted_author_name'] as const;
  const roleConflicts = oldPayload ? roleKeys.filter(role => oldPayload[role] && record.payload[role] && oldPayload[role] !== record.payload[role]) : [];
  const oldClaims = Array.isArray(oldPayload?.provider_metadata.author_role_claims) ? oldPayload.provider_metadata.author_role_claims : [];
  const newClaims = roleKeys.filter(role => record.payload[role]).map(role => ({ role, name: record.payload[role], source_id: sourceId, location_kind: location.kind, relative_path: location.relative_path, sha256: location.sha256 }));
  const roleClaims = [...new Map([...oldClaims, ...newClaims].map(claim => [canonicalJson(claim), claim])).values()];
  const retainBody = oldPayload && location.availability === 'available' && record.payload.body === null && oldPayload.body !== null;
  const oldCreator=oldPayload?.provider_metadata.creator_feed,newCreator=record.payload.provider_metadata.creator_feed;
  const creator=oldCreator&&newCreator&&typeof oldCreator==='object'&&!Array.isArray(oldCreator)&&typeof newCreator==='object'&&!Array.isArray(newCreator)?{...oldCreator,...newCreator}:newCreator;
  const payload: SourceRecordPayload = oldPayload ? { ...record.payload, body: retainBody ? oldPayload.body : record.payload.body,
    author_name: oldPayload.author_name ?? record.payload.author_name, reply_author_name: oldPayload.reply_author_name ?? record.payload.reply_author_name, quoted_author_name: oldPayload.quoted_author_name ?? record.payload.quoted_author_name,
    external_links: [...new Set([...oldPayload.external_links, ...record.payload.external_links])], media: [...new Map([...(options.replace_platform_media?oldPayload.media.filter(item=>typeof item.asset_id==='string'||typeof item.path==='string'):oldPayload.media), ...record.payload.media].map(item => [canonicalJson(item), item])).values()],
    identity_status: oldPayload.identity_status === 'confirmed' ? 'confirmed' : record.payload.identity_status, parser_warnings: [...new Set([...oldPayload.parser_warnings, ...record.payload.parser_warnings, ...(roleConflicts.length ? ['作者角色存在不同来源候选，保留已知值与全部出处，待核对。'] : [])])],
    provider_metadata: { ...oldPayload.provider_metadata, ...record.payload.provider_metadata, author_role_claims: roleClaims, ...(retainBody ? { body_start_line: oldPayload.provider_metadata.body_start_line ?? 1 } : {}) },
    // 原文配图抓取缓存不随资料刷新丢失。
    ...(oldPayload.page_images || record.payload.page_images ? { page_images: { ...oldPayload.page_images, ...record.payload.page_images } } : {}) } : { ...record.payload, provider_metadata: { ...record.payload.provider_metadata, author_role_claims: roleClaims } };
  if (payload.body !== null) payload.parser_warnings = payload.parser_warnings.filter(warning => warning !== '正文尚未读取；列表仅含摘要。' && (record.payload.body === null || !['详情当前不可用；保留摘要和原文链接。', '详情更新暂不可用；保留已有解读和原文链接。'].includes(warning)));
  if(creator&&typeof creator==='object'&&!Array.isArray(creator)){payload.provider_metadata.creator_feed=creator;if(retainBody&&creator.content_version!==creator.detail_content_version)payload.parser_warnings=[...new Set([...payload.parser_warnings,'候选正文尚未与当前内容版本核对；保留历史正文，等待刷新。'])];}
  if (old) db.prepare('UPDATE source_records SET canonical_url=COALESCE(?,canonical_url),work_id=COALESCE(?,work_id),published_at=COALESCE(?,published_at),content_status=?,payload=?,updated_at=? WHERE workspace_id=? AND id=?').run(record.canonical_url, work, record.published_at, location.availability === 'parse_error' ? 'parse_error' : payload.body === null ? 'summary_only' : 'available', canonicalJson(payload), at, workspace, id);
  else db.prepare('INSERT INTO source_records(id,workspace_id,source_id,external_id,canonical_url,record_kind,work_id,author_account_id,published_at,content_document_id,content_status,payload) VALUES (?,?,?,?,?,?,?,NULL,?,NULL,?,?)').run(id, workspace, sourceId, record.external_id, record.canonical_url, record.record_kind, work, record.published_at, location.availability === 'parse_error' ? 'parse_error' : payload.body === null ? 'summary_only' : 'available', canonicalJson(payload));
  const existing = db.prepare('SELECT id FROM source_locations WHERE workspace_id=? AND record_id=? AND kind=? AND relative_path IS ? AND source_url IS ? AND sha256=?').get(workspace, id, location.kind, location.relative_path, location.source_url, location.sha256);
  if ((location.kind === 'vault' || location.kind.startsWith('vault:')) && location.relative_path) db.prepare("UPDATE source_locations SET availability='offline',updated_at=? WHERE workspace_id=? AND record_id=? AND kind=? AND relative_path=? AND sha256<>?").run(at, workspace, id, location.kind, location.relative_path, location.sha256);
  const locationId = existing ? String(existing.id) : randomUUID();
  if (existing) db.prepare('UPDATE source_locations SET availability=?,raw_response_ref=COALESCE(?,raw_response_ref),capture_time=CASE WHEN ? THEN ? ELSE capture_time END,updated_at=? WHERE workspace_id=? AND id=?').run(location.availability, location.raw_response_ref ? canonicalJson(location.raw_response_ref) : null, location.raw_response_ref ? 1 : 0, location.capture_time, at, workspace, locationId);
  else db.prepare('INSERT INTO source_locations(id,workspace_id,record_id,kind,relative_path,source_url,capture_time,sha256,parser_version,availability,raw_response_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(locationId, workspace, id, location.kind, location.relative_path, location.source_url, location.capture_time, location.sha256, location.parser_version, location.availability, location.raw_response_ref ? canonicalJson(location.raw_response_ref) : null);
  return { record_id: id, location_id: locationId, inserted: !old };
}
export function recordLocations(db: DatabaseSync, workspace: string, id: string): SourceLocationSummary[] {
  return db.prepare('SELECT * FROM source_locations WHERE workspace_id=? AND record_id=? ORDER BY created_at,id').all(workspace, id).map(row => ({ ...row, raw_response_ref: row.raw_response_ref ? JSON.parse(String(row.raw_response_ref)) : null })) as unknown as SourceLocationSummary[];
}
// 从已存 payload 投影列表媒体信息，不为每张卡片再读取完整详情或平台回执。
export function benchmarkMediaSummary(payload: SourceRecordPayload): Pick<SourceRecordSummary,'media_type'|'duration_ms'|'preview_url'> {
  const video=payload.media.find(m=>m.type==='video'||m.type==='animated_gif'),format=payload.provider_metadata.format;
  const media_type=format==='image_post'?'image':video||format==='short_video'?'video':payload.media.some(m=>['cover','image','photo'].includes(String(m.type)))?'image':format==='text'?'text':'unknown';
  const validDuration=(value:unknown):value is string=>typeof value==='string'&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)>0;
  const duration=[payload.provider_metadata.duration_ms,video?.duration_ms].find(validDuration);
  const ownPreview=payload.media.find(m=>typeof m.preview_url==='string')?.preview_url as string??payload.media.find(m=>m.type==='cover'||m.type==='image'||m.type==='photo')?.url as string??null;
  const xPost=payload.provider_metadata.x_post,related=xPost&&typeof xPost==='object'&&!Array.isArray(xPost)?xPost.quoted_post??xPost.reposted_post:null;
  const relatedMedia=related&&typeof related==='object'&&!Array.isArray(related)&&related.availability==='available'&&Array.isArray(related.media)?related.media.filter((m):m is JsonObject=>m!==null&&typeof m==='object'&&!Array.isArray(m)):[];
  const safePreview=(value:unknown):value is string=>{if(typeof value!=='string'||value.length>8192||/[\u0000-\u001f\u007f]/.test(value))return false;try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}};
  const relatedPreview=relatedMedia.find(m=>safePreview(m.preview_url))?.preview_url??relatedMedia.find(m=>['cover','image','photo'].includes(String(m.type))&&safePreview(m.url))?.url;
  return {media_type,duration_ms:media_type==='video'&&validDuration(duration)?duration:null,preview_url:ownPreview??(typeof relatedPreview==='string'?relatedPreview:null)};
}
interface SummaryReads { locations:SourceLocationSummary[]; favorite:boolean; read:boolean; sourceKind:string; curationFeedKind:string|null; curationFeedHash:string|null }
export function recordSummary(db: DatabaseSync, workspace: string, row: Record<string, unknown>, reads?:SummaryReads): SourceRecordSummary {
  const payload = readSourcePayload(row),trustedPlay=payload.category==='对标内容'?readTrustedBenchmarkPlayCount(db,workspace,row):null,metrics=payload.provider_metadata.metrics;
  const projectedMetrics=metrics&&typeof metrics==='object'&&!Array.isArray(metrics)?{...metrics,...(trustedPlay?{plays:trustedPlay.value}:{})}:trustedPlay?{plays:trustedPlay.value}:null;
  const { payload: _payload, sort_at: _sortAt, sort_rowid: _sortRowid, summary_favorite:_favorite, summary_read_at:_readAt, summary_source_kind:_sourceKind, ...base } = row;
  const value=payload.provider_metadata.curation;const curation=value&&typeof value==='object'&&!Array.isArray(value)&&Number.isSafeInteger(value.rank)&&Number(value.rank)>0&&typeof value.reason==='string'&&value.selected===true&&value.status==='active'?{rank:Number(value.rank),score:typeof value.score==='number'&&Number.isFinite(value.score)&&value.score>=0&&value.score<=100?value.score:null,reason:value.reason,selected:true,status:'active',generated_at:typeof value.generated_at==='string'?value.generated_at:null,...(value.type==='event'||value.type==='practice'?{type:value.type,lane:value.lane,stale_after:value.stale_after??null,source_updated_at:value.source_updated_at??null}:{})}:null;
  const marks = reads?undefined:db.prepare('SELECT favorite,read_at FROM user_source_marks WHERE workspace_id=? AND record_id=?').get(workspace, String(row.id));
  if(curation){if(reads)Object.assign(curation,{current:typeof reads.curationFeedHash==='string'&&reads.locations.some(location=>location.kind===reads.curationFeedKind&&location.sha256===reads.curationFeedHash)});else{const checkpoint=db.prepare("SELECT c.cursor,s.external_id FROM sync_checkpoints c JOIN sources s ON s.workspace_id=c.workspace_id AND s.connector_id=c.connector_id AND s.external_id=c.stream_key WHERE s.workspace_id=? AND s.kind='personal_site' AND s.external_id IN('creator-feed','hot-topics') ORDER BY CASE s.external_id WHEN 'creator-feed' THEN 0 ELSE 1 END,c.updated_at DESC LIMIT 1").get(workspace);const hash=checkpoint?JSON.parse(String(checkpoint.cursor)).response_sha256:null;Object.assign(curation,{current:typeof hash==='string'&&Boolean(db.prepare("SELECT id FROM source_locations WHERE workspace_id=? AND record_id=? AND kind=? AND sha256=? LIMIT 1").get(workspace,String(row.id),'personal_site:'+String(checkpoint!.external_id),hash))});}}
  return { ...base, title: payload.title, summary: payload.summary, category: payload.category, author_name: payload.author_name, reply_author_name: payload.reply_author_name, quoted_author_name: payload.quoted_author_name,
    curation, favorite: reads?.favorite??marks?.favorite === 1, read: reads?.read??Boolean(marks?.read_at), source_name: typeof payload.provider_metadata.source_name === 'string' ? payload.provider_metadata.source_name : reads?.sourceKind??String(sourceRow(db, workspace, String(row.source_id)).kind), source_locations: reads?.locations??recordLocations(db, workspace, String(row.id)),...(payload.category==='对标内容'?{metrics:projectedMetrics,metric_sources:trustedPlay?{plays:trustedPlay.source}:null,format:payload.provider_metadata.format??null,...benchmarkMediaSummary(payload)}:{}) } as unknown as SourceRecordSummary;
}
export function getRecordDetail(db: DatabaseSync, workspace: string, id: string): SourceRecordDetail {
  const row = db.prepare('SELECT * FROM source_records WHERE workspace_id=? AND id=?').get(workspace, id); if (!row) throw new ContractError('NOT_FOUND', '资料不存在');
  const payload = readSourcePayload(row);
  const creator=payload.provider_metadata.creator_feed,summary=recordSummary(db,workspace,row);
  return { ...summary, body: payload.body, external_links: payload.external_links, media: payload.media, parser_warnings: payload.parser_warnings,creator:creator&&typeof creator==='object'&&!Array.isArray(creator)?creator:null,benchmark:payload.category==='对标内容'?{...payload.provider_metadata,metrics:summary.metrics??null,metric_sources:summary.metric_sources??null}:null };
}
export interface SourceFilters { curated?:boolean; order?: 'captured_desc' | 'published_desc'; source?: string; category?: string; date?: string; query?: string; favorite?: boolean; cursor?: string; limit?: number }
// cursor 绑定筛选，防止拿旧查询游标造成漏项；稳定次序为排序键/插入顺序（rowid）。
export function sourcePage(db: DatabaseSync, workspace: string, filters: SourceFilters = {}): Page<SourceRecordSummary> {
  const limit = filters.limit ?? 50; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ContractError('VALIDATION_ERROR', '资料列表最多50条');
  const order = filters.order ?? 'captured_desc'; if (!['captured_desc','published_desc'].includes(order)) throw new ContractError('VALIDATION_ERROR', '资料排序无效');
  const cp=filters.curated?db.prepare("SELECT c.cursor,s.external_id FROM sync_checkpoints c JOIN sources s ON s.workspace_id=c.workspace_id AND s.connector_id=c.connector_id AND s.external_id=c.stream_key WHERE s.workspace_id=? AND s.kind='personal_site' AND s.external_id IN('creator-feed','hot-topics') ORDER BY CASE s.external_id WHEN 'creator-feed' THEN 0 ELSE 1 END,c.updated_at DESC LIMIT 1").get(workspace):null;
  const feedHash=cp?JSON.parse(String(cp.cursor)).response_sha256:null,direction=filters.curated?'ASC':'DESC',compare=filters.curated?'>':'<';
  // Only membership in the current selected feed lends a current rank.
  // Manually saved records (no current rank) sort after ranked ones, newest first (inverted creation time, then inverted insertion order).
  // Exact ties fall back to insertion order (rowid), which is monotonic, instead of the random UUID id.
  // Historical manually saved records remain visible after this edition.
  const feedKind=cp?.external_id==='hot-topics'?'hot-topics':'creator-feed',safeHash=typeof feedHash==='string'&&/^[a-f0-9]{64}$/.test(feedHash)?feedHash:'no-curated-batch';
  const currentFeed="EXISTS(SELECT 1 FROM source_locations current_location WHERE current_location.workspace_id=r.workspace_id AND current_location.record_id=r.id AND current_location.kind='personal_site:"+feedKind+"' AND current_location.sha256='"+safeHash+"')";
  const orderColumn=filters.curated?"CASE WHEN "+currentFeed+" THEN printf('%06d',COALESCE(json_extract(r.payload,'$.provider_metadata.curation.rank'),999998)) ELSE printf('999999:%016d:%019d',9999999999999999-CAST(ROUND((julianday(r.created_at)-2440587.5)*86400000) AS INTEGER),9223372036854775807-r.rowid) END":order==='published_desc'?'COALESCE(r.published_at,r.created_at)':'r.created_at';
  const scope = canonicalJson({ workspace, order, curated:filters.curated??false,feed_hash:filters.curated?feedHash:null, source: filters.source ?? null, category: filters.category ?? null, date: filters.date ?? null, query: filters.query ?? null, favorite: filters.favorite ?? null });
  let cursor: [string, string] | null = null;
  if (filters.cursor) {
    let parsed: unknown = null; try { parsed = JSON.parse(Buffer.from(filters.cursor, 'base64url').toString()); } catch { parsed = null; }
    const shaped = Array.isArray(parsed) && parsed.length === 3 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string' && typeof parsed[2] === 'string' ? parsed as [string, string, string] : null;
    // 别的筛选下的游标：照旧拒绝，防止拿旧查询游标漏项。
    if (shaped && shaped[0] !== scope) throw new ContractError('VALIDATION_ERROR', '资料游标与当前筛选不符');
    if (shaped && /^\d{1,19}$/.test(shaped[2])) cursor = [shaped[1], shaped[2]];
    // 旧格式游标（第三项是记录 id、按旧的 id 平局排序生成）和认不出的游标：不报错，从第一页重新开始。
    // 旧排序与新排序的平局次序不同，按旧位置续页会漏行；前端按 id 去重合并，重新翻一遍不重复也不遗漏。
  }
  const clauses = ['r.workspace_id=?'], params: (string | number)[] = [workspace];
  if(filters.curated){clauses.push("(EXISTS(SELECT 1 FROM source_locations curated_location WHERE curated_location.workspace_id=r.workspace_id AND curated_location.record_id=r.id AND curated_location.kind=? AND curated_location.sha256=?) OR EXISTS(SELECT 1 FROM source_locations manual_location WHERE manual_location.workspace_id=r.workspace_id AND manual_location.record_id=r.id AND manual_location.kind='manual'))");params.push('personal_site:'+String(cp?.external_id??'creator-feed'),typeof feedHash==='string'?feedHash:'no-curated-batch');}
  if (filters.source) { const source = sourceRow(db, workspace, filters.source);
    if (source.kind === 'personal_site') { clauses.push('(r.source_id=? OR EXISTS(SELECT 1 FROM source_locations sl WHERE sl.workspace_id=r.workspace_id AND sl.record_id=r.id AND sl.kind=?))'); params.push(filters.source, `personal_site:${source.external_id}`); }
    else if (source.kind === 'vault') { const rootPrefix = String(source.url) + '/'; clauses.push("(r.source_id=? OR EXISTS(SELECT 1 FROM source_locations sl WHERE sl.workspace_id=r.workspace_id AND sl.record_id=r.id AND (sl.kind=? OR (sl.kind='vault' AND EXISTS(SELECT 1 FROM index_entries ie WHERE ie.workspace_id=sl.workspace_id AND ie.source_location_id=sl.id AND substr(ie.path,1,?)=?)))))"); params.push(filters.source, `vault:${source.id}`, rootPrefix.length, rootPrefix); }
    else if (source.kind === 'tikhub_benchmark') { clauses.push('(r.source_id=? OR r.author_account_id=?)'); params.push(filters.source, String(source.external_id)); }
    else { clauses.push('(r.source_id=? OR EXISTS(SELECT 1 FROM source_locations sl WHERE sl.workspace_id=r.workspace_id AND sl.record_id=r.id AND sl.kind=?))'); params.push(filters.source, String(source.kind)); }
  }
  if (filters.category) { clauses.push("json_extract(r.payload,'$.category')=?"); params.push(filters.category); }
  if (filters.date) { if (!/^\d{4}-\d{2}-\d{2}$/.test(filters.date)) throw new ContractError('VALIDATION_ERROR', '日期筛选无效'); clauses.push('substr(r.published_at,1,10)=?'); params.push(filters.date); }
  if (filters.query) { const query = filters.query.normalize('NFKC').toLocaleLowerCase(); clauses.push("instr(lower(json_extract(r.payload,'$.title')||' '||json_extract(r.payload,'$.summary')||' '||COALESCE(json_extract(r.payload,'$.body'),'')),?)>0"); params.push(query); }
  if (filters.favorite !== undefined) { clauses.push('COALESCE(m.favorite,0)=?'); params.push(filters.favorite ? 1 : 0); }
  if (cursor) { clauses.push(`(${orderColumn}${compare}? OR (${orderColumn}=? AND r.rowid${compare}?))`); params.push(cursor[0], cursor[0], Number(cursor[1])); }
  const rows = db.prepare(`SELECT r.*,r.rowid AS sort_rowid,${orderColumn} AS sort_at,m.favorite AS summary_favorite,m.read_at AS summary_read_at,s.kind AS summary_source_kind FROM source_records r LEFT JOIN user_source_marks m ON m.workspace_id=r.workspace_id AND m.record_id=r.id JOIN sources s ON s.workspace_id=r.workspace_id AND s.id=r.source_id WHERE ${clauses.join(' AND ')} ORDER BY ${orderColumn} ${direction},r.rowid ${direction} LIMIT ?`).all(...params, limit + 1);
  const selected = rows.slice(0, limit), last = selected.at(-1);
  const locations=new Map<string,SourceLocationSummary[]>();
  if(selected.length)for(const location of db.prepare(`SELECT * FROM source_locations WHERE workspace_id=? AND record_id IN(${selected.map(()=>'?').join(',')}) ORDER BY created_at,id`).all(workspace,...selected.map(row=>String(row.id)))){const id=String(location.record_id),items=locations.get(id)??[];items.push({...location,raw_response_ref:location.raw_response_ref?JSON.parse(String(location.raw_response_ref)):null} as unknown as SourceLocationSummary);locations.set(id,items);}
  const curationCheckpoint=cp??(selected.some(row=>{const c=readSourcePayload(row).provider_metadata.curation;return c&&typeof c==='object'&&!Array.isArray(c);})?db.prepare("SELECT c.cursor,s.external_id FROM sync_checkpoints c JOIN sources s ON s.workspace_id=c.workspace_id AND s.connector_id=c.connector_id AND s.external_id=c.stream_key WHERE s.workspace_id=? AND s.kind='personal_site' AND s.external_id IN('creator-feed','hot-topics') ORDER BY CASE s.external_id WHEN 'creator-feed' THEN 0 ELSE 1 END,c.updated_at DESC LIMIT 1").get(workspace):null);
  const curationHash=curationCheckpoint?JSON.parse(String(curationCheckpoint.cursor)).response_sha256:null;
  return { items: selected.map(row => recordSummary(db, workspace, row,{locations:locations.get(String(row.id))??[],favorite:row.summary_favorite===1,read:Boolean(row.summary_read_at),sourceKind:String(row.summary_source_kind),curationFeedKind:curationCheckpoint?'personal_site:'+String(curationCheckpoint.external_id):null,curationFeedHash:typeof curationHash==='string'?curationHash:null})), next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([scope, last.sort_at, String(last.sort_rowid)])).toString('base64url') : null, has_more: rows.length > limit,
    last_success_at: db.prepare('SELECT MAX(last_sync_at) AS at FROM sources WHERE workspace_id=?').get(workspace)?.at as string | null ?? null };
}
