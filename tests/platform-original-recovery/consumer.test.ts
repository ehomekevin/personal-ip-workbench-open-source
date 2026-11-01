import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {ResumeJobSchema,DEFAULT_TEXT_OBSERVATION,type JsonObject} from '../../packages/contracts/src/index.ts';
import {canonicalJson,transaction,inputHash} from '../../packages/storage/src/connection/index.ts';
import {buildServiceAgentPlan} from '../../packages/domain/src/service-agent/index.ts';
import {integrationFixture,evidence} from './integration-harness.ts';
import {threadResponse} from './native-harness.ts';
import {createJobsModule} from '../../apps/service/src/routes/jobs.ts';
import {queueJobInTransaction} from '../../packages/storage/src/jobs/index.ts';
import {startApplication} from '../../apps/service/src/bootstrap/application.ts';
import {createDocumentsModule} from '../../apps/service/src/routes/documents.ts';
import {createTopicsModule} from '../../apps/service/src/routes/topics.ts';
const noGenerate=(f:Awaited<ReturnType<typeof integrationFixture>>)=>{
 const calls=f.calls();for(const method of ['thread/start','thread/resume','turn/start','model/list'])assert.equal(calls.filter(c=>c.method===method).length,0,method);
 assert.equal(new Set(f.detail().attempts.map(a=>JSON.parse(a.checkpoint).agent_handle?.runtime_turn_id).filter(Boolean)).size,1);
};
function record(name:string,f:Awaited<ReturnType<typeof integrationFixture>>){if(evidence)appendFileSync(join(evidence,'consumer-results.jsonl'),JSON.stringify({name,state:f.detail().job.state,attempts:f.detail().attempts.length,counts:f.counts(),wire:f.calls().filter(x=>x.method).map(x=>x.method)})+'\n',{mode:0o600});}
test('completed原结果经真实stdio/RoutedTextAdapter/handler/ResultCommit单次消费，固定两Skill与时限',async()=>{
 const f=await integrationFixture('completed');try{
  const frozen=JSON.parse(f.detail().job.input_manifest);assert.deepEqual(frozen.observation_policy,DEFAULT_TEXT_OBSERVATION);assert.equal(frozen.service_agent.execution_policy,undefined);assert.equal(frozen.writing_skills.length,2);
  const old=JSON.parse(JSON.stringify(f.detail().attempts[0]));const beforeHash=f.detail().job.input_hash;const key='same-original-query';const queued=f.query(key);
  assert.equal(canonicalJson(f.detail().attempts[0]),canonicalJson(old));assert.equal(f.detail().job.input_hash,beforeHash);
  // 事务恢复意图可跨Jobs/worker实例与领取传播，不改旧attempt或原manifest。
  const worker=f.worker();assert.equal((await worker.runOnce())!.state,'committed');
  const detail=f.detail();assert.equal(detail.job.state,'succeeded');assert.equal(detail.attempts.length,2);assert.equal(JSON.parse(detail.attempts[1].checkpoint).recovery_action,'query_original');
  assert.equal(detail.attempts[1].runtime_session_id,f.handle.runtime_session_id);assert.equal(detail.attempts[1].runtime_turn_id,f.handle.runtime_turn_id);
  assert.equal(detail.receipts.length,1);assert.equal(detail.receipts[0].state,'committed');assert.equal((await f.read()).text,f.output.documents[0].text);
  assert.equal(f.context.db.prepare('SELECT status FROM variants WHERE id=?').get(String(f.variant.id))!.status,'ready');
  assert.equal(f.context.db.prepare('SELECT status FROM variants WHERE id=?').get(String(f.other.id))!.status,'empty');
  assert.equal(canonicalJson(f.jobs.resume(f.request(key),f.accepted.job_id,{expected_version:queued.version-1,recovery_action:'query_original'})),canonicalJson(queued));
  f.query('different-idempotency');assert.equal(await f.worker().runOnce(),null);assert.equal(f.counts().receipts,1);noGenerate(f);record('completed',f);
 }finally{await f.cleanup();}
});
for(const invalid of ['wrong-target','extra-field','recommendation','source-link','response-cwd','response-turn'])test('实际producer/consumer拒绝不兼容结果：'+invalid,async()=>{
 const f=await integrationFixture('output-'+invalid);try{
  const output=structuredClone(f.output) as any;
  if(invalid==='wrong-target')output.documents[0].document_id='forged-target';
  if(invalid==='extra-field')output.owner='forged';
  if(invalid==='recommendation')output.recommendations=[{payload_json:'{}',source_ids:[],rationale:'forged'}];
  if(invalid==='source-link')output.documents[0].text='伪造依据 [资料](https://invalid.example/fake)';
  const thread=threadResponse(f.handle,'completed',output);if(invalid==='response-cwd')thread.cwd=f.root;if(invalid==='response-turn')thread.turns[0].id='forged-turn';
  f.set({thread});f.query();await f.worker().runOnce();assert.notEqual(f.detail().job.state,'succeeded');assert.equal((await f.read()).head_revision_id,null);assert.deepEqual(f.counts(),{receipts:0,candidates:0,intents:0});noGenerate(f);record(invalid,f);
 }finally{await f.cleanup();}
});
test('材料原字节与可信root在worker重建计划时拒绝，查询意图跨重领仍不生成',async()=>{
 const f=await integrationFixture('material-root');try{
  f.query();const material=f.context.db.prepare('SELECT file_path FROM document_revisions WHERE id=?').get(f.core.revision_id)!;
  chmodSync(String(material.file_path),0o600);writeFileSync(String(material.file_path),readFileSync(String(material.file_path),'utf8')+'\nforged bytes');
  await f.worker().runOnce();assert.equal(f.calls().length,0);assert.equal(f.counts().receipts,0);assert.equal((await f.read()).head_revision_id,null);record('material-root',f);
 }finally{await f.cleanup();}
});
test('verifier读取窗口崩溃标志不会把再次query变成新生成或永久阻塞',async()=>{
 const f=await integrationFixture('verifier-reclaim');try{
  f.query();const verifier=f.jobs.claim('controlled-verifier-crash')!;const checkpoint=JSON.parse(verifier.attempt.checkpoint);
  assert.equal(checkpoint.recovery_action,'query_original');f.jobs.checkpoint(verifier.fence,{...checkpoint,resume_submission_unknown:true});f.jobs.fail(verifier.fence,{code:'RESULT_UNKNOWN',message:'controlled query-client crash'},'failed');
  f.query();assert.equal((await f.worker().runOnce())!.state,'committed');assert.equal(f.detail().attempts.length,3);assert.equal(f.counts().receipts,1);noGenerate(f);record('query-reclaim',f);
 }finally{await f.cleanup();}
});
test('新幂等键/不同fixture输出不能再次消费已提交原结果',async()=>{
 const f=await integrationFixture('conflicting-replay');try{
  f.query();await f.worker().runOnce();const initial=(await f.read()).hash;const before=f.calls().length;
  f.set({thread:threadResponse(f.handle,'completed',{documents:[{document_id:String(f.variant.document_id),text:'第二份冲突输出'}],recommendations:[]})});f.query('replay-conflict');assert.equal(await f.worker().runOnce(),null);
  assert.equal((await f.read()).hash,initial);assert.equal(f.counts().receipts,1);assert.equal(f.calls().length,before);noGenerate(f);record('different-output-replay',f);
 }finally{await f.cleanup();}
});
test('API route严格动作不落host-session恢复，参数schema拒绝旁路',async()=>{
 const f=await integrationFixture('route');try{
  let hostResumes=0;const routes:any[]=[];const module=createJobsModule(f.context,{resume(){hostResumes++;throw Error('host resume must not run');}} as any);module.register({register:(r:any)=>routes.push(r)} as any);
  const route=routes.find(r=>r.method==='POST'&&r.path==='/api/v1/jobs/{id}/resume');
  const host=transaction(f.context.db,()=>queueJobInTransaction(f.context.db,f.context.identity.workspace_id,{kind:'variant_generate',execution_mode:'host_session',executor_id:'codex',entrypoint:'standalone_web',presentation:'foreground_dialog',input_manifest:{},retry_policy:{recovery:'read_only'}},Date.now()));
  assert.throws(()=>route.handle({context:f.request(),params:{id:host.id},headers:{},body:route.schema.parse({expected_version:host.version,recovery_action:'query_original'})}),{code:'CAPABILITY_UNSUPPORTED'});
  assert.equal(hostResumes,0);assert.equal(f.calls().length,0);assert.equal(f.counts().receipts,0);record('host-route',f);
 }finally{await f.cleanup();}
});
test('实际公共HTTP→持久query intent→stdio→consumer→receipt/doc/variant回读',async()=>{
 const f=await integrationFixture('http');let app:Awaited<ReturnType<typeof startApplication>>|undefined;try{
  app=await startApplication({...f.context.config,listen:{host:'127.0.0.1',port:4355}},{port:0,executorHealth:async()=>[],moduleFactories:[ctx=>createJobsModule(ctx),createDocumentsModule,createTopicsModule]});
  const base='http://127.0.0.1:'+app.address.port,headers={'content-type':'application/json','x-workspace-id':f.context.identity.workspace_id,'x-service-instance-id':f.context.identity.service_instance_id};
  const request=async(method:string,path:string,body?:unknown,extra:Record<string,string>={})=>{
   const response=await fetch(base+path,{method,headers:{...headers,'idempotency-key':crypto.randomUUID(),...extra},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});const result=await response.json();
   appendFileSync(join(f.root,'http.jsonl'),JSON.stringify({method,path,status:response.status,result})+'\n',{mode:0o600});return {status:response.status,body:result};
  };
  const path='/api/v1/jobs/'+f.accepted.job_id+'/resume',body={expected_version:f.detail().job.version,recovery_action:'query_original'};
  assert.equal((await request('POST',path,body,{'x-workspace-id':'different-workspace'})).status,409);
  assert.equal((await request('POST',path,{...body,input:{}})).status,400);assert.equal(f.detail().attempts.length,1);
  assert.equal((await request('POST',path,body)).status,200);assert.equal((await f.worker().runOnce())!.state,'committed');
  const job=await request('GET','/api/v1/jobs/'+f.accepted.job_id),doc=await request('GET','/api/v1/documents/'+String(f.variant.document_id)),topic=await request('GET','/api/v1/topics/'+f.topic.id);
  assert.equal(job.body.receipts[0].state,'committed');assert.equal(doc.body.hash,(await f.read()).hash);assert.equal(topic.body.variants.find((v:any)=>v.id===f.variant.id).status,'ready');noGenerate(f);record('http-chain',f);
  await app.close();app=undefined;await assert.rejects(fetch(base+'/health',{signal:AbortSignal.timeout(500)}));
 }finally{await app?.close();await f.cleanup();}
});
for(const status of ['interrupted','failed','inProgress','missing','no-final','partial','read-error','disconnect'])test('原状态拒绝且零新turn：'+status,async()=>{
 const f=await integrationFixture(status);try{
  const response=threadResponse(f.handle,['interrupted','failed','inProgress'].includes(status)?status:'completed',f.output);
  if(status==='missing')response.turns=[];
  if(status==='no-final')response.turns[0].items=[];
  if(status==='partial')response.turns[0].items[0].text='{"documents":[';
  f.set(status==='read-error'?{readError:true}:status==='disconnect'?{disconnectOnRead:true}:{thread:response});f.query();await f.worker().runOnce();
  assert.notEqual(f.detail().job.state,'succeeded');assert.equal((await f.read()).head_revision_id,null);assert.deepEqual(f.counts(),{receipts:0,candidates:0,intents:0});noGenerate(f);record(status,f);
 }finally{await f.cleanup();}
});
for(const mutation of ['workspace','cwd','thread','turn','run-input','source','skill','target','input-hash'])test('固定绑定拒绝：'+mutation,async()=>{
 const f=await integrationFixture('binding-'+mutation);try{
  const cp=f.detail().checkpoint!,h=cp.agent_handle as JsonObject,c=h.checkpoint as JsonObject,run=c.run_input as JsonObject,manifest=run.input_manifest as JsonObject;
  if(mutation==='workspace')c.workspace_id='wrong-workspace';
  if(mutation==='cwd')c.cwd=f.root;
  if(mutation==='thread')h.runtime_session_id='wrong-thread';
  if(mutation==='turn')h.runtime_turn_id='wrong-turn';
  if(mutation==='run-input')run.task_instruction='different';
  if(mutation==='source')(manifest.frozen as JsonObject).source_ids=['forged'];
  if(mutation==='skill')((manifest.frozen as JsonObject).writing_skills as JsonObject[])[1].content='forged';
  if(mutation==='target')run.target_document_id='other-document';
  if(mutation==='input-hash')cp.fixed_input_hash='wrong';
  f.context.db.prepare('UPDATE job_attempts SET checkpoint=? WHERE id=?').run(canonicalJson(cp),f.claim.attempt.id);
  assert.throws(()=>f.query());assert.equal(f.detail().attempts.length,1);assert.equal(f.calls().length,0);assert.equal((await f.read()).head_revision_id,null);record(mutation,f);
 }finally{await f.cleanup();}
});
for(const change of ['human','core','cancel','wrong-executor','version-conflict'])test('入队前竞争保护：'+change,async()=>{
 const f=await integrationFixture(change);try{
  const version=f.detail().job.version;
  if(change==='human')await f.documents.save(f.request(),String(f.variant.document_id),{expected_revision_id:null,text:'人工后来稿',origin:'human'});
  if(change==='core')await f.documents.save(f.request(),f.topic.core_document_id,{expected_revision_id:f.core.revision_id,text:'核心新版本',origin:'human'});
  if(change==='cancel')f.jobs.cancel(f.request(),f.accepted.job_id,{expected_version:version});
  assert.throws(()=>change==='wrong-executor'?f.jobs.resume(f.request(),f.accepted.job_id,{expected_version:version,recovery_action:'query_original',executor:'claude'}):change==='version-conflict'?f.jobs.resume(f.request(),f.accepted.job_id,{expected_version:version-1,recovery_action:'query_original'}):f.query());
  assert.equal(f.calls().length,0);assert.equal(f.counts().receipts,0);if(change==='human')assert.equal((await f.read()).text,'人工后来稿');record(change,f);
 }finally{await f.cleanup();}
});
test('领取后人工稿变化拒绝消费，旧fence/晚结果及并发重复核对不取得提交权',async()=>{
 const f=await integrationFixture('race');try{
  const version=f.detail().job.version;f.query();assert.throws(()=>f.jobs.resume(f.request(),f.accepted.job_id,{expected_version:version,recovery_action:'query_original'}),{code:'VERSION_CONFLICT'});
  const worker=f.worker();const running=worker.runOnce();await new Promise(r=>setTimeout(r,20));
  await f.documents.save(f.request(),String(f.variant.document_id),{expected_revision_id:null,text:'在核对期间保存的人稿',origin:'human'});await running;
  assert.equal((await f.read()).text,'在核对期间保存的人稿');assert.equal(f.counts().receipts,0);noGenerate(f);record('manual-race',f);
  const late=worker.results.submit(f.request(),f.accepted.job_id,{attempt_id:f.claim.attempt.id,attempt_generation:f.claim.attempt.attempt_generation,expected_version:f.detail().job.version,input_hash:f.detail().job.input_hash,typed_output:f.output},'controlled-original-seed');
  assert.equal(late.state,'quarantined');assert.equal((await f.read()).text,'在核对期间保存的人稿');
 }finally{await f.cleanup();}
});
test('schema动作不允许输入/路线变更，已有普通resume仍接受旧合同',()=>{
 assert.deepEqual(ResumeJobSchema.parse({expected_version:3,recovery_action:'query_original'}),{expected_version:3,recovery_action:'query_original'});
 for(const extra of [{input:{}},{executor:'codex'},{native_task_binding_id:'x'},{recovery_action:'retry'}])assert.throws(()=>ResumeJobSchema.parse({expected_version:3,recovery_action:'query_original',...extra}));
 assert.deepEqual(ResumeJobSchema.parse({expected_version:3,input:{}}),{expected_version:3,input:{}});
});
