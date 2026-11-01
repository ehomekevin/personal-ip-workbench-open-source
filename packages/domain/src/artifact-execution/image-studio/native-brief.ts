import {randomUUID} from 'node:crypto';
import {ContractError,type JsonObject,type AgentResult} from '@workbench/contracts';
import type {AgentPort} from '../../ports/index.ts';
import type {ImageBriefAnalysisPort} from '../../../../adapters/src/media/image/brief.ts';
import {ImageAnalysisCleanupError} from './analysis-lifecycle.ts';
export function nativeImageBriefPort(create:()=>AgentPort&{close?():Promise<void>},checkpoint:(hash:string,native:JsonObject)=>void):ImageBriefAnalysisPort {
 return{async analyze(request,options){options.signal.throwIfAborted();const adapter=create(),close=adapter.close?.bind(adapter),id=randomUUID(),pending=new Set<Promise<unknown>>();let stream:AsyncIterator<unknown>|undefined;
  if(!close)throw new ContractError('CAPABILITY_UNVERIFIED','内容分析执行器缺少本地关闭能力，未开始分析');
  const bounded=<T>(work:Promise<T>)=>{pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work));return new Promise<T>((resolve,reject)=>{const abort=()=>reject(options.signal.reason);if(options.signal.aborted){reject(options.signal.reason);return;}options.signal.addEventListener('abort',abort,{once:true});void work.then(value=>{options.signal.removeEventListener('abort',abort);resolve(value);},error=>{options.signal.removeEventListener('abort',abort);reject(error);});});};
  try{options.signal.throwIfAborted();const handle=await bounded(adapter.start({job_id:id,kind:'image_studio_brief',target_document_id:null,base_revision_id:null,task_instruction:request.prompt,input_manifest:{schema_version:'image-studio-brief-run/1',fixed_input_hash:request.input_hash,source:request.prompt},allowed_tools:[],output_schema:request.output_schema}));
   options.signal.throwIfAborted();checkpoint(request.input_hash,{analysis_run_id:id,native_thread_id:handle.runtime_session_id,native_turn_id:handle.runtime_turn_id??null,checkpoint:handle.checkpoint,billing_route:'chatgpt_subscription',fees:null});
   const iterator=adapter.streamEvents(handle)[Symbol.asyncIterator]();stream=iterator;while(true){const next=await bounded(iterator.next());if(next.done)break;const value=next.value;
    options.signal.throwIfAborted();if('status' in value){const result=value as AgentResult;if(result.status!=='completed')throw new ContractError('RESULT_UNKNOWN','内容分析未取得完整终态；保留原任务身份');return{output:result.resume_info.output,provenance:{provider:'codex',input_hash:request.input_hash,native_thread_id:handle.runtime_session_id,native_turn_id:handle.runtime_turn_id??'',model:typeof result.resume_info.model==='string'?result.resume_info.model:null,usage:result.actual_usage}};}
   }throw new ContractError('RESULT_UNKNOWN','内容分析观察结束，无对应结构化结果，未新开提交');
  }finally{
   // Begin local transport close before draining a late start/stream next; the
   // underlying promise is still ours after bounded observation rejects.
   const cleanup=await Promise.allSettled([close(),...pending]);
   let error:unknown=cleanup[0]?.status==='rejected'?cleanup[0].reason:undefined;
   try{await stream?.return?.();}catch(cause){error??=cause;}
   if(error!==undefined)throw new ImageAnalysisCleanupError(error);
  }
 }};
}
