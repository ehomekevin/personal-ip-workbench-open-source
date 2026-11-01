import { randomUUID } from 'node:crypto';
import { ContractError, type PublicationIntentsRow, type PublicationMembersRow, type PublicationAttemptsRow, type PublicationBatchesRow, type SchedulesRow, type JobsRow, type JsonObject } from '@workbench/contracts';
import { canonicalJson, type DatabaseSync } from '../connection/index.ts';
import { getJob, getAttempt, fenceReason, type AttemptFence } from '../jobs/index.ts';
export function intentRow(db: DatabaseSync, workspace: string, id: string): PublicationIntentsRow { const row=db.prepare('SELECT * FROM publication_intents WHERE workspace_id=? AND id=?').get(workspace,id); if(!row)throw new ContractError('NOT_FOUND','发布意图不存在');return row as unknown as PublicationIntentsRow; }
export function memberRows(db: DatabaseSync, workspace: string, id: string): PublicationMembersRow[] {return db.prepare('SELECT * FROM publication_members WHERE workspace_id=? AND intent_id=? ORDER BY position').all(workspace,id) as unknown as PublicationMembersRow[];}
export function publicationAttempts(db: DatabaseSync, workspace: string, id: string): PublicationAttemptsRow[] {return db.prepare('SELECT * FROM publication_attempts WHERE workspace_id=? AND intent_id=? ORDER BY attempt_no,started_at,id').all(workspace,id) as unknown as PublicationAttemptsRow[];}
export function intentJob(db: DatabaseSync,workspace:string,id:string):JobsRow {const row=db.prepare("SELECT * FROM jobs WHERE workspace_id=? AND kind='publication' AND target_id=? ORDER BY rowid DESC LIMIT 1").get(workspace,id);if(!row)throw new ContractError('NOT_FOUND','发布任务不存在');return row as unknown as JobsRow;}
export function scheduleRow(db: DatabaseSync,workspace:string,id:string):SchedulesRow {const row=db.prepare('SELECT * FROM schedules WHERE workspace_id=? AND id=?').get(workspace,id);if(!row)throw new ContractError('NOT_FOUND','排期不存在');return row as unknown as SchedulesRow;}
export function batchRow(db: DatabaseSync,workspace:string,id:string):PublicationBatchesRow {const row=db.prepare('SELECT * FROM publication_batches WHERE workspace_id=? AND id=?').get(workspace,id);if(!row)throw new ContractError('NOT_FOUND','发布批次不存在');return row as unknown as PublicationBatchesRow;}
export function requireFence(db:DatabaseSync,workspace:string,fence:AttemptFence,now:number,allowCancellation=false):void {
 const job=getJob(db,workspace,fence.job_id),attempt=getAttempt(db,workspace,fence.attempt_id);
 const reason=fenceReason(allowCancellation?{...job,cancel_requested_at:null}:job,attempt,fence,now);
 if(reason||attempt.lease_owner!==fence.lease_owner)throw new ContractError('HOST_RUN_NOT_CURRENT','发布执行归属或租约失效',{reason:reason??'OWNER_MISMATCH'});
}
export function beginPublicationAttempt(db:DatabaseSync,workspace:string,intentId:string,memberId:string|null,phase:string,fingerprint:string,now:number):string {
 if(!db.isTransaction)throw new Error('发送阶段必须在事务中持久化');const id=randomUUID(),at=new Date(now).toISOString();
 const n=Number(db.prepare('SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM publication_attempts WHERE workspace_id=? AND intent_id=?').get(workspace,intentId)!.n);
 db.prepare("INSERT INTO publication_attempts(id,workspace_id,intent_id,member_id,attempt_no,phase,request_fingerprint,result_status,started_at) VALUES (?,?,?,?,?,?,?,'sending',?)").run(id,workspace,intentId,memberId,n,phase,fingerprint,at);return id;
}
export function setProgress(db:DatabaseSync,workspace:string,id:string,state:PublicationIntentsRow['state'],progress:JsonObject,now:number):void {db.prepare('UPDATE publication_intents SET state=?,progress=?,version=version+1,updated_at=? WHERE workspace_id=? AND id=?').run(state,canonicalJson(progress),new Date(now).toISOString(),workspace,id);}
