import {ContractError,type RequestContext} from '@workbench/contracts';
import type {ArticleImageCredit,ArticleLayoutImageSync,ArticleLayoutSaveResult,ArticleLayoutSnapshot,ArticleLayoutSourceBinding,ArticleLayoutView} from '../../../contracts/src/article-layout.ts';
import {SqliteArticleLayoutRepository,type ArticleLayoutRecord} from '../../../storage/src/article-layout/index.ts';
import {readImagePlanFinal} from '../../../storage/src/image-studio/index.ts';
import {Documents,assertRequestIdentity} from '../documents/index.ts';
import type {ApplicationContext} from '../ports/index.ts';
import type {ImageStudio} from '../artifact-execution/image-studio/index.ts';
import type {ImagePlans} from '../artifact-execution/image-studio/plan.ts';
import {ArticleLayoutService,ArticleLayoutSaveUnknown,type ArticleLayoutCheckSource} from './service.ts';
import {createArticleLayout,replaceArticleImages,isArticleImageBlock,articleConfirmationIsCurrent,runLayoutChecks} from './index.ts';
import {PlanFinalImageSource,imagesFromFinal,layoutArticleId,layoutImageBlockId,mapParagraphBlocks,studioCreditUrls} from './plan-final-source.ts';
// 公众号排版（C1）编排：从「平台稿当前文本 + 配图终稿」初始化图文块；保存只写排版自己的块版本（不调用 Documents.save，平台稿修订不变）；
// 配图重新确认后按终稿重建图片块，文字块编辑保留。
const KNOWN:Record<string,{code:'NOT_FOUND'|'IDEMPOTENCY_CONFLICT'|'VALIDATION_ERROR';message:string}>={
 ARTICLE_LAYOUT_NOT_FOUND:{code:'NOT_FOUND',message:'这篇文章还没有开始排版，先确认配图再进入排版'},
 ARTICLE_LAYOUT_IDEMPOTENCY_CONFLICT:{code:'IDEMPOTENCY_CONFLICT',message:'同一次保存的内容不一致，请刷新后再改'},
};
/** 叶子层抛的是内部错误码；接口只给用户语言，内部码放进 details.reason 供诊断。 */
export function articleLayoutError(error:unknown):never{
 if(error instanceof ContractError)throw error;
 if(error instanceof ArticleLayoutSaveUnknown)throw new ContractError('RESULT_UNKNOWN','上一次保存的结果还没确认，刷新后再改',{reason:'save_pending'});
 const code=error instanceof Error?error.message:'';const known=KNOWN[code];
 if(known)throw new ContractError(known.code,known.message,{reason:code});
 if(code.startsWith('ARTICLE_LAYOUT_'))throw new ContractError('VALIDATION_ERROR','这次修改没能保存，刷新后再改',{reason:code});
 throw error;
}
export class ArticleLayoutStudio {
 readonly context:ApplicationContext;readonly image:Pick<ImageStudio,'currentArticle'>;readonly plans:Pick<ImagePlans,'finalStatus'>;readonly repository:SqliteArticleLayoutRepository;
 constructor(context:ApplicationContext,deps:{image:Pick<ImageStudio,'currentArticle'>;plans:Pick<ImagePlans,'finalStatus'>;check_source?:ArticleLayoutCheckSource;allow_fixture_checks?:boolean}){this.context=context;this.image=deps.image;this.plans=deps.plans;this.repository=new SqliteArticleLayoutRepository(context.db);this.check_source=deps.check_source;this.allow_fixture_checks=deps.allow_fixture_checks===true;}
 private readonly check_source?:ArticleLayoutCheckSource;private readonly allow_fixture_checks:boolean;
 private service(image_source?:PlanFinalImageSource,before_check_commit?:()=>void){return new ArticleLayoutService(this.repository,new Documents(this.context),{document_writeback:false,before_check_commit,...(image_source?{image_source}:{}),...(this.check_source?{check_source:this.check_source}:{}),allow_fixture_checks:this.allow_fixture_checks});}
 private topicTitle(request:RequestContext,topic:string){const row=this.context.db.prepare('SELECT title FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,topic);if(!row)throw new ContractError('NOT_FOUND','主题不存在');return String(row.title);}
 private title(snapshot:ArticleLayoutSnapshot){return snapshot.order.find(id=>snapshot.blocks.find(b=>b.id===id)?.kind==='title')??null;}
 private async record(request:RequestContext,topic:string):Promise<ArticleLayoutRecord&{source:ArticleLayoutSourceBinding}>{
  const record=await this.repository.read(request.workspace_id,layoutArticleId(topic));if(!record)throw new ContractError('NOT_FOUND','这篇文章还没有开始排版，先确认配图再进入排版');
  if(!record.source||record.source.topic_id!==topic)throw new ContractError('INPUT_STALE','排版记录缺少来源，请重新进入排版');return record as ArticleLayoutRecord&{source:ArticleLayoutSourceBinding};
 }
 private async imageState(request:RequestContext,topic:string,source:ArticleLayoutSourceBinding):Promise<{state:ArticleLayoutImageSync;final_confirmed_at:string|null}>{
  const final=readImagePlanFinal(this.context.db,request.workspace_id,topic);if(final&&final.id!==source.final_id)return{state:'final_updated',final_confirmed_at:final.confirmed_at};
  // 读不到配图确认摘要时如实说「无法确认」，不当作已同步。
  let current:boolean;try{current=(await this.plans.finalStatus(request,topic)).current;}catch{return{state:'unknown',final_confirmed_at:final?.confirmed_at??null};}
  return{state:current?'synced':'plan_changed',final_confirmed_at:final?.confirmed_at??null};
 }
 /** 读取排版；中断留下的未提交保存直接作废（没有外部写入），本机未提交稿仍在浏览器里。 */
 async view(request:RequestContext,topic:string):Promise<ArticleLayoutView>{
  assertRequestIdentity(this.context,request);const title=this.topicTitle(request,topic);
  try{await this.service().discardInterruptedLocalSave(request,layoutArticleId(topic));}catch(error){articleLayoutError(error);}
  let record=await this.record(request,topic);const credits=this.creditState(request,topic,record.snapshot);let pending:string[]=[];
  // C2：C1 旧记录补齐网络图图源（写排版自己的新版本，不回写平台稿）；固定幂等键，重复读取只补一次。
  // 尽力而为：版本冲突、在途写入或围栏失败时放弃这次补写，直接返回当前快照，下次读取再补；读取本身绝不因此失败。
  // 已有确认（不论是否仍有效）的记录不自动补写（补写会让确认失效），改为在检查里提示「重新同步配图可补全图源」，由用户显式操作。
  if(Object.keys(credits.found).length){
   if(record.snapshot.confirmation!==null)pending=Object.keys(credits.found);
   else{try{const result=await this.service().backfillCredits({...request,idempotency_key:'article-layout-credit-backfill:'+record.snapshot.layout_revision_id+':'+record.snapshot.content_revision_id},layoutArticleId(topic),{expected_version:record.snapshot.version,credits:credits.found});if(result.state==='saved')record=await this.record(request,topic);}catch{/* 放弃本次补写 */}
    try{record=await this.record(request,topic);}catch{/* 保留已读到的快照 */}}
  }
  const left=this.creditState(request,topic,record.snapshot);if(record.snapshot.confirmation===null)pending=[];else pending=Object.keys(left.found);
  return{topic_id:topic,topic_title:title,snapshot:record.snapshot,images:{...await this.imageState(request,topic,record.source),count:record.snapshot.blocks.filter(isArticleImageBlock).length,credit_missing:left.missing,credit_pending:pending}};
 }
 /** 没有图源事实的图片块：在当前配图终稿里按块 ID + 图片版本找到对应项；网络图补图源，找不到的记为 missing。 */
 private creditState(request:RequestContext,topic:string,snapshot:ArticleLayoutSnapshot):{found:Record<string,ArticleImageCredit>;missing:string[]}{
  const pending=snapshot.blocks.filter(isArticleImageBlock).filter(b=>!b.image.credit),found:Record<string,ArticleImageCredit>={},missing:string[]=[];if(!pending.length)return{found,missing};
  const final=readImagePlanFinal(this.context.db,request.workspace_id,topic),url=studioCreditUrls(this.context,request,topic);
  for(const b of pending){const item=final?.items.find(i=>layoutImageBlockId(topic,i.item_id)===b.id&&i.version_id===b.image.version_id);if(!item){missing.push(b.id);continue;}const label=item.credit_label?.trim();if(label)found[b.id]={label,url:url(item)};}
  return{found,missing};
 }
 /** 进入排版：已有排版直接返回；没有时按平台稿当前文本与配图终稿初始化（须先确认配图，且平台稿没在确认后改过）。 */
 async open(request:RequestContext,input:{topic_id:string}):Promise<ArticleLayoutView>{
  assertRequestIdentity(this.context,request);const topic=input.topic_id;this.topicTitle(request,topic);
  if(!await this.repository.read(request.workspace_id,layoutArticleId(topic))){
   const article=await this.image.currentArticle(request,topic),final=readImagePlanFinal(this.context.db,request.workspace_id,topic);
   if(!final)throw new ContractError('VALIDATION_ERROR','还没有确认配图，先在配图里确认');
   if(final.document_id!==article.document_id||final.document_revision_id!==article.document_revision_id)throw new ContractError('INPUT_STALE','平台稿在配图确认后改过，回到配图重新确认后再排版');
   let snapshot=createArticleLayout({article_id:layoutArticleId(topic),document_id:article.document_id,document_revision_id:article.document_revision_id,text:article.article_text});
   const source:ArticleLayoutSourceBinding={topic_id:topic,document_id:article.document_id,document_revision_id:article.document_revision_id,final_id:final.id,paragraph_blocks:mapParagraphBlocks(article.article_text,article.paragraphs,snapshot),synced_at:new Date().toISOString()};
   snapshot=replaceArticleImages(snapshot,imagesFromFinal(topic,final,source,this.title(snapshot),studioCreditUrls(this.context,request,topic)).map(i=>({id:i.id,image:i.image,caption:i.caption??'',anchor_block_id:i.placement!.anchor_block_id,position:i.placement!.position})));snapshot.version=1;
   // 并发进入时只有一个创建成功，其余读到同一份。
   await this.repository.create(request.workspace_id,{snapshot,pending:null,operations:{},conflicts:[],source});
  }
  return this.view(request,topic);
 }
 /** 保存块版本（文字、顺序、图片宽度、回退）；只写排版记录，不回写平台稿。版本冲突返回 conflict 与双方内容。 */
 async save(request:RequestContext,input:{topic_id:string;expected_version:number;snapshot:ArticleLayoutSnapshot}):Promise<ArticleLayoutSaveResult>{
  assertRequestIdentity(this.context,request);this.topicTitle(request,input.topic_id);await this.record(request,input.topic_id);
  try{return await this.service().save(request,layoutArticleId(input.topic_id),{expected_version:input.expected_version,snapshot:input.snapshot});}catch(error){return articleLayoutError(error);}
 }
 /** 确认排版（C2）：本机 15 条检查没有阻断项时，把当前排版版本（文字 + 版式 + 图片）冻结为排版终稿；之后任何修改都会让确认失效。
  * 检查在服务端按当前记录重跑，客户端不能绕过；只写排版记录，不回写平台稿、不提交草稿。 */
 async confirm(request:RequestContext,input:{topic_id:string;expected_version:number}):Promise<ArticleLayoutView>{
  assertRequestIdentity(this.context,request);const topic=input.topic_id,title=this.topicTitle(request,topic),record=await this.record(request,topic),id=layoutArticleId(topic);
  if(!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','缺少确认请求标识，请刷新后再确认');
  const replay=record.operations[request.idempotency_key];
  if(!replay){
   if(record.snapshot.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','排版刚在别处保存过，刷新后再确认');
   if(articleConfirmationIsCurrent(record.snapshot))return this.view(request,topic);
   const credit=this.creditState(request,topic,record.snapshot),report=runLayoutChecks(record.snapshot,{topic_title:title,credit_missing:credit.missing,credit_pending:Object.keys(credit.found)});
   if(report.blocking)throw new ContractError('VALIDATION_ERROR','还有 '+report.blocking+' 项阻断：'+report.results.filter(r=>r.level==='block').map(r=>r.title).join('、')+'，改好后再确认排版',{reason:'layout_check_blocking',rules:report.results.filter(r=>r.level==='block').map(r=>r.id)});
  }
  // 本机单人工作台：HTTP 请求不带登录身份时，以本工作区的本人记为确认人；确认标识随幂等键固定，同键重放只返回原回执。
  let result:ArticleLayoutSaveResult;try{result=await this.service().confirm({...request,request_identity_ref:request.request_identity_ref??'workspace-owner:'+request.workspace_id},id,{expected_version:input.expected_version,human_decision_ref:'wechat-layout-confirm:'+request.idempotency_key});}catch(error){return articleLayoutError(error);}
  if(result.state==='conflict')throw new ContractError('VERSION_CONFLICT','排版刚在别处保存过，刷新后再确认');
  return this.view(request,topic);
 }
 /** 重新同步配图：按最新配图终稿重建图片块（保留文字块编辑），并把排版来源登记到这份终稿。 */
 async syncImages(request:RequestContext,input:{topic_id:string;expected_version:number}):Promise<ArticleLayoutView>{
  assertRequestIdentity(this.context,request);const topic=input.topic_id;this.topicTitle(request,topic);const record=await this.record(request,topic);
  // 来源登记随图片块在同一提交事务里写入（final_id 取 producer 实际读到的终稿）；同键重放只返回原回执，不改来源。
  let result:ArticleLayoutSaveResult;try{result=await this.service(new PlanFinalImageSource(this.context,topic,record.source,this.title(record.snapshot))).syncImages(request,layoutArticleId(topic),{expected_version:input.expected_version},final_id=>({...record.source,final_id,synced_at:new Date().toISOString()}));}catch(error){return articleLayoutError(error);}
  if(result.state==='conflict')throw new ContractError('VERSION_CONFLICT','排版刚在别处保存过，刷新后再同步配图');
  return this.view(request,topic);
 }
 async syncVisualCheck(request:RequestContext,topicId:string,input:{expected_version:number;attempt_id:string},before_check_commit?:()=>void){const record=await this.record(request,topicId);return this.service(undefined,before_check_commit).syncCheck(request,record.snapshot.article_id,input);}

}
