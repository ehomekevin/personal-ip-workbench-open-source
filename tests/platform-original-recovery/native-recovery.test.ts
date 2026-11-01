import test from 'node:test';
import assert from 'node:assert/strict';
import type {JsonObject} from '../../packages/contracts/src/index.ts';
import {CodexAdapter,confirmedStops} from '../../packages/adapters/src/agent/codex/index.ts';
import {canonical,hash} from '../../packages/adapters/src/agent/codex/primitives.ts';
import {nativeFixture,fixedInput,originalHandle,threadResponse} from '../platform-layout-integration/native-harness.ts';
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function drain(adapter:CodexAdapter,handle:Awaited<ReturnType<CodexAdapter['resume']>>){const values=[];for await(const value of adapter.streamEvents(handle))values.push(value);return values;}
function assertNoNewTurn(calls:any[]){for(const method of ['thread/start','thread/resume','turn/start','model/list'])assert.equal(calls.filter(m=>m.method===method).length,0,method);}

test('query_original consumes a complete original final without starting a turn',async()=>{
 const f=nativeFixture(),adapter=new CodexAdapter(f.options),handle=originalHandle(fixedInput(),f.root,f.options.workspace_id);f.set({thread:threadResponse(handle)});
 try{const recovered=await adapter.resume(handle,{recovery_action:'query_original'});const output=await drain(adapter,recovered);assert.equal(recovered.runtime_turn_id,handle.runtime_turn_id);assert.equal(output.length,1);assert.equal((output[0] as any).resume_info.output.answer,'42');assertNoNewTurn(f.calls());}finally{await adapter.close();f.cleanup();}
});

test('legacy no-policy observer reads the original turn and keeps an in-progress producer alive',async()=>{
 const f=nativeFixture(),adapter=new CodexAdapter(f.options);f.set({progressInterval:20});
 try{const handle=await adapter.start(fixedInput());await sleep(60);const internals=adapter as any,run=internals.runs.get(handle.runtime_turn_id);const progressBefore=run.progressGeneration;await internals.observeDeadline(run,'idle');assert.equal(run.terminal,false);assert.ok(progressBefore>0);assert.equal(f.calls().filter(m=>m.method==='thread/read').length,1);assert.equal(f.calls().filter(m=>m.fixture_event==='stdin_closed').length,0);await adapter.cancel(handle);await assert.rejects(drain(adapter,handle),{code:'HOST_INTERRUPTED'});}finally{await adapter.close();f.cleanup();}
});

test('query_original refuses interrupted, failed, unknown, missing and malformed finals, including confirmedStops',async()=>{
 for(const kind of ['interrupted','failed','inProgress','no-final','partial-final','wrong-schema','non-final','wrong-thread','wrong-turn','wrong-response-cwd','wrong-response-provider','read-error','transport-disconnect','confirmed-stop']){
  const f=nativeFixture(),adapter=new CodexAdapter(f.options),input=fixedInput(),handle=originalHandle(input,f.root,f.options.workspace_id),before=canonical(handle);
  const thread=threadResponse(handle,['interrupted','failed','inProgress'].includes(kind)?kind:'completed');
  if(kind==='no-final')thread.turns[0].items=[];
  if(kind==='partial-final')thread.turns[0].items[0].text='{"answer":';
  if(kind==='wrong-schema')thread.turns[0].items[0].text='{"wrong":1}';
  if(kind==='non-final')thread.turns[0].items[0].phase='commentary';
  if(kind==='wrong-thread')thread.id='other-thread';
  if(kind==='wrong-turn')thread.turns[0].id='other-turn';
  if(kind==='wrong-response-cwd')thread.cwd='/wrong-root';
  if(kind==='wrong-response-provider')thread.modelProvider='different-provider';
  if(kind==='confirmed-stop'){thread.turns[0].status='interrupted';confirmedStops.set(`${handle.runtime_session_id}:${handle.runtime_turn_id}`,hash(canonical(input)));}
  f.set({thread,readError:kind==='read-error',disconnectOnRead:kind==='transport-disconnect'});
  try{await assert.rejects(adapter.resume(handle,{recovery_action:'query_original'}),(error:any)=>{
   assert.equal(error.details.no_new_turn_started,true,kind);
   if(['interrupted','failed','no-final','partial-final','wrong-schema','non-final','confirmed-stop'].includes(kind))assert.equal(error.details.original_result_unavailable,true,kind);
   return true;
  });assertNoNewTurn(f.calls());assert.equal(canonical(handle),before,kind);}finally{confirmedStops.delete(`${handle.runtime_session_id}:${handle.runtime_turn_id}`);await adapter.close();f.cleanup();}
 }
});

test('query_original rejects altered binding, fixed input and skill bytes before native requests',async()=>{
 for(const kind of ['workspace','cwd','outer-thread','outer-turn','binding-hash','run-input','manifest','skill-hash','input-key','other-action']){
  const f=nativeFixture(),adapter=new CodexAdapter(f.options),input=fixedInput();
  if(kind==='skill-hash')(input.input_manifest.frozen as any).writing_skills=[{name:'controlled-skill',version:'1.0.0',content:'controlled bytes',sha256:'0'.repeat(64)}];
  const handle=originalHandle(input,f.root,f.options.workspace_id);
  if(kind==='workspace')handle.checkpoint.workspace_id='other-workspace';
  if(kind==='cwd')handle.checkpoint.cwd='/different-cwd';
  if(kind==='outer-thread')handle.runtime_session_id='other-thread';
  if(kind==='outer-turn')handle.runtime_turn_id='other-turn';
  if(kind==='binding-hash')handle.checkpoint.native_binding_hash='0'.repeat(64);
  if(kind==='run-input')(handle.checkpoint.run_input as any).task_instruction='tampered';
  if(kind==='manifest')((handle.checkpoint.run_input as any).input_manifest.frozen as any).source_ids=['forged'];
  const action:JsonObject=kind==='input-key'?{recovery_action:'query_original',input:{answer:'forged'}}:kind==='other-action'?{recovery_action:'new_turn'}:{recovery_action:'query_original'};
  try{await assert.rejects(adapter.resume(handle,action));assert.equal(f.calls().length,0,kind);assertNoNewTurn(f.calls());}finally{await adapter.close();f.cleanup();}
 }
});

test('legacy observer consumes a completed final read from the same turn',async()=>{
 const f=nativeFixture(),adapter=new CodexAdapter(f.options);f.set({progressInterval:20});
 try{const handle=await adapter.start(fixedInput()),run=(adapter as any).runs.get(handle.runtime_turn_id);f.set({thread:threadResponse(handle)});await (adapter as any).observeDeadline(run,'idle');const values=await drain(adapter,handle);assert.equal((values.at(-1) as any).resume_info.output.answer,'42');assert.equal(f.calls().filter(m=>m.method==='thread/read').length,1);assert.equal(f.calls().filter(m=>m.method==='turn/interrupt').length,0);}finally{await adapter.close();f.cleanup();}
});

test('pure observation timings preserve legacy model and reasoning; writing policy remains authoritative',async()=>{
 for(const explicitWriting of [false,true]){
  const f=nativeFixture(),adapter=new CodexAdapter(f.options),input=fixedInput(),frozen=input.input_manifest.frozen as any;
  frozen.observation_policy={idle_timeout_ms:30000,max_duration_ms:60000};
  if(explicitWriting)frozen.service_agent={execution_policy:{model:'gpt-6.1-sol',reasoning_effort:'medium',idle_timeout_ms:180000,max_duration_ms:900000}};
  f.set({finalDelay:20});
  try{const handle=await adapter.start(input),run=(adapter as any).runs.get(handle.runtime_turn_id);await drain(adapter,handle);const turn=f.calls().find(m=>m.method==='turn/start');assert.equal(turn.params.model,'gpt-6.1-sol');assert.equal(turn.params.effort,explicitWriting?'medium':'xhigh');assert.deepEqual(run.observation,explicitWriting?{idle_timeout_ms:180000,max_duration_ms:900000}:{idle_timeout_ms:30000,max_duration_ms:60000});assert.equal(!!handle.checkpoint.execution_policy,explicitWriting);}finally{await adapter.close();f.cleanup();}
 }
});

test('idle unknown and read errors retain producer; hard deadline requests exact interrupt and confirms stopped',async()=>{
 for(const readError of [false,true]){
  const f=nativeFixture(),adapter=new CodexAdapter(f.options);f.set({progressInterval:20,readError});
  try{const handle=await adapter.start(fixedInput()),run=(adapter as any).runs.get(handle.runtime_turn_id);await (adapter as any).observeDeadline(run,'idle');assert.equal(run.terminal,false);assert.equal(f.calls().filter(m=>m.fixture_event==='stdin_closed').length,0);await (adapter as any).observeDeadline(run,'duration');await assert.rejects(drain(adapter,handle),(error:any)=>error.code==='HOST_INTERRUPTED'&&error.details.observation==='duration');const stop=f.calls().find(m=>m.method==='turn/interrupt');assert.deepEqual(stop.params,{threadId:handle.runtime_session_id,turnId:handle.runtime_turn_id});assert.equal(f.calls().filter(m=>m.method==='turn/start').length,1);}finally{await adapter.close();f.cleanup();}
 }
});

test('hard deadline arriving during an idle query is retained; completed original read wins safely',async()=>{
 for(const completed of [false,true]){
  const f=nativeFixture(),adapter=new CodexAdapter(f.options);f.set({progressInterval:10});
  try{const handle=await adapter.start(fixedInput()),run=(adapter as any).runs.get(handle.runtime_turn_id);f.set({progressInterval:10,readDelay:60,thread:threadResponse(handle,completed?'completed':'inProgress')});const idle=(adapter as any).observeDeadline(run,'idle');await sleep(10);await (adapter as any).observeDeadline(run,'duration');await idle;assert.equal(run.terminal,true);if(completed){const values=await drain(adapter,handle);assert.equal((values.at(-1) as any).status,'completed');assert.equal(f.calls().filter(m=>m.method==='turn/interrupt').length,0);}else{await assert.rejects(drain(adapter,handle),{code:'HOST_INTERRUPTED'});assert.equal(f.calls().filter(m=>m.method==='turn/interrupt').length,1);}}finally{await adapter.close();f.cleanup();}
 }
});

test('unconfirmed hard stop stays unknown, closes only its producer and leaves no live child',async()=>{
 for(const interruptError of [false,true]){
  const f=nativeFixture(),adapter=new CodexAdapter(f.options);f.set({progressInterval:20,ignoreInterrupt:true,interruptError});
  try{const handle=await adapter.start(fixedInput()),run=(adapter as any).runs.get(handle.runtime_turn_id);await (adapter as any).observeDeadline(run,'duration');await assert.rejects(drain(adapter,handle),(error:any)=>error.code==='RESULT_UNKNOWN'&&error.details.producer_close_requested===true&&error.details.native_interrupt===(interruptError?'unconfirmed':'requested'));await adapter.close();for(const pid of f.calls().filter(m=>m.fixture_event==='spawn').map(m=>m.pid))assert.throws(()=>process.kill(pid,0));assert.equal(f.calls().filter(m=>m.method==='turn/start').length,1);assert.equal(f.calls().filter(m=>m.method==='thread/resume').length,0);}finally{await adapter.close();f.cleanup();}
 }
});

test('observer transport failure is unknown and does not start another turn',async()=>{
 const f=nativeFixture(),adapter=new CodexAdapter(f.options);f.set({progressInterval:20});
 try{const handle=await adapter.start(fixedInput()),run=(adapter as any).runs.get(handle.runtime_turn_id);f.set({disconnectOnRead:true});await (adapter as any).observeDeadline(run,'idle');await assert.rejects(drain(adapter,handle),{code:'RESULT_UNKNOWN'});assert.equal(f.calls().filter(m=>m.method==='turn/start').length,1);assert.equal(f.calls().filter(m=>m.method==='thread/resume').length,0);}finally{await adapter.close();f.cleanup();}
});

test('query final followed by close failure never falls back to a generation',async()=>{
 const f=nativeFixture(),adapter=new CodexAdapter(f.options),handle=originalHandle(fixedInput(),f.root,f.options.workspace_id);f.set({thread:threadResponse(handle)});
 const original=(adapter as any).native.bind(adapter);(adapter as any).native=(...args:any[])=>{const native=original(...args),close=native.close.bind(native);native.close=async()=>{await close();throw new Error('controlled terminal close failure');};return native;};
 try{await assert.rejects(adapter.resume(handle,{recovery_action:'query_original'}),(error:any)=>error.code==='RESULT_UNKNOWN'&&error.details.no_new_turn_started===true&&error.details.producer_close_unconfirmed===false);await assert.rejects(drain(adapter,handle),{code:'HOST_RUN_NOT_CURRENT'});assertNoNewTurn(f.calls());for(const pid of f.calls().filter(m=>m.fixture_event==='spawn').map(m=>m.pid))assert.throws(()=>process.kill(pid,0));assert.equal((adapter as any).starting.size,0);}finally{try{await adapter.close();}catch{/* fault is intentional; actual child already exited. */}f.cleanup();}
});
