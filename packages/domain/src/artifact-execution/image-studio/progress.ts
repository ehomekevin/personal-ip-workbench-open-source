import type {DatabaseSync} from 'node:sqlite';
import type {JsonObject,StudioImageProgress,StudioImageProgressStage} from '@workbench/contracts';

// 生图进度（只读投影）：阶段取自任务最近一次执行的 checkpoint，耗时取自任务事件；不新开协议、不写库。
/** 没有历史成功任务时的保守估计：按 2 分钟估，宁可进度走得慢，也不提前逼近完成。 */
export const DEFAULT_TYPICAL_MS=120_000;
const HISTORY_LIMIT=20;
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** 任务状态 + 最近 checkpoint → 进度阶段。只认执行链路真实写下的 phase / native_state，认不出时停在较早阶段。 */
export function imageProgressStage(jobState:string,checkpoint:unknown):StudioImageProgressStage{
 if(jobState==='reconciling')return 'checking';
 if(jobState!=='running')return 'queued';
 const cp=object(checkpoint)?checkpoint:{};
 if(cp.phase==='image_provider_result'||cp.phase==='image_verified')return 'saving';
 if(cp.phase==='image_provider'&&object(cp.image_checkpoint)){
  const native=cp.image_checkpoint;
  // Codex：item/completed 记下 image_item、turn/completed 记下 terminal_observed；AGY：result 事件记下 terminal_observed。
  if(native.native_state==='terminal_observed'||native.native_state==='completed'||native.image_item!==undefined)return 'saving';
  if(native.native_state==='running')return 'generating';
 }
 return 'starting';
}
type Typical=Pick<StudioImageProgress,'typical_ms'|'typical_source'|'typical_samples'>;
/** 历史均值缓存：快照会被高频轮询，均值按「库 × 工作区 × 渠道」缓存；任务成功时（快照观察到版本转为成功）主动失效，另有 TTL 兜底（其他入口完成的任务）。 */
export const TYPICAL_CACHE_TTL_MS=5*60_000;
const typicalCache=new WeakMap<DatabaseSync,Map<string,{value:Typical;at:number}>>();
export function cachedTypicalImageDuration(db:DatabaseSync,workspace:string,provider:string,now=Date.now()):Typical{
 let map=typicalCache.get(db);if(!map){map=new Map();typicalCache.set(db,map);}
 const key=workspace+'\n'+provider,hit=map.get(key);if(hit&&now-hit.at<TYPICAL_CACHE_TTL_MS)return hit.value;
 const value=typicalImageDuration(db,workspace,provider);map.set(key,{value,at:now});return value;
}
export function invalidateTypicalImageDuration(db:DatabaseSync,workspace:string,provider:string){typicalCache.get(db)?.delete(workspace+'\n'+provider);}
/** 同渠道最近成功生图任务的平均耗时（首次开始执行 → 成功）。 */
export function typicalImageDuration(db:DatabaseSync,workspace:string,provider:string):Pick<StudioImageProgress,'typical_ms'|'typical_source'|'typical_samples'>{
 const rows=db.prepare(`SELECT (SELECT MIN(occurred_at) FROM job_events e WHERE e.workspace_id=j.workspace_id AND e.job_id=j.id AND e.type='started') AS started_at,
   (SELECT MAX(occurred_at) FROM job_events e WHERE e.workspace_id=j.workspace_id AND e.job_id=j.id AND e.type='succeeded') AS finished_at
  FROM jobs j WHERE j.workspace_id=? AND j.kind='media_generate' AND j.state='succeeded' AND json_extract(j.input_manifest,'$.operation')='image_provider' AND json_extract(j.input_manifest,'$.image.provider')=?
  ORDER BY j.updated_at DESC LIMIT ?`).all(workspace,provider,HISTORY_LIMIT);
 const spans=rows.map(r=>Date.parse(String(r.finished_at))-Date.parse(String(r.started_at))).filter(ms=>Number.isFinite(ms)&&ms>0);
 if(!spans.length)return {typical_ms:DEFAULT_TYPICAL_MS,typical_source:'default',typical_samples:0};
 return {typical_ms:Math.round(spans.reduce((a,b)=>a+b,0)/spans.length),typical_source:'history',typical_samples:spans.length};
}
/** 一个进行中的生图任务此刻的进度；任务不存在时返回 null。 */
export function imageJobProgress(db:DatabaseSync,workspace:string,jobId:string,typical:Pick<StudioImageProgress,'typical_ms'|'typical_source'|'typical_samples'>,now=Date.now()):StudioImageProgress|null{
 const job=db.prepare('SELECT state,created_at FROM jobs WHERE workspace_id=? AND id=?').get(workspace,jobId);if(!job)return null;
 const attempt=db.prepare('SELECT checkpoint FROM job_attempts WHERE workspace_id=? AND job_id=? ORDER BY attempt_no DESC LIMIT 1').get(workspace,jobId);
 const started=db.prepare("SELECT MIN(occurred_at) AS at FROM job_events WHERE workspace_id=? AND job_id=? AND type='started'").get(workspace,jobId)?.at;
 let checkpoint:unknown=null;try{checkpoint=attempt?JSON.parse(String(attempt.checkpoint)):null;}catch{checkpoint=null;}
 const stage=imageProgressStage(String(job.state),checkpoint),since=(at:unknown)=>{const ms=now-Date.parse(String(at));return Number.isFinite(ms)?Math.max(0,Math.round(ms)):0;};
 return {stage,total_ms:since(job.created_at),running_ms:started&&stage!=='queued'?since(started):null,...typical,previews:[]};
}
