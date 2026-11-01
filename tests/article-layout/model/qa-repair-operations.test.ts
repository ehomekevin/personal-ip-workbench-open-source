import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureLayoutExecution,completeFixtureLayoutExecution} from './check-fixture.ts';
import {layoutFixture} from './harness.ts';
import {ArticleLayoutService,ArticleLayoutSaveUnknown} from '../../../packages/domain/src/article-layout/service.ts';
import {articleLayoutCheckStatus,createLayoutCheckBinding,digest,editArticleText,serializeArticleText,sha256,updateArticleStyle} from '../../../packages/domain/src/article-layout/index.ts';
import type {ArticleLayoutSnapshot,LayoutCheckAttempt} from '../../../packages/contracts/src/article-layout.ts';
const image={asset_id:'qa-repair-fixture-asset',version_id:'qa-repair-image-v1',sha256:sha256('fixture-pixels'),source_sha256:sha256('fixture-producer'),url:'/fixture-not-a-real-image.png',pixel_width:1600,pixel_height:900};


test('P2-01 confirm stable original command replays after duplicate/restart/new head without restoring old confirmation',async()=>{
 const f=await layoutFixture();try{
  const request=f.request('confirm-command'),input={expected_version:1,human_decision_ref:'fixture-only-decision'};const first=await f.service.confirm(request,f.article.article_id,input);assert.equal(first.state,'saved');assert.deepEqual(await f.service.confirm(request,f.article.article_id,input),first);if(first.state!=='saved')return;
  const local=editArticleText(first.snapshot,first.snapshot.blocks[0]!.id,'本人后续保存的新稿');const updated=await f.service.save(f.request(),f.article.article_id,{expected_version:2,snapshot:local});assert.equal(updated.state,'saved');f.reopen();assert.deepEqual(await f.service.confirm({...request,request_id:'transport-retry-new-request-id'},f.article.article_id,input),first);
  const current=await f.service.load(f.request(),f.article.article_id);assert.equal(current.version,3);assert.equal(serializeArticleText(current),serializeArticleText(local));assert.equal(current.confirmation,null);assert.equal(Number(f.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()!.n),2);
  await assert.rejects(()=>f.service.confirm(request,f.article.article_id,{...input,human_decision_ref:'different-command'}),/IDEMPOTENCY_CONFLICT/);await assert.rejects(()=>f.service.confirm(request,f.article.article_id,{...input,expected_version:3}),/IDEMPOTENCY_CONFLICT/);await assert.rejects(()=>f.service.confirm({...request,request_identity_ref:'different-actor'},f.article.article_id,input),/IDEMPOTENCY_CONFLICT/);
 }finally{f.cleanup();}
});

test('P2-01 adoption replays before producer/configuration access and never loosens fresh producer revision fence',async()=>{
 const f=await layoutFixture();try{
  let loads=0;const source={async load(){loads++;return{document_revision_id:f.article.document_revision_id,producer_version:'fixture-producer-v1',source_sha256:image.source_sha256,images:[{id:'fixture-img',image,caption:'fixture-new-caption'}]};}};
  const service=new ArticleLayoutService(f.repository,f.documents,{image_source:source}),request=f.request('adoption-command'),input={expected_version:1};const first=await service.adoptImages(request,f.article.article_id,input);assert.equal(first.state,'saved');assert.deepEqual(await service.adoptImages(request,f.article.article_id,input),first);assert.equal(loads,1);if(first.state!=='saved')return;
  const edited=editArticleText(first.snapshot,first.snapshot.blocks[0]!.id,'采用图后的人工新稿');assert.equal((await service.save(f.request(),f.article.article_id,{expected_version:2,snapshot:edited})).state,'saved');f.reopen();assert.deepEqual(await f.service.adoptImages(request,f.article.article_id,input),first);assert.equal(loads,1);
  const current=await f.service.load(f.request(),f.article.article_id);assert.equal(current.version,3);assert.equal(serializeArticleText(current),serializeArticleText(edited));assert.equal((current.blocks.find(block=>block.kind==='image') as any).image.version_id,'qa-repair-image-v1');assert.equal(Number(f.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()!.n),3);
  const staleProducer=new ArticleLayoutService(f.repository,f.documents,{image_source:source});await assert.rejects(()=>staleProducer.adoptImages(f.request('fresh-but-stale-producer'),f.article.article_id,{expected_version:3}),/IMAGE_PRODUCER_FENCE/);assert.equal(loads,2);await assert.rejects(()=>staleProducer.adoptImages(request,f.article.article_id,{expected_version:2}),/IDEMPOTENCY_CONFLICT/);assert.equal(loads,2);
 }finally{f.cleanup();}
});

test('P2-01 intent check-sync replays before journal access across restart/new human head',async()=>{
 const f=await layoutFixture();try{
  let loads=0;const execution=fixtureLayoutExecution(f.article,f.root,'operation-fixture-job','operation-fixture-attempt'),check=execution.attempt,service=new ArticleLayoutService(f.repository,f.documents,{allow_fixture_checks:true,check_source:{async load(){loads++;return execution;}}}),request=f.request('sync-intent-command'),input={expected_version:1,attempt_id:check.attempt_id};
  const first=await service.syncCheck(request,f.article.article_id,input);assert.equal(first.state,'saved');assert.deepEqual(await service.syncCheck(request,f.article.article_id,input),first);assert.equal(loads,1);if(first.state!=='saved')return;
  const edited=editArticleText(first.snapshot,first.snapshot.blocks[0]!.id,'同步之后的本人新稿');assert.equal((await service.save(f.request(),f.article.article_id,{expected_version:2,snapshot:edited})).state,'saved');f.reopen();assert.deepEqual(await f.service.syncCheck(request,f.article.article_id,input),first);assert.equal(loads,1);const current=await f.service.load(f.request(),f.article.article_id);assert.equal(current.version,3);assert.equal(articleLayoutCheckStatus(current),'stale');assert.equal(current.checks.length,1);
  await assert.rejects(()=>f.service.syncCheck(request,f.article.article_id,{...input,attempt_id:'different-attempt'}),/IDEMPOTENCY_CONFLICT/);
 }finally{f.cleanup();}
});

test('P2-01 completed check-sync returns its original receipt and does not mark a newer layout current',async()=>{
 const f=await layoutFixture();try{
  let loads=0;const execution=completeFixtureLayoutExecution(fixtureLayoutExecution(f.article,f.root,'operation-fixture-job','operation-fixture-attempt')),check=execution.attempt;
  const service=new ArticleLayoutService(f.repository,f.documents,{allow_fixture_checks:true,check_source:{async load(){loads++;return execution;}}}),request=f.request('sync-completed-command'),input={expected_version:1,attempt_id:check.attempt_id};const first=await service.syncCheck(request,f.article.article_id,input);assert.equal(first.state,'saved');if(first.state!=='saved')return;assert.equal(articleLayoutCheckStatus(first.snapshot),'passed');
  const styled=updateArticleStyle(first.snapshot,{body_size:16});assert.equal((await service.save(f.request(),f.article.article_id,{expected_version:2,snapshot:styled})).state,'saved');f.reopen();assert.deepEqual(await f.service.syncCheck(request,f.article.article_id,input),first);assert.equal(loads,1);const current=await f.service.load(f.request(),f.article.article_id);assert.equal(current.version,3);assert.equal(articleLayoutCheckStatus(current),'stale');assert.equal(Number(f.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()!.n),1);
 }finally{f.cleanup();}
});

test('P2-01 cross-mode key reuse rejects before producer access; old editor receipt format still replays',async()=>{
 const f=await layoutFixture();try{
  const request=f.request('editor-legacy-command'),input={expected_version:1,snapshot:editArticleText(f.article,f.article.blocks[0]!.id,'编辑器幂等原稿')};const first=await f.service.save(request,f.article.article_id,input);assert.equal(first.state,'saved');
  const record=await f.repository.read(request.workspace_id,f.article.article_id);delete record!.operations[request.idempotency_key!]!.operation;f.db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(record),'article-layout.v1:'+request.workspace_id+':'+f.article.article_id);f.reopen();assert.deepEqual(await f.service.save(request,f.article.article_id,input),first);
  await assert.rejects(()=>f.service.confirm(request,f.article.article_id,{expected_version:1,human_decision_ref:'different-operation'}),/IDEMPOTENCY_CONFLICT/);await assert.rejects(()=>f.service.adoptImages(request,f.article.article_id,{expected_version:1}),/IDEMPOTENCY_CONFLICT/);await assert.rejects(()=>f.service.syncCheck(request,f.article.article_id,{expected_version:1,attempt_id:'other-operation'}),/IDEMPOTENCY_CONFLICT/);
  const confirmRequest=f.request('confirm-mode-key'),confirmed=await f.service.confirm(confirmRequest,f.article.article_id,{expected_version:2,human_decision_ref:'fixture-decision'});assert.equal(confirmed.state,'saved');if(confirmed.state==='saved')await assert.rejects(()=>f.service.save(confirmRequest,f.article.article_id,{expected_version:3,snapshot:confirmed.snapshot}),/IDEMPOTENCY_CONFLICT/);
 }finally{f.cleanup();}
});

test('P2-01 dedicated unknown intent keeps stable command identity and recovers without another producer or Document save',async()=>{
 const f=await layoutFixture();try{
  let loads=0;const service=new ArticleLayoutService(f.repository,f.documents,{after_document_checkpoint:()=>{throw new Error('fixture process interruption');},image_source:{async load(){loads++;return{document_revision_id:f.article.document_revision_id,producer_version:'fixture-v1',source_sha256:image.source_sha256,images:[{id:'fixture-img',image,caption:'new fixture caption'}]};}}}),request=f.request('unknown-adoption-command'),input={expected_version:1};
  await assert.rejects(()=>service.adoptImages(request,f.article.article_id,input),ArticleLayoutSaveUnknown);await assert.rejects(()=>service.adoptImages(request,f.article.article_id,input),ArticleLayoutSaveUnknown);assert.equal(loads,1);await assert.rejects(()=>service.adoptImages(request,f.article.article_id,{expected_version:2}),/IDEMPOTENCY_CONFLICT/);assert.equal(loads,1);
  f.reopen();const recovered=await f.service.recover(f.request(),f.article.article_id);assert.equal(recovered.state,'saved');assert.deepEqual(await f.service.adoptImages(request,f.article.article_id,input),recovered);assert.equal(loads,1);assert.equal(Number(f.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()!.n),2);const record=await f.repository.read(request.workspace_id,f.article.article_id);assert.equal(record!.operations[request.idempotency_key!]!.operation,'adoptImages');assert.equal(record!.pending,null);
 }finally{f.cleanup();}
});

test('P2-02 concurrent initialize for the same Document converges to one article record',async()=>{
 const f=await layoutFixture();try{const input={article_id:'same-document-race',document_id:f.document_id},results=await Promise.all([f.service.initialize(f.request(),input),f.service.initialize(f.request(),input)]);assert.deepEqual(results[0],results[1]);assert.equal(results[0]!.document_id,f.document_id);f.reopen();assert.deepEqual(await f.service.initialize(f.request(),input),results[0]);}finally{f.cleanup();}
});

test('P2-02 concurrent initialize for different Documents rejects the loser without returning or altering the winner',async()=>{
 const f=await layoutFixture();try{const second=await f.documents.create(f.request(),{kind:'article',initial_text:'第二篇独立文稿正文'}),documentIds=[f.document_id,second.document_id],articleId='different-document-race';const results=await Promise.allSettled(documentIds.map(document_id=>f.service.initialize(f.request(),{article_id:articleId,document_id})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);for(const [index,result] of results.entries()){if(result.status==='fulfilled')assert.equal(result.value.document_id,documentIds[index]);else assert.match(String(result.reason),/DOCUMENT_ID_MISMATCH/);}assert.equal((await f.documents.get(f.request(),second.document_id)).text,'第二篇独立文稿正文');const current=await f.service.load(f.request(),articleId);assert.ok(documentIds.includes(current.document_id));}finally{f.cleanup();}
});

test('P2-01 legacy editor concurrent CAS still returns the losing local draft as a conflict',async()=>{
 const f=await layoutFixture();try{const a=editArticleText(f.article,f.article.blocks[0]!.id,'先保存稿 A'),b=editArticleText(f.article,f.article.blocks[0]!.id,'竞争稿 B');const results=await Promise.all([f.service.save(f.request(),f.article.article_id,{expected_version:1,snapshot:a}),f.service.save(f.request(),f.article.article_id,{expected_version:1,snapshot:b})]);assert.equal(results[0]!.state,'saved');assert.equal(results[1]!.state,'conflict');if(results[1]!.state==='conflict')assert.equal(serializeArticleText(results[1]!.local),serializeArticleText(b));assert.equal((await f.documents.get(f.request(),f.document_id)).text,serializeArticleText(a));}finally{f.cleanup();}
});
