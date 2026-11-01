import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture,writeEvidence} from '../documents/harness.ts';
import {Sources} from '../../packages/domain/src/sources/index.ts';
import {BenchmarkSync} from '../../packages/domain/src/sources/benchmark-sync.ts';
import {TikHubAdapter} from '../../packages/adapters/src/tikhub/index.ts';
import {DurableWorker} from '../../apps/service/src/worker/core/index.ts';
import {ContentGeneration,validateContentOutput,AccountResearch} from '../../packages/domain/src/content-agents/index.ts';
import {SkillLibrary} from '../../packages/domain/src/skills/library.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import {transaction,sha256} from '../../packages/storage/src/connection/index.ts';
import {commitObservationInTransaction,ensureMetricsSourceInTransaction} from '../../packages/storage/src/metrics/index.ts';
import {buildServiceAgentPlan} from '../../packages/domain/src/service-agent/index.ts';
import {readWritingSkills} from '../../packages/adapters/src/agent/skills.ts';
import {RESEARCH_DIMENSIONS,RESEARCH_GOALS,type AccountResearchReport,type AccountResearchPlan,type JsonObject} from '../../packages/contracts/src/index.ts';
import {startApplication,type RunningApplication} from '../../apps/service/src/bootstrap/application.ts';
import {createGenerationModule} from '../../apps/service/src/routes/generation.ts';
import {resolveWorkbenchRoute,routeRequest,WORKBENCH_TOOL_ROUTES} from '../../packages/host-bridge/src/core/tools.ts';

async function setup(platform:'x'|'douyin'='x',n=6){
 const f=fixture(),root=join(f.root,'skills'),directory=join(root,'personal-ip-operations');mkdirSync(directory,{recursive:true});
 writeFileSync(join(directory,'SKILL.md'),'---\nname: personal-ip-operations\ndescription: 从真实作品研究运营方法\n---\n参考 [数据边界](evidence.md)。对标是待验证方法，不是本人实绩。');writeFileSync(join(directory,'evidence.md'),'采集时间不替代平台观察时间；缺字幕不能冒充口播。');
 const sources=new Sources(f.context()),sec='MS4w'+'a'.repeat(20),url=platform==='x'?'https://x.com/bench':'https://www.douyin.com/user/'+sec,id=sources.createAccount(f.request(),{role:'benchmark',platform,url,name:'测试对标'}).account_id;
 f.context().db.prepare("UPDATE accounts SET platform_account_id='123',identity_status='confirmed' WHERE id=?").run(id);
 const posts=Array.from({length:n},(_,i)=>({id:String(100+i),published:new Date(Date.parse('2026-10-01T00:00:00Z')+i*86400000).toISOString()}));
 const data=platform==='x'?{timeline:posts.map(p=>({tweet_id:p.id,text:'AI 工作流 '+p.id+'\n先说明读者障碍，再展示真实步骤和结果。',created_at:p.published,author:{id_str:'123',screen_name:'bench',name:'测试对标'},favorites:10000,views:9000}))}:{aweme_list:posts.map(p=>({aweme_id:p.id,desc:'AI 视频说明 '+p.id,create_time:Date.parse(p.published)/1000,author:{uid:'123',sec_uid:sec,nickname:'测试对标'},statistics:{digg_count:10000,play_count:0},video:{duration:30000}}))};
 const adapter=new TikHubAdapter({fixture:true,token_provider:()=> 'fixture-token',fetcher:async()=>new Response(JSON.stringify({code:200,data}))}),sync=new BenchmarkSync(f.context(),adapter);
 sync.enqueue(f.request(),id);await new DurableWorker(f.context(),[{registration:{kind:'benchmark_sync',execution_mode:'programmatic',recovery:'read_only'},async execute(e){await sync.execute(e.claim.job.id,JSON.parse(e.claim.job.input_manifest),{fence:e.claim.fence,signal:e.signal,checkpoint:e.checkpoint});return {documents:[],recommendations:[]};}}]).runOnce();
 const library=()=>new SkillLibrary(f.context(),{roots:[root]}),research=()=>new AccountResearch(f.context(),library()),generation=()=>new ContentGeneration(f.context(),{skill_library:library()});
 return {...f,id,posts,directory,sources,library,research,generation,platform};
}
type F=Awaited<ReturnType<typeof setup>>;
function addCapture(f:F,workId:string,value:string|null,age=86400,format?:string,key=f.platform==='x'?'views':'plays',targetWindow=86400){
 const db=f.context().db,w=f.config.workspace_id,work=db.prepare('SELECT * FROM works WHERE workspace_id=? AND id=?').get(w,workId)!;if(format)db.prepare('UPDATE works SET format=? WHERE id=?').run(format,workId);
 const observed=new Date(Date.parse(String(work.published_at))+age*1000).toISOString(),raw=JSON.stringify({work:workId,value,at:observed}),path=join(f.config.paths.state_root,randomUUID()+'.json');writeFileSync(path,raw);
 return transaction(db,()=>commitObservationInTransaction(db,w,ensureMetricsSourceInTransaction(db,w),{platform:f.platform,scope:'work',target_id:workId,platform_work_id:String(work.platform_work_id),account_id:f.id,collection_request_id:randomUUID(),request_fingerprint:sha256(randomUUID()),observed_at:observed,observed_time_basis:'provider',observed_time_reason:null,observation_evidence_ref:'fixture_verified_observation',collected_at:observed,published_at:String(work.published_at),target_window:targetWindow,raw_path:path,raw_sha256:sha256(raw),adapter_version:'research-fixture/1',metrics:[{definition:{platform:f.platform,scope:'work',key,raw_field:'fixture.'+key,unit:'count',kind:'cumulative',visibility:'public',definition_version:'research-fixture/1'},value,availability:value===null?'unavailable':'available',reason:value===null?'fixture_missing':null}],failure:null,retry_after_s:null,evidence_kind:'real_platform'})).snapshot_id;
}
function report(plan:AccountResearchPlan):AccountResearchReport{
 const keys=plan.source_record_ids.map(id=>'source:'+id);
 return {schema_version:1,summary:'用可见正文拆步骤与证据，再做本人作品试验。',facts:[{text:'所选作品包含操作步骤。',evidence_keys:[keys[0]!]}],analyses:RESEARCH_DIMENSIONS.map(dimension=>({dimension,status:dimension==='trends'?'insufficient':'supported',text:dimension==='trends'?'缺少可比观察数据，不能判断趋势。':'先指出障碍，再给出步骤与依据。',evidence_keys:[keys[0]!]})),samples:plan.samples.slice(0,2).map(sample=>({source_id:sample.source_id,polarity:'contrast',aspect:'开头与步骤',analysis_scope:sample.content_basis==='description_only'?'video_description':'written_text',performance_claim:'not_comparable',text:'可见文字先提出任务；这只是表达机制对照。',evidence_keys:['source:'+sample.source_id]})),hypotheses:[{text:'明确步骤或能帮助理解。',evidence_keys:[keys[0]!],missing_evidence:'本人下一篇的实际提问与操作反馈'}],recommendations:RESEARCH_GOALS.map(goal=>({goal,text:'先验证读者能否完成一步。',evidence_keys:[keys[0]!],action:'下一篇只改开头的任务说明。',prerequisite:'有本人实际演示与结果，改稿约十分钟。',measurement:'记录具体问题与操作反馈，不把曝光当咨询。',adoption_status:'proposed'})),limitations:plan.limitations};
}
async function execute(f:F){return new DurableWorker(f.context(),[{registration:{kind:'document_modify',execution_mode:'service_adapter',recovery:'read_only'},async execute(e){const manifest=JSON.parse(e.claim.job.input_manifest),plan=buildServiceAgentPlan(f.context(),e.claim,{staging_root:join(f.config.paths.state_root,'generation-staging')});assert.equal(plan.api_fallback!.enabled,false);assert.equal(readWritingSkills(plan.input.input_manifest)[0]!.name,'personal-ip-operations');assert.equal(manifest.research_skill.base_local_skill.references.length,1);return validateContentOutput(manifest,{documents:[{document_id:manifest.targets[0].document_id,text:JSON.stringify(report(manifest.research_context.plan))}],recommendations:[]});}}]).runOnce();}
const jobCount=(f:F)=>Number(f.context().db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='document_modify'").get()!.n);

test('研究预览只读，正文/视频覆盖准确，未知观察与缺plays不排名',async()=>{
 for(const platform of ['x','douyin'] as const){const f=await setup(platform);try{
  const before=f.context().db.prepare('SELECT SUM(n) n FROM (SELECT COUNT(*) n FROM jobs UNION ALL SELECT COUNT(*) n FROM documents UNION ALL SELECT COUNT(*) n FROM application_metadata)').get()!.n;
  const first=await f.research().get(f.request(),f.id),second=await f.research().get(f.request(),f.id);assert.deepEqual(first,second);assert.equal(first.history.length,0);assert.equal(first.plan.coverage.sample_count,6);assert.equal(first.plan.comparisons.status,'insufficient');assert.ok(first.plan.samples.every(s=>s.comparison_group===null));assert.equal(first.plan.trends.account,'insufficient');assert.equal(first.plan.coverage.full_text_count,platform==='x'?6:0);assert.equal(first.plan.coverage.transcription_rate,platform==='douyin'?0:null);
  assert.equal(f.context().db.prepare('SELECT SUM(n) n FROM (SELECT COUNT(*) n FROM jobs UNION ALL SELECT COUNT(*) n FROM documents UNION ALL SELECT COUNT(*) n FROM application_metadata)').get()!.n,before);assert.equal(jobCount(f),0);assert.ok(!readdirSync(f.config.paths.state_root).includes('generation-staging'));
 }finally{f.cleanup();}}
});
test('公平观察用秒窗口/同格式定义/真实龄；大整数排序保持精度，少于4篇不作表现对照',async()=>{
 const f=await setup();try{const works=f.context().db.prepare('SELECT id FROM works ORDER BY platform_work_id').all();for(let i=0;i<4;i++)addCapture(f,String(works[i]!.id),String(9007199254740992n+BigInt(i)));addCapture(f,String(works[4]!.id),'999999999999999999',86400,'image_post');addCapture(f,String(works[5]!.id),'999999999999999999',90001);
  const plan=(await f.research().get(f.request(),f.id)).plan;assert.equal(plan.comparisons.status,'available');assert.equal(plan.comparisons.groups,1);assert.equal(plan.samples.find(s=>s.selection==='higher_observed')!.metric_value,'9007199254740995');assert.equal(plan.samples.find(s=>s.selection==='lower_observed')!.metric_value,'9007199254740992');assert.equal(plan.samples.find(s=>s.format==='image_post')!.comparison_group,null);assert.equal(plan.samples.find(s=>s.work_id===works[5]!.id)!.comparison_group,null);
 }finally{f.cleanup();}
});
test('每个观察窗口先各自选作品快照，不因部分作品另有24h快照丢失足量72h组',async()=>{
 const f=await setup();try{const works=f.context().db.prepare('SELECT id FROM works ORDER BY id').all();for(let i=0;i<4;i++)addCapture(f,String(works[i]!.id),String(100+i),259200,undefined,'views',259200);for(let i=0;i<2;i++)addCapture(f,String(works[i]!.id),String(10+i));const plan=(await f.research().get(f.request(),f.id)).plan;assert.equal(plan.comparisons.status,'available');assert.equal(plan.comparisons.groups,1);assert.ok(plan.samples.filter(s=>s.comparison_group).every(s=>s.comparison_group!.endsWith(':259200')));
 }finally{f.cleanup();}
});
test('预览后正文或技能引用变化拒绝旧input；无关联资料不能混入，固定技能组合参与复用',async()=>{
 const f=await setup();try{const view=await f.research().get(f.request(),f.id),g=f.generation();writeFileSync(join(f.directory,'evidence.md'),'已经变化的研究数据规则');await assert.rejects(g.research(f.request(),f.id,{executor:'codex',source_record_ids:view.plan.source_record_ids,input_version:view.plan.input_version}),{code:'INPUT_STALE'});assert.equal(jobCount(f),0);
  const fresh=await f.research().get(f.request(),f.id);await assert.rejects(g.research(f.request(),f.id,{executor:'codex',source_record_ids:[...fresh.plan.source_record_ids,'unrelated']}),{code:'VALIDATION_ERROR'});assert.equal(jobCount(f),0);
  const [one,two]=await Promise.all([g.research(f.request(),f.id,{executor:'codex',source_record_ids:fresh.plan.source_record_ids,input_version:fresh.plan.input_version}),g.research(f.request(),f.id,{executor:'codex',source_record_ids:fresh.plan.source_record_ids,input_version:fresh.plan.input_version})]);assert.equal(one.job_id,two.job_id);assert.equal(jobCount(f),1);
  const route={settings_version:1,skills:['workbench-evidence-notes']};const three=await g.research(f.request(),f.id,{executor:'codex',source_record_ids:fresh.plan.source_record_ids,input_version:fresh.plan.input_version,skill_route:route});assert.notEqual(three.job_id,one.job_id);assert.equal(jobCount(f),2);
 }finally{f.cleanup();}
});
test('候选不自动采用；采用后资料变化产生独立报告，旧采用报告/冻结来源保留，改稿仍可回查',async()=>{
 const f=await setup();try{const first=await f.research().get(f.request(),f.id),g=f.generation(),accepted=await g.research(f.request(),f.id,{executor:'codex',source_record_ids:first.plan.source_record_ids,input_version:first.plan.input_version});await execute(f);let view=await f.research().get(f.request(),f.id);assert.equal(view.history[0]!.state,'succeeded');assert.equal(view.history[0]!.adopted_revision_id,null);assert.equal((await new Documents(f.context()).get(f.request(),accepted.document_id!)).head_revision_id,null);
  await new Documents(f.context()).adoptCandidate(f.request(),view.history[0]!.candidate_id!,{expected_revision_id:null});view=await f.research().get(f.request(),f.id);const old=view.history[0]!.adopted_revision_id;assert.ok(old);
  const frozen=String(f.context().db.prepare('SELECT input_manifest FROM jobs WHERE id=?').get(accepted.job_id)!.input_manifest),row=f.context().db.prepare('SELECT payload FROM source_records WHERE id=?').get(first.plan.source_record_ids[0]!)!,payload=JSON.parse(String(row.payload));payload.body+='\n新增事实';f.context().db.prepare('UPDATE source_records SET payload=? WHERE id=?').run(JSON.stringify(payload),first.plan.source_record_ids[0]!);
  const fresh=(await f.research().get(f.request(),f.id)).plan;assert.notEqual(fresh.input_version,first.plan.input_version);const second=await g.research(f.request(),f.id,{executor:'codex',source_record_ids:fresh.source_record_ids,input_version:fresh.input_version});assert.notEqual(second.document_id,accepted.document_id);assert.equal(String(f.context().db.prepare('SELECT input_manifest FROM jobs WHERE id=?').get(accepted.job_id)!.input_manifest),frozen);assert.equal((await new Documents(f.context()).get(f.request(),accepted.document_id!)).head_revision_id,old);
  const edit=await g.modify(f.request(),accepted.document_id!,{base_revision_id:old!,source_ids:[],executor:'codex',instruction:'保留结构，明确适用条件'});assert.ok((await f.research().get(f.request(),f.id)).history.some(h=>h.job_id===edit.job_id));const manifest=JSON.parse(String(f.context().db.prepare('SELECT input_manifest FROM jobs WHERE id=?').get(edit.job_id)!.input_manifest));assert.equal(manifest.research_generation,true);assert.equal(manifest.content_purpose,'research');assert.throws(()=>validateContentOutput(manifest,{documents:[{document_id:accepted.document_id!,text:'## 事实\n随意文本'}],recommendations:[]}));
 }finally{f.cleanup();}
});
test('不接受假来源、缺维度、虚假口播、无公平组与增粉因果；缺值快照不构成趋势',async()=>{
 const f=await setup('douyin');try{const works=f.context().db.prepare('SELECT id FROM works ORDER BY id').all();addCapture(f,String(works[0]!.id),null);addCapture(f,String(works[0]!.id),null,172800);addCapture(f,String(works[1]!.id),'100');const view=await f.research().get(f.request(),f.id);assert.equal(view.plan.trends.works,'captures_only');assert.equal(view.plan.comparisons.status,'insufficient');assert.ok(view.plan.samples.every(s=>s.comparison_group===null));
  const accepted=await f.generation().research(f.request(),f.id,{executor:'codex',source_record_ids:view.plan.source_record_ids,input_version:view.plan.input_version}),manifest=JSON.parse(String(f.context().db.prepare('SELECT input_manifest FROM jobs WHERE id=?').get(accepted.job_id)!.input_manifest)),valid=report(view.plan),validate=(data:AccountResearchReport)=>validateContentOutput(manifest,{documents:[{document_id:accepted.document_id!,text:JSON.stringify(data)}],recommendations:[]});assert.doesNotThrow(()=>validate(valid));
  for(const change of [(r:AccountResearchReport)=>r.facts[0]!.evidence_keys=['source:invented'],(r:AccountResearchReport)=>r.analyses.pop(),(r:AccountResearchReport)=>r.samples[0]!.analysis_scope='spoken_text',(r:AccountResearchReport)=>r.samples[0]!.performance_claim='comparable',(r:AccountResearchReport)=>r.summary='标题导致涨粉1000']){const altered=structuredClone(valid);change(altered);assert.throws(()=>validate(altered),{code:'VALIDATION_ERROR'});}const negative=structuredClone(valid);negative.summary='现有数据不足以证明该标题导致涨粉。';assert.doesNotThrow(()=>validate(negative));negative.summary='现有数据不足以证明效果，但标题导致涨粉1000。';assert.throws(()=>validate(negative),{code:'VALIDATION_ERROR'});
 }finally{f.cleanup();}
});
test('失败/结果未知复用已有任务，当前原始快照损坏不阻断已采用历史',async()=>{
 const f=await setup();try{const works=f.context().db.prepare('SELECT id FROM works ORDER BY id').all();for(let i=0;i<4;i++)addCapture(f,String(works[i]!.id),String(10+i));const view=await f.research().get(f.request(),f.id),g=f.generation(),input={executor:'codex' as const,source_record_ids:view.plan.source_record_ids,input_version:view.plan.input_version},first=await g.research(f.request(),f.id,input);
  f.context().db.prepare("UPDATE jobs SET state='failed' WHERE id=?").run(first.job_id);assert.equal((await g.research(f.request(),f.id,input)).job_id,first.job_id);assert.equal(jobCount(f),1);f.context().db.prepare("UPDATE jobs SET state='queued' WHERE id=?").run(first.job_id);await execute(f);let history=(await f.research().get(f.request(),f.id)).history;await new Documents(f.context()).adoptCandidate(f.request(),history[0]!.candidate_id!,{expected_revision_id:null});const snapshot=f.context().db.prepare('SELECT raw_path FROM snapshots WHERE target_window=86400 LIMIT 1').get()!;writeFileSync(String(snapshot.raw_path),'corrupted fixture');const broken=await f.research().get(f.request(),f.id);assert.ok(broken.plan.blocked);assert.equal(broken.history[0]!.adopted_revision_id,history[0]!.revision_id);assert.ok(await g.preview(f.request(),broken.history[0]!.candidate_id!));
 }finally{f.cleanup();}
});
test('正式HTTP/MCP预览无写、生成异步body与幂等一致，公开合同固定研究范围',async()=>{
 const f=await setup();let app:RunningApplication|undefined;try{const preview=(await f.research().get(f.request(),f.id)).plan;f.closeDb();app=await startApplication(f.config,{port:0,moduleFactories:[context=>createGenerationModule(context,{skill_library:new SkillLibrary(context,{roots:[join(f.root,'skills')]})})],executorHealth:async()=>[]});
  const endpoint='http://127.0.0.1:'+app.address.port+'/api/v1/accounts/'+f.id+'/research',headers={'Content-Type':'application/json','X-Workspace-Id':f.config.workspace_id,'X-Service-Instance-Id':f.config.service_instance_id};
  const before=app.context.db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n;for(let i=0;i<2;i++){const response=await fetch(endpoint,{headers});assert.equal(response.status,200);assert.equal((await response.json()).plan.input_version,preview.input_version);}assert.equal(app.context.db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,before);
  const input={source_record_ids:preview.source_record_ids,input_version:preview.input_version,executor:'codex'},call=()=>fetch(endpoint,{method:'POST',headers:{...headers,'Idempotency-Key':'research-http-fixture'},body:JSON.stringify(input)});const one=await call();assert.equal(one.status,202);const accepted=await one.json();assert.equal(typeof accepted.job_id,'string');assert.equal(typeof accepted.document_id,'string');assert.deepEqual(await (await call()).json(),accepted);assert.equal(app.context.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='document_modify'").get()!.n,1);
  const get=resolveWorkbenchRoute('GET','/api/v1/accounts/'+f.id+'/research',undefined);assert.equal(get.name,'get_account_research');assert.equal(WORKBENCH_TOOL_ROUTES.find(r=>r.name===get.name)!.idempotent,false);assert.equal(routeRequest(WORKBENCH_TOOL_ROUTES.find(r=>r.name===get.name)!,get.input).method,'GET');
  const post=resolveWorkbenchRoute('POST','/api/v1/accounts/'+f.id+'/research',input,{idempotencyKey:'research-mcp-fixture'});assert.equal(post.name,'service_research_account');assert.deepEqual(routeRequest(WORKBENCH_TOOL_ROUTES.find(r=>r.name===post.name)!,post.input).body,input);
  const openapi=JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json',import.meta.url),'utf8'));assert.equal(openapi.paths['/api/v1/accounts/{id}/research'].get.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/AccountResearchView');assert.equal(openapi.components.schemas.AccountResearchReport.additionalProperties,false);assert.ok(openapi.components.schemas.ResearchRequest.properties.input_version);
 }finally{await app?.close();f.cleanup();}
});


test('P2-A: 35 次合法改稿挤出展示历史，同输入新幂等键仍复用旧 job/document',async()=>{
 const f=await setup();try{
  const g=f.generation(),view=await f.research().get(f.request(),f.id),input={executor:'codex' as const,source_record_ids:view.plan.source_record_ids,input_version:view.plan.input_version};
  const first=await g.research(f.request('p2-first'),f.id,input);await execute(f);
  const original=(await f.research().get(f.request(),f.id)).history[0]!;
  await new Documents(f.context()).adoptCandidate(f.request(),original.candidate_id!,{expected_revision_id:null});
  for(let i=0;i<35;i++)g.modify(f.request('p2-edit-'+i),first.document_id!,{executor:'codex',base_revision_id:original.revision_id,source_ids:[],instruction:'保留固定依据，明确适用条件 '+i});
  const history=f.research().history(f.request(),f.id);assert.equal(history.length,30);assert.ok(!history.some(row=>row.job_id===first.job_id));
  const counts=()=>({jobs:jobCount(f),documents:Number(f.context().db.prepare("SELECT COUNT(*) n FROM documents WHERE kind='account_research'").get()!.n),attempts:Number(f.context().db.prepare('SELECT COUNT(*) n FROM job_attempts').get()!.n)}),before=counts();
  const reused=await g.research(f.request('p2-new-key'),f.id,input);assert.equal(reused.job_id,first.job_id);assert.equal(reused.document_id,first.document_id);assert.deepEqual(counts(),before);
  for(const state of ['failed','reconciling','cancel_requested']){
   f.context().db.prepare('UPDATE jobs SET state=? WHERE id=?').run(state,first.job_id);
   if(state==='reconciling')f.context().db.prepare('UPDATE job_attempts SET checkpoint=? WHERE job_id=?').run(JSON.stringify({agent_handle:{state:'unknown',checkpoint:{submission_unknown:true}}}),first.job_id);
   assert.equal((await g.research(f.request('p2-state-'+state),f.id,input)).job_id,first.job_id);assert.deepEqual(counts(),before);
  }
  f.context().db.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").run(first.job_id);
  const replacement=await g.research(f.request('p2-after-cancel'),f.id,input);assert.notEqual(replacement.job_id,first.job_id);assert.notEqual(replacement.document_id,first.document_id);assert.equal(jobCount(f),before.jobs+1);assert.equal(f.research().history(f.request(),f.id).length,30);
  writeEvidence('dedup-history.json',{passed:true,fixture_only:true,edits:35,history_limit:history.length,old_job_hidden:true,reused_same_job_and_document:true,no_new_job_document_attempt:true,failed_unknown_cancel_requested_reused:true,cancelled_new_job:true,counts_before:before});
 }finally{f.cleanup();}
});

test('P2-A: 相同 fingerprint 按 workspace/account/executor 隔离，身份不匹配拒收',async()=>{
 const f=await setup();try{
  const g=f.generation(),plan=(await f.research().get(f.request(),f.id)).plan,input={executor:'codex' as const,source_record_ids:plan.source_record_ids,input_version:plan.input_version},one=await g.research(f.request(),f.id,input),db=f.context().db;
  const job=db.prepare('SELECT * FROM jobs WHERE id=?').get(one.job_id)!,manifest=JSON.parse(String(job.input_manifest)),fingerprint=manifest.research_execution_fingerprint;
  const otherAccount=f.sources.createAccount(f.request(),{role:'benchmark',platform:'x',name:'另一个对标',url:'https://x.com/other'}).account_id,otherWorkspace=randomUUID();
  db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES(?,?,?,?,?,?,1)').run(otherWorkspace,otherWorkspace,'isolated collision',f.config.timezone,JSON.stringify(f.config.paths),'demo');
  const clone=(workspace:string,account:string)=>{
   const document=randomUUID(),id=randomUUID();db.prepare("INSERT INTO documents(id,workspace_id,kind,owner_entity_id,version) VALUES(?,?,'account_research',?,1)").run(document,workspace,account);
   const frozen=structuredClone(manifest);frozen.targets[0].document_id=document;
   const row:Record<string,string|number|null>={...job,id,workspace_id:workspace,target_id:account,input_manifest:JSON.stringify(frozen),created_at:'2099-01-01T00:00:00Z'},columns=Object.keys(row);
   db.prepare('INSERT INTO jobs('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...columns.map(key=>row[key] as string|number|null));return {job_id:id,document_id:document};
  };
  const alien=clone(otherWorkspace,f.id),second=clone(f.config.workspace_id,otherAccount);
  assert.equal((await g.research(f.request(),f.id,input)).job_id,one.job_id);
  assert.deepEqual(f.research().existing(f.request(),otherAccount,fingerprint,'codex'),second);
  const alienContext={...f.context(),identity:{...f.context().identity,workspace_id:otherWorkspace}},alienResearch=new AccountResearch(alienContext);
  assert.deepEqual(alienResearch.existing({...f.request(),workspace_id:otherWorkspace},f.id,fingerprint,'codex'),alien);
  for(const request of [{...f.request(),workspace_id:otherWorkspace},{...f.request(),service_instance_id:randomUUID()},{...f.request(),contract_version:'invalid'}])assert.throws(()=>f.research().existing(request as ReturnType<typeof f.request>,f.id,fingerprint,'codex'),{code:'WORKSPACE_INSTANCE_MISMATCH'});
  const claude=await g.research(f.request(),f.id,{...input,executor:'claude'});assert.notEqual(claude.job_id,one.job_id);assert.equal((await g.research(f.request(),f.id,{...input,executor:'claude'})).job_id,claude.job_id);
  assert.equal(f.research().existing(f.request(),f.id,'different-fingerprint','codex'),null);
  const changed=await g.research(f.request(),f.id,{...input,skill_route:{settings_version:1,skills:['workbench-evidence-notes']}});assert.notEqual(changed.job_id,one.job_id);
  writeEvidence('dedup-isolation.json',{passed:true,workspace:true,account:true,executor:true,fingerprint:true,request_identity:true,fixture_only:true});
 }finally{f.cleanup();}
});

test('P2-C: 摘要/样本正文/拆解标题同句拒收，合法否定、假设和范围说明保留',async()=>{
 const f=await setup();try{
  const plan=(await f.research().get(f.request(),f.id)).plan,accepted=await f.generation().research(f.request(),f.id,{executor:'codex',source_record_ids:plan.source_record_ids,input_version:plan.input_version}),manifest=JSON.parse(String(f.context().db.prepare('SELECT input_manifest FROM jobs WHERE id=?').get(accepted.job_id)!.input_manifest)),valid=report(plan);
  const validate=(data:AccountResearchReport,comparable=false)=>{const frozen=structuredClone(manifest);if(comparable)frozen.research_context.plan.trends.account='comparable';return validateContentOutput(frozen,{documents:[{document_id:accepted.document_id!,text:JSON.stringify(data)}],recommendations:[]});};
  let rejected=0,allowed=0;
  for(const field of ['summary','sample','aspect'] as const){
   const assign=(text:string)=>{const data=structuredClone(valid);if(field==='summary')data.summary=text;else data.samples[0]![field==='sample'?'text':'aspect']=text;return data;};
   for(const text of ['标题导致涨粉1000','这组数据表明涨粉1000']){assert.throws(()=>validate(assign(text)),{code:'VALIDATION_ERROR'});rejected++;}
   assert.throws(()=>validate(assign('标题导致涨粉1000'),true),{code:'VALIDATION_ERROR'});rejected++;
   assert.doesNotThrow(()=>validate(assign('真实可比账号快照记录粉丝增长1000；不能证明该标题导致涨粉。'),true));allowed++;
   for(const text of ['现有数据不足以证明标题导致涨粉1000。','没有证据证明标题导致涨粉。','仅见作品说明，没有字幕或转写，不能分析完整口播；涨粉数据尚不可比。','待验证假设：任务描述可能帮助理解；缺少本人发布数据，不能证明标题导致涨粉。']){assert.doesNotThrow(()=>validate(assign(text)));allowed++;}
   for(const text of ['待验证假设：这类标题可能导致涨粉，尚无本人发布证据。','待验证假设：这类标题可能导致涨粉1000，仍需本人发布实验。']){assert.doesNotThrow(()=>validate(assign(text)));allowed++;}
   for(const text of ['无法证明效果，但标题导致涨粉1000。','待验证假设：标题导致涨粉1000。','待验证假设：标题可能有用，但标题导致涨粉1000。','待验证假设：标题可能有用而新标题导致涨粉1000。']){assert.throws(()=>validate(assign(text)),{code:'VALIDATION_ERROR'});rejected++;}
   for(const text of ['待验证假设：标题可能导致涨粉1000且新标题导致涨粉2000。','待验证假设：标题可能涨粉1000且实际涨粉2000。']){
    assert.throws(()=>validate(assign(text)),{code:'VALIDATION_ERROR'});rejected++;
   }
   for(const text of ['待验证假设：标题可能导致涨粉1000且新标题导致涨粉2000。','待验证假设：标题可能导致理解提升且新标题导致涨粉1000。']){assert.throws(()=>validate(assign(text),true),{code:'VALIDATION_ERROR'});rejected++;}
  }
  const hypothesis=structuredClone(valid);hypothesis.hypotheses[0]!.text='待验证假设：这类标题可能导致涨粉，尚无本人发布证据。';assert.doesNotThrow(()=>validate(hypothesis));allowed++;
  writeEvidence('claim-validation.json',{passed:true,rejected,allowed,summary_sample_aspect_same_rules:true,causality_rejected_even_when_comparable:true,schema_unchanged:true,fixture_only:true});
 }finally{f.cleanup();}
});


test('P2-C/r2: 生产校验的否定对象、转折/并列、后置缺证据与待验证条件范围',async()=>{
 const f=await setup();try{
  const plan=(await f.research().get(f.request(),f.id)).plan,accepted=await f.generation().research(f.request(),f.id,{executor:'codex',source_record_ids:plan.source_record_ids,input_version:plan.input_version}),manifest=JSON.parse(String(f.context().db.prepare('SELECT input_manifest FROM jobs WHERE id=?').get(accepted.job_id)!.input_manifest)),valid=report(plan);
  // 前八项是独立验收 r1 的生产 validator 24 个原对照，后续补命题范围。
  const cases:Array<{id:string;text:string;expected:'accepted'|'rejected';comparable:boolean}>=[
   {id:'direct',text:'标题导致涨粉1000',expected:'rejected',comparable:false},
   {id:'direct_comparable',text:'标题导致涨粉1000',expected:'rejected',comparable:true},
   {id:'unrelated_negation',text:'不是普通标题而是这个标题导致涨粉1000。',expected:'rejected',comparable:true},
   {id:'new_actual_after_denial',text:'不能证明标题导致涨粉1000且实际涨粉2000。',expected:'rejected',comparable:false},
   {id:'legal_missing_evidence',text:'标题导致涨粉1000这一说法尚无证据。',expected:'accepted',comparable:false},
   {id:'legal_condition',text:'待验证假设：如果标题能导致涨粉1000，仍需通过本人实验检验；这不是已发生的结果。',expected:'accepted',comparable:false},
   {id:'legal_hypothesis',text:'待验证假设：标题可能导致涨粉1000，仍需通过本人实验检验。',expected:'accepted',comparable:false},
   {id:'legal_neutral',text:'仅拆解可见正文并提出本人待验证实验。',expected:'accepted',comparable:false},
   {id:'denial_then_other_cause',text:'不能证明A但B导致涨粉1000。',expected:'rejected',comparable:true},
   {id:'unrelated_denial',text:'不能确定读者是否理解而标题导致涨粉1000。',expected:'rejected',comparable:true},
   {id:'causal_denial',text:'这不是标题导致涨粉1000。',expected:'accepted',comparable:false},
   {id:'numeric_denial',text:'不是涨粉1000，而是资料采集次数变化。',expected:'accepted',comparable:false},
   {id:'lacks_evidence',text:'缺乏证据证明标题导致涨粉1000。',expected:'accepted',comparable:false},
   {id:'postfix_denial_then_numeric',text:'标题导致涨粉1000这一说法尚无证据且实际涨粉2000。',expected:'rejected',comparable:false},
   {id:'postfix_denial_then_cause',text:'标题导致涨粉1000这一说法尚无证据，但另一个标题导致涨粉2000。',expected:'rejected',comparable:true},
   {id:'denial_then_numeric',text:'没有证据证明标题导致涨粉1000，而本次实际涨粉2000。',expected:'rejected',comparable:false},
   {id:'if_future_experiment',text:'如果标题能导致涨粉1000，则下一条实验观察是否有相同变化。',expected:'accepted',comparable:false},
   {id:'if_evidence_review',text:'如果标题能导致涨粉1000，则需要复核证据；目前尚未发布，只是假定条件。',expected:'accepted',comparable:false},
   {id:'if_future_no_comma',text:'如果标题能导致涨粉1000则下一条实验观察是否有相同变化。',expected:'accepted',comparable:false},
   {id:'if_future_consequence',text:'如果标题讲清任务，则下一条实验观察标题是否导致涨粉1000。',expected:'accepted',comparable:false},
   {id:'bare_if_does_not_cover_next_fact',text:'如果标题可用，标题导致涨粉1000。',expected:'rejected',comparable:true},
   {id:'if_past_actual',text:'如果标题已导致涨粉1000，则下一条实验再检验。',expected:'rejected',comparable:true},
   {id:'hypothesis_actual',text:'待验证假设：标题可能导致实际涨粉1000，仍需检验。',expected:'rejected',comparable:true},
   {id:'hypothesis_then_past_actual',text:'待验证假设：标题可能导致涨粉1000，但这个标题已导致涨粉2000。',expected:'rejected',comparable:true},
   {id:'condition_then_actual',text:'待验证假设：如果标题能导致涨粉1000，则本次实际涨粉2000。',expected:'rejected',comparable:true},
   {id:'condition_then_numeric_actual',text:'如果标题能导致涨粉1000，则下一条实验观察；本次实际涨粉2000。',expected:'rejected',comparable:false},
   {id:'bare_possible_not_hypothesis',text:'标题可能导致涨粉1000。',expected:'rejected',comparable:true},
   {id:'unrelated_proof_object',text:'不能证明阅读量的报告显示标题导致涨粉1000。',expected:'rejected',comparable:true},
   {id:'postfix_reference_after_comma',text:'标题导致涨粉1000，这一说法尚无证据。',expected:'accepted',comparable:false},
   {id:'if_unrelated_task_not_experiment',text:'如果标题导致涨粉1000，则需要整理文件。',expected:'rejected',comparable:false},
   {id:'postfix_reference_then_cause',text:'标题导致涨粉1000，这一说法尚无证据，但新标题导致涨粉2000。',expected:'rejected',comparable:true},
   {id:'denied_actual_causality',text:'不能证明标题实际导致涨粉1000。',expected:'accepted',comparable:false},
   {id:'denied_recorded_subject',text:'不能证明这次记录的标题导致涨粉1000。',expected:'accepted',comparable:false},
   {id:'denied_report_subject',text:'不能证明该报告中的标题导致涨粉1000。',expected:'accepted',comparable:false},
   {id:'postfix_reference_then_numeric',text:'标题导致涨粉1000，这一说法尚无证据且实际涨粉2000。',expected:'rejected',comparable:false},
   {id:'comparable_descriptive',text:'可比账号快照记录粉丝增长1000；不能证明该标题导致涨粉。',expected:'accepted',comparable:true},
  ];
  const results:Array<Record<string,unknown>>=[];
  for(const testCase of cases)for(const field of ['summary','samples.text','samples.aspect'] as const){
   const data=structuredClone(valid),frozen=structuredClone(manifest);frozen.research_context.plan.trends.account=testCase.comparable?'comparable':'insufficient';
   if(field==='summary')data.summary=testCase.text;else data.samples[0]![field==='samples.text'?'text':'aspect']=testCase.text;
   let actual:'accepted'|'rejected'='accepted',error:null|{code:string;message:string}=null;
   try{validateContentOutput(frozen,{documents:[{document_id:accepted.document_id!,text:JSON.stringify(data)}],recommendations:[]});}catch(e){actual='rejected';error={code:String((e as {code?:string}).code),message:(e as Error).message};}
   results.push({...testCase,field,actual,status:actual===testCase.expected?'passed':'failed',error});
  }
  const failed=results.filter(row=>row.status==='failed');
  writeEvidence('claim-scope-r2.json',{task:'ACCOUNT-RESEARCH-P2-01/r2',fixture_only:true,entrypoint:'validateContentOutput',total:results.length,passed:results.length-failed.length,failed:failed.length,original_acceptance_cases:24,results});
  assert.deepEqual(failed,[]);assert.ok(results.filter(row=>row.actual==='rejected').every(row=>(row.error as {code:string}).code==='VALIDATION_ERROR'));
 }finally{f.cleanup();}
});


test('P2-C/r3: 实际语气绑定本命题，否定的旧实绩不污染另一假设/条件',async()=>{
 const f=await setup();try{
  const plan=(await f.research().get(f.request(),f.id)).plan,accepted=await f.generation().research(f.request(),f.id,{executor:'codex',source_record_ids:plan.source_record_ids,input_version:plan.input_version}),manifest=JSON.parse(String(f.context().db.prepare('SELECT input_manifest FROM jobs WHERE id=?').get(accepted.job_id)!.input_manifest)),valid=report(plan);
  const cases:Array<{id:string;text:string;expected:'accepted'|'rejected'}>=[
   {id:'hypothesis_denied_actual',text:'待验证假设：新标题可能导致涨粉1000，但不能证明旧标题实际导致涨粉2000。',expected:'accepted'},
   {id:'hypothesis_denied_no_actual',text:'待验证假设：新标题可能导致涨粉1000，但不能证明旧标题导致涨粉2000。',expected:'accepted'},
   {id:'hypothesis_denied_semicolon',text:'待验证假设：新标题可能导致涨粉1000；不能证明旧标题实际导致涨粉2000。',expected:'accepted'},
   {id:'hypothesis_affirmed_actual',text:'待验证假设：新标题可能导致涨粉1000，但旧标题实际导致涨粉2000。',expected:'rejected'},
   {id:'condition_denied_actual',text:'如果新标题能导致涨粉1000，则下一条实验验证，但不能证明旧标题实际导致涨粉2000。',expected:'accepted'},
   {id:'condition_denied_no_actual',text:'如果新标题能导致涨粉1000，则下一条实验验证，但不能证明旧标题导致涨粉2000。',expected:'accepted'},
   {id:'condition_denied_semicolon',text:'如果新标题能导致涨粉1000，则下一条实验验证；不能证明旧标题实际导致涨粉2000。',expected:'accepted'},
   {id:'condition_affirmed_actual',text:'如果新标题能导致涨粉1000，则下一条实验验证，但旧标题实际导致涨粉2000。',expected:'rejected'},
   {id:'hypothesis_denied_already',text:'待验证假设：新标题可能导致涨粉1000，但未能证明旧标题已经导致涨粉2000。',expected:'accepted'},
   {id:'denial_then_hypothesis',text:'不能证明旧标题实际导致涨粉2000，待验证假设：新标题可能导致涨粉1000。',expected:'accepted'},
   {id:'denial_then_condition',text:'不能证明旧标题实际导致涨粉2000，如果新标题能导致涨粉1000则下一条实验验证。',expected:'accepted'},
   {id:'condition_affirmed_then_result',text:'如果新标题能导致涨粉1000，则本次实际涨粉2000。',expected:'rejected'},
  ];
  const results:Array<Record<string,unknown>>=[];
  for(const comparable of [false,true])for(const testCase of cases)for(const field of ['summary','samples.text','samples.aspect'] as const){
   const data=structuredClone(valid),frozen=structuredClone(manifest);frozen.research_context.plan.trends.account=comparable?'comparable':'insufficient';
   if(field==='summary')data.summary=testCase.text;else data.samples[0]![field==='samples.text'?'text':'aspect']=testCase.text;
   let actual:'accepted'|'rejected'='accepted',error:null|{code:string;message:string}=null;
   try{validateContentOutput(frozen,{documents:[{document_id:accepted.document_id!,text:JSON.stringify(data)}],recommendations:[]});}catch(e){actual='rejected';error={code:String((e as {code?:string}).code),message:(e as Error).message};}
   results.push({...testCase,comparable,field,actual,status:actual===testCase.expected?'passed':'failed',error});
  }
  const failed=results.filter(row=>row.status==='failed');
  writeEvidence('claim-scope-r3.json',{task:'ACCOUNT-RESEARCH-P2-01/r3',fixture_only:true,entrypoint:'validateContentOutput',total:results.length,passed:results.length-failed.length,failed:failed.length,original_f3_cases:24,results});
  assert.deepEqual(failed,[]);assert.ok(results.filter(row=>row.actual==='rejected').every(row=>(row.error as {code:string}).code==='VALIDATION_ERROR'));
 }finally{f.cleanup();}
});


test('P2-C/r4: 明确实验验证问题保留，实验词不能豁免肯定或混合因果结果',async()=>{
 const f=await setup();try{
  const plan=(await f.research().get(f.request(),f.id)).plan,accepted=await f.generation().research(f.request(),f.id,{executor:'codex',source_record_ids:plan.source_record_ids,input_version:plan.input_version}),manifest=JSON.parse(String(f.context().db.prepare('SELECT input_manifest FROM jobs WHERE id=?').get(accepted.job_id)!.input_manifest)),valid=report(plan);
  const cases:Array<{id:string;text:string;expected:'accepted'|'rejected'}>=[
   {id:'pending_verification',text:'如果新标题能导致涨粉1000，则需要实验验证是否涨粉2000。',expected:'accepted'},
   {id:'future_observation',text:'如果新标题能导致涨粉1000，则下一条实验观察是否涨粉2000。',expected:'accepted'},
   {id:'affirmed_result',text:'如果新标题能导致涨粉1000，则本次实际涨粉2000。',expected:'rejected'},
   {id:'pending_causal_question',text:'如果新标题能导致涨粉1000，则需要实验验证新标题能否导致涨粉2000。',expected:'accepted'},
   {id:'pending_question_no_condition',text:'需要实验验证是否涨粉2000。',expected:'accepted'},
   {id:'keywords_without_question',text:'如果新标题能导致涨粉1000，则需要实验验证涨粉2000。',expected:'rejected'},
   {id:'unrelated_question_then_fact',text:'如果新标题能导致涨粉1000，则需要实验验证是否有效但新标题已导致涨粉2000。',expected:'rejected'},
   {id:'pending_question_then_denial',text:'如果新标题能导致涨粉1000，则需要实验验证是否涨粉2000，但不能证明旧标题实际导致涨粉3000。',expected:'accepted'},
   {id:'pending_question_then_actual',text:'如果新标题能导致涨粉1000，则需要实验验证是否涨粉2000，但旧标题实际导致涨粉3000。',expected:'rejected'},
   {id:'actual_then_pending_question',text:'如果新标题能导致涨粉1000，则本次已经涨粉2000，需要实验验证是否涨粉3000。',expected:'rejected'},
   {id:'actual_with_verification_words',text:'如果新标题能导致涨粉1000，则需要实验验证本次实际涨粉2000。',expected:'rejected'},
   {id:'missing_question_then_cause',text:'需要实验验证新标题导致涨粉2000。',expected:'rejected'},
  ];
  const results:Array<Record<string,unknown>>=[];
  for(const comparable of [false,true])for(const testCase of cases)for(const field of ['summary','samples.text','samples.aspect'] as const){
   const data=structuredClone(valid),frozen=structuredClone(manifest);frozen.research_context.plan.trends.account=comparable?'comparable':'insufficient';
   if(field==='summary')data.summary=testCase.text;else data.samples[0]![field==='samples.text'?'text':'aspect']=testCase.text;
   let actual:'accepted'|'rejected'='accepted',error:null|{code:string;message:string}=null;
   try{validateContentOutput(frozen,{documents:[{document_id:accepted.document_id!,text:JSON.stringify(data)}],recommendations:[]});}catch(e){actual='rejected';error={code:String((e as {code?:string}).code),message:(e as Error).message};}
   results.push({...testCase,comparable,field,actual,status:actual===testCase.expected?'passed':'failed',error});
  }
  const failed=results.filter(row=>row.status==='failed');
  writeEvidence('claim-scope-r4.json',{task:'ACCOUNT-RESEARCH-P2-01/r4',fixture_only:true,entrypoint:'validateContentOutput',total:results.length,passed:results.length-failed.length,failed:failed.length,original_f4_cases:18,results});
  assert.deepEqual(failed,[]);assert.ok(results.filter(row=>row.actual==='rejected').every(row=>(row.error as {code:string}).code==='VALIDATION_ERROR'));
 }finally{f.cleanup();}
});
