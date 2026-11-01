import { randomUUID } from 'node:crypto';
import { ContractError } from '@workbench/contracts';
import { Publications } from '@workbench/domain/publications';
import { ResultCommit } from '@workbench/domain/result-commit';
import { DEFAULT_HEARTBEAT_MS } from '@workbench/storage/jobs';
/** 领取由发布领域加账户/排期检查；heartbeat、失效恢复和输出提交沿用 WP09。 */
export class PublicationWorker {
 readonly publications:Publications; readonly owner:string; readonly results:ResultCommit;
 constructor(publications:Publications,owner=`publication-worker:${randomUUID()}`){this.publications=publications;this.owner=owner;this.results=new ResultCommit(publications.context,{clock:publications.clock});}
 async runOnce():Promise<{job_id:string;state:string}|null> {
  this.publications.sweepRecovery();const claim=this.publications.claim(this.owner);if(!claim)return null;const abort=new AbortController();let checkpoint=JSON.parse(claim.attempt.checkpoint);
  const timer=setInterval(()=>{try{this.publications.jobs.heartbeat(claim.fence,checkpoint);}catch{abort.abort(new Error('LEASE_REVOKED'));}},DEFAULT_HEARTBEAT_MS);timer.unref();
  try {const output=await this.publications.execute({claim,signal:abort.signal,checkpoint:value=>{checkpoint=JSON.parse(this.publications.jobs.checkpoint(claim.fence,value).checkpoint);}}),current=this.publications.jobs.get(this.publications.request(),claim.job.id).job;
   const result=this.results.submit(this.publications.request(`publication-output:${claim.attempt.id}`),claim.job.id,{attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,expected_version:current.version,input_hash:claim.job.input_hash,typed_output:output},this.owner);return {job_id:claim.job.id,state:result.state};
  }catch(error){if(error instanceof ContractError&&error.code==='STORAGE_UNAVAILABLE')return {job_id:claim.job.id,state:'pending_repair'};try{const job=this.publications.jobs.fail(claim.fence,{code:error instanceof ContractError?error.code:'EXECUTION_FAILED',message:error instanceof Error?error.message:'执行未完成'},'reconciling');return {job_id:job.id,state:job.state};}catch{return {job_id:claim.job.id,state:this.publications.jobs.get(this.publications.request(),claim.job.id).job.state};}}
  finally {clearInterval(timer);}
 }
}
