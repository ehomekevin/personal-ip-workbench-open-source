import test from '../helpers/media-tools.ts'; // 依赖真实图像解码；缺 ffmpeg/ffprobe 时跳过
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {startStudioFixture} from './harness.ts';
import {ImageStudio} from '../../packages/domain/src/artifact-execution/image-studio/index.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import type {StudioSnapshot,StudioGenerationRequest} from '../../packages/contracts/src/index.ts';
function input(s:StudioSnapshot):StudioGenerationRequest{return{topic_id:s.topic_id,document_revision_id:s.document_revision_id,paragraph_id:s.paragraphs[0]!.id,placement_paragraph_id:s.paragraphs[1]!.id,description:'普通并发操作：说明、生成、采用',title:'普通并发',position:'after',provider:'agy',references:[],expected_version:s.version,slot_id:null,parent_version_id:null,operation:'generate',size_mode:'manual',size:{width:640,height:640,aspect_ratio:'1:1'},brief_id:null};}
async function seeded(){const f=await startStudioFixture({auto_worker:false}),studio=new ImageStudio(f.app.context,{record_root:f.app.context.paths.managed_notes_root}),documents=new Documents(f.app.context),s=await studio.snapshot(f.request(),f.topic.id),q=await(await f.call('POST','/api/v1/image-studio/generations',input(s))).json();await f.runOnce();return{f,studio,documents,s,q};}
for(const kind of ['adopt','confirm'] as const)test(`WS-F01 ${kind} rejects a concurrent ordinary human save inside its writing transaction`,async()=>{
 const{f,studio,documents}=await seeded();try{let s=await studio.snapshot(f.request(),f.topic.id);const slot=s.slots[0]!,v=slot.versions[0]!;if(kind==='confirm')s=await studio.adopt(f.request(),slot.id,{topic_id:s.topic_id,expected_version:s.version,version_id:v.id});
  const operation=kind==='adopt'?studio.adopt(f.request(),slot.id,{topic_id:s.topic_id,expected_version:s.version,version_id:v.id}):studio.confirm(f.request(),{topic_id:s.topic_id,document_revision_id:s.document_revision_id,expected_version:s.version,confirmed:true});
  const caught=operation.then(value=>({value,error:null}),error=>({value:null,error}));
  const saved=await documents.save(f.request(),f.document_id,{expected_revision_id:s.document_revision_id,text:s.article_text+'\n\n本人新稿已保存。',origin:'human'}),actual=await caught;assert.equal(actual.value,null);assert.equal(actual.error?.code,'INPUT_STALE');
  const current=await documents.get(f.request(),f.document_id),fresh=await studio.snapshot(f.request(),f.topic.id);assert.equal(current.head_revision_id,saved.revision_id);assert.ok(current.text.endsWith('本人新稿已保存。'));assert.equal(fresh.recording.wiki_record,null);if(kind==='adopt')assert.equal(fresh.slots[0]!.active_version_id,null);assert.equal(f.image_calls,1);assert.equal(f.brief_calls,0);assert.equal(f.provider.queries,0);
 }finally{const root=f.root;await f.close();assert.equal(existsSync(root),false);}
});
test('WS-F02 saving before first observation preserves the committed old file and permits a task for the new article',async()=>{
 const{f,studio,documents,s,q}=await seeded();try{const job=await(await f.call('GET','/api/v1/jobs/'+q.job_id)).json();assert.equal(job.job.state,'succeeded');const saved=await documents.save(f.request(),f.document_id,{expected_revision_id:s.document_revision_id,text:s.article_text+'\n\n本人新稿已保存。',origin:'human'}),fresh=await studio.snapshot(f.request(),f.topic.id),old=fresh.slots[0]!.versions[0]!;
  assert.ok(old.asset_id);assert.ok(['succeeded','size_mismatch'].includes(old.state));assert.equal(old.document_revision_id,s.document_revision_id);assert.equal(fresh.document_revision_id,saved.revision_id);assert.equal((await f.call('GET','/api/v1/assets/'+old.asset_id+'/content')).status,200);
  await assert.rejects(()=>studio.adopt(f.request(),fresh.slots[0]!.id,{topic_id:fresh.topic_id,expected_version:fresh.version,version_id:old.id}),{code:'INPUT_STALE'});
  const response=await f.call('POST','/api/v1/image-studio/generations',{...input(fresh),slot_id:fresh.slots[0]!.id,description:'本人新稿的新配图'});assert.equal(response.status,202,await response.clone().text());assert.equal(f.image_calls,1);assert.equal(f.provider.queries,0);
 }finally{await f.close();}
});
