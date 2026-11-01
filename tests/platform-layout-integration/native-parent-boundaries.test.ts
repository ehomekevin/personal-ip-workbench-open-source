import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexAdapter} from '../../packages/adapters/src/agent/codex/index.ts';
import {canonical} from '../../packages/adapters/src/agent/codex/primitives.ts';
import {nativeFixture,fixedInput,originalHandle,threadResponse} from './native-harness.ts';
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const drain=async(adapter:CodexAdapter,handle:any)=>{const values:any[]=[];for await(const value of adapter.streamEvents(handle))values.push(value);return values;};
const noGeneration=(calls:any[])=>{for(const method of ['thread/start','thread/resume','turn/start','turn/interrupt','model/list'])assert.equal(calls.filter(call=>call.method===method).length,0,method);};
// 原QA四个通过边界的断言原样重放；此处是开发回归，不是新的独立QA。
test('parent-QA regression: foreign thread/turn progress is ignored and matching progress never extends hard timer',async()=>{
 const f=nativeFixture(),adapter=new CodexAdapter(f.options);f.set({progressInterval:10});
 try{
  const handle=await adapter.start(fixedInput()),internals=adapter as any,run=internals.runs.get(handle.runtime_turn_id),generation=run.progressGeneration;
  const hard=run.hardTimer,hardStarted=run.hardTimer._idleStart,idle=run.timer;
  internals.event(run,{method:'item/agentMessage/delta',params:{threadId:'foreign-thread',turnId:handle.runtime_turn_id,itemId:'foreign',delta:'x'}});
  internals.event(run,{method:'item/agentMessage/delta',params:{threadId:handle.runtime_session_id,turnId:'foreign-turn',itemId:'foreign',delta:'x'}});
  assert.equal(run.progressGeneration,generation);assert.equal(run.timer,idle);
  await sleep(45);assert.ok(run.progressGeneration>generation);assert.notEqual(run.timer,idle);assert.equal(run.hardTimer,hard);assert.equal(run.hardTimer._idleStart,hardStarted);
  assert.equal(run.observation.max_duration_ms,900000);await adapter.cancel(handle);await assert.rejects(drain(adapter,handle),{code:'HOST_INTERRUPTED'});
 }finally{await adapter.close();f.cleanup();}
});

test('parent-QA regression: closing a pending query never interrupts original turn and a fresh checker can query the same handle',async()=>{
 const f=nativeFixture(),adapter=new CodexAdapter(f.options),handle=originalHandle(fixedInput(),f.root,f.options.workspace_id),before=canonical(handle);
 f.set({thread:threadResponse(handle,'inProgress'),readDelay:500});
 let second:CodexAdapter|undefined;
 try{
  const pending=adapter.resume(handle,{recovery_action:'query_original'});const rejection=assert.rejects(pending,(error:any)=>error.code==='RESULT_UNKNOWN'&&error.details.no_new_turn_started===true);
  for(let i=0;i<100&&!f.calls().some(call=>call.method==='thread/read');i++)await sleep(10);
  assert.equal(f.calls().filter(call=>call.method==='thread/read').length,1);
  await adapter.close();await rejection;
  f.set({thread:threadResponse(handle)});second=new CodexAdapter(f.options);const recovered=await second.resume(handle,{recovery_action:'query_original'}),values=await drain(second,recovered);
  assert.equal(values.length,1);assert.equal(values[0].status,'completed');assert.equal(recovered.runtime_turn_id,handle.runtime_turn_id);assert.equal(canonical(handle),before);noGeneration(f.calls());
 }finally{await adapter.close();await second?.close();f.cleanup();}
});

test('parent-QA regression: last final is authoritative; a preceding valid final cannot hide a partial last final',async()=>{
 const f=nativeFixture(),adapter=new CodexAdapter(f.options),handle=originalHandle(fixedInput(),f.root,f.options.workspace_id),response=threadResponse(handle);
 response.turns[0].items.push({...response.turns[0].items[0],id:'last-partial-final',text:'{"answer":'});f.set({thread:response});
 try{await assert.rejects(adapter.resume(handle,{recovery_action:'query_original'}),(error:any)=>error.details.original_result_unavailable===true&&error.details.no_new_turn_started===true);noGeneration(f.calls());}finally{await adapter.close();f.cleanup();}
});

test('parent-QA regression: a duplicate terminal notification cannot append another completed result',async()=>{
 const f=nativeFixture(),adapter=new CodexAdapter(f.options);f.set({finalDelay:10});
 try{const handle=await adapter.start(fixedInput()),values=await drain(adapter,handle),run=(adapter as any).runs.get(handle.runtime_turn_id);assert.equal(values.filter(v=>v.status==='completed').length,1);(adapter as any).event(run,{method:'turn/completed',params:{threadId:handle.runtime_session_id,turn:{id:handle.runtime_turn_id,status:'completed',items:[]}}});assert.deepEqual(await drain(adapter,handle),[]);assert.equal(f.calls().filter(call=>call.method==='turn/start').length,1);}finally{await adapter.close();f.cleanup();}
});
