import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {mkdir,copyFile,rename,chmod} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {ContractError,imageGenerationLimit,imageProviderAvailability,ImageGenerationSchema,imageProviderPrompt,type ImageGenerationRequest,type ImageProviderId,type JsonObject,type RequestContext,type GeneratedAssetOutput} from '@workbench/contracts';
import {createImageProvider,validateSizeRequest,type ImageProviderPort,type ImageProviderInput,type ImageProviderResult} from '@workbench/adapters/media/image';
import {decode,metadata,fileHash} from '@workbench/adapters/media/render';
import {canonicalJson,inputHash,sha256,transaction,lookupIdempotency,claimIdempotency,commitIdempotency} from '@workbench/storage/connection';
import {workspaceSettings} from '@workbench/storage/settings';
import {safeManagedChild} from '@workbench/storage/files';
import {queueJobInTransaction,getJob,getAttempt,fenceReason,revokeAttemptInTransaction,appendEvent,type ClaimedJob} from '@workbench/storage/jobs';
import type {ApplicationContext} from '../ports/index.ts';
import {assertRequestIdentity} from '../documents/index.ts';
import {ImageProviderSettings,type ImageProviderSettingsOptions} from '../settings/image-providers.ts';
import {Jobs} from '../jobs/index.ts';
import {controlledPath,verifiedFileHash} from '../result-commit/media.ts';
import {readGenerationBudget,recordGenerationSubmit} from '../../../storage/src/image-studio/index.ts';
// 真实生图提交的生产预算闸门：公众号配图与通用 asset-generations 共用同一工作区计数；须在入队的同一写事务里调用。
export function consumeImageGenerationBudget(context:ApplicationContext,workspace:string,provider:'codex'|'agy'):void {const used=readGenerationBudget(context.db,workspace)[provider],limit=imageGenerationLimit(context.config,provider);if(limit!==null&&used>=limit)throw new ContractError('QUOTA_EXHAUSTED','本渠道真实生图次数已达上限，需人工放开',{provider,used,limit});recordGenerationSubmit(context.db,workspace,provider);}

export interface FrozenImageInput extends ImageGenerationRequest {
  config_version:number;reference_assets:Array<{asset_id:string;file_path:string;sha256:string;size_bytes:number}>;
  brand_manifest:JsonObject;brand_manifest_sha256:string;
  document_binding:{document_id:string;revision_id:string}|null;
  plan_binding:{kind:'content'|'production';plan_id:string;revision_id:string}|null;
}
export interface ImageAssetManifest {schema_version:'image-provider-asset/1';asset_id:string;workspace_id:string;topic_id:string;job_id:string;attempt_id:string;attempt_generation:number;input_hash:string;file_name:string;file_sha256:string;size_bytes:number;mime:string;width:number;height:number;model:string|null;provider:ImageProviderId;native:JsonObject;metadata:JsonObject}
export interface ImageSubmitReceipt {schema_version:'image-provider-submit/1';job_id:string;workspace_id:string;input_hash:string;original_binding:ImageProviderInput['binding'];checkpoint:JsonObject;state:'intent'|'observing'|'result';result:ImageProviderResult|null}
export function publicImageNative(native:JsonObject):JsonObject {return Object.fromEntries(Object.entries(native).filter(([key])=>['schema_version','provider','operation','conversation_id','subagent_conversation_id','image_subagent_id','tool_call_id','thread_id','turn_id','runtime_session_id','runtime_turn_id','output_sha256','image_bytes','fully_decoded','native_status'].includes(key))) as JsonObject;}
export function compactImageNative(native:JsonObject):JsonObject {return {...publicImageNative(native),native_checkpoint_sha256:inputHash(native),...(native.original_binding?{original_binding:native.original_binding}:{}),...(native.request_hash?{request_hash:native.request_hash}:{})};}

export function imageReceiptPath(context:ApplicationContext,jobId:string){return safeManagedChild(context.paths.state_root,join(context.paths.state_root,'image-provider-jobs',jobId,'provider-receipt.json'));}
function durable(path:string,value:unknown,exclusive=false){mkdirSync(dirname(path),{recursive:true});const tmp=exclusive?path:path+'.'+randomUUID()+'.tmp',fd=openSync(tmp,'wx',0o600);try{writeFileSync(fd,canonicalJson(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}if(!exclusive)renameSync(tmp,path);const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
function object(value:unknown):value is JsonObject{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function imageRequestHash(image:FrozenImageInput,binding:ImageProviderInput['binding']){
  return inputHash({provider:image.provider,operation:image.operation,prompt:imageProviderPrompt(image),references:image.reference_assets.map(r=>({asset_id:r.asset_id,sha256:r.sha256})),workspace_id:binding.workspace_id,job_id:binding.job_id,input_hash:binding.input_hash,...(image.size_request?{size_request:image.size_request}:{})});
}
function terminalProof(job:import('@workbench/contracts').JobsRow,attempt:import('@workbench/contracts').JobAttemptsRow,receipt:ImageSubmitReceipt):boolean{
  try{
    const checkpoint=JSON.parse(attempt.checkpoint),proof=checkpoint.image_terminal_proof,result=receipt.result;
    if('image_terminal_proof_required' in checkpoint&&checkpoint.image_terminal_proof_required!==true)return false;
    return object(proof)&&object(proof.original_binding)&&object(proof.verifier_binding)&&!!result&&proof.schema_version==='image-terminal-proof/1'&&
      canonicalJson(proof.original_binding)===canonicalJson(receipt.original_binding)&&
      canonicalJson(proof.verifier_binding)===canonicalJson({workspace_id:job.workspace_id,job_id:job.id,attempt_id:attempt.id,attempt_generation:attempt.attempt_generation,input_hash:job.input_hash})&&
      proof.verifier_lease_owner===attempt.lease_owner&&proof.native_sha256===inputHash(result.native)&&proof.result_sha256===inputHash(result);
  }catch{return false;}
}
function legacyResultReadable(context:ApplicationContext,job:import('@workbench/contracts').JobsRow,receipt:ImageSubmitReceipt):boolean{
  if(job.state!=='succeeded')return false;
  try{
    // Any modern submission/proof marker excludes legacy, including null, corrupt or deleted proof values.
    const attempts=context.db.prepare('SELECT checkpoint FROM job_attempts WHERE workspace_id=? AND job_id=?').all(job.workspace_id,job.id);
    if(attempts.some(row=>{const cp=JSON.parse(String(row.checkpoint));return !object(cp)||['image_submit_binding','image_request_hash','image_terminal_proof','image_terminal_proof_required'].some(key=>key in cp);}))return false;
    const rows=context.db.prepare("SELECT a.id,a.sha256,a.size_bytes,a.generation_metadata,t.checkpoint,r.output_payload FROM assets a JOIN result_receipts r ON r.workspace_id=a.workspace_id AND r.job_id=a.job_id JOIN job_attempts t ON t.workspace_id=r.workspace_id AND t.id=r.attempt_id AND t.job_id=r.job_id WHERE a.workspace_id=? AND a.job_id=? AND a.kind='image' AND a.status='ready' AND r.state='committed'").all(job.workspace_id,job.id);
    return rows.some(row=>{
      const cp=JSON.parse(String(row.checkpoint)),payload=JSON.parse(String(row.output_payload));
      if(cp.phase!=='image_verified'||cp.asset_id!==row.id||!receipt.result)return false;
      const outputs=payload.typed_output?.generated_assets;if(!Array.isArray(outputs)||outputs.length!==1||outputs[0]?.asset_id!==row.id)return false;
      const media=workspaceSettings(context.db,job.workspace_id).paths.media_root,path=controlledPath(media,join(media,'image-provider',String(row.id),'manifest.json'));
      if(resolve(outputs[0].manifest_path)!==path)return false;
      const bytes=verifiedFileHash(path);if(bytes.size>1024*1024||bytes.sha256!==outputs[0].sha256)return false;
      const manifest=JSON.parse(readFileSync(path,'utf8')) as ImageAssetManifest,result=receipt.result;
      // Old provenance is pinned by the committed SQL output's manifest hash and asset metadata, not resealed files.
      return manifest.job_id===job.id&&manifest.asset_id===row.id&&manifest.native.native_checkpoint_sha256===inputHash(result.native)&&
        manifest.file_sha256===row.sha256&&manifest.size_bytes===Number(row.size_bytes)&&result.sha256===manifest.file_sha256&&result.size_bytes===manifest.size_bytes&&result.mime===manifest.mime&&result.width===manifest.width&&result.height===manifest.height&&result.model===manifest.model&&
        canonicalJson(manifest.metadata)===canonicalJson(JSON.parse(String(row.generation_metadata)))&&canonicalJson(result.usage)===canonicalJson(manifest.metadata.actual_usage);
    });
  }catch{return false;}
}
export function verifyImageTerminalProof(context:ApplicationContext,job:import('@workbench/contracts').JobsRow,attempt:import('@workbench/contracts').JobAttemptsRow,receipt:ImageSubmitReceipt){
  const current=getAttempt(context.db,job.workspace_id,attempt.id);
  if(current.job_id===job.id&&terminalProof(job,current,receipt))return;
  if(legacyResultReadable(context,job,receipt))return; // Only pinned pre-proof legacy assets, never proof-bearing records.
  throw new ContractError('RESULT_UNKNOWN','图片终态缺少当前有效验证代次的 SQLite 原生证明',{no_new_submit:true});
}
export function readImageReceipt(context:ApplicationContext,jobId:string,input_hash:string):ImageSubmitReceipt {
  const path=controlledPath(context.paths.state_root,imageReceiptPath(context,jobId)),record=JSON.parse(readFileSync(path,'utf8')) as ImageSubmitReceipt;
  const bad=():never=>{throw new ContractError('RESULT_UNKNOWN','图像原提交身份无法交叉核实，未发送新请求',{no_new_submit:true});};
  if(!object(record)||record.schema_version!=='image-provider-submit/1'||record.job_id!==jobId||record.workspace_id!==context.identity.workspace_id||record.input_hash!==input_hash||!object(record.original_binding)||!['intent','observing','result'].includes(record.state))return bad();
  const binding=record.original_binding,job=getJob(context.db,context.identity.workspace_id,jobId),body=JSON.parse(job.input_manifest),image=body.image as FrozenImageInput;
  if(job.state==='succeeded'&&record.state!=='result')return bad();
  if(body.operation!=='image_provider'||inputHash(body)!==input_hash||job.input_hash!==input_hash||binding.job_id!==jobId||binding.workspace_id!==job.workspace_id||binding.input_hash!==input_hash||typeof binding.attempt_id!=='string'||!Number.isSafeInteger(binding.attempt_generation)||binding.attempt_generation<1)return bad();
  const original=context.db.prepare('SELECT * FROM job_attempts WHERE workspace_id=? AND id=? AND job_id=? AND attempt_generation=?').get(job.workspace_id,binding.attempt_id,jobId,binding.attempt_generation);
  if(!original)return bad();
  const authority=JSON.parse(String(original.checkpoint)),requestHash=imageRequestHash(image,binding);
  if(['image_submit_binding','image_request_hash','image_terminal_proof','image_terminal_proof_required'].some(key=>key in authority)){
    if(!object(authority.image_submit_binding)||canonicalJson(authority.image_submit_binding)!==canonicalJson(binding)||authority.image_request_hash!==requestHash||'image_terminal_proof_required' in authority&&authority.image_terminal_proof_required!==true)return bad();
  }else{
    // Read-only compatibility for an already committed r2 asset, never admission of an old unknown submit.
    const saved=context.db.prepare("SELECT a.id FROM assets a JOIN result_receipts r ON r.workspace_id=a.workspace_id AND r.job_id=a.job_id WHERE a.workspace_id=? AND a.job_id=? AND a.id=? AND a.status='ready' AND r.attempt_id=? AND r.state='committed'").get(job.workspace_id,jobId,authority.asset_id??'',binding.attempt_id);
    if(job.state!=='succeeded'||authority.phase!=='image_verified'||!saved||!legacyResultReadable(context,job,record))return bad();
  }
  const validateNative=(native:unknown)=>{
    if(!object(native)||!object(native.original_input)||!object(native.original_binding))return bad();
    const input=native.original_input as unknown as ImageProviderInput;
    if(native.provider!==image.provider||native.operation!==image.operation||native.input_hash!==input_hash||native.request_hash!==requestHash||canonicalJson(native.original_binding)!==canonicalJson(binding)||!object(input.binding)||canonicalJson(input.binding)!==canonicalJson(binding)||input.provider!==image.provider||input.operation!==image.operation||input.prompt!==imageProviderPrompt(image)||canonicalJson(input.references)!==canonicalJson(image.reference_assets)||canonicalJson(input.size_request??null)!==canonicalJson(image.size_request??null))return bad();
    const stored=authority.image_checkpoint;
    if(object(stored))for(const key of ['conversation_id','thread_id','turn_id','tool_call_id','image_child_id'])if(typeof stored[key]==='string'&&native[key]!==stored[key])return bad();
  };
  if(!object(record.checkpoint))return bad();
  if(record.state!=='intent'||Object.keys(record.checkpoint).length)validateNative(record.checkpoint);
  if(record.state==='result'){
    if(!object(record.result))return bad();validateNative(record.result.native);
    for(const key of ['conversation_id','thread_id','turn_id','tool_call_id','image_child_id'])if(typeof record.checkpoint[key]==='string'&&record.result.native[key]!==record.checkpoint[key])return bad();
    // Successful reads must use the committed verifier, not an unrelated historical attempt's valid proof.
    const verifiers=(job.state==='succeeded'?context.db.prepare("SELECT t.* FROM job_attempts t JOIN result_receipts r ON r.workspace_id=t.workspace_id AND r.attempt_id=t.id AND r.job_id=t.job_id WHERE t.workspace_id=? AND t.job_id=? AND r.state='committed' AND r.attempt_generation=t.attempt_generation AND r.input_hash=?").all(job.workspace_id,job.id,job.input_hash):context.db.prepare('SELECT * FROM job_attempts WHERE workspace_id=? AND job_id=?').all(job.workspace_id,job.id)) as unknown as import('@workbench/contracts').JobAttemptsRow[];
    if(!verifiers.some(attempt=>terminalProof(job,attempt,record))&&!legacyResultReadable(context,job,record))return bad();
  }else if(record.result!==null)return bad();
  return record;
}
export function assertCurrentImageInputs(context:ApplicationContext,image:FrozenImageInput){
  if(image.document_binding){const row=context.db.prepare('SELECT head_revision_id FROM documents WHERE workspace_id=? AND id=?').get(context.identity.workspace_id,image.document_binding.document_id);if(!row||row.head_revision_id!==image.document_binding.revision_id)throw new ContractError('INPUT_STALE','人工文稿已变化，旧图片结果不能关联到新稿');}
  if(image.plan_binding){const b=image.plan_binding,table=b.kind==='content'?'content_plans':'production_plans',head=b.kind==='content'?'head_content_revision_id':'head_plan_revision_id';const row=context.db.prepare(`SELECT ${head} AS head FROM ${table} WHERE workspace_id=? AND id=?`).get(context.identity.workspace_id,b.plan_id);if(!row||row.head!==b.revision_id)throw new ContractError('INPUT_STALE','制作计划已变化，旧图片结果不能采用');}
  for(const ref of image.reference_assets){const row=context.db.prepare("SELECT sha256,status,file_path FROM assets WHERE workspace_id=? AND id=? AND kind='image'").get(context.identity.workspace_id,ref.asset_id);if(!row||row.sha256!==ref.sha256||row.status!=='ready'||row.file_path!==ref.file_path)throw new ContractError('INPUT_STALE','参考图身份或版本变化');const actual=verifiedFileHash(controlledPath(context.paths.media_root,ref.file_path));if(actual.sha256!==ref.sha256||actual.size!==ref.size_bytes)throw new ContractError('INPUT_STALE','参考图文件发生变化');}
}
export class ImageGenerationWorkflow {
  readonly context:ApplicationContext;readonly options:{provider?:(id:ImageProviderId)=>ImageProviderPort;brand_path?:string;provider_settings?:ImageProviderSettingsOptions};
  constructor(context:ApplicationContext,options:{provider?:(id:ImageProviderId)=>ImageProviderPort;brand_path?:string;provider_settings?:ImageProviderSettingsOptions}={}){this.context=context;this.options=options;}
  // 「已配置」指本机命令行存在；注入了 provider 端口时不经命令行，视为已配置。
  providerSettings(){return new ImageProviderSettings(this.context,{...(this.options.provider?{configured:()=>true}:{}),...this.options.provider_settings});}
  // 服务端提交前的统一可用判定（与弹窗、设置页同一函数）：未启用/未配置/执行器额度或登录/验证明确失败一律拒绝，不入队、不计预算。
  // 预算用完交给入队事务里的预算闸门（它对复用已有同输入任务不计数）。
  async assertProviderAvailable(request:RequestContext,provider:ImageProviderId):Promise<void>{
    const channel=(await this.providerSettings().read(request)).channels.find(c=>c.provider===provider);if(!channel)throw new ContractError('CAPABILITY_UNVERIFIED','所选图像渠道不存在');
    const a=imageProviderAvailability(channel);if(a.selectable||a.block==='budget')return;
    if(a.block==='quota')throw new ContractError('QUOTA_EXHAUSTED','所选图像渠道额度暂不可用，未提交生图',{provider,pre_submit_failure:true});
    if(a.block==='login')throw new ContractError('AUTH_REQUIRED','所选图像渠道需要重新登录，未提交生图',{provider,pre_submit_failure:true});
    throw new ContractError('CAPABILITY_UNVERIFIED',a.block==='disabled'?'先在 AI 设置启用所选图像渠道':a.block==='unconfigured'?'本机未找到所选图像渠道的命令行工具，未提交生图':a.block==='probe_failed'?(a.detail??'所选图像渠道连接验证未通过')+'，未提交生图':'所选图像渠道暂不支持，未提交生图',{provider,pre_submit_failure:true});
  }
  private provider(id:ImageProviderId){return this.options.provider?.(id)??createImageProvider(id);}
  enqueue(request:RequestContext,input:ImageGenerationRequest):{job_id:string;state:string;input_hash:string}{
    assertRequestIdentity(this.context,request);ImageGenerationSchema.parse(input);if(!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','缺少Idempotency-Key');
    return transaction(this.context.db,()=>this.enqueueInTransaction(request,input));
  }
  // 对外 HTTP 入口：幂等重放与已有同输入任务直接返回；只对真正新入队的任务扣预算，计数与入队同事务提交或回滚。
  async enqueueBudgeted(request:RequestContext,input:ImageGenerationRequest):Promise<{job_id:string;state:string;input_hash:string}>{
    assertRequestIdentity(this.context,request);ImageGenerationSchema.parse(input);if(!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','缺少Idempotency-Key');
    if(lookupIdempotency(this.context.db,request.workspace_id,'image.generate',request.idempotency_key,input)?.state!=='committed')await this.assertProviderAvailable(request,input.provider);
    return transaction(this.context.db,()=>this.enqueueInTransaction(request,input,()=>consumeImageGenerationBudget(this.context,request.workspace_id,input.provider)));
  }
  enqueueInTransaction(request:RequestContext,input:ImageGenerationRequest,beforeNewJob?:()=>void):{job_id:string;state:string;input_hash:string}{
    if(!this.context.db.isTransaction)throw new Error('Image enqueue requires the caller transaction');
    assertRequestIdentity(this.context,request);ImageGenerationSchema.parse(input);if(!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','缺少Idempotency-Key');
      const old=lookupIdempotency(this.context.db,request.workspace_id,'image.generate',request.idempotency_key!,input);if(old?.state==='committed')return old.response as unknown as {job_id:string;state:string;input_hash:string};
      const settings=new ImageProviderSettings(this.context);settings.assertEnabled(input.provider);if(input.size_request)validateSizeRequest(input.size_request);
      if(input.operation==='reference_edit'&&input.provider!=='agy')throw new ContractError('CAPABILITY_UNVERIFIED','Codex参考编辑尚未准入');
      if(!this.context.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,input.topic_id))throw new ContractError('NOT_FOUND','图片所属主题不存在');
      const refs=input.input_asset_ids.map(id=>{const row=this.context.db.prepare("SELECT id,file_path,sha256,size_bytes FROM assets WHERE workspace_id=? AND id=? AND kind='image' AND status='ready'").get(request.workspace_id,id);if(!row)throw new ContractError('NOT_FOUND','参考图片不存在或未就绪');return{asset_id:String(row.id),file_path:String(row.file_path),sha256:String(row.sha256),size_bytes:Number(row.size_bytes),...(input.studio_binding?.references.find(ref=>ref.asset_id===id)?.purpose?{purpose:input.studio_binding.references.find(ref=>ref.asset_id===id)!.purpose}:{})};});
      let document_binding:FrozenImageInput['document_binding']=null,plan_binding:FrozenImageInput['plan_binding']=null;
      if(input.document_revision_id){const row=this.context.db.prepare('SELECT r.document_id FROM document_revisions r JOIN documents d ON d.workspace_id=r.workspace_id AND d.id=r.document_id WHERE r.workspace_id=? AND r.id=? AND (d.owner_entity_id=? OR d.owner_entity_id IN (SELECT id FROM variants WHERE workspace_id=? AND topic_id=?))').get(request.workspace_id,input.document_revision_id,input.topic_id,request.workspace_id,input.topic_id);if(!row)throw new ContractError('NOT_FOUND','引用文稿修订不属于当前主题');document_binding={document_id:String(row.document_id),revision_id:input.document_revision_id};}
      if(input.plan_revision_id){const content=this.context.db.prepare('SELECT r.plan_id FROM content_plan_revisions r JOIN content_plans p ON p.workspace_id=r.workspace_id AND p.id=r.plan_id JOIN variants v ON v.workspace_id=p.workspace_id AND v.id=p.variant_id WHERE r.workspace_id=? AND r.id=? AND v.topic_id=?').get(request.workspace_id,input.plan_revision_id,input.topic_id);const production=content?undefined:this.context.db.prepare('SELECT r.plan_id FROM production_plan_revisions r JOIN production_plans p ON p.workspace_id=r.workspace_id AND p.id=r.plan_id WHERE r.workspace_id=? AND r.id=? AND p.topic_id=?').get(request.workspace_id,input.plan_revision_id,input.topic_id);if(!content&&!production)throw new ContractError('NOT_FOUND','引用计划修订不属于当前主题');plan_binding={kind:content?'content':'production',plan_id:String((content??production)!.plan_id),revision_id:input.plan_revision_id};}
      const brand=readFileSync(this.options.brand_path??resolve(import.meta.dirname,'../../../../assets/visual-theme.json'));
      const image:FrozenImageInput={...input,config_version:settings.stored().version,reference_assets:refs,brand_manifest:JSON.parse(brand.toString()),brand_manifest_sha256:sha256(brand),document_binding,plan_binding};assertCurrentImageInputs(this.context,image);
      const manifest={schema_version:'image-provider/1',mode:'none',targets:[],source_ids:[],operation:'image_provider',image:image as unknown as JsonObject};
      const frozenHash=inputHash(manifest),active=new Set(['queued','running','waiting_input','waiting_quota','cancel_requested','reconciling']);
      // The IMMEDIATE transaction serializes lookup+insert across connections and fresh keys.
      const candidates=this.context.db.prepare("SELECT * FROM jobs WHERE workspace_id=? AND kind='media_generate' AND target_id=? AND input_hash=? AND state<>'succeeded' ORDER BY created_at,id").all(request.workspace_id,input.topic_id,frozenHash) as unknown as import('@workbench/contracts').JobsRow[];
      const existing=candidates.find(job=>active.has(job.state)||existsSync(imageReceiptPath(this.context,job.id)));
      const idem=claimIdempotency(this.context.db,request.workspace_id,'image.generate',request.idempotency_key!,input);
      if(!existing)beforeNewJob?.();
      const job=existing??queueJobInTransaction(this.context.db,request.workspace_id,{kind:'media_generate',target_id:input.topic_id,entrypoint:'standalone_web',execution_mode:'programmatic',input_manifest:manifest,retry_policy:{recovery:'media',max_attempts:1},presentation:'foreground_dialog'},Date.now());
      const result={job_id:job.id,state:job.state,input_hash:job.input_hash};commitIdempotency(this.context.db,request.workspace_id,idem.id,result);return result;
  }
  recover(request:RequestContext,id:string,expected_version:number):{job_id:string;state:string}{
    assertRequestIdentity(this.context,request);if(!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','缺少Idempotency-Key');const replay=lookupIdempotency(this.context.db,request.workspace_id,'image.query',request.idempotency_key,{id,expected_version});if(replay?.state==='committed')return replay.response as unknown as {job_id:string;state:string};const job=getJob(this.context.db,request.workspace_id,id),body=JSON.parse(job.input_manifest);
    if(body.operation!=='image_provider'||job.cancel_requested_at||!['reconciling','waiting_input','failed'].includes(job.state))throw new ContractError('HOST_RUN_NOT_CURRENT','图片任务不处于可查询状态');
    if(job.version!==expected_version)throw new ContractError('VERSION_CONFLICT','图片任务状态已变化');
    if(!existsSync(imageReceiptPath(this.context,id)))throw new ContractError('RESULT_UNKNOWN','原任务没有可核对的提交身份，未重复提交');
    const receipt=readImageReceipt(this.context,id,job.input_hash);if(receipt.state==='intent'&&!Object.keys(receipt.checkpoint).length)throw new ContractError('RESULT_UNKNOWN','原提交尚未取得原生身份，需人工核对，未重复提交');
    return transaction(this.context.db,()=>{const old=lookupIdempotency(this.context.db,request.workspace_id,'image.query',request.idempotency_key!,{id,expected_version});if(old?.state==='committed')return old.response as unknown as {job_id:string;state:string};const idem=claimIdempotency(this.context.db,request.workspace_id,'image.query',request.idempotency_key!,{id,expected_version});const current=getJob(this.context.db,request.workspace_id,id);if(current.version!==expected_version||current.cancel_requested_at)throw new ContractError('VERSION_CONFLICT','图片任务状态已变化');const next=revokeAttemptInTransaction(this.context.db,request.workspace_id,id,'IMAGE_QUERY_ONLY','superseded','queued',Date.now());appendEvent(this.context.db,request.workspace_id,id,'queued',{recovery:'query_only',new_submit:false},Date.now());const result={job_id:id,state:next.state};commitIdempotency(this.context.db,request.workspace_id,idem.id,result);return result;});
  }
  async execute(claim:ClaimedJob,signal:AbortSignal,checkpoint:(value:JsonObject)=>void):Promise<GeneratedAssetOutput>{
    const body=JSON.parse(claim.job.input_manifest);if(body.operation!=='image_provider'||inputHash(body)!==claim.job.input_hash)throw new ContractError('INPUT_STALE','图片任务固定输入无效');
    const image=body.image as FrozenImageInput,paths=workspaceSettings(this.context.db,claim.job.workspace_id).paths,asset=randomUUID();
    const stage=safeManagedChild(paths.state_root,join(paths.state_root,'image-staging',asset)),root=safeManagedChild(paths.media_root,join(paths.media_root,'image-provider',asset)),recordPath=imageReceiptPath(this.context,claim.job.id);
    const check=()=>{signal.throwIfAborted();const job=getJob(this.context.db,claim.job.workspace_id,claim.job.id),attempt=getAttempt(this.context.db,job.workspace_id,claim.attempt.id);if(fenceReason(job,attempt,claim.fence,Date.now())||attempt.lease_owner!==claim.fence.lease_owner)throw new ContractError('HOST_RUN_NOT_CURRENT','图片提交权已撤销');assertCurrentImageInputs(this.context,image);};
    let promoted=false,submitted=existsSync(recordPath);const newIntent=!submitted;
    try{
      check();if(!submitted){const current=new ImageProviderSettings(this.context);current.assertEnabled(image.provider);if(current.stored().version!==image.config_version)throw new ContractError('INPUT_STALE','图像配置已变化，未提交旧配置任务');}
      await mkdir(stage,{recursive:true});const input:ImageProviderInput={provider:image.provider,operation:image.operation,prompt:imageProviderPrompt(image),references:image.reference_assets,...(image.size_request?{size_request:image.size_request}:{}),binding:{workspace_id:claim.job.workspace_id,job_id:claim.job.id,attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,input_hash:claim.job.input_hash},work_directory:join(paths.state_root,'image-provider-jobs',claim.job.id,'workspace'),output_directory:stage};await mkdir(input.work_directory,{recursive:true});
      let receipt:ImageSubmitReceipt;
      if(submitted)receipt=readImageReceipt(this.context,claim.job.id,claim.job.input_hash);
      else{receipt={schema_version:'image-provider-submit/1',job_id:claim.job.id,workspace_id:claim.job.workspace_id,input_hash:claim.job.input_hash,original_binding:input.binding,checkpoint:{},state:'intent',result:null};durable(recordPath,receipt,true);submitted=true;}
      const binding=receipt.original_binding,requestHash=imageRequestHash(image,binding);
      checkpoint({phase:'image_submit_intent',provider:image.provider,image_terminal_proof_required:true,image_submit_binding:binding,image_request_hash:requestHash,image_checkpoint:receipt.checkpoint,message:'图像提交身份已绑定持久执行代次'});
      const save=(value:JsonObject)=>{check();receipt={...receipt,state:'observing',checkpoint:value};durable(recordPath,receipt);checkpoint({phase:'image_provider',provider:image.provider,image_terminal_proof_required:true,image_submit_binding:binding,image_request_hash:requestHash,image_checkpoint:value,message:'原生图片任务身份已持久保存'});};
      const provider=this.provider(image.provider),result=newIntent?await provider.execute(input,{signal,checkpoint:save}):await provider.query(input,receipt.checkpoint,signal);
      check();
      // Only the adapter's newly verified return value can mint this SQL proof, under the real verifier fence.
      // The full native digest covers terminal tool/selected child/child arrays/typed payload and all other fields.
      const terminal:JsonObject={schema_version:'image-terminal-proof/1',original_binding:binding,verifier_binding:input.binding,verifier_lease_owner:claim.fence.lease_owner,native_sha256:inputHash(result.native),result_sha256:inputHash(result),native_identity:Object.fromEntries(Object.entries(result.native).filter(([key])=>['provider','operation','conversation_id','child_ids','image_child_id','tool_call_id','native_payload_sha256','thread_id','turn_id','image_item_ids','output_sha256'].includes(key)))};
      checkpoint({phase:'image_provider_result',provider:image.provider,image_terminal_proof_required:true,image_submit_binding:binding,image_request_hash:requestHash,image_checkpoint:receipt.checkpoint,image_terminal_proof:terminal,message:'已验证原生终态证明绑定当前持久验证代次'});
      receipt={...receipt,state:'result',result};durable(recordPath,receipt);readImageReceipt(this.context,claim.job.id,claim.job.input_hash);check();
      const extension=result.mime==='image/png'?'png':result.mime==='image/jpeg'?'jpg':null;if(!extension)throw new ContractError('VALIDATION_ERROR','图片结果不是已准入PNG/JPEG');
      const file_name='image.'+extension,file=join(stage,file_name);if(resolve(result.file_path)!==resolve(file))await copyFile(result.file_path,file);await decode(file,{signal});const info=await metadata(file,{signal}),stream=(info.streams as JsonObject[]).find(v=>v.codec_type==='video');
      const actual=verifiedFileHash(file);if(!stream||Number(stream.width)!==result.width||Number(stream.height)!==result.height||actual.sha256!==result.sha256||actual.size!==result.size_bytes||!Number.isSafeInteger(result.width)||result.width<1||result.height<1)throw new ContractError('VALIDATION_ERROR','图片解码、尺寸或hash不符');
      const native=compactImageNative(result.native),publicNative=publicImageNative(native);
      const meta:JsonObject={source_kind:'image_provider',provider:image.provider,operation:image.operation,purpose:image.purpose,prompt:image.prompt,model:result.model,native:publicNative,reference_assets:image.reference_assets.map(r=>({asset_id:r.asset_id,sha256:r.sha256})),parent_asset_id:image.parent_asset_id,brand_manifest_sha256:image.brand_manifest_sha256,brand_manifest:image.brand_manifest,document_revision_id:image.document_revision_id,plan_revision_id:image.plan_revision_id,config_version:image.config_version,job_id:claim.job.id,version_id:asset,full_decode:true,actual_usage:result.usage,actual_cost:null,adoption:'pending',publishable:false,...(image.size_request?{requested_size:image.size_request,accepted_image_parameters:result.native.accepted_image_parameters??null}:{}),...(image.studio_binding?{studio_binding:image.studio_binding}:{})};
      const manifest:ImageAssetManifest={schema_version:'image-provider-asset/1',asset_id:asset,workspace_id:claim.job.workspace_id,topic_id:image.topic_id,job_id:claim.job.id,attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,input_hash:claim.job.input_hash,file_name,file_sha256:actual.sha256,size_bytes:actual.size,mime:result.mime,width:result.width,height:result.height,model:result.model,provider:image.provider,native,metadata:meta};durable(join(stage,'manifest.json'),manifest);check();await mkdir(dirname(root),{recursive:true});await rename(stage,root);promoted=true;await chmod(join(root,file_name),0o444);await chmod(join(root,'manifest.json'),0o444);check();checkpoint({phase:'image_verified',provider:image.provider,image_terminal_proof_required:true,image_submit_binding:binding,image_request_hash:requestHash,image_checkpoint:receipt.checkpoint,image_terminal_proof:terminal,asset_id:asset,message:'图片已解码；等待有效代次收据提交'});return{asset_id:asset,manifest_path:join(root,'manifest.json'),sha256:await fileHash(join(root,'manifest.json'),signal)};
    }catch(error){const source=promoted?root:stage;if(existsSync(source)){const quarantine=safeManagedChild(paths.state_root,join(paths.state_root,'image-quarantine',asset));await mkdir(dirname(quarantine),{recursive:true});await rename(source,quarantine);}
      try{const job=getJob(this.context.db,claim.job.workspace_id,claim.job.id),attempt=getAttempt(this.context.db,job.workspace_id,claim.attempt.id);if(!fenceReason(job,attempt,claim.fence,Date.now()))new Jobs(this.context).fail(claim.fence,{code:error instanceof ContractError?error.code:'IMAGE_UNAVAILABLE',message:error instanceof ContractError?error.message:'图片任务未取得可核对终态',submitted,new_submit:false},submitted?'reconciling':'waiting_input');}catch{}throw error;
    }
  }
}
