// 配图方案（A2）：规划入队走写作执行器路径且幂等、方案校验失败可重试、自动选源导入网络图、AI 槽位待生成不扣预算、方案项编辑与换源。
import nodeTest from 'node:test';
import test from '../helpers/media-tools.ts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseImagePlanDraft,imagePlanBodyLimit,ImagePlanItemUpdateSchema,type ImagePlanFrozenInput,type ImagePlanSnapshot,type StudioWebImageCandidate,type StudioWebImportResult} from '../../packages/contracts/src/index.ts';
import {readGenerationBudget} from '../../packages/storage/src/image-studio/index.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import {planKeywords,planKeywordScore} from '../../packages/domain/src/artifact-execution/image-studio/plan.ts';
import {startPlanFixture,defaultPlan} from '../image-studio/plan-fixture.ts';
type Fixture=Awaited<ReturnType<typeof startPlanFixture>>;
const budget=(f:Fixture)=>readGenerationBudget(f.app.context.db,f.app.identity.workspace_id);
const mediaJobs=(f:Fixture)=>Number(f.app.context.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='media_generate'").get()!.n);
const frozen:Pick<ImagePlanFrozenInput,'paragraphs'|'candidates'|'body_limit'>={paragraphs:[{id:'p1',index:0,text:'一'},{id:'p2',index:1,text:'二'}],candidates:[{candidate_id:'c-article',group:'article_original',title:'原文',credit_label:'图源：原文',paragraph_hits:[]},{candidate_id:'c-post',group:'platform_post',title:'帖子',credit_label:'图源：X',paragraph_hits:[]}],body_limit:2};
const item=(extra:Record<string,unknown>={})=>({paragraph_id:'p1',position:'after',purpose:'图注',source_strategy:'ai_generate',aspect:'16:9',prompt_draft:'画面',...extra});
const cover=item({position:'cover'});
nodeTest('plan JSON is validated: paragraphs, enums, positions, body limit, duplicates; fenced JSON accepted, prose rejected; foreign candidate ids dropped',()=>{
 const good=parseImagePlanDraft(JSON.stringify({cover,slots:[item({source_strategy:'article_original',candidate_id:'c-article'}),item({paragraph_id:'p2',source_strategy:'platform_post',candidate_id:'c-article'})]}),frozen);
 assert.equal(good.slots[0]!.candidate_id,'c-article');assert.equal(good.slots[1]!.candidate_id,null,'候选分组与策略不符时丢弃，交给服务端按关键词再选');
 assert.equal(parseImagePlanDraft('```json\n'+JSON.stringify({cover,slots:[]})+'\n```',frozen).slots.length,0);
 const reason=(value:unknown)=>{try{parseImagePlanDraft(typeof value==='string'?value:JSON.stringify(value),frozen);return 'ok';}catch(e){return (e as {details:{reason:string}}).details.reason+'|'+(e as Error).message;}};
 assert.match(reason('方案如下：'+JSON.stringify({cover,slots:[]})),/^not_json\|/);
 assert.match(reason({cover:item({paragraph_id:'nope',position:'cover'}),slots:[]}),/^unknown_paragraph\|封面指向的段落不存在/);
 assert.match(reason({cover:item(),slots:[]}),/^invalid_position\|/,'封面必须是 cover');
 assert.match(reason({cover,slots:[item({position:'cover'})]}),/^invalid_position\|/);
 assert.match(reason({cover,slots:[item({source_strategy:'stock_photo'})]}),/^invalid_strategy\|第 1 张正文图的来源策略不合法/);
 assert.match(reason({cover,slots:[item({aspect:'21:9'})]}),/^invalid_aspect\|/);
 assert.match(reason({cover,slots:[item({purpose:' '})]}),/^invalid_purpose\|/);
 assert.match(reason({cover,slots:[item(),item({paragraph_id:'p2'}),item({paragraph_id:'p2',position:'before'})]}),/^too_many\|正文配图 3 张，超过本篇上限 2 张/);
 assert.match(reason({cover,slots:[item(),item()]}),/^duplicate_position\|/);
 assert.match(reason({cover,slots:[item({url:'https://x'})]}),/^unknown_field\|/);
 assert.deepEqual([0,400,500,501,1200,2600,9000].map(imagePlanBodyLimit),[1,1,1,2,3,6,6]);
 assert.throws(()=>ImagePlanItemUpdateSchema.parse({topic_id:'t',expected_version:1}),/没有要修改的内容/);
 const keys=planKeywords('同题的抖音作品也很有参考价值');assert.ok(planKeywordScore(keys,'抖音作品 图源：抖音 @抖音作者')>=2);assert.equal(planKeywordScore(keys,'X 帖子 图源：X @alice'),0);
});
test('entering with no plan queues exactly one image_plan job on the writing path; replays and replans while active do not queue again; no image budget is used',async()=>{
 const f=await startPlanFixture();try{
  const empty=await f.plan();assert.equal(empty.state,'empty');assert.equal(empty.items.length,0);assert.equal(empty.run,null);assert.deepEqual(empty.budget.agy,{used:0,limit:2,remaining:2});
  const key=randomUUID(),first=await f.json<ImagePlanSnapshot>(await f.run({replan:false},key,empty.version));assert.equal(first.state,'planning');assert.equal(first.run!.state,'queued');assert.equal(first.run!.executor,'codex');
  const jobs=f.planJobs();assert.equal(jobs.length,1);assert.equal(jobs[0]!.execution_mode,'service_adapter');assert.equal(jobs[0]!.executor_id,'codex');
  const manifest=JSON.parse(jobs[0]!.input_manifest);assert.equal(manifest.content_purpose,'image_plan');assert.equal(manifest.mode,'candidate');assert.equal(manifest.service_agent.api_fallback.enabled,false);assert.equal(manifest.execution_policy.reasoning_effort,'medium');
  const studio=first.studio;assert.deepEqual(manifest.image_plan.paragraphs.map((p:{id:string})=>p.id),studio.paragraphs.map(p=>p.id));assert.equal(manifest.image_plan.body_limit,3);assert.equal(manifest.image_plan.skill.name,'wechat-image-plan');
  const groups=new Set(manifest.image_plan.candidates.map((c:{group:string})=>c.group));assert.ok(groups.has('article_original')&&groups.has('platform_post'));assert.equal(JSON.stringify(manifest.image_plan.candidates).includes('record_id'),false,'候选摘要不带资料记录 ID');
  assert.match(manifest.service_agent.task_instruction,/wechat-image-plan/);
  assert.equal((await f.json<ImagePlanSnapshot>(await f.run({replan:false},key,empty.version))).state,'planning','同一幂等键重放');
  assert.equal((await f.json<ImagePlanSnapshot>(await f.run({replan:true}))).run!.state,'queued','进行中再点重新规划不重复入队');
  await f.json(await f.run({replan:false}));assert.equal(f.planJobs().length,1);
  await f.json(await f.run({replan:true},randomUUID(),empty.version),409);
  assert.deepEqual(budget(f),{codex:0,agy:0});assert.equal(mediaJobs(f),0);assert.equal(f.image_calls,0);
  assert.equal((await f.complete())!.state,'committed');const ready=await f.plan();assert.equal(ready.state,'ready');assert.equal(ready.run!.state,'succeeded');assert.equal(ready.items.length,4);
  await f.json(await f.run({replan:false}));assert.equal(f.planJobs().length,1,'已有方案时进入工作台不再自动规划');
  const again=await f.json<ImagePlanSnapshot>(await f.run({replan:true,executor:'claude'}));assert.equal(again.state,'planning');assert.equal(f.planJobs().length,2);assert.equal(f.planJobs()[1]!.executor_id,'claude','本次规划可选执行器，不改全局默认');
  assert.equal(again.items.length,4,'重新规划进行中仍显示原方案');assert.deepEqual(budget(f),{codex:0,agy:0});
 }finally{await f.close();}
});
test('an invalid plan fails the job with a user-language reason and no plan; replanning recovers',async()=>{
 const f=await startPlanFixture();try{
  f.adapter.respond=fz=>({cover:{...defaultPlan(fz).cover},slots:[{...defaultPlan(fz).slots[3]!,paragraph_id:'不存在的段落'}]});
  await f.json(await f.run({replan:false}));assert.equal((await f.complete())!.state,'failed');
  const failed=await f.plan();assert.equal(failed.state,'failed');assert.equal(failed.items.length,0);assert.match(failed.run!.error!,/AI 给出的方案不合格（第 1 张正文图指向的段落不存在），可以重新规划/);assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}|VALIDATION_ERROR|unknown_paragraph/.test(failed.run!.error!),false,'原因不露任务 ID 或错误码');
  assert.equal(Number(f.app.context.db.prepare("SELECT COUNT(*) AS n FROM candidates c JOIN documents d ON d.id=c.target_document_id WHERE d.kind='image_plan'").get()!.n),0,'不合格方案不留候选');
  f.adapter.respond=fz=>({...defaultPlan(fz),slots:[...defaultPlan(fz).slots,{...defaultPlan(fz).slots[3]!,paragraph_id:fz.paragraphs[4]!.id}]});
  await f.json(await f.run({replan:true}));assert.equal((await f.complete())!.state,'failed');assert.match((await f.plan()).run!.error!,/正文配图 4 张，超过本篇上限 3 张/);
  f.adapter.respond='好的，下面是方案：{}';await f.json(await f.run({replan:true}));assert.equal((await f.complete())!.state,'failed');assert.match((await f.plan()).run!.error!,/不是一段完整的 JSON/);
  f.adapter.respond=defaultPlan;await f.json(await f.run({replan:true}));assert.equal((await f.complete())!.state,'committed');const ready=await f.plan();assert.equal(ready.state,'ready');assert.equal(ready.run!.error,null);assert.equal(f.planJobs().length,4);
 }finally{await f.close();}
});
test('three strategies: article/post slots are auto-imported once and marked AI-selected; AI slots wait unqueued without spending budget',async()=>{
 const f=await startPlanFixture();try{
  await f.json(await f.run({replan:false}));await f.complete();const ready=await f.plan();
  assert.deepEqual(ready.items.map(i=>[i.role,i.source_strategy,i.status]),[['cover','ai_generate','awaiting_generation'],['body','article_original','filled'],['body','platform_post','filled'],['body','ai_generate','awaiting_generation']]);
  const [coverItem,article,post,flow]=ready.items;assert.equal(coverItem!.position,'cover');
  assert.equal(article!.current_version!.auto_selected,true);assert.equal(article!.current_version!.credit_label,'图源：Example News');assert.equal(article!.auto.state,'selected');assert.equal(article!.current_version!.index,1);
  assert.equal(post!.current_version!.auto_selected,true);assert.match(post!.current_version!.credit_label!,/图源：抖音/,'未给候选 ID 时按段落关键词选中同题抖音作品');
  const slot=ready.studio.slots.find(s=>s.id===article!.slot_id)!;assert.equal(slot.paragraph_id,article!.paragraph_id);assert.equal(slot.position,'after');assert.equal(slot.versions[0]!.operation,'web_import');assert.equal(slot.versions[0]!.auto_selected,true);assert.equal(slot.versions[0]!.job_id,null);
  assert.equal(ready.studio.slots.some(s=>s.id===coverItem!.slot_id||s.id===flow!.slot_id),false,'AI 槽位只备好提示词，不建任务');assert.ok(flow!.prompt_draft.includes('六个步骤'));
  assert.equal(mediaJobs(f),0);assert.deepEqual(budget(f),{codex:0,agy:0});assert.equal(f.image_calls,0);
  const downloads=f.web.count('https://news.example/og.png')+f.web.count('https://douyin.example/cover.png');assert.equal(downloads,2);
  const again=await f.plan();assert.equal(again.studio.slots.length,2);assert.equal(f.web.count('https://news.example/og.png')+f.web.count('https://douyin.example/cover.png'),2,'重复读取不重复导入');
  assert.equal(JSON.stringify(again.items.map(i=>i.issue)).match(/[0-9a-f]{32}/),null);
 }finally{await f.close();}
});
test('no matching web image leaves the slot pending with a reason; switching to a web strategy later triggers selection',async()=>{
 const f=await startPlanFixture({seed:false});try{
  await f.json(await f.run({replan:false}));await f.complete();const ready=await f.plan();const [,article,post]=ready.items;
  assert.equal(article!.status,'pending');assert.equal(article!.auto.state,'no_match');assert.match(article!.issue!,/没有找到和这段相关的原文配图/);assert.equal(post!.status,'pending');assert.equal(ready.studio.slots.length,0);
  const {seedWebSources}=await import('../image-studio/web-fixture.ts');seedWebSources(f.app.context,f.request(),f.topic.id,{searchText:'同题帖子：'+f.topic.title});
  await f.json(await f.update(post!.id,{source_strategy:'ai_generate'}));let next=await f.json<ImagePlanSnapshot>(await f.update(post!.id,{source_strategy:'platform_post'}));
  const selected=next.items.find(i=>i.id===post!.id)!;assert.equal(selected.status,'filled');assert.equal(selected.current_version!.auto_selected,true);
 }finally{await f.close();}
});
test('item edits: caption, prompt, strategy, skip/restore and up/down move are reflected in order; cover cannot move; stale version is rejected',async()=>{
 const f=await startPlanFixture();try{
  await f.json(await f.run({replan:false}));await f.complete();let s=await f.plan();const ids=s.items.map(i=>i.id);
  s=await f.json(await f.update(ids[3]!,{purpose:'六步流程图（改过的图注）',prompt_draft:'改过的提示词',aspect:'2:5'}));const flow=s.items[3]!;assert.equal(flow.purpose,'六步流程图（改过的图注）');assert.equal(flow.prompt_draft,'改过的提示词');assert.equal(flow.aspect,'2:5');
  s=await f.json(await f.update(ids[3]!,{skipped:true}));assert.equal(s.items[3]!.status,'skipped');s=await f.json(await f.update(ids[3]!,{skipped:false}));assert.equal(s.items[3]!.status,'awaiting_generation');
  const before=s.items.map(i=>[i.id,i.placement_paragraph_id,i.position]);
  s=await f.json(await f.update(ids[3]!,{move:'up'}));assert.deepEqual(s.items.map(i=>i.id),[ids[0],ids[1],ids[3],ids[2]]);
  const moved=s.items[2]!;assert.equal(moved.placement_paragraph_id,before[2]![1]);assert.equal(moved.paragraph_id,before[3]![1],'图仍说明原来那段，只交换在文章里的位置');
  s=await f.json(await f.update(ids[3]!,{move:'down'}));assert.deepEqual(s.items.map(i=>i.id),ids);
  const body=await f.json<{error:{message:string}}>(await f.update(ids[0]!,{move:'down'}),400);assert.match(body.error.message,/封面固定在最前/);
  await f.json(await f.update(ids[1]!,{move:'up'}),400);
  await f.json(await f.update(ids[1]!,{purpose:'x'},randomUUID(),s.version-1),409);
  s=await f.json(await f.update(ids[1]!,{source_strategy:'ai_generate'}));assert.equal(s.items[1]!.status,'filled','已有图片时换策略不丢图');
  const key=randomUUID(),v=s.version;await f.json(await f.update(ids[2]!,{purpose:'重放'},key,v));const replay=await f.json<ImagePlanSnapshot>(await f.update(ids[2]!,{purpose:'重放'},key,v));assert.equal(replay.items[2]!.purpose,'重放');
  await f.json(await f.update(randomUUID(),{purpose:'x'}),404);
 }finally{await f.close();}
});
test('per-slot generation uses the reserved slot through the existing budget gate; over-budget is refused; source swap adds a version, old one can be restored; edits go through reference_edit',async()=>{
 const f=await startPlanFixture({image_generation_limits:{codex:0,agy:2}});try{
  await f.json(await f.run({replan:false}));await f.complete();let s=await f.plan();const [coverItem,article,,flow]=s.items;
  const generate=(it:typeof coverItem,snap:ImagePlanSnapshot,extra:Record<string,unknown>={})=>f.call('POST','/api/v1/image-studio/generations',{topic_id:f.topic.id,document_revision_id:snap.studio.document_revision_id,paragraph_id:it!.paragraph_id,placement_paragraph_id:it!.placement_paragraph_id,description:it!.prompt_draft,title:it!.purpose,position:it!.position,provider:'agy',references:[],expected_version:snap.studio.version,slot_id:it!.slot_id,parent_version_id:null,operation:'generate',size_mode:'manual',size:{width:1600,height:900,aspect_ratio:'16:9'},brief_id:null,...extra});
  const queued=await f.json<{slot_id:string}>(await generate(coverItem,s),202);assert.equal(queued.slot_id,coverItem!.slot_id,'首次生成按方案预留的槽位建图');
  s=await f.plan();assert.equal(s.items[0]!.status,'generating');const created=s.studio.slots.find(x=>x.id===coverItem!.slot_id)!;assert.equal(created.position,'cover');assert.deepEqual(budget(f),{codex:0,agy:1});assert.deepEqual(s.budget.agy,{used:1,limit:2,remaining:1});
  await f.json(await generate(flow,s,{provider:'codex'}),429);assert.equal(s.studio.slots.some(x=>x.id===flow!.slot_id),false);
  // 换来源：同一槽位导入另一张原文图，版本号递增，指针移到新版；切回旧版即登记采用。
  const candidates=(await f.json<{candidates:StudioWebImageCandidate[]}>(await f.call('GET','/api/v1/topics/'+f.topic.id+'/web-image-candidates'))).candidates,other=candidates.find(c=>c.image_url.endsWith('/tw.png'))!;
  const imported=await f.json<StudioWebImportResult>(await f.call('POST','/api/v1/image-studio/web-imports',{topic_id:f.topic.id,expected_version:s.studio.version,slot_id:article!.slot_id,candidate:{candidate_id:other.candidate_id,image_url:other.image_url}}),201);
  s=await f.plan();let swapped=s.items.find(i=>i.id===article!.id)!;assert.equal(swapped.current_version!.index,2);assert.equal(swapped.current_version!.id,imported.version_id);assert.equal(swapped.current_version!.auto_selected,false);
  const first=s.studio.slots.find(x=>x.id===article!.slot_id)!.versions[0]!;s=await f.json(await f.update(article!.id,{current_version_id:first.id}));swapped=s.items.find(i=>i.id===article!.id)!;assert.equal(swapped.current_version!.index,1);assert.equal(s.studio.slots.find(x=>x.id===article!.slot_id)!.active_version_id,first.id,'切回旧版同时登记采用');
  s=await f.json(await f.update(article!.id,{current_version_id:null}));assert.equal(s.items.find(i=>i.id===article!.id)!.status,'pending');assert.equal(s.studio.slots.find(x=>x.id===article!.slot_id)!.versions.length,2,'清除只换掉当前图，版本保留');
  s=await f.json(await f.update(article!.id,{current_version_id:imported.version_id}));
  const edit=await f.json<{slot_id:string}>(await generate(s.items.find(i=>i.id===article!.id)!,s,{operation:'reference_edit',parent_version_id:imported.version_id,description:'增加留白，保留品牌元素'}),202);assert.equal(edit.slot_id,article!.slot_id);
  s=await f.plan();const editing=s.studio.slots.find(x=>x.id===article!.slot_id)!.versions.at(-1)!;assert.equal(editing.operation,'reference_edit');assert.equal(editing.parent_version_id,imported.version_id);assert.equal(s.items.find(i=>i.id===article!.id)!.status,'generating');assert.deepEqual(budget(f),{codex:0,agy:2});
  await f.json(await f.call('POST','/api/v1/image-studio/generations',{topic_id:f.topic.id,document_revision_id:s.studio.document_revision_id,paragraph_id:flow!.paragraph_id,placement_paragraph_id:flow!.paragraph_id,description:'d',title:'',position:'after',provider:'agy',references:[],expected_version:s.studio.version,slot_id:randomUUID(),parent_version_id:null,operation:'generate',size_mode:'manual',size:{width:1600,height:900,aspect_ratio:'16:9'},brief_id:null}),404);
 }finally{await f.close();}
});
test('an edited article marks the plan stale; extra studio slots outside the plan show up as manual items',async()=>{
 const f=await startPlanFixture();try{
  await f.json(await f.run({replan:false}));await f.complete();let s=await f.plan();assert.equal(s.stale,false);
  const candidates=(await f.json<{candidates:StudioWebImageCandidate[]}>(await f.call('GET','/api/v1/topics/'+f.topic.id+'/web-image-candidates'))).candidates,x=candidates.find(c=>c.credit_label==='图源：X @alice')!;
  await f.json(await f.call('POST','/api/v1/image-studio/web-imports',{topic_id:f.topic.id,expected_version:s.studio.version,slot_id:null,candidate:{candidate_id:x.candidate_id,image_url:x.image_url}}),201);
  s=await f.plan();const manual=s.items.filter(i=>i.role==='manual');assert.equal(manual.length,1);assert.equal(manual[0]!.status,'filled');assert.equal(manual[0]!.source_strategy,'platform_post');
  await new Documents(f.app.context).save(f.request(),f.document_id,{expected_revision_id:f.article_revision_id,text:'完全改写后的正文。\n\n第二段。',origin:'human'});
  s=await f.plan();assert.equal(s.stale,true);assert.match(s.items[1]!.issue!,/文章已修改/);
 }finally{await f.close();}
});
nodeTest('workbench view model: canvas follows plan positions and skips, AI-selected label, generate-all splits by remaining budget, copy hides codes',async()=>{
 const {projectWorkbench,generateAllPlan,appendChip,workbenchErrorCopy,PLAN_CHIPS}=await import('../../apps/web/src/features/media/image-studio/plan-model.ts');
 const base={slot_id:'s',role:'body',paragraph_id:'p1',placement_paragraph_id:'p1',seq:10,purpose:'图注',source_strategy:'ai_generate',aspect:'16:9',prompt_draft:'画面',candidate_id:null,skipped:false,auto:{state:'none',candidate_id:null,error:null},current_version_id:null,cleared:false,seen_versions:0,status:'awaiting_generation',paragraph_excerpt:'一',paragraph_index:0,current_version:null,issue:null} as const;
 const items=[{...base,id:'c',slot_id:'sc',role:'cover',position:'cover'},{...base,id:'a',slot_id:'sa',position:'after',placement_paragraph_id:'p2',paragraph_index:1,source_strategy:'article_original',status:'filled',current_version:{id:'v1',index:1,auto_selected:true,credit_label:'图源：X',operation:'web_import'},current_version_id:'v1'},{...base,id:'b',slot_id:'sb',position:'before',placement_paragraph_id:'p1'},{...base,id:'k',slot_id:'sk',position:'after',placement_paragraph_id:'p1',skipped:true,status:'skipped'}];
 const version={id:'v1',slot_id:'sa',asset_id:'asset',provider:'codex',description:'',title:'',requested:{width:16,height:9},accepted:null,actual:{width:16,height:9},mime:'image/png',sha256:'',size_bytes:1,created_at:'',job_id:null,parent_version_id:null,reference_assets:[],actual_verified:true,state:'succeeded',warning:null,error:null,accepted_parameters:null,document_revision_id:'r',paragraph_id:'p2',placement:'after:p2',operation:'web_import'};
 const studio={topic_id:'t',document_revision_id:'r',version:3,title:'',article:'',paragraphs:[{id:'p1',label:'第 1 段',text:'一'},{id:'p2',label:'第 2 段',text:'二'}],slots:[{id:'sa',title:'',description:'',placement:'after:p2',adopted_version_id:null,versions:[version]}],references:[],capabilities:[]};
 const plan={topic_id:'t',topic_title:'标题',version:2,state:'ready',run:null,stale:false,items,budget:{codex:{used:2,limit:2,remaining:0},agy:{used:1,limit:2,remaining:1}},studio:{}};
 const vm=projectWorkbench(plan as never,studio as never,new Set(['b']));
 assert.deepEqual(vm.canvas.map(b=>b.kind==='figure'?b.item.id:b.id),['c','b','p1','p2','a'],'封面→段前→段落→段后，跳过的不排入');
 assert.equal(vm.items.find(i=>i.id==='a')!.statusLabel,'AI 选中，可换');assert.equal(vm.items.find(i=>i.id==='b')!.statusLabel,'额度不足');assert.deepEqual(vm.pendingGenerate.map(i=>i.id),['c','b']);
 const split=generateAllPlan(vm.pendingGenerate,1);assert.deepEqual([split.queue.map(i=>i.id),split.blocked.map(i=>i.id)],[['c'],['b']]);assert.equal(generateAllPlan(vm.pendingGenerate,0).queue.length,0);
 assert.equal(appendChip('人物缩小',PLAN_CHIPS.space!),'人物缩小。'+PLAN_CHIPS.space+'。');assert.equal(appendChip(appendChip('',PLAN_CHIPS.brand!),PLAN_CHIPS.brand!),PLAN_CHIPS.brand+'。');
 for(const e of [{response:{error:{code:'VALIDATION_ERROR'}},message:'VALIDATION_ERROR job 0a1b2c3d-1111-2222-3333-444455556666'},Object.assign(new Error('x'),{response:{error:{code:'QUOTA_EXHAUSTED'}}})])assert.equal(/[A-Z_]{6,}|[0-9a-f]{8}-/.test(workbenchErrorCopy(e)),false);
});
test('auto-select in flight never overrides a user edit: switching to AI keeps the imported web image as an unused candidate, not current, not AI-selected',async()=>{
 const {planNetwork}=await import('../image-studio/plan-fixture.ts');const {readImagePlan}=await import('../../packages/storage/src/image-studio/index.ts');
 const web=planNetwork(),og='https://news.example/og.png',orig=web.routes.get(og)!;let release!:()=>void,hit!:()=>void;const gate=new Promise<void>(r=>{release=r;}),reached=new Promise<void>(r=>{hit=r;});
 const f=await startPlanFixture({web});try{
  await f.json(await f.run({replan:false}));web.routes.set(og,async()=>{hit();await gate;return orig();});await f.complete();
  const reading=f.plan();await reached;const stored=readImagePlan(f.app.context.db,f.app.identity.workspace_id,f.topic.id),article=stored.plan!.items.find(i=>i.source_strategy==='article_original')!;
  const edited=await f.json<ImagePlanSnapshot>(await f.call('POST','/api/v1/image-studio/plan/items/'+article.id,{topic_id:f.topic.id,expected_version:stored.version,source_strategy:'ai_generate'},randomUUID()));assert.equal(edited.items.find(i=>i.id===article.id)!.source_strategy,'ai_generate');
  release();await reading;const after=await f.plan(),item=after.items.find(i=>i.id===article.id)!;
  assert.equal(item.source_strategy,'ai_generate');assert.equal(item.current_version,null,'不把后到的网络图设为当前图');assert.equal(item.status,'awaiting_generation');assert.notEqual(item.auto.state,'selected');
  const slot=after.studio.slots.find(s=>s.id===article.slot_id);if(slot){assert.equal(item.auto.state,'unused','已导入的一版作为候选留在版本条');assert.equal(slot.versions.length,1);}
  const again=await f.plan();assert.equal(again.items.find(i=>i.id===article.id)!.current_version,null,'后续读取也不自动采用');
 }finally{release();await f.close();}
});
test('a skipped item is not auto-imported; adopting a version and updating the plan commit together or roll back together',async()=>{
 const f=await startPlanFixture();try{
  await f.json(await f.run({replan:false}));await f.complete();let s=await f.plan();const article=s.items.find(i=>i.source_strategy==='article_original')!;
  const candidates=(await f.json<{candidates:StudioWebImageCandidate[]}>(await f.call('GET','/api/v1/topics/'+f.topic.id+'/web-image-candidates'))).candidates,other=candidates.find(c=>c.image_url.endsWith('/tw.png'))!;
  await f.json(await f.call('POST','/api/v1/image-studio/web-imports',{topic_id:f.topic.id,expected_version:s.studio.version,slot_id:article.slot_id,candidate:{candidate_id:other.candidate_id,image_url:other.image_url}}),201);
  s=await f.plan();const slot=()=>s.studio.slots.find(x=>x.id===article.slot_id)!,first=slot().versions[0]!,activeBefore=slot().active_version_id;
  // 同一请求里采用成功但移动封面失败：整体回滚，槽位采用不变。
  const cover=s.items.find(i=>i.position==='cover')!;await f.json(await f.call('POST','/api/v1/image-studio/plan/items/'+cover.id,{topic_id:f.topic.id,expected_version:s.version,move:'up'},randomUUID()),400);
  const studioBefore=s.studio.version;await f.json(await f.update(article.id,{current_version_id:first.id},randomUUID(),s.version-1),409);
  s=await f.plan();assert.equal(slot().active_version_id,activeBefore,'方案版本冲突时不留下采用');assert.equal(s.studio.version,studioBefore);
  await f.json(await f.update(article.id,{current_version_id:'not-a-version'}),422);s=await f.plan();assert.equal(slot().active_version_id,activeBefore);
  s=await f.json(await f.update(article.id,{current_version_id:first.id}));assert.equal(slot().active_version_id,first.id);assert.equal(s.items.find(i=>i.id===article.id)!.current_version!.id,first.id);
 }finally{await f.close();}
});
nodeTest('generate-all stops queueing once the workbench is closed while a read is still in flight',async()=>{
 const {workbench,loadValue,deferred,el,settle}=await import('../image-studio/workbench-harness.ts');
 const hold=deferred<ReturnType<typeof loadValue>>(),t=workbench([async()=>loadValue(),()=>hold.promise]);
 t.w.open('topic');await settle();await settle();assert.equal(t.loads,1);
 await t.w.handle('studio-wb-generate-all',el());assert.match(t.dialogs.at(-1)!.body,/把已选的 <b>2<\/b> 张逐张入队/);
 const running=t.w.handle('studio-wb-generate-all-confirm',el());await settle();t.w.close();hold.resolve(loadValue());await running;
 assert.equal(t.submits.length,0,'关闭面板后不再提交');
 const u=workbench([async()=>loadValue()]);u.w.open('topic');await settle();await settle();await u.w.handle('studio-wb-generate-all',el());await u.w.handle('studio-wb-generate-all-confirm',el());assert.equal(u.submits.length,2,'未关闭时逐张入队');
 const v=workbench([async()=>loadValue()]);v.w.open('topic');await settle();await settle();await v.w.handle('studio-wb-generate-all',el());v.w.dialogClosed();await v.w.handle('studio-wb-generate-all-confirm',el());assert.equal(v.submits.length,0,'确认框已关时不入队');
});
nodeTest('a failed poll keeps retrying with backoff (1.5s → 10s cap) and offers a manual reload; a concurrent plan start reads as syncing, not failure',async t=>{
 const {workbench,loadValue,el,settle}=await import('../image-studio/workbench-harness.ts');
 t.mock.timers.enable({apis:['setTimeout']});
 const down=async()=>{throw Object.assign(new Error('读取失败'),{response:{error:{code:'STORAGE_UNAVAILABLE'}}});};
 const w=workbench([async()=>loadValue('planning'),down,down,down,down,down,async()=>loadValue('ready')]);
 w.w.open('topic');await settle();await settle();assert.equal(w.loads,1);
 const step=async(ms:number)=>{t.mock.timers.tick(ms);await settle();await settle();};
 await step(1500);assert.equal(w.loads,2,'规划中按 1.5s 轮询');
 await step(1500);assert.equal(w.loads,3,'失败后 1.5s 重试');await step(2999);assert.equal(w.loads,3);await step(1);assert.equal(w.loads,4,'再失败 3s');
 await step(6000);assert.equal(w.loads,5);await step(10000);assert.equal(w.loads,6,'封顶 10s');
 await w.w.handle('studio-wb-reload',el());assert.equal(w.loads,7,'手动重新读取');
 const conflict=workbench([async()=>loadValue('ready'),async()=>loadValue('planning')],{run:async()=>{throw Object.assign(new Error('配图方案已变化，请刷新'),{response:{error:{code:'VERSION_CONFLICT'}}});}});
 conflict.w.open('topic');await settle();await settle();await conflict.w.handle('studio-wb-replan',el());assert.deepEqual(conflict.toasts,['另一处已开始规划，正在同步']);
 t.mock.timers.reset();
});
nodeTest('channel choices reuse the shared availability rule: no unverified hint in options, blocked channels not selectable, remaining from the channel budget',async()=>{
 const {workbench,loadValue,capability,el,settle}=await import('../image-studio/workbench-harness.ts');
 const caps=[capability('agy',{selectable:true,block:null,message:'',detail:null,unverified:true,remaining:1,limit:2}),capability('codex',{selectable:false,block:'login',message:'需要重新登录',detail:null,unverified:true,remaining:2,limit:2})];
 const t=workbench([async()=>loadValue('ready',caps)]);t.w.open('topic');await settle();await settle();
 await t.w.handle('studio-wb-generate-all',el());const body=t.dialogs.at(-1)!.body,foot=t.dialogs.at(-1)!.foot!;
 assert.match(body,/<option value="agy" selected>AGY 生图 · 剩余 1 次<\/option>/);assert.match(body,/<option value="codex" disabled>Codex 生图 · 需要重新登录<\/option>/);assert.doesNotMatch(body,/未经真实验收/);
 assert.match(body,/1 张超出本渠道剩余额度/);assert.match(foot,/确认生成 1 张/);
 await t.w.handle('studio-wb-generate-all-confirm',el());assert.equal(t.submits.length,1);assert.equal((t.submits[0] as {provider:string}).provider,'agy');
});
// 生产现状：写作执行器 codex supported、claude unverified（都已订阅认证）；生图 AGY 剩 1、Codex 生图剩 0，设置默认 codex。
async function selectorBench(caps:'production'|'none'){
 const {workbench,loadValue,capability,settle}=await import('../image-studio/workbench-harness.ts');const {executorChoices}=await import('../../apps/web/src/components/executors.ts');
 const agy=capability('agy',caps==='none'?{selectable:false,block:'login',message:'需要重新登录',detail:null,unverified:false,remaining:1,limit:2}:{selectable:true,block:null,message:'',detail:null,unverified:false,remaining:1,limit:2});
 const codex=capability('codex',{selectable:false,block:'budget',message:'本渠道真实生图次数已达上限',detail:null,unverified:true,remaining:0,limit:2});
 const value=()=>{const v=loadValue('ready',[agy,codex]) as any;v.studio.default_provider='codex';v.plan.budget={codex:{used:2,limit:2,remaining:0},agy:{used:1,limit:2,remaining:1}};
  v.plan.items[0]={...v.plan.items[0],status:'filled',current_version:{id:'v1',index:1,auto_selected:false,credit_label:null}};
  v.studio.slots=[{id:'slot-a',versions:[{id:'v1',asset_id:'asset-1',state:'succeeded',provider:'agy',operation:'generate',source:null,actual:{width:1600,height:900}}]}];
  v.executors=executorChoices({executors:[{executor_id:'codex',status:'supported',auth_state:'subscription_authenticated'},{executor_id:'claude',status:'unverified',auth_state:'subscription_authenticated'}]} as never);v.default_executor='codex';return v;};
 const t=workbench([async()=>value()]);t.w.open('topic');await settle();await settle();return {...t,markup:()=>String((t.w as any).markup()),value};
}
nodeTest('selectors: planner control is labelled and sits in the replan row; workbench options never say 未经真实验收; image channels say Codex 生图 / AGY 生图',async()=>{
 const t=await selectorBench('production'),html=t.markup();
 const tools=html.slice(html.indexOf('<div class="iwb-plan-tools">'),html.indexOf('data-action="studio-wb-replan"',html.indexOf('<div class="iwb-plan-tools">')));
 assert.match(tools,/^<div class="iwb-plan-tools"><div class="iwb-planner" role="radiogroup" aria-labelledby="iwb-planner-label"><span class="iwb-planner-label" id="iwb-planner-label">AI 规划用<\/span>/,'带标签的分段控件，与「重新规划」同一行（同一 flex 容器、在按钮左侧）');
 assert.match(tools,/<\/div><button[^>]*$/,'分段控件闭合后紧跟「重新规划」按钮，不在下拉弹层里');assert.doesNotMatch(html,/<select class="field" id="studio-wb-executor"/,'不再用原生下拉');
 const seg=[...tools.matchAll(/<input type="radio" name="studio-wb-executor" id="studio-wb-executor-(\w+)" value="\w+"( checked)?( disabled)?><b>([^<]+)<\/b><small>([^<]+)<\/small>/g)].map(m=>[m[1],!!m[2],!!m[3],m[4],m[5]]);
 assert.deepEqual(seg,[['codex',true,false,'Codex','可用'],['claude',false,false,'Claude','可用']]);
 assert.doesNotMatch(html,/未经真实验收/);
 assert.match(html,/>批量生成（已选 1 张）<\/button><p class="iwb-pick-note">默认选中待生成的图；已配的图也可勾选<\/p><p class="iwb-budget-line" id="iwb-budget-line">生图剩余：AGY 1 次 · Codex 生图 0 次（已用完，可在设置放开）<\/p>/);
 // A2-2：已有图的项是「修改」，只列支持在原图上修改的 AGY，Codex 写明不支持并禁用。
 assert.match(html,/<option value="agy" selected>AGY 生图 · 剩余 1 次<\/option><option value="codex" disabled>Codex 生图 · 不支持在原图上修改<\/option>/,'修改下拉只有 AGY 可选');
 const {el}=await import('../image-studio/workbench-harness.ts');
 await t.w.handle('studio-wb-focus',el({item:'b'}));assert.match(t.markup(),/<option value="agy" selected>AGY 生图 · 剩余 1 次<\/option><option value="codex" disabled>Codex 生图 · 次数已用完<\/option>/,'还没有图的项：默认 codex 已用完 → 退到 AGY');
 await t.w.handle('studio-wb-generate-all',el());const dialog=t.dialogs.at(-1)!;assert.doesNotMatch(dialog.body,/未经真实验收/);assert.match(dialog.body,/生图剩余：AGY 1 次 · Codex 生图 0 次/);assert.match(dialog.body,/<option value="agy" selected>AGY 生图/);assert.match(dialog.foot!,/确认生成 1 张/);
 (t.w as any).handleChange({id:'studio-wb-executor-claude',value:'claude',checked:true});assert.match(t.markup(),/id="studio-wb-executor-claude" value="claude" checked/);
});
nodeTest('selectors: default image channel skips the spent default; 生成修改版 is usable; both spent → disabled with reason and a settings link; manual pick survives reloads in the session',async()=>{
 const t=await selectorBench('production');
 const edit=(h:string)=>/<button type="button" class="button primary iwb-primary" data-action="studio-wb-edit" data-item="a"( disabled)?>生成修改版<\/button>/.exec(h);
 assert.ok(edit(t.markup()),'聚焦已有图的项：出现生成修改版');assert.equal(edit(t.markup())![1],undefined,'默认 AGY（剩 1 次）→ 生成修改版可用');
 const {el}=await import('../image-studio/workbench-harness.ts');(t.w as any).handleInput({id:'studio-wb-request',value:'人物缩小一点'});await t.w.handle('studio-wb-edit',el({item:'a'}));assert.equal(t.submits.length,0,'先确认再提交');await t.w.handle('studio-wb-edit-confirm',el());
 assert.deepEqual(t.submits.map(x=>[(x as any).provider,(x as any).operation]),[['agy','reference_edit']],'修改版走 AGY 入队');
 const none=await selectorBench('none');assert.equal(edit(none.markup())![1],' disabled','AGY 不可用 → 生成修改版禁用');await none.w.handle('studio-wb-focus',el({item:'b'}));const h=none.markup();
 assert.match(h,/<select class="field" id="studio-wb-provider" disabled aria-describedby="studio-wb-provider-why">/);
 assert.match(h,/<p class="iwb-provider-none" id="studio-wb-provider-why" role="status">两个生图渠道暂时都用不了：AGY 生图需要重新登录；Codex 生图次数已用完。<button type="button" class="iwb-link" data-action="nav" data-page="settings">去设置放开次数或检查渠道<\/button><\/p>/);
 await none.w.handle('studio-wb-generate-all',el());assert.match(none.dialogs.at(-1)!.body,/id="studio-wb-all-provider" disabled/);assert.match(none.dialogs.at(-1)!.body,/data-page="settings"/);assert.match(none.dialogs.at(-1)!.foot!,/没有可入队的图/);
 // 手动选择：本次会话内保留（重新读取、关掉再开别的文章都不被默认值覆盖）。
 const m=await selectorBench('production');await m.w.handle('studio-wb-focus',el({item:'b'}));(m.w as any).handleChange({id:'studio-wb-provider',value:'codex'});await m.w.reload();
 assert.match(m.markup(),/<option value="codex" selected disabled>Codex 生图 · 次数已用完<\/option>/,'重新读取后仍是手动选的渠道');
 m.w.close();m.w.open('topic');const {settle}=await import('../image-studio/workbench-harness.ts');await settle();await settle();assert.equal((m.w as any).provider,'codex','重新打开仍保留手动选择');
 await m.w.handle('studio-wb-generate-all',el());assert.match(m.dialogs.at(-1)!.body,/<option value="codex" selected disabled>/,'确认框沿用右栏手动选择');
 (m.w as any).handleChange({id:'studio-wb-all-provider',value:'agy'});m.w.dialogClosed();await m.w.handle('studio-wb-generate-all',el());assert.match(m.dialogs.at(-1)!.body,/<option value="agy" selected>/,'确认框里的手动选择也保留');
});
test('unlimited image budget: plan budget reports limit/remaining null and stays usable past the default two',async()=>{
 const f=await startPlanFixture({image_generation_limits:{agy:null,codex:0}});try{
  const s=await f.plan();assert.deepEqual(s.budget.agy,{used:0,limit:null,remaining:null});assert.deepEqual(s.budget.codex,{used:0,limit:0,remaining:0});
 }finally{await f.close();}
});
nodeTest('unlimited image budget copy: 不限次数 in the budget line, channel options, confirm dialog and settings card; nothing is marked 额度不足',async()=>{
 const {workbench,loadValue,capability,el,settle}=await import('../image-studio/workbench-harness.ts');
 const caps=[capability('agy',{selectable:true,block:null,message:'',detail:null,unverified:false,remaining:null,limit:null}),capability('codex',{selectable:true,block:null,message:'',detail:null,unverified:false,remaining:null,limit:null})];
 const t=workbench([async()=>{const v=loadValue('ready',caps) as any;v.plan.budget={codex:{used:7,limit:null,remaining:null},agy:{used:12,limit:null,remaining:null}};return v;}]);t.w.open('topic');await settle();await settle();
 const html=String((t.w as any).markup());assert.match(html,/生图剩余：AGY 不限次数 · Codex 生图 不限次数<\/p>/);assert.match(html,/<option value="agy" selected>AGY 生图 · 不限次数<\/option>/);assert.doesNotMatch(html,/额度不足|已用完/);
 await t.w.handle('studio-wb-generate-all',el());const d=t.dialogs.at(-1)!;assert.match(d.body,/所选渠道不限次数。/);assert.doesNotMatch(d.body,/生图剩余/,'不限次数时不显示额度提示');assert.doesNotMatch(d.body,/额度不足|超出本渠道/);assert.match(d.foot!,/确认生成 2 张/);
 await t.w.handle('studio-wb-generate-all-confirm',el());assert.equal(t.submits.length,2,'不限次数时全部入队');
 const {renderSettings}=await import('../../apps/web/src/features/settings/settings.ts');
 const ch={provider:'agy',label:'AGY · Nano Banana 2',enabled:true,configured:true,identity:'unverified',connection:'unverified',permission:'unverified',model:null,operations:{generation:'supported',reference_edit:'supported',mask:'unverified',writing:'unverified'},limitations:[],budget:{used:12,limit:null,remaining:null}};
 const page=renderSettings({default_executor:'codex',executors:[],capabilities:[],paths:{source_vault_root:null,managed_notes_root:'/n',state_root:'/s',media_root:'/m'},version:1,timezone:'Asia/Shanghai'} as never,{image_providers:{version:1,default_provider:'agy',channels:[ch]} as never,image_draft:{default_provider:'agy',enabled:{agy:true,codex:true}}});
 assert.match(page,/真实生图次数：不限次数（已用 12 次）/);assert.doesNotMatch(page,/已达上限/);
});
test('auto import and plan claim commit together: concurrent reads during the download do not turn an untouched item into an unused candidate',async()=>{
 const {planNetwork}=await import('../image-studio/plan-fixture.ts');
 const web=planNetwork(),og='https://news.example/og.png',orig=web.routes.get(og)!;let release!:()=>void,hit!:()=>void;const gate=new Promise<void>(r=>{release=r;}),reached=new Promise<void>(r=>{hit=r;});
 const f=await startPlanFixture({web});try{
  await f.json(await f.run({replan:false}));web.routes.set(og,async()=>{hit();await gate;return orig();});await f.complete();
  const reading=f.plan();await reached;const during=await f.plan();const article=during.items.find(i=>i.source_strategy==='article_original')!;assert.equal(article.status,'searching');
  release();await reading;const reads=await Promise.all([f.plan(),f.plan()]);
  for(const s of reads){const it=s.items.find(i=>i.id===article.id)!;assert.equal(it.status,'filled');assert.equal(it.auto.state,'selected');assert.equal(it.current_version!.auto_selected,true);}
 }finally{release();await f.close();}
});
test('switching to another web source while a download is in flight keeps the new source pending and lets selection continue',async()=>{
 const {planNetwork}=await import('../image-studio/plan-fixture.ts');const {readImagePlan}=await import('../../packages/storage/src/image-studio/index.ts');
 const web=planNetwork(),og='https://news.example/og.png',orig=web.routes.get(og)!;let release!:()=>void,hit!:()=>void;const gate=new Promise<void>(r=>{release=r;}),reached=new Promise<void>(r=>{hit=r;});
 const f=await startPlanFixture({web});try{
  await f.json(await f.run({replan:false}));web.routes.set(og,async()=>{hit();await gate;return orig();});await f.complete();
  const reading=f.plan();await reached;const stored=readImagePlan(f.app.context.db,f.app.identity.workspace_id,f.topic.id),article=stored.plan!.items.find(i=>i.source_strategy==='article_original')!;
  await f.json(await f.call('POST','/api/v1/image-studio/plan/items/'+article.id,{topic_id:f.topic.id,expected_version:stored.version,source_strategy:'platform_post'},randomUUID()));
  const mid=readImagePlan(f.app.context.db,f.app.identity.workspace_id,f.topic.id).plan!.items.find(i=>i.id===article.id)!;assert.equal(mid.auto.state,'pending');
  release();await reading;const held=readImagePlan(f.app.context.db,f.app.identity.workspace_id,f.topic.id).plan!.items.find(i=>i.id===article.id)!;assert.equal(held.auto.state,'pending','旧导入不覆盖新策略的待选源');assert.equal(held.current_version_id,null,'原文图只作候选');
  const after=await f.plan(),it=after.items.find(i=>i.id===article.id)!;assert.equal(it.source_strategy,'platform_post');assert.notEqual(it.auto.state,'pending','继续选源（候选版本不阻断）');assert.notEqual(it.auto.state,'unused');
  assert.ok(after.studio.slots.find(s=>s.id===article.slot_id)!.versions.some(v=>v.source?.platform==='article'),'旧原文图留在版本条');
  if(it.current_version)assert.notEqual(after.studio.slots.find(s=>s.id===article.slot_id)!.versions.find(v=>v.id===it.current_version!.id)!.source?.platform,'article');
 }finally{release();await f.close();}
});
test('re-adopting the already-active image after the article changed is rejected instead of silently succeeding',async()=>{
 const f=await startPlanFixture();try{
  await f.json(await f.run({replan:false}));await f.complete();let s=await f.plan();const article=s.items.find(i=>i.source_strategy==='article_original')!;
  s=await f.json(await f.update(article.id,{current_version_id:article.current_version!.id}));assert.equal(s.studio.slots.find(x=>x.id===article.slot_id)!.active_version_id,article.current_version!.id);
  await new Documents(f.app.context).save(f.request(),f.document_id,{expected_revision_id:f.article_revision_id,text:'完全改写后的正文。\n\n第二段。',origin:'human'});
  s=await f.plan();const body=await f.json<{error:{code:string;message:string}}>(await f.update(article.id,{current_version_id:article.current_version!.id}),422);assert.equal(body.error.code,'INPUT_STALE');assert.match(body.error.message,/人工文章已改/);
 }finally{await f.close();}
});
test('final confirmation only requires the items the plan still includes; skipped items with leftover candidate slots do not block',async()=>{
 const f=await startPlanFixture();try{
  await f.json(await f.run({replan:false}));await f.complete();let s=await f.plan();const [cover,article,post,flow]=s.items;
  const candidates=(await f.json<{candidates:StudioWebImageCandidate[]}>(await f.call('GET','/api/v1/topics/'+f.topic.id+'/web-image-candidates'))).candidates,x=candidates.find(c=>c.credit_label==='图源：X @alice')!;
  const coverImport=await f.json<StudioWebImportResult>(await f.call('POST','/api/v1/image-studio/web-imports',{topic_id:f.topic.id,expected_version:s.studio.version,slot_id:cover!.slot_id,candidate:{candidate_id:x.candidate_id,image_url:x.image_url}}),201);
  for(const id of [cover!.id,flow!.id])await f.json(await f.update(id,{skipped:true}));
  for(const it of [article!,post!])await f.json(await f.update(it.id,{current_version_id:it.current_version!.id}));
  // 当前图即采用（A2-2）：换源后封面槽位已采用；跳过后它仍留在槽位里，但不纳入终稿。
  s=await f.plan();assert.equal(s.studio.slots.find(x=>x.id===cover!.slot_id)!.active_version_id,coverImport.version_id,'换源即采用，跳过后槽位仍在');
  const done=await f.json<{recording:{wiki_record:string}}>(await f.call('POST','/api/v1/image-studio/confirm-final',{topic_id:f.topic.id,document_revision_id:s.studio.document_revision_id,expected_version:s.studio.version,confirmed:true}));
  const {readFileSync}=await import('node:fs');const record=JSON.parse(readFileSync(done.recording.wiki_record,'utf8').replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/,'$1'));assert.deepEqual(record.slots.map((x:{slot_id:string})=>x.slot_id).sort(),[article!.slot_id,post!.slot_id].sort());
  // 恢复封面后它已是采用版本（当前图即采用），旧面板终稿把它一并纳入。
  await f.json(await f.update(cover!.id,{skipped:false}));s=await f.plan();const again=await f.json<{recording:{wiki_record:string}}>(await f.call('POST','/api/v1/image-studio/confirm-final',{topic_id:f.topic.id,document_revision_id:s.studio.document_revision_id,expected_version:s.studio.version,confirmed:true}));
  const record2=JSON.parse(readFileSync(again.recording.wiki_record,'utf8').replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/,'$1'));assert.deepEqual(record2.slots.map((x:{slot_id:string})=>x.slot_id).sort(),[cover!.slot_id,article!.slot_id,post!.slot_id].sort());
 }finally{await f.close();}
});
nodeTest('closing and reopening the generate-all confirmation starts a new batch; the old in-flight loop never submits for it',async()=>{
 const {workbench,loadValue,deferred,el,settle}=await import('../image-studio/workbench-harness.ts');
 const hold=deferred<ReturnType<typeof loadValue>>(),t=workbench([async()=>loadValue(),()=>hold.promise,async()=>loadValue()]);
 t.w.open('topic');await settle();await settle();
 await t.w.handle('studio-wb-generate-all',el());const old=t.w.handle('studio-wb-generate-all-confirm',el());await settle();
 t.w.dialogClosed();await t.w.handle('studio-wb-generate-all',el());hold.resolve(loadValue());await old;
 assert.equal(t.submits.length,0,'旧批次在新确认框打开后不再提交');
 await t.w.handle('studio-wb-generate-all-confirm',el());assert.equal(t.submits.length,2,'新批次按新的确认入队');
});
nodeTest('reload after a failed first read: a failing retry settles with the error shown and loading reset; the next retry recovers',async()=>{
 const {workbench,loadValue,el,settle}=await import('../image-studio/workbench-harness.ts');
 const down=async()=>{throw Object.assign(new Error('读取失败'),{response:{error:{code:'STORAGE_UNAVAILABLE'}}});};
 const t=workbench([down,down,async()=>loadValue()]);t.w.open('topic');await settle();await settle();const w=t.w as unknown as {loading:boolean;error:string;vm?:unknown};
 assert.equal(w.loading,false);assert.ok(w.error);
 await t.w.handle('studio-wb-retry',el());assert.equal(t.loads,2);assert.equal(w.loading,false,'重试失败后 loading 复位');assert.ok(w.error,'仍显示错误与重新读取');
 await t.w.handle('studio-wb-retry',el());assert.equal(t.loads,3);assert.equal(w.error,'');assert.ok(w.vm);
});

nodeTest('bundled image-plan and speech-cleanup rules load real content, freeze exact hashes and reject mismatched identities',async()=>{
 const {readImagePlanSkill}=await import('../../packages/domain/src/artifact-execution/image-studio/plan-skill.ts');
 const {readSpeechCleanupSkill,speechCleanupContext}=await import('../../packages/domain/src/speech-input/cleanup.ts');
 const {createHash}=await import('node:crypto');
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {pathToFileURL}=await import('node:url');
 const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
 for(const [load,name] of [[readImagePlanSkill,'wechat-image-plan'],[readSpeechCleanupSkill,'speech-cleanup']] as const){
  const skill=load();assert.equal(skill.name,name);assert.equal(skill.sha256,digest(skill.content));assert.ok(skill.content.includes('documents[].text'));
  const root=mkdtempSync(join(tmpdir(),'workbench-skill-test-'));try{
   const path=join(root,'SKILL.md'),url=pathToFileURL(path);writeFileSync(path,'---\nname: wrong-skill\n---\n');assert.throws(()=>load(url),{code:'INPUT_STALE'});
   writeFileSync(path,skill.content);const frozen=load(url);writeFileSync(path,skill.content+'\nSynthetic revision.\n');
   assert.equal(frozen.sha256,skill.sha256);assert.notEqual(load(url).sha256,frozen.sha256);
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 const cleanup=readSpeechCleanupSkill(),context=speechCleanupContext('synthetic-speech','Synthetic transcript.',cleanup);
 assert.equal((context.skill as {sha256:string}).sha256,cleanup.sha256);
});
