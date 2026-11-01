import test from 'node:test';
import assert from 'node:assert/strict';
import {WritingFlowController} from '../../apps/web/src/features/create/writing-flow/index.ts';
import {WorkbenchTransportError} from '../../apps/web/src/transport/workbench-client.ts';
import {DEFAULT_WRITING_EXECUTION,type DocumentSnapshot} from '../../packages/contracts/src/index.ts';
import type {FeatureContext} from '../../apps/web/src/transport/feature-ports.ts';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function view(id='original',state='running',phase='writing'){
 return {schema_version:'writing-flow/1',id,version:1,topic_id:'topic',document_id:'core',input_revision_id:null,input_text_sha256:'hash',instruction:'本人观点',executor:'codex',execution_policy:DEFAULT_WRITING_EXECUTION,source_ids:[],rule_snapshot:{id:'rules',created_at:'now',files:[],skill:{name:'configured-writing',version:'1',sha256:'hash',content:'rules'},scope:'本人'},export_target:null,created_at:'now',parent_run_id:null,phase,stages:[{stage:'writing',job_id:'job-'+id,document_id:'core',input_revision_id:null}],decisions:[],adopted_revision_id:null,exports:[],candidate:state==='succeeded'?{id:'candidate-'+id,text:'待本人核对的候选'.repeat(120),revision_id:'candidate-revision',status:'pending'}:null,review:null,current_job:{id:'job-'+id,state,version:1,error:null as {code:string;message:string}|null},input_draft:'',core_head:null};
}
const summary=(run:ReturnType<typeof view>)=>({...run,skill:'configured-writing'});
const snapshot={head_revision_id:'viewpoint-ack',text:'简短观点'} as DocumentSnapshot;
function fixture(){
 const fields=new Map([['agent-select',{value:'codex'}],['agent-request',{value:'冻结的要求'}],['core-editor',{value:'人工原稿仍在编辑'}]]),dialogs:{title:string;body:string;foot?:string}[]=[],calls:{method:string;url:string;body:any}[]=[];
 let reader:(method:string,url:string,body:any)=>Promise<any>=async(_method,url)=>url.includes('?summary=1')?{items:[],targets:[]}:url==='/api/v1/topics/topic'?{core_document_id:'core',core:{head_revision_id:'core-ack'},source_ids:['source']} :view('new');
 let leave=async()=>{},leaves=0,panel='';
 const root={querySelector(selector:string){return selector==='.writing-flow-panel'?{set outerHTML(html:string){panel=html;}}:fields.get(selector.slice(1))??null;}} as unknown as HTMLElement;
 const context={ui:{topic:'topic'},signal:new AbortController().signal,skillSelection:()=>({fixture:'frozen-route'}),drafts:{leave:()=>{leaves++;return leave();},status:()=> 'committed'},client:{request:async(method:string,url:string,body:any)=>{calls.push({method,url,body});return reader(method,url,body);}},surface:{presentDialog:(dialog:typeof dialogs[number])=>dialogs.push(dialog),closeDialog:()=>{},toast:()=>{}}} as unknown as FeatureContext;
 const controller=new WritingFlowController({root,context:()=>context,render:()=>{throw new Error('Must retain existing editor DOM');},active:()=>true}),internal=controller as any;internal.topicId='topic';
 return {controller,internal,context,fields,calls,dialogs,setReader(value:typeof reader){reader=value;},setLeave(value:typeof leave){leave=value;},counts:()=>({leaves,panel}),posts:()=>calls.filter(c=>c.method==='POST')};
}
test('fresh summary resumes the exact blocker, including an older run; repeated clicks start zero turns',async()=>{
 const f=fixture();try{const blocker=view('actual-older'),newest=view('newest','succeeded','awaiting_user');f.internal.runs=[summary(view('stale'))];f.setReader(async(_m,url)=>url.includes('?summary=1')?{items:[summary(newest),summary(blocker)],targets:[]}:blocker);
  await f.controller.generateFromViewpoints(snapshot);await f.controller.generateFromViewpoints(snapshot);
  assert.equal(f.posts().length,0);assert.equal(f.counts().leaves,0);assert.equal(f.dialogs.length,2);assert.equal(f.internal.dialogRun,'actual-older');assert.deepEqual(f.calls.filter(c=>!c.url.includes('?summary=1')).map(c=>c.url),['/api/v1/writing-runs/actual-older','/api/v1/writing-runs/actual-older']);assert.equal(f.fields.get('core-editor')!.value,'人工原稿仍在编辑');
 }finally{f.controller.dispose();}
});
test('overlapping clicks share the in-flight read and cannot submit a new turn',async()=>{
 const f=fixture();try{const list=deferred<any>(),current=view();f.setReader(async(_m,url)=>url.includes('?summary=1')?list.promise:current);const first=f.controller.generateFromViewpoints(snapshot);await f.controller.generateFromViewpoints(snapshot);assert.equal(f.calls.length,1);list.resolve({items:[summary(current)],targets:[]});await first;assert.equal(f.posts().length,0);assert.equal(f.dialogs.length,1);}finally{f.controller.dispose();}
});
test('a known active run that just finished opens its pending candidate without a second generation',async()=>{
 const f=fixture();try{f.internal.runs=[summary(view())];const completed=view('original','succeeded','writing_ready');f.setReader(async(_m,url)=>url.includes('?summary=1')?{items:[summary(completed)],targets:[]}:completed);await f.controller.generateFromViewpoints(snapshot);assert.equal(f.posts().length,0);assert.match(f.dialogs[0].body,/本轮候选/);assert.match(f.dialogs[0].foot!,/wf-adopt/);assert.equal(f.internal.dialogRun,'original');}finally{f.controller.dispose();}
});
test('fresh terminal without pending recovery allows explicit generation with frozen ACK, route and preserved manual draft',async()=>{
 const f=fixture();try{const old=view('original','cancelled','needs_attention');old.current_job.error={code:'RESULT_UNKNOWN',message:'取消前遗留提示'};f.internal.runs=[summary(view())];const fresh=deferred<any>();let lists=0;f.setReader(async(method,url)=>url.includes('?summary=1')?++lists===1?fresh.promise:{items:[summary(view('new'))],targets:[]}:url==='/api/v1/writing-runs/original'?old:url==='/api/v1/topics/topic'?{core_document_id:'core',core:{head_revision_id:'core-ack'},source_ids:['source']}:method==='POST'?{id:'new'}:view('new'));
  const generating=f.controller.generateFromViewpoints(snapshot);f.fields.get('agent-request')!.value='等待时换的指令';f.fields.get('agent-select')!.value='claude';fresh.resolve({items:[summary(old)],targets:[]});await generating;assert.equal(f.posts().length,1);assert.deepEqual(f.posts()[0].body,{base_revision_id:'core-ack',viewpoints_revision_id:'viewpoint-ack',source_ids:['source'],executor:'codex',instruction:'冻结的要求',rule_set:'configured',execution_policy:DEFAULT_WRITING_EXECUTION,skill_route:{fixture:'frozen-route'},parent_run_id:'original'});assert.equal(f.fields.get('core-editor')!.value,'人工原稿仍在编辑');assert.equal(f.internal.dialogRun,'new');}finally{f.controller.dispose();}
});
test('without click-time recovery context a completed run keeps the explicit new-generation path',async()=>{
 const f=fixture();try{const completed=view('previous','succeeded','writing_ready');f.internal.runs=[summary(completed)];f.setReader(async(method,url)=>url.includes('?summary=1')?{items:[summary(completed)],targets:[]}:url==='/api/v1/topics/topic'?{core_document_id:'core',core:{head_revision_id:null},source_ids:[]}:method==='POST'?{id:'new'}:view('new'));await f.controller.generateFromViewpoints(snapshot);assert.equal(f.posts().length,1);assert.equal(f.internal.dialogRun,'new');}finally{f.controller.dispose();}
});
for(const state of ['waiting_quota','waiting_input','reconciling','unknown'])test(state+' resumes existing state without POST',async()=>{
 const f=fixture();try{const current=view('held',state==='unknown'?'failed':state,'needs_attention');if(state==='unknown')current.current_job.error={code:'RESULT_UNKNOWN',message:'原任务结果待核对'};f.setReader(async(_m,url)=>url.includes('?summary=1')?{items:[summary(current)],targets:[]}:current);await f.controller.generateFromViewpoints(snapshot);assert.equal(f.posts().length,0);assert.equal(f.internal.dialogRun,'held');assert.match(f.dialogs[0].foot!,/wf-reconcile/);}finally{f.controller.dispose();}
});
test('review VALIDATION_ERROR is a known failure, not an unknown-result recovery gate',async()=>{
 const f=fixture();try{const failed=view('review-failed','failed','needs_attention');failed.current_job.error={code:'VALIDATION_ERROR',message:'文风对照必须来自固定原文与已提供样本'};failed.adopted_revision_id='core-ack' as any;f.internal.runs=[summary(failed)];f.setReader(async(method,url)=>url.includes('?summary=1')?{items:[summary(failed)],targets:[]}:url==='/api/v1/topics/topic'?{core_document_id:'core',core:{head_revision_id:'core-ack'},source_ids:[]}:method==='POST'?{id:'new'}:view('new'));assert.doesNotMatch(f.controller.panel(),/wf-new[^>]*disabled/);await f.controller.generateFromViewpoints(snapshot);assert.equal(f.posts().length,1);assert.equal(f.posts()[0].body.base_revision_id,'core-ack');assert.equal(f.calls.some(call=>call.url==='/api/v1/writing-runs/review-failed'),false);assert.equal(f.fields.get('core-editor')!.value,'人工原稿仍在编辑');}finally{f.controller.dispose();}
});
test('POST RESULT_UNKNOWN opens only its supplied run_id, never resends the request',async()=>{
 const f=fixture();try{const existing=view('concurrent','failed','needs_attention');existing.current_job.error={code:'RESULT_UNKNOWN',message:'待核对'};f.setReader(async(method,url)=>url.includes('?summary=1')?{items:[],targets:[]}:url==='/api/v1/topics/topic'?{core_document_id:'core',core:{head_revision_id:null},source_ids:[]}:method==='POST'?Promise.reject(new WorkbenchTransportError(409,{error:{code:'RESULT_UNKNOWN',message:'原任务待核对',details:{run_id:'concurrent',no_new_turn_started:true},retryable:false,request_id:'fixture'}})):existing);await f.controller.generateFromViewpoints(snapshot);assert.equal(f.posts().length,1);assert.equal(f.internal.dialogRun,'concurrent');assert.equal(f.calls.at(-1)!.url,'/api/v1/writing-runs/concurrent');assert.match(f.dialogs[0].foot!,/wf-reconcile/);}finally{f.controller.dispose();}
});
test('RESULT_UNKNOWN without a valid run id stays an error and is never retried',async()=>{
 const f=fixture();try{f.setReader(async(method,url)=>url.includes('?summary=1')?{items:[],targets:[]}:method==='POST'?Promise.reject(new WorkbenchTransportError(409,{error:{code:'RESULT_UNKNOWN',message:'待核对',details:{},retryable:false,request_id:'fixture'}})):{core_document_id:'core',core:{head_revision_id:null},source_ids:[]});await assert.rejects(f.controller.generateFromViewpoints(snapshot),/待核对/);assert.equal(f.posts().length,1);assert.equal(f.dialogs.length,0);}finally{f.controller.dispose();}
});
for(const boundary of ['summary','detail','save','post'] as const)for(const change of ['close','topic'] as const)test(boundary+' late receipt after '+change+' cannot reopen or start a later turn',async()=>{
 const f=fixture();try{const late=deferred<any>(),active=view(),paused=boundary==='summary'?{items:[summary(active)],targets:[]}:boundary==='detail'?active:boundary==='post'?{id:'new'}:undefined;
  if(boundary==='save')f.setLeave(()=>late.promise);
  f.setReader(async(method,url)=>url.includes('?summary=1')?boundary==='summary'?late.promise:{items:boundary==='detail'?[summary(active)]:[],targets:[]}:url==='/api/v1/topics/topic'?{core_document_id:'core',core:{head_revision_id:null},source_ids:[]}:method==='POST'?boundary==='post'?late.promise:{id:'new'}:boundary==='detail'?late.promise:view('new'));
  const generating=f.controller.generateFromViewpoints(snapshot);await flush();if(change==='close')f.controller.close();else{f.controller.deactivate();Object.assign(f.context.ui,{topic:'other'});f.internal.topicId='other';}late.resolve(paused);await generating;assert.equal(f.dialogs.length,0);assert.equal(f.posts().length,boundary==='post'?1:0);assert.equal(f.fields.get('core-editor')!.value,'人工原稿仍在编辑');}finally{f.controller.dispose();}
});
test('a concurrent RESULT_UNKNOWN arriving after dialog close cannot reopen the original run',async()=>{
 const f=fixture();try{const post=deferred<any>();f.setReader(async(method,url)=>url.includes('?summary=1')?{items:[],targets:[]}:method==='POST'?post.promise:{core_document_id:'core',core:{head_revision_id:null},source_ids:[]});const generating=f.controller.generateFromViewpoints(snapshot);await flush();f.controller.close();post.resolve(Promise.reject(new WorkbenchTransportError(409,{error:{code:'RESULT_UNKNOWN',message:'待核对',details:{run_id:'concurrent'},retryable:false,request_id:'fixture'}})));await generating;assert.equal(f.posts().length,1);assert.equal(f.dialogs.length,0);assert.equal(f.calls.some(c=>c.url==='/api/v1/writing-runs/concurrent'),false);}finally{f.controller.dispose();}
});
test('wrong-topic detail is rejected and cannot be presented or trigger new generation',async()=>{
 const f=fixture();try{const current=view();f.setReader(async(_m,url)=>url.includes('?summary=1')?{items:[summary(current)],targets:[]}:{...current,topic_id:'other'});await assert.rejects(f.controller.generateFromViewpoints(snapshot),/当前主题不一致/);assert.equal(f.posts().length,0);assert.equal(f.dialogs.length,0);}finally{f.controller.dispose();}
});
test('empty-core adoption note is limited to ready candidates and does not replace an existing human draft',()=>{
 const f=fixture();try{f.internal.runs=[summary(view('original','succeeded','writing_ready'))];assert.doesNotMatch(f.controller.panel(),/会进入核心稿编辑区/);f.fields.get('core-editor')!.value='';assert.match(f.controller.panel(),/候选已生成，打开「查看流程」核对并采用后，会进入核心稿编辑区/);f.internal.runs[0].phase='revision_ready';assert.match(f.controller.panel(),/会进入核心稿编辑区/);f.internal.runs[0].phase='writing';assert.doesNotMatch(f.controller.panel(),/会进入核心稿编辑区/);}finally{f.controller.dispose();}
});
