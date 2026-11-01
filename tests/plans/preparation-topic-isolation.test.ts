import assert from 'node:assert/strict';
import test from 'node:test';
import type {PatchPreparationPlanRequest} from '../../packages/contracts/src/index.ts';
import {Topics} from '../../packages/domain/src/topics/index.ts';
import {TopicPreparation} from '../../packages/domain/src/topic-preparation/index.ts';
import type {FeatureAction,FeatureContext,PageFeaturePort} from '../../apps/web/src/transport/feature-ports.ts';
import type {RequestOptions,WorkbenchClient} from '../../apps/web/src/transport/workbench-client.ts';
import {initialUi,type ViewContext} from '../../apps/web/src/app/view-model.ts';
import {emptyIngestView} from '../../apps/web/src/features/sources/read/index.ts';
import {withPreparationFeaturePort,type PreparationSnapshot} from '../../apps/web/src/features/media/preparation/index.ts';
import {evidence,fixture} from './harness.ts';

function gate(){let release!:()=>void;const ready=new Promise<void>(resolve=>{release=resolve;});return {ready,release};}
async function bounded<T>(work:Promise<T>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('独立计划保存被其他计划阻塞')),2000);})]);}finally{clearTimeout(timer);}}
const duration=(seconds:number,index=0):FeatureAction=>({action:'shot-duration',dataset:{index:String(index)},fields:{'shot-duration':String(seconds)}});
const aborted=(error:unknown)=>error instanceof DOMException&&error.name==='AbortError';

async function realFeature(){
  const f=fixture(),topics=new Topics(f.context()),preparation=new TopicPreparation(f.context());
  try{
    const a=await topics.create(f.request(),{title:'隔离主题 A',category:'个人思考',audience:'',source_ids:[]});
    const b=await topics.create(f.request(),{title:'隔离主题 B',category:'个人思考',audience:'',source_ids:[]});
    const patches:Array<{plan_id:string;input:PatchPreparationPlanRequest;revision_id?:string}>=[];
    const hooks:{patch?:(planId:string,input:PatchPreparationPlanRequest)=>Promise<void>;get?:(snapshot:PreparationSnapshot)=>Promise<void>;base?:(view:ViewContext)=>Promise<void>}={};
    const client={async request(method:string,path:string,input?:unknown,options?:RequestOptions){
      if(method==='GET'&&path.startsWith('/api/v1/topics/'))return topics.get(f.request(),decodeURIComponent(path.slice('/api/v1/topics/'.length)));
      if(path.startsWith('/api/v1/production-plans/')){
        const planId=decodeURIComponent(path.slice('/api/v1/production-plans/'.length));
        if(method==='GET'){const snapshot=await preparation.get(f.request(),planId);await hooks.get?.(snapshot);return snapshot;}
        if(method==='PATCH'){
          const patch=structuredClone(input) as PatchPreparationPlanRequest,record={plan_id:planId,input:patch,revision_id:undefined as string|undefined};patches.push(record);
          await hooks.patch?.(planId,patch);const result=await preparation.revise(f.request(options?.idempotencyKey),planId,patch);record.revision_id=result.plan_revision_id;return result;
        }
      }
      throw new Error('unexpected '+method+' '+path);
    }} as WorkbenchClient;
    const ui={...initialUi('create'),topic:a.id,editTab:'assets'},context:FeatureContext={client,identity:f.context().identity,ui,signal:new AbortController().signal,surface:{updateUi(update){Object.assign(ui,update);},editorFeedback(){},presentDialog(){},closeDialog(){},toast(){},navigate(){}},drafts:{} as FeatureContext['drafts']};
    async function baseView(c:FeatureContext){const view=emptyIngestView(c,{...c.ui});view.state.topics=[a,b].map(t=>({id:t.id,title:t.title,category:t.category,source:'',confirmed:false,coreRev:0,core:'',versions:{},assets:[],shots:[]}));await hooks.base?.(view);return view;}
    const base:PageFeaturePort<'create'>={page:'create',load:baseView,async dispatch(action,c){if(action.action==='select-topic'){c.surface.updateUi({topic:action.dataset.id??''});return baseView(c);}}};
    const feature=withPreparationFeaturePort(base);
    return {f,a,b,preparation,context,ui,hooks,patches,feature};
  }catch(error){f.cleanup();throw error;}
}

test('R5 real preparation: two queued A inputs keep their topic, shot and value after switching to B',async()=>{
  const h=await realFeature(),started=gate(),release=gate();
  try{
    await h.feature.load(h.context);
    h.hooks.patch=async plan=>{if(plan===h.a.preparation_plan_id&&h.patches.length===1){started.release();await release.ready;}};
    const first=h.feature.input!(duration(3),h.context);await started.ready;
    const secondAction=duration(9),second=h.feature.input!(secondAction,h.context);
    // 调用方仍持有输入对象；入队后的修改也不能改变已经捕获的保存值。
    (secondAction.fields as Record<string,string>)['shot-duration']='77';
    h.ui.topic=h.b.id;const bView=await h.feature.load(h.context);assert.equal(bView.ui.topic,h.b.id);
    release.release();await Promise.all([first,second]);
    const a=await h.preparation.get(h.f.request(),h.a.preparation_plan_id),b=await h.preparation.get(h.f.request(),h.b.preparation_plan_id);
    assert.equal(a.shots[0]!.duration_ms,9000);assert.equal(b.shots[0]!.duration_ms,0);assert.equal(a.version,3);assert.equal(b.version,1);
    assert.deepEqual(h.patches.map(p=>[p.plan_id,p.input.expected_version,p.input.shots[0]!.duration_ms]),[[a.id,1,3000],[a.id,2,9000]]);
    assert.equal(h.patches[1]!.input.base_plan_revision_id,h.patches[0]!.revision_id);assert.equal(h.ui.topic,h.b.id);
    h.f.closeDb();h.f.openDb();const reopened=new TopicPreparation(h.f.context());assert.equal((await reopened.get(h.f.request(),a.id)).shots[0]!.duration_ms,9000);assert.equal((await reopened.get(h.f.request(),b.id)).shots[0]!.duration_ms,0);
    evidence('review-r5-queued-topic-isolation.json',{scope:'internal_rule',real_feature:true,real_domain_sqlite:true,actual_http:false,actual_browser:false,result:'passed',a,b,patches:h.patches,reopened:true,late_a_save_did_not_change_b:true,queued_fields_captured:true});
  }finally{release.release();h.f.cleanup();}
});

test('R6 real preparation: delegated B projection is immediately editable and has its own save queue',async()=>{
  const h=await realFeature(),started=gate(),release=gate();let first:Promise<void>|undefined;
  try{
    await h.feature.load(h.context);h.hooks.patch=async plan=>{if(plan===h.a.preparation_plan_id){started.release();await release.ready;}};
    first=h.feature.input!(duration(3),h.context);await started.ready;
    const bView=await h.feature.dispatch({action:'select-topic',dataset:{id:h.b.id},fields:{}},h.context) as ViewContext;
    assert.equal(bView.ui.topic,h.b.id);assert.equal(bView.state.topics.find(t=>t.id===h.b.id)!.shots[0]!.duration,0);
    // A 仍挂起，B 应立即写入自己的计划，不能等 A 的全局队列。
    await bounded(h.feature.input!(duration(6),h.context));const b=await h.preparation.get(h.f.request(),h.b.preparation_plan_id);assert.equal(b.shots[0]!.duration_ms,6000);assert.equal(b.version,2);
    release.release();await first;await h.feature.input!(duration(8),h.context);const after=await h.preparation.get(h.f.request(),b.id);assert.equal(after.shots[0]!.duration_ms,8000);assert.equal(after.version,3);assert.equal(h.ui.topic,h.b.id);
    assert.deepEqual(h.patches.map(p=>p.plan_id),[h.a.preparation_plan_id,b.id,b.id]);
    evidence('review-r6-delegated-projection.json',{scope:'internal_rule',real_feature:true,real_domain_sqlite:true,result:'passed',actual_http:false,actual_browser:false,no_extra_load_for_b_edit:true,b_saved_while_a_pending:true,late_a_did_not_change_b_version:true,patches:h.patches,b:after});
  }finally{release.release();try{await first;}finally{h.f.cleanup();}}
});

test('R6 real preparation: late delegated and plan reads cannot restore A selection or lower a committed version',async()=>{
  const h=await realFeature(),readStarted=gate(),readRelease=gate(),baseStarted=gate(),baseRelease=gate();
  try{
    await h.feature.load(h.context);
    h.hooks.get=async snapshot=>{if(snapshot.id===h.a.preparation_plan_id){h.hooks.get=undefined;readStarted.release();await readRelease.ready;}};
    const oldRead=h.feature.load(h.context),oldReadRejected=assert.rejects(oldRead,aborted);await readStarted.ready;
    await h.feature.input!(duration(4),h.context);
    const bView=await h.feature.dispatch({action:'select-topic',dataset:{id:h.b.id},fields:{}},h.context) as ViewContext;
    readRelease.release();await oldReadRejected;assert.equal(bView.ui.topic,h.b.id);assert.equal(h.ui.topic,h.b.id);
    await h.feature.input!(duration(5),h.context);
    h.hooks.base=async view=>{if(view.ui.topic===h.a.id){h.hooks.base=undefined;baseStarted.release();await baseRelease.ready;}};
    const oldBase=h.feature.dispatch({action:'select-topic',dataset:{id:h.a.id},fields:{}},h.context),oldBaseRejected=assert.rejects(oldBase,aborted);await baseStarted.ready;
    await h.feature.dispatch({action:'select-topic',dataset:{id:h.b.id},fields:{}},h.context);baseRelease.release();await oldBaseRejected;
    await h.feature.input!(duration(7),h.context);assert.equal(h.ui.topic,h.b.id);
    await h.feature.dispatch({action:'select-topic',dataset:{id:h.a.id},fields:{}},h.context);await h.feature.input!(duration(9),h.context);
    const a=await h.preparation.get(h.f.request(),h.a.preparation_plan_id),b=await h.preparation.get(h.f.request(),h.b.preparation_plan_id);assert.equal(a.version,3);assert.equal(a.shots[0]!.duration_ms,9000);assert.equal(b.version,3);assert.equal(b.shots[0]!.duration_ms,7000);
    assert.equal(h.patches.at(-1)!.input.expected_version,2);assert.equal(h.patches.at(-1)!.input.base_plan_revision_id,h.patches[0]!.revision_id);
    evidence('review-r6-late-read-isolation.json',{scope:'internal_rule',real_feature:true,real_domain_sqlite:true,result:'passed',actual_http:false,actual_browser:false,late_plan_read:'AbortError',late_delegated_view:'AbortError',selection_preserved:true,a,b,patches:h.patches});
  }finally{readRelease.release();baseRelease.release();h.f.cleanup();}
});

test('R5 real preparation: a stale same-plan read cannot lower the next queued CAS version',async()=>{
  const h=await realFeature(),started=gate(),release=gate();
  try{
    await h.feature.load(h.context);h.hooks.get=async snapshot=>{if(snapshot.id===h.a.preparation_plan_id){h.hooks.get=undefined;started.release();await release.ready;}};
    const oldRead=h.feature.load(h.context);await started.ready;
    await h.feature.input!(duration(3),h.context);release.release();const view=await oldRead;assert.equal(view.state.topics.find(t=>t.id===h.a.id)!.shots[0]!.duration,3);
    await h.feature.input!(duration(9),h.context);const a=await h.preparation.get(h.f.request(),h.a.preparation_plan_id);assert.equal(a.version,3);assert.equal(a.shots[0]!.duration_ms,9000);assert.deepEqual(h.patches.map(p=>p.input.expected_version),[1,2]);
    evidence('review-r5-late-version-monotonic.json',{scope:'internal_rule',real_feature:true,real_domain_sqlite:true,result:'passed',actual_http:false,actual_browser:false,stale_read_version:1,projected_duration_seconds:3,next_expected_version:2,a,patches:h.patches});
  }finally{release.release();h.f.cleanup();}
});

test('R5 real preparation: queued duration follows captured shot_key after an earlier reorder',async()=>{
  const h=await realFeature(),started=gate(),release=gate(),readStarted=gate(),readRelease=gate();let moved:Promise<ViewContext|void>|undefined;
  try{
    const before=await h.preparation.get(h.f.request(),h.a.preparation_plan_id);
    await h.preparation.revise(h.f.request(),before.id,{expected_version:before.version,base_plan_revision_id:before.head_plan_revision_id,shots:[{shot_key:'a',position:0,title:'镜头 A 标题',kind:'screen',duration_ms:1000,source_requirement:{status:'pending',reference:'准备依据 A'}},{shot_key:'b',position:1,title:'镜头 B 标题',kind:'live_action',duration_ms:2000,source_requirement:{status:'pending',reference:'准备依据 B'}}]});
    await h.feature.load(h.context);h.hooks.patch=async()=>{if(h.patches.length===1){started.release();await release.ready;}};
    h.hooks.get=async snapshot=>{if(snapshot.id===before.id&&snapshot.version>=3){h.hooks.get=undefined;readStarted.release();await readRelease.ready;}};
    moved=h.feature.dispatch({action:'shot-down',dataset:{index:'0'},fields:{}},h.context);await started.ready;
    const saved=h.feature.input!(duration(9),h.context);release.release();await saved;await readStarted.ready;
    // 保存缓存已重排，但页面刷新仍挂起；原 index=0 控件仍对应镜头 a。
    await h.feature.input!(duration(11),h.context);readRelease.release();await moved;
    const after=await h.preparation.get(h.f.request(),before.id);assert.deepEqual(after.shots.map(s=>[s.shot_key,s.position,s.duration_ms]),[['b',0,2000],['a',1,11000]]);
    assert.deepEqual(after.shots.map(s=>[s.title,s.kind,s.source_requirement.reference]),[['镜头 B 标题','live_action','准备依据 B'],['镜头 A 标题','screen','准备依据 A']]);
    assert.deepEqual(h.patches.map(p=>p.input.expected_version),[2,3,4]);assert.equal(h.patches[1]!.input.base_plan_revision_id,h.patches[0]!.revision_id);
    evidence('review-r5-stable-shot-key.json',{scope:'internal_rule',real_feature:true,real_domain_sqlite:true,result:'passed',actual_http:false,actual_browser:false,captured_shot_key:'a',initial_visible_index:0,final_position:1,reorder_refresh_pending:true,preserved_title_kind_source:true,after,patches:h.patches});
  }finally{release.release();readRelease.release();try{await moved;}finally{h.f.cleanup();}}
});
