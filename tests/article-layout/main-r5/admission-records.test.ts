/** MAIN-INTEGRATION-R5/r1 developer checks. Synthetic confirmations/native protocol only; real provider calls = 0. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Worker,isMainThread,workerData,parentPort} from 'node:worker_threads';
import {SqliteLayoutCheckAdmissionV2,SqliteLayoutCheckJournalV2,readLayoutCheckAdmissionReservationV2,type LayoutCheckAuthorityV2} from '../../../packages/storage/src/article-layout/check-admission.ts';
import {SqliteLayoutCheckJournal,SqliteLayoutCheckBudget} from '../../../packages/storage/src/article-layout/check-journal.ts';
import {writeConfirmedArticleLayoutWiki,type ArticleLayoutOnlyArchiveOptions,type ArticleLayoutRecordGrant} from '../../../packages/storage/src/article-layout/records.ts';
import {createArticleLayout,editArticleText,confirmArticleLayout,updateArticleStyle,digest,sha256,LAYOUT_RULES_VERSION} from '../../../packages/domain/src/article-layout/index.ts';
import {fixtureLayoutExecution,completeFixtureLayoutExecution} from '../model/check-fixture.ts';
import {CodexLayoutCheckAdapter} from '../../../packages/adapters/src/media/layout-check/check.ts';
import {QAOnlyNative} from '../visual/repair-fixture.ts';
import type {LayoutCheckExecution,LayoutCheckJournal} from '../../../packages/adapters/src/media/layout-check/types.ts';
import type {ArticleLayoutSnapshot,ArticleLayoutSourceBinding} from '../../../packages/contracts/src/article-layout.ts';

// Two real connections in separate threads race the same SQLite identities, behind a start barrier.
if(!isMainThread){
 const db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=5000');
 const gate=new Int32Array(workerData.gate);parentPort!.postMessage({ready:true});Atomics.wait(gate,0,0);
 try{
  const permit=new SqliteLayoutCheckAdmissionV2(db,workerData.authority);
  const value=workerData.kind==='journal'?await new SqliteLayoutCheckJournalV2(db,workerData.authority.workspace_id).reserve(workerData.execution):await permit.reserve_submission(workerData.execution.attempt.job_id,workerData.execution.attempt.attempt_id,workerData.execution.attempt.input_manifest_sha256);
  parentPort!.postMessage({value});
 }catch(error){parentPort!.postMessage({error:String(error)});}finally{db.close();}
 process.exit(0);
}
function fixture(t:{after(fn:()=>void):void}){
 const root=mkdtempSync(join(import.meta.dirname,'.admission-fixture-')),path=join(root,'metadata.sqlite');let db=new DatabaseSync(path);
 db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE application_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 const authority:LayoutCheckAuthorityV2={schema_version:'article-layout-authority.v2',authority_id:'synthetic-authority-1',workspace_id:'fixture-workspace',candidate_sha256:sha256('r5 developer candidate'),goal_id:'synthetic-layout-goal',parent_sha256:null,scope:'fixture'};
 return{root,path,authority,get db(){return db;},reopen(){db.close();db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=5000');}};
}
function execution(root:string,suffix:string):LayoutCheckExecution{
 const snapshot=createArticleLayout({article_id:'fixture-article',document_id:'fixture-document',document_revision_id:'fixture-revision',text:'原始人工稿。'});
 const value=fixtureLayoutExecution(snapshot,root,'job-'+suffix,'attempt-'+suffix);value.candidate_sha256=sha256('r5 developer candidate');return value;
}
function enroll(permit:SqliteLayoutCheckAdmissionV2,value:LayoutCheckExecution){permit.enroll({intent_id:value.attempt.id,job_id:value.attempt.job_id,attempt_id:value.attempt.attempt_id,manifest_sha256:value.attempt.input_manifest_sha256,context_sha256:sha256('same legitimate current view')});}
async function reserve(permit:SqliteLayoutCheckAdmissionV2,journal:SqliteLayoutCheckJournalV2,value:LayoutCheckExecution){enroll(permit,value);assert.equal(await journal.reserve(value),true);assert.equal(await permit.reserve_submission(value.attempt.job_id,value.attempt.attempt_id,value.attempt.input_manifest_sha256),true);}
async function race(path:string,authority:LayoutCheckAuthorityV2,value:LayoutCheckExecution,kind:'journal'|'submission'){
 const gate=new SharedArrayBuffer(4),workers=[0,1].map(()=>new Worker(new URL(import.meta.url),{workerData:{path,authority,execution:value,kind,gate}}));
 const ready=workers.map(worker=>new Promise<void>((resolve,reject)=>{worker.once('message',()=>resolve());worker.once('error',reject);}));
 const results=workers.map(worker=>new Promise<{value?:boolean;error?:string}>((resolve,reject)=>{worker.on('message',message=>{if(!message.ready)resolve(message);});worker.once('error',reject);}));
 const exits=workers.map(worker=>new Promise<void>((resolve,reject)=>{worker.once('exit',code=>code===0?resolve():reject(new Error('race worker exit '+code)));}));
 await Promise.all(ready);Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);
 const values=await Promise.all(results);await Promise.all(exits);return values;
}
test('v2 binds the untouched exhausted v1 ledger and admits third/fourth new intents without a cumulative cap',async t=>{
 const f=fixture(t),legacy=new SqliteLayoutCheckBudget(f.db,{workspace_id:f.authority.workspace_id,permit_id:'legacy-only',candidate_sha256:sha256('legacy-candidate'),authorized_job_ids:['old-1','old-2']});
 assert.equal(await legacy.reserve_submission('old-1','old-a1',sha256('old manifest1')),true);assert.equal(await legacy.reserve_submission('old-2','old-a2',sha256('old manifest2')),true);
 const before=f.db.prepare('SELECT key,value FROM application_metadata ORDER BY key').all();
 const permit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),journal=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id);
 const record=JSON.parse(String(f.db.prepare('SELECT value FROM application_metadata WHERE key=?').get('article-layout-check-admission.v2:'+f.authority.workspace_id+':authority-hash:'+permit.authority_sha256)!.value));
 assert.equal(record.legacy_v1_sha256,digest(before));
 for(const suffix of ['third','fourth','fifth']){const value=execution(f.root,suffix);await reserve(permit,journal,value);await journal.save(completeFixtureLayoutExecution(value));permit.settle(value.attempt.job_id,'completed');assert.equal(permit.reservation(value.attempt.job_id)?.state,'completed');}
 assert.deepEqual(f.db.prepare("SELECT key,value FROM application_metadata WHERE key LIKE 'article-layout-check-budget.v1:%' ORDER BY key").all(),before);
 f.reopen();const restored=new SqliteLayoutCheckAdmissionV2(f.db,f.authority);assert.equal(restored.reservation('job-fourth')?.state,'completed');assert.equal(await restored.reserve_submission('job-fourth','attempt-fourth',execution(f.root,'fourth').attempt.input_manifest_sha256),false);
});
test('authority parent link is immutable, candidate-bound, same scope/goal, and cannot reset a used root',async t=>{
 const f=fixture(t),first=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),value=execution(f.root,'old-authority');await reserve(first,new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id),value);
 const successor={...f.authority,authority_id:'successor',candidate_sha256:sha256('next candidate'),parent_sha256:first.authority_sha256};
 assert.throws(()=>new SqliteLayoutCheckAdmissionV2(f.db,{...successor,parent_sha256:null}),/PARENT_FENCE/);
 assert.throws(()=>new SqliteLayoutCheckAdmissionV2(f.db,{...successor,scope:'production'}),/PARENT_FENCE/);
 assert.throws(()=>new SqliteLayoutCheckAdmissionV2(f.db,{...successor,goal_id:'unrelated'}),/PARENT_FENCE/);
 assert.throws(()=>new SqliteLayoutCheckAdmissionV2(f.db,{...f.authority,candidate_sha256:sha256('replace')}),/REBIND/);
 new SqliteLayoutCheckAdmissionV2(f.db,successor);
 assert.throws(()=>enroll(first,execution(f.root,'late')),/SUPERSEDED/);assert.equal(first.authorize_job(value.attempt.job_id),true);
 assert.equal(await first.reserve_submission(value.attempt.job_id,value.attempt.attempt_id,value.attempt.input_manifest_sha256),false);
});
test('enrollment refuses reused intent/job/attempt and either v1 journal or budget identity, before native acquisition',async t=>{
 const f=fixture(t),old=execution(f.root,'legacy');old.candidate_sha256=null;const v1=new SqliteLayoutCheckJournal(f.db,f.authority.workspace_id);await v1.reserve(old);
 const legacyBefore=f.db.prepare("SELECT key,value FROM application_metadata WHERE key LIKE 'article-layout-check.v1:%' ORDER BY key").all(),permit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority);
 assert.throws(()=>enroll(permit,old),/DUPLICATE/);const current=execution(f.root,'enrolled');enroll(permit,current);
 for(const field of ['id','job_id','attempt_id'] as const){const duplicate=execution(f.root,'different-'+field);duplicate.attempt[field]=current.attempt[field];assert.throws(()=>enroll(permit,duplicate),/DUPLICATE/);}
 assert.equal(permit.authorize_job('unregistered'),false);
 const journal=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id);assert.deepEqual(journal.read(old.attempt.attempt_id),old);
 await assert.rejects(()=>journal.save(old),/ADMISSION_FENCE/);
 assert.deepEqual(f.db.prepare("SELECT key,value FROM application_metadata WHERE key LIKE 'article-layout-check.v1:%' ORDER BY key").all(),legacyBefore);
});
test('two independent SQLite workers admit exactly one journal reservation and exactly one native submission',async t=>{
 const f=fixture(t),permit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),value=execution(f.root,'race');enroll(permit,value);
 assert.deepEqual((await race(f.path,f.authority,value,'journal')).map(x=>{assert.equal(x.error,undefined);return x.value;}).sort(),[false,true]);
 assert.deepEqual((await race(f.path,f.authority,value,'submission')).map(x=>{assert.equal(x.error,undefined);return x.value;}).sort(),[false,true]);
 assert.equal(permit.reservation(value.attempt.job_id)?.state,'reserved');
});
test('journal v2 binds candidate/manifest/intent and preserves original unknown IDs through restart and query completion',async t=>{
 const f=fixture(t),permit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),journal=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id),value=execution(f.root,'unknown');
 enroll(permit,value);for(const field of ['id','job_id','attempt_id'] as const){const wrong=structuredClone(value);wrong.attempt[field]+='-forged';await assert.rejects(()=>journal.reserve(wrong),/ADMISSION_FENCE/);}
 const wrong=structuredClone(value);wrong.candidate_sha256=sha256('different candidate');await assert.rejects(()=>journal.reserve(wrong),/ADMISSION_FENCE/);
 assert.equal(await journal.reserve(value),true);assert.equal(await permit.reserve_submission(value.attempt.job_id,'wrong-attempt',value.attempt.input_manifest_sha256),false);
 assert.equal(await permit.reserve_submission(value.attempt.job_id,value.attempt.attempt_id,value.attempt.input_manifest_sha256),true);
 const unknown=structuredClone(value);unknown.submit_count=1;unknown.attempt.state='unknown';unknown.attempt.native.thread_id='known-original-thread';unknown.attempt.native.turn_id='known-original-turn';unknown.attempt.error='synthetic RPC reply lost';await journal.save(unknown);permit.settle(value.attempt.job_id,'unknown');
 assert.equal(await permit.reserve_submission(value.attempt.job_id,value.attempt.attempt_id,value.attempt.input_manifest_sha256),false);
 const reset=structuredClone(unknown);reset.attempt.state='running';await assert.rejects(()=>journal.save(reset),/NO_RESUBMIT/);
 const replace=structuredClone(unknown);replace.attempt.native.turn_id='replacement';await assert.rejects(()=>journal.save(replace),/NATIVE_FENCE/);
 f.reopen();const restored=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id);assert.deepEqual(restored.read(value.attempt.attempt_id),unknown);
 const complete=completeFixtureLayoutExecution(unknown);complete.attempt.native=unknown.attempt.native;await restored.save(complete);
 new SqliteLayoutCheckAdmissionV2(f.db,f.authority).settle(value.attempt.job_id,'completed');
 const changed=structuredClone(complete);changed.attempt.error='rewrite terminal';await assert.rejects(()=>restored.save(changed),/TERMINAL_IMMUTABLE/);
 const index='article-layout-check.v2:'+f.authority.workspace_id+':job:'+value.attempt.job_id;f.db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(unknown),index);assert.throws(()=>restored.read(value.attempt.attempt_id),/INDEX_FENCE/);
});
test('v2 detects a later conflicting v1 writer without deleting or repairing either ledger',async t=>{
 const f=fixture(t),permit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),journal=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id),value=execution(f.root,'later-conflict');await reserve(permit,journal,value);
 const legacy=structuredClone(value);legacy.candidate_sha256=null;await new SqliteLayoutCheckJournal(f.db,f.authority.workspace_id).reserve(legacy);
 assert.equal(permit.authorize_job(value.attempt.job_id),false);assert.throws(()=>journal.read(value.attempt.attempt_id),/CROSS_VERSION_DUPLICATE/);
 assert.equal(Number(f.db.prepare("SELECT COUNT(*) AS n FROM application_metadata WHERE key LIKE 'article-layout-check.v1:%'").get()!.n),3);
});
function adapter(f:ReturnType<typeof fixture>,journal:LayoutCheckJournal,native:QAOnlyNative,permit?:SqliteLayoutCheckAdmissionV2,is_current?:()=>boolean){return new CodexLayoutCheckAdapter({workspace_id:f.authority.workspace_id,cwd:f.root,lock_root:f.root,schema_directory:f.root,journal,fixture:true,native_factory:()=>native,permit,is_current,timeout_ms:20});}
test('fixture v2 adapter exercises admission and full unchanged proof; missing grant/current/abort stop before native',async t=>{
 const f=fixture(t),permit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),journal=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id),value=execution(f.root,'adapter'),native=new QAOnlyNative();enroll(permit,value);
 const observed=await adapter(f,journal,native,permit).execute(value.input_manifest,{id:value.attempt.id,job_id:value.attempt.job_id,attempt_id:value.attempt.attempt_id},new AbortController().signal);
 assert.equal(observed.execution.attempt.state,'completed');assert.equal(observed.execution.schema_version,'article-layout-check-execution.v1');assert.equal(observed.execution.candidate_sha256,f.authority.candidate_sha256);assert.equal(native.starts,1);assert.equal(native.closes,1);assert.equal(journal.read(value.attempt.attempt_id)?.proof.original_input_verified,true);
 const missing=execution(f.root,'no-grant'),denied=new QAOnlyNative();await assert.rejects(()=>adapter(f,journal,denied,permit).execute(missing.input_manifest,{id:missing.attempt.id,job_id:missing.attempt.job_id,attempt_id:missing.attempt.attempt_id},new AbortController().signal),/准入/);assert.equal(denied.calls.length,0);
 let acquisitions=0;const options={workspace_id:f.authority.workspace_id,cwd:f.root,lock_root:f.root,schema_directory:f.root,journal,fixture:true,native_factory:()=>{acquisitions++;return denied;},is_current:()=>false};
 await assert.rejects(()=>new CodexLayoutCheckAdapter(options).execute(missing.input_manifest,{id:missing.attempt.id,job_id:missing.attempt.job_id,attempt_id:missing.attempt.attempt_id},new AbortController().signal),/已变化/);assert.equal(acquisitions,0);
 const controller=new AbortController();controller.abort();await assert.rejects(()=>adapter(f,journal,denied,permit).execute(missing.input_manifest,{id:missing.attempt.id,job_id:missing.attempt.job_id,attempt_id:missing.attempt.attempt_id},controller.signal));assert.equal(denied.calls.length,0);
});
test('current fence is rechecked before every native request and stale thread cannot start a turn',async t=>{
 const f=fixture(t),permit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),journal=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id),value=execution(f.root,'stale');enroll(permit,value);
 const native=new QAOnlyNative(),request=native.request.bind(native);let current=true;
 native.request=async(method,params)=>{const result=await request(method,params);if(method==='thread/start')current=false;return result;};
 const result=await adapter(f,journal,native,permit,()=>current).execute(value.input_manifest,{id:value.attempt.id,job_id:value.attempt.job_id,attempt_id:value.attempt.attempt_id},new AbortController().signal);
 assert.equal(result.execution.attempt.state,'failed');assert.equal(result.execution.submit_count,0);assert.equal(native.threads,1);assert.equal(native.starts,0);assert.equal(native.closes,1);
});
test('v2 unknown recovers the original native IDs by query only after database restart',async t=>{
 const f=fixture(t),permit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),journal=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id),value=execution(f.root,'query-only'),native=new QAOnlyNative('reply-lost');enroll(permit,value);
 const observed=await adapter(f,journal,native,permit).execute(value.input_manifest,{id:value.attempt.id,job_id:value.attempt.job_id,attempt_id:value.attempt.attempt_id},new AbortController().signal);assert.equal(observed.execution.attempt.state,'unknown');permit.settle(value.attempt.job_id,'unknown');assert.equal(native.starts,1);
 f.reopen();native.mode='complete';const restoredPermit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),restored=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id);
 const result=await adapter(f,restored,native,restoredPermit).query(value.attempt.attempt_id,new AbortController().signal);assert.equal(result.execution.attempt.state,'completed');assert.deepEqual(result.execution.attempt.native,observed.execution.attempt.native);assert.equal(native.starts,1);assert.equal(native.threads,1);assert.equal(native.reads,1);restoredPermit.settle(value.attempt.job_id,'completed');
 assert.equal(await restoredPermit.reserve_submission(value.attempt.job_id,value.attempt.attempt_id,value.attempt.input_manifest_sha256),false);
});
test('legacy adapter query still reads and saves only its original v1 envelope with no new thread or submission',async t=>{
 const f=fixture(t),journal=new SqliteLayoutCheckJournal(f.db,f.authority.workspace_id),value=execution(f.root,'legacy-query'),native=new QAOnlyNative('reply-lost');
 const oldAdapter=adapter(f,journal,native);const observed=await oldAdapter.execute(value.input_manifest,{id:value.attempt.id,job_id:value.attempt.job_id,attempt_id:value.attempt.attempt_id},new AbortController().signal);assert.equal(observed.execution.attempt.state,'unknown');native.mode='complete';
 const result=await oldAdapter.query(value.attempt.attempt_id,new AbortController().signal);assert.equal(result.execution.attempt.state,'completed');assert.equal(result.execution.candidate_sha256,null);assert.equal(native.starts,1);assert.equal(native.threads,1);
 assert.equal(Number(f.db.prepare("SELECT COUNT(*) AS n FROM application_metadata WHERE key LIKE 'article-layout-check.v2:%'").get()!.n),0);
});
test('reservePrepared is synchronous and enrollment/journal/job handoff share one SQLite commit or rollback',t=>{
 const f=fixture(t),permit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),journal=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id),value=execution(f.root,'atomic-prepared');
 f.db.exec('BEGIN IMMEDIATE');enroll(permit,value);assert.equal(journal.reservePrepared(value),true);
 f.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?)').run('synthetic-job-handoff',JSON.stringify({original_attempt_id:value.attempt.attempt_id}));f.db.exec('ROLLBACK');
 assert.equal(permit.reservation(value.attempt.job_id),null);assert.equal(journal.read(value.attempt.attempt_id),null);assert.equal(f.db.prepare('SELECT key FROM application_metadata WHERE key=?').get('synthetic-job-handoff'),undefined);
 f.db.exec('BEGIN IMMEDIATE');enroll(permit,value);assert.equal(journal.reservePrepared(value),true);f.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?)').run('synthetic-job-handoff',JSON.stringify({original_attempt_id:value.attempt.attempt_id}));f.db.exec('COMMIT');
 f.reopen();assert.deepEqual(new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id).read(value.attempt.attempt_id),value);assert.equal(JSON.parse(String(f.db.prepare('SELECT value FROM application_metadata WHERE key=?').get('synthetic-job-handoff')!.value)).original_attempt_id,value.attempt.attempt_id);
 const before=f.db.prepare('SELECT key,value FROM application_metadata ORDER BY key').all(),read=readLayoutCheckAdmissionReservationV2(f.db,f.authority.workspace_id,value.attempt.job_id);assert.equal(read?.context_sha256,sha256('same legitimate current view'));assert.deepEqual(f.db.prepare('SELECT key,value FROM application_metadata ORDER BY key').all(),before);
 const corrupted={...read!,context_sha256:sha256('wrong index context')};f.db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(corrupted),'article-layout-check-admission.v2:'+f.authority.workspace_id+':intent:'+value.attempt.id);assert.throws(()=>readLayoutCheckAdmissionReservationV2(f.db,f.authority.workspace_id,value.attempt.job_id),/INDEX_FENCE/);
});
test('executePrepared uses the exact restarted durable v2 intent and performs one native thread/turn without re-reserving journal',async t=>{
 const f=fixture(t),permit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),journal=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id),value=execution(f.root,'prepared');
 f.db.exec('BEGIN IMMEDIATE');enroll(permit,value);assert.equal(journal.reservePrepared(value),true);f.db.exec('COMMIT');f.reopen();
 const restored=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id),restoredPermit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),native=new QAOnlyNative();
 restored.reserve=async()=>{throw new Error('executePrepared must not reserve journal again');};
 const result=await adapter(f,restored,native,restoredPermit).executePrepared(restored.read(value.attempt.attempt_id)!,new AbortController().signal);
 assert.equal(result.execution.attempt.state,'completed');assert.equal(result.execution.attempt.attempt_id,value.attempt.attempt_id);assert.equal(native.threads,1);assert.equal(native.starts,1);assert.equal(native.closes,1);assert.equal(restoredPermit.reservation(value.attempt.job_id)?.state,'reserved');assert.equal(result.execution.submit_count,1);
});
test('concurrent executePrepared claims submission before acquiring native; duplicate invocation cannot create another client/thread',async t=>{
 const f=fixture(t),permit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),journal=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id),value=execution(f.root,'prepared-concurrent');enroll(permit,value);assert.equal(journal.reservePrepared(value),true);
 const native=new QAOnlyNative();let acquisitions=0;const options={workspace_id:f.authority.workspace_id,cwd:f.root,lock_root:f.root,schema_directory:f.root,journal,fixture:true,permit,native_factory:()=>{acquisitions++;return native;},timeout_ms:20};
 const values=await Promise.allSettled([new CodexLayoutCheckAdapter(options).executePrepared(structuredClone(value),new AbortController().signal),new CodexLayoutCheckAdapter(options).executePrepared(structuredClone(value),new AbortController().signal)]);
 assert.equal(values.filter(v=>v.status==='fulfilled').length,1);assert.equal(values.filter(v=>v.status==='rejected').length,1);assert.equal(acquisitions,1);assert.equal(native.threads,1);assert.equal(native.starts,1);
 await assert.rejects(()=>new CodexLayoutCheckAdapter(options).executePrepared(value,new AbortController().signal),/完整 execution|占用|intent/);assert.equal(acquisitions,1);
});
test('executePrepared rejects missing durable source, legacy journal, wrong candidate, changed full digest and wrong fixture source before native',async t=>{
 const f=fixture(t),permit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),journal=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id),value=execution(f.root,'prepared-source'),native=new QAOnlyNative();enroll(permit,value);
 await assert.rejects(()=>adapter(f,journal,native,permit).executePrepared(value,new AbortController().signal),/持久完整 execution/);assert.equal(journal.reservePrepared(value),true);
 await assert.rejects(()=>adapter(f,new SqliteLayoutCheckJournal(f.db,f.authority.workspace_id),native,permit).executePrepared(value,new AbortController().signal),/v2 持久 journal/);
 const wrongCandidate=structuredClone(value);wrongCandidate.candidate_sha256=sha256('wrong prepared candidate');await assert.rejects(()=>adapter(f,journal,native,permit).executePrepared(wrongCandidate,new AbortController().signal),/候选/);
 const changed=structuredClone(value);changed.attempt.updated_at='2026-10-01T00:00:00Z';await assert.rejects(()=>adapter(f,journal,native,permit).executePrepared(changed,new AbortController().signal),/持久完整 execution/);
 const source=structuredClone(value);source.proof.source='codex_app_server';await assert.rejects(()=>adapter(f,journal,native,permit).executePrepared(source,new AbortController().signal),/INPUT_PROOF_INVALID/);
 assert.equal(native.calls.length,0);assert.equal(permit.reservation(value.attempt.job_id)?.state,'enrolled');
});
test('executePrepared refuses previously acquired thread IDs and submit1; a claimed-but-clean crash cannot reacquire native',async t=>{
 const f=fixture(t),permit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority),journal=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id),native=new QAOnlyNative();
 const thread=execution(f.root,'prepared-old-thread');enroll(permit,thread);journal.reservePrepared(thread);thread.attempt.native.thread_id='original-thread-with-no-submission';await journal.save(thread);
 await assert.rejects(()=>adapter(f,journal,native,permit).executePrepared(thread,new AbortController().signal),/已有原生身份/);
 const submitted=execution(f.root,'prepared-submitted');await reserve(permit,journal,submitted);submitted.submit_count=1;submitted.attempt.state='unknown';submitted.attempt.native={provider:'fixture',thread_id:'original-thread',turn_id:'original-turn'};await journal.save(submitted);
 await assert.rejects(()=>adapter(f,journal,native,permit).executePrepared(submitted,new AbortController().signal),/已有原生身份/);
 const claimed=execution(f.root,'prepared-crash-before-thread');await reserve(permit,journal,claimed);f.reopen();const restored=new SqliteLayoutCheckJournalV2(f.db,f.authority.workspace_id),restoredPermit=new SqliteLayoutCheckAdmissionV2(f.db,f.authority);
 await assert.rejects(()=>adapter(f,restored,native,restoredPermit).executePrepared(restored.read(claimed.attempt.attempt_id)!,new AbortController().signal),/占用提交准入/);assert.equal(native.calls.length,0);assert.equal(restored.read(claimed.attempt.attempt_id)!.submit_count,0);
});
function savedArchive(f:ReturnType<typeof fixture>){
 const initial=createArticleLayout({article_id:'fixture-article',document_id:'fixture-document',document_revision_id:'original-document-revision',text:'已审原始稿。'});
 const edited=editArticleText(initial,initial.blocks[0]!.id,'排版里人工改过的文字。');edited.version=2;
 const snapshot=confirmArticleLayout(edited,{actor:'synthetic-fixture-actor',human_decision_ref:'synthetic-fixture-not-user-approval',layout_only:true});
 const source:ArticleLayoutSourceBinding={topic_id:'fixture-topic',document_id:snapshot.document_id,document_revision_id:'original-document-revision',final_id:'fixture-image-final',paragraph_blocks:{p1:{first:snapshot.blocks[0]!.id,last:snapshot.blocks[0]!.id}},synced_at:'2026-10-26T00:00:00Z'};
 const root=join(f.root,'managed-notes');mkdirSync(root);const ref=join(f.root,'fixture-record-grant.json');
 const grant:ArticleLayoutRecordGrant={root,process_root:join(root,'process','article-layout'),wiki_root:join(root,'wiki','article-layout'),owner_registration_ref:ref,scope:'fixture'};writeFileSync(ref,JSON.stringify(grant));
 const save=(s:ArticleLayoutSnapshot,sourceBinding=source,pending:unknown=null)=>f.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('article-layout.v1:'+f.authority.workspace_id+':'+s.article_id,JSON.stringify({snapshot:s,source:sourceBinding,pending,operations:{},conflicts:[]}));save(snapshot);
 const options:ArticleLayoutOnlyArchiveOptions={mode:'layout_only',db:f.db,workspace_id:f.authority.workspace_id,source,rules_version:LAYOUT_RULES_VERSION};
 return {snapshot,source,grant,options,save};
}
test('default still rejects null; explicit layout_only archives saved current combination with source revision and synthetic scope',t=>{
 const f=fixture(t),a=savedArchive(f);assert.equal(a.snapshot.document_revision_id,null);assert.throws(()=>writeConfirmedArticleLayoutWiki(a.grant,a.snapshot),/CONFIRMATION_REQUIRED/);
 const receipt=writeConfirmedArticleLayoutWiki(a.grant,a.snapshot,a.options),body=readFileSync(receipt.path,'utf8');assert.equal(receipt.scope,'fixture');assert.match(body,/archive_mode: "layout_only"/);assert.match(body,/document_revision_id: null/);assert.match(body,/source_document_revision_id: "original-document-revision"/);assert.match(body,/synthetic fixture/);assert.match(body,/排版里人工改过的文字/);
 assert.equal(writeConfirmedArticleLayoutWiki(a.grant,a.snapshot,a.options).written,false);assert.equal(receipt.sha256,sha256(body));
 assert.equal(Number(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()!.n),1);
});
test('layout_only archive rejects missing/mismatched grant, unsaved/pending/old combination, source and rules changes',t=>{
 const f=fixture(t),a=savedArchive(f);
 assert.throws(()=>writeConfirmedArticleLayoutWiki({...a.grant,owner_registration_ref:join(f.root,'unregistered.json')},a.snapshot,a.options),/GRANT_REQUIRED/);
 assert.throws(()=>writeConfirmedArticleLayoutWiki({...a.grant,scope:'production'},a.snapshot,a.options),/GRANT_MISMATCH/);
 assert.throws(()=>writeConfirmedArticleLayoutWiki(a.grant,a.snapshot,{...a.options,rules_version:'old-rules'}),/RULES_FENCE/);
 assert.throws(()=>writeConfirmedArticleLayoutWiki(a.grant,a.snapshot,{...a.options,source:{...a.source,document_revision_id:'made-up-document-revision'}}),/PROVENANCE_FENCE/);
 assert.throws(()=>writeConfirmedArticleLayoutWiki(a.grant,a.snapshot,{...a.options,source:{...a.source,final_id:'changed-final'}}),/SAVED_COMBINATION_REQUIRED/);
 a.save(a.snapshot,a.source,{id:'in-progress'});assert.throws(()=>writeConfirmedArticleLayoutWiki(a.grant,a.snapshot,a.options),/SAVED_COMBINATION_REQUIRED/);
 const changed=updateArticleStyle(a.snapshot,{body_size:16});changed.version++;a.save(changed);assert.throws(()=>writeConfirmedArticleLayoutWiki(a.grant,a.snapshot,a.options),/SAVED_COMBINATION_REQUIRED/);assert.throws(()=>writeConfirmedArticleLayoutWiki(a.grant,changed,a.options),/CONFIRMATION_REQUIRED/);
 a.save(a.snapshot);writeConfirmedArticleLayoutWiki(a.grant,a.snapshot,a.options);const replay=structuredClone(a.snapshot);replay.confirmation!.human_decision_ref='forged';assert.throws(()=>writeConfirmedArticleLayoutWiki(a.grant,replay,a.options),/SAVED_COMBINATION_REQUIRED/);
});
