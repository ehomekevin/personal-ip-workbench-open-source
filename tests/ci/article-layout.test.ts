// 公众号排版（C1）接入：配图终稿 → 图文块（顺序、图注与图源）；保存只写排版块版本、刷新保留、平台稿修订不变；回退；配图改后重新同步保留文字编辑。
import nodeTest from 'node:test';
import test from '../helpers/media-tools.ts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {ArticleLayoutSaveResult,ArticleLayoutView,ArticleLayoutSnapshot,ArticleImageBlock,ArticleTextBlock,ImagePlanSnapshot,StudioWebImageCandidate,StudioWebImportResult} from '../../packages/contracts/src/index.ts';
import {editArticleText,reorderArticleBlocks,updateArticleImageWidth,restoreArticleContent,parseArticleText,createArticleLayout} from '../../packages/domain/src/article-layout/index.ts';
import {mapParagraphBlocks,layoutCaption} from '../../packages/domain/src/article-layout/plan-final-source.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import {readImagePlanFinal} from '../../packages/storage/src/image-studio/index.ts';
import {startPlanFixture} from '../image-studio/plan-fixture.ts';
type Fixture=Awaited<ReturnType<typeof startPlanFixture>>;
const images=(s:ArticleLayoutSnapshot)=>s.order.map(id=>s.blocks.find(b=>b.id===id)!).filter((b):b is ArticleImageBlock=>b.kind==='image');
const texts=(s:ArticleLayoutSnapshot)=>s.blocks.filter((b):b is ArticleTextBlock=>'text' in b);
// 方案就绪 → 生成封面 → 跳过流程图 → 确认配图。
async function confirmed(f:Fixture){
 await f.json(await f.run({replan:false}));await f.complete();let s=await f.plan();const cover=s.items[0]!;
 await f.json(await f.call('POST','/api/v1/image-studio/generations',{topic_id:f.topic.id,document_revision_id:s.studio.document_revision_id,paragraph_id:cover.paragraph_id,placement_paragraph_id:cover.placement_paragraph_id,description:cover.prompt_draft,title:cover.purpose,position:cover.position,provider:'agy',references:[],expected_version:s.studio.version,slot_id:cover.slot_id,parent_version_id:null,operation:'generate',size_mode:'manual',size:{width:1600,height:900,aspect_ratio:'16:9'},brief_id:null}),202);
 await f.runOnce();s=await f.json(await f.update(s.items[3]!.id,{skipped:true}));s=await f.json(await f.call('POST','/api/v1/image-studio/plan/confirm',{topic_id:f.topic.id,expected_version:s.version},randomUUID()));assert.equal(s.final.current,true);return s;
}
const open=(f:Fixture,key=randomUUID())=>f.call('POST','/api/v1/article-layout',{topic_id:f.topic.id},key);
const read=(f:Fixture)=>f.call('GET','/api/v1/article-layout?topic_id='+f.topic.id).then(r=>f.json<ArticleLayoutView>(r));
const save=(f:Fixture,expected:number,snapshot:ArticleLayoutSnapshot,key=randomUUID())=>f.call('POST','/api/v1/article-layout/saves',{topic_id:f.topic.id,expected_version:expected,snapshot},key).then(r=>f.json<ArticleLayoutSaveResult>(r));
nodeTest('paragraph → block mapping follows paragraph order through headings, quotes and multi-line paragraphs; credit is appended once',()=>{
 const text='# 标题\n\n> 导读一句\n\n## 小节\n小节下紧跟的正文\n\n普通段落\n\n\n最后一段';
 const snapshot=createArticleLayout({article_id:'a',document_id:'d',document_revision_id:'r',text});
 const paragraphs=text.split(/\n\s*\n/).map(t=>t.trim()).filter(Boolean).map((t,i)=>({id:'p'+i,text:t}));
 const map=mapParagraphBlocks(text,paragraphs,snapshot),kind=(id:string)=>snapshot.blocks.find(b=>b.id===id)!;
 assert.deepEqual(Object.keys(map),['p0','p1','p2','p3','p4']);assert.equal(kind(map.p0!.first).kind,'title');assert.equal(kind(map.p1!.first).kind,'lead');
 assert.equal(kind(map.p2!.first).kind,'heading');assert.equal((kind(map.p2!.last) as ArticleTextBlock).text,'小节下紧跟的正文','一段被拆成标题+正文时首尾指向不同块');
 assert.equal((kind(map.p4!.last) as ArticleTextBlock).text,'最后一段');assert.equal(parseArticleText(text,'a').length>0,true);
 assert.equal(layoutCaption('官方配图','图源：Example News'),'官方配图 · 图源：Example News');assert.equal(layoutCaption('官方配图','Example'),'官方配图 · 图源：Example');assert.equal(layoutCaption('封面',null),'封面');
});
test('layout needs a confirmed final; initialization follows the plan order with captions and credits; opening again is idempotent',async()=>{
 const f=await startPlanFixture();try{
  await f.json(await f.run({replan:false}));await f.complete();
  const refused=await f.json<{error:{message:string}}>(await open(f),400);assert.match(refused.error.message,/先在配图里确认/);await f.json(await f.call('GET','/api/v1/article-layout?topic_id='+f.topic.id),404);
  await f.close();
 }catch(e){await f.close();throw e;}
 const g=await startPlanFixture();try{
  const plan=await confirmed(g),final=readImagePlanFinal(g.app.context.db,g.app.identity.workspace_id,g.topic.id)!;
  const view=await g.json<ArticleLayoutView>(await open(g));assert.equal(view.images.state,'synced');assert.equal(view.images.count,3);assert.equal(view.snapshot.version,1);
  const s=view.snapshot,imgs=images(s);assert.deepEqual(imgs.map(i=>i.image.version_id),final.items.map(i=>i.version_id),'图片按方案顺序');
  const [cover,article,post]=plan.items;
  assert.equal(imgs[0]!.caption,cover!.purpose,'AI 生图只用方案图注');assert.equal(imgs[1]!.caption,article!.purpose+' · 图源：Example News（news.example）','网络图图注带来源名与原网页链接（C2）');assert.deepEqual(imgs[1]!.image.credit,{label:'图源：Example News',url:'https://news.example/a'});assert.equal(imgs[0]!.image.credit,undefined,'AI 生图没有图源');assert.match(imgs[2]!.caption,/^同题抖音作品的封面：一句话总结影响 · 图源：抖音/);
  assert.equal(s.order[0],imgs[0]!.id,'没有文章标题时封面放最前');
  // 原文图放在第 2 段之后、帖子图放在第 3 段之后。
  const para=(i:number)=>texts(s).find(b=>b.text===plan.studio.paragraphs[i]!.text)!.id;
  assert.equal(s.order[s.order.indexOf(para(1))+1],imgs[1]!.id);assert.equal(s.order[s.order.indexOf(para(2))+1],imgs[2]!.id);
  for(const i of imgs){assert.equal(i.display_width_percent,100);assert.match(i.image.url,/^\/api\/v1\/assets\/[^/]+\/content$/);assert.equal(i.image.source_sha256,final.id);}
  const again=await g.json<ArticleLayoutView>(await open(g));assert.equal(again.snapshot.version,1);assert.equal(again.snapshot.layout_revision_id,s.layout_revision_id,'再次进入不重建');
 }finally{await g.close();}
});
test('saving edits only writes layout block versions: text, move and width survive a reload; the platform draft revision is unchanged; replay, conflict and rollback',async()=>{
 const f=await startPlanFixture();try{
  await confirmed(f);const documents=new Documents(f.app.context),before=await documents.get(f.request(),f.document_id);
  let s=(await f.json<ArticleLayoutView>(await open(f))).snapshot;const target=texts(s).find(b=>b.kind==='paragraph'&&b.text.length>40)!,image=images(s)[1]!;
  let next=editArticleText(s,target.id,target.text+'（排版时补的一句）');next=updateArticleImageWidth(next,image.id,75);const at=next.order.indexOf(image.id);next=reorderArticleBlocks(next,[...next.order.slice(0,at-1),image.id,next.order[at-1]!,...next.order.slice(at+1)]);
  const key=randomUUID(),saved=await save(f,s.version,next,key);assert.equal(saved.state,'saved');if(saved.state!=='saved')return;assert.equal(saved.snapshot.version,2);
  const replay=await save(f,s.version,next,key);assert.equal(replay.state,'saved');assert.equal((replay as {snapshot:ArticleLayoutSnapshot}).snapshot.version,2,'同键重放不再写入');
  const stale=await save(f,s.version,editArticleText(s,target.id,'另一处的旧改动'));assert.equal(stale.state,'conflict','版本冲突返回双方内容，不覆盖');
  const reloaded=(await read(f)).snapshot;assert.equal(texts(reloaded).find(b=>b.id===target.id)!.text,target.text+'（排版时补的一句）');assert.equal(images(reloaded).find(b=>b.id===image.id)!.display_width_percent,75);assert.equal(reloaded.order.indexOf(image.id),at-1,'上移保留');
  const after=await documents.get(f.request(),f.document_id);assert.equal(after.head_revision_id,before.head_revision_id,'平台稿修订不变');assert.equal(after.text,before.text);
  // 回退文字到进入排版时的版本。
  s=reloaded;const initial=s.content_history.find(r=>r.reason==='image_adoption')!;const restored=await save(f,s.version,restoreArticleContent(s,initial.id));assert.equal(restored.state,'saved');
  assert.equal(texts((await read(f)).snapshot).find(b=>b.id===target.id)!.text,target.text,'回退后文字回到原文');
  // 编辑请求不能改图片事实。
  s=(await read(f)).snapshot;const forged=structuredClone(s);(forged.blocks.find(b=>b.id===image.id) as ArticleImageBlock).image.asset_id='forged';
  const body=await f.json<{error:{code:string;message:string}}>(await f.call('POST','/api/v1/article-layout/saves',{topic_id:f.topic.id,expected_version:s.version,snapshot:forged},randomUUID()),400);assert.equal(body.error.code,'VALIDATION_ERROR');assert.doesNotMatch(body.error.message,/ARTICLE_LAYOUT_/,'错误给用户语言');
 }finally{await f.close();}
});
test('back to images → change one → layout reports plan changed; re-confirm → final updated; re-sync rebuilds image blocks and keeps text edits',async()=>{
 const f=await startPlanFixture();try{
  await confirmed(f);let s=(await f.json<ArticleLayoutView>(await open(f))).snapshot;const target=texts(s).find(b=>b.kind==='paragraph'&&b.text.length>40)!;
  // 文字改一段、原文图宽度改 75% 并上移一块：同步后都保留。
  const articleImage=images(s)[1]!;let edited=updateArticleImageWidth(editArticleText(s,target.id,'排版里改过的这段。'),articleImage.id,75);const at=edited.order.indexOf(articleImage.id);edited=reorderArticleBlocks(edited,[...edited.order.slice(0,at-1),articleImage.id,edited.order[at-1]!,...edited.order.slice(at+1)]);
  const saved=await save(f,s.version,edited);assert.equal(saved.state,'saved');const movedOrder=(saved as {snapshot:ArticleLayoutSnapshot}).snapshot.order;
  // 回到配图换一张原文图。
  let plan=await f.plan();const article=plan.items[1]!;
  const candidates=(await f.json<{candidates:StudioWebImageCandidate[]}>(await f.call('GET','/api/v1/topics/'+f.topic.id+'/web-image-candidates'))).candidates,other=candidates.find(c=>c.image_url.endsWith('/tw.png'))!;
  const swapped=await f.json<StudioWebImportResult>(await f.call('POST','/api/v1/image-studio/web-imports',{topic_id:f.topic.id,expected_version:plan.studio.version,slot_id:article.slot_id,candidate:{candidate_id:other.candidate_id,image_url:other.image_url}}),201);
  assert.equal((await read(f)).images.state,'plan_changed','配图改过但还没重新确认');
  plan=await f.plan();await f.json<ImagePlanSnapshot>(await f.call('POST','/api/v1/image-studio/plan/confirm',{topic_id:f.topic.id,expected_version:plan.version},randomUUID()));
  let view=await read(f);assert.equal(view.images.state,'final_updated');s=view.snapshot;
  const key=randomUUID();view=await f.json<ArticleLayoutView>(await f.call('POST','/api/v1/article-layout/image-syncs',{topic_id:f.topic.id,expected_version:s.version},key));
  assert.equal(view.images.state,'synced');assert.equal(images(view.snapshot)[1]!.image.version_id,swapped.version_id,'图片块换成新确认的那版');
  assert.equal(texts(view.snapshot).find(b=>b.id===target.id)!.text,'排版里改过的这段。','文字块编辑保留');
  const kept=images(view.snapshot).find(b=>b.id===articleImage.id)!;assert.equal(kept.display_width_percent,75,'换图的块保留 75% 宽度');assert.equal(kept.image.version_id,swapped.version_id);
  assert.deepEqual(view.snapshot.order,movedOrder,'用户调整过的位置保留');assert.equal(images(view.snapshot).find(b=>b.id!==articleImage.id)!.display_width_percent,100);
  const replay=await f.json<ArticleLayoutView>(await f.call('POST','/api/v1/article-layout/image-syncs',{topic_id:f.topic.id,expected_version:s.version},key));assert.equal(replay.snapshot.version,view.snapshot.version,'同键重放');
  await f.json(await f.call('POST','/api/v1/article-layout/image-syncs',{topic_id:f.topic.id,expected_version:s.version},randomUUID()),409);
 }finally{await f.close();}
});
test('image sync writes blocks, source and receipt together: a replay after a newer confirmation keeps the old source; a failing commit changes neither',async()=>{
 const {SqliteArticleLayoutRepository}=await import('../../packages/storage/src/article-layout/index.ts');const {layoutArticleId}=await import('../../packages/domain/src/article-layout/plan-final-source.ts');
 const f=await startPlanFixture();try{
  await confirmed(f);await f.json(await open(f));const swapTo=async(suffix:string)=>{const plan=await f.plan(),article=plan.items[1]!;const candidates=(await f.json<{candidates:StudioWebImageCandidate[]}>(await f.call('GET','/api/v1/topics/'+f.topic.id+'/web-image-candidates'))).candidates,other=candidates.find(c=>c.image_url.endsWith(suffix))!;
   await f.json(await f.call('POST','/api/v1/image-studio/web-imports',{topic_id:f.topic.id,expected_version:plan.studio.version,slot_id:article.slot_id,candidate:{candidate_id:other.candidate_id,image_url:other.image_url}}),201);const p=await f.plan();await f.json(await f.call('POST','/api/v1/image-studio/plan/confirm',{topic_id:f.topic.id,expected_version:p.version},randomUUID()));return readImagePlanFinal(f.app.context.db,f.app.identity.workspace_id,f.topic.id)!.id;};
  const source=async()=>(await new SqliteArticleLayoutRepository(f.app.context.db).read(f.app.identity.workspace_id,layoutArticleId(f.topic.id)))!.source!.final_id;
  const finalA=await swapTo('/tw.png');let view=await read(f);assert.equal(view.images.state,'final_updated');
  // 提交时出错：图片块与来源都不变。
  const original=SqliteArticleLayoutRepository.prototype.commit;SqliteArticleLayoutRepository.prototype.commit=async function(){throw new Error('disk full');};
  try{const failed=await f.call('POST','/api/v1/article-layout/image-syncs',{topic_id:f.topic.id,expected_version:view.snapshot.version},randomUUID());assert.equal(failed.status,409);}finally{SqliteArticleLayoutRepository.prototype.commit=original;}
  view=await read(f);assert.equal(view.images.state,'final_updated');assert.notEqual(await source(),finalA);assert.equal(images(view.snapshot).some(b=>b.image.source_sha256===finalA),false,'图片块没有半截更新');
  const key=randomUUID(),synced=await f.json<ArticleLayoutView>(await f.call('POST','/api/v1/article-layout/image-syncs',{topic_id:f.topic.id,expected_version:view.snapshot.version},key));assert.equal(synced.images.state,'synced');assert.equal(await source(),finalA);
  const finalB=await swapTo('/in2.png');assert.notEqual(finalB,finalA);
  const replay=await f.json<ArticleLayoutView>(await f.call('POST','/api/v1/article-layout/image-syncs',{topic_id:f.topic.id,expected_version:view.snapshot.version},key));assert.equal(await source(),finalA,'重放不把来源改成 B');assert.equal(replay.images.state,'final_updated');assert.equal(images(replay.snapshot).every(b=>b.image.source_sha256===finalA),true);
 }finally{await f.close();}
});
test('when the image confirmation status cannot be read, the layout says so instead of claiming synced',async()=>{
 const {ArticleLayoutStudio}=await import('../../packages/domain/src/article-layout/studio.ts');const {ImageStudio}=await import('../../packages/domain/src/artifact-execution/image-studio/index.ts');
 const f=await startPlanFixture();try{
  await confirmed(f);await f.json(await open(f));const image=new ImageStudio(f.app.context);
  const layout=new ArticleLayoutStudio(f.app.context,{image,plans:{finalStatus:async()=>{throw new Error('storage busy');}}});
  const view=await layout.view(f.request(),f.topic.id);assert.equal(view.images.state,'unknown');
  const {imageSyncCopy}=await import('../../apps/web/src/features/media/article-layout/c1-model.ts');assert.match(imageSyncCopy('unknown')!.text,/无法确认配图状态，请刷新/);
 }finally{await f.close();}
});
