import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageAnalysisLifecycle} from '../../packages/domain/src/artifact-execution/image-studio/analysis-lifecycle.ts';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
test('image analysis owner closes only after an aborted uncooperative port finishes its cleanup',async()=>{
 const owner=new ImageAnalysisLifecycle(),entered=deferred(),release=deferred();let active=0,closed=0,signal:AbortSignal|undefined;
 const pending=owner.run(async s=>{signal=s;active++;entered.resolve();try{await release.promise;s.throwIfAborted();return'late';}finally{active--;closed++;}});
 await entered.promise;const closing=owner.close();let resolved=false;void closing.then(()=>{resolved=true;});await new Promise<void>(done=>setImmediate(done));
 assert.equal(signal?.aborted,true);assert.equal(active,1);assert.equal(closed,0);assert.equal(resolved,false);assert.deepEqual(owner.snapshot(),{close_requested:true,fully_closed:false,in_flight:1});assert.equal(owner.close(),closing);
 release.resolve();await assert.rejects(pending);await closing;assert.equal(active,0);assert.equal(closed,1);assert.deepEqual(owner.snapshot(),{close_requested:true,fully_closed:true,in_flight:0});await assert.rejects(owner.run(async()=> 'replacement'));
});
test('request cancellation and bounded timeout propagate but never abandon the port cleanup promise',async()=>{
 for(const reason of ['request','timeout'] as const){
  const owner=new ImageAnalysisLifecycle(reason==='timeout'?20:180000),request=new AbortController(),entered=deferred(),aborted=deferred(),release=deferred();let closed=0;
  const pending=owner.run(async signal=>{entered.resolve();signal.addEventListener('abort',aborted.resolve,{once:true});try{await release.promise;signal.throwIfAborted();return'late';}finally{closed++;}},request.signal);
  await entered.promise;if(reason==='request')request.abort(new Error('own HTTP request closed'));else await new Promise<void>(done=>setTimeout(done,30));await aborted.promise;assert.equal(closed,0);assert.equal(owner.snapshot().in_flight,1);
  const closing=owner.close();assert.equal(owner.snapshot().fully_closed,false);release.resolve();await assert.rejects(pending);await closing;assert.equal(closed,1);
 }
});
test('normal analysis completion retains its result and a pre-aborted request never enters the port',async()=>{
 const owner=new ImageAnalysisLifecycle();assert.equal(await owner.run(async()=> 'completed'),'completed');assert.equal(owner.snapshot().in_flight,0);
 const request=new AbortController();request.abort(new Error('already closed'));let calls=0;await assert.rejects(owner.run(async()=>{calls++;return'never';},request.signal));assert.equal(calls,0);await owner.close();assert.equal(owner.snapshot().fully_closed,true);
});
