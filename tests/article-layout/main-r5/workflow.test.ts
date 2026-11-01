import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {workflowFixture} from './workflow-fixture.ts';
import {getJob,getAttempt} from '../../../packages/storage/src/jobs/index.ts';
import {readVisualRecord,visualKey,type ArticleVisualRenderRecord} from '../../../packages/storage/src/article-layout/visual-store.ts';
import {verifyLayoutCheckOutput} from '../../../packages/domain/src/result-commit/article-layout.ts';
import {digest, LAYOUT_RULES_VERSION, confirmArticleLayout, articleConfirmationIsCurrent, articleConfirmationRulesOutdated} from '../../../packages/domain/src/article-layout/index.ts';
import {ARTICLE_LAYOUT_RENDERER_VERSION} from '../../../apps/service/src/bootstrap/article-layout-renderer.ts';

const fixtureTests:Array<{name:string;passed:boolean;directory:string;error?:string}>=[];
async function run(name:string,body:(f:Awaited<ReturnType<typeof workflowFixture>>)=>Promise<void>,mode:Parameters<typeof workflowFixture>[0]='complete'){
 const f=await workflowFixture(mode);try{await body(f);fixtureTests.push({name,passed:true,directory:f.directory});}catch(error){fixtureTests.push({name,passed:false,directory:f.directory,error:String(error)});writeFileSync(join(f.directory,'first-failure.json'),JSON.stringify({name,error:String(error),stack:error instanceof Error?error.stack:null},null,2));throw error;}finally{await f.close();}
}
const statusPath=(f:Awaited<ReturnType<typeof workflowFixture>>)=>'/api/v1/article-layout/visual-status?topic_id='+f.topic.id;

test('MAIN-R7 renderer/rules3 bind new renders, reject an exact legacy-version context and keep consumed results historical after a renderer successor',async()=>run('r7-version-consumed-history',async f=>{
 assert.equal(ARTICLE_LAYOUT_RENDERER_VERSION,'c1-reader.v3');assert.equal(LAYOUT_RULES_VERSION,'wechat-layout-rules.3');
 const rendered=await f.render(),current=f.renderRecord(rendered.render_id),ws=f.app.identity.workspace_id,key=visualKey(ws,'render',rendered.render_id);
 assert.equal(current.context.renderer_version,ARTICLE_LAYOUT_RENDERER_VERSION);assert.equal(current.context.rules_version,LAYOUT_RULES_VERSION);
 // Only the own fixture's render-context metadata is retagged; this is a legacy-version gate case, not old pixels or a historical model replay.
 const legacy=structuredClone(current);legacy.context.renderer_version='c1-reader.v2';legacy.context.rules_version='wechat-layout-rules.2';legacy.context_sha256=digest(legacy.context);
 f.context.db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(legacy),key);
 const response=await f.response('POST','/api/v1/article-layout/visual-checks',{topic_id:f.topic.id,expected_version:(await f.load()).snapshot.version,render_id:rendered.render_id});assert.equal(response.status,422);assert.equal((await response.json()).error.code,'INPUT_STALE');assert.equal(f.context.db.prepare('SELECT count(*) n FROM jobs').get()!.n,0);
 f.context.db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(current),key);
 const job=await f.enqueue(rendered);assert.equal((await f.worker.runOnce())?.state,'committed');assert.equal((await f.status()).latest?.current,true);
 const before=(await f.load()).snapshot,receipts=f.context.db.prepare('SELECT * FROM result_receipts').all(),execution=f.runtime.workflow.journal.read(f.jobRecord(job.job_id).execution_attempt_id!);
 const confirmed=confirmArticleLayout(before,{actor:'fixture-user',human_decision_ref:'synthetic-only',layout_only:true});confirmed.confirmation!.binding.rules_version='wechat-layout-rules.2';const rawConfirmation=structuredClone(confirmed.confirmation);
 assert.equal(articleConfirmationIsCurrent(confirmed),false);assert.equal(articleConfirmationRulesOutdated(confirmed),true);assert.deepEqual(confirmed.confirmation,rawConfirmation);
 f.runtime.workflow.options.renderer_version=ARTICLE_LAYOUT_RENDERER_VERSION+'.controlled-successor';
 for(let n=0;n<2;n++){const status=await f.status();assert.equal(status.latest?.state,'stale');assert.equal(status.latest?.current,false);assert.equal(status.latest?.result?.verdict,'passed');assert.deepEqual((await f.load()).snapshot,before);}
 assert.deepEqual(f.context.db.prepare('SELECT * FROM result_receipts').all(),receipts);assert.deepEqual(f.runtime.workflow.journal.read(f.jobRecord(job.job_id).execution_attempt_id!),execution);assert.equal(f.native.starts,1);
}));

test('MAIN-R7 renderer successor blocks consumption of an already committed but unconsumed receipt without rewriting any proof',async()=>run('r7-version-unconsumed',async f=>{
 const job=await f.enqueue();assert.equal((await f.worker.runOnce())?.state,'committed');const before=(await f.load()).snapshot;assert.equal(before.checks.length,0);
 const receipts=f.context.db.prepare('SELECT * FROM result_receipts').all(),execution=f.runtime.workflow.journal.read(f.jobRecord(job.job_id).execution_attempt_id!);
 f.runtime.workflow.options.renderer_version=ARTICLE_LAYOUT_RENDERER_VERSION+'.controlled-successor';
 for(let n=0;n<2;n++){const status=await f.status();assert.equal(status.latest?.state,'stale');assert.equal(status.latest?.current,false);assert.deepEqual((await f.load()).snapshot,before);assert.equal(f.jobRecord(job.job_id).consumed_receipt_id,null);}
 assert.deepEqual(f.context.db.prepare('SELECT * FROM result_receipts').all(),receipts);assert.deepEqual(f.runtime.workflow.journal.read(f.jobRecord(job.job_id).execution_attempt_id!),execution);assert.equal(f.native.starts,1);
}));

test('MAIN-R5 real saved C1 → actual 390 Reader → HTTP enqueue → DurableWorker/native fixture → committed receipt → GET consume → refresh exactly once, no Document write',async()=>run('complete-chain',async f=>{
 const before=await f.documents.get(f.request(),f.documentId),beforeRevisions=f.context.db.prepare('SELECT count(*) n FROM document_revisions').get()!.n;
 const saved=await f.save();assert.equal(saved.state,'saved');assert.equal(saved.snapshot.document_revision_id,null);
 const rendered=await f.render(),frozen=f.renderRecord(rendered.render_id);assert.equal(frozen.context.snapshot_version,saved.snapshot.version);assert.equal(frozen.context.snapshot_sha256,digest(saved.snapshot));assert.equal(frozen.input.render_pngs[0]!.width,390);assert.ok(frozen.input.blocks.some(b=>b.id==='__topic_title__'));
 const enqueued=await f.enqueue(rendered);assert.equal(enqueued.state,'queued');assert.equal(f.native.starts,0);
 const result=await f.worker.runOnce();assert.equal(result?.state,'committed');assert.equal(getJob(f.context.db,f.app.identity.workspace_id,enqueued.job_id).state,'succeeded');
 assert.equal((await f.load()).snapshot.checks.length,0,'committed receipt is not a client check until consumption');
 const status=await f.status();assert.equal(status.latest?.state,'completed');assert.equal(status.latest?.result?.verdict,'passed');
 const refreshed=(await f.load()).snapshot;assert.equal(refreshed.checks.length,1);assert.equal(refreshed.text_hash,saved.snapshot.text_hash);assert.equal(refreshed.images_hash,saved.snapshot.images_hash);
 for(let n=0;n<3;n++){assert.equal((await f.status()).latest?.state,'completed');assert.equal((await f.load()).snapshot.version,refreshed.version);assert.equal((await f.load()).snapshot.checks.length,1);}
 const record=f.jobRecord(enqueued.job_id);assert.ok(record.consumed_receipt_id);assert.equal(record.consume_expected_version,saved.snapshot.version);
 assert.equal(f.runtime.workflow.journal.read(record.execution_attempt_id!)!.submit_count,1);assert.equal(f.native.threads,1);assert.equal(f.native.starts,1);
 const edited=await f.save(),history=await f.status();assert.equal(history.latest?.state,'stale');assert.equal(history.latest?.current,false);assert.equal(history.latest?.result?.binding.content_revision_id,saved.snapshot.content_revision_id,'trusted consumed result remains historical after new manual text');
 for(let n=0;n<2;n++){const again=await f.status();assert.equal(again.latest?.state,'stale');assert.equal(again.latest?.current,false);assert.equal(again.latest?.result?.verdict,'passed');assert.equal((await f.load()).snapshot.checks.length,1);assert.equal((await f.load()).snapshot.version,edited.snapshot.version,'refresh never revives or re-saves old result');}
 const after=await f.documents.get(f.request(),f.documentId);assert.equal(after.head_revision_id,before.head_revision_id);assert.equal(after.text,before.text);assert.equal(f.context.db.prepare('SELECT count(*) n FROM document_revisions').get()!.n,beforeRevisions);
}));

test('MAIN-R5 unknown result queries original native IDs under SQL attempt A2 without a new thread or turn',async()=>run('unknown-query-original',async f=>{
 const job=await f.enqueue();assert.equal((await f.worker.runOnce())?.state,'reconciling');const original=f.jobRecord(job.job_id).execution_attempt_id!;
 const unknown=await f.status();assert.equal(unknown.latest?.state,'unknown');assert.equal(unknown.latest?.can_query,true);assert.equal((await f.load()).snapshot.checks.length,0);
 await f.status();assert.equal(f.native.starts,1);assert.equal(f.native.threads,1);assert.equal(f.native.reads,0,'GET status never queries the provider');
 f.native.mode='complete';const queued=await f.call<{state:string}>('POST','/api/v1/article-layout/visual-queries',{topic_id:f.topic.id,job_id:job.job_id});assert.equal(queued.state,'queued');
 assert.equal((await f.worker.runOnce())?.state,'committed');const current=getJob(f.context.db,f.app.identity.workspace_id,job.job_id);assert.notEqual(current.current_attempt_id,original);assert.ok(current.attempt_generation>getAttempt(f.context.db,f.app.identity.workspace_id,original).attempt_generation);assert.equal(f.context.db.prepare('SELECT count(*) n FROM job_attempts WHERE job_id=?').get(job.job_id)!.n,2,'SQL attempt A2 retains independently advanced fence generation');
 const cp=JSON.parse(getAttempt(f.context.db,f.app.identity.workspace_id,current.current_attempt_id!).checkpoint);assert.equal(cp.layout_original_attempt_id,original);assert.equal(cp.layout_query_only,true);
 assert.equal((await f.status()).latest?.state,'completed');assert.equal((await f.load()).snapshot.checks.length,1);assert.equal(f.native.starts,1);assert.equal(f.native.threads,1);assert.equal(f.native.reads,1);assert.equal(f.jobRecord(job.job_id).execution_attempt_id,original);
},'reply-lost'));

test('MAIN-R5 positively pre-submit failure is terminal failed and later fresh intents 2/3/4 are admitted, not stuck unknown',async()=>run('pre-submit-and-later-intents',async f=>{
 const first=await f.enqueue();assert.equal((await f.worker.runOnce())?.state,'failed');assert.equal(getJob(f.context.db,f.app.identity.workspace_id,first.job_id).state,'failed');assert.equal((await f.status()).latest?.can_query,false);
 const failed=f.runtime.workflow.journal.read(f.jobRecord(first.job_id).execution_attempt_id!)!;assert.equal(failed.submit_count,0);assert.equal(failed.attempt.state,'failed');assert.equal(f.native.starts,0);assert.equal(f.native.threads,0);
 f.native.mode='complete';for(let n=2;n<=4;n++){const job=await f.enqueue();assert.notEqual(job.job_id,first.job_id);assert.equal((await f.worker.runOnce())?.state,'committed');assert.equal((await f.status()).latest?.state,'completed');assert.equal((await f.load()).snapshot.checks.length,n-1);}
 assert.equal(f.native.starts,3);assert.equal(f.native.threads,3);
},'no-image'));

test('MAIN-R5 receipt hash/generation, original SQL generation, PNG bytes and context tampering never reach current C1; restoring exact evidence permits one consume',async()=>run('receipt-input-counterexamples',async f=>{
 const job=await f.enqueue();assert.equal((await f.worker.runOnce())?.state,'committed');const db=f.context.db,ws=f.app.identity.workspace_id;
 const receipt=db.prepare("SELECT * FROM result_receipts WHERE job_id=? AND state='committed'").get(job.job_id)!;
 const rejected=async()=>{const response=await f.response('GET',statusPath(f));await response.json();assert.notEqual(response.status,200);assert.equal((await f.load()).snapshot.checks.length,0);assert.equal(f.jobRecord(job.job_id).consumed_receipt_id,null);};
 assert.throws(()=>db.prepare('UPDATE result_receipts SET output_hash=? WHERE id=?').run('f'.repeat(64),receipt.id!),/FIXED_PROVENANCE/,'committed receipt hash is immutable');
 assert.throws(()=>db.prepare('UPDATE result_receipts SET attempt_generation=attempt_generation+1 WHERE id=?').run(receipt.id!),/FIXED_PROVENANCE/,'committed receipt generation is immutable');
 const payload=JSON.parse(String(receipt.output_payload)),sqlJob=getJob(db,ws,job.job_id),attempt=getAttempt(db,ws,String(receipt.attempt_id));
 assert.throws(()=>verifyLayoutCheckOutput(f.context,sqlJob,attempt,{...payload.typed_output.layout_check,attempt_generation:attempt.attempt_generation+1}),/代次/);
 assert.throws(()=>verifyLayoutCheckOutput(f.context,sqlJob,attempt,{...payload.typed_output.layout_check,execution_sha256:'f'.repeat(64)}),/证明|摘要/);
 assert.throws(()=>f.worker.results.submit(f.request(),job.job_id,{attempt_id:attempt.id,attempt_generation:attempt.attempt_generation,expected_version:sqlJob.version,input_hash:sqlJob.input_hash,typed_output:{...payload.typed_output,layout_check:{...payload.typed_output.layout_check,execution_sha256:'f'.repeat(64)}}},f.worker.owner));
 assert.equal(db.prepare("SELECT count(*) n FROM result_receipts WHERE job_id=? AND state='committed'").get(job.job_id)!.n,1);assert.equal((await f.load()).snapshot.checks.length,0);
 const record=f.jobRecord(job.job_id),jobKey=visualKey(ws,'job',job.job_id);db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify({...record,execution_generation:999}),jobKey);await rejected();db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(record),jobKey);
 const render=f.renderRecord(job.render_id),key=visualKey(ws,'render',job.render_id);db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify({...render,context:{...render.context,topic_title:'tampered context'}}),key);await rejected();db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(render),key);
 const png=render.input.render_pngs[0]!,bytes=readFileSync(png.path);chmodSync(png.path,0o600);writeFileSync(png.path,Buffer.from('not a PNG'));await rejected();writeFileSync(png.path,bytes);chmodSync(png.path,0o444);
 assert.equal((await f.status()).latest?.state,'completed');assert.equal((await f.load()).snapshot.checks.length,1);assert.equal(f.native.starts,1);
}));

test('MAIN-R5 cancellation during native completion rejects late output and never commits or updates C1',async()=>run('cancel-late-output',async f=>{
 let release!:()=>void,started!:()=>void;f.native.holdTurn=new Promise<void>(done=>{release=done;});const observed=new Promise<void>(done=>{started=done;});f.native.turnStarted=started;
 const job=await f.enqueue(),work=f.worker.runOnce();await observed;
 const cancelled=await f.call<{state:string}>('POST','/api/v1/article-layout/visual-cancellations',{topic_id:f.topic.id,job_id:job.job_id});assert.equal(cancelled.state,'cancelled');release();await work;
 assert.equal((await f.status()).latest?.state,'cancelled');assert.equal((await f.load()).snapshot.checks.length,0);assert.equal(f.context.db.prepare("SELECT count(*) n FROM result_receipts WHERE job_id=? AND state='committed'").get(job.job_id)!.n,0);assert.equal(f.native.starts,1);assert.equal(f.native.threads,1);
}));

test('MAIN-R5 actual completed handler output arriving after cancellation is quarantined by real ResultCommit',async()=>run('late-receipt-after-cancel',async f=>{
 const job=await f.enqueue(),claim=f.worker.jobs.claim(f.worker.owner);assert.ok(claim);assert.equal(claim.job.id,job.job_id);
 const handler=f.worker.handlers[0]!,typed=await handler.execute({claim,signal:new AbortController().signal,checkpoint:value=>{f.worker.jobs.checkpoint(claim.fence,value);}});
 assert.equal(f.runtime.workflow.journal.read(f.jobRecord(job.job_id).execution_attempt_id!)!.attempt.state,'completed');
 await f.call('POST','/api/v1/article-layout/visual-cancellations',{topic_id:f.topic.id,job_id:job.job_id});
 const current=getJob(f.context.db,f.app.identity.workspace_id,job.job_id),receipt=f.worker.results.submit(f.request(),job.job_id,{attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,expected_version:current.version,input_hash:claim.job.input_hash,typed_output:typed},f.worker.owner);
 assert.equal(receipt.state,'quarantined');assert.ok(receipt.quarantine_reason);assert.equal((await f.status()).latest?.state,'cancelled');assert.equal((await f.load()).snapshot.checks.length,0);
 assert.equal(f.context.db.prepare("SELECT count(*) n FROM result_receipts WHERE job_id=? AND state='committed'").get(job.job_id)!.n,0);assert.equal(f.native.starts,1);assert.equal(f.native.threads,1);
}));

test('MAIN-R5 title changed after pre-consume check but during repository prepare is rejected by final CAS transaction guard',async()=>run('title-at-final-consume-CAS',async f=>{
 const job=await f.enqueue();assert.equal((await f.worker.runOnce())?.state,'committed');const ws=f.app.identity.workspace_id,key='article-layout.v1:'+ws+':'+f.renderRecord(job.render_id).snapshot.article_id;
 // Real SQLite trigger injects a concurrent business edit exactly at prepare. No repository/worker implementation is replaced.
 const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
 f.context.db.exec(`CREATE TRIGGER fixture_title_at_prepare AFTER UPDATE ON application_metadata WHEN NEW.key=${quote(key)} AND json_extract(NEW.value,'$.pending.operation')='syncCheck' BEGIN UPDATE topics SET title='标题在最终CAS前已变化' WHERE id=${quote(f.topic.id)}; END`);
 const response=await f.response('GET',statusPath(f));await response.json();assert.notEqual(response.status,200);assert.equal(f.context.db.prepare('SELECT title FROM topics WHERE id=?').get(f.topic.id)!.title,'标题在最终CAS前已变化');
 assert.equal((await f.load()).snapshot.checks.length,0);assert.equal(f.jobRecord(job.job_id).consumed_receipt_id,null);assert.equal(f.context.db.prepare("SELECT count(*) n FROM result_receipts WHERE job_id=? AND state='committed'").get(job.job_id)!.n,1,'native receipt remains historical evidence');
 f.context.db.exec('DROP TRIGGER fixture_title_at_prepare');assert.equal((await f.status()).latest?.state,'stale');assert.equal(f.native.starts,1);
}));

test('MAIN-R5 beginClose synchronously closes a controlled in-flight renderer before waiting for its HTTP mutation, then drains and refuses later renders',async()=>run('close-in-flight-render-order',async f=>{
 const workflow=f.runtime.workflow,realRenderer=workflow.options.renderer,events:string[]=[];
 let started!:()=>void,rejectRender!: (error:Error)=>void,releaseClose!:()=>void,closeCalls=0;
 const renderStarted=new Promise<void>(done=>{started=done;}),closeGate=new Promise<void>(done=>{releaseClose=done;});
 // Explicit renderer-close ordering seam only in this test. Actual Chrome active-abort behavior has its own renderer.test.ts coverage.
 workflow.options.renderer={render:async()=>{events.push('render-start');started();return new Promise<never>((_resolve,reject)=>{rejectRender=reject;});},close:()=>{closeCalls++;events.push('renderer-close');rejectRender?.(new Error('controlled renderer shutdown'));return closeGate;}};
 let inFlight:Promise<Response>|undefined;
 try{
  const version=(await f.load()).snapshot.version;
  inFlight=f.response('POST','/api/v1/article-layout/visual-renders',{topic_id:f.topic.id,expected_version:version});await renderStarted;
  workflow.beginClose();assert.deepEqual(events,['render-start','renderer-close'],'renderer.close must run synchronously before waiting for render mutation');
  let closeSettled=false;const closing=workflow.close().then(()=>{closeSettled=true;});
  const response=await inFlight;await response.json();assert.notEqual(response.status,200);await Promise.resolve();assert.equal(closeSettled,false,'close waits the renderer close promise as well as failed mutation');
  releaseClose();await closing;assert.equal(closeCalls,1);workflow.beginClose();await workflow.close();assert.equal(closeCalls,1,'renderer close is memoized across lifecycle calls');
  await assert.rejects(workflow.render(f.request(),{topic_id:f.topic.id,expected_version:version}),/服务正在关闭/);
  const later=await f.response('POST','/api/v1/article-layout/visual-renders',{topic_id:f.topic.id,expected_version:version});await later.json();assert.notEqual(later.status,200);assert.equal(f.native.starts,0);assert.equal(f.native.threads,0);
 }finally{if(!closeCalls){const cleanup=workflow.options.renderer.close();releaseClose();await cleanup;}else releaseClose();await inFlight?.then(response=>response.arrayBuffer()).catch(()=>undefined);await realRenderer.close();workflow.options.renderer=realRenderer;}
}));

process.on('beforeExit',()=>{if(fixtureTests.length)writeFileSync(join(import.meta.dirname,'../../../runtime/main-r5-workflow/latest-result.json'),JSON.stringify({task:'MAIN-INTEGRATION-R5/r1',passed:fixtureTests.every(t=>t.passed),tests:fixtureTests,scope:'real Application/HTTP/SQLite/import/ImagePlanFinal/390renderer/worker/ResultCommit/journal/C1; pre-existing plan seed + native protocol are synthetic',model_calls:0,os_ime:'not_run',independent_qa:'not_run'},null,2));});
