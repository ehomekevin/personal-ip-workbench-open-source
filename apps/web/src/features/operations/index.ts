import type { Page, TopicDetail, TopicSummary, TopicOperationsSnapshot, TopicOperations, ReaderFeedback, OperationsAutomation, OperationsCandidateView, OperationsFollowupProposal, DecideTopicOperationsRequest } from '@workbench/contracts';
import type { PageFeaturePort, FeatureContext, FeatureAction } from '../../transport/feature-ports.ts';
import type { OperationsProjection, ViewContext } from '../../app/view-model.ts';
import { createTemplateHelpers } from '../../components/templateHelpers.ts';
import { renderOperationsFlow } from './flow-view.ts';

const path=encodeURIComponent;
const briefFields=[['reader_task','读者正在做什么，卡在哪一步？'],['takeaway','读者能带走什么？'],['personal_addition','你新增了什么实操、修改或判断？'],['evidence','已有材料与待补的部分'],['goal','这篇最希望发生什么？'],['reader_next_step','读者下一步可以做什么？']] as const;
const feedbackKinds:Record<ReaderFeedback['kind'],string>={question:'具体提问',attempt:'尝试与结果',obstacle:'操作障碍',business:'业务询问',response:'一般回应'};
const stateLabels:Record<OperationsAutomation['state'],string>={missing:'等待生成',queued:'已排队',running:'正在整理运营候选',waiting_input:'等待补充输入',waiting_quota:'等待执行额度',failed:'生成失败',candidate:'候选待本人确认',confirmed:'运营记录已确认',rejected:'本轮候选未采用',stale:'材料已变化',blocked:'暂时无法生成'};
const stateNotes:Record<OperationsAutomation['state'],string>={missing:'将根据当前主题和已有材料整理简报。',queued:'生成任务已经排队，完成后会出现待确认的候选。',running:'正在整理已有材料与真实反馈，完成后由你决定是否采用。',waiting_input:'任务需要更多输入。补充主题或材料后可重试。',waiting_quota:'执行额度暂不可用，任务状态会自动更新。',failed:'本次任务未完成，已确认记录和正在编辑的内容保留。',candidate:'先核对简报，再选择真实反馈与后续题目。确认后才写入运营记录。',confirmed:'可以继续制作，并在新反馈到来后核对新的运营候选。',rejected:'本轮候选未写入记录；需要重新整理时可以显式重试。',stale:'已有材料或人工记录发生变化，请重新整理候选。',blocked:'当前输入或执行条件不满足，补充后可以重试。'};
const waitingStates=new Set<OperationsAutomation['state']>(['queued','running','waiting_input','waiting_quota']);
const retryStates=new Set<OperationsAutomation['state']>(['missing','waiting_input','waiting_quota','failed','rejected','stale','blocked']);
const {esc,btn,tag}=createTemplateHelpers([]);

export function briefReady(data:TopicOperations):boolean { return ['reader_task','takeaway','personal_addition','evidence'].every(key=>data.brief[key as keyof TopicOperations['brief']].trim()); }
export function operationsNext(p:OperationsProjection):{label:string;action:string;page?:string;tab?:string} {
  const automation=p.snapshot.automation;
  if(automation?.state==='failed'&&automation.candidate?.status==='adopted')return {label:'继续完成已确认内容',action:'operations-retry'};
  if(automation?.candidate?.status==='pending'&&automation.state==='candidate')return {label:'核对运营候选',action:'operations-review-candidate'};
  if(!p.snapshot.document&&automation?.state!=='confirmed')return automation&&waitingStates.has(automation.state)?{label:'查看生成进度',action:'operations-reload'}:{label:'重新生成运营候选',action:'operations-retry'};
  if(!p.coreConfirmed)return {label:'继续核对核心稿',action:'operations-go',page:'create',tab:'core'};
  if(!p.variantCount)return {label:'制作所选平台稿',action:'operations-go',page:'create',tab:'versions'};
  if(!p.publishedWorks.length)return {label:'检查平台稿与发布准备',action:'operations-go',page:'create',tab:'versions'};
  if(!p.snapshot.data.feedback.length)return automation&&waitingStates.has(automation.state)?{label:'查看生成进度',action:'operations-reload'}:{label:'刷新真实读者反馈',action:'operations-retry'};
  if(!p.snapshot.data.followups.length)return {label:'核对后续选题候选',action:automation&&waitingStates.has(automation.state)?'operations-reload':'operations-retry'};
  return {label:'继续后续内容',action:'operations-open-followup'};
}
function canRefreshFeedback(p:OperationsProjection):boolean { return !!p.snapshot.document&&p.publishedWorks.length>0&&p.snapshot.automation?.state==='confirmed'; }
function refreshFeedbackButton(p:OperationsProjection):string { return canRefreshFeedback(p)?btn('刷新真实读者反馈','operations-retry',false,'data-topic="'+esc(p.topicId)+'" data-refresh-feedback="true"'):''; }
function timeLabel(value:string|null|undefined):string { const at=value?new Date(value):null;return at&&Number.isFinite(at.getTime())?at.toLocaleString('zh-CN'):'时间未记录'; }
function sourceLink(source:string):string { try{const url=new URL(source);if(['https:','http:'].includes(url.protocol))return '<a href="'+esc(url.href)+'" target="_blank" rel="noopener noreferrer">'+esc(source)+'</a>';}catch{}return esc(source||'来源未记录'); }
function feedbackBody(row:ReaderFeedback,kind=row.kind):string {
  return '<div class="row">'+tag(feedbackKinds[kind])+'<span class="fine">'+esc(row.provenance==='platform'?'平台原始反馈':'人工记录反馈')+'</span></div><p class="operations-feedback-text">'+esc(row.text)+'</p><dl class="operations-feedback-meta"><div><dt>来源</dt><dd>'+sourceLink(row.source)+'</dd></div><div><dt>作品</dt><dd>'+(row.work_url?sourceLink(row.work_url):'对应当前主题')+'</dd></div><div><dt>作者</dt><dd>'+esc(row.author_name||'作者未记录')+(row.is_author?' · 作品作者':'')+'</dd></div><div><dt>时间</dt><dd>'+esc(timeLabel(row.commented_at??row.recorded_at))+'</dd></div></dl>';
}
function automationBody(automation:OperationsAutomation|undefined):string {
  if(!automation)return '<div class="operations-automation" role="status"><strong>运营候选暂未读取</strong><p class="fine">重新读取以核对生成状态。</p></div>';
  const limitations=[...new Set([...automation.limitations,...(automation.candidate?.data.limitations??[])])];
  const confirming=automation.state==='failed'&&automation.candidate?.status==='adopted';
  return '<div class="operations-automation'+(waitingStates.has(automation.state)?' is-waiting':'')+'" role="status"><div class="row"><strong>'+esc(confirming?'确认后的任务未完成':stateLabels[automation.state])+'</strong>'+tag(automation.candidate?.status==='conflict'?'候选与人工记录冲突':waitingStates.has(automation.state)?'后台任务':'自动整理')+'</div><p class="fine">'+esc(confirming?'本轮决定已经保存。继续完成已确认内容，可恢复尚未完成的记录与后续主题。':stateNotes[automation.state])+'</p>'+(automation.error?'<p class="operations-error" role="alert">'+esc(automation.error)+'</p>':'')+(limitations.length?'<ul class="operations-limitations">'+limitations.map(text=>'<li>'+esc(text)+'</li>').join('')+'</ul>':'')+'<details class="operations-task-details"><summary>任务与反馈来源</summary><p class="fine">'+(automation.job_id?'任务 '+esc(automation.job_id)+' · 版本 '+esc(automation.job_version??'待核对'):'尚无执行任务')+'</p><p class="fine">反馈读取状态：'+esc(automation.feedback_status||'待核对')+'</p></details></div>';
}
export function renderOperationsPanel(view:ViewContext):string {
  if(view.provenance!=='service'||!['today','create','schedule','retro'].includes(view.ui.page))return '';
  const p=view.projections.operations,error=view.projections.operationsError;
  if(!p&&error)return '<section class="panel operations-panel"><div class="panel-body"><h2>账号运营流程</h2><p class="fine" role="alert">运营记录暂时未能读取：'+esc(error)+'</p>'+btn('重新读取','operations-reload')+'</div></section>';
  if(!p)return '<section class="panel operations-panel"><div class="panel-body"><div class="row"><div><h2>账号运营流程</h2><p class="fine">先建立一个主题，工作台会根据已有材料整理待确认的运营候选。</p></div>'+btn('新建主题','new-topic')+'</div></div></section>';
  const data=p.snapshot.data,next=operationsNext(p),automation=p.snapshot.automation,hasRecord=!!p.snapshot.document;
  const attrs='data-topic="'+esc(p.topicId)+'"'+(next.page?' data-page="'+next.page+'"':'')+(next.tab?' data-tab="'+next.tab+'"':'')+(next.action==='operations-retry'&&p.publishedWorks.length&&automation?.state==='confirmed'?' data-refresh-feedback="true"':'');
  const feedback=view.ui.page==='retro'?'<div class="operations-feedback-list">'+(data.feedback.length?data.feedback.slice(-5).reverse().map(row=>'<article>'+feedbackBody(row)+'</article>').join(''):'<p class="fine">已确认记录中还没有真实读者反馈。实际发布并读到反馈后，可以刷新候选。</p>')+'</div>':'';
  const reviewReady=automation?.state==='candidate'&&automation.candidate?.status==='pending';
  const retryLabel=automation?.state==='waiting_input'?'补充后重试':automation?.state==='waiting_quota'?'额度恢复后重试':'重试运营任务';
  const secondary=(hasRecord?btn('编辑已确认简报','operations-brief',false,'data-topic="'+esc(p.topicId)+'"')+btn('已确认反馈 · '+data.feedback.length,'operations-feedback',false,'data-topic="'+esc(p.topicId)+'"')+btn('已确认后续 · '+data.followups.length,'operations-followup',false,'data-topic="'+esc(p.topicId)+'"'):'')+(automation&&retryStates.has(automation.state)&&next.action!=='operations-retry'?btn(retryLabel,'operations-retry',false,'data-topic="'+esc(p.topicId)+'"'):'')+(reviewReady&&next.action!=='operations-review-candidate'?btn('核对运营候选','operations-review-candidate',false,'data-topic="'+esc(p.topicId)+'"'):'')+(next.label!=='刷新真实读者反馈'?refreshFeedbackButton(p):'');
  return '<section class="panel operations-panel" aria-label="账号运营流程" data-operations-topic="'+esc(p.topicId)+'">'+renderOperationsFlow(p,btn(next.label,next.action,true,attrs))+'<div class="panel-body">'+automationBody(automation)+(error?'<p class="operations-error" role="alert">状态更新暂未完成：'+esc(error)+' '+btn('重新读取','operations-reload')+'</p>':'')+'<div class="operations-summary"><p>'+esc(data.brief.takeaway||(hasRecord?'运营简报已确认，缺少的材料可以在主题与核心稿中补充。':reviewReady?'运营候选已整理好，核对后再采用。':'工作台正在整理主题的运营候选；本人确认后，再进入创作。'))+'</p><div class="button-row">'+btn(next.label,next.action,true,attrs)+secondary+'</div></div>'+feedback+'<p class="fine operations-note">'+p.publishedWorks.length+' 份实际发布记录 · '+data.feedback.length+' 条已确认反馈 · '+data.followups.length+' 个已确认后续主题</p></div></section>';
}

const readOnlyWechatEntry=(context:FeatureContext)=>context.ui.page==='create'&&context.ui.editTab==='versions'&&context.ui.platform==='wechat';
export function withAccountOperationsFeature<P extends PageFeaturePort['page']>(base:PageFeaturePort<P>):PageFeaturePort<P> {
  let latest:OperationsProjection|undefined,editSnapshot:TopicOperationsSnapshot|undefined,editCandidate:OperationsCandidateView|undefined,generation=0,busy=false,dialogGeneration=0,decisionKey='',dialogToken='';
  let timer:ReturnType<typeof setTimeout>|undefined;
  const endpoint=(id:string)=>'/api/v1/topics/'+path(id)+'/operations';
  function stopPolling(){clearTimeout(timer);timer=undefined;}
  function refreshPanel(view:ViewContext,context:FeatureContext){
    if(typeof document!=='undefined'){
      const panel=[...document.querySelectorAll<HTMLElement>('.operations-panel')].find(row=>row.dataset.operationsTopic===latest?.topicId);
      if(panel)panel.outerHTML=renderOperationsPanel({...view,ui:{...context.ui}});return;
    }
    context.surface.updateUi({});
  }
  function ownsDialog(token:string):boolean {
    if(typeof document==='undefined')return true;
    const marker=document.querySelector('[data-operations-dialog="'+token+'"]'),dialog=marker?.closest('dialog');
    return !!marker&&(!dialog||dialog.open);
  }
  function schedulePoll(view:ViewContext,context:FeatureContext,own:number){
    stopPolling();const p=latest,state=p?.snapshot.automation?.state;if(!p||!state||!waitingStates.has(state)||!context.surface)return;
    const page=context.ui.page;
    const owns=()=>!context.signal.aborted&&!context.readSignal?.aborted&&generation===own&&latest===p&&context.ui.page===page&&context.ui.topic===p.topicId;
    timer=setTimeout(()=>{timer=undefined;if(!owns())return;void context.client.request<TopicOperationsSnapshot>('GET',endpoint(p.topicId),undefined,{signal:context.signal}).then(snapshot=>{
      if(!owns())return;p.snapshot=snapshot;delete view.projections.operationsError;refreshPanel(view,context);schedulePoll(view,context,own);
    }).catch(error=>{if(!owns())return;view.projections.operationsError=error instanceof Error?error.message:'状态读取失败';refreshPanel(view,context);schedulePoll(view,context,own);});},state==='waiting_input'||state==='waiting_quota'?5000:1800);
    (timer as unknown as {unref?:()=>void}).unref?.();
  }
  async function decorate(view:ViewContext,context:FeatureContext,ensure:boolean,own:number):Promise<ViewContext> {
    const page=context.ui.page,selectedTopic=context.ui.topic;
    const owns=()=>own===generation&&context.ui.page===page&&context.ui.topic===selectedTopic&&!context.signal.aborted&&!context.readSignal?.aborted;
    const listed:Page<TopicSummary>=await context.client.request('GET','/api/v1/topics',undefined,{signal:context.signal});
    const rows=[...listed.items];let cursor=listed.next_cursor;
    while(cursor){const result:Page<TopicSummary>=await context.client.request('GET','/api/v1/topics?cursor='+path(cursor),undefined,{signal:context.signal});rows.push(...result.items);cursor=result.next_cursor;}
    if(!owns())return view;
    const id=rows.some(t=>t.id===view.ui.topic)?view.ui.topic:rows[0]?.id;
    if(!id){latest=undefined;return view;}
    const [detail,readSnapshot,works]=await Promise.all([
      context.client.request<TopicDetail>('GET','/api/v1/topics/'+path(id),undefined,{signal:context.signal}),
      context.client.request<TopicOperationsSnapshot>('GET',endpoint(id),undefined,{signal:context.signal}),
      context.client.request<Page<{id:string;url:string;platform:string;published_at:string|null;identity_status:string}>>('GET','/api/v1/works?topic_id='+path(id)+'&limit=100',undefined,{signal:context.signal})
    ]);
    context.signal.throwIfAborted();if(!owns())return view;
    let snapshot=readSnapshot,ensureError:string|undefined;
    // 微信平台稿的配图/排版只读取运营状态；在异步 GET 返回后按当前页签复核，避免旧核心稿请求晚到时生成任务。
    if(ensure&&!readOnlyWechatEntry(context))try{snapshot=await context.client.request<TopicOperationsSnapshot>('POST',endpoint(id)+'/ensure',{},{signal:context.signal,idempotencyKey:crypto.randomUUID()});}catch(error){context.signal.throwIfAborted();ensureError=error instanceof Error?error.message:'自动候选暂未启动，请重试';}
    if(!owns())return view;
    const publishedWorks=works.items.filter(work=>work.identity_status==='confirmed'&&work.published_at).map(work=>({id:work.id,url:work.url,platform:work.platform}));
    const variantDocuments=await Promise.all(detail.variants.filter(v=>v.based_on_core_revision_id===detail.core.head_revision_id).map(v=>context.client.getDocument(String(v.document_id),context.signal)));
    if(!owns())return view;
    const p:OperationsProjection={topicId:id,title:detail.title,snapshot,coreConfirmed:!!detail.core_approval,variantCount:variantDocuments.filter(doc=>doc.head_revision_id&&doc.text.trim()).length,publishedWorks};
    latest=p;const decorated={...view,ui:{...view.ui,topic:id},projections:{...view.projections,operations:p,operationsError:ensureError}};schedulePoll(decorated,context,own);return decorated;
  }
  async function safeDecorate(view:ViewContext,context:FeatureContext,ensure=false,own=++generation):Promise<ViewContext>{
    stopPolling();const page=context.ui.page,topic=context.ui.topic;
    try{return await decorate(view,context,ensure,own);}catch(error){context.signal.throwIfAborted();if(own!==generation||context.ui.page!==page||context.ui.topic!==topic)return view;latest=undefined;return {...view,projections:{...view.projections,operations:undefined,operationsError:error instanceof Error?error.message:'请重新读取'}};}
  }
  async function reload(context:FeatureContext,ensure=false):Promise<ViewContext>{
    stopPolling();const allowEnsure=ensure&&!readOnlyWechatEntry(context),own=++generation,page=context.ui.page,topic=context.ui.topic,view=await base.load(context);if(own!==generation||context.ui.page!==page||context.ui.topic!==topic)return view;return safeDecorate(view,context,allowEnsure,own);
  }
  function selected(context:FeatureContext):OperationsProjection { if(!latest||latest.topicId!==context.ui.topic)throw new Error('主题已变化，请重新打开运营记录');return latest; }
  function openCandidate(p:OperationsProjection,context:FeatureContext){
    const candidate=p.snapshot.automation?.candidate;
    if(!candidate||candidate.status!=='pending'||p.snapshot.automation?.state!=='candidate')throw new Error('当前没有可确认的候选，请重新读取生成状态');
    editSnapshot=structuredClone(p.snapshot);editCandidate=structuredClone(candidate);decisionKey=crypto.randomUUID();dialogToken=crypto.randomUUID();dialogGeneration++;
    const labels=new Map(candidate.data.feedback_labels.map(row=>[row.id,row.kind]));
    const feedback=candidate.feedback.map((row,i)=>'<label class="operations-feedback-choice" for="operations-candidate-feedback-'+i+'"><input type="checkbox" id="operations-candidate-feedback-'+i+'" aria-label="采用第'+(i+1)+'条反馈" '+(labels.has(row.id)&&row.is_author!==true?'checked':'')+'><span>'+feedbackBody(row,labels.get(row.id)??row.kind)+'</span></label>').join('');
    const followups=candidate.data.followups.map((row,i)=>'<section class="operations-followup-choice"><label class="operations-check" for="operations-candidate-followup-'+i+'"><input type="checkbox" id="operations-candidate-followup-'+i+'" checked><strong>采用这个后续题目</strong></label><label class="field-label" for="operations-candidate-title-'+i+'">后续题目</label><input class="field" id="operations-candidate-title-'+i+'" maxlength="300" value="'+esc(row.title)+'"><label class="field-label" for="operations-candidate-help-'+i+'">这篇新增什么帮助？</label><textarea class="field" id="operations-candidate-help-'+i+'" rows="3" maxlength="12000">'+esc(row.new_help)+'</textarea><details><summary>题目依据</summary><ul class="operations-limitations">'+row.evidence_keys.map(key=>'<li>'+esc(key)+'</li>').join('')+'</ul></details></section>').join('');
    context.surface.presentDialog({title:'核对运营候选 · '+p.title,body:'<div class="operations-review" data-operations-dialog="'+dialogToken+'"><p class="note">修改简报，勾选要采用的真实反馈与后续题目。确认后，选中的后续题目会建立为主题。</p><h3>本条运营简报</h3>'+briefFields.map(([key,label])=>'<label class="field-label" for="operations-candidate-'+key+'">'+label+'</label><textarea class="field" id="operations-candidate-'+key+'" rows="2" maxlength="12000">'+esc(candidate.data.brief[key])+'</textarea>').join('')+'<h3>真实读者反馈 · '+candidate.feedback.length+'</h3><p class="fine">反馈原话与来源保持原记录，只选择要采用的条目。</p>'+(feedback||'<p class="note">本轮没有读到真实反馈。可确认简报，后续题目仅依赖已有材料。</p>')+'<h3>后续选题 · '+candidate.data.followups.length+'</h3>'+(followups||'<p class="fine">本轮没有提出有依据的后续题目。</p>')+(candidate.data.limitations.length?'<h3>本轮仍缺少的材料</h3><ul class="operations-limitations">'+candidate.data.limitations.map(text=>'<li>'+esc(text)+'</li>').join('')+'</ul>':'')+'<label class="operations-check operations-confirm-check" for="operations-candidate-confirmed"><input type="checkbox" id="operations-candidate-confirmed"><span>我已核对本次简报、选中的真实反馈与后续题目，确认采用。</span></label></div>',foot:btn('稍后再看','close-dialog')+btn('不采用本轮','operations-reject-candidate')+btn('确认并写入运营记录','operations-confirm-candidate',true)});
  }
  async function dispatch(action:FeatureAction,context:FeatureContext):Promise<ViewContext|void> {
    const ownPage=context.ui.page;
    if(busy&&!['operations-save-brief','operations-confirm-candidate','operations-reject-candidate'].includes(action.action))dialogGeneration++;
    if(action.action==='operations-reload')return reload(context);
    if(action.action==='operations-go'){const p=selected(context);context.surface.updateUi({topic:p.topicId,editTab:action.dataset.tab==='versions'?'versions':'core'});context.surface.navigate(action.dataset.page==='retro'?'retro':'create');return;}
    if(action.action==='operations-open-followup'){const p=selected(context),next=action.dataset.followup?p.snapshot.data.followups.find(row=>row.topic_id===action.dataset.followup):p.snapshot.data.followups.at(-1);if(next){dialogGeneration++;context.surface.closeDialog('completed');context.surface.updateUi({topic:next.topic_id,editTab:'core'});context.surface.navigate('create');}return;}
    if(action.action==='operations-review-candidate'){openCandidate(selected(context),context);return;}
    if(action.action==='operations-retry'){
      if(busy)return;const p=selected(context);if(action.dataset.refreshFeedback==='true'&&!canRefreshFeedback(p)){context.surface.toast('已有运营候选或任务，请先核对当前状态');return;}const own=++generation;stopPolling();busy=true;
      try{const snapshot=await context.client.request<TopicOperationsSnapshot>('POST',endpoint(p.topicId)+'/ensure',{retry:true,...(action.dataset.refreshFeedback==='true'?{refresh_feedback:true}:{})},{signal:context.signal,idempotencyKey:crypto.randomUUID()});if(own!==generation||context.ui.page!==ownPage||context.ui.topic!==p.topicId)return;p.snapshot=snapshot;context.surface.toast('运营状态已更新');return reload(context);}finally{busy=false;}
    }
    if(action.action==='operations-brief'){
      const p=selected(context);if(!p.snapshot.document)throw new Error('先核对自动运营候选，再编辑已确认记录');editSnapshot=structuredClone(p.snapshot);editCandidate=undefined;dialogToken=crypto.randomUUID();dialogGeneration++;
      context.surface.presentDialog({title:'编辑已确认简报 · '+p.title,body:'<div data-operations-dialog="'+dialogToken+'"><p class="fine">这次保存会保留你的人工修改。后续自动候选仍需本人确认。</p>'+briefFields.map(([key,label])=>'<label class="field-label" for="operations-'+key+'">'+label+'</label><textarea class="field" id="operations-'+key+'" rows="2" maxlength="12000">'+esc(p.snapshot.data.brief[key])+'</textarea>').join('')+'</div>',foot:btn('取消','close-dialog')+btn('保存已确认简报','operations-save-brief',true)});return;
    }
    if(action.action==='operations-feedback'){
      const p=selected(context);dialogGeneration++;context.surface.presentDialog({title:'已确认读者反馈 · '+p.title,body:'<div class="operations-review operations-feedback-list">'+(p.snapshot.data.feedback.length?p.snapshot.data.feedback.map(row=>'<article>'+feedbackBody(row)+'</article>').join(''):'<p class="fine">已确认记录中暂无真实反馈。实际发布并读到反馈后，可以刷新运营候选。</p>')+'</div>',foot:btn('关闭','close-dialog')+refreshFeedbackButton(p)});return;
    }
    if(action.action==='operations-followup'){
      const p=selected(context);dialogGeneration++;context.surface.presentDialog({title:'已确认后续选题 · '+p.title,body:'<div class="operations-review">'+(p.snapshot.data.followups.length?p.snapshot.data.followups.map(row=>'<article class="operations-followup-record"><h3>'+esc(row.title)+'</h3><p>'+esc(row.new_help)+'</p>'+btn('继续这个主题','operations-open-followup',false,'data-followup="'+esc(row.topic_id)+'"')+'</article>').join(''):'<p class="fine">本轮还没有确认后续题目。可在运营候选中核对并选中有依据的题目。</p>')+'</div>',foot:btn('关闭','close-dialog')});return;
    }
    if(['operations-confirm-candidate','operations-reject-candidate','operations-save-brief'].includes(action.action)){
      if(busy)return;const p=selected(context),editing=editSnapshot,candidate=editCandidate;
      if(!editing||editing.topic_id!==context.ui.topic)throw new Error('主题已变化，请重新打开；当前输入保留');
      const ownDialog=dialogGeneration,ownToken=dialogToken,visible=()=>dialogGeneration===ownDialog&&context.ui.topic===editing.topic_id&&context.ui.page===ownPage&&!context.signal.aborted&&ownsDialog(ownToken);
      let decision:DecideTopicOperationsRequest|undefined,data:TopicOperations|undefined;
      if(action.action==='operations-save-brief'){
        if(!editing.document)throw new Error('先确认运营候选');data=structuredClone(editing.data);for(const [key] of briefFields)data.brief[key]=String(action.fields['operations-'+key]??'').trim();
      }else{
        if(!candidate||candidate.status!=='pending')throw new Error('候选已变化，请重新打开；当前输入保留');
        if(p.snapshot.automation?.candidate?.id!==candidate.id||(p.snapshot.document?.head_revision_id??null)!==(editing.document?.head_revision_id??null))throw new Error('候选或人工记录已变化，请重新核对；当前输入保留');
        decision={candidate_id:candidate.id,expected_revision_id:editing.document?.head_revision_id??null,decision:action.action==='operations-confirm-candidate'?'confirm':'reject'};
        if(decision.decision==='confirm'){
          if(action.fields['operations-candidate-confirmed']!==true)throw new Error('请先勾选本人确认，再写入运营记录');
          const brief={...candidate.data.brief};for(const [key] of briefFields)brief[key]=String(action.fields['operations-candidate-'+key]??'').trim();
          const followups:OperationsFollowupProposal[]=candidate.data.followups.flatMap((row,i)=>action.fields['operations-candidate-followup-'+i]===true?[{...row,title:String(action.fields['operations-candidate-title-'+i]??'').trim(),new_help:String(action.fields['operations-candidate-help-'+i]??'').trim()}]:[]);
          if(followups.some(row=>!row.title||!row.new_help))throw new Error('选中的后续题目需写清标题和新增帮助；当前输入保留');
          decision={...decision,brief,feedback_ids:candidate.feedback.filter((_row,i)=>action.fields['operations-candidate-feedback-'+i]===true).map(row=>row.id),followups};
        }
      }
      busy=true;context.surface.dialogBusy?.(true);
      try{
        const saved=await context.client.request<TopicOperationsSnapshot>(decision?'POST':'PUT',endpoint(editing.topic_id)+(decision?'/decision':''),decision??{expected_revision_id:editing.document?.head_revision_id??null,data},{signal:context.signal,idempotencyKey:decision?decisionKey:crypto.randomUUID()});
        if(!visible())return;editSnapshot=saved;editCandidate=undefined;p.snapshot=saved;context.surface.closeDialog('completed');context.surface.toast(decision?.decision==='reject'?'本轮候选已标记为未采用':decision?'运营候选已确认，选中内容已写入记录':'已确认简报已保存');return reload(context);
      }finally{busy=false;if(visible())context.surface.dialogBusy?.(false);}
    }
    if(['operations-save-feedback','operations-create-followup'].includes(action.action))throw new Error('请在自动运营候选中选择真实反馈与后续题目，再由本人确认');
    if(action.action==='ai-suggest'&&latest&&latest.topicId===context.ui.topic&&context.ui.editTab==='core'){
      const brief=latest.snapshot.data.brief;
      const instruction=String(action.fields['agent-request']??'').trim()||'根据已核对的材料整理核心稿，保留本人事实和判断。';
      action={...action,fields:{...action.fields,'agent-request':instruction+'\n\n本条已确认运营简报（只作写作上下文，缺失信息不补造）：\n'+briefFields.map(([key,label])=>label+' '+(brief[key]||'待补充')).join('\n')+'\n正文不要出现内部流程或证据检查说明。'}};
    }
    const result=await base.dispatch(action,context);return result?safeDecorate(result,context):result;
  }
  return {...base,load:context=>reload(context,true),dispatch};
}
