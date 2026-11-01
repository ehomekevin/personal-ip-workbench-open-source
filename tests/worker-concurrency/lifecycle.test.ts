import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../service-agent/harness.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { ExecutionScheduler } from '../../apps/service/src/bootstrap/execution-concurrency.ts';
import { ContractError } from '../../packages/contracts/src/index.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
test('五任务独立signal/checkpoint，认证等待仅影响一条，其他四条完整写入',async()=>{
 const f=fixture(),signals=new Set<AbortSignal>(),barrier=new Map<string,()=>void>();
 try{const rows=Array.from({length:5},()=>{const document=randomUUID();f.context.db.prepare("INSERT INTO documents(id,workspace_id,kind,version) VALUES (?,?,'wiki',1)").run(document,f.context.identity.workspace_id);return f.jobs.enqueue(f.request(),{kind:'document_modify',execution_mode:'service_adapter',executor_id:'codex',entrypoint:'standalone_web',presentation:'foreground_dialog',target_id:document,input_manifest:{schema_version:'fixture',mode:'candidate',targets:[{document_id:document,base_revision_id:null,core_revision_id:null}],source_ids:[]}});}),failed=rows[0].id;
  const worker=new DurableWorker(f.context,[{registration:{kind:'document_modify',execution_mode:'service_adapter',recovery:'read_only'},async execute(execution){signals.add(execution.signal);execution.checkpoint({owner_job:execution.claim.job.id});await new Promise<void>(resolve=>barrier.set(execution.claim.job.id,resolve));if(execution.claim.job.id===failed)throw new ContractError('AUTH_REQUIRED','受控认证等待',{pre_submit_failure:true});return {documents:[{document_id:execution.claim.job.target_id!,text:'候选'}],recommendations:[]};}}]),scheduler=new ExecutionScheduler(worker);
  scheduler.tick();assert.equal(barrier.size,5);assert.equal(signals.size,5);barrier.get(failed)!();await delay(10);assert.equal(f.jobs.get(f.request(),failed).job.state,'waiting_input');assert.equal(scheduler.activeCount,4);assert(rows.slice(1).every(row=>f.jobs.get(f.request(),row.id).job.state==='running'));for(const row of rows.slice(1))barrier.get(row.id)!();await delay(30);await scheduler.close();assert(rows.slice(1).every(row=>f.jobs.get(f.request(),row.id).job.state==='succeeded'));for(const row of rows)assert.equal(f.jobs.get(f.request(),row.id).checkpoint!.owner_job,row.id);
 }finally{f.cleanup();}
});
