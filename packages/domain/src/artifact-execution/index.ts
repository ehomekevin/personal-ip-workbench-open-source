import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, chmodSync, readFileSync, openSync, closeSync, fsyncSync, readdirSync } from 'node:fs';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError, type ArtifactsRow, type JsonObject, type RequestContext } from '@workbench/contracts';
import { LocalRenderer, LOCAL_PRESET, RENDERER, fileHash, type LocalRenderInput } from '@workbench/adapters/media/render';
import { present, recordVerifiedOutput, verifyRenderedOutput, recordIsolation, verifyIsolation } from './cancellation-proof.ts';
import { H3Readiness } from '@workbench/adapters/media/h3';
import type { ApplicationContext } from '../ports/index.ts';
import { assertRequestIdentity } from '../documents/index.ts';
import { Jobs } from '../jobs/index.ts';
import { ContentPlans } from '../content-plans/index.ts';
import { ProductionPlans } from '../production-plans/index.ts';
import type { FrozenPlanInput, ResolvedPlanInput } from '../content-plans/types.ts';
import { canonicalJson, inputHash, sha256, transaction, lookupIdempotency, claimIdempotency, commitIdempotency } from '@workbench/storage/connection';
import { ensureManagedDirectory, safeManagedChild } from '@workbench/storage/files';
import { workspaceSettings } from '@workbench/storage/settings';
import { getJob, getAttempt, fenceReason, appendEvent, type ClaimedJob } from '@workbench/storage/jobs';
import type { ArtifactManifest, ArtifactOutput, RenderRequest } from './types.ts';
export type { ArtifactManifest, ArtifactOutput, RenderRequest, MediaProgress, MediaImportMetadata } from './types.ts';
export { MediaImporter } from './import.ts';
export { H3VoiceWorkflow } from './voice.ts';
export const MEDIA_REGISTRATION={kind:'media_generate',execution_mode:'programmatic' as const,recovery:'media' as const};
function clean(value:unknown):unknown { if(Array.isArray(value))return value.map(clean); if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['file_path','resolved_texts'].includes(key)).map(([key,v])=>[key,clean(v)])); return value; }
export class ArtifactExecution {
  readonly context:ApplicationContext;readonly renderer:LocalRenderer;
  constructor(context:ApplicationContext,options:{renderer?:LocalRenderer}={}) {this.context=context;this.renderer=options.renderer??new LocalRenderer();}
  private root():string {return join(workspaceSettings(this.context.db,this.context.identity.workspace_id).paths.media_root,'artifacts');}
  private request():RequestContext {return {...this.context.identity,request_id:randomUUID(),idempotency_key:null,request_identity_ref:'media-worker'};}
  private async resolved(request:RequestContext,kind:'content'|'production',planId:string,revisionId:string,preset:string):Promise<ResolvedPlanInput> { return kind==='content'?new ContentPlans(this.context).assertRenderable(request,planId,revisionId,{preset,renderer:RENDERER}):new ProductionPlans(this.context).assertRenderable(request,planId,revisionId,{preset,renderer:RENDERER}); }
  enqueueGeneration(request:RequestContext,input:{topic_id:string;purpose:string;prompt:string;input_asset_ids:string[];generator:string}):{job_id:string;state:string} {
    assertRequestIdentity(this.context,request); if(input.generator!=='h3'||!input.purpose.trim()||!input.prompt.trim()||!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','H3请求目的、prompt、generator与Idempotency-Key必须提供');
    if(!this.context.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,input.topic_id))throw new ContractError('NOT_FOUND','H3主题不存在');
    const assets=input.input_asset_ids.map(id=>{const row=this.context.db.prepare('SELECT id,sha256,size_bytes FROM assets WHERE workspace_id=? AND id=?').get(request.workspace_id,id);if(!row)throw new ContractError('NOT_FOUND','H3输入素材不存在');return{asset_id:String(row.id),sha256:String(row.sha256),size_bytes:Number(row.size_bytes)};});
    return transaction(this.context.db,()=>{const body={...input,assets},old=lookupIdempotency(this.context.db,request.workspace_id,'media.h3',request.idempotency_key!,body);if(old?.state==='committed')return old.response as unknown as {job_id:string;state:string};const idem=claimIdempotency(this.context.db,request.workspace_id,'media.h3',request.idempotency_key!,body);const job=queueMedia(this.context,request,input.topic_id,{schema_version:'wp19-media/1',mode:'none',targets:[],source_ids:[],operation:'h3',generation:body});const result={job_id:job.id,state:job.state};commitIdempotency(this.context.db,request.workspace_id,idem.id,result);return result;});
  }
  async enqueue(request:RequestContext,kind:'content'|'production',planId:string,input:RenderRequest):Promise<{job_id:string;input_hash:string;state:string}> {
    assertRequestIdentity(this.context,request); if(input.preset!==LOCAL_PRESET||!['preview','export'].includes(input.mode))throw new ContractError('CAPABILITY_UNVERIFIED','媒体preset/mode未准入');
    if(!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','缺少Idempotency-Key');
    // 即使素材当前不可达也固定任务，worker持久记录waiting_input，不改旧产物。
    const frozen=kind==='content'?new ContentPlans(this.context).getFrozenInput(request,planId,input.revision_id):new ProductionPlans(this.context).getFrozenInput(request,planId,input.revision_id);
    if(frozen.preset!==input.preset||frozen.renderer.id!==RENDERER.id||frozen.renderer.version!==RENDERER.version)throw new ContractError('INPUT_STALE','请求preset/renderer与计划不符');
    const manifest:JsonObject={schema_version:'wp19-media/1',mode:'none',targets:[],source_ids:[],operation:'render',render_mode:input.mode,frozen_input:frozen as unknown as JsonObject};
    return transaction(this.context.db,()=>{const old=lookupIdempotency(this.context.db,request.workspace_id,'media.render',request.idempotency_key!,{kind,planId,input});if(old?.state==='committed')return old.response as unknown as {job_id:string;input_hash:string;state:string};const idem=claimIdempotency(this.context.db,request.workspace_id,'media.render',request.idempotency_key!,{kind,planId,input});
      // Jobs.enqueue自带事务，直接使用公共storage队列port保持本次幂等原子性。
      const job=this.queue(request,planId,manifest); const result={job_id:job.id,input_hash:frozen.input_hash,state:job.state};commitIdempotency(this.context.db,request.workspace_id,idem.id,result);return result;});
  }
  private queue(request:RequestContext,planId:string,manifest:JsonObject) {return queueMedia(this.context,request,planId,manifest);}
  async execute(claim:ClaimedJob,signal:AbortSignal,checkpoint:(value:JsonObject)=>void):Promise<ArtifactOutput[]> {
    const body=JSON.parse(claim.job.input_manifest) as {operation:string;frozen_input:FrozenPlanInput;render_mode:'preview'|'export'};
    if(body.operation==='h3'){try{await new H3Readiness().submit({});}catch(error){new Jobs(this.context).fail(claim.fence,{code:'CAPABILITY_UNVERIFIED',message:'H3缺当前provider配置、本人输入与付费调用授权',paid_api_calls_made:0},'waiting_input');throw error;}}
    if(body.operation!=='render'||inputHash(JSON.parse(claim.job.input_manifest))!==claim.job.input_hash)throw new ContractError('VALIDATION_ERROR','媒体任务固定输入无效');
    const frozen=body.frozen_input, artifactId=randomUUID(), paths=workspaceSettings(this.context.db,this.context.identity.workspace_id).paths;ensureManagedDirectory(paths.media_root);ensureManagedDirectory(paths.state_root);
    const stage=safeManagedChild(paths.state_root,join(paths.state_root,'media-staging',artifactId)), final=safeManagedChild(paths.media_root,join(this.root(),artifactId));await mkdir(stage,{recursive:true});let promoted=false,rendererSettled=false;const begin=Date.now();
    const check=()=>{signal.throwIfAborted();const job=getJob(this.context.db,this.context.identity.workspace_id,claim.job.id),attempt=getAttempt(this.context.db,job.workspace_id,claim.attempt.id),reason=fenceReason(job,attempt,claim.fence,Date.now());if(reason||attempt.lease_owner!==claim.fence.lease_owner)throw new ContractError('HOST_RUN_NOT_CURRENT','媒体提交权已撤销',{reason:reason??'OWNER_MISMATCH'});};
    try {check();const resolved=await this.resolved(this.request(),frozen.plan_kind,frozen.plan_id,frozen.plan_revision_id,frozen.preset);if(resolved.input_hash!==frozen.input_hash)throw new ContractError('INPUT_STALE','冻结计划输入变化');
      const renderInput=this.renderInput(resolved,artifactId,body.render_mode);const result=await this.renderer.render(renderInput,stage,{signal,progress:(phase,completed,total)=>{check();const value:JsonObject={phase,completed,total,unit:'steps',elapsed_ms:Date.now()-begin};checkpoint(value);transaction(this.context.db,()=>appendEvent(this.context.db,claim.job.workspace_id,claim.job.id,'progress',value,Date.now(),claim.attempt.attempt_no));}}).finally(()=>{rendererSettled=true;});check();
      const manifest:ArtifactManifest={schema_version:'artifact-manifest.v1',artifact_id:artifactId,job_id:claim.job.id,attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,workspace_id:frozen.workspace_id,topic_id:frozen.topic_id,variant_id:frozen.variant_id,variant_revision_id:frozen.variant_revision_id,content_plan_revision_id:frozen.plan_kind==='content'?frozen.plan_revision_id:null,production_plan_revision_id:frozen.plan_kind==='production'?frozen.plan_revision_id:null,script_revision_id:frozen.script_revision_id,core_revision_id:frozen.core_revision_id,core_approval_id:frozen.core_approval_id,source_preparation_revision_id:frozen.source_preparation_revision_id,plan_id:frozen.plan_id,input_hash:frozen.input_hash,platform:frozen.platform,format:frozen.format,mode:body.render_mode,status:body.render_mode==='export'?'export_ready':'preview_ready',publishable:false,kind:frozen.plan_kind==='production'?'final_video':frozen.format==='image_post'?'image_package':frozen.format==='article'?'article_package':'text_package',producer_version:'wp19-local-render/1',renderer:RENDERER,preset_snapshot:result.preset_snapshot,input_plan:clean(frozen) as JsonObject,files:result.files,provenance:[...renderInput.assets.map(a=>({asset_id:a.asset_id,sha256:a.sha256,...a.provenance})),...result.provenance],limitations:result.limitations,created_at:new Date().toISOString()};
      await writeFile(join(stage,'manifest.json'),canonicalJson(manifest)+'\n',{flag:'wx'});await writeFile(join(paths.state_root,`media-tools-${artifactId}.json`),JSON.stringify(result.traces,null,2)+'\n',{flag:'wx'});check();await mkdir(this.root(),{recursive:true});if((await stat(stage)).dev!==(await stat(this.root())).dev)throw new ContractError('STORAGE_UNAVAILABLE','媒体staging和成品必须同卷');flushTree(stage);renameSync(stage,final);flushDirectory(this.root());promoted=true;for(const file of manifest.files)chmodSync(safeManagedChild(final,join(final,file.relative_path)),0o444);chmodSync(join(final,'manifest.json'),0o444);check();
      const output:ArtifactOutput={artifact_id:artifactId,variant_id:frozen.variant_id,variant_revision_id:frozen.variant_revision_id,content_plan_revision_id:manifest.content_plan_revision_id,production_plan_revision_id:manifest.production_plan_revision_id,manifest_path:join(final,'manifest.json'),sha256:await fileHash(join(final,'manifest.json'),signal),kind:manifest.kind,producer_version:manifest.producer_version};recordVerifiedOutput(this.context,claim,output,manifest.files);checkpoint({phase:'verified_output',artifact_id:artifactId,manifest_sha256:output.sha256,completed:manifest.files.length,total:manifest.files.length,unit:'steps'});check();return [output];
    } catch(error) {
      const reason=error instanceof Error?error.message:'MEDIA_FAILED',source=promoted?final:stage;
      if(present(source)){
        const quarantine=safeManagedChild(paths.state_root,join(paths.state_root,'media-quarantine',artifactId));mkdirSync(join(paths.state_root,'media-quarantine'),{recursive:true});renameSync(source,quarantine);
        if(rendererSettled&&recordIsolation(this.context,claim,artifactId,quarantine,reason,present(join(quarantine,'manifest.json'))?await fileHash(join(quarantine,'manifest.json')):null))this.settleLocalCancellation(claim,[artifactId]);
      }
      try{check();new Jobs(this.context).fail(claim.fence,{code:error instanceof ContractError?error.code:'MEDIA_EXECUTION_FAILED',message:reason},'waiting_input');}catch{/* 撤销提交权后的状态由取消/恢复协议持有，不重新关联。 */}throw error;
    }
  }
  async reconcileCancelled(request:RequestContext,jobId:string):Promise<{state:string;isolated_artifact_ids:string[]}> {
    assertRequestIdentity(this.context,request);const job=getJob(this.context.db,request.workspace_id,jobId);
    if(job.kind!=='media_generate'||!job.cancel_requested_at||!['reconciling','cancelled'].includes(job.state)||job.current_attempt_id!==null)throw new ContractError('HOST_RUN_NOT_CURRENT','媒体任务没有待核对的撤销状态');
    const attemptRow=this.context.db.prepare("SELECT id FROM job_attempts WHERE workspace_id=? AND job_id=? AND state='cancelled' AND attempt_generation=?").get(request.workspace_id,jobId,job.attempt_generation-1);
    if(!attemptRow)throw new ContractError('HOST_RUN_NOT_CURRENT','媒体任务没有已撤销执行代次');
    const attempt=getAttempt(this.context.db,request.workspace_id,String(attemptRow.id)),claim:ClaimedJob={job,attempt,fence:{job_id:job.id,attempt_id:attempt.id,attempt_generation:attempt.attempt_generation,lease_owner:attempt.lease_owner}},paths=workspaceSettings(this.context.db,request.workspace_id).paths;
    const rows=this.context.db.prepare("SELECT * FROM result_receipts WHERE workspace_id=? AND job_id=? AND state='quarantined' ORDER BY created_at,id").all(request.workspace_id,jobId),isolated=new Set<string>();
    for(const row of rows){
      if(row.attempt_id!==attempt.id||row.attempt_generation!==attempt.attempt_generation)throw new ContractError('HOST_RUN_NOT_CURRENT','撤销收据代次不符');
      const payload=JSON.parse(String(row.output_payload)) as {typed_output:{artifacts?:ArtifactOutput[]}};
      for(const output of payload.typed_output.artifacts??[]){
        this.assertUnassociated(job.workspace_id,output.artifact_id);const source=safeManagedChild(this.root(),join(this.root(),output.artifact_id)),quarantine=safeManagedChild(paths.state_root,join(paths.state_root,'media-quarantine',output.artifact_id));
        if(output.manifest_path!==join(source,'manifest.json'))throw new ContractError('STORAGE_UNAVAILABLE','撤销清单不是固定受控路径');
        if(present(source)){
          if(present(quarantine))throw new ContractError('STORAGE_UNAVAILABLE','needs_repair：原输出与隔离目录同时存在');
          verifyRenderedOutput(this.context,claim,output,source);mkdirSync(join(paths.state_root,'media-quarantine'),{recursive:true});renameSync(source,quarantine);recordIsolation(this.context,claim,output.artifact_id,quarantine,'CANCELLED_RECEIPT',output.sha256);
        }
        if(!present(quarantine)){if(job.state==='cancelled')throw new ContractError('STORAGE_UNAVAILABLE','needs_repair：已取消任务的隔离证明缺失');return{state:'reconciling',isolated_artifact_ids:[...isolated]};}
        verifyIsolation(this.context,claim,output.artifact_id,quarantine,output.sha256);isolated.add(output.artifact_id);
      }
    }
    // 无收据的本地晚到输出也只接受执行层已持久记录的隔离证明。
    const proofs=this.context.db.prepare("SELECT payload FROM job_events WHERE workspace_id=? AND job_id=? AND type='progress' AND attempt_no=? ORDER BY seq").all(request.workspace_id,jobId,attempt.attempt_no);
    for(const row of proofs){const proof=JSON.parse(String(row.payload)) as JsonObject;if(proof.phase!=='media_output_isolated'||proof.attempt_id!==attempt.id||proof.attempt_generation!==attempt.attempt_generation)continue;const id=String(proof.artifact_id);this.assertUnassociated(job.workspace_id,id);const quarantine=safeManagedChild(paths.state_root,join(paths.state_root,'media-quarantine',id));verifyIsolation(this.context,claim,id,quarantine);isolated.add(id);}
    if(isolated.size)this.settleLocalCancellation(claim,[...isolated]);
    return{state:getJob(this.context.db,request.workspace_id,jobId).state,isolated_artifact_ids:[...isolated]};
  }
  private assertUnassociated(workspaceId:string,id:string):void {if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new ContractError('STORAGE_UNAVAILABLE','撤销成品ID无效');if(this.context.db.prepare('SELECT id FROM artifacts WHERE workspace_id=? AND id=?').get(workspaceId,id))throw new ContractError('HOST_RUN_NOT_CURRENT','不能隔离已关联成品');}
  private settleLocalCancellation(claim:ClaimedJob,artifactIds:string[]):void {
    transaction(this.context.db,()=>{
      const job=getJob(this.context.db,claim.job.workspace_id,claim.job.id),attempt=getAttempt(this.context.db,claim.job.workspace_id,claim.attempt.id);
      if(!['reconciling','cancelled'].includes(job.state)||!job.cancel_requested_at||job.current_attempt_id!==null||job.attempt_generation!==claim.fence.attempt_generation+1||attempt.state!=='cancelled'||attempt.lease_owner!==claim.fence.lease_owner)return;
      if(this.context.db.prepare("SELECT id FROM result_receipts WHERE workspace_id=? AND job_id=? AND state='committed'").get(job.workspace_id,job.id))return;
      const expected=new Map<string,string>();
      for(const receipt of this.context.db.prepare("SELECT attempt_id,attempt_generation,output_payload FROM result_receipts WHERE workspace_id=? AND job_id=? AND state='quarantined'").all(job.workspace_id,job.id)){
        if(receipt.attempt_id!==attempt.id||receipt.attempt_generation!==attempt.attempt_generation)return;
        const payload=JSON.parse(String(receipt.output_payload)) as {typed_output:{artifacts?:ArtifactOutput[]}};
        for(const output of payload.typed_output.artifacts??[])expected.set(output.artifact_id,output.sha256);
      }
      // 本地晚到文件的证明不能替代另一份缺实际文件的撤销收据。
      if([...expected.keys()].some(id=>!artifactIds.includes(id)))return;
      const paths=workspaceSettings(this.context.db,job.workspace_id).paths,proofs=artifactIds.map(id=>{this.assertUnassociated(job.workspace_id,id);if(present(safeManagedChild(this.root(),join(this.root(),id))))throw new ContractError('STORAGE_UNAVAILABLE','needs_repair：输出尚未完整隔离');return{artifact_id:id,...verifyIsolation(this.context,claim,id,safeManagedChild(paths.state_root,join(paths.state_root,'media-quarantine',id)),expected.get(id))};});
      if(!proofs.length||job.state==='cancelled')return;
      const now=Date.now(),updated=this.context.db.prepare("UPDATE jobs SET state='cancelled',version=version+1,updated_at=? WHERE workspace_id=? AND id=? AND state='reconciling' AND cancel_requested_at IS NOT NULL AND current_attempt_id IS NULL AND attempt_generation=?").run(new Date(now).toISOString(),job.workspace_id,job.id,claim.fence.attempt_generation+1);
      if(updated.changes)appendEvent(this.context.db,job.workspace_id,job.id,'cancelled',{reason:'LOCAL_OUTPUT_ISOLATED',attempt_id:attempt.id,artifact_id:artifactIds[0]!,associated:false,actual_proof:{renderer_settled:true,verified_isolation:proofs}},now,attempt.attempt_no);
    });
  }
  private renderInput(frozen:ResolvedPlanInput,artifact_id:string,mode:'preview'|'export'):LocalRenderInput {const texts=new Map(frozen.resolved_texts.map(t=>[t.revision_id,t.text]));const text=(id:string|null|undefined)=>id?texts.get(id)??'':'';return{artifact_id,platform:frozen.platform,format:frozen.format,plan_revision_id:frozen.plan_revision_id,input_hash:frozen.input_hash,preset:frozen.preset,mode,title:text(frozen.title_revision_id),caption:text(frozen.caption_revision_id),cover_asset_id:frozen.cover_asset_id,input_texts:frozen.texts,assets:frozen.assets.map(asset=>{const row=this.context.db.prepare('SELECT origin,generation_metadata FROM assets WHERE workspace_id=? AND id=?').get(frozen.workspace_id,asset.asset_id);let provenance:JsonObject={source_kind:String(row?.origin??'unknown'),is_user_footage:false};if(row?.generation_metadata){try{provenance={...provenance,...JSON.parse(String(row.generation_metadata))};}catch{/* 不把未知来源猜成用户媒体。 */}}return{...asset,provenance};}),units:frozen.units.map(u=>({...u,text:u.text_segment?text(u.text_revision_id).slice(u.text_segment.start,u.text_segment.end):text(u.text_revision_id)})),shots:frozen.shots.map(s=>({...s,narration:text(s.narration_revision_id),subtitle:text(s.subtitle_revision_id)})),frozen_plan:frozen as unknown as JsonObject};}
  async read(request:RequestContext,artifactId:string):Promise<{artifact:ArtifactsRow;manifest:ArtifactManifest}> {assertRequestIdentity(this.context,request);const row=this.context.db.prepare('SELECT * FROM artifacts WHERE workspace_id=? AND id=?').get(request.workspace_id,artifactId) as unknown as ArtifactsRow|undefined;if(!row)throw new ContractError('NOT_FOUND','成品不存在');const root=safeManagedChild(this.root(),join(this.root(),artifactId)),path=safeManagedChild(root,row.manifest_path);if(path!==join(root,'manifest.json')||await fileHash(path)!==row.sha256)throw new ContractError('STORAGE_UNAVAILABLE','成品清单hash/位置不符');const manifest=JSON.parse(readFileSync(path,'utf8')) as ArtifactManifest;if(manifest.artifact_id!==row.id||manifest.workspace_id!==request.workspace_id||manifest.variant_id!==row.variant_id||manifest.variant_revision_id!==row.variant_revision_id||manifest.content_plan_revision_id!==row.content_plan_revision_id||manifest.production_plan_revision_id!==row.production_plan_revision_id)throw new ContractError('STORAGE_UNAVAILABLE','成品归属不符');for(const file of manifest.files){const path=safeManagedChild(root,join(root,file.relative_path));if((await stat(path)).size!==file.size_bytes||await fileHash(path)!==file.sha256)throw new ContractError('STORAGE_UNAVAILABLE','成品实际文件hash不符',{file_ref:file.file_ref});}return{artifact:row,manifest};}
  async content(request:RequestContext,artifactId:string,fileRef:string) {const{manifest}=await this.read(request,artifactId);const file=manifest.files.find(f=>f.file_ref===fileRef);if(!file)throw new ContractError('NOT_FOUND','成品资源不存在');const root=safeManagedChild(this.root(),join(this.root(),artifactId));return{stream:createReadStream(safeManagedChild(root,join(root,file.relative_path)),{highWaterMark:1024*1024}),mime:file.mime,size_bytes:file.size_bytes,filename:file.relative_path.split('/').at(-1)!};}
}
import { queueJobInTransaction } from '@workbench/storage/jobs';
function queueMedia(context:ApplicationContext,request:RequestContext,planId:string,manifest:JsonObject){return queueJobInTransaction(context.db,request.workspace_id,{kind:'media_generate',target_id:planId,entrypoint:'standalone_web',execution_mode:'programmatic',input_manifest:manifest,retry_policy:{recovery:'media',max_attempts:1},presentation:'foreground_dialog'},Date.now());}

function flushDirectory(path:string):void{const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function flushTree(root:string):void{for(const file of readdirSync(root,{withFileTypes:true})){const path=join(root,file.name);if(file.isDirectory())flushTree(path);else{const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}}flushDirectory(root);}

export {ImageGenerationWorkflow} from './image.ts';
export type {FrozenImageInput,ImageAssetManifest} from './image.ts';
