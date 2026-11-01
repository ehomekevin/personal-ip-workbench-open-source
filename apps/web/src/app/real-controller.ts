import {ImageStudioController,mountImageStep,hideGenericImageEntry} from './lazy-features.ts';
import '../features/media/image-generation.css';
import {ImageGenerationController} from '../features/media/image-generation.ts';
import {ViewpointsController} from '../features/create/viewpoints/index.ts';
import {SpeechInputController} from './lazy-features.ts';
import { GenerationProgressMount } from '../components/generation-progress-mount.tsx';
import { ArticleLayoutPanel } from '../features/media/article-layout/c1-panel.tsx';
import { mountImageLoader } from '../components/image-generation-loader-mount.ts';
import {WritingFlowController} from '../features/create/writing-flow/index.ts';
import { SkillSettingsController } from './lazy-features.ts';
import type {ServiceIdentity,SettingsResponse,WorkbenchPage,OpenWorkbenchRequest,PublishingSettingsLocation,Platform,TopicDetail,Page} from '@workbench/contracts';
import {ContractError} from '@workbench/contracts';
import {mountHomeFlow} from '../components/homeFlow.ts';
import {NAV} from '../components/metadata.ts';
import {createTemplateHelpers} from '../components/templateHelpers.ts';
import {createApprovedPageViews} from '../pages/approvedViews.ts';
import {initialUi} from './view-model.ts';
import type {ViewContext} from './view-model.ts';
import {scopedDom} from './dom.ts';
import type {ControlElement} from './dom.ts';
import {parsePage,type ForegroundDismissReason} from '../transport/feature-ports.ts';
import type {FeatureAction,FeatureContext,UiSurface,WorkbenchInjection} from '../transport/feature-ports.ts';
import {TaskDialogSession,bindPageHide} from '../transport/task-dialog.ts';
import type {DialogCloseReason} from '../transport/task-dialog.ts';
import {renderSettings} from '../features/settings/settings.ts';
import {ConfigurationController} from './lazy-features.ts';
import {isFeatureOperation} from '../transport/approved-operations.ts';
import {showIngestSearch} from '../features/sources/read/index.ts';
import {DraftRegistry} from '../transport/drafts.ts';
import {renderOperationsPanel} from '../features/operations/index.ts';
import {mountOperationsFlow} from '../features/operations/flow-motion.ts';
import {PublishingSettingsController} from './lazy-features.ts';
import {parseWorkbenchLocation,parseWorkbenchView,workbenchLocationHash,workbenchViewHash,type WorkbenchView} from '../transport/workbench-location.ts';
import {P} from '../components/metadata.ts';
import {createReadScope} from '../transport/read-scope.ts';
import {createNavigationCache,READ_ONLY_NAVIGATION_ACTIONS} from '../transport/navigation-cache.ts';
import {invalidateManualAccountDialog,notifyManualAccountDialogPresentation} from '../features/sources/accounts-manual/lazy.ts';

export function mountReal(root:HTMLElement,injection:WorkbenchInjection){
  const abort=new AbortController(),signal=abort.signal,document=scopedDom(root,signal);
  // 真实工作台专属的外壳样式（如小屏底部导航）；演示模式保持与批准原型逐像素一致。
  root.classList.add('workbench-real');
  const cache=injection.client?createNavigationCache(injection.client):undefined,client=cache?.client;
  let navigationReads=new AbortController();
  let initialLocation:OpenWorkbenchRequest;
  try{initialLocation=injection.initialLocation??(injection.initialPage?{page:injection.initialPage}:parseWorkbenchLocation(location.hash));}catch{initialLocation={page:'settings'};}
  const ui=initialUi(initialLocation.page);
  // 创作页子位置（页签/平台/配图或排版）随地址保存，刷新后回到同一处；pendingView 在对应主题读完后套用一次。
  let variantPlatform:string|undefined;
  let pendingView:WorkbenchView|undefined=injection.initialLocation||injection.initialPage?undefined:parseWorkbenchView(location.hash);
  let currentLocation:OpenWorkbenchRequest=initialLocation;
  let publishingLocation:PublishingSettingsLocation|undefined;
  let publishingReturn:{location:OpenWorkbenchRequest;ui:typeof ui;dialogHtml:string;drawer:boolean}|undefined;
  const publisher=client?new PublishingSettingsController({root,client:client,signal,identity:()=>identity,render,toast,navigate:target=>navigate(target),hasReturn:()=>!!publishingReturn,returnToPublishing:()=>void returnToPublishing()}):undefined;
  const skills=client?new SkillSettingsController({root,client:client,signal,context,render,active:()=>currentLocation.settings_view==='skills',navigateSkills:()=>void navigate({page:'settings',settings_view:'skills'}),navigateSettings:()=>void navigate('settings'),toast}):undefined;
  const configuration=client?new ConfigurationController({root,client:client,signal,settings:()=>settings,setSettings:value=>{settings=value;},preferencesChanged:value=>{retroDefaultsLoaded=false;ui.defaultRetroPeriod=value.retro_days;},context,render,toast,navigate:platform=>void navigate({page:'settings',settings_view:'publishing',platform})}):undefined;
  const writing=client?new WritingFlowController({root,context,render,active:()=>ui.page==='create'}):undefined;
  const speech=client?new SpeechInputController({root,client:client,signal,context,render,toast}):undefined;
  // 公众号配图挂在「平台版本 · 公众号」的配图步骤里；分镜与素材页签只保留通用素材与图像任务。
  const studioActive=()=>ui.page==='create'&&ui.editTab==='versions'&&ui.platform==='wechat';
  const studio=client?new ImageStudioController({root,context,active:studioActive,signal,toast,assetsChanged:refreshImageAssets,progressMount:()=>new GenerationProgressMount(),imageLoader:()=>({mount:mountImageLoader}),layoutPanel:host=>new ArticleLayoutPanel({root,context,active:studioActive,signal,toast,backToImages:host.backToImages,clearToast:()=>{clearTimeout(toastTimer);const region=document.getElementById('toast-region');if(region)region.innerHTML='';}})}):undefined;
  const images=client?new ImageGenerationController({root,context,active:()=>ui.page==='create'&&ui.editTab==='assets',signal,toast,assetsChanged:refreshImageAssets}):undefined;
  const viewpoints=client?new ViewpointsController({root,context,active:()=>ui.page==='create'&&ui.editTab==='core',generate:snapshot=>writing!.generateFromViewpoints(snapshot),speak:(topicId,onAdopt)=>{void speech?.openForTopic({topicId,title:view?.state.topics.find(t=>t.id===topicId)?.title??'本题观点',onAdopt}).catch(error=>toast(error instanceof Error?error.message:'语音输入未打开'));}}):undefined;
  let retroDefaultsLoaded=false,settingsReady=false,speechSettingsReady=false;
  const {icon,btn,iconBtn,esc}=createTemplateHelpers([]);
  let identity:ServiceIdentity|undefined,settings:SettingsResponse|undefined,view:ViewContext|undefined,revision=0,actionRevision=0,loading=false,stale=false,loadError:string|undefined;
  let settingsQueue:Promise<void>=Promise.resolve(),toastTimer:ReturnType<typeof setTimeout>|undefined;
  let drafts:DraftRegistry|undefined;
  let flowCleanup:(()=>void)|undefined;
  const operationsFlowCleanup=mountOperationsFlow(root);
  let foreground:{id:string;version:number;keepOnDismiss?:boolean}|undefined,selectionRestored=false;
  const selectionKey=()=>identity?'workbench-selection:'+identity.workspace_id+':'+identity.service_instance_id:null;
  function saveSelection(){const key=selectionKey();if(key&&ui.topic)localStorage.setItem(key,ui.topic);}
  const generationProgress=new GenerationProgressMount();let progressShell:{body:string;foot?:string}|undefined;
  // 批量生成的前台任务：关闭、Esc、导航只停止跟随；只有显式“取消任务”才取消。
  let lastClose:{id:string;reason:ForegroundDismissReason}|undefined;
  const task=new TaskDialogSession(async reason=>{const job=foreground;foreground=undefined;if(job)lastClose={id:job.id,reason};if(job?.keepOnDismiss&&reason!=='cancel')return;if(job&&client)try{for(let retry=0;retry<3;retry++){try{await client.cancelJob(job.id,job.version,{idempotencyKey:crypto.randomUUID()});break;}catch(error){const code=error&&typeof error==='object'&&'response' in error?String((error as {response:{error:{code:string}}}).response.error.code):'';if(code!=='VERSION_CONFLICT'||retry===2)throw error;const current=await client.request<{job:{version:number;state:string}}>('GET','/api/v1/jobs/'+encodeURIComponent(job.id));if(['succeeded','failed','cancelled'].includes(current.job.state)){toast('任务已进入终态，结果请在服务记录中核对');break;}job.version=current.job.version;}}}catch(error){toast(error instanceof Error?error.message:'取消请求失败，任务状态待核对');}});
  function toast(message:string){clearTimeout(toastTimer);document.getElementById('toast-region').innerHTML='<div class="toast">'+esc(message)+'</div>';toastTimer=setTimeout(()=>{document.getElementById('toast-region').innerHTML='';},3300);}
  function closeDialog(reason:DialogCloseReason='user_close'){studio?.close(reason);images?.close(reason);if(client)invalidateManualAccountDialog(client);speech?.close();generationProgress.dispose();writing?.close();void task.close(reason);if(reason==='completed')foreground=undefined;document.getElementById('dialog').close();}
  const surface:UiSurface={dialogBusy(busy){for(const field of document.getElementById('dialog').querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('input,textarea,select')){if(busy){field.dataset.operationsDisabled=String(field.disabled);field.disabled=true;}else if(field.dataset.operationsDisabled!==undefined){field.disabled=field.dataset.operationsDisabled==='true';delete field.dataset.operationsDisabled;}}},isForegroundJobActive(jobId){return foreground?.id===jobId&&task.isActive()&&document.getElementById('dialog').open;},foregroundCloseReason(jobId){return lastClose?.id===jobId?lastClose.reason:undefined;},updateUi(patch){if(patch.topic!==undefined&&patch.topic!==ui.topic){studio?.deactivate();images?.deactivate();speech?.close();viewpoints?.deactivate();}if(patch.editTab!==undefined&&patch.editTab!=='core'){speech?.close();viewpoints?.deactivate();}Object.assign(ui,patch);if(patch.topic!==undefined)saveSelection();render();},editorFeedback(feedback){if(feedback.coreStatus?.startsWith('已修改')&&view?.projections.operations){view.projections.operations.coreConfirmed=false;view.projections.operations.variantCount=0;const panel=root.querySelector('.operations-panel');if(panel)panel.outerHTML=renderOperationsPanel({...view,ui});}const save=document.querySelector('#save-state'),core=document.querySelector('#core-status'),generate=document.querySelector('[data-action="generate-versions"]'),confirm=document.querySelector('[data-action="confirm-core"]');if(save&&feedback.saveState!==undefined)save.textContent=feedback.saveState;if(core&&feedback.coreStatus!==undefined)core.textContent=feedback.coreStatus;if(generate&&feedback.generationEnabled!==undefined)generate.disabled=stale||!feedback.generationEnabled;if(confirm&&feedback.confirmationLabel!==undefined)confirm.textContent=feedback.confirmationLabel;/* 空核心稿不能确认：保存反馈后按编辑框当前内容重新算一次（首屏空稿渲染为禁用，写入并保存后要解除）。 */const editor=document.querySelector('#core-editor');if(confirm&&editor)confirm.disabled=stale||!editor.value.trim();},toast,closeDialog,navigate:page=>void navigate(page),openPublishingSettings(platform,accountId){capturePublishingReturn();void navigate({page:'settings',settings_view:'publishing',platform,...(accountId?{account_id:accountId}:{})});},presentDialog(data){
    if(client)notifyManualAccountDialogPresentation(client,data);
    studio?.replace(data.title);images?.replace(data.title);
    speech?.replace(data.title);
    if((data.title.startsWith('图像任务')||data.title.startsWith('公众号配图 · 任务'))&&!data.foregroundJob)void task.close('completed');
    const d=document.getElementById('dialog');
    const sameImageTask=(data.title.startsWith('图像任务')||data.title.startsWith('公众号配图 · 任务'))&&!!data.foregroundJob&&d.open&&foreground?.id===data.foregroundJob.id&&!!d.querySelector('#image-job-state');
    // 前台任务按 job 复用球体；progressKey（关闭不取消的流程面板）只在正文与按钮不变时复用，避免轮询重建 Canvas。
    const progressKey=data.foregroundJob?.id??data.progressKey,sameProgress=!!progressKey&&!!data.generationProgress&&d.open&&generationProgress.isMountedFor(progressKey)&&(!!data.foregroundJob||(progressShell?.body===data.body&&progressShell.foot===data.foot));
    foreground=data.foregroundJob;
    if(sameImageTask){const next=root.ownerDocument.createElement('div');next.innerHTML=data.body;for(const id of ['image-job-state','image-job-message']){const current=d.querySelector('#'+id),value=next.querySelector('#'+id);if(current&&value)current.textContent=value.textContent;}return;}
    if(sameProgress){d.querySelector('#dialog-title')!.textContent=data.title;generationProgress.update(data.generationProgress!);return;}
    const focused=root.ownerDocument.activeElement as HTMLInputElement|null;
    const focusedId=focused?.id,selection=focused&&'selectionStart' in focused?focused.selectionStart:null;
    generationProgress.dispose();
    if(foreground)task.begin();
    d.innerHTML='<div class="dialog-head"><h2 id="dialog-title">'+esc(data.title)+'</h2>'+iconBtn('close','close-dialog','关闭弹窗')+'</div><div class="dialog-body">'+data.body+'</div><div class="dialog-foot">'+(data.foot??btn('知道了','close-dialog'))+'</div>';
    progressShell=progressKey&&data.generationProgress?{body:data.body,foot:data.foot}:undefined;
    if(progressKey&&data.generationProgress)generationProgress.mount(d.querySelector<HTMLElement>('.generation-progress-host')??d.querySelector<HTMLElement>('.dialog-body')!,progressKey,data.generationProgress);
    d.classList.toggle('drawer',/账号研究|数据依据|发布记录|接入说明|保存分工/.test(data.title));
    if(!d.open)d.showModal();
    if(focusedId){const restored=d.querySelector<HTMLInputElement>('#'+CSS.escape(focusedId));restored?.focus({preventScroll:true});if(selection!==null)restored?.setSelectionRange(selection,selection);}
  }};
  function context():FeatureContext {if(!identity||!client||!drafts)throw new Error('真实服务尚未接入');return {identity,client:client,hostBridge:injection.hostBridge,ui,signal,readSignal:navigationReads.signal,surface,drafts,skillSelection:(purpose,platform)=>skills?.selection(purpose,platform)};}
  function nav(){
    document.getElementById('nav').innerHTML=NAV.map(n=>'<button class="nav-button '+(ui.page===n[0]?'active':'')+'" data-action="nav" data-page="'+n[0]+'" title="'+n[1]+'" '+(ui.page===n[0]?'aria-current="page"':'')+'>'+icon(n[2])+'<span class="nav-text">'+n[1]+'</span>'+(n[0]==='create'?'<span class="nav-count">'+String(view?.state.topics.length??0).padStart(2,'0')+'</span>':'')+'</button>').join('');
    const index=NAV.findIndex(n=>n[0]===ui.page),indicator=document.getElementById('nav-indicator');indicator.style.opacity=index<0?'0':'1';indicator.style.transform='translateY('+Math.max(0,index)*53+'px)';
    document.getElementById('settings-nav').innerHTML=icon('settings')+'<span class="nav-text">设置与连接</span>';document.getElementById('settings-nav').classList.toggle('active',ui.page==='settings');const crumb=document.getElementById('crumb');crumb.textContent=currentLocation.settings_view==='skills'?'创作配方':publishingLocation?P[publishingLocation.platform]!.name+' / 平台发布':NAV.find(n=>n[0]===ui.page)?.[1]??'设置';const crumbHost=crumb.parentElement!;if(publishingLocation){if(!crumbHost.querySelector('.crumb-link')){crumbHost.firstChild?.remove();const back=root.ownerDocument.createElement('button');back.className='crumb-link';back.dataset.action='publishing-home';back.textContent='设置与连接';crumbHost.prepend(back);}}else if(crumbHost.querySelector('.crumb-link')){crumbHost.querySelector('.crumb-link')!.remove();crumbHost.prepend(root.ownerDocument.createTextNode('工作空间 '));}document.getElementById('search-icon').innerHTML=icon('search');
    const badge=document.querySelector('.demo-badge');if(badge)badge.textContent=settings?.title??'本地工作台';
  }
  function rememberView(captureInputs=false){if(!view||stale||!identity||!cache)return;const snapshot={...view,state:{...view.state,topics:view.state.topics.map(topic=>({...topic,versions:{...topic.versions}}))}};const topic=snapshot.state.topics.find(topic=>topic.id===ui.topic);if(captureInputs&&ui.page==='create'&&topic){const core=root.querySelector<HTMLTextAreaElement>('#core-editor'),text=root.querySelector<HTMLTextAreaElement>('#version-text'),title=root.querySelector<HTMLInputElement>('#version-title');if(core){if(core.value!==topic.core){topic.confirmed=false;snapshot.editorFeedback={...snapshot.editorFeedback,generationEnabled:false,coreStatus:'已修改，请重新确认；平台稿件保留原版本',confirmationLabel:'确认核心稿'};}topic.core=core.value;}if(text&&topic.versions[ui.platform])topic.versions[ui.platform]={...topic.versions[ui.platform],text:text.value,...(title?{title:title.value}:{})};}cache.remember(identity,ui,snapshot);}
  function allowedWhileStale(control:HTMLElement){const action=control.dataset.action||control.id;return control.hasAttribute('data-x-image')||['nav','close-dialog','publishing-close','cancel-task','navigation-refresh'].includes(action)||READ_ONLY_NAVIGATION_ACTIONS.has(action);}
  function lockStaleControls(){if(!stale)return;for(const control of root.querySelectorAll<HTMLElement>('#content button,#content input,#content textarea,#content select,#content [data-action],dialog button,dialog input,dialog textarea,dialog select,dialog [data-action]')){if(allowedWhileStale(control))continue;if(control instanceof HTMLTextAreaElement||control instanceof HTMLInputElement&&['text','search','url','tel','password',''].includes(control.type))control.readOnly=true;else if('disabled' in control)(control as HTMLButtonElement).disabled=true;else{control.setAttribute('aria-disabled','true');control.tabIndex=-1;}}}
  function guardCachedEvent(event:Event){if(!stale)return;const control=(event.target as Element).closest<HTMLElement>('button,input,textarea,select,[data-action]');if(event.type==='click'&&(!control||allowedWhileStale(control)||control instanceof HTMLTextAreaElement&&control.readOnly||control instanceof HTMLInputElement&&['text','search','url','tel','password',''].includes(control.type)&&control.readOnly))return;event.preventDefault();event.stopImmediatePropagation();toast('正在核对最新资料，核对后可继续操作');}
  root.addEventListener('click',guardCachedEvent,{capture:true,signal});root.addEventListener('submit',guardCachedEvent,{capture:true,signal});
  const staleObserver=new MutationObserver(()=>{if(stale)lockStaleControls();});staleObserver.observe(root,{childList:true,subtree:true});
  function syncLocation(){
    if(injection.initialLocation||injection.initialPage)return;
    let hash:string;
    try{
      if(ui.page==='create'&&!currentLocation.settings_view&&!publishingLocation){
        const topic=view?ui.topic:currentLocation.topic_id,step=pendingView?.step??studio?.step();
        // 按平台版本打开的定位（宿主/发布设置返回）在仍停留在同一平台版本时保留 variant_id 原样。
        const variant=currentLocation.variant_id&&currentLocation.topic_id===topic&&(!view||ui.editTab==='versions'&&ui.platform===variantPlatform)?currentLocation.variant_id:undefined;
        hash=workbenchViewHash({page:'create',...(topic?{topic_id:topic}:{}),...(variant?{variant_id:variant}:{})},variant?{...(step?{tab:'versions' as const,platform:ui.platform as WorkbenchView['platform'],step}:{})}:view||!pendingView?{tab:ui.editTab as WorkbenchView['tab'],platform:ui.platform as WorkbenchView['platform'],...(step?{step}:{})}:pendingView);
      }else hash=workbenchLocationHash(currentLocation);
    }catch{return;}
    if(location.hash!==hash)history.replaceState(null,'',hash);
  }
  let syncQueued=false;const scheduleSync=()=>{if(syncQueued)return;syncQueued=true;queueMicrotask(()=>{syncQueued=false;if(!signal.aborted)syncLocation();});};
  const locationObserver=new MutationObserver(scheduleSync);locationObserver.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  /** 主题读完后套用地址里的子位置：页签与平台在读取前设好；配图/排版在配图模块激活后打开。 */
  function applyPendingStep(){
    const step=pendingView?.step;if(!pendingView||!view||stale)return;
    if(ui.page!=='create'||!step||!studioActive()||!ui.topic){if(view)pendingView=undefined;return;}
    pendingView=undefined;studio?.openStep(ui.topic,step);
  }
  // 页脚：主路径只说保存在哪；工作区、服务实例和当前主题的内部编号收进「诊断信息」。还没连上时显示正常的连接提示，确实连不上才说明连接问题。
  function footerNote(){
    if(!identity)return '<p class="footer-note" role="status">'+esc(loadError?'暂时连不上本机服务：'+loadError:'正在连接本机工作台…')+'</p>';
    const rows:Array<[string,string]>=[['工作区',identity.workspace_id],['服务实例',identity.service_instance_id],...(ui.page==='create'&&ui.topic?[['当前主题',ui.topic] as [string,string]]:[])];
    return '<div class="footer-note"><span>本机工作台 · 由唯一主服务保存运营记录</span><details class="footer-diagnostics"><summary>诊断信息</summary><dl>'+rows.map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd>').join('')+'</dl></details></div>';
  }
  function render(){root.classList.toggle('publishing-workbench',!!publishingLocation);flowCleanup?.();flowCleanup=undefined;const active=root.ownerDocument.activeElement as HTMLInputElement|null;const focus=active&&root.contains(active)?{id:active.id,name:active.name,value:active.value,action:active.dataset.action,platform:active.dataset.platform,page:active.dataset.page,selection:'selectionStart' in active?active.selectionStart:null}:undefined;if(view?.provenance==='demo')throw new Error('真实入口不能使用 demo 投影');nav();let html='';if(ui.page==='settings'&&!settingsReady)html='<div class="empty">'+esc(loadError?'读取失败：'+loadError:'正在读取设置与连接…')+'</div>';else if(currentLocation.settings_view==='skills'&&skills)html=skills.render();else if(publishingLocation&&publisher)html=publisher.render();else if(ui.page==='settings'&&settings)html=renderSettings(settings,configuration?.state);else if(view)html=renderOperationsPanel({...view,ui})+createApprovedPageViews({...view,ui})[ui.page]();else html='<div class="empty">'+esc(loadError?'读取失败：'+loadError:loading?'正在读取已保存的资料…':'此页面的真实模块尚未接入')+'</div>';document.getElementById('content').innerHTML='<div class="page"'+(stale?' data-navigation-stale="true"':'')+'>'+((stale||loadError)?'<p class="fine" role="status">'+esc(loadError?'最新资料暂未能核对：'+loadError: '正在核对最新资料，已保存内容可先阅读。')+(!loading?' <button class="btn btn-small" data-action="navigation-refresh">重新读取</button>':'')+'</p>':'')+html+'</div>'+footerNote();if(ui.page==='create'&&skills){const field=root.querySelector('#agent-request');if(field){const section=root.ownerDocument.createElement('div');const purpose=ui.editTab==='versions'?'variant':'core';const category=view?.state.topics.find(t=>t.id===ui.topic)?.category;section.innerHTML=skills.picker(purpose,purpose==='variant'?ui.platform as Platform:undefined,category);field.before(section);}}if(ui.page==='create'&&writing&&view&&ui.topic){writing.activate(ui.topic);const aside=root.querySelector('.editor-side');if(aside&&ui.editTab==='core'){const section=root.ownerDocument.createElement('div');section.innerHTML=writing.panel();aside.prepend(section);}}if(!stale&&ui.page==='create'&&ui.editTab==='core'&&view&&ui.topic&&viewpoints){viewpoints.activate(ui.topic);const slot=root.querySelector('.viewpoints-slot');if(slot)slot.innerHTML=viewpoints.panel();}else viewpoints?.deactivate();if(speech&&!currentLocation.settings_view){if(ui.page==='settings'){const grid=root.querySelector('.settings-grid');grid?.insertAdjacentHTML('beforeend',speechSettingsReady?speech.panel():'<section class="panel speech-settings"><div class="panel-head"><h2>语音输入</h2></div><div class="panel-body"><p class="fine" role="status">语音设置暂不可读，请重新读取设置。</p>'+btn('重新读取','navigation-refresh')+'</div></section>');}else if(['today','create','sources'].includes(ui.page)){const actions=root.querySelector('.page-heading .button-row');if(actions)actions.insertAdjacentHTML('beforeend',btn('语音记想法','speech-open'));}}if(!stale&&view&&identity&&ui.page==='create'&&ui.editTab==='assets'&&ui.topic){images?.activate(ui.topic);images?.mount();hideGenericImageEntry(root,ui.platform);}else images?.deactivate();
    if(!stale&&view&&identity&&studioActive()&&ui.topic&&mountImageStep(root)){studio?.activate(ui.topic);studio?.mount();}else studio?.deactivate();applyPendingStep();syncLocation();flowCleanup=mountHomeFlow(root);if(view?.editorFeedback)surface.editorFeedback(view.editorFeedback);lockStaleControls();if(focus){const control=Array.from(root.querySelectorAll<HTMLInputElement>('input,textarea,select,button')).find(e=>focus.id?e.id===focus.id:focus.name?e.name===focus.name&&e.value===focus.value:focus.action&&e.dataset.action===focus.action&&e.dataset.platform===focus.platform&&e.dataset.page===focus.page);control?.focus({preventScroll:true});if(control&&focus.selection!==null&&'setSelectionRange' in control&&['text','search','url','tel','password',''].includes(control.type))control.setSelectionRange(focus.selection,focus.selection);}}
  function capturePublishingReturn(){
    const d=document.getElementById('dialog');let dialogHtml='';
    if(d.open){const clone=d.cloneNode(true) as HTMLDialogElement;const controls=[...d.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('input,textarea,select')];[...clone.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('input,textarea,select')].forEach((copy,i)=>{const original=controls[i]!;if(copy instanceof HTMLInputElement){copy.setAttribute('value',original.value);if(copy.type==='checkbox'||copy.type==='radio')copy.toggleAttribute('checked',(original as HTMLInputElement).checked);}else if(copy instanceof HTMLTextAreaElement)copy.textContent=original.value;else for(const option of copy.options)option.toggleAttribute('selected',option.value===original.value);});dialogHtml=clone.innerHTML;d.close();}
    publishingReturn={location:currentLocation,ui:{...ui},dialogHtml,drawer:d.classList.contains('drawer')};void drafts?.leave();
  }
  async function returnToPublishing(){const previous=publishingReturn;if(!previous)return;publishingReturn=undefined;Object.assign(ui,previous.ui);await navigate(previous.location);if(previous.dialogHtml){const d=document.getElementById('dialog');d.innerHTML=previous.dialogHtml;d.classList.toggle('drawer',previous.drawer);d.showModal();d.querySelector<HTMLElement>('input,select,button')?.focus();}}
  async function navigate(target:WorkbenchPage|OpenWorkbenchRequest){
    rememberView(true);studio?.deactivate();images?.deactivate();publisher?.deactivate();navigationReads.abort();navigationReads=new AbortController();const readSignal=navigationReads.signal;
    const requested=typeof target==='string'?{page:target}:target;const page=requested.page;speech?.close();writing?.deactivate();viewpoints?.deactivate();if(client)invalidateManualAccountDialog(client);
    if(foreground)closeDialog('user_close');const draftSave=drafts?.leave(),current=++revision;ui.page=page;view=undefined;stale=false;loadError=undefined;loading=!!client&&(page==='settings'||!!injection.features?.[page]);currentLocation=requested;publishingLocation=requested.settings_view==='publishing'?requested:undefined;
    if(publishingLocation)publisher?.setLocation(publishingLocation);
    if(requested.topic_id)ui.topic=requested.topic_id;
    if(page==='create'&&pendingView){if(pendingView.tab)ui.editTab=pendingView.tab;if(pendingView.platform)ui.platform=pendingView.platform;}else pendingView=undefined;
    if(identity&&cache){view=cache.recall(identity,ui);stale=!!view;}if(page==='settings'){settings=undefined;settingsReady=false;speechSettingsReady=false;}
    syncLocation();render();window.scrollTo({top:0,behavior:'instant'});if(!client)return;
    const reads=createReadScope(client,readSignal),readClient=reads.client;
    try{
      await draftSave;if(current!==revision||readSignal.aborted)return;
      const nextIdentity=await readClient.identity(AbortSignal.any([signal,readSignal]));if(current!==revision)return;if(identity&&(identity.workspace_id!==nextIdentity.workspace_id||identity.service_instance_id!==nextIdentity.service_instance_id||identity.contract_version!==nextIdentity.contract_version)){cache?.clear();view=undefined;stale=false;settings=undefined;throw new Error('工作区身份已变化，请刷新工作台重新连接');}identity=nextIdentity;cache?.bind(identity);drafts??=new DraftRegistry(client,identity,localStorage);
      if(!selectionRestored){const selected=localStorage.getItem(selectionKey()!);if(!requested.topic_id&&selected&&/^[a-zA-Z0-9-]{1,128}$/.test(selected))ui.topic=selected;selectionRestored=true;}
      if(requested.variant_id){
        let topic:TopicDetail|undefined;
        if(requested.topic_id)topic=await readClient.request('GET','/api/v1/topics/'+encodeURIComponent(requested.topic_id),undefined,{signal});
        else{let cursor:string|null=null;do{const listed:Page<{id:string}>=await readClient.request('GET','/api/v1/topics'+(cursor?'?cursor='+encodeURIComponent(cursor):''),undefined,{signal});for(const item of listed.items){const candidate=await readClient.request<TopicDetail>('GET','/api/v1/topics/'+encodeURIComponent(item.id),undefined,{signal});if(candidate.variants.some(v=>v.id===requested.variant_id)){topic=candidate;break;}}cursor=topic?null:listed.next_cursor;}while(cursor);}
        const variant=topic?.variants.find(v=>v.id===requested.variant_id);if(!topic||!variant)throw new ContractError('NOT_FOUND','平台版本不属于当前主题或工作区');if(current!==revision)return;ui.topic=topic.id;if(typeof variant.platform==='string')ui.platform=variant.platform;variantPlatform=ui.platform;ui.editTab='versions';
      }
      const skillRead=page==='create'&&skills?skills.load().catch(error=>{if(current===revision)toast(error instanceof Error?error.message:'配方读取失败，默认路由由服务处理');}):undefined;
      if(page==='settings'){
        const data=await readClient.getSettings(signal);if(current===revision)settings=data;if(!requested.settings_view)await Promise.all([configuration?.load(),speech?.load().then(()=>{if(current===revision)speechSettingsReady=true;}).catch(()=>{if(current===revision)speechSettingsReady=false;})]);if(publishingLocation&&publisher)await publisher.load();if(requested.settings_view==='skills'&&skills)await skills.load();if(current===revision){settings=data;settingsReady=true;render();}
      }else{
        if(page==='retro'&&!retroDefaultsLoaded){const preferences=await readClient.request<import('@workbench/contracts').ConfigurationSnapshot>('GET','/api/v1/settings/configuration',undefined,{signal});if(current!==revision)return;ui.period=preferences.preferences.retro_days;ui.defaultRetroPeriod=ui.period;retroDefaultsLoaded=true;}
        const feature=injection.features?.[page];if(feature){const scoped={...context(),client:readClient,readSignal,surface:{...surface,updateUi(patch:Parameters<UiSurface['updateUi']>[0]){if(current===revision)surface.updateUi(patch);},editorFeedback(feedback:Parameters<UiSurface['editorFeedback']>[0]){if(current===revision)surface.editorFeedback(feedback);},toast(message:string){if(current===revision)surface.toast(message);}}};const loadEpoch=cache?.epoch;const data=await feature.load(scoped);await skillRead;if(current===revision){if(loadEpoch!==cache?.epoch){void navigate(requested);return;}view=data;stale=false;Object.assign(ui,data.ui);saveSelection();rememberView();render();}}
      }
    }catch(error){if(!signal.aborted&&current===revision){loadError=error instanceof Error?error.message:'读取失败，输入保留';if(loadError.includes('工作区身份已变化')){view=undefined;stale=false;settings=undefined;settingsReady=false;drafts?.dispose();}toast(loadError);}}finally{reads.close();if(current===revision){loading=false;render();}}
  }
  async function refreshImageAssets(){const feature=injection.features?.create,current=revision,own=actionRevision,topic=ui.topic,tab=ui.editTab;if(!feature||ui.page!=='create')return;const data=await feature.load({...context(),ui:{...ui}});if(current!==revision||own!==actionRevision||ui.page!=='create'||ui.topic!==topic||ui.editTab!==tab)return;view=data;Object.assign(ui,data.ui);saveSelection();if(!stale)rememberView();render();}
  function actionInput(el:ControlElement):FeatureAction {const fields:Record<string,string|boolean>={};for(const input of root.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('input,textarea,select')){const key=input.name==='platform'?'platform:'+input.value:input.id||input.name;if(key){const value=input instanceof HTMLInputElement&&input.type==='checkbox'?input.checked:input.value;fields[key]=value;if(input.name==='platform'&&input.id)fields[input.id]=value;}}if(el.classList.contains('shot-duration'))fields['shot-duration']=el.value;const operation=el.dataset.action||el.id||el.name||(el.classList.contains('shot-duration')?'shot-duration':'');if(!isFeatureOperation(operation))throw new Error('操作不在批准原型范围内');return {action:operation,dataset:{...el.dataset} as Record<string,string>,fields};}
  document.addEventListener('click',event=>{const el=event.target.closest<ControlElement>('[data-action]');if(!el||el.disabled)return;const action=el.dataset.action;
    if(action==='navigation-refresh'){void navigate(currentLocation);return;}if(stale&&!allowedWhileStale(el)){toast('正在核对最新资料，核对后可继续操作');return;}
    if(action==='publishing-open'){void navigate({page:'settings',settings_view:'publishing',platform:'x'});return;}
    if(action==='publishing-connection-jump'){capturePublishingReturn();void navigate({page:'settings',settings_view:'publishing',platform:el.dataset.platform as Platform,...(el.dataset.account?{account_id:el.dataset.account}:{})});return;}
    if(studio?.handle(el))return;
    if(images?.handle(el))return;
    if(speech?.handleClick(el))return;
    if(configuration?.handleClick(el))return;
    if(publisher?.handleClick(el))return;
    if(skills?.handleClick(el))return;
    if(viewpoints?.handle(el))return;
    if(writing?.handle(el))return;
    if(action==='nav'){closeDialog();void navigate(parsePage(el.dataset.page));}else if(action==='close-dialog')closeDialog();else if(action==='cancel-task'){closeDialog('cancel');toast('已请求取消任务，现有稿件保留');}
    else if(action==='connection-info'){const capability=settings?.capabilities.find(c=>c.tool===el.dataset.name||c.name===el.dataset.name);surface.presentDialog({title:(el.dataset.name??'工具')+' · 接入说明',body:'<p>'+esc(capability?.status??'unverified')+'</p><p class="fine" style="margin-top:15px">'+esc(capability?.limitations??'此能力尚未验证')+'</p>'});}
    else if(action==='upload')document.getElementById('file-input').click();
    else if(action==='storage-info'&&settings)surface.presentDialog({title:'资料与运营状态的保存分工',body:'<p style="font-size:13px;line-height:2">'+esc(settings.paths.managed_notes_root)+'<br><br>'+esc(settings.paths.state_root)+'<br><br>'+esc(settings.paths.media_root)+'</p>'});
    else dispatchFeature(actionInput(el));
  });
  function dispatchFeature(action:FeatureAction){if(stale&&!READ_ONLY_NAVIGATION_ACTIONS.has(action.action)){toast('正在核对最新资料，核对后可继续操作');return;}if(action.action==='search'||action.action==='global-search'){void showIngestSearch(context(),String(action.fields['global-search']??'')).catch(error=>toast(error instanceof Error?error.message:'搜索失败'));return;}const target=action.action==='read-news'?'sources':action.action==='search-knowledge'?'knowledge':ui.page;const feature=injection.features?.[target],current=revision,actionOwn=++actionRevision;if(feature)void feature.dispatch(action,context()).then(data=>{if(data&&current===revision&&actionOwn===actionRevision){view=data;Object.assign(ui,data.ui);saveSelection();if(!stale)rememberView();render();}}).catch(error=>{if(current===revision&&!(error instanceof DOMException&&error.name==='AbortError'))toast(error instanceof Error?error.message:'操作失败，输入保留');});else toast('此操作的真实模块尚未接入');}
  document.addEventListener('change',event=>{if(stale&&!READ_ONLY_NAVIGATION_ACTIONS.has(event.target.dataset.action||event.target.id))return;if(studio?.handleChange(event.target as unknown as HTMLInputElement))return;if(images?.handleChange(event.target as unknown as HTMLInputElement))return;if(speech?.handleChange(event.target as unknown as HTMLInputElement))return;if(configuration?.handleChange(event.target as unknown as HTMLInputElement))return;if(skills?.handleChange(event.target as unknown as HTMLInputElement))return;const el=event.target;if(publisher?.handleChange(el as unknown as HTMLInputElement))return;if(el.id==='retro-period'){dispatchFeature(actionInput(el));return;}if(el.id==='file-input'){dispatchFeature({action:'upload',dataset:{},fields:{},files:Array.from(el.files??[])});el.value='';return;}if(el.name==='default-agent'||el.id==='api-toggle'){
    const patch=el.id==='api-toggle'?{api_fallback_enabled:el.checked}:{default_executor:el.value as 'codex'|'claude'};
    settingsQueue=settingsQueue.then(async()=>{if(!settings||!client)return;try{settings=await client.patchSettings({expected_version:settings.version,...patch},{idempotencyKey:crypto.randomUUID()});if(ui.page==='settings')render();toast(el.id==='api-toggle'?'API 补充偏好已保存':'默认执行器已保存：'+(settings.default_executor==='codex'?'Codex':'Claude Code'));}catch(error){toast(error instanceof Error?error.message:'设置保存失败');}});
  }});
  document.addEventListener('input',event=>{if(stale&&!READ_ONLY_NAVIGATION_ACTIONS.has(event.target.dataset.action||event.target.id))return;if(studio?.handleInput(event.target as unknown as HTMLInputElement))return;if(images?.handleInput(event.target as unknown as HTMLInputElement))return;if(viewpoints?.input(event.target as unknown as HTMLInputElement))return;if(speech?.handleInput(event.target as unknown as HTMLInputElement))return;if(configuration?.handleInput(event.target as unknown as HTMLInputElement))return;if(skills?.handleInput(event.target as unknown as HTMLInputElement))return;if(event.target.id==='file-input')return;if(['global-search','source-query','knowledge-query'].includes(event.target.id)){dispatchFeature(actionInput(event.target));return;}const feature=injection.features?.[ui.page],operation=event.target.dataset.action||event.target.id||event.target.name||(event.target.classList.contains('shot-duration')?'shot-duration':'');if(feature?.input&&isFeatureOperation(operation))void feature.input(actionInput(event.target),context()).catch(error=>toast(error instanceof Error?error.message:'输入尚未提交'));});
  document.addEventListener('keydown',event=>{if(publisher?.handleKey(event as unknown as KeyboardEvent))return;if(studio?.handleKey(event as unknown as KeyboardEvent))return;if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();document.querySelector('[data-action="search"]')?.click();}if((event.key==='Enter'||event.key===' ')&&event.target.getAttribute('role')==='button'){event.preventDefault();event.target.click();}const input=event.target;if(document.getElementById('dialog').open&&(input.id==='global-search'||input.classList.contains('search-result'))&&['ArrowDown','ArrowUp'].includes(event.key)){const rows=[...document.querySelectorAll('.search-result')];if(rows.length){event.preventDefault();const index=rows.indexOf(input);rows[event.key==='ArrowDown'?Math.min(rows.length-1,index+1):Math.max(0,index-1)].focus();}}});
  document.getElementById('dialog').addEventListener('cancel',()=>{studio?.close('escape');images?.close('escape');if(client)invalidateManualAccountDialog(client);speech?.close();generationProgress.dispose();writing?.close();void task.close('escape');},{signal});document.getElementById('dialog').addEventListener('close',()=>{if(document.getElementById('dialog').open)return;studio?.close();images?.close();if(client)invalidateManualAccountDialog(client);speech?.close();generationProgress.dispose();writing?.close();void task.close('user_close');},{signal});
  document.getElementById('dialog').addEventListener('click',event=>{if(event.target===event.currentTarget){const d=document.getElementById('dialog'),r=d.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog('user_close');}},{signal});
  let paging=false;root.addEventListener('scroll',event=>{const target=event.target as HTMLElement;if(paging||!['feed-list','knowledge-list'].includes(target.id)||target.scrollHeight-target.scrollTop-target.clientHeight>80)return;const feature=injection.features?.[ui.page],current=revision;if(feature?.loadMore){paging=true;void feature.loadMore(context()).then(data=>{if(current===revision){view=data;Object.assign(ui,data.ui);saveSelection();if(!stale)rememberView();render();}}).catch(error=>toast(error instanceof Error?error.message:'读取下一页失败')).finally(()=>{paging=false;});}},{capture:true,signal});
  document.addEventListener('focusout',event=>{if(event.target.matches?.('textarea,input')&&drafts)void drafts.leave().catch(error=>toast(error instanceof Error?error.message:'输入尚未提交'));});
  window.addEventListener('pagehide',()=>{studio?.deactivate();images?.deactivate();speech?.close();generationProgress.dispose();drafts?.dispose();},{signal});
  root.addEventListener('error',event=>{const image=event.target;if(image instanceof HTMLImageElement&&image.hasAttribute('data-platform-image'))image.hidden=true;if(image instanceof HTMLVideoElement&&image.hasAttribute('data-platform-video')){const message=image.parentElement?.querySelector<HTMLElement>('.benchmark-media-error');if(message)message.hidden=false;}},{capture:true,signal});
  bindPageHide(window,()=>{if(foreground)closeDialog('navigate');},signal);window.addEventListener('hashchange',()=>{try{const next=parseWorkbenchLocation(location.hash);pendingView=parseWorkbenchView(location.hash);void navigate(next);}catch{toast('工作台定位无效，请选择合法平台与账号。');}},{signal});
  void navigate(initialLocation);
  return {dispose(){studio?.dispose();images?.dispose();speech?.dispose();viewpoints?.dispose();generationProgress.dispose();navigationReads.abort();staleObserver.disconnect();locationObserver.disconnect();cache?.clear();abort.abort();root.classList.remove('workbench-real');writing?.dispose();publisher?.dispose();flowCleanup?.();operationsFlowCleanup();drafts?.dispose();clearTimeout(toastTimer);},mode:'real' as const};
}
