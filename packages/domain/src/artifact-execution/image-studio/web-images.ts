import {createHash} from 'node:crypto';
import {ContractError,type JsonObject,type RequestContext,type SourcePageImages,type StudioWebImageCandidate,type StudioWebImageCandidates,type StudioWebCaptureStatus,type StudioWebPlatform} from '@workbench/contracts';
import {transaction} from '@workbench/storage/connection';
import {sourceSearch,searchTerms} from '../../../../storage/src/knowledge-index/index.ts';
import {guardedFetch,parseArticleImages,decodeHtml,createPinnedHttpsFetch,systemLookup,WebDnsGuard,type AddressLookup} from '../../../../adapters/src/web/public-fetch.ts';
import type {ApplicationContext} from '../../ports/index.ts';
// 网络找图候选：只读主题已关联资料、同题已采集的 X/抖音作品，以及资讯原文一次受控抓取（结果缓存在 source_records.payload.page_images）。
// 不调用 TikHub、不接图库或搜索接口、不做授权判断。
export interface WebImageOptions {fetcher?:typeof fetch;lookup?:AddressLookup;dns?:WebDnsGuard;now?:()=>number;page_timeout_ms?:number;image_timeout_ms?:number;max_image_bytes?:number;max_page_bytes?:number;max_pages?:number;failure_ttl_ms?:number;success_ttl_ms?:number}
// 抓取失败缓存 1 小时后才自动重试（用户点「重新读取」可立即重试）；成功结果 7 天内直接复用，过期后后台重读，重读失败继续用旧图。
// 同一工作区同一原文 URL 的并发抓取合并为一次。
export const PAGE_FAILURE_TTL_MS=60*60*1000;
export const PAGE_SUCCESS_TTL_MS=7*24*60*60*1000;
const inflight=new Map<string,Promise<SourcePageImages>>();
const recent=(entry:SourcePageImages|undefined,now:number,ttl:number)=>!!entry&&now-Date.parse(entry.captured_at)<ttl;
// 每个原文链接的缓存状态：ready 成功且未过期；expired 成功但已过期；failed 没有可用结果且最近一次读取失败；missing 还没读过（或失败已过冷却期）。
type PageState='ready'|'expired'|'failed'|'missing';
function pageState(entry:SourcePageImages|undefined,shared:SourcePageImages|undefined,now:number,ttl:number,successTtl:number):PageState{
 if(entry&&!entry.error)return recent(entry,now,successTtl)?'ready':'expired';
 return (entry?.error&&recent(entry,now,ttl))||(shared?.error&&recent(shared,now,ttl))?'failed':'missing';
}
// 需要重读：没读过；成功结果过期且最近没有重读失败；或用户要求立即重试（force）时失败/过期的也重读。
function needsCapture(entry:SourcePageImages|undefined,shared:SourcePageImages|undefined,now:number,ttl:number,successTtl:number,force:boolean){
 const state=pageState(entry,shared,now,ttl,successTtl);if(state==='ready')return false;if(state==='missing')return true;
 if(force)return true;return state==='expired'&&!(shared?.error&&recent(shared,now,ttl));
}
// 未注入时用默认 fake-IP/DoH 配置；服务模块会按 web_fetch 配置注入自己的实例（并据此在 /health 报 dns_mode）。
const defaultDnsGuard=new WebDnsGuard();
export function webFetchOptions(options:WebImageOptions={}){const dns=options.dns??defaultDnsGuard;return{fetcher:options.fetcher??createPinnedHttpsFetch(dns),lookup:options.lookup??systemLookup,dns};}
const obj=(v:unknown):JsonObject=>v&&typeof v==='object'&&!Array.isArray(v)?v as JsonObject:{};
const str=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim():null;
const num=(v:unknown)=>{const n=typeof v==='number'?v:typeof v==='string'&&/^\d{1,6}$/.test(v)?Number(v):NaN;return Number.isSafeInteger(n)&&n>0?n:undefined;};
const httpsUrl=(v:unknown)=>{if(typeof v!=='string'||v.length>8192||/[\u0000-\u001f\u007f]/.test(v))return null;try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}};
const PLATFORM_HOSTS=/(^|\.)(x\.com|twitter\.com|douyin\.com|iesdouyin\.com)$/i;
const candidateId=(record:string,image:string)=>createHash('sha256').update(record+'\n'+image).digest('hex').slice(0,32);
// 平台签名地址的 x-expires（Unix 秒）；没有可读的过期信息时保持未知。
export function signedExpiry(url:string):string|null{try{const raw=new URL(url).searchParams.get('x-expires');if(!raw||!/^\d{9,12}$/.test(raw))return null;return new Date(Number(raw)*1000).toISOString();}catch{return null;}}
interface Row {id:string;record_kind:string;canonical_url:string|null;published_at:string|null;payload:string}
function platformOf(row:Row,payload:JsonObject):'x'|'douyin'|null{const p=obj(payload.provider_metadata).platform;if(row.record_kind==='x_post'||p==='x')return 'x';if(row.record_kind==='douyin_video'||p==='douyin')return 'douyin';return null;}
function platformCandidates(row:Row,payload:JsonObject,now:number):StudioWebImageCandidate[]{
 const platform=platformOf(row,payload);if(!platform)return[];const meta=obj(payload.provider_metadata),out:StudioWebImageCandidate[]=[];
 const add=(media:unknown[],page:string|null,author:string|null,handle:string|null)=>{if(!page)return;for(const item of media.map(obj)){
  const type=String(item.type??'');if(platform==='x'?!['photo','image'].includes(type):!['image','cover'].includes(type))continue;const image=httpsUrl(item.url);if(!image)continue;
  const preview=httpsUrl(item.preview_url),expires=signedExpiry(image)??str(item.expires_at),label=platform==='x'?'图源：X '+(handle?'@'+handle:author??'帖子'):'图源：抖音 '+(author?'@'+author:'作品');
  out.push({candidate_id:candidateId(row.id,image),image_url:image,...(preview&&preview!==image?{thumb_url:preview}:{}),...(num(item.width)?{width:num(item.width)!}:{}),...(num(item.height)?{height:num(item.height)!}:{}),platform,record_id:row.id,page_url:page,...(str(payload.title)?{page_title:str(payload.title)!.slice(0,300)}:{}),...(author?{author_name:author}:{}),site_name:platform==='x'?'X':'抖音',...(row.published_at?{published_at:row.published_at}:{}),...(expires?{expires_at:expires}:{}),availability:expires?(Date.parse(expires)<=now?'expired':'available'):'unknown',credit_label:label});
 }};
 const handle=str(meta.author_handle),author=str(payload.author_name);add(Array.isArray(payload.media)?payload.media:[],httpsUrl(row.canonical_url),author,platform==='x'?handle:null);
 const quoted=obj(obj(meta.x_post).quoted_post);if(platform==='x'&&quoted.availability==='available'&&Array.isArray(quoted.media)){const qa=obj(quoted.author),qh=str(qa.handle),qid=str(quoted.id);add(quoted.media,qh&&qid&&/^\d{1,30}$/.test(qid)?'https://x.com/'+qh+'/status/'+qid:httpsUrl(row.canonical_url),str(qa.name),qh);}
 return out;
}
function articleLinks(row:Row,payload:JsonObject):string[]{if(platformOf(row,payload))return[];return(Array.isArray(payload.external_links)?payload.external_links:[]).map(httpsUrl).filter((u):u is string=>!!u&&!PLATFORM_HOSTS.test(new URL(u).hostname)).slice(0,3);}
function articleCandidates(row:Row,payload:JsonObject,now:number):StudioWebImageCandidate[]{
 const cache=obj(payload.page_images) as unknown as Record<string,SourcePageImages>,out:StudioWebImageCandidate[]=[];
 for(const link of articleLinks(row,payload)){const page=cache[link];if(!page||page.error||!Array.isArray(page.images))continue;const site=str(page.site_name),title=str(page.page_title),author=str(page.author),label='图源：'+(site??title??new URL(link).hostname);
  for(const image of page.images){const url=httpsUrl(image.url);if(!url)continue;const expires=signedExpiry(url);out.push({candidate_id:candidateId(row.id,url),image_url:url,platform:'article',record_id:row.id,page_url:link,...(title?{page_title:title}:{}),...(author?{author_name:author}:{}),...(site?{site_name:site}:{}),...(row.published_at?{published_at:row.published_at}:{}),...(expires?{expires_at:expires}:{}),availability:expires?(Date.parse(expires)<=now?'expired':'available'):'unknown',...(page.truncated?{truncated:true}:{}),credit_label:label});}}
 return out;
}
// 原文抓取：每个原文 URL 只抓一次；成功与失败都写入缓存，之后只读缓存。
const failureKey=(workspace:string)=>'web-page-capture-failures.v1:'+workspace;
function readSharedFailures(context:ApplicationContext,workspace:string):Record<string,SourcePageImages>{const row=context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(failureKey(workspace));try{return row?obj(JSON.parse(String(row.value))) as unknown as Record<string,SourcePageImages>:{};}catch{return{};}}
async function capturePages(context:ApplicationContext,workspace:string,rows:Row[],options:WebImageOptions,control:{force?:boolean;signal?:AbortSignal}={}){
 // 失败按「工作区 + 原文 URL」共享：别的主题/记录引用同一 URL 时，1 小时内同样不重抓。
 const readFailures=()=>readSharedFailures(context,workspace),failures=readFailures();
 const fetchOptions=webFetchOptions(options),budget=options.max_pages??6,ttl=options.failure_ttl_ms??PAGE_FAILURE_TTL_MS,successTtl=options.success_ttl_ms??PAGE_SUCCESS_TTL_MS,now=()=>options.now?.()??Date.now(),jobs:Array<{row:Row;link:string}>=[],signal=control.signal;
 for(const row of rows){const payload=obj(JSON.parse(row.payload)),cache=obj(payload.page_images) as unknown as Record<string,SourcePageImages>;for(const link of articleLinks(row,payload)){if(needsCapture(cache[link],failures[link],now(),ttl,successTtl,!!control.force)&&jobs.length<budget)jobs.push({row,link});}}
 const capture=async(link:string):Promise<SourcePageImages>=>{const captured_at=new Date(now()).toISOString();
  try{const page=await guardedFetch(link,'html',{...fetchOptions,timeout_ms:options.page_timeout_ms??8000,...(options.max_page_bytes?{max_bytes:options.max_page_bytes}:{}),...(signal?{signal}:{})});const parsed=parseArticleImages(decodeHtml(page.bytes,page.mime),page.url);return{captured_at,final_url:page.url,...parsed,error:null,...(page.truncated?{truncated:true}:{})};}
  catch(error){
   // 服务关闭导致的中止不是原文的问题：不写失败缓存，下次再读。
   if(signal?.aborted)throw signal.reason??error;
   return{captured_at,final_url:null,page_title:null,site_name:null,author:null,images:[],error:error instanceof Error?error.message.slice(0,200):'原文暂时无法读取'};}};
 const results=await Promise.all(jobs.map(async({row,link})=>{const key=workspace+'\n'+link;let pending=inflight.get(key);if(!pending){pending=capture(link).finally(()=>inflight.delete(key));inflight.set(key,pending);}return{row,link,entry:await pending};}));
 if(results.length)transaction(context.db,()=>{const shared=readFailures();for(const {link,entry} of results){if(entry.error)shared[link]={...entry};else delete shared[link];}for(const [link,entry] of Object.entries(shared))if(!entry?.captured_at||now()-Date.parse(entry.captured_at)>=ttl*24)delete shared[link];context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(failureKey(workspace),JSON.stringify(shared));
  for(const {row,link,entry} of results){const current=context.db.prepare('SELECT payload FROM source_records WHERE workspace_id=? AND id=?').get(workspace,row.id);if(!current)continue;const payload=obj(JSON.parse(String(current.payload))),cache=obj(payload.page_images) as unknown as Record<string,SourcePageImages>;const existing=cache[link];if(existing&&(existing.captured_at>entry.captured_at||!!entry.error&&!existing.error))continue;payload.page_images={...cache,[link]:entry} as unknown as JsonObject;context.db.prepare('UPDATE source_records SET payload=?,updated_at=? WHERE workspace_id=? AND id=?').run(JSON.stringify(payload),new Date().toISOString(),workspace,row.id);}});
 return results.length;
}
// 同题帖子：用主题标题关键词在已索引资料里匹配 X/抖音作品；多词标题至少命中两个词。
function sameTopicRows(context:ApplicationContext,workspace:string,title:string,exclude:Set<string>):Row[]{
 const terms=searchTerms(title).filter(t=>[...t].length>=2).slice(0,8);if(!terms.length)return[];const counts=new Map<string,{n:number;score:number}>();
 for(const term of terms)for(const hit of sourceSearch(context.db,workspace,term)){const c=counts.get(hit.id)??{n:0,score:0};c.n++;c.score+=hit.score;counts.set(hit.id,c);}
 const need=Math.min(2,terms.length),ids=[...counts.entries()].filter(([id,c])=>c.n>=need&&!exclude.has(id)).sort((a,b)=>b[1].n-a[1].n||b[1].score-a[1].score||a[0].localeCompare(b[0])).slice(0,20).map(([id])=>id);if(!ids.length)return[];
 const rows=context.db.prepare(`SELECT id,record_kind,canonical_url,published_at,payload FROM source_records WHERE workspace_id=? AND id IN(${ids.map(()=>'?').join(',')})`).all(workspace,...ids) as unknown as Row[];
 return ids.map(id=>rows.find(r=>r.id===id)).filter((r):r is Row=>!!r&&!!platformOf(r,obj(JSON.parse(r.payload))));
}
function topicTitle(context:ApplicationContext,workspace:string,topic:string){const t=context.db.prepare('SELECT title FROM topics WHERE workspace_id=? AND id=?').get(workspace,topic);if(!t)throw new ContractError('NOT_FOUND','主题不存在');return String(t.title);}
const linkedRows=(context:ApplicationContext,workspace:string,topic:string)=>context.db.prepare('SELECT r.id,r.record_kind,r.canonical_url,r.published_at,r.payload FROM topic_sources ts JOIN source_records r ON r.workspace_id=ts.workspace_id AND r.id=ts.source_record_id WHERE ts.workspace_id=? AND ts.topic_id=? ORDER BY ts.created_at,r.id').all(workspace,topic) as unknown as Row[];
function assemble(context:ApplicationContext,workspace:string,title:string,linked:Row[],now:number):StudioWebImageCandidate[]{
 const search=sameTopicRows(context,workspace,title,new Set(linked.map(r=>r.id))),seen=new Set<string>(),out:StudioWebImageCandidate[]=[];
 const parse=(r:Row)=>obj(JSON.parse(r.payload));
 for(const c of [...linked.flatMap(r=>articleCandidates(r,parse(r),now)),...linked.flatMap(r=>platformCandidates(r,parse(r),now)),...search.flatMap(r=>platformCandidates(r,parse(r),now))])if(!seen.has(c.image_url)){seen.add(c.image_url);out.push(c);}
 return out.slice(0,60);
}
// 同步版本：capture=true 时先在本次调用内抓完原文再返回（配图规划任务在后台执行器里调用）；capture=false 只读缓存。
export async function webImageCandidates(context:ApplicationContext,request:RequestContext,topic:string,options:WebImageOptions&{capture:boolean}):Promise<StudioWebImageCandidate[]>{
 const workspace=request.workspace_id,title=topicTitle(context,workspace,topic);
 let linked=linkedRows(context,workspace,topic);if(options.capture&&await capturePages(context,workspace,linked,options))linked=linkedRows(context,workspace,topic);
 return assemble(context,workspace,title,linked,options.now?.()??Date.now());
}
// 后台抓取：同一工作区同一主题同一时刻只有一个抓取任务；请求只读缓存并立即返回，抓取结果写回缓存后由下一次请求带回。
// 抓取任务意外出错（不是原文读取失败，例如存储暂不可写）时 1 分钟内不自动重来，状态报 failed，用户可立即重试。
export const CAPTURE_ERROR_COOLDOWN_MS=60*1000;
export class WebCaptureRunner {
 private readonly jobs=new Map<string,Promise<void>>();
 private readonly errors=new Map<string,number>();
 private readonly abort=new AbortController();
 private readonly clock:()=>number;
 private closing=false;
 constructor(clock:()=>number=Date.now){this.clock=clock;}
 running(key:string){return this.jobs.has(key);}
 failedRecently(key:string){const at=this.errors.get(key);return at!==undefined&&this.clock()-at<CAPTURE_ERROR_COOLDOWN_MS;}
 /** 已有同键任务或正在关闭时不再启动，返回 false。 */
 start(key:string,work:(signal:AbortSignal)=>Promise<unknown>):boolean{
  if(this.closing||this.jobs.has(key))return false;
  const job=Promise.resolve().then(()=>work(this.abort.signal)).then(()=>{this.errors.delete(key);},()=>{if(!this.closing)this.errors.set(key,this.clock());}).finally(()=>{this.jobs.delete(key);});
  this.jobs.set(key,job);return true;
 }
 /** 测试与关闭用：等当前所有抓取任务结束。 */
 async idle(){while(this.jobs.size)await Promise.allSettled([...this.jobs.values()]);}
 beginClose(){if(this.closing)return;this.closing=true;this.abort.abort(new Error('网络找图模块正在关闭'));}
 async close(){this.beginClose();await this.idle();}
 snapshot(){return{in_flight:this.jobs.size,close_requested:this.closing};}
}
// 找图接口：只读缓存立即返回，需要时在后台起一次抓取，并告诉前端抓取状态。
export async function webImageCandidateState(context:ApplicationContext,request:RequestContext,topic:string,options:WebImageOptions&{runner:WebCaptureRunner;refresh?:boolean}):Promise<StudioWebImageCandidates>{
 const workspace=request.workspace_id,title=topicTitle(context,workspace,topic),now=options.now?.()??Date.now(),ttl=options.failure_ttl_ms??PAGE_FAILURE_TTL_MS,successTtl=options.success_ttl_ms??PAGE_SUCCESS_TTL_MS;
 const linked=linkedRows(context,workspace,topic),failures=readSharedFailures(context,workspace),key=workspace+'\n'+topic,force=!!options.refresh,runner=options.runner;
 const pages:PageState[]=[];let due=false,refreshed:string|null=null;
 for(const row of linked){const payload=obj(JSON.parse(row.payload)),cache=obj(payload.page_images) as unknown as Record<string,SourcePageImages>;
  for(const link of articleLinks(row,payload)){const entry=cache[link];pages.push(pageState(entry,failures[link],now,ttl,successTtl));if(needsCapture(entry,failures[link],now,ttl,successTtl,force))due=true;if(entry&&!entry.error&&(!refreshed||entry.captured_at>refreshed))refreshed=entry.captured_at;}}
 // 去重：同一主题已有抓取在跑就不再起第二个；上一轮意外出错 1 分钟内不自动重来（用户重试除外）。
 if(due&&!runner.running(key)&&(force||!runner.failedRecently(key)))runner.start(key,signal=>capturePages(context,workspace,linkedRows(context,workspace,topic),options,{force,signal}));
 const running=runner.running(key),failed=pages.filter(p=>p==='failed').length;
 const state:StudioWebCaptureStatus['state']=running?'refreshing':failed||due?'failed':pages.includes('expired')?'stale':'fresh';
 const capture:StudioWebCaptureStatus={state,pages_total:pages.length,pages_ready:pages.filter(p=>p==='ready'||p==='expired').length,pages_failed:failed,refreshed_at:refreshed};
 return{candidates:assemble(context,workspace,title,linked,now),capture};
}
export const webPlatformLabel=(p:StudioWebPlatform)=>p==='x'?'X':p==='douyin'?'抖音':'原文';
