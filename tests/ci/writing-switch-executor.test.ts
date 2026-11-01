// 换执行器重跑（服务端流程，意图先落盘）：预检失败/结果未知/目标不可用都不取消；pending→取消→克隆冻结输入入队；任一步崩溃凭 pending 续做；原输入变化时放弃 pending。
import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from '../documents/harness.ts';import {Topics} from '../../packages/domain/src/topics/index.ts';import {Documents} from '../../packages/domain/src/documents/index.ts';import {WritingFlow} from '../../packages/domain/src/writing-flow/index.ts';import {Jobs} from '../../packages/domain/src/jobs/index.ts';
import {sha256} from '../../packages/storage/src/connection/index.ts';import {DEFAULT_WRITING_EXECUTION,SwitchWritingExecutorSchema,type ExecutorHealth,type WritingRuleSnapshot} from '../../packages/contracts/src/index.ts';
const rule=(content:string):WritingRuleSnapshot=>{const skill='---\nname: personal-ip-writing\ndescription: 测试\n---\n'+content;return {id:sha256(content),created_at:'2026-10-14T00:00:00Z',files:[{name:'本人偏好',kind:'acknowledged_feedback',sha256:sha256(content),content}],skill:{name:'personal-ip-writing',version:'0.1.0',content:skill,sha256:sha256(skill)},scope:'本人'};};
const health=(claude:string):ExecutorHealth[]=>[{executor_id:'codex',status:'unverified',runtime_version:null,auth_state:'QUOTA_EXHAUSTED',billing_route:null,limitations:[]},{executor_id:'claude',status:'unverified',runtime_version:null,auth_state:claude,billing_route:null,limitations:[]}];
async function setup(checkpoint:Record<string,unknown>={}){const f=fixture();let rules=rule('原规则：保留主张'),claude='subscription_authenticated';const context={...f.context(),getExecutorHealth:async()=>health(claude)};
 const topic=await new Topics(context).create(f.request(),{title:'换执行器',category:'个人思考',audience:'创作者',source_ids:[]}),docs=new Documents(context),saved=await docs.save(f.request(),topic.core_document_id,{expected_revision_id:null,text:'本人原稿。'.repeat(80),origin:'human'});
 const flow=new WritingFlow(context,{rules:()=>structuredClone(rules)}),run=flow.start(f.request(),topic.id,{base_revision_id:saved.revision_id,source_ids:[],executor:'codex',instruction:'写清判断',rule_set:'personal-ip-writing',execution_policy:DEFAULT_WRITING_EXECUTION});
 const jobs=new Jobs(context),claim=jobs.claim('owner')!,db=context.db;db.prepare('UPDATE job_attempts SET checkpoint=? WHERE id=?').run(JSON.stringify(checkpoint),claim.attempt.id);jobs.fail(claim.fence,{code:'QUOTA_EXHAUSTED',message:'Codex included usage 当前不可用'},'waiting_quota');
 const job=(id:string)=>db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as {state:string;executor_id:string;input_manifest:string},count=()=>Number(db.prepare("SELECT count(*) n FROM jobs WHERE kind='document_modify'").get()!.n),oldJob=run.stages[0]!.job_id;
 return {f,db,flow,run,docs,topic,saved,job,count,oldJob,raw:()=>flow.raw(f.request(),run.id),setRules:(r:WritingRuleSnapshot)=>{rules=r;},setClaude:(s:string)=>{claude=s;}};}
test('成功：克隆原运行与原任务 manifest 的冻结输入逐字段一致，只换执行器；API 回退配置取原 manifest；等待期间规则变化不影响',async()=>{
 const t=await setup({pre_submit_failure:true,executor_id:'codex'});try{
  assert.throws(()=>SwitchWritingExecutorSchema.parse({executor:'gemini',expected_version:1}));
  const manifest=JSON.parse(t.job(t.oldJob).input_manifest),frozenFallback=manifest.service_agent.api_fallback,ws=t.f.context().identity.workspace_id;
  t.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('api-fallback.v1:'+ws,JSON.stringify({provider:'anthropic',model:'changed-after-start',max_output_tokens:1000}));t.db.prepare('UPDATE workspaces SET api_fallback_enabled=1,version=version+1').run();
  t.setRules(rule('等待期间被改动的新规则'));const original=t.raw();
  const next=await t.flow.switchExecutor(t.f.request('switch-1'),t.run.id,{executor:'claude',expected_version:1});
  assert.equal(t.job(t.oldJob).state,'cancelled');assert.equal(next.executor,'claude');assert.equal(next.parent_run_id,t.run.id);assert.notEqual(next.id,t.run.id);
  for(const field of ['rule_snapshot','skill_bindings','instruction','execution_policy','input_revision_id','input_text_sha256','viewpoints','source_ids','topic_context','export_target'] as const)assert.deepEqual(next[field],original[field],'运行字段 '+field);
  const newJob=t.job(next.stages[0]!.job_id),newManifest=JSON.parse(newJob.input_manifest);assert.equal(newJob.executor_id,'claude');
  for(const field of ['input_evidence','writing_rule_files','writing_skills','skill_route','targets','writing_context','source_ids','execution_policy'])assert.deepEqual(newManifest[field],manifest[field],'manifest 字段 '+field);
  assert.equal(newManifest.writing_rule_files[0].content,'原规则：保留主张');assert.deepEqual(newManifest.service_agent.api_fallback,frozenFallback,'回退配置取原 manifest，不读启动后改过的设置');assert.notEqual(newManifest.service_agent.api_fallback.model,'changed-after-start');
  const after=t.raw();assert.equal(after.switched_to,next.id);assert.equal(after.switch_pending,null);
  assert.equal((await t.flow.switchExecutor(t.f.request('switch-1'),t.run.id,{executor:'claude',expected_version:1})).id,next.id,'同键重放');assert.equal(t.count(),2);
 }finally{t.f.cleanup();}
});
test('原任务提交结果未知（有 handle 无执行前失败证明 / 恢复提交未知）：拒绝换执行器，不取消、不记 pending、不新建',async()=>{
 for(const checkpoint of [{executor_id:'codex',agent_handle:{runtime_session_id:'s',runtime_turn_id:'t'}},{executor_id:'codex',agent_handle:{runtime_session_id:'s'},resume_submission_unknown:true}]){
  const t=await setup(checkpoint);try{
   await assert.rejects(t.flow.switchExecutor(t.f.request(),t.run.id,{executor:'claude',expected_version:1}),(e:{code:string;message:string})=>e.code==='RESULT_UNKNOWN'&&e.message==='原任务提交结果待核对，请先核对再换执行器');
   assert.equal(t.job(t.oldJob).state,'waiting_quota');assert.equal(t.raw().switch_pending,undefined);assert.equal(t.count(),1);
  }finally{t.f.cleanup();}
 }
 const queued=await setup({});try{assert.equal((await queued.flow.switchExecutor(queued.f.request(),queued.run.id,{executor:'claude',expected_version:1})).executor,'claude','从未提交（无 handle）允许');}finally{queued.f.cleanup();}
});
test('预检失败（运行版本过期、核心稿已变、目标执行器不可用）直接拒绝，不取消原任务',async()=>{
 const t=await setup({pre_submit_failure:true});try{
  await assert.rejects(t.flow.switchExecutor(t.f.request(),t.run.id,{executor:'claude',expected_version:5}),{code:'VERSION_CONFLICT'});
  t.setClaude('QUOTA_EXHAUSTED');await assert.rejects(t.flow.switchExecutor(t.f.request(),t.run.id,{executor:'claude',expected_version:1}),{code:'QUOTA_EXHAUSTED'});
  t.setClaude('AUTH_REQUIRED');await assert.rejects(t.flow.switchExecutor(t.f.request(),t.run.id,{executor:'claude',expected_version:1}),{code:'AUTH_REQUIRED'});
  t.setClaude('subscription_authenticated');await t.docs.save(t.f.request(),t.topic.core_document_id,{expected_revision_id:t.saved.revision_id,text:'本人后来改过。'.repeat(80),origin:'human'});
  await assert.rejects(t.flow.switchExecutor(t.f.request(),t.run.id,{executor:'claude',expected_version:1}),{code:'REVISION_CONFLICT',message:'原输入已变化，请新开完整稿流程'});
  assert.equal(t.job(t.oldJob).state,'waiting_quota');assert.equal(t.raw().switch_pending,undefined);assert.equal(t.count(),1);
 }finally{t.f.cleanup();}
});
test('意图先落盘：pending 后取消前崩溃、取消后入队前崩溃，都凭 pending 用同一幂等键续做，只入队一次；换键被拒',async()=>{
 const t=await setup({pre_submit_failure:true});try{
  t.db.exec("CREATE TEMP TRIGGER block_cancel BEFORE INSERT ON job_events WHEN NEW.type='cancelled' BEGIN SELECT RAISE(ABORT,'fixture crash before cancel'); END;");
  await assert.rejects(t.flow.switchExecutor(t.f.request('key-A'),t.run.id,{executor:'claude',expected_version:1}),/fixture crash before cancel/);
  assert.equal(t.job(t.oldJob).state,'waiting_quota');assert.deepEqual([t.raw().switch_pending!.executor,t.raw().switch_pending!.idempotency_key],['claude','key-A']);t.db.exec('DROP TRIGGER block_cancel');
  t.db.exec("CREATE TEMP TRIGGER block_enqueue BEFORE INSERT ON jobs WHEN NEW.kind='document_modify' BEGIN SELECT RAISE(ABORT,'fixture enqueue failure'); END;");
  await assert.rejects(t.flow.switchExecutor(t.f.request('key-A'),t.run.id,{executor:'claude',expected_version:1}),/fixture enqueue failure/);assert.equal(t.job(t.oldJob).state,'cancelled');assert.equal(t.count(),1);
  assert.equal((await t.flow.get(t.f.request(),t.run.id)).switch_pending?.executor,'claude','刷新后状态来自服务端');t.db.exec('DROP TRIGGER block_enqueue');
  await assert.rejects(t.flow.switchExecutor(t.f.request('key-B'),t.run.id,{executor:'claude',expected_version:1}),{code:'IDEMPOTENCY_CONFLICT'});
  const next=await t.flow.switchExecutor(t.f.request('key-A'),t.run.id,{executor:'claude',expected_version:1});assert.equal(t.count(),2);
  assert.equal((await t.flow.switchExecutor(t.f.request('key-A'),t.run.id,{executor:'claude',expected_version:1})).id,next.id);assert.equal(t.count(),2,'重试只入队一次');
 }finally{t.f.cleanup();}
});
test('入队失败后人工改稿：重试返回“原输入已变化”，pending 清除并记为 abandoned，不再提示可以重试',async()=>{
 const t=await setup({pre_submit_failure:true});try{
  t.db.exec("CREATE TEMP TRIGGER block_enqueue BEFORE INSERT ON jobs WHEN NEW.kind='document_modify' BEGIN SELECT RAISE(ABORT,'fixture enqueue failure'); END;");
  await assert.rejects(t.flow.switchExecutor(t.f.request('key-A'),t.run.id,{executor:'claude',expected_version:1}),/fixture enqueue failure/);t.db.exec('DROP TRIGGER block_enqueue');
  await t.docs.save(t.f.request(),t.topic.core_document_id,{expected_revision_id:t.saved.revision_id,text:'本人在等待期间改稿。'.repeat(80),origin:'human'});
  await assert.rejects(t.flow.switchExecutor(t.f.request('key-A'),t.run.id,{executor:'claude',expected_version:1}),{code:'REVISION_CONFLICT',message:'原输入已变化，请新开完整稿流程'});
  const after=t.raw();assert.equal(after.switch_pending,null);assert.equal(after.switch_abandoned?.reason,'input_changed');assert.equal(t.count(),1);
 }finally{t.f.cleanup();}
});
test('并发：不同幂等键只有一个成功、另一个冲突；相同幂等键得到同一个新运行',async()=>{
 const t=await setup({pre_submit_failure:true});try{
  const results=await Promise.allSettled([t.flow.switchExecutor(t.f.request('k1'),t.run.id,{executor:'claude',expected_version:1}),t.flow.switchExecutor(t.f.request('k2'),t.run.id,{executor:'claude',expected_version:1})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.ok(['IDEMPOTENCY_CONFLICT','VERSION_CONFLICT','HOST_RUN_NOT_CURRENT'].includes(rejected.reason.code),rejected.reason.code);assert.equal(t.count(),2);
 }finally{t.f.cleanup();}
 const u=await setup({pre_submit_failure:true});try{
  const [a,b]=await Promise.all([u.flow.switchExecutor(u.f.request('same'),u.run.id,{executor:'claude',expected_version:1}),u.flow.switchExecutor(u.f.request('same'),u.run.id,{executor:'claude',expected_version:1})]);assert.equal(a.id,b.id);assert.equal(u.count(),2);
 }finally{u.f.cleanup();}
});
