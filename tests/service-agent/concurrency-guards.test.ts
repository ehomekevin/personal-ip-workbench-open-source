import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, execFileSync } from 'node:child_process';
import { fixture, projectRoot, schemaDirectory } from './harness.ts';
import { CodexAdapter } from '../../packages/adapters/src/agent/codex/index.ts';
import { ClaudeAdapter, confirmedStops as claudeStops } from '../../packages/adapters/src/agent/claude/index.ts';
import { acquire, canonical, hash, nativeBindingHash, StopLedger, STOP_PROOF_LIMIT, STOP_PROOF_TTL_MS } from '../../packages/adapters/src/agent/codex/primitives.ts';
import { buildServiceAgentPlan } from '../../packages/domain/src/service-agent/index.ts';
import { createServiceAgentHandlers } from '../../apps/service/src/worker/handlers/agent/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import type { AgentRunInput, AgentRunHandle, AgentResult, JsonObject } from '../../packages/contracts/src/index.ts';
function input():AgentRunInput{return {job_id:randomUUID(),kind:'document_modify',task_instruction:'Return 42',target_document_id:null,base_revision_id:null,input_manifest:{},allowed_tools:[],output_schema:{type:'object',required:['answer'],additionalProperties:false,properties:{answer:{type:'string'}}}};}
async function complete(adapter:CodexAdapter|ClaudeAdapter,handle:AgentRunHandle){let result:AgentResult|undefined;for await(const event of adapter.streamEvents(handle))if('status'in event)result=event;return result;}
function evidence(name:string,value:unknown){if(process.env.C05_EVIDENCE_DIR){mkdirSync(process.env.C05_EVIDENCE_DIR,{recursive:true});writeFileSync(join(process.env.C05_EVIDENCE_DIR,name+'.json'),JSON.stringify(value,null,2)+'\n');}}
for(const operation of ['start','resume'] as const)test(`r4/F1 ${operation}: 五次预spawn认证拒绝后无slot/private泄漏，Codex/Claude均可继续`,async()=>{
 const f=fixture(),locks=join(f.root,'locks'),adapters:Array<CodexAdapter|ClaudeAdapter>=[],original=process.env.CODEX_API_KEY;let spawned=0;
 const options={workspace_id:f.context.identity.workspace_id,cwd:f.staging,lock_root:locks,schema_directory:schemaDirectory,concurrency_slots:5 as const,executable:join(projectRoot,'tests/service-agent/fake-codex.mjs'),sink:(entry:{direction:string})=>{if(entry.direction==='spawn')spawned++;}};
 try{process.env.CODEX_API_KEY='c05-r4-fixture-not-a-credential';for(let index=0;index<5;index++){const a=new CodexAdapter(options);adapters.push(a);const fixed=input(),session=randomUUID(),turn=randomUUID(),handle:AgentRunHandle={runtime_session_id:session,runtime_turn_id:turn,supports_resume:true,checkpoint:{executor_id:'codex',cwd:f.staging,run_input:fixed as unknown as JsonObject,input_hash:hash(canonical(fixed.input_manifest)),runtime_session_id:session,runtime_turn_id:turn}};
   Object.assign(handle.checkpoint,{workspace_id:f.context.identity.workspace_id,run_input_hash:hash(canonical(fixed))});handle.checkpoint.native_binding_hash=nativeBindingHash(handle.checkpoint);
   await assert.rejects(operation==='start'?a.start(fixed):a.resume(handle,{}),{code:'AUTH_REQUIRED'});await a.close();assert.equal(readdirSync(locks).length,0);const dirs=join(f.staging,'.workbench-runs');if(existsSync(dirs))assert.equal(readdirSync(dirs).length,0);}
  assert.equal(spawned,0);if(original===undefined)delete process.env.CODEX_API_KEY;else process.env.CODEX_API_KEY=original;
  const a=new CodexAdapter(options),b=new ClaudeAdapter({...options,executable:join(projectRoot,'tests/service-agent/fake-claude.mjs')});adapters.push(a,b);const h=await a.start(input());assert.equal((await complete(a,h))!.status,'completed');await a.close();const k=await b.start(input());assert.equal((await complete(b,k))!.status,'completed');await b.close();assert.equal(readdirSync(locks).length,0);assert.equal(readdirSync(join(f.staging,'.workbench-runs')).length,0);
  evidence('pre-spawn-'+operation,{task:'EXECUTOR-CONCURRENCY-05/r4',failures:5,failed_attempt_native_children:0,leftover_slots:0,leftover_private_directories:0,subsequent_codex:'completed',subsequent_claude:'completed'});
 }finally{if(original===undefined)delete process.env.CODEX_API_KEY;else process.env.CODEX_API_KEY=original;await Promise.all(adapters.map(a=>a.close()));f.cleanup();}
});
test('r4/F1 清理失败attempt不释放另一个活child或它的private目录',async()=>{
 const f=fixture(),locks=join(f.root,'locks'),original=process.env.CODEX_API_KEY,options={workspace_id:f.context.identity.workspace_id,cwd:f.staging,lock_root:locks,schema_directory:schemaDirectory,concurrency_slots:5 as const,executable:join(projectRoot,'tests/service-agent/fake-codex.mjs')},a=new CodexAdapter(options);process.env.WP15_FAKE_MODE='slow';try{const h=await a.start(input()),slot=readdirSync(locks).find(name=>/\.slot-\d\.lock$/.test(name))!,before=readFileSync(join(locks,slot),'utf8'),directories=readdirSync(join(f.staging,'.workbench-runs'));process.env.CODEX_API_KEY='c05-r4-fixture-not-a-credential';for(let index=0;index<5;index++){const rejected=new CodexAdapter(options);await assert.rejects(rejected.start(input()),{code:'AUTH_REQUIRED'});await rejected.close();assert.equal(readFileSync(join(locks,slot),'utf8'),before);assert.deepEqual(readdirSync(join(f.staging,'.workbench-runs')),directories);assert.equal(readdirSync(locks).filter(name=>/\.slot-\d\.lock$/.test(name)).length,1);}if(original===undefined)delete process.env.CODEX_API_KEY;else process.env.CODEX_API_KEY=original;await a.cancel(h);await assert.rejects(complete(a,h),{code:'HOST_INTERRUPTED'});await a.close();assert.equal(readdirSync(locks).length,0);}finally{if(original===undefined)delete process.env.CODEX_API_KEY;else process.env.CODEX_API_KEY=original;delete process.env.WP15_FAKE_MODE;await a.close();f.cleanup();}
});
// 裁决变更（F5）：spawn 后构造异常不再保留 child/slot/private，而是终止该 child、确认退出后释放。
test('r4/F1 schema构造失败明确无child可清理；spawn后构造异常终止child并释放slot/private',async()=>{
 const f=fixture(),locks=join(f.root,'locks'),badSchemas=join(f.root,'bad-schemas');mkdirSync(join(badSchemas,'v2'),{recursive:true});writeFileSync(join(badSchemas,'v2','ThreadStartParams.json'),'{}');const options={workspace_id:f.context.identity.workspace_id,cwd:f.staging,lock_root:locks,schema_directory:badSchemas,concurrency_slots:5 as const,executable:join(projectRoot,'tests/service-agent/fake-codex.mjs')};const a=new CodexAdapter(options);let pid:number|undefined;
 try{await assert.rejects(a.start(input()),{code:'INPUT_STALE'});await a.close();assert.equal(readdirSync(locks).length,0);assert.equal(readdirSync(join(f.staging,'.workbench-runs')).length,0);
  const b=new CodexAdapter({...options,schema_directory:schemaDirectory,sink:entry=>{if(entry.direction==='spawn'){pid=(entry.message as JsonObject).pid as number;throw new Error('controlled post-spawn construction fault');}}});const fixed=input();await assert.rejects(b.start(fixed),/controlled post-spawn/);await b.close();assert(pid);assert.throws(()=>process.kill(pid!,0),{code:'ESRCH'},'构造失败的child已被终止');assert.equal(readdirSync(locks).length,0);assert.equal(readdirSync(join(f.staging,'.workbench-runs')).length,0);const next=acquire(locks,f.context.identity.workspace_id,'claude',{capacity:5,task_id:fixed.job_id});next();
 }finally{if(pid){try{process.kill(pid,'SIGTERM');}catch{/* F5 后child应已被终止。 */}for(let n=0;n<100;n++){try{process.kill(pid,0);}catch{pid=undefined;break;}await delay(10);}assert.equal(pid,undefined,'本fixture创建的child应已退出');}await a.close();f.cleanup();}
});
test('r4/F2 生产worker拒绝拼接native身份/input/target，原A completed仍零重复turn正确落库',async()=>{
 const f=fixture(),control=join(f.staging,'control'),locks=join(f.root,'locks'),adapters:CodexAdapter[]=[],sent:Array<{method?:string}>=[];mkdirSync(control);
 const create=()=>{const a=new CodexAdapter({workspace_id:f.context.identity.workspace_id,cwd:f.staging,lock_root:locks,schema_directory:schemaDirectory,concurrency_slots:5,timeout_ms:3000,executable:join(projectRoot,'tests/service-agent/concurrency-fixture-codex.mjs'),sink:entry=>{if(entry.direction==='send')sent.push(entry.message as {method?:string});}});adapters.push(a);return a;};
 try{const queued=f.enqueue('codex',JSON.stringify({root:control,label:'A',mode:'success'})),first=f.jobs.claim('initial')!,plan=buildServiceAgentPlan(f.context,first,{staging_root:f.staging}),a=create(),handleA=await a.start(plan.input);writeFileSync(join(control,'A.release'),'release');await complete(a,handleA);await a.close();const other=structuredClone(plan.input);other.job_id=randomUUID();other.task_instruction=JSON.stringify({root:control,label:'B',mode:'success'});((other.input_manifest.frozen as JsonObject).service_agent as JsonObject).task_instruction=other.task_instruction;const b=create(),handleB=await b.start(other);writeFileSync(join(control,'B.release'),'release');await complete(b,handleB);await b.close();
  const cases:Array<{name:string;mutate(handle:AgentRunHandle):void;code:string}>=[
   {name:'outer_session',code:'INPUT_STALE',mutate:h=>{h.runtime_session_id=handleB.runtime_session_id;}},
   {name:'outer_turn',code:'INPUT_STALE',mutate:h=>{h.runtime_turn_id=handleB.runtime_turn_id;}},
   {name:'outer_pair',code:'INPUT_STALE',mutate:h=>{h.runtime_session_id=handleB.runtime_session_id;h.runtime_turn_id=handleB.runtime_turn_id;}},
   {name:'inner_and_outer_pair',code:'INPUT_STALE',mutate:h=>{h.runtime_session_id=handleB.runtime_session_id;h.runtime_turn_id=handleB.runtime_turn_id;h.checkpoint.runtime_session_id=handleB.runtime_session_id;h.checkpoint.runtime_turn_id=handleB.runtime_turn_id!;}},
   {name:'executor',code:'INPUT_STALE',mutate:h=>{h.checkpoint.executor_id='claude';}},
   {name:'workspace',code:'INPUT_STALE',mutate:h=>{h.checkpoint.workspace_id=randomUUID();}},
   {name:'job_id',code:'INPUT_STALE',mutate:h=>{(h.checkpoint.run_input as JsonObject).job_id=randomUUID();}},
   {name:'target',code:'INPUT_STALE',mutate:h=>{(h.checkpoint.run_input as JsonObject).target_document_id=randomUUID();}},
   {name:'manifest_hash',code:'INPUT_STALE',mutate:h=>{h.checkpoint.input_hash='changed';}},
   {name:'missing_new_binding',code:'RESULT_UNKNOWN',mutate:h=>{delete h.checkpoint.native_binding_hash;}},
   {name:'missing_full_input_hash',code:'RESULT_UNKNOWN',mutate:h=>{delete h.checkpoint.run_input_hash;}},
   {name:'missing_original_session',code:'RESULT_UNKNOWN',mutate:h=>{delete h.checkpoint.runtime_session_id;}},
   {name:'legacy_missing_binding',code:'RESULT_UNKNOWN',mutate:h=>{delete h.checkpoint.workspace_id;delete h.checkpoint.run_input_hash;delete h.checkpoint.native_binding_hash;}},
   {name:'legacy_binding_removed_and_pair_swapped',code:'RESULT_UNKNOWN',mutate:h=>{delete h.checkpoint.workspace_id;delete h.checkpoint.run_input_hash;delete h.checkpoint.native_binding_hash;h.runtime_session_id=handleB.runtime_session_id;h.runtime_turn_id=handleB.runtime_turn_id;h.checkpoint.runtime_session_id=handleB.runtime_session_id;h.checkpoint.runtime_turn_id=handleB.runtime_turn_id!;}},
  ];
  for(const key of ['job_id','task_instruction','output_schema'] as const){const forged=structuredClone(handleA),fixed=forged.checkpoint.run_input as JsonObject;fixed[key]=key==='output_schema'?{type:'object'}:'changed-'+key;const reader=create(),before=sent.length;await assert.rejects(reader.resume(forged,{}),{code:'INPUT_STALE'});await reader.close();assert.equal(sent.length,before,'完整input在直接adapter查询前拒收');}
  const outcomes:unknown[]=[];let claim=first;
  for(const item of cases){const forged=structuredClone(handleA);item.mutate(forged);f.jobs.checkpoint(claim.fence,{executor_id:'codex',fixed_input_hash:plan.fixed_input_hash,agent_handle:forged as unknown as JsonObject,pre_submit_failure:false});const waiting=f.jobs.fail(claim.fence,{code:'QUOTA_EXHAUSTED'},'waiting_quota');f.jobs.resume(f.request(),queued.id,{expected_version:waiting.version});const before=sent.length,worker=new DurableWorker(f.context,createServiceAgentHandlers(f.context,{staging_root:f.staging,createAdapter:create}));assert.equal((await worker.runOnce())!.state,'failed');const after=f.jobs.get(f.request(),queued.id);assert.equal(after.error!.code,item.code,item.name);assert.equal(sent.length,before,item.name+'应在原生查询前拒收');assert.equal(f.context.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE job_id=?').get(queued.id)!.n,0);outcomes.push({case:item.name,code:after.error!.code,native_queries:0,new_turns:0,candidates:0});f.jobs.resume(f.request(),queued.id,{expected_version:after.job.version});claim=f.jobs.claim('seed-next')!;}
  f.jobs.checkpoint(claim.fence,{executor_id:'codex',fixed_input_hash:plan.fixed_input_hash,agent_handle:handleA as unknown as JsonObject,pre_submit_failure:false});const waiting=f.jobs.fail(claim.fence,{code:'QUOTA_EXHAUSTED'},'waiting_quota');f.jobs.resume(f.request(),queued.id,{expected_version:waiting.version});const worker=new DurableWorker(f.context,createServiceAgentHandlers(f.context,{staging_root:f.staging,createAdapter:create}));assert.equal((await worker.runOnce())!.state,'committed');const after=f.jobs.get(f.request(),queued.id),files=f.context.db.prepare('SELECT path FROM write_intents WHERE job_id=?').all(queued.id).map(row=>readFileSync(String(row.path),'utf8'));assert.equal(files.length,1);assert(files[0].includes('候选 A'));assert(!files[0].includes('候选 B'));assert.equal(after.attempts.at(-1)!.runtime_session_id,handleA.runtime_session_id);assert.equal(after.attempts.at(-1)!.runtime_turn_id,handleA.runtime_turn_id);assert.equal(sent.filter(message=>message.method==='turn/start').length,2);
  evidence('swapped-native-identity',{task:'EXECUTOR-CONCURRENCY-05/r4',outcomes,original_a:handleA,other_b:handleB,legitimate_result:after.job.state,files,setup_turns:2,recovery_new_turns:0});
 }finally{await Promise.all(adapters.map(a=>a.close()));f.cleanup();}
});
test('r4/F2 同manifest不同job/schema/input及Claude停止证明不能互换',async()=>{
 const f=fixture(),locks=join(f.root,'locks'),options={workspace_id:f.context.identity.workspace_id,cwd:f.staging,lock_root:locks,schema_directory:schemaDirectory,concurrency_slots:5 as const,executable:join(projectRoot,'tests/service-agent/fake-claude.mjs')},a=new ClaudeAdapter(options),b=new ClaudeAdapter(options);process.env.WP15_FAKE_CLAUDE_MODE='slow';try{const fixed=input(),h=await a.start(fixed);await a.cancel(h);await assert.rejects(complete(a,h),{code:'HOST_INTERRUPTED'});await a.close();const cases=[(copy:AgentRunHandle)=>{(copy.checkpoint.run_input as JsonObject).job_id=randomUUID();},(copy:AgentRunHandle)=>{(copy.checkpoint.run_input as JsonObject).task_instruction='different instruction';},(copy:AgentRunHandle)=>{(copy.checkpoint.run_input as JsonObject).output_schema={type:'object'};},(copy:AgentRunHandle)=>{copy.runtime_turn_id=randomUUID();}];for(const mutate of cases){const copy=structuredClone(h);mutate(copy);await assert.rejects(b.resume(copy,{}),{code:'INPUT_STALE'});assert.equal(readdirSync(locks).length,0);}delete process.env.WP15_FAKE_CLAUDE_MODE;const next=await b.resume(structuredClone(h),{});assert.equal(next.runtime_session_id,h.runtime_session_id);await complete(b,next);await b.close();}finally{delete process.env.WP15_FAKE_CLAUDE_MODE;await a.close();await b.close();f.cleanup();}
});
test('r4/F2 Claude init无turn只凭本进程完整停止证明恢复，旧缺身份/活任务不能猜测',async()=>{
 const f=fixture(),locks=join(f.root,'locks'),options={workspace_id:f.context.identity.workspace_id,cwd:f.staging,lock_root:locks,concurrency_slots:5 as const,executable:join(projectRoot,'tests/service-agent/concurrency-fixture-claude-init.mjs')},a=new ClaudeAdapter(options),b=new ClaudeAdapter(options),c=new ClaudeAdapter(options);try{const h=await a.start(input());assert.equal(h.runtime_turn_id,undefined);await a.cancel(h);await assert.rejects(complete(a,h),{code:'HOST_INTERRUPTED'});await a.close();const next=await b.resume(structuredClone(h),{});assert.equal(next.runtime_session_id,h.runtime_session_id);await assert.rejects(c.resume(structuredClone(h),{}),{code:'RESULT_UNKNOWN'});await b.close();const missing=structuredClone(next);delete missing.checkpoint.runtime_session_id;await assert.rejects(c.resume(missing,{}),{code:'RESULT_UNKNOWN'});assert.equal(readdirSync(locks).length,0);}finally{await a.close();await b.close();await c.close();f.cleanup();}
});
test('r4/F2 Claude readiness等待中修改调用方handle不能更换恢复session/input',async()=>{
 const f=fixture(),locks=join(f.root,'locks'),spawned:JsonObject[]=[],options={workspace_id:f.context.identity.workspace_id,cwd:f.staging,lock_root:locks,concurrency_slots:5 as const,executable:join(projectRoot,'tests/service-agent/fake-claude.mjs')},a=new ClaudeAdapter(options),b=new ClaudeAdapter({...options,sink:entry=>{if(entry.direction==='spawn')spawned.push(entry.message as JsonObject);}});
 try{process.env.WP15_FAKE_CLAUDE_MODE='slow';const h=await a.start(input());await a.cancel(h);await assert.rejects(complete(a,h),{code:'HOST_INTERRUPTED'});await a.close();delete process.env.WP15_FAKE_CLAUDE_MODE;
  let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;}),readiness=b.checkReadiness.bind(b);b.checkReadiness=async()=>{entered();await gate;return readiness();};
  const caller=structuredClone(h),pending=b.resume(caller,{});await waiting;const swapped=randomUUID();caller.runtime_session_id=swapped;caller.checkpoint.runtime_session_id=swapped;(caller.checkpoint.run_input as JsonObject).job_id=randomUUID();release();const recovered=await pending;assert.equal(recovered.runtime_session_id,h.runtime_session_id);assert.equal((recovered.checkpoint.run_input as JsonObject).job_id,(h.checkpoint.run_input as JsonObject).job_id);assert.equal((await complete(b,recovered))!.status,'completed');assert.equal(spawned.length,1);const args=spawned[0].args as string[];assert.equal(args[args.indexOf('--resume')+1],h.runtime_session_id);await b.close();assert.equal(readdirSync(locks).length,0);
  evidence('claude-readiness-handle-snapshot',{task:'EXECUTOR-CONCURRENCY-05/r4',original_session:h.runtime_session_id,caller_changed_session:swapped,resumed_session:recovered.runtime_session_id,spawn_resume_session:args[args.indexOf('--resume')+1],result:'completed',caller_mutation_ignored:true});
 }finally{delete process.env.WP15_FAKE_CLAUDE_MODE;await a.close();await b.close();f.cleanup();}
});
function controlled(control:string,label:string):AgentRunInput{return {job_id:randomUUID(),kind:'document_modify',task_instruction:JSON.stringify({root:control,label,mode:'success'}),target_document_id:'doc-'+label,base_revision_id:null,input_manifest:{frozen:{targets:[{document_id:'doc-'+label,base_revision_id:null}]}},allowed_tools:[],output_schema:{type:'object'}};}
for(const executor of ['codex','claude'] as const)test(`F1 ${executor}: 退出清理写槽位 ENOSPC 只记录并留待核对，另一任务完成且无未处理拒绝`,async()=>{
 const f=fixture(),locks=join(f.root,'locks'),control=join(f.staging,'control'),faults:unknown[]=[],unhandled:unknown[]=[];mkdirSync(control);
 const onRejection=(reason:unknown)=>{unhandled.push(reason);},onException=(error:unknown)=>{unhandled.push(error);};process.on('unhandledRejection',onRejection);process.on('uncaughtException',onException);
 const options={workspace_id:f.context.identity.workspace_id,cwd:f.staging,lock_root:locks,schema_directory:schemaDirectory,concurrency_slots:5 as const,timeout_ms:5000,sink:(entry:{direction:string;message:unknown})=>{if(entry.direction==='cleanup_error')faults.push(entry.message);}};
 const a=executor==='codex'?new CodexAdapter({...options,executable:join(projectRoot,'tests/service-agent/concurrency-fixture-codex.mjs')}):new ClaudeAdapter({...options,executable:join(projectRoot,'tests/service-agent/concurrency-fixture-claude.mjs')});
 try{const ha=await a.start(controlled(control,'A')),hb=await a.start(controlled(control,'B'));
  const internal=a as unknown as {runs:Map<string,{slot:{childExited():void}}>|Set<{handle:AgentRunHandle;release:{childExited():void};done:Promise<void>}>};
  const slotA=executor==='codex'?(internal.runs as Map<string,{slot:{childExited():void}}>).get(ha.runtime_turn_id!)!.slot:[...(internal.runs as Set<{handle:AgentRunHandle;release:{childExited():void};done:Promise<void>}>)].find(run=>run.handle===ha)!.release;
  const before=new Set(readdirSync(locks).filter(name=>/\.slot-\d\.lock$/.test(name)));assert.equal(before.size,2);
  const tokenA=[...before].find(name=>JSON.parse(readFileSync(join(locks,name),'utf8')).task_id===(ha.checkpoint.run_input as JsonObject).job_id)!;
  slotA.childExited=()=>{throw Object.assign(new Error('ENOSPC: no space left on device, write'),{code:'ENOSPC'});};
  writeFileSync(join(control,'A.release'),'release');assert.equal((await complete(a,ha))!.status,'completed');
  if(executor==='claude')await [...(internal.runs as Set<{handle:AgentRunHandle;done:Promise<void>}>)].find(run=>run.handle===ha)!.done;
  for(let n=0;n<200&&!faults.length;n++)await delay(10);
  writeFileSync(join(control,'B.release'),'release');assert.equal((await complete(a,hb))!.status,'completed');
  for(let n=0;n<200&&readdirSync(locks).filter(name=>/\.slot-\d\.lock$/.test(name)).length>1;n++)await delay(10);
  const left=readdirSync(locks).filter(name=>/\.slot-\d\.lock$/.test(name));assert.deepEqual(left,[tokenA],'仅失败任务槽位保留');
  const record=JSON.parse(readFileSync(join(locks,tokenA),'utf8'));assert.equal(record.child_state,'unverified');assert.equal(record.unverified_reason,'cleanup_failed');
  assert(faults.some(fault=>(fault as JsonObject).step==='child_exited'&&(fault as JsonObject).code==='ENOSPC'));
  await a.close();await delay(20);assert.deepEqual(unhandled,[]);
 }finally{process.off('unhandledRejection',onRejection);process.off('uncaughtException',onException);await a.close();f.cleanup();}
});
test('F5 Claude spawn后登记失败：终止child、释放slot与private目录，后续任务可领取',async()=>{
 const f=fixture(),locks=join(f.root,'locks');let pid:number|undefined;const a=new ClaudeAdapter({workspace_id:f.context.identity.workspace_id,cwd:f.staging,lock_root:locks,concurrency_slots:5,executable:join(projectRoot,'tests/service-agent/fake-claude.mjs'),sink:entry=>{if(entry.direction==='spawn'){pid=(entry.message as JsonObject).pid as number;throw new Error('controlled post-spawn registration fault');}}});process.env.WP15_FAKE_CLAUDE_MODE='slow';
 try{const fixed=input();await assert.rejects(a.start(fixed),/controlled post-spawn registration fault/);assert(pid);assert.throws(()=>process.kill(pid!,0),{code:'ESRCH'});assert.equal(readdirSync(locks).length,0);assert.equal(readdirSync(join(f.staging,'.workbench-runs')).length,0);const next=acquire(locks,f.context.identity.workspace_id,'codex',{capacity:5,task_id:fixed.job_id});next();assert.equal(readdirSync(locks).length,0);
 }finally{delete process.env.WP15_FAKE_CLAUDE_MODE;if(pid)try{process.kill(pid,'SIGKILL');}catch{}await a.close();f.cleanup();}
});
test('F6 停止证明超过条数上限淘汰最旧，超过TTL不再返回',()=>{
 const ledger=new StopLedger();let now=1_000;ledger.now=()=>now;
 for(let index=0;index<=STOP_PROOF_LIMIT;index++)ledger.set('turn-'+index,'proof-'+index);
 assert.equal(ledger.size,STOP_PROOF_LIMIT);assert.equal(ledger.get('turn-0'),undefined);assert.equal(ledger.get('turn-1'),'proof-1');assert.equal(ledger.get('turn-'+STOP_PROOF_LIMIT),'proof-'+STOP_PROOF_LIMIT);
 now+=STOP_PROOF_TTL_MS-1;assert.equal(ledger.get('turn-1'),'proof-1');now+=1;assert.equal(ledger.get('turn-1'),undefined);assert.equal(ledger.size,0);
});
test('F6 Claude停止证明过期后恢复走unknown，不提交新调用',async()=>{
 const f=fixture(),locks=join(f.root,'locks'),spawned:unknown[]=[],options={workspace_id:f.context.identity.workspace_id,cwd:f.staging,lock_root:locks,concurrency_slots:5 as const,executable:join(projectRoot,'tests/service-agent/fake-claude.mjs')},a=new ClaudeAdapter(options),b=new ClaudeAdapter({...options,sink:entry=>{if(entry.direction==='spawn')spawned.push(entry.message);}}),clock=claudeStops.now;let shift=0;claudeStops.now=()=>Date.now()+shift;process.env.WP15_FAKE_CLAUDE_MODE='slow';
 try{const h=await a.start(input());await a.cancel(h);await assert.rejects(complete(a,h),{code:'HOST_INTERRUPTED'});await a.close();shift=STOP_PROOF_TTL_MS+1;
  await assert.rejects(b.resume(structuredClone(h),{}),{code:'RESULT_UNKNOWN'});assert.equal(spawned.length,0);assert.equal(readdirSync(locks).length,0);
 }finally{claudeStops.now=clock;delete process.env.WP15_FAKE_CLAUDE_MODE;await a.close();await b.close();f.cleanup();}
});
test('F1 生产诊断：bootstrap 适配器 sink 只把 cleanup_error 写成带 slot 与错误码的结构化日志',async()=>{
 const { executorDiagnostics, nativeAdapter } = await import('../../apps/service/src/bootstrap/execution.ts');
 const f=fixture(),locks=join(f.root,'locks'),control=join(f.staging,'control'),lines:string[]=[];mkdirSync(control);
 const wired=nativeAdapter(f.context.identity.workspace_id,f.context.paths.state_root,'codex') as unknown as CodexAdapter;assert.equal(typeof wired.options.sink,'function','bootstrap 默认接上诊断 sink');
 const a=new CodexAdapter({workspace_id:f.context.identity.workspace_id,cwd:f.staging,lock_root:locks,schema_directory:schemaDirectory,concurrency_slots:5,timeout_ms:5000,executable:join(projectRoot,'tests/service-agent/concurrency-fixture-codex.mjs'),sink:executorDiagnostics('codex',line=>{lines.push(line);})});
 try{const h=await a.start(controlled(control,'A')),slot=(a as unknown as {runs:Map<string,{slot:{id:string;childExited():void}}>}).runs.get(h.runtime_turn_id!)!.slot;
  slot.childExited=()=>{throw Object.assign(new Error('ENOSPC: no space left on device, write'),{code:'ENOSPC'});};
  writeFileSync(join(control,'A.release'),'release');await complete(a,h);for(let n=0;n<200&&!lines.length;n++)await delay(10);await delay(50);
  assert.equal(lines.length,1,'普通 send/receive/spawn trace 不进日志');const record=JSON.parse(lines[0]!);
  assert.equal(record.event,'executor_cleanup_error');assert.equal(record.executor,'codex');assert.equal(record.detail.code,'ENOSPC');assert.equal(record.detail.step,'child_exited');assert.equal(record.detail.slot,slot.id);assert.match(record.detail.slot,/\.slot-\d\.lock$/);
 }finally{await a.close();f.cleanup();}
});
test('r2 Codex启动失败路径清理写槽位失败：原异常原样抛出、cleanup_error记录、槽位待核对、私有目录清理',async()=>{
 const f=fixture(),locks=join(f.root,'locks'),faults:JsonObject[]=[],unhandled:unknown[]=[],onRejection=(reason:unknown)=>{unhandled.push(reason);};process.on('unhandledRejection',onRejection);process.env.WP15_FAKE_MODE='wrong_provider';
 const tamper=()=>{const name=readdirSync(locks).find(item=>/\.slot-\d\.lock$/.test(item))!,path=join(locks,name),record=JSON.parse(readFileSync(path,'utf8'));writeFileSync(path,JSON.stringify({...record,token:'tampered-by-test'}));};
 const a=new CodexAdapter({workspace_id:f.context.identity.workspace_id,cwd:f.staging,lock_root:locks,schema_directory:schemaDirectory,concurrency_slots:5,executable:join(projectRoot,'tests/service-agent/fake-codex.mjs'),sink:entry=>{if(entry.direction==='spawn')tamper();if(entry.direction==='cleanup_error')faults.push(entry.message as JsonObject);}});
 try{await assert.rejects(a.start(input()),{code:'AUTH_REQUIRED'});await delay(20);
  assert(faults.some(fault=>fault.step==='child_exited'&&fault.code==='HOST_RUN_NOT_CURRENT'&&/\.slot-\d\.lock$/.test(String(fault.slot))));
  assert.equal(readdirSync(join(f.staging,'.workbench-runs')).length,0);assert.equal(readdirSync(locks).filter(name=>/\.slot-\d\.lock$/.test(name)).length,1,'写失败的槽位不假装释放');assert.deepEqual(unhandled,[]);
 }finally{process.off('unhandledRejection',onRejection);delete process.env.WP15_FAKE_MODE;await a.close();f.cleanup();}
});
test('r3 领取后槽位状态写入遇互斥超时：报提交状态未知，不带pre_submit/容量忙，worker不重排队不二次启动',async()=>{
 const { stateUnknown, poolMutexPath } = await import('../../packages/adapters/src/agent/codex/primitives.ts');
 const f=fixture(),locks=join(f.root,'locks'),slot=acquire(locks,f.context.identity.workspace_id,'claude',{pool:1,task_id:'held'});
 const holder=spawn(process.execPath,['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.send('held');setInterval(()=>{},1000);",poolMutexPath(locks)],{stdio:['ignore','ignore','pipe','ipc']});
 try{await new Promise(resolve=>holder.once('message',resolve));
  let fault:unknown;try{slot.bindChild(process.pid);}catch(error){fault=error;}
  assert.equal((fault as {code:string}).code,'RESULT_UNKNOWN');const details=(fault as {details:JsonObject}).details;assert.equal(details.pre_submit_failure,undefined);assert.equal(details.executor_capacity_busy,undefined);
  assert.throws(()=>acquire(locks,f.context.identity.workspace_id,'codex',{pool:2,task_id:'other'}),(error:{code:string;details:JsonObject})=>error.code==='CAPABILITY_UNVERIFIED'&&error.details.pre_submit_failure===true,'领取前互斥超时仍是容量忙');
  holder.kill('SIGKILL');await new Promise(resolve=>holder.once('exit',resolve));
  let starts=0;const queued=f.enqueue('claude'),adapter={start:async()=>{starts++;throw stateUnknown('claude');},close:async()=>{}} as unknown as CodexAdapter;
  const worker=new DurableWorker(f.context,createServiceAgentHandlers(f.context,{staging_root:f.staging,createAdapter:()=>adapter as never}));
  assert.equal((await worker.runOnce())!.state,'failed');const job=f.jobs.get(f.request(),queued.id);assert.equal(job.job.state,'failed');assert.equal(job.error!.code,'RESULT_UNKNOWN');
  assert.equal(await worker.runOnce(),null);assert.equal(starts,1,'不二次启动');
 }finally{if(holder.exitCode===null&&holder.signalCode===null)holder.kill('SIGKILL');slot();f.cleanup();}
});
test('r4 互斥损坏投影到/health（degraded+pool_mutex_broken）并写一行带恢复说明的日志',async()=>{
 const { createExecutionModule } = await import('../../apps/service/src/bootstrap/execution.ts');
 const { poolAvailable, poolMutexPath } = await import('../../packages/adapters/src/agent/codex/primitives.ts');
 const f=fixture(),lines:string[]=[],module=createExecutionModule(f.context,{log:line=>{lines.push(line);}}),locks=join(f.context.paths.state_root,'executor-locks'),workspace=f.context.identity.workspace_id;
 try{assert.equal((await module.health()).status,'ready');assert.equal(poolAvailable(locks,workspace,{pool:5}),true);
  rmSync(poolMutexPath(locks));writeFileSync(poolMutexPath(locks),'');
  assert.equal(poolAvailable(locks,workspace,{pool:5}),false);
  const health=(await module.health()) as unknown as {status:string;details:JsonObject};assert.equal(health.status,'degraded');assert.equal(health.details.degraded_reason,'pool_mutex_broken');assert.equal(health.details.pool_mutex,'broken');
  assert.equal(lines.length,1);const record=JSON.parse(lines[0]!);assert.equal(record.event,'executor_cleanup_error');assert.equal(record.executor,'pool');assert.equal(record.detail.step,'pool_mutex_broken');assert.match(record.detail.recovery,/重启服务/);
  assert.equal(poolAvailable(locks,workspace,{pool:5}),false);assert.equal(lines.length,1,'同一损坏只记一次');
 }finally{await module.close?.();f.cleanup();}
});
test('r4 结算时互斥被占：槽位进待结算队列并记日志，释放后下一次领取先补结算、槽位被释放',async()=>{
 const { settleSlot, poolMutexPath, onPoolDiagnostic, pendingSettlementCount } = await import('../../packages/adapters/src/agent/codex/primitives.ts');
 const f=fixture(),locks=join(f.root,'locks'),workspace=f.context.identity.workspace_id,traces:JsonObject[]=[],pool:JsonObject[]=[],stop=onPoolDiagnostic(entry=>pool.push(entry.message as JsonObject));
 const slot=acquire(locks,workspace,'claude',{pool:1,task_id:'exited-job'}),privateDir=join(f.root,'private');mkdirSync(privateDir);
 const holder=spawn(process.execPath,['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.send('held');setInterval(()=>{},1000);",poolMutexPath(locks)],{stdio:['ignore','ignore','pipe','ipc']});
 try{await new Promise(resolve=>holder.once('message',resolve));
  settleSlot(slot,entry=>traces.push(entry.message as JsonObject),'exited-job',privateDir);
  assert(traces.some(t=>t.step==='child_exited'&&t.code==='RESULT_UNKNOWN'));assert(pool.some(p=>p.step==='pending_settlement'&&p.outcome==='queued'&&String(p.recovery).includes(slot.id)&&/重启服务/.test(String(p.recovery))));assert.equal(pendingSettlementCount(locks),1);
  assert.equal(readdirSync(locks).filter(name=>/\.slot-\d\.lock$/.test(name)).length,1,'超时时槽位尚未释放');assert(!existsSync(privateDir));
  holder.kill('SIGKILL');await new Promise(resolve=>holder.once('exit',resolve));
  const next=acquire(locks,workspace,'codex',{pool:1,task_id:'next-job'});
  assert.equal(pendingSettlementCount(locks),0);assert(pool.some(p=>p.step==='pending_settlement'&&p.outcome==='settled'));
  const slots=readdirSync(locks).filter(name=>/\.slot-\d\.lock$/.test(name));assert.equal(slots.length,1);assert.equal(JSON.parse(readFileSync(join(locks,slots[0]!),'utf8')).task_id,'next-job');next();
 }finally{stop();if(holder.exitCode===null&&holder.signalCode===null)holder.kill('SIGKILL');f.cleanup();}
});
test('r5 真实写盘失败（锁目录只读）：保留原错误码，槽位转待核对、不入待结算队列，有cleanup_error日志',async()=>{
 const { settleSlot, pendingSettlementCount } = await import('../../packages/adapters/src/agent/codex/primitives.ts');
 const { chmodSync } = await import('node:fs');
 const f=fixture(),locks=join(f.root,'locks'),traces:JsonObject[]=[],slot=acquire(locks,f.context.identity.workspace_id,'claude',{pool:1,task_id:'write-fail'});
 try{slot.bindChild(2147483646);const before=pendingSettlementCount();chmodSync(locks,0o500);
  settleSlot(slot,entry=>traces.push(entry.message as JsonObject),'write-fail');chmodSync(locks,0o700);
  assert(traces.some(t=>t.step==='child_exited'&&t.code==='EACCES'),JSON.stringify(traces));assert.equal(pendingSettlementCount(),before,'写盘错误不入待结算队列');
  const name=readdirSync(locks).find(n=>/\.slot-\d\.lock$/.test(n))!;assert(name,'槽位未被假装释放');
  slot();assert(existsSync(join(locks,name)),'待核对槽位 release 不生效');
  assert.throws(()=>acquire(locks,f.context.identity.workspace_id,'codex',{pool:1,task_id:'next'}),{code:'CAPABILITY_UNVERIFIED'});
 }finally{try{(await import('node:fs')).chmodSync(locks,0o700);}catch{}f.cleanup();}
});
test('r5 进程退出时待结算队列非空：写一行 unsettled_at_exit 列出槽位与恢复步骤',async()=>{
 const script=`import {settleSlot,stateUnknown,onPoolDiagnostic} from ${JSON.stringify(join(projectRoot,'packages/adapters/src/agent/codex/primitives.ts'))};
onPoolDiagnostic(entry=>process.stdout.write(JSON.stringify(entry.message)+'\\n'));
const slot=Object.assign(()=>{},{id:'abc.slot-3.lock',childExited(){throw stateUnknown('claude');},markUnverified(){},starting(){},bindChild(){}});
Object.defineProperty(slot,'deferredSettlement',{value:{root:'/tmp/executor-locks',settle(){}}});settleSlot(slot,undefined,'exit-job');`;
 const output=execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'}).trim().split('\n').map(line=>JSON.parse(line) as JsonObject);
 assert(output.some(e=>e.outcome==='queued'));const last=output.find(e=>e.outcome==='unsettled_at_exit')!;assert(last,'退出时有记录');assert.deepEqual(last.slots,['executor-locks/abc.slot-3.lock']);assert.match(String(last.recovery),/重启服务/);
});
test('Claude 进程先退出、stdout 后读完：等 close 再判终态，结果不被当作未知，槽位释放',async()=>{
 const f=fixture(),locks=join(f.root,'locks'),a=new ClaudeAdapter({workspace_id:f.context.identity.workspace_id,cwd:f.staging,lock_root:locks,concurrency_slots:5,executable:join(projectRoot,'tests/service-agent/claude-late-stdout-fixture.mjs')});
 try{const h=await a.start(input());const result=await complete(a,h);assert.equal(result!.status,'completed');await a.close();assert.equal(readdirSync(locks).filter(file=>file.endsWith('.lock')).length,0);}finally{await a.close();f.cleanup();}
});
