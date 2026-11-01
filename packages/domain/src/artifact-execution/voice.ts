import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, open, rename, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { ContractError, VoiceSampleSchema, type VoiceSampleRequest, type VoiceReadinessResponse, type GeneratedAssetOutput, type RequestContext, type JsonObject } from '@workbench/contracts';
import { ComfyVoice, freezeVoiceProfile, voiceGraph, checkVoiceReadiness, type FrozenVoiceProfile } from '@workbench/adapters/media/h3';
import { metadata, decode, fileHash } from '@workbench/adapters/media/render';
import { canonicalJson, inputHash, transaction, lookupIdempotency, claimIdempotency, commitIdempotency } from '@workbench/storage/connection';
import { workspaceSettings } from '@workbench/storage/settings';
import { safeManagedChild } from '@workbench/storage/files';
import { queueJobInTransaction, getJob, getAttempt, fenceReason, revokeAttemptInTransaction, appendEvent, type ClaimedJob } from '@workbench/storage/jobs';
import { assertRequestIdentity } from '../documents/index.ts';
import type { ApplicationContext } from '../ports/index.ts';
import { Jobs } from '../jobs/index.ts';

export interface VoiceInput { topic_id:string;transcript:string;frames:number;profile:FrozenVoiceProfile;graph:JsonObject;tag:string;original_job_id:string;provider_id:string|null }
interface ProviderReceipt { state:'sending'|'accepted';tag:string;graph_hash:string;provider_id:string|null }
export interface VoiceAssetManifest {schema_version:'h3-voice-asset/1';asset_id:string;workspace_id:string;topic_id:string;job_id:string;attempt_id:string;attempt_generation:number;input_hash:string;provider_id:string;file_sha256:string;size_bytes:number;duration_ms:number;metadata:JsonObject}
const pause=(signal:AbortSignal)=>new Promise<void>((done,reject)=>{const timer=setTimeout(finish,2000);function finish(){signal.removeEventListener('abort',abort);done();}function abort(){clearTimeout(timer);reject(signal.reason);}if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
async function durable(path:string,value:unknown){const temp=path+'.'+randomUUID()+'.tmp',handle=await open(temp,'wx',0o600);try{await handle.writeFile(canonicalJson(value)+'\n');await handle.sync();}finally{await handle.close();}await rename(temp,path);const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}}

export class H3VoiceWorkflow {
  readonly isolatedReadiness:boolean;
  readonly context:ApplicationContext;readonly profilePath:string|undefined;readonly createRemote:(profile:FrozenVoiceProfile)=>ComfyVoice;readonly inspect:(path:string,signal:AbortSignal)=>Promise<number>;
  constructor(context:ApplicationContext,options:{profile_path?:string;createRemote?:(profile:FrozenVoiceProfile)=>ComfyVoice;inspect?:(path:string,signal:AbortSignal)=>Promise<number>}={}){
    this.isolatedReadiness=!options.createRemote;
    this.context=context;this.profilePath=options.profile_path??process.env.WORKBENCH_H3_VOICE_PROFILE??join(context.paths.state_root,'h3-voice-profile.json');this.createRemote=options.createRemote??(profile=>new ComfyVoice(profile.endpoint));
    this.inspect=options.inspect??(async(path,signal)=>{const info=await metadata(path,{signal});await decode(path,{signal});const streams=info.streams as Array<{codec_type:string;codec_name:string}>;if(streams.length!==1||streams[0]?.codec_type!=='audio'||streams[0]?.codec_name!=='flac')throw new ContractError('VALIDATION_ERROR','H3 输出不是原始 FLAC 音轨');return Math.round(Number((info.format as JsonObject).duration)*1000);});
  }
  async readiness(request:RequestContext):Promise<VoiceReadinessResponse>{
    assertRequestIdentity(this.context,request);
    if (this.isolatedReadiness) return { identity: this.context.identity, ...await checkVoiceReadiness(this.profilePath) };
    let profile:FrozenVoiceProfile;
    try{profile=freezeVoiceProfile(this.profilePath);}catch(error){return{identity:this.context.identity,status:error instanceof ContractError&&error.code==='INPUT_STALE'?'input_changed':'unconfigured',message:error instanceof Error?error.message:'声音服务未配置',profile:null,running:null,pending:null};}
    const view={id:profile.id,skill_name:profile.skill_name,skill_sha256:profile.skill_sha256,reference_sha256:profile.reference_sha256,template_sha256:profile.template_sha256};
    try{const queue=await this.createRemote(profile).readiness(profile);return{identity:this.context.identity,status:'ready',message:'本人参考和制作节点可用；先生成一段试听',profile:view,...queue};}catch(error){return{identity:this.context.identity,status:error instanceof ContractError&&error.code==='INPUT_STALE'?'input_changed':'offline',message:error instanceof ContractError?error.message:'声音服务未连接，现有稿件与音频保留',profile:view,running:null,pending:null};}
  }
  enqueue(request:RequestContext,input:VoiceSampleRequest):{job_id:string;state:string}{
    assertRequestIdentity(this.context,request);VoiceSampleSchema.parse(input);if(!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','缺少 Idempotency-Key');
    return transaction(this.context.db,()=>{const old=lookupIdempotency(this.context.db,request.workspace_id,'h3.voice',request.idempotency_key!,input);if(old?.state==='committed')return old.response as unknown as {job_id:string;state:string};
      if(!this.context.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,input.topic_id))throw new ContractError('NOT_FOUND','声音所属主题不存在');
      const profile=freezeVoiceProfile(this.profilePath);
      const existing=this.context.db.prepare("SELECT id,state,input_manifest FROM jobs WHERE workspace_id=? AND target_id=? AND kind='media_generate' AND state IN ('queued','running','reconciling') AND json_extract(input_manifest,'$.operation')='h3_voice' ORDER BY created_at DESC,id DESC").all(request.workspace_id,input.topic_id).find(row=>{
        const saved=JSON.parse(String(row.input_manifest)).voice as VoiceInput;
        if(saved.transcript!==input.transcript||saved.frames!==input.frames||inputHash(saved.profile)!==inputHash(profile))return false;
        return !this.context.db.prepare("SELECT id FROM assets WHERE workspace_id=? AND json_extract(generation_metadata,'$.original_job_id')=?").get(request.workspace_id,saved.original_job_id||String(row.id));
      });
      if(existing){const idem=claimIdempotency(this.context.db,request.workspace_id,'h3.voice',request.idempotency_key!,input),result={job_id:String(existing.id),state:String(existing.state)};commitIdempotency(this.context.db,request.workspace_id,idem.id,result);return result;}
      const tag=randomUUID(),voice:VoiceInput={...input,profile,tag,original_job_id:'',provider_id:null,graph:voiceGraph(profile,input.transcript,input.frames,'workbench-voice/'+tag)};
      const idem=claimIdempotency(this.context.db,request.workspace_id,'h3.voice',request.idempotency_key!,input),job=this.queue(request,voice),result={job_id:job.id,state:job.state};commitIdempotency(this.context.db,request.workspace_id,idem.id,result);return result;
    });
  }
  private queue(request:RequestContext,voice:VoiceInput){return queueJobInTransaction(this.context.db,request.workspace_id,{kind:'media_generate',target_id:voice.topic_id,entrypoint:'standalone_web',execution_mode:'programmatic',input_manifest:{schema_version:'h3-voice/1',mode:'none',targets:[],source_ids:[],operation:'h3_voice',voice:voice as unknown as JsonObject},retry_policy:{recovery:'media',max_attempts:1},presentation:'foreground_dialog'},Date.now());}
  private recordPath(jobId:string){const state=workspaceSettings(this.context.db,this.context.identity.workspace_id).paths.state_root;return safeManagedChild(state,join(state,'h3-voice',jobId,'provider-receipt.json'));}
  async recover(request:RequestContext,id:string):Promise<{job_id:string;state:string}>{
    assertRequestIdentity(this.context,request);const db=this.context.db,job=getJob(db,request.workspace_id,id),body=JSON.parse(job.input_manifest) as {operation:string;voice:VoiceInput};
    if(body.operation!=='h3_voice'||!['reconciling','waiting_input','failed'].includes(job.state)||job.cancel_requested_at)throw new ContractError('HOST_RUN_NOT_CURRENT','这个声音任务不能恢复');
    const original=body.voice.original_job_id||id,path=this.recordPath(original);if(!existsSync(path))throw new ContractError('RESULT_UNKNOWN','原任务没有提交记录；需核对输入，不能将恢复当成新提交');
    const receipt=JSON.parse(readFileSync(path,'utf8')) as ProviderReceipt;if(receipt.tag!==body.voice.tag||receipt.graph_hash!==inputHash(body.voice.graph))throw new ContractError('INPUT_STALE','原声音回执与固定任务不符');
    const provider=receipt.provider_id??await this.createRemote(body.voice.profile).find(body.voice.tag,body.voice.graph);if(!provider)throw new ContractError('RESULT_UNKNOWN','队列与最近历史尚未唯一确认原任务，未重复提交');
    const key='h3.voice.recover:'+original,requestBody={original_job_id:original,provider_id:provider};
    return transaction(db,()=>{
      const current=getJob(db,request.workspace_id,id);if(current.version!==job.version)throw new ContractError('VERSION_CONFLICT','任务状态已变化');
      const old=lookupIdempotency(db,request.workspace_id,'h3.voice.recover',key,requestBody);
      if(old?.state==='committed'){
        const savedResponse=old.response as unknown as {job_id:string};let next=getJob(db,request.workspace_id,savedResponse.job_id);
        if(next.cancel_requested_at)throw new ContractError('HOST_RUN_NOT_CURRENT','已取消的声音恢复任务不能重试');
        if(['reconciling','failed','waiting_input'].includes(next.state)){
          const saved=JSON.parse(next.input_manifest).voice as VoiceInput;if(saved.provider_id!==provider||saved.original_job_id!==original)throw new ContractError('INPUT_STALE','恢复任务没有固定原生成回执');
          const now=Date.now();next=revokeAttemptInTransaction(db,request.workspace_id,next.id,'VOICE_QUERY_RETRY','superseded','queued',now);appendEvent(db,request.workspace_id,next.id,'queued',{recovery:'read_only',provider_id:provider},now);
        }
        return {job_id:next.id,state:next.state};
      }
      const idem=claimIdempotency(db,request.workspace_id,'h3.voice.recover',key,requestBody),next=this.queue(request,{...body.voice,original_job_id:original,provider_id:provider}),result={job_id:next.id,state:next.state};commitIdempotency(db,request.workspace_id,idem.id,result);return result;
    });
  }
  async execute(claim:ClaimedJob,signal:AbortSignal,checkpoint:(value:JsonObject)=>void):Promise<GeneratedAssetOutput>{
    const body=JSON.parse(claim.job.input_manifest) as {operation:string;voice:VoiceInput};if(body.operation!=='h3_voice'||inputHash(body)!==claim.job.input_hash)throw new ContractError('INPUT_STALE','声音任务快照无效');
    const voice=body.voice,paths=workspaceSettings(this.context.db,claim.job.workspace_id).paths,remote=this.createRemote(voice.profile),jobs=new Jobs(this.context),asset=randomUUID(),stage=safeManagedChild(paths.state_root,join(paths.state_root,'h3-voice-staging',asset)),root=safeManagedChild(paths.media_root,join(paths.media_root,'h3-voice',asset));let promoted=false,submitted=!!voice.provider_id;
    const check=()=>{signal.throwIfAborted();const job=getJob(this.context.db,claim.job.workspace_id,claim.job.id),attempt=getAttempt(this.context.db,job.workspace_id,claim.attempt.id);if(fenceReason(job,attempt,claim.fence,Date.now())||attempt.lease_owner!==claim.fence.lease_owner)throw new ContractError('HOST_RUN_NOT_CURRENT','声音任务提交权已撤销');};
    try{
      check();checkpoint({phase:'checking_voice',message:voice.provider_id?'核对已提交的原声音任务':'核对本人参考与声音节点'});if(!voice.provider_id)await remote.readiness(voice.profile);check();
      let provider=voice.provider_id;const receiptPath=this.recordPath(voice.original_job_id||claim.job.id);await mkdir(dirname(receiptPath),{recursive:true});
      if(!provider){if(existsSync(receiptPath))throw new ContractError('RESULT_UNKNOWN','已存在提交意图，只允许核对原任务');await durable(receiptPath,{state:'sending',tag:voice.tag,graph_hash:inputHash(voice.graph),provider_id:null} satisfies ProviderReceipt);submitted=true;check();provider=await remote.submit(voice.graph,voice.tag,signal);await durable(receiptPath,{state:'accepted',tag:voice.tag,graph_hash:inputHash(voice.graph),provider_id:provider} satisfies ProviderReceipt);}
      check();checkpoint({phase:'generating_voice',provider_id:provider,message:'正在生成这一段；原任务回执已保存'});const end=Date.now()+25*60*1000;let result=await remote.query(provider,voice.tag,voice.graph,signal);
      while(result.state==='running'&&Date.now()<end){await pause(signal);check();result=await remote.query(provider,voice.tag,voice.graph,signal);}
      if(result.state==='running')throw new ContractError('RESULT_UNKNOWN','声音生成尚未完成，可继续核对原任务');if(result.state==='failed'||!result.file)throw new ContractError('CAPABILITY_UNVERIFIED','H3 声音生成失败，原任务回执保留');
      checkpoint({phase:'checking_audio',provider_id:provider,message:'下载原始音频并检查解码'});await mkdir(stage,{recursive:true});const audio=join(stage,'audio.flac'),handle=await open(audio,'wx',0o600);let size=0;try{for await(const chunk of remote.download(result.file,signal)){check();await handle.writeFile(chunk);size+=chunk.byteLength;}await handle.sync();}finally{await handle.close();}
      const duration=await this.inspect(audio,signal);if(!Number.isSafeInteger(duration)||duration<=0||size<=4||readFileSync(audio).subarray(0,4).toString()!=='fLaC')throw new ContractError('VALIDATION_ERROR','音频格式、时长或文件不完整');
      const hash=await fileHash(audio,signal),manifest:VoiceAssetManifest={schema_version:'h3-voice-asset/1',asset_id:asset,workspace_id:claim.job.workspace_id,topic_id:voice.topic_id,job_id:claim.job.id,attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,input_hash:claim.job.input_hash,provider_id:provider,file_sha256:hash,size_bytes:size,duration_ms:duration,metadata:{source_kind:'h3_owner_reference',purpose:'口播声音试听',owner_voice:true,skill_name:voice.profile.skill_name,skill_sha256:voice.profile.skill_sha256,reference_sha256:voice.profile.reference_sha256,template_sha256:voice.profile.template_sha256,transcript:voice.transcript,frames:voice.frames,original_job_id:voice.original_job_id||claim.job.id,provider_id:provider,full_decode:true,content_check:'not_run',listening:'pending',actual_cost:null}};
      await durable(join(stage,'manifest.json'),manifest);check();await mkdir(dirname(root),{recursive:true});await rename(stage,root);promoted=true;await chmod(join(root,'audio.flac'),0o444);await chmod(join(root,'manifest.json'),0o444);check();return{asset_id:asset,manifest_path:join(root,'manifest.json'),sha256:await fileHash(join(root,'manifest.json'),signal)};
    }catch(error){const source=promoted?root:stage;if(existsSync(source)){const quarantine=safeManagedChild(paths.state_root,join(paths.state_root,'h3-voice-quarantine',asset));await mkdir(dirname(quarantine),{recursive:true});await rename(source,quarantine);}
      try{check();jobs.fail(claim.fence,{code:error instanceof ContractError?error.code:'VOICE_UNAVAILABLE',message:error instanceof ContractError?error.message:submitted?'无法读取原声音任务，请核对服务后恢复原任务':'声音服务未连接，请检查设备和服务',submitted},submitted?'reconciling':'waiting_input');}catch{}throw error;
    }
  }
}
