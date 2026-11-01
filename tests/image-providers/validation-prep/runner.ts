import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {join} from 'node:path';
export const PRODUCT_CANDIDATE='sha256:8f8f88a699fe5593339f28fdc2118886192866fb90192a98f366f7ae901d39aa';
export const PROMPT='One square product photograph: a small lime ceramic cube (#ccf866) on a navy desk (#0b1f52), desk lamp behind it and soft mist lighting. Realistic materials. No text, logos, people or watermark. Keep the first result.';
export const OLD_UNKNOWN_JOB='96f17053-bdaf-4e0b-92b7-d44665af3e94';
export interface KnownIds {workspace_id?:string;topic_id?:string;job_id?:string;attempt_id?:string;attempt_generation?:number;input_hash?:string;thread_id?:string;turn_id?:string}
export interface ImageEvidence extends KnownIds {asset_id:string;image_item_ids:string[];file_path:string;mime:'image/png'|'image/jpeg';bytes:number;sha256:string;width:number;height:number;fully_decoded:true;ready:true;committed:true;refresh_readable:true;native_proof_verified:true}
export interface Observation {state:'running'|'succeeded'|'failed'|'completed_no_image'|'unknown'|'cancelled';detail?:unknown}
export interface RunPort {
 setup(signal:AbortSignal):Promise<void>;
 submit(input:{provider:'codex';operation:'generate';prompt:string},key:string,signal:AbortSignal):Promise<{job_id:string}>;
 snapshot():KnownIds;
 observe(jobId:string,signal:AbortSignal):Promise<Observation>;
 verify(jobId:string,signal:AbortSignal):Promise<ImageEvidence>;
 capture(phase:'submitted'|'terminal',signal:AbortSignal):Promise<void>;
 close():Promise<void>;
}
export interface Invocation {
 schema_version:'codex-validation-invocation/1';run_id:string;requirement_version:string;mode:'fixture'|'real';product_candidate:string;prep_candidate:string|null;
 input:{provider:'codex';operation:'generate';prompt:string};input_sha256:string;idempotency_key:string;
 budget:{codex:number;agy:0;fallback:false};native_submit_count:null;fees:null;local_submit_attempts:number;
 state:'intent'|'about_to_submit'|'submitted'|'succeeded'|'blocked'|'unknown';known:KnownIds;reason:string|null;observations:Observation[];view_errors:string[];cleanup_errors:string[];
 evidence:ImageEvidence|null;local_stop:boolean;remote_cancel_confirmed:false;started_at:string;updated_at:string;
}
function writeDurable(path:string,value:unknown,exclusive=false){
 const tmp=exclusive?path:path+'.'+randomUUID()+'.tmp',fd=openSync(tmp,'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 if(!exclusive)renameSync(tmp,path);const dir=openSync(join(path,'..'),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
}
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
export async function runOnce(port:RunPort,options:{out:string;mode:'fixture'|'real';requirement_version:string;prep_candidate?:string;max_observations:number;operation_timeout_ms:number;poll_ms:number;max_duration_ms?:number;signal?:AbortSignal}):Promise<Invocation>{
 if(options.mode==='real'&&(options.requirement_version!=='IMAGE-CODEX-VALIDATION-RUN/r1'||!options.prep_candidate))throw new Error('Separate new real-run authorization required');
 const input={provider:'codex' as const,operation:'generate' as const,prompt:PROMPT},now=()=>new Date().toISOString();
 const record:Invocation={schema_version:'codex-validation-invocation/1',run_id:'single-codex-after-prep-r1',requirement_version:options.requirement_version,mode:options.mode,product_candidate:PRODUCT_CANDIDATE,prep_candidate:options.prep_candidate??null,input,input_sha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),idempotency_key:randomUUID(),budget:{codex:options.mode==='real'?1:0,agy:0,fallback:false},native_submit_count:null,fees:null,local_submit_attempts:0,state:'intent',known:{},reason:null,observations:[],view_errors:[],cleanup_errors:[],evidence:null,local_stop:false,remote_cancel_confirmed:false,started_at:now(),updated_at:now()};
 mkdirSync(options.out,{recursive:true});const marker=join(options.out,'invocation.json');
 // This persistent exclusive marker is never removed, even before submission or after unknown.
 writeDurable(marker,record,true);const deadline=Date.now()+(options.max_duration_ms??600000);
 const save=()=>{record.updated_at=now();writeDurable(marker,record);};
 const snapshot=()=>{const next=port.snapshot();if(next.job_id===OLD_UNKNOWN_JOB)throw new Error('Old unknown job is excluded');for(const [key,value] of Object.entries(next)){const previous=(record.known as Record<string,unknown>)[key];if(previous!==undefined&&previous!==value)throw new Error('Known identity changed: '+key);}record.known={...record.known,...next};save();};
 async function bounded<T>(work:(signal:AbortSignal)=>Promise<T>,useExternalSignal=true):Promise<T>{
  if(useExternalSignal&&Date.now()>=deadline)throw new Error('Observation deadline reached; external state unknown');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const abort=()=>controller.abort(options.signal?.reason??new Error('Local observation stopped'));if(useExternalSignal)options.signal?.addEventListener('abort',abort,{once:true});
  if(useExternalSignal&&options.signal?.aborted)abort();
  try{return await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return work(controller.signal);}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort(new Error('Local operation timeout'));reject(controller.signal.reason);},useExternalSignal?Math.max(1,Math.min(options.operation_timeout_ms,deadline-Date.now())):options.operation_timeout_ms);controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true});})]);}
  finally{if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
 }
 const view=async(phase:'submitted'|'terminal')=>{try{await bounded(signal=>port.capture(phase,signal));}catch(error){record.view_errors.push(message(error));save();}};
 try{
  await bounded(signal=>port.setup(signal));snapshot();
  // Record the local submit intent and key before the sole POST; never retry POST after an ambiguous response.
  record.state='about_to_submit';record.local_submit_attempts=1;save();
  const submitted=await bounded(signal=>port.submit(input,record.idempotency_key,signal));
  if(submitted.job_id===OLD_UNKNOWN_JOB)throw new Error('Old unknown job is excluded');record.known.job_id=submitted.job_id;snapshot();record.state='submitted';save();
  await view('submitted');
  for(let round=0;round<options.max_observations;round++){
   options.signal?.throwIfAborted();snapshot();const observed=await bounded(signal=>port.observe(record.known.job_id!,signal));record.observations.push(observed);snapshot();
   if(observed.state==='succeeded'){
    const evidence=await bounded(signal=>port.verify(record.known.job_id!,signal));
    if(evidence.job_id!==record.known.job_id||evidence.workspace_id!==record.known.workspace_id||evidence.attempt_id!==record.known.attempt_id||evidence.input_hash!==record.known.input_hash||evidence.thread_id!==record.known.thread_id||evidence.turn_id!==record.known.turn_id||!evidence.thread_id||!evidence.turn_id||evidence.image_item_ids.length!==1||!evidence.image_item_ids[0]||!evidence.bytes||!/^[a-f0-9]{64}$/.test(evidence.sha256)||!evidence.width||!evidence.height||!evidence.fully_decoded||!evidence.ready||!evidence.committed||!evidence.refresh_readable||!evidence.native_proof_verified)throw new Error('Success evidence incomplete or identity mismatch');
    record.evidence=evidence;record.state='succeeded';save();break;
   }
   if(observed.state!=='running'){record.state=['failed','completed_no_image'].includes(observed.state)?'blocked':'unknown';record.reason='Observed '+observed.state;save();break;}
   if(options.poll_ms)await bounded(signal=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,options.poll_ms);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});}));
  }
  if(record.state==='submitted'){record.state='unknown';record.reason='Observation limit reached; external state and fees unknown';save();}
  await view('terminal');
 }catch(error){record.state='unknown';record.reason=message(error);save();}
 finally{
  try{snapshot();}catch(error){record.cleanup_errors.push('Snapshot: '+message(error));}
  try{await bounded(()=>port.close(),false);record.local_stop=true;}catch(error){record.cleanup_errors.push('Local close: '+message(error));}
  // Own receipt files remain readable after local resources close. This never queries native tasks.
  try{snapshot();}catch(error){record.cleanup_errors.push('Final snapshot: '+message(error));}
  save();
 }
 return record;
}
