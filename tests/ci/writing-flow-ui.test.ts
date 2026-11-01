import test from 'node:test';
import assert from 'node:assert/strict';
import {WritingFlowController} from '../../apps/web/src/features/create/writing-flow/index.ts';
import {DEFAULT_WRITING_EXECUTION,type WritingRun} from '../../packages/contracts/src/index.ts';
import type {FeatureContext} from '../../apps/web/src/transport/feature-ports.ts';

function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const flush=()=>new Promise<void>(r=>setImmediate(r));
const draft='完整母稿'.repeat(200);
function runView(version=1,phase='deciding') {return {schema_version:'writing-flow/1',id:'run',version,topic_id:'topic',document_id:'core',input_revision_id:'base',input_text_sha256:'hash',instruction:'保留本人事实',executor:'codex',execution_policy:DEFAULT_WRITING_EXECUTION,source_ids:[],rule_snapshot:{id:'rules',created_at:'now',files:[],skill:{name:'personal-ip-writing',version:'0.1.0',sha256:'hash',content:'rules'},scope:'本人'},export_target:null,created_at:'now',parent_run_id:null,phase,stages:[{stage:'review',job_id:'job',document_id:'review',input_revision_id:'base',reviewed_revision_id:'base'}],decisions:[],adopted_revision_id:'base',exports:[],candidate:{id:'candidate',text:'review',revision_id:'review-v1'},review:{summary:'合法不改',findings:[],style_comparison:[]},current_job:{id:'job',state:'succeeded',version:1,error:null},input_draft:draft,core_head:'base'};}
function fixture() {
 const fields=new Map<string,{value:string}>([['wf-instruction',{value:'冻结的完整稿要求'}],['wf-effort',{value:'high'}],['wf-idle',{value:'3'}],['wf-duration',{value:'15'}],['wf-target',{value:''}]]),dialogs:{title:string;body:string}[]=[],calls:{method:string;url:string;body:unknown}[]=[];
 let active=true,closed=0,renders=0,panelWrites=0,reader:(method:string,url:string,body:unknown)=>Promise<unknown>=async(_m,url)=>url.includes('?summary=1')?{items:[],targets:[]}:runView(),leave=async()=>{};
 const panel={set outerHTML(_value:string){panelWrites++;}},root={querySelector(selector:string){if(selector==='.writing-flow-panel')return panel;if(selector.startsWith('#'))return fields.get(selector.slice(1))??null;return null;}} as unknown as HTMLElement;
 const context={ui:{page:'create',topic:'topic'},signal:new AbortController().signal,client:{request:async(method:string,url:string,body:unknown)=>{calls.push({method,url,body});return reader(method,url,body);}},drafts:{leave:()=>leave()},surface:{presentDialog:(dialog:{title:string;body:string})=>dialogs.push(dialog),closeDialog:()=>{closed++;},dialogBusy:()=>{},toast:()=>{},navigate:()=>{}}} as unknown as FeatureContext;
 globalThis.CSS??={escape:(value:string)=>value} as unknown as typeof CSS;
 const controller=new WritingFlowController({root,context:()=>context,render:()=>{renders++;},active:()=>active}),internal=controller as any;
 internal.topicId='topic';
 return {controller,internal,fields,dialogs,calls,context,setReader(value:typeof reader){reader=value;},setLeave(value:typeof leave){leave=value;},deactivate(){active=false;controller.deactivate();},counts:()=>({closed,renders,panelWrites})};
}
test('稳定审读轮询只更新流程卡；修改决定表单和编辑器不重绘',async()=>{
 const f=fixture();try{const view=runView();f.internal.detail=view;f.internal.dialogRun=view.id;f.fields.set('wf-decision-reason',{value:'本人填写到一半'});f.setReader(async()=>({items:[{...view,skill:'personal-ip-writing'}],targets:[]}));await f.internal.load();await f.internal.load();assert.equal(f.dialogs.length,0);assert.equal(f.fields.get('wf-decision-reason')!.value,'本人填写到一半');assert.deepEqual(f.counts(),{closed:0,renders:0,panelWrites:2});}finally{f.controller.dispose();}
});
test('重叠轮询以最新详情为准；关闭或离开后的迟到详情不能重新打开弹窗',async()=>{
 const f=fixture();try{f.internal.detail=runView();f.internal.dialogRun='run';const old=deferred<ReturnType<typeof runView>>();let list=0,detail=0;f.setReader(async(_m,url)=>url.includes('?summary=1')?{items:[{...runView(++list+1),skill:'personal-ip-writing'}],targets:[]}:++detail===1?old.promise:runView(3));const first=f.internal.load();await flush();await f.internal.load();assert.equal(f.internal.detail.version,3);old.resolve(runView(2));await first;assert.equal(f.internal.detail.version,3);assert.equal(f.dialogs.length,1);
  const late=deferred<ReturnType<typeof runView>>();f.setReader(async()=>late.promise);const opening=f.internal.dispatch('wf-open',{dataset:{run:'run'}});f.controller.close();late.resolve(runView(4));await opening;assert.equal(f.dialogs.length,1);
  const left=deferred<ReturnType<typeof runView>>();f.setReader(async()=>left.promise);const afterLeave=f.internal.dispatch('wf-open',{dataset:{run:'run'}});f.deactivate();left.resolve(runView(5));await afterLeave;assert.equal(f.dialogs.length,1);
 }finally{f.controller.dispose();}
});
test('启动前冻结表单字段；等待保存期间离开页面不发写作任务',async()=>{
 const f=fixture();try{const saving=deferred<void>();f.setLeave(()=>saving.promise);f.setReader(async(method,url)=>method==='GET'&&url==='/api/v1/topics/topic'?{core:{head_revision_id:'base'},source_ids:[]}:url.includes('?summary=1')?{items:[],targets:[]}:runView(1,'writing'));const starting=f.internal.dispatch('wf-start',{dataset:{}});f.fields.get('wf-instruction')!.value='等待中被改的字段';saving.resolve();await starting;const mutation=f.calls.find(c=>c.method==='POST');assert.ok(mutation);assert.equal((mutation.body as WritingRun).instruction,'冻结的完整稿要求');assert.equal((mutation.body as WritingRun).execution_policy.max_duration_ms,900000);
 }finally{f.controller.dispose();}
 const f2=fixture();try{const saving=deferred<void>();f2.setLeave(()=>saving.promise);const starting=f2.internal.dispatch('wf-start',{dataset:{}});f2.deactivate();saving.resolve();await starting;assert.equal(f2.calls.filter(c=>c.method==='POST').length,0);}finally{f2.controller.dispose();}
});
test('结果未知时入口阻止重发；取消明确终态才允许新流程',()=>{
 const f=fixture();try{f.internal.runs=[{id:'run',phase:'needs_attention',skill:'personal-ip-writing',exports:[],current_job:{state:'failed',error:{code:'RESULT_UNKNOWN'}}}];assert.match(f.controller.panel(),/wf-new[^>]*disabled/);f.internal.runs[0].current_job={state:'cancelled',error:null};assert.doesNotMatch(f.controller.panel(),/wf-new[^>]*disabled/);}finally{f.controller.dispose();}
});
