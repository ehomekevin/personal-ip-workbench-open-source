import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from '../documents/harness.ts';
import {Topics} from '../../packages/domain/src/topics/index.ts';
import {TopicOperationsStore} from '../../packages/domain/src/topics/operations.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import {SkillLibrary} from '../../packages/domain/src/skills/library.ts';
import {DurableWorker} from '../../apps/service/src/worker/core/index.ts';
import {validateContentOutput} from '../../packages/domain/src/content-agents/index.ts';
import {buildServiceAgentPlan} from '../../packages/domain/src/service-agent/index.ts';
import {emptyTopicOperations,type OperationsCandidateData,type ReaderFeedback} from '../../packages/contracts/src/operations.ts';
import type {ApplicationContext,ReaderFeedbackPort} from '../../packages/domain/src/ports/index.ts';

async function setup(options:{feedback?:ReaderFeedbackPort;skill?:boolean;ready?:boolean}={}){
 const f=fixture(),skills=join(f.root,'skills'),directory=join(skills,'personal-ip-operations');mkdirSync(directory,{recursive:true});
 if(options.skill!==false){writeFileSync(join(directory,'SKILL.md'),'---\nname: personal-ip-operations\ndescription: 围绕真实材料完成运营整理\n---\n读者任务与本人新增帮助。参考 [依据](evidence.md)。只使用固定材料。');writeFileSync(join(directory,'evidence.md'),'真实评论原文与作品出处，泛赞和作者自答不作为需求验证。');}
 const context=():ApplicationContext=>({...f.context(),getExecutorHealth:async()=>[{executor_id:'codex',status:options.ready===false?'unconfigured':'supported',runtime_version:'test',auth_state:'authenticated',billing_route:'chatgpt_subscription',limitations:[]}],...(options.feedback?{reader_feedback:options.feedback}:{})});
 const store=()=>new TopicOperationsStore(context(),{skill_library:new SkillLibrary(context(),{roots:[skills]})});
 const topic=await new Topics(context()).create(f.request(),{title:'运营自动整理测试',category:'个人思考',audience:'需要完成内容的创作者',angle:'本人实际使用结果',source_ids:[]});
 return {...f,context,store,topic};
}
function proposed(topicId:string,feedback:ReaderFeedback[]=[]):OperationsCandidateData{
 return {schema_version:1,brief:{reader_task:'内容交付要求写不清',takeaway:'一段可复制的交付要求',personal_addition:'本人核对实际生成结果',evidence:'本条已提供的主题与原稿',goal:'读者能完成一次明确交付',reader_next_step:'复制要求后核对结果'},feedback_labels:feedback.map(f=>({id:f.id,kind:'obstacle'})),followups:[{id:'p1',title:'如何核对交付结果',new_help:'展示本次原稿未涉及的核对步骤，完成一次复核',evidence_keys:['topic:'+topicId]}],limitations:feedback.length?[]:['尚无本人发布作品，不能判断读者实绩']};
}
async function execute(f:Awaited<ReturnType<typeof setup>>,data=proposed(f.topic.id)){
 const worker=new DurableWorker(f.context(),[{registration:{kind:'document_modify',execution_mode:'service_adapter',recovery:'read_only'},async execute(e){const m=JSON.parse(e.claim.job.input_manifest);const plan=buildServiceAgentPlan(f.context(),e.claim,{staging_root:join(f.config.paths.state_root,'generation-staging')});assert.equal(plan.api_fallback?.enabled,false);assert.equal((plan.input.input_manifest.frozen as any).service_agent.execution_policy.model,'gpt-6.1-sol');assert.equal((m.operations_skill.base_local_skill.references as any[]).length,1);return validateContentOutput(m,{documents:[{document_id:m.targets[0].document_id,text:JSON.stringify(data)}],recommendations:[]});}}]);return worker.runOnce();
}

test('GET无写入，自动ensure并发/刷新/重开不重复任务，候选待确认且合法没有反馈',async()=>{
 const f=await setup();try{
  const initial=await f.store().get(f.request(),f.topic.id);assert.equal(initial.automation!.state,'missing');assert.equal(initial.document,null);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,0);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM application_metadata').get()!.n,0);
  const [first,second]=await Promise.all([f.store().ensure(f.request(),f.topic.id),f.store().ensure(f.request(),f.topic.id)]);assert.equal(first.automation!.job_id,second.automation!.job_id);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,1);
  f.reopen();assert.equal((await f.store().ensure(f.request(),f.topic.id)).automation!.job_id,first.automation!.job_id);await execute(f);const ready=await f.store().get(f.request(),f.topic.id);assert.equal(ready.automation!.state,'candidate');assert.equal(ready.document,null);assert.deepEqual(ready.automation!.candidate!.feedback,[]);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM topics').get()!.n,1);assert.equal(f.context().db.prepare("SELECT COUNT(*) n FROM documents WHERE kind='topic_operations'").get()!.n,0);
 }finally{f.cleanup();}
});

test('修改并确认候选才保存简报及选中后续；重复确认与刷新不重复创建',async()=>{
 const f=await setup();try{await f.store().ensure(f.request(),f.topic.id);await execute(f);const ready=await f.store().get(f.request(),f.topic.id),candidate=ready.automation!.candidate!,input={candidate_id:candidate.id,expected_revision_id:null,decision:'confirm' as const,brief:{...candidate.data.brief,takeaway:'本人确认的具体做法'},feedback_ids:[],followups:candidate.data.followups},request=f.request();
  const saved=await f.store().decide(request,f.topic.id,input);await f.store().decide(request,f.topic.id,input);await f.store().ensure(f.request(),f.topic.id);assert.equal(saved.data.brief.takeaway,'本人确认的具体做法');assert.equal(saved.automation!.state,'confirmed');assert.equal(saved.data.followups.length,1);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM topics').get()!.n,2);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,1);
  const edited=structuredClone(saved.data);edited.brief.personal_addition='确认后人工补充';await f.store().save(f.request(),f.topic.id,{expected_revision_id:saved.document!.head_revision_id,data:edited});assert.equal((await f.store().ensure(f.request(),f.topic.id)).data.brief.personal_addition,'确认后人工补充');assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,1);
 }finally{f.cleanup();}
});

test('确认可不选后续，拒绝不会保存或反复生成',async()=>{
 for(const decision of ['confirm','reject'] as const){const f=await setup();try{await f.store().ensure(f.request(),f.topic.id);await execute(f);const view=await f.store().get(f.request(),f.topic.id);const result=await f.store().decide(f.request(),f.topic.id,{candidate_id:view.automation!.candidate!.id,expected_revision_id:null,decision,followups:[]});assert.equal(result.automation!.state,decision==='confirm'?'confirmed':'rejected');assert.equal(result.data.followups.length,0);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM topics').get()!.n,1);await f.store().ensure(f.request(),f.topic.id);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,1);if(decision==='reject')assert.equal(result.document,null);}finally{f.cleanup();}}
});

test('候选不能覆盖新人工修订，所用原稿变化时确认旧候选冲突',async()=>{
 for(const changed of ['operations','core']){const f=await setup();try{await f.store().ensure(f.request(),f.topic.id);await execute(f);const view=await f.store().get(f.request(),f.topic.id);if(changed==='operations'){const data=emptyTopicOperations();data.brief.reader_task='人工保留';await f.store().save(f.request(),f.topic.id,{expected_revision_id:null,data});}else await new Documents(f.context()).save(f.request(),f.topic.core_document_id,{expected_revision_id:null,text:'本人新增的原稿事实',origin:'human'});assert.equal((await f.store().get(f.request(),f.topic.id)).automation!.state,'stale');await assert.rejects(f.store().decide(f.request(),f.topic.id,{candidate_id:view.automation!.candidate!.id,expected_revision_id:null,decision:'confirm'}),{code:'REVISION_CONFLICT'});assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM topics').get()!.n,1);}finally{f.cleanup();}}
});

test('确认后主题建立中断由POST ensure恢复，GET不恢复，创建与关联分别幂等',async()=>{
 const f=await setup();try{await f.store().ensure(f.request(),f.topic.id);await execute(f);const view=await f.store().get(f.request(),f.topic.id);f.context().db.exec("CREATE TRIGGER operations_test_fail BEFORE INSERT ON topics BEGIN SELECT RAISE(ABORT,'SIMULATED_TOPIC_FAILURE'); END");await assert.rejects(f.store().decide(f.request(),f.topic.id,{candidate_id:view.automation!.candidate!.id,expected_revision_id:null,decision:'confirm'}),/SIMULATED_TOPIC_FAILURE/);const partial=await f.store().get(f.request(),f.topic.id);assert.ok(partial.data.confirmed_generation);assert.equal(partial.automation!.state,'failed');assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM topics').get()!.n,1);f.context().db.exec('DROP TRIGGER operations_test_fail');const done=await f.store().ensure(f.request(),f.topic.id);await f.store().ensure(f.request(),f.topic.id);assert.equal(done.automation!.state,'confirmed');assert.equal(done.data.followups.length,1);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM topics').get()!.n,2);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,1);}finally{f.cleanup();}
});

test('缺少技能或订阅连接显示blocked，不调用API或排任务',async()=>{
 for(const options of [{skill:false},{ready:false}]){const f=await setup(options);try{const view=await f.store().ensure(f.request(),f.topic.id);assert.equal(view.automation!.state,'blocked');assert.equal(view.document,null);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,0);}finally{f.cleanup();}}
});

test('只采集已核对且主题绑定的本人作品，原评论持久去重；分类不能造反馈',async()=>{
 let collected:string[]=[];const raw:ReaderFeedback={id:'x:comment-1',kind:'response',text:'实际评论：这一步我操作失败',source:'https://x.com/reader/status/22',recorded_at:'2026-10-01T00:00:00Z',provenance:'platform',work_id:'owned-work',platform_comment_id:'22',commented_at:'2026-10-01T00:00:00Z',author_name:'真实读者',is_author:false};
 const f=await setup({feedback:{async collect(work){collected.push(work.id);return {status:'collected',feedback:[raw,raw],limitations:[]};}}});try{
  const db=f.context().db,w=f.config.workspace_id;db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,canonical_url,name,role,identity_status) VALUES ('owner',?,'x','o','https://x.com/owner','本人','owner','confirmed'),('benchmark',?,'x','b','https://x.com/benchmark','对标','benchmark','confirmed')").run(w,w);
  db.prepare("INSERT INTO works(id,workspace_id,platform,platform_work_id,account_id,topic_id,url,published_at,origin,identity_status) VALUES ('owned-work',?,'x','11','owner',?,'https://x.com/owner/status/11','2026-09-30T00:00:00Z','published','confirmed'),('benchmark-work',?,'x','33','benchmark',?,'https://x.com/benchmark/status/33','2026-09-30T00:00:00Z','import','confirmed')").run(w,f.topic.id,w,f.topic.id);
  await f.store().ensure(f.request(),f.topic.id);await f.store().ensure(f.request(),f.topic.id);assert.deepEqual(collected,['owned-work']);await execute(f,proposed(f.topic.id,[raw]));const view=await f.store().get(f.request(),f.topic.id);assert.equal(view.automation!.candidate!.feedback.length,1);assert.equal(view.automation!.candidate!.feedback[0]!.text,raw.text);
  const manifest=JSON.parse(String(db.prepare('SELECT input_manifest FROM jobs LIMIT 1').get()!.input_manifest));assert.throws(()=>validateContentOutput(manifest,{documents:[{document_id:manifest.targets[0].document_id,text:JSON.stringify({...proposed(f.topic.id),feedback_labels:[{id:'invented',kind:'question'}]})}],recommendations:[]}));
  const confirmed=await f.store().decide(f.request(),f.topic.id,{candidate_id:view.automation!.candidate!.id,expected_revision_id:null,decision:'confirm',followups:[]});assert.equal(confirmed.data.feedback[0]!.text,raw.text);assert.equal(confirmed.data.feedback[0]!.kind,'obstacle');assert.equal(confirmed.data.feedback[0]!.source,raw.source);
 }finally{f.cleanup();}
});

test('失败重试沿用同一冻结任务；首次并发手动保存与旧版本覆盖仍受保护',async()=>{
 const f=await setup();try{const run=await f.store().ensure(f.request(),f.topic.id),worker=new DurableWorker(f.context(),[{registration:{kind:'document_modify',execution_mode:'service_adapter',recovery:'read_only'},async execute(){throw new Error('test execution failure');}}]);await worker.runOnce();assert.equal((await f.store().get(f.request(),f.topic.id)).automation!.state,'failed');assert.equal((await f.store().ensure(f.request(),f.topic.id,{retry:true})).automation!.job_id,run.automation!.job_id);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,1);
  const store=f.store(),results=await Promise.allSettled([store.save(f.request(),f.topic.id,{expected_revision_id:null,data:emptyTopicOperations()}),store.save(f.request(),f.topic.id,{expected_revision_id:null,data:emptyTopicOperations()})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.context().db.prepare("SELECT COUNT(*) n FROM documents WHERE kind='topic_operations'").get()!.n,1);await assert.rejects(store.save(f.request(),f.topic.id,{expected_revision_id:null,data:emptyTopicOperations()}),{code:'REVISION_CONFLICT'});
 }finally{f.cleanup();}
});

test('拒绝后只在本人显式重试时生成新一轮候选，同一输入自动load保持不重复',async()=>{
 const f=await setup();try{await f.store().ensure(f.request(),f.topic.id);await execute(f);const first=await f.store().get(f.request(),f.topic.id);await f.store().decide(f.request(),f.topic.id,{candidate_id:first.automation!.candidate!.id,expected_revision_id:null,decision:'reject'});await f.store().ensure(f.request(),f.topic.id);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,1);const retried=await f.store().ensure(f.request(),f.topic.id,{retry:true});assert.notEqual(retried.automation!.job_id,first.automation!.job_id);await f.store().ensure(f.request(),f.topic.id);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,2);}finally{f.cleanup();}
});

test('后续主题已创建但关联修订中断，恢复不会再建同一主题且保留candidate来源',async()=>{
 const f=await setup();try{await f.store().ensure(f.request(),f.topic.id);await execute(f);const view=await f.store().get(f.request(),f.topic.id);f.context().db.exec("CREATE TRIGGER operations_test_link_fail BEFORE INSERT ON document_revisions WHEN NEW.parent_revision_id IS NOT NULL AND EXISTS(SELECT 1 FROM documents WHERE id=NEW.document_id AND kind='topic_operations') BEGIN SELECT RAISE(ABORT,'SIMULATED_LINK_FAILURE'); END");await assert.rejects(f.store().decide(f.request(),f.topic.id,{candidate_id:view.automation!.candidate!.id,expected_revision_id:null,decision:'confirm'}),/SIMULATED_LINK_FAILURE/);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM topics').get()!.n,2);const partial=await f.store().get(f.request(),f.topic.id);assert.equal(partial.data.followups.length,0);f.context().db.exec('DROP TRIGGER operations_test_link_fail');const done=await f.store().ensure(f.request(),f.topic.id);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM topics').get()!.n,2);assert.equal(done.data.followups[0]!.candidate_id,view.automation!.candidate!.id);assert.equal(done.data.followups[0]!.proposal_id,'p1');assert.equal(done.data.followups[0]!.source_version,view.automation!.source_version);assert.equal(done.automation!.state,'confirmed');}finally{f.cleanup();}
});

test('确认文稿已提交但外层receipt和saved标记未更新，重开仍自动完成后续',async()=>{
 const f=await setup();try{await f.store().ensure(f.request(),f.topic.id);await execute(f);const view=await f.store().get(f.request(),f.topic.id);f.context().db.exec("CREATE TRIGGER operations_test_crash BEFORE INSERT ON topics BEGIN SELECT RAISE(ABORT,'SIMULATED_CRASH'); END");await assert.rejects(f.store().decide(f.request(),f.topic.id,{candidate_id:view.automation!.candidate!.id,expected_revision_id:null,decision:'confirm'}));const db=f.context().db,key='topic-operations.automation.v1:'+f.config.workspace_id+':'+f.topic.id,run=JSON.parse(String(db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key)!.value));assert.equal(run.pending.saved,true);run.pending.saved=false;db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(run),key);db.prepare('DELETE FROM idempotency_requests WHERE workspace_id=? AND operation=?').run(f.config.workspace_id,'topic-operations.save:'+f.topic.id);db.exec('DROP TRIGGER operations_test_crash');f.reopen();const done=await f.store().ensure(f.request(),f.topic.id);assert.equal(done.automation!.state,'confirmed');assert.equal(done.data.followups.length,1);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM topics').get()!.n,2);assert.equal(f.context().db.prepare("SELECT COUNT(*) n FROM document_revisions r JOIN documents d ON d.id=r.document_id WHERE d.kind='topic_operations'").get()!.n,2);}finally{f.cleanup();}
});

test('同一原文hash刷新采集失败与恢复状态，不重复生成候选',async()=>{
 let unavailable=true;const f=await setup({feedback:{async collect(){return {status:unavailable?'unavailable':'empty',feedback:[],limitations:unavailable?['模拟权限缺口']:[]};}}});try{const db=f.context().db,w=f.config.workspace_id;db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,canonical_url,name,role,identity_status) VALUES ('owner',?,'x','o','https://x.com/owner','本人','owner','confirmed')").run(w);db.prepare("INSERT INTO works(id,workspace_id,platform,platform_work_id,account_id,topic_id,url,published_at,origin,identity_status) VALUES ('owned-work',?,'x','11','owner',?,'https://x.com/owner/status/11','2026-09-30T00:00:00Z','published','confirmed')").run(w,f.topic.id);
  const first=await f.store().ensure(f.request(),f.topic.id);assert.match(first.automation!.feedback_status,/暂不可读取/);unavailable=false;const recovered=await f.store().ensure(f.request(),f.topic.id,{refresh_feedback:true});assert.equal(recovered.automation!.job_id,first.automation!.job_id);assert.equal(recovered.automation!.feedback_status,'已采集，暂无读者评论');assert.ok(!recovered.automation!.limitations.includes('模拟权限缺口'));unavailable=true;const failedAgain=await f.store().ensure(f.request(),f.topic.id,{refresh_feedback:true});assert.match(failedAgain.automation!.feedback_status,/暂不可读取/);assert.ok(failedAgain.automation!.limitations.includes('模拟权限缺口'));assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,1);
 }finally{f.cleanup();}
});

test('旧材料回到相同输入hash复用已有任务，取消后只有显式重试开新任务',async()=>{
 const f=await setup();try{const first=await f.store().ensure(f.request(),f.topic.id),db=f.context().db;db.prepare('UPDATE topics SET angle=? WHERE id=?').run('临时不同输入',f.topic.id);const other=await f.store().ensure(f.request(),f.topic.id);assert.notEqual(other.automation!.job_id,first.automation!.job_id);db.prepare('UPDATE topics SET angle=? WHERE id=?').run('本人实际使用结果',f.topic.id);assert.equal((await f.store().ensure(f.request(),f.topic.id)).automation!.job_id,first.automation!.job_id);const {Jobs}=await import('../../packages/domain/src/jobs/index.ts'),jobs=new Jobs(f.context()),detail=jobs.get(f.request(),first.automation!.job_id!);jobs.cancel(f.request(),detail.job.id,{expected_version:detail.job.version});assert.equal((await f.store().get(f.request(),f.topic.id)).automation!.state,'failed');const retry=await f.store().ensure(f.request(),f.topic.id,{retry:true});assert.notEqual(retry.automation!.job_id,first.automation!.job_id);assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,3);}finally{f.cleanup();}
});

test('GET检测被改修订时不修复文件或产生conflict副本',async()=>{
 const f=await setup();try{const doc=new Documents(f.context()),saved=await doc.save(f.request(),f.topic.core_document_id,{expected_revision_id:null,text:'本人原稿',origin:'human'}),revision=f.context().db.prepare('SELECT file_path FROM document_revisions WHERE id=?').get(saved.revision_id)!,{chmodSync,readFileSync,existsSync}=await import('node:fs');chmodSync(String(revision.file_path),0o644);writeFileSync(String(revision.file_path),'人工改写文件');await assert.rejects(f.store().get(f.request(),f.topic.id),{code:'STORAGE_UNAVAILABLE'});assert.equal(readFileSync(String(revision.file_path),'utf8'),'人工改写文件');assert.equal(existsSync(join(f.config.paths.managed_notes_root,'conflicts')),false);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,0);}finally{f.cleanup();}
});

test('未确认的已采集原文在再次采集失败时保留，任务与候选不被空响应替换',async()=>{
 let unavailable=false;const raw:ReaderFeedback={id:'x:comment-22',kind:'response',text:'实际问题原文',source:'https://x.com/reader/status/22',recorded_at:'2026-10-01T00:00:00Z',provenance:'platform',work_id:'owned-work',platform_comment_id:'22'};const f=await setup({feedback:{async collect(){return unavailable?{status:'unavailable',feedback:[],limitations:['模拟第二次权限失败']}:{status:'collected',feedback:[raw],limitations:[]};}}});try{const db=f.context().db,w=f.config.workspace_id;db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,canonical_url,name,role,identity_status) VALUES ('owner',?,'x','o','https://x.com/owner','本人','owner','confirmed')").run(w);db.prepare("INSERT INTO works(id,workspace_id,platform,platform_work_id,account_id,topic_id,url,published_at,origin,identity_status) VALUES ('owned-work',?,'x','11','owner',?,'https://x.com/owner/status/11','2026-09-30T00:00:00Z','published','confirmed')").run(w,f.topic.id);const first=await f.store().ensure(f.request(),f.topic.id);await execute(f,proposed(f.topic.id,[raw]));unavailable=true;const refreshed=await f.store().ensure(f.request(),f.topic.id,{refresh_feedback:true});assert.equal(refreshed.automation!.job_id,first.automation!.job_id);assert.equal(refreshed.automation!.candidate!.feedback[0]!.text,raw.text);assert.match(refreshed.automation!.feedback_status,/暂不可读取/);assert.ok(refreshed.automation!.limitations.includes('模拟第二次权限失败'));assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n,1);assert.equal(refreshed.document,null);
 }finally{f.cleanup();}
});
