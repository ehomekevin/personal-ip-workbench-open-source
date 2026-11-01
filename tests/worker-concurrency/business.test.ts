import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture as serviceFixture, projectRoot } from '../service-agent/harness.ts';
import { fixture as contentFixture } from '../content-workflows/harness.ts';
import { Jobs } from '../../packages/domain/src/jobs/index.ts';
import { ContractError } from '../../packages/contracts/src/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { createServiceAgentHandlers } from '../../apps/service/src/worker/handlers/agent/index.ts';
import { buildServiceAgentPlan } from '../../packages/domain/src/service-agent/index.ts';
import { hash, canonical } from '../../packages/adapters/src/agent/codex/primitives.ts';
import type { JsonObject } from '../../packages/contracts/src/index.ts';
async function until(check:()=>boolean){const end=Date.now()+10_000;while(!check()){if(Date.now()>end)throw new Error('claim timed out');await delay(10);}}
test('八进程同时 SQLite claim 总上限五、单job/同目标唯一归属，同run占用跳过独立队尾',async()=>{
 const f=serviceFixture(),gate=join(f.root,'gate'),children:ReturnType<typeof spawn>[]=[];try{
  const same=randomUUID(),run=randomUUID();
  for(let index=0;index<9;index++){const document=index<2?same:randomUUID();if(!f.context.db.prepare('SELECT id FROM documents WHERE id=?').get(document))f.context.db.prepare("INSERT INTO documents(id,workspace_id,kind,version) VALUES (?,?,'wiki',1)").run(document,f.context.identity.workspace_id);f.jobs.enqueue(f.request(),{kind:'document_modify',execution_mode:'service_adapter',executor_id:'codex',entrypoint:'standalone_web',presentation:'foreground_dialog',target_id:document,input_manifest:{schema_version:'fixture',mode:'candidate',targets:[{document_id:document,base_revision_id:null,core_revision_id:null}],source_ids:[],...(index===2||index===3?{writing_flow:{run_id:run}}:{})}});}
  const outputs=Array.from({length:8},(_,index)=>join(f.root,'claim-'+index+'.json'));
  for(let index=0;index<8;index++){const scenario=join(f.root,'scenario-'+index+'.json');writeFileSync(scenario,JSON.stringify({database:join(f.context.paths.state_root,'workbench.sqlite'),workspace:f.context.identity.workspace_id,label:'worker:'+index,gate,output:outputs[index]}));children.push(spawn(process.execPath,[join(projectRoot,'tests/worker-concurrency/claim-child.mjs'),scenario],{stdio:['ignore','ignore','pipe']}));}
  writeFileSync(gate,'start');await until(()=>outputs.every(path=>existsSync(path)));const claims=outputs.map(path=>JSON.parse(readFileSync(path,'utf8'))).filter(Boolean);assert.equal(claims.length,5);assert.equal(new Set(claims.map(claim=>claim.id)).size,5);assert.equal(new Set(claims.map(claim=>claim.attempt)).size,5);assert.equal(claims.filter(claim=>claim.resources.some((target:{document_id:string})=>target.document_id===same)).length,1);
  const running=f.jobs.list(f.request(),{state:'running'}).items;assert.equal(running.filter(job=>JSON.parse(job.input_manifest).writing_flow?.run_id===run).length,1);assert.equal(f.jobs.list(f.request(),{state:'queued'}).items.length,4);
 }finally{await Promise.all(children.map(child=>new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',()=>resolve());child.kill('SIGTERM');})));f.cleanup();}
});
test('同已确认core五平台同时claim，人工编辑/core过期与晚到候选保持CAS，观点/审批不串写',async()=>{
 const f=contentFixture();try{const topic=await f.topic(),original=await f.topics.get(f.request(),topic.id),targets=[['xiaohongshu','image_post'],['wechat','article'],['x','text'],['douyin','short_video'],['bilibili','long_video']] as const;
  const variants=targets.map(([platform,format])=>f.generation.createVariant(f.request(),topic.id,{platform,format}));
  for(const variant of variants)f.generation.variant(f.request(),String(variant.id),{core_revision_id:topic.core_revision_id,base_revision_id:null,mode:'initialize',source_ids:[f.source],executor:'codex'});
  const claims=variants.map(()=>f.claim());assert.equal(new Set(claims.map(claim=>claim.job.id)).size,5);assert.equal(f.jobs.claim('sixth'),null);
  const edited=await f.documents.save(f.request(),String(variants[0].document_id),{expected_revision_id:null,text:f.text('人工平台文字与观点'),origin:'human'});
  const core=await f.documents.save(f.request(),topic.core_document_id,{expected_revision_id:topic.core_revision_id,text:f.text('本人核心新观点'),origin:'human'});await f.documents.approveCore(f.request(),topic.id,core.revision_id);
  for(const claim of claims){const manifest=JSON.parse(claim.job.input_manifest),output={documents:[{document_id:manifest.targets[0].document_id,text:'候选 '+claim.job.id}],recommendations:[]};const first=f.finish(claim,output),again=f.finish(claim,output);assert.equal(first.receipt_id,again.receipt_id);assert.equal(f.context.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE job_id=?').get(claim.job.id)!.n,1);}
  assert.equal((await f.documents.get(f.request(),String(variants[0].document_id))).text,f.text('人工平台文字与观点'));
  for(const variant of variants){const candidate=f.generation.candidates(f.request(),String(variant.document_id))[0]!;assert.equal(candidate.adoption_mode,null);await assert.rejects(f.documents.adoptCandidate(f.request(),candidate.id,{expected_revision_id:variant.id===variants[0].id?edited.revision_id:null}));}
  const current=await f.topics.get(f.request(),topic.id);assert.equal(current.core_approval?.revision_id,core.revision_id);assert.notEqual(current.core_approval?.revision_id,original.core_approval?.revision_id);assert.equal(current.core.text,f.text('本人核心新观点'));
 }finally{f.cleanup();}
});
test('多次容量等待不消耗真正执行的恢复次数；恢复提交缺新身份不会再次调用handler',async()=>{
 const f=serviceFixture();let now=Date.now();try{const job=f.enqueue(),jobs=new Jobs(f.context,{clock:()=>now});for(let index=0;index<4;index++){const claim=jobs.claim('busy')!;jobs.deferCapacity(claim.fence,{});}const running=jobs.claim('first-real-run')!;assert.equal(running.attempt.attempt_no,5);now+=60_001;assert.equal(jobs.recoverExpired()[0].state,'queued');
  let calls=0;const worker=new DurableWorker(f.context,[{registration:{kind:'document_modify',execution_mode:'service_adapter',recovery:'read_only'},async execute(){calls++;throw new ContractError('RESULT_UNKNOWN','恢复请求已提交但无新身份',{resume_submission_unknown:true});}}],{clock:()=>now});assert.equal((await worker.runOnce())!.state,'failed');const view=jobs.get(f.request(),job.id);assert.equal(view.checkpoint!.resume_submission_unknown,true);jobs.resume(f.request(),job.id,{expected_version:view.job.version});assert.equal((await worker.runOnce())!.state,'failed');assert.equal(calls,1);
 }finally{f.cleanup();}
});
test('恢复提交前checkpoint持久落盘；新handle前进程SIGKILL，重启不再次native提交',async()=>{
 const f=serviceFixture();let child:ReturnType<typeof spawn>|undefined;try{const queued=f.enqueue(),claim=f.jobs.claim('old')!,plan=buildServiceAgentPlan(f.context,claim,{staging_root:f.staging}),old={runtime_session_id:'fixture-old-session',runtime_turn_id:'fixture-old-turn',supports_resume:true,checkpoint:{executor_id:'codex',cwd:f.staging,run_input:plan.input,input_hash:hash(canonical(plan.input.input_manifest))}};
  f.jobs.checkpoint(claim.fence,{executor_id:'codex',fixed_input_hash:plan.fixed_input_hash,agent_handle:old as unknown as JsonObject,pre_submit_failure:false});const failed=f.jobs.fail(claim.fence,{code:'QUOTA_EXHAUSTED'},'waiting_quota');f.jobs.resume(f.request(),queued.id,{expected_version:failed.version});
  const scenario=join(f.root,'resume-crash.json'),observation=join(f.root,'resume-observation');writeFileSync(scenario,JSON.stringify({database:join(f.context.paths.state_root,'workbench.sqlite'),config:f.context.config,identity:f.context.identity,staging:f.staging,observation}));child=spawn(process.execPath,[join(projectRoot,'tests/worker-concurrency/resume-crash-child.mjs'),scenario],{stdio:['ignore','ignore','pipe']});const exit=await new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{child!.once('error',reject);child!.once('exit',(code,signal)=>resolve({code,signal}));});assert.equal(exit.signal,'SIGKILL');assert(existsSync(observation));assert.equal(f.jobs.get(f.request(),queued.id).checkpoint!.resume_submission_unknown,true);
  const future=Date.now()+60_001,jobs=new Jobs(f.context,{clock:()=>future});assert.equal(jobs.recoverExpired()[0].state,'queued');let resumed=0;const worker=new DurableWorker(f.context,[{registration:{kind:'document_modify',execution_mode:'service_adapter',recovery:'read_only'},async execute(){resumed++;return {documents:[],recommendations:[]};}}],{clock:()=>future});assert.equal((await worker.runOnce())!.state,'failed');assert.equal(resumed,0);assert.equal(jobs.get(f.request(),queued.id).error!.code,'RESULT_UNKNOWN');
 }finally{child?.kill('SIGTERM');f.cleanup();}
});
