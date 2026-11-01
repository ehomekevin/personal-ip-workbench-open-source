/** MAIN-INTEGRATION-R5/r5 internal developer tests. All native reads/events are explicit synthetic fixtures; real model/API/query/image calls = 0. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createArticleLayout,digest} from '../../../packages/domain/src/article-layout/index.ts';
import {createLayoutCheckTerminalEvidence,assertLayoutCheckTerminalEvidence,assertLayoutCheckExecutionProof} from '../../../packages/adapters/src/media/layout-check/proof.ts';
import {layoutCheckNativeInputs} from '../../../packages/adapters/src/media/layout-check/input.ts';
import type {LayoutCheckExecution} from '../../../packages/adapters/src/media/layout-check/types.ts';
import {SqliteLayoutCheckAdmissionV2,SqliteLayoutCheckJournalV2,type LayoutCheckAuthorityV2} from '../../../packages/storage/src/article-layout/check-admission.ts';
import {SqliteLayoutCheckJournal} from '../../../packages/storage/src/article-layout/check-journal.ts';
import {getJob,getAttempt} from '../../../packages/storage/src/jobs/index.ts';
import {fixtureLayoutExecution,completeFixtureLayoutExecution} from '../model/check-fixture.ts';
import {workflowFixture} from './workflow-fixture.ts';

function fixture(t:{after(fn:()=>void):void}){
 const base=resolve(import.meta.dirname,'../../../runtime/main-layout-r5-isolated/r5');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'native-terminal-')),path=join(root,'metadata.sqlite');let db=new DatabaseSync(path);db.exec('CREATE TABLE application_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 const authority:LayoutCheckAuthorityV2={schema_version:'article-layout-authority.v2',authority_id:'synthetic-terminal-authority',workspace_id:'synthetic-terminal-workspace',candidate_sha256:digest('synthetic-r5-terminal-candidate'),goal_id:'synthetic-terminal-goal',parent_sha256:null,scope:'fixture'};
 return{root,authority,get db(){return db;},get journal(){return new SqliteLayoutCheckJournalV2(db,authority.workspace_id);},get permit(){return new SqliteLayoutCheckAdmissionV2(db,authority);},reopen(){db.close();db=new DatabaseSync(path);}};
}
function intent(f:ReturnType<typeof fixture>,suffix:string):LayoutCheckExecution{
 const snapshot=createArticleLayout({article_id:'synthetic-terminal-article',document_id:'synthetic-document',document_revision_id:'synthetic-revision',text:'明确标注的合成终态证据测试。'});
 const x=fixtureLayoutExecution(snapshot,f.root,'synthetic-job-'+suffix,'synthetic-attempt-'+suffix);x.candidate_sha256=f.authority.candidate_sha256;return x;
}
async function submitted(f:ReturnType<typeof fixture>,suffix:string,state:'running'|'unknown'='unknown'){
 const x=intent(f,suffix),permit=f.permit,journal=f.journal;permit.enroll({intent_id:x.attempt.id,job_id:x.attempt.job_id,attempt_id:x.attempt.attempt_id,manifest_sha256:x.attempt.input_manifest_sha256,context_sha256:digest('same-current-synthetic-view')});assert.equal(journal.reservePrepared(x),true);assert.equal(await permit.reserve_submission(x.attempt.job_id,x.attempt.attempt_id,x.attempt.input_manifest_sha256),true);
 x.submit_count=1;x.attempt.state=state;x.attempt.native={provider:'fixture',thread_id:'synthetic-thread-'+suffix,turn_id:'synthetic-turn-'+suffix};x.proof.thread_start={thread_id:x.attempt.native.thread_id!,model:'gpt-6.1-sol',model_provider:'openai',cwd:f.root};await journal.save(x);if(state==='unknown')permit.settle(x.attempt.job_id,'unknown');return x;
}
function raw(x:LayoutCheckExecution,status:'failed'|'interrupted'='interrupted'){
 return{transport_metadata:{synthetic:true,opaque_extra:'retain full read'},thread:{id:x.attempt.native.thread_id,modelProvider:'openai',model:'gpt-6.1-sol' as string|null,cwd:x.proof.thread_start!.cwd,turns:[{id:x.attempt.native.turn_id,status:status as string,itemsView:'full' as string,error:{message:'synthetic native unsuccessful terminal'},items:[{type:'userMessage',content:layoutCheckNativeInputs(x.input_manifest)},{type:'reasoning',synthetic_marker:'synthetic opaque item retained without interpretation'}] as Array<Record<string,unknown>>}]}};
}
function unsuccessful(x:LayoutCheckExecution,read:unknown,cwd:string):LayoutCheckExecution{
 const next=structuredClone(x);next.proof.terminal_read=createLayoutCheckTerminalEvidence(next,read,cwd);next.proof.original_input_verified=true;next.attempt.state='failed';next.attempt.result=null;next.attempt.error='synthetic verified original terminal';return next;
}
const invalid=/LAYOUT_CHECK_(?:TERMINAL|INPUT|OUTPUT)_PROOF_INVALID/;

test('r5 fixture full failed/interrupted read is retained verbatim and unknown→failed settles once across SQLite restart',async t=>{
 const f=fixture(t);
 for(const status of ['failed','interrupted'] as const){const x=await submitted(f,status),read=raw(x,status),before=structuredClone(x),terminal=unsuccessful(x,read,f.root);assert.deepEqual(x,before,'creating terminal evidence never edits original execution');assert.deepEqual(terminal.proof.terminal_read!.raw_read,read);assert.equal(terminal.proof.terminal_read!.raw_read_sha256,digest(read));read.transport_metadata.opaque_extra='mutated caller';assert.notEqual(terminal.proof.terminal_read!.raw_read.transport_metadata,read.transport_metadata,'evidence owns a full clone');
  assertLayoutCheckTerminalEvidence(terminal);await f.journal.save(terminal);f.permit.settle(x.attempt.job_id,'failed');assert.equal(f.permit.reservation(x.attempt.job_id)!.state,'failed');await f.journal.save(terminal);f.permit.settle(x.attempt.job_id,'failed');assert.equal(await f.permit.reserve_submission(x.attempt.job_id,x.attempt.attempt_id,x.attempt.input_manifest_sha256),false);f.reopen();assert.deepEqual(f.journal.read(x.attempt.attempt_id),terminal);assert.equal(terminal.submit_count,1);assert.equal(terminal.attempt.result,null);assert.equal(terminal.proof.output_sha256,null);
 }
});

test('r5 full terminal read refuses wrong native IDs/provider/model/cwd, duplicate turns, incomplete or changed original user/image inputs',async t=>{
 const f=fixture(t),x=await submitted(f,'identity');
 const mutations:Array<(read:ReturnType<typeof raw>)=>void>=[r=>{r.thread.id='different-thread';},r=>{r.thread.turns[0]!.id='different-turn';},r=>{r.thread.modelProvider='other-provider';},r=>{r.thread.model='other-model';},r=>{r.thread.cwd=join(f.root,'different-cwd');},r=>{r.thread.turns.push(structuredClone(r.thread.turns[0]!));},r=>{r.thread.turns[0]!.status='inProgress';},r=>{r.thread.turns[0]!.status='completed';},r=>{r.thread.turns[0]!.itemsView='partial';},r=>{r.thread.turns[0]!.items=[];},r=>{const a=r.thread.turns[0]!.items;a.push(structuredClone(a[0]!));},r=>{(r.thread.turns[0]!.items[0] as {content:unknown[]}).content.pop();},r=>{(r.thread.turns[0]!.items[0] as {content:Array<Record<string,unknown>>}).content[1]!.path='/synthetic/different-image.png';}];
 for(const mutate of mutations){const read=raw(x);mutate(read);assert.throws(()=>createLayoutCheckTerminalEvidence(x,read,f.root),invalid);}
 const missingView=raw(x);delete (missingView.thread.turns[0] as Partial<ReturnType<typeof raw>['thread']['turns'][number]>).itemsView;assert.throws(()=>createLayoutCheckTerminalEvidence(x,missingView,f.root),invalid);const nonStringStatus=raw(x);(nonStringStatus.thread.turns[0] as unknown as Record<string,unknown>).status=['interrupted'];assert.throws(()=>createLayoutCheckTerminalEvidence(x,nonStringStatus,f.root),invalid);
 for(const mutate of [(v:LayoutCheckExecution)=>{v.submit_count=0;},(v:LayoutCheckExecution)=>{v.attempt.native.turn_id=null;},(v:LayoutCheckExecution)=>{v.attempt.state='cancelled';},(v:LayoutCheckExecution)=>{v.proof.source='codex_app_server';}]){const bad=structuredClone(x);mutate(bad);assert.throws(()=>createLayoutCheckTerminalEvidence(bad,raw(x),f.root),invalid);}
 assert.throws(()=>createLayoutCheckTerminalEvidence(x,raw(x),f.root+'/.'),invalid);const otherCwd=raw(x),noStart=structuredClone(x);delete noStart.proof.thread_start;otherCwd.thread.cwd=join(f.root,'another-root');assert.throws(()=>createLayoutCheckTerminalEvidence(noStart,otherCwd,otherCwd.thread.cwd),invalid);const nonJson=raw(x) as unknown as Record<string,unknown>;nonJson.self=nonJson;assert.throws(()=>createLayoutCheckTerminalEvidence(x,nonJson,f.root),invalid);
});

test('r5 model=null uses only the preserved matching thread/start; omitted model or mismatched start cannot be substituted',async t=>{
 const f=fixture(t),x=await submitted(f,'null-model'),read=raw(x);read.thread.model=null;assertLayoutCheckTerminalEvidence(unsuccessful(x,read,f.root));
 const noStart=structuredClone(x);delete noStart.proof.thread_start;assert.throws(()=>createLayoutCheckTerminalEvidence(noStart,read,f.root),invalid);assert.doesNotThrow(()=>createLayoutCheckTerminalEvidence(noStart,raw(x),f.root),'nonnull native model can verify old envelopes without thread_start');
 for(const field of ['cwd','thread_id','model','model_provider'] as const){const bad=structuredClone(x);bad.proof.thread_start![field]='different';assert.throws(()=>createLayoutCheckTerminalEvidence(bad,read,f.root),invalid);}
 const missing=raw(x) as unknown as {thread:Record<string,unknown>};delete missing.thread.model;assert.throws(()=>createLayoutCheckTerminalEvidence(x,missing,f.root),invalid);
});

test('r5 submitted failure without full proof stays unknown; legacy marker/original_input_verified booleans cannot authorize settle',async t=>{
 const f=fixture(t),x=await submitted(f,'missing-evidence'),before=f.db.prepare('SELECT key,value FROM application_metadata ORDER BY key').all();
 for(const marker of [undefined,{status:'interrupted'},'interrupted']){const bad=structuredClone(x);bad.attempt.state='failed';bad.proof.original_input_verified=true;(bad.proof as unknown as Record<string,unknown>).terminal_read=marker;await assert.rejects(()=>f.journal.save(bad),invalid);}
 assert.deepEqual(f.db.prepare('SELECT key,value FROM application_metadata ORDER BY key').all(),before);assert.throws(()=>f.permit.settle(x.attempt.job_id,'failed'),/EXECUTION_FENCE/);assert.equal(f.journal.read(x.attempt.attempt_id)!.attempt.state,'unknown');
 const terminal=unsuccessful(x,raw(x),f.root);terminal.proof.original_input_verified=false;await assert.rejects(()=>f.journal.save(terminal),invalid);assert.equal(await f.permit.reserve_submission(x.attempt.job_id,x.attempt.attempt_id,x.attempt.input_manifest_sha256),false);
 const historical=await submitted(f,'historical-failed-no-field');historical.attempt.state='failed';for(const [kind,id] of [['attempt',historical.attempt.attempt_id],['job',historical.attempt.job_id],['id',historical.attempt.id]])f.db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(historical),'article-layout-check.v2:'+f.authority.workspace_id+':'+kind+':'+id);assert.deepEqual(f.journal.read(historical.attempt.attempt_id),historical,'old optional-field records stay readable without upgrading their evidence');assertLayoutCheckExecutionProof(historical);await assert.rejects(()=>f.journal.save(historical),invalid);assert.throws(()=>f.permit.settle(historical.attempt.job_id,'failed'),invalid);
});

test('r5 evidence binds candidate/raw hash/full frozen input and cannot create an output receipt or bypass fixture authority',async t=>{
 const f=fixture(t),x=await submitted(f,'frozen'),done=unsuccessful(x,raw(x),f.root);
 const mutations:Array<(v:LayoutCheckExecution)=>void>=[v=>{v.proof.terminal_read!.candidate_sha256=digest('different');},v=>{v.proof.terminal_read!.raw_read_sha256=digest('different');},v=>{v.proof.terminal_read!.native_input_sha256=digest('different');},v=>{v.proof.terminal_read!.input_manifest_sha256=digest('different');},v=>{v.proof.terminal_read!.thread_id='different';},v=>{v.proof.terminal_read!.status='failed';},v=>{v.proof.output_sha256=digest('fabricated-result');}];
 for(const mutate of mutations){const bad=structuredClone(done);mutate(bad);await assert.rejects(()=>f.journal.save(bad),invalid);}
 const changedCandidate=structuredClone(done);changedCandidate.candidate_sha256=digest('different');changedCandidate.proof.terminal_read!.candidate_sha256=changedCandidate.candidate_sha256;await assert.rejects(()=>f.journal.save(changedCandidate),/ADMISSION_FENCE/);
 const changedManifest=structuredClone(done);changedManifest.input_manifest.blocks[0]!.text='changed';await assert.rejects(()=>f.journal.save(changedManifest),invalid);
 const wrongScope=structuredClone(done);wrongScope.fixture=false;wrongScope.attempt.native.provider='codex';wrongScope.proof.source='codex_app_server';wrongScope.proof.billing_route='chatgpt_subscription';await assert.rejects(()=>f.journal.save(wrongScope),/ADMISSION_FENCE/);
 const png=x.input_manifest.render_pngs[0]!.path,bytes=readFileSync(png);writeFileSync(png,Buffer.concat([bytes,Buffer.from('changed')]));try{assert.throws(()=>assertLayoutCheckTerminalEvidence(done),invalid);}finally{writeFileSync(png,bytes);}
});

test('r5 completed/cancelled and unsuccessful terminals remain immutable; pre-submit failure still needs no invented native read',async t=>{
 const f=fixture(t);
 for(const end of ['completed','cancelled','failed'] as const){const x=await submitted(f,'immutable-'+end),terminal=unsuccessful(x,raw(x),f.root);let saved:LayoutCheckExecution;if(end==='completed'){saved=completeFixtureLayoutExecution(x);saved.attempt.native=x.attempt.native;}else if(end==='failed')saved=terminal;else{saved=structuredClone(x);saved.attempt.state='cancelled';}await f.journal.save(saved);f.permit.settle(x.attempt.job_id,end);const changed=structuredClone(terminal);changed.attempt.error='late rewrite';await assert.rejects(()=>f.journal.save(changed),/TERMINAL_IMMUTABLE/);assert.deepEqual(f.journal.read(x.attempt.attempt_id),saved);}
 const x=intent(f,'pre-submit'),p=f.permit;p.enroll({intent_id:x.attempt.id,job_id:x.attempt.job_id,attempt_id:x.attempt.attempt_id,manifest_sha256:x.attempt.input_manifest_sha256,context_sha256:digest('same-current-synthetic-view')});assert.equal(f.journal.reservePrepared(x),true);x.attempt.state='failed';await f.journal.save(x);p.settle(x.attempt.job_id,'failed');assert.equal(x.submit_count,0);assert.equal(x.proof.terminal_read,undefined);
});

test('r5 known unsuccessful intents retain dedup/no-resubmit and permit third/fourth new purposes with same view',async t=>{
 const f=fixture(t);for(const suffix of ['first','second','third','fourth']){const x=await submitted(f,suffix);await f.journal.save(unsuccessful(x,raw(x),f.root));f.permit.settle(x.attempt.job_id,'failed');assert.equal(await f.permit.reserve_submission(x.attempt.job_id,x.attempt.attempt_id,x.attempt.input_manifest_sha256),false);assert.throws(()=>f.permit.enroll({intent_id:x.attempt.id,job_id:x.attempt.job_id,attempt_id:x.attempt.attempt_id,manifest_sha256:x.attempt.input_manifest_sha256,context_sha256:digest('same-current-synthetic-view')}),/DUPLICATE/);}
});

test('r5 original v1 execution proof stays query-readable without v1 row rewrites and v2 refuses crossing its identities',async t=>{
 const f=fixture(t),v1=new SqliteLayoutCheckJournal(f.db,f.authority.workspace_id),x=intent(f,'v1');x.candidate_sha256=null;assert.equal(await v1.reserve(x),true);x.submit_count=1;x.attempt.state='unknown';x.attempt.native={provider:'fixture',thread_id:'synthetic-v1-thread',turn_id:'synthetic-v1-turn'};x.proof.thread_start={thread_id:'synthetic-v1-thread',model:'gpt-6.1-sol',model_provider:'openai',cwd:f.root};await v1.save(x);const done=unsuccessful(x,raw(x),f.root);await v1.save(done);const before=f.db.prepare("SELECT key,value FROM application_metadata WHERE key LIKE 'article-layout-check.v1:%' ORDER BY key").all();assert.deepEqual(f.journal.read(x.attempt.attempt_id),done);assert.throws(()=>f.permit.enroll({intent_id:x.attempt.id,job_id:x.attempt.job_id,attempt_id:x.attempt.attempt_id,manifest_sha256:x.attempt.input_manifest_sha256,context_sha256:digest('same-current-synthetic-view')}),/DUPLICATE/);assert.deepEqual(f.db.prepare("SELECT key,value FROM application_metadata WHERE key LIKE 'article-layout-check.v1:%' ORDER BY key").all(),before);assertLayoutCheckExecutionProof(done);
});

for(const nativeStatus of ['interrupted','failed'] as const)test('r5 actual HTTP/worker fixture unknown→'+nativeStatus+' terminal fails original job with no receipt and admits a fresh explicit intent',async()=>{
 const f=await workflowFixture('reply-lost');try{
  const queued=await f.enqueue();assert.equal((await f.worker.runOnce())?.state,'reconciling');const record=f.jobRecord(queued.job_id),original=record.execution_attempt_id!,before=f.runtime.workflow.journal.read(original)!;assert.equal(before.attempt.state,'unknown');assert.equal((await f.status()).latest?.can_query,true);const request=f.native.request.bind(f.native);
  f.native.request=async(method,params)=>{const value=await request(method,params);if(method==='thread/read'){const read=value as ReturnType<typeof raw>;read.thread.cwd=before.input_manifest.work_directory;read.thread.model=null;for(const turn of read.thread.turns){turn.status=nativeStatus;turn.itemsView='full';turn.items=turn.items.filter(item=>item.type!=='agentMessage');}}return value;};
  await f.call('POST','/api/v1/article-layout/visual-queries',{topic_id:f.topic.id,job_id:queued.job_id});assert.equal((await f.worker.runOnce())?.state,'failed');const job=getJob(f.context.db,f.app.identity.workspace_id,queued.job_id),execution=f.runtime.workflow.journal.read(original)!;assert.equal(job.state,'failed','shared worker failure handling cannot restore reconciling after known terminal');assert.equal(job.current_attempt_id,null,'terminal Jobs.fail clears the active claim');const sqlAttempts=f.context.db.prepare('SELECT id FROM job_attempts WHERE job_id=? ORDER BY attempt_generation').all(queued.job_id);assert.equal(sqlAttempts.length,2);const recoveredSqlId=String(sqlAttempts.at(-1)!.id);assert.notEqual(recoveredSqlId,original);assert.equal(getAttempt(f.context.db,f.app.identity.workspace_id,recoveredSqlId).state,'failed');assert.equal(execution.attempt.state,'failed');assert.equal(execution.attempt.native.thread_id,before.attempt.native.thread_id);assert.equal(execution.attempt.native.turn_id,before.attempt.native.turn_id);assert.equal(execution.proof.terminal_read!.status,nativeStatus);assertLayoutCheckTerminalEvidence(execution);assert.equal(f.runtime.workflow.admission!.reservation(queued.job_id)!.state,'failed');
  assert.equal(f.context.db.prepare('SELECT count(*) n FROM result_receipts WHERE job_id=?').get(queued.job_id)!.n,0);assert.equal((await f.load()).snapshot.checks.length,0);const status=await f.status();assert.equal(status.latest?.state,'failed');assert.equal(status.latest?.can_query,false);assert.match(status.latest?.error??'',/interrupted|failed|原生|未成功/);assert.equal(await f.worker.runOnce(),null);assert.equal(getJob(f.context.db,f.app.identity.workspace_id,queued.job_id).state,'failed');
  const next=await f.enqueue();assert.equal(next.state,'queued');assert.notEqual(next.job_id,queued.job_id);assert.equal(f.native.starts,1);assert.equal(f.native.threads,1);assert.equal(f.native.reads,1);writeFileSync(join(f.directory,'terminal-r5-result.json'),JSON.stringify({synthetic_native:true,native_status:nativeStatus,original_execution:original,SQL_current_attempt:job.current_attempt_id,recovered_SQL_attempt:recoveredSqlId,job_state:job.state,proof_status:execution.proof.terminal_read!.status,receipt_count:0,checks:0,new_job:next.job_id,real_model_calls:0},null,2));
 }catch(error){writeFileSync(join(f.directory,'terminal-r5-first-failure.json'),JSON.stringify({error:String(error),stack:error instanceof Error?error.stack:null},null,2));throw error;}finally{await f.close();}
});
