// 语音“重新整理”：用编辑框文字新建 speech_cleanup 任务；旧任务 queued/waiting 先取消；整理任务版本栅栏与幂等重放；执行器只作用于本次任务。
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {fixture} from '../documents/harness.ts';
import type {AsrProvider,AsrEvent} from '../../packages/adapters/src/media/asr/ark.ts';
import {SpeechInputs} from '../../packages/domain/src/speech-input/index.ts';
import {Jobs} from '../../packages/domain/src/jobs/index.ts';
import {RecleanupSpeechInputSchema} from '../../packages/contracts/src/index.ts';
function asr():AsrProvider{let event!:(e:AsrEvent)=>void;return {async open(_m,onEvent){event=onEvent;return {requestId:randomUUID(),logId:()=>'log',send(_b,final){if(final)queueMicrotask(()=>event({text:'口述原文一二三四五六七八',final:true,log_id:'log'}));},close(){}};}};}
async function setup(){const f=fixture(),speech=new SpeechInputs(f.context(),{provider:asr(),credentialPresent:()=>true});speech.configure(f.request(),true);const s=await speech.start(f.request(),{mode:'live'});speech.chunk(f.request(),s.id,{sequence:1,audio_base64:'',final:true});await Promise.resolve();const first=speech.get(f.request(),s.id);
 const job=(id:string)=>f.context().db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as {id:string;state:string;executor_id:string;version:number;input_manifest:string};
 const receipt=()=>JSON.parse(String(f.context().db.prepare('SELECT value FROM application_metadata WHERE key=?').get('speech-input.v1:'+f.context().identity.workspace_id+':'+s.id)!.value)) as {cleanup_job_id:string;cleanup_source_text?:string};
 const count=()=>Number(f.context().db.prepare("SELECT count(*) n FROM jobs WHERE kind='speech_cleanup'").get()!.n);
 return {f,speech,id:s.id,first,job,receipt,count};}
test('queued 旧任务被取消，新任务冻结编辑框文字与所选执行器，状态回到 queued；重放不重复入队',async()=>{
 const t=await setup();try{
  assert.equal(t.first.cleanup_state,'queued');const old=t.receipt().cleanup_job_id,key=randomUUID(),input={text:'本人改过的口述文字一二三四',expected_cleanup_job_id:old,executor:'claude' as const};
  const next=t.speech.recleanup(t.f.request(key),t.id,input);assert.equal(next.cleanup_state,'queued');assert.equal(next.cleaned_text,null);
  assert.equal(t.job(old).state,'cancelled');const fresh=t.receipt();assert.notEqual(fresh.cleanup_job_id,old);assert.equal(fresh.cleanup_source_text,input.text);
  const created=t.job(fresh.cleanup_job_id);assert.equal(created.executor_id,'claude');assert.equal(JSON.parse(created.input_manifest).speech_cleanup.raw_text,input.text);
  assert.equal(t.speech.recleanup(t.f.request(key),t.id,input).cleanup_state,'queued');assert.equal(t.count(),2,'同一幂等键重放不重复入队');
  assert.throws(()=>t.speech.recleanup(t.f.request(),t.id,input),{code:'VERSION_CONFLICT'},'旧 expected_cleanup_job_id 被栅栏拒绝');
  assert.equal(t.speech.get(t.f.request(),t.id).cleanup_state,'queued','旧任务取消不会把新整理投影成失败');
 }finally{t.speech.close();t.f.cleanup();}
});
test('waiting（额度等待）旧任务同样取消；running 旧任务拒绝；未传执行器沿用默认；已采用后拒绝',async()=>{
 const t=await setup();try{
  const old=t.receipt().cleanup_job_id,claim=new Jobs(t.f.context()).claim('owner')!;assert.equal(claim.job.id,old);
  assert.throws(()=>t.speech.recleanup(t.f.request(),t.id,{text:'改过的文字',expected_cleanup_job_id:old}),{code:'VERSION_CONFLICT'});assert.equal(t.job(old).state,'running');
  new Jobs(t.f.context()).fail(claim.fence,{code:'QUOTA_EXHAUSTED',message:'q'},'waiting_quota');assert.equal(t.speech.get(t.f.request(),t.id).cleanup_state,'waiting');
  const next=t.speech.recleanup(t.f.request(),t.id,{text:'改过的文字一二三四五六',expected_cleanup_job_id:old});assert.equal(next.cleanup_state,'queued');assert.equal(t.job(old).state,'cancelled');
  const defaults=String(t.f.context().db.prepare('SELECT default_executor FROM workspaces').get()!.default_executor);assert.equal(t.job(t.receipt().cleanup_job_id).executor_id,defaults);
  t.speech.adopt(t.f.request(),t.id,{title:'素材',text:'改过的文字'});assert.throws(()=>t.speech.recleanup(t.f.request(),t.id,{text:'再整理',expected_cleanup_job_id:t.receipt().cleanup_job_id}),{code:'CAPABILITY_UNVERIFIED'});
  assert.throws(()=>RecleanupSpeechInputSchema.parse({text:'  ',expected_cleanup_job_id:null}));assert.throws(()=>RecleanupSpeechInputSchema.parse({text:'a',expected_cleanup_job_id:null,executor:'gemini'}));
 }finally{t.speech.close();t.f.cleanup();}
});
test('取消成功后入队前失败：旧任务保留已取消，接收方不变；同一请求重试只入队一次',async()=>{
 const t=await setup();try{
  const old=t.receipt().cleanup_job_id,key=randomUUID(),input={text:'重试的文字一二三四五',expected_cleanup_job_id:old};const db=t.f.context().db;
  db.exec("CREATE TEMP TRIGGER block_cleanup BEFORE INSERT ON documents WHEN NEW.kind='speech_cleanup' BEGIN SELECT RAISE(ABORT,'fixture insert failure'); END;");
  assert.throws(()=>t.speech.recleanup(t.f.request(key),t.id,input),/fixture insert failure/);assert.equal(t.job(old).state,'cancelled');assert.equal(t.receipt().cleanup_job_id,old);assert.equal(t.count(),1,'事务回滚，无半个新任务');
  db.exec('DROP TRIGGER block_cleanup');const next=t.speech.recleanup(t.f.request(key),t.id,input);assert.equal(next.cleanup_state,'queued');assert.equal(t.count(),2);assert.notEqual(t.receipt().cleanup_job_id,old);
 }finally{t.speech.close();t.f.cleanup();}
});
test('响应与幂等重放都带新的 cleanup_job_id；用它立即再次整理不冲突',async()=>{
 const t=await setup();try{
  const old=t.receipt().cleanup_job_id;assert.equal(t.first.cleanup_job_id,old,'快照带当前整理任务');
  const key=randomUUID(),input={text:'第一次重新整理的文字一二三四',expected_cleanup_job_id:old},first=t.speech.recleanup(t.f.request(key),t.id,input);
  assert.equal(first.cleanup_job_id,t.receipt().cleanup_job_id);assert.notEqual(first.cleanup_job_id,old);
  assert.equal(t.speech.recleanup(t.f.request(key),t.id,input).cleanup_job_id,first.cleanup_job_id,'幂等重放返回新任务');
  const second=t.speech.recleanup(t.f.request(),t.id,{text:'紧接着再整理一次的文字',expected_cleanup_job_id:first.cleanup_job_id!});
  assert.equal(t.job(first.cleanup_job_id!).state,'cancelled');assert.equal(second.cleanup_job_id,t.receipt().cleanup_job_id);assert.equal(t.speech.get(t.f.request(),t.id).cleanup_job_id,second.cleanup_job_id);assert.equal(t.count(),3);
 }finally{t.speech.close();t.f.cleanup();}
});
test('旧记录只有外层 cleanup_job_id：读取投影回填到快照，重新整理用它做栅栏',async()=>{
 const t=await setup();try{
  const key='speech-input.v1:'+t.f.context().identity.workspace_id+':'+t.id,stored=JSON.parse(String(t.f.context().db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key)!.value));delete stored.snapshot.cleanup_job_id;t.f.context().db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(stored),key);
  const view=t.speech.get(t.f.request(),t.id);assert.equal(view.cleanup_job_id,stored.cleanup_job_id);
  assert.equal(t.speech.recleanup(t.f.request(),t.id,{text:'旧记录重新整理的文字',expected_cleanup_job_id:view.cleanup_job_id!}).cleanup_state,'queued');
 }finally{t.speech.close();t.f.cleanup();}
});
