import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError, type JsonObject, type RawResponseRef, type Sha256, type NormalizedSourceRecord, type SourceLocationInput, type SourceRecordPayload } from '@workbench/contracts';
import { CREATOR_FEED_VERSION, creatorId, parseCreatorFeed, normalizeCreatorCandidate, parseCreatorDetail } from './creator-feed.ts';

export const PERSONAL_SITE_STREAMS = ['items', 'events', 'hot-topics', 'dailies', 'creator-feed'] as const;
export type PersonalSiteStream = typeof PERSONAL_SITE_STREAMS[number];
export const PERSONAL_SITE_VERSION = 'personal-site/3';
export const DEFAULT_PERSONAL_SITE_STREAM='creator-feed' as const;
export interface PersonalSiteBatch { raw_response_ref: RawResponseRef; records: NormalizedSourceRecord[]; source_locations: SourceLocationInput[]; next_checkpoint_candidate: JsonObject; warnings: string[] }
const obj = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const str = (value: unknown): string | null => typeof value === 'string' && value.length ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const digest = (value: string): Sha256 => createHash('sha256').update(value).digest('hex') as Sha256;
function publicUrl(value: unknown): string | null { const text = str(value); if (!text) return null; try { const url = new URL(text); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : null; } catch { return null; } }
function flatten(value: unknown): string { if (typeof value === 'string') return value; if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join('\n'); if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => !/En$|links|url|id|score/.test(key)).map(([key, part]) => `${key}: ${flatten(part)}`).join('\n'); return ''; }
const objects = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(obj) : [];
function articleEntry(entry: JsonObject): string {
  return [str(entry.title), str(entry.summary), str(obj(entry.source).name) ? '来源：' + str(obj(entry.source).name) : null].filter(Boolean).join('\n');
}
function readableBody(stream: PersonalSiteStream, input: JsonObject): string {
  if (stream === 'dailies') return [str(input.lead), ...objects(input.sections).map(section => [str(section.label), ...objects(section.events).map(articleEntry)].filter(Boolean).join('\n\n')),
    objects(input.flashes).length ? '简讯\n\n' + objects(input.flashes).map(articleEntry).join('\n\n') : null].filter(Boolean).join('\n\n') || flatten(input);
  const brief = obj(input.brief);
  if (!Object.keys(brief).length) return flatten(input);
  const labels: Record<string, string> = { tldr: '要点', what: '发生了什么', facts: '关键事实', background: '背景', impact: '影响', quotes: '站点引用', next: '后续关注' };
  return Object.entries(brief).filter(([key]) => !key.endsWith('En')).map(([key, value]) => {
    const text = (key === 'facts' || key === 'quotes') && Array.isArray(value) ? value.map(part => {
      const entry = obj(part), fields = key === 'facts' ? [str(entry.k), str(entry.v)] : [str(entry.who), str(entry.say)];
      return fields.filter(Boolean).join('：') || flatten(part);
    }).filter(Boolean).join('\n') : flatten(value);
    return text ? (labels[key] ?? key) + '\n' + text : '';
  }).filter(Boolean).join('\n\n');
}
export function normalizePersonalSiteRecord(stream: PersonalSiteStream, input: JsonObject, detail = false): NormalizedSourceRecord {
  const links = obj(input.links), id = str(input.id) ?? str(input.date);
  if (!id) throw new ContractError('VALIDATION_ERROR', '个人站记录缺少真实 ID/日期');
  const title = str(input.title) ?? str(input.headline); if (!title) throw new ContractError('VALIDATION_ERROR', '个人站记录缺少标题');
  const date = stream === 'dailies' && /^\d{4}-\d{2}-\d{2}$/.test(str(input.date) ?? '') ? str(input.date) : null;
  const published = str(input.publishedAt) ?? str(input.firstAt) ?? date;
  const payload: SourceRecordPayload = { title, summary: str(input.summary) ?? str(input.lead) ?? '', body: detail ? readableBody(stream, input) : null,
    category: '热点资讯', author_name: null, reply_author_name: null, quoted_author_name: null,
    external_links: [...new Set([publicUrl(links.original), ...(Array.isArray(input.reports) ? input.reports.map(report => publicUrl(obj(obj(report).links).original)) : [])].filter((v): v is string => v !== null))],
    media: [], identity_status: 'pending', parser_warnings: ['站点来源名称是出版来源，不是已核对的平台作者；事件 ID 不是平台作品 ID。', ...(detail ? ['站点解读不代表每篇外站全文。'] : ['正文尚未读取；列表仅含摘要。'])],
    provider_metadata: { event_id: str(input.eventId) ?? (stream !== 'dailies' ? id : null), source_name: str(obj(input.source).name) ?? (strings(input.sources).join(' / ') || 'personal_site'),
      date: str(input.date), category: str(input.category), published_time_basis: input.publishedAt ? 'provider_publishedAt' : input.firstAt ? 'event_firstAt' : date ? 'provider_daily_date' : 'unknown',
      ...(stream==='hot-topics'&&!detail?{curation:{rank:typeof input.rank==='number'?input.rank:1,score:typeof input.score==='number'&&Number.isFinite(input.score)&&input.score>=0&&input.score<=100?input.score:null,reason:str(input.reason)??'',selected:true,status:'active',generated_at:str(input.curationGeneratedAt)}}:{}),
      ...(detail ? { body_parser_version: PERSONAL_SITE_VERSION } : {}) } };
  return { external_id: id, canonical_url: publicUrl(links.original) ?? publicUrl(links.site), record_kind: stream === 'items' ? 'site_item' : stream === 'dailies' ? 'site_daily' : 'site_event',
    published_at: published && Number.isFinite(Date.parse(published)) ? new Date(published).toISOString() : null, payload, identity: null };
}
export function personalSiteOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ContractError('VALIDATION_ERROR', '个人站地址必须为明确的 HTTP(S) 站点地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new ContractError('VALIDATION_ERROR', '个人站地址必须为不含凭据、查询或路径的 HTTP(S) 站点地址');
  return url.origin;
}
export class PersonalSiteAdapter {
  readonly stream: PersonalSiteStream; readonly rawRoot: string; readonly fetcher: typeof fetch; readonly baseUrl: string | null;
  constructor(options: { stream: PersonalSiteStream; rawRoot: string; fetcher?: typeof fetch; baseUrl?: string }) { this.baseUrl = options.baseUrl === undefined ? null : personalSiteOrigin(options.baseUrl); this.stream = options.stream; this.rawRoot = options.rawRoot; this.fetcher = options.fetcher ?? fetch; }
  async describe() { return [{ operation: 'fetchBatch', status: this.baseUrl ? 'supported' as const : 'unconfigured' as const, limitations: ['匿名公开静态列表；不证明对标账号增量能力。'], verified_at: null, evidence_ref: null }]; }
  private endpoint(path: string): string { if (!this.baseUrl) throw new ContractError('CAPABILITY_UNVERIFIED', '个人站地址尚未明确配置'); return this.baseUrl + path; }
  private async fetchJson(endpoint: string, signal?: AbortSignal): Promise<{ value: JsonObject; ref: RawResponseRef; capturedAt: string; etag: string | null }> {
    const adapterVersion=this.stream==='creator-feed'?CREATOR_FEED_VERSION:PERSONAL_SITE_VERSION;
    const run = join(this.rawRoot, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`); await mkdir(run, { recursive: true });
    const started = new Date().toISOString(); await writeFile(join(run, 'request.json'), JSON.stringify({ method: 'GET', endpoint, started_at: started, auth: 'anonymous', adapter_version: adapterVersion }) + '\n', { flag: 'wx' });
    try {
      const response = await this.fetcher(endpoint, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), redirect: 'error' });
      let body:string;
      if(this.stream==='creator-feed'&&response.body){const reader=response.body.getReader(),decoder=new TextDecoder();let size=0;body='';try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>2*1024*1024)throw new ContractError('CAPABILITY_UNVERIFIED','候选响应超过大小限制，保留已有资料');body+=decoder.decode(chunk.value,{stream:true});}body+=decoder.decode();}finally{await reader.cancel();}}
      else body=await response.text();
      const capturedAt = new Date().toISOString(), hash = digest(body);
      await writeFile(join(run, 'response.json'), body, { flag: 'wx' });
      await writeFile(join(run, 'receipt.json'), JSON.stringify({ status: response.status, captured_at: capturedAt, bytes: Buffer.byteLength(body), sha256: hash, headers: { etag: response.headers.get('etag'), date: response.headers.get('date') } }) + '\n', { flag: 'wx' });
      if (!response.ok) throw new ContractError('CAPABILITY_UNVERIFIED', '公开个人站请求未成功', { http_status: response.status });
      const value = obj(JSON.parse(body)); if (value.schemaVersion !== 1) throw new ContractError('CAPABILITY_UNVERIFIED', '个人站 schemaVersion 尚未准入');
      return { value, ref: { path: join(run, 'response.json'), sha256: hash, adapter_version: adapterVersion }, capturedAt, etag: response.headers.get('etag') };
    } catch (error) { await writeFile(join(run, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), code: error instanceof ContractError ? error.code : signal?.aborted ? 'ABORTED' : 'REQUEST_FAILED' }) + '\n', { flag: 'wx' }); throw error; }
  }
  async fetchBatch(_checkpoint: JsonObject | null, signal?: AbortSignal): Promise<PersonalSiteBatch> {
    const endpoint = this.endpoint(`/api/v1/${this.stream}.json`), result = await this.fetchJson(endpoint, signal);
    if(this.stream==='creator-feed'){
      const records=parseCreatorFeed(result.value,this.baseUrl!).map(c=>normalizeCreatorCandidate(c,result.value,false,this.baseUrl!));
      return {raw_response_ref:result.ref,records,source_locations:records.map(record=>({external_id:record.external_id,kind:'personal_site:creator-feed',relative_path:null,source_url:record.canonical_url,capture_time:result.capturedAt,sha256:result.ref.sha256,parser_version:CREATOR_FEED_VERSION,availability:'available',raw_response_ref:result.ref})),next_checkpoint_candidate:{mode:'full_static',stream:this.stream,generated_at:result.value.generatedAt,snapshot_id:result.value.snapshotId,content_version:result.value.contentVersion,source_data_updated_at:result.value.sourceDataUpdatedAt,stale_after:result.value.staleAfter,rule_version:result.value.ruleVersion,candidate_count:records.length,counts:result.value.counts??{},readings:result.value.readings??{},response_sha256:result.ref.sha256,seen_ids:records.map(r=>r.external_id),etag:result.etag},warnings:['列表位置是上游车道顺序，不是跨类型质量排名。','列表缺席表示本期未入选，不删除历史资料。',...(Date.parse(String(result.value.staleAfter))<Date.now()?['候选快照已过建议更新时间，仍保留可读。']:[])]};
    }
    const key = this.stream === 'hot-topics' ? 'events' : this.stream;
    const values = result.value[key] ?? result.value.items ?? result.value.topics;
    if (!Array.isArray(values)) throw new ContractError('CAPABILITY_UNVERIFIED', '个人站列表结构尚未准入');
    const selected=this.stream==='hot-topics'?values.map(obj).filter(v=>v.selected!==false&&(!v.status||v.status==='active')).sort((a,b)=>Number(a.rank??999)-Number(b.rank??999)).filter((v,i,all)=>all.findIndex(other=>other.id===v.id)===i).slice(0,10).map((v,i)=>({...v,rank:Number.isSafeInteger(v.rank)&&Number(v.rank)>0?Number(v.rank):i+1,curationGeneratedAt:result.value.generatedAt??null})):values.map(obj);
    const records = selected.map(value => normalizePersonalSiteRecord(this.stream, value));
    const source_locations = records.map(record => ({ external_id: record.external_id, kind: `personal_site:${this.stream}`, relative_path: null, source_url: record.canonical_url,
      capture_time: result.capturedAt, sha256: result.ref.sha256, parser_version: PERSONAL_SITE_VERSION, availability: 'available' as const, raw_response_ref: result.ref }));
    return { raw_response_ref: result.ref, records, source_locations, next_checkpoint_candidate: { mode: 'full_static', stream: this.stream, generated_at: result.value.generatedAt ?? null,
      response_sha256: result.ref.sha256, seen_ids: records.map(record => record.external_id), etag: result.etag }, warnings: ['列表缺席不代表删除；没有远端游标。'] };
  }
  async fetchDetail(recordId: string, signal?: AbortSignal, expectedVersion?:string): Promise<{ record: NormalizedSourceRecord; raw_response_ref: RawResponseRef; captured_at: string }> {
    if(this.stream==='creator-feed'){
      if(!creatorId(recordId))throw new ContractError('VALIDATION_ERROR','候选详情 ID 无效');
      const result=await this.fetchJson(this.endpoint(`/api/v1/creator-feed/${recordId}.json`),signal);
      return {record:parseCreatorDetail(result.value,recordId,expectedVersion,this.baseUrl!),raw_response_ref:result.ref,captured_at:result.capturedAt};
    }
    if (!(this.stream === 'dailies' ? /^\d{4}-\d{2}-\d{2}$/ : /^[A-Za-z0-9_-]{1,100}$/).test(recordId)) throw new ContractError('VALIDATION_ERROR', '详情 ID 无效');
    const result = await this.fetchJson(this.endpoint(`/api/v1/${this.stream === 'dailies' ? 'dailies' : 'events'}/${encodeURIComponent(recordId)}.json`), signal);
    const raw = obj(result.value[this.stream === 'dailies' ? 'daily' : 'event']);
    if (this.stream === 'dailies') { raw.date ??= recordId; raw.headline ??= raw.title ?? `日报 ${recordId}`; }
    return { record: normalizePersonalSiteRecord(this.stream, raw, true), raw_response_ref: result.ref, captured_at: result.capturedAt };
  }
  async resolveIdentity(input: JsonObject): Promise<JsonObject> { return { identity_status: 'pending', input, reason: '没有已核对的平台作者/作品 ID' }; }
  async normalize(input: JsonObject): Promise<JsonObject> { return normalizePersonalSiteRecord(this.stream, input) as unknown as JsonObject; }
}
