import type { StudioImageProgress, StudioMark, StudioUploadPurpose, AssetsRow, ImageProviderAvailability, ImageProviderSettingsResponse, JsonObject, StudioSnapshot as ServiceStudioSnapshot, StudioBriefInput, StudioGenerationRequest, StudioWebImageCandidate, StudioWebImageCandidates, StudioWebCaptureStatus } from '@workbench/contracts';
import { imageProviderAvailability } from '@workbench/contracts';
import {buildStudioPromptContext,studioPromptBudget,validateStudioPromptBudget} from '../../../../../../packages/domain/src/artifact-execution/image-studio/prompt.ts';
// UI projections below are derived from the service DTO and ready asset records.
// They do not establish a second transport contract or claim native pixel control.

export type StudioProvider = 'codex' | 'agy';
export type ReferencePurpose = 'style' | 'layout' | 'object' | 'person' | 'brand';
export interface StudioSize { width:number; height:number }
export interface StudioSizeChoice extends StudioSize { id:string; label:string }
export interface StudioCapability {
  provider:StudioProvider; label:string; enabled:boolean; available:boolean;
  /** 与设置页共用的渠道可用判定；available=availability.selectable。 */
  availability?:ImageProviderAvailability;
  sizes:StudioSizeChoice[]; custom:{min:number;max:number;step:number;min_ratio:number;max_ratio:number}|null;
  reference_limit:number; reference_edit:boolean; mask:boolean; text_edit:boolean;
  limitations:string[];
  /** 渠道可用的生图模型（来自适配器能力）；只有一个时界面只显示、不可改。 */
  models?:Array<{id:string;label:string}>;
}
export interface StudioReference {
  asset_id:string; name:string; purpose:ReferencePurpose; sha256:string; mime:string; size_bytes:number;
  width:number; height:number; fixed:boolean;
}
export interface StudioVersion {
  id:string; slot_id:string; asset_id:string; provider:StudioProvider; description:string; title:string;
  requested:StudioSize; accepted:StudioSize|null; actual:StudioSize; mime:string; sha256:string; size_bytes:number;
  created_at:string; job_id:string|null; parent_version_id:string|null; reference_assets:StudioReference[];
  actual_verified:boolean; state:string; warning:string|null; error:string|null; accepted_parameters:JsonObject|null; document_revision_id:string; paragraph_id:string; placement:string; operation:'generate'|'reference_edit'|'web_import'|'upload';
  source?:StudioVersionSource|null;
  /** 这一版修改时的画面标注（不进入成品）；上传 / 找回的图片用途。 */
  marks?:StudioMark[]; upload?:{purpose:StudioUploadPurpose|null;name:string|null}|null;
  /** 进行中的 AI 生图的真实进度（服务端按任务记录现算）；received_at 是本地收到这份快照的时刻，用来往前推已用时间。 */
  progress?:StudioImageProgress&{received_at:number};
}
/** 网络导入版本的图源；credit_label 就是采用时图注要带的「图源：xxx」。 */
export interface StudioVersionSource { credit:string; page_url:string; page_title:string|null; image_url?:string }
export interface StudioSlot {
  id:string; title:string; description:string; placement:string; adopted_version_id:string|null;
  versions:StudioVersion[];
}
export interface StudioParagraph { id:string; label:string; text:string }
export interface StudioSnapshot {
  topic_id:string; document_revision_id:string|null; version:number; title:string; article:string;
  paragraphs:StudioParagraph[]; slots:StudioSlot[]; references:StudioReference[]; capabilities:StudioCapability[];
  recording?:ServiceStudioSnapshot['recording'];
  /** 设置页的默认生图渠道；工作台默认渠道优先取它（不可选或已用完时退到另一个）。 */
  default_provider?:StudioProvider;
}
export type StudioAssetRecord=Pick<AssetsRow,'id'|'mime'|'sha256'|'size_bytes'|'status'>&{generation_metadata?:JsonObject|string|null;purpose?:string};
const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;
export function studioAspect(width:number,height:number){const divisor=gcd(width,height)||1;return width/divisor+':'+height/divisor;}
const referencePurpose=(purpose:string):ReferencePurpose=>purpose==='identity'?'person':purpose==='content'?'object':'style';
const servicePurpose=(purpose:ReferencePurpose):'style'|'identity'|'content'=>purpose==='person'?'identity':purpose==='object'?'content':'style';
export function studioBriefInput(input:{topic_id:string;document_revision_id:string|null;provider:string;description:string;paragraph_id:string;title:string;reference_assets:StudioDraft['reference_assets'];placement?:string}):StudioBriefInput {
  const position=input.placement==='cover'?'cover':input.placement?.startsWith('before:')?'before':'after';
  return {topic_id:input.topic_id,document_revision_id:input.document_revision_id??'',provider:input.provider as StudioProvider,description:input.description,title:input.title,paragraph_id:input.paragraph_id,placement_paragraph_id:input.placement&&input.placement!=='cover'?input.placement.slice(input.placement.indexOf(':')+1):input.paragraph_id,position,references:input.reference_assets.map(r=>({asset_id:r.asset_id,purpose:servicePurpose(r.purpose)}))};
}
export function studioGenerationInput(input:StudioSubmit):StudioGenerationRequest {
  return {...studioBriefInput({...input,placement:input.placement}),expected_version:input.expected_version,slot_id:input.slot_id,
    parent_version_id:input.parent_version_id,operation:input.operation,size_mode:input.mode,size:{...input.requested_size,aspect_ratio:studioAspect(input.requested_size.width,input.requested_size.height)},brief_id:input.brief_id,...(input.marks?.length?{marks:input.marks}:{}),...(input.candidate_only?{candidate_only:true}:{}),...(input.model?{model:input.model}:{})};
}
export function projectStudioSnapshot(value:ServiceStudioSnapshot,assets:StudioAssetRecord[],settings:ImageProviderSettingsResponse,received_at=Date.now()):StudioSnapshot {
  const references:StudioReference[]=value.references.map(r=>({asset_id:r.id,name:r.purpose||'参考图 '+r.id.slice(0,8),purpose:referencePurpose(r.purpose),sha256:r.sha256,mime:r.mime,size_bytes:r.size_bytes,width:0,height:0,fixed:false}));
  const reference=(r:{asset_id:string;purpose:string}):StudioReference=>({...references.find(x=>x.asset_id===r.asset_id)??{asset_id:r.asset_id,name:'参考图 '+r.asset_id.slice(0,8),sha256:'',mime:'',size_bytes:0,width:0,height:0,fixed:false},purpose:referencePurpose(r.purpose)});
  const capabilities:StudioCapability[]=value.capabilities.map(raw=>{const channel=settings.channels.find(c=>c.provider===raw.provider),range=raw.manual_range as JsonObject|undefined,refs=raw.references as JsonObject|undefined;
    const availability=channel?imageProviderAvailability(channel):undefined;
    return {provider:raw.provider as StudioProvider,label:channel?.label??String(raw.provider),enabled:channel?.enabled??false,available:!!availability?.selectable,availability,
      sizes:Array.isArray(raw.composition_targets)?raw.composition_targets.map(target=>{const s=target as JsonObject;return {id:String(s.aspect_ratio),label:studioRatioLabel(String(s.aspect_ratio)),width:Number(s.width),height:Number(s.height)};}):[],
      custom:range?{min:Number(range.min_edge),max:Number(range.max_edge),step:1,min_ratio:Number(range.min_ratio),max_ratio:Number(range.max_ratio)}:null,
      reference_limit:Number(refs?.max_images??0),reference_edit:channel?.operations.reference_edit==='supported',mask:refs?.mask==='supported',text_edit:refs?.exact_text_edit==='supported',
      limitations:Array.isArray(raw.limitations)?raw.limitations.map(String):['画幅与像素作为说明发送，实际尺寸以解码结果为准。'],
      models:Array.isArray(raw.models)?raw.models.map(m=>{const x=m as JsonObject;return {id:String(x.id),label:String(x.label??x.id)};}):[]};});
  return {topic_id:value.topic_id,document_revision_id:value.document_revision_id,version:value.version,title:'公众号文章配图',article:value.article_text,
    paragraphs:value.paragraphs.map(p=>({id:p.id,label:'第 '+(p.index+1)+' 段 · '+p.text.slice(0,28),text:p.text})),references,capabilities,recording:value.recording,default_provider:settings.default_provider,
    slots:value.slots.map(s=>({id:s.id,title:s.title,description:s.description,placement:s.position==='cover'?'cover':s.position+':'+s.placement_paragraph_id,adopted_version_id:s.active_version_id,
      versions:s.versions.map(v=>{const asset=assets.find(a=>a.id===v.asset_id&&a.status==='ready'),actual=v.actual_size??v.size_request;return {id:v.id,slot_id:s.id,asset_id:v.asset_id??'',provider:v.provider,description:v.description,title:v.title,
        requested:{width:v.size_request.width,height:v.size_request.height},accepted:null,actual:{width:actual.width,height:actual.height},mime:asset?.mime??'',sha256:asset?.sha256??'',size_bytes:asset?.size_bytes??0,
        created_at:v.created_at,job_id:v.job_id,parent_version_id:v.parent_version_id,reference_assets:v.references.map(reference),actual_verified:!!v.actual_size&&!!asset,state:v.state,warning:v.size_warning,error:v.error,accepted_parameters:v.accepted_parameters?structuredClone(v.accepted_parameters):null,document_revision_id:v.document_revision_id,paragraph_id:v.paragraph_id,placement:v.position==='cover'?'cover':v.position+':'+v.placement_paragraph_id,operation:v.operation,source:v.source?{credit:v.source.credit_label,page_url:v.source.page_url,page_title:v.source.page_title,image_url:v.source.image_url}:null,marks:v.marks?structuredClone(v.marks):[],upload:v.upload??null,...(v.progress?{progress:{...v.progress,previews:[...v.progress.previews],received_at}}:{})};})}))};
}
export function studioFinalConfirmationReason(snapshot:StudioSnapshot):string {
  if(!snapshot.recording?.process_record||snapshot.recording.process_record==='pending_record_root_registration')return '过程记录路径待登记，终稿整理暂不可用。';
  if(snapshot.slots.some(s=>s.versions.some(v=>!v.asset_id&&['queued','running','cancel_requested','reconciling','unknown','cancelled','waiting_input','waiting_quota'].includes(v.state))))return '还有原图像任务或未知结果待核对，先保留原任务记录。';
  if(!snapshot.slots.length||snapshot.slots.some(s=>!s.adopted_version_id))return '先逐图采用，再确认本篇终稿。';
  if(snapshot.slots.some(s=>!s.versions.find(v=>v.id===s.adopted_version_id)?.actual_verified))return '已采用的图片须有可核对的真实文件。';
  if(snapshot.slots.some(s=>s.versions.find(v=>v.id===s.adopted_version_id)?.document_revision_id!==snapshot.document_revision_id))return '已采用的图片关联旧文章，请先核对当前版本再确认。';
  return '';
}
export interface StudioBrief {
  id:string; provider:StudioProvider; width:number; height:number; reason:string;
  input_digest:string; capability_revision:string; analysis_source:string;
}
export interface StudioDraft {
  slot_id:string|null; parent_version_id:string|null; provider:StudioProvider; description:string; title:string;
  placement:string; paragraph_id:string; reference_assets:{asset_id:string;purpose:ReferencePurpose}[];
  mode:'auto'|'manual'; width:number; height:number; brief:StudioBrief|null; operation:'generate'|'reference_edit';
}
export interface StudioSubmit {
  topic_id:string; document_revision_id:string|null; expected_version:number; slot_id:string|null;
  parent_version_id:string|null; provider:StudioProvider; description:string; title:string; placement:string;
  paragraph_id:string; reference_assets:{asset_id:string;purpose:ReferencePurpose}[];
  mode:'auto'|'manual'; requested_size:StudioSize; brief_id:string|null; operation:'generate'|'reference_edit';
  marks?:StudioMark[]; candidate_only?:boolean; model?:string;
}
export function defaultStudioDraft(provider:StudioProvider='codex'):StudioDraft {
  return {slot_id:null,parent_version_id:null,provider,description:'',title:'',placement:'ending',paragraph_id:'',reference_assets:[],mode:'auto',width:0,height:0,brief:null,operation:'generate'};
}
// 生图渠道统一称呼：与规划/写作用的执行器（Codex / Claude）区分开。
export const STUDIO_PROVIDER_NAMES:Record<StudioProvider,string>={codex:'Codex 生图',agy:'AGY 生图'};
// 生成渠道下拉项文案：只写渠道名与状态（剩余次数 / 不限次数 / 阻塞原因）；「未经真实验收」只在设置页渠道卡说明，不进选项。
export function studioProviderOption(capability:StudioCapability):{text:string;disabled:boolean} {
  const a=capability.availability,name=STUDIO_PROVIDER_NAMES[capability.provider]??capability.label;
  if(!a)return {text:name+(capability.available&&capability.enabled?'':' · 暂不可用'),disabled:!(capability.available&&capability.enabled)};
  if(!a.selectable)return {text:name+' · '+(a.block==='budget'?'次数已用完':a.message),disabled:true};
  return {text:name+' · '+(a.remaining===null?'不限次数':'剩余 '+a.remaining+' 次'),disabled:false};
}
// 可以直接拿来生图的渠道：判定沿用 studioProviderOption（共用可用规则），另要求剩余次数 > 0（null = 不限）。
export function studioProviderReady(capability:StudioCapability|undefined):boolean {return !!capability&&!studioProviderOption(capability).disabled&&(capability.availability?.remaining??1)>0;}
// 默认生图渠道：优先设置页 default_provider；它不可选或已用完时退到另一个可用渠道；都不可用返回 null。
export function defaultStudioProvider(capabilities:StudioCapability[],preferred?:StudioProvider):StudioProvider|null {
  const ready=capabilities.filter(studioProviderReady);return (ready.find(c=>c.provider===preferred)??ready[0])?.provider??null;
}
export function studioDimensionsError(size:StudioSize,capability?:StudioCapability):string {
  if(!capability?.enabled||!capability.available){const a=capability?.availability;return a?.block==='budget'?'本渠道真实生图次数已达上限。':a?.detail?a.detail+'。':a?.message?'所选渠道'+a.message+'，请换一个渠道或核对图像渠道设置。':'所选渠道尚不可用，请核对图像渠道设置。';}
  if(!Number.isSafeInteger(size.width)||!Number.isSafeInteger(size.height)||size.width<=0||size.height<=0)return '宽度和高度须为正整数。';
  if(capability.sizes.some(s=>s.width===size.width&&s.height===size.height))return '';
  const custom=capability.custom;
  if(!custom)return '所选渠道仅接受列出的尺寸，请选择一个有效画幅。';
  if(size.width<custom.min||size.height<custom.min||size.width>custom.max||size.height>custom.max)return '尺寸范围为 '+custom.min+'–'+custom.max+' px。';
  if(size.width%custom.step||size.height%custom.step)return '尺寸须为 '+custom.step+' px 的倍数。';
  const ratio=size.width/size.height;
  if(ratio<custom.min_ratio||ratio>custom.max_ratio)return '该画幅超出所选渠道支持的比例范围。';
  return '';
}
export function invalidateStudioBrief(draft:StudioDraft):StudioDraft {
  return draft.mode==='manual'?{...draft,brief:null}:{...draft,brief:null,width:0,height:0};
}
export function acceptStudioBrief(draft:StudioDraft,brief:StudioBrief):StudioDraft {
  if(draft.provider!==brief.provider)return draft;
  return draft.mode==='manual'?{...draft,brief}:{...draft,brief,width:brief.width,height:brief.height};
}
export function studioDraftPromptBudget(snapshot:StudioSnapshot,draft:StudioDraft){
  const parent=snapshot.slots.flatMap(s=>s.versions).find(v=>v.id===draft.parent_version_id);
  const context=buildStudioPromptContext({paragraph:snapshot.paragraphs.find(p=>p.id===draft.paragraph_id)?.text??'',title:draft.title,parent:parent?{asset_id:parent.asset_id,description:parent.description,actual_size:parent.actual_verified?parent.actual:null}:null});
  const budget=studioPromptBudget(draft.description,context);
  try{validateStudioPromptBudget(draft.description,context);return {...budget,error:''};}
  catch(error){return {...budget,error:error instanceof Error?error.message:'画面说明或关联内容超过可用长度，请缩短后再提交。'};}
}
export function studioSubmit(snapshot:StudioSnapshot,draft:StudioDraft):StudioSubmit {
  const error=studioDimensionsError(draft,snapshot.capabilities.find(c=>c.provider===draft.provider));
  if(error)throw new Error(error);
  if(!draft.description.trim())throw new Error('先写这张图要说明的内容。');
  const budget=studioDraftPromptBudget(snapshot,draft);if(budget.error)throw new Error(budget.error);
  if(draft.mode==='auto'&&!draft.brief)throw new Error('先分析内容并取得画幅建议。');
  const capability=snapshot.capabilities.find(c=>c.provider===draft.provider)!;
  if(draft.operation==='reference_edit'&&!capability.reference_edit)throw new Error('所选渠道的参考原图修改尚未验证可用。');
  if(draft.reference_assets.length>capability.reference_limit)throw new Error('所选渠道最多支持 '+capability.reference_limit+' 张参考图。');
  if(draft.operation==='generate'&&draft.reference_assets.length)throw new Error('参考图已保存；新增时混合参考尚未准入，请选择 AGY 基于一张参考图制作。');
  if(draft.operation==='reference_edit'&&!draft.parent_version_id&&draft.reference_assets.length!==1)throw new Error('先选择一张实际保存的参考图。');
  return {topic_id:snapshot.topic_id,document_revision_id:snapshot.document_revision_id,expected_version:snapshot.version,
    slot_id:draft.slot_id,parent_version_id:draft.parent_version_id,provider:draft.provider,
    description:draft.description,title:draft.title,placement:draft.placement,paragraph_id:draft.paragraph_id,
    reference_assets:draft.reference_assets.map(r=>({...r})),operation:draft.operation,mode:draft.mode,requested_size:{width:draft.width,height:draft.height},brief_id:draft.brief?.id??null};
}

// 画幅选项文案与已确认原型一致：横图 / 方图 / 竖图 / 长图。
export function studioRatioLabel(ratio:string):string {const [w,h]=ratio.split(':').map(Number);if(!w||!h)return ratio;const shape=w===h?'方图':w>h?'横图':h/w>=2.5?'长图':'竖图';return shape+' · '+ratio;}

// 网络找图候选的界面投影：主路径只给缩略图、图源、来源页面和能否导入；记录/内容指纹等留在服务端。
export interface StudioWebCandidateView { id:string; image_url:string; thumb_url:string; credit:string; page_url:string; page_label:string; group:'article'|'posts'; selectable:boolean; note:string }
export function projectWebCandidates(candidates:StudioWebImageCandidate[]):StudioWebCandidateView[] {
  return candidates.map(c=>({id:c.candidate_id,image_url:c.image_url,thumb_url:c.thumb_url??c.image_url,credit:c.credit_label,page_url:c.page_url,page_label:c.page_title??c.site_name??(()=>{try{return new URL(c.page_url).hostname;}catch{return '来源页面';}})(),group:c.platform==='article'?'article':'posts',selectable:c.availability!=='expired',note:c.availability==='expired'?'平台链接已过期，不能导入':''}));
}

// 资讯原文后台读取状态的界面投影：只说「正在补充 / 有原文读不到 / 用的是旧图」和能否重试，不露内部状态名、页数统计之外的细节。
// 旧服务没有 capture 字段时按已读完处理。
export interface StudioWebCaptureView { refreshing:boolean; note:string; retry:boolean; tone:'info'|'warn'|'none' }
export interface StudioWebCandidateList { items:StudioWebCandidateView[]; capture:StudioWebCaptureView }
export function projectWebCapture(capture:StudioWebCaptureStatus|undefined):StudioWebCaptureView {
  if(!capture||capture.state==='fresh')return {refreshing:false,note:'',retry:false,tone:'none'};
  if(capture.state==='refreshing')return {refreshing:true,note:'正在从资讯原文补充更多图片，读到后会自动出现在这里',retry:false,tone:'info'};
  if(capture.state==='stale')return {refreshing:false,note:'资讯原文这次没能重新读取，先显示上次读到的图片',retry:true,tone:'warn'};
  const n=capture.pages_failed;
  return {refreshing:false,note:(n>1?'有 '+n+' 篇资讯原文':'资讯原文')+'暂时读不到，原文里的图片可能没列全',retry:true,tone:'warn'};
}
export function projectWebCandidateList(value:StudioWebImageCandidates):StudioWebCandidateList {return {items:projectWebCandidates(value.candidates),capture:projectWebCapture(value.capture)};}
// 后台补图期间的轮询间隔：1 秒起，每次 ×1.5，封顶 5 秒；超过约 2 分钟仍未读完就停下，改成「读取较慢，可重试」。
export const WEB_CAPTURE_POLL={first_ms:1000,factor:1.5,max_ms:5000,max_polls:30};
export const webCaptureNextDelay=(delay:number)=>Math.min(WEB_CAPTURE_POLL.max_ms,Math.round(delay*WEB_CAPTURE_POLL.factor));
export const WEB_CAPTURE_SLOW:StudioWebCaptureView={refreshing:false,note:'资讯原文读取得比较慢，可以稍后点「重新读取」',retry:true,tone:'warn'};

// 每张候选的导入请求冻结「幂等键 + 原请求体」：响应丢失后重试先原样重放，服务端已提交则直接返回原结果，不会重复建版本。
// 原请求返回版本冲突说明它没有提交，此时才换新键、用最新版本号重新冻结。
export interface WebImportRequest { topic_id:string; expected_version:number; slot_id:string|null; candidate:{candidate_id:string;image_url:string} }
export interface FrozenWebImport { key:string; input:WebImportRequest }
export interface WebImportKeyStore { getItem(key:string):string|null; setItem(key:string,value:string):void; removeItem(key:string):void }
export class WebImportKeys {
  private readonly memory=new Map<string,FrozenWebImport>();
  private readonly scope:string; private readonly store:WebImportKeyStore|null;
  constructor(scope:string,store:WebImportKeyStore|null){this.scope=scope;this.store=store;}
  private storageKey(id:string){return 'workbench-image-studio-web:'+this.scope+':'+id;}
  get(id:string):FrozenWebImport|undefined {
    const held=this.memory.get(id);if(held)return held;
    try{const raw=this.store?.getItem(this.storageKey(id));if(raw&&raw.length<16384){const value=JSON.parse(raw) as FrozenWebImport;if(typeof value.key==='string'&&value.input?.candidate?.candidate_id===id){this.memory.set(id,value);return value;}}}catch{/* 存储不可用时只用内存。 */}
    return undefined;
  }
  freeze(id:string,input:WebImportRequest,newKey:()=>string):FrozenWebImport {
    const held=this.get(id);if(held)return held;const value={key:newKey(),input:structuredClone(input)};this.memory.set(id,value);
    try{this.store?.setItem(this.storageKey(id),JSON.stringify(value));}catch{/* 存储不可用时只用内存。 */}return value;
  }
  clear(id:string){this.memory.delete(id);try{this.store?.removeItem(this.storageKey(id));}catch{/* 忽略 */}}
}
export const isVersionConflict=(error:unknown)=>(error as {response?:{error?:{code?:string}}})?.response?.error?.code==='VERSION_CONFLICT';

// 导入失败原因翻成用户语言：不露 HTTP 状态码、错误码或内部字段；原始信息留在服务端事件里。
export function webImportFailureCopy(error:unknown):string {
  const code=(error as {response?:{error?:{code?:string}}})?.response?.error?.code,message=error instanceof Error?error.message:'';
  if(code==='VERSION_CONFLICT')return '配图刚有变化，请再点一次导入';
  if(code==='NOT_FOUND')return '这张图的来源已变化，请重新打开网络找图';
  if(/过期/.test(message))return '平台链接已过期，请换一张';
  if(/内网|保留|本机|https|账号信息|端口/.test(message))return '这张图的地址不是公开网页地址，已拦下，未下载';
  if(/大小上限/.test(message))return '图片太大（超过 15MB），未导入';
  if(/不是 JPEG|声明格式不符|为空|宽高/.test(message))return '来源给的不是可用的图片文件，未导入';
  if(/超时/.test(message))return '来源响应太慢，未取得图片，可稍后再试';
  return '来源页面已打不开，未取得图片';
}
