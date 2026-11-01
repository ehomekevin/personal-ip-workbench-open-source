// 配图方案「当前图即采用」（A2-2）：自动选源、生成成功自动跟进、手动换源三条路径在填好的同一事务里登记槽位采用；旧数据读取时补采用且幂等；工作台对当前版显示「当前采用」。
import nodeTest from 'node:test';
import test from '../helpers/media-tools.ts';
import assert from 'node:assert/strict';
import type {ImagePlanSnapshot,StudioWebImageCandidate,StudioWebImportResult} from '../../packages/contracts/src/index.ts';
import {readStudio,writeStudio} from '../../packages/storage/src/image-studio/index.ts';
import {transaction} from '../../packages/storage/src/connection/index.ts';
import {startPlanFixture} from '../image-studio/plan-fixture.ts';
type Fixture=Awaited<ReturnType<typeof startPlanFixture>>;
const slotOf=(s:ImagePlanSnapshot,id:string)=>s.studio.slots.find(x=>x.id===id);
const assertAdopted=(s:ImagePlanSnapshot,itemId:string,label:string)=>{const item=s.items.find(i=>i.id===itemId)!;assert.equal(item.status,'filled',label+'：已填好');const slot=slotOf(s,item.slot_id)!;assert.equal(slot.active_version_id,item.current_version!.id,label+'：当前图即采用');assert.equal(slot.versions.find(v=>v.id===item.current_version!.id)!.adoption,'adopted');};
const ready=async(f:Fixture)=>{await f.json(await f.run({replan:false}));await f.complete();return f.plan();};
test('auto-selected web images are adopted in the same import transaction',async()=>{
 const f=await startPlanFixture();try{
  const s=await ready(f);const [,article,post]=s.items;
  assertAdopted(s,article!.id,'原文图自动选源');assertAdopted(s,post!.id,'帖子图自动选源');
  const studio=readStudio(f.app.context.db,f.app.identity.workspace_id,f.topic.id);assert.ok(studio.events.some(e=>e.kind==='plan_current_adopted'),'过程记录写明是方案当前图采用，不冒充本人逐图采用');
  assert.equal(s.studio.version,(await f.plan()).studio.version,'再次读取不重复采用');
 }finally{await f.close();}
});
test('a generated image followed as current is adopted when the plan reads it; the returned studio snapshot already shows the adoption',async()=>{
 const f=await startPlanFixture();try{
  let s=await ready(f);const cover=s.items[0]!;
  await f.json(await f.call('POST','/api/v1/image-studio/generations',{topic_id:f.topic.id,document_revision_id:s.studio.document_revision_id,paragraph_id:cover.paragraph_id,placement_paragraph_id:cover.placement_paragraph_id,description:cover.prompt_draft,title:cover.purpose,position:cover.position,provider:'agy',references:[],expected_version:s.studio.version,slot_id:cover.slot_id,parent_version_id:null,operation:'generate',size_mode:'manual',size:{width:1600,height:900,aspect_ratio:'16:9'},brief_id:null}),202);
  s=await f.plan();assert.equal(s.items[0]!.status,'generating');assert.equal(slotOf(s,cover.slot_id)!.active_version_id,null,'生成中还没有可采用的版本');
  await f.runOnce();s=await f.plan();assertAdopted(s,cover.id,'生成成功自动跟进');
  // 返回的 studio 版本号与服务端一致：直接用它提交下一次生成不会版本冲突。
  const edit=await f.call('POST','/api/v1/image-studio/generations',{topic_id:f.topic.id,document_revision_id:s.studio.document_revision_id,paragraph_id:cover.paragraph_id,placement_paragraph_id:cover.placement_paragraph_id,description:'增加留白',title:cover.purpose,position:cover.position,provider:'agy',references:[],expected_version:s.studio.version,slot_id:cover.slot_id,parent_version_id:s.items[0]!.current_version!.id,operation:'reference_edit',size_mode:'manual',size:{width:1600,height:900,aspect_ratio:'16:9'},brief_id:null});
  assert.equal(edit.status,202,'采用写入后返回的是最新 studio 版本');
 }finally{await f.close();}
});
test('a manual source swap becomes current and adopted; switching back re-adopts the older version',async()=>{
 const f=await startPlanFixture();try{
  let s=await ready(f);const article=s.items[1]!,first=article.current_version!.id;
  const candidates=(await f.json<{candidates:StudioWebImageCandidate[]}>(await f.call('GET','/api/v1/topics/'+f.topic.id+'/web-image-candidates'))).candidates,other=candidates.find(c=>c.image_url.endsWith('/tw.png'))!;
  const imported=await f.json<StudioWebImportResult>(await f.call('POST','/api/v1/image-studio/web-imports',{topic_id:f.topic.id,expected_version:s.studio.version,slot_id:article.slot_id,candidate:{candidate_id:other.candidate_id,image_url:other.image_url}}),201);
  s=await f.plan();assert.equal(s.items[1]!.current_version!.id,imported.version_id);assertAdopted(s,article.id,'手动换源');
  s=await f.json(await f.update(article.id,{current_version_id:first}));assert.equal(slotOf(s,article.slot_id)!.active_version_id,first,'本人切回旧版仍可改');
 }finally{await f.close();}
});
test('an explicit adoption from the old panel is kept: the plan item follows it and later reads never adopt the newer version back',async()=>{
 const f=await startPlanFixture();try{
  let s=await ready(f);const article=s.items[1]!,first=article.current_version!.id;
  const candidates=(await f.json<{candidates:StudioWebImageCandidate[]}>(await f.call('GET','/api/v1/topics/'+f.topic.id+'/web-image-candidates'))).candidates,other=candidates.find(c=>c.image_url.endsWith('/tw.png'))!;
  const imported=await f.json<StudioWebImportResult>(await f.call('POST','/api/v1/image-studio/web-imports',{topic_id:f.topic.id,expected_version:s.studio.version,slot_id:article.slot_id,candidate:{candidate_id:other.candidate_id,image_url:other.image_url}}),201);
  s=await f.plan();assert.equal(slotOf(s,article.slot_id)!.active_version_id,imported.version_id);
  await f.json(await f.call('POST','/api/v1/image-studio/slots/'+article.slot_id+'/adopt',{topic_id:f.topic.id,expected_version:s.studio.version,version_id:first}));
  for(let i=0;i<2;i++){s=await f.plan();assert.equal(slotOf(s,article.slot_id)!.active_version_id,first,'读取不撤销本人采用');assert.equal(s.items[1]!.current_version!.id,first,'方案当前图同步成本人采用的版本');}
  assert.equal(s.final.pending,2,'采用一致，不计入待处理');
 }finally{await f.close();}
});
test('legacy data: a filled item whose slot was never adopted is adopted on read, once',async()=>{
 const f=await startPlanFixture();try{
  let s=await ready(f);const article=s.items[1]!;
  // 模拟旧版本留下的数据：方案已有当前图，槽位采用为空。
  transaction(f.app.context.db,()=>{const state=readStudio(f.app.context.db,f.app.identity.workspace_id,f.topic.id);for(const slot of state.slots){slot.active_version_id=null;for(const v of slot.versions)v.adoption='pending';}writeStudio(f.app.context.db,f.app.identity.workspace_id,state);});
  const legacy=readStudio(f.app.context.db,f.app.identity.workspace_id,f.topic.id).version;
  s=await f.plan();assertAdopted(s,article.id,'旧数据补采用');assertAdopted(s,s.items[2]!.id,'旧数据补采用');assert.equal(s.studio.version,legacy+2,'两个槽位各登记一次');
  const again=await f.plan();assert.equal(again.studio.version,s.studio.version,'重复读取不再写入');assert.equal(readStudio(f.app.context.db,f.app.identity.workspace_id,f.topic.id).events.filter(e=>e.kind==='plan_current_adopted').length,4,'自动选源 2 次 + 补采用 2 次，不重复');
 }finally{await f.close();}
});
nodeTest('workbench: the current version shows 当前采用 instead of an adopt button; picking another version offers 采用这一版',async()=>{
 const {workbench,loadValue,el,settle}=await import('../image-studio/workbench-harness.ts');
 const value=loadValue();const version={id:'v1',slot_id:'slot-a',asset_id:'asset',provider:'agy',description:'',title:'',requested:{width:16,height:9},accepted:null,actual:{width:16,height:9},mime:'image/png',sha256:'',size_bytes:1,created_at:'',job_id:null,parent_version_id:null,reference_assets:[],actual_verified:true,state:'succeeded',warning:null,error:null,accepted_parameters:null,document_revision_id:'r',paragraph_id:'p1',placement:'after:p1',operation:'generate'};
 const items=(value.plan.items as unknown as Array<Record<string,unknown>>);Object.assign(items[0]!,{status:'filled',current_version_id:'v1',current_version:{id:'v1',index:1,auto_selected:false,credit_label:null,operation:'generate'}});
 Object.assign(value.studio,{slots:[{id:'slot-a',title:'',description:'',placement:'after:p1',adopted_version_id:'v1',versions:[version,{...version,id:'v2'}]}]});
 const t=workbench([async()=>value]);t.w.open('topic');await settle();await settle();const markup=()=>(t.w as unknown as {markup():string}).markup();
 await t.w.handle('studio-wb-focus',el({item:'a'}));assert.match(markup(),/当前采用 · v1/);assert.doesNotMatch(markup(),/采用这一版/);
 await t.w.handle('studio-wb-version',el({item:'a',version:'v2'}));assert.match(markup(),/采用这一版/);assert.doesNotMatch(markup(),/当前采用 · v1/);
});
