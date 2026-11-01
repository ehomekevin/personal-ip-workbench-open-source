import {randomUUID} from 'node:crypto';
import {ContractError,executorAvailability,imageGenerationLimit,imagePlanBodyLimit,parseImagePlanDraft,ImagePlanRunSchema,ImagePlanItemUpdateSchema,ImagePlanItemCreateSchema,ImagePlanConfirmSchema,IMAGE_PLAN_JOB_KIND,IMAGE_PLAN_SCHEMA,IMAGE_PLAN_FINAL_SCHEMA,type ImagePlanConfirmRequest,type ImagePlanFinal,type ImagePlanFinalItem,type ImagePlanFinalSummary,type ImagePlanFrozenInput,type ImagePlanItem,type ImagePlanItemUpdate,type ImagePlanItemCreate,type ImagePlanPosition,type ImagePlanItemView,type ImagePlanRunRequest,type ImagePlanRunState,type ImagePlanSnapshot,type ImagePlanState,type ImagePlanStrategy,type ImagePlanAspect,type JsonObject,type RequestContext,type StudioSnapshot,type StudioSlot,type StudioWebImageCandidate} from '@workbench/contracts';
import {transaction,inputHash} from '@workbench/storage/connection';
import {readCommittedIdempotent,storeIdempotent} from '@workbench/storage/revisions';
import {getJob} from '@workbench/storage/jobs';
import {workspaceSettings} from '@workbench/storage/settings';
import {readImagePlan,writeImagePlan,readGenerationBudget,readStudio,readImagePlanFinal,writeImagePlanFinal} from '../../../../storage/src/image-studio/index.ts';
import {assertRequestIdentity} from '../../documents/index.ts';
import {ContentGeneration} from '../../content-agents/index.ts';
import type {ApplicationContext} from '../../ports/index.ts';
import type {ImageStudio} from './index.ts';
import {webImageCandidates} from './web-images.ts';
import {readImagePlanSkill,imagePlanInstruction,frozenImagePlan,IMAGE_PLAN_EXECUTION} from './plan-skill.ts';
// 配图方案（A2）：执行器规划落点与来源 → 服务端自动导入原文/帖子图 → 本人逐张生成与修改。
// 规划走写作同一条执行器任务路径（ContentGeneration + 并发槽位），不扣生图预算；方案与真实图片版本分开保存。
const ACTIVE_RUN=['queued','running','waiting'],PENDING_VERSION=['queued','running','reconciling','waiting_input','waiting_quota'],UNSETTLED_VERSION=['unknown','cancelled'];
const ok=(v:{asset_id:string|null;state:string})=>!!v.asset_id&&['succeeded','size_mismatch'].includes(v.state);
const STOP=new Set(['我们','一个','这个','那个','就是','因为','所以','但是','然后','可以','没有','什么','自己','他们','你们','已经','还是','如果','这样','不是','时候','现在','也是','都是','之后','之前','一些','这些','那些','进行','通过','以及','或者','而且','这种','其中','为了']);
/** 段落与候选标题的关键词：中文取相邻两字，英文与数字取 3 个字符以上的词。 */
export function planKeywords(text:string):Set<string>{
 const out=new Set<string>(),lower=text.toLowerCase();
 for(const run of lower.match(/[\p{Script=Han}]+/gu)??[])for(let i=0;i+1<run.length;i++){const pair=run.slice(i,i+2);if(!STOP.has(pair))out.add(pair);}
 for(const word of lower.match(/[a-z0-9][a-z0-9.+-]{2,}/g)??[])out.add(word);
 return out;
}
export function planKeywordScore(keys:Set<string>,text:string):number{const other=planKeywords(text);let n=0;for(const k of keys)if(other.has(k))n++;return n;}
const candidateGroup=(c:StudioWebImageCandidate):'article_original'|'platform_post'=>c.platform==='article'?'article_original':'platform_post';
const candidateText=(c:StudioWebImageCandidate)=>[c.page_title,c.site_name,c.author_name,c.credit_label].filter(Boolean).join(' ');
const nearestAspect=(w:number,h:number):ImagePlanAspect=>{const r=w/h,list:Array<[ImagePlanAspect,number]>=[['16:9',16/9],['4:3',4/3],['1:1',1],['3:4',3/4],['9:16',9/16],['2:5',2/5]];return list.reduce((best,c)=>Math.abs(c[1]-r)<Math.abs(best[1]-r)?c:best)[0];};
export class ImagePlans {
 readonly context:ApplicationContext;readonly studio:ImageStudio;
 private readonly inflight=new Map<string,Promise<void>>();
 constructor(context:ApplicationContext,studio:ImageStudio){this.context=context;this.studio=studio;}
 private read(topic:string){return readImagePlan(this.context.db,this.context.identity.workspace_id,topic);}
 private write(state:ImagePlanState){writeImagePlan(this.context.db,this.context.identity.workspace_id,state);}
 private topicTitle(request:RequestContext,topic:string){const row=this.context.db.prepare('SELECT title FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,topic);if(!row)throw new ContractError('NOT_FOUND','主题不存在');return String(row.title);}
 // 读取时先把规划任务与图片版本投影进方案：任务结束只落一次；新出现的成功版本自动成为这一项的当前图。
 // 当前图即采用：同一事务里把当前图登记为槽位采用版本（含旧数据里已有当前图但未采用的槽位，幂等）。返回是否改动了槽位采用。
 private refresh(request:RequestContext,topic:string,studio:StudioSnapshot):boolean{
  return transaction(this.context.db,()=>{const state=this.read(topic);let changed=false;
   const run=state.run;if(run&&ACTIVE_RUN.includes(run.state)){let job;try{job=getJob(this.context.db,request.workspace_id,run.job_id);}catch{job=null;}
    if(job){const next=job.state==='queued'?'queued':['running','cancel_requested'].includes(job.state)?'running':['waiting_input','waiting_quota','reconciling'].includes(job.state)?'waiting':job.state==='succeeded'?'succeeded':job.state==='cancelled'?'cancelled':'failed';
     if(next==='succeeded'){const settled=this.materialize(request,state,run.document_id,job.id,JSON.parse(job.input_manifest) as JsonObject);run.state=settled.error?'failed':'succeeded';run.error=settled.error;run.settled_at=new Date().toISOString();changed=true;}
     else if(next==='failed'||next==='cancelled'){run.state=next;run.error=next==='cancelled'?'这次规划已取消，可以重新规划。':this.failureCopy(request,job.id);run.settled_at=new Date().toISOString();changed=true;}
     else if(next!==run.state){run.state=next as ImagePlanRunState;changed=true;}}}
   const plan=state.plan;if(plan){
    // 方案以外的已有配图（旧面板、手动新增、上一版方案里已配好的图）作为「手动」项保留，不丢图。
    const known=new Set(plan.items.map(i=>i.slot_id));let seq=Math.max(0,...plan.items.map(i=>i.seq));
    for(const slot of studio.slots)if(!known.has(slot.id)&&slot.versions.length){const last=[...slot.versions].reverse().find(ok)??slot.versions.at(-1)!,size=last.actual_size??last.size_request;
     plan.items.push({id:randomUUID(),role:'manual',slot_id:slot.id,paragraph_id:slot.paragraph_id,placement_paragraph_id:slot.placement_paragraph_id,position:slot.position,seq:seq+=10,purpose:(slot.title||last.title||'正文配图').slice(0,120),source_strategy:last.operation==='web_import'?(last.source?.platform==='article'?'article_original':'platform_post'):'ai_generate',aspect:nearestAspect(size.width,size.height),prompt_draft:(slot.description||'正文配图').slice(0,2000),candidate_id:null,skipped:false,auto:{state:'none',candidate_id:null,error:null},current_version_id:null,cleared:false,seen_versions:0});changed=true;}
    for(const item of plan.items){const slot=studio.slots.find(s=>s.id===item.slot_id);if(!slot)continue;
     let latest=-1;slot.versions.forEach((v,i)=>{if(ok(v))latest=i;});
     // 自动选源导入的版本由导入事务自己登记当前图；这里只跟进人工生成/导入的新版本，不改自动选源的归属。
     if(latest>=0&&latest>=item.seen_versions){const v=slot.versions[latest]!;if(!v.auto_selected&&!v.candidate_only){item.current_version_id=v.id;item.cleared=false;}item.seen_versions=latest+1;changed=true;}
     if(item.current_version_id&&!slot.versions.some(v=>v.id===item.current_version_id&&ok(v))){item.current_version_id=null;changed=true;}
}
   }
   if(changed){state.version++;this.write(state);}
   const pairs=(state.plan?.items??[]).filter(i=>i.current_version_id&&!i.cleared&&!i.removed).map(i=>({slot_id:i.slot_id,version_id:i.current_version_id!}));
   return this.studio.syncPlanAdoptionsInTransaction(request,topic,pairs,studio);
  });
 }
 private failureCopy(request:RequestContext,jobId:string){
  const row=this.context.db.prepare('SELECT error FROM job_attempts WHERE workspace_id=? AND job_id=? ORDER BY attempt_no DESC LIMIT 1').get(request.workspace_id,jobId);let error:{code?:string;message?:string}={};try{error=row?.error?JSON.parse(String(row.error)):{};}catch{error={};}
  return error.code==='VALIDATION_ERROR'&&error.message?'AI 给出的方案不合格（'+error.message+'），可以重新规划。':'这次规划没有完成，可以重新规划。';
 }
 // 读取已提交的方案候选，按冻结输入再校验一次；合格才落为方案。
 private materialize(request:RequestContext,state:ImagePlanState,documentId:string,jobId:string,manifest:JsonObject):{error:string|null}{
  let text:string|null=null;try{const generation=new ContentGeneration(this.context),candidate=generation.candidates(request,documentId).find(c=>c.job_id===jobId);text=candidate?generation.revision(request,documentId,candidate.revision_id).text:null;}catch{text=null;}
  if(!text?.trim())return{error:'方案读取失败，可以重新规划。'};
  let frozen:ImagePlanFrozenInput,draft;try{frozen=frozenImagePlan(manifest);draft=parseImagePlanDraft(text,frozen);}catch(error){return{error:'AI 给出的方案不合格（'+(error instanceof Error?error.message:'格式不对')+'），可以重新规划。'};}
  const index=new Map(frozen.paragraphs.map(p=>[p.id,p.index]));
  const items:ImagePlanItem[]=[{...draft.cover,role:'cover' as const},...draft.slots.map(s=>({...s,role:'body' as const}))].map((d,i)=>({id:randomUUID(),role:d.role,slot_id:randomUUID(),paragraph_id:d.paragraph_id,placement_paragraph_id:d.paragraph_id,position:d.position,seq:(i+1)*10,purpose:d.purpose,source_strategy:d.source_strategy,aspect:d.aspect,prompt_draft:d.prompt_draft,candidate_id:d.candidate_id,skipped:false,auto:{state:d.source_strategy==='ai_generate'?'none' as const:'pending' as const,candidate_id:null,error:null},current_version_id:null,cleared:false,seen_versions:0}));
  items.sort((a,b)=>this.anchor(a,index)-this.anchor(b,index)||a.seq-b.seq);items.forEach((item,i)=>{item.seq=(i+1)*10;});
  // 本人删除过的项随新方案保留（仍为已删除），避免它们的槽位被当作方案外的已有图重新加回来。
  state.plan={id:state.run!.id,article_revision_id:frozen.article_revision_id,created_at:new Date().toISOString(),items:[...items,...(state.plan?.items.filter(i=>i.removed)??[])]};return{error:null};
 }
 private anchor(item:Pick<ImagePlanItem,'position'|'placement_paragraph_id'>,index:Map<string,number>){return item.position==='cover'?-1:(index.get(item.placement_paragraph_id)??9999)*2+(item.position==='after'?1:0);}
 async snapshot(request:RequestContext,topic:string):Promise<ImagePlanSnapshot>{
  assertRequestIdentity(this.context,request);this.topicTitle(request,topic);let studio=await this.studio.snapshot(request,topic);if(this.refresh(request,topic,studio))studio=await this.studio.snapshot(request,topic);
  // 已有一次自动选源在进行（同主题）时不等待它，直接返回现状（这些项显示「正在找图」），避免修改请求被下载拖住。
  if(this.needsAuto(topic,studio)&&!this.inflight.has(request.workspace_id+'\n'+topic)){await this.autoSelect(request,topic);studio=await this.studio.snapshot(request,topic);if(this.refresh(request,topic,studio))studio=await this.studio.snapshot(request,topic);}
  return this.view(request,topic,studio);
 }
 // 已有当前图或人工版本时不再自动选源；只作候选留下的自动导入版本（unused）不阻断。
 private hasImage(item:Pick<ImagePlanItem,'current_version_id'|'slot_id'>,studio:Pick<StudioSnapshot,'slots'>){return!!item.current_version_id||!!studio.slots.find(s=>s.id===item.slot_id)?.versions.some(v=>!v.auto_selected);}
 private needsAuto(topic:string,studio:StudioSnapshot){return!!this.read(topic).plan?.items.some(i=>!i.skipped&&!i.removed&&i.source_strategy!=='ai_generate'&&i.auto.state==='pending'&&!this.hasImage(i,studio));}
 // 自动选源：方案给的候选优先，否则按段落关键词匹配首个可用候选；同一候选只用一次。同主题并发读取合并为一次，导入键按方案项固定，重复读取不会重复导入。
 private autoSelect(request:RequestContext,topic:string):Promise<void>{
  const key=request.workspace_id+'\n'+topic;let pending=this.inflight.get(key);if(!pending){pending=this.performAutoSelect(request,topic).finally(()=>this.inflight.delete(key));this.inflight.set(key,pending);}return pending;
 }
 private async performAutoSelect(request:RequestContext,topic:string){
  const plan=this.read(topic).plan;if(!plan)return;let studio=await this.studio.snapshot(request,topic);
  const todo=plan.items.filter(i=>!i.skipped&&!i.removed&&i.source_strategy!=='ai_generate'&&i.auto.state==='pending'&&!this.hasImage(i,studio));if(!todo.length)return;
  let candidates:StudioWebImageCandidate[]=[];try{candidates=(await webImageCandidates(this.context,request,topic,{...this.studio.options.web,capture:false})).filter(c=>c.availability!=='expired');}catch{candidates=[];}
  const used=new Set(plan.items.flatMap(i=>i.auto.candidate_id?[i.auto.candidate_id]:[]));
  const live=(id:string)=>{const s=this.read(topic);return s.plan?.id===plan.id?s.plan.items.find(i=>i.id===id):undefined;};
  const eligible=(i:ImagePlanItem|undefined,strategy:ImagePlanStrategy)=>!!i&&!i.skipped&&!i.removed&&i.source_strategy===strategy&&i.source_strategy!=='ai_generate'&&i.auto.state==='pending';
  for(const item of todo){
   // 每项导入前重读：用户已改策略、跳过或自动选源已结束时不再导入。
   if(!eligible(live(item.id),item.source_strategy))continue;
   const group=item.source_strategy as Exclude<ImagePlanStrategy,'ai_generate'>,pool=candidates.filter(c=>candidateGroup(c)===group&&!used.has(c.candidate_id)),paragraph=studio.paragraphs.find(p=>p.id===item.paragraph_id)?.text??'',keys=planKeywords(paragraph+' '+item.purpose);
   const chosen=pool.find(c=>c.candidate_id===item.candidate_id)??pool.map(c=>({c,score:planKeywordScore(keys,candidateText(c))})).filter(x=>x.score>=2).sort((a,b)=>b.score-a.score)[0]?.c;
   let outcome:{state:'selected'|'no_match'|'failed';candidate_id:string|null;error:string|null;version_id?:string};
   if(!chosen)outcome={state:'no_match',candidate_id:null,error:group==='article_original'?'没有找到和这段相关的原文配图，可以换来源或改用 AI 生成':'没有找到和这段相关的同题帖子图，可以换来源或改用 AI 生成'};
   else{used.add(chosen.candidate_id);
    const attempt=async(version:number)=>{if(!eligible(live(item.id),item.source_strategy))throw new ContractError('INPUT_STALE','这一项已被修改，不再自动导入');return this.studio.webImport({...request,idempotency_key:'image-plan-auto:'+plan.id+':'+item.id+':'+version},{topic_id:topic,expected_version:version,slot_id:item.slot_id,candidate:{candidate_id:chosen.candidate_id,image_url:chosen.image_url}},{auto_selected:true,onCommit:imported=>this.claimImport(request,topic,plan.id,item.id,item.source_strategy,chosen.candidate_id,imported)});};
    try{let result;try{result=await attempt(studio.version);}catch(error){if(!(error instanceof ContractError&&error.code==='VERSION_CONFLICT'))throw error;studio=await this.studio.snapshot(request,topic);if(this.hasImage(live(item.id)??item,studio))continue;result=await attempt(studio.version);}
     studio={...studio,version:result.version};outcome={state:'selected',candidate_id:chosen.candidate_id,error:null,version_id:result.version_id};}
    catch(error){if(error instanceof ContractError&&error.message==='这一项已被修改，不再自动导入')continue;outcome={state:'failed',candidate_id:chosen.candidate_id,error:'自动选中的网络图没能导入，可以在右栏换一张或改用 AI 生成'};}}
   // 导入成功时归属已在导入事务里登记；这里只记录没找到/没导入成功，且仅当这一项仍是发起时的策略、仍在自动选源。
   if(outcome.version_id)continue;
   transaction(this.context.db,()=>{const state=this.read(topic),target=state.plan?.id===plan.id?state.plan.items.find(i=>i.id===item.id):undefined;if(!eligible(target,item.source_strategy))return;target!.auto={state:outcome.state,candidate_id:outcome.candidate_id,error:outcome.error};state.version++;this.write(state);});
  }
 }
 // 在导入的同一写事务里登记这一版：仍是发起时的策略且在自动选源 → 设为当前图（返回 true，导入方同一事务登记采用）；已切到另一种网络来源 → 只作候选，保留新策略继续选源；
 // 已跳过或改成 AI 生图 → 标 unused 候选。只读写方案状态，不抛错，不会让导入回滚。
 private claimImport(request:RequestContext,topic:string,planId:string,itemId:string,strategy:ImagePlanStrategy,candidate:string,imported:{version_id:string;index:number}):boolean{
  const state=this.read(topic),target=state.plan?.id===planId?state.plan.items.find(i=>i.id===itemId):undefined;if(!target)return false;let current=false;
  target.seen_versions=Math.max(target.seen_versions,imported.index+1);
  if(!target.skipped&&!target.removed&&target.source_strategy===strategy&&target.auto.state==='pending'){target.auto={state:'selected',candidate_id:candidate,error:null};target.current_version_id=imported.version_id;target.cleared=false;current=true;}
  else if(!target.skipped&&!target.removed&&target.source_strategy!=='ai_generate'&&target.auto.state==='pending'){/* 新网络策略仍待选源，这一版只留在版本条 */}
  else target.auto={state:'unused',candidate_id:candidate,error:null};
  state.version++;this.write(state);return current;
 }
 private view(request:RequestContext,topic:string,studio:StudioSnapshot):ImagePlanSnapshot{
  const state=this.read(topic),index=new Map(studio.paragraphs.map(p=>[p.id,p.index])),budgetRow=readGenerationBudget(this.context.db,request.workspace_id);
  const budget=(provider:'codex'|'agy')=>{const used=budgetRow[provider],limit=imageGenerationLimit(this.context.config,provider);return{used,limit,remaining:limit===null?null:Math.max(0,limit-used)};};
  const items=(state.plan?.items??[]).filter(i=>!i.removed).sort((a,b)=>this.anchor(a,index)-this.anchor(b,index)||a.seq-b.seq).map(item=>this.itemView(item,studio.slots.find(s=>s.id===item.slot_id),studio));
  const run=state.run,active=!!run&&ACTIVE_RUN.includes(run.state);
  return{topic_id:topic,topic_title:this.topicTitle(request,topic),version:state.version,state:active?'planning':state.plan?'ready':run&&['failed','cancelled'].includes(run.state)?'failed':'empty',run:run?{state:run.state,executor:run.executor,error:run.error,requested_at:run.requested_at,job_id:run.job_id}:null,stale:!!state.plan&&state.plan.article_revision_id!==studio.document_revision_id,items,budget:{codex:budget('codex'),agy:budget('agy')},final:this.finalSummary(request,topic,state,studio),studio};
 }
 // ——— 配图终稿（A2-2） ———
 // 按方案顺序整理未跳过的项：已填好、当前图即槽位采用版本、对应当前正文且文件仍在，才计入终稿；其余（含从未生成、生成中、已清除）都算待处理。
 private finalDraft(request:RequestContext,state:ImagePlanState,studio:StudioSnapshot):{pending:number;items:ImagePlanFinalItem[]}{
  const index=new Map(studio.paragraphs.map(p=>[p.id,p.index])),items:ImagePlanFinalItem[]=[];let pending=0;
  const list=(state.plan?.items??[]).slice().sort((a,b)=>this.anchor(a,index)-this.anchor(b,index)||a.seq-b.seq);
  // 已跳过与已删除（A2-2）的项都不进终稿、也不计未完成；顺序按方案插入位置（封面 → 第 N 段前/后）。
  for(const item of list){if(item.skipped||item.removed)continue;
   const slot=studio.slots.find(s=>s.id===item.slot_id),version=!item.cleared&&item.current_version_id?slot?.versions.find(v=>v.id===item.current_version_id):undefined;
   const busy=!!slot?.versions.some(v=>!v.asset_id&&[...PENDING_VERSION,...UNSETTLED_VERSION].includes(v.state)),placed=index.has(item.paragraph_id)&&(item.position==='cover'||index.has(item.placement_paragraph_id));
   const asset=version?.asset_id?this.context.db.prepare("SELECT sha256 FROM assets WHERE workspace_id=? AND id=? AND kind='image' AND status='ready'").get(request.workspace_id,version.asset_id):undefined;
   if(!slot||!version||!ok(version)||busy||!placed||slot.active_version_id!==version.id||version.document_revision_id!==studio.document_revision_id||!asset){pending++;continue;}
   const size=version.actual_size??version.size_request,first=studio.paragraphs[0]?.id??item.placement_paragraph_id;
   items.push({item_id:item.id,role:item.role,slot_id:slot.id,asset_id:version.asset_id!,version_id:version.id,sha256:String(asset.sha256),url:'/api/v1/assets/'+encodeURIComponent(version.asset_id!)+'/content',pixel_width:size.width,pixel_height:size.height,caption:item.purpose,credit_label:version.source?.credit_label??null,paragraph_id:item.position==='cover'?first:item.placement_paragraph_id,position:item.position});
  }
  return{pending,items};
 }
 private finalId(content:Omit<ImagePlanFinal,'id'|'confirmed_at'>){return inputHash(content);}
 private finalSummary(request:RequestContext,topic:string,state:ImagePlanState,studio:StudioSnapshot):ImagePlanFinalSummary{
  const stored=readImagePlanFinal(this.context.db,request.workspace_id,topic),draft=state.plan?this.finalDraft(request,state,studio):{pending:0,items:[]};
  const current=!!stored&&!!state.plan&&draft.pending===0&&stored.plan_id===state.plan.id&&stored.document_revision_id===studio.document_revision_id&&stored.id===this.finalId({schema_version:IMAGE_PLAN_FINAL_SCHEMA,topic_id:topic,plan_id:state.plan.id,document_id:studio.document_id,document_revision_id:studio.document_revision_id,items:draft.items});
  return{pending:draft.pending,confirmed:!!stored,current,confirmed_at:stored?.confirmed_at??null};
 }
 /** 配图确认摘要（排版页判断配图确认后是否又改过）：先像方案读取一样投影新版本与采用，不触发自动选源。 */
 async finalStatus(request:RequestContext,topic:string):Promise<ImagePlanFinalSummary>{assertRequestIdentity(this.context,request);this.topicTitle(request,topic);let studio=await this.studio.snapshot(request,topic);if(this.refresh(request,topic,studio))studio=await this.studio.snapshot(request,topic);return this.finalSummary(request,topic,this.read(topic),studio);}
 /** 读取已确认的配图终稿（排版初始化与重新同步用）；未确认时为 null。 */
 readFinal(request:RequestContext,topic:string):ImagePlanFinal|null{assertRequestIdentity(this.context,request);return readImagePlanFinal(this.context.db,request.workspace_id,topic);}
 // 确认配图：所有未跳过的项都已配好并采用才冻结终稿；幂等（同键重放返回现状）、带方案版本；不写 Wiki，不需要记录根目录。
 async confirm(request:RequestContext,input:ImagePlanConfirmRequest):Promise<ImagePlanSnapshot>{
  assertRequestIdentity(this.context,request);ImagePlanConfirmSchema.parse(input);const op='image-studio.plan.confirm',topic=input.topic_id;
  if(readCommittedIdempotent(this.context.db,request,op,input))return this.snapshot(request,topic);
  this.topicTitle(request,topic);let studio=await this.studio.snapshot(request,topic);if(this.refresh(request,topic,studio))studio=await this.studio.snapshot(request,topic);
  transaction(this.context.db,()=>{
   if(readCommittedIdempotent(this.context.db,request,op,input))return;const state=this.read(topic);
   if(state.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','配图方案已变化，请刷新');
   if(!state.plan)throw new ContractError('VALIDATION_ERROR','还没有配图方案，先让 AI 规划配图');
   if(state.plan.article_revision_id!==studio.document_revision_id)throw new ContractError('INPUT_STALE','文章在规划后又改过，先按最新定稿重新规划');
   this.studio.assertArticleFresh(request,topic,studio);
   // 冻结用的槽位快照是在事务外读的：事务内核对槽位版本未变，变了就拒绝（409），不冻结过时的图。
   if(readStudio(this.context.db,request.workspace_id,topic).version!==studio.version)throw new ContractError('VERSION_CONFLICT','配图刚有变化，请刷新后再确认');
   const draft=this.finalDraft(request,state,studio);if(draft.pending)throw new ContractError('VALIDATION_ERROR','还有 '+draft.pending+' 张配图待处理，处理完再确认',{pending:draft.pending});
   const content={schema_version:IMAGE_PLAN_FINAL_SCHEMA,topic_id:topic,plan_id:state.plan.id,document_id:studio.document_id,document_revision_id:studio.document_revision_id,items:draft.items} as const,id=this.finalId(content),prior=readImagePlanFinal(this.context.db,request.workspace_id,topic);
   // 内容不变时保留原终稿（含确认时间），排版不会误报「配图已更新」。
   if(prior?.id!==id)writeImagePlanFinal(this.context.db,request.workspace_id,{...content,id,confirmed_at:new Date().toISOString()});
   storeIdempotent(this.context.db,request,op,input,{final_id:id});
  });
  return this.snapshot(request,topic);
 }
 private itemView(item:ImagePlanItem,slot:StudioSlot|undefined,studio:StudioSnapshot):ImagePlanItemView{
  const paragraph=studio.paragraphs.find(p=>p.id===item.paragraph_id),versions=slot?.versions??[],currentIndex=item.cleared?-1:versions.findIndex(v=>v.id===item.current_version_id),current=currentIndex>=0?versions[currentIndex]!:null,last=versions.at(-1);
  let status:ImagePlanItemView['status'],issue:string|null=null;
  // 与生成接口同一判定：任一版本还没有图且任务未结束或结果未知，这张图不能再提交生成或修改（不只看最后一版）。
  const pendingAny=versions.some(v=>!v.asset_id&&PENDING_VERSION.includes(v.state)),unsettledAny=versions.some(v=>!v.asset_id&&UNSETTLED_VERSION.includes(v.state));
  if(item.skipped)status='skipped';
  else if(pendingAny)status='generating';
  else if(current){status='filled';if(unsettledAny)issue='上次生成的结果还在核对，暂时不能再生成或修改这张';}
  else if(unsettledAny){status='failed';issue='上次生成的结果还在核对，暂时不能再生成这张';}
  else if(item.source_strategy==='ai_generate'){status=last?.state==='failed'?'failed':'awaiting_generation';if(last?.state==='failed')issue='上次生成没有成功，可以再生成一次';}
  else if(item.auto.state==='pending')status='searching';
  else{status='pending';issue=item.cleared?'已清除当前图，可以换一张或改用 AI 生成':item.auto.error;}
  if(!paragraph)issue='文章已修改，这一段已找不到，建议重新规划';
  const {removed:_removed,...visible}=item;
  return{...visible,status,paragraph_excerpt:paragraph?paragraph.text.slice(0,60):'',paragraph_index:paragraph?paragraph.index:null,current_version:current?{id:current.id,index:currentIndex+1,auto_selected:current.auto_selected===true,credit_label:current.source?.credit_label??null,operation:current.operation}:null,issue};
 }
 // 规划入队：进入工作台无方案时自动调用一次；已有方案或任务进行中时直接返回现状（重新规划也不会重复入队）。
 async run(request:RequestContext,input:ImagePlanRunRequest):Promise<ImagePlanSnapshot>{
  assertRequestIdentity(this.context,request);ImagePlanRunSchema.parse(input);const op='image-studio.plan.run',topic=input.topic_id;
  if(readCommittedIdempotent(this.context.db,request,op,input))return this.snapshot(request,topic);
  this.topicTitle(request,topic);let studio=await this.studio.snapshot(request,topic);if(this.refresh(request,topic,studio))studio=await this.studio.snapshot(request,topic);
  const settle=()=>{const state=this.read(topic);if(state.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','配图方案已变化，请刷新');const active=!!state.run&&ACTIVE_RUN.includes(state.run.state);return active||!input.replan&&!!(state.plan||state.run);};
  if(settle()){transaction(this.context.db,()=>{if(!readCommittedIdempotent(this.context.db,request,op,input))storeIdempotent(this.context.db,request,op,input,{enqueued:false});});return this.snapshot(request,topic);}
  if(input.executor){const health=(await this.context.getExecutorHealth({wait_for:input.executor})).find(e=>e.executor_id===input.executor),availability=executorAvailability(health);if(availability.blocked)throw new ContractError(availability.reason==='quota'?'QUOTA_EXHAUSTED':availability.reason==='login'?'AUTH_REQUIRED':'CAPABILITY_UNVERIFIED',(input.executor==='claude'?'Claude':'Codex')+(availability.reason==='quota'?' 额度暂不可用':availability.reason==='login'?' 需要登录':' 当前不可用')+'，请换一个执行器',{executor:input.executor});}
  const article=await this.studio.currentArticle(request,topic);if(!article.paragraphs.length)throw new ContractError('VALIDATION_ERROR','文章还没有正文段落，先写好再规划配图');
  let candidates:StudioWebImageCandidate[]=[];try{candidates=(await webImageCandidates(this.context,request,topic,{...this.studio.options.web,capture:true})).filter(c=>c.availability!=='expired').slice(0,30);}catch{candidates=[];}
  const skill=readImagePlanSkill(),chars=Array.from(article.article_text.replace(/\s+/gu,'')).length,paragraphKeys=article.paragraphs.map(p=>({id:p.id,keys:planKeywords(p.text)}));
  const frozen:ImagePlanFrozenInput={schema_version:IMAGE_PLAN_SCHEMA,topic_id:topic,topic_title:this.topicTitle(request,topic),article_revision_id:article.document_revision_id,article_chars:chars,body_limit:imagePlanBodyLimit(chars),paragraphs:article.paragraphs,candidates:candidates.map(c=>({candidate_id:c.candidate_id,group:candidateGroup(c),title:(c.page_title??c.site_name??c.credit_label).slice(0,200),credit_label:c.credit_label,paragraph_hits:paragraphKeys.filter(p=>planKeywordScore(p.keys,candidateText(c))>=2).map(p=>p.id)})),skill:{name:skill.name,sha256:skill.sha256}};
  transaction(this.context.db,()=>{
   if(readCommittedIdempotent(this.context.db,request,op,input))return;if(settle()){storeIdempotent(this.context.db,request,op,input,{enqueued:false});return;}
   this.studio.assertArticleFresh(request,topic,article);const state=this.read(topic),executor=input.executor??workspaceSettings(this.context.db,request.workspace_id).default_executor,document=randomUUID(),id=randomUUID();
   this.context.db.prepare("INSERT INTO documents(id,workspace_id,kind,owner_entity_id,version) VALUES (?,?,'image_plan',?,1)").run(document,request.workspace_id,topic);
   const accepted=new ContentGeneration(this.context).enqueueInTransaction({...request,idempotency_key:'image-plan:'+topic+':'+request.idempotency_key},IMAGE_PLAN_JOB_KIND,document,executor,'candidate',[{document_id:document,base_revision_id:null,core_revision_id:null}],[],imagePlanInstruction(skill),{content_purpose:'image_plan',image_plan:frozen as unknown as JsonObject,execution_policy:IMAGE_PLAN_EXECUTION as unknown as JsonObject});
   state.run={id,job_id:accepted.job_id,document_id:document,executor,article_revision_id:article.document_revision_id,state:'queued',error:null,requested_at:new Date().toISOString(),settled_at:null};state.version++;this.write(state);storeIdempotent(this.context.db,request,op,input,{enqueued:true,run_id:id});
  });
  return this.snapshot(request,topic);
 }
 // 改图注/提示/画幅、换策略、跳过与恢复、上下移（与相邻项交换落点）、切换或清除当前图。
 async updateItem(request:RequestContext,itemId:string,input:ImagePlanItemUpdate):Promise<ImagePlanSnapshot>{
  assertRequestIdentity(this.context,request);ImagePlanItemUpdateSchema.parse(input);const op='image-studio.plan.item:'+itemId,topic=input.topic_id;
  if(readCommittedIdempotent(this.context.db,request,op,input))return this.snapshot(request,topic);
  this.topicTitle(request,topic);let studio=await this.studio.snapshot(request,topic);if(this.refresh(request,topic,studio))studio=await this.studio.snapshot(request,topic);
  const locate=()=>{const state=this.read(topic);if(state.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','配图方案已变化，请刷新');const item=state.plan?.items.find(i=>i.id===itemId&&!i.removed);if(!state.plan||!item)throw new ContractError('NOT_FOUND','这张配图不在当前方案里（可能已删除）');return{state,plan:state.plan,item};};
  const before=locate(),slot=studio.slots.find(s=>s.id===before.item.slot_id);
  // 采用某一版：同时登记为这张图的采用版本（终稿按采用版本整理），旧版仍保留可回退。
  if(typeof input.current_version_id==='string'){const version=slot?.versions.find(v=>v.id===input.current_version_id);if(!slot||!version||!ok(version))throw new ContractError('INPUT_STALE','只能切换到这张图已保存的版本');}
  const article=typeof input.current_version_id==='string'?await this.studio.currentArticle(request,topic):null;
  transaction(this.context.db,()=>{
   if(readCommittedIdempotent(this.context.db,request,op,input))return;const {state,plan,item}=locate();
   if(input.purpose!==undefined)item.purpose=input.purpose.trim();if(input.prompt_draft!==undefined)item.prompt_draft=input.prompt_draft.trim();if(input.aspect)item.aspect=input.aspect;if(input.skipped!==undefined)item.skipped=input.skipped;
   if(input.source_strategy&&input.source_strategy!==item.source_strategy){item.source_strategy=input.source_strategy;item.candidate_id=null;item.auto={state:input.source_strategy!=='ai_generate'&&!this.hasImage(item,studio)?'pending':'none',candidate_id:null,error:null};}
   // 采用、方案更新与幂等记录同一事务：任一校验失败（含版本冲突）整体回滚，不会只采用不更新方案。
   if(typeof input.current_version_id==='string')this.studio.adoptInTransaction(request,topic,item.slot_id,input.current_version_id,article!);
   if(input.current_version_id!==undefined){item.current_version_id=input.current_version_id;item.cleared=input.current_version_id===null;}
   if(input.move||input.move_to!==undefined){if(item.position==='cover')throw new ContractError('VALIDATION_ERROR','封面固定在最前，不能移动');const index=new Map(studio.paragraphs.map(p=>[p.id,p.index])),list=plan.items.filter(i=>i.position!=='cover'&&!i.removed).sort((x,y)=>this.anchor(x,index)-this.anchor(y,index)||x.seq-y.seq),at=list.indexOf(item);
    const target=input.move_to!==undefined?Math.min(list.length-1,input.move_to):input.move==='up'?at-1:at+1;
    if(target<0||target>=list.length)throw new ContractError('VALIDATION_ERROR',input.move==='up'?'已经是第一张正文图':'已经是最后一张正文图');
    // 交换插入点（段落与前后位置）和同位次序：图仍说明原来那段，只是在文章里的先后对调。拖拽到第 N 位等于逐位交换，其他图依次让位。
    const swap=(x:ImagePlanItem,y:ImagePlanItem)=>{const a={placement_paragraph_id:x.placement_paragraph_id,position:x.position,seq:x.seq};Object.assign(x,{placement_paragraph_id:y.placement_paragraph_id,position:y.position,seq:y.seq});Object.assign(y,a);};
    for(let i=at;i!==target;i+=target>at?1:-1){const next=i+(target>at?1:-1);swap(list[i]!,list[next]!);[list[i],list[next]]=[list[next]!,list[i]!];}}
   if(input.placement)this.place(plan.items,item,input.placement,studio);
   // 删除：方案项与手动项都只标记删除，不进画布与终稿；已生成的版本仍在本篇素材里，可在其他图的「换来源」找回。
   if(input.removed){item.removed=true;item.auto={...item.auto,state:item.auto.state==='pending'?'none':item.auto.state};}
   state.version++;this.write(state);storeIdempotent(this.context.db,request,op,input,{updated:true});
  });
  if(article)this.studio.recordProcess(topic);
  return this.snapshot(request,topic);
 }
 // 本人指定插入位置：段落存在才接受；封面只能有一张。改位置后这张图说明所选的这一段，排在同一位置已有图的后面。
 private place(items:ImagePlanItem[],item:ImagePlanItem,placement:{position:ImagePlanPosition;paragraph_id:string|null},studio:StudioSnapshot){
  if(placement.position==='cover'){if(items.some(i=>i!==item&&!i.removed&&i.position==='cover'))throw new ContractError('VALIDATION_ERROR','已经有一张封面，先删除或移走原封面');item.position='cover';item.seq=0;return;}
  const paragraph=studio.paragraphs.find(p=>p.id===placement.paragraph_id);if(!paragraph)throw new ContractError('INPUT_STALE','这一段已找不到，文章可能刚改过，请刷新');
  Object.assign(item,{position:placement.position,placement_paragraph_id:paragraph.id,paragraph_id:paragraph.id,seq:Math.max(0,...items.map(i=>i.seq))+10});
 }
 // 手动加一张：直接在方案里新增一项（预留槽位），本人选好位置后再生成、换来源或上传。
 async createItem(request:RequestContext,input:ImagePlanItemCreate):Promise<ImagePlanSnapshot>{
  assertRequestIdentity(this.context,request);ImagePlanItemCreateSchema.parse(input);const op='image-studio.plan.item.create',topic=input.topic_id;
  if(readCommittedIdempotent(this.context.db,request,op,input))return this.snapshot(request,topic);
  this.topicTitle(request,topic);const studio=await this.studio.snapshot(request,topic);this.refresh(request,topic,studio);
  transaction(this.context.db,()=>{
   if(readCommittedIdempotent(this.context.db,request,op,input))return;const state=this.read(topic);if(state.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','配图方案已变化，请刷新');
   if(!state.plan)throw new ContractError('VALIDATION_ERROR','先让 AI 规划配图，再手动加图');
   const anchor=input.paragraph_id??studio.paragraphs[0]?.id;const paragraph=studio.paragraphs.find(p=>p.id===anchor);if(!paragraph)throw new ContractError('INPUT_STALE','这一段已找不到，文章可能刚改过，请刷新');
   const item:ImagePlanItem={id:randomUUID(),role:'manual',slot_id:randomUUID(),paragraph_id:paragraph.id,placement_paragraph_id:paragraph.id,position:'after',seq:0,purpose:(input.purpose??'').trim()||'手动加图：第 '+(paragraph.index+1)+' 段',source_strategy:input.source_strategy??'ai_generate',aspect:input.aspect??'16:9',prompt_draft:('为这一段配一张说明图：'+paragraph.text).slice(0,2000),candidate_id:null,skipped:false,auto:{state:'none',candidate_id:null,error:null},current_version_id:null,cleared:false,seen_versions:0};
   if(item.source_strategy!=='ai_generate')item.auto={state:'pending',candidate_id:null,error:null};
   this.place(state.plan.items,item,{position:input.position,paragraph_id:paragraph.id},studio);
   state.plan.items.push(item);state.version++;this.write(state);storeIdempotent(this.context.db,request,op,input,{created:item.id});
  });
  return this.snapshot(request,topic);
 }
}
