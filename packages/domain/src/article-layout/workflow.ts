import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,lstatSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {ContractError,type RequestContext,type JsonObject,type JobsRow} from '@workbench/contracts';
import type {ArticleLayoutSnapshot,ArticleLayoutVisualContext,ArticleLayoutVisualRenderView,ArticleLayoutVisualJobView,ArticleLayoutVisualStatus,LayoutVisualInput} from '../../../contracts/src/article-layout.ts';
import type {ApplicationContext} from '../ports/index.ts';
import {assertRequestIdentity} from '../documents/index.ts';
import {ArticleLayoutStudio} from './studio.ts';
import {layoutArticleId} from './plan-final-source.ts';
import {digest,LAYOUT_RULES_VERSION} from './index.ts';
import {Jobs} from '../jobs/index.ts';
import {canonicalJson,outputHash,transaction,lookupIdempotency,claimIdempotency,commitIdempotency} from '../../../storage/src/connection/index.ts';
import {queueJobInTransaction,getJob,getAttempt,fenceReason,revokeAttemptInTransaction,appendEvent,type ClaimedJob} from '../../../storage/src/jobs/index.ts';
import {createVisualRecord,readVisualRecord,updateVisualJob,visualKey,type ArticleVisualRenderRecord,type ArticleVisualJobRecord} from '../../../storage/src/article-layout/visual-store.ts';
import {SqliteLayoutCheckAdmissionV2,SqliteLayoutCheckJournalV2,type LayoutCheckAuthorityV2} from '../../../storage/src/article-layout/check-admission.ts';
import {CodexLayoutCheckAdapter,newLayoutCheckExecution} from '../../../adapters/src/media/layout-check/check.ts';
import {LayoutCheckSessions} from '../../../adapters/src/media/layout-check/sessions.ts';
import {assertLayoutCheckTerminalEvidence} from '../../../adapters/src/media/layout-check/proof.ts';
import {validateLayoutVisualInput,layoutVisualManifestHash} from '../../../adapters/src/media/layout-check/input.ts';
import type {LayoutNativeClient,LayoutCheckExecution} from '../../../adapters/src/media/layout-check/types.ts';
import {verifyLayoutCheckOutput,type LayoutCheckOutput} from '../result-commit/article-layout.ts';
import {articleLayoutRecordPaths,recordArticleLayoutSnapshot,writeConfirmedArticleLayoutWiki,type ArticleLayoutRecordGrant} from '../../../storage/src/article-layout/records.ts';

export interface ArticleVisualRenderer {render(snapshot:ArticleLayoutSnapshot,context:ArticleLayoutVisualContext,directory:string,signal:AbortSignal):Promise<LayoutVisualInput>;close():Promise<void>}
export interface ArticleVisualWorkflowOptions {
 renderer:ArticleVisualRenderer;renderer_version:string;authority?:LayoutCheckAuthorityV2;fixture?:boolean;
 native_factory?:()=>LayoutNativeClient;record_grant?:ArticleLayoutRecordGrant;timeout_ms?:number;
}
interface ArticleRecordFailure {id:string;error:string;snapshot_facts_sha256:string;grant_sha256:string;grant_identity_sha256?:string|null;requires_confirmation:boolean}
interface ArticleRecordState {pending:ArticleRecordFailure|null;obligations?:ArticleRecordFailure[];history:Array<Record<string,unknown>>}
/** Identity describes the exact registered five-field authorization, not incidental JSON metadata or path spelling.
 * It never authorizes a write: existing process/wiki guards still consume the original grant unchanged. */
function recordGrantIdentity(grant:ArticleLayoutRecordGrant):string|null{
 try{
  const fields=['root','process_root','wiki_root','owner_registration_ref','scope'] as const;
  if(!fields.every(k=>typeof grant[k]==='string')||!fields.slice(0,4).every(k=>isAbsolute(grant[k])))return null;
  articleLayoutRecordPaths(grant,'identity-probe');const stat=lstatSync(grant.owner_registration_ref);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.size>8_000_000)return null;
  const registered=JSON.parse(readFileSync(grant.owner_registration_ref,'utf8'));
  if(!registered||fields.some(k=>registered[k]!==grant[k]))return null;
  return digest({schema_version:'article-layout-record-grant-identity.v1',root:resolve(grant.root),process_root:resolve(grant.process_root),wiki_root:resolve(grant.wiki_root),owner_registration_ref:resolve(grant.owner_registration_ref),scope:grant.scope});
 }catch{return null;}
}
function recordObligations(state:ArticleRecordState,raw:string,identity:string|null):ArticleRecordFailure[]{
 return (state.obligations??(state.pending?[state.pending]:[])).map(entry=>!entry.grant_identity_sha256&&entry.grant_sha256===raw&&identity?{...entry,grant_identity_sha256:identity}:entry);
}
const outstandingRecord=(entries:ArticleRecordFailure[])=>entries.find(e=>e.requires_confirmation)??entries.at(-1)??null;
/** Only render facts affect currency; receipt/check history and human confirmation are separate state. */
export const articleRenderFacts=(s:ArticleLayoutSnapshot)=>({article_id:s.article_id,document_id:s.document_id,content_revision_id:s.content_revision_id,layout_revision_id:s.layout_revision_id,text_hash:s.text_hash,images_hash:s.images_hash,standard:s.standard,blocks:s.blocks,order:s.order,content_order:s.content_order,style:s.style,original_text:s.original_text,upstream_review:s.upstream_review});
export class ArticleLayoutVisualWorkflow {
 readonly context:ApplicationContext;readonly studio:ArticleLayoutStudio;readonly options:ArticleVisualWorkflowOptions;
 readonly journal:SqliteLayoutCheckJournalV2;readonly admission:SqliteLayoutCheckAdmissionV2|null;
 private readonly sessions=new LayoutCheckSessions();
 private closing=false;private rendererClosing:Promise<void>|null=null;private active=new Set<AbortController>();private executions=new Set<Promise<void>>();private mutations=new Map<string,Promise<unknown>>();
 constructor(context:ApplicationContext,studio:ArticleLayoutStudio,options:ArticleVisualWorkflowOptions){
  this.context=context;this.studio=studio;this.options=options;this.journal=new SqliteLayoutCheckJournalV2(context.db,context.identity.workspace_id);
  if(options.fixture!==true&&options.native_factory)throw new ContractError('VALIDATION_ERROR','生产视觉链不可替换原生客户端');
  this.admission=options.authority?new SqliteLayoutCheckAdmissionV2(context.db,options.authority):null;
 }
 private authorize(request:RequestContext){assertRequestIdentity(this.context,request);if(this.closing)throw new ContractError('RESULT_UNKNOWN','排版服务正在关闭，原稿已保留');}
 private async record(request:RequestContext,topicId:string){this.authorize(request);const r=await this.studio.repository.read(request.workspace_id,layoutArticleId(topicId));if(!r?.source||r.source.topic_id!==topicId)throw new ContractError('NOT_FOUND','先确认配图并进入排版');return r;}
 private title(topic:string):string{const r=this.context.db.prepare('SELECT title FROM topics WHERE workspace_id=? AND id=?').get(this.context.identity.workspace_id,topic);if(!r)throw new ContractError('NOT_FOUND','主题不存在');return String(r.title);}
 private contextFor(topic:string,snapshot:ArticleLayoutSnapshot,source:ArticleLayoutVisualContext['source']):ArticleLayoutVisualContext{return{schema_version:'article-layout-visual-context.v2',workspace_id:this.context.identity.workspace_id,topic_id:topic,topic_title:this.title(topic),snapshot_version:snapshot.version,content_revision_id:snapshot.content_revision_id,layout_revision_id:snapshot.layout_revision_id,text_hash:snapshot.text_hash,images_hash:snapshot.images_hash,source:structuredClone(source),rules_version:LAYOUT_RULES_VERSION,renderer_version:this.options.renderer_version,snapshot_sha256:digest(snapshot)};}
 private current(render:ArticleVisualRenderRecord,allowPending=false):boolean{
  const ws=this.context.identity.workspace_id,r=this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get('article-layout.v1:'+ws+':'+render.snapshot.article_id);if(!r)return false;
  const live=JSON.parse(String(r.value));if(live.pending&&!allowPending||!live.source)return false;
  const c=render.context;return c.workspace_id===ws&&c.topic_title===this.title(c.topic_id)&&c.rules_version===LAYOUT_RULES_VERSION&&c.renderer_version===this.options.renderer_version&&digest(live.source)===digest(c.source)&&digest(articleRenderFacts(live.snapshot))===digest(articleRenderFacts(render.snapshot));
 }
 private renderRecord(workspace:string,id:string):ArticleVisualRenderRecord{const r=readVisualRecord<ArticleVisualRenderRecord>(this.context.db,workspace,'render',id);if(!r||r.context.workspace_id!==workspace||digest(r.context)!==r.context_sha256||digest(r.snapshot)!==r.context.snapshot_sha256||layoutVisualManifestHash(r.input)!==r.manifest_sha256)throw new ContractError('INPUT_STALE','渲染输入已变化，请重新准备当前排版');return r;}
 async render(request:RequestContext,input:{topic_id:string;expected_version:number},signal:AbortSignal=new AbortController().signal):Promise<ArticleLayoutVisualRenderView>{
  return this.idempotent(request,'render',input,async()=>{
   const r=await this.record(request,input.topic_id);if(r.pending||r.snapshot.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','排版已变化，请先保存并刷新');
   const context=this.contextFor(input.topic_id,r.snapshot,r.source!),id=randomUUID(),directory=join(this.context.paths.state_root,'article-layout-visual','renders',id);mkdirSync(directory,{recursive:true,mode:0o700});
   const visual=await this.options.renderer.render(structuredClone(r.snapshot),context,directory,signal);this.authorize(request);validateLayoutVisualInput(visual);
   const render:ArticleVisualRenderRecord={schema_version:'article-layout-render.v2',render_id:id,context,context_sha256:digest(context),snapshot:structuredClone(r.snapshot),input:visual,manifest_sha256:layoutVisualManifestHash(visual),created_at:new Date().toISOString()};
   if(!this.current(render))throw new ContractError('VERSION_CONFLICT','渲染期间排版或主题已变化，请重新准备');
   createVisualRecord(this.context.db,request.workspace_id,'render',id,render);
   return{render_id:id,topic_id:input.topic_id,snapshot_version:r.snapshot.version,context_sha256:render.context_sha256,created_at:render.created_at};
  });
 }
 async enqueue(request:RequestContext,input:{topic_id:string;expected_version:number;render_id:string}):Promise<ArticleLayoutVisualJobView>{
  this.authorize(request);if(!this.admission)throw new ContractError('CAPABILITY_UNVERIFIED','AI排版检查尚未配置执行授权，当前稿件已保留');
  const jobId=await this.idempotent(request,'check',input,async()=>{
   const live=await this.record(request,input.topic_id),render=this.renderRecord(request.workspace_id,input.render_id);
   if(live.pending||live.snapshot.version!==input.expected_version||render.context.topic_id!==input.topic_id||!this.current(render))throw new ContractError('INPUT_STALE','准备的画面已过期，请重新检查当前排版');
   validateLayoutVisualInput(render.input);const intent=randomUUID();
   return transaction(this.context.db,()=>{const active=this.context.db.prepare("SELECT id FROM jobs WHERE workspace_id=? AND kind='article_layout_check' AND target_id=? AND state IN ('queued','running','reconciling') LIMIT 1").get(request.workspace_id,render.snapshot.article_id);if(active)throw new ContractError('RESULT_UNKNOWN','这篇排版已有在途或待核对检查，请先核对原任务');const job=queueJobInTransaction(this.context.db,request.workspace_id,{kind:'article_layout_check',target_id:render.snapshot.article_id,executor_id:'codex',entrypoint:'standalone_web',execution_mode:'programmatic',presentation:'foreground_dialog',input_manifest:{schema_version:'article-layout-visual-job.v2',operation:'layout_visual',mode:'none',targets:[],source_ids:[],render_id:render.render_id,context_sha256:render.context_sha256,intent_id:intent,authority_sha256:digest(this.options.authority)},retry_policy:{recovery:'media',max_attempts:3}},Date.now());
    createVisualRecord(this.context.db,request.workspace_id,'job',job.id,{schema_version:'article-layout-job.v2',job_id:job.id,render_id:render.render_id,topic_id:input.topic_id,intent_id:intent,execution_attempt_id:null,execution_generation:null,consumed_receipt_id:null,created_at:new Date().toISOString(),record_error:null} satisfies ArticleVisualJobRecord);
    this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(visualKey(request.workspace_id,'latest',input.topic_id),JSON.stringify(job.id));return job.id;});
  });return this.view(request,input.topic_id,jobId);
 }
 /** Called only with the worker's actual lease. Unknown resumes read the old native attempt. */
 async execute(claim:ClaimedJob,signal:AbortSignal,checkpoint:(v:JsonObject)=>void):Promise<LayoutCheckOutput>{
  if(this.closing)throw new ContractError('RESULT_UNKNOWN','排版服务关闭中');
  const ws=this.context.identity.workspace_id,record=readVisualRecord<ArticleVisualJobRecord>(this.context.db,ws,'job',claim.job.id),body=JSON.parse(claim.job.input_manifest);
  if(!record||!this.admission||record.render_id!==body.render_id||digest(this.options.authority)!==body.authority_sha256)throw new ContractError('INPUT_STALE','视觉任务授权或绑定不存在');
  const render=this.renderRecord(ws,record.render_id),controller=new AbortController(),abort=()=>controller.abort(signal.reason);this.active.add(controller);let drained!:()=>void;const executionDrained=new Promise<void>(done=>{drained=done;});this.executions.add(executionDrained);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const fenceCurrent=()=>{try{return !fenceReason(getJob(this.context.db,ws,claim.job.id),getAttempt(this.context.db,ws,claim.attempt.id),claim.fence,Date.now());}catch{return false;}};
  const current=()=>!this.closing&&!controller.signal.aborted&&!(record.execution_attempt_id===null&&!this.current(render))&&fenceCurrent();
  const check=()=>{controller.signal.throwIfAborted();if(!current())throw new ContractError('HOST_RUN_NOT_CURRENT','视觉任务已取消、过期或排版变化，保留原身份');};
  try{check();let original=record.execution_attempt_id;
   let prepared:LayoutCheckExecution|null=null;
   if(!original){prepared=newLayoutCheckExecution(render.input,{id:record.intent_id,job_id:claim.job.id,attempt_id:claim.attempt.id},this.options.fixture===true);prepared.candidate_sha256=this.admission.candidate_sha256;
    const execution=prepared;transaction(this.context.db,()=>{check();this.admission!.enroll({intent_id:record.intent_id,job_id:claim.job.id,attempt_id:claim.attempt.id,manifest_sha256:execution.attempt.input_manifest_sha256,context_sha256:render.context_sha256});
     if(!this.journal.reservePrepared(execution))throw new ContractError('INPUT_STALE','原检查身份已经存在');
     updateVisualJob(this.context.db,ws,claim.job.id,r=>({...r,execution_attempt_id:claim.attempt.id,execution_generation:claim.attempt.attempt_generation}));});original=claim.attempt.id;
   }
   checkpoint({phase:record.execution_attempt_id?'layout_query_original':'layout_visual_check',layout_original_attempt_id:original,layout_query_only:record.execution_attempt_id!==null,render_id:render.render_id,context_sha256:render.context_sha256});check();
   const adapter=new CodexLayoutCheckAdapter({workspace_id:ws,cwd:render.input.work_directory,lock_root:join(this.context.paths.state_root,'executor-locks'),schema_directory:join(this.context.paths.state_root,'executor-schemas'),journal:this.journal,fixture:this.options.fixture===true,permit:this.admission,is_current:current,is_fence_current:fenceCurrent,session_owner:this.sessions,...(this.options.native_factory?{native_factory:this.options.native_factory}:{}),...(this.options.timeout_ms?{timeout_ms:this.options.timeout_ms}:{})});
   const prior=prepared??this.journal.read(original);
   if(!prior)throw new ContractError('INPUT_STALE','原视觉检查记录不存在');
   // A recovered SQL lease never reopens a native thread for a pre-submit intent.
   if(!prepared&&prior.submit_count===0){prior.attempt.state='failed';prior.attempt.result=null;prior.attempt.error='上次检查在提交前中断，未提交视觉任务，可重新检查';prior.attempt.updated_at=new Date().toISOString();await this.journal.save(prior);this.admission.settle(claim.job.id,'failed');new Jobs(this.context).fail(claim.fence,{code:'EXECUTION_FAILED',message:prior.attempt.error,pre_submit_failure:true},'failed');throw new ContractError('CAPABILITY_UNVERIFIED',prior.attempt.error,{pre_submit_failure:true});}
   const observed=prepared?await adapter.executePrepared(prepared,controller.signal):await adapter.query(original,controller.signal);check();
   this.admission.settle(claim.job.id,observed.execution.attempt.state==='completed'?'completed':observed.execution.attempt.state==='failed'?'failed':'unknown');
   if(observed.execution.attempt.state==='failed'&&observed.execution.submit_count===0){const message=observed.execution.attempt.error??'检查未提交，可重新检查';new Jobs(this.context).fail(claim.fence,{code:'CAPABILITY_UNVERIFIED',message,pre_submit_failure:true},'failed');throw new ContractError('CAPABILITY_UNVERIFIED',message,{pre_submit_failure:true});}
   if(observed.execution.attempt.state==='failed'&&observed.execution.submit_count===1){assertLayoutCheckTerminalEvidence(observed.execution);const message=observed.execution.attempt.error??'原生检查未成功结束';new Jobs(this.context).fail(claim.fence,{code:'EXECUTION_FAILED',message},'failed');throw new ContractError('CAPABILITY_UNVERIFIED',message,{native_terminal:true,no_automatic_retry:true});}
   if(observed.execution.attempt.state!=='completed'||!observed.result)throw new ContractError('RESULT_UNKNOWN','视觉结果待核对，只查询原任务，不重新提交');
   return{job_id:claim.job.id,attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,render_id:render.render_id,context_sha256:render.context_sha256,execution_attempt_id:original,execution_sha256:digest(observed.execution)};
  }finally{signal.removeEventListener('abort',abort);this.active.delete(controller);drained();this.executions.delete(executionDrained);}
 }
 /** A positively unsubmitted attempt can fail terminally despite the generic media recovery policy. */
 async failUnsubmitted(claim:ClaimedJob,error:unknown):Promise<void>{
  const db=this.context.db,ws=this.context.identity.workspace_id;
  if(fenceReason(getJob(db,ws,claim.job.id),getAttempt(db,ws,claim.attempt.id),claim.fence,Date.now()))return;
  const record=readVisualRecord<ArticleVisualJobRecord>(db,ws,'job',claim.job.id);if(!record)return;
  const execution=record.execution_attempt_id?this.journal.read(record.execution_attempt_id):null;
  if(record.execution_attempt_id&&!execution||execution?.submit_count)return;
  const message=error instanceof Error?error.message:'视觉检查未提交，可重新检查';
  if(execution){if(execution.attempt.state!=='failed'){execution.attempt.state='failed';execution.attempt.result=null;execution.attempt.error=message;execution.attempt.updated_at=new Date().toISOString();await this.journal.save(execution);}this.admission?.settle(claim.job.id,'failed');}
  new Jobs(this.context).fail(claim.fence,{code:'EXECUTION_FAILED',message,pre_submit_failure:true},'failed');
 }
 private jobRecord(request:RequestContext,topic:string,id:string):ArticleVisualJobRecord{this.authorize(request);const r=readVisualRecord<ArticleVisualJobRecord>(this.context.db,request.workspace_id,'job',id);if(!r||r.topic_id!==topic)throw new ContractError('NOT_FOUND','排版检查任务不存在');return r;}
 private async consume(request:RequestContext,record:ArticleVisualJobRecord):Promise<void>{
  const db=this.context.db,job=getJob(db,request.workspace_id,record.job_id);if(job.state!=='succeeded'||job.cancel_requested_at||record.consumed_receipt_id)return;
  const row=db.prepare("SELECT * FROM result_receipts WHERE workspace_id=? AND job_id=? AND state='committed' AND attempt_generation=? AND attempt_id=? ORDER BY created_at DESC LIMIT 1").get(request.workspace_id,job.id,job.attempt_generation,job.current_attempt_id);
  if(!row)return;const payload=JSON.parse(String(row.output_payload)),typed=payload.typed_output,output=typed.layout_check as LayoutCheckOutput,attempt=getAttempt(db,request.workspace_id,String(row.attempt_id));
  if(row.input_hash!==job.input_hash||row.output_hash!==outputHash(payload)||Object.keys(typed).sort().join(',')!=='documents,layout_check,recommendations'||!Array.isArray(typed.documents)||typed.documents.length||!Array.isArray(typed.recommendations)||typed.recommendations.length)throw new ContractError('INPUT_STALE','已提交视觉收据损坏');
  verifyLayoutCheckOutput(this.context,job,attempt,output);const render=this.renderRecord(request.workspace_id,record.render_id);if(!this.current(render))return;
  const serviceRequest={...request,idempotency_key:'visual-consume:'+row.id},live=await this.record(request,record.topic_id);
  const frozen=transaction(db,()=>updateVisualJob(db,request.workspace_id,job.id,r=>({...r,consume_expected_version:r.consume_expected_version??live.snapshot.version})));
  if(frozen.consumed_receipt_id)return;
  const saved=await this.studio.syncVisualCheck(serviceRequest,record.topic_id,{expected_version:frozen.consume_expected_version!,attempt_id:output.execution_attempt_id},()=>{
   // Runs synchronously inside the repository CAS transaction. Marking consumption is atomic with the snapshot write.
   if(!this.current(render,true))throw new ContractError('INPUT_STALE','消费期间排版、标题或来源已变化');
   verifyLayoutCheckOutput(this.context,getJob(db,request.workspace_id,job.id),attempt,output);
   updateVisualJob(db,request.workspace_id,job.id,r=>({...r,consumed_receipt_id:String(row.id)}));
  });
  if(saved.state==='saved')this.recordSaved(request,record.topic_id,saved.snapshot);
 }
 async view(request:RequestContext,topic:string,id:string):Promise<ArticleLayoutVisualJobView>{
  let record=this.jobRecord(request,topic,id);await this.consume(request,record);record=this.jobRecord(request,topic,id);
  const job=getJob(this.context.db,request.workspace_id,id),render=this.renderRecord(request.workspace_id,record.render_id),valid=this.current(render),execution=record.execution_attempt_id?this.journal.read(record.execution_attempt_id):null;
  const state:ArticleLayoutVisualJobView['state']=job.cancel_requested_at||job.state==='cancelled'?'cancelled':!valid?'stale':job.state==='succeeded'&&record.consumed_receipt_id?'completed':job.state==='running'?'running':job.state==='queued'?'queued':job.state==='reconciling'?'unknown':'failed';
  return{topic_id:topic,job_id:id,attempt_id:job.current_attempt_id,render_id:record.render_id,snapshot_version:render.context.snapshot_version,context_sha256:render.context_sha256,state,phase:state==='queued'?'等待排版检查':state==='running'?'正在检查当前排版':state==='unknown'?'结果待核对，保留原任务':state==='stale'?'排版已变化，旧结果仅作历史':state==='completed'?'排版检查完成':state==='cancelled'?'检查已停止':'检查未完成',result:record.consumed_receipt_id?execution?.attempt.result??null:null,current:valid,can_query:(state==='unknown'||state==='stale'&&job.state==='reconciling')&&!job.cancel_requested_at&&!!record.execution_attempt_id&&!!execution?.submit_count,error:execution?.attempt.error??record.record_error};
 }
 async status(request:RequestContext,topic:string):Promise<ArticleLayoutVisualStatus>{this.authorize(request);await this.record(request,topic);const id=readVisualRecord<string>(this.context.db,request.workspace_id,'latest',topic);return{available:!!this.admission,reason:this.admission?null:'AI排版检查尚未配置执行授权',latest:id?await this.view(request,topic,id):null};}
 async query(request:RequestContext,input:{topic_id:string;job_id:string}):Promise<ArticleLayoutVisualJobView>{
  this.jobRecord(request,input.topic_id,input.job_id);const view=await this.view(request,input.topic_id,input.job_id);if(view.state==='completed'||view.state==='queued'||view.state==='running')return view;
  if(!view.can_query)throw new ContractError('RESULT_UNKNOWN','只能核对仍有效的原任务，不能重开检查');
  await this.idempotent(request,'query',input,async()=>transaction(this.context.db,()=>{const current=getJob(this.context.db,request.workspace_id,input.job_id);if(current.cancel_requested_at||current.state!=='reconciling')throw new ContractError('HOST_RUN_NOT_CURRENT','原任务已变化');revokeAttemptInTransaction(this.context.db,request.workspace_id,current.id,'LAYOUT_QUERY_ONLY','superseded','queued',Date.now());appendEvent(this.context.db,request.workspace_id,current.id,'queued',{query_only:true,new_native_submit:false},Date.now());return current.id;}));
  return this.view(request,input.topic_id,input.job_id);
 }
 async cancel(request:RequestContext,input:{topic_id:string;job_id:string}):Promise<ArticleLayoutVisualJobView>{this.jobRecord(request,input.topic_id,input.job_id);const job=getJob(this.context.db,request.workspace_id,input.job_id);new Jobs(this.context).cancel(request,job.id,{expected_version:job.version});await this.sessions.cancel(request.workspace_id,job.id);return this.view(request,input.topic_id,input.job_id);}
 recordSaved(request:RequestContext,topic:string,snapshot:ArticleLayoutSnapshot,confirmed=false):void{
  const grant=this.options.record_grant;if(!grant)return;
  const db=this.context.db,ws=request.workspace_id,id=readVisualRecord<string>(db,ws,'latest',topic),before=id?readVisualRecord<ArticleVisualJobRecord>(db,ws,'job',id):null;
  const key='article-layout-record-state.v1:'+ws+':'+id,readState=():ArticleRecordState=>{const row=db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key);return row?JSON.parse(String(row.value)):{pending:null,history:[]};};
  const initial=readState(),facts=digest(articleRenderFacts(snapshot)),grantHash=digest(grant),grantIdentity=recordGrantIdentity(grant);
  // Recording follows the current saved article even when its last visual check is stale.
  const current=()=>{if(!id||ws!==this.context.identity.workspace_id||readVisualRecord<string>(db,ws,'latest',topic)!==id)return false;
   const record=readVisualRecord<ArticleVisualJobRecord>(db,ws,'job',id),row=db.prepare('SELECT value FROM application_metadata WHERE key=?').get('article-layout.v1:'+ws+':'+snapshot.article_id),live=row?JSON.parse(String(row.value)):null;
   if(!record||record.job_id!==id||record.topic_id!==topic||!live||live.pending||live.source?.topic_id!==topic||digest(live.snapshot)!==digest(snapshot))return false;
   const render=this.renderRecord(ws,record.render_id);return render.snapshot.article_id===snapshot.article_id&&(!record.consumed_receipt_id||snapshot.checks.some(check=>check.job_id===id&&check.attempt_id===record.execution_attempt_id));};
  const writeState=(state:ArticleRecordState)=>db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(state));
  try{
   recordArticleLayoutSnapshot(grant,snapshot);if(confirmed){const row=db.prepare('SELECT value FROM application_metadata WHERE key=?').get('article-layout.v1:'+ws+':'+snapshot.article_id),source=row?JSON.parse(String(row.value)).source:null;writeConfirmedArticleLayoutWiki(grant,snapshot,{mode:'layout_only',db,workspace_id:ws,source,rules_version:LAYOUT_RULES_VERSION});}
   // Only a complete write for a verified matching authorization recovers its duty. Other grants stay pending.
   if(before?.record_error)transaction(db,()=>{const record=readVisualRecord<ArticleVisualJobRecord>(db,ws,'job',id!),state=readState();if(!current()||record?.record_error!==before.record_error||digest(state)!==digest(initial))return;
    const obligations=recordObligations(state,grantHash,grantIdentity),recovered=obligations.filter(e=>grantIdentity&&e.grant_identity_sha256===grantIdentity&&(!e.requires_confirmation||confirmed));
    const legacy=obligations.length===0;if(legacy&&(!grantIdentity||snapshot.confirmation&&!confirmed))return;
    for(const entry of legacy?[null]:recovered)state.history.push({id:randomUUID(),kind:'recovered',at:new Date().toISOString(),failure_id:entry?.id??null,error:entry?.error??before.record_error,legacy_error_observed:legacy,grant_identity_sha256:grantIdentity,snapshot_sha256:digest(snapshot),snapshot_version:snapshot.version,confirmed});
    state.obligations=obligations.filter(e=>!recovered.includes(e));state.pending=outstandingRecord(state.obligations);writeState(state);updateVisualJob(db,ws,id!,r=>({...r,record_error:state.pending?.error??null}));});
  }catch(error){if(id)transaction(db,()=>{if(!current())return;const state=readState(),obligations=recordObligations(state,grantHash,grantIdentity);
   const same=(entry:ArticleRecordFailure)=>grantIdentity?entry.grant_identity_sha256===grantIdentity:!entry.grant_identity_sha256&&entry.grant_sha256===grantHash;
   const previous=obligations.filter(same),failure:ArticleRecordFailure={id:randomUUID(),error:error instanceof Error?error.message:'过程记录待补写',snapshot_facts_sha256:facts,grant_sha256:grantHash,grant_identity_sha256:grantIdentity,requires_confirmation:confirmed||previous.some(e=>e.requires_confirmation)||!!(!obligations.length&&before?.record_error&&snapshot.confirmation)};
   state.history.push({...failure,kind:'failed',at:new Date().toISOString(),snapshot_sha256:digest(snapshot),snapshot_version:snapshot.version});state.obligations=[...obligations.filter(e=>!same(e)),failure];state.pending=outstandingRecord(state.obligations);writeState(state);updateVisualJob(db,ws,id,r=>({...r,record_error:state.pending!.error}));});}
 }
 private async idempotent<T>(request:RequestContext,operation:string,body:unknown,action:()=>Promise<T>):Promise<T>{
  this.authorize(request);if(!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','缺少Idempotency-Key');const name='article-visual.'+operation,key=request.workspace_id+':'+name+':'+request.idempotency_key;
  const active=this.mutations.get(key);if(active){await active;return this.idempotent(request,operation,body,action);}
  const old=lookupIdempotency(this.context.db,request.workspace_id,name,request.idempotency_key,body);if(old?.state==='committed')return old.response as unknown as T;
  if(old)throw new ContractError('RESULT_UNKNOWN','原操作结果待核对，保留原身份');const claim=transaction(this.context.db,()=>claimIdempotency(this.context.db,request.workspace_id,name,request.idempotency_key!,body));
  const promise=action();this.mutations.set(key,promise);try{const result=await promise;transaction(this.context.db,()=>commitIdempotency(this.context.db,request.workspace_id,claim.id,result as unknown as JsonObject));return result;}
  catch(error){throw error;}
  finally{this.mutations.delete(key);}
 }
 beginClose(){this.closing=true;this.sessions.beginClose();for(const c of this.active)c.abort(new Error('LAYOUT_RUNTIME_CLOSED'));this.rendererClosing??=this.options.renderer.close();void this.rendererClosing.catch(()=>undefined);}
 async close(){this.beginClose();await Promise.allSettled(this.mutations.values());await this.rendererClosing;await this.sessions.close();await Promise.all(this.executions);}
}
