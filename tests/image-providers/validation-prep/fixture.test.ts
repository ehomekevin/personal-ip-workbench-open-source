import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {fixture,seeded,FakeImageProvider} from '../harness.ts';
import {baseCheckpoint} from '../../../packages/adapters/src/media/image/common.ts';
import {ImageGenerationWorkflow} from '../../../packages/domain/src/artifact-execution/image.ts';
import {ResultCommit} from '../../../packages/domain/src/result-commit/index.ts';
import {Jobs} from '../../../packages/domain/src/jobs/index.ts';
import {getJob} from '../../../packages/storage/src/jobs/index.ts';
import type {ImageProviderPort,ImageProviderInput,ImageProviderResult} from '../../../packages/adapters/src/media/image/index.ts';
import type {GeneratedAssetOutput} from '../../../packages/contracts/src/index.ts';
import {PRODUCT_CANDIDATE,PROMPT,OLD_UNKNOWN_JOB,runOnce,type RunPort,type KnownIds} from './runner.ts';
import {verifyReady} from './verify-ready.ts';
import {admitReal} from './run.ts';
const owned=resolve(import.meta.dirname),project=resolve(owned,'../../..');
if(process.env.CODEX_PREP_EVIDENCE_DIR)mkdirSync(process.env.CODEX_PREP_EVIDENCE_DIR,{recursive:true});
function save(name:string,value:unknown){if(process.env.CODEX_PREP_EVIDENCE_DIR){mkdirSync(process.env.CODEX_PREP_EVIDENCE_DIR,{recursive:true});writeFileSync(join(process.env.CODEX_PREP_EVIDENCE_DIR,name+'.json'),JSON.stringify(value,null,2)+'\n');}}
const scenarios=['success','view_error','no_image','submit_response_unknown','observe_response_unknown','observation_timeout','observation_limit','local_stop','refresh_error','close_error'] as const;
for(const scenario of scenarios)test('single Codex fixture preserves invocation across '+scenario,async()=>{
 const f=fixture(),out=mkdtempSync(join(owned,'.run-')),controller=new AbortController(),worker=new AbortController();
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(done=>release=done),nativeStarted=new Promise<void>(done=>started=done);
 let providerCalls=0,setupCalls=0,closeCalls=0,observeCalls=0,captureCalls=0,fixtureClosed=false,known:KnownIds={},output:GeneratedAssetOutput|undefined,workerError:unknown,execution:Promise<void>|undefined;
 const fake=new FakeImageProvider(),provider:ImageProviderPort={id:'codex',describe:async()=>({configured:true}),
  async execute(input:ImageProviderInput,options):Promise<ImageProviderResult>{providerCalls++;const cp={...baseCheckpoint(input),thread_id:'fixture-thread',turn_id:'fixture-turn'};options.checkpoint(cp);known={...known,thread_id:'fixture-thread',turn_id:'fixture-turn'};started();await gate;worker.signal.throwIfAborted();
   if(scenario==='no_image')throw new Error('Explicit full/completed fixture turn contains zero typed images');
   return{...fake.output(input,{...cp,native_state:'completed',observed_image_calls:1,image_item_ids:['fixture-image-item']}),model:null};
  },query:async()=>{throw new Error('Query forbidden in single validation fixture');}};
 let port:RunPort|undefined;
 try{
  const {input,topic}=await seeded(f),workflow=new ImageGenerationWorkflow(f.context,{provider:id=>{assert.equal(id,'codex');return provider;}}),jobs=new Jobs(f.context);
  port={setup:async()=>{setupCalls++;known={workspace_id:f.config.workspace_id,topic_id:topic.id};},
   async submit(request,key){assert.equal(request.provider,'codex');assert.equal(request.prompt,PROMPT);assert(existsSync(join(out,'invocation.json')));const intent=JSON.parse(readFileSync(join(out,'invocation.json'),'utf8'));assert.equal(intent.state,'about_to_submit');assert.equal(intent.local_submit_attempts,1);assert.equal(intent.idempotency_key,key);assert.equal(intent.budget.agy,0);
    const q=workflow.enqueue(f.request(key),{...input,provider:'codex',prompt:request.prompt}),claim=jobs.claim('own-codex-validation-fixture')!;known={...known,job_id:q.job_id,attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,input_hash:claim.job.input_hash};
    execution=workflow.execute(claim,worker.signal,v=>jobs.checkpoint(claim.fence,v)).then(result=>{output=result;const resultReceipt=new ResultCommit(f.context).submit(f.request(),q.job_id,{attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,expected_version:getJob(f.context.db,f.config.workspace_id,q.job_id).version,input_hash:q.input_hash,typed_output:{documents:[],recommendations:[],generated_assets:[result]}},claim.fence.lease_owner);assert.equal(resultReceipt.state,'committed');}).catch(error=>{workerError=error;});
    await nativeStarted;if(scenario==='submit_response_unknown')throw new Error('HTTP POST accepted but response JSON unavailable');return{job_id:q.job_id};
   },snapshot:()=>({...known}),
   async observe(_id,signal){observeCalls++;if(scenario==='observe_response_unknown')throw new Error('HTTP GET response unreadable');
    if(scenario==='observation_timeout')return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    if(scenario==='local_stop'){controller.abort(new Error('Own local observation stopped'));return{state:'running'};}
    if(scenario==='observation_limit')return{state:'running'};
    release();await execution;if(scenario==='no_image'){assert(workerError);return{state:'completed_no_image',detail:{fixture_full_turn:true,typed_images:0}};}assert(!workerError);return{state:'succeeded'};
   },
   async verify(id,signal){return verifyReady(f.context,id,signal,async assetId=>{if(scenario==='refresh_error')throw new Error('Refreshed image response unavailable');const asset=f.context.db.prepare('SELECT status FROM assets WHERE id=?').get(assetId);return asset?.status==='ready';});},
   async capture(){captureCalls++;if(scenario==='view_error')throw new Error('locator.scrollIntoViewIfNeeded: Element is not attached to the DOM');},
   async close(){closeCalls++;worker.abort(new Error('Own fixture worker close'));release();await execution;if(output&&process.env.CODEX_PREP_EVIDENCE_DIR&&scenario==='success'){const m=JSON.parse(readFileSync(output.manifest_path,'utf8'));writeFileSync(join(process.env.CODEX_PREP_EVIDENCE_DIR,'fixture-success.png'),readFileSync(join(output.manifest_path,'..',m.file_name)));}f.cleanup();fixtureClosed=true;if(scenario==='close_error')throw new Error('Own cleanup reporting error');}
  };
  const record=await runOnce(port,{out,mode:'fixture',requirement_version:'IMAGE-CODEX-VALIDATION-PREP/r1',max_observations:2,operation_timeout_ms:scenario==='observation_timeout'?30:3000,poll_ms:0,signal:controller.signal});
  assert.equal(record.local_submit_attempts,1);assert.equal(providerCalls,1);assert.equal(setupCalls,1);assert.equal(closeCalls,1);assert.equal(record.known.job_id,known.job_id);assert.equal(record.known.attempt_id,known.attempt_id);assert.equal(record.known.thread_id,'fixture-thread');assert.equal(record.known.turn_id,'fixture-turn');assert.equal(record.native_submit_count,null);assert.equal(record.fees,null);assert.equal(record.remote_cancel_confirmed,false);
  assert.equal(record.state,['success','view_error','close_error'].includes(scenario)?'succeeded':scenario==='no_image'?'blocked':'unknown');if(scenario==='view_error'){assert.equal(record.view_errors.length,2);assert(record.evidence?.fully_decoded&&record.evidence.refresh_readable);}assert.equal(record.cleanup_errors.length,scenario==='close_error'?1:0);assert.equal(record.local_stop,scenario!=='close_error');assert(fixtureClosed);
  assert.deepEqual(JSON.parse(readFileSync(join(out,'invocation.json'),'utf8')),record);
  await assert.rejects(runOnce(port,{out,mode:'fixture',requirement_version:'IMAGE-CODEX-VALIDATION-PREP/r1',max_observations:2,operation_timeout_ms:100,poll_ms:0}),{code:'EEXIST'});assert.equal(providerCalls,1);assert.equal(setupCalls,1);assert.equal(closeCalls,1);
  save(scenario,{record,provider_fixture_calls:providerCalls,AGY_calls:0,native_queries:0,setup_calls:setupCalls,close_calls:closeCalls,observations:observeCalls,captures:captureCalls,repeat_start_rejected:true,source:'deterministic Codex ImageProviderPort + existing image fixture PNG + production Workflow/SQLite/ResultCommit/proof/verifier; no real provider or service',temporary_fixture_removed:true});
 }finally{if(!fixtureClosed)f.cleanup();rmSync(out,{recursive:true,force:true});}
});
test('missing explicit inputs and historical real execution are rejected before service startup',()=>{
 const command=resolve(owned,'run.ts');
 for(const [args,pattern] of [[[],/Usage: run.ts --root/],[['--run-real'],/only validates saved preparation offline/]] as const){
  assert.throws(()=>execFileSync(process.execPath,[command,...args],{cwd:project,stdio:'pipe'}),(error:unknown)=>{const e=error as {status:number;stderr:Buffer};assert.equal(e.status,2);assert.match(e.stderr.toString(),pattern);return true;});
 }
 assert(!existsSync(resolve(project,'.ci-artifacts/evidence/image-provider-agy-01/codex-validation-prep/r1/real-run-once')));
 save('default-denied',{missing_inputs_exit:2,historical_execution_exit:2,service_started:false,real_calls:0});
});
test('explicit offline binding admits only matching authorization and budgets',()=>{
 const manifest={candidate_id:'synthetic-prep-candidate',source_files:[]},binding={product_candidate:'synthetic-product-candidate',prompt:'Synthetic neutral test image',run_id:'synthetic-offline-run',output_directory:join(project,'.ci-artifacts/synthetic-output')};
 const approval={task_id:'IMAGE-CODEX-VALIDATION-RUN',requirement_version:'r1',authorized:true,codex_budget:1,agy_budget:0,native_old_query_budget:0,...binding,prep_candidate:manifest.candidate_id,human_approval_reference:'synthetic offline test only'};
 assert.doesNotThrow(()=>admitReal(approval,manifest,project,binding));
 assert.throws(()=>admitReal(approval,manifest,project),/Explicit candidate/);
 const changes=[{task_id:'OTHER',requirement_version:'r2'},{codex_budget:0},{agy_budget:1},{native_old_query_budget:1},{prep_candidate:'wrong'},{human_approval_reference:''},{product_candidate:'wrong'},{prompt:'wrong'},{run_id:'wrong'},{output_directory:'wrong'}];
 for(const change of changes)assert.throws(()=>admitReal({...approval,...change},manifest,project,binding),/Missing bound single-Codex authorization/);
 save('admission-negative',{positive_cases:1,negative_cases:changes.length+1,simulated_only:true,real_calls:0});
});
test('concurrent starts share one durable invocation, with one fixture POST',async()=>{
 const out=mkdtempSync(join(owned,'.exclusive-'));let posts=0,setups=0;
 const port:RunPort={setup:async()=>{setups++;},submit:async()=>{posts++;return{job_id:'fixture-exclusive-job'};},snapshot:()=>({job_id:'fixture-exclusive-job'}),observe:async()=>({state:'unknown'}),verify:async()=>{throw new Error('No success');},capture:async()=>{},close:async()=>{}};
 try{const options={out,mode:'fixture' as const,requirement_version:'IMAGE-CODEX-VALIDATION-PREP/r1',max_observations:1,operation_timeout_ms:100,poll_ms:0};const first=runOnce(port,options);await assert.rejects(runOnce(port,options),{code:'EEXIST'});const result=await first;assert.equal(posts,1);assert.equal(setups,1);assert.equal(result.state,'unknown');save('concurrent-exclusive',{fixture_posts:posts,fixture_setups:setups,second_start:'EEXIST',real_calls:0});}finally{rmSync(out,{recursive:true,force:true});}
});
test('the recorded old unknown ID is excluded before any submit or observation',async()=>{
 const out=mkdtempSync(join(owned,'.old-id-'));let submits=0,observes=0;
 const port:RunPort={setup:async()=>{},submit:async()=>{submits++;return{job_id:OLD_UNKNOWN_JOB};},snapshot:()=>({job_id:OLD_UNKNOWN_JOB}),observe:async()=>{observes++;return{state:'unknown'};},verify:async()=>{throw new Error('No success');},capture:async()=>{},close:async()=>{}};
 try{const record=await runOnce(port,{out,mode:'fixture',requirement_version:'IMAGE-CODEX-VALIDATION-PREP/r1',max_observations:1,operation_timeout_ms:100,poll_ms:0});assert.equal(record.state,'unknown');assert.equal(submits,0);assert.equal(observes,0);assert.equal(record.local_submit_attempts,0);save('old-id-excluded',{fixture_submits:0,fixture_observes:0,record,old_saved_records_opened:false,real_calls:0});}finally{rmSync(out,{recursive:true,force:true});}
});
test('hanging own cleanup stays bounded and records incomplete local stop',async()=>{
 const out=mkdtempSync(join(owned,'.cleanup-'));
 const port:RunPort={setup:async()=>{},submit:async()=>({job_id:'fixture-cleanup-job'}),snapshot:()=>({job_id:'fixture-cleanup-job',thread_id:'fixture-cleanup-thread'}),observe:async()=>({state:'unknown'}),verify:async()=>{throw new Error('No success');},capture:async()=>{},close:()=>new Promise(()=>{})};
 try{const record=await runOnce(port,{out,mode:'fixture',requirement_version:'IMAGE-CODEX-VALIDATION-PREP/r1',max_observations:1,operation_timeout_ms:30,poll_ms:0});assert.equal(record.state,'unknown');assert.equal(record.local_stop,false);assert.equal(record.cleanup_errors.length,1);assert.equal(record.known.thread_id,'fixture-cleanup-thread');assert.equal(record.remote_cancel_confirmed,false);save('cleanup-timeout',{record,real_calls:0,source:'pending Promise only; owns no process/service/DB'});}finally{rmSync(out,{recursive:true,force:true});}
});
test('local SIGTERM preserves known IDs and exclusive record across a second process',async()=>{
 const out=mkdtempSync(join(owned,'.signal-')),helper=join(owned,'signal-fixture.ts'),child=spawn(process.execPath,[helper,out],{cwd:project,stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);const ended=new Promise<number|null>(resolve=>child.once('exit',resolve));
 try{
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Own signal fixture startup timeout: '+stderr)),3000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error('Early child exit: '+stderr));});});
  child.kill('SIGTERM');assert.equal(await ended,0);const record=JSON.parse(readFileSync(join(out,'invocation.json'),'utf8'));assert.equal(record.state,'unknown');assert.equal(record.known.thread_id,'fixture-signal-thread');assert.equal(record.known.turn_id,'fixture-signal-turn');assert.equal(record.local_stop,true);assert.equal(record.remote_cancel_confirmed,false);
  assert.throws(()=>execFileSync(process.execPath,[helper,out],{cwd:project,stdio:'pipe'}),{status:2});assert.equal(readFileSync(join(out,'fixture-posts.txt'),'utf8'),'POST\n');save('SIGTERM',{record,repeat_process_exit:2,fixture_posts:1,own_PID:child.pid,own_process_exited:true,real_calls:0});
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended;rmSync(out,{recursive:true,force:true});}
});
