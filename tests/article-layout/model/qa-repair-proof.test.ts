import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureLayoutExecution,completeFixtureLayoutExecution} from './check-fixture.ts';
import {layoutFixture} from './harness.ts';
import {ArticleLayoutService} from '../../../packages/domain/src/article-layout/service.ts';
import {SqliteLayoutCheckJournal} from '../../../packages/storage/src/article-layout/check-journal.ts';
import {articleLayoutCheckStatus,editArticleText,sha256,serializeArticleText} from '../../../packages/domain/src/article-layout/index.ts';
import type {LayoutCheckExecution} from '../../../packages/storage/src/article-layout/proof.ts';

test('repair P2-03: service independently rejects altered, empty or missing native digest, images and projected proof before current passed',async()=>{
 for(const mutation of ['digest','empty','missing','images','projection'] as const){
  const f=await layoutFixture();try{
   const done=completeFixtureLayoutExecution(fixtureLayoutExecution(f.article,f.root));const bad:any=structuredClone(done);
   if(mutation==='digest')bad.proof.native_input_sha256=sha256('valid but unrelated native input');
   if(mutation==='empty')bad.proof.native_input_sha256='';
   if(mutation==='missing')delete bad.proof.native_input_sha256;
   if(mutation==='images')bad.proof.submitted_local_images.reverse();
   const source=mutation==='projection'?{attempt:bad.attempt,fixture:true,proof:{source:'fixture',original_input_verified:true,output_sha256:bad.proof.output_sha256}}:bad;
   let saves=0,loads=0;const service=new ArticleLayoutService(f.repository,{get:(...a)=>f.documents.get(...a),save:async(...a)=>{saves++;return f.documents.save(...a);}},{allow_fixture_checks:true,check_source:{async load(){loads++;return source as LayoutCheckExecution;}}});
   await assert.rejects(()=>service.syncCheck(f.request(),f.article.article_id,{expected_version:1,attempt_id:done.attempt.attempt_id}),/INPUT_PROOF_INVALID/);
   const current=await service.load(f.request(),f.article.article_id);assert.equal(current.version,1);assert.notEqual(articleLayoutCheckStatus(current),'passed');assert.equal(current.text_hash,f.article.text_hash);assert.equal(current.checks.length,0);assert.equal(saves,0);assert.equal(loads,1);assert.equal((await f.repository.read(f.request().workspace_id,f.article.article_id))!.pending,null);
  }finally{f.cleanup();}
 }
});

test('repair P2-03: full valid completion survives actual SQLite reopen, cached consumption and repeated command with no extra Document write',async()=>{
 const f=await layoutFixture();try{
  const intent=fixtureLayoutExecution(f.article,f.root),done=completeFixtureLayoutExecution(intent),workspace=f.request().workspace_id;
  let journal=new SqliteLayoutCheckJournal(f.db,workspace);assert.equal(await journal.reserve(intent),true);await journal.save(done);f.reopen();journal=new SqliteLayoutCheckJournal(f.db,workspace);
  let saves=0,loads=0;const service=new ArticleLayoutService(f.repository,{get:(...a)=>f.documents.get(...a),save:async(...a)=>{saves++;return f.documents.save(...a);}},{allow_fixture_checks:true,check_source:{async load(id){loads++;return journal.load(id);}}});
  const request=f.request('complete-original-command'),input={expected_version:1,attempt_id:done.attempt.attempt_id},first=await service.syncCheck(request,f.article.article_id,input);assert.equal(first.state,'saved');assert.equal(articleLayoutCheckStatus(await service.load(f.request(),f.article.article_id)),'passed');
  assert.deepEqual(await service.syncCheck(request,f.article.article_id,input),first);assert.equal(loads,1);assert.equal(saves,0);assert.equal(Number(f.db.prepare('SELECT COUNT(*) AS n FROM document_revisions').get()!.n),1);
 }finally{f.cleanup();}
});

test('repair P2-03: valid old full input completion cannot mark later human content current passed or overwrite its text',async()=>{
 const f=await layoutFixture();try{
  const intent=fixtureLayoutExecution(f.article,f.root);let execution:LayoutCheckExecution=intent;
  const service=new ArticleLayoutService(f.repository,f.documents,{allow_fixture_checks:true,check_source:{async load(){return execution;}}});
  const registered=await service.syncCheck(f.request(),f.article.article_id,{expected_version:1,attempt_id:intent.attempt.attempt_id});assert.equal(registered.state,'saved');if(registered.state!=='saved')return;
  const human=editArticleText(registered.snapshot,registered.snapshot.blocks[0]!.id,'本人新稿不可覆盖');assert.equal((await service.save(f.request(),f.article.article_id,{expected_version:2,snapshot:human})).state,'saved');execution=completeFixtureLayoutExecution(intent);
  assert.equal((await service.syncCheck(f.request(),f.article.article_id,{expected_version:3,attempt_id:intent.attempt.attempt_id})).state,'saved');const current=await service.load(f.request(),f.article.article_id);
  assert.equal(articleLayoutCheckStatus(current),'stale');assert.equal(current.text_hash,human.text_hash);assert.equal((await f.documents.get(f.request(),f.document_id)).text,serializeArticleText(human));
 }finally{f.cleanup();}
});
