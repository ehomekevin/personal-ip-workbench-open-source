// 生图真实进度（快照里的只读投影）：阶段来自执行 checkpoint，历史均值来自同渠道成功任务；不持久保存、不新开协议。
import nodeTest from 'node:test';
import test from '../helpers/media-tools.ts'; // 依赖真实图像解码；缺 ffmpeg/ffprobe 时跳过
import assert from 'node:assert/strict';
import {startStudioFixture} from './harness.ts';
import type {StudioSnapshot,StudioGenerationRequest} from '../../packages/contracts/src/index.ts';
import {imageProgressStage,DEFAULT_TYPICAL_MS,cachedTypicalImageDuration,invalidateTypicalImageDuration,TYPICAL_CACHE_TTL_MS} from '../../packages/domain/src/artifact-execution/image-studio/progress.ts';
import {readStudio} from '../../packages/storage/src/image-studio/index.ts';
import {DatabaseSync} from 'node:sqlite';

nodeTest('进度阶段：只认执行链路真实写下的 phase / native_state，认不出时停在较早阶段',()=>{
 assert.equal(imageProgressStage('queued',null),'queued');
 assert.equal(imageProgressStage('waiting_input',{}),'queued');
 assert.equal(imageProgressStage('reconciling',{phase:'image_provider'}),'checking');
 assert.equal(imageProgressStage('running',{}),'starting');
 assert.equal(imageProgressStage('running',{phase:'image_submit_intent'}),'starting');
 assert.equal(imageProgressStage('running',{phase:'image_provider',image_checkpoint:{native_state:'submitting'}}),'starting');
 assert.equal(imageProgressStage('running',{phase:'image_provider',image_checkpoint:{native_state:'thread_ready'}}),'starting');
 assert.equal(imageProgressStage('running',{phase:'image_provider',image_checkpoint:{native_state:'running'}}),'generating');
 assert.equal(imageProgressStage('running',{phase:'image_provider',image_checkpoint:{native_state:'running',image_item:{id:'x'}}}),'saving','Codex 已返回图像 item');
 assert.equal(imageProgressStage('running',{phase:'image_provider',image_checkpoint:{native_state:'terminal_observed'}}),'saving');
 assert.equal(imageProgressStage('running',{phase:'image_provider_result'}),'saving');
 assert.equal(imageProgressStage('running',{phase:'image_verified'}),'saving');
 assert.equal(imageProgressStage('running','not-an-object'),'starting');
});

async function json<T>(response:Response,status=200):Promise<T>{const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;}
test('快照给进行中的版本附上进度：排队→无历史用保守默认；成功后同渠道新任务用历史均值；进度不写回持久状态',async()=>{
 const f=await startStudioFixture({auto_worker:false});
 try{
  const snapshot=()=>f.call('GET','/api/v1/image-studio?topic_id='+f.topic.id).then(r=>json<StudioSnapshot>(r));
  const generation=(s:StudioSnapshot,description:string):StudioGenerationRequest=>({topic_id:s.topic_id,document_revision_id:s.document_revision_id,paragraph_id:s.paragraphs[0]!.id,placement_paragraph_id:s.paragraphs[1]!.id,description,title:'进度',position:'after',provider:'agy',references:[],expected_version:s.version,slot_id:null,parent_version_id:null,operation:'generate',size_mode:'manual',size:{width:640,height:640,aspect_ratio:'1:1'},brief_id:null});
  let s=await snapshot();
  await json(await f.call('POST','/api/v1/image-studio/generations',generation(s,'第一张：排队中的进度')),202);
  s=await snapshot();
  const queued=s.slots[0]!.versions[0]!;
  assert.equal(queued.state,'queued');
  assert.equal(queued.progress?.stage,'queued');
  assert.equal(queued.progress?.running_ms,null,'还没开始执行');
  assert.ok(queued.progress!.total_ms>=0);
  assert.deepEqual(queued.progress?.previews,[],'当前渠道不提供中间图');
  assert.equal(queued.progress?.typical_source,'default');
  assert.equal(queued.progress?.typical_ms,DEFAULT_TYPICAL_MS);
  const stored=readStudio(f.app.context.db,f.app.context.identity.workspace_id,f.topic.id);
  assert.equal('progress' in stored.slots[0]!.versions[0]!,false,'进度只在响应里现算，不写回持久状态');
  await f.runOnce();
  s=await snapshot();
  assert.equal(s.slots[0]!.versions[0]!.state,'succeeded');
  assert.equal(s.slots[0]!.versions[0]!.progress,undefined,'结束后不再返回进度');
  await json(await f.call('POST','/api/v1/image-studio/generations',generation(s,'第二张：用历史均值估算')),202);
  s=await snapshot();
  const next=s.slots.flatMap(x=>x.versions).find(v=>v.description==='第二张：用历史均值估算')!;
  assert.equal(next.progress?.typical_source,'history');
  assert.equal(next.progress?.typical_samples,1);
  assert.ok(next.progress!.typical_ms>0&&next.progress!.typical_ms<DEFAULT_TYPICAL_MS,'历史均值来自刚才那次真实耗时：'+next.progress!.typical_ms);
 }finally{await f.close();}
});

nodeTest('历史均值走缓存：高频轮询不重复扫描任务表；任务成功时失效，TTL 兜底',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE jobs(id TEXT,workspace_id TEXT,kind TEXT,state TEXT,input_manifest TEXT,updated_at TEXT);CREATE TABLE job_events(workspace_id TEXT,job_id TEXT,type TEXT,occurred_at TEXT);');
 let scans=0;const prepare=db.prepare.bind(db);(db as unknown as {prepare:(sql:string)=>unknown}).prepare=(sql:string)=>{if(/FROM jobs j/.test(sql))scans++;return prepare(sql);};
 const add=(id:string,ms:number)=>{db.prepare("INSERT INTO jobs VALUES(?,'w','media_generate','succeeded',?,?)").run(id,JSON.stringify({operation:'image_provider',image:{provider:'agy'}}),'2026-10-16T00:00:00Z');db.prepare("INSERT INTO job_events VALUES('w',?,'started','2026-10-16T00:00:00.000Z')").run(id);db.prepare("INSERT INTO job_events VALUES('w',?,'succeeded',?)").run(id,new Date(Date.parse('2026-10-16T00:00:00.000Z')+ms).toISOString());};
 add('a',30000);
 assert.equal(cachedTypicalImageDuration(db,'w','agy',0).typical_ms,30000);
 add('b',50000);
 for(let i=0;i<50;i++)assert.equal(cachedTypicalImageDuration(db,'w','agy',1000+i*1500).typical_ms,30000,'轮询命中缓存');
 assert.equal(scans,1,'50 次轮询只扫描一次');
 invalidateTypicalImageDuration(db,'w','agy');
 assert.equal(cachedTypicalImageDuration(db,'w','agy',100000).typical_ms,40000,'任务成功后失效重算');
 assert.equal(scans,2);
 add('c',70000);
 assert.equal(cachedTypicalImageDuration(db,'w','agy',100000+TYPICAL_CACHE_TTL_MS).typical_ms,50000,'TTL 到期重算');
 assert.equal(cachedTypicalImageDuration(db,'w','codex',0).typical_source,'default','渠道分开缓存');
});
