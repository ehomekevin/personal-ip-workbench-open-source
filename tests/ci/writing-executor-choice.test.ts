// 核心稿写作发起处可选执行器：默认取全局设置，额度不可用/需要登录的项禁用；选择只随本次请求，不改全局 default_executor。
import test from 'node:test';import assert from 'node:assert/strict';
import {fixture as serviceFixture} from '../documents/harness.ts';import {Topics} from '../../packages/domain/src/topics/index.ts';import {Documents} from '../../packages/domain/src/documents/index.ts';import {WritingFlow} from '../../packages/domain/src/writing-flow/index.ts';import {Jobs} from '../../packages/domain/src/jobs/index.ts';
import {sha256} from '../../packages/storage/src/connection/index.ts';import {workspaceSettings} from '../../packages/storage/src/settings/index.ts';import {DEFAULT_WRITING_EXECUTION,StartWritingFlowSchema,type WritingRuleSnapshot} from '../../packages/contracts/src/index.ts';
import type {FeatureContext} from '../../apps/web/src/transport/feature-ports.ts';
import {WritingFlowController} from '../../apps/web/src/features/create/writing-flow/index.ts';
import {executorChoices,executorOptions,preferredExecutor} from '../../apps/web/src/components/executors.ts';
import {createTemplateHelpers} from '../../apps/web/src/components/templateHelpers.ts';
const {esc}=createTemplateHelpers([]);
const quotaCodex={default_executor:'codex',executors:[{executor_id:'codex',status:'unverified',auth_state:'QUOTA_EXHAUSTED'},{executor_id:'claude',status:'supported',auth_state:'subscription_authenticated'}]};
test('执行器选项：额度不可用与需要登录的项禁用并显示状态；默认项被阻塞时退到可用项',()=>{
 const choices=executorChoices(quotaCodex as never);assert.deepEqual(choices.map(c=>[c.id,c.status,c.blocked,c.usable]),[['codex','额度暂不可用',true,false],['claude','可用',false,true]]);
 assert.equal(preferredExecutor(choices,'codex'),'claude');assert.equal(preferredExecutor(executorChoices({executors:[]} as never),'claude'),'claude','状态未知不阻塞默认项');
 const html=executorOptions(choices,'claude',esc);assert.match(html,/<option value="codex" disabled>Codex · 额度暂不可用<\/option>/);assert.match(html,/<option value="claude" selected>Claude · 可用<\/option>/);
 assert.equal(executorChoices({executors:[{executor_id:'claude',status:'unconfigured',auth_state:'AUTH_REQUIRED'}]} as never)[1]!.status,'需要登录');
});
function web(reader:(method:string,url:string,body:unknown)=>unknown,fields:Record<string,string>={}){
 const dialogs:{title:string;body:string}[]=[],calls:{method:string;url:string;body:unknown}[]=[],values=new Map(Object.entries(fields).map(([k,v])=>[k,{value:v}]));
 const root={querySelector:(selector:string)=>selector==='.writing-flow-panel'?{set outerHTML(_v:string){}}:selector.startsWith('#')?values.get(selector.slice(1))??null:null} as unknown as HTMLElement;
 const context={ui:{page:'create',topic:'topic'},signal:new AbortController().signal,client:{request:async(method:string,url:string,body:unknown)=>{calls.push({method,url,body});return reader(method,url,body);}},drafts:{leave:async()=>{},status:()=>'committed'},surface:{presentDialog:(d:{title:string;body:string})=>dialogs.push(d),closeDialog:()=>{},dialogBusy:()=>{},toast:()=>{},navigate:()=>{}}} as unknown as FeatureContext;
 globalThis.CSS??={escape:(v:string)=>v} as unknown as typeof CSS;
 const controller=new WritingFlowController({root,context:()=>context,render:()=>{},active:()=>true}),internal=controller as any;internal.topicId='topic';return {controller,internal,dialogs,calls,values};
}
const runView={id:'run-new',topic_id:'topic',phase:'writing',version:1,executor:'claude',execution_policy:DEFAULT_WRITING_EXECUTION,stages:[{stage:'writing',job_id:'j'}],decisions:[],exports:[],rule_snapshot:{files:[]},current_job:{id:'j',state:'queued',version:1,error:null},candidate:null,review:null,input_draft:'',input_revision_id:'base',adopted_revision_id:null};
test('开始完整稿流程：弹窗显示执行器选择（禁用额度不可用项），请求体带所选执行器，不改全局设置',async()=>{
 const w=web((method,url)=>url==='/api/v1/settings'?quotaCodex:url==='/api/v1/topics/topic'?{core:{head_revision_id:'base'},source_ids:[]}:url.includes('?summary=1')?{items:[],targets:[]}:runView);
 try{await w.internal.dispatch('wf-new',{dataset:{}});const dialog=w.dialogs.at(-1)!;assert.equal(dialog.title,'开始完整稿流程');assert.match(dialog.body,/<select class="field" id="wf-executor"><option value="codex" disabled>Codex · 额度暂不可用<\/option><option value="claude" selected>Claude · 可用<\/option><\/select>/);assert.match(dialog.body,/不改设置里的默认执行器/);
  for(const [k,v] of Object.entries({'wf-executor':'claude','wf-instruction':'本次要求','wf-effort':'high','wf-idle':'3','wf-duration':'15','wf-target':''}))w.values.set(k,{value:v});
  await w.internal.dispatch('wf-start',{dataset:{}});const post=w.calls.find(c=>c.method==='POST')!;assert.equal((post.body as {executor:string}).executor,'claude');
  assert.equal(w.calls.filter(c=>c.method!=='GET'&&c.url.startsWith('/api/v1/settings')).length,0,'不写全局设置');
  w.values.set('wf-executor',{value:'codex'});await assert.rejects(w.internal.dispatch('wf-start',{dataset:{}}),/所选执行器当前不可用/);assert.equal(w.calls.filter(c=>c.method==='POST').length,1,'禁用项不能发起');
 }finally{w.controller.dispose();}
});
test('从观点生成核心稿：请求体带本条执行器选择',async()=>{
 const w=web((method,url)=>url==='/api/v1/topics/topic'?{core:{head_revision_id:'base'},source_ids:['s'],core_document_id:'core'}:url.includes('?summary=1')?{items:[],targets:[]}:runView,{'agent-select':'claude','agent-request':'写清判断'});
 try{await w.controller.generateFromViewpoints({head_revision_id:'vp-1'} as never);const post=w.calls.find(c=>c.method==='POST')!;assert.equal(post.url,'/api/v1/topics/topic/writing-runs');assert.equal((post.body as {executor:string}).executor,'claude');}finally{w.controller.dispose();}
});
const skill='---\nname: personal-ip-writing\ndescription: 测试\n---\n保持原主张。',rules:WritingRuleSnapshot={id:'r',created_at:'2026-10-14T00:00:00Z',files:[],skill:{name:'personal-ip-writing',version:'0.1.0',content:skill,sha256:sha256(skill)},scope:'本人'};
test('服务端：未传执行器沿用工作区默认；传入时只作用于本次运行与任务，不改默认',async()=>{
 const f=serviceFixture();try{
  const base={source_ids:[],instruction:'测试',rule_set:'personal-ip-writing' as const,execution_policy:DEFAULT_WRITING_EXECUTION};assert.doesNotThrow(()=>StartWritingFlowSchema.parse({...base,base_revision_id:null}));assert.throws(()=>StartWritingFlowSchema.parse({...base,base_revision_id:null,executor:'gemini'}));
  const flow=new WritingFlow(f.context(),{rules:()=>structuredClone(rules)}),docs=new Documents(f.context()),defaults=workspaceSettings(f.context().db,f.context().identity.workspace_id).default_executor;
  const make=async(title:string)=>{const topic=await new Topics(f.context()).create(f.request(),{title,category:'个人思考',audience:'创作者',source_ids:[]});const saved=await docs.save(f.request(),topic.core_document_id,{expected_revision_id:null,text:'本人原稿。'.repeat(80),origin:'human'});return {topic,saved};};
  const a=await make('默认执行器'),first=flow.start(f.request(),a.topic.id,{...base,base_revision_id:a.saved.revision_id});assert.equal(first.executor,defaults);
  const other=defaults==='codex'?'claude':'codex',b=await make('本次执行器'),second=flow.start(f.request(),b.topic.id,{...base,base_revision_id:b.saved.revision_id,executor:other});assert.equal(second.executor,other);
  assert.equal(new Jobs(f.context()).get(f.request(),second.stages[0]!.job_id).job.executor_id,other);assert.equal(workspaceSettings(f.context().db,f.context().identity.workspace_id).default_executor,defaults,'全局默认不变');
 }finally{f.cleanup();}
});
