// 公众号排版 C2 接入：版式改动随排版版本保存并可回退；确认排版由服务端重跑 15 条检查（有阻断项拒绝）；确认冻结为排版终稿，刷新后保持，之后修改让确认失效；
// 客户端不能伪造确认或改图源；不回写平台稿。
import test from '../helpers/media-tools.ts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {ArticleLayoutSaveResult,ArticleLayoutView,ArticleLayoutSnapshot,ArticleImageBlock,ArticleTextBlock} from '../../packages/contracts/src/index.ts';
import {editArticleText,updateArticleStyle,restoreArticleLayout,restoreArticleContent,runLayoutChecks,removeCaptionCredit,splitCaption,editCaptionMain,articleConfirmationIsCurrent,articleConfirmationRulesOutdated,createArticleLayout,replaceArticleImages,confirmArticleLayout} from '../../packages/domain/src/article-layout/index.ts';
import {SqliteArticleLayoutRepository} from '../../packages/storage/src/article-layout/index.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import {startPlanFixture} from '../image-studio/plan-fixture.ts';
type Fixture=Awaited<ReturnType<typeof startPlanFixture>>;
const images=(s:ArticleLayoutSnapshot)=>s.order.map(id=>s.blocks.find(b=>b.id===id)!).filter((b):b is ArticleImageBlock=>b.kind==='image');
async function confirmedPlan(f:Fixture){
 await f.json(await f.run({replan:false}));await f.complete();let s=await f.plan();const cover=s.items[0]!;
 await f.json(await f.call('POST','/api/v1/image-studio/generations',{topic_id:f.topic.id,document_revision_id:s.studio.document_revision_id,paragraph_id:cover.paragraph_id,placement_paragraph_id:cover.placement_paragraph_id,description:cover.prompt_draft,title:cover.purpose,position:cover.position,provider:'agy',references:[],expected_version:s.studio.version,slot_id:cover.slot_id,parent_version_id:null,operation:'generate',size_mode:'manual',size:{width:1600,height:900,aspect_ratio:'16:9'},brief_id:null}),202);
 await f.runOnce();s=await f.json(await f.update(s.items[3]!.id,{skipped:true}));s=await f.json(await f.call('POST','/api/v1/image-studio/plan/confirm',{topic_id:f.topic.id,expected_version:s.version},randomUUID()));return s;
}
const open=(f:Fixture)=>f.call('POST','/api/v1/article-layout',{topic_id:f.topic.id},randomUUID()).then(r=>f.json<ArticleLayoutView>(r));
const read=(f:Fixture)=>f.call('GET','/api/v1/article-layout?topic_id='+f.topic.id).then(r=>f.json<ArticleLayoutView>(r));
const save=(f:Fixture,expected:number,snapshot:ArticleLayoutSnapshot,key=randomUUID())=>f.call('POST','/api/v1/article-layout/saves',{topic_id:f.topic.id,expected_version:expected,snapshot},key).then(r=>f.json<ArticleLayoutSaveResult>(r));
const confirm=(f:Fixture,expected:number,key=randomUUID())=>f.call('POST','/api/v1/article-layout/confirmations',{topic_id:f.topic.id,expected_version:expected},key);
const saved=(r:ArticleLayoutSaveResult)=>{assert.equal(r.state,'saved');return (r as {snapshot:ArticleLayoutSnapshot}).snapshot;};

test('style changes are saved as layout versions and roll back; blocking checks refuse confirmation on the server; confirming freezes the final and survives a reload',async()=>{
 const f=await startPlanFixture();try{
  await confirmedPlan(f);const documents=new Documents(f.app.context),before=await documents.get(f.request(),f.document_id);
  let s=(await open(f)).snapshot;const initialLayout=s.layout_revision_id;
  // 版式：正文 17px、行距 2.0、主题色暖橙 → 保存为新的排版版本；文字不变。
  s=saved(await save(f,s.version,updateArticleStyle(s,{body_size:17,body_line_height:2,accent_color:'#ffd59a',page_padding:20})));
  let view=await read(f);assert.equal(view.snapshot.style.body_size,17);assert.equal(view.snapshot.style.accent_color,'#ffd59a');assert.equal(view.snapshot.content_revision_id,s.content_revision_id);
  assert.equal(view.snapshot.layout_history.at(-1)!.reason,'style','版式改动记为排版版本');
  // 正文颜色改成浅灰 → 阻断；服务端拒绝确认，给用户语言，不露内部码。
  s=saved(await save(f,s.version,updateArticleStyle(s,{text_color:'#a0a6bd'})));assert.equal(runLayoutChecks(s,{topic_title:f.topic.title}).blocking,1);
  const refused=await f.json<{error:{code:string;message:string}}>(await confirm(f,s.version),400);assert.equal(refused.error.code,'VALIDATION_ERROR');assert.match(refused.error.message,/还有 1 项阻断：文字颜色对比度/);assert.doesNotMatch(refused.error.message,/ARTICLE_LAYOUT_|text_contrast/);
  assert.equal((await read(f)).snapshot.confirmation,null,'有阻断项时不生成确认');
  // 回退到进入排版时的版式：正文字号、颜色回到标准。
  s=saved(await save(f,s.version,restoreArticleLayout(s,initialLayout)));assert.equal(s.style.body_size,15);assert.equal(s.style.text_color,'#0b1f52');assert.equal(s.style.accent_color,'#ccf866');
  // 排版里改过文字（平台稿修订为空）也能确认：确认的是排版自己的块版本。
  const p=s.blocks.find((b):b is ArticleTextBlock=>b.kind==='paragraph'&&b.text.length>40)!;s=saved(await save(f,s.version,editArticleText(s,p.id,p.text+'（排版时补的一句）')));assert.equal(s.document_revision_id,null);
  // 旧版本号确认 → 冲突，不确认。
  await f.json(await confirm(f,s.version-1),409);
  const key=randomUUID(),ok=await f.json<ArticleLayoutView>(await confirm(f,s.version,key));const c=ok.snapshot.confirmation!;assert.ok(c,'生成确认');
  assert.equal(c.binding.content_revision_id,s.content_revision_id);assert.equal(c.binding.layout_revision_id,s.layout_revision_id);assert.equal(ok.snapshot.version,s.version+1);assert.equal(articleConfirmationIsCurrent(ok.snapshot),true);
  const replay=await f.json<ArticleLayoutView>(await confirm(f,s.version,key));assert.equal(replay.snapshot.confirmation!.id,c.id,'同键重放返回原确认');assert.equal(replay.snapshot.version,ok.snapshot.version);
  // 刷新（重新读取）后确认状态保持；再确认一次不重复写。
  view=await read(f);assert.equal(view.snapshot.confirmation!.id,c.id);const again=await f.json<ArticleLayoutView>(await confirm(f,view.snapshot.version));assert.equal(again.snapshot.version,view.snapshot.version,'已确认的当前版本不重复确认');
  // 平台稿没被改。
  const after=await documents.get(f.request(),f.document_id);assert.equal(after.head_revision_id,before.head_revision_id);assert.equal(after.text,before.text);
  // 确认之后再改：确认失效。
  s=view.snapshot;const changed=saved(await save(f,s.version,updateArticleStyle(s,{body_size:16})));assert.equal(changed.confirmation,null);assert.equal((await read(f)).snapshot.confirmation,null);
 }finally{await f.close();}
});
test('a client cannot forge the confirmation or rewrite an image credit through a save; removing the credit from the caption is a normal caption edit',async()=>{
 const f=await startPlanFixture();try{
  await confirmedPlan(f);let s=(await open(f)).snapshot;const web=images(s).find(i=>i.image.credit)!;assert.ok(web,'有网络图');assert.equal(splitCaption(web).has_credit,true);
  const forged=structuredClone(s);forged.confirmation={id:'x',actor:'me',human_decision_ref:'x',confirmed_at:new Date().toISOString(),binding:{article_id:s.article_id,content_revision_id:s.content_revision_id,layout_revision_id:s.layout_revision_id,text_hash:s.text_hash,images_hash:s.images_hash,standard_version:s.standard.version,standard_png_sha256:s.standard.png_sha256,standard_html_sha256:s.standard.html_sha256}};
  await f.json(await f.call('POST','/api/v1/article-layout/saves',{topic_id:f.topic.id,expected_version:s.version,snapshot:forged},randomUUID()),400);
  const credit=structuredClone(s);(credit.blocks.find(b=>b.id===web.id) as ArticleImageBlock).image.credit={label:'图源：别处',url:null};
  await f.json(await f.call('POST','/api/v1/article-layout/saves',{topic_id:f.topic.id,expected_version:s.version,snapshot:credit},randomUUID()),400);
  s=saved(await save(f,s.version,editArticleText(s,web.id,removeCaptionCredit(web))));const after=s.blocks.find(b=>b.id===web.id) as ArticleImageBlock;
  assert.equal(splitCaption(after).has_credit,false);assert.deepEqual(after.image.credit,web.image.credit,'图源事实仍在，可以加回来');
  assert.equal(runLayoutChecks(s,{topic_title:f.topic.title}).results.find(r=>r.id==='image_credit')!.level,'warn');
 }finally{await f.close();}
});
test('the server clears a confirmation that a changed save tries to keep; restoring the confirmed versions afterwards does not revive it',async()=>{
 const f=await startPlanFixture();try{
  await confirmedPlan(f);let s=(await open(f)).snapshot;let view=await f.json<ArticleLayoutView>(await confirm(f,s.version));s=view.snapshot;const confirmed=s.confirmation!,contentId=s.content_revision_id,layoutId=s.layout_revision_id;
  // 客户端改了版式却原样带着旧确认提交 → 服务端清掉。
  const sneaky=updateArticleStyle(s,{body_size:16});sneaky.confirmation=structuredClone(confirmed);
  s=saved(await save(f,s.version,sneaky));assert.equal(s.confirmation,null,'改动后确认被服务端清空');assert.equal((await read(f)).snapshot.confirmation,null);
  // 再确认 → 修改 → 回到确认时的文字与排版版本：仍是未确认。
  view=await f.json<ArticleLayoutView>(await confirm(f,s.version));s=view.snapshot;const second=s.confirmation!;assert.ok(second);
  const p=s.blocks.find((b):b is ArticleTextBlock=>b.kind==='paragraph'&&b.text.length>40)!;s=saved(await save(f,s.version,editArticleText(updateArticleStyle(s,{paragraph_gap:28}),p.id,p.text+'改')));
  let back=restoreArticleLayout(s,second.binding.layout_revision_id);back=restoreArticleContent(back,second.binding.content_revision_id);back.confirmation=structuredClone(second);
  s=saved(await save(f,s.version,back));assert.equal(s.confirmation,null,'回退不复活旧确认');assert.equal(articleConfirmationIsCurrent(s),false);
  assert.equal(s.style.paragraph_gap,20);assert.equal(s.blocks.find(b=>b.id===p.id&&'text' in b&&b.text===p.text)!==undefined,true,'内容确实回到了确认时');
  assert.notEqual(s.layout_revision_id,layoutId);assert.notEqual(s.content_revision_id,contentId);
 }finally{await f.close();}
});
test('a C1 record without credit facts gets them backfilled from the image final on read (once, as a layout version); unknown images warn to re-sync; legacy credit text survives caption edits',async()=>{
 const f=await startPlanFixture();try{
  await confirmedPlan(f);const documents=new Documents(f.app.context),before=await documents.get(f.request(),f.document_id);const s=(await open(f)).snapshot;
  const repo=new SqliteArticleLayoutRepository(f.app.context.db),ws=f.app.identity.workspace_id,record=(await repo.read(ws,s.article_id))!;
  // 造一份 C1 旧记录：图片没有 credit，网络图图注是「说明 · 图源：来源名」；封面的图片版本与终稿对不上（找不到来源）。
  const imgs=images(s),cover=imgs[0]!,web=imgs.find(i=>i.image.credit?.url)!;
  let legacy=createArticleLayout({article_id:s.article_id,document_id:s.document_id,document_revision_id:record.source!.document_revision_id,text:s.original_text});
  legacy=replaceArticleImages(legacy,imgs.map(i=>{const at=s.order.indexOf(i.id),prev=s.order.slice(0,at).reverse().find(id=>!imgs.some(x=>x.id===id));const {credit,...image}=i.image;
   return{id:i.id,image:{...image,...(i.id===cover.id?{version_id:'v-old'}:{})},caption:credit?i.caption.replace(/（[^（]*）$/,''):i.caption,anchor_block_id:prev??null,position:prev?'after' as const:'before' as const};}));legacy.version=1;
  f.app.context.db.prepare('DELETE FROM application_metadata WHERE key=?').run('article-layout.v1:'+ws+':'+s.article_id);assert.equal(await repo.create(ws,{snapshot:legacy,pending:null,operations:{},conflicts:[],source:record.source}),true);
  const oldWeb=legacy.blocks.find(b=>b.id===web.id) as ArticleImageBlock;assert.equal(oldWeb.caption,'官方配图：发布会现场与关键参数对比 · 图源：Example News');
  const parts=splitCaption(oldWeb);assert.equal(parts.has_credit,true);assert.equal(parts.legacy,true);assert.equal(editCaptionMain(oldWeb,''),'图源：Example News','补齐前编辑说明也不会丢来源文字');
  const view=await read(f),after=view.snapshot,filled=after.blocks.find(b=>b.id===web.id) as ArticleImageBlock;
  assert.deepEqual(filled.image.credit,{label:'图源：Example News',url:'https://news.example/a'});assert.equal(filled.caption,'官方配图：发布会现场与关键参数对比 · 图源：Example News（news.example）');
  assert.equal(after.version,2,'补齐写成排版自己的一个新版本');assert.equal(after.layout_history.at(-1)!.reason,'image_credit');
  assert.deepEqual(view.images.credit_missing,[cover.id],'终稿里找不到来源的图单独列出');assert.equal((after.blocks.find(b=>b.id===cover.id) as ArticleImageBlock).image.credit,undefined);
  assert.equal((await read(f)).snapshot.version,2,'再次读取不重复补');
  const rule=runLayoutChecks(after,{topic_title:f.topic.title,credit_missing:view.images.credit_missing}).results.find(r=>r.id==='image_credit')!;assert.equal(rule.level,'warn');assert.match(rule.summary,/重新同步配图/);assert.equal(rule.hits[0]!.block_id,cover.id);
  const doc=await documents.get(f.request(),f.document_id);assert.equal(doc.head_revision_id,before.head_revision_id,'不回写平台稿');
 }finally{await f.close();}
});
/** 造一份 C1 旧记录（图片没有 credit，网络图图注只有「图源：来源名」），可选地带上确认。 */
async function legacyRecord(f:Fixture,options:{confirmed?:boolean}={}){
 const s=(await open(f)).snapshot,repo=new SqliteArticleLayoutRepository(f.app.context.db),ws=f.app.identity.workspace_id,record=(await repo.read(ws,s.article_id))!,imgs=images(s);
 let legacy=createArticleLayout({article_id:s.article_id,document_id:s.document_id,document_revision_id:record.source!.document_revision_id,text:s.original_text});
 legacy=replaceArticleImages(legacy,imgs.map(i=>{const at=s.order.indexOf(i.id),prev=s.order.slice(0,at).reverse().find(id=>!imgs.some(x=>x.id===id));const {credit,...image}=i.image;
  return{id:i.id,image,caption:credit?i.caption.replace(/（[^（]*）$/,''):i.caption,anchor_block_id:prev??null,position:prev?'after' as const:'before' as const};}));legacy.version=1;
 if(options.confirmed)legacy=confirmArticleLayout(legacy,{actor:'workspace-owner',human_decision_ref:'c1-era',layout_only:true});
 f.app.context.db.prepare('DELETE FROM application_metadata WHERE key=?').run('article-layout.v1:'+ws+':'+s.article_id);assert.equal(await repo.create(ws,{snapshot:legacy,pending:null,operations:{},conflicts:[],source:record.source}),true);
 return{legacy,web:imgs.filter(i=>i.image.credit).map(i=>i.id)};
}
test('a confirmed C1 record is not rewritten on read: confirmation and version stay; the check asks to re-sync to complete the credit',async()=>{
 const f=await startPlanFixture();try{
  await confirmedPlan(f);const {legacy,web}=await legacyRecord(f,{confirmed:true});assert.ok(legacy.confirmation);
  const first=await read(f),second=await read(f);
  for(const v of [first,second]){assert.equal(v.snapshot.version,1,'读取不写新版本');assert.deepEqual(v.snapshot.confirmation,legacy.confirmation,'确认不变');assert.deepEqual(v.images.credit_pending.sort(),[...web].sort());}
  assert.ok(images(second.snapshot).every(i=>!i.image.credit),'没有自动补图源');
  const rule=runLayoutChecks(second.snapshot,{topic_title:f.topic.title,credit_missing:second.images.credit_missing,credit_pending:second.images.credit_pending}).results.find(r=>r.id==='image_credit')!;
  assert.equal(rule.level,'warn');assert.match(rule.summary,/重新同步配图可补全图源/);assert.deepEqual(rule.hits.map(h=>h.block_id).sort(),[...web].sort());
 }finally{await f.close();}
});
test('staggered and concurrent reads of a C1 record all succeed and backfill the credit exactly once',async()=>{
 const f=await startPlanFixture();try{
  await confirmedPlan(f);await legacyRecord(f);
  const get=()=>f.call('GET','/api/v1/article-layout?topic_id='+f.topic.id);
  const a=get(),b=new Promise<Response>(done=>setTimeout(()=>done(get()),1)),c=get();
  const views=await Promise.all([a,b,c].map(async r=>f.json<ArticleLayoutView>(await r,200)));
  const final=await read(f);assert.equal(final.snapshot.version,2,'只补写一次');assert.equal(final.snapshot.events.filter(e=>e.kind==='image_credit').length,1);assert.equal(final.snapshot.layout_history.filter(r=>r.reason==='image_credit').length,1);
  assert.ok(views.every(v=>v.snapshot.version===1||v.snapshot.version===2),'每次读取都返回一份完整快照');
  const record=await new SqliteArticleLayoutRepository(f.app.context.db).read(f.app.identity.workspace_id,final.snapshot.article_id);assert.equal(record!.pending,null,'没有遗留待提交项');
  assert.ok(images(final.snapshot).some(i=>i.image.credit?.url==='https://news.example/a'));
 }finally{await f.close();}
});

test('a confirmation made before the current layout rules is not current on read (record untouched); confirming again through the service makes it current',async()=>{
 const f=await startPlanFixture();try{
  await confirmedPlan(f);let s=(await open(f)).snapshot;s=(await f.json<ArticleLayoutView>(await confirm(f,s.version))).snapshot;assert.equal(articleConfirmationIsCurrent(s),true);
  // 把已存确认改成规则版本之前的样子（C2 早期没有 rules_version），其余不动。
  const repo=new SqliteArticleLayoutRepository(f.app.context.db),ws=f.app.identity.workspace_id,record=(await repo.read(ws,s.article_id))!;
  const {rules_version:_v,...binding}=record.snapshot.confirmation!.binding,old={...record.snapshot,confirmation:{...record.snapshot.confirmation!,binding}};
  f.app.context.db.prepare('DELETE FROM application_metadata WHERE key=?').run('article-layout.v1:'+ws+':'+s.article_id);assert.equal(await repo.create(ws,{...record,snapshot:old}),true);
  const before=await read(f);assert.equal(before.snapshot.version,old.version,'读取不改写记录');assert.deepEqual(before.snapshot.confirmation,old.confirmation);
  assert.equal(articleConfirmationIsCurrent(before.snapshot),false,'规则更新后旧确认不是当前终稿');assert.equal(articleConfirmationRulesOutdated(before.snapshot),true);
  const again=(await f.json<ArticleLayoutView>(await confirm(f,before.snapshot.version))).snapshot;assert.equal(articleConfirmationIsCurrent(again),true,'重新确认后是当前终稿');assert.equal(articleConfirmationRulesOutdated(again),false);
 }finally{await f.close();}
});
