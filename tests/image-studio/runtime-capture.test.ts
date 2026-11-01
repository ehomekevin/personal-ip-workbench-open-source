import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {managedFiniteCapture} from './runtime-capture.ts';
import {runStudioBounded,type StudioRunPort} from './bounded-runner.ts';
import type {StudioGenerationRequest,StudioImageVersion} from '../../packages/contracts/src/index.ts';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
function fixture(delayed:'build'|'listen'|'launch'|'newPage'|'capture',fail?:'launch'|'page_close'){
 const entered=deferred(),release=deferred(),made={server:0,browser:0,page:0},closed={server:0,browser:0,page:0};let frames=0;
 const wait=async(stage:typeof delayed)=>{if(delayed===stage){entered.resolve();await release.promise;}};
 const capture=managedFiniteCapture({
  async build(){await wait('build');return{};},
  createServer(){made.server++;return{};},async listen(){await wait('listen');},
  async launch(){await wait('launch');if(fail==='launch')throw new Error('Fixture launch failed');made.browser++;return{};},
  async newPage(){await wait('newPage');made.page++;return{};},
  async capture(_server,_page,_index,_signal,check){await wait('capture');check();frames++;},
  async closePage(){if(fail==='page_close')throw new Error('Fixture page did not close');closed.page++;},
  async closeBrowser(){closed.browser++;},async closeServer(){closed.server++;}
 });return{capture,entered,release,made,closed,get frames(){return frames;}};
}
for(const stage of ['build','listen','launch','newPage','capture'] as const)test('capture close waits for delayed '+stage+' and owns every late resource',async()=>{
 const f=fixture(stage),controller=new AbortController(),pending=f.capture.capture(0,controller.signal);void pending.catch(()=>{});await f.entered.promise;
 controller.abort(new Error('Fixture observation timeout'));let didClose=false;const closing=f.capture.close().then(()=>{didClose=true;});await Promise.resolve();assert.equal(didClose,false);assert.equal(f.capture.snapshot().fully_closed,false);
 f.release.resolve();await assert.rejects(pending);await closing;assert.deepEqual(f.closed,f.made);assert.equal(f.frames,0);assert.equal(f.capture.snapshot().fully_closed,true);assert.deepEqual(f.capture.snapshot().owned_resources,{server:false,browser:false,page:false});
 if(stage==='build')assert.deepEqual(f.made,{server:0,browser:0,page:0});if(stage==='launch')assert.equal(f.made.page,0);
 await assert.rejects(f.capture.capture(1,new AbortController().signal),/closing/);assert.equal(await f.capture.close(),undefined);
});
test('capture initialization failure closes already created server without replacement initialization',async()=>{
 const f=fixture('launch','launch'),pending=f.capture.capture(0,new AbortController().signal);void pending.catch(()=>{});await f.entered.promise;f.release.resolve();await assert.rejects(pending,/Fixture launch failed/);
 assert.deepEqual(f.made,{server:1,browser:0,page:0});assert.deepEqual(f.closed,f.made);await assert.rejects(f.capture.capture(1,new AbortController().signal),/closing/);await f.capture.close();assert.equal(f.capture.snapshot().fully_closed,true);
});
function port(capture:ReturnType<typeof fixture>['capture']):StudioRunPort{
 return{setup:async()=>{},prepare:async(provider,kind)=>({provider,size_mode:kind,operation:'generate'}) as StudioGenerationRequest,submit:async()=>({job_id:'owned-fixture-job',version_id:'owned-fixture-version',input_hash:'fixture'}),observe:async()=>({state:'succeeded',version:{id:'owned-fixture-version',asset_id:'owned-fixture-asset',actual_size:{width:640,height:640,aspect_ratio:'1:1'}} as StudioImageVersion,native:{fixture:true}}),capture:capture.capture,snapshot:()=>({capture:capture.snapshot()}),close:capture.close};
}
test('runner local_stop remains false while the real capture lifecycle is still initializing',async()=>{
 const f=fixture('launch'),out=mkdtempSync(join(import.meta.dirname,'.studio-runtime-'));
 try{
  const running=runStudioBounded(port(f.capture),{out,mode:'fixture',operation_timeout_ms:10,cleanup_timeout_ms:20,max_observations:1});await f.entered.promise;
  const result=await running;assert.equal(result.local_stop,false);assert.ok(result.errors.some(error=>error.startsWith('Own cleanup:')));assert.equal(f.capture.snapshot().fully_closed,false);
  f.release.resolve();await f.capture.close();assert.deepEqual(f.closed,f.made);assert.equal(f.made.page,0);assert.equal(result.local_stop,false);
 }finally{f.release.resolve();await f.capture.close();rmSync(out,{recursive:true,force:true});}
});
test('runner confirms local_stop only after delayed launch is reclaimed; cleanup failure stays visible',async()=>{
 const f=fixture('launch'),out=mkdtempSync(join(import.meta.dirname,'.studio-runtime-'));
 try{
  const running=runStudioBounded(port(f.capture),{out,mode:'fixture',operation_timeout_ms:10,cleanup_timeout_ms:100,max_observations:1});await f.entered.promise;const release=setTimeout(()=>f.release.resolve(),30);const result=await running;clearTimeout(release);
  assert.equal(result.local_stop,true);assert.equal(f.capture.snapshot().fully_closed,true);assert.deepEqual(f.closed,f.made);assert.equal(f.made.page,0);
 }finally{f.release.resolve();await f.capture.close();rmSync(out,{recursive:true,force:true});}
 const failed=fixture('capture','page_close'),pending=failed.capture.capture(0,new AbortController().signal);await failed.entered.promise;failed.release.resolve();await pending;
 await assert.rejects(failed.capture.close(),/did not all close/);assert.equal(failed.capture.snapshot().fully_closed,false);assert.equal(failed.capture.snapshot().owned_resources.page,true);assert.equal(failed.closed.server,1);assert.equal(failed.closed.browser,1);
});
