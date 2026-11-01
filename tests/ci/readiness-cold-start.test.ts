import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {ExecutorHealth} from '../../packages/contracts/src/index.ts';
import type {ApplicationContext} from '../../packages/domain/src/ports/index.ts';
import {executorHealth} from '../../apps/service/src/bootstrap/execution.ts';
import {runConfigurationProbe} from '../../packages/domain/src/settings/process-probe.ts';
import {Settings} from '../../packages/domain/src/settings/index.ts';
import {TopicOperationsStore} from '../../packages/domain/src/topics/operations.ts';
import {Topics} from '../../packages/domain/src/topics/index.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import {SkillLibrary} from '../../packages/domain/src/skills/library.ts';
import {fixture} from '../documents/harness.ts';

type Executor='codex'|'claude';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const ready=(executor_id:Executor):ExecutorHealth=>({executor_id,status:'supported',runtime_version:'0.161.0',auth_state:'subscription_authenticated',billing_route:executor_id==='codex'?'chatgpt_subscription':'claude_subscription',limitations:[]});
async function operationsFixture(health:ApplicationContext['getExecutorHealth']){
  const f=fixture(),skills=join(f.root,'skills'),directory=join(skills,'personal-ip-operations');mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,'SKILL.md'),'---\nname: personal-ip-operations\ndescription: 固定材料的运营候选\n---\n仅依据本题材料整理候选，不编造事实或自动确认。');
  const context={...f.context(),getExecutorHealth:health},store=new TopicOperationsStore(context,{skill_library:new SkillLibrary(context,{roots:[skills]})});
  const topic=await new Topics(context).create(f.request(),{title:'冷启动隔离主题',category:'个人思考',audience:'fixture',source_ids:[]});
  return {...f,context,store,topic};
}

test('普通 settings GET 在两个探针仍pending时立即返回占位，读取无数据库写入',async()=>{
  const f=fixture(),pending={codex:deferred<ExecutorHealth>(),claude:deferred<ExecutorHealth>()},calls={codex:0,claude:0};
  const health=executorHealth('fixture','/unused',{probe:id=>{calls[id]++;return pending[id].promise;}}),context={...f.context(),getExecutorHealth:health};
  try{
    const before=context.db.prepare('SELECT total_changes() n').get()!.n;let completed=false;
    const reading=new Settings(context).get(f.request()).then(value=>{completed=true;return value;});await flush();assert.equal(completed,true);
    const value=await reading;assert.deepEqual(value.executors.map(row=>[row.auth_state,row.billing_route]),[['not_checked',null],['not_checked',null]]);assert.deepEqual(calls,{codex:1,claude:1});
    await new Settings(context).get(f.request());assert.deepEqual(calls,{codex:1,claude:1});assert.equal(context.db.prepare('SELECT total_changes() n').get()!.n,before);
  }finally{pending.codex.resolve(ready('codex'));pending.claude.resolve(ready('claude'));await flush();f.cleanup();}
});

test('提交等待复用后台所选探针，Codex已完成无需等仍pending的Claude',async()=>{
  const pending={codex:deferred<ExecutorHealth>(),claude:deferred<ExecutorHealth>()},calls={codex:0,claude:0};
  const health=executorHealth('fixture','/unused',{probe:id=>{calls[id]++;return pending[id].promise;}});
  try{
    await health();let completed=false;const decision=health({wait_for:'codex'}).then(value=>{completed=true;return value;});await flush();assert.equal(completed,false);assert.deepEqual(calls,{codex:1,claude:1});
    pending.codex.resolve(ready('codex'));const value=await decision;assert.equal(value[0]!.billing_route,'chatgpt_subscription');assert.equal(value[1]!.auth_state,'not_checked');assert.deepEqual(calls,{codex:1,claude:1});
    await health({wait_for:'codex'});assert.deepEqual(calls,{codex:1,claude:1});
  }finally{pending.claude.resolve(ready('claude'));await flush();}
});

test('仅提交路径冷启动只检查所选执行器；并发和缓存过期共享检查，显式refresh兼容原接口',async()=>{
  let now=0;const calls={codex:0,claude:0},pending=deferred<ExecutorHealth>();
  const health=executorHealth('fixture','/unused',{now:()=>now,probe:id=>{calls[id]++;return calls.codex===1&&id==='codex'?pending.promise:Promise.resolve(ready(id));}});
  const first=health({wait_for:'codex'}),second=health({wait_for:'codex'});await flush();assert.deepEqual(calls,{codex:1,claude:0});pending.resolve(ready('codex'));await Promise.all([first,second]);
  await health({wait_for:'codex'});assert.deepEqual(calls,{codex:1,claude:0});now=30_001;await Promise.all([health({wait_for:'codex'}),health({wait_for:'codex'})]);assert.deepEqual(calls,{codex:2,claude:0});
  await Promise.all([health(true),health(true)]);assert.deepEqual(calls,{codex:3,claude:1});await health(false);assert.deepEqual(calls,{codex:3,claude:1});
});

test('冷启动并发ensure等真实ready，不持久占位blocked且只排一个运营任务',async()=>{
  const pending=deferred<ExecutorHealth>(),entered=deferred<void>(),calls={codex:0,claude:0};
  const health=executorHealth('fixture','/unused',{probe:id=>{calls[id]++;entered.resolve(undefined);return pending.promise;}}),f=await operationsFixture(health);
  try{
    const first=f.store.ensure(f.request(),f.topic.id),second=f.store.ensure(f.request(),f.topic.id);await entered.promise;
    assert.deepEqual(calls,{codex:1,claude:0});assert.equal(f.context.db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,0);assert.equal(f.context.db.prepare("SELECT COUNT(*) n FROM application_metadata WHERE key LIKE 'topic-operations.%'").get()!.n,0);
    const reading=await f.store.get(f.request(),f.topic.id);assert.equal(reading.automation!.state,'missing');assert.deepEqual(calls,{codex:1,claude:0});
    pending.resolve(ready('codex'));const [a,b]=await Promise.all([first,second]);assert.equal(a.automation!.state,'queued');assert.equal(a.automation!.error,null);assert.equal(a.automation!.job_id,b.automation!.job_id);assert.equal(f.context.db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,1);
    await f.store.ensure(f.request(),f.topic.id);assert.deepEqual(calls,{codex:1,claude:0});assert.equal(f.context.db.prepare('SELECT head_revision_id FROM documents WHERE id=?').get(f.topic.core_document_id)!.head_revision_id,null);
  }finally{pending.resolve(ready('codex'));await flush();f.cleanup();}
});

test('等待中切换默认执行器：job冻结到已准入Codex，不用Codex健康放行未核对Claude',async()=>{
  const pending=deferred<ExecutorHealth>(),entered=deferred<void>(),calls={codex:0,claude:0};
  const health=executorHealth('fixture','/unused',{probe:id=>{calls[id]++;if(id==='codex'){entered.resolve(undefined);return pending.promise;}return Promise.resolve({...ready(id),status:'unconfigured',auth_state:'AUTH_REQUIRED',billing_route:null});}}),f=await operationsFixture(health);
  try{
    const ensuring=f.store.ensure(f.request(),f.topic.id);await entered.promise;
    f.context.db.prepare("UPDATE workspaces SET default_executor='claude' WHERE workspace_id=?").run(f.config.workspace_id);
    pending.resolve(ready('codex'));const value=await ensuring;
    assert.equal(value.automation!.state,'queued');const job=f.context.db.prepare('SELECT executor_id FROM jobs WHERE id=?').get(value.automation!.job_id!)!;
    assert.equal(job.executor_id,'codex');assert.equal(f.context.db.prepare('SELECT default_executor FROM workspaces WHERE workspace_id=?').get(f.config.workspace_id)!.default_executor,'claude');assert.deepEqual(calls,{codex:1,claude:0});assert.equal(f.context.db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,1);
    await f.store.ensure(f.request(),f.topic.id);assert.deepEqual(calls,{codex:1,claude:0});assert.equal(f.context.db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,1);
  }finally{pending.resolve(ready('codex'));await flush();f.cleanup();}
});

test('已完成的未登录、额度耗尽和不支持结果仍blocked，无生成job或自动重探测',async()=>{
  for(const [status,auth] of [['unconfigured','AUTH_REQUIRED'],['unverified','QUOTA_EXHAUSTED'],['unsupported','CAPABILITY_UNVERIFIED']] as const){
    let calls=0;const health=executorHealth('fixture','/unused',{probe:async id=>{calls++;return {...ready(id),status,auth_state:auth,billing_route:null};}}),f=await operationsFixture(health);
    try{
      const value=await f.store.ensure(f.request(),f.topic.id);assert.equal(value.automation!.state,'blocked');assert.equal(value.automation!.job_id,null);assert.match(value.automation!.error!,/订阅执行器尚未就绪/);assert.equal(f.context.db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,0);
      await f.store.ensure(f.request(),f.topic.id);await f.store.get(f.request(),f.topic.id);assert.equal(calls,1);
    }finally{f.cleanup();}
  }
});

test('超时探针有界结束；GET不恢复，缓存过期后原ensure可恢复且保留人工核心稿',async()=>{
  let now=0,calls=0;const f=fixture(),script=join(f.root,'timed-fake-probe.mjs');writeFileSync(script,'setTimeout(() => {}, 5000);');
  const health=executorHealth('fixture','/unused',{now:()=>now,probe:id=>{calls++;return calls===1?runConfigurationProbe<ExecutorHealth>(pathToFileURL(script),{},30):Promise.resolve(ready(id));}});
  const skills=join(f.root,'skills'),directory=join(skills,'personal-ip-operations');mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'SKILL.md'),'---\nname: personal-ip-operations\ndescription: 隔离超时恢复\n---\n只读固定材料。');
  const context={...f.context(),getExecutorHealth:health},store=new TopicOperationsStore(context,{skill_library:new SkillLibrary(context,{roots:[skills]})}),topic=await new Topics(context).create(f.request(),{title:'超时恢复fixture',category:'个人思考',audience:'',source_ids:[]}),docs=new Documents(context);
  try{
    const saved=await docs.save(f.request(),topic.core_document_id,{expected_revision_id:null,text:'本人手写原稿保持不变',origin:'human'});
    const first=await store.ensure(f.request(),topic.id);assert.equal(first.automation!.state,'blocked');assert.equal(calls,1);assert.equal(context.db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,0);
    now=30_001;assert.equal((await store.get(f.request(),topic.id)).automation!.state,'blocked');assert.equal(calls,1);
    const [a,b]=await Promise.all([store.ensure(f.request(),topic.id),store.ensure(f.request(),topic.id)]);assert.equal(a.automation!.state,'queued');assert.equal(a.automation!.error,null);assert.equal(a.automation!.job_id,b.automation!.job_id);assert.equal(calls,2);assert.equal(context.db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,1);
    assert.equal((await docs.get(f.request(),topic.core_document_id)).head_revision_id,saved.revision_id);assert.equal((await docs.get(f.request(),topic.core_document_id)).text,'本人手写原稿保持不变');
  }finally{f.cleanup();}
});

test('调用器抛错不会悬住pending；已完成失败按缓存恢复，不重复排队',async()=>{
  let now=0,calls=0;const health=executorHealth('fixture','/unused',{now:()=>now,probe:async id=>{if(++calls===1)throw new Error('fake CLI unavailable');return ready(id);}});
  const first=await health({wait_for:'codex'});assert.equal(first[0]!.billing_route,null);assert.match(first[0]!.limitations[0]!,/检查超时或工具暂不可用/);await health({wait_for:'codex'});assert.equal(calls,1);
  now=30_001;const restored=await health({wait_for:'codex'});assert.equal(restored[0]!.billing_route,'chatgpt_subscription');assert.equal(calls,2);
});
