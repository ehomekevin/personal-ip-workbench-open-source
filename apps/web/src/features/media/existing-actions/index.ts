import type { JobDetailResponse, AssetsRow, Page, JsonObject } from '@workbench/contracts';
import type { ViewContext } from '../../../app/view-model.ts';
import type { FeatureContext, PageFeaturePort } from '../../../transport/feature-ports.ts';
import { createTemplateHelpers } from '../../../components/templateHelpers.ts';

// 复用原有上传/H3动作和任务对话框；素材记录只来自正式服务。
export interface ExistingMediaTransport {request<T>(method:'POST',path:string,input:unknown):Promise<T>;upload<T>(path:string,file:File,fields:Record<string,string>):Promise<T>}
export function existingMediaActions(transport:ExistingMediaTransport){return{upload(file:File,topic_id:string,purpose:string){return transport.upload('/api/v1/assets',file,{topic_id,purpose});},generate(input:{topic_id:string;purpose:string;prompt:string;input_asset_ids:string[];generator:string}){return transport.request<{job_id:string}>('POST','/api/v1/asset-generations',input);}};}

const delay=(signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const done=()=>{signal.removeEventListener('abort',abort);resolve();},timer=setTimeout(done,250),abort=()=>{clearTimeout(timer);reject(signal.reason??new DOMException('Aborted','AbortError'));};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
async function showGeneration(context:FeatureContext,jobId:string):Promise<void>{
  const {btn,esc}=createTemplateHelpers([]);const present=(detail:JobDetailResponse)=>context.surface.presentDialog({title:'H3 素材任务',body:'<div class="task-orb"><span>a.</span></div><p class="fine" style="text-align:center">'+esc(detail.job.state==='queued'?'等待素材执行器领取…':'读取固定素材输入…')+'</p><div class="progress-track"><div id="task-progress" style="width:12%"></div></div><p id="task-text" style="font-size:12px">H3 配置、本人输入与付费调用尚待核对。</p>',foot:btn('取消任务','cancel-task'),foregroundJob:{id:jobId,version:detail.job.version}});
  let detail=await context.client.request<JobDetailResponse>('GET','/api/v1/jobs/'+encodeURIComponent(jobId),undefined,{signal:context.signal});
  if(!['succeeded','waiting_input','waiting_quota','failed','cancelled','reconciling'].includes(detail.job.state))present(detail);
  while(!context.signal.aborted){
    if(detail.job.state==='succeeded'){context.surface.closeDialog('completed');context.surface.toast('素材任务完成，已读取正式素材记录');return;}
    if(['cancelled','cancel_requested'].includes(detail.job.state)){context.surface.closeDialog('completed');return;}
    if(['waiting_input','waiting_quota','failed','reconciling'].includes(detail.job.state)){context.surface.closeDialog('completed');context.surface.toast(detail.error&&typeof detail.error.message==='string'?detail.error.message:'素材任务需要补充输入；现有素材保留');return;}
    if(!(context.surface.isForegroundJobActive?.(jobId)??true))return;
    await delay(context.signal);detail=await context.client.request<JobDetailResponse>('GET','/api/v1/jobs/'+encodeURIComponent(jobId),undefined,{signal:context.signal});
    if(!(context.surface.isForegroundJobActive?.(jobId)??true))return;
    if(!['succeeded','waiting_input','waiting_quota','failed','cancelled','cancel_requested','reconciling'].includes(detail.job.state))present(detail);
  }
}

type AssetListItem=Pick<AssetsRow,'id'|'kind'|'origin'|'size_bytes'|'sha256'|'mime'|'status'>&{generation_metadata?:JsonObject|string|null};
function projectAsset(asset:AssetListItem){let metadata:JsonObject={};try{const value=typeof asset.generation_metadata==='string'?JSON.parse(asset.generation_metadata):asset.generation_metadata;if(value&&typeof value==='object'&&!Array.isArray(value))metadata=value as JsonObject;}catch{/* 保留未解析来源，不猜测业务素材。 */}const kind=({image:'图片',video:'视频',audio:'音频',file:'文件'} as Record<string,string>)[asset.kind]??asset.kind,state=({ready:'可用',referenced:'原地引用',missing:'无法访问'} as Record<string,string>)[asset.status]??asset.status;return{id:asset.id,name:kind+'素材 · '+asset.id.slice(0,8),type:kind+' · '+state,size:asset.size_bytes,note:[typeof metadata.purpose==='string'?metadata.purpose:'',typeof metadata.source_kind==='string'?metadata.source_kind:asset.origin,typeof metadata.provider==='string'?metadata.provider:'',typeof metadata.model==='string'?metadata.model:'',typeof metadata.parent_asset_id==='string'?'基于原图 '+metadata.parent_asset_id.slice(0,8):'','SHA256 '+asset.sha256.slice(0,12)].filter(Boolean).join(' · ')};}

export function withExistingMediaActions(base:PageFeaturePort<'create'>):PageFeaturePort<'create'>{
  let generationKey=crypto.randomUUID(),latest:ViewContext|undefined,loadGeneration=0;
  const project=async(context:FeatureContext,baseView:ViewContext,own:number):Promise<ViewContext>=>{if(baseView.provenance!=='service')throw new Error('素材投影只接受正式服务数据');const topics=await Promise.all(baseView.state.topics.map(async topic=>{if(context.ui.page!=='create'||context.ui.editTab!=='assets'||topic.id!==baseView.ui.topic)return topic;const page=await context.client.request<Page<AssetListItem>>('GET','/api/v1/assets?topic_id='+encodeURIComponent(topic.id),undefined,{signal:context.signal});return {...topic,assets:page.items.map(projectAsset)};}));const view={...baseView,state:{...baseView.state,topics}};if(own===loadGeneration&&!context.signal.aborted)latest=view;return view;};
  const load=async(context:FeatureContext)=>{const own=++loadGeneration;return project(context,await base.load(context),own);};
  return {...base,load,dispatch:async(action,context)=>{
    const topicId=context.ui.topic;if(!['upload','h3-task','do-h3','open-assets'].includes(action.action)){const own=++loadGeneration,result=await base.dispatch(action,context);return result?project(context,result,own):undefined;}
    if(!topicId)throw new Error('先选择素材所属主题');
    if(action.action==='open-assets'){context.surface.closeDialog('completed');context.surface.updateUi({editTab:'assets'});if(context.ui.page!=='create'){context.surface.navigate('create');return;}return load({...context,ui:{...context.ui,editTab:'assets'}});}
    const actions=existingMediaActions({request:(method,path,input)=>context.client.request(method,path,input,{signal:context.signal,idempotencyKey:generationKey}),upload:(path,file,fields)=>{if(!context.client.upload)throw new Error('当前宿主未配置素材上传能力');return context.client.upload(path,file,fields,{signal:context.signal,idempotencyKey:crypto.randomUUID()});}});
    if(action.action==='upload'){
      if(!action.files?.length)return;
      for(const file of action.files){context.signal.throwIfAborted();await actions.upload(file,topicId,String(action.fields.purpose??'主题素材'));}
      context.surface.toast('素材已导入并核对文件 hash');return load(context);
    }
    const {btn,esc}=createTemplateHelpers([]);
    if(action.action==='h3-task'){
      const current=latest??await load(context),topic=current.state.topics.find(t=>t.id===topicId);if(!topic)throw new Error('当前主题已变化，请重新选择素材所属主题');const script=topic.versions[context.ui.platform];generationKey=crypto.randomUUID();context.surface.presentDialog({title:'H3 素材任务',body:'<label class="field-label" for="h3-prompt">素材用途与画面说明</label><textarea class="field" id="h3-prompt" rows="4" placeholder="说明当前主题需要的素材与镜头用途"></textarea><p class="fine" style="margin-top:14px">'+esc(topic.title)+' · '+(script?.text?'当前平台已有文稿':'当前平台脚本待补充')+'。H3 未配置，本人输入与调用授权待补充。</p>',foot:btn('取消','close-dialog')+btn('创建素材任务','do-h3',true)});return;
    }
    const prompt=String(action.fields['h3-prompt']??'').trim();if(!prompt)throw new Error('填写素材用途与画面说明');
    const accepted=await actions.generate({topic_id:topicId,purpose:String(action.fields.purpose??'辅助画面'),prompt,input_asset_ids:[],generator:'h3'});
    await showGeneration(context,accepted.job_id);return load(context);
  }};
}
