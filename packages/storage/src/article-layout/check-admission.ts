import type {DatabaseSync} from 'node:sqlite';
import type {LayoutCheckExecution, LayoutCheckJournal, LayoutCheckPermitV2} from '../../../adapters/src/media/layout-check/types.ts';
import {assertLayoutCheckAttempt, digest} from '../../../domain/src/article-layout/index.ts';
import {assertLayoutCheckExecutionProof} from './proof.ts';
import {assertLayoutCheckTerminalEvidence} from '../../../adapters/src/media/layout-check/proof.ts';

export interface LayoutCheckAuthorityV2 {
 schema_version:'article-layout-authority.v2'; authority_id:string; workspace_id:string;
 candidate_sha256:string; goal_id:string; parent_sha256:string|null; scope:'fixture'|'production';
}
export interface LayoutCheckEnrollmentV2 {
 intent_id:string; job_id:string; attempt_id:string; manifest_sha256:string; context_sha256:string;
}
export interface LayoutCheckAdmissionReservationV2 extends LayoutCheckEnrollmentV2 {
 authority_sha256:string; candidate_sha256:string; state:'enrolled'|'reserved'|'completed'|'failed'|'unknown'|'cancelled';
 reserved_at:string|null;
}
interface AuthorityRecord {authority:LayoutCheckAuthorityV2; authority_sha256:string; legacy_v1_sha256:string}
const validHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const named=(value:unknown):value is string=>typeof value==='string'&&value.length>0;
const prefix=(workspace:string)=>'article-layout-check-admission.v2:'+workspace+':';
const journalKey=(version:'v1'|'v2',workspace:string,type:string,id:string)=>'article-layout-check.'+version+':'+workspace+':'+type+':'+id;
function atomic<T>(db:DatabaseSync,fn:()=>T):T{
 if(db.isTransaction)return fn();
 db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
}
function get<T>(db:DatabaseSync,key:string):T|null{const row=db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key);return row?JSON.parse(String(row.value)) as T:null;}
function insert(db:DatabaseSync,key:string,value:unknown){db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?)').run(key,JSON.stringify(value));}
function rows(db:DatabaseSync,starts:string):Array<{key:string;value:string}>{return db.prepare('SELECT key,value FROM application_metadata WHERE substr(key,1,?)=? ORDER BY key').all(starts.length,starts).map(row=>({key:String(row.key),value:String(row.value)}));}
function legacyRows(db:DatabaseSync,workspace:string){return [...rows(db,'article-layout-check.v1:'+workspace+':'),...rows(db,'article-layout-check-budget.v1:'+workspace+':')].sort((a,b)=>a.key.localeCompare(b.key));}
function legacyConflict(db:DatabaseSync,workspace:string,input:Pick<LayoutCheckEnrollmentV2,'intent_id'|'job_id'|'attempt_id'>):boolean{
 if(['attempt','job','id'].some((type,i)=>get(db,journalKey('v1',workspace,type,[input.attempt_id,input.job_id,input.intent_id][i]!))))return true;
 return rows(db,'article-layout-check-budget.v1:'+workspace+':').some(row=>{
  const budget=JSON.parse(row.value) as {reservations?:Array<{job_id:string;attempt_id:string}>};
  return budget.reservations?.some(value=>value.job_id===input.job_id||value.attempt_id===input.attempt_id)??false;
 });
}
function authorityRecord(db:DatabaseSync,workspace:string,sha:string):AuthorityRecord{
 const record=get<AuthorityRecord>(db,prefix(workspace)+'authority-hash:'+sha);
 if(!record||record.authority_sha256!==sha||digest(record.authority)!==sha||record.authority.workspace_id!==workspace||!validHash(record.legacy_v1_sha256))throw new Error('LAYOUT_CHECK_AUTHORITY_CORRUPT');
 return record;
}
function readEnrollment(db:DatabaseSync,workspace:string,jobId:string):LayoutCheckAdmissionReservationV2|null{
 const row=get<LayoutCheckAdmissionReservationV2>(db,prefix(workspace)+'job:'+jobId);
 if(!row)return null;
 if(row.job_id!==jobId||!named(row.intent_id)||!named(row.attempt_id)||!validHash(row.manifest_sha256)||!validHash(row.context_sha256)||!['enrolled','reserved','completed','failed','unknown','cancelled'].includes(row.state)||!validHash(row.authority_sha256)||!validHash(row.candidate_sha256))throw new Error('LAYOUT_CHECK_ADMISSION_CORRUPT');
 const record=authorityRecord(db,workspace,row.authority_sha256);
 if(record.authority.candidate_sha256!==row.candidate_sha256)throw new Error('LAYOUT_CHECK_ADMISSION_AUTHORITY_FENCE');
 for(const [kind,id] of [['job',row.job_id],['attempt',row.attempt_id],['intent',row.intent_id]])if(digest(get(db,prefix(workspace)+kind+':'+id))!==digest(row))throw new Error('LAYOUT_CHECK_ADMISSION_INDEX_FENCE');
 return row;
}
/** Synchronous read-only bridge for receipt/context validation; validates authority and all identity indexes. */
export function readLayoutCheckAdmissionReservationV2(db:DatabaseSync,workspace:string,jobId:string):LayoutCheckAdmissionReservationV2|null{return readEnrollment(db,workspace,jobId);}
function writeEnrollment(db:DatabaseSync,workspace:string,row:LayoutCheckAdmissionReservationV2){
 for(const [kind,id] of [['job',row.job_id],['attempt',row.attempt_id],['intent',row.intent_id]])db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(row),prefix(workspace)+kind+':'+id);
}
/** The caller supplies the root-issued authority. This class persists and fences it; it cannot grant itself a wider scope. */
export class SqliteLayoutCheckAdmissionV2 implements LayoutCheckPermitV2 {
 readonly version='v2' as const; readonly candidate_sha256:string; readonly authority_sha256:string;
 readonly authority:Readonly<LayoutCheckAuthorityV2>; readonly db:DatabaseSync;
 constructor(db:DatabaseSync,authority:LayoutCheckAuthorityV2){
  if(authority.schema_version!=='article-layout-authority.v2'||![authority.authority_id,authority.workspace_id,authority.goal_id].every(named)||!validHash(authority.candidate_sha256)||authority.parent_sha256!==null&&!validHash(authority.parent_sha256)||!['fixture','production'].includes(authority.scope))throw new Error('LAYOUT_CHECK_AUTHORITY_INVALID');
  this.db=db;this.authority=Object.freeze(structuredClone(authority));this.candidate_sha256=authority.candidate_sha256;this.authority_sha256=digest(authority);
  atomic(db,()=>{
   const base=prefix(authority.workspace_id),existing=get<AuthorityRecord>(db,base+'authority-id:'+authority.authority_id),head=get<{sha256:string}>(db,base+'head');
   if(existing){if(digest(existing.authority)!==this.authority_sha256||digest(authorityRecord(db,authority.workspace_id,this.authority_sha256))!==digest(existing))throw new Error('LAYOUT_CHECK_AUTHORITY_REBIND_FORBIDDEN');return;}
   if(head){const parent=authorityRecord(db,authority.workspace_id,head.sha256);if(authority.parent_sha256!==head.sha256||parent.authority.scope!==authority.scope||parent.authority.goal_id!==authority.goal_id)throw new Error('LAYOUT_CHECK_AUTHORITY_PARENT_FENCE');}
   else if(authority.parent_sha256!==null||rows(db,base).length)throw new Error('LAYOUT_CHECK_AUTHORITY_ROOT_RESET_FORBIDDEN');
   const record:AuthorityRecord={authority:structuredClone(authority),authority_sha256:this.authority_sha256,legacy_v1_sha256:digest(legacyRows(db,authority.workspace_id))};
   insert(db,base+'authority-id:'+authority.authority_id,record);insert(db,base+'authority-hash:'+this.authority_sha256,record);
   db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(base+'head',JSON.stringify({sha256:this.authority_sha256}));
  });
 }
 private current():boolean{return get<{sha256:string}>(this.db,prefix(this.authority.workspace_id)+'head')?.sha256===this.authority_sha256;}
 enroll(input:LayoutCheckEnrollmentV2):void{
  if(![input.intent_id,input.job_id,input.attempt_id].every(named)||!validHash(input.manifest_sha256)||!validHash(input.context_sha256))throw new Error('LAYOUT_CHECK_ENROLLMENT_INVALID');
  atomic(this.db,()=>{
   if(!this.current())throw new Error('LAYOUT_CHECK_AUTHORITY_SUPERSEDED');
   authorityRecord(this.db,this.authority.workspace_id,this.authority_sha256);
   const base=prefix(this.authority.workspace_id),keys=[base+'intent:'+input.intent_id,base+'job:'+input.job_id,base+'attempt:'+input.attempt_id];
   if(keys.some(key=>get(this.db,key))||legacyConflict(this.db,this.authority.workspace_id,input)||['attempt','job','id'].some((type,i)=>get(this.db,journalKey('v2',this.authority.workspace_id,type,[input.attempt_id,input.job_id,input.intent_id][i]!))))throw new Error('LAYOUT_CHECK_ENROLLMENT_DUPLICATE');
   const row:LayoutCheckAdmissionReservationV2={...structuredClone(input),authority_sha256:this.authority_sha256,candidate_sha256:this.candidate_sha256,state:'enrolled',reserved_at:null};
   for(const key of keys)insert(this.db,key,row);
  });
 }
 authorize_job(jobId:string):boolean{
  const row=this.reservation(jobId);
  // A superseded authority retains read-only original-ID recovery. It cannot reserve a new submission.
  return !!row&&row.authority_sha256===this.authority_sha256&&!legacyConflict(this.db,this.authority.workspace_id,row)&&(this.current()||row.reserved_at!==null);
 }
 async reserve_submission(jobId:string,attemptId:string,manifestSha:string):Promise<boolean>{
  return atomic(this.db,()=>{
   const row=this.reservation(jobId);
   if(!this.current()||!row||row.authority_sha256!==this.authority_sha256||row.state!=='enrolled'||row.reserved_at!==null||row.attempt_id!==attemptId||row.manifest_sha256!==manifestSha||legacyConflict(this.db,this.authority.workspace_id,row))return false;
   const execution=get<LayoutCheckExecution>(this.db,journalKey('v2',this.authority.workspace_id,'attempt',attemptId));
   if(!execution||execution.attempt.id!==row.intent_id||execution.attempt.job_id!==jobId||execution.attempt.input_manifest_sha256!==manifestSha||execution.candidate_sha256!==this.candidate_sha256||execution.submit_count!==0||execution.attempt.state!=='intent')return false;
   assertLayoutCheckExecutionProof(execution);row.state='reserved';row.reserved_at=new Date().toISOString();writeEnrollment(this.db,this.authority.workspace_id,row);return true;
  });
 }
 settle(jobId:string,state:'completed'|'failed'|'unknown'|'cancelled'):void{
  if(!['completed','failed','unknown','cancelled'].includes(state))throw new Error('LAYOUT_CHECK_ADMISSION_STATE_INVALID');
  atomic(this.db,()=>{const row=this.reservation(jobId);if(!row||row.authority_sha256!==this.authority_sha256)throw new Error('LAYOUT_CHECK_ADMISSION_MISSING');
   if(row.state!==state&&['completed','failed','cancelled'].includes(row.state)||state==='completed'&&!row.reserved_at||state==='unknown'&&!row.reserved_at)throw new Error('LAYOUT_CHECK_ADMISSION_TERMINAL_FENCE');
   const execution=new SqliteLayoutCheckJournalV2(this.db,this.authority.workspace_id).read(row.attempt_id);
   if(!execution||execution.attempt.state!==state)throw new Error('LAYOUT_CHECK_ADMISSION_EXECUTION_FENCE');
   assertLayoutCheckExecutionProof(execution);if(state==='failed'&&execution.submit_count===1)assertLayoutCheckTerminalEvidence(execution);row.state=state;writeEnrollment(this.db,this.authority.workspace_id,row);
  });
 }
 reservation(jobId:string):LayoutCheckAdmissionReservationV2|null{return readEnrollment(this.db,this.authority.workspace_id,jobId);}
}

/** v2 storage namespace, full unchanged execution.v1 proof. Legacy reads never rewrite v1 rows. */
export class SqliteLayoutCheckJournalV2 implements LayoutCheckJournal {
 readonly version='v2' as const;
 readonly db:DatabaseSync;readonly workspace_id:string;
 constructor(db:DatabaseSync,workspaceId:string){if(!workspaceId)throw new Error('LAYOUT_CHECK_WORKSPACE_REQUIRED');this.db=db;this.workspace_id=workspaceId;}
 private key(type:string,id:string){return journalKey('v2',this.workspace_id,type,id);}
 private validate(x:LayoutCheckExecution){
  assertLayoutCheckExecutionProof(x);assertLayoutCheckAttempt(x.attempt);
  const row=readEnrollment(this.db,this.workspace_id,x.attempt.job_id);
  if(!row||row.intent_id!==x.attempt.id||row.attempt_id!==x.attempt.attempt_id||row.manifest_sha256!==x.attempt.input_manifest_sha256||row.candidate_sha256!==x.candidate_sha256||authorityRecord(this.db,this.workspace_id,row.authority_sha256).authority.scope!==(x.fixture?'fixture':'production'))throw new Error('LAYOUT_CHECK_JOURNAL_ADMISSION_FENCE');
  if(legacyConflict(this.db,this.workspace_id,row))throw new Error('LAYOUT_CHECK_CROSS_VERSION_DUPLICATE');
  if(x.submit_count===1&&!row.reserved_at)throw new Error('LAYOUT_CHECK_SUBMISSION_RESERVATION_REQUIRED');
  if(x.submit_count===0&&['running','unknown','completed'].includes(x.attempt.state)||x.submit_count===1&&x.attempt.state==='intent')throw new Error('LAYOUT_CHECK_EXECUTION_STATE_FENCE');
 }
 read(attemptId:string):LayoutCheckExecution|null{
  const value=get<LayoutCheckExecution>(this.db,this.key('attempt',attemptId));
  if(!value){
   // Legacy proof checking is synchronous too; do not use its async load inside ResultCommit.
   const old=get<LayoutCheckExecution>(this.db,journalKey('v1',this.workspace_id,'attempt',attemptId));
   if(old){assertLayoutCheckExecutionProof(old);assertLayoutCheckAttempt(old.attempt);if(old.attempt.attempt_id!==attemptId)throw new Error('LAYOUT_CHECK_JOURNAL_LOAD_FENCE');
    if(['intent:'+old.attempt.id,'job:'+old.attempt.job_id,'attempt:'+old.attempt.attempt_id].some(id=>get(this.db,prefix(this.workspace_id)+id)))throw new Error('LAYOUT_CHECK_CROSS_VERSION_DUPLICATE');}
   return old;
  }
  this.validate(value);if(value.attempt.attempt_id!==attemptId)throw new Error('LAYOUT_CHECK_JOURNAL_LOAD_FENCE');
  for(const [kind,id] of [['attempt',value.attempt.attempt_id],['job',value.attempt.job_id],['id',value.attempt.id]])if(digest(get(this.db,this.key(kind!,id!)))!==digest(value))throw new Error('LAYOUT_CHECK_JOURNAL_INDEX_FENCE');
  return value;
 }
 async load(attemptId:string):Promise<LayoutCheckExecution|null>{return this.read(attemptId);}
 reservePrepared(execution:LayoutCheckExecution):boolean{
  return atomic(this.db,()=>{this.validate(execution);if(execution.attempt.state!=='intent'||execution.submit_count!==0)throw new Error('LAYOUT_CHECK_INTENT_REQUIRED');
   const keys=[this.key('attempt',execution.attempt.attempt_id),this.key('job',execution.attempt.job_id),this.key('id',execution.attempt.id)];
   if(keys.some(key=>get(this.db,key)))return false;
   for(const key of keys)insert(this.db,key,execution);return true;
  });
 }
 async reserve(execution:LayoutCheckExecution):Promise<boolean>{return this.reservePrepared(execution);}
 async save(execution:LayoutCheckExecution):Promise<void>{
  atomic(this.db,()=>{
   if(execution.attempt.state==='failed'&&execution.submit_count===1)assertLayoutCheckTerminalEvidence(execution);
   this.validate(execution);const old=this.read(execution.attempt.attempt_id);
   if(!get(this.db,this.key('attempt',execution.attempt.attempt_id))||!old)throw new Error('LAYOUT_CHECK_V2_RESERVATION_REQUIRED');
   const frozen=(x:LayoutCheckExecution)=>({schema_version:x.schema_version,fixture:x.fixture,candidate_sha256:x.candidate_sha256,id:x.attempt.id,job_id:x.attempt.job_id,attempt_id:x.attempt.attempt_id,binding:x.attempt.binding,input_manifest_sha256:x.attempt.input_manifest_sha256,input_manifest:x.input_manifest,native_provider:x.attempt.native.provider,native_input_sha256:x.proof.native_input_sha256,source:x.proof.source,input_channel:x.proof.input_channel,submitted_local_images:x.proof.submitted_local_images,billing_route:x.proof.billing_route,no_automatic_retry:x.no_automatic_retry,created_at:x.attempt.created_at});
   if(digest(frozen(old))!==digest(frozen(execution))||old.submit_count>execution.submit_count)throw new Error('LAYOUT_CHECK_JOURNAL_FENCE');
   if(old.proof.thread_start&&digest(old.proof.thread_start)!==digest(execution.proof.thread_start))throw new Error('LAYOUT_CHECK_THREAD_START_FENCE');
   if(old.attempt.native.thread_id&&old.attempt.native.thread_id!==execution.attempt.native.thread_id||old.attempt.native.turn_id&&old.attempt.native.turn_id!==execution.attempt.native.turn_id)throw new Error('LAYOUT_CHECK_NATIVE_FENCE');
   if(['completed','failed','cancelled'].includes(old.attempt.state)&&digest(old)!==digest(execution))throw new Error('LAYOUT_CHECK_TERMINAL_IMMUTABLE');
   if(old.attempt.state==='unknown'&&execution.attempt.state==='failed')assertLayoutCheckTerminalEvidence(execution);
   else if(old.attempt.state==='unknown'&&execution.attempt.state!=='unknown'&&execution.attempt.state!=='completed'&&execution.attempt.state!=='cancelled')throw new Error('LAYOUT_CHECK_NO_RESUBMIT');
   if(old.proof.terminal_read&&digest(old.proof.terminal_read)!==digest(execution.proof.terminal_read))throw new Error('LAYOUT_CHECK_TERMINAL_PROOF_FENCE');
   if(old.proof.original_input_verified&&!execution.proof.original_input_verified||old.proof.output_sha256&&old.proof.output_sha256!==execution.proof.output_sha256)throw new Error('LAYOUT_CHECK_NATIVE_PROOF_FENCE');
   for(const [kind,id] of [['attempt',execution.attempt.attempt_id],['job',execution.attempt.job_id],['id',execution.attempt.id]])this.db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(execution),this.key(kind!,id!));
  });
 }
}
export {SqliteLayoutCheckAdmissionV2 as SQLiteLayoutCheckAdmissionV2,SqliteLayoutCheckJournalV2 as SQLiteLayoutCheckJournalV2};
