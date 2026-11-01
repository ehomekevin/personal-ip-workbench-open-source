// 配图确认（A2-2）：POST /api/v1/image-studio/plan/confirm——有未完成项拒绝并返回张数（从未生成的项也算）；全部完成冻结终稿（方案顺序、图注、图源、文件摘要）；幂等重放；版本冲突拒绝；不写 Wiki。
import nodeTest from 'node:test';
import test from '../helpers/media-tools.ts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import type {ImagePlanSnapshot,StudioWebImageCandidate,StudioWebImportResult} from '../../packages/contracts/src/index.ts';
import {readImagePlanFinal} from '../../packages/storage/src/image-studio/index.ts';
import {startPlanFixture} from '../image-studio/plan-fixture.ts';
type Fixture=Awaited<ReturnType<typeof startPlanFixture>>;
const confirm=(f:Fixture,expected:number,key=randomUUID())=>f.call('POST','/api/v1/image-studio/plan/confirm',{topic_id:f.topic.id,expected_version:expected},key);
const final=(f:Fixture)=>readImagePlanFinal(f.app.context.db,f.app.identity.workspace_id,f.topic.id);
const ready=async(f:Fixture)=>{await f.json(await f.run({replan:false}));await f.complete();return f.plan();};
test('confirm refuses while items are unfinished and reports how many — never-generated AI items count too',async()=>{
 const f=await startPlanFixture();try{
  const s=await ready(f);assert.deepEqual(s.final,{pending:2,confirmed:false,current:false,confirmed_at:null},'封面与流程图从未生成，没有槽位，也计入待处理');
  assert.equal(s.studio.slots.some(x=>x.id===s.items[0]!.slot_id),false);
  const body=await f.json<{error:{code:string;message:string;details:{pending:number}}}>(await confirm(f,s.version),400);
  assert.equal(body.error.code,'VALIDATION_ERROR');assert.equal(body.error.details.pending,2);assert.match(body.error.message,/还有 2 张配图待处理/);assert.equal(final(f),null);
  // 已清除当前图的项同样算未完成。
  await f.json(await f.update(s.items[0]!.id,{skipped:true}));await f.json(await f.update(s.items[3]!.id,{skipped:true}));const article=s.items[1]!;
  let next=await f.json<ImagePlanSnapshot>(await f.update(article.id,{current_version_id:null}));assert.equal(next.final.pending,1);
  const cleared=await f.json<{error:{details:{pending:number}}}>(await confirm(f,next.version),400);assert.equal(cleared.error.details.pending,1);
  next=await f.json(await f.update(article.id,{current_version_id:article.current_version!.id}));assert.equal(next.final.pending,0);
 }finally{await f.close();}
});
test('confirm freezes the final in plan order with caption, credit, file digest and anchor; replay is idempotent; stale version is rejected; nothing is written to the Wiki',async()=>{
 const f=await startPlanFixture();try{
  let s=await ready(f);const [cover,article,post,flow]=s.items;
  await f.json(await f.call('POST','/api/v1/image-studio/generations',{topic_id:f.topic.id,document_revision_id:s.studio.document_revision_id,paragraph_id:cover!.paragraph_id,placement_paragraph_id:cover!.placement_paragraph_id,description:cover!.prompt_draft,title:cover!.purpose,position:cover!.position,provider:'agy',references:[],expected_version:s.studio.version,slot_id:cover!.slot_id,parent_version_id:null,operation:'generate',size_mode:'manual',size:{width:1600,height:900,aspect_ratio:'16:9'},brief_id:null}),202);
  await f.runOnce();s=await f.json(await f.update(flow!.id,{skipped:true}));assert.equal(s.final.pending,0);
  await f.json(await confirm(f,s.version-1),409);assert.equal(final(f),null,'版本冲突不留终稿');
  const key=randomUUID(),done=await f.json<ImagePlanSnapshot>(await confirm(f,s.version,key));assert.equal(done.final.confirmed,true);assert.equal(done.final.current,true);assert.equal(done.final.pending,0);
  const frozen=final(f)!;assert.equal(frozen.schema_version,'image-plan-final/1');assert.equal(frozen.document_revision_id,s.studio.document_revision_id);assert.equal(frozen.plan_id!==undefined,true);
  assert.deepEqual(frozen.items.map(i=>i.item_id),[cover!.id,article!.id,post!.id],'按方案顺序，跳过的不纳入');
  const byId=(id:string)=>frozen.items.find(i=>i.item_id===id)!;
  assert.equal(byId(article!.id).caption,article!.purpose);assert.equal(byId(article!.id).credit_label,'图源：Example News');assert.equal(byId(cover!.id).credit_label,null,'AI 生图没有图源');
  assert.equal(byId(article!.id).position,'after');assert.equal(byId(article!.id).paragraph_id,article!.placement_paragraph_id);assert.equal(byId(cover!.id).position,'cover');
  for(const it of frozen.items){const slot=done.studio.slots.find(x=>x.id===it.slot_id)!,version=slot.versions.find(v=>v.id===it.version_id)!;assert.equal(slot.active_version_id,it.version_id);assert.equal(it.asset_id,version.asset_id);assert.deepEqual([it.pixel_width,it.pixel_height],[version.actual_size!.width,version.actual_size!.height]);
   const asset=f.app.context.db.prepare('SELECT sha256 FROM assets WHERE id=?').get(it.asset_id)!;assert.equal(it.sha256,asset.sha256);assert.equal(it.url,'/api/v1/assets/'+it.asset_id+'/content');}
  // 同键重放：返回现状，不新建终稿；不同键、内容不变：保留原终稿与确认时间。
  const replay=await f.json<ImagePlanSnapshot>(await confirm(f,s.version,key));assert.equal(replay.final.confirmed_at,done.final.confirmed_at);assert.deepEqual(final(f),frozen);
  const same=await f.json<ImagePlanSnapshot>(await confirm(f,(await f.plan()).version));assert.equal(same.final.confirmed_at,frozen.confirmed_at);assert.equal(final(f)!.id,frozen.id);
  assert.equal(existsSync(join(f.root,'notes','wiki')),false,'配图确认不写 Wiki');
  // 确认后改图：终稿不再是最新，重新确认得到新终稿。
  const candidates=(await f.json<{candidates:StudioWebImageCandidate[]}>(await f.call('GET','/api/v1/topics/'+f.topic.id+'/web-image-candidates'))).candidates,other=candidates.find(c=>c.image_url.endsWith('/tw.png'))!;
  const swapped=await f.json<StudioWebImportResult>(await f.call('POST','/api/v1/image-studio/web-imports',{topic_id:f.topic.id,expected_version:(await f.plan()).studio.version,slot_id:article!.slot_id,candidate:{candidate_id:other.candidate_id,image_url:other.image_url}}),201);
  s=await f.plan();assert.equal(s.final.current,false,'配图已改，终稿不是最新');assert.equal(s.final.confirmed,true);
  await f.json(await confirm(f,s.version));const updated=final(f)!;assert.notEqual(updated.id,frozen.id);assert.equal(updated.items.find(i=>i.item_id===article!.id)!.version_id,swapped.version_id);
 }finally{await f.close();}
});
test('confirm is refused when the article changed after planning',async()=>{
 const f=await startPlanFixture();try{
  let s=await ready(f);for(const id of [s.items[0]!.id,s.items[3]!.id])await f.json(await f.update(id,{skipped:true}));
  const {Documents}=await import('../../packages/domain/src/documents/index.ts');await new Documents(f.app.context).save(f.request(),f.document_id,{expected_revision_id:f.article_revision_id,text:'完全改写后的正文。\n\n第二段。',origin:'human'});
  s=await f.plan();const body=await f.json<{error:{code:string;message:string}}>(await confirm(f,s.version),422);assert.equal(body.error.code,'INPUT_STALE');assert.match(body.error.message,/重新规划/);assert.equal(final(f),null);
 }finally{await f.close();}
});
nodeTest('workbench: 确认配图，进入排版 is disabled with the pending count, confirms then opens the layout; the 排版 step is clickable once confirmed',async()=>{
 const {workbench,loadValue,el,settle}=await import('../image-studio/workbench-harness.ts');
 const value=(pending:number,confirmed:boolean)=>{const v=loadValue();Object.assign(v.plan,{final:{pending,confirmed,current:confirmed,confirmed_at:confirmed?'2026-10-15T00:00:00Z':null}});return v;};
 const confirms:unknown[]=[],opened:string[]=[];
 const t=workbench([async()=>value(2,false),async()=>value(0,false),async()=>value(0,true)],{confirm:async input=>{confirms.push(input);return value(0,true).plan;}});
 (t.w as unknown as {host:{openLayout(topic:string):void}}).host.openLayout=topic=>{opened.push(topic);};
 t.w.open('topic');await settle();await settle();const markup=()=>(t.w as unknown as {markup():string}).markup();
 assert.match(markup(),/data-action="studio-wb-confirm"[^>]*disabled/);assert.match(markup(),/还有 2 张待处理/);assert.doesNotMatch(markup(),/data-action="studio-wb-layout"/,'没确认过时排版步骤不可点');
 await t.w.handle('studio-wb-confirm',el());assert.equal(confirms.length,0,'禁用时不提交');
 await t.w.reload();assert.doesNotMatch(markup(),/data-action="studio-wb-confirm"[^>]*disabled/);assert.doesNotMatch(markup(),/张待处理/);
 await t.w.handle('studio-wb-confirm',el());assert.deepEqual(confirms,[{topic_id:'topic',expected_version:2}]);assert.deepEqual(opened,['topic']);
 await t.w.reload();assert.match(markup(),/data-action="studio-wb-layout"/,'确认过后排版步骤可点');await t.w.handle('studio-wb-layout',el());assert.deepEqual(opened,['topic','topic']);
});
test('confirm re-checks the slot state inside its transaction: a change between reading and freezing is refused with 409 and no final',async()=>{
 const {ImageStudio}=await import('../../packages/domain/src/artifact-execution/image-studio/index.ts');const {ImagePlans}=await import('../../packages/domain/src/artifact-execution/image-studio/plan.ts');
 const {readStudio,writeStudio}=await import('../../packages/storage/src/image-studio/index.ts');const {transaction}=await import('../../packages/storage/src/connection/index.ts');const {ContractError}=await import('../../packages/contracts/src/index.ts');
 const f=await startPlanFixture();try{
  let s=await ready(f);for(const id of [s.items[0]!.id,s.items[3]!.id])await f.json(await f.update(id,{skipped:true}));s=await f.plan();assert.equal(s.final.pending,0);
  const studio=new ImageStudio(f.app.context),plans=new ImagePlans(f.app.context,studio),read=studio.snapshot.bind(studio);
  // 每次读完槽位快照后，另一处立刻改了槽位（版本号前进）。
  studio.snapshot=async(request,topic)=>{const value=await read(request,topic);transaction(f.app.context.db,()=>{const state=readStudio(f.app.context.db,f.app.identity.workspace_id,topic);state.version++;writeStudio(f.app.context.db,f.app.identity.workspace_id,state);});return value;};
  await assert.rejects(plans.confirm(f.request(),{topic_id:f.topic.id,expected_version:s.version}),(e:unknown)=>e instanceof ContractError&&e.code==='VERSION_CONFLICT');assert.equal(final(f),null);
  const ok=await f.json<ImagePlanSnapshot>(await confirm(f,(await f.plan()).version));assert.equal(ok.final.confirmed,true,'没有交错时正常确认');
 }finally{await f.close();}
});
nodeTest('workbench: a version conflict on confirm reloads and retries once, then opens the layout',async()=>{
 const {workbench,loadValue,el,settle}=await import('../image-studio/workbench-harness.ts');
 const value=()=>{const v=loadValue();Object.assign(v.plan,{final:{pending:0,confirmed:false,current:false,confirmed_at:null}});return v;};
 let calls=0;const opened:string[]=[];
 const t=workbench([async()=>value()],{confirm:async()=>{calls++;if(calls===1)throw Object.assign(new Error('配图方案已变化，请刷新'),{response:{error:{code:'VERSION_CONFLICT'}}});return value().plan;}});
 (t.w as unknown as {host:{openLayout(topic:string):void}}).host.openLayout=topic=>{opened.push(topic);};
 t.w.open('topic');await settle();await settle();await t.w.handle('studio-wb-confirm',el());
 assert.equal(calls,2,'重读后重试一次');assert.deepEqual(opened,['topic']);assert.deepEqual(t.toasts,[]);
});
