import type { RequestContext } from '../../../contracts/src/common.ts';
import type { ArticleLayoutSourceBinding, ArticleLayoutSnapshot, ArticleLayoutSaveResult, ArticleLayoutStandard, ArticleReviewBinding, ArticleImageReference, ArticleImageCredit, LayoutCheckAttempt } from '../../../contracts/src/article-layout.ts';
import type { ArticleLayoutRepository, ArticleLayoutSaveIntent } from '../../../storage/src/article-layout/index.ts';
import {articleLayoutCommandIdentity,assertArticleLayoutCommandIdentity,replayArticleLayoutCommand,type ArticleLayoutCommandIdentity} from '../../../storage/src/article-layout/commands.ts';
import {assertLayoutCheckExecutionProof,type LayoutCheckExecution} from '../../../storage/src/article-layout/proof.ts';
import { backfillArticleImageCredits, articleTextHash, assertArticleSnapshot, assertLayoutCheckAttempt, recordLayoutCheck, registerLayoutCheck, adoptArticleImage, replaceArticleImages, confirmArticleLayout, createArticleLayout, digest, serializeArticleText } from './index.ts';
/** Structurally identical to the existing DocumentPort.get/save projection; Documents is passed unchanged. */
export interface ArticleDocumentPort {
 get(request:RequestContext,id:string):Promise<{document_id:string;head_revision_id:string|null;text:string;version:number;hash:string|null;save_state:string}>;
 save(request:RequestContext,id:string,input:{expected_revision_id:string|null;text:string;origin:'human'}):Promise<{revision_id:string;version:number;hash:string}>;
}
export class ArticleLayoutSaveUnknown extends Error { readonly intent_id:string;readonly local:ArticleLayoutSnapshot;constructor(intent:ArticleLayoutSaveIntent,cause:unknown){super('排版保存结果待核实；本地稿和原保存身份已保留，不自动重发',{cause});this.name='ArticleLayoutSaveUnknown';this.intent_id=intent.id;this.local=structuredClone(intent.target);}}
/** 采用图片的可信来源。placement（C1 配图终稿 producer 提供）给出相对文字块的确切位置，供整组重建图片块。 */
export interface ArticleAdoptedImageSource { load(request:RequestContext,documentId:string):Promise<{document_revision_id:string|null;producer_version:string;source_sha256:string;images:Array<{id:string;image:ArticleImageReference;caption?:string;after_block_id?:string|null;display_width_percent?:number;placement?:{anchor_block_id:string|null;position:'before'|'after'}}>}> }
/** Trusted server loader must retain the complete persisted execution, including its frozen files and input proof. */
export interface ArticleLayoutCheckSource {load(attemptId:string):Promise<LayoutCheckExecution|null>}
/** document_writeback=false（公众号排版 C1）：保存只写排版自己的块版本，不读写平台稿 Documents。默认 true 保持叶子行为。 */
export interface ArticleLayoutServiceOptions {before_check_commit?:()=>void;after_document_checkpoint?:()=>void;image_source?:ArticleAdoptedImageSource;check_source?:ArticleLayoutCheckSource;allow_fixture_checks?:boolean;document_writeback?:boolean}
/** 本进程里已登记、正在提交的保存（不回写平台稿模式）；进程重启后为空，留下的待提交项才是中断的保存。 */
const IN_FLIGHT=new Set<string>();
/** 文字、排版或图片有变化（任何一项修订号或摘要不同）。 */
export function articleSnapshotChanged(current:ArticleLayoutSnapshot,next:ArticleLayoutSnapshot):boolean{return current.content_revision_id!==next.content_revision_id||current.layout_revision_id!==next.layout_revision_id||current.text_hash!==next.text_hash||current.images_hash!==next.images_hash;}
export class ArticleLayoutService {
 readonly repository:ArticleLayoutRepository;readonly documents:ArticleDocumentPort;
 readonly hooks:ArticleLayoutServiceOptions;
 constructor(repository:ArticleLayoutRepository,documents:ArticleDocumentPort,hooks:ArticleLayoutServiceOptions={}){this.repository=repository;this.documents=documents;this.hooks=hooks;}
 async load(request:RequestContext,articleId:string):Promise<ArticleLayoutSnapshot>{const record=await this.repository.read(request.workspace_id,articleId);if(!record)throw new Error('ARTICLE_LAYOUT_NOT_FOUND');assertArticleSnapshot(record.snapshot);return record.snapshot;}
 async initialize(request:RequestContext,input:{article_id:string;document_id:string;standard?:ArticleLayoutStandard;upstream_review?:ArticleReviewBinding|null}):Promise<ArticleLayoutSnapshot>{const old=await this.repository.read(request.workspace_id,input.article_id);if(old){if(old.snapshot.document_id!==input.document_id)throw new Error('ARTICLE_LAYOUT_DOCUMENT_ID_MISMATCH');return old.snapshot;}const document=await this.documents.get(request,input.document_id);if(document.save_state==='needs_repair')throw new Error('ARTICLE_LAYOUT_DOCUMENT_NEEDS_REPAIR');const snapshot=createArticleLayout({...input,text:document.text,document_revision_id:document.head_revision_id});snapshot.version=1;const created=await this.repository.create(request.workspace_id,{snapshot,pending:null,operations:{},conflicts:[]});const actual=created?snapshot:await this.load(request,input.article_id);if(actual.document_id!==input.document_id)throw new Error('ARTICLE_LAYOUT_DOCUMENT_ID_MISMATCH');return actual;}
 async save(request:RequestContext,articleId:string,input:{expected_version:number;snapshot:ArticleLayoutSnapshot}):Promise<ArticleLayoutSaveResult>{return this.saveInternal(request,articleId,input,'editor');}
 /** Server consumer only: image facts come from the injected producer, never from the edit request. */
 async adoptImages(request:RequestContext,articleId:string,input:{expected_version:number}):Promise<ArticleLayoutSaveResult>{
  const command=articleLayoutCommandIdentity('adoptImages',articleId,input),replay=await this.replayCommand(request,articleId,command);if(replay)return replay;
  if(!this.hooks.image_source)throw new Error('ARTICLE_LAYOUT_TRUSTED_IMAGE_SOURCE_REQUIRED');const current=await this.load(request,articleId),producer=await this.hooks.image_source.load(request,current.document_id);
  if(producer.document_revision_id!==current.document_revision_id||!producer.producer_version||!/^[a-f0-9]{64}$/.test(producer.source_sha256))throw new Error('ARTICLE_LAYOUT_IMAGE_PRODUCER_FENCE');let next=current;for(const image of producer.images){if(image.image.source_sha256!==producer.source_sha256)throw new Error('ARTICLE_LAYOUT_IMAGE_PRODUCER_FENCE');next=adoptArticleImage(next,image);}return this.saveInternal(request,articleId,{expected_version:input.expected_version,snapshot:next},'images',command);
 }
 /** Server consumer only（C1）：按可信 producer 的整组配图重建图片块，文字块编辑保留；不经平台稿修订围栏（排版不回写平台稿）。 */
 async syncImages(request:RequestContext,articleId:string,input:{expected_version:number},bind?:(final_id:string)=>ArticleLayoutSourceBinding):Promise<ArticleLayoutSaveResult>{
  const command=articleLayoutCommandIdentity('syncImages',articleId,input),replay=await this.replayCommand(request,articleId,command);if(replay)return replay;
  if(!this.hooks.image_source)throw new Error('ARTICLE_LAYOUT_TRUSTED_IMAGE_SOURCE_REQUIRED');const current=await this.load(request,articleId),producer=await this.hooks.image_source.load(request,current.document_id);
  if(!producer.producer_version||!/^[a-f0-9]{64}$/.test(producer.source_sha256)||producer.images.some(i=>i.image.source_sha256!==producer.source_sha256||!i.placement))throw new Error('ARTICLE_LAYOUT_IMAGE_PRODUCER_FENCE');
  const next=replaceArticleImages(current,producer.images.map(i=>({id:i.id,image:i.image,caption:i.caption??'',anchor_block_id:i.placement!.anchor_block_id,position:i.placement!.position})));
  // 图片块、来源登记（这份终稿）与幂等回执在同一个提交事务里；重放只返回原回执，不动来源。
  return this.saveInternal(request,articleId,{expected_version:input.expected_version,snapshot:next},'images',command,bind?.(producer.source_sha256));
 }
 /** Server consumer only（C2）：给旧记录补齐图源事实；图源由服务端从配图终稿读出，不接受编辑请求里的图源。 */
 async backfillCredits(request:RequestContext,articleId:string,input:{expected_version:number;credits:Record<string,ArticleImageCredit>}):Promise<ArticleLayoutSaveResult>{
  const command=articleLayoutCommandIdentity('backfillCredits',articleId,input),replay=await this.replayCommand(request,articleId,command);if(replay)return replay;
  const current=await this.load(request,articleId);return this.saveInternal(request,articleId,{expected_version:input.expected_version,snapshot:backfillArticleImageCredits(current,input.credits)},'images',command);
 }
 /** 不回写平台稿时没有外部副作用：中断留下的待提交保存直接作废（本机未提交稿仍在浏览器缓存里）。 */
 async discardInterruptedLocalSave(request:RequestContext,articleId:string):Promise<void>{
  // 只作废真正中断的保存：本进程里正在提交的写入（例如另一个并发读取的补图源）不算中断；作废时待提交项已变（刚提交/已被作废）就不再处理。
  if(this.hooks.document_writeback!==false)return;const record=await this.repository.read(request.workspace_id,articleId);if(!record?.pending||IN_FLIGHT.has(record.pending.id))return;
  try{await this.repository.reject(request.workspace_id,articleId,record.pending.id,'interrupted_local_save');}catch(error){if((error as Error).message!=='ARTICLE_LAYOUT_SAVE_FENCE')throw error;}
 }
 /** Server consumer only: loads the original adapter journal identity/proof; no client result is accepted. */
 async syncCheck(request:RequestContext,articleId:string,input:{expected_version:number;attempt_id:string}):Promise<ArticleLayoutSaveResult>{
  const command=articleLayoutCommandIdentity('syncCheck',articleId,input),replay=await this.replayCommand(request,articleId,command);if(replay)return replay;
  if(!this.hooks.check_source)throw new Error('ARTICLE_LAYOUT_TRUSTED_CHECK_SOURCE_REQUIRED');const current=await this.load(request,articleId),execution=await this.hooks.check_source.load(input.attempt_id);
  if(!execution)throw new Error('ARTICLE_LAYOUT_CHECK_SOURCE_FENCE');assertLayoutCheckExecutionProof(execution);
  if(execution.attempt.attempt_id!==input.attempt_id||execution.attempt.binding.article_id!==articleId||execution.fixture&&!this.hooks.allow_fixture_checks)throw new Error('ARTICLE_LAYOUT_CHECK_SOURCE_FENCE');
  assertLayoutCheckAttempt(execution.attempt);
  if(execution.attempt.state==='completed'&&(!execution.proof.original_input_verified||!execution.attempt.native.thread_id||!execution.attempt.native.turn_id||!execution.proof.output_sha256))throw new Error('ARTICLE_LAYOUT_CHECK_PROOF_REQUIRED');
  if(execution.attempt.state==='completed'&&execution.proof.output_sha256!==digest(execution.attempt.result))throw new Error('ARTICLE_LAYOUT_CHECK_OUTPUT_HASH_MISMATCH');const old=current.checks.find(c=>c.id===execution.attempt.id);let next:ArticleLayoutSnapshot;
  if(old)next=recordLayoutCheck(current,execution.attempt);else{next=registerLayoutCheck(current,{...execution.attempt,state:'intent',result:null});if(execution.attempt.state!=='intent')next=recordLayoutCheck(next,execution.attempt);}return this.saveInternal(request,articleId,{expected_version:input.expected_version,snapshot:next},'check',command);
 }
 /** Dedicated human action. The service boundary supplies request actor and the original decision reference. */
 async confirm(request:RequestContext,articleId:string,input:{expected_version:number;human_decision_ref:string}):Promise<ArticleLayoutSaveResult>{
  const command=articleLayoutCommandIdentity('confirm',articleId,{...input,actor:request.request_identity_ref}),replay=await this.replayCommand(request,articleId,command);if(replay)return replay;
  if(!request.request_identity_ref||!input.human_decision_ref)throw new Error('ARTICLE_LAYOUT_HUMAN_DECISION_REQUIRED');const current=await this.load(request,articleId),next=confirmArticleLayout(current,{actor:request.request_identity_ref,human_decision_ref:input.human_decision_ref,layout_only:this.hooks.document_writeback===false});return this.saveInternal(request,articleId,{expected_version:input.expected_version,snapshot:next},'confirm',command);
 }
 private async replayCommand(request:RequestContext,articleId:string,command:ArticleLayoutCommandIdentity):Promise<ArticleLayoutSaveResult|null>{
  if(!request.idempotency_key)throw new Error('ARTICLE_LAYOUT_IDEMPOTENCY_REQUIRED');const record=await this.repository.read(request.workspace_id,articleId);if(!record)throw new Error('ARTICLE_LAYOUT_NOT_FOUND');const replay=replayArticleLayoutCommand(record,request.idempotency_key,command);if(replay)return replay;
  if(record.pending){if(record.pending.operation_key===request.idempotency_key)assertArticleLayoutCommandIdentity(record.pending,command);throw new ArticleLayoutSaveUnknown(record.pending,new Error('save already pending'));}return null;
 }
 private async saveInternal(request:RequestContext,articleId:string,input:{expected_version:number;snapshot:ArticleLayoutSnapshot},mode:'editor'|'images'|'check'|'confirm',command:ArticleLayoutCommandIdentity=articleLayoutCommandIdentity('editor',articleId,input),source?:ArticleLayoutSourceBinding):Promise<ArticleLayoutSaveResult>{
  if(!request.idempotency_key)throw new Error('ARTICLE_LAYOUT_IDEMPOTENCY_REQUIRED');const record=await this.repository.read(request.workspace_id,articleId);if(!record)throw new Error('ARTICLE_LAYOUT_NOT_FOUND');const hash=command.input_hash,operationKey=request.idempotency_key;
  const replay=replayArticleLayoutCommand(record,operationKey,command);if(replay)return replay;
  if(record.pending){if(record.pending.operation_key===operationKey)assertArticleLayoutCommandIdentity(record.pending,command);throw new ArticleLayoutSaveUnknown(record.pending,new Error('save already pending'));}
  if(record.snapshot.version!==input.expected_version)return{state:'conflict',current:record.snapshot,local:structuredClone(input.snapshot),reason:'layout_version_changed'};
  // 确认只由专用 confirm 写入：其他保存只要文字、排版或图片变了，服务端一律清掉确认（不依赖客户端，回退旧版本也不会复活旧确认）。
  if(mode!=='confirm'&&input.snapshot.confirmation!==null&&articleSnapshotChanged(record.snapshot,input.snapshot))input={...input,snapshot:{...input.snapshot,confirmation:null}};
  this.assertWrite(record.snapshot,input.snapshot,articleId,mode);const intent:ArticleLayoutSaveIntent={id:globalThis.crypto.randomUUID(),operation_key:operationKey,operation:command.operation,input_hash:hash,request:structuredClone(request),expected_version:input.expected_version,expected_document_revision_id:record.snapshot.document_revision_id,target:structuredClone(input.snapshot),phase:'prepared',saved_document_revision_id:null,created_at:new Date().toISOString()};
  // 登记在途要在写入待提交项之前，避免并发读取在两者之间把它当成中断的保存。
  const local=this.hooks.document_writeback===false;if(local)IN_FLIGHT.add(intent.id);let prepared=false;try{prepared=await this.repository.prepare(request.workspace_id,articleId,input.expected_version,intent);}finally{if(!prepared)IN_FLIGHT.delete(intent.id);}
  if(!prepared){const concurrent=await this.repository.read(request.workspace_id,articleId);if(!concurrent)throw new Error('ARTICLE_LAYOUT_NOT_FOUND');const concurrentReplay=replayArticleLayoutCommand(concurrent,operationKey,command);if(concurrentReplay)return concurrentReplay;if(concurrent.pending?.operation_key===operationKey){assertArticleLayoutCommandIdentity(concurrent.pending,command);throw new ArticleLayoutSaveUnknown(concurrent.pending,new Error('same command is pending'));}return{state:'conflict',current:concurrent.snapshot,local:input.snapshot,reason:'layout_version_changed'};}
  // 不回写平台稿：校验通过后直接提交排版版本（同一 CAS 事务），平台稿修订不变。
  if(local){try{return{state:'saved',snapshot:await this.repository.commit(request.workspace_id,articleId,intent.id,structuredClone(intent.target),source,mode==='check'?this.hooks.before_check_commit:undefined)};}catch(error){throw new ArticleLayoutSaveUnknown(intent,error);}finally{IN_FLIGHT.delete(intent.id);}}
  try{
   const document=await this.documents.get(request,record.snapshot.document_id);if(document.head_revision_id!==intent.expected_document_revision_id)return this.repository.reject(request.workspace_id,articleId,intent.id,'document_revision_changed');
   const contentChanged=input.snapshot.content_revision_id!==record.snapshot.content_revision_id||input.snapshot.text_hash!==record.snapshot.text_hash;
   const saved=contentChanged?await this.documents.save({...request,idempotency_key:'article-layout:'+articleId+':'+operationKey},record.snapshot.document_id,{expected_revision_id:intent.expected_document_revision_id,text:serializeArticleText(input.snapshot),origin:'human'}):{revision_id:document.head_revision_id};
   intent.saved_document_revision_id=saved.revision_id;intent.phase='document_saved';await this.repository.updatePending(request.workspace_id,articleId,intent);this.hooks.after_document_checkpoint?.();
   const final=this.bindDocument(intent.target,saved.revision_id);const snapshot=await this.repository.commit(request.workspace_id,articleId,intent.id,final);return{state:'saved',snapshot};
  }catch(error){if((error as {code?:string}).code==='REVISION_CONFLICT')return this.repository.reject(request.workspace_id,articleId,intent.id,'document_revision_changed');throw new ArticleLayoutSaveUnknown(intent,error);}
 }
 async saveContent(request:RequestContext,articleId:string,input:{expected_version:number;snapshot:ArticleLayoutSnapshot}){return this.save(request,articleId,input);}
 async saveLayout(request:RequestContext,articleId:string,input:{expected_version:number;snapshot:ArticleLayoutSnapshot}){return this.save(request,articleId,input);}
 /** Read/checkpoint recovery only. No DocumentPort.save, model submit or retry. */
 async recover(request:RequestContext,articleId:string):Promise<{state:'ready';snapshot:ArticleLayoutSnapshot}|{state:'unknown';intent_id:string;local:ArticleLayoutSnapshot}|ArticleLayoutSaveResult>{
  const record=await this.repository.read(request.workspace_id,articleId);if(!record)throw new Error('ARTICLE_LAYOUT_NOT_FOUND');const intent=record.pending;if(!intent)return{state:'ready',snapshot:record.snapshot};if(intent.phase!=='document_saved')return{state:'unknown',intent_id:intent.id,local:intent.target};
  const doc=await this.documents.get(request,record.snapshot.document_id);if(doc.head_revision_id!==intent.saved_document_revision_id||doc.text!==serializeArticleText(intent.target))return this.repository.reject(request.workspace_id,articleId,intent.id,'recovery_document_changed');const final=this.bindDocument(intent.target,intent.saved_document_revision_id);return{state:'saved',snapshot:await this.repository.commit(request.workspace_id,articleId,intent.id,final)};
 }
 private bindDocument(target:ArticleLayoutSnapshot,revisionId:string|null):ArticleLayoutSnapshot{
  const next=structuredClone(target),pendingId=next.content_revision_id;next.document_revision_id=revisionId;if(revisionId&&pendingId!==revisionId){next.content_revision_id=revisionId;for(const revision of next.content_history){if(revision.id===pendingId){revision.id=revisionId;revision.document_revision_id=revisionId;}if(revision.parent_id===pendingId)revision.parent_id=revisionId;}for(const event of next.events){if(event.after_content_revision_id===pendingId)event.after_content_revision_id=revisionId;if(event.before_content_revision_id===pendingId)event.before_content_revision_id=revisionId;}/* pending checks/confirmation remain attached to their exact old input and become stale */}
  assertArticleSnapshot(next);return next;
 }
 private assertWrite(current:ArticleLayoutSnapshot,next:ArticleLayoutSnapshot,articleId:string,mode:'editor'|'images'|'check'|'confirm'){
  assertArticleSnapshot(next);if(next.article_id!==articleId||next.document_id!==current.document_id||next.version!==current.version)throw new Error('ARTICLE_LAYOUT_SAVE_IDENTITY');if(next.original_text!==current.original_text||digest(next.upstream_review)!==digest(current.upstream_review))throw new Error('ARTICLE_LAYOUT_ORIGINAL_REVIEW_IMMUTABLE');
  if(digest(next.content_order)!==digest(current.content_order))throw new Error('ARTICLE_LAYOUT_CONTENT_IDS_IMMUTABLE');
  const originalBlocks=new Map(current.blocks.filter(b=>'original_text' in b).map(b=>[b.id,b]));for(const block of next.blocks){if('original_text' in block){const old=originalBlocks.get(block.id);if(!old||!('original_text' in old)||block.original_text!==old.original_text||block.source_prefix!==old.source_prefix||block.source_suffix!==old.source_suffix)throw new Error('ARTICLE_LAYOUT_BLOCK_SOURCE_IMMUTABLE');}}
  for(const [oldHistory,newHistory] of [[current.content_history,next.content_history],[current.layout_history,next.layout_history],[current.events,next.events]] as const){if(newHistory.length<oldHistory.length||digest(newHistory.slice(0,oldHistory.length))!==digest(oldHistory))throw new Error('ARTICLE_LAYOUT_HISTORY_IMMUTABLE');}
  if(next.text_hash!==articleTextHash(next))throw new Error('ARTICLE_LAYOUT_HASH_MISMATCH');
  const changed=articleSnapshotChanged(current,next);
  if(mode!=='check'&&digest(next.checks)!==digest(current.checks))throw new Error('ARTICLE_LAYOUT_CHECK_SOURCE_REQUIRED');
  if(mode!=='check'&&digest(next.active_render)!==digest(current.active_render)&&!(changed&&next.active_render===null))throw new Error('ARTICLE_LAYOUT_RENDER_SOURCE_REQUIRED');
  if(mode!=='confirm'&&digest(next.confirmation)!==digest(current.confirmation)&&!(changed&&next.confirmation===null))throw new Error('ARTICLE_LAYOUT_CONFIRM_SOURCE_REQUIRED');
  if(mode!=='images'&&digest(next.blocks.filter(b=>b.kind==='image').map(b=>({id:b.id,image:b.image})))!==digest(current.blocks.filter(b=>b.kind==='image').map(b=>({id:b.id,image:b.image}))))throw new Error('ARTICLE_LAYOUT_IMAGE_SOURCE_REQUIRED');
  if(digest(next.standard)!==digest(current.standard))throw new Error('ARTICLE_LAYOUT_STANDARD_SOURCE_REQUIRED');
  const allowedEditorEvents=['manual_text','style','reorder','image_width','content_restore','layout_restore','brand_block'];if(mode==='editor'&&next.events.slice(current.events.length).some(e=>!allowedEditorEvents.includes(e.kind)))throw new Error('ARTICLE_LAYOUT_EDITOR_EVENT_INVALID');
  const currentChecks=new Map(current.checks.map(c=>[c.id,c]));
  for(const old of currentChecks.values()){const updated=next.checks.find(c=>c.id===old.id);if(!updated||updated.job_id!==old.job_id||updated.attempt_id!==old.attempt_id||updated.input_manifest_sha256!==old.input_manifest_sha256||digest(updated.binding)!==digest(old.binding))throw new Error('ARTICLE_LAYOUT_CHECK_HISTORY_IMMUTABLE');}
 }
}
