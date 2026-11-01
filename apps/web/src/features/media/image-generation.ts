import type { AssetsRow, ImageGenerationRequest, ImageProviderSettingsResponse, JobDetailResponse, JobsRow, JsonObject, Page, TopicDetail } from '@workbench/contracts';
import type { FeatureContext } from '../../transport/feature-ports.ts';
import type { DialogCloseReason } from '../../transport/task-dialog.ts';
import { createTemplateHelpers } from '../../components/templateHelpers.ts';
import { ConfirmArm, TriggerGuard, generateConfirmDialog } from './image-studio/generate-confirm.ts';
/** 通用图像面板的「确认生成」标题（与「生成图像新版」表单同属本面板，不会被当成别的弹窗关掉）。 */
export const IMAGE_CONFIRM_TITLE='确认生成图像';

const { btn, esc } = createTemplateHelpers([]);
export type ImageAsset = Pick<AssetsRow, 'id'|'kind'|'mime'|'sha256'|'size_bytes'|'status'> & { generation_metadata?:JsonObject|string|null };
const path = encodeURIComponent;
const activeStates = ['queued', 'running', 'cancel_requested'];
export function imageMetadata(asset:ImageAsset):JsonObject {
  try { const value=typeof asset.generation_metadata==='string'?JSON.parse(asset.generation_metadata):asset.generation_metadata; return value&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:{}; } catch { return {}; }
}
export function isUnknownImageJob(detail:JobDetailResponse) {
  return detail.job.state==='reconciling'||detail.error?.code==='RESULT_UNKNOWN'||detail.error?.code==='PROVIDER_RESULT_UNKNOWN'||detail.checkpoint?.phase==='unknown';
}
export function canUseImageOperation(settings:ImageProviderSettingsResponse|undefined, provider:string, operation:'generate'|'reference_edit') {
  const channel=settings?.channels.find(c=>c.provider===provider);
  return !!channel?.enabled&&channel.configured&&channel.operations[operation==='generate'?'generation':'reference_edit']==='supported';
}
export async function verifiedImageUrl(blob:Blob, asset:ImageAsset):Promise<string> {
  if(!['image/png','image/jpeg','image/webp','image/gif'].includes(blob.type)||blob.type!==asset.mime)throw new Error('图片格式与保存记录不一致');
  if(!blob.size||blob.size>32*1024*1024||blob.size!==asset.size_bytes)throw new Error('图片大小与保存记录不一致');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
  if(digest!==asset.sha256)throw new Error('图片内容与保存的 hash 不一致');
  const url=URL.createObjectURL(blob);
  try {const image=new Image();image.src=url;await image.decode();if(!image.naturalWidth||!image.naturalHeight)throw new Error('图片无法解码');return url;}catch(error){URL.revokeObjectURL(url);throw error;}
}
interface Options { root:HTMLElement;context():FeatureContext;active():boolean;signal:AbortSignal;toast(message:string):void;assetsChanged?():Promise<void> }
type PendingImage = {topic_id:string;job_id:string|null;input_hash:string|null;key:string;input?:ImageGenerationRequest};
/** 图像渠道的用户显示名（与设置页「AGY · Nano Banana 2」「Codex 图像」对应，去掉内部代号）。 */
export const IMAGE_CHANNEL_NAMES:Record<string,string>={agy:'Nano Banana 2 生图',codex:'Codex 生图'};
export class ImageGenerationController {
  readonly options:Options;
  private topic=''; private epoch=0; private dialogEpoch=0; private loadEpoch=0; private requestEpoch=0; private busyRequest=0;
  private settings?:ImageProviderSettingsResponse; private assets:ImageAsset[]=[];private jobs:JobDetailResponse[]=[];
  private current?:JobDetailResponse; private topicDetail?:TopicDetail; private submitKey=''; private busy=false; private error='';private loading=false;
  private confirmDraft?:{provider:string;operation:'generate'|'reference_edit';prompt:string;purpose:string;reference:string}; private readonly arm=new ConfirmArm(()=>this.options.root.ownerDocument);
  // 防误触避让：与配图工作台同一逻辑。
  private readonly guard=new TriggerGuard(()=>this.options.root.ownerDocument);
  private dialogOpen=false; private timer?:ReturnType<typeof setTimeout>;private urls=new Map<string,string>();private previews=new Map<string,Promise<void>>();private imageErrors=new Map<string,string>();
  private draftTopic='';
  private draft={provider:'agy',operation:'generate' as 'generate'|'reference_edit',prompt:'',purpose:'内容配图',reference:''};
  private pending?:PendingImage;
  constructor(options:Options){this.options=options;}
  private storageKey(c=this.options.context()){const i=c.identity;return 'workbench-image-task:'+i.workspace_id+':'+i.service_instance_id;}
  private store(p=this.pending,c=this.options.context()){try{if(p){const value=JSON.stringify(p);localStorage.setItem(this.storageKey(c)+':topic:'+path(p.topic_id),value);if(this.pending?.key===p.key)localStorage.setItem(this.storageKey(c),value);}}catch{/* 服务任务仍持久保存。 */}}
  private clearPending(p:PendingImage,c=this.options.context()){if(this.pending?.key===p.key)this.pending=undefined;try{for(const key of [this.storageKey(c),this.storageKey(c)+':topic:'+path(p.topic_id)]){const raw=localStorage.getItem(key);if(raw&&JSON.parse(raw).key===p.key)localStorage.removeItem(key);}}catch{/* 服务任务仍持久保存。 */}}
  private restore(){try{const raw=localStorage.getItem(this.storageKey()+':topic:'+path(this.topic))??localStorage.getItem(this.storageKey());if(raw&&raw.length<16384){const p=JSON.parse(raw);if(typeof p.topic_id==='string'&&typeof p.key==='string'&&(p.job_id===null||typeof p.job_id==='string'))this.pending=p;}}catch{/* 不使用损坏的本地定位。 */}}
  activate(topic:string){if(topic===this.topic)return;this.deactivate();this.topic=topic;if(this.draftTopic!==topic){this.draftTopic=topic;this.submitKey='';this.draft={provider:'agy',operation:'generate',prompt:'',purpose:'内容配图',reference:''};}this.restore();const epoch=this.epoch,read=this.load(),load=this.loadEpoch;void read.catch(e=>{if(this.owns(epoch,undefined,undefined,topic)&&load===this.loadEpoch){this.error=e instanceof Error?e.message:'图像记录暂不可读';this.refresh();}});}
  deactivate(){this.close();this.epoch++;this.loadEpoch++;this.topic='';this.loading=false;for(const url of this.urls.values())URL.revokeObjectURL(url);this.urls.clear();this.previews.clear();this.imageErrors.clear();this.assets=[];this.jobs=[];this.current=undefined;this.settings=undefined;this.topicDetail=undefined;this.error='';}
  close(_reason:DialogCloseReason='user_close'){this.guard.stop();this.confirmDraft=undefined;this.arm.reset();this.capture();const wasOpen=this.dialogOpen;this.dialogOpen=false;this.dialogEpoch++;this.requestEpoch++;this.busy=false;this.busyRequest=0;clearTimeout(this.timer);if(wasOpen){this.loadEpoch++;this.loading=false;this.refresh();}}
  replace(title:string){if(this.dialogOpen&&!['准备图像任务','生成图像新版','读取原图像任务',IMAGE_CONFIRM_TITLE].includes(title)&&!title.startsWith('图像任务 · ')&&!title.startsWith('查看图片 · '))this.close();}
  dispose(){this.deactivate();}
  private owns(epoch:number,dialog?:number,request?:number,topic=this.topic){return !this.options.signal.aborted&&this.options.active()&&!!this.topic&&topic===this.topic&&epoch===this.epoch&&(dialog===undefined||this.dialogOpen&&dialog===this.dialogEpoch)&&(request===undefined||request===this.requestEpoch);}
  mount(){if(!this.topic||!this.options.active())return;const slot=this.options.root.querySelector('.editor-grid > .panel .panel-body');if(!slot)return;if(!slot.querySelector('.image-generation-panel'))slot.insertAdjacentHTML('afterbegin','<section class="image-generation-panel"></section>');this.refresh();}
  private refresh(){const slot=this.options.root.querySelector('.image-generation-panel');if(slot)slot.innerHTML=this.panel();void this.loadPreviews();}
  panel(){
    const blocked=this.pending?.topic_id===this.topic||this.jobs.some(j=>isUnknownImageJob(j)||activeStates.includes(j.job.state));
    return '<div class="image-panel-heading"><div><h3>AI 图像</h3><p class="fine">生成新版配图，原图与已保存稿件各自保留。</p></div>'+btn('生成图片','image-task',true,this.loading||!this.settings||blocked?'disabled':'')+'</div>'+(this.error?'<p class="configuration-error" role="alert">'+esc(this.error)+'</p>':'')+(this.loading?'<p class="fine" role="status">正在读取图像渠道和任务…</p>':'')+(this.pending?.topic_id===this.topic&&!this.pending.job_id?'<p class="note">任务创建结果尚未核清，请先核对服务记录。暂不创建另一任务。</p><details class="image-source-details"><summary>本轮输入与本机定位</summary><pre>'+esc(this.pending.input?.prompt??'原输入以服务记录为准')+'</pre><small>'+esc(this.pending.key)+'</small></details>':'')+this.jobs.slice(0,8).map(j=>'<div class="image-job-row"><div><strong>'+esc(this.jobLabel(j))+'</strong><small>'+esc(this.providerLabel(this.jobProvider(j)))+'</small></div>'+btn('查看任务','image-open-job',false,'data-job="'+esc(j.job.id)+'"')+'</div>').join('')+'<div class="image-gallery">'+this.assets.map(a=>{const m=imageMetadata(a),provider=typeof m.provider==='string'?this.providerLabel(m.provider):'已导入图片',parent=typeof m.parent_asset_id==='string'?m.parent_asset_id:'';return '<figure class="image-asset" data-image-asset="'+esc(a.id)+'">'+(this.urls.has(a.id)?'<button class="image-preview-button" data-action="image-view" data-asset="'+esc(a.id)+'" aria-label="查看图片 '+esc(typeof m.purpose==='string'?m.purpose:'本主题图片')+'"><img src="'+esc(this.urls.get(a.id)!)+'" alt="'+esc(typeof m.purpose==='string'?m.purpose:'本主题图片')+'"></button>':'<div class="image-preview-placeholder" role="status">'+esc(this.imageErrors.get(a.id)??(a.status==='missing'?'图片文件暂不可访问':'正在读取图片…'))+'</div>')+'<figcaption><strong>'+esc(typeof m.purpose==='string'?m.purpose:'本主题图片')+'</strong><p>'+esc(provider)+(typeof m.model==='string'?' · '+esc(m.model):'')+'</p>'+(parent?'<small>基于原图修改</small>':'')+'</figcaption></figure>';}).join('')+'</div>'+(!this.assets.length&&!this.loading?'<p class="fine">尚无图片，可生成新图或上传素材。</p>':'');
  }
  /** 渠道显示名：主路径只用用户看得懂的名字，渠道代号（agy/codex）只进「来源与版本」详情。 */
  private providerLabel(provider:string){return IMAGE_CHANNEL_NAMES[provider]??'图像渠道';}
  private jobProvider(j:JobDetailResponse){const m=this.manifest(j.job);const provider=(m.image&&typeof m.image==='object'&&!Array.isArray(m.image)?(m.image as JsonObject).provider:m.provider);return typeof provider==='string'?provider:'图像渠道';}
  private manifest(job:JobsRow):JsonObject{try{return typeof job.input_manifest==='string'?JSON.parse(job.input_manifest):job.input_manifest as JsonObject;}catch{return {};}}
  private jobLabel(j:JobDetailResponse){if(isUnknownImageJob(j))return '结果待核对';return ({queued:'等待执行',running:'正在生成',succeeded:'图片已保存',failed:'生成未完成',cancelled:'已取消',cancel_requested:'正在撤销',waiting_input:'需要补充输入',waiting_quota:'等待额度'} as Record<string,string>)[j.job.state]??j.job.state;}
  async load(owner?:{dialog:number;request:number}){
    const c=this.options.context(),topic=this.topic,epoch=this.epoch,n=++this.loadEpoch;this.loading=true;this.refresh();
    const owns=()=>this.owns(epoch,owner?.dialog,owner?.request,topic)&&n===this.loadEpoch;
    try {
      const [settings,assets,jobs]=await Promise.all([c.client.request<ImageProviderSettingsResponse>('GET','/api/v1/settings/image-providers',undefined,{signal:c.signal}),this.pages<ImageAsset>('/api/v1/assets?topic_id='+path(topic)),this.pages<JobsRow>('/api/v1/jobs?kind=media_generate&target_id='+path(topic))]);
      const imageJobs=jobs.filter(j=>this.manifest(j).operation==='image_provider');const details=await Promise.all(imageJobs.map(j=>c.client.request<JobDetailResponse>('GET','/api/v1/jobs/'+path(j.id),undefined,{signal:c.signal})));
      if(!owns())return;this.settings=settings;this.assets=assets.filter(a=>a.kind==='image');this.jobs=details;this.loading=false;this.error='';if(!this.submitKey)this.draft.provider=settings.default_provider;
      if(this.pending?.job_id&&this.pending.topic_id===topic){const detail=details.find(j=>j.job.id===this.pending?.job_id);if(detail&&!isUnknownImageJob(detail)&&['succeeded','failed','cancelled','waiting_input','waiting_quota'].includes(detail.job.state))this.clearPending(this.pending,c);}
      this.refresh();
    }finally{if(owns()){this.loading=false;this.refresh();}}
  }
  private async pages<T>(url:string){const c=this.options.context(),rows:T[]=[];let cursor:string|null=null;do{const page:Page<T>=await c.client.request<Page<T>>('GET',url+(cursor?'&cursor='+path(cursor):''),undefined,{signal:c.signal});rows.push(...page.items);cursor=page.next_cursor;}while(cursor);return rows;}
  private async loadPreviews(){
    if(!this.options.active())return;const c=this.options.context(),epoch=this.epoch;
    for(const asset of this.assets){if(asset.status==='missing'||this.urls.has(asset.id)||this.previews.has(asset.id)||this.imageErrors.has(asset.id))continue;
      const pending=(async()=>{try{if(!c.client.assetContent)throw new Error('当前宿主尚未提供图片内容查看');const blob=await c.client.assetContent(asset.id,c.signal),url=await verifiedImageUrl(blob,asset);if(!this.owns(epoch)){URL.revokeObjectURL(url);return;}this.urls.set(asset.id,url);}catch(e){if(this.owns(epoch))this.imageErrors.set(asset.id,e instanceof Error?e.message:'图片暂不可读');}finally{if(this.owns(epoch))this.refresh();}})();this.previews.set(asset.id,pending);
    }
  }
  handle(el:HTMLElement){const action=el.dataset.action;if(!action||!['image-task','image-confirm','image-back','do-image','image-open-job','image-query','image-view'].includes(action))return false;if(this.busy)return true;const epoch=this.epoch,topic=this.topic,operation=this.dispatch(action,el),dialog=this.dialogEpoch,request=this.requestEpoch;void operation.catch(e=>{if(this.owns(epoch,dialog,request,topic)){this.error=e instanceof Error?e.message:'图像操作未完成';this.options.toast(this.error);const body=this.options.root.querySelector('#dialog .dialog-body');body?.querySelector('.image-error')?.remove();body?.insertAdjacentHTML('afterbegin','<p class="image-error configuration-error" role="alert">'+esc(this.error)+'</p>');this.refresh();}});return true;}
  handleChange(input:HTMLInputElement){if(!input.id.startsWith('image-'))return false;this.capture();if(input.id==='image-operation'&&this.draft.operation==='generate')this.draft.reference='';if(['image-provider','image-operation','image-reference'].includes(input.id)&&this.dialogOpen&&!this.busy)this.presentForm();return true;}
  handleInput(input:HTMLInputElement){if(!input.id.startsWith('image-'))return false;this.capture();return true;}
  private capture(){const get=(id:string)=>this.options.root.querySelector<HTMLInputElement>('#'+id);if(get('image-prompt'))this.draft={provider:get('image-provider')!.value,operation:get('image-operation')!.value as 'generate'|'reference_edit',prompt:get('image-prompt')!.value,purpose:get('image-purpose')!.value,reference:get('image-reference')!.value};}
  private presentForm(){
    const settings=this.settings;if(!settings)return;const channel=settings.channels.find(c=>c.provider===this.draft.provider),editable=this.draft.operation==='reference_edit',supported=canUseImageOperation(settings,this.draft.provider,this.draft.operation)&&(!editable||!!this.draft.reference);
    this.options.context().surface.presentDialog({title:'生成图像新版',body:'<div class="image-form-grid"><label class="configuration-field" for="image-provider"><span>图像渠道</span><select class="field" id="image-provider">'+settings.channels.map(c=>'<option value="'+esc(c.provider)+'" '+(c.provider===this.draft.provider?'selected':'')+'>'+esc(c.label)+(c.enabled?'':' · 未启用')+'</option>').join('')+'</select></label><label class="configuration-field" for="image-operation"><span>本轮操作</span><select class="field" id="image-operation"><option value="generate" '+(!editable?'selected':'')+'>生成新图</option><option value="reference_edit" '+(editable?'selected':'')+'>参考原图修改</option></select></label></div><label class="configuration-field" for="image-purpose"><span>图片用途</span><input class="field" id="image-purpose" maxlength="300" value="'+esc(this.draft.purpose)+'"></label><label class="configuration-field" for="image-prompt"><span>画面要求</span><textarea class="field" id="image-prompt" rows="5" maxlength="8000" placeholder="说明需要呈现的画面、准确文字和修改要求">'+esc(this.draft.prompt)+'</textarea></label><label class="configuration-field" for="image-reference"><span>'+(editable?'原图 · 本轮参考':'参考图 · 仅修改模式可用')+'</span><select class="field" id="image-reference" '+(!editable?'disabled':'')+'><option value="">'+(editable?'选择一张已保存图片':'不使用参考图')+'</option>'+this.assets.filter(a=>a.status==='ready').map(a=>'<option value="'+esc(a.id)+'" '+(a.id===this.draft.reference?'selected':'')+'>'+esc(typeof imageMetadata(a).purpose==='string'?imageMetadata(a).purpose:a.id.slice(0,12))+' · '+esc(a.sha256.slice(0,12))+'</option>').join('')+'</select></label><p class="fine">'+esc(channel?.model??'具体模型由原生渠道回执记录')+'。'+esc(channel?.limitations.join('；')??'渠道状态待核对')+'</p><p class="note">生成结果保存为新图片，原图保留。完成后可先查看，再决定如何使用。</p>'+(supported?'':'<p class="fine" role="status">所选渠道或操作尚不可用，请核对设置与参考图片。</p>'),foot:btn('取消','close-dialog')+btn('创建图像任务','image-confirm',true,!supported?'disabled':'')});
  }
  private presentJob(detail:JobDetailResponse){
    this.current=detail;this.jobs=[detail,...this.jobs.filter(j=>j.job.id!==detail.job.id)];this.refresh();const active=activeStates.includes(detail.job.state),unknown=isUnknownImageJob(detail),c=this.options.context();
    c.surface.presentDialog({title:'图像任务 · '+this.jobProvider(detail),body:'<div class="image-task-status"><strong id="image-job-state">'+esc(this.jobLabel(detail))+'</strong><p id="image-job-message">'+esc(detail.error?.message??(active?'请求与原生任务标识保存在本机，关闭时会请求撤销。':unknown?'只核对原任务记录，不重新发送画面要求。':'任务记录与图片版本已保存。'))+'</p><small>'+esc(detail.job.id)+'</small></div>'+(detail.job.state==='succeeded'?'<p class="note">图片已保存为新版本，可在本主题 AI 图像区查看。原图未覆盖，稿件未自动采用。</p>':'')+(unknown?'<p class="note">结果尚未确定，暂不创建另一图像任务。停止本机进程不能证明远端已取消。</p>':''),foot:btn(active?'取消任务':'关闭',active?'cancel-task':'close-dialog')+(unknown?(detail.job.cancel_requested_at?btn('重新读取原任务','image-open-job',false,'data-job="'+esc(detail.job.id)+'"'):btn('核对原任务','image-query',true,'data-job="'+esc(detail.job.id)+'"')):''),...(active?{foregroundJob:{id:detail.job.id,version:detail.job.version}}:{})});
  }
  /** 与提交时相同的前置校验：在打开「确认生成」之前就拦下填写不完整或渠道不可用的请求。 */
  private validate(frozen:{provider:string;operation:'generate'|'reference_edit';prompt:string;purpose:string;reference:string}){
    if(!frozen.prompt.trim()||!frozen.purpose.trim())throw new Error('填写图片用途和画面要求');if(!canUseImageOperation(this.settings,frozen.provider,frozen.operation))throw new Error('所选图像操作尚未验证可用');
    if(frozen.operation==='generate'&&frozen.reference)throw new Error('参考图须选择参考原图修改模式');if(frozen.operation==='reference_edit'&&!frozen.reference)throw new Error('先选择要修改的原图');
    if(frozen.reference&&!this.assets.some(a=>a.id===frozen.reference&&a.status==='ready'))throw new Error('参考图已变化，请重新选择');
  }
  /** 统一「确认生成」：渠道、模型、张数；本面板读不到剩余次数，写明提交时按渠道额度核对。 */
  private presentConfirm(frozen:{provider:string;operation:'generate'|'reference_edit';prompt:string;purpose:string;reference:string}){
    const channel=this.settings?.channels.find(x=>x.provider===frozen.provider),edit=frozen.operation==='reference_edit';
    const dialog=generateConfirmDialog({title:IMAGE_CONFIRM_TITLE,lead:edit?'以所选原图为参考生成 <b>1</b> 张新图，原图保留。':'生成 <b>1</b> 张新图，保存为新版本。',image:frozen.purpose.trim(),provider:channel?.label??frozen.provider,model:channel?.model??'渠道默认模型',count:1,remaining:undefined,extra:[['剩余次数','提交时按本渠道额度核对，额度不足不会入队']]},{action:'do-image'},{label:'返回修改',action:'image-back'},this.arm.open());
    this.options.context().surface.presentDialog(dialog);this.guard.watch();
  }
  async dispatch(action:string,el:HTMLElement){
    const c=this.options.context(),epoch=this.epoch,topic=this.topic,request=++this.requestEpoch;
    if(action==='image-task'){
      this.dialogOpen=true;const d=++this.dialogEpoch;this.submitKey=crypto.randomUUID();c.surface.presentDialog({title:'准备图像任务',body:'<p class="fine" role="status">正在核对图像渠道、图片和已保存稿件…</p>',foot:btn('关闭','close-dialog')});await this.load({dialog:d,request});if(!this.owns(epoch,d,request,topic))return;if(this.pending?.topic_id===topic||this.jobs.some(j=>isUnknownImageJob(j)||activeStates.includes(j.job.state)))throw new Error('先核对当前图像任务，再创建新版本');
      await c.drafts.leave();if(!this.owns(epoch,d,request,topic))return;const detail=await c.client.request<TopicDetail>('GET','/api/v1/topics/'+path(topic),undefined,{signal:c.signal});if(!this.owns(epoch,d,request,topic))return;this.topicDetail=detail;if(c.drafts.status(this.topicDetail.core_document_id)&&c.drafts.status(this.topicDetail.core_document_id)!=='committed')throw new Error('人工修改尚未保存，请先核对保存状态');this.presentForm();return;
    }
    if(action==='image-view'){this.dialogOpen=true;const d=++this.dialogEpoch,asset=this.assets.find(a=>a.id===el.dataset.asset);if(!asset)throw new Error('图片不属于当前主题');await this.previews.get(asset.id);if(!this.owns(epoch,d,request,topic))return;const url=this.urls.get(asset.id);if(!url)throw new Error(this.imageErrors.get(asset.id)??'图片暂不可查看');const m=imageMetadata(asset);c.surface.presentDialog({title:'查看图片 · '+asset.id.slice(0,8),body:'<img class="image-full-preview" src="'+esc(url)+'" alt="'+esc(typeof m.purpose==='string'?m.purpose:'已保存图片')+'"><details class="image-source-details"><summary>本轮画面要求与版本</summary><pre>'+esc(typeof m.prompt==='string'?m.prompt:'上传素材')+'</pre><dl class="image-source-fields">'+[['图像渠道',m.provider],['实际模型',m.model??'原生回执未返回'],['原任务',m.job_id],['版本',m.version_id??m.version],['父图',m.parent_asset_id??'无'],['参考图',JSON.stringify(m.reference_assets??[])],['品牌版本',m.brand_manifest_sha256],['引用文稿',m.document_revision_id??'未引用'],['引用计划',m.plan_revision_id??'未引用']].map(([key,value])=>'<div><dt>'+esc(key)+'</dt><dd>'+esc(value??'待核对')+'</dd></div>').join('')+'</dl><small>SHA256 '+esc(asset.sha256)+'</small></details>',foot:btn('关闭','close-dialog')});return;}
    if(action==='image-open-job'){this.dialogOpen=true;const d=++this.dialogEpoch;c.surface.presentDialog({title:'读取原图像任务',body:'<p class="fine" role="status">正在读取原任务记录…</p>',foot:btn('关闭','close-dialog')});const detail=await c.client.request<JobDetailResponse>('GET','/api/v1/jobs/'+path(el.dataset.job!),undefined,{signal:c.signal});if(!this.owns(epoch,d,request,topic))return;if(detail.job.target_id!==topic||this.manifest(detail.job).operation!=='image_provider')throw new Error('任务不属于当前主题的图像请求');this.presentJob(detail);this.watch(detail.job.id,epoch,d,request,topic);return;}
    // 真实生图先确认：表单「创建图像任务」只打开统一的「确认生成」（渠道、模型、张数、剩余次数，确认按钮带冷却）；确认后才提交，「返回修改」回到表单。
    if(action==='image-confirm'){if(this.busy||!this.dialogOpen)return;this.capture();const frozen={...this.draft};this.validate(frozen);this.confirmDraft=frozen;this.presentConfirm(frozen);return;}
    if(action==='image-back'){if(this.busy||!this.confirmDraft)return;this.draft={...this.confirmDraft};this.confirmDraft=undefined;this.arm.reset();this.presentForm();return;}
    if(action==='do-image'&&!this.confirmDraft)return;
    const d=this.dialogEpoch;if(!this.owns(epoch,d,request,topic))return;this.busy=true;this.busyRequest=request;c.surface.dialogBusy?.(true);
    try{
      if(action==='image-query'){const id=this.current?.job.id;if(!id||id!==el.dataset.job||!isUnknownImageJob(this.current!))throw new Error('原任务已变化，请重新读取');await c.client.request('POST','/api/v1/jobs/'+path(id)+'/image-query',{expected_version:this.current!.job.version},{signal:c.signal,idempotencyKey:crypto.randomUUID()});if(!this.owns(epoch,d,request,topic))return;const detail=await c.client.request<JobDetailResponse>('GET','/api/v1/jobs/'+path(id),undefined,{signal:c.signal});if(!this.owns(epoch,d,request,topic))return;this.presentJob(detail);this.watch(id,epoch,d,request,topic);return;}
      if(action==='do-image'){
        const frozen={...this.confirmDraft!};if(!frozen.prompt.trim()||!frozen.purpose.trim())throw new Error('填写图片用途和画面要求');if(!canUseImageOperation(this.settings,frozen.provider,frozen.operation))throw new Error('所选图像操作尚未验证可用');if(frozen.operation==='generate'&&frozen.reference)throw new Error('参考图须选择参考原图修改模式');if(frozen.operation==='reference_edit'&&!frozen.reference)throw new Error('先选择要修改的原图');if(frozen.reference&&!this.assets.some(a=>a.id===frozen.reference&&a.status==='ready'))throw new Error('参考图已变化，请重新选择');
        await c.drafts.leave();if(!this.owns(epoch,d,request,topic))return;const latest=await c.client.request<TopicDetail>('GET','/api/v1/topics/'+path(topic),undefined,{signal:c.signal});if(!this.owns(epoch,d,request,topic))return;if(!this.topicDetail||latest.core.head_revision_id!==this.topicDetail.core.head_revision_id||latest.preparation_head_revision_id!==this.topicDetail.preparation_head_revision_id)throw new Error('稿件或素材计划已变化，请关闭后重新核对');if(c.drafts.status(latest.core_document_id)&&c.drafts.status(latest.core_document_id)!=='committed')throw new Error('人工修改尚未保存');
        const body:ImageGenerationRequest={generator:'image',provider:frozen.provider as 'agy'|'codex',operation:frozen.operation,topic_id:topic,purpose:frozen.purpose.trim(),prompt:frozen.prompt.trim(),input_asset_ids:frozen.reference?[frozen.reference]:[],parent_asset_id:frozen.operation==='reference_edit'?frozen.reference:null,document_revision_id:latest.core.head_revision_id,plan_revision_id:null};
        if(this.pending?.topic_id===topic)throw new Error('原任务创建结果待核对，不能重发');const pending:PendingImage={topic_id:topic,job_id:null,input_hash:null,key:this.submitKey,input:body};this.pending=pending;this.store(pending,c);this.confirmDraft=undefined;
        let accepted:{job_id:string;state:string;input_hash:string};try{accepted=await c.client.request('POST','/api/v1/asset-generations',body,{signal:c.signal,idempotencyKey:pending.key});}catch(e){const error=e as {status?:number};if(error.status&&error.status>=400&&error.status<500)this.clearPending(pending,c);throw e;}
        pending.job_id=accepted.job_id;pending.input_hash=accepted.input_hash;if(this.pending?.key===pending.key)this.pending=pending;this.store(pending,c);
        if(!this.owns(epoch,d,request,topic)){await this.cancelLateAccepted(accepted.job_id,c);return;}
        const detail=await c.client.request<JobDetailResponse>('GET','/api/v1/jobs/'+path(accepted.job_id),undefined,{signal:c.signal});if(!this.owns(epoch,d,request,topic)){await this.cancelLateAccepted(accepted.job_id,c);return;}if(detail.job.id!==accepted.job_id||detail.job.target_id!==topic||detail.job.input_hash!==accepted.input_hash||this.manifest(detail.job).operation!=='image_provider')throw new Error('任务回执与当前图像请求不一致，请核对原任务');this.presentJob(detail);this.watch(accepted.job_id,epoch,d,request,topic);
      }
    }finally{if(this.busyRequest===request&&this.owns(epoch,d,request,topic)){this.busy=false;this.busyRequest=0;c.surface.dialogBusy?.(false);}}
  }
  private async cancelLateAccepted(id:string,c:FeatureContext){try{const detail=await c.client.request<JobDetailResponse>('GET','/api/v1/jobs/'+path(id),undefined,{signal:c.signal});if(activeStates.includes(detail.job.state))await c.client.cancelJob(id,detail.job.version,{signal:c.signal,idempotencyKey:crypto.randomUUID()});}catch{/* 保持已保存的原任务定位，不能重发。 */}}
  private watch(id:string,epoch:number,dialog:number,request:number,topic:string){clearTimeout(this.timer);if(!this.owns(epoch,dialog,request,topic)||!this.current||!activeStates.includes(this.current.job.state))return;this.timer=setTimeout(()=>{void(async()=>{try{const c=this.options.context(),detail=await c.client.request<JobDetailResponse>('GET','/api/v1/jobs/'+path(id),undefined,{signal:c.signal});if(!this.owns(epoch,dialog,request,topic)||this.current?.job.id!==id)return;this.presentJob(detail);if(!activeStates.includes(detail.job.state)){await this.load({dialog,request});if(detail.job.state==='succeeded'&&this.owns(epoch,dialog,request,topic))await this.options.assetsChanged?.();}else this.watch(id,epoch,dialog,request,topic);}catch(e){if(this.owns(epoch,dialog,request,topic)){this.options.toast(e instanceof Error?e.message:'原任务状态暂不可读');this.error='任务状态暂不可读，可重新打开原任务核对。';this.refresh();}}})();},750);}
}
