import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {startStudioFixture,STUDIO_ARTICLE} from './harness.ts';
import type {StudioSnapshot} from '../../packages/contracts/src/index.ts';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
async function delayedBrief(){
 const f=await startStudioFixture({auto_worker:false}),entered=deferred(),release=deferred(),ended=deferred(),original=f.analysis.analyze.bind(f.analysis);let signal:AbortSignal|undefined,active=0,closed=0;
 f.analysis.analyze=async(request,options)=>{signal=options.signal;active++;entered.resolve();try{await release.promise;return await original(request,options);}finally{active--;closed++;ended.resolve();}};
 const s=await(await f.call('GET','/api/v1/image-studio?topic_id='+f.topic.id)).json() as StudioSnapshot;
 const body={topic_id:s.topic_id,document_revision_id:s.document_revision_id,paragraph_id:s.paragraphs[0]!.id,placement_paragraph_id:s.paragraphs[1]!.id,description:'普通关闭回归：分析内容期间停止观察',title:'正常分析关闭',position:'after',provider:'codex',references:[]};
 const request=new AbortController();
 const response=fetch('http://127.0.0.1:'+f.app.address.port+'/api/v1/image-studio/brief',{method:'POST',signal:request.signal,headers:{'content-type':'application/json','x-workspace-id':f.app.identity.workspace_id,'x-service-instance-id':f.app.identity.service_instance_id,'idempotency-key':randomUUID()},body:JSON.stringify(body)});
 // Observe rejection even when a caller stops waiting for the response.
 void response.catch(()=>{});
 await entered.promise;
 return{f,response,request,release,ended,get signal(){return signal!;},get active(){return active;},get closed(){return closed;}};
}
test('normal HTTP brief waits for its owned analysis, saves the result once and closes cleanly',async()=>{
 const d=await delayedBrief();try{assert.equal(d.signal.aborted,false);d.release.resolve();const response=await d.response;assert.equal(response.status,200);const brief=await response.json() as {native:Record<string,unknown>};assert.equal(brief.native.native_thread_id,'fixture-brief-thread');assert.equal(d.active,0);assert.equal(d.closed,1);assert.equal(d.f.provider.submits,0);
  const state=await(await d.f.call('GET','/api/v1/image-studio?topic_id='+d.f.topic.id)).json() as StudioSnapshot;assert.equal(state.article_text,STUDIO_ARTICLE);assert.equal(state.briefs.length,1);
 }finally{d.release.resolve();await d.ended.promise;await d.f.close();}assert.equal(existsSync(d.f.root),false);
});
test('HTTP cancellation reaches the analysis; its late result remains unknown and cannot save a brief',async()=>{
 const d=await delayedBrief();try{d.request.abort(new Error('own client stopped'));await assert.rejects(d.response);for(let n=0;n<30&&!d.signal.aborted;n++)await new Promise<void>(done=>setTimeout(done,10));assert.equal(d.signal.aborted,true);assert.equal(d.active,1);assert.equal(d.closed,0);
  d.release.resolve();await d.ended.promise;let state:StudioSnapshot|undefined;for(let n=0;n<30;n++){state=await(await d.f.call('GET','/api/v1/image-studio?topic_id='+d.f.topic.id)).json() as StudioSnapshot;const raw=d.f.app.context.db.prepare('SELECT value FROM application_metadata WHERE key LIKE ?').get('wechat-image-studio.v1:'+d.f.app.identity.workspace_id+':%');if(raw&&Object.values(JSON.parse(String(raw.value)).brief_invocations).some((v:any)=>v.state==='unknown'))break;await new Promise<void>(done=>setTimeout(done,10));}
  assert.equal(state!.briefs.length,0);assert.equal(state!.article_text,STUDIO_ARTICLE);assert.equal(d.f.provider.submits,0);const raw=d.f.app.context.db.prepare('SELECT value FROM application_metadata WHERE key LIKE ?').get('wechat-image-studio.v1:'+d.f.app.identity.workspace_id+':%')!;assert.equal((Object.values(JSON.parse(String(raw.value)).brief_invocations)[0] as any).state,'unknown');
 }finally{d.release.resolve();await d.ended.promise;await d.f.close();}assert.equal(existsSync(d.f.root),false);
});
test('service close cancels an active HTTP analysis and duplicate close shares the pending cleanup',async()=>{
 const d=await delayedBrief();let closing:Promise<void>|undefined;
 try{closing=d.f.app.close();const repeated=d.f.app.close();assert.equal(repeated,closing);let settled=false;void closing.then(()=>{settled=true;});await new Promise<void>(done=>setImmediate(done));assert.equal(d.signal.aborted,true);assert.equal(settled,false);assert.equal(d.active,1);assert.equal(d.closed,0);assert.equal(existsSync(d.f.root),true);assert.ok(d.f.app.context.db.prepare('SELECT id FROM workspaces').get());
  d.release.resolve();await d.response;await closing;assert.equal(d.active,0);assert.equal(d.closed,1);assert.equal(d.f.provider.submits,0);
 }finally{d.release.resolve();await d.ended.promise;await d.response.catch(()=>{});await closing;await d.f.close();}assert.equal(existsSync(d.f.root),false);
});
