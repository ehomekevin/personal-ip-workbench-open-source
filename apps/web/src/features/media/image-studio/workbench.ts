import type { FeatureContext, GenerationProgressView } from '../../../transport/feature-ports.ts';
import type { ContentExecutor, ImagePlanSnapshot, ImagePlanItemUpdate, ImagePlanItemCreate, StudioAssetVersionRequest, StudioAssetVersionResult, StudioMark, StudioUploadPurpose, ImageProviderSettingsResponse, Page, StudioWebImageCandidates, StudioWebImportResult, ArticleLayoutView } from '@workbench/contracts';
import { createTemplateHelpers } from '../../../components/templateHelpers.ts';
import { executorChoices, preferredExecutor, type ExecutorChoice } from '../../../components/executors.ts';
import { projectStudioSnapshot, projectWebCandidateList, webCaptureNextDelay, WEB_CAPTURE_POLL, WEB_CAPTURE_SLOW, isVersionConflict, studioProviderOption, studioProviderReady, defaultStudioProvider, studioRatioLabel, studioAspect, STUDIO_PROVIDER_NAMES } from './model.ts';
import type { StudioAssetRecord, StudioSnapshot, StudioSubmit, StudioVersion, StudioWebCandidateView, StudioWebCandidateList, StudioWebCaptureView } from './model.ts';
import { ConfirmArm, TriggerGuard, generateConfirmDialog } from './generate-confirm.ts';
import { articleConfirmationIsCurrent } from '../../../../../../packages/domain/src/article-layout/index.ts';
import type { LoaderOptions } from '../../../components/image-generation-loader-core.ts';
import { studioLoaderProgress, studioLoaderFailure } from './loader-progress.ts';
import { projectWorkbench, sizeForAspect, generateAllPlan, budgetLine, planGenerationSubmit, appendChip, workbenchErrorCopy, positionOptions, parsePosition, composeEditDescription, resizeDescription, versionTag, recoverableVersions, describeMark, MARK_LABELS, UPLOAD_PURPOSE_LABELS, PLAN_CHIPS, STRATEGY_LABELS, ASPECT_LABELS, adjustMark, markBounds, sanitizeMark, fitPath, BRUSH_PATH_LIMIT, RECT_HANDLES, type MarkHandle, type PlanItemVM, type WorkbenchVM } from './plan-model.ts';
// 公众号配图工作台（A2 / A2-2）：创作页内的全宽面板。左栏是可直接编辑的方案列表（图注、来源、插入位置、排序、删除），中栏是单图舞台（标注、尺寸、版本），右栏改选中的那张图；整篇文章在「预览完整文章」弹窗里看。
const {btn,esc}=createTemplateHelpers([]),path=encodeURIComponent;
// 需要额外 class 的按钮：模板 btn 已写死 class，这里单独拼，避免重复 class 属性被浏览器丢弃。
const cbtn=(label:string,action:string,cls:string,attrs='')=>'<button type="button" class="button '+cls+'" data-action="'+action+'" '+attrs+'>'+esc(label)+'</button>';
// 规划执行器的短状态：只写「可用 / 额度不足 / 需登录」，不在选项里挂「未经真实验收」。
const plannerStatus=(c:ExecutorChoice)=>c.usable?'可用':c.status==='额度暂不可用'?'额度不足':c.status==='需要登录'?'需登录':c.status;
export const WORKBENCH_TITLES=['公众号配图 · 批量生成','公众号配图 · 完整文章预览','公众号配图 · 删除这张图','公众号配图 · 对比修改前后','公众号配图 · 调整画幅与尺寸','公众号配图 · 确认生成','公众号配图 · 重新确认配图','公众号配图 · 新加图片位'];
export { GENERATE_ARM_MS } from './generate-confirm.ts';
export interface ImagePlanLoad {plan:ImagePlanSnapshot;studio:StudioSnapshot;executors:ExecutorChoice[];default_executor:ContentExecutor}
export interface ImagePlanPort {
  load(topic:string,context:FeatureContext,withSettings:boolean):Promise<ImagePlanLoad>;
  run(input:{topic_id:string;expected_version:number;replan:boolean;executor?:ContentExecutor},key:string,context:FeatureContext):Promise<ImagePlanSnapshot>;
  update(item:string,input:ImagePlanItemUpdate,key:string,context:FeatureContext):Promise<ImagePlanSnapshot>;
  create(input:ImagePlanItemCreate,key:string,context:FeatureContext):Promise<ImagePlanSnapshot>;
  assetVersion(input:StudioAssetVersionRequest,key:string,context:FeatureContext):Promise<StudioAssetVersionResult>;
  /** 网络候选：先返回已缓存的图，capture 说明资讯原文是否还在后台补充；refresh=true 是用户点「重新读取」。 */
  candidates(topic:string,context:FeatureContext,options?:{refresh?:boolean}):Promise<StudioWebCandidateList>;
  /** 重新读取规划执行器状态（服务刚启动时执行器还在后台检查，先返回「待检查」）。 */
  executors?(context:FeatureContext):Promise<{executors:ExecutorChoice[];default_executor:ContentExecutor}>;
  /** 确认配图（冻结配图终稿给排版）。 */
  confirm?(input:{topic_id:string;expected_version:number},key:string,context:FeatureContext):Promise<ImagePlanSnapshot>;
  /** 排版进度（只读）：步骤条与「确认配图」据此说明排版是否已确认；还没进入过排版时返回 started=false。 */
  layout?(topic:string,context:FeatureContext):Promise<WorkbenchLayoutStatus>;
}
/** 配图页看到的排版进度：started=已进入过排版；confirmed=排版已确认；synced=排版用的就是当前配图终稿（配图确认后没再改）。 */
export interface WorkbenchLayoutStatus {started:boolean;confirmed:boolean;synced:boolean}
export function imagePlanHttpPort():ImagePlanPort {
  let settingsCache:{executors:ExecutorChoice[];default_executor:ContentExecutor}|undefined;
  return {
    async load(topic,c,withSettings){
      const assets=async()=>{const out:StudioAssetRecord[]=[];let cursor:string|null=null;do{const page:Page<StudioAssetRecord>=await c.client.request('GET','/api/v1/assets?topic_id='+path(topic)+(cursor?'&cursor='+path(cursor):''),undefined,{signal:c.signal});out.push(...page.items);cursor=page.next_cursor;}while(cursor);return out;};
      const settings=async()=>{if(settingsCache&&!withSettings&&!settingsCache.executors.some(unchecked))return settingsCache;try{const s=await c.client.getSettings(c.signal);settingsCache={executors:executorChoices(s),default_executor:s.default_executor as ContentExecutor};}catch{settingsCache=settingsCache??{executors:executorChoices(null),default_executor:'codex'};}return settingsCache;};
      // 方案读取可能刚自动导入了网络图：先读方案，再读资产清单，避免新图缺少已核对的文件记录。
      const plan=await c.client.request<ImagePlanSnapshot>('GET','/api/v1/image-studio/plan?topic_id='+path(topic),undefined,{signal:c.signal});
      const [list,providers,exec]=await Promise.all([assets(),c.client.request<ImageProviderSettingsResponse>('GET','/api/v1/settings/image-providers',undefined,{signal:c.signal}),settings()]);
      return {plan,studio:projectStudioSnapshot(plan.studio,list,providers),executors:exec.executors,default_executor:exec.default_executor};
    },
    run:(input,key,c)=>c.client.request('POST','/api/v1/image-studio/plan/runs',input,{signal:c.signal,idempotencyKey:key}),
    update:(item,input,key,c)=>c.client.request('POST','/api/v1/image-studio/plan/items/'+path(item),input,{signal:c.signal,idempotencyKey:key}),
    create:(input,key,c)=>c.client.request('POST','/api/v1/image-studio/plan/items',input,{signal:c.signal,idempotencyKey:key}),
    assetVersion:(input,key,c)=>c.client.request('POST','/api/v1/image-studio/asset-versions',input,{signal:c.signal,idempotencyKey:key}),
    executors:async c=>{const s=await c.client.getSettings(c.signal);settingsCache={executors:executorChoices(s),default_executor:s.default_executor as ContentExecutor};return settingsCache;},
    confirm:(input,key,c)=>c.client.request('POST','/api/v1/image-studio/plan/confirm',input,{signal:c.signal,idempotencyKey:key}),
    layout:async(topic,c)=>{try{const view:ArticleLayoutView=await c.client.request('GET','/api/v1/article-layout?topic_id='+path(topic),undefined,{signal:c.signal});return {started:true,confirmed:articleConfirmationIsCurrent(view.snapshot),synced:view.images.state==='synced'};}
      catch(e){if((e as {response?:{error?:{code?:string}}})?.response?.error?.code==='NOT_FOUND')return {started:false,confirmed:false,synced:false};throw e;}},
    candidates:async(topic,c,options)=>{const value:StudioWebImageCandidates=await c.client.request('GET','/api/v1/topics/'+path(topic)+'/web-image-candidates'+(options?.refresh?'?refresh=1':''),undefined,{signal:c.signal});return projectWebCandidateList(value);},
  };
}
/** 执行器健康还没检查完（服务刚启动的占位）：界面显示「待检查」，稍后再读一次。 */
export const unchecked=(c:ExecutorChoice)=>!c.usable&&!c.blocked;
export interface ProgressMount {mount(container:HTMLElement,key:string,view:GenerationProgressView):void;update(view:GenerationProgressView):void;dispose():void}
/** 生图加载动效由宿主注入（img-fx 像素马赛克，React 组件）；未注入时舞台里是文字占位。 */
export interface ImageLoaderMount {mount(el:HTMLElement,options:LoaderOptions):{update(options:LoaderOptions):void;dispose():void}}
export interface WorkbenchAddPrefill {slot_id:string|null;paragraph_id:string;placement:string;title:string;description:string;width:number;height:number}
export interface WorkbenchHost {
  root:HTMLElement; context():FeatureContext; active():boolean; signal:AbortSignal; toast(message:string):void;
  submit(input:StudioSubmit,key:string,context:FeatureContext):Promise<{job_id:string;input_hash:string}>;
  webImport(input:{topic_id:string;expected_version:number;slot_id:string|null;candidate:{candidate_id:string;image_url:string}},key:string,context:FeatureContext):Promise<StudioWebImportResult>;
  /** 进度球体由宿主注入（复用 GenerationProgress）；未注入时显示文字进度。 */
  progress?():ProgressMount;
  imageLoader?():ImageLoaderMount;
  imageUrl(version:StudioVersion):string|undefined; setStudio(snapshot:StudioSnapshot):void; openAdd(prefill:WorkbenchAddPrefill|null):void; assetsChanged?():Promise<void>;
  /** 旧版提交超过 3 分钟仍没有任务编号（会挡住「更多选项」新增）；工作台在加图处给出「放弃这次请求」。 */
  pendingStale?():boolean; abandonPending?():void;
  /** 上传一张图片到本篇素材（复用参考图上传），返回已保存的资产。 */
  upload?(file:File,purpose:StudioUploadPurpose,context:FeatureContext):Promise<{asset_id:string}>;
  /** 舞台上「生成中」的加载占位（生图加载动效接入点）；不提供时用文字占位。 */
  renderLoading?(item:{id:string;caption:string;width:number;height:number;images:string[]}):string|undefined;
  /** 进入排版（关掉工作台，打开同一篇的排版面板）。 */
  openLayout?(topic:string):void;
  /** 标注草稿的本机存储（默认浏览器 localStorage；不可用时标注只留在当前页面）。 */
  storage?():Storage|undefined;
}
type Tool='select'|'rect'|'brush'|'arrow'|'text';
// 新加图片位的来源：上传也是先建一个图片位（按 AI 生图占位），再在右栏「上传图片」里选文件。
type InsertSource='ai_generate'|'article_original'|'platform_post'|'upload';
const INSERT_SOURCES:Array<[InsertSource,string,string]>=[['ai_generate','AI 生图','按这一段生成，提交前会先确认渠道和次数'],['article_original','网络找图 · 原文 / 官方图','从资讯原文里自动挑一张，之后可以换'],['platform_post','网络找图 · 同题帖子图','从同题平台作品里自动挑一张，之后可以换'],['upload','上传图片','用自己的图：新加后在右栏选文件']];
const MARK_STORE_LIMIT=500000;
const TOOLS:Array<[Tool,string]>=[['select','选择'],['rect','框选'],['brush','涂抹'],['arrow','箭头'],['text','改文字']];
const TOOL_HINTS:Record<Tool,string>={select:'选框选、涂抹、箭头或改文字工具，在图上标出要改的地方',rect:'在图片上拖动框选，再在下面写这一处怎么改',brush:'涂抹想修改的部分，标注会和修改要求一起发送',arrow:'拖动箭头指向想修改的元素',text:'点击图上要改字的位置，再在下面写新文字'};
const RESIZE_RATIOS:Array<[string,number,number]>=[['16:9',1600,900],['4:3',1600,1200],['1:1',1600,1600],['3:4',1200,1600],['9:16',1080,1920],['2:5',1200,3000]];
const ACTIVE_VERSION=['queued','running','reconciling','waiting_input','waiting_quota'];
const LOADER_LABELS:Record<string,string>={queued:'排队中',running:'正在生成',reconciling:'正在核对结果',waiting_input:'等待执行器',waiting_quota:'等待额度'};
const SCROLL_KEEP=['.iwb-plan','.iwb-stage-col','.iwb-edit','.iwb-steps'];
type LoaderEntry={node:HTMLElement;handle:{update(options:LoaderOptions):void;dispose():void};done:boolean;version:string|null;opts:LoaderOptions};
export class ImageWorkbench {
  readonly host:WorkbenchHost; readonly port:ImagePlanPort;
  private openTopic=''; private epoch=0; private plan?:ImagePlanSnapshot; private studio?:StudioSnapshot; private vm?:WorkbenchVM;
  private executors:ExecutorChoice[]=[]; private executor:ContentExecutor='codex'; private provider:'codex'|'agy'='agy'; private focus='';
  private preview=new Map<string,string>(); private quota=new Set<string>(); private requests=new Map<string,string>(); private prompts=new Map<string,string>();
  private candidates?:StudioWebCandidateView[]; private candidatesError='';
  // 资讯原文后台补图：状态、轮询计时器与退避；关闭/切文章时停止。
  private candidateCapture?:StudioWebCaptureView; private candidateTimer?:ReturnType<typeof setTimeout>; private candidateDelay=WEB_CAPTURE_POLL.first_ms; private candidatePolls=0; private candidateSeq=0; private loading=false; private error=''; private working=new Set<string>();
  private autoTried=new Set<string>(); private timer?:ReturnType<typeof setTimeout>; private delay=1500; private allProvider:'codex'|'agy'='agy'; private confirmOpen=false;
  // 用户在右栏 / 确认框手动选过的渠道：本次会话（工作台实例存活期间）保留，不再被默认值覆盖。
  private providerPicked=false; private allPicked=false;
  // A2-2：标注（按方案项分开保存，生成修改版后清空）、当前工具、右栏分页、上传用途、画幅调整草稿、拖拽中的项。
  private marks=new Map<string,StudioMark[]>(); private tool:Tool='select'; private tab:'modify'|'sources'|'refs'='modify'; private uploadPurpose:StudioUploadPurpose='style';
  private resizeDraft?:{item:string;width:number;height:number};
  // 标注调整：撤销栈（按「图 + 版本」分开）、选中的一处、拖动/缩放中的状态；标注草稿存本机，刷新后还在。
  private markHistory=new Map<string,StudioMark[][]>(); private selectedMark=0; private selectedKey=''; private adjusting?:{key:string;id:number;mode:MarkHandle;start:{x:number;y:number};orig:StudioMark;next?:StudioMark};
  // 新加图片位弹窗的草稿：插入位置（与卡片位置下拉同一取值）、来源、图注。
  private insertDraft?:{value:string;source:InsertSource;caption:string};
  // 本机草稿同步：每个键上次与 localStorage 对齐时的内容（JSON），用来发现另一个标签页的改动；storage 事件随工作台开关。
  private markBase=new Map<string,string>(); private storageWatch?:AbortController;
  // 正在编辑说明的那一处（同一处连续输入只压一次撤销栈）；正在拖动/画图的指针（多指触控时只跟第一根手指）。
  private noteEditing=''; private pointer:number|null=null; private brushSimplified=false;
  // 已入队、等结果的图片位：入队前已有的版本、入队时舞台上看的预览版；新版本出来后设为当前图。fresh=切走期间出了新版本的图片位（卡片上标一下）。
  private expecting=new Map<string,{known:Set<string>;viewing:string|undefined}>(); private fresh=new Set<string>();
  // 批量生成的勾选：没动过时默认选中全部「待生成」；已配好的图也可勾选，生成的新版本只作候选，不自动采用。
  private picked=new Set<string>(); private pickTouched=false; private dragging=''; private drawing?:StudioMark; private removeTarget='';
  // 每次打开「生成全部」确认框都是一个新批次；旧批次的循环在任何 await 之后发现批次号变了就停，不会替新确认框提交。
  private batchSeq=0; private confirmBatch=0;
  // 单张生成 / 生成修改版：先弹「确认生成」（渠道、模型、张数），确认后才提交；弹窗关掉即作废。
  private genPending?:{item:string;op:'generate'|'reference_edit'|'resize';description:string;provider:'codex'|'agy';marks?:StudioMark[];markKey?:string;size?:{width:number;height:number}};
  // 确认按钮的防穿透冷却：绑定到每一次打开的确认弹窗。
  private readonly arm=new ConfirmArm(()=>this.host.root.ownerDocument);
  // 排版进度（进入工作台时读一次）：undefined=还没读到或读不到，步骤条不做推断。
  private layoutState?:WorkbenchLayoutStatus; private confirmError=''; private layoutChecking=false; private layoutSeq=0;
  private readonly progress:ProgressMount|undefined; private progressNode?:HTMLElement;
  // 舞台上 AI 生图的加载动效（#41 img-fx）：每个方案项一个常驻节点，重绘时搬回新占位，不重建着色器；实例上限与降级由加载器核心负责。
  private readonly loaderMount:ImageLoaderMount|undefined; private loaders=new Map<string,LoaderEntry>(); private loaderPlan=new Map<string,{opts:LoaderOptions;version:string|null}>();
  constructor(host:WorkbenchHost,port:ImagePlanPort=imagePlanHttpPort()){this.host=host;this.port=port;this.progress=host.progress?.();this.loaderMount=host.imageLoader?.();}
  get isOpen(){return !!this.openTopic;}
  private owns(epoch:number){return !this.host.signal.aborted&&this.host.active()&&!!this.openTopic&&epoch===this.epoch;}
  open(topic:string){if(this.openTopic===topic){this.mount();return;}this.close();this.openTopic=topic;this.epoch++;this.focus='';this.preview.clear();this.quota.clear();this.requests.clear();this.prompts.clear();this.candidates=undefined;this.candidatesError='';this.candidateCapture=undefined;this.error='';this.picked.clear();this.pickTouched=false;this.syncDeferred=false;this.restoreMarks();this.watchStorage();this.expecting.clear();this.fresh.clear();this.markHistory.clear();this.noteEditing='';this.selectedMark=0;this.selectedKey='';this.insertDraft=undefined;this.plan=undefined;this.vm=undefined;this.layoutState=undefined;this.confirmError='';this.genPending=undefined;this.loading=true;this.mount();const epoch=this.epoch;void this.load(true).catch(e=>this.fail(epoch,e));void this.loadCandidates(epoch);}
  close(){clearTimeout(this.timer);clearTimeout(this.executorTimer);clearTimeout(this.candidateTimer);this.candidateSeq++;
    // 关闭或切文章时结束所有进行中的交互，否则重开后重绘闸门会一直拦着。
    this.drawing=undefined;this.drawingKey='';this.adjusting=undefined;this.pointer=null;this.storageWatch?.abort();this.storageWatch=undefined;this.dragging='';this.filePicking=false;this.renderPending=false;const wasOpen=!!this.openTopic;this.openTopic='';this.epoch++;this.confirmOpen=false;this.confirmBatch=0;this.working.clear();this.progress?.dispose();this.progressNode=undefined;this.disposeLoaders();this.fileInput?.remove();this.fileInput=undefined;if(!wasOpen)return;this.host.root.classList.remove('studio-workbench-open');this.host.root.querySelector('.image-workbench-host')?.remove();}
  // 读取失败：已有方案时保留画面并按 1.5s→10s 指数退避自动重读，同时给出「重新读取」入口。
  private retryDelay=0;
  private fail(epoch:number,e:unknown){if(!this.owns(epoch))return;this.loading=false;if(!this.vm){this.error=workbenchErrorCopy(e);this.render();return;}
    this.error='最新状态暂时读不到（'+workbenchErrorCopy(e)+'），正在自动重试';this.render();clearTimeout(this.timer);this.retryDelay=Math.min(10000,this.retryDelay?this.retryDelay*2:1500);this.timer=setTimeout(()=>{if(this.owns(epoch))void this.load(false).catch(err=>this.fail(epoch,err));},this.retryDelay);}
  mount(){if(!this.openTopic||!this.host.active())return;const page=this.host.root.querySelector('#content .page');if(!page)return;this.host.root.classList.add('studio-workbench-open');let node=page.querySelector<HTMLElement>(':scope > .image-workbench-host');if(!node){node=this.host.root.ownerDocument.createElement('div');node.className='image-workbench-host';page.prepend(node);}this.render();}
  reload(){if(!this.openTopic)return Promise.resolve();const epoch=this.epoch;return this.load(false).catch(e=>this.fail(epoch,e));}
  private async load(first:boolean){
    const epoch=this.epoch,c=this.host.context(),value=await this.port.load(this.openTopic,c,first);if(!this.owns(epoch))return;
    if(value.plan.topic_id!==this.openTopic)throw new Error('配图方案不属于当前文章');
    this.apply(value.plan,value.studio);this.settleNew();if(first){this.executors=value.executors;this.executor=preferredExecutor(value.executors,value.default_executor);if(this.executors.some(unchecked))void this.recheckExecutors(epoch,0);}
    this.loading=false;this.error='';this.retryDelay=0;this.render();this.schedule();
    // 确认过配图时读一次排版进度（排版确认后点「返回配图」会重新打开工作台，这里就能读到最新）；读不到不影响配图。
    if(first&&value.plan.final?.confirmed)void this.loadLayout(epoch);
    // 进入工作台时没有方案、也没有规划记录：自动规划一次（已有方案或失败记录时不自动重来）。
    if(value.plan.state==='empty'&&!value.plan.run&&!this.autoTried.has(this.openTopic)){this.autoTried.add(this.openTopic);await this.startRun(false,epoch,true);}
  }
  /** 读排版进度并返回这一次读到的结果（读不到为 undefined）。每次读取带递增序号，只有最新一次能写进步骤条用的状态：较早发出、较晚返回的读取不会覆盖较新的结果。 */
  private async loadLayout(epoch:number):Promise<WorkbenchLayoutStatus|undefined>{if(!this.port.layout)return undefined;const seq=++this.layoutSeq;let value:WorkbenchLayoutStatus;try{value=await this.port.layout(this.openTopic,this.host.context());}catch{return undefined;}if(!this.owns(epoch))return undefined;if(seq===this.layoutSeq){this.layoutState=value;this.render();}return value;}
  /** 排版已确认：修改或重新确认配图前要告诉本人，排版需要同步新配图并重新确认。 */
  private layoutConfirmed(){return !!this.layoutState?.confirmed&&!!this.plan?.final?.confirmed;}
  private apply(plan:ImagePlanSnapshot,studio:StudioSnapshot){this.plan=plan;this.studio=studio;if(!this.providerPicked)this.provider=defaultStudioProvider(studio.capabilities,studio.default_provider)??studio.default_provider??this.provider;this.host.setStudio(studio);this.vm=projectWorkbench(plan,studio,this.quota);if(this.vm.state==='ready'){const live=this.vm.items;const pruned=[...this.marks.keys()].filter(key=>!live.some(i=>key.startsWith(i.id+'|')));for(const key of pruned)this.marks.delete(key);if(pruned.length)this.saveMarks(pruned);}if(!this.vm.items.some(i=>i.id===this.focus))this.focus=this.vm.items.find(i=>i.status!=='skipped')?.id??this.vm.items[0]?.id??'';for(const [item,version] of this.preview)if(this.vm.items.find(i=>i.id===item)?.current?.id===version)this.preview.delete(item);}
  // 规划中、生成中、找图中时轮询；间隔逐步拉长，状态变化后重置。
  private schedule(){clearTimeout(this.timer);const vm=this.vm;if(!this.openTopic||!vm)return;const busy=vm.state==='planning'||vm.items.some(i=>['generating','searching'].includes(i.status));if(!busy){this.delay=1500;return;}const epoch=this.epoch;this.timer=setTimeout(()=>{if(!this.owns(epoch))return;const before=JSON.stringify(this.vm?.items.map(i=>[i.status,i.currentIndex]))+this.vm?.state;void this.load(false).then(()=>{const after=JSON.stringify(this.vm?.items.map(i=>[i.status,i.currentIndex]))+this.vm?.state;this.delay=before===after?Math.min(6000,Math.round(this.delay*1.4)):1500;if(before!==after&&this.vm?.items.some(i=>i.status==='filled'))void this.host.assetsChanged?.();}).catch(e=>this.fail(epoch,e));},this.delay);}
  // 网络候选：先显示已缓存的图；资讯原文还在后台读取时按 1s→5s 退避轮询，读到的新图自动并入；失败或读取过慢时给「重新读取」。
  private async loadCandidates(epoch:number,refresh=false,poll=false){clearTimeout(this.candidateTimer);const seq=++this.candidateSeq;if(!poll){this.candidateDelay=WEB_CAPTURE_POLL.first_ms;this.candidatePolls=0;}
    try{const list=await this.port.candidates(this.openTopic,this.host.context(),refresh?{refresh:true}:undefined);if(!this.owns(epoch)||seq!==this.candidateSeq)return;const before=this.candidatesSignature();this.candidates=list.items;this.candidatesError='';this.candidateCapture=list.capture;
      if(list.capture.refreshing){if(this.candidatePolls>=WEB_CAPTURE_POLL.max_polls)this.candidateCapture=WEB_CAPTURE_SLOW;else{const delay=this.candidateDelay;this.candidateDelay=webCaptureNextDelay(delay);this.candidatePolls++;this.candidateTimer=setTimeout(()=>{if(this.owns(epoch)&&seq===this.candidateSeq)void this.loadCandidates(epoch,false,true);},delay);}}
      // 轮询没有带来新图、状态也没变时不重绘，避免打断正在输入的内容。
      if(poll&&before===this.candidatesSignature())return;}
    catch{if(!this.owns(epoch)||seq!==this.candidateSeq)return;if(!this.candidates)this.candidates=[];this.candidatesError='网络候选暂时读不到';this.candidateCapture=undefined;}
    this.render();}
  private candidatesSignature(){return JSON.stringify([this.candidates?.map(c=>c.id+(c.selectable?'':'!')),this.candidateCapture?.note??'',this.candidatesError]);}
  // 来源分页顶部的补图状态行：正在补充时是轻量提示；读不到或用旧图时说明原因并给「重新读取」。
  private captureLine(){if(this.candidatesError)return '<p class="iwb-capture is-warn" role="alert"><span class="iwb-capture-text">'+esc(this.candidatesError)+'</span>'+btn('重新读取','studio-wb-candidates-retry')+'</p>';const v=this.candidateCapture;if(!v||v.tone==='none')return '';
    return '<p class="iwb-capture'+(v.tone==='warn'?' is-warn':'')+'" role="status" aria-live="polite">'+(v.refreshing?'<span class="iwb-capture-dot" aria-hidden="true"></span>':'')+'<span class="iwb-capture-text">'+esc(v.note)+'</span>'+(v.retry?btn('重新读取','studio-wb-candidates-retry'):'')+'</p>';}
  private item(id=this.focus){return this.vm?.items.find(i=>i.id===id);}
  private capability(provider=this.provider){return this.studio?.capabilities.find(c=>c.provider===provider);}
  // 生图渠道下拉（右栏与确认框共用）：文案与 disabled 来自共用判定；两个渠道都用不了时整体禁用，并说明原因、给去设置的入口。
  private noProvider(){return !(this.studio?.capabilities??[]).some(studioProviderReady);}
  private providerSelect(id:string,selected:string){const none=this.noProvider();return '<label class="configuration-field" for="'+id+'"><span>生成渠道</span><select class="field" id="'+id+'"'+(none?' disabled aria-describedby="'+id+'-why"':'')+'>'+(this.studio?.capabilities??[]).map(x=>{const o=studioProviderOption(x);return '<option value="'+esc(x.provider)+'"'+(x.provider===selected?' selected':'')+(o.disabled?' disabled':'')+'>'+esc(o.text)+'</option>';}).join('')+'</select></label>'+(none?this.noProviderNote(id+'-why'):'');}
  private noProviderNote(id:string){const why=(this.studio?.capabilities??[]).map(x=>{const a=x.availability,name=STUDIO_PROVIDER_NAMES[x.provider]??x.label;return name+(a?.block==='budget'||(a?.selectable&&a.remaining===0)?'次数已用完':a&&!a.selectable?a.message:'暂不可用');}).join('；');
    return '<p class="iwb-provider-none" id="'+id+'" role="status">两个生图渠道暂时都用不了：'+esc(why||'还没有可用的生图渠道')+'。<button type="button" class="iwb-link" data-action="nav" data-page="settings">去设置放开次数或检查渠道</button></p>';}
  // 进入工作台时执行器若还是「待检查」（服务端后台探测未完成），每 2 秒重读一次设置，最多 5 次；读到真实状态即停。
  private executorTimer?:ReturnType<typeof setTimeout>;
  private async recheckExecutors(epoch:number,tries:number){
    if(!this.port.executors||tries>=5)return;clearTimeout(this.executorTimer);
    this.executorTimer=setTimeout(()=>{if(!this.owns(epoch))return;void this.port.executors!(this.host.context()).then(value=>{if(!this.owns(epoch))return;const picked=this.executors.find(c=>c.id===this.executor);this.executors=value.executors;if(!picked||picked.blocked||unchecked(picked))this.executor=preferredExecutor(value.executors,value.default_executor);this.render();if(value.executors.some(unchecked))void this.recheckExecutors(epoch,tries+1);}).catch(()=>{if(this.owns(epoch))void this.recheckExecutors(epoch,tries+1);});},2000);
  }
  private async startRun(replan:boolean,epoch=this.epoch,auto=false){
    if(!this.plan)return;const c=this.host.context();this.working.add('run');this.render();
    try{const snapshot=await this.port.run({topic_id:this.openTopic,expected_version:this.plan.version,replan,...(auto?{}:{executor:this.executor})},crypto.randomUUID(),c);if(!this.owns(epoch))return;this.plan=snapshot;await this.load(false);}
    catch(e){if(!this.owns(epoch))return;
      // 版本冲突多半是另一处（另一个标签页）刚开始规划：同步现状，不当作失败。
      if(isVersionConflict(e)){await this.load(false).catch(()=>undefined);if(!this.owns(epoch))return;if(this.vm?.state==='planning'||this.vm?.items.length){this.error='';this.host.toast(this.vm?.state==='planning'?'另一处已开始规划，正在同步':'方案刚在另一处更新，已同步');return;}}
      this.host.toast(auto?'自动规划没能开始：'+workbenchErrorCopy(e):workbenchErrorCopy(e));this.error=auto?'自动规划没能开始：'+workbenchErrorCopy(e):'';}
    finally{if(this.owns(epoch)){this.working.delete('run');this.render();}}
  }
  private async update(item:string,patch:Omit<ImagePlanItemUpdate,'topic_id'|'expected_version'>,label=''){
    if(!this.plan)return;const epoch=this.epoch,c=this.host.context();this.working.add('item:'+item);this.render();
    try{await this.port.update(item,{topic_id:this.openTopic,expected_version:this.plan.version,...patch},crypto.randomUUID(),c);if(!this.owns(epoch))return;await this.load(false);if(label)this.host.toast(label);}
    catch(e){if(!this.owns(epoch))return;if(isVersionConflict(e))await this.load(false);this.host.toast(workbenchErrorCopy(e));}
    finally{if(this.owns(epoch)){this.working.delete('item:'+item);this.render();}}
  }
  // 单张入队走现有生成接口与预算闸门；槽位版本冲突时取最新版本重试一次。
  // guard：每次 await 之后、真正提交之前复核（面板关闭、切主题、确认框关掉即停，不再入队）。
  private async submit(item:PlanItemVM,operation:'generate'|'reference_edit',description:string,provider=this.provider,guard:()=>boolean=()=>true,extra:{size?:{width:number;height:number};marks?:StudioMark[];candidate_only?:boolean}={}):Promise<'queued'|'quota'|'failed'|'stopped'>{
    const epoch=this.epoch,c=this.host.context(),build=()=>{const cap=this.capability(provider),size=extra.size?{id:studioAspect(extra.size.width,extra.size.height),label:'',...extra.size}:sizeForAspect(cap,item.aspect);if(!cap||studioProviderOption(cap).disabled||!size)throw Object.assign(new Error('所选渠道暂不可用或额度已用完，请换一个渠道'),{quota:true});return {...planGenerationSubmit({studio:this.studio!,item:operation==='reference_edit'?{...item,current:this.shown(item)}:item,provider,description,size,operation}),...(extra.marks?.length?{marks:extra.marks}:{}),...(extra.candidate_only?{candidate_only:true}:{}),...(this.modelFor(provider)?{model:this.modelFor(provider)}:{})};};
    const live=()=>this.owns(epoch)&&guard(),known=new Set((this.item(item.id)??item).versions.map(v=>v.id)),viewing=this.preview.get(item.id);
    try{let input=build();if(!live())return 'stopped';try{await this.host.submit(input,crypto.randomUUID(),c);}catch(e){if(!isVersionConflict(e))throw e;await this.load(false);if(!live())return 'stopped';input=build();await this.host.submit(input,crypto.randomUUID(),c);}this.expecting.set(item.id,{known,viewing});return 'queued';}
    catch(e){if((e as {quota?:boolean}).quota||(e as {response?:{error?:{code?:string}}})?.response?.error?.code==='QUOTA_EXHAUSTED')return 'quota';this.host.toast(workbenchErrorCopy(e));return 'failed';}
  }
  private shown(item:PlanItemVM){const id=this.preview.get(item.id);return (id?item.versions.find(v=>v.id===id):undefined)??item.current;}
  private batchEligible(i:PlanItemVM){return i.status!=='skipped'&&!i.blocked&&i.status!=='generating'&&i.canGenerate;}
  private batchItems():PlanItemVM[]{const vm=this.vm;if(!vm)return [];return this.pickTouched?vm.items.filter(i=>this.picked.has(i.id)&&this.batchEligible(i)):vm.pendingGenerate;}
  // 生图模型：来自适配器能力；只有一个模型时只显示名字、不可改（目前 AGY 与 Codex 都是固定模型）。
  // 生图模型：来自适配器能力；只有一个模型时只显示名字、不可改（目前 AGY 与 Codex 都是固定模型）。多个模型时下拉的选中值随生成请求提交。
  private models:Record<string,string>={};
  private modelFor(provider:'codex'|'agy'){const models=this.capability(provider)?.models??[];if(models.length<2)return undefined;return models.find(m=>m.id===this.models[provider])?.id??models[0]!.id;}
  private modelField(provider:'codex'|'agy',id:string){const models=this.capability(provider)?.models??[];if(!models.length)return '';const picked=this.modelFor(provider);return '<div class="configuration-field iwb-model"><span>生图模型</span>'+(models.length===1?'<p class="iwb-model-fixed" id="'+id+'">'+esc(models[0]!.label)+'<small>本渠道只有这一个模型</small></p>':'<select class="field" id="'+id+'" data-provider="'+provider+'">'+models.map(m=>'<option value="'+esc(m.id)+'"'+(m.id===picked?' selected':'')+'>'+esc(m.label)+'</option>').join('')+'</select>')+'</div>';}
  // 标注绑定到「这张图 + 舞台上正看的那一版」：切换版本时各版本的标注各自保留，提交修改时只带当前原图上的标注。
  private markKey(id=this.focus){const it=this.item(id),v=it?this.shown(it):null;return id+'|'+(v?.id??'');}
  private markList(id=this.focus){return this.marks.get(this.markKey(id))??[];}
  private dropMarks(id:string){const keys=[...new Set([...this.marks.keys(),...this.markBase.keys()])].filter(key=>key.startsWith(id+'|'));for(const key of keys)this.marks.delete(key);for(const key of [...this.markHistory.keys()])if(key.startsWith(id+'|'))this.markHistory.delete(key);this.saveMarks(keys);}
  // 标注草稿存本机（按工作区 + 文章区分，键是「图 + 版本」）：刷新或重开工作台后还在；生成修改版入队、删除这张图后清掉。
  private store():Storage|undefined{try{return this.host.storage?this.host.storage():this.host.root.ownerDocument?.defaultView?.localStorage??undefined;}catch{return undefined;}}
  private marksStoreKey(){return 'image-studio-marks:v1:'+(this.host.context().identity?.workspace_id??'')+':'+this.openTopic;}
  private parseStore(raw:string|null):Record<string,unknown>{if(!raw||raw.length>MARK_STORE_LIMIT)return {};try{const value=JSON.parse(raw) as unknown;return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}catch{return {};}}
  private cleanList(list:unknown):StudioMark[]{return Array.isArray(list)?list.map(sanitizeMark).filter((m):m is StudioMark=>!!m).slice(0,30):[];}
  /** 只写本页改过的键：写之前重读本机草稿，其他键（含另一个标签页刚写的）原样保留；同一个键被另一处改过时提示，不静默覆盖。 */
  private saveMarks(keys:Iterable<string>){const s=this.store();if(!s||!this.openTopic)return;try{const storeKey=this.marksStoreKey(),stored=this.parseStore(s.getItem(storeKey));let conflict=false;
    for(const k of keys){const remote=stored[k]===undefined?'':JSON.stringify(stored[k]),base=this.markBase.get(k)??'',local=this.marks.get(k);if(remote!==base)conflict=true;if(local?.length)stored[k]=local;else delete stored[k];this.markBase.set(k,local?.length?JSON.stringify(local):'');}
    if(!Object.keys(stored).length)s.removeItem(storeKey);else{const raw=JSON.stringify(stored);if(raw.length<=MARK_STORE_LIMIT)s.setItem(storeKey,raw);else this.host.toast('标注草稿太大，本机没能保存，刷新后这次的改动会丢失');}
    if(conflict)this.host.toast('另一个标签页也改过这张图的标注，已保存本页的修改');}catch{/* 本机不允许保存时，标注只留在当前页面 */}}
  private restoreMarks(){this.marks.clear();this.markBase.clear();const s=this.store();if(!s||!this.openTopic)return;let stored:Record<string,unknown>={};try{stored=this.parseStore(s.getItem(this.marksStoreKey()));}catch{return;}for(const [k,list] of Object.entries(stored)){if(!/^[^|]+\|[^|]*$/.test(k))continue;this.markBase.set(k,JSON.stringify(list));const ms=this.cleanList(list);if(ms.length)this.marks.set(k,ms);}}
  // 另一个标签页改了同一篇的标注：本页没有未保存改动的键直接同步过来；两边都改了的键保留本页并提示。
  private watchStorage(){this.storageWatch?.abort();const win=this.host.root.ownerDocument?.defaultView;if(!win?.addEventListener)return;this.storageWatch=new AbortController();win.addEventListener('storage',e=>{if(e.key===this.marksStoreKey())this.syncMarksFromStore(e.newValue);},{signal:this.storageWatch.signal});win.addEventListener('focusout',()=>queueMicrotask(()=>this.flushSync()),{signal:this.storageWatch.signal,capture:true});}
  // 拖动、画图或正在输入标注说明时先不套用另一个标签页的改动，操作结束（松手 / 离开输入框）后再按最新草稿合并；同一处两边都改了会提示。
  private syncDeferred=false;
  private typingNote(){const a=this.host.root.ownerDocument?.activeElement as HTMLElement|null|undefined;return !!a?.id&&a.id.startsWith('studio-wb-mark-')&&!a.id.startsWith('studio-wb-mark-pick-');}
  flushSync(){if(!this.syncDeferred||this.adjusting||this.drawing||this.typingNote())return;this.syncDeferred=false;const s=this.store();if(s)try{this.syncMarksFromStore(s.getItem(this.marksStoreKey()));}catch{/* 读不到就等下一次 */}}
  syncMarksFromStore(raw:string|null){if(!this.openTopic)return;if(this.adjusting||this.drawing||this.typingNote()){this.syncDeferred=true;return;}const stored=this.parseStore(raw);let changed=false,conflict=false;
    for(const k of new Set([...Object.keys(stored),...this.markBase.keys()])){if(!/^[^|]+\|[^|]*$/.test(k))continue;const remote=stored[k]===undefined?'':JSON.stringify(stored[k]),base=this.markBase.get(k)??'';if(remote===base)continue;const local=this.marks.get(k),localJson=local?.length?JSON.stringify(local):'';
      if(localJson!==base&&localJson!==remote){conflict=true;continue;}const ms=this.cleanList(stored[k]);if(ms.length)this.marks.set(k,ms);else this.marks.delete(k);this.markBase.set(k,remote);this.markHistory.delete(k);if(this.noteEditing.startsWith(k+'#'))this.noteEditing='';if(this.selectedKey===k&&!ms.some(m=>m.id===this.selectedMark))this.selectedMark=0;changed=true;}
    if(changed){this.render();this.host.toast('另一个标签页改了标注，这里已同步');}else if(conflict)this.host.toast('另一个标签页也改了这张图的标注，这里保留本页的修改');}
  /** 改一处标注清单：先把改动前的清单压进撤销栈，再保存草稿；选中的那处被删掉时取消选中。 */
  private pushHistory(key:string){const h=this.markHistory.get(key)??[];h.push(structuredClone(this.marks.get(key)??[]));if(h.length>50)h.shift();this.markHistory.set(key,h);}
  private setMarks(key:string,next:StudioMark[]){this.pushHistory(key);this.noteEditing='';if(next.length)this.marks.set(key,next);else this.marks.delete(key);if(this.selectedKey===key&&!next.some(m=>m.id===this.selectedMark))this.selectedMark=0;this.saveMarks([key]);}
  private selected(){const key=this.markKey();return this.selectedMark&&this.selectedKey===key?this.markList().find(m=>m.id===this.selectedMark):undefined;}
  private deleteSelectedMark(){const m=this.selected();if(!m)return false;this.setMarks(this.markKey(),this.markList().filter(x=>x.id!==m.id));this.selectedMark=0;this.render();this.host.toast('已删除标注 '+m.id+'，点「撤销」可以恢复');return true;}
  /** Delete / Backspace 删除舞台上选中的标注；焦点在输入框、文本域、下拉或弹窗里时不拦截。 */
  handleKey(event:KeyboardEvent):boolean{
    if(!this.openTopic||(event.key!=='Delete'&&event.key!=='Backspace')||event.metaKey||event.ctrlKey||event.altKey||event.isComposing)return false;
    const t=event.target as HTMLElement|null;if(t&&typeof t.closest==='function'&&t.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return false;
    if(this.host.root.ownerDocument?.querySelector?.('dialog[open]'))return false;
    if(this.adjusting||this.drawing||!this.selected())return false;
    event.preventDefault();this.deleteSelectedMark();return true;
  }
  private viewHeight(v:StudioVersion|null){return v&&v.actual.width>0?Math.round(1000*v.actual.height/v.actual.width*10)/10:1000;}
  handleInput(input:HTMLInputElement):boolean{
    if(!input.id?.startsWith('studio-wb-'))return false;
    if(input.id==='studio-wb-request')this.requests.set(this.focus,input.value);
    if(input.id==='studio-wb-prompt')this.prompts.set(this.focus,input.value);
    if(input.id.startsWith('studio-wb-mark-')){const id=Number(input.id.slice('studio-wb-mark-'.length)),mark=this.markList().find(m=>m.id===id);if(mark){const key=this.markKey();if(this.noteEditing!==key+'#'+id){this.pushHistory(key);this.noteEditing=key+'#'+id;}if(mark.type==='text')mark.text=input.value.slice(0,200);else mark.note=input.value.slice(0,300);this.saveMarks([key]);}}
    if(input.id==='studio-wb-insert-caption'&&this.insertDraft)this.insertDraft.caption=input.value.slice(0,120);
    if((input.id==='studio-wb-resize-w'||input.id==='studio-wb-resize-h')&&this.resizeDraft){const n=Number(input.value);if(input.id.endsWith('-w'))this.resizeDraft.width=n;else this.resizeDraft.height=n;this.resizeStatus();}
    return true;
  }
  handleChange(input:HTMLInputElement):boolean{
    if(!input.id?.startsWith('studio-wb-'))return false;
    const item=this.item();
    if(input.id==='studio-wb-insert-place'&&this.insertDraft){this.insertDraft.value=input.value;const note=this.host.root.ownerDocument?.querySelector?.('#studio-wb-insert-excerpt');if(note)note.textContent=this.insertExcerpt(input.value);return true;}
    if(input.id.startsWith('studio-wb-insert-src-')&&this.insertDraft){if(input.checked)this.insertDraft.source=input.value as InsertSource;return true;}
    if(input.id.startsWith('studio-wb-executor-')){if(input.checked){this.executor=input.value as ContentExecutor;this.render();}return true;}
    if(input.id==='studio-wb-provider'){this.provider=input.value as 'codex'|'agy';this.providerPicked=true;this.render();return true;}
    if(input.id==='studio-wb-all-provider'){this.allProvider=input.value as 'codex'|'agy';this.allPicked=true;this.presentGenerateAll();return true;}
    if(input.id==='studio-wb-aspect'&&item){void this.update(item.id,{aspect:input.value as PlanItemVM['aspect']});return true;}
    if(input.id==='studio-wb-prompt'&&item){const value=input.value.trim();if(value&&value!==item.prompt)void this.update(item.id,{prompt_draft:value.slice(0,2000)});return true;}
    if(input.id.startsWith('studio-wb-caption-')){const id=input.id.slice('studio-wb-caption-'.length),target=this.item(id),value=input.value.trim();if(target&&value&&value!==target.caption)void this.update(id,{purpose:value.slice(0,120)},'图注已保存');else if(target&&!value){input.value=target.caption;this.host.toast('图注不能为空');}return true;}
    if(input.id.startsWith('studio-wb-strategy-')){const id=input.id.slice('studio-wb-strategy-'.length);void this.update(id,{source_strategy:input.value as PlanItemVM['strategy']},'来源已改');return true;}
    if(input.id.startsWith('studio-wb-place-')){const id=input.id.slice('studio-wb-place-'.length),placement=parsePosition(input.value);if(placement)void this.update(id,{placement},'位置已改，画布已按新位置排入');return true;}
    if(input.id.startsWith('studio-wb-pick-')){const id=input.id.slice('studio-wb-pick-'.length);if(!this.pickTouched){this.picked=new Set(this.vm?.pendingGenerate.map(i=>i.id));this.pickTouched=true;}if(input.checked)this.picked.add(id);else this.picked.delete(id);this.render();return true;}
    if(input.id==='studio-wb-gen-provider'){const p=this.genPending,value=input.value as 'codex'|'agy';if(p&&p.op==='generate'&&(value==='codex'||value==='agy')){p.provider=value;this.provider=value;this.providerPicked=true;this.render();this.presentGenerate(true);}return true;}
    if(input.id==='studio-wb-model'||input.id==='studio-wb-all-model'||input.id==='studio-wb-gen-model'){const provider=input.dataset.provider as 'codex'|'agy'|undefined;if(provider)this.models[provider]=input.value;if(input.id==='studio-wb-gen-model'&&this.genPending){this.render();this.presentGenerate(true);}else if(input.id==='studio-wb-model'&&this.genPending)this.presentGenerate(true);return true;}
    if(input.id==='studio-wb-upload-purpose'){this.uploadPurpose=input.value as StudioUploadPurpose;return true;}
    if(input.id==='studio-wb-resize-ratio'&&this.resizeDraft){const r=RESIZE_RATIOS.find(x=>x[0]===input.value);if(r){this.resizeDraft.width=r[1];this.resizeDraft.height=r[2];}this.presentResize();return true;}
    return true;
  }
  async handle(action:string,el:HTMLElement):Promise<void>{
    const epoch=this.epoch,c=this.host.context(),id=el.dataset.item??this.focus,item=this.item(id);
    if(action==='studio-wb-open'){const topic=c.ui.topic;if(topic)this.open(topic);return;}
    if(action==='studio-wb-close'){this.close();return;}
    if(action==='studio-wb-abandon-pending'){this.host.abandonPending?.();this.render();return;}
    if(action==='studio-wb-retry'){this.error='';this.loading=true;this.render();await this.load(true).catch(e=>this.fail(epoch,e));return;}
    if(action==='studio-wb-reload'){clearTimeout(this.timer);await this.reload();return;}
    if(action==='studio-wb-candidates-retry'){this.candidatesError='';this.candidateCapture={refreshing:true,note:'正在重新读取资讯原文…',retry:false,tone:'info'};this.render();await this.loadCandidates(epoch,true);return;}
    if(action==='studio-wb-replan'){await this.startRun(true);return;}
    if(action==='studio-wb-focus'){if(item)this.fresh.delete(item.id);if(item&&item.id!==this.focus){this.focus=item.id;this.tool='select';this.selectedMark=0;this.render();}return;}
    if(action==='studio-wb-skip'&&item){await this.update(item.id,{skipped:true},'已跳过这张，不排进文章');return;}
    if(action==='studio-wb-restore'&&item){await this.update(item.id,{skipped:false},'已恢复这张');return;}
    if(action==='studio-wb-move'&&item){const dir=el.dataset.dir==='up'?'up':'down';await this.update(item.id,{move:dir});if(this.owns(epoch))this.revealFocused('[data-action="studio-wb-move"][data-dir="'+dir+'"]');return;}
    if(action==='studio-wb-find'&&item){this.focus=item.id;this.tool='select';this.tab='sources';this.render();this.host.root.querySelector<HTMLElement>('.iwb-edit')?.scrollIntoView?.({block:'nearest'});this.host.root.querySelector<HTMLElement>('.iwb-tab[data-tab="sources"]')?.focus({preventScroll:true});return;}
    if(action==='studio-wb-remove'&&item){this.removeTarget=item.id;this.presentRemove(item);return;}
    if(action==='studio-wb-remove-confirm'){const target=this.item(this.removeTarget);if(!target)return;c.surface.closeDialog('completed');this.removeTarget='';this.dropMarks(target.id);await this.update(target.id,{removed:true},target.versions.some(v=>v.asset_id)?'已删除这张图，已生成的版本保留在素材库':'已删除这张图');if(this.owns(epoch))this.revealFocused();return;}
    if(action==='studio-wb-upload'&&item){this.pickFile(item.id);return;}
    if(action==='studio-wb-add-item'){await this.addItem(item);return;}
    if(action==='studio-wb-clear'&&item){this.preview.delete(item.id);await this.update(item.id,{current_version_id:null},'已清除当前图，版本仍保留');return;}
    if(action==='studio-wb-version'&&item){const version=el.dataset.version??'';if(version===item.current?.id)this.preview.delete(item.id);else this.preview.set(item.id,version);this.selectedMark=0;this.render();return;}
    if(action==='studio-wb-adopt'&&item){const version=this.preview.get(item.id);if(!version)return;await this.update(item.id,{current_version_id:version},'已采用这一版，其他版本保留');this.preview.delete(item.id);this.render();return;}
    if(action==='studio-wb-chip'){const chip=PLAN_CHIPS[el.dataset.chip??''];if(!chip||!item)return;const next=appendChip(this.requests.get(item.id)??'',chip);this.requests.set(item.id,next);const field=this.host.root.querySelector<HTMLTextAreaElement>('#studio-wb-request');if(field)field.value=next;return;}
    if(action==='studio-wb-tab'){const tab=el.dataset.tab;if(tab==='modify'||tab==='sources'||tab==='refs'){this.tab=tab;this.render();}return;}
    if(action==='studio-wb-tool'){const tool=el.dataset.tool as Tool;if(TOOLS.some(t=>t[0]===tool)){this.tool=tool;this.render();}return;}
    // 撤销：退回上一步标注操作（添加、移动、缩放、删除、清除）；刷新后没有撤销记录时，撤掉最后一处。
    if(action==='studio-wb-undo'){const key=this.markKey(),h=this.markHistory.get(key);if(h?.length){const prev=h.pop()!;if(prev.length)this.marks.set(key,prev);else this.marks.delete(key);}else{const list=this.markList();if(!list.length){this.host.toast('还没有可撤销的标注');return;}list.pop();if(!list.length)this.marks.delete(key);}if(!this.markList().some(m=>m.id===this.selectedMark))this.selectedMark=0;this.noteEditing='';this.saveMarks([key]);this.render();return;}
    if(action==='studio-wb-clear-marks'){if(!this.markList().length)return;this.setMarks(this.markKey(),[]);this.render();this.host.toast('已清除本轮标注，点「撤销」可以恢复；图片本身没有改动');return;}
    if(action==='studio-wb-mark-remove'){const mark=Number(el.dataset.mark);if(!this.markList().some(m=>m.id===mark))return;this.setMarks(this.markKey(),this.markList().filter(m=>m.id!==mark));this.render();this.host.toast('已删除标注 '+mark+'，点「撤销」可以恢复');return;}
    if(action==='studio-wb-mark-select'){const mark=Number(el.dataset.mark);if(this.markList().some(m=>m.id===mark)){this.selectedKey=this.markKey();this.selectedMark=mark;this.render();}return;}
    if(action==='studio-wb-mark-delete'){this.deleteSelectedMark();return;}
    // 新加图片位：卡片「在后面插入」默认插在这张图之后；完整文章预览里可在任意段落后插入；底部入口默认插在文末。
    if(action==='studio-wb-insert'){if(!this.plan||!this.studio||this.vm?.state==='planning')return;const paragraphs=this.studio.paragraphs;if(!paragraphs.length){this.host.toast('文章还没有正文段落');return;}const place=el.dataset.place;
      const value=place&&place!=='end'?place:place==='end'||!item?'after:'+paragraphs.at(-1)!.id:item.position==='cover'?'before:'+paragraphs[0]!.id:item.position+':'+item.placement_paragraph_id;
      this.insertDraft={value,source:'ai_generate',caption:''};this.presentInsert();return;}
    if(action==='studio-wb-insert-confirm'){const d=this.insertDraft,placement=d?parsePosition(d.value):null;if(!d||!placement){this.host.toast('先选插入位置');return;}this.insertDraft=undefined;c.surface.closeDialog('completed');await this.insertItem(placement,d.source,d.caption.trim());return;}
    if(action==='studio-wb-compare'&&item){this.presentCompare(item);return;}
    if(action==='studio-wb-restore-version'&&item){const version=el.dataset.version??'';c.surface.closeDialog('completed');this.preview.delete(item.id);const n=item.versions.findIndex(v=>v.id===version)+1;await this.update(item.id,{current_version_id:version},'已回到 v'+n+'，其他版本仍保留');return;}
    if(action==='studio-wb-resize'&&item){const v=this.shown(item);if(!v)return;this.resizeDraft={item:item.id,width:v.actual.width,height:v.actual.height};this.presentResize();return;}
    // 调整画幅另存新版也是真实生图：尺寸选好后先进「确认生成」，确认后才提交。
    if(action==='studio-wb-resize-next'){this.genTrigger=el.getBoundingClientRect?.();const d=this.resizeDraft,target=d?this.item(d.item):undefined;if(!d||!target||!this.resizeValid())return;const label=studioRatioLabel(studioAspect(d.width,d.height));this.genPending={item:target.id,op:'resize',description:resizeDescription(d.width,d.height,label),provider:'agy',size:{width:d.width,height:d.height}};this.presentGenerate();return;}
    if(action==='studio-wb-resize-confirm'){if(this.genPending?.op!=='resize')return;await this.resize(epoch,c);return;}
    if(action==='studio-wb-recover'&&item){const found=this.studio?recoverableVersions(this.vm?.items??[],this.studio).find(x=>x.version.id===el.dataset.version):undefined;if(!found)return;await this.withItem(item,async()=>{await this.assetVersion(item,found.version.asset_id,{name:('找回：'+found.title).slice(0,120),recover_version_id:found.version.id});this.host.toast('已把这张图找回为新一版，可以采用或在上面修改');});return;}
    if(action==='studio-wb-add'){const target=item&&!item.current&&item.status!=='skipped'&&!item.versions.length?item:undefined,size=target?sizeForAspect(this.capability(),target.aspect):undefined;this.host.openAdd(target&&size?{slot_id:target.slot_id,paragraph_id:target.paragraph_id,placement:target.placement,title:target.caption,description:this.prompts.get(target.id)??target.prompt,width:size.width,height:size.height}:null);return;}
    if(action==='studio-wb-preview'){this.presentPreview();return;}
    // 排版已确认时先说明后果（重新确认配图后排版要同步新配图并重新确认），本人点「仍要确认」再继续。
    // 确认过配图（排版可能已开始）时，点击当下再读一次排版进度，不靠打开时的那次读取；读不到按「排版可能已确认」先提示，不静默放行。
    if(action==='studio-wb-confirm'){if(!this.canConfirm()||this.layoutChecking)return;
      if(this.plan?.final?.confirmed&&this.port.layout){this.layoutChecking=true;let status:WorkbenchLayoutStatus|undefined;try{status=await this.loadLayout(epoch);}finally{this.layoutChecking=false;}if(!this.owns(epoch)||!this.canConfirm())return;
        // 以这次点击实时读到的结果为准，不看共享的缓存状态。
        if(!status){this.presentRelock(undefined);return;}if(status.confirmed){this.presentRelock(status);return;}}
      await this.confirmAndLayout(epoch,c);return;}
    if(action==='studio-wb-confirm-anyway'){c.surface.closeDialog('completed');await this.confirmAndLayout(epoch,c);return;}
    if(action==='studio-wb-layout'){if(this.plan?.final?.confirmed&&this.host.openLayout)this.host.openLayout(this.openTopic);return;}
    if(action==='studio-wb-swap'&&item){const candidate=this.candidates?.find(x=>x.id===el.dataset.candidate);if(!candidate||!this.studio)return;this.working.add('item:'+item.id);this.render();
      try{const send=()=>this.host.webImport({topic_id:this.openTopic,expected_version:this.studio!.version,slot_id:item.slot_id,candidate:{candidate_id:candidate.id,image_url:candidate.image_url}},crypto.randomUUID(),c);try{await send();}catch(e){if(!isVersionConflict(e))throw e;await this.load(false);await send();}if(!this.owns(epoch))return;this.preview.delete(item.id);await this.load(false);this.host.toast('已换成这张网络图，旧版仍可回退');await this.host.assetsChanged?.();}
      catch(e){if(this.owns(epoch))this.host.toast(workbenchErrorCopy(e));}finally{if(this.owns(epoch)){this.working.delete('item:'+item.id);this.render();}}return;}
    // 单张生成：先核对画面说明，再弹「确认生成」；只有在弹窗里确认后才真正提交生图。
    if(action==='studio-wb-generate'&&item){
      const description=(this.prompts.get(item.id)??item.prompt).trim();if(!description){this.host.toast('先写这张图的画面说明');return;}
      if(this.working.has('item:'+item.id)||!item.canGenerate)return;
      this.genPending={item:item.id,op:'generate',description,provider:this.provider};this.genTrigger=el.getBoundingClientRect?.();this.presentGenerate();return;}
    if(action==='studio-wb-generate-confirm'){
      const pending=this.genPending;if(!pending||pending.op!=='generate')return;this.genPending=undefined;c.surface.closeDialog('completed');const target=this.item(pending.item);
      if(!target||!target.canGenerate||this.working.has('item:'+target.id)){this.host.toast('这张图的状态刚有变化，没有入队');return;}
      this.working.add('item:'+target.id);this.render();
      try{const result=await this.submit(target,'generate',pending.description,pending.provider);if(!this.owns(epoch))return;if(result==='quota'){this.quota.add(target.id);this.host.toast('额度不足，这张没有入队');}else if(result==='queued'){this.quota.delete(target.id);this.host.toast('已入队生成，完成后出现在舞台和版本条');}await this.load(false);}
      finally{if(this.owns(epoch)){this.working.delete('item:'+target.id);this.render();}}return;}
    if(action==='studio-wb-edit'&&item){
      // 修改只走支持在原图上修改的 AGY；标注翻成文字拼进说明，标注本身随版本记录保存，不进入成品。
      const shown=this.shown(item),marks=this.markList(item.id),markKey=this.markKey(item.id);let description:string;
      if(item.blocked){this.host.toast('这张图上次的任务还在核对，暂不能再修改');return;}
      try{description=composeEditDescription(this.requests.get(item.id)??'',marks,this.viewHeight(shown??null));}catch(e){this.host.toast(e instanceof Error?e.message:'先写修改要求');return;}
      if(this.working.has('item:'+item.id))return;
      this.genPending={item:item.id,op:'reference_edit',description,provider:'agy',marks:structuredClone(marks.filter(m=>m.type!=='text'||(m.text??'').trim())),markKey};this.genTrigger=el.getBoundingClientRect?.();this.presentGenerate();return;}
    if(action==='studio-wb-edit-confirm'){
      const pending=this.genPending;if(!pending||pending.op!=='reference_edit')return;this.genPending=undefined;c.surface.closeDialog('completed');const target=this.item(pending.item);
      if(!target||target.blocked||this.working.has('item:'+target.id)){this.host.toast('这张图的状态刚有变化，没有入队');return;}
      this.working.add('item:'+target.id);this.render();
      try{const result=await this.submit(target,'reference_edit',pending.description,'agy',()=>true,{marks:pending.marks??[]});if(!this.owns(epoch))return;if(result==='quota')this.host.toast('AGY 生图次数不足，这张没有入队');else if(result==='queued'){this.requests.delete(target.id);if(pending.markKey){this.marks.delete(pending.markKey);this.markHistory.delete(pending.markKey);if(this.selectedKey===pending.markKey)this.selectedMark=0;this.saveMarks([pending.markKey]);}this.tool='select';this.host.toast('修改版已入队，完成后出现在版本条，旧版保留');}await this.load(false);}
      finally{if(this.owns(epoch)){this.working.delete('item:'+target.id);this.render();}}return;}
    if(action==='studio-wb-generate-all'){this.genTrigger=el.getBoundingClientRect?.();if(!this.allPicked)this.allProvider=this.provider;this.confirmOpen=true;this.confirmBatch=++this.batchSeq;this.presentGenerateAll(true);return;}
    if(action==='studio-wb-generate-all-confirm'){await this.generateAll(epoch,c);return;}
  }
  dialogClosed(){this.genTrigger=undefined;this.guard.stop();this.confirmOpen=false;this.confirmBatch=0;this.resizeDraft=undefined;this.genPending=undefined;this.insertDraft=undefined;this.arm.reset();}
  // 上移/下移/删除后：保持左栏滚动位置（重绘时已恢复），并把仍选中的那张留在视口里，键盘焦点回到同一个按钮。
  private revealFocused(button=''){const card=this.host.root.querySelector<HTMLElement>('.iwb-card.is-focused');if(!card)return;card.scrollIntoView?.({block:'nearest'});const target=(button?card.querySelector<HTMLButtonElement>(button):null);(target&&!target.disabled?target:card.querySelector<HTMLElement>('.iwb-card-hit'))?.focus({preventScroll:true});}
  /** 单张生成 / 生成修改版的确认：写明图片、渠道、模型、张数和剩余次数；确认按钮在弹窗底部，与触发按钮不在同一位置。 */
  /** 生成 / 修改版 / 调整画幅（含批量）成功后：新版本设为这张图的当前图（走采用接口与方案版本号）。本人还在看这张、没另选版本时舞台切到新版本；
   *  已切到别的图或手动选了别的版本时不抢舞台，只在卡片上标「新版本已生成」。失败不切换；配图已确认后不自动换当前图。 */
  private settleNew(){const vm=this.vm;if(!vm)return;
    for(const [id,exp] of [...this.expecting]){const item=vm.items.find(i=>i.id===id);if(!item){this.expecting.delete(id);continue;}
      const added=item.versions.filter(v=>!exp.known.has(v.id));if(!added.length)continue;
      const ready=added.filter(v=>!!v.asset_id&&['succeeded','size_mismatch'].includes(v.state));if(!ready.length){if(!added.some(v=>!v.asset_id&&ACTIVE_VERSION.includes(v.state)))this.expecting.delete(id);continue;}
      this.expecting.delete(id);const next=ready.at(-1)!,n=item.versions.indexOf(next)+1,stay=this.focus===id&&this.preview.get(id)===exp.viewing;
      if(!stay)this.fresh.add(id);
      if(this.plan?.final?.confirmed){if(stay&&item.current?.id!==next.id)this.preview.set(id,next.id);this.host.toast('已生成第 '+n+' 版；配图已确认，当前图没有自动更换，需要时点「采用这一版」');continue;}
      if(stay)this.preview.delete(id);
      const label='已生成第 '+n+' 版，已设为当前图，可在修改版本里切回';if(item.current?.id===next.id)this.host.toast(label);else void this.update(id,{current_version_id:next.id},label);}
  }
  private presentGenerate(rerender=false){
    const p=this.genPending,item=p?this.item(p.item):undefined,plan=this.plan;if(!p||!item||!plan)return;
    const cap=this.capability(p.provider),models=cap?.models??[],model=models.find(m=>m.id===this.modelFor(p.provider))?.label??models[0]?.label??'渠道默认模型';
    const remaining=cap?.availability?.remaining??plan.budget[p.provider].remaining,shown=this.shown(item),n=shown?item.versions.indexOf(shown)+1:0;
    const lead=p.op==='resize'?'以 v'+n+' 为原图，按新画幅另存 <b>1</b> 张新版本，旧画幅的版本保留。':p.op==='reference_edit'?'以 v'+n+' 为原图生成 <b>1</b> 张修改版，旧版保留、可回退。':'为这张图生成 <b>1</b> 张新图。';
    const extra:Array<[string,string]>=[...(p.size?[['新尺寸',p.size.width+' × '+p.size.height+' px · '+studioRatioLabel(studioAspect(p.size.width,p.size.height))] as [string,string]]:[]),...(p.op==='reference_edit'&&p.marks?.length?[['画面标注',p.marks.length+' 处，写进修改说明'] as [string,string]]:[])];
    const action=p.op==='resize'?'studio-wb-resize-confirm':p.op==='reference_edit'?'studio-wb-edit-confirm':'studio-wb-generate-confirm';
    // 弹窗内可改：首次生成可换渠道（不可用的置灰并写原因）和模型；修改版/调整画幅只能用支持在原图上修改的 AGY，可换模型。选择与右栏共用。
    const choice=(p.op==='generate'?this.providerSelect('studio-wb-gen-provider',p.provider).replace('<span>生成渠道</span>','<span>换渠道</span>'):this.editProviderSelect('studio-wb-gen-provider').replace('<span>修改用的渠道</span>','<span>换渠道</span>'))+this.modelField(p.provider,'studio-wb-gen-model');
    this.host.context().surface.presentDialog(generateConfirmDialog({lead,image:item.roleLabel+' · '+item.caption,provider:STUDIO_PROVIDER_NAMES[p.provider]??cap?.label??p.provider,model,count:1,remaining,extra,choice},{action,attrs:'data-item="'+esc(item.id)+'"'},undefined,rerender?this.arm.attrs():this.arm.open()));if(!rerender)this.avoidTrigger();
  }
  // 防误触：确认按钮不能落在刚点的触发按钮原位置（所有生图确认入口共用 TriggerGuard，布局变化时复核）。
  private genTrigger?:{x:number;y:number;width:number;height:number};
  private readonly guard=new TriggerGuard(()=>this.host.root.ownerDocument);
  private avoidTrigger(){this.guard.watch(this.genTrigger);}

  /** 排版已确认后再确认配图：先说明后果。 */
  private presentRelock(status:WorkbenchLayoutStatus|undefined){
    const unknown=!status,synced=!!status?.synced&&!!this.plan?.final?.current;
    const body='<div class="iwb-confirm"><p>'+(unknown?'暂时<b>无法确认排版状态</b>，排版可能已经确认过。':'这篇的<b>排版已确认</b>。')+'</p><p>'+esc(unknown?'如果排版已确认：重新确认配图后，排版需要同步新配图，并重新确认排版。':synced?'配图在排版确认后没有改动：重新确认配图后，排版仍用同一组图。':'配图在排版确认后有改动：重新确认配图后，排版需要同步新配图，并重新确认排版。')+'</p><p class="iwb-confirm-budget">修改配图会让排版需要重新确认。</p></div>';
    this.host.context().surface.presentDialog({title:'公众号配图 · 重新确认配图',body,foot:btn('先不确认','close-dialog')+btn('仍要确认配图','studio-wb-confirm-anyway',true,this.arm.open())});
  }
  private async withItem(item:PlanItemVM,run:()=>Promise<void>){const epoch=this.epoch;this.working.add('item:'+item.id);this.render();try{await run();}catch(e){if(this.owns(epoch))this.host.toast(workbenchErrorCopy(e));}finally{if(this.owns(epoch)){this.working.delete('item:'+item.id);this.render();}}}
  // 已保存的图片（上传 / 找回）作为这张图的新一版；槽位版本冲突时取最新版本重试一次。
  private async assetVersion(item:PlanItemVM,asset:string,extra:{purpose?:StudioUploadPurpose;name?:string;recover_version_id?:string}){
    const c=this.host.context(),send=()=>this.port.assetVersion({topic_id:this.openTopic,expected_version:this.studio!.version,slot_id:item.slot_id,asset_id:asset,...extra},crypto.randomUUID(),c);
    try{await send();}catch(e){if(!isVersionConflict(e))throw e;await this.load(false);await send();}
    this.preview.delete(item.id);await this.load(false);await this.host.assetsChanged?.();
  }
  /** 还没配好的张数：以服务端的确认摘要为准（从未生成的项也算）。 */
  private pending(){const plan=this.plan,vm=this.vm;if(!plan||!vm)return 0;return plan.final?.pending??vm.items.filter(i=>i.status!=='skipped'&&i.status!=='filled').length;}
  private canConfirm(){const vm=this.vm;return !!vm&&!!this.host.openLayout&&!!this.port.confirm&&vm.state==='ready'&&!vm.stale&&vm.items.length>0&&this.pending()===0&&!this.working.has('confirm');}
  // 确认配图并进入排版：内容没变时服务端保留原终稿；版本冲突时重读一次再确认。
  private async confirmAndLayout(epoch:number,c:FeatureContext){
    if(!this.plan||!this.canConfirm()||!this.port.confirm)return;const topic=this.openTopic;this.confirmError='';this.working.add('confirm');this.render();
    try{const send=()=>this.port.confirm!({topic_id:topic,expected_version:this.plan!.version},crypto.randomUUID(),c);try{await send();}catch(e){if(!isVersionConflict(e))throw e;await this.load(false);if(!this.owns(epoch))return;
      // 重读后先去掉本次的忙标记再判断，否则自己的标记会挡住重试。
      this.working.delete('confirm');if(!this.canConfirm()){this.host.toast('配图刚有变化，请核对后再确认');return;}this.working.add('confirm');await send();}
      if(!this.owns(epoch))return;this.working.delete('confirm');this.host.openLayout?.(topic);}
    // 失败：头部留一条可见的说明和「重试」，不只靠一闪而过的提示。
    catch(e){if(this.owns(epoch)){this.confirmError='配图终稿没有冻结成功：'+workbenchErrorCopy(e);this.host.toast(workbenchErrorCopy(e));this.working.delete('confirm');await this.load(false).catch(()=>undefined);}}
    finally{if(this.owns(epoch)){this.working.delete('confirm');this.render();}}
  }
  // 文件选择框打开期间工作台会因轮询重绘；选择器放在重绘区域之外，选中的文件不会因为节点被替换而丢失。
  private fileInput?:HTMLInputElement;
  private pickFile(itemId:string){
    const doc=this.host.root.ownerDocument;if(!this.fileInput){const input=doc.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp';input.id='studio-wb-upload-file';input.className='iwb-file';input.hidden=true;doc.body.append(input);this.fileInput=input;}
    const input=this.fileInput,done=()=>{if(!this.filePicking)return;this.filePicking=false;this.flushRender();};this.filePicking=true;
    input.onchange=()=>{const file=input.files?.[0];input.value='';done();const target=this.item(itemId);if(file&&target)void this.uploadVersion(target,file);};input.oncancel=done;doc.defaultView?.addEventListener('focus',()=>setTimeout(done,300),{once:true});input.click();
  }
  private async uploadVersion(item:PlanItemVM,file:File){
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){this.host.toast('请选择 PNG、JPG 或 WebP 图片');return;}
    if(file.size>15*1024*1024){this.host.toast('图片超过 15MB，请压缩后再上传');return;}
    if(!this.host.upload){this.host.toast('当前页面还不能上传图片');return;}
    const purpose=this.uploadPurpose;
    await this.withItem(item,async()=>{const saved=await this.host.upload!(file,purpose,this.host.context());await this.assetVersion(item,saved.asset_id,{purpose,name:file.name.slice(0,120)});this.host.toast('已上传为这张图的新一版，可以采用或在上面修改');});
  }
  // 手动加一张：在选中图之后（没有选中时放在最后一段之后）新增一项，再由本人在卡片上改位置。
  private async addItem(after:PlanItemVM|undefined){
    if(!this.plan||!this.studio)return;const paragraphs=this.studio.paragraphs,anchor=after&&after.position!=='cover'?after.placement_paragraph_id:paragraphs.at(-1)?.id??null,position=after&&after.position==='before'?'before':'after';
    const before=new Set(this.vm?.items.map(i=>i.id));const epoch=this.epoch;this.working.add('add');this.render();
    try{await this.port.create({topic_id:this.openTopic,expected_version:this.plan.version,position,paragraph_id:anchor},crypto.randomUUID(),this.host.context());if(!this.owns(epoch))return;await this.load(false);const made=this.vm?.items.find(i=>!before.has(i.id));if(made){this.focus=made.id;this.tool='select';}this.host.toast('已新增一张，可以在卡片上选插入位置，再生成、换来源或上传');this.render();this.host.root.querySelector<HTMLElement>('.iwb-card.is-focused select[id^="studio-wb-place-"]')?.focus();}
    catch(e){if(!this.owns(epoch))return;if(isVersionConflict(e))await this.load(false);this.host.toast(workbenchErrorCopy(e));}
    finally{if(this.owns(epoch)){this.working.delete('add');this.render();}}
  }
  private insertExcerpt(value:string){const p=parsePosition(value);if(!p)return '';if(p.position==='cover')return '作为文章封面，排在最前';const para=this.studio?.paragraphs.find(x=>x.id===p.paragraph_id);if(!para)return '';const text=para.text.replace(/\s+/g,' ').trim();return (p.position==='before'?'插在这一段前面：':'插在这一段后面：')+(text.length>80?text.slice(0,80)+'…':text);}
  private presentInsert(){
    const d=this.insertDraft;if(!d||!this.studio)return;const coverTaken=(this.vm?.items??[]).some(i=>i.position==='cover'),options=positionOptions(this.studio.paragraphs,coverTaken);
    const place='<label class="configuration-field" for="studio-wb-insert-place"><span>插入位置</span><select class="field" id="studio-wb-insert-place">'+options.map(o=>'<option value="'+esc(o.value)+'"'+(o.value===d.value?' selected':'')+(o.disabled?' disabled':'')+'>'+esc(o.label)+'</option>').join('')+'</select></label><p class="iwb-insert-excerpt" id="studio-wb-insert-excerpt">'+esc(this.insertExcerpt(d.value))+'</p>';
    const sources='<fieldset class="iwb-insert-sources"><legend>图从哪里来</legend>'+INSERT_SOURCES.map(([v,label,hint])=>'<label class="iwb-insert-source" for="studio-wb-insert-src-'+v+'"><input type="radio" name="studio-wb-insert-src" id="studio-wb-insert-src-'+v+'" value="'+v+'"'+(v===d.source?' checked':'')+'><span><b>'+esc(label)+'</b><small>'+esc(hint)+'</small></span></label>').join('')+'</fieldset>';
    const caption='<label class="configuration-field" for="studio-wb-insert-caption"><span>图注（可不填）</span><input class="field" id="studio-wb-insert-caption" maxlength="120" value="'+esc(d.caption)+'" placeholder="不填就按段落起名，之后可以改"></label>';
    this.host.context().surface.presentDialog({title:'公众号配图 · 新加图片位',body:'<div class="iwb-insert">'+place+sources+caption+'<p class="iwb-confirm-budget">新加图片位不会自动生图；AI 生图要在右栏点「生成这张」并确认后才提交。</p></div>',foot:btn('取消','close-dialog')+btn('新加图片位','studio-wb-insert-confirm',true)});
  }
  // 在指定位置新加图片位：写进方案（与「手动加一张」同一接口），选中新项并把右栏切到对应来源。
  private async insertItem(placement:{position:'cover'|'before'|'after';paragraph_id:string|null},source:InsertSource,caption:string){
    if(!this.plan||!this.studio)return;const before=new Set(this.vm?.items.map(i=>i.id)),epoch=this.epoch;this.working.add('add');this.render();
    try{await this.port.create({topic_id:this.openTopic,expected_version:this.plan.version,position:placement.position,paragraph_id:placement.paragraph_id,source_strategy:source==='upload'?'ai_generate':source,...(caption?{purpose:caption}:{})},crypto.randomUUID(),this.host.context());if(!this.owns(epoch))return;await this.load(false);
      const made=this.vm?.items.find(i=>!before.has(i.id));if(made){this.focus=made.id;this.tool='select';this.selectedMark=0;this.tab=source==='upload'?'refs':source==='ai_generate'?'modify':'sources';}
      this.host.toast(source==='upload'?'已新加图片位，在右栏「上传图片」里选一张图':source==='ai_generate'?'已新加图片位，在右栏写好画面说明后点「生成这张」':'已新加图片位，正在按这一段找网络图，之后可以换');this.render();this.revealFocused();}
    catch(e){if(!this.owns(epoch))return;if(isVersionConflict(e))await this.load(false);this.host.toast(workbenchErrorCopy(e));}
    finally{if(this.owns(epoch)){this.working.delete('add');this.render();}}
  }
  private presentRemove(item:PlanItemVM){
    const kept=item.versions.filter(v=>v.asset_id).length;
    this.host.context().surface.presentDialog({title:'公众号配图 · 删除这张图',body:'<div class="iwb-confirm"><p>删除「'+esc(item.roleLabel+' · '+item.caption)+'」后，它不再排进文章，也不会进入终稿。</p>'+(item.role!=='manual'?'<p>这是 AI 规划的图片位，删除后不会自动加回；需要时可以在任意段落新加。</p>':'')+(kept?'<p class="iwb-confirm-warn" role="note">已生成的图片会保留在素材库（共 '+kept+' 个版本），可从其他图的「网络找图」分页找回。</p>':'<p class="iwb-confirm-budget">这张还没有生成过图片。</p>')+'</div>',foot:btn('取消','close-dialog')+btn('删除这张图','studio-wb-remove-confirm',true,'data-item="'+esc(item.id)+'"')});
  }
  private versionLine(item:PlanItemVM,v:StudioVersion){return 'v'+(item.versions.indexOf(v)+1)+' · '+versionTag(v);}
  private presentCompare(item:PlanItemVM){
    const shown=this.shown(item);if(!shown)return;const usable=item.versions.filter(v=>v.asset_id&&['succeeded','size_mismatch'].includes(v.state)),at=usable.indexOf(shown),before=at>0?usable[at-1]:undefined;
    if(!before){this.host.toast('这是第一版，还没有可以对比的旧版');return;}
    const block=(v:StudioVersion,title:string)=>{const url=this.host.imageUrl(v),marks=v.marks?.length?' · 修改时标注 '+v.marks.length+' 处':'';return '<section class="iwb-compare-block"><h3>'+esc(title)+'</h3><div class="iwb-compare-art" style="aspect-ratio:'+v.actual.width+'/'+v.actual.height+'">'+(url?'<img src="'+esc(url)+'" alt="'+esc(title)+'">':'<span>正在读取图片…</span>')+'</div><p>'+esc(v.actual.width+' × '+v.actual.height+' px'+marks)+'</p><p class="iwb-compare-desc">'+esc(v.description.slice(0,120)+(v.description.length>120?'…':''))+'</p></section>';};
    const n=item.versions.indexOf(before)+1;
    this.host.context().surface.presentDialog({title:'公众号配图 · 对比修改前后',body:'<div class="iwb-compare">'+block(before,this.versionLine(item,before))+block(shown,this.versionLine(item,shown)+' · 当前查看')+'</div>',foot:btn('回到 v'+n,'studio-wb-restore-version',false,'data-item="'+esc(item.id)+'" data-version="'+esc(before.id)+'"')+btn('保留当前版','close-dialog',true)});
  }
  private resizeValid(){const d=this.resizeDraft;return !!d&&Number.isInteger(d.width)&&Number.isInteger(d.height)&&d.width>=320&&d.height>=320&&d.width<=4096&&d.height<=4096&&d.width/d.height>=.2&&d.width/d.height<=5;}
  private resizeStatus(){const root=this.host.root,d=this.resizeDraft,ok=this.resizeValid(),ready=studioProviderReady(this.capability('agy'));const summary=root.querySelector('#studio-wb-resize-summary'),error=root.querySelector('#studio-wb-resize-error'),go=root.querySelector<HTMLButtonElement>('[data-action="studio-wb-resize-next"]');
    if(summary&&d)summary.textContent=ok?d.width+' × '+d.height+' px · '+studioRatioLabel(studioAspect(d.width,d.height)):'请检查尺寸';if(error)error.textContent=ok?'':'尺寸范围 320–4096 px，画幅比例需在 1:5 到 5:1 之间。';if(go)go.disabled=!ok||!ready;}
  private presentResize(){
    const d=this.resizeDraft,item=d?this.item(d.item):undefined;if(!d||!item)return;const ratio=RESIZE_RATIOS.find(r=>r[1]===d.width&&r[2]===d.height)?.[0]??'custom',ready=studioProviderReady(this.capability('agy'));
    const body='<div class="iwb-resize"><p>以当前这一版为原图，用 AGY 生图按新画幅另存一版；旧画幅的版本保留，可以对比和回退。</p><label class="configuration-field" for="studio-wb-resize-ratio"><span>画幅比例</span><select class="field" id="studio-wb-resize-ratio">'+RESIZE_RATIOS.map(r=>'<option value="'+r[0]+'"'+(r[0]===ratio?' selected':'')+'>'+esc(studioRatioLabel(r[0]))+'</option>').join('')+'<option value="custom"'+(ratio==='custom'?' selected':'')+'>自定义</option></select></label>'
      +'<div class="iwb-resize-fields"><label class="configuration-field" for="studio-wb-resize-w"><span>宽度（px）</span><input class="field" id="studio-wb-resize-w" type="number" min="320" max="4096" step="1" value="'+d.width+'"></label><label class="configuration-field" for="studio-wb-resize-h"><span>高度（px）</span><input class="field" id="studio-wb-resize-h" type="number" min="320" max="4096" step="1" value="'+d.height+'"></label></div>'
      +'<p class="iwb-confirm-budget" id="studio-wb-resize-summary" role="status"></p><p class="iwb-resize-error" id="studio-wb-resize-error" role="alert"></p><p class="fine">像素作为说明发送给生图渠道，实际尺寸以返回的图片为准。'+(ready?'':'AGY 生图当前不可用或次数已用完，暂时不能调整。')+'</p></div>';
    this.host.context().surface.presentDialog({title:'公众号配图 · 调整画幅与尺寸',body,foot:btn('取消','close-dialog')+btn('下一步：确认生成','studio-wb-resize-next',true,'data-item="'+esc(item.id)+'"')});this.resizeStatus();
  }
  private async resize(epoch:number,c:FeatureContext){
    const d=this.resizeDraft,item=d?this.item(d.item):undefined;if(!d||!item||!this.resizeValid())return;const size={width:d.width,height:d.height},label=studioRatioLabel(studioAspect(size.width,size.height));
    c.surface.dialogBusy?.(true);this.working.add('item:'+item.id);
    try{const result=await this.submit(item,'reference_edit',resizeDescription(size.width,size.height,label),'agy',()=>true,{size});if(!this.owns(epoch))return;
      // 只关/解锁仍是本次的调整画幅窗口：用户中途关掉并打开了别的窗口时，迟到的结果不能关掉或解锁那个新窗口。
      if(result==='queued'){if(this.resizeDraft===d){c.surface.dialogBusy?.(false);c.surface.closeDialog('completed');}const aspect=RESIZE_RATIOS.find(r=>r[1]*size.height===r[2]*size.width)?.[0] as PlanItemVM['aspect']|undefined;if(aspect&&aspect!==item.aspect)await this.update(item.id,{aspect});else await this.load(false);this.host.toast('新尺寸版本已入队，完成后出现在版本条，旧版保留');}
      else if(result==='quota')this.host.toast('AGY 生图次数不足，没有入队');}
    finally{if(this.owns(epoch)){if(this.resizeDraft===d)c.surface.dialogBusy?.(false);this.working.delete('item:'+item.id);this.render();}}
  }
  private presentGenerateAll(fresh=false){
    const vm=this.vm,plan=this.plan;if(!vm||!plan||!this.confirmOpen)return;
    // 新打开时进入冷却；切换渠道 / 模型重绘时沿用同一冷却，不会被提前解开，也不会因为重绘而跳过。
    const armAttr=fresh?this.arm.open():this.arm.attrs();const items=this.batchItems(),provider=this.allProvider,cap=this.capability(provider),usable=!!cap&&!studioProviderOption(cap).disabled,remaining=usable?cap!.availability?.remaining??plan.budget[provider].remaining:0,split=generateAllPlan(items,remaining),limited=remaining!==null;
    const body='<div class="iwb-confirm"><p>把已选的 <b>'+items.length+'</b> 张逐张入队。'+(limited?'每张都会用掉一次真实生图次数。':'所选渠道不限次数。')+'已配好的图会新建一个版本，生成后设为当前图，旧版保留、可在版本条里切回。</p>'+(limited?'<p class="iwb-confirm-budget" role="status">生图剩余：'+esc(budgetLine(plan.budget))+'</p>':'')
      +this.providerSelect('studio-wb-all-provider',provider)+this.modelField(provider,'studio-wb-all-model')
      +'<ol class="iwb-confirm-list">'+items.map(i=>'<li class="'+(split.blocked.includes(i)?'is-blocked':'')+'"><b>'+esc(i.roleLabel)+'</b><span>'+esc(i.caption)+'</span><em>'+(split.blocked.includes(i)?'额度不足，不入队':i.current?'新建版本':'首次生成')+'</em></li>').join('')+'</ol>'
      +(split.blocked.length?'<p class="iwb-confirm-warn" role="alert">'+split.blocked.length+' 张超出本渠道剩余额度，会标为「额度不足」，不会入队。</p>':'')+'</div>';
    this.host.context().surface.presentDialog({title:'公众号配图 · 批量生成',body,foot:btn('取消','close-dialog')+btn(split.queue.length?'确认生成 '+split.queue.length+' 张':'没有可入队的图','studio-wb-generate-all-confirm',true,split.queue.length?armAttr:'disabled')});if(fresh)this.avoidTrigger();
  }

  private async generateAll(epoch:number,c:FeatureContext){
    const vm=this.vm,plan=this.plan;if(!vm||!plan)return;const chosen=this.batchItems(),provider=this.allProvider,cap=this.capability(provider),usable=!!cap&&!studioProviderOption(cap).disabled,split=generateAllPlan(chosen,usable?cap!.availability?.remaining??plan.budget[provider].remaining:0);
    c.surface.dialogBusy?.(true);let queued=0,failed=0;const batch=this.confirmBatch;
    try{for(const item of split.blocked)this.quota.add(item.id);
      const live=()=>this.owns(epoch)&&this.confirmOpen&&batch!==0&&this.confirmBatch===batch;
      for(const item of split.queue){if(!live())return;await this.load(false);if(!live())return;const fresh=this.item(item.id),wasFilled=!!item.current;if(!fresh||!this.batchEligible(fresh)||!wasFilled&&fresh.current){continue;}const result=await this.submit(fresh,'generate',(this.prompts.get(fresh.id)??fresh.prompt).trim(),provider,live,fresh.current?{candidate_only:true}:{});if(result==='stopped'||!live())return;if(result==='queued'){queued++;this.quota.delete(fresh.id);}else if(result==='quota')this.quota.add(fresh.id);else failed++;}
      if(!live())return;this.confirmOpen=false;this.confirmBatch=0;this.pickTouched=false;this.picked.clear();c.surface.dialogBusy?.(false);c.surface.closeDialog('completed');await this.load(false);
      const blocked=chosen.filter(i=>this.quota.has(i.id)).length;this.host.toast('已入队 '+queued+' 张'+(blocked?'，'+blocked+' 张额度不足未入队':'')+(failed?'，'+failed+' 张没有入队':''));
    }finally{
      // 只解锁仍属于这一批的确认框；批次已结束或窗口已换成别的弹窗时不碰它的弹窗锁。
      if(this.owns(epoch)&&this.confirmOpen&&batch!==0&&this.confirmBatch===batch)c.surface.dialogBusy?.(false);}
  }
  private presentPreview(){if(!this.vm)return;this.host.context().surface.presentDialog({title:'公众号配图 · 完整文章预览',body:'<div class="iwb-preview"><p class="iwb-preview-tip">想在哪一段后面加图，点段落下面的「在这里插入图片位」。</p>'+this.article(true)+'</div>',foot:btn('关闭','close-dialog')});}
  private progressView():GenerationProgressView{const run=this.plan?.run;return {state:run?.state==='running'?'running':run?.state==='waiting'?'waiting':'queued',message:run?.state==='waiting'?'执行器暂时不可用，恢复后继续规划':'AI 正在读定稿、规划配图落点',note:'规划不消耗生图额度。完成后，原文与帖子里的图会自动选好；需要 AI 生成的图等你逐张生成。'};}
  private markup():string{
    const vm=this.vm,plan=this.plan;
    // 头部右侧主操作：确认配图并进入排版。还有没配好的图时禁用，并写明还剩几张。
    const pending=this.pending(),layoutReady=!!this.host.openLayout&&!!this.port.confirm,confirmBusy=this.working.has('confirm');
    const why=!vm||!layoutReady?'':vm.state==='planning'?'方案规划中，完成后再确认':!vm.items.length?'方案出来后再确认配图':vm.stale?'文章改过，先按最新定稿重新规划':pending?'还有 '+pending+' 张待处理':'';
    // 冻结终稿要几秒：按钮就地转圈、禁用并写明在做什么；失败时头部留可见的说明与「重试」。排版已确认时提前说明后果。
    const relock=this.layoutConfirmed(),note=why||(relock&&!confirmBusy?'排版已确认，修改配图会让排版需要重新确认':'');
    const confirmBtn=layoutReady&&vm?(confirmBusy?'<button type="button" class="button primary iwb-confirm-layout is-busy" data-action="studio-wb-confirm" disabled aria-busy="true"><span class="iwb-spinner" aria-hidden="true"></span>正在冻结配图终稿…</button>':cbtn('确认配图，进入排版','studio-wb-confirm','primary iwb-confirm-layout',this.canConfirm()?(note?'aria-describedby="iwb-confirm-why"':''):'disabled'+(note?' aria-describedby="iwb-confirm-why"':'')))
      +(note?'<small class="iwb-head-note" id="iwb-confirm-why">'+esc(note)+'</small>':'')
      +(this.confirmError&&!confirmBusy?'<p class="iwb-confirm-error" role="alert"><span>'+esc(this.confirmError)+'</span>'+(this.canConfirm()?btn('重试','studio-wb-confirm'):'')+'</p>':''):'';
    const head='<header class="iwb-head"><div class="iwb-title"><p class="iwb-eyebrow">WECHAT · IMAGE STUDIO</p><h2>给这篇文章，配上合适的图。</h2><p class="iwb-sub">'+esc(vm?'文章：'+vm.title:'正在读取文章…')+'</p></div><div class="iwb-head-actions">'+btn('返回平台稿','studio-wb-close')+btn('预览完整文章','studio-wb-preview',false,vm?.items.length?'':'disabled aria-describedby="iwb-preview-why"')+confirmBtn+(vm?.items.length?'':'<small class="iwb-head-note" id="iwb-preview-why">方案出来后才能预览完整文章</small>')+'</div></header>';
    // 步骤条按真实进度：配图确认过写「已确认」（之后又改过写「有改动待确认」）；确认过配图后「排版」可点，排版已确认时写「已确认」；后续阶段统一写「待上线」。
    const layoutOpen=layoutReady&&!!plan?.final?.confirmed,final=plan?.final,ls=this.layoutState;
    const imageTag=final?.confirmed?(final.current?'已确认':'有改动待确认'):'';
    const layoutTag=!layoutOpen?'确认配图后进入':ls?.confirmed?(ls.synced&&final?.current?'已确认':'需重新确认'):ls?.started?'进行中':'';
    const steps='<nav class="iwb-steps" aria-label="公众号发布步骤"><ol>'+([['文案定稿','done',''],['配图','current',imageTag],['排版',layoutOpen?(ls?.confirmed&&ls.synced&&final?.current?'open is-done':'open'):'next',layoutTag],['AI 审核','next','待上线'],['确认并提交草稿','next','待上线']] as Array<[string,string,string]>).map(([label,kind,tag],i)=>{const done=kind==='done'||kind.includes('is-done')||(kind==='current'&&tag==='已确认');const dot='<span class="iwb-step-dot" aria-hidden="true">'+(done?'✓':String(i+1))+'</span><span>'+esc(label)+'</span>'+(tag?'<small>'+esc(tag)+'</small>':'');return '<li class="iwb-step is-'+kind+'"'+(kind==='current'?' aria-current="step"':kind==='next'?' aria-disabled="true"':'')+'>'+(kind.startsWith('open')?'<button type="button" class="publish-step-open iwb-step-link" data-action="studio-wb-layout">'+dot+'</button>':dot)+'</li>';}).join('<li class="iwb-step-sep" aria-hidden="true">›</li>')+'</ol></nav>';
    if(this.error&&!vm)return '<section class="image-workbench" aria-label="公众号配图工作台">'+head+steps+'<div class="iwb-empty" role="alert"><b>配图方案暂时读不到</b><p>'+esc(this.error)+'</p>'+btn('重新读取','studio-wb-retry',true)+'</div></section>';
    if(!vm||!plan)return '<section class="image-workbench" aria-label="公众号配图工作台">'+head+steps+'<div class="iwb-empty" role="status"><p>正在读取定稿、配图方案和渠道…</p></div></section>';
    const banners=(vm.stale?'<p class="iwb-banner is-warn" role="status">文章在规划后又改过，部分落点可能对不上。'+btn('按最新定稿重新规划','studio-wb-replan',false,this.working.has('run')?'disabled':'')+'</p>':'')+(vm.replanning?'<p class="iwb-banner" role="status">正在按最新定稿重新规划，完成后替换下面的方案；已配好的图会保留。</p>':'')+(vm.state==='ready'&&plan.run?.state==='failed'&&vm.runError?'<p class="iwb-banner is-warn" role="status">'+esc(vm.runError)+'</p>':'')+(this.error?'<p class="iwb-banner is-warn" role="alert">'+esc(this.error)+btn('重新读取','studio-wb-reload')+'</p>':'');
    return '<section class="image-workbench" aria-label="公众号配图工作台">'+head+steps+banners+'<div class="iwb-grid">'+this.left()+this.center()+this.right()+'</div><p class="iwb-foot fine">方案和每一版图片都保存在本篇记录里；AI 审核和提交草稿待上线。</p></section>';
  }
  // ——— 渲染 ———
  // 拖拽排序、画标注、文件选择框打开期间不重绘（轮询结果先记下），结束后补一次，避免操作中的节点被替换。
  private renderPending=false; private filePicking=false; private drawingKey='';
  private flushRender(){if(this.renderPending){this.renderPending=false;this.render();}}
  private render(){
    if(this.drawing||this.adjusting||this.dragging||this.filePicking){this.renderPending=true;return;}
    const node=this.host.root.querySelector<HTMLElement>('.image-workbench-host');if(!node||!this.openTopic)return;
    const doc=this.host.root.ownerDocument,active=doc.activeElement as HTMLInputElement|null,keep=active&&node.contains(active)&&active.id?{id:active.id,start:active.selectionStart,end:active.selectionEnd}:null;
    // 整块重绘会把各栏的滚动位置清零（1440 下左栏、舞台、右栏各自滚动）：重绘前记下，重绘后还原，排序/删除后不跳回顶部。
    const scrolls=SCROLL_KEEP.map(sel=>[sel,node.querySelector<HTMLElement>(sel)?.scrollTop??0] as const);
    this.loaderPlan.clear();node.innerHTML=this.markup();this.attachLoaders(node);
    for(const [sel,top] of scrolls){const box=top?node.querySelector<HTMLElement>(sel):null;if(box)box.scrollTop=top;}
    const slot=node.querySelector<HTMLElement>('.iwb-progress-slot');if(slot&&this.plan?.run&&this.vm?.state==='planning'&&!this.progress){const v=this.progressView();slot.innerHTML='<div class="iwb-progress-text" role="status"><b>'+esc(v.message)+'</b><p>'+esc(v.note)+'</p></div>';}else if(slot&&this.plan?.run&&this.vm?.state==='planning'&&this.progress){if(!this.progressNode){this.progressNode=doc.createElement('div');this.progressNode.className='iwb-progress';this.progress.mount(this.progressNode,this.plan.run.requested_at,this.progressView());}else this.progress.update(this.progressView());slot.append(this.progressNode);}else if(this.progressNode&&this.vm?.state!=='planning'){this.progress?.dispose();this.progressNode=undefined;}
    for(const img of Array.from(node.querySelectorAll<HTMLImageElement>('.iwb-candidate img')))img.addEventListener('error',()=>{const box=img.parentElement;if(box){box.classList.add('is-broken');box.textContent='缩略图无法显示（来源站限制）';}},{once:true});
    this.bindMarks(node);this.bindDrag(node);
    if(keep){const field=node.querySelector<HTMLInputElement>('#'+CSS.escape(keep.id));if(field){field.focus({preventScroll:true});if(keep.start!==null&&'setSelectionRange' in field)try{field.setSelectionRange(keep.start,keep.end);}catch{/* select 等控件无选区 */}}}
  }
  // 标注绘制：pointer 事件换算到 viewBox（宽 1000、高 1000×h/w），拖动中只重画待定图形，松手后才加入清单。
  private bindMarks(node:HTMLElement){
    const svg=node.querySelector<SVGSVGElement>('.iwb-marks'),item=this.item();if(!svg||!item)return;const H=Number(svg.dataset.h)||1000,pending=svg.querySelector<SVGGElement>('.iwb-pending'),handles=svg.querySelector<SVGGElement>('.iwb-handles');
    const round=(n:number)=>Math.round(n*10)/10,at=(e:PointerEvent)=>{const r=svg.getBoundingClientRect();return {x:round(Math.max(0,Math.min(1000,(e.clientX-r.left)*1000/r.width))),y:round(Math.max(0,Math.min(H,(e.clientY-r.top)*H/r.height)))};};
    const shape=(d:StudioMark,p:{x:number;y:number}):StudioMark=>d.type==='rect'?{...d,x:Math.min(d.x,p.x),y:Math.min(d.y,p.y),w:round(Math.abs(p.x-d.x)),h:round(Math.abs(p.y-d.y)),ex:p.x,ey:p.y}:{...d,ex:p.x,ey:p.y,w:round(Math.abs(p.x-d.x)),h:round(Math.abs(p.y-d.y))};
    // 选中的一处画手柄：按舞台实际像素换算，桌面约 14px、小屏约 22px，方便手指拖。框选有八个手柄，箭头有两端，其余只画选中框。
    const paint=(m:StudioMark|undefined)=>{if(!handles)return;if(!m){handles.innerHTML='';return;}const r=svg.getBoundingClientRect(),u=r.width>0?1000/r.width:2,s=round((r.width>0&&r.width<480?22:14)*u),half=s/2,pad=6*u;
      const pts:Array<[MarkHandle,number,number]>=m.type==='rect'?RECT_HANDLES.map(hd=>[hd,m.x+(hd.endsWith('w')?0:hd.endsWith('e')?m.w:m.w/2),m.y+(hd.startsWith('n')?0:hd.startsWith('s')?m.h:m.h/2)] as [MarkHandle,number,number]):m.type==='arrow'?[['start',m.x,m.y],['end',m.ex,m.ey]]:[];
      const b=markBounds(m),frame=m.type==='rect'?'':'<rect class="iwb-select-frame" x="'+round(b.x-pad)+'" y="'+round(b.y-pad)+'" width="'+round(b.w+pad*2)+'" height="'+round(b.h+pad*2)+'"/>';
      const hit=round(32*u),hh=hit/2;handles.innerHTML=frame+pts.map(([hd,x,y])=>'<rect class="iwb-handle-hit is-'+hd+'" data-handle="'+hd+'" x="'+round(x-hh)+'" y="'+round(y-hh)+'" width="'+hit+'" height="'+hit+'"/><rect class="iwb-handle is-'+hd+'" data-handle="'+hd+'" x="'+round(x-half)+'" y="'+round(y-half)+'" width="'+s+'" height="'+s+'" rx="'+round(s/5)+'"/>').join('');};
    const groupOf=(id:number)=>svg.querySelector<SVGGElement>('.iwb-mark-g[data-mark="'+id+'"]');
    paint(this.selectedKey===this.markKey(item.id)?this.markList(item.id).find(m=>m.id===this.selectedMark):undefined);
    // 多指触控：拖动/画图期间只跟第一根按下的手指，其余指针的按下、移动、抬起都忽略。
    const other=(e:PointerEvent)=>this.pointer!==null&&e.pointerId!==this.pointer;
    svg.addEventListener('pointerdown',e=>{if(this.working.has('item:'+item.id)||this.pointer!==null&&(this.adjusting||this.drawing))return;
      // 先看是否按在手柄或已有标注上：选择工具下任一处可拖；画图工具下只有已选中的那处可拖（其余位置照常画新标注）。
      const target=e.target as Element|null,hd=target?.closest?.('[data-handle]'),g=target?.closest?.('[data-mark]'),key=this.markKey(item.id),list=this.markList(item.id);
      const id=hd?(this.selectedKey===key?this.selectedMark:0):g?Number(g.getAttribute('data-mark')):0,mark=id?list.find(m=>m.id===id):undefined;
      if(mark&&(hd||this.tool==='select'||this.selectedKey===key&&this.selectedMark===id)){e.preventDefault();try{svg.setPointerCapture(e.pointerId);}catch{/* 合成事件没有指针捕获 */}try{svg.focus({preventScroll:true});}catch{/* 旧浏览器 SVG 不能聚焦 */}
        this.selectedKey=key;this.selectedMark=id;this.pointer=e.pointerId;this.adjusting={key,id,mode:(hd?.getAttribute('data-handle') as MarkHandle|null)??'move',start:at(e),orig:structuredClone(mark)};
        svg.querySelectorAll('.iwb-mark-g.is-selected').forEach(n=>n.classList.remove('is-selected'));groupOf(id)?.classList.add('is-selected');paint(mark);return;}
      if(this.tool==='select'){if(this.selectedMark&&this.selectedKey===key){this.selectedMark=0;this.render();}return;}
      e.preventDefault();const p=at(e),next=list.length?Math.max(...list.map(m=>m.id))+1:1;
      if(list.length>=30){this.host.toast('一张图最多标注 30 处');return;}
      if(this.tool==='text'){this.setMarks(key,[...list,{id:next,type:'text',x:p.x,y:p.y,w:0,h:0,ex:p.x,ey:p.y,path:'',note:'',text:''}]);this.selectedKey=key;this.selectedMark=next;this.render();this.host.root.querySelector<HTMLInputElement>('#studio-wb-mark-'+next)?.focus();return;}
      try{svg.setPointerCapture(e.pointerId);}catch{/* 合成事件没有指针捕获 */}this.pointer=e.pointerId;this.brushSimplified=false;this.drawingKey=key;this.drawing={id:next,type:this.tool,x:p.x,y:p.y,w:0,h:0,ex:p.x,ey:p.y,path:'M'+p.x+' '+p.y,note:''};});
    svg.addEventListener('pointermove',e=>{if(other(e))return;const a=this.adjusting;if(a){const p=at(e);a.next=adjustMark(a.orig,a.mode,p.x-a.start.x,p.y-a.start.y,H);const g=groupOf(a.id);if(g)g.innerHTML=this.markSvg(a.next,H);paint(a.next);return;}
      const d=this.drawing;if(!d)return;const p=at(e);if(d.type==='brush'){d.path+=' L'+p.x+' '+p.y;if(d.path.length>BRUSH_PATH_LIMIT){d.path=fitPath(d.path,Math.round(BRUSH_PATH_LIMIT*.7));this.brushSimplified=true;}}if(pending)pending.innerHTML=this.markSvg(shape(d,p),H,true);});
    // 按下时固定版本键：绘制或调整期间轮询换了当前版，标注仍记在按下时那一版上。所有退出路径都补一次被暂停的重绘。
    const finish=(e:PointerEvent,cancel=false)=>{if(other(e))return;this.pointer=null;
      const a=this.adjusting;if(a){this.adjusting=undefined;const next=a.next;if(!cancel&&next&&JSON.stringify(next)!==JSON.stringify(a.orig)){const list=this.marks.get(a.key)??[];if(list.some(m=>m.id===a.id))this.setMarks(a.key,list.map(m=>m.id===a.id?next:m));}this.renderPending=false;this.render();return;}
      const d=this.drawing,key=this.drawingKey;this.drawing=undefined;this.drawingKey='';if(pending)pending.innerHTML='';if(!d||cancel||!key){this.flushRender();return;}const p=at(e);if(Math.hypot(p.x-d.x,p.y-d.y)<=6&&d.type!=='brush'||d.type==='brush'&&d.path.split('L').length<3){this.flushRender();return;}
      this.setMarks(key,[...(this.marks.get(key)??[]),shape(d,p)]);this.selectedKey=key;this.selectedMark=d.id;this.renderPending=false;this.render();this.host.root.querySelector<HTMLInputElement>('#studio-wb-mark-'+d.id)?.focus();this.host.toast(this.brushSimplified?'这处涂抹很长，已自动简化路径，可以写这一处怎么改':'标注已添加，可以写这一处怎么改');this.brushSimplified=false;};
    svg.addEventListener('pointerup',e=>{finish(e);this.flushSync();});svg.addEventListener('pointercancel',e=>{finish(e,true);this.flushSync();});
  }
  // 左栏拖拽排序：只改正文图的先后（与上下移同样交换落点），具体位置以卡片上的「插入位置」为准；键盘用上移/下移。
  private bindDrag(node:HTMLElement){
    for(const card of Array.from(node.querySelectorAll<HTMLElement>('.iwb-card[draggable="true"]'))){
      card.addEventListener('dragstart',e=>{this.dragging=card.dataset.item??'';card.classList.add('is-dragging');e.dataTransfer?.setData('text/plain',this.dragging);if(e.dataTransfer)e.dataTransfer.effectAllowed='move';});
      card.addEventListener('dragend',()=>{this.dragging='';queueMicrotask(()=>this.flushRender());card.classList.remove('is-dragging');node.querySelectorAll('.is-drop-target').forEach(n=>n.classList.remove('is-drop-target'));});
      card.addEventListener('dragover',e=>{if(!this.dragging||this.dragging===card.dataset.item)return;e.preventDefault();card.classList.add('is-drop-target');});
      card.addEventListener('dragleave',()=>card.classList.remove('is-drop-target'));
      card.addEventListener('drop',e=>{e.preventDefault();card.classList.remove('is-drop-target');const from=this.dragging,to=card.dataset.item??'';this.dragging='';const body=(this.vm?.items??[]).filter(i=>i.position!=='cover'),target=body.findIndex(i=>i.id===to);if(!from||from===to||target<0)return;void this.update(from,{move_to:target},'顺序已调整，可在卡片上细调插入位置');});
    }
  }
  private left():string{
    const vm=this.vm!,plan=this.plan!,runBusy=this.working.has('run')||vm.state==='planning';
    const planner=this.executors.length?'<div class="iwb-planner" role="radiogroup" aria-labelledby="iwb-planner-label"><span class="iwb-planner-label" id="iwb-planner-label">AI 规划用</span><span class="iwb-segment">'+this.executors.map(c=>{const on=c.id===this.executor;return '<label class="iwb-segment-option'+(on?' is-checked':'')+(c.blocked?' is-disabled':'')+'" for="studio-wb-executor-'+c.id+'"><input type="radio" name="studio-wb-executor" id="studio-wb-executor-'+c.id+'" value="'+c.id+'"'+(on?' checked':'')+(c.blocked?' disabled':'')+'><b>'+esc(c.name)+'</b><small>'+esc(plannerStatus(c))+'</small></label>';}).join('')+'</span></div>':'';
    const tools='<div class="iwb-plan-tools">'+planner+btn(vm.items.length?'重新规划':'让 AI 规划配图','studio-wb-replan',!vm.items.length,runBusy?'disabled':'')+'</div>';
    const all=vm.items.length?cbtn('批量生成（已选 '+this.batchItems().length+' 张）','studio-wb-generate-all','primary iwb-generate-all',(this.batchItems().length?'':'disabled ')+'aria-describedby="iwb-budget-line"')+'<p class="iwb-pick-note">'+esc(this.pickTouched?'已配的图会新建版本，旧版保留':'默认选中待生成的图；已配的图也可勾选')+'</p>'+'<p class="iwb-budget-line" id="iwb-budget-line">生图剩余：'+esc(budgetLine(plan.budget))+'</p>':'';
    let list:string;
    if(!vm.items.length)list=vm.state==='planning'?'<div class="iwb-skeleton" role="status"><span></span><span></span><span></span><p>AI 正在规划落点…</p></div>':vm.state==='failed'?'<div class="iwb-note is-warn" role="alert"><b>这次规划没有成功</b><p>'+esc(vm.runError??'可以重新规划。')+'</p></div>':vm.state==='ready'?'<div class="iwb-note"><b>这篇的配图都删掉了</b><p>可以手动加一张，或按定稿重新规划。</p></div>':'<div class="iwb-note"><b>还没有配图方案</b><p>让 AI 读完定稿，先给出每张图的位置、图注和来源，你再逐张生成。</p></div>';
    else list='<ol class="iwb-items">'+vm.items.map(i=>this.card(i)).join('')+'</ol>';
    const add=vm.items.length||vm.state==='ready'?'<div class="iwb-add-row">'+cbtn(this.working.has('add')?'正在新增…':'＋ 手动加一张','studio-wb-add-item','iwb-add',this.working.has('add')?'disabled':'')+'<button type="button" class="iwb-link" data-action="studio-wb-insert" data-place="end"'+(this.working.has('add')?' disabled':'')+'>选段落插入（AI 生图 / 网络找图 / 上传）</button><button type="button" class="iwb-link" data-action="studio-wb-add">更多选项（写画面说明、定画幅后直接生成）</button>'+(this.host.pendingStale?.()?'<p class="iwb-pending-stale" role="status"><span>这次请求没有回应，可以放弃后重新发起</span>'+btn('放弃这次请求','studio-wb-abandon-pending')+'</p>':'')+'</div>':'';
    return '<aside class="iwb-plan" aria-label="本篇配图"><div class="iwb-col-head"><h3>本篇配图</h3><span>'+(vm.items.length?vm.counts.filled+' / '+(vm.counts.total-vm.counts.skipped)+' 张已配':'')+'</span></div>'+tools+all+list+add+'<p class="fine">图注、来源和插入位置改完即保存；拖动卡片或用上移/下移调整先后。</p></aside>';
  }
  private thumb(item:PlanItemVM,cls:string){const v=this.shown(item),url=v?this.host.imageUrl(v):undefined;return url?'<img class="'+cls+'" src="'+esc(url)+'" alt="'+esc(item.caption)+'">':'<span class="'+cls+' is-empty" aria-hidden="true">'+esc(item.status==='generating'?'生成中':item.status==='searching'?'找图中':item.strategy==='ai_generate'?'AI':'图')+'</span>';}
  // 卡片始终可编辑：不用先展开，图注、来源、插入位置直接改，失焦或回车保存。
  private card(item:PlanItemVM):string{
    const focused=item.id===this.focus,busy=this.working.has('item:'+item.id),dis=busy?' disabled':'',iid=esc(item.id),body=item.position!=='cover';
    const coverTaken=(this.vm?.items??[]).some(i=>i.position==='cover'&&i.id!==item.id),options=positionOptions(this.studio?.paragraphs??[],coverTaken),current=item.position==='cover'?'cover':item.position+':'+item.placement_paragraph_id;
    const batched=this.batchItems().includes(item),eligible=this.batchEligible(item);
    const pick='<label class="iwb-pick" for="studio-wb-pick-'+iid+'"><input type="checkbox" id="studio-wb-pick-'+iid+'" aria-label="'+esc('选择 '+item.roleLabel+'「'+item.caption+'」'+(item.current?'批量生成新版本':'批量生成'))+'"'+(batched?' checked':'')+(eligible?'':' disabled')+'><span>'+(item.current?'选入批量（新建版本）':'选入批量生成')+'</span></label>';
    const summary='<div class="iwb-card-top">'+(body?'<span class="iwb-drag" aria-hidden="true" title="拖动调整顺序">⋮⋮</span>':'')+'<button type="button" class="iwb-card-hit" data-action="studio-wb-focus" data-item="'+iid+'" aria-pressed="'+focused+'" aria-label="'+esc('在舞台上编辑'+item.roleLabel+'「'+item.caption+'」')+'">'+this.thumb(item,'iwb-thumb')+'<span class="iwb-card-text"><b>'+esc(item.roleLabel)+(item.currentIndex?' <small>v'+item.currentIndex+'</small>':'')+'</b><span class="iwb-card-meta">'+esc(item.strategyLabel)+'</span>'+(this.fresh.has(item.id)?'<span class="iwb-fresh">新版本已生成</span>':'')+'</span><span class="iwb-chip is-'+item.tone+'">'+esc(item.statusLabel)+'</span></button>'+pick+'</div>';
    // 每张图都有「从网络找图」：打开右栏的网络找图分页；资讯原文还在后台补图时写明「正在补充更多图片」。
    const refreshing=!!this.candidateCapture?.refreshing;
    const insert='<button type="button" class="iwb-link iwb-insert-after" data-action="studio-wb-insert" data-item="'+iid+'" aria-label="'+esc('在'+item.roleLabel+'后面插入一个图片位')+'">＋ 在后面插入</button>';
    const find='<div class="iwb-card-find">'+(item.status==='skipped'?'':'<button type="button" class="iwb-link" data-action="studio-wb-find" data-item="'+iid+'">从网络找图</button>'+(refreshing?'<small class="iwb-card-find-note"><span class="iwb-capture-dot" aria-hidden="true"></span>正在补充更多图片</small>':''))+insert+'</div>';
    const strategy='<select class="field" id="studio-wb-strategy-'+iid+'"'+dis+'>'+(Object.entries(STRATEGY_LABELS) as Array<[PlanItemVM['strategy'],string]>).map(([k,v])=>'<option value="'+k+'"'+(k===item.strategy?' selected':'')+'>'+esc(v)+'</option>').join('')+'</select>';
    const place='<select class="field" id="studio-wb-place-'+iid+'"'+dis+'>'+(options.some(o=>o.value===current)?'':'<option value="" selected>原段落已找不到，请重新选</option>')+options.map(o=>'<option value="'+esc(o.value)+'"'+(o.value===current?' selected':'')+(o.disabled&&o.value!==current?' disabled':'')+'>'+esc(o.label)+'</option>').join('')+'</select>';
    // 紧凑卡片：图注一行、插入位置一行，不展开就能改；来源、跳过/删除等在选中这张时就地展开。
    const quick='<div class="iwb-card-quick"><input class="field iwb-caption-inline" id="studio-wb-caption-'+iid+'" maxlength="120" aria-label="'+esc(item.roleLabel+'的图注草案')+'" value="'+esc(item.caption)+'"'+dis+'><label class="iwb-place" for="studio-wb-place-'+iid+'"><span class="iwb-sr">插入位置</span>'+place+'</label></div>';
    // 卡片上只放整理类操作（排序一组、去留一组），不放「生成」：生成在右栏，且要先确认，避免上移/下移后误点成真实生图。
    const edit=quick+find+(!focused?'':'<div class="iwb-card-edit"><label class="configuration-field" for="studio-wb-strategy-'+iid+'"><span>来源</span>'+strategy+'</label>'
      +(item.issue?'<p class="iwb-issue" role="status">'+esc(item.issue)+'</p>':'')
      +'<div class="iwb-card-actions">'+(body?'<span class="iwb-card-group" role="group" aria-label="调整顺序">'+btn('上移','studio-wb-move',false,'data-item="'+iid+'" data-dir="up" aria-label="上移这张图"'+(item.canMoveUp&&!busy?'':' disabled'))+btn('下移','studio-wb-move',false,'data-item="'+iid+'" data-dir="down" aria-label="下移这张图"'+(item.canMoveDown&&!busy?'':' disabled'))+'</span>':'')
      +'<span class="iwb-card-group is-end" role="group" aria-label="跳过或删除">'+(item.status==='skipped'?btn('恢复','studio-wb-restore',false,'data-item="'+iid+'"'+dis):btn('跳过','studio-wb-skip',false,'data-item="'+iid+'"'+dis))+cbtn('删除','studio-wb-remove','iwb-danger','data-item="'+iid+'" aria-label="删除这张图"'+dis)+'</span></div>'
      +(item.strategy==='ai_generate'&&!item.current&&item.status!=='skipped'?'<p class="iwb-card-hint">在「怎么改这张图？」里点「生成这张」，确认渠道和次数后才会提交。</p>':'')+'</div>');
    return '<li class="iwb-card'+(focused?' is-focused':'')+' is-'+item.status+'" data-item="'+iid+'"'+(body&&!busy?' draggable="true"':'')+'>'+summary+edit+'</li>';
  }
  private markSvg(m:StudioMark,H:number,pending=false):string{
    const cls='iwb-mark'+(pending?' is-pending':'');let s='';
    if(m.type==='rect')s='<rect class="'+cls+' is-rect" x="'+m.x+'" y="'+m.y+'" width="'+m.w+'" height="'+m.h+'" rx="5"/>';
    if(m.type==='brush')s='<path class="'+cls+' is-brush" d="'+esc(m.path)+'"/>';
    if(m.type==='arrow')s='<path class="'+cls+' is-arrow" d="M'+m.x+' '+m.y+' L'+m.ex+' '+m.ey+'" marker-end="url(#iwb-arrow-tip)"/>'+(pending?'':'<path class="iwb-mark-hit" d="M'+m.x+' '+m.y+' L'+m.ex+' '+m.ey+'"/>');
    if(m.type==='text')s='<rect class="'+cls+' is-text" x="'+(m.x-6)+'" y="'+(m.y-6)+'" width="12" height="12" rx="2"/>';
    const r=Math.max(12,H/60);return s+(pending?'':'<circle class="iwb-mark-badge" cx="'+m.x+'" cy="'+m.y+'" r="'+r+'"/><text class="iwb-mark-num" x="'+m.x+'" y="'+(m.y+r*.38)+'" font-size="'+r*1.05+'" text-anchor="middle">'+m.id+'</text>');
  }
  /** 生成中的舞台占位：生图加载动效分支可经宿主 renderLoading 接入，未接入时显示文字占位。 */
  protected renderLoading(item:PlanItemVM,width:number,height:number):string{
    const gen=this.loaderFor(item);if(gen){this.loaderPlan.set(item.id,gen);return '<span class="iwb-gen-loader" data-gen-item="'+esc(item.id)+'"></span>';}
    const images=item.versions.map(v=>this.host.imageUrl(v)).filter((u):u is string=>!!u).slice(-4);
    return this.host.renderLoading?.({id:item.id,caption:item.caption,width,height,images})??'<div class="iwb-loading" role="status"><span class="iwb-loading-dot" aria-hidden="true"></span><b>'+esc(item.current?'正在生成修改版…':'正在生成这张图…')+'</b><small>完成后出现在版本条，旧版保留</small></div>';
  }
  /** 方案项此刻要不要显示生图动效：有进行中的版本就按真实状态（running 才循环）；刚结束的那一版成功且真图已读到时揭示到真图，失败则回到普通占位。 */
  private loaderFor(item:PlanItemVM):{opts:LoaderOptions;version:string|null}|null{
    if(!this.loaderMount||item.status==='skipped')return null;
    const entry=this.loaders.get(item.id),active=[...item.versions].reverse().find(v=>!v.asset_id&&ACTIVE_VERSION.includes(v.state));
    if(active||item.status==='generating'){
      const size=active?.requested??{width:Number(item.aspect.split(':')[0])||1,height:Number(item.aspect.split(':')[1])||1},parent=active?.parent_version_id?item.versions.find(v=>v.id===active.parent_version_id):undefined;
      const images=[parent,...[...item.versions].reverse()].map(v=>v?this.host.imageUrl(v):undefined).filter((u,i,a):u is string=>!!u&&a.indexOf(u)===i).slice(0,4);
      return {opts:{state:active?.state==='running'?'running':'queued',images,width:size.width,height:size.height,label:active?LOADER_LABELS[active.state]??'排队中':'排队中',...studioLoaderProgress(active,item.versions,v=>this.host.imageUrl(v))},version:active?.id??null};
    }
    if(!entry||entry.done)return null;
    const target=entry.version?item.versions.find(v=>v.id===entry.version):undefined;
    // 失败 / 取消 / 结果不明：没有可显示的图时停在最后一帧并写明原因（有旧图时舞台照常显示旧图）。
    if(target&&['failed','cancelled','unknown'].includes(target.state))return this.shown(item)?null:{opts:{...entry.opts,state:'failed',label:studioLoaderFailure(target)},version:entry.version};
    if(!target||!['succeeded','size_mismatch'].includes(target.state))return null;
    // 揭示到舞台实际要显示的那一版（当前版或明确的预览版）；新版只作候选、或本人在看别的版本时不揭示，直接按舞台显示。
    if(this.shown(item)?.id!==target.id)return null;
    const url=this.host.imageUrl(target);
    return url?{opts:{...entry.opts,state:'succeeded',images:[...entry.opts.images.filter(i=>i!==url),url],label:'已生成'},version:entry.version}:{opts:entry.opts,version:entry.version};
  }
  private attachLoaders(root:HTMLElement){
    const mount=this.loaderMount;if(!mount)return;const doc=this.host.root.ownerDocument,seen=new Set<string>();
    for(const host of Array.from(root.querySelectorAll<HTMLElement>('[data-gen-item]'))){
      const id=host.dataset.genItem??'',plan=this.loaderPlan.get(id);if(!plan)continue;seen.add(id);
      let entry=this.loaders.get(id);if(entry&&(entry.done||(plan.version&&entry.version&&plan.version!==entry.version&&plan.opts.state!=='succeeded'))){entry.handle.dispose();this.loaders.delete(id);entry=undefined;}
      const opts:LoaderOptions={...plan.opts,onRevealed:()=>{const e=this.loaders.get(id);if(e)e.done=true;queueMicrotask(()=>{if(this.openTopic)this.render();});}};
      if(!entry){const node=doc.createElement('div');node.className='iwb-gen-loader-node';entry={node,handle:mount.mount(node,opts),done:false,version:plan.version,opts:plan.opts};this.loaders.set(id,entry);}
      else{entry.opts=plan.opts;entry.version=plan.version??entry.version;entry.handle.update(opts);}
      host.append(entry.node);
    }
    for(const [id,entry] of this.loaders)if(!seen.has(id)){entry.handle.dispose();this.loaders.delete(id);}
  }
  private disposeLoaders(){for(const entry of this.loaders.values())entry.handle.dispose();this.loaders.clear();this.loaderPlan.clear();}

  private center():string{
    const vm=this.vm!;
    if(!vm.items.length){const body=vm.state==='planning'?'<div class="iwb-progress-slot"></div>':'<div class="iwb-empty-canvas"><p>方案出来后，在这里逐张查看、标注和修改配图。</p>'+btn(vm.state==='failed'?'重新规划':'让 AI 规划配图','studio-wb-replan',true,this.working.has('run')?'disabled':'')+'</div>';return '<section class="iwb-stage-col" aria-label="配图编辑台"><div class="iwb-canvas">'+body+'</div></section>';}
    const item=this.item();if(!item)return '<section class="iwb-stage-col" aria-label="配图编辑台"><p class="iwb-note">在左栏选一张图开始编辑。</p></section>';
    const shown=this.shown(item),url=shown?this.host.imageUrl(shown):undefined,busy=this.working.has('item:'+item.id),marks=this.markList(item.id),canMark=!!url&&item.status!=='skipped'&&!this.loaderFor(item);
    const genPlan=this.loaderFor(item),w=genPlan?.opts.width||shown?.actual.width||Number(item.aspect.split(':')[0])||16,h=genPlan?.opts.height||shown?.actual.height||Number(item.aspect.split(':')[1])||9,H=this.viewHeight(shown??null);
    const head='<div class="iwb-editor-head"><div class="iwb-editor-title"><h3>'+esc(item.roleLabel)+'</h3>'+(shown?'<span class="iwb-badge">'+esc(this.versionLine(item,shown))+'</span>':'<span class="iwb-badge">还没有图</span>')+'</div>'+'<div class="iwb-editor-actions">'+cbtn('版本对比','studio-wb-compare','iwb-ghost',(shown&&item.versions.filter(v=>v.asset_id).length>1?'':'disabled ')+'data-item="'+esc(item.id)+'"')+cbtn('删除图片位','studio-wb-remove','iwb-ghost iwb-remove-slot','data-item="'+esc(item.id)+'" aria-label="'+esc('删除图片位：'+item.roleLabel)+'"'+(busy?' disabled':''))+'</div></div>';
    const tools='<div class="iwb-toolbar" role="toolbar" aria-label="图片标注工具">'+TOOLS.map(([t,label])=>'<button type="button" class="iwb-tool'+(this.tool===t?' is-active':'')+'" data-action="studio-wb-tool" data-tool="'+t+'" aria-pressed="'+(this.tool===t)+'"'+(canMark?'':' disabled')+'>'+esc(label)+'</button>').join('')+'<span class="iwb-tool-divider" aria-hidden="true"></span><button type="button" class="iwb-tool" data-action="studio-wb-undo"'+(marks.length||this.markHistory.get(this.markKey(item.id))?.length?'':' disabled')+'>撤销</button><button type="button" class="iwb-tool iwb-tool-end" data-action="studio-wb-clear-marks"'+(marks.length?'':' disabled')+'>清除标注</button></div>';
    const picked=this.selectedKey===this.markKey(item.id)?this.selectedMark:0,pickedMark=picked?marks.find(m=>m.id===picked):undefined;
    const svg=url?'<svg id="studio-wb-marks" tabindex="-1" class="iwb-marks'+(this.tool!=='select'?' is-drawing':' is-select')+'" viewBox="0 0 1000 '+H+'" data-h="'+H+'" preserveAspectRatio="none" role="img" aria-label="'+esc(marks.length?'画面标注 '+marks.length+' 处':'画面标注')+'"><defs><marker id="iwb-arrow-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path class="iwb-mark-tip" d="M0 0 L10 5 L0 10 z"/></marker></defs>'+marks.map(m=>'<g class="iwb-mark-g'+(m.id===picked?' is-selected':'')+'" data-mark="'+m.id+'">'+this.markSvg(m,H)+'</g>').join('')+'<g class="iwb-handles"></g><g class="iwb-pending"></g></svg>':'';
    const loading=item.status==='generating'||busy&&!url;
    // 生成中 / 修改版生成中：有加载器时整块换成像素马赛克（以原图为素材），成功后揭示到新图；没有加载器时原图上叠文字占位。
    const gen=!!genPlan;
    const art=gen?this.renderLoading(item,w,h):url?'<img src="'+esc(url)+'" alt="'+esc(item.caption)+'" width="'+w+'" height="'+h+'" draggable="false">'+svg+(item.status==='generating'?'<div class="iwb-stage-loading">'+this.renderLoading(item,w,h)+'</div>':''):loading?this.renderLoading(item,w,h):'<span class="iwb-placeholder"><b>'+esc(shown?'正在读取图片…':item.statusLabel)+'</b><span>'+esc(item.strategyLabel+' · '+ASPECT_LABELS[item.aspect])+'</span><small>'+esc(shown?'':'在右栏生成、换来源或上传第一版')+'</small></span>';
    const stage='<div class="iwb-stage"><div class="iwb-art" style="aspect-ratio:'+w+'/'+h+';width:min(100%,calc(var(--iwb-stage-h) * '+(w/h).toFixed(4)+'))">'+art+'</div></div>'+(pickedMark&&canMark?'<div class="iwb-stage-hint is-selected" role="status"><span>'+esc('已选中标注 '+pickedMark.id+'（'+MARK_LABELS[pickedMark.type]+'）：'+(pickedMark.type==='rect'?'拖动可移动，拖四角或四边改大小':pickedMark.type==='arrow'?'拖动可移动，拖两端改方向和长短':'拖动可移动')+'；按 Delete 也能删除')+'</span>'+cbtn('删除这处标注','studio-wb-mark-delete','iwb-danger iwb-mark-delete','data-mark="'+pickedMark.id+'" aria-label="删除标注'+pickedMark.id+'"')+'</div>':'<p class="iwb-stage-hint" role="status">'+esc(canMark?TOOL_HINTS[this.tool]:'有图之后可以框选、涂抹、加箭头或改文字，标注只用来说明修改，不进入成品')+'</p>');
    const size=shown?'<span>'+esc((item.position==='cover'?'文章封面':'正文配图')+' · '+shown.actual.width+' × '+shown.actual.height+' px · '+studioRatioLabel(studioAspect(shown.actual.width,shown.actual.height)))+'</span>':'<span>'+esc('拟用画幅 · '+ASPECT_LABELS[item.aspect])+'</span>';
    const footer='<div class="iwb-canvas-footer">'+size+cbtn('调整画幅 / 尺寸','studio-wb-resize','iwb-ghost','data-item="'+esc(item.id)+'"'+(shown&&!item.blocked&&!busy?'':' disabled'))+'<span class="iwb-mark-count">'+esc(marks.length?marks.length+' 处标注 · 批注不进入成品':'无标注 · 按图片比例显示')+'</span></div>';
    const notes=marks.length?'<ol class="iwb-annotations" aria-label="标注清单">'+marks.map(m=>'<li class="iwb-annotation"'+(m.id===picked?' data-selected="true"':'')+'><button type="button" class="iwb-annotation-num" id="studio-wb-mark-pick-'+m.id+'" data-action="studio-wb-mark-select" data-mark="'+m.id+'" aria-pressed="'+(m.id===picked)+'" aria-label="选中标注'+m.id+'">'+m.id+'</button><small class="iwb-annotation-type">'+esc(MARK_LABELS[m.type])+'</small><input class="field" id="studio-wb-mark-'+m.id+'" maxlength="'+(m.type==='text'?200:300)+'" aria-label="'+esc('标注'+m.id+(m.type==='text'?'处改成的文字':'的修改要求'))+'" placeholder="'+(m.type==='text'?'这里的文字改成…':'描述这处怎么改')+'" value="'+esc(m.type==='text'?m.text??'':m.note)+'"><button type="button" class="iwb-annotation-remove" data-action="studio-wb-mark-remove" data-mark="'+m.id+'" aria-label="删除标注'+m.id+'">×</button></li>').join('')+'</ol>':'';
    const versions='<div class="iwb-versions"><div class="iwb-sub-head"><b>修改版本</b><small>选一个版本查看，也可以回到旧版</small></div>'+(item.versions.length?'<div class="iwb-version-row">'+item.versions.map((v,i)=>{const vurl=this.host.imageUrl(v),usable=!!v.asset_id&&['succeeded','size_mismatch'].includes(v.state),selected=shown?.id===v.id;return '<button type="button" class="iwb-version'+(selected?' is-selected':'')+'" data-action="studio-wb-version" data-item="'+esc(item.id)+'" data-version="'+esc(v.id)+'" aria-pressed="'+selected+'"'+(usable?'':' disabled')+'>'+(vurl?'<img src="'+esc(vurl)+'" alt="">':'<span class="iwb-version-empty" aria-hidden="true"></span>')+'<span><b>v'+(i+1)+' · '+esc(versionTag(v))+'</b><small>'+esc(usable?v.actual.width+' × '+v.actual.height:'')+(item.current?.id===v.id?' · 当前':'')+(selected?' · 查看中':'')+'</small></span></button>';}).join('')+'</div>':'<p class="fine iwb-empty-versions">还没有版本；生成、换来源或上传后会出现在这里，可以随时回到旧版。</p>')+(this.preview.has(item.id)?'<div class="iwb-adopt-row">'+btn('采用这一版','studio-wb-adopt',true,'data-item="'+esc(item.id)+'"'+(busy?' disabled':''))+'<small>采用后文章里换成这一版，其他版本保留。</small></div>':item.current?'<div class="iwb-adopt-row"><span class="iwb-adopted" role="status">当前采用 · v'+item.currentIndex+'</span><small>排版用这一版；点别的版本可以改用。</small></div>':'')+'</div>';
    // 版本条紧跟舞台（1440 首屏可见），标注清单在其后。
    return '<section class="iwb-stage-col" aria-label="配图编辑台"><div class="iwb-editor">'+head+tools+stage+footer+'</div>'+versions+(notes?'<div class="iwb-editor iwb-notes">'+notes+'</div>':'')+'</section>';
  }
  private article(insert=false):string{
    const vm=this.vm!;
    return '<article class="iwb-article"><h1>'+esc(vm.title)+'</h1>'+vm.canvas.map(block=>{
      if(block.kind==='paragraph')return '<p class="iwb-paragraph" data-paragraph="'+block.index+'">'+esc(block.text).replace(/\n/g,'<br>')+'</p>'+(insert?'<button type="button" class="iwb-insert-here" data-action="studio-wb-insert" data-place="after:'+esc(block.id)+'" aria-label="'+esc('在第 '+(block.index+1)+' 段后面插入图片位')+'">＋ 在这里插入图片位</button>':'');
      const item=block.item,v=this.shown(item),url=v?this.host.imageUrl(v):undefined,ratio=v?v.actual.width+'/'+v.actual.height:item.aspect.replace(':','/');
      const media=url?'<img src="'+esc(url)+'" alt="'+esc(item.caption)+'" width="'+v!.actual.width+'" height="'+v!.actual.height+'">':'<span class="iwb-placeholder" style="aspect-ratio:'+esc(ratio)+'"><b>'+esc(v?'正在读取图片…':item.statusLabel)+'</b><span>'+esc(item.strategyLabel+' · '+ASPECT_LABELS[item.aspect])+'</span></span>';
      return '<figure class="iwb-figure'+(item.position==='cover'?' is-cover':'')+'">'+media+'<figcaption class="iwb-figcaption"><span>'+esc(item.caption)+'</span>'+(v?.source?'<small>'+esc(v.source.credit)+'</small>':'')+'</figcaption></figure>';
    }).join('')+'</article>';
  }
  // 修改渠道：只有支持在原图上修改的 AGY 可选；Codex 生图在下拉里写明不支持并禁用。
  private editProviderSelect(id='studio-wb-provider'){const agy=this.capability('agy'),codex=this.capability('codex'),o=agy?studioProviderOption(agy):{text:'AGY 生图 · 暂不可用',disabled:true};return '<label class="configuration-field" for="'+id+'"><span>修改用的渠道</span><select class="field" id="'+id+'"><option value="agy" selected'+(o.disabled?' disabled':'')+'>'+esc(o.text)+'</option>'+(codex?'<option value="codex" disabled>Codex 生图 · 不支持在原图上修改</option>':'')+'</select></label>';}
  private right():string{
    const item=this.item(),plan=this.plan!;
    const headBar='<div class="iwb-col-head"><h3>怎么改这张图？</h3><span class="iwb-badge">品牌规范已带入</span></div>';
    if(!item)return '<aside class="iwb-edit" aria-label="怎么改这张图">'+headBar+'<p class="iwb-note">方案出来后，点左边的图，在这里修改。</p></aside>';
    const busy=this.working.has('item:'+item.id),dis=busy?' disabled':'',shown=this.shown(item),edit=!!shown,cap=this.capability(),iid=esc(item.id),marks=this.markList(item.id);
    const agyReady=studioProviderReady(this.capability('agy')),providerBlocked=!studioProviderReady(cap),none=this.noProvider();
    const providers=(edit?this.editProviderSelect():this.providerSelect('studio-wb-provider',this.provider))+this.modelField(edit?'agy':this.provider,'studio-wb-model');
    const tabs='<div class="iwb-tabs" role="tablist" aria-label="修改方式">'+([['modify','修改要求'],['sources','网络找图'],['refs','上传图片']] as const).map(([t,label])=>'<button type="button" role="tab" class="iwb-tab'+(this.tab===t?' is-active':'')+'" data-action="studio-wb-tab" data-tab="'+t+'" aria-selected="'+(this.tab===t)+'">'+esc(label)+(t==='modify'&&marks.length?' <small aria-label="'+marks.length+' 处标注">· '+marks.length+'</small>':'')+'</button>').join('')+'</div>';
    const aspect='<label class="configuration-field" for="studio-wb-aspect"><span>画幅</span><select class="field" id="studio-wb-aspect"'+dis+'>'+(Object.entries(ASPECT_LABELS) as Array<[string,string]>).filter(([k])=>!cap||cap.sizes.some(s=>s.id===k)).map(([k,v])=>'<option value="'+esc(k)+'"'+(k===item.aspect?' selected':'')+'>'+esc(v)+'</option>').join('')+'</select></label>';
    const chips='<div class="iwb-chips" role="group" aria-label="快捷修改"><button type="button" class="iwb-chip-btn" data-action="studio-wb-chip" data-chip="marked"'+(edit&&marks.length?'':' disabled aria-describedby="iwb-marked-why"')+'>只改标注区域</button><button type="button" class="iwb-chip-btn" data-action="studio-wb-chip" data-chip="space"'+(edit?'':' disabled')+'>增加留白</button><button type="button" class="iwb-chip-btn" data-action="studio-wb-chip" data-chip="brand"'+(edit?'':' disabled')+'>保留品牌元素</button></div>'+(edit&&!marks.length?'<p class="iwb-hint iwb-hint-left" id="iwb-marked-why">在图上标注后可用「只改标注区域」。</p>':'');
    const promptBlock=edit?'':'<label class="configuration-field" for="studio-wb-prompt"><span>画面说明（AI 草稿，可改）</span><textarea class="field" id="studio-wb-prompt" rows="4"'+dis+'>'+esc(this.prompts.get(item.id)??item.prompt)+'</textarea></label>'+aspect;
    const request='<label class="configuration-field" for="studio-wb-request"><span>描述你的修改 <small>也可以结合画面标注</small></span><textarea class="field" id="studio-wb-request" rows="3"'+(edit?'':' disabled aria-describedby="iwb-request-why"')+' placeholder="'+(edit?'例如：人物缩小一点，标题突出；框选区域换成浅色背景。':'生成、换来源或上传得到第一版后，可在这里写修改要求')+'">'+esc(this.requests.get(item.id)??'')+'</textarea></label>'+chips+(edit?'':'<p class="iwb-hint" id="iwb-request-why">这张还没有图：先生成第一版，再写修改要求或在图上标注。</p>');
    const brand='<div class="iwb-brand"><span class="iwb-brand-mark" aria-hidden="true">W</span><div><b>工作台 · 全平台共用</b><small>自定义参考图 / 配色 / 系统字体</small></div></div>';
    const blockedHint=item.blocked&&item.status!=='generating'?'<p class="iwb-hint">这张图上次的任务结果还在核对，暂时不能再生成或修改。</p>':'';
    const primary=item.status==='skipped'?'<p class="iwb-note">这张已跳过，恢复后才能生成或修改。</p>':edit?cbtn(busy?'正在入队…':item.status==='generating'?'生成中…':'生成修改版','studio-wb-edit','primary iwb-primary','data-item="'+iid+'"'+(busy||!agyReady||item.blocked?' disabled':''))+(blockedHint||(!agyReady?'<p class="iwb-hint">修改需要 AGY 生图；它当前不可用或次数已用完，可在设置里放开。</p>':'<p class="iwb-hint">以当前这一版为原图生成新版本'+(marks.length?'，'+marks.length+' 处标注会写进说明':'')+'；点击后先确认再提交，旧版保留可回退。</p>')):cbtn(busy?'正在入队…':item.status==='generating'?'生成中…':'生成这张','studio-wb-generate','primary iwb-primary','data-item="'+iid+'"'+(busy||!item.canGenerate||providerBlocked?' disabled':''))+(blockedHint||(none?'':'<p class="iwb-hint">'+(providerBlocked?'所选渠道暂不可用或生图次数已用完，可换渠道或在设置里放开次数。':'点击后先确认渠道、模型和张数再提交；每张用一次生图次数。生图剩余：'+esc(budgetLine(plan.budget))+'。')+'</p>'));
    const modify='<div class="iwb-pane" role="tabpanel">'+promptBlock+request+brand+primary+'</div>';
    const pool=(this.candidates??[]).slice().sort((a,b)=>Number((b.group==='article')===(item.strategy==='article_original'))-Number((a.group==='article')===(item.strategy==='article_original'))).slice(0,8);
    const recover=this.studio?recoverableVersions(this.vm?.items??[],this.studio):[];
    const recoverBlock=recover.length?'<div class="iwb-recover"><div class="iwb-sub-head"><b>已删除配图的图片</b><small>找回后作为这张图的新一版</small></div><div class="iwb-candidates">'+recover.slice(0,12).map(r=>{const u=this.host.imageUrl(r.version);return '<div class="iwb-candidate"><span class="iwb-candidate-thumb">'+(u?'<img src="'+esc(u)+'" alt="'+esc(r.title)+'">':'图片读取中')+'</span><b>'+esc(r.title)+'</b><small>'+esc(versionTag(r.version))+'</small>'+btn('找回到这里','studio-wb-recover',false,'data-item="'+iid+'" data-version="'+esc(r.version.id)+'"'+(busy||item.status==='skipped'||item.blocked?' disabled':''))+'</div>';}).join('')+'</div></div>':'';
    const sources='<div class="iwb-pane" role="tabpanel"><div class="iwb-sources"><div class="iwb-sub-head"><b>网络图片</b>'+(shown?btn('清除当前图','studio-wb-clear',false,'data-item="'+iid+'"'+dis):'')+'</div>'+(this.candidates===undefined?'<p class="fine" role="status">正在读取网络候选…</p>':this.captureLine()+(!pool.length?(this.candidateCapture?.refreshing||this.candidatesError?'':'<p class="fine">这个主题还没有可用的网络图片，可以用 AI 生成或上传。</p>'):'<div class="iwb-candidates">'+pool.map(c=>{const same=!!shown?.source&&shown.source.image_url===c.image_url;return '<div class="iwb-candidate'+(c.selectable?'':' is-disabled')+'"><span class="iwb-candidate-thumb"><img src="'+esc(c.thumb_url)+'" alt="'+esc(c.credit)+'" loading="lazy" referrerpolicy="no-referrer"></span><b>'+esc(c.credit)+'</b><small>'+esc(c.group==='article'?'原文 / 官方图':'同题帖子图')+'</small>'+btn(same?'当前来源':c.selectable?'换成这张':'已过期','studio-wb-swap',false,'data-item="'+iid+'" data-candidate="'+esc(c.id)+'"'+(c.selectable&&!busy&&!same&&item.status!=='skipped'?'':' disabled'))+'</div>';}).join('')+'</div>'))+'</div>'+recoverBlock+'</div>';
    const purposes=(Object.entries(UPLOAD_PURPOSE_LABELS) as Array<[StudioUploadPurpose,string]>).map(([k,v])=>'<option value="'+k+'"'+(k===this.uploadPurpose?' selected':'')+'>'+esc(v)+'</option>').join('');
    const upDisabled=busy||item.status==='skipped'||item.blocked||!this.host.upload;
    const refs='<div class="iwb-pane" role="tabpanel"><div class="iwb-refs"><label class="configuration-field" for="studio-wb-upload-purpose"><span>这张图的用途</span><select class="field" id="studio-wb-upload-purpose">'+purposes+'</select></label><button type="button" class="iwb-upload" data-action="studio-wb-upload" data-item="'+iid+'"'+(upDisabled?' disabled':'')+'><b>＋ 上传图片作为新一版</b><small>PNG、JPG 或 WebP，15MB 以内</small></button><p class="fine">上传的图片成为这张图的新一版：可以直接采用，也可以在它上面标注、生成修改版。用途只作记录，不会混合多张参考图。</p></div></div>';
    return '<aside class="iwb-edit" aria-label="怎么改这张图">'+headBar+'<div class="iwb-edit-body"><p class="iwb-focus-title"><b>'+esc(item.roleLabel)+'</b><span>'+esc(item.caption)+'</span>'+(item.credit&&!this.preview.has(item.id)?'<small>'+esc(item.credit)+(item.autoSelected?' · AI 选中，可换':'')+'</small>':'')+'</p>'+providers+tabs+(this.tab==='modify'?modify:this.tab==='sources'?sources:refs)+'</div></aside>';
  }
}
