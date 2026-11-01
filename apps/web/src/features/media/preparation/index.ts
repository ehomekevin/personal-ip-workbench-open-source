import type {PreparationShotInput,PatchPreparationPlanRequest,TopicDetail} from '@workbench/contracts';
import type {FeatureContext,FeatureAction,PageFeaturePort} from '../../../transport/feature-ports.ts';
import type {ViewContext} from '../../../app/view-model.ts';
export interface PreparationSnapshot {id:string;topic_id:string;head_plan_revision_id:string;version:number;shots:PreparationShotInput[]}
export interface PreparationApi {get(planId:string):Promise<PreparationSnapshot>;revise(planId:string,input:PatchPreparationPlanRequest,key?:string):Promise<{plan_revision_id:string;version:number}>}
export function createPreparationApi(context:FeatureContext):PreparationApi {const path=(id:string)=>encodeURIComponent(id);return {get:id=>context.client.request('GET','/api/v1/production-plans/'+path(id),undefined,{signal:context.signal}),revise:(id,input,key)=>context.client.request('PATCH','/api/v1/production-plans/'+path(id),input,{signal:context.signal,idempotencyKey:key??crypto.randomUUID()})};}
export function projectPreparation(snapshot:PreparationSnapshot) {return [...snapshot.shots].sort((a,b)=>a.position-b.position).map(shot=>({title:shot.title,kind:shot.kind,duration:shot.duration_ms/1000,status:String(shot.source_requirement.status??'pending')==='pending'?'待准备':'已准备'}));}
export function withPreparationFeaturePort(base:PageFeaturePort<'create'>):PageFeaturePort<'create'> {
  const snapshots=new Map<string,PreparationSnapshot>(),queues=new Map<string,Promise<void>>(),bindings=new Map<string,{plan_id:string;shot_keys:string[]}>();
  let selected:{topic_id:string;plan_id:string;shot_keys:string[]}|undefined,generation=0;
  type Edit={topic_id:string;plan_id:string;shot_key:string;context:FeatureContext;key:string}&({kind:'duration';duration_ms:number}|{kind:'move';offset:-1|1});
  function current(own:number,context:FeatureContext){context.signal.throwIfAborted();if(own!==generation)throw new DOMException('准备读取已被更新','AbortError');}
  function remember(read:PreparationSnapshot){const known=snapshots.get(read.id);if(!known||known.version<read.version)snapshots.set(read.id,structuredClone(read));return snapshots.get(read.id)!;}
  function accept(view:ViewContext){bindings.clear();for(const topic of view.state.topics)if(topic.preparation)bindings.set(topic.id,structuredClone(topic.preparation));return view;}
  async function enrich(view:ViewContext,context:FeatureContext,own:number):Promise<ViewContext>{
    current(own,context);if(view.provenance!=='service')throw new Error('准备计划投影只接受service数据');
    if(context.ui.page!=='create'||context.ui.editTab!=='assets')return accept(view);
    const topic=view.state.topics.find(item=>item.id===view.ui.topic);if(!topic){selected=undefined;return accept(view);}
    const detail=await context.client.request<TopicDetail>('GET','/api/v1/topics/'+encodeURIComponent(topic.id),undefined,{signal:context.signal});current(own,context);
    const read=await createPreparationApi(context).get(detail.preparation_plan_id);
    if(read.id!==detail.preparation_plan_id||read.topic_id!==topic.id)throw new Error('准备计划不属于所选主题');
    // 迟到读取只合并对应计划的更高版本，不覆盖已保存的版本或当前选择。
    const snapshot=remember(read);current(own,context);selected={topic_id:topic.id,plan_id:snapshot.id,shot_keys:[...snapshot.shots].sort((a,b)=>a.position-b.position).map(shot=>shot.shot_key)};
    // 只在新投影即将返回时接受所有主题的可见绑定，不在读取挂起期间替换旧控件身份。
    return accept({...view,ui:{...view.ui},state:{...view.state,topics:view.state.topics.map(item=>item.id===topic.id?{...item,shots:projectPreparation(snapshot),preparation:{plan_id:snapshot.id,shot_keys:[...selected!.shot_keys]}}:item)}});
  }
  async function load(context:FeatureContext):Promise<ViewContext>{const own=++generation,view=await base.load(context);return enrich({...view,ui:{...view.ui}},context,own);}
  function capture(action:FeatureAction,context:FeatureContext):Edit{
    const topic_id=context.ui.topic,binding=bindings.get(topic_id)??(selected?.topic_id===topic_id?selected:undefined);if(!binding?.plan_id)throw new Error('主题准备计划尚未加载');
    const index=Number(action.dataset.index);if(!Number.isSafeInteger(index)||index<0||index>=binding.shot_keys.length)throw new Error('镜头不存在');
    // 可见镜头顺序独立于已提交缓存，重排响应尚未刷新页面时仍按原控件身份保存。
    const target={topic_id,plan_id:binding.plan_id,shot_key:binding.shot_keys[index]!,context:{...context,ui:{...context.ui}},key:crypto.randomUUID()};
    if(action.action==='shot-duration'){const duration=Number(action.fields['shot-duration']);if(!Number.isFinite(duration)||duration<1||duration>180)throw new Error('镜头时长须为1至180秒');return {...target,kind:'duration',duration_ms:Math.round(duration*1000)};}
    return {...target,kind:'move',offset:action.action==='shot-up'?-1:1};
  }
  async function save(edit:Edit){
    let snapshot=snapshots.get(edit.plan_id);
    if(!snapshot){const read=await createPreparationApi(edit.context).get(edit.plan_id);if(read.id!==edit.plan_id||read.topic_id!==edit.topic_id)throw new Error('准备计划不属于所选主题');snapshot=remember(read);}
    if(snapshot.topic_id!==edit.topic_id)throw new Error('准备计划不属于所选主题');
    const shots=structuredClone(snapshot.shots).sort((a,b)=>a.position-b.position),index=shots.findIndex(shot=>shot.shot_key===edit.shot_key);if(index<0)throw new Error('镜头不存在');
    if(edit.kind==='duration')shots[index]!.duration_ms=edit.duration_ms;else{const target=index+edit.offset;if(target<0||target>=shots.length)return;[shots[index],shots[target]]=[shots[target]!,shots[index]!];shots.forEach((shot,position)=>shot.position=position);}
    const result=await createPreparationApi(edit.context).revise(edit.plan_id,{expected_version:snapshot.version,base_plan_revision_id:snapshot.head_plan_revision_id,shots},edit.key);
    remember({...snapshot,head_plan_revision_id:result.plan_revision_id,version:result.version,shots});edit.context.signal.throwIfAborted();
  }
  function orderedSave(edit:Edit){const work=(queues.get(edit.plan_id)??Promise.resolve()).then(()=>save(edit));queues.set(edit.plan_id,work.then(()=>undefined,()=>undefined));return work;}
  return {page:'create',load,async dispatch(action,context){
    const own=++generation;
    if(action.action==='shot-up'||action.action==='shot-down'||action.action==='shot-duration'){
      const edit=capture(action,context);await orderedSave(edit);current(own,context);
      if(context.ui.topic!==edit.topic_id)throw new DOMException('准备读取已被更新','AbortError');return load(context);
    }
    const view=await base.dispatch(action,context);current(own,context);if(view)return enrich({...view,ui:{...view.ui}},context,own);
  },async input(action,context){if(action.action==='shot-duration'){const edit=capture(action,context);await orderedSave(edit);return;}return base.input?.(action,context);}};
}
