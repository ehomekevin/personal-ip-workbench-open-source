import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ContractError, type JsonObject } from '../../packages/contracts/src/index.ts';
import { CodexAdapter } from '../../packages/adapters/src/agent/codex/index.ts';
import { ClaudeAdapter } from '../../packages/adapters/src/agent/claude/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { createServiceAgentHandlers } from '../../apps/service/src/worker/handlers/agent/index.ts';
import { ExecutionScheduler } from '../../apps/service/src/bootstrap/execution-concurrency.ts';
import { poolAdmission } from '../../apps/service/src/bootstrap/execution.ts';
import { acquire } from '../../packages/adapters/src/agent/codex/primitives.ts';
import { CAPACITY_BACKOFF_MAX_MS } from '../../apps/service/src/worker/core/index.ts';
import { fixture, projectRoot, schemaDirectory } from '../service-agent/harness.ts';
import type { ServiceAgentPlan } from '../../packages/domain/src/service-agent/index.ts';
import { validateConfiguration } from '../../apps/service/src/bootstrap/config.ts';
import { Settings } from '../../packages/domain/src/settings/index.ts';

export async function until(check: () => boolean, timeout = 10_000) { const deadline = Date.now() + timeout; while (!check()) { if (Date.now() >= deadline) throw new Error('barrier timed out'); await delay(10); } }
function controlled(limit=5,admission=false) {
 const f=fixture(),control=join(f.staging,'control'),locks=join(f.root,'locks');mkdirSync(control);
 const adapters:Array<(CodexAdapter|ClaudeAdapter)>=[],starts:JsonObject[]=[];
 function createAdapter(plan:ServiceAgentPlan) { const options={workspace_id:f.context.identity.workspace_id,cwd:plan.cwd,lock_root:locks,concurrency_slots:limit,timeout_ms:10_000,sink:(entry:{direction:string;message:unknown})=>{if(entry.direction==='send'&&entry.message&&typeof entry.message==='object'&&'method' in entry.message&&(entry.message as {method:string}).method==='turn/start')starts.push({executor:'codex',job_id:plan.input.job_id,at:Date.now()});}};
   const adapter=plan.executor_id==='codex'?new CodexAdapter({...options,schema_directory:schemaDirectory,executable:join(projectRoot,'tests/service-agent/concurrency-fixture-codex.mjs')}):new ClaudeAdapter({...options,executable:join(projectRoot,'tests/service-agent/concurrency-fixture-claude.mjs')});adapters.push(adapter);return adapter; }
 const worker=new DurableWorker(f.context,createServiceAgentHandlers(f.context,{staging_root:f.staging,createAdapter}),{heartbeat_ms:25});
 const scheduler=new ExecutionScheduler(worker,{interval_ms:20,limit,...(admission?{admit:poolAdmission(locks,f.context.identity.workspace_id,limit)}:{}),closeAdapters:async()=>{await Promise.all(adapters.map(adapter=>adapter.close()));}});
 function enqueue(label:string,executor='codex',mode='success',document=randomUUID(),extra:JsonObject={}) { if(!f.context.db.prepare('SELECT id FROM documents WHERE id=?').get(document))f.context.db.prepare("INSERT INTO documents(id,workspace_id,kind,version) VALUES (?,?,'wiki',1)").run(document,f.context.identity.workspace_id);
  const job=f.jobs.enqueue(f.request(),{kind:'document_modify',execution_mode:'service_adapter',executor_id:executor,entrypoint:'standalone_web',presentation:'foreground_dialog',target_id:document,input_manifest:{schema_version:'c05-fixture',mode:'candidate',targets:[{document_id:document,base_revision_id:null,core_revision_id:null}],source_ids:[],...extra,service_agent:{cwd:f.staging,task_instruction:JSON.stringify({root:control,label,mode}),allowed_tools:[]}}});return {job,document,label}; }
 const started=(label:string)=>existsSync(join(control,label+'.started')),release=(label:string)=>writeFileSync(join(control,label+'.release'),'release');
 return {...f,control,locks,worker,scheduler,adapters,starts,enqueue,started,release,async stop(){await scheduler.close();f.cleanup();}};
}
function evidence(name:string,value:unknown){if(process.env.C05_EVIDENCE_DIR){mkdirSync(process.env.C05_EVIDENCE_DIR,{recursive:true});writeFileSync(join(process.env.C05_EVIDENCE_DIR,name+'.json'),JSON.stringify(value,null,2)+'\n');}}
// F3：上限来自服务配置；limit=2 时三条任务仅两条 running，第三条 queued 且无 attempt。
for(const [limit,executors] of [[5,Array(6).fill('codex')],[5,Array(6).fill('claude')],[5,['codex','claude','codex','claude','codex','claude']],[2,['codex','claude','codex']]] as Array<[number,string[]]>)test(`${limit}路 native barrier / ${executors.join(',')} / 第${limit+1} queued 和补位`,async()=>{
 const f=controlled(limit),rows=executors.map((executor,index)=>f.enqueue(String(index),executor)),timeline:unknown[]=[];let max=0;const sample=setInterval(()=>{max=Math.max(max,f.scheduler.activeCount);},2);
 try{f.scheduler.initialize();f.scheduler.initialize();for(let n=0;n<20;n++)f.scheduler.tick();await until(()=>rows.filter(row=>f.started(row.label)).length===limit);
   const blocked=rows.find(row=>!f.started(row.label))!,running=rows.filter(row=>f.started(row.label));
   await delay(100);assert.equal(rows.filter(row=>f.started(row.label)).length,limit);assert.equal(f.scheduler.activeCount,limit);assert.equal(f.jobs.get(f.request(),blocked.job.id).job.state,'queued');assert.equal(f.jobs.get(f.request(),blocked.job.id).attempts.length,0);
   const barrier=running.map(row=>({job_id:row.job.id,state:f.jobs.get(f.request(),row.job.id).job.state,...JSON.parse(readFileSync(join(f.control,row.label+'.started'),'utf8'))}));assert(barrier.every(row=>row.state==='running'));assert.equal(new Set(barrier.map(row=>row.pid)).size,limit);assert.equal(new Set(barrier.map(row=>row.thread)).size,limit);timeline.push({at:Date.now(),phase:'five_started_barrier',barrier,sixth:{job_id:blocked.job.id,state:'queued'}});
   f.release(running[0].label);await until(()=>f.started(blocked.label));assert.equal(f.jobs.get(f.request(),running[0].job.id).job.state,'succeeded');assert(running.slice(1).every(row=>f.jobs.get(f.request(),row.job.id).job.state==='running'));timeline.push({at:Date.now(),phase:'sixth_started_after_one_release',native:JSON.parse(readFileSync(join(f.control,blocked.label+'.started'),'utf8'))});
   rows.forEach(row=>f.release(row.label));await until(()=>rows.every(row=>f.jobs.get(f.request(),row.job.id).job.state==='succeeded'));await until(()=>f.scheduler.activeCount===0);assert(max<=limit);
   for(const row of rows){const candidate=f.context.db.prepare('SELECT target_document_id FROM candidates WHERE job_id=?').get(row.job.id)!;assert.equal(candidate.target_document_id,row.document);assert.equal(f.context.db.prepare('SELECT head_revision_id FROM documents WHERE id=?').get(row.document)!.head_revision_id,null);const attempt=f.jobs.get(f.request(),row.job.id).attempts[0];assert(attempt.runtime_session_id);assert(attempt.runtime_turn_id);}
   assert.equal(f.context.db.prepare("SELECT COUNT(*) AS n FROM result_receipts WHERE state='committed'").get()!.n,rows.length);assert.equal(readdirSync(f.locks).filter(file=>file.endsWith('.lock')).length,0);
   if(limit===5)evidence('barrier-'+(new Set(executors).size===1?executors[0]:'mixed'),{task:'EXECUTOR-CONCURRENCY-05/r2',scope:'controlled_native_fixture',max_active:max,timeline,receipts:rows.map(row=>({job_id:row.job.id,attempts:f.jobs.get(f.request(),row.job.id).attempts,receipts:f.jobs.get(f.request(),row.job.id).receipts}))});
 }finally{clearInterval(sample);await f.stop();}
});
test('取消一个 native task，另四个保持运行；第六补位，旧 checkpoint/output 不能提交',async()=>{
 const f=controlled(),rows=Array.from({length:6},(_,index)=>f.enqueue(String(index),index%2?'claude':'codex'));
 try{f.scheduler.initialize();await until(()=>rows.filter(row=>f.started(row.label)).length===5);const active=rows.filter(row=>f.started(row.label)),cancelled=active[0],before=f.jobs.get(f.request(),cancelled.job.id),attempt=before.attempts[0];f.jobs.cancel(f.request(),cancelled.job.id,{expected_version:before.job.version});
  await until(()=>rows.every(row=>f.started(row.label)));assert(active.slice(1).every(row=>f.jobs.get(f.request(),row.job.id).job.state==='running'));
  assert.throws(()=>f.jobs.checkpoint({job_id:cancelled.job.id,attempt_id:attempt.id,attempt_generation:attempt.attempt_generation,lease_owner:attempt.lease_owner},{late:true}),{code:'HOST_RUN_NOT_CURRENT'});
  const receipt=f.results.submit(f.request(),cancelled.job.id,{attempt_id:attempt.id,attempt_generation:attempt.attempt_generation,expected_version:f.jobs.get(f.request(),cancelled.job.id).job.version,input_hash:cancelled.job.input_hash,typed_output:{documents:[{document_id:cancelled.document,text:'迟到候选'}],recommendations:[]}},attempt.lease_owner);assert.equal(receipt.state,'quarantined');
  rows.forEach(row=>f.release(row.label));await until(()=>rows.filter(row=>row!==cancelled).every(row=>f.jobs.get(f.request(),row.job.id).job.state==='succeeded'));assert.equal(f.jobs.get(f.request(),cancelled.job.id).job.state,'cancelled');assert.equal(f.context.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE job_id=?').get(cancelled.job.id)!.n,0);
 }finally{await f.stop();}
});
test('同目标/同run队头让出独立任务；busy 保持 queued 和原 checkpoint，无失败污染',async()=>{
 const f=controlled(),first=f.enqueue('first'),same=f.enqueue('same','claude','success',first.document),independent=f.enqueue('independent');
 try{f.scheduler.initialize();await until(()=>f.started('first')||f.started('same'));await until(()=>f.started('independent'));assert.equal(f.scheduler.activeCount,2);const waiting=f.started('first')?same:first;assert.equal(f.jobs.get(f.request(),waiting.job.id).job.state,'queued');
   f.release(f.started('first')?'first':'same');await until(()=>f.started(waiting.label));[first,same,independent].forEach(row=>f.release(row.label));await until(()=>[first,same,independent].every(row=>f.jobs.get(f.request(),row.job.id).job.state==='succeeded'));
 }finally{await f.stop();}
 const isolated=fixture();try{const job=isolated.enqueue(),worker=new DurableWorker(isolated.context,[{registration:{kind:'document_modify',execution_mode:'service_adapter',recovery:'read_only'},async execute(){throw new ContractError('CAPABILITY_UNVERIFIED','busy',{executor_capacity_busy:true,pre_submit_failure:true});}}]);assert.equal((await worker.runOnce())!.state,'queued');const view=isolated.jobs.get(isolated.request(),job.id);assert.equal(view.error,null);assert.deepEqual(view.checkpoint,{});assert(!isolated.jobs.events(isolated.request(),job.id).events.some(event=>event.type==='failed'));assert.equal(await worker.runOnce(),null);}finally{isolated.cleanup();}
});
test('关闭同时中止所有 native child，重复 initialize/close 不再领取；不响应 handler 的等待有界',async()=>{
 const f=controlled(),rows=Array.from({length:5},(_,index)=>f.enqueue(String(index)));
 try{f.scheduler.initialize();await until(()=>rows.every(row=>f.started(row.label)));await Promise.all([f.scheduler.close(),f.scheduler.close()]);assert.equal(f.scheduler.activeCount,0);assert.equal(readdirSync(f.locks).filter(file=>file.endsWith('.lock')).length,0);const next=f.enqueue('after');f.scheduler.initialize();f.scheduler.tick();await delay(50);assert.equal(f.jobs.get(f.request(),next.job.id).job.state,'queued');}finally{await f.stop();}
 const fake=new ExecutionScheduler({startNext:()=>new Promise(()=>{})},{close_timeout_ms:20});fake.tick();await assert.rejects(fake.close(),{code:'RESULT_UNKNOWN'});assert.equal(fake.activeCount,5);fake.tick();assert.equal(fake.activeCount,5);
});
for(const [executor,mode,state] of [['codex','quota','waiting_quota'],['claude','quota','waiting_quota'],['codex','unknown','failed']] as const)test(`单任务 ${executor}/${mode} 不影响另外四路，unknown 显式核对不新发 turn`,async()=>{
 const f=controlled(),fault=f.enqueue('fault',executor,mode),others=Array.from({length:4},(_,index)=>f.enqueue('good-'+index,executor));
 try{f.scheduler.initialize();await until(()=>[fault,...others].every(row=>f.started(row.label)));f.release(fault.label);await until(()=>f.jobs.get(f.request(),fault.job.id).job.state===state);assert(others.every(row=>f.jobs.get(f.request(),row.job.id).job.state==='running'));
  const submits=f.starts.filter(entry=>entry.job_id===fault.job.id).length;await delay(60);assert.equal(f.jobs.get(f.request(),fault.job.id).job.state,state);
  if(mode==='unknown'){const current=f.jobs.get(f.request(),fault.job.id);f.jobs.resume(f.request(),fault.job.id,{expected_version:current.job.version});await until(()=>f.jobs.get(f.request(),fault.job.id).job.state==='failed');assert.equal(f.starts.filter(entry=>entry.job_id===fault.job.id).length,submits);assert.equal(f.jobs.get(f.request(),fault.job.id).job.executor_id,executor);}
  others.forEach(row=>f.release(row.label));await until(()=>others.every(row=>f.jobs.get(f.request(),row.job.id).job.state==='succeeded'));assert.equal(f.context.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE job_id=?').get(fault.job.id)!.n,0);
 }finally{await f.stop();}
});
test('unknown只读核对未完成后仍可核对原turn完成结果，保留旧session/turn且不再次生成',async()=>{
 const f=controlled(),row=f.enqueue('unknown','codex','unknown');try{f.scheduler.initialize();await until(()=>f.started(row.label));const native=JSON.parse(readFileSync(join(f.control,row.label+'.started'),'utf8'));f.release(row.label);await until(()=>f.jobs.get(f.request(),row.job.id).job.state==='failed');let view=f.jobs.get(f.request(),row.job.id);f.jobs.resume(f.request(),row.job.id,{expected_version:view.job.version});await until(()=>f.jobs.get(f.request(),row.job.id).job.state==='failed');view=f.jobs.get(f.request(),row.job.id);assert.equal(view.checkpoint!.resume_submission_unknown,false);
  const path=join(f.control,native.thread+'.json'),record=JSON.parse(readFileSync(path,'utf8')),template=JSON.parse(readFileSync(join(projectRoot,'tests/service-agent/native-fixture.json'),'utf8'));record.turns[0].status='completed';record.turns[0].items=[{...template['item/completed'].item,text:JSON.stringify({documents:[{document_id:row.document,text:'原turn完成候选'}],recommendations:[]})}];writeFileSync(path,JSON.stringify(record));f.jobs.resume(f.request(),row.job.id,{expected_version:view.job.version});await until(()=>f.jobs.get(f.request(),row.job.id).job.state==='succeeded');const after=f.jobs.get(f.request(),row.job.id);assert.equal(after.attempts.at(-1)!.runtime_session_id,native.thread);assert.equal(after.attempts.at(-1)!.runtime_turn_id,native.turn);assert.equal(f.starts.filter(entry=>entry.job_id===row.job.id).length,1);assert.equal(f.context.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE job_id=?').get(row.job.id)!.n,1);
 }finally{await f.stop();}
});
test('F3 服务配置 max_concurrent_generations：默认5、范围1–10，settings 只读透出',async()=>{
 const f=fixture();try{const base={...f.context.config,listen:{host:'127.0.0.1' as const,port:4321}};
  for(const value of [1,10])assert.equal(validateConfiguration({...base,max_concurrent_generations:value}).max_concurrent_generations,value);
  for(const value of [0,11,2.5,'3'])assert.throws(()=>validateConfiguration({...base,max_concurrent_generations:value}),{code:'VALIDATION_ERROR'});
  assert.equal((await new Settings(f.context).get(f.request())).max_concurrent_generations,5);
  assert.equal((await new Settings({...f.context,config:{...base,max_concurrent_generations:2}}).get(f.request())).max_concurrent_generations,2);
 }finally{f.cleanup();}
});
test('F4 槽位被占满时排队任务5秒内不新增attempt/事件，释放后领取且attempt_no从1开始',async()=>{
 const f=controlled(2,true),held=[0,1].map(index=>acquire(f.locks,f.context.identity.workspace_id,'claude',{pool:2,task_id:'external-'+index,resources:[]})),row=f.enqueue('A');
 const count=(table:string)=>Number(f.context.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE job_id=?`).get(row.job.id)!.n);
 try{const events=count('job_events');f.scheduler.initialize();await delay(5000);
  assert.equal(count('job_attempts'),0);assert.equal(count('job_events'),events);assert.equal(f.jobs.get(f.request(),row.job.id).job.state,'queued');assert(!f.started('A'));
  held.forEach(release=>release());await until(()=>f.started('A'));f.release('A');await until(()=>f.jobs.get(f.request(),row.job.id).job.state==='succeeded');
  const attempts=f.jobs.get(f.request(),row.job.id).attempts;assert.equal(attempts.length,1);assert.equal(attempts[0]!.attempt_no,1);
 }finally{held.forEach(release=>release());await f.stop();}
});
test('F4 预检与领取竞争时的容量退回按连续次数指数退避，上限10秒',async()=>{
 const f=controlled(2),held=[0,1].map(index=>acquire(f.locks,f.context.identity.workspace_id,'claude',{pool:2,task_id:'external-'+index,resources:[]})),row=f.enqueue('A'),cooldown=(f.worker as unknown as {cooldown:Map<string,number>}).cooldown,gaps:number[]=[];
 try{for(let n=0;n<7;n++){const before=Date.now();assert.equal((await f.worker.runOnce())!.state,'queued');gaps.push(cooldown.get(row.job.id)!-before);cooldown.delete(row.job.id);}
  const expected=[500,1000,2000,4000,8000,CAPACITY_BACKOFF_MAX_MS,CAPACITY_BACKOFF_MAX_MS];gaps.forEach((gap,index)=>assert(gap>=expected[index]!&&gap<expected[index]!+1000,`第${index+1}次退避 ${gap}ms`));
  held.forEach(release=>release());const run=f.worker.runOnce();await until(()=>f.started('A'));f.release('A');await run;assert.equal(f.jobs.get(f.request(),row.job.id).job.state,'succeeded');assert.equal((f.worker as unknown as {busyStreak:Map<string,number>}).busyStreak.has(row.job.id),false);
 }finally{held.forEach(release=>release());await f.stop();}
});
