import test from 'node:test';
import assert from 'node:assert/strict';
import {managedFiniteSetup} from './runtime-setup.ts';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
for(const delay of ['start','initialize'] as const)test('service setup close owns late '+delay+' and prevents later initialization steps',async()=>{
 const entered=deferred(),release=deferred(),controller=new AbortController();let made=0,closed=0,initializations=0,timers=0;
 const setup=managedFiniteSetup({async start(){made++;if(delay==='start'){entered.resolve();await release.promise;}return{};},async initialize(_app,_signal,check){initializations++;if(delay==='initialize'){entered.resolve();await release.promise;}check();timers++;},beforeClose:async()=>{},close:async()=>{closed++;}});
 const pending=setup.setup(controller.signal);void pending.catch(()=>{});await entered.promise;let stopped=false;controller.abort(new Error('Owned fixture stop'));const closing=setup.close().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);assert.equal(setup.snapshot().fully_closed,false);
 release.resolve();await assert.rejects(pending);await closing;assert.equal(made,1);assert.equal(closed,1);assert.equal(timers,0);assert.equal(initializations,delay==='start'?0:1);assert.equal(setup.snapshot().fully_closed,true);assert.equal(setup.snapshot().owned_app,false);await assert.rejects(setup.setup(new AbortController().signal),/already started/);
});
test('service cleanup tries app close even when waiting for a worker reports an error',async()=>{
 let closed=0;const setup=managedFiniteSetup({start:async()=>({}),initialize:async()=>{},beforeClose:async()=>{throw new Error('Owned worker fixture failed');},close:async()=>{closed++;}});await setup.setup(new AbortController().signal);await assert.rejects(setup.close(),/did not all close/);assert.equal(closed,1);assert.equal(setup.snapshot().fully_closed,false);assert.equal(setup.snapshot().owned_app,false);
});
