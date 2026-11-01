import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs, {mkdirSync,readFileSync,writeFileSync,appendFileSync,existsSync,symlinkSync,readdirSync,fstatSync,statSync,renameSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,dirname} from 'node:path';
import {fixture} from '../documents/harness.ts';
import {Topics} from '../../packages/domain/src/topics/index.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import {WritingFlow} from '../../packages/domain/src/writing-flow/index.ts';
import {WritingExport} from '../../packages/domain/src/writing-flow/export.ts';
import {Jobs} from '../../packages/domain/src/jobs/index.ts';
import {DEFAULT_WRITING_EXECUTION,type WritingRuleSnapshot} from '../../packages/contracts/src/index.ts';
import {sha256} from '../../packages/storage/src/connection/index.ts';

const text='# 已采用的完整稿\n\n'+'本人真实经历，保留原主张和读者用途。'.repeat(50);
const original='\uFEFF---\r\nstatus: 待本人过目\r\n人工字段: 保留\r\n---\r\n# 指定内容卡\r\n\r\n本人意见：不能编成效。\r\n\r\n## v1\r\n历史全文一。\r\n\r\n## v2\r\n历史全文二。\r\n';
const skill='---\nname: personal-ip-writing\ndescription: 导出恢复测试规则\n---\n保持本人事实。';
const rules:WritingRuleSnapshot={id:'export-fixture-rules',created_at:'2026-10-13T00:00:00Z',files:[],skill:{name:'personal-ip-writing',version:'0.1.0',content:skill,sha256:sha256(skill)},scope:'测试指定内容卡受控回写'};

async function setup(){
 const f=fixture();
 try{
  const topic=await new Topics(f.context()).create(f.request(),{title:'受控导出恢复测试',category:'个人思考',audience:'AI创作者',source_ids:[]});
  const documents=new Documents(f.context()),saved=await documents.save(f.request(),topic.core_document_id,{expected_revision_id:null,text,origin:'human'});
  const vault=join(f.root,'vault'),card=join(vault,'40-content','specified-card.md'),other=join(vault,'40-content','other-card.md');
  mkdirSync(dirname(card),{recursive:true});writeFileSync(card,original);writeFileSync(other,'其他源库内容保持只读');
  Object.assign(f.config.paths,{source_vault_root:vault});
  const target={id:'specified-card',topic_id:topic.id,document_id:topic.core_document_id,relative_path:'40-content/specified-card.md'};
  const registration=join(f.config.paths.state_root,'writing-flow-targets.json');
  writeFileSync(registration,JSON.stringify({workspace_id:f.config.workspace_id,targets:[target]}));
  const flow=new WritingFlow(f.context(),{rules:()=>structuredClone(rules)});
  const run=flow.start(f.request(),topic.id,{base_revision_id:saved.revision_id,source_ids:[],executor:'codex',instruction:'导出层恢复测试，未发布',rule_set:'personal-ip-writing',execution_policy:DEFAULT_WRITING_EXECUTION,export_target_id:target.id});
  // 独立导出测试固定为已审读、已采用的输入；完整执行链由 writing-flow.test.ts 验证。
  run.phase='awaiting_user';run.adopted_revision_id=saved.revision_id;flow.save(run);
  return {...f,topic,documents,saved,vault,card,other,target,registration,run,flow,exporter:new WritingExport(f.context())};
 }catch(error){f.cleanup();throw error;}
}
type ExportFixture=Awaited<ReturnType<typeof setup>>;
const prepare=(f:ExportFixture)=>f.exporter.prepare(f.request(),f.run.id,{expected_version:f.run.version});
const committed=(f:ExportFixture)=>new WritingFlow(f.context()).raw(f.request(),f.run.id).exports;
function mockFs(t:TestContext,name:'writeSync'|'renameSync'|'fsyncSync',fn:any){t.mock.method(fs,name,fn);syncBuiltinESMExports();}
function restore(t:TestContext){t.mock.restoreAll();syncBuiltinESMExports();}
const addition=(intent:ReturnType<typeof prepare>)=>Buffer.from(String(intent.full_content)).subarray(Buffer.byteLength(original));
const journalPath=(f:ExportFixture,intent:ReturnType<typeof prepare>)=>join(f.config.paths.state_root,'.writing-export-append-'+sha256(f.config.workspace_id+':'+intent.id)+'.json');
const isCardDescriptor=(f:ExportFixture,fd:number)=>fstatSync(fd).ino===statSync(f.card).ino;

test('只回写登记的精确内容卡，按字节保留 frontmatter、人工意见与历史；同 revision 换请求和重开后都不追加',async()=>{
 const f=await setup();try{
  assert.throws(()=>f.exporter.prepare(f.request(),f.run.id,{expected_version:f.run.version,path:f.other} as any),{code:'VALIDATION_ERROR'});
  const intent=prepare(f),request=f.request(),input={expected_version:f.run.version,export_id:String(intent.id)};
  assert.equal(intent.target_path,f.card);assert.equal(intent.relative_path,f.target.relative_path);assert.equal(intent.text,text);
  const receipt=f.exporter.commit(request,f.run.id,input),bytes=readFileSync(f.card);
  assert.ok(bytes.subarray(0,Buffer.byteLength(original)).equals(Buffer.from(original)));
  assert.equal(sha256(bytes),intent.output_file_sha256);assert.equal(receipt.text_sha256,sha256(text));assert.equal(receipt.revision_id,f.saved.revision_id);assert.equal(receipt.readback_matched,true);
  assert.deepEqual(f.exporter.commit(request,f.run.id,input),receipt);
  assert.deepEqual(f.exporter.commit(f.request(),f.run.id,input),receipt);
  f.reopen();const exporter=new WritingExport(f.context()),run=exporter.flow.raw(f.request(),f.run.id);
  const again=exporter.prepare(f.request(),f.run.id,{expected_version:run.version});
  assert.equal(again.id,intent.id);assert.deepEqual(exporter.commit(f.request(),f.run.id,{expected_version:run.version,export_id:String(again.id)}),receipt);
  assert.deepEqual(readFileSync(f.card),bytes);assert.equal(bytes.toString().split('<!-- workbench-writing:').length,2);
  assert.equal(run.exports.length,1);assert.equal(readFileSync(f.other,'utf8'),'其他源库内容保持只读');
 }finally{f.cleanup();}
});

test('准备后文件、工作台 head 或目标登记变化都拒绝覆盖，下一次准备可以纳入人工新增意见',async()=>{
 const f=await setup();try{
  const intent=prepare(f),input={expected_version:f.run.version,export_id:String(intent.id)};
  const changed=original+'\n本人新增意见：保留这一句。';writeFileSync(f.card,changed);
  assert.throws(()=>f.exporter.commit(f.request(),f.run.id,input),{code:'REVISION_CONFLICT'});assert.equal(readFileSync(f.card,'utf8'),changed);assert.equal(committed(f).length,0);
  const fresh=prepare(f);assert.notEqual(fresh.id,intent.id);assert.ok(String(fresh.full_content).startsWith(changed));
  const current={expected_version:f.run.version,export_id:String(fresh.id)};
  writeFileSync(f.registration,JSON.stringify({workspace_id:f.config.workspace_id,targets:[{...f.target,relative_path:'40-content/other-card.md'}]}));
  assert.throws(()=>f.exporter.commit(f.request(),f.run.id,current),{code:'INPUT_STALE'});assert.equal(readFileSync(f.other,'utf8'),'其他源库内容保持只读');
  writeFileSync(f.registration,JSON.stringify({workspace_id:f.config.workspace_id,targets:[f.target]}));
  await f.documents.save(f.request(),f.topic.core_document_id,{expected_revision_id:f.saved.revision_id,text:text+'\n新增人工稿件修订',origin:'human'});
  assert.throws(()=>f.exporter.commit(f.request(),f.run.id,current),{code:'REVISION_CONFLICT'});assert.equal(readFileSync(f.card,'utf8'),changed);
 }finally{f.cleanup();}
});

test('最后核对之后、原 rename 窗口发生人工 append 时保留原字节和人工新增，再顺序追加一次正文',async(t)=>{
 const f=await setup();try{
  const intent=prepare(f),write=fs.writeSync,human='\nNEW HUMAN FEEDBACK：写入前最后一刻人工追加。';let injected=false;
  mockFs(t,'writeSync',(fd:number,buffer:Buffer,offset:number,length:number,position:number|null)=>{assert.equal(isCardDescriptor(f,fd),true);assert.equal(position,null);appendFileSync(f.card,human);injected=true;return write(fd,buffer,offset,length,position);});
  const input={expected_version:f.run.version,export_id:String(intent.id)},receipt=f.exporter.commit(f.request(),f.run.id,input),expected=Buffer.concat([Buffer.from(original+human),addition(intent)]);
  assert.equal(injected,true);assert.deepEqual(readFileSync(f.card),expected);assert.equal(expected.includes(Buffer.from(human)),true,'human_edits_survived');
  assert.equal(receipt.file_sha256,sha256(expected));assert.notEqual(receipt.file_sha256,intent.output_file_sha256);assert.equal(receipt.readback_matched,true);assert.equal(receipt.append_offset,Buffer.byteLength(original+human));
  assert.deepEqual(f.exporter.commit(f.request(),f.run.id,input),receipt);assert.equal(committed(f).length,1);assert.deepEqual(readFileSync(f.card),expected);
  assert.equal(existsSync(join(dirname(f.card),'.workbench-export-'+intent.id+'.tmp')),false);
 }finally{restore(t);f.cleanup();}
});

test('本次追加之后、读回之前发生人工 append 时保留 suffix，并以实际读回登记回执',async(t)=>{
 const f=await setup();try{
  const intent=prepare(f),write=fs.writeSync,human='\n写后人工反馈';
  mockFs(t,'writeSync',(fd:number,buffer:Buffer,offset:number,length:number,position:number|null)=>{const result=write(fd,buffer,offset,length,position);appendFileSync(f.card,human);return result;});
  const input={expected_version:f.run.version,export_id:String(intent.id)};
  const receipt=f.exporter.commit(f.request(),f.run.id,input);restore(t);
  const expected=String(intent.full_content)+human;assert.equal(readFileSync(f.card,'utf8'),expected);assert.equal(receipt.file_sha256,sha256(expected));assert.equal(receipt.readback_matched,true);
  assert.deepEqual(f.exporter.commit(f.request(),f.run.id,input),receipt);assert.equal(committed(f).length,1);assert.equal(readFileSync(f.card,'utf8'),expected);
 }finally{restore(t);f.cleanup();}
});

test('descriptor 打开后人工 atomic replace，包括同字节换 inode，都拒绝成功并保持当前卡',async(t)=>{
 for(const sameBytes of [false,true]){
  const f=await setup();try{
   const intent=prepare(f),write=fs.writeSync,replacement=join(dirname(f.card),'human-save.md'),human=sameBytes?original:original+'\n人工原子保存的反馈';let injected=false;
   mockFs(t,'writeSync',(fd:number,buffer:Buffer,offset:number,length:number,position:number|null)=>{writeFileSync(replacement,human);renameSync(replacement,f.card);injected=true;return write(fd,buffer,offset,length,position);});
   const input={expected_version:f.run.version,export_id:String(intent.id)};
   assert.throws(()=>f.exporter.commit(f.request(),f.run.id,input),{code:'REVISION_CONFLICT'});restore(t);
   assert.equal(injected,true);assert.equal(readFileSync(f.card,'utf8'),human);assert.equal(committed(f).length,0);
   f.reopen();const exporter=new WritingExport(f.context());assert.throws(()=>exporter.commit(f.request(),f.run.id,input),{code:'REVISION_CONFLICT'});assert.throws(()=>exporter.prepare(f.request(),f.run.id,{expected_version:f.run.version}),{code:'REVISION_CONFLICT'});
   assert.equal(readFileSync(f.card,'utf8'),human);
  }finally{restore(t);f.cleanup();}
 }
});

test('短于 marker 的残片、UTF-8 多字节短写和零写入均保留现场；重开、换请求和重新准备不追加',async(t)=>{
 for(const kind of ['before-marker','multibyte','zero'] as const){
  const f=await setup();try{
   const intent=prepare(f),write=fs.writeSync,bytes=addition(intent),length=kind==='before-marker'?2:kind==='multibyte'?bytes.indexOf(Buffer.from('工作台'))+1:0;
   mockFs(t,'writeSync',(fd:number,buffer:Buffer,offset:number,_length:number,position:number|null)=>length?write(fd,buffer,offset,length,position):0);
   const input={expected_version:f.run.version,export_id:String(intent.id)};
   assert.throws(()=>f.exporter.commit(f.request(),f.run.id,input),(error:any)=>error.code==='STORAGE_UNAVAILABLE'&&error.details.recovery_state==='needs_attention');restore(t);
   const human=kind==='before-marker'?'\n短写后人工追加反馈':'',expected=Buffer.concat([Buffer.from(original),bytes.subarray(0,length),Buffer.from(human)]);if(human)appendFileSync(f.card,human);
   assert.deepEqual(readFileSync(f.card),expected);assert.equal(committed(f).length,0);assert.equal(JSON.parse(readFileSync(journalPath(f,intent),'utf8')).state,'attempted');
   f.reopen();const exporter=new WritingExport(f.context()),code=kind==='multibyte'?'STORAGE_UNAVAILABLE':'REVISION_CONFLICT';
   assert.throws(()=>exporter.commit(f.request(),f.run.id,input),(error:any)=>error.code===code&&error.details.recovery_state==='needs_attention');assert.throws(()=>exporter.prepare(f.request(),f.run.id,{expected_version:f.run.version}),(error:any)=>error.code===code&&error.details.recovery_state==='needs_attention');
   assert.deepEqual(readFileSync(f.card),expected);assert.equal(committed(f).length,0);
  }finally{restore(t);f.cleanup();}
 }
});

test('显式旧 export_id、旧 commit 和重新 prepare 均不能绕过另一意图的零写入或无 marker 残片',async(t)=>{
 for(const length of [0,2]){
  const f=await setup();try{
   const older=prepare(f);appendFileSync(f.card,'\nprepare 之后的人工反馈');const newer=prepare(f);assert.notEqual(older.id,newer.id);
   const write=fs.writeSync;mockFs(t,'writeSync',(fd:number,buffer:Buffer,offset:number,_length:number,position:number|null)=>length?write(fd,buffer,offset,length,position):0);
   assert.throws(()=>f.exporter.commit(f.request(),f.run.id,{expected_version:f.run.version,export_id:String(newer.id)}),{code:'STORAGE_UNAVAILABLE'});restore(t);
   const bytes=readFileSync(f.card);f.reopen();const exporter=new WritingExport(f.context());
   assert.throws(()=>exporter.prepare(f.request(),f.run.id,{expected_version:f.run.version,export_id:String(older.id)}),{code:'REVISION_CONFLICT'});
   assert.throws(()=>exporter.commit(f.request(),f.run.id,{expected_version:f.run.version,export_id:String(older.id)}),{code:'REVISION_CONFLICT'});
   assert.throws(()=>exporter.prepare(f.request(),f.run.id,{expected_version:f.run.version}),{code:'REVISION_CONFLICT'});
   assert.deepEqual(readFileSync(f.card),bytes);assert.equal(committed(f).length,0);assert.equal(readdirSync(f.config.paths.state_root).filter(name=>name.startsWith('.writing-export-append-')&&name.endsWith('.json')).length,1);
  }finally{restore(t);f.cleanup();}
 }
});

test('同内容卡另起正式 run，也不能绕过旧 run 的零写入或无 marker 残片',async(t)=>{
 for(const length of [0,2]){
  const f=await setup();try{
   const intent=prepare(f),jobs=new Jobs(f.context()),job=jobs.get(f.request(),f.run.stages[0]!.job_id);
   // fixture 未调用 provider；结束它的排队 job 后，按真实 start 路径创建同卡新 run。
   jobs.cancel(f.request(),job.job.id,{expected_version:job.job.version});
   const next=f.flow.start(f.request(),f.topic.id,{base_revision_id:f.saved.revision_id,source_ids:[],executor:'codex',instruction:'另一次完整稿 fixture',rule_set:'personal-ip-writing',execution_policy:DEFAULT_WRITING_EXECUTION,export_target_id:f.target.id,parent_run_id:f.run.id});
   next.phase='awaiting_user';next.adopted_revision_id=f.saved.revision_id;f.flow.save(next);
   const nextIntent=f.exporter.prepare(f.request(),next.id,{expected_version:next.version}),write=fs.writeSync;
   mockFs(t,'writeSync',(fd:number,buffer:Buffer,offset:number,_length:number,position:number|null)=>length?write(fd,buffer,offset,length,position):0);
   assert.throws(()=>f.exporter.commit(f.request(),f.run.id,{expected_version:f.run.version,export_id:String(intent.id)}),{code:'STORAGE_UNAVAILABLE'});restore(t);
   const bytes=readFileSync(f.card);f.reopen();const exporter=new WritingExport(f.context());
   assert.throws(()=>exporter.prepare(f.request(),next.id,{expected_version:next.version}),{code:'REVISION_CONFLICT'});
   assert.throws(()=>exporter.commit(f.request(),next.id,{expected_version:next.version,export_id:String(nextIntent.id)}),{code:'REVISION_CONFLICT'});
   assert.deepEqual(readFileSync(f.card),bytes);assert.equal(committed(f).length,0);assert.equal(exporter.flow.raw(f.request(),next.id).exports.length,0);
  }finally{restore(t);f.cleanup();}
 }
});

test('写入已完成但调用抛错、返回值未知或目标 fsync 中断后，只读回原追加并补一次回执',async(t)=>{
 for(const kind of ['throw-after-write','unknown-return','fsync'] as const){
  const f=await setup();try{
   const intent=prepare(f),input={expected_version:f.run.version,export_id:String(intent.id)},write=fs.writeSync,sync=fs.fsyncSync;let injected=false;
   if(kind==='fsync')mockFs(t,'fsyncSync',(fd:number)=>{if(isCardDescriptor(f,fd)&&!injected){injected=true;throw new Error('test: card fsync interrupted');}return sync(fd);});
   else mockFs(t,'writeSync',(fd:number,buffer:Buffer,offset:number,length:number,position:number|null)=>{write(fd,buffer,offset,length,position);injected=true;if(kind==='throw-after-write')throw new Error('test: interrupted after write');return undefined;});
   assert.throws(()=>f.exporter.commit(f.request(),f.run.id,input));restore(t);
   const bytes=readFileSync(f.card);assert.equal(injected,true);assert.equal(sha256(bytes),intent.output_file_sha256);assert.equal(committed(f).length,0);
   f.reopen();const exporter=new WritingExport(f.context()),receipt=exporter.commit(f.request(),f.run.id,input);assert.equal(receipt.readback_matched,true);assert.deepEqual(exporter.commit(f.request(),f.run.id,input),receipt);
   assert.deepEqual(readFileSync(f.card),bytes);assert.equal(committed(f).length,1);
  }finally{restore(t);f.cleanup();}
 }
});

test('写后 marker 被损坏或原卡前缀被人工修改时拒绝成功，重试和 prepare 都不重写',async(t)=>{
 for(const kind of ['marker','frontmatter'] as const){
  const f=await setup();try{
   const intent=prepare(f),write=fs.writeSync,changed=kind==='marker'?String(intent.full_content).replace('<!-- workbench-writing:','<!-- broken-writing:'):String(intent.full_content).replace('人工字段: 保留','人工字段: 本人修改');
   mockFs(t,'writeSync',(fd:number,buffer:Buffer,offset:number,length:number,position:number|null)=>{const count=write(fd,buffer,offset,length,position);writeFileSync(f.card,changed);return count;});
   const input={expected_version:f.run.version,export_id:String(intent.id)};assert.throws(()=>f.exporter.commit(f.request(),f.run.id,input),{code:'REVISION_CONFLICT'});restore(t);
   assert.equal(readFileSync(f.card,'utf8'),changed);assert.equal(committed(f).length,0);assert.throws(()=>f.exporter.commit(f.request(),f.run.id,input),{code:'REVISION_CONFLICT'});assert.throws(()=>prepare(f),{code:'REVISION_CONFLICT'});assert.equal(readFileSync(f.card,'utf8'),changed);
  }finally{restore(t);f.cleanup();}
 }
});

test('文件已 fsync 但持久回执替换中断后，清理回执临时文件并恢复完整追加；不重复正文',async(t)=>{
 const f=await setup();try{
  const intent=prepare(f),rename=fs.renameSync,journal=journalPath(f,intent);let injected=false;
  mockFs(t,'renameSync',(from:fs.PathLike,to:fs.PathLike)=>{if(String(to)===journal){injected=true;throw new Error('test: durable receipt save interrupted');}return rename(from,to);});
  const input={expected_version:f.run.version,export_id:String(intent.id)};assert.throws(()=>f.exporter.commit(f.request(),f.run.id,input),/durable receipt/);restore(t);
  const bytes=readFileSync(f.card);assert.equal(injected,true);assert.equal(sha256(bytes),intent.output_file_sha256);assert.equal(committed(f).length,0);assert.equal(readdirSync(f.config.paths.state_root).some(name=>name.endsWith('.tmp')),false);
  f.reopen();const exporter=new WritingExport(f.context()),receipt=exporter.commit(f.request(),f.run.id,input);assert.equal(receipt.readback_matched,true);assert.deepEqual(exporter.commit(f.request(),f.run.id,input),receipt);assert.deepEqual(readFileSync(f.card),bytes);assert.equal(committed(f).length,1);
 }finally{restore(t);f.cleanup();}
});

test('文件已落盘但 SQLite COMMIT 中断后重开恢复原意图，旧 run/head 已变化也只补一次原回执',async(t)=>{
 const f=await setup();try{
  const intent=prepare(f),db=f.context().db,execute=db.exec.bind(db);let interrupted=false;
  t.mock.method(db,'exec',(sql:string)=>{if(sql==='COMMIT'&&!interrupted){interrupted=true;throw new Error('test: service interrupted before SQLite COMMIT');}return execute(sql);});
  const request=f.request(),input={expected_version:f.run.version,export_id:String(intent.id)};
  assert.throws(()=>f.exporter.commit(request,f.run.id,input),/service interrupted/);restore(t);
  const durable=JSON.parse(readFileSync(journalPath(f,intent),'utf8')).receipt;assert.equal(durable.file_sha256,intent.output_file_sha256);assert.equal(durable.readback_matched,true);
  appendFileSync(f.card,'\n数据库中断之后本人补充的意见');
  const bytes=readFileSync(f.card);assert.notEqual(sha256(bytes),intent.output_file_sha256);assert.equal(committed(f).length,0);
  f.reopen();const exporter=new WritingExport(f.context());
  await new Documents(f.context()).save(f.request(),f.topic.core_document_id,{expected_revision_id:f.saved.revision_id,text:text+'\n服务中断后的人工修改',origin:'human'});
  const changedRun=exporter.flow.raw(f.request(),f.run.id);changedRun.version++;changedRun.phase='reviewing';exporter.flow.save(changedRun);
  const recovered=exporter.prepare(f.request(),f.run.id,{expected_version:changedRun.version});assert.equal(recovered.id,intent.id);
  const receipt=exporter.commit(request,f.run.id,input);assert.equal(receipt.export_id,intent.id);assert.equal(receipt.revision_id,f.saved.revision_id);assert.equal(receipt.readback_matched,true);assert.deepEqual(receipt,durable);
  assert.deepEqual(exporter.commit(f.request(),f.run.id,input),receipt);assert.deepEqual(readFileSync(f.card),bytes);
  const latest=exporter.flow.raw(f.request(),f.run.id);assert.equal(latest.exports.length,1);assert.equal(latest.version,changedRun.version+1);assert.equal(latest.phase,'reviewing');
 }finally{restore(t);f.cleanup();}
});

test('旧整卡输出已经完成但没有 append journal 时兼容恢复；内容卡 symlink 不允许写入其他源库文件',async()=>{
 const f=await setup();try{
  const intent=prepare(f);
  // 旧实现已经 rename 整卡、但尚未提交 SQLite 回执的现场。
  writeFileSync(f.card,String(intent.full_content));f.reopen();const exporter=new WritingExport(f.context());
  const receipt=exporter.commit(f.request(),f.run.id,{expected_version:f.run.version,export_id:String(intent.id)});
  assert.equal(receipt.readback_matched,true);assert.equal(existsSync(journalPath(f,intent)),false);
  const after=readFileSync(f.card);fs.unlinkSync(f.card);symlinkSync(f.other,f.card);
  assert.throws(()=>exporter.prepare(f.request(),f.run.id,{expected_version:exporter.flow.raw(f.request(),f.run.id).version}));
  assert.equal(readFileSync(f.other,'utf8'),'其他源库内容保持只读');assert.ok(after.length>Buffer.byteLength(original));
 }finally{f.cleanup();}
});

test('追加恢复记录被截断或回执 hash 损坏时拒绝自动恢复，不重复正文',async(t)=>{
 for(const kind of ['truncated-attempt','damaged-receipt'] as const){
  const f=await setup();try{
   const intent=prepare(f),input={expected_version:f.run.version,export_id:String(intent.id)};
   if(kind==='truncated-attempt')mockFs(t,'writeSync',()=>0);
   else{const db=f.context().db,execute=db.exec.bind(db);t.mock.method(db,'exec',(sql:string)=>{if(sql==='COMMIT')throw new Error('test: SQLite interrupted');return execute(sql);});}
   assert.throws(()=>f.exporter.commit(f.request(),f.run.id,input));restore(t);
   const bytes=readFileSync(f.card),path=journalPath(f,intent);
   if(kind==='truncated-attempt')writeFileSync(path,'{"intent_sha256":');
   else{const journal=JSON.parse(readFileSync(path,'utf8'));journal.receipt.file_sha256='damaged';writeFileSync(path,JSON.stringify(journal));}
   f.reopen();const exporter=new WritingExport(f.context());assert.throws(()=>exporter.commit(f.request(),f.run.id,input),{code:'STORAGE_UNAVAILABLE'});assert.throws(()=>exporter.prepare(f.request(),f.run.id,{expected_version:f.run.version}),{code:'STORAGE_UNAVAILABLE'});
   assert.deepEqual(readFileSync(f.card),bytes);assert.equal(committed(f).length,0);
  }finally{restore(t);f.cleanup();}
 }
});

test('原卡含无法无损解码的 UTF-8 字节时拒绝准备，不能替换历史内容后仍声明读回一致',async()=>{
 const f=await setup();try{
  const bytes=Buffer.concat([Buffer.from(original),Buffer.from([0xff]),Buffer.from('\n历史稿字节')]);writeFileSync(f.card,bytes);
  assert.throws(()=>prepare(f),{code:'STORAGE_UNAVAILABLE'});assert.deepEqual(readFileSync(f.card),bytes);assert.equal(committed(f).length,0);
 }finally{f.cleanup();}
});
