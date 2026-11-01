import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyTopicOperations, type DecideTopicOperationsRequest, type OperationsAutomation, type TopicOperationsSnapshot } from '../../packages/contracts/src/operations.ts';
import { operationsNext, renderOperationsPanel, withAccountOperationsFeature } from '../../apps/web/src/features/operations/index.ts';
import { initialUi, type OperationsProjection, type ViewContext } from '../../apps/web/src/app/view-model.ts';
import type { DialogView, FeatureAction, FeatureContext, PageFeaturePort } from '../../apps/web/src/transport/feature-ports.ts';

function snapshot(topic='first',state:OperationsAutomation['state']='candidate'):TopicOperationsSnapshot {
  const data=emptyTopicOperations();
  return {topic_id:topic,document:null,data,automation:{source_version:'source-1',input_version:'input-1',state,job_id:'job-1',job_version:1,limitations:[],feedback_status:'ready',error:null,candidate:state==='candidate'?{
    id:'candidate-'+topic,status:'pending',base_operations_revision_id:null,
    data:{schema_version:1,brief:{reader_task:'读者正在配置工作台',takeaway:'能独立核对接入结果',personal_addition:'补充本人实测',evidence:'已有配置记录',goal:'读者成功接入',reader_next_step:'核对本地设置'},feedback_labels:[{id:'feedback-1',kind:'question'},{id:'feedback-author',kind:'response'}],followups:[{id:'proposal-1',title:'接入失败怎么排查',new_help:'根据实际错误定位配置缺口',evidence_keys:['feedback:feedback-1']}],limitations:['平台稿尚待补充']},
    feedback:[{id:'feedback-1',kind:'question',text:'接入失败后在哪里核对？',source:'小红书评论',recorded_at:'2026-10-12T00:00:00.000Z',provenance:'platform',work_id:'internal-work-id',work_url:'https://example.org/works/1',author_name:'真实读者',commented_at:'2026-10-11T00:00:00.000Z',is_author:false},{id:'feedback-author',kind:'response',text:'作者补充说明',source:'小红书评论',recorded_at:'2026-10-12T00:00:00.000Z',provenance:'platform',work_id:'internal-work-id',work_url:'https://example.org/works/1',author_name:'作品作者',is_author:true}]
  }:null}};
}
function projection(value:TopicOperationsSnapshot):OperationsProjection { return {topicId:value.topic_id,title:'本人工作台实测',snapshot:value,coreConfirmed:false,variantCount:0,publishedWorks:[]}; }
function view(ui=initialUi('create')):ViewContext { return {provenance:'service',ui:{...ui},projections:{},state:{topics:[]} as unknown as ViewContext['state'],NEWS:[],KNOWLEDGE:[],files:new Map()}; }
type Call={method:string;url:string;body:unknown;options?:{idempotencyKey?:string;signal?:AbortSignal}};
function harness(state:OperationsAutomation['state']='candidate'){
  const ui=initialUi('create');ui.topic='first';
  const abort=new AbortController(),calls:Call[]=[],dialogs:DialogView[]=[],toasts:string[]=[],busy:boolean[]=[];
  const snapshots=new Map([['first',snapshot('first',state)],['second',snapshot('second')]]);
  let closeCount=0,refreshCount=0;
  let onRequest:((call:Call)=>Promise<unknown>|undefined)|undefined;
  const context={ui,signal:abort.signal,surface:{presentDialog(value:DialogView){dialogs.push(value);},closeDialog(){closeCount++;},dialogBusy(value:boolean){busy.push(value);},toast(value:string){toasts.push(value);},updateUi(patch:object){refreshCount++;Object.assign(ui,patch);},navigate(page:typeof ui.page){ui.page=page;},editorFeedback(){}},client:{async request(method:string,url:string,body:unknown,options?:Call['options']){
    const call={method,url,body,options};calls.push(call);const delayed=onRequest?.(call);if(delayed)return delayed;
    if(url==='/api/v1/topics')return {items:[{id:'first'},{id:'second'}],next_cursor:null};
    if(url.startsWith('/api/v1/works'))return {items:[],next_cursor:null};
    const id=url.split('/')[4]!,current=snapshots.get(id)!;
    if(url.endsWith('/decision')){
      const input=body as DecideTopicOperationsRequest,saved=structuredClone(current);
      if(input.decision==='confirm'){
        saved.data={schema_version:1,brief:input.brief!,feedback:current.automation!.candidate!.feedback.filter(row=>input.feedback_ids!.includes(row.id)),followups:(input.followups??[]).map(row=>({topic_id:'next-'+row.id,title:row.title,new_help:row.new_help})),confirmed_generation:{candidate_id:input.candidate_id,source_version:'source-1'}};
        saved.document={document_id:'operations-'+id,head_revision_id:'revision-1',text:JSON.stringify(saved.data)} as TopicOperationsSnapshot['document'];
      }
      saved.automation!.state=input.decision==='confirm'?'confirmed':'rejected';saved.automation!.candidate!.status=input.decision==='confirm'?'adopted':'rejected';snapshots.set(id,saved);return saved;
    }
    if(url.endsWith('/operations')||url.endsWith('/ensure'))return structuredClone(current);
    return {id,title:'本人工作台实测',core:{head_revision_id:null},core_approval:null,variants:[]};
  }}} as unknown as FeatureContext;
  const base={page:'create',load:async()=>view(ui),dispatch:async()=>undefined} as PageFeaturePort<'create'>;
  const feature=withAccountOperationsFeature(base);
  const dispatch=(action:FeatureAction['action'],fields:FeatureAction['fields']={},dataset:FeatureAction['dataset']={})=>feature.dispatch({action,fields,dataset},context);
  return {ui,abort,calls,dialogs,toasts,busy,snapshots,context,feature,dispatch,set onRequest(value:typeof onRequest){onRequest=value;},get closeCount(){return closeCount;},get refreshCount(){return refreshCount;}};
}
function confirmFields(value:TopicOperationsSnapshot):Record<string,string|boolean> {
  return {...Object.fromEntries(Object.entries(value.automation!.candidate!.data.brief).map(([key,text])=>['operations-candidate-'+key,text])), 'operations-candidate-confirmed':true,'operations-candidate-feedback-0':true,'operations-candidate-feedback-1':false,'operations-candidate-followup-0':true,'operations-candidate-title-0':'本人修改后的后续题目','operations-candidate-help-0':'补充实测排查过程'};
}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}

test('运营页默认入口展示自动候选与执行状态，未确认时没有手填入口',()=>{
  for(const [state,label] of [['queued','已排队'],['running','正在整理'],['waiting_input','等待补充输入'],['waiting_quota','等待执行额度'],['failed','生成失败'],['blocked','暂时无法生成'],['candidate','候选待本人确认']] as const){
    const value=snapshot('first',state);if(state==='failed')value.automation!.error='<执行失败>';
    const p=projection(value),rendered=renderOperationsPanel({...view(),projections:{operations:p}});
    assert.match(rendered,new RegExp(label));assert.doesNotMatch(rendered,/data-action="operations-brief"/);assert.doesNotMatch(rendered,/补齐运营简报|记录读者反馈/);
    if(state==='failed')assert.match(rendered,/&lt;执行失败&gt;/);
  }
  assert.equal(operationsNext(projection(snapshot())).action,'operations-review-candidate');
  assert.equal(operationsNext(projection(snapshot('first','queued'))).action,'operations-reload');
  const confirmed=snapshot('first','confirmed');assert.equal(operationsNext(projection(confirmed)).action,'operations-go');assert.equal(operationsNext(projection(confirmed)).tab,'core');
});

test('初次load显式ensure，后续读取仅GET，显式重试携带retry与反馈刷新',async()=>{
  const h=harness();await h.feature.load(h.context);
  assert.equal(h.calls.filter(call=>call.url.endsWith('/ensure')).length,1);assert.deepEqual(h.calls.find(call=>call.url.endsWith('/ensure'))!.body,{});
  await h.dispatch('operations-reload');assert.equal(h.calls.filter(call=>call.url.endsWith('/ensure')).length,1);
  const saved=h.snapshots.get('first')!;saved.document={document_id:'ops',head_revision_id:'ops-1',text:'{}'} as TopicOperationsSnapshot['document'];saved.automation!.state='confirmed';
  h.onRequest=call=>call.url.startsWith('/api/v1/works')?Promise.resolve({items:[{id:'work',url:'https://example.org/works/1',platform:'xiaohongshu',identity_status:'confirmed',published_at:'2026-10-12T00:00:00Z'}],next_cursor:null}):undefined;
  await h.dispatch('operations-reload');await h.dispatch('operations-retry',{}, {refreshFeedback:'true'});
  const ensures=h.calls.filter(call=>call.url.endsWith('/ensure'));assert.equal(ensures.length,2);assert.deepEqual(ensures[1]!.body,{retry:true,refresh_feedback:true});h.abort.abort();
});

test('生成轮询仅GET，候选就绪后停止，不再次ensure',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const h=harness('running'),loaded=await h.feature.load(h.context);
  const before=h.calls.length;h.snapshots.set('first',snapshot());t.mock.timers.tick(1800);await flush();
  assert.equal(h.calls.length,before+1);assert.equal(h.calls.at(-1)!.method,'GET');assert.equal(h.calls.at(-1)!.url,'/api/v1/topics/first/operations');assert.equal(loaded.projections.operations!.snapshot.automation!.state,'candidate');assert.equal(h.refreshCount,1);
  t.mock.timers.tick(20000);await flush();assert.equal(h.calls.length,before+1);assert.equal(h.calls.filter(call=>call.url.endsWith('/ensure')).length,1);h.abort.abort();
});

test('切换主题后旧轮询停止，也不重绘编辑内容',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const h=harness('running');await h.feature.load(h.context);const before=h.calls.length;
  h.ui.topic='second';t.mock.timers.tick(1800);await flush();assert.equal(h.calls.length,before);assert.equal(h.refreshCount,0);h.abort.abort();
});

test('候选只显示真实反馈和来源作品作者时间，作者回复默认不勾选',async()=>{
  const h=harness();await h.feature.load(h.context);await h.dispatch('operations-review-candidate');const dialog=h.dialogs.at(-1)!;
  assert.match(dialog.body,/真实读者/);assert.match(dialog.body,/https:\/\/example.org\/works\/1/);assert.match(dialog.body,/作品作者/);assert.doesNotMatch(dialog.body,/internal-work-id/);
  assert.match(dialog.body,/id="operations-candidate-feedback-0"[^>]* checked/);assert.doesNotMatch(dialog.body,/id="operations-candidate-feedback-1"[^>]* checked/);assert.doesNotMatch(dialog.body,/<textarea[^>]*id="operations-feedback-text"/);
  assert.match(dialog.foot!,/operations-confirm-candidate/);h.abort.abort();
});

test('必须本人确认，采用提交人工修改简报、真实反馈ID和选中的后续题目',async()=>{
  const h=harness();await h.feature.load(h.context);await h.dispatch('operations-review-candidate');const fields=confirmFields(h.snapshots.get('first')!);
  await assert.rejects(h.dispatch('operations-confirm-candidate',{...fields,'operations-candidate-confirmed':false}),/本人确认/);assert.equal(h.calls.filter(call=>call.url.endsWith('/decision')).length,0);
  fields['operations-candidate-takeaway']='本人修改后的读者收获';fields['operations-candidate-feedback-invented']='不应采用';await h.dispatch('operations-confirm-candidate',fields);
  const call=h.calls.find(call=>call.url.endsWith('/decision'))!;assert.equal(call.method,'POST');const input=call.body as DecideTopicOperationsRequest;
  assert.equal(input.candidate_id,'candidate-first');assert.equal(input.expected_revision_id,null);assert.equal(input.decision,'confirm');assert.equal(input.brief!.takeaway,'本人修改后的读者收获');assert.deepEqual(input.feedback_ids,['feedback-1']);assert.deepEqual(input.followups,[{id:'proposal-1',title:'本人修改后的后续题目',new_help:'补充实测排查过程',evidence_keys:['feedback:feedback-1']}]);
  assert.equal(h.closeCount,1);assert.equal(h.snapshots.get('first')!.data.feedback[0]!.text,'接入失败后在哪里核对？');h.abort.abort();
});

test('材料不足的合法空简报可直接确认，后续继续核心稿而非重复生成',async()=>{
  const h=harness();h.snapshots.get('first')!.automation!.candidate!.data.brief=emptyTopicOperations().brief;await h.feature.load(h.context);await h.dispatch('operations-review-candidate');
  await h.dispatch('operations-confirm-candidate',confirmFields(h.snapshots.get('first')!));const saved=h.snapshots.get('first')!;
  assert.equal(saved.automation!.state,'confirmed');assert.equal(saved.data.brief.reader_task,'');assert.equal(operationsNext(projection(saved)).action,'operations-go');assert.equal(operationsNext(projection(saved)).tab,'core');h.abort.abort();
});

test('不采用发送同一decision endpoint，既有记录不被候选写入',async()=>{
  const h=harness();await h.feature.load(h.context);await h.dispatch('operations-review-candidate');await h.dispatch('operations-reject-candidate');
  assert.deepEqual(h.calls.find(call=>call.url.endsWith('/decision'))!.body,{candidate_id:'candidate-first',expected_revision_id:null,decision:'reject'});assert.equal(h.snapshots.get('first')!.document,null);assert.equal(h.snapshots.get('first')!.automation!.state,'rejected');h.abort.abort();
});

test('提交失败保留原弹窗与输入，不再次present或关闭，解除busy',async()=>{
  const h=harness();await h.feature.load(h.context);await h.dispatch('operations-review-candidate');const before=h.dialogs.at(-1)!;
  h.onRequest=call=>call.url.endsWith('/decision')?Promise.reject(new Error('REVISION_CONFLICT，当前输入保留')):undefined;
  await assert.rejects(h.dispatch('operations-confirm-candidate',confirmFields(h.snapshots.get('first')!)),/REVISION_CONFLICT/);
  assert.equal(h.dialogs.length,1);assert.equal(h.dialogs.at(-1),before);assert.equal(h.closeCount,0);assert.deepEqual(h.busy,[true,false]);h.abort.abort();
});

test('旧主题确认晚到不关闭新主题候选弹窗、不导航或改写选择',async()=>{
  const h=harness();await h.feature.load(h.context);await h.dispatch('operations-review-candidate');let resolve!:(value:unknown)=>void;
  h.onRequest=call=>call.url==='/api/v1/topics/first/operations/decision'?new Promise(done=>{resolve=done;}):undefined;
  const pending=h.dispatch('operations-confirm-candidate',confirmFields(h.snapshots.get('first')!));await flush();
  h.ui.topic='second';await h.feature.load(h.context);await h.dispatch('operations-review-candidate');const newDialog=h.dialogs.at(-1)!;
  resolve(snapshot('first','confirmed'));await pending;assert.equal(h.closeCount,0);assert.equal(h.toasts.length,0);assert.equal(h.ui.topic,'second');assert.equal(h.dialogs.at(-1),newDialog);assert.match(newDialog.body,/data-operations-dialog/);h.abort.abort();
});

test('旧主题GET晚到不会ensure旧主题或抢占当前主题',async()=>{
  const h=harness();let resolve!:(value:unknown)=>void;
  h.onRequest=call=>call.url==='/api/v1/topics/first'&&call.method==='GET'?new Promise(done=>{resolve=done;}):undefined;
  const oldLoad=h.feature.load(h.context);await flush();h.ui.topic='second';const current=await h.feature.load(h.context);
  resolve({id:'first',title:'旧主题',core:{head_revision_id:null},core_approval:null,variants:[]});await oldLoad;
  assert.equal(current.projections.operations!.topicId,'second');assert.equal(h.calls.filter(call=>call.url==='/api/v1/topics/first/operations/ensure').length,0);assert.equal(h.calls.filter(call=>call.url==='/api/v1/topics/second/operations/ensure').length,1);
  await h.dispatch('operations-review-candidate');assert.match(h.dialogs.at(-1)!.body,/data-operations-dialog/);h.abort.abort();
});

test('无已确认记录不能进入手填简报或手工创建后续默认路径',async()=>{
  const h=harness();await h.feature.load(h.context);await assert.rejects(h.dispatch('operations-brief'),/先核对自动运营候选/);await assert.rejects(h.dispatch('operations-create-followup'),/自动运营候选/);assert.equal(h.calls.filter(call=>call.method==='PUT').length,0);h.abort.abort();
});

test('等待输入或额度显示可重试入口，确认后任务中断引导恢复已确认内容',()=>{
  for(const state of ['waiting_input','waiting_quota'] as const){const p=projection(snapshot('first',state));assert.match(renderOperationsPanel({...view(),projections:{operations:p}}),/data-action="operations-retry"/);}
  const recovering=snapshot();recovering.automation!.state='failed';recovering.automation!.candidate!.status='adopted';recovering.automation!.error='后续主题建立中断';
  assert.deepEqual(operationsNext(projection(recovering)),{label:'继续完成已确认内容',action:'operations-retry'});assert.match(renderOperationsPanel({...view(),projections:{operations:projection(recovering)}}),/确认后的任务未完成/);
  const p=projection(recovering);p.publishedWorks=[{id:'work-1',url:'https://example.org/works/1',platform:'xiaohongshu'}];assert.doesNotMatch(renderOperationsPanel({...view(),projections:{operations:p}}),/data-refresh-feedback="true"/);
});

test('已有反馈和后续题目仍保留显式刷新入口，运行和候选状态不重复刷新',()=>{
  const value=snapshot('first','confirmed');value.document={document_id:'ops',head_revision_id:'ops-1',text:'{}'} as TopicOperationsSnapshot['document'];
  value.data.feedback=[snapshot().automation!.candidate!.feedback[0]!];value.data.followups=[{topic_id:'next',title:'已确认后续',new_help:'根据真实提问继续'}];
  const p=projection(value);p.coreConfirmed=true;p.variantCount=1;p.publishedWorks=[{id:'work',url:'https://example.org/works/1',platform:'xiaohongshu'}];
  assert.equal(operationsNext(p).action,'operations-open-followup');
  const rendered=renderOperationsPanel({...view(),projections:{operations:p}});
  assert.match(rendered,/data-action="operations-retry"[^>]*data-refresh-feedback="true"[^>]*>刷新真实读者反馈/);
  for(const state of ['candidate','running','queued','waiting_input','waiting_quota'] as const){p.snapshot.automation!.state=state;assert.doesNotMatch(renderOperationsPanel({...view(),projections:{operations:p}}),/data-refresh-feedback="true"/);}
});

test('只读反馈弹窗刷新走现有ensure，不关闭弹窗或覆盖确认记录，旧刷新按钮不重复生成',async()=>{
  const h=harness('confirmed'),value=h.snapshots.get('first')!;value.document={document_id:'ops',head_revision_id:'ops-1',text:'{}'} as TopicOperationsSnapshot['document'];
  value.data.feedback=[snapshot().automation!.candidate!.feedback[0]!];value.data.followups=[{topic_id:'next',title:'已确认后续',new_help:'根据真实提问继续'}];
  const saved=structuredClone(value.data);h.onRequest=call=>call.url.startsWith('/api/v1/works')?Promise.resolve({items:[{id:'work',url:'https://example.org/works/1',platform:'xiaohongshu',identity_status:'confirmed',published_at:'2026-10-12T00:00:00Z'}],next_cursor:null}):undefined;
  await h.feature.load(h.context);await h.dispatch('operations-feedback');const dialog=h.dialogs.at(-1)!;
  assert.match(dialog.foot!,/data-refresh-feedback="true"/);assert.match(dialog.foot!,/刷新真实读者反馈/);
  await h.dispatch('operations-retry',{}, {refreshFeedback:'true'});
  const ensures=h.calls.filter(call=>call.url.endsWith('/ensure'));assert.deepEqual(ensures.at(-1)!.body,{retry:true,refresh_feedback:true});
  assert.equal(h.closeCount,0);assert.equal(h.dialogs.length,1);assert.equal(h.dialogs.at(-1),dialog);assert.deepEqual(value.data,saved);
  assert.equal(h.calls.filter(call=>call.url.endsWith('/decision')||call.method==='PUT').length,0);
  value.automation!.state='running';await h.dispatch('operations-reload');const before=h.calls.filter(call=>call.url.endsWith('/ensure')).length;
  await h.dispatch('operations-retry',{}, {refreshFeedback:'true'});assert.equal(h.calls.filter(call=>call.url.endsWith('/ensure')).length,before);assert.equal(h.closeCount,0);h.abort.abort();
});


test('微信平台版本纯进入、编辑后重载与重进仅GET运营快照，不自动ensure',async()=>{
 const h=harness();h.ui.editTab='versions';h.ui.platform='wechat';let denied=0;
 h.onRequest=call=>{if(call.url.endsWith('/ensure')){denied++;return Promise.reject(new Error('controlled pre-transport guard: implicit ensure denied'));}return undefined;};
 try{for(let n=0;n<3;n++){const loaded=await h.feature.load(h.context);assert.equal(loaded.projections.operations!.topicId,'first');await h.dispatch('operations-reload');}
 assert.equal(h.calls.filter(c=>c.method==='POST').length,0);assert.equal(denied,0);assert.equal(h.calls.filter(c=>c.url.endsWith('/operations')&&c.method==='GET').length,6);
 }finally{h.abort.abort();}
});

test('微信版本上下文仍允许本人显式retry一次并保原body和幂等标识',async()=>{
 const h=harness();h.ui.editTab='versions';h.ui.platform='wechat';
 try{await h.feature.load(h.context);assert.equal(h.calls.filter(c=>c.url.endsWith('/ensure')).length,0);
 await h.dispatch('operations-retry');const calls=h.calls.filter(c=>c.url.endsWith('/ensure'));
 assert.equal(calls.length,1);assert.equal(calls[0]!.method,'POST');assert.deepEqual(calls[0]!.body,{retry:true});assert.match(calls[0]!.options!.idempotencyKey!,/^[0-9a-f-]{36}$/);assert.equal(calls[0]!.options!.signal,h.abort.signal);
 }finally{h.abort.abort();}
});

test('核心稿、其他平台版本与普通运营入口维持原初次ensure行为',async()=>{
 for(const mode of ['wechat-core','douyin-versions','ordinary-create']as const){const h=harness();
 try{if(mode==='wechat-core'){h.ui.platform='wechat';h.ui.editTab='core';}if(mode==='douyin-versions'){h.ui.platform='douyin';h.ui.editTab='versions';}
 await h.feature.load(h.context);assert.equal(h.calls.filter(c=>c.url.endsWith('/ensure')).length,1,mode);await h.dispatch('operations-reload');assert.equal(h.calls.filter(c=>c.url.endsWith('/ensure')).length,1,mode);
 }finally{h.abort.abort();}}
});

test('旧核心稿GET晚到时已切入微信版本，不补发旧自动ensure',async()=>{
 const h=harness();let resolve!:(value:unknown)=>void;h.onRequest=c=>c.method==='GET'&&c.url==='/api/v1/topics/first'?new Promise(done=>{resolve=done;}):undefined;
 try{const pending=h.feature.load(h.context);await flush();h.ui.editTab='versions';h.ui.platform='wechat';resolve({id:'first',title:'本人工作台实测',core:{head_revision_id:null},core_approval:null,variants:[]});await pending;assert.equal(h.calls.filter(c=>c.url.endsWith('/ensure')).length,0);
 }finally{h.abort.abort();}
});


test('微信版本运行状态仍只GET轮询，就绪后停止且不ensure',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=harness('running');h.ui.editTab='versions';h.ui.platform='wechat';
 try{const loaded=await h.feature.load(h.context);const before=h.calls.length;h.snapshots.set('first',snapshot());t.mock.timers.tick(1800);await flush();assert.equal(h.calls.length,before+1);assert.equal(h.calls.at(-1)!.method,'GET');assert.equal(loaded.projections.operations!.snapshot.automation!.state,'candidate');assert.equal(h.calls.filter(c=>c.url.endsWith('/ensure')).length,0);t.mock.timers.tick(20000);await flush();assert.equal(h.calls.length,before+1);}finally{h.abort.abort();}
});

test('旧微信只读请求晚到核心稿不升级为ensure，新核心稿load保持旧自动行为',async()=>{
 const h=harness();h.ui.editTab='versions';h.ui.platform='wechat';let resolve!:(v:unknown)=>void;h.onRequest=c=>c.method==='GET'&&c.url==='/api/v1/topics/first'?new Promise(done=>{resolve=done;}):undefined;
 try{const pending=h.feature.load(h.context);await flush();h.ui.editTab='core';resolve({id:'first',title:'本人工作台实测',core:{head_revision_id:null},core_approval:null,variants:[]});await pending;assert.equal(h.calls.filter(c=>c.url.endsWith('/ensure')).length,0);h.onRequest=undefined;await h.feature.load(h.context);assert.equal(h.calls.filter(c=>c.url.endsWith('/ensure')).length,1);}finally{h.abort.abort();}
});
