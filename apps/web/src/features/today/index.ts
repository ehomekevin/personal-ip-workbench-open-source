import type { OverviewResponse,PutDailyPlanRequest,DailyPlan,TopicDetail,SourceRecordSummary,JobDetailResponse } from '@workbench/contracts';
import type { PageFeaturePort,FeatureContext,FeatureAction } from '../../transport/feature-ports.ts';
import type { ViewContext,TodayProjection,TopicView } from '../../app/view-model.ts';
import { createTemplateHelpers } from '../../components/templateHelpers.ts';
import {projectTopicSummary} from '../../transport/topic-summary.ts';
export interface TodayFeatureOptions { loadBase(context:FeatureContext):Promise<ViewContext>; dispatchRelated?(action:FeatureAction,context:FeatureContext):Promise<ViewContext|void> }
export function projectToday(overview:OverviewResponse,topicId?:string):TodayProjection {
  const action=overview.actions[0],job=overview.jobs.find(item=>(topicId===undefined||item.target_id===topicId)&&['waiting_input','waiting_quota','reconciling','queued','running','cancel_requested'].includes(String(item.state))),date=new Date(overview.local_date+'T12:00:00Z');
  const labels:Record<string,string>={pending:'待完成',in_progress:'进行中',done:'已完成',skipped:'已跳过'};
  const tasks=overview.items.map(item=>{const topic=overview.topics.find(topic=>topic.id===item.topic_id),task=overview.jobs.find(job=>job.id===item.job_id),suggestion=overview.actions.find(action=>action.id===item.action_id);return {id:String(item.id),title:topic?.title ?? (task?String(task.kind):suggestion?String(suggestion.description):item.topic_id?'主题 '+String(item.topic_id):item.job_id?'任务 '+String(item.job_id):'复盘行动 '+String(item.action_id)),note:String(item.effort_min)+' 分钟人工投入 · '+(labels[String(item.status)] ?? String(item.status)),topicId:typeof item.topic_id==='string'?item.topic_id:task&&overview.topics.some(topic=>topic.id===task.target_id)?String(task.target_id):null};});
  return {dateHeading:new Intl.DateTimeFormat('zh-CN',{timeZone:'UTC',month:'long',day:'numeric',weekday:'long'}).format(date),budgetMinutes:overview.budget_min,favoritePercent:null,favoriteDelta:'尚无已核对的表现数据',comparableWorks:null,next:{time:'暂无排期',platform:null,title:'当前没有待发布安排'},tasks,feedback:{actionId:action?String(action.id):null,title:action?String(action.description):'暂无复盘建议',context:action?String(action.hypothesis):'后续复盘行动会从服务记录读取',status:action?String(action.status):'暂无记录',note:action?'采用和效果评价分别保存，后续作品达到窗口后再评价。':'尚无记录时保持为空。'},...(job?{continuation:{id:String(job.id),state:String(job.state),version:Number(job.version),topicId:typeof job.target_id==='string'?job.target_id:null}}:{}),spark:{previousPath:'',currentPath:''}};
}
function topicView(topic:TopicDetail,old:TopicView|undefined):TopicView {
  return {...old,id:topic.id,title:topic.title,category:topic.category,source:old?.source ?? '',confirmed:topic.core_approval!==null,coreRev:topic.core.version,core:topic.core.text,versions:old?.versions ?? {},assets:old?.assets ?? [],shots:topic.shots.map(shot=>({title:shot.title,kind:shot.kind,duration:shot.duration_ms/1000,status:'已保存'}))};
}
function newsView(record:SourceRecordSummary) {return {id:record.id,title:record.title,category:record.category,time:record.published_at ?? record.created_at,source:record.source_name,summary:record.summary,curation:record.curation??undefined,body:'',sources:record.source_locations.map(location=>location.source_url ?? location.relative_path ?? location.id)};}
export async function putDailyPlan(context:FeatureContext,date:string,input:PutDailyPlanRequest,idempotencyKey=crypto.randomUUID()):Promise<DailyPlan> {return context.client.request('PUT','/api/v1/daily-plans/'+encodeURIComponent(date),input,{signal:context.signal,idempotencyKey});}
export function createTodayFeaturePort(options:TodayFeatureOptions):PageFeaturePort<'today'> {
  let latest:ViewContext|undefined,latestOverview:OverviewResponse|undefined,generation=0,createTopicKey=crypto.randomUUID();
  async function load(context:FeatureContext):Promise<ViewContext> {
    const own=++generation,base=await options.loadBase(context);if(base.provenance!=='service')throw new Error('今日正式投影只接受 service 数据');
    const overview=await context.client.request<OverviewResponse>('GET','/api/v1/overview',undefined,{signal:context.signal});
    const topicId=overview.topics.some(topic=>topic.id===context.ui.topic)?context.ui.topic:overview.topics[0]?.id??'',selected=topicId?await context.client.request<TopicDetail>('GET','/api/v1/topics/'+encodeURIComponent(topicId),undefined,{signal:context.signal}):undefined,today=projectToday(overview,topicId);
    const viewTopics=overview.topics.map(topic=>selected?.id===topic.id?topicView(selected,base.state.topics.find(old=>old.id===topic.id)):projectTopicSummary(topic)),selectedView=viewTopics.find(topic=>topic.id===topicId);
    if(selected&&selectedView){
      selectedView.versions={};
      const formats:Record<string,string>={xiaohongshu:'image_post',wechat:'article',x:'text',douyin:'short_video',bilibili:'long_video'};
      await Promise.all(selected.variants.filter(variant=>formats[String(variant.platform)]===variant.format).map(async variant=>{
        const doc=await context.client.getDocument(String(variant.document_id),context.signal);if(!doc.head_revision_id||!doc.text.trim())return;
        selectedView.versions[String(variant.platform)]={title:selected.title,text:doc.text,rev:doc.version,edited:true,status:selected.core_approval&&variant.based_on_core_revision_id===selected.core.head_revision_id?'已保存':'核心稿已变化'};
      }));
    }
    if(today.continuation){
      const continuation=today.continuation;
      try{
        const detail=await context.client.request<JobDetailResponse>('GET','/api/v1/jobs/'+encodeURIComponent(today.continuation.id),undefined,{signal:context.signal});
        if(detail.job.target_id!==topicId)delete today.continuation;
        else{const operation=JSON.parse(detail.job.input_manifest).operation,labels:Record<string,string>={document_modify:'核心稿修改',variant_generate:'平台稿制作',media_generate:operation==='h3_voice'?'声音试听':'素材制作',publication:'发布任务'};
          today.continuation.state=detail.job.state;today.continuation.version=detail.job.version;today.continuation.label=labels[detail.job.kind]??'相关任务';today.continuation.note=typeof detail.error?.message==='string'?detail.error.message:detail.job.state==='running'?'正在处理，任务结果会保留在创作记录中。':'任务记录已保留，可继续编辑当前内容。';
          if(['succeeded','failed','cancelled'].includes(detail.job.state))delete today.continuation;
        }
      }catch(error){context.signal.throwIfAborted();continuation.note='任务详情暂时未能读取，可继续编辑当前内容。';}
    }
    const view:ViewContext={...base,provenance:'service',ui:{...context.ui,topic:topicId},state:{...base.state,topics:viewTopics},NEWS:overview.recent_news.map(newsView),projections:{...base.projections,today}};
    if(own===generation&&!context.signal.aborted){latest=view;latestOverview=overview;}return view;
  }
  async function dispatch(action:FeatureAction,context:FeatureContext):Promise<ViewContext|void> {
    if(action.action==='new-topic') {
      createTopicKey=crypto.randomUUID();const {esc,btn}=createTemplateHelpers([]),source=latest?.NEWS.find(news=>news.id===action.dataset.source);
      context.surface.presentDialog({title:'建立一个新主题',body:'<label class="field-label" for="new-title">你想讲什么？</label><input class="field" id="new-title" placeholder="一个具体问题、一条实测或一个判断" value="'+esc(source?.title ?? '')+'"><label class="field-label" for="new-category">内容方向</label><select class="field" id="new-category" style="width:100%">'+['AI 实测','热点资讯','个人思考'].map(category=>'<option '+(source?.category===category?'selected':'')+'>'+category+'</option>').join('')+'</select><label class="field-label" for="new-angle">你的角度 / 目标读者</label><textarea class="field" id="new-angle" rows="3" placeholder="谁遇到了什么问题？你已有的依据是什么？">'+esc(source?.summary ?? '')+'</textarea>'+(source?'<p class="fine" style="margin-top:15px">关联资料：'+esc(source.title)+'</p>':''),foot:btn('取消','close-dialog')+btn('进入核心稿','create-topic',true,'data-source="'+esc(source?.id ?? '')+'"')});return;
    }
    if(action.action==='create-topic') {
      const title=String(action.fields['new-title'] ?? '').trim(),category=String(action.fields['new-category'] ?? '个人思考'),angle=String(action.fields['new-angle'] ?? '').trim();if(!title)throw new Error('写一个主题，再进入核心稿');
      const topic=await context.client.request<TopicDetail>('POST','/api/v1/topics',{title,category,audience:'',angle,source_ids:action.dataset.source?[action.dataset.source]:[]},{signal:context.signal,idempotencyKey:createTopicKey});
      context.surface.closeDialog('completed');context.surface.updateUi({topic:topic.id,editTab:'core',coreDirty:false});context.surface.navigate('create');context.surface.toast('主题已保存，核心稿等待你补充');return;
    }
    if(action.action==='open-create'||action.action==='select-topic') {
      const topicId=action.dataset.id ?? latest?.ui.topic ?? latest?.state.topics[0]?.id;
      if(typeof topicId==='string'&&topicId.trim()){context.surface.updateUi({topic:topicId,editTab:['core','versions','assets'].includes(action.dataset.tab??'')?action.dataset.tab:'core'});context.surface.navigate('create');}else context.surface.toast('当前尚无可继续的主题');return;
    }
    if(action.action==='open-adopted'){context.surface.navigate('retro');return;}
    return options.dispatchRelated?.(action,context);
  }
  return {page:'today',load,dispatch};
}
