import {randomUUID} from 'node:crypto';
import {readFileSync,openSync,readSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {ContractError,StudioBriefSchema,StudioGenerationSchema,StudioAdoptSchema,StudioConfirmSchema,StudioWebImportSchema,StudioAssetVersionSchema,studioVersionBlocks,type StudioAssetVersionRequest,type StudioAssetVersionResult,type StudioWebImportRequest,type StudioWebImportResult,type StudioWebImageCandidates,type StudioBriefInput,type StudioBrief,type StudioGenerationRequest,type StudioSnapshot,type StudioImageVersion,type StudioSlot,type JsonObject,type RequestContext} from '@workbench/contracts';
import {transaction,inputHash} from '@workbench/storage/connection';
import {readCommittedIdempotent,storeIdempotent} from '@workbench/storage/revisions';
import {readStudio,writeStudio,readImagePlan,writeImagePlan,type StudioState} from '../../../../storage/src/image-studio/index.ts';
import {analyzeImageBrief,imageBriefInputHash,imageCapabilities,validateSizeRequest,type ImageBriefAnalysisPort,type ImageBriefInput} from '../../../../adapters/src/media/image/index.ts';
import {appendStudioProcess,imageStudioRecordPaths,writeConfirmedStudioWiki} from '../../../../adapters/src/vault/image-studio.ts';
import {getJob,getAttempt} from '@workbench/storage/jobs';
import {Documents,assertRequestIdentity} from '../../documents/index.ts';
import {ImageGenerationWorkflow,readImageReceipt,consumeImageGenerationBudget} from '../image.ts';
import {verifyCommittedImageAsset} from '../../result-commit/image.ts';
import {controlledPath,verifiedFileHash} from '../../result-commit/media.ts';
import type {ApplicationContext} from '../../ports/index.ts';
import {buildStudioPromptContext,validateStudioPromptBudget} from './prompt.ts';
import {ImageAnalysisLifecycle} from './analysis-lifecycle.ts';
import {webImageCandidates,webImageCandidateState,webFetchOptions,WebCaptureRunner,type WebImageOptions} from './web-images.ts';
import {guardedFetch} from '../../../../adapters/src/web/public-fetch.ts';
import {MediaImporter} from '../import.ts';
import {imageJobProgress,cachedTypicalImageDuration,invalidateTypicalImageDuration} from './progress.ts';
const STUDIO_PROGRESS_STATES=['queued','running','reconciling','waiting_input','waiting_quota'];
export class ImageStudio {
 private readonly analysisLifecycle:ImageAnalysisLifecycle;
 // 网络找图的资讯原文后台抓取：同主题去重，关闭模块时中止并等待收尾。
 private readonly webCapture:WebCaptureRunner;
 readonly context:ApplicationContext;readonly options:{image?:ImageGenerationWorkflow;analysis?:ImageBriefAnalysisPort;record_root?:string|null;analysis_timeout_ms?:number;web?:WebImageOptions};
 constructor(context:ApplicationContext,options:ImageStudio['options']={}){this.context=context;this.options=options;this.analysisLifecycle=new ImageAnalysisLifecycle(options.analysis_timeout_ms);this.webCapture=new WebCaptureRunner(()=>this.options.web?.now?.()??Date.now());}
 private read(topic:string){return readStudio(this.context.db,this.context.identity.workspace_id,topic);}
 private write(state:StudioState){writeStudio(this.context.db,this.context.identity.workspace_id,state);}
 // 配图方案（A2）给每一项预留了槽位 ID：首次生成或导入时按方案落点建槽，之后与普通槽位一致。
 private reservedSlot(topic:string,slotId:string):StudioSlot|undefined{const item=readImagePlan(this.context.db,this.context.identity.workspace_id,topic).plan?.items.find(i=>i.slot_id===slotId&&!i.removed);return item?{id:slotId,title:item.purpose.slice(0,300),paragraph_id:item.paragraph_id,placement_paragraph_id:item.placement_paragraph_id,position:item.position,description:item.prompt_draft,provider:'codex',size_mode:'manual',references:[],active_version_id:null,versions:[]}:undefined;}
 // 本人删除的方案项（A2-2）：它的槽位不再接受新版本、不再入队生成；已有版本仍可从其他图找回。
 private assertSlotLive(topic:string,slotId:string|null){if(slotId&&readImagePlan(this.context.db,this.context.identity.workspace_id,topic).plan?.items.some(i=>i.slot_id===slotId&&i.removed))throw new ContractError('NOT_FOUND','这张配图已删除，不能再生成或加入新版本');}
 /** 当前定稿正文（按段落编号）；配图方案按同一套段落 ID 规划。 */
 currentArticle(request:RequestContext,topic:string){return this.article(request,topic);}
 /** 在调用方的写事务里核对正文未被人工改动。 */
 assertArticleFresh(request:RequestContext,topic:string,expected:{document_id:string;document_revision_id:string}){this.assertArticleCurrent(request,topic,expected);}
 private event(state:StudioState,kind:string,payload:unknown){state.events.push({id:randomUUID(),at:new Date().toISOString(),kind,payload});}
 private syncNotes(state:StudioState){if(this.options.record_root)for(const event of state.events)appendStudioProcess(this.options.record_root,state.topic_id,event);}
 private articleSelection(request:RequestContext,topic:string){
  assertRequestIdentity(this.context,request);const t=this.context.db.prepare('SELECT core_document_id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,topic);if(!t)throw new ContractError('NOT_FOUND','主题不存在');
  const variant=this.context.db.prepare("SELECT v.document_id,d.head_revision_id FROM variants v JOIN documents d ON d.workspace_id=v.workspace_id AND d.id=v.document_id WHERE v.workspace_id=? AND v.topic_id=? AND v.platform='wechat' AND d.head_revision_id IS NOT NULL ORDER BY v.rowid DESC LIMIT 1").get(request.workspace_id,topic);
  const document=variant??this.context.db.prepare('SELECT id AS document_id,head_revision_id FROM documents WHERE workspace_id=? AND id=?').get(request.workspace_id,t.core_document_id);
  if(!document?.head_revision_id)throw new ContractError('VALIDATION_ERROR','先保存公众号文章或核心稿，再添加配图');return{document_id:String(document.document_id),document_revision_id:String(document.head_revision_id),article_source:variant?'wechat' as const:'core' as const};
 }
 private assertArticleCurrent(request:RequestContext,topic:string,expected:{document_id:string;document_revision_id:string}){
  if(!this.context.db.isTransaction)throw new Error('Article freshness requires the writing transaction');const current=this.articleSelection(request,topic);
  if(current.document_id!==expected.document_id||current.document_revision_id!==expected.document_revision_id)throw new ContractError('INPUT_STALE','人工文章已保存新版本，重新核对配图后再采用或确认终稿',{current_document_id:current.document_id,current_revision_id:current.document_revision_id});
 }
 private async article(request:RequestContext,topic:string){
  const selected=this.articleSelection(request,topic),document=await new Documents(this.context).get(request,selected.document_id);
  if(!document.head_revision_id)throw new ContractError('VALIDATION_ERROR','先保存公众号文章或核心稿，再添加配图');
  const paragraphs=document.text.split(/\n\s*\n/).map(text=>text.trim()).filter(Boolean).map((text,index)=>({id:inputHash({revision:document.head_revision_id,index,text}).slice(0,32),index,text}));
  return{...selected,document_revision_id:document.head_revision_id,article_text:document.text,paragraphs};
 }
 private references(request:RequestContext,refs:StudioBriefInput['references']){
  return refs.map(ref=>{const row=this.context.db.prepare("SELECT id,file_path,sha256,size_bytes FROM assets WHERE workspace_id=? AND id=? AND kind='image' AND status='ready'").get(request.workspace_id,ref.asset_id);if(!row)throw new ContractError('NOT_FOUND','参考图未持久保存或不可用');
   const actual=verifiedFileHash(controlledPath(this.context.paths.media_root,String(row.file_path)));if(actual.sha256!==row.sha256||actual.size!==Number(row.size_bytes))throw new ContractError('INPUT_STALE','参考图真实文件已变化');return{asset_id:ref.asset_id,sha256:String(row.sha256),purpose:ref.purpose};});
 }
 private async briefInput(request:RequestContext,input:StudioBriefInput):Promise<{article:Awaited<ReturnType<ImageStudio['article']>>;frozen:ImageBriefInput}>{
  StudioBriefSchema.parse({topic_id:input.topic_id,document_revision_id:input.document_revision_id,paragraph_id:input.paragraph_id,placement_paragraph_id:input.placement_paragraph_id,description:input.description,title:input.title,position:input.position,provider:input.provider,references:input.references});const article=await this.article(request,input.topic_id);if(article.document_revision_id!==input.document_revision_id)throw new ContractError('INPUT_STALE','文章人工稿已变化，重新选择段落');const p=article.paragraphs.find(p=>p.id===input.paragraph_id);if(input.position!=='cover'&&!article.paragraphs.some(p=>p.id===input.placement_paragraph_id))throw new ContractError('INPUT_STALE','插入位置对应段落已变化');if(!p)throw new ContractError('INPUT_STALE','本次说明对应段落已变化');
  return{article,frozen:{provider:input.provider,paragraph:p.text,description:input.description,...(input.title?{title:input.title}:{}),insertion_point:input.position+':'+input.placement_paragraph_id,references:this.references(request,input.references),brand_version:inputHash(JSON.parse(readFileSync(join(import.meta.dirname,'../../../../../assets/visual-theme.json'),'utf8')))}};
 }
 /** 给进行中的 AI 生图版本附上真实进度（返回副本，不写回持久状态）；同一渠道的历史均值走缓存，版本转为成功时失效。 */
 private withProgress(workspace:string,slots:StudioState['slots']):StudioState['slots']{
  const typical=new Map<string,ReturnType<typeof cachedTypicalImageDuration>>(),now=Date.now();
  return slots.map(slot=>({...slot,versions:slot.versions.map(v=>{
   if(!v.job_id||v.asset_id||!STUDIO_PROGRESS_STATES.includes(v.state))return v;
   if(!typical.has(v.provider))typical.set(v.provider,cachedTypicalImageDuration(this.context.db,workspace,v.provider,now));
   const progress=imageJobProgress(this.context.db,workspace,v.job_id,typical.get(v.provider)!,now);return progress?{...v,progress}:v;})}));
 }
 async snapshot(request:RequestContext,topic:string):Promise<StudioSnapshot>{
  const article=await this.article(request,topic);const state=transaction(this.context.db,()=>{const state=this.read(topic);let changed=false;
   for(const slot of state.slots)for(const version of slot.versions){
    if(!version.job_id)continue;const job=getJob(this.context.db,request.workspace_id,version.job_id);
    if(['succeeded','size_mismatch','cancelled','failed'].includes(version.state)&&version.asset_id)continue;
    let next:string=job.state;let error:unknown;
    if(job.state==='succeeded'&&!job.cancel_requested_at){try{
     const receipt=this.context.db.prepare("SELECT attempt_id,output_payload FROM result_receipts WHERE workspace_id=? AND job_id=? AND state='committed'").get(request.workspace_id,job.id);if(!receipt)throw new Error('图像缺少已提交回执');const outputs=JSON.parse(String(receipt.output_payload)).typed_output.generated_assets;if(outputs.length!==1)throw new Error('图像输出不唯一');
     const attempt=getAttempt(this.context.db,request.workspace_id,String(receipt.attempt_id));verifyCommittedImageAsset(this.context,job,attempt,outputs[0]);const native=readImageReceipt(this.context,job.id,job.input_hash).result!;
     version.asset_id=outputs[0].asset_id;version.actual_size={width:native.width,height:native.height,aspect_ratio:native.width+':'+native.height};version.accepted_parameters=(native.native.accepted_image_parameters??null) as JsonObject|null;
     version.size_match=native.width===version.size_request.width&&native.height===version.size_request.height;const aspect=Math.abs(native.width/native.height-version.size_request.width/version.size_request.height)/(version.size_request.width/version.size_request.height);
     version.size_warning=version.size_match?null:aspect<=0.02?'返回画幅符合提示，实际像素与期望不同；没有拉伸、裁切或补发':'返回画幅与期望不符；保留原始图片，未拉伸、裁切或补发';next=aspect>0.02?'size_mismatch':'succeeded';
    }catch(e){next='unknown';error=e;}}
    else if(job.cancel_requested_at)next='cancelled';
    if(next!==version.state&&['succeeded','size_mismatch'].includes(next))invalidateTypicalImageDuration(this.context.db,request.workspace_id,version.provider);
    if(next!==version.state||error){version.state=next;version.error=error instanceof Error?error.message:null;changed=true;this.event(state,'image_observed',{slot_id:slot.id,version});}
   }
   if(changed){state.version++;this.write(state);}return state;});this.syncNotes(state);
  const rows=this.context.db.prepare("SELECT a.id,a.mime,a.sha256,a.size_bytes,a.generation_metadata FROM assets a JOIN topic_asset_links l ON l.workspace_id=a.workspace_id AND l.asset_id=a.id WHERE a.workspace_id=? AND l.topic_id=? AND a.kind='image' AND a.status='ready'").all(request.workspace_id,topic);
  return{topic_id:topic,...article,version:state.version,slots:this.withProgress(request.workspace_id,state.slots),briefs:state.briefs,references:rows.map(row=>({id:String(row.id),mime:String(row.mime),sha256:String(row.sha256),size_bytes:Number(row.size_bytes),purpose:'已持久保存的主题图片'})),capabilities:['codex','agy'].map(provider=>imageCapabilities(provider as 'codex'|'agy')),recording:{process_record:this.options.record_root?imageStudioRecordPaths(this.options.record_root,topic).process:'pending_record_root_registration',wiki_confirmation_required:true,wiki_record:state.wiki_record}};
 }
 brief(request:RequestContext,input:StudioBriefInput,options:{signal?:AbortSignal}={}):Promise<StudioBrief>{
  return this.analysisLifecycle.run(signal=>this.performBrief(request,input,signal),options.signal);
 }
 beginClose(){this.analysisLifecycle.beginClose();this.webCapture.beginClose();}
 async close(){await Promise.all([this.analysisLifecycle.close(),this.webCapture.close()]);}
 /** 测试与诊断：等当前的原文后台抓取结束。 */
 webCaptureIdle(){return this.webCapture.idle();}
 webCaptureSnapshot(){return this.webCapture.snapshot();}
 analysisSnapshot(){return this.analysisLifecycle.snapshot();}
 private async performBrief(request:RequestContext,input:StudioBriefInput,signal:AbortSignal):Promise<StudioBrief>{
  const {frozen}=await this.briefInput(request,input);signal.throwIfAborted();validateStudioPromptBudget(input.description,buildStudioPromptContext({paragraph:frozen.paragraph,title:input.title}));const digest=imageBriefInputHash(frozen),prior=this.read(input.topic_id),existing=prior.briefs.find(b=>b.input_digest===digest&&b.document_revision_id===input.document_revision_id);if(existing)return existing;
  if(prior.brief_invocations[digest]&&prior.brief_invocations[digest]!.state!=='retryable')throw new ContractError('RESULT_UNKNOWN','原内容分析已提交或状态未知，保留原记录；没有新模型提交',{brief_id:prior.brief_invocations[digest]!.id});if(!this.options.analysis)throw new ContractError('CAPABILITY_UNVERIFIED','内容分析通道未装配，手动模式仍可用');
  const id=randomUUID();transaction(this.context.db,()=>{const state=this.read(input.topic_id);if(state.brief_invocations[digest]&&state.brief_invocations[digest]!.state!=='retryable')throw new ContractError('RESULT_UNKNOWN','原内容分析已有提交意图，未重复调用');state.brief_invocations[digest]={id,state:'intent',input:frozen,native:{},error:null};this.event(state,'brief_intent',{id,input_digest:digest,input:frozen});this.write(state);});this.syncNotes(this.read(input.topic_id));
  try{const result=await analyzeImageBrief(frozen,this.options.analysis,{signal});const fresh=await this.article(request,input.topic_id);signal.throwIfAborted();if(fresh.document_revision_id!==input.document_revision_id)throw new ContractError('INPUT_STALE','内容分析期间人工文章已变化，结果保留但不能采用');
   const brief:StudioBrief={...input,id,reason:result.recommendation.reason,suggested_size:{width:result.recommendation.width,height:result.recommendation.height,aspect_ratio:result.recommendation.aspect_ratio},content_analysis:result.analysis as unknown as JsonObject,native:result.provenance as unknown as JsonObject,input_digest:digest,created_at:new Date().toISOString()};
   transaction(this.context.db,()=>{const state=this.read(input.topic_id);this.assertArticleCurrent(request,input.topic_id,fresh);state.briefs.push(brief);state.brief_invocations[digest]={...state.brief_invocations[digest]!,state:'completed',native:brief.native};this.event(state,'brief_completed',brief);this.write(state);});this.syncNotes(this.read(input.topic_id));return brief;
  }catch(error){
   // 执行器确认未提交（含槽位占满）时可重试：不写 unknown，同输入可再次提交；只有提交结果不明才禁止重发。
   if(error instanceof ContractError&&error.details.pre_submit_failure===true&&error.details.resume_submission_unknown!==true&&error.details.slot_state_unknown!==true){transaction(this.context.db,()=>{const state=this.read(input.topic_id);state.brief_invocations[digest]={...state.brief_invocations[digest]!,state:'retryable',error:error.message};this.event(state,'brief_not_submitted',{id,input_digest:digest,error:error.message,capacity_busy:error.details.executor_capacity_busy===true});this.write(state);});this.syncNotes(this.read(input.topic_id));throw error;}
   transaction(this.context.db,()=>{const state=this.read(input.topic_id);state.brief_invocations[digest]={...state.brief_invocations[digest]!,state:'unknown',error:error instanceof Error?error.message:String(error)};this.event(state,'brief_unknown',{id,input_digest:digest,error:state.brief_invocations[digest]!.error});this.write(state);});this.syncNotes(this.read(input.topic_id));throw error;}
 }
 async generate(request:RequestContext,input:StudioGenerationRequest){
  StudioGenerationSchema.parse(input);const {article,frozen}=await this.briefInput(request,input),size_request={...input.size,mode:input.size_mode,policy:'prompt_guided' as const};validateSizeRequest(size_request);
  // 与弹窗、设置页同一可用判定：不可用的渠道在入队前拒绝，不计预算；已提交请求的幂等重放不受影响。
  if(!readCommittedIdempotent(this.context.db,request,'image-studio.generate',input))await (this.options.image??new ImageGenerationWorkflow(this.context)).assertProviderAvailable(request,input.provider);
  const queued=transaction(this.context.db,()=>{this.assertArticleCurrent(request,input.topic_id,article);const replay=readCommittedIdempotent<{job_id:string;slot_id:string;version_id:string;input_hash:string}>(this.context.db,request,'image-studio.generate',input);if(replay)return replay;
   const state=this.read(input.topic_id);if(state.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','配图版本已变化，请刷新');
   this.assertSlotLive(input.topic_id,input.slot_id);
   if(input.size_mode==='auto'){const brief=state.briefs.find(b=>b.id===input.brief_id);if(!brief||brief.input_digest!==imageBriefInputHash(frozen)||brief.document_revision_id!==input.document_revision_id||inputHash(brief.suggested_size)!==inputHash(input.size))throw new ContractError('INPUT_STALE','自动建议与当前内容或画幅不符，重新分析或切换手动');}
   const samePending=state.slots.flatMap(s=>s.versions).find(v=>!v.asset_id&&['queued','running','reconciling','waiting_input','waiting_quota','unknown','cancelled'].includes(v.state)&&v.provider===input.provider&&v.description===input.description&&v.paragraph_id===input.paragraph_id&&inputHash({width:v.size_request.width,height:v.size_request.height,aspect_ratio:v.size_request.aspect_ratio})===inputHash(input.size));if(samePending)throw new ContractError('RESULT_UNKNOWN','相同配图已有原提交，保留原ID，未新建提交',{job_id:samePending.job_id});
   let slot=input.slot_id?state.slots.find(s=>s.id===input.slot_id):undefined;const reservedId=input.slot_id&&!slot&&this.reservedSlot(input.topic_id,input.slot_id)?input.slot_id:null;if(input.slot_id&&!slot&&!reservedId)throw new ContractError('NOT_FOUND','本篇配图不存在');
   const parent=input.parent_version_id?slot?.versions.find(v=>v.id===input.parent_version_id):undefined;if(input.parent_version_id&&(!parent?.asset_id||!['succeeded','size_mismatch'].includes(parent.state)))throw new ContractError('INPUT_STALE','修改须基于本图已保存的真实版本');
    // 标注坐标按原图实际比例核对（viewBox 宽 1000、高 1000×h/w）：长图下部的标注不会被误拒，图外的标注会被拒。
    if(input.marks?.length){const base=parent?.actual_size;if(!base)throw new ContractError('VALIDATION_ERROR','标注只能用在基于原图的修改上');const H=1000*base.height/base.width+10,inside=(x:number,y:number)=>x>=-10&&x<=1010&&y>=-10&&y<=H;
     // 涂抹路径逐点核对（M/L 后的每对坐标），数字不成对或任一点在图外都拒绝。
     const brushInside=(path:string)=>{const n=(path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)??[]).map(Number);if(n.length%2||/[^MLml\d\s.,eE+-]/.test(path))return false;for(let i=0;i<n.length;i+=2)if(!inside(n[i]!,n[i+1]!))return false;return true;};if(input.marks.some(m=>!inside(m.x,m.y)||!inside(m.ex,m.ey)||m.type==='rect'&&!inside(m.x+m.w,m.y+m.h)||m.type==='brush'&&!brushInside(m.path)))throw new ContractError('VALIDATION_ERROR','标注超出了图片范围，请重新标注');}
    if(input.model){const models=(imageCapabilities(input.provider).models as Array<{id:string}>|undefined)??[];if(!models.some(m=>m.id===input.model))throw new ContractError('VALIDATION_ERROR','所选渠道没有这个生图模型');}
   if(slot?.versions.some(studioVersionBlocks))throw new ContractError('RESULT_UNKNOWN','本图已有原任务或未知结果，未创建第二提交');
   const refs=[...input.references];if(input.operation==='reference_edit'){
    if(input.provider!=='agy')throw new ContractError('CAPABILITY_UNVERIFIED','Codex基于原图修改尚未核实；可选择生成新画幅版本');
    if(parent?.asset_id){if(refs.length&&refs[0]!.asset_id!==parent.asset_id)throw new ContractError('CAPABILITY_UNSUPPORTED','当前通道只支持一张参考，原图与额外参考不能合并');if(!refs.length)refs.push({asset_id:parent.asset_id,purpose:'content'});}
    if(refs.length!==1)throw new ContractError('VALIDATION_ERROR','基于原图修改需一张已保存原图');
   }else if(refs.length)throw new ContractError('CAPABILITY_UNVERIFIED','参考图已保存；本通道新增时混合参考未准入，请选择AGY基于参考图修改');
   this.references(request,refs);if(parent?.asset_id)this.references(request,[{asset_id:parent.asset_id,purpose:'content'}]);
   if(!slot){slot={id:reservedId??randomUUID(),title:input.title,paragraph_id:input.paragraph_id,placement_paragraph_id:input.placement_paragraph_id,position:input.position,description:input.description,provider:input.provider,size_mode:input.size_mode,references:refs,active_version_id:null,versions:[]};state.slots.push(slot);}else if(!slot.active_version_id)Object.assign(slot,{title:input.title,paragraph_id:input.paragraph_id,placement_paragraph_id:input.placement_paragraph_id,position:input.position,description:input.description,provider:input.provider,size_mode:input.size_mode,references:refs});
   const version:StudioImageVersion={id:randomUUID(),operation:input.operation,paragraph_id:input.paragraph_id,placement_paragraph_id:input.placement_paragraph_id,position:input.position,job_id:'',asset_id:null,state:'queued',provider:input.provider,description:input.description,title:input.title,size_request,accepted_parameters:null,actual_size:null,size_match:null,size_warning:null,references:refs,parent_version_id:parent?.id??null,document_revision_id:input.document_revision_id,created_at:new Date().toISOString(),adoption:'pending',error:null,...(input.marks?.length?{marks:structuredClone(input.marks)}:{}),...(input.candidate_only?{candidate_only:true}:{}),...(input.model?{model:input.model}:{})};
   const context_prompt=buildStudioPromptContext({paragraph:frozen.paragraph,title:input.title,parent:parent?{asset_id:parent.asset_id,description:parent.description,actual_size:parent.actual_size}:null});validateStudioPromptBudget(input.description,context_prompt);const prompt=input.description;
   // 生产预算闸门：在入队事务里只对真正新建的任务扣额（复用已有同输入任务不计数），超限即拒绝；放开须人工调整服务配置。
   const q=(this.options.image??new ImageGenerationWorkflow(this.context)).enqueueInTransaction({...request,idempotency_key:'studio-image:'+inputHash({key:request.idempotency_key})},{generator:'image',provider:input.provider,operation:input.operation,topic_id:input.topic_id,purpose:'公众号配图 · '+input.position,prompt,input_asset_ids:refs.map(r=>r.asset_id),parent_asset_id:input.operation==='reference_edit'?refs[0]!.asset_id:null,document_revision_id:article.document_revision_id,plan_revision_id:null,size_request,studio_binding:{context_prompt,slot_id:slot.id,version_id:version.id,document_id:article.document_id,paragraph_id:input.paragraph_id,placement_paragraph_id:input.placement_paragraph_id,position:input.position,title:input.title,parent_version_id:version.parent_version_id,references:refs}},()=>consumeImageGenerationBudget(this.context,request.workspace_id,input.provider));
   version.job_id=q.job_id;slot.versions.push(version);state.version++;this.event(state,'image_queued',{slot_id:slot.id,version,brief_id:input.brief_id,manual_override:input.size_mode==='manual',prompt});this.write(state);const response={job_id:q.job_id,slot_id:slot.id,version_id:version.id,input_hash:q.input_hash};storeIdempotent(this.context.db,request,'image-studio.generate',input,response);return response;});this.syncNotes(this.read(input.topic_id));return queued;
 }
 // 采用的核心校验与写入：调用方须已在写事务里核对正文；配图方案在同一事务里一并更新当前图（A2）。
 // 采用前的完整校验：本槽位真实保存的版本、对应当前正文、文件仍与记录一致。
 private validateAdoption(request:RequestContext,state:StudioState,slotId:string,versionId:string,revision:string){
   const slot=state.slots.find(s=>s.id===slotId),version=slot?.versions.find(v=>v.id===versionId);if(!slot||!version?.asset_id||!['succeeded','size_mismatch'].includes(version.state))throw new ContractError('INPUT_STALE','只能采用本图实际保存的版本');
   if(version.document_revision_id!==revision)throw new ContractError('INPUT_STALE','人工文章已改，旧配图保留但不能覆盖新稿关联');this.references(request,[{asset_id:version.asset_id,purpose:'content'}]);return{slot,version};
 }
 private applyAdoption(request:RequestContext,state:StudioState,slotId:string,versionId:string,revision:string,kind='human_adopted'){
   const {slot,version}=this.validateAdoption(request,state,slotId,versionId,revision);
   Object.assign(slot,{active_version_id:version.id,paragraph_id:version.paragraph_id,placement_paragraph_id:version.placement_paragraph_id,position:version.position,title:version.title,description:version.description,provider:version.provider,size_mode:version.size_request.mode,references:version.references});
   version.adoption='adopted';state.version++;this.event(state,kind,{slot_id:slotId,version_id:version.id,actual_size:version.actual_size,size_warning:version.size_warning});this.write(state);
 }
 /** 在调用方的写事务里采用某一版（不另开事务、不另记幂等）；失败随调用方事务整体回滚。 */
 adoptInTransaction(request:RequestContext,topic:string,slotId:string,versionId:string,article:{document_id:string;document_revision_id:string}){
  if(!this.context.db.isTransaction)throw new Error('Adoption requires the writing transaction');this.assertArticleCurrent(request,topic,article);const state=this.read(topic);
  // 先完整校验（版本对应当前正文、文件仍在），再判断已是采用版本可免写入；旧稿图片不能借「已采用」绕过校验。
  this.validateAdoption(request,state,slotId,versionId,article.document_revision_id);if(state.slots.find(s=>s.id===slotId)?.active_version_id===versionId)return;this.applyAdoption(request,state,slotId,versionId,article.document_revision_id);
 }
 /** 配图方案的当前图即采用（A2-2）：在调用方的写事务里把方案项当前图登记为槽位采用版本。
  * 不抛错：正文已改或版本不再可用时跳过（方案会显示过期/待处理），返回是否写入了新的采用。 */
 syncPlanAdoptionsInTransaction(request:RequestContext,topic:string,pairs:Array<{slot_id:string;version_id:string}>,article:{document_id:string;document_revision_id:string}):boolean{
  if(!this.context.db.isTransaction)throw new Error('Adoption requires the writing transaction');if(!pairs.length)return false;
  try{this.assertArticleCurrent(request,topic,article);}catch{return false;}
  const state=this.read(topic);let changed=false;
  // 只在方案当前版比现有采用更新（版本序号更大）时补写：本人显式采用的旧版不会被读取覆盖。
  for(const pair of pairs){const slot=state.slots.find(s=>s.id===pair.slot_id);if(!slot||slot.active_version_id===pair.version_id)continue;
   // 批量重新生成的候选版本（A2-2）只能由本人显式采用，读取时不自动登记。
   if(slot.versions.find(v=>v.id===pair.version_id)?.candidate_only)continue;const at=(id:string|null)=>id?slot.versions.findIndex(v=>v.id===id):-1;if(slot.active_version_id&&at(pair.version_id)<=at(slot.active_version_id))continue;try{this.validateAdoption(request,state,pair.slot_id,pair.version_id,article.document_revision_id);}catch{continue;}this.applyAdoption(request,state,pair.slot_id,pair.version_id,article.document_revision_id,'plan_current_adopted');changed=true;}
  return changed;
 }
 /** 采用写入后同步过程记录（事务提交后调用）。 */
 recordProcess(topic:string){this.syncNotes(this.read(topic));}
 async adopt(request:RequestContext,slotId:string,input:{topic_id:string;expected_version:number;version_id:string}){
  assertRequestIdentity(this.context,request);StudioAdoptSchema.parse(input);const operation='image-studio.adopt:'+slotId;
  const replay=readCommittedIdempotent<StudioSnapshot>(this.context.db,request,operation,input);if(replay)return replay;
  const before=await this.snapshot(request,input.topic_id);
  const result=transaction(this.context.db,()=>{this.assertArticleCurrent(request,input.topic_id,before);const state=this.read(input.topic_id);if(state.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','配图列表已变化，请刷新后采用');
   this.applyAdoption(request,state,slotId,input.version_id,before.document_revision_id);
   // 配图方案里对应这一槽位的项同一事务改用这一版（当前图即采用的反向），之后的读取不会把采用改回去。
   const plan=readImagePlan(this.context.db,request.workspace_id,input.topic_id),item=plan.plan?.items.find(i=>i.slot_id===slotId),slot=state.slots.find(s=>s.id===slotId)!;
   if(item&&item.current_version_id!==input.version_id){item.current_version_id=input.version_id;item.cleared=false;item.seen_versions=Math.max(item.seen_versions,slot.versions.length);plan.version++;writeImagePlan(this.context.db,request.workspace_id,plan);}
   const response={...before,version:state.version,slots:state.slots};storeIdempotent(this.context.db,request,operation,input,response);return response;});this.syncNotes(this.read(input.topic_id));return result;
 }
 // 网络找图：候选只来自本工作区已有资料与原文一次受控抓取；导入时服务端按候选 ID 重新定位，不信任客户端给的地址。
 // 只读缓存立即返回；需要时后台读取资讯原文，状态见 capture。refresh=true 是用户点「重新读取」：失败冷却期内也立即重试。
 async webCandidates(request:RequestContext,topic:string,options:{refresh?:boolean}={}):Promise<StudioWebImageCandidates>{assertRequestIdentity(this.context,request);return webImageCandidateState(this.context,request,topic,{...this.options.web,runner:this.webCapture,...(options.refresh?{refresh:true}:{})});}
 async webImport(request:RequestContext,input:StudioWebImportRequest,internal:{auto_selected?:boolean;onCommit?:(imported:{slot_id:string;version_id:string;index:number})=>boolean|void}={}):Promise<StudioWebImportResult>{
  assertRequestIdentity(this.context,request);StudioWebImportSchema.parse(input);const operation='image-studio.web-import';
  const replay=readCommittedIdempotent<StudioWebImportResult>(this.context.db,request,operation,input);if(replay)return replay;
  if(!this.context.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,input.topic_id))throw new ContractError('NOT_FOUND','主题不存在');if(this.read(input.topic_id).version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','配图版本已变化，请刷新');
  const candidates=await webImageCandidates(this.context,request,input.topic_id,{...this.options.web,capture:false}),candidate=candidates.find(c=>c.candidate_id===input.candidate.candidate_id&&c.image_url===input.candidate.image_url);
  if(!candidate)throw new ContractError('NOT_FOUND','这张候选图片不存在或来源已变化，请重新打开网络找图');if(candidate.availability==='expired')throw new ContractError('VALIDATION_ERROR','这张图片的平台链接已过期，请换一张');
  const article=await this.article(request,input.topic_id),web=this.options.web??{},captured_at=new Date(web.now?.()??Date.now()).toISOString();
  const download=await guardedFetch(candidate.image_url,'image',{...webFetchOptions(web),timeout_ms:web.image_timeout_ms??20000,...(web.max_image_bytes?{max_bytes:web.max_image_bytes}:{})});
  const source={page_url:candidate.page_url,image_url:candidate.image_url,page_title:candidate.page_title??null,author:candidate.author_name??null,site:candidate.site_name??null,platform:candidate.platform,captured_at,credit_label:candidate.credit_label};
  // 资产入库、主题关联与版本追加在同一事务：版本冲突等拒绝时整体回滚并删除未提交文件，不留孤儿资产。
  let result:StudioWebImportResult|undefined;
  const imported=await new MediaImporter(this.context).importFile({...request,idempotency_key:'studio-web:'+inputHash({key:request.idempotency_key})},(async function*(){yield new Uint8Array(download.bytes);})(),{kind:'image',mime:download.mime,topic_id:input.topic_id,purpose:'网络配图',source_kind:'web_reference',origin:'web',total_bytes:download.bytes.length},{commit:imported=>{
   const replayed=readCommittedIdempotent<StudioWebImportResult>(this.context.db,request,operation,input);if(replayed){result=replayed;return;}this.assertArticleCurrent(request,input.topic_id,article);const state=this.read(input.topic_id);if(state.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','配图版本已变化，请刷新');
   this.assertSlotLive(input.topic_id,input.slot_id);const asset=this.context.db.prepare('SELECT dimensions FROM assets WHERE workspace_id=? AND id=?').get(request.workspace_id,imported.asset_id),dims=asset?.dimensions?JSON.parse(String(asset.dimensions)) as {width:number;height:number}:null;
   if(!dims?.width||!dims.height)throw new ContractError('VALIDATION_ERROR','图片无法读取宽高，未加入配图版本');
   let slot=input.slot_id?state.slots.find(s=>s.id===input.slot_id):undefined;const reserved=input.slot_id&&!slot?this.reservedSlot(input.topic_id,input.slot_id):undefined;if(input.slot_id&&!slot&&!reserved)throw new ContractError('NOT_FOUND','本篇配图不存在');if(reserved){slot=reserved;state.slots.push(slot);}
   const first=article.paragraphs[0];if(!first)throw new ContractError('VALIDATION_ERROR','文章还没有可放置配图的段落');
   if(!slot){slot={id:randomUUID(),title:(candidate.page_title??'网络配图').slice(0,300),paragraph_id:first.id,placement_paragraph_id:first.id,position:'after',description:candidate.credit_label,provider:'codex',size_mode:'manual',references:[],active_version_id:null,versions:[]};state.slots.push(slot);}
   const placed=article.paragraphs.some(p=>p.id===slot!.paragraph_id)&&(slot.position==='cover'||article.paragraphs.some(p=>p.id===slot!.placement_paragraph_id));
   const size={width:Number(dims.width),height:Number(dims.height),aspect_ratio:dims.width+':'+dims.height};
   const version:StudioImageVersion={id:randomUUID(),operation:'web_import',paragraph_id:placed?slot.paragraph_id:first.id,placement_paragraph_id:placed?slot.placement_paragraph_id:first.id,position:placed?slot.position:'after',job_id:null,asset_id:imported.asset_id,state:'succeeded',provider:slot.provider,description:candidate.credit_label,title:slot.title,size_request:{...size,mode:'manual',policy:'prompt_guided'},accepted_parameters:null,actual_size:size,size_match:true,size_warning:null,references:[],parent_version_id:null,document_revision_id:article.document_revision_id,created_at:new Date().toISOString(),adoption:'pending',error:null,source,...(internal.auto_selected?{auto_selected:true}:{})};
   slot.versions.push(version);state.version++;this.event(state,'web_image_imported',{slot_id:slot.id,version_id:version.id,asset_id:imported.asset_id,deduplicated:imported.deduplicated,source,...(internal.auto_selected?{auto_selected:true}:{})});
   // 调用方（配图方案自动选源）在同一事务里登记这一版的归属；版本落库、方案项更新与采用一起提交或一起回滚。
   // 方案把这一版设为当前图时即登记采用（当前图即采用）。
   const adopt=internal.onCommit?.({slot_id:slot.id,version_id:version.id,index:slot.versions.length-1})===true;
   if(adopt)this.applyAdoption(request,state,slot.id,version.id,article.document_revision_id,'plan_current_adopted');else this.write(state);
   result={slot_id:slot.id,version_id:version.id,asset_id:imported.asset_id,deduplicated:imported.deduplicated,version:state.version};storeIdempotent(this.context.db,request,operation,input,result);
  }});
  if(!result){const replayed=readCommittedIdempotent<StudioWebImportResult>(this.context.db,request,operation,input);if(!replayed||replayed.asset_id!==imported.asset_id)throw new ContractError('RESULT_UNKNOWN','导入结果未能确认，请刷新后核对版本列表');result=replayed;}
  this.syncNotes(this.read(input.topic_id));return result;
 }
 // 上传图片或从已删除的配图找回（A2-2）：已保存在本篇的图片作为槽位新的一版原图，可采用、可在其上修改；不调用生图、不扣预算。
  async assetVersion(request:RequestContext,input:StudioAssetVersionRequest):Promise<StudioAssetVersionResult>{
   assertRequestIdentity(this.context,request);StudioAssetVersionSchema.parse(input);const operation='image-studio.asset-version';
   const replay=readCommittedIdempotent<StudioAssetVersionResult>(this.context.db,request,operation,input);if(replay)return replay;
   const article=await this.article(request,input.topic_id);
   const result=transaction(this.context.db,()=>{const again=readCommittedIdempotent<StudioAssetVersionResult>(this.context.db,request,operation,input);if(again)return again;
    this.assertArticleCurrent(request,input.topic_id,article);const state=this.read(input.topic_id);if(state.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','配图版本已变化，请刷新');
    this.assertSlotLive(input.topic_id,input.slot_id);
    const row=this.context.db.prepare("SELECT a.dimensions,a.mime,a.file_path,a.size_bytes FROM assets a JOIN topic_asset_links l ON l.workspace_id=a.workspace_id AND l.asset_id=a.id WHERE a.workspace_id=? AND l.topic_id=? AND a.id=? AND a.kind='image' AND a.status='ready'").get(request.workspace_id,input.topic_id,input.asset_id);
    if(!row)throw new ContractError('NOT_FOUND','这张图片不在本篇素材里或还没保存好');if(!['image/png','image/jpeg','image/webp'].includes(String(row.mime)))throw new ContractError('VALIDATION_ERROR','只支持 PNG、JPG 或 WebP 图片');
    const dims=row.dimensions?JSON.parse(String(row.dimensions)) as {width:number;height:number}:null;if(!dims?.width||!dims.height)throw new ContractError('VALIDATION_ERROR','图片无法读取宽高，未加入配图版本');
    this.references(request,[{asset_id:input.asset_id,purpose:'content'}]);
    // 真实文件格式与大小在服务端再核对一次（不只信声明的 mime）：PNG / JPEG / WebP 魔数，15MB 以内。
    if(Number(row.size_bytes)>15*1024*1024)throw new ContractError('VALIDATION_ERROR','图片超过 15MB，请压缩后再上传');
    {const head=Buffer.alloc(12),fd=openSync(controlledPath(this.context.paths.media_root,String(row.file_path)),'r');try{readSync(fd,head,0,12,0);}finally{closeSync(fd);}const png=head.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),jpeg=head[0]===0xff&&head[1]===0xd8&&head[2]===0xff,webp=head.subarray(0,4).toString('latin1')==='RIFF'&&head.subarray(8,12).toString('latin1')==='WEBP';if(!png&&!jpeg&&!webp)throw new ContractError('VALIDATION_ERROR','文件内容不是 PNG、JPG 或 WebP 图片');}
    // 找回：原版本须是本篇里同一张图；复制图源，终稿署名不丢。
    const origin=input.recover_version_id?state.slots.flatMap(s=>s.versions).find(v=>v.id===input.recover_version_id):undefined;if(input.recover_version_id&&(!origin||origin.asset_id!==input.asset_id))throw new ContractError('NOT_FOUND','要找回的图片版本不存在');
    let slot=state.slots.find(s=>s.id===input.slot_id);if(!slot){const reserved=this.reservedSlot(input.topic_id,input.slot_id);if(!reserved)throw new ContractError('NOT_FOUND','本篇配图不存在');slot=reserved;state.slots.push(slot);}
    if(slot.versions.some(studioVersionBlocks))throw new ContractError('RESULT_UNKNOWN','本图已有原任务或未知结果，先等它结束');
    const first=article.paragraphs[0];if(!first)throw new ContractError('VALIDATION_ERROR','文章还没有可放置配图的段落');
    const placed=article.paragraphs.some(p=>p.id===slot!.paragraph_id)&&(slot.position==='cover'||article.paragraphs.some(p=>p.id===slot!.placement_paragraph_id));
    const size={width:Number(dims.width),height:Number(dims.height),aspect_ratio:dims.width+':'+dims.height},name=input.name?.trim()||null;
    const version:StudioImageVersion={id:randomUUID(),operation:'upload',paragraph_id:placed?slot.paragraph_id:first.id,placement_paragraph_id:placed?slot.placement_paragraph_id:first.id,position:placed?slot.position:'after',job_id:null,asset_id:input.asset_id,state:'succeeded',provider:slot.provider,description:name?'上传的图片：'+name:'上传的图片',title:slot.title,size_request:{...size,mode:'manual',policy:'prompt_guided'},accepted_parameters:null,actual_size:size,size_match:true,size_warning:null,references:[],parent_version_id:null,document_revision_id:article.document_revision_id,created_at:new Date().toISOString(),adoption:'pending',error:null,upload:{purpose:input.purpose??null,name},...(origin?{recovered_from:origin.id,...(origin.source?{source:structuredClone(origin.source)}:{})}:{})};
    slot.versions.push(version);state.version++;this.event(state,'image_uploaded',{slot_id:slot.id,version_id:version.id,asset_id:input.asset_id,purpose:input.purpose??null});this.write(state);
    const response={slot_id:slot.id,version_id:version.id,asset_id:input.asset_id,version:state.version};storeIdempotent(this.context.db,request,operation,input,response);return response;});
   this.syncNotes(this.read(input.topic_id));return result;
  }
  async confirm(request:RequestContext,input:{topic_id:string;document_revision_id:string;expected_version:number;confirmed:true}){
  assertRequestIdentity(this.context,request);StudioConfirmSchema.parse(input);const operation='image-studio.confirm-final';const replay=readCommittedIdempotent<StudioSnapshot>(this.context.db,request,operation,input);if(replay)return replay;
  const before=await this.snapshot(request,input.topic_id);if(before.document_revision_id!==input.document_revision_id)throw new ContractError('INPUT_STALE','当前文章版本已变，不能确认旧终稿');if(!this.options.record_root)throw new ContractError('CAPABILITY_UNVERIFIED','Wiki新记录路径未登记；不会写原Vault');
  const result=transaction(this.context.db,()=>{this.assertArticleCurrent(request,input.topic_id,before);const state=this.read(input.topic_id);if(state.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','配图采用记录已变');
   // 配图方案里已跳过的项不纳入终稿（含下载中跳过留下的候选槽位）；其余槽位仍须逐图由本人采用。
   const planItems=readImagePlan(this.context.db,request.workspace_id,input.topic_id).plan?.items??[],skipped=new Set(planItems.filter(i=>i.skipped||i.removed).map(i=>i.slot_id)),included=state.slots.filter(s=>!skipped.has(s.id));// 已删除（A2-2）的项同样不纳入；方案项的插入位置以方案为准。
   if(!included.length||included.some(s=>!s.active_version_id))throw new ContractError('VALIDATION_ERROR','先逐图由本人采用，再确认终稿');
   const slots=included.map(s=>{const version=s.versions.find(v=>v.id===s.active_version_id);if(!version?.asset_id||version.document_revision_id!==before.document_revision_id||!['succeeded','size_mismatch'].includes(version.state))throw new ContractError('INPUT_STALE','采用图片须对应当前文章并已实际保存');this.references(request,[{asset_id:version.asset_id,purpose:'content'}]);if(s.versions.some(v=>!v.asset_id&&['queued','running','reconciling','waiting_input','waiting_quota','unknown','cancelled'].includes(v.state)))throw new ContractError('RESULT_UNKNOWN','本图仍有原任务待核对，终稿尚不能确认');const planned=planItems.find(i=>i.slot_id===s.id&&!i.removed);return{slot_id:s.id,paragraph_id:planned?.paragraph_id??s.paragraph_id,placement_paragraph_id:planned?.placement_paragraph_id??s.placement_paragraph_id,position:planned?.position??s.position,version};});
   const record={schema_version:'image-studio-final/1',topic_id:input.topic_id,document_revision_id:before.document_revision_id,article_text:before.article_text,slots,confirmed_via:'explicit_workbench_confirmation',publisher_submitted:false};
   const path=writeConfirmedStudioWiki(this.options.record_root!,input.topic_id,before.document_revision_id,record);state.wiki_record=path;state.version++;this.event(state,'human_final_confirmed',{document_revision_id:before.document_revision_id,wiki_record:path});this.write(state);
   const response={...before,version:state.version,slots:state.slots,recording:{...before.recording,wiki_record:path}};storeIdempotent(this.context.db,request,operation,input,response);return response;});this.syncNotes(this.read(input.topic_id));return result;
 }
}
