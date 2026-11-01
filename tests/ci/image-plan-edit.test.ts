// 配图方案编辑（A2-2）：位置下拉、拖拽排序、删除（方案项与手动项）、手动加一张、上传/找回为新版本、标注随修改记入版本、待核对版本与服务端一致。
import test from '../helpers/media-tools.ts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {ImagePlanSnapshot,StudioAssetVersionResult,StudioMark} from '../../packages/contracts/src/index.ts';
import {MediaImporter} from '../../packages/domain/src/artifact-execution/import.ts';
import {solidPng} from '../helpers/png.ts';
import {startPlanFixture} from '../image-studio/plan-fixture.ts';
type Fixture=Awaited<ReturnType<typeof startPlanFixture>>;
const ready=async(f:Fixture)=>{await f.json(await f.run({replan:false}));await f.complete();return f.plan();};
const upload=async(f:Fixture,width=800,height=600)=>(await new MediaImporter(f.app.context).importFile(f.request(),(async function*(){yield new Uint8Array(solidPng(width,height,[12,40,90]));})(),{kind:'image',mime:'image/png',topic_id:f.topic.id,purpose:'style'})).asset_id;
const assetVersion=(f:Fixture,s:ImagePlanSnapshot,body:Record<string,unknown>,key=randomUUID())=>f.call('POST','/api/v1/image-studio/asset-versions',{topic_id:f.topic.id,expected_version:s.studio.version,...body},key);
const create=async(f:Fixture,body:Record<string,unknown>,key=randomUUID())=>f.call('POST','/api/v1/image-studio/plan/items',{topic_id:f.topic.id,expected_version:(await f.plan()).version,...body},key);
const generate=(f:Fixture,s:ImagePlanSnapshot,item:ImagePlanSnapshot['items'][number],extra:Record<string,unknown>={})=>f.call('POST','/api/v1/image-studio/generations',{topic_id:f.topic.id,document_revision_id:s.studio.document_revision_id,paragraph_id:item.paragraph_id,placement_paragraph_id:item.placement_paragraph_id,description:item.prompt_draft,title:item.purpose,position:item.position,provider:'agy',references:[],expected_version:s.studio.version,slot_id:item.slot_id,parent_version_id:null,operation:'generate',size_mode:'manual',size:{width:1600,height:900,aspect_ratio:'16:9'},brief_id:null,...extra});
test('placement dropdown re-anchors an item to a chosen paragraph and before/after; only one cover; drag (move_to) rotates positions; all persists across reads',async()=>{
 const f=await startPlanFixture();try{
  let s=await ready(f);const ids=s.items.map(i=>i.id),p=s.studio.paragraphs;
  s=await f.json(await f.update(ids[3]!,{placement:{position:'before',paragraph_id:p[1]!.id}}));
  const moved=s.items.find(i=>i.id===ids[3])!;assert.equal(moved.position,'before');assert.equal(moved.placement_paragraph_id,p[1]!.id);assert.equal(moved.paragraph_id,p[1]!.id,'改位置后这张图说明所选的段落');
  assert.deepEqual(s.items.map(i=>i.id),[ids[0],ids[3],ids[1],ids[2]],'第 2 段之前排在第 2 段之后的图前面');
  const cover=await f.json<{error:{message:string}}>(await f.update(ids[1]!,{placement:{position:'cover',paragraph_id:null}}),400);assert.match(cover.error.message,/已经有一张封面/);
  const missing=await f.update(ids[1]!,{placement:{position:'after',paragraph_id:'不存在'}});assert.notEqual(missing.status,200,'不存在的段落被拒绝');
  assert.equal((await f.update(ids[1]!,{placement:{position:'after',paragraph_id:null}})).status,400,'正文位置必须选段落');
  // 拖拽：把最后一张拖到第 0 位，其余依次让位（与逐次上移等价）。
  const order=s.items.filter(i=>i.position!=='cover').map(i=>[i.id,i.position,i.placement_paragraph_id]);
  s=await f.json(await f.update(ids[2]!,{move_to:0}));const body=s.items.filter(i=>i.position!=='cover');
  assert.deepEqual(body.map(i=>i.id),[ids[2],ids[3],ids[1]]);assert.deepEqual(body.map(i=>[i.position,i.placement_paragraph_id]),order.map(o=>[o[1],o[2]]),'落点集合不变，图依次换位');
  const again=await f.plan();assert.deepEqual(again.items.map(i=>i.id),s.items.map(i=>i.id),'刷新后保留');
  // 封面可以改到正文，空出的封面位可以给别的图。
  s=await f.json(await f.update(ids[0]!,{placement:{position:'after',paragraph_id:p[5]!.id}}));s=await f.json(await f.update(ids[1]!,{placement:{position:'cover',paragraph_id:null}}));assert.equal(s.items[0]!.id,ids[1]);assert.equal(s.items[0]!.position,'cover');
 }finally{await f.close();}
});
test('delete: plan and manual items disappear from the view, canvas and final record; versions stay in the studio; replan and reads never resurrect them',async()=>{
 const f=await startPlanFixture();try{
  let s=await ready(f);const [cover,article,post,flow]=s.items;
  const made=await f.json<ImagePlanSnapshot>(await create(f,{position:'after',paragraph_id:s.studio.paragraphs[4]!.id}),201);const manual=made.items.find(i=>i.role==='manual')!;
  assert.equal(manual.status,'awaiting_generation');assert.equal(manual.placement_paragraph_id,s.studio.paragraphs[4]!.id);assert.match(manual.purpose,/第 5 段/);
  // 手动项先放一张上传图，再删除：图仍在素材里。
  const asset=await upload(f);s=await f.plan();await f.json(await assetVersion(f,s,{slot_id:manual.slot_id,asset_id:asset,purpose:'style',name:'参考.png'}),201);
  s=await f.json(await f.update(manual.id,{removed:true}));assert.equal(s.items.some(i=>i.id===manual.id),false);assert.ok(s.studio.slots.find(x=>x.id===manual.slot_id)!.versions.length===1,'版本保留');
  s=await f.json(await f.update(article!.id,{removed:true}));assert.deepEqual(s.items.map(i=>i.id),[cover!.id,post!.id,flow!.id]);
  assert.equal(JSON.stringify(s.items).includes('"removed"'),false,'读取视图不带 removed 字段');
  await f.json(await f.update(article!.id,{purpose:'x'}),404);
  s=await f.plan();assert.equal(s.items.length,3,'再次读取不会把已删除手动项的槽位当作方案外的图加回');
  await f.json(await f.run({replan:true}));await f.complete();s=await f.plan();assert.equal(s.items.filter(i=>i.role==='manual'&&i.slot_id===manual.slot_id).length,0,'重新规划后已删除的图也不回来');
  // 终稿：已删除项不纳入；正文其余项采用后可确认。
  const fresh=await f.plan();for(const it of fresh.items.filter(i=>i.source_strategy==='ai_generate'||!i.current_version))await f.json(await f.update(it.id,{removed:true}));
  s=await f.plan();for(const it of s.items)await f.json(await f.update(it.id,{current_version_id:it.current_version!.id}));s=await f.plan();
  const done=await f.json<{recording:{wiki_record:string}}>(await f.call('POST','/api/v1/image-studio/confirm-final',{topic_id:f.topic.id,document_revision_id:s.studio.document_revision_id,expected_version:s.studio.version,confirmed:true}));
  const record=JSON.parse(readFileSync(done.recording.wiki_record,'utf8').replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/,'$1'));assert.equal(record.slots.some((x:{slot_id:string})=>x.slot_id===manual.slot_id||x.slot_id===article!.slot_id),false);
 }finally{await f.close();}
});
test('final record uses the plan position the person chose',async()=>{
 const f=await startPlanFixture();try{
  let s=await ready(f);const [cover,article,post,flow]=s.items;for(const id of [cover!.id,flow!.id,post!.id])await f.json(await f.update(id,{removed:true}));
  const target=s.studio.paragraphs[6]!.id;s=await f.json(await f.update(article!.id,{placement:{position:'before',paragraph_id:target}}));await f.json(await f.update(article!.id,{current_version_id:s.items[0]!.current_version!.id}));s=await f.plan();
  const done=await f.json<{recording:{wiki_record:string}}>(await f.call('POST','/api/v1/image-studio/confirm-final',{topic_id:f.topic.id,document_revision_id:s.studio.document_revision_id,expected_version:s.studio.version,confirmed:true}));
  const record=JSON.parse(readFileSync(done.recording.wiki_record,'utf8').replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/,'$1'));assert.deepEqual([record.slots[0].position,record.slots[0].placement_paragraph_id],['before',target]);
 }finally{await f.close();}
});
test('manual add: validates placement and needs a plan; is idempotent; only one cover',async()=>{
 const f=await startPlanFixture();try{
  assert.equal((await create(f,{position:'after',paragraph_id:null})).status,400);
  let s=await ready(f);const key=randomUUID(),v=s.version,p=s.studio.paragraphs[2]!.id;
  const a=await f.json<ImagePlanSnapshot>(await f.call('POST','/api/v1/image-studio/plan/items',{topic_id:f.topic.id,expected_version:v,position:'before',paragraph_id:p},key),201);
  const b=await f.json<ImagePlanSnapshot>(await f.call('POST','/api/v1/image-studio/plan/items',{topic_id:f.topic.id,expected_version:v,position:'before',paragraph_id:p},key),201);
  assert.equal(a.items.filter(i=>i.role==='manual').length,1);assert.equal(b.items.filter(i=>i.role==='manual').length,1,'同键重放不重复新增');
  const c=await f.json<{error:{message:string}}>(await create(f,{position:'cover',paragraph_id:null}),400);assert.match(c.error.message,/已经有一张封面/);
  await f.json(await f.call('POST','/api/v1/image-studio/plan/items',{topic_id:f.topic.id,expected_version:v,position:'after',paragraph_id:p}),409);
  s=await f.plan();const manual=s.items.find(i=>i.role==='manual')!;
  const q=await f.json<{slot_id:string}>(await generate(f,s,manual),202);assert.equal(q.slot_id,manual.slot_id,'新增项用预留槽位生成');
 }finally{await f.close();}
});
test('uploaded image becomes a new version (operation upload, purpose kept) that can be adopted and edited on; foreign assets are refused; replay is idempotent',async()=>{
 const f=await startPlanFixture({image_generation_limits:{codex:0,agy:3}});try{
  let s=await ready(f);const flow=s.items[3]!,asset=await upload(f,1200,900),key=randomUUID();
  const first=await f.json<StudioAssetVersionResult>(await assetVersion(f,s,{slot_id:flow.slot_id,asset_id:asset,purpose:'layout',name:'构图参考.png'},key),201);
  const replay=await f.json<StudioAssetVersionResult>(await assetVersion(f,s,{slot_id:flow.slot_id,asset_id:asset,purpose:'layout',name:'构图参考.png'},key),201);assert.equal(replay.version_id,first.version_id);
  s=await f.plan();const item=s.items.find(i=>i.id===flow.id)!,version=s.studio.slots.find(x=>x.id===flow.slot_id)!.versions[0]!;
  assert.equal(version.operation,'upload');assert.deepEqual(version.upload,{purpose:'layout',name:'构图参考.png'});assert.deepEqual(version.actual_size,{width:1200,height:900,aspect_ratio:'1200:900'});
  assert.equal(item.status,'filled');assert.equal(item.current_version!.id,first.version_id,'上传的一版成为当前图');
  s=await f.json(await f.update(flow.id,{current_version_id:first.version_id}));assert.equal(s.studio.slots.find(x=>x.id===flow.slot_id)!.active_version_id,first.version_id,'可以采用');
  await f.json(await generate(f,s,item,{operation:'reference_edit',parent_version_id:first.version_id,description:'在上传图上增加留白'}),202);
  s=await f.plan();await f.json(await assetVersion(f,s,{slot_id:flow.slot_id,asset_id:randomUUID()}),404);
  assert.equal((await assetVersion(f,s,{slot_id:flow.slot_id,asset_id:asset,purpose:'poster'})).status,400);
  await f.json(await assetVersion(f,s,{slot_id:flow.slot_id,asset_id:asset}),409,);
 }finally{await f.close();}
});
test('marks travel with a reference edit and are stored on the version; Codex cannot edit on the original',async()=>{
 const f=await startPlanFixture({image_generation_limits:{codex:2,agy:2}});try{
  let s=await ready(f);const article=s.items[1]!,parent=article.current_version!.id;
  const marks:StudioMark[]=[{id:1,type:'rect',x:100,y:50,w:250,h:250,ex:350,ey:300,path:'',note:'人物缩小'},{id:2,type:'text',x:500,y:200,w:0,h:0,ex:500,ey:200,path:'',note:'',text:'新标题'}];
  const description='标注1（框选，x 10–35%，y 9–53%）：人物缩小；把标注2处（x 50%，y 36%）的文字改为「新标题」；未标注区域保持不变';
  const codex=await generate(f,s,article,{operation:'reference_edit',parent_version_id:parent,description,provider:'codex',marks});assert.notEqual(codex.status,202,'Codex 不能在原图上修改');
  s=await f.plan();await f.json(await generate(f,s,s.items[1]!,{operation:'reference_edit',parent_version_id:parent,description,marks}),202);
  s=await f.plan();const v=s.studio.slots.find(x=>x.id===article.slot_id)!.versions.at(-1)!;assert.deepEqual(v.marks,marks);assert.equal(v.description,description);
  assert.equal((await generate(f,s,s.items[1]!,{operation:'reference_edit',parent_version_id:parent,description:'x',marks:[{...marks[0],type:'circle'}]})).status,400,'标注类型受契约约束');
 }finally{await f.close();}
});
test('a cancelled later version blocks further edits even when the item already has a current image: view issue matches the server refusal',async()=>{
 const f=await startPlanFixture({image_generation_limits:{codex:0,agy:3}});try{
  let s=await ready(f);const article=s.items[1]!,parent=article.current_version!.id;
  const q=await f.json<{job_id:string}>(await generate(f,s,article,{operation:'reference_edit',parent_version_id:parent,description:'改一版'}),202);
  const job=await f.json<{job:{version:number}}>(await f.call('GET','/api/v1/jobs/'+q.job_id));await f.json(await f.call('POST','/api/v1/jobs/'+q.job_id+'/cancel',{expected_version:job.job.version}));
  s=await f.plan();const item=s.items[1]!;assert.equal(item.status,'filled');assert.match(item.issue!,/还在核对/);
  assert.equal((await generate(f,s,item,{operation:'reference_edit',parent_version_id:parent,description:'再改一版'})).status,409,'服务端同样拒绝');
 }finally{await f.close();}
});
test('batch regeneration of a filled item adds a candidate version without replacing the current image',async()=>{
 const f=await startPlanFixture({image_generation_limits:{codex:0,agy:3}});try{
  let s=await ready(f);const article=s.items[1]!,current=article.current_version!.id;
  await f.json(await generate(f,s,article,{candidate_only:true}),202);await f.runOnce();s=await f.plan();
  const versions=s.studio.slots.find(x=>x.id===article.slot_id)!.versions;assert.equal(versions.length,2);assert.equal(versions[1]!.candidate_only,true);assert.equal(versions[1]!.state,'succeeded');
  assert.equal(s.items[1]!.current_version!.id,current,'候选版本不自动设为当前图');
  s=await f.json(await f.update(article.id,{current_version_id:versions[1]!.id}));assert.equal(s.items[1]!.current_version!.id,versions[1]!.id,'用户可以在版本条里选用');
 }finally{await f.close();}
});
// ——— 与 #42 配图确认/当前图即采用的衔接 ———
const confirmPlan=(f:Fixture,expected:number)=>f.call('POST','/api/v1/image-studio/plan/confirm',{topic_id:f.topic.id,expected_version:expected},randomUUID());
test('plan confirm ignores removed items (not counted as pending, not in the final) and freezes the final in the chosen placement order',async()=>{
 const f=await startPlanFixture();try{
  let s=await ready(f);const [cover,article,post,flow]=s.items;assert.equal(s.final.pending,2);
  s=await f.json(await f.update(cover!.id,{removed:true}));s=await f.json(await f.update(flow!.id,{removed:true}));assert.equal(s.final.pending,0,'已删除的从未生成项不计未完成');
  // 把帖子图挪到原文图之前（第 2 段之前），终稿按方案位置排序。
  s=await f.json(await f.update(post!.id,{placement:{position:'before',paragraph_id:s.studio.paragraphs[1]!.id}}));
  const done=await f.json<ImagePlanSnapshot>(await confirmPlan(f,s.version));assert.equal(done.final.confirmed,true);
  const {readImagePlanFinal}=await import('../../packages/storage/src/image-studio/index.ts');const record=readImagePlanFinal(f.app.context.db,f.app.identity.workspace_id,f.topic.id)!;
  assert.deepEqual(record.items.map(i=>[i.item_id,i.position,i.paragraph_id]),[[post!.id,'before',s.studio.paragraphs[1]!.id],[article!.id,'after',s.studio.paragraphs[1]!.id]]);
  assert.equal(record.items.some(i=>i.item_id===cover!.id||i.item_id===flow!.id),false);
 }finally{await f.close();}
});
test('current-is-adopted sync skips removed items and never auto-adopts a candidate_only regeneration',async()=>{
 const f=await startPlanFixture({image_generation_limits:{codex:0,agy:5}});try{
  let s=await ready(f);const article=s.items[1]!,post=s.items[2]!,adopted=s.studio.slots.find(x=>x.id===article.slot_id)!.active_version_id;assert.equal(adopted,article.current_version!.id,'#42：当前图即采用');
  // 候选：已配好的图批量重新生成，新版成功后不自动采用、也不换当前图。
  await f.json(await generate(f,s,article,{candidate_only:true}),202);await f.runOnce();s=await f.plan();
  const slot=s.studio.slots.find(x=>x.id===article.slot_id)!;assert.equal(slot.versions.length,2);assert.equal(slot.active_version_id,adopted,'候选版本不被自动采用');assert.equal(s.items[1]!.current_version!.id,adopted);
  // 已删除：删除后槽位不再接受生成与新版本（门禁 P2），采用记录保持原样。
  const postAdopted=s.studio.slots.find(x=>x.id===post.slot_id)!.active_version_id;s=await f.json(await f.update(post.id,{removed:true}));
  assert.equal((await generate(f,s,{...post,prompt_draft:'删除后的一版'} as never)).status,404,'已删除项的槽位拒绝入队');
  const extra=await upload(f);assert.equal((await assetVersion(f,s,{slot_id:post.slot_id,asset_id:extra})).status,404,'已删除项的槽位拒绝新版本');
  s=await f.plan();const postSlot=s.studio.slots.find(x=>x.id===post.slot_id)!;assert.equal(postSlot.versions.length,1);assert.equal(postSlot.active_version_id,postAdopted);
 }finally{await f.close();}
});

// ——— 第 1 轮门禁修复 ———
test('recovering a deleted web image into another item keeps its source; the confirmed final carries the credit',async()=>{
 const f=await startPlanFixture({image_generation_limits:{codex:0,agy:3}});try{
  let s=await ready(f);const [cover,article,post,flow]=s.items;const webVersion=s.studio.slots.find(x=>x.id===post!.slot_id)!.versions[0]!;assert.ok(webVersion.source);
  s=await f.json(await f.update(post!.id,{removed:true}));
  const r=await f.json<StudioAssetVersionResult>(await assetVersion(f,s,{slot_id:flow!.slot_id,asset_id:webVersion.asset_id,name:'找回：帖子图',recover_version_id:webVersion.id}),201);
  s=await f.plan();const v=s.studio.slots.find(x=>x.id===flow!.slot_id)!.versions.find(x=>x.id===r.version_id)!;assert.equal(v.recovered_from,webVersion.id);assert.deepEqual(v.source,webVersion.source);
  assert.equal(s.items.find(i=>i.id===flow!.id)!.current_version!.credit_label,webVersion.source!.credit_label);
  await f.json(await f.update(cover!.id,{removed:true}));s=await f.plan();
  const done=await f.json<ImagePlanSnapshot>(await f.call('POST','/api/v1/image-studio/plan/confirm',{topic_id:f.topic.id,expected_version:s.version},randomUUID()));assert.equal(done.final.confirmed,true);
  const {readImagePlanFinal}=await import('../../packages/storage/src/image-studio/index.ts');const record=readImagePlanFinal(f.app.context.db,f.app.identity.workspace_id,f.topic.id)!;
  assert.equal(record.items.find(i=>i.item_id===flow!.id)!.credit_label,webVersion.source!.credit_label,'找回的网络图终稿带图源');void article;
  assert.equal((await assetVersion(f,await f.plan(),{slot_id:flow!.slot_id,asset_id:webVersion.asset_id,recover_version_id:randomUUID()})).status,404);
 }finally{await f.close();}
});
test('a candidate regeneration finishing after the current image was cleared does not become current',async()=>{
 const f=await startPlanFixture({image_generation_limits:{codex:0,agy:3}});try{
  let s=await ready(f);const article=s.items[1]!;
  await f.json(await generate(f,s,article,{candidate_only:true}),202);s=await f.json(await f.update(article.id,{current_version_id:null}));
  await f.runOnce();s=await f.plan();const it=s.items[1]!;assert.equal(it.current_version,null,'候选不自动填补已清除的当前图');assert.equal(s.studio.slots.find(x=>x.id===article.slot_id)!.versions.length,2);
 }finally{await f.close();}
});
test('uploads are checked server-side by real file signature and the 15MB limit',async()=>{
 const f=await startPlanFixture();try{
  let s=await ready(f);const flow=s.items[3]!;const {writeFileSync}=await import('node:fs');const {join,dirname}=await import('node:path');const {createHash}=await import('node:crypto');
  const swap=(asset:string,bytes:Buffer)=>{const row=f.app.context.db.prepare('SELECT file_path FROM assets WHERE id=?').get(asset) as {file_path:string};const rel=join(dirname(row.file_path),'swap-'+randomUUID()+'.png');writeFileSync(rel,bytes);f.app.context.db.prepare('UPDATE assets SET file_path=?,sha256=?,size_bytes=? WHERE id=?').run(rel,createHash('sha256').update(bytes).digest('hex'),bytes.length,asset);};
  const gif=await upload(f);swap(gif,Buffer.concat([Buffer.from('GIF89a'),Buffer.alloc(64)]));
  const bad=await f.json<{error:{message:string}}>(await assetVersion(f,s,{slot_id:flow.slot_id,asset_id:gif}),400);assert.match(bad.error.message,/不是 PNG、JPG 或 WebP/);
  const big=await upload(f);swap(big,Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(15*1024*1024+16)]));
  s=await f.plan();const huge=await f.json<{error:{message:string}}>(await assetVersion(f,s,{slot_id:flow.slot_id,asset_id:big}),400);assert.match(huge.error.message,/超过 15MB/);
 }finally{await f.close();}
});
test('marks are checked against the real image ratio: a tall image accepts marks near its bottom, marks outside are refused',async()=>{
 const f=await startPlanFixture({image_generation_limits:{codex:0,agy:5}});try{
  let s=await ready(f);const flow=s.items[3]!,tall=await upload(f,320,3200);
  const v=await f.json<StudioAssetVersionResult>(await assetVersion(f,s,{slot_id:flow.slot_id,asset_id:tall}),201);s=await f.plan();const item=s.items[3]!;
  const mark=(y:number)=>[{id:1,type:'rect',x:100,y,w:200,h:200,ex:300,ey:y+200,path:'',note:'这里'}];
  assert.equal((await generate(f,s,item,{operation:'reference_edit',parent_version_id:v.version_id,description:'改底部',marks:mark(9500)})).status,202,'10:1 长图（viewBox 高 10000）底部标注可用');
  s=await f.plan();await f.runOnce();s=await f.plan();
  const out=await f.json<{error:{message:string}}>(await generate(f,s,s.items[3]!,{operation:'reference_edit',parent_version_id:v.version_id,description:'图外',marks:mark(12000)}),400);assert.match(out.error.message,/超出了图片范围/);
  const brush=(path:string)=>[{id:1,type:'brush',x:100,y:100,w:0,h:0,ex:0,ey:0,path,note:''}];
  assert.match((await f.json<{error:{message:string}}>(await generate(f,s,s.items[3]!,{operation:'reference_edit',parent_version_id:v.version_id,description:'涂抹越界',marks:brush('M100 100 L200000 100')}),400)).error.message,/超出了图片范围/,'涂抹路径逐点核对');
  assert.equal((await generate(f,s,s.items[3]!,{operation:'reference_edit',parent_version_id:v.version_id,description:'涂抹格式',marks:brush('M100 100 L200')})).status,400,'坐标不成对拒绝');
 }finally{await f.close();}
});
