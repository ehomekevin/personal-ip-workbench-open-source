import assert from 'node:assert/strict';
import test from 'node:test';
import type {PatchPreparationPlanRequest,PreparationShotInput} from '../../packages/contracts/src/index.ts';
import {Topics} from '../../packages/domain/src/topics/index.ts';
import {TopicPreparation} from '../../packages/domain/src/topic-preparation/index.ts';
import type {FeatureAction,FeatureContext,PageFeaturePort} from '../../apps/web/src/transport/feature-ports.ts';
import type {RequestOptions,WorkbenchClient} from '../../apps/web/src/transport/workbench-client.ts';
import {initialUi,type ViewContext} from '../../apps/web/src/app/view-model.ts';
import {emptyIngestView} from '../../apps/web/src/features/sources/read/index.ts';
import {withPreparationFeaturePort,type PreparationSnapshot} from '../../apps/web/src/features/media/preparation/index.ts';
import {evidence,fixture} from './harness.ts';

function gate(){let release!:()=>void;const ready=new Promise<void>(resolve=>{release=resolve;});return {ready,release};}
async function bounded<T>(work:Promise<T>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('可见输入等待了无关读取或计划')),2000);})]);}finally{clearTimeout(timer);}}
const duration=(seconds:number,index=0):FeatureAction=>({action:'shot-duration',dataset:{index:String(index)},fields:{'shot-duration':String(seconds)}});
const select=(id:string):FeatureAction=>({action:'select-topic',dataset:{id},fields:{}});

async function realVisibleFeature(metadata=true,bShots?:PreparationShotInput[]){
  const f=fixture(),topics=new Topics(f.context()),preparation=new TopicPreparation(f.context());
  try{
    const a=await topics.create(f.request(),{title:'可见输入 A',category:'个人思考',audience:'',source_ids:[]}),b=await topics.create(f.request(),{title:'可见输入 B',category:'个人思考',audience:'',source_ids:[]});
    if(bShots){const initial=await preparation.get(f.request(),b.preparation_plan_id);await preparation.revise(f.request(),initial.id,{expected_version:initial.version,base_plan_revision_id:initial.head_plan_revision_id,shots:bShots});}
    const patches:Array<{plan_id:string;input:PatchPreparationPlanRequest;revision_id?:string}>=[],reads:Array<{plan_id:string;version:number}>=[];
    const hooks:{afterPatch?:(planId:string)=>Promise<void>;get?:(snapshot:PreparationSnapshot)=>Promise<void>}={};
    const client={async request(method:string,path:string,input?:unknown,options?:RequestOptions){
      if(method==='GET'&&path.startsWith('/api/v1/topics/'))return topics.get(f.request(),decodeURIComponent(path.slice('/api/v1/topics/'.length)));
      if(path.startsWith('/api/v1/production-plans/')){
        const planId=decodeURIComponent(path.slice('/api/v1/production-plans/'.length));
        if(method==='GET'){const snapshot=await preparation.get(f.request(),planId);reads.push({plan_id:planId,version:snapshot.version});await hooks.get?.(snapshot);return snapshot;}
        if(method==='PATCH'){
          const patch=structuredClone(input) as PatchPreparationPlanRequest,record={plan_id:planId,input:patch,revision_id:undefined as string|undefined};patches.push(record);
          const result=await preparation.revise(f.request(options?.idempotencyKey),planId,patch);record.revision_id=result.plan_revision_id;await hooks.afterPatch?.(planId);return result;
        }
      }
      throw new Error('unexpected '+method+' '+path);
    }} as WorkbenchClient;
    const ui={...initialUi('create'),topic:a.id,editTab:'assets'},context:FeatureContext={client,identity:f.context().identity,ui,signal:new AbortController().signal,surface:{updateUi(update){Object.assign(ui,update);},editorFeedback(){},presentDialog(){},closeDialog(){},toast(){},navigate(){}},drafts:{} as FeatureContext['drafts']};
    async function baseView(c:FeatureContext){
      const view=emptyIngestView(c,{...c.ui}),actual=await Promise.all([a,b].map(t=>topics.get(f.request(),t.id)));
      view.state.topics=actual.map(t=>({id:t.id,title:t.title,category:t.category,source:'',confirmed:false,coreRev:0,core:'',versions:{},assets:[],shots:t.shots.map(s=>({title:s.title,kind:s.kind,duration:s.duration_ms/1000,status:'待准备'})),...(metadata?{preparation:{plan_id:t.preparation_plan_id,shot_keys:[...t.shots].sort((x,y)=>x.position-y.position).map(s=>s.shot_key)}}:{})}));return view;
    }
    const base:PageFeaturePort<'create'>={page:'create',load:baseView,async dispatch(action,c){if(action.action==='select-topic'){c.surface.updateUi({topic:action.dataset.id??''});return baseView(c);}}};
    return {f,a,b,preparation,context,ui,hooks,patches,reads,feature:withPreparationFeaturePort(base)};
  }catch(error){f.cleanup();throw error;}
}

test('R5/R6 visible B input saves before B enrich GET or the earlier A PATCH reply is released',async()=>{
  const h=await realVisibleFeature(),aStarted=gate(),aRelease=gate(),bStarted=gate(),bRelease=gate();const pending:Promise<unknown>[]=[];
  try{
    const initial=await h.feature.load(h.context);assert.equal(initial.state.topics.find(t=>t.id===h.b.id)!.preparation!.plan_id,h.b.preparation_plan_id);
    h.hooks.afterPatch=async plan=>{if(plan===h.a.preparation_plan_id&&h.patches.length===1){aStarted.release();await aRelease.ready;}};
    const first=h.feature.input!(duration(3),h.context);pending.push(first);await aStarted.ready;
    assert.equal((await h.preparation.get(h.f.request(),h.a.preparation_plan_id)).shots[0]!.duration_ms,3000);
    const second=h.feature.input!(duration(9),h.context);pending.push(second);
    h.hooks.get=async snapshot=>{if(snapshot.id===h.b.preparation_plan_id){h.hooks.get=undefined;bStarted.release();await bRelease.ready;}};
    const switching=h.feature.dispatch(select(h.b.id),h.context);pending.push(switching);await bStarted.ready;assert.equal(h.ui.topic,h.b.id);
    const bInput=h.feature.input!(duration(4),h.context);pending.push(bInput);await bounded(bInput);
    const beforeReleaseB=await h.preparation.get(h.f.request(),h.b.preparation_plan_id);assert.equal(beforeReleaseB.shots[0]!.duration_ms,4000);assert.equal(beforeReleaseB.version,2);
    assert.equal((await h.preparation.get(h.f.request(),h.a.preparation_plan_id)).shots[0]!.duration_ms,3000);assert.deepEqual(h.patches.map(p=>p.plan_id),[h.a.preparation_plan_id,h.b.preparation_plan_id]);
    bRelease.release();const view=await switching as ViewContext;assert.equal(view.ui.topic,h.b.id);assert.equal(view.state.topics.find(t=>t.id===h.b.id)!.shots[0]!.duration,4);
    aRelease.release();await Promise.all([first,second]);const a=await h.preparation.get(h.f.request(),h.a.preparation_plan_id),b=await h.preparation.get(h.f.request(),h.b.preparation_plan_id);
    assert.equal(a.shots[0]!.duration_ms,9000);assert.equal(b.shots[0]!.duration_ms,4000);assert.equal(h.ui.topic,h.b.id);assert.deepEqual(h.patches.map(p=>[p.plan_id,p.input.expected_version]),[[a.id,1],[b.id,1],[a.id,2]]);
    evidence('review-visible-input-before-enrich.json',{scope:'internal_rule',real_feature:true,real_domain_sqlite:true,result:'passed',actual_http:false,actual_browser:false,a_first_committed_reply_pending:true,b_enrich_response_pending_at_b_save:true,b_saved_without_wait:true,a,b,b_before_releasing_reads:beforeReleaseB,patches:h.patches,reads:h.reads});
  }finally{aRelease.release();bRelease.release();await Promise.allSettled(pending);h.f.cleanup();}
});

test('R5/R6 visible metadata stays at the accepted order until the new view returns',async()=>{
  const shots:PreparationShotInput[]=[{shot_key:'b-a',position:0,title:'可见首镜头',kind:'screen',duration_ms:1000,source_requirement:{status:'pending'}},{shot_key:'b-b',position:1,title:'可见次镜头',kind:'live_action',duration_ms:2000,source_requirement:{status:'pending'}}];
  const h=await realVisibleFeature(true,shots),started=gate(),release=gate();const pending:Promise<unknown>[]=[];
  try{
    const accepted=await h.feature.load(h.context);assert.deepEqual(accepted.state.topics.find(t=>t.id===h.b.id)!.preparation!.shot_keys,['b-a','b-b']);
    const before=await h.preparation.get(h.f.request(),h.b.preparation_plan_id);await h.preparation.revise(h.f.request(),before.id,{expected_version:before.version,base_plan_revision_id:before.head_plan_revision_id,shots:[{...before.shots[1]!,position:0},{...before.shots[0]!,position:1}]});
    h.hooks.get=async snapshot=>{if(snapshot.id===before.id){h.hooks.get=undefined;started.release();await release.ready;}};
    const switching=h.feature.dispatch(select(h.b.id),h.context);pending.push(switching);await started.ready;
    await bounded(h.feature.input!(duration(4,0),h.context));const during=await h.preparation.get(h.f.request(),before.id);
    assert.deepEqual(during.shots.map(s=>[s.shot_key,s.duration_ms]),[['b-b',2000],['b-a',4000]]);
    release.release();const returned=await switching as ViewContext;assert.deepEqual(returned.state.topics.find(t=>t.id===h.b.id)!.preparation!.shot_keys,['b-b','b-a']);
    await h.feature.input!(duration(6,0),h.context);const after=await h.preparation.get(h.f.request(),before.id);assert.deepEqual(after.shots.map(s=>[s.shot_key,s.duration_ms]),[['b-b',6000],['b-a',4000]]);assert.equal(h.ui.topic,h.b.id);
    evidence('review-visible-binding-return-boundary.json',{scope:'internal_rule',real_feature:true,real_domain_sqlite:true,result:'passed',actual_http:false,actual_browser:false,accepted_keys:['b-a','b-b'],incoming_keys_not_accepted_before_return:true,pending_input_key:'b-a',returned_keys:['b-b','b-a'],next_input_key:'b-b',during,after,patches:h.patches});
  }finally{release.release();await Promise.allSettled(pending);h.f.cleanup();}
});

test('R5/R6 no initial visible binding rejects explicitly while legacy loaded-topic editing still works',async()=>{
  const h=await realVisibleFeature(false),started=gate(),release=gate();const pending:Promise<unknown>[]=[];
  try{
    await assert.rejects(h.feature.input!(duration(4),h.context),/主题准备计划尚未加载/);assert.equal(h.patches.length,0);
    await h.feature.load(h.context);h.hooks.get=async snapshot=>{if(snapshot.id===h.b.preparation_plan_id){h.hooks.get=undefined;started.release();await release.ready;}};
    const switching=h.feature.dispatch(select(h.b.id),h.context);pending.push(switching);await started.ready;
    await assert.rejects(h.feature.input!(duration(4),h.context),/主题准备计划尚未加载/);assert.equal(h.patches.length,0);
    release.release();await switching;await h.feature.input!(duration(4),h.context);assert.equal((await h.preparation.get(h.f.request(),h.b.preparation_plan_id)).shots[0]!.duration_ms,4000);
    evidence('review-visible-missing-binding.json',{scope:'internal_rule',real_feature:true,real_domain_sqlite:true,result:'passed',actual_http:false,actual_browser:false,initial_unknown_target:'explicit_rejection',missing_other_topic_metadata:'explicit_rejection',legacy_loaded_topic:'saved',patches:h.patches});
  }finally{release.release();await Promise.allSettled(pending);h.f.cleanup();}
});
