import test from 'node:test';
import assert from 'node:assert/strict';
import { startApplication } from '../../apps/service/src/bootstrap/application.ts';
import { createTopicsModule } from '../../apps/service/src/routes/topics.ts';
import { createDocumentsModule } from '../../apps/service/src/routes/documents.ts';
import { createRetroModule } from '../../apps/service/src/routes/retro.ts';
import { createBusinessOutcomesModule } from '../../apps/service/src/routes/business-outcomes.ts';
import { createOverviewModule } from '../../apps/service/src/routes/overview.ts';
import { createDailyPlansModule } from '../../apps/service/src/routes/daily-plans.ts';
import { createHttpClient } from '../../apps/web/src/transport/workbench-client.ts';
import { createTodayFeaturePort,putDailyPlan } from '../../apps/web/src/features/today/index.ts';
import { createRetroActionsFeaturePort } from '../../apps/web/src/features/retro/actions/index.ts';
import { createBusinessOutcomesFeaturePort,createBusinessEvent } from '../../apps/web/src/features/retro/business-outcomes/index.ts';
import { initialUi,type ViewContext } from '../../apps/web/src/app/view-model.ts';
import type { FeatureContext,DialogView } from '../../apps/web/src/transport/feature-ports.ts';
import type { DraftRegistry } from '../../apps/web/src/transport/drafts.ts';
import { fixture,evidence } from '../retro-adoption/harness.ts';
import { Topics } from '../../packages/domain/src/topics/index.ts';
function base(context:FeatureContext):ViewContext {return {provenance:'service',projections:{},state:{version:1,agent:'codex',api:false,compact:false,favorites:[],adopted:false,topics:[],schedules:[],publications:[],accounts:[],notes:{},business:{count:null,source:'尚无记录'}},ui:{...context.ui},NEWS:[],KNOWLEDGE:[],files:new Map()};}
test('T27-feature-real-new-topic-and-rendered-topic-identity',async()=>{
  const f=fixture('tests/daily-plans');let app:Awaited<ReturnType<typeof startApplication>>|undefined;
  try {
    const a=await new Topics(f.context()).create(f.request(),{title:'卡片当前主题 A',category:'个人思考',audience:'',source_ids:[]}),b=await new Topics(f.context()).create(f.request(),{title:'计划首项主题 B',category:'AI 实测',audience:'',source_ids:[]});
    app=await startApplication(f.config,{port:0,moduleFactories:[createTopicsModule,createDocumentsModule,createOverviewModule,createDailyPlansModule]});
    const surfaceEvents:unknown[]=[],client=createHttpClient(`http://127.0.0.1:${app.address.port}`),ui={...initialUi('today'),topic:a.id};let dialog:DialogView|undefined;
    const context:FeatureContext={identity:f.identity,client,ui,signal:new AbortController().signal,drafts:{} as DraftRegistry,surface:{updateUi:patch=>{surfaceEvents.push({update:patch});Object.assign(ui,patch);},navigate:page=>{surfaceEvents.push({navigate:page});},toast:message=>surfaceEvents.push({toast:message}),presentDialog:value=>{dialog=value;},closeDialog:reason=>surfaceEvents.push({close:reason}),editorFeedback:()=>{}}};
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:f.config.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());await putDailyPlan(context,date,{timezone:f.config.timezone,expected_version:0,items:[{topic_id:b.id,effort_min:30,status:'pending'}]});
    const today=createTodayFeaturePort({loadBase:async context=>base(context)}),loaded=await today.load(context);assert.equal(loaded.ui.topic,a.id);assert.equal(loaded.state.topics.find(topic=>topic.id===loaded.ui.topic)!.title,'卡片当前主题 A');assert.equal(loaded.projections.today!.tasks![0]!.title,b.title);assert.match(loaded.projections.today!.tasks![0]!.note,/30 分钟人工投入/);assert.equal(loaded.projections.today!.tasks![0]!.topicId,b.id);
    await today.dispatch({action:'open-create',dataset:{},fields:{}},context);assert.equal(ui.topic,a.id);assert.equal((surfaceEvents[0] as {update:{topic:string}}).update.topic,a.id);
    await today.dispatch({action:'new-topic',dataset:{},fields:{}},context);assert.equal(dialog!.title,'建立一个新主题');assert.match(dialog!.body,/new-title/);assert.match(dialog!.body,/new-category/);
    await today.dispatch({action:'create-topic',dataset:{},fields:{'new-title':'浏览器既有按钮建立的真实主题','new-category':'个人思考','new-angle':'已有材料的角度'}},context);const after=await today.load(context);assert(after.state.topics.some(topic=>topic.title==='浏览器既有按钮建立的真实主题'));assert.equal(after.state.topics.find(topic=>topic.id===ui.topic)!.core,'');
    evidence('T27-feature-topic-selection-new-topic',{scope:'internal_rule',result:'passed',displayed_topic:a.id,planned_first_topic:b.id,opened_topic:a.id,surfaceEvents,created_topic:after.state.topics.find(topic=>topic.id===ui.topic),projection:after.projections.today});
  }catch(error){evidence('T27-feature-topic-selection-failure',{result:'failed',error:error instanceof Error?{message:error.message,stack:error.stack}:String(error)});throw error;}finally{await app?.close();f.cleanup();}
});
test('T26-feature-adoption-business-actual-HTTP-refresh',async()=>{
  const f=fixture('tests/daily-plans');let app:Awaited<ReturnType<typeof startApplication>>|undefined;
  try {
    const seeded=await f.report();app=await startApplication(f.config,{port:0,moduleFactories:[createRetroModule,createBusinessOutcomesModule,createTopicsModule,createDocumentsModule]});
    const events:unknown[]=[],ui={...initialUi('retro'),retroPlatform:'x'},context:FeatureContext={identity:f.identity,client:createHttpClient(`http://127.0.0.1:${app.address.port}`),ui,signal:new AbortController().signal,drafts:{} as DraftRegistry,surface:{updateUi:patch=>{events.push({update:patch});Object.assign(ui,patch);},navigate:page=>events.push({navigate:page}),toast:message=>events.push({toast:message}),presentDialog:value=>events.push({dialog:value}),closeDialog:reason=>events.push({close:reason}),editorFeedback:()=>{}}};
    const actions=createRetroActionsFeaturePort({loadBase:async context=>base(context)}),before=await actions.load(context);assert.equal(before.projections.retro!.adoptionAction!.id,seeded.action.id);assert.equal(before.projections.retro!.adoptionAction!.sourceRunId,seeded.run.id);assert.deepEqual(before.projections.retro!.adoptionAction!.baselineWorkIds.sort(),seeded.baselineWorks.sort());assert.deepEqual(before.projections.retro!.adoptionAction!.baselineSnapshotIds.sort(),seeded.snapshots.map(snapshot=>snapshot.id).sort());
    await Promise.all([actions.dispatch({action:'adopt-retro',dataset:{},fields:{}},context),actions.dispatch({action:'adopt-retro',dataset:{},fields:{}},context)]);
    const refreshed=await createRetroActionsFeaturePort({loadBase:async context=>base(context)}).load(context);assert.equal(f.context().db.prepare('SELECT count(*) n FROM topics').get()!.n,1);assert.equal(typeof refreshed.state.adopted,'string');assert.equal(refreshed.projections.retro!.adoptionAction!.sourceRunId,seeded.run.id);assert.deepEqual(refreshed.projections.retro!.adoptionAction!.baselineWorkIds.sort(),seeded.baselineWorks.sort());assert.deepEqual(refreshed.projections.retro!.adoptionAction!.baselineSnapshotIds.sort(),seeded.snapshots.map(snapshot=>snapshot.id).sort());await actions.dispatch({action:'open-adopted',dataset:{},fields:{}},context);assert.equal(ui.topic,refreshed.state.adopted);
    const business=createBusinessOutcomesFeaturePort({loadBase:async()=>refreshed});await business.dispatch({action:'business',dataset:{},fields:{}},context);await business.dispatch({action:'save-business',dataset:{},fields:{'business-count':'2','business-source':'未知'}},context);const after=await createBusinessOutcomesFeaturePort({loadBase:async()=>refreshed}).load(context);assert.equal(after.state.business.count,'2');assert.equal(after.state.business.source,'未知');
    await createBusinessEvent(context,{kind:'consultation',time:new Date().toISOString(),count:'9007199254740993',note:'原样保留大数',attribution:'unknown'});const huge=await business.load(context);assert.equal(huge.state.business.count,'9007199254740993');
    evidence('T26-feature-adoption-business-http',{scope:'internal_rule',result:'passed',action:seeded.action.id,source_projection_before:before.projections.retro!.adoptionAction,source_projection_after:refreshed.projections.retro!.adoptionAction,adoption:refreshed.state.adopted,business:after.state.business,huge:huge.state.business,events});
  }catch(error){evidence('T26-feature-adoption-business-failure',{result:'failed',error:error instanceof Error?{message:error.message,stack:error.stack}:String(error)});throw error;}finally{await app?.close();f.cleanup();}
});
test('T27-empty-topic-control-keeps-user-on-today',async()=>{
  const f=fixture('tests/daily-plans');let app:Awaited<ReturnType<typeof startApplication>>|undefined;
  try{app=await startApplication(f.config,{port:0,moduleFactories:[createOverviewModule,createTopicsModule,createDocumentsModule]});const events:unknown[]=[],ui=initialUi('today'),context:FeatureContext={identity:f.identity,client:createHttpClient(`http://127.0.0.1:${app.address.port}`),ui,signal:new AbortController().signal,drafts:{} as DraftRegistry,surface:{updateUi:patch=>events.push({update:patch}),navigate:page=>events.push({navigate:page}),toast:message=>events.push({toast:message}),presentDialog:value=>events.push({dialog:value}),closeDialog:()=>{},editorFeedback:()=>{}}};const today=createTodayFeaturePort({loadBase:async context=>base(context)}),loaded=await today.load(context);assert.equal(loaded.ui.topic,'');await today.dispatch({action:'open-create',dataset:{},fields:{}},context);assert.deepEqual(events,[{toast:'当前尚无可继续的主题'}]);evidence('T27-feature-empty-topic-control',{scope:'internal_rule',result:'passed',topic:loaded.ui.topic,events});}catch(error){evidence('T27-feature-empty-topic-failure',{result:'failed',message:String(error)});throw error;}finally{await app?.close();f.cleanup();}
});
