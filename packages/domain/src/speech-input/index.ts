import { randomUUID,createHash } from 'node:crypto';
import { ContractError,LinkSpeechInputTopicSchema,SPEECH_CLEANUP_JOB_KIND,SPEECH_CLEANUP_MAX_LENGTH_DEVIATION,SPEECH_INPUT_LIMITS,SPEECH_INPUT_DERIVED_LIMITS,SpeechInputBatchSchema,CancelSpeechInputSchema,RecleanupSpeechInputSchema,type RecleanupSpeechInput,type SpeechInputBatch,type CancelSpeechInput,type SpeechInputSnapshot,type SpeechInputConfiguration,type RequestContext,type StartSpeechInput,type SpeechInputChunk,type AdoptSpeechInput,type LinkSpeechInputTopic,type JsonObject } from '@workbench/contracts';
import type { ApplicationContext } from '../ports/index.ts';
import type { AsrProvider,AsrStream } from '../../../adapters/src/media/asr/ark.ts';
import { assertRequestIdentity } from '../documents/index.ts';
import { Sources } from '../sources/index.ts';
import { transaction } from '@workbench/storage/connection';
import { readIdempotent,storeIdempotent } from '@workbench/storage/revisions';
import { getJob } from '@workbench/storage/jobs';
import { Jobs } from '../jobs/index.ts';
import { workspaceSettings } from '@workbench/storage/settings';
import { ContentGeneration } from '../content-agents/index.ts';
import { cleanupDeviation,readSpeechCleanupSkill,speechCleanupContext,speechCleanupInstruction,SPEECH_CLEANUP_EXECUTION } from './cleanup.ts';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const active=(state:string)=>['starting','recording','finalizing'].includes(state);
interface Receipt { snapshot:SpeechInputSnapshot; sequence:number; bytes:number; chunks:Record<string,string>; adoption_hash?:string; credential_fingerprint?:string|null; cleanup_job_id?:string; cleanup_document_id?:string; cleanup_source_text?:string }
// Job failures are recorded in user language; the job row keeps the technical code and details.
const CLEANUP_REASONS:Record<string,string>={empty:'整理稿为空，未采用整理稿',length_guard:'整理稿与原文长度相差过大，未采用整理稿'};
interface Live { stream?:AsrStream; timer?:ReturnType<typeof setTimeout>;abort:AbortController }
export function decodePcm(base64:string,max:number=SPEECH_INPUT_LIMITS.chunk_bytes):Buffer {
  // Linear check: the grouped-repeat regex overflowed the stack on full-length (10 min) WAV payloads.
  if(base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw new ContractError('VALIDATION_ERROR','音频编码无效');
  const bytes=Buffer.from(base64,'base64');if(bytes.length>max||bytes.length%2)throw new ContractError('VALIDATION_ERROR','音频片段大小或采样格式无效');return bytes;
}
export function wavPcm(bytes:Uint8Array):Buffer {
  const data=Buffer.from(bytes);if(data.length<44||data.length>SPEECH_INPUT_DERIVED_LIMITS.max_wav_bytes||data.toString('ascii',0,4)!=='RIFF'||data.toString('ascii',8,12)!=='WAVE'||data.readUInt32LE(4)+8!==data.length)throw new ContractError('VALIDATION_ERROR','请上传 16kHz、单声道、16bit PCM WAV，最长 '+SPEECH_INPUT_DERIVED_LIMITS.max_minutes+' 分钟');
  let at=12,valid=false,pcm:Buffer|undefined;while(at+8<=data.length){const kind=data.toString('ascii',at,at+4),size=data.readUInt32LE(at+4),end=at+8+size;if(end>data.length)throw new ContractError('VALIDATION_ERROR','WAV 音轨不完整');
    if(kind==='fmt '){if(size<16||data.readUInt16LE(at+8)!==1||data.readUInt16LE(at+10)!==1||data.readUInt32LE(at+12)!==16000||data.readUInt32LE(at+16)!==32000||data.readUInt16LE(at+20)!==2||data.readUInt16LE(at+22)!==16)throw new ContractError('VALIDATION_ERROR','WAV 采样格式不支持');valid=true;}
    if(kind==='data'){if(pcm)throw new ContractError('VALIDATION_ERROR','WAV 包含重复音轨');pcm=data.subarray(at+8,end);}at=end+(size%2);
  }
  if(!valid||!pcm?.length||pcm.length%2||pcm.length>SPEECH_INPUT_LIMITS.max_bytes)throw new ContractError('VALIDATION_ERROR','WAV 音轨为空或超过 '+SPEECH_INPUT_DERIVED_LIMITS.max_minutes+' 分钟');return pcm;
}
export class SpeechInputs {
  private readonly live=new Map<string,Live>();
  private readonly context:ApplicationContext;private readonly options:{provider:AsrProvider;credentialPresent:()=>boolean;credentialFingerprint?:()=>string|null;setupUrl?:string};
  constructor(context:ApplicationContext,options:SpeechInputs['options']){this.context=context;this.options=options;}
  private key(id:string){return 'speech-input.v1:'+this.context.identity.workspace_id+':'+id;}
  private load(id:string):Receipt{const row=this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(this.key(id));if(!row)throw new ContractError('NOT_FOUND','语音记录不存在');const receipt=JSON.parse(String(row.value)) as Receipt;if(receipt.cleanup_job_id)receipt.snapshot.cleanup_job_id=receipt.cleanup_job_id;return receipt;}
  // 外层 cleanup_job_id 是真源；读写都回填到快照，旧记录也能让弹窗拿到重新整理的栅栏。
  private save(receipt:Receipt){if(receipt.cleanup_job_id)receipt.snapshot.cleanup_job_id=receipt.cleanup_job_id;this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.key(receipt.snapshot.id),JSON.stringify(receipt));}
  configuration():SpeechInputConfiguration {
    const row=this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(this.key('configuration')),saved=row?JSON.parse(String(row.value)):{};
    return {enabled:saved.enabled===true,credential_present:this.options.credentialPresent(),connection:saved.connection==='verified'&&saved.fingerprint===(this.options.credentialFingerprint?.()??null)?'verified':'unverified',setup_url:this.options.setupUrl??null,limits:SPEECH_INPUT_LIMITS};
  }
  configure(request:RequestContext,enabled:boolean){assertRequestIdentity(this.context,request);const replay=readIdempotent<SpeechInputConfiguration>(this.context.db,request,'speech-input.configure',{enabled});if(replay)return {...replay,credential_present:this.options.credentialPresent()};if(enabled&&!this.options.credentialPresent())throw new ContractError('AUTH_REQUIRED','先填写 Agent Plan 专属 API Key');return transaction(this.context.db,()=>{const current=this.configuration();this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.key('configuration'),JSON.stringify({enabled,connection:current.connection,fingerprint:this.options.credentialFingerprint?.()??null}));const result=this.configuration();storeIdempotent(this.context.db,request,'speech-input.configure',{enabled},result);return result;});}
  get(request:RequestContext,id:string){assertRequestIdentity(this.context,request);const receipt=this.load(id);if(active(receipt.snapshot.state)&&!this.live.has(id))this.finish(id,'unknown','连接已中断，已有文字保留；不会自动重发音频');this.refreshCleanup(request,id);return this.load(id).snapshot;}
  // A final transcript queues exactly one cleanup job on the default executor; the receipt's cleanup_job_id is the idempotency fence inside the same transaction.
  private enqueueCleanup(id:string){
    const request:RequestContext={...this.context.identity,request_id:randomUUID(),idempotency_key:'speech-cleanup:'+id,request_identity_ref:'speech-input'};
    try{transaction(this.context.db,()=>{
      const receipt=this.load(id),text=receipt.snapshot.final_text;if(receipt.cleanup_job_id||receipt.snapshot.cleanup_state||receipt.snapshot.state!=='final'||!text?.trim())return;
      const skill=readSpeechCleanupSkill(),executor=workspaceSettings(this.context.db,this.context.identity.workspace_id).default_executor,document=randomUUID();
      this.context.db.prepare("INSERT INTO documents(id,workspace_id,kind,owner_entity_id,version) VALUES (?,?,'speech_cleanup',?,1)").run(document,this.context.identity.workspace_id,id);
      const accepted=new ContentGeneration(this.context).enqueueInTransaction(request,SPEECH_CLEANUP_JOB_KIND,document,executor,'candidate',[{document_id:document,base_revision_id:null,core_revision_id:null}],[],speechCleanupInstruction(skill),{content_purpose:'speech_cleanup',speech_cleanup:speechCleanupContext(id,text,skill),execution_policy:SPEECH_CLEANUP_EXECUTION as unknown as JsonObject});
      receipt.cleanup_job_id=accepted.job_id;receipt.cleanup_document_id=document;Object.assign(receipt.snapshot,{cleanup_state:'queued',cleaned_text:null,cleanup_error:null,cleanup_job_id:accepted.job_id});this.save(receipt);
    });}catch{const receipt=this.load(id);if(receipt.cleanup_job_id||receipt.snapshot.cleanup_state)return;Object.assign(receipt.snapshot,{cleanup_state:'failed',cleaned_text:null,cleanup_error:'整理任务未能开始'});this.save(receipt);}
  }
  // Read-through projection of the cleanup job; a settled result (text or reason) is written back once and never re-read.
  private refreshCleanup(request:RequestContext,id:string){
    const receipt=this.load(id),snapshot=receipt.snapshot;if(!receipt.cleanup_job_id||!['queued','running','waiting'].includes(snapshot.cleanup_state??''))return;
    let job;try{job=getJob(this.context.db,this.context.identity.workspace_id,receipt.cleanup_job_id);}catch{return;}
    let next:Pick<SpeechInputSnapshot,'cleanup_state'|'cleaned_text'|'cleanup_error'>;
    if(job.state==='queued')next={cleanup_state:'queued',cleaned_text:null,cleanup_error:null};
    else if(['running','cancel_requested'].includes(job.state))next={cleanup_state:'running',cleaned_text:null,cleanup_error:null};
    // Login/quota waits and result reconciliation can still resume the same job (new attempt generation), so they stay pending and keep being re-read.
    else if(['waiting_input','waiting_quota','reconciling'].includes(job.state))next={cleanup_state:'waiting',cleaned_text:null,cleanup_error:null};
    else if(job.state==='succeeded'){
      // A draft that cannot be read (missing file, hash mismatch) settles as failed; the raw transcript stays readable and adoptable.
      let text:string|null=null;try{const generation=new ContentGeneration(this.context),candidate=generation.candidates(request,receipt.cleanup_document_id!).find(item=>item.job_id===job.id);text=candidate?generation.revision(request,receipt.cleanup_document_id!,candidate.revision_id).text:null;}catch{text=null;}
      // The worker already rejects drifting drafts; re-check here so a stored candidate can never bypass the guard.
      next=!text?.trim()?{cleanup_state:'failed',cleaned_text:null,cleanup_error:'整理结果读取失败，可直接采用原文'}:cleanupDeviation(receipt.cleanup_source_text??snapshot.final_text??'',text)>SPEECH_CLEANUP_MAX_LENGTH_DEVIATION?{cleanup_state:'failed',cleaned_text:null,cleanup_error:CLEANUP_REASONS.length_guard!}:{cleanup_state:'succeeded',cleaned_text:text,cleanup_error:null};
    }else{
      const row=this.context.db.prepare('SELECT error FROM job_attempts WHERE workspace_id=? AND job_id=? ORDER BY attempt_no DESC LIMIT 1').get(this.context.identity.workspace_id,job.id),error=row?.error?JSON.parse(String(row.error)) as {code?:string;details?:{reason?:string}}:{};
      next={cleanup_state:'failed',cleaned_text:null,cleanup_error:CLEANUP_REASONS[error.details?.reason??'']??CLEANUP_REASONS[error.code??'']??(job.state==='cancelled'?'整理已取消':'整理未完成')};
    }
    if(next.cleanup_state===snapshot.cleanup_state)return;Object.assign(snapshot,next);this.save(receipt);
  }
  // Re-run cleanup on the edited text. Fence: expected_cleanup_job_id must still be the receipt's job. A queued/waiting old job is cancelled first
  // (Jobs.cancel owns its transaction; nesting is unsupported), then one transaction re-checks the fence and that the old job is terminal before enqueueing.
  // A crash between the two leaves the old job cancelled and the receipt unchanged; retrying the same request (same Idempotency-Key) replays the cancel and enqueues once.
  recleanup(request:RequestContext,id:string,input:RecleanupSpeechInput):SpeechInputSnapshot{
    assertRequestIdentity(this.context,request);RecleanupSpeechInputSchema.parse(input);if(!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','缺少重新整理请求标识');
    const op='speech-input.recleanup:'+id,replay=readIdempotent<SpeechInputSnapshot>(this.context.db,request,op,input);if(replay)return replay;
    this.refreshCleanup(request,id);const before=this.load(id),settled=['succeeded','failed','cancelled'];
    if(before.snapshot.state!=='final'||before.snapshot.source_record_id)throw new ContractError('CAPABILITY_UNVERIFIED','转写未完成或已采用，不能重新整理');
    if((before.cleanup_job_id??null)!==input.expected_cleanup_job_id)throw new ContractError('VERSION_CONFLICT','整理任务已变化，请刷新后再试');
    if(before.cleanup_job_id){const job=getJob(this.context.db,this.context.identity.workspace_id,before.cleanup_job_id);
      if(['running','cancel_requested','reconciling'].includes(job.state))throw new ContractError('VERSION_CONFLICT','整理正在进行，完成后再重新整理');
      if(!settled.includes(job.state))new Jobs(this.context).cancel({...request,idempotency_key:'speech-recleanup-cancel:'+id+':'+request.idempotency_key},job.id,{expected_version:job.version});}
    const skill=readSpeechCleanupSkill();
    return transaction(this.context.db,()=>{
      const again=readIdempotent<SpeechInputSnapshot>(this.context.db,request,op,input);if(again)return again;
      const receipt=this.load(id);if((receipt.cleanup_job_id??null)!==input.expected_cleanup_job_id)throw new ContractError('VERSION_CONFLICT','整理任务已变化，请刷新后再试');
      if(receipt.snapshot.state!=='final'||receipt.snapshot.source_record_id)throw new ContractError('CAPABILITY_UNVERIFIED','转写未完成或已采用，不能重新整理');
      if(receipt.cleanup_job_id&&!settled.includes(getJob(this.context.db,this.context.identity.workspace_id,receipt.cleanup_job_id).state))throw new ContractError('VERSION_CONFLICT','原整理任务尚未停止，请稍后再试');
      const executor=input.executor??workspaceSettings(this.context.db,this.context.identity.workspace_id).default_executor,document=randomUUID();
      this.context.db.prepare("INSERT INTO documents(id,workspace_id,kind,owner_entity_id,version) VALUES (?,?,'speech_cleanup',?,1)").run(document,this.context.identity.workspace_id,id);
      const accepted=new ContentGeneration(this.context).enqueueInTransaction({...request,idempotency_key:'speech-recleanup:'+id+':'+request.idempotency_key},SPEECH_CLEANUP_JOB_KIND,document,executor,'candidate',[{document_id:document,base_revision_id:null,core_revision_id:null}],[],speechCleanupInstruction(skill),{content_purpose:'speech_cleanup',speech_cleanup:speechCleanupContext(id,input.text,skill),execution_policy:SPEECH_CLEANUP_EXECUTION as unknown as JsonObject});
      receipt.cleanup_job_id=accepted.job_id;receipt.cleanup_document_id=document;receipt.cleanup_source_text=input.text;Object.assign(receipt.snapshot,{cleanup_state:'queued',cleaned_text:null,cleanup_error:null,cleanup_job_id:accepted.job_id});this.save(receipt);
      storeIdempotent(this.context.db,request,op,input,receipt.snapshot as unknown as JsonObject);return receipt.snapshot;
    });
  }
  private arm(id:string,delay=30000){const runtime=this.live.get(id);if(!runtime)return;clearTimeout(runtime.timer);runtime.timer=setTimeout(()=>this.finish(id,'unknown','语音连接超时，已有文字保留；不会自动重录或重发'),delay);runtime.timer.unref();}
  private finish(id:string,state:SpeechInputSnapshot['state'],error:string|null=null){const receipt=this.load(id);if(!active(receipt.snapshot.state))return;receipt.snapshot.state=state;receipt.snapshot.error=error;this.save(receipt);const runtime=this.live.get(id);clearTimeout(runtime?.timer);runtime?.abort.abort();runtime?.stream?.close();this.live.delete(id);}
  async start(request:RequestContext,input:StartSpeechInput,identityInput:unknown=input,recordingDigest?:string):Promise<SpeechInputSnapshot>{
    assertRequestIdentity(this.context,request);if(!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','缺少语音请求标识');
    const startKey=this.key('start:'+hash(request.idempotency_key)),inputHash=hash(JSON.stringify(identityInput)),row=this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(startKey);
    if(row){const replay=JSON.parse(String(row.value));if(replay.hash!==inputHash)throw new ContractError('IDEMPOTENCY_CONFLICT','同一语音请求的输入已变化');return this.get(request,replay.id);}
    const recordingKey=recordingDigest?this.key('recording:'+recordingDigest):null;
    if(recordingKey){const previous=this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(recordingKey);if(previous){const prior=this.get(request,JSON.parse(String(previous.value)).id);if(prior.state==='unknown')throw new ContractError('RESULT_UNKNOWN','此录音已有未知回执，已保留原记录；不能更换请求标识重新付费',{speech_input_id:prior.id});if(prior.state==='final'||active(prior.state)){this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?)').run(startKey,JSON.stringify({id:prior.id,hash:inputHash}));return prior;}}}
    if(!this.configuration().enabled)throw new ContractError('CAPABILITY_UNVERIFIED','先在设置启用方舟语音输入');
    if([...this.live.values()].length)throw new ContractError('VERSION_CONFLICT','已有语音输入进行中，请先停止或取消');
    const id=input.capture_id??randomUUID();if(this.context.db.prepare('SELECT key FROM application_metadata WHERE key=?').get(this.key(id)))throw new ContractError('IDEMPOTENCY_CONFLICT','录音标识已使用，请核对原记录');
    const receipt:Receipt={sequence:0,bytes:0,chunks:{},credential_fingerprint:this.options.credentialFingerprint?.()??null,snapshot:{id,state:'starting',provider:'ark_agent_plan',model:'doubao-seed-asr-2.0',partial_text:'',final_text:null,duration_ms:0,estimated_afp:0,request_id:'',log_id:null,error:null,source_record_id:null,created_at:new Date().toISOString()}};
    transaction(this.context.db,()=>{this.save(receipt);this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?)').run(startKey,JSON.stringify({id,hash:inputHash}));if(recordingKey)this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(recordingKey,JSON.stringify({id}));});
    const runtime:Live={abort:new AbortController()};this.live.set(id,runtime);this.arm(id,10000);
    try{const stream=await this.options.provider.open(input.mode,event=>{const current=this.load(id);if(!active(current.snapshot.state))return;current.snapshot.partial_text=event.text;current.snapshot.log_id=event.log_id;
        if(event.final){current.snapshot.final_text=event.text;current.snapshot.state=event.text.trim()?'final':'failed';current.snapshot.error=event.text.trim()?null:'未识别到可用文字';this.save(current);clearTimeout(runtime.timer);runtime.stream?.close();this.live.delete(id);if(event.text.trim()){const config=this.configuration();this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.key('configuration'),JSON.stringify({enabled:config.enabled,connection:'verified',fingerprint:current.credential_fingerprint}));this.enqueueCleanup(id);}}
        else this.save(current);
      },()=>this.finish(id,'unknown','ASR 连接中断，已有文字保留；不会自动重发音频'),runtime.abort.signal);
      runtime.stream=stream;const current=this.load(id);current.snapshot.request_id=stream.requestId;current.snapshot.log_id=stream.logId();if(current.snapshot.state==='starting')current.snapshot.state='recording';this.save(current);if(active(current.snapshot.state))this.arm(id);else stream.close();return current.snapshot;
    }catch{this.finish(id,'failed','ASR 认证或连接未通过，请核对专属 Key、套餐额度和网络');return this.load(id).snapshot;}
  }
  chunk(request:RequestContext,id:string,input:SpeechInputChunk){
    assertRequestIdentity(this.context,request);const bytes=decodePcm(input.audio_base64),receipt=this.load(id),digest=hash(JSON.stringify(input));
    if(!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','缺少音频片段请求标识');const requestKey=this.key('chunk-request:'+hash(request.idempotency_key)),requestHash=hash(JSON.stringify({id,input})),bound=this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(requestKey);if(bound&&JSON.parse(String(bound.value)).hash!==requestHash)throw new ContractError('IDEMPOTENCY_CONFLICT','同一音频请求标识的输入已变化');
    if(receipt.chunks[input.sequence]){if(receipt.chunks[input.sequence]!==digest)throw new ContractError('IDEMPOTENCY_CONFLICT','音频片段已变化');if(!bound)this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?)').run(requestKey,JSON.stringify({hash:requestHash}));return receipt.snapshot;}
    const runtime=this.live.get(id);if(!runtime?.stream||receipt.snapshot.state!=='recording')throw new ContractError('RESULT_UNKNOWN','语音会话已结束，不能重发录音');
    if(input.sequence!==receipt.sequence+1||(!bytes.length&&!input.final)||receipt.bytes+bytes.length>SPEECH_INPUT_LIMITS.max_bytes)throw new ContractError('VALIDATION_ERROR','音频顺序、大小或时长超过限制');
    receipt.sequence=input.sequence;receipt.bytes+=bytes.length;receipt.chunks[input.sequence]=digest;receipt.snapshot.accepted_sequence=input.sequence;receipt.snapshot.duration_ms=receipt.bytes/32;receipt.snapshot.estimated_afp=receipt.snapshot.duration_ms/3600000*SPEECH_INPUT_LIMITS.afp_per_hour;if(input.final)receipt.snapshot.state='finalizing';transaction(this.context.db,()=>{this.save(receipt);this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(requestKey,JSON.stringify({hash:requestHash}));});
    try{runtime.stream.send(bytes,input.final);this.arm(id,input.final?15000:30000);}catch{this.finish(id,'unknown','音频已提交但回执不明，未自动重复发送');}
    return this.load(id).snapshot;
  }
  batch(request:RequestContext,id:string,input:SpeechInputBatch){
    assertRequestIdentity(this.context,request);SpeechInputBatchSchema.parse(input);if(!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','缺少音频批次请求标识');
    const receipt=this.load(id),requestKey=this.key('batch-request:'+hash(request.idempotency_key)),requestHash=hash(JSON.stringify({id,input})),bound=this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(requestKey);
    if(bound&&JSON.parse(String(bound.value)).hash!==requestHash)throw new ContractError('IDEMPOTENCY_CONFLICT','同一音频批次的输入已变化');
    // Validate the entire batch before sending any new provider frames. Replayed chunks retain their original hash fence.
    let sequence=receipt.sequence,bytes=receipt.bytes;
    for(const chunk of input.chunks){const pcm=decodePcm(chunk.audio_base64),digest=hash(JSON.stringify(chunk));if(receipt.chunks[chunk.sequence]){if(receipt.chunks[chunk.sequence]!==digest)throw new ContractError('IDEMPOTENCY_CONFLICT','音频片段已变化');continue;}
      if(chunk.sequence!==sequence+1||(!pcm.length&&!chunk.final)||(bytes+=pcm.length)>SPEECH_INPUT_LIMITS.max_bytes)throw new ContractError('VALIDATION_ERROR','音频顺序、大小或时长超过限制');sequence=chunk.sequence;
    }
    this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(requestKey,JSON.stringify({hash:requestHash}));
    let snapshot=receipt.snapshot;
    for(const chunk of input.chunks){if(!receipt.chunks[chunk.sequence]&&!active(snapshot.state))break;snapshot=this.chunk({...request,idempotency_key:'speech-batch:'+hash(request.idempotency_key)+':'+chunk.sequence},id,chunk);}
    return snapshot;
  }
  cancel(request:RequestContext,id:string,input:CancelSpeechInput={}){assertRequestIdentity(this.context,request);CancelSpeechInputSchema.parse(input);const receipt=this.load(id);if(active(receipt.snapshot.state)&&input.reason){receipt.snapshot.cancellation=input;this.save(receipt);}const reasons={buffer_full:'音频缓冲已满，录音已停止；已有文字保留',state_unavailable:'转写状态持续不可读，录音已停止；已有文字保留',chunk_receipt_unconfirmed:'音频回执仍未确认，录音已停止；已有文字保留',capture_failed:'录音设备未完成启动；已有文字保留',user:null,closed:null};const error=input.reason?reasons[input.reason]:null;this.finish(id,'cancelled',error);return this.load(id).snapshot;}
  adopt(request:RequestContext,id:string,input:AdoptSpeechInput){
    assertRequestIdentity(this.context,request);const receipt=this.load(id),digest=hash(JSON.stringify(input));if(receipt.snapshot.source_record_id){if(receipt.adoption_hash!==digest)throw new ContractError('IDEMPOTENCY_CONFLICT','此语音已采用，后续请在资料中编辑');return receipt.snapshot;}
    if(receipt.snapshot.state!=='final'||!input.text.trim()||!input.title.trim())throw new ContractError('CAPABILITY_UNVERIFIED','先完成转写并核对候选文字');
    this.refreshCleanup(request,id);const cleaned=this.load(id).snapshot,from=input.adopted_from??'raw';if(from==='cleaned'&&(cleaned.cleanup_state!=='succeeded'||!cleaned.cleaned_text))throw new ContractError('CAPABILITY_UNVERIFIED','整理稿尚未完成，可直接采用原文');
    if(input.topic_id&&!this.context.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,input.topic_id))throw new ContractError('NOT_FOUND','当前主题不存在，请先刷新核对');
    const sources=new Sources(this.context),source=sources.create({...request,idempotency_key:'speech-adopt:'+id},{title:input.title,text:input.text,category:'个人思考'});
    if(input.topic_id)sources.linkTopic({...request,idempotency_key:'speech-link:'+id},input.topic_id,{record_id:source.record_id,usage:'语音口述素材',locator:'speech-input:'+id});
    return transaction(this.context.db,()=>{
      // Keep raw provider text and edited adoption side by side; leave core approval untouched.
      this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.key('source:'+source.record_id),JSON.stringify({speech_input_id:id,provider:receipt.snapshot.provider,model:receipt.snapshot.model,request_id:receipt.snapshot.request_id,log_id:receipt.snapshot.log_id,raw_text:receipt.snapshot.final_text,cleaned_text:cleaned.cleaned_text??null,adopted_from:from,adopted_text:input.text,duration_ms:receipt.snapshot.duration_ms}));
      const latest=this.load(id);latest.snapshot.source_record_id=source.record_id;latest.adoption_hash=digest;if(input.topic_id)latest.snapshot.linked_topic_ids=[input.topic_id];this.save(latest);return latest.snapshot;
    });
  }
  // Links already-adopted material to another topic without re-creating it; the topic_sources insert and per-topic idempotency key make repeats no-ops.
  linkTopic(request:RequestContext,id:string,input:LinkSpeechInputTopic){
    assertRequestIdentity(this.context,request);LinkSpeechInputTopicSchema.parse(input);const receipt=this.load(id),record=receipt.snapshot.source_record_id;if(!record)throw new ContractError('CAPABILITY_UNVERIFIED','先保存为个人素材，再关联主题');
    if(!this.context.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,input.topic_id))throw new ContractError('NOT_FOUND','当前主题不存在，请先刷新核对');
    // Sources.linkTopic owns its transaction (nesting is not supported); the receipt update below is synchronous and idempotent.
    new Sources(this.context).linkTopic({...request,idempotency_key:'speech-link:'+id+':'+input.topic_id},input.topic_id,{record_id:record,usage:'语音口述素材',locator:'speech-input:'+id});
    const latest=this.load(id),linked=latest.snapshot.linked_topic_ids??[];if(!linked.includes(input.topic_id)){latest.snapshot.linked_topic_ids=[...linked,input.topic_id];this.save(latest);}return latest.snapshot;
  }
  close(){for(const id of [...this.live.keys()])this.finish(id,'unknown','主服务已停止，已有文字保留；不会自动重发音频');}
}
