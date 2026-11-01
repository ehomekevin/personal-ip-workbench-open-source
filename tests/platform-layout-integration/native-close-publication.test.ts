import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {CodexAdapter} from '../../packages/adapters/src/agent/codex/index.ts';
import {canonical} from '../../packages/adapters/src/agent/codex/primitives.ts';
import {nativeFixture,fixedInput,originalHandle,threadResponse} from './native-harness.ts';
const noGeneration=(calls:any[])=>{for(const method of ['thread/start','thread/resume','turn/start','turn/interrupt','model/list'])assert.equal(calls.filter(c=>c.method===method).length,0,method);};
async function drain(adapter:CodexAdapter,handle:any){const values:any[]=[];for await(const value of adapter.streamEvents(handle))values.push(value);return values;}
function assertClosed(calls:any[]){for(const pid of calls.filter(c=>c.fixture_event==='spawn').map(c=>c.pid))assert.throws(()=>process.kill(pid,0));}

test('NATIVE-QA-P2-01: rejected close cannot expose completed through original public handle',async()=>{
 const f=nativeFixture(),adapter=new CodexAdapter(f.options),handle=originalHandle(fixedInput(),f.root,f.options.workspace_id);f.set({thread:threadResponse(handle)});
 const factory=(adapter as any).native.bind(adapter);(adapter as any).native=(...args:any[])=>{const native=factory(...args),close=native.close.bind(native);native.close=async()=>{await close();throw new Error('independent controlled query close failure');};return native;};
 try{
  await assert.rejects(adapter.resume(handle,{recovery_action:'query_original'}),(error:any)=>error.code==='RESULT_UNKNOWN'&&error.details.no_new_turn_started===true);
  let values:any[]|null=null,error:unknown=null;try{values=await drain(adapter,handle);}catch(caught){error=caught;}
  const observation={synthetic:true,resume_rejected:true,stream_error_code:(error as any)?.code??null,stream_statuses:values?.map(v=>v.status)??null,completed_count:values?.filter(v=>v.status==='completed').length??0,trace_methods:f.calls().filter(c=>c.method).map(c=>c.method)};
  writeFileSync(join(f.root,'close-failed-stream-observation.json'),JSON.stringify(observation,null,2)+'\n',{mode:0o600});
  noGeneration(f.calls());assertClosed(f.calls());
  assert.equal(observation.completed_count,0,'a rejected query must not leave publicly consumable completed output');assert.equal((error as any)?.code,'HOST_RUN_NOT_CURRENT');
 }finally{try{await adapter.close();}catch{/* real child closed; injected close fault retained */}f.cleanup();}
});

test('original final is not published while query client close is pending',async()=>{
 const f=nativeFixture(),adapter=new CodexAdapter(f.options),handle=originalHandle(fixedInput(),f.root,f.options.workspace_id);f.set({thread:threadResponse(handle)});
 let release!:()=>void,closed!:()=>void;const gate=new Promise<void>(r=>{release=r;}),clientClosed=new Promise<void>(r=>{closed=r;});
 const factory=(adapter as any).native.bind(adapter);(adapter as any).native=(...args:any[])=>{const native=factory(...args),close=native.close.bind(native);native.close=async()=>{await close();closed();await gate;};return native;};
 const pending=adapter.resume(handle,{recovery_action:'query_original'});
 try{await clientClosed;await assert.rejects(drain(adapter,handle),{code:'HOST_RUN_NOT_CURRENT'});assertClosed(f.calls());release();const recovered=await pending,values=await drain(adapter,recovered);assert.equal(values.filter(v=>v.status==='completed').length,1);assert.equal(recovered.runtime_turn_id,handle.runtime_turn_id);noGeneration(f.calls());}finally{release();await pending.catch(()=>{});await adapter.close();f.cleanup();}
});

test('unknown and close failure leave no stream, then same adapter can retry without a new turn',async()=>{
 const f=nativeFixture(),adapter=new CodexAdapter(f.options),handle=originalHandle(fixedInput(),f.root,f.options.workspace_id),before=canonical(handle);const factory=(adapter as any).native.bind(adapter);
 try{
  f.set({thread:threadResponse(handle,'inProgress')});await assert.rejects(adapter.resume(handle,{recovery_action:'query_original'}),(error:any)=>error.code==='RESULT_UNKNOWN'&&error.details.no_new_turn_started===true);await assert.rejects(drain(adapter,handle),{code:'HOST_RUN_NOT_CURRENT'});
  f.set({thread:threadResponse(handle)});(adapter as any).native=(...args:any[])=>{const native=factory(...args),close=native.close.bind(native);native.close=async()=>{await close();throw new Error('controlled retry close failure');};return native;};
  await assert.rejects(adapter.resume(handle,{recovery_action:'query_original'}),(error:any)=>error.code==='RESULT_UNKNOWN'&&error.details.no_new_turn_started===true);await assert.rejects(drain(adapter,handle),{code:'HOST_RUN_NOT_CURRENT'});
  (adapter as any).native=factory;const recovered=await adapter.resume(handle,{recovery_action:'query_original'}),values=await drain(adapter,recovered);assert.equal(values.filter(v=>v.status==='completed').length,1);assert.deepEqual(values[0].resume_info.output,{answer:'42'});assert.equal(canonical(handle),before);assert.equal(recovered.runtime_turn_id,handle.runtime_turn_id);noGeneration(f.calls());assertClosed(f.calls());
 }finally{try{await adapter.close();}catch{/* fault injection may remain installed after a red assertion; child really exited. */}f.cleanup();}
});
