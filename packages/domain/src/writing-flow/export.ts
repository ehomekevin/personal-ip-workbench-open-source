import {randomUUID} from 'node:crypto';
import {isUtf8} from 'node:buffer';
import {constants,openSync,closeSync,readSync,writeSync,writeFileSync,fsyncSync,renameSync,unlinkSync,lstatSync,fstatSync,realpathSync,type Stats} from 'node:fs';
import {dirname,join,isAbsolute} from 'node:path';
import {ContractError,WritingExportActionSchema,type RequestContext,type WritingExportAction,type JsonObject,type WritingRun,type WritingTarget} from '@workbench/contracts';
import {transaction,sha256,canonicalJson} from '@workbench/storage/connection';
import {readIdempotent,storeIdempotent,assertRevisionExpected,getDocumentRow} from '@workbench/storage/revisions';
import {WritingFlow} from './index.ts';
import {registeredTargets,vaultFile} from './rules.ts';

interface ExportIntent {
 id:string;run_id:string;run_version:number;document_id:string;revision_id:string;target_id:string;relative_path:string;
 target_path?:string;target_registration_sha256?:string;expected_file_sha256:string;output_file_sha256:string;text_sha256:string;
 text:string;full_content:string;created_at:string;state:'prepared'|'committed';committed_at?:string;receipt?:JsonObject;
}
const key=(w:string,id:string)=>'writing-export.v1:'+w+':'+id;
const marker=(intent:Pick<ExportIntent,'run_id'|'revision_id'>)=>'<!-- workbench-writing:'+intent.run_id+':'+intent.revision_id+' -->';
const block=(intent:Pick<ExportIntent,'run_id'|'revision_id'|'text'>)=>marker(intent)+'\n'+intent.text+'\n<!-- /workbench-writing -->\n';
const appendBlock=(intent:Pick<ExportIntent,'run_id'|'revision_id'|'text'>)=>'\n\n## 工作台完整稿 · 待本人过目\n\n'+block(intent);
const targetHash=(target:WritingTarget)=>sha256(canonicalJson(target));
const maxCardBytes=1048576;
interface AppendJournal {intent_sha256:string;dev:number;ino:number;state:'attempted'|'verified';receipt?:JsonObject;receipt_sha256?:string}
function assertDescriptor(path:string,fd:number,expected?:Pick<Stats,'dev'|'ino'>):Stats {
 const info=fstatSync(fd),current=lstatSync(path);
 if(!info.isFile()||info.nlink!==1||!current.isFile()||current.isSymbolicLink()||current.nlink!==1||realpathSync(path)!==path||current.dev!==info.dev||current.ino!==info.ino||(expected&&(info.dev!==expected.dev||info.ino!==expected.ino)))throw new ContractError('REVISION_CONFLICT','内容卡文件身份发生变化，未替换当前文件；请人工核对');
 if(info.size>maxCardBytes)throw new ContractError('STORAGE_UNAVAILABLE','内容卡超过可读回核对的大小');
 return info;
}
function openCard(path:string,flags=constants.O_RDONLY):number {
 const before=lstatSync(path);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>maxCardBytes||realpathSync(path)!==path)throw new ContractError('STORAGE_UNAVAILABLE','内容卡必须是可核对的普通文件');
 const fd=openSync(path,flags|constants.O_NOFOLLOW);
 try{assertDescriptor(path,fd,before);return fd;}catch(error){closeSync(fd);throw error;}
}
function readDescriptor(path:string,fd:number,expected?:Pick<Stats,'dev'|'ino'>):{bytes:Buffer;info:Stats} {
 const opened=assertDescriptor(path,fd,expected),bytes=Buffer.alloc(opened.size);
 let offset=0;
 while(offset<bytes.length){const length=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!length)break;offset+=length;}
 const after=assertDescriptor(path,fd,opened);
 if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||offset!==opened.size)throw new ContractError('REVISION_CONFLICT','读取时内容卡发生变化，请重新核对');
 return {bytes,info:after};
}
function readCard(path:string):string {
 const fd=openCard(path);
 try{
  const {bytes}=readDescriptor(path,fd);
  if(!isUtf8(bytes))throw new ContractError('STORAGE_UNAVAILABLE','内容卡不是有效 UTF-8，无法无损保留人工内容；请先核对文件编码');
  return bytes.toString('utf8');
 }finally{closeSync(fd);}
}
function verifyAppend(intent:ExportIntent,bytes:Buffer){
 const addition=Buffer.from(appendBlock(intent)),base=Buffer.from(intent.full_content).subarray(0,Buffer.byteLength(intent.full_content)-addition.length),start=bytes.indexOf(addition,base.length),tag=Buffer.from(marker(intent));
 if(!bytes.subarray(0,base.length).equals(base)||start<base.length||bytes.indexOf(addition,start+1)!==-1||bytes.indexOf(tag)!==start+addition.indexOf(tag)||bytes.indexOf(tag,start+addition.indexOf(tag)+1)!==-1)throw new ContractError('REVISION_CONFLICT','追加字节未完整且唯一保留，固定意图保留待人工核对；未重写内容卡',{export_id:intent.id,recovery_state:'needs_attention'});
 return {append_sha256:sha256(addition),append_offset:start,append_bytes:addition.length};
}
function syncDirectory(path:string){const directory=openSync(dirname(path),constants.O_RDONLY);try{fsyncSync(directory);}finally{closeSync(directory);}}

export class WritingExport {
 readonly flow:WritingFlow;
 constructor(readonlyContext:WritingFlow['context']){this.flow=new WritingFlow(readonlyContext);}
 private save(intent:ExportIntent){this.flow.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key(this.flow.context.identity.workspace_id,intent.id),JSON.stringify(intent));}
 private load(request:RequestContext,exportId:string):ExportIntent {
  const row=this.flow.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key(request.workspace_id,exportId));
  if(!row)throw new ContractError('NOT_FOUND','回写意图不存在');return JSON.parse(String(row.value)) as ExportIntent;
 }
 private intents(request:RequestContext,run?:WritingRun):ExportIntent[]{return this.flow.context.db.prepare('SELECT value FROM application_metadata WHERE key LIKE ?').all('writing-export.v1:'+request.workspace_id+':%').map(row=>JSON.parse(String(row.value)) as ExportIntent).filter(intent=>!run||(intent.run_id===run.id&&intent.document_id===run.document_id)).sort((a,b)=>b.created_at.localeCompare(a.created_at));}
 private validateIntent(request:RequestContext,run:WritingRun,intent:ExportIntent){
  if(intent.run_id!==run.id||intent.document_id!==run.document_id)throw new ContractError('INPUT_STALE','回写意图不属于本次运行与文稿');
  const addition=appendBlock(intent),base=intent.full_content.slice(0,-addition.length);
  if(sha256(intent.full_content)!==intent.output_file_sha256||sha256(intent.text)!==intent.text_sha256||!intent.full_content.endsWith(addition)||sha256(base)!==intent.expected_file_sha256||base.includes(marker(intent)))throw new ContractError('STORAGE_UNAVAILABLE','固定回写字节或正文 hash 无效');
  if(this.flow.generation.revision(request,intent.document_id,intent.revision_id).text!==intent.text)throw new ContractError('STORAGE_UNAVAILABLE','固定回写正文与登记修订不一致');
 }
 private view(intent:ExportIntent){
  // 整卡固定输出可以直接审查；运行回执留在 evidence，读者正文只取 text。
  return {...intent,evidence:{run_id:intent.run_id,document_id:intent.document_id,revision_id:intent.revision_id,target_id:intent.target_id,relative_path:intent.relative_path,purpose:'content_card_export',status:'test_draft_awaiting_user',publishing:false}};
 }
 private receipt(intent:ExportIntent,fileHash=intent.output_file_sha256):JsonObject {
  if(intent.receipt)return intent.receipt;
  if(!intent.committed_at)throw new ContractError('STORAGE_UNAVAILABLE','已回写意图缺少提交时间');
  return {export_id:intent.id,run_id:intent.run_id,document_id:intent.document_id,revision_id:intent.revision_id,target_id:intent.target_id,relative_path:intent.relative_path,previous_file_sha256:intent.expected_file_sha256,file_sha256:fileHash,text_sha256:intent.text_sha256,committed_at:intent.committed_at,state:'committed',readback_matched:true};
 }
 private journalPath(intent:ExportIntent){return join(this.flow.context.paths.state_root,'.writing-export-append-'+sha256(this.flow.context.identity.workspace_id+':'+intent.id)+'.json');}
 private journalBinding(intent:ExportIntent){return sha256(canonicalJson({id:intent.id,run_id:intent.run_id,document_id:intent.document_id,revision_id:intent.revision_id,target_id:intent.target_id,relative_path:intent.relative_path,target_path:intent.target_path,target_registration_sha256:intent.target_registration_sha256,expected_file_sha256:intent.expected_file_sha256,output_file_sha256:intent.output_file_sha256,text_sha256:intent.text_sha256,append_sha256:sha256(appendBlock(intent))}));}
 private loadJournal(intent:ExportIntent):AppendJournal|undefined {
  let journal:AppendJournal;
  try{journal=JSON.parse(readCard(this.journalPath(intent))) as AppendJournal;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new ContractError('STORAGE_UNAVAILABLE','追加恢复记录不可核对，未再次写入；请人工核对',{export_id:intent.id,recovery_state:'needs_attention'});}
  const receipt=journal?.receipt,validReceipt=receipt&&journal.receipt_sha256===sha256(canonicalJson(receipt))&&receipt.export_id===intent.id&&receipt.run_id===intent.run_id&&receipt.document_id===intent.document_id&&receipt.revision_id===intent.revision_id&&receipt.target_id===intent.target_id&&receipt.relative_path===intent.relative_path&&receipt.state==='committed'&&receipt.text_sha256===intent.text_sha256&&receipt.previous_file_sha256===intent.expected_file_sha256&&receipt.prepared_file_sha256===intent.output_file_sha256&&receipt.append_sha256===sha256(appendBlock(intent))&&receipt.append_bytes===Buffer.byteLength(appendBlock(intent))&&Number.isSafeInteger(receipt.append_offset)&&Number(receipt.append_offset)>=Buffer.byteLength(intent.full_content)-Buffer.byteLength(appendBlock(intent))&&typeof receipt.file_sha256==='string'&&/^[a-f0-9]{64}$/.test(receipt.file_sha256)&&typeof receipt.committed_at==='string'&&Number.isFinite(Date.parse(receipt.committed_at))&&receipt.readback_matched===true&&receipt.write_mode==='append_preserving'&&receipt.readback_scope==='original_prefix_and_unique_append';
  if(!journal||journal.intent_sha256!==this.journalBinding(intent)||!Number.isSafeInteger(journal.dev)||journal.dev<0||!Number.isSafeInteger(journal.ino)||journal.ino<0||!['attempted','verified'].includes(journal.state)||(journal.state==='verified'&&!validReceipt))throw new ContractError('STORAGE_UNAVAILABLE','追加恢复记录与固定意图不一致，未再次写入',{export_id:intent.id,recovery_state:'needs_attention'});
  return journal;
 }
 private saveJournal(intent:ExportIntent,journal:AppendJournal,initial=false){
  const path=this.journalPath(intent),temporary=path+'.'+randomUUID()+'.tmp',destination=initial?path:temporary;
  const fd=openSync(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{
   try{writeFileSync(fd,JSON.stringify(journal));fsyncSync(fd);}finally{closeSync(fd);}
   if(!initial)renameSync(temporary,path);syncDirectory(path);
  }finally{if(!initial)try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 }
 private verifyJournal(intent:ExportIntent,journal:AppendJournal,fd:number):JsonObject {
  const {bytes}=readDescriptor(intent.target_path!,fd,journal);
  // 先以原始字节识别已记录的尝试；半个 UTF-8 字符是 pending partial，不能当新卡准备或解析成成功。
  if(bytes.indexOf(Buffer.from(appendBlock(intent)))===-1)throw new ContractError(isUtf8(bytes)?'REVISION_CONFLICT':'STORAGE_UNAVAILABLE','追加尝试尚未完成或字节已损坏，现场已保留待人工核对；未再次追加',{export_id:intent.id,recovery_state:'needs_attention'});
  const addition=verifyAppend(intent,bytes);
  if(!isUtf8(bytes))throw new ContractError('STORAGE_UNAVAILABLE','已追加内容卡含无法无损读取的 UTF-8 字节，现场保留待人工核对',{export_id:intent.id,recovery_state:'needs_attention'});
  // 完整追加已经落盘后才保存回执；它独立于外层 SQLite 事务，SQL 回滚不丢掉首次读回结果。
  fsyncSync(fd);
  if(journal.state!=='verified'){
   journal.receipt={...this.receipt({...intent,committed_at:new Date().toISOString()},sha256(bytes)),...addition,write_mode:'append_preserving',readback_scope:'original_prefix_and_unique_append',prepared_file_sha256:intent.output_file_sha256};journal.receipt_sha256=sha256(canonicalJson(journal.receipt));journal.state='verified';this.saveJournal(intent,journal);
  }
  assertDescriptor(intent.target_path!,fd,journal);
  return journal.receipt!;
 }
 private recoverAppend(intent:ExportIntent,journal:AppendJournal):JsonObject {
  const fd=openCard(intent.target_path!);
  try{return this.verifyJournal(intent,journal,fd);}finally{closeSync(fd);}
 }
 private assertNoPendingAppend(request:RequestContext,run:WritingRun,intents=this.intents(request,run)){
  // 旧 export_id 或另起 run 也不能绕过同一内容卡的未完成尝试。
  const paths=new Set(intents.flatMap(intent=>intent.target_path?[intent.target_path]:[]));
  if(run.export_target)paths.add(vaultFile(this.flow.context,run.export_target.relative_path));
  for(const intent of this.intents(request)){
   if(intent.state!=='prepared'||!intent.target_path||!paths.has(intent.target_path))continue;
   const journal=this.loadJournal(intent);
   if(journal){this.validateIntent(request,intent.run_id===run.id?run:this.flow.raw(request,intent.run_id),intent);this.recoverAppend(intent,journal);}
  }
 }
 private currentTarget(run:WritingRun):WritingTarget {
  const frozen=run.export_target,target=frozen&&registeredTargets(this.flow.context).find(t=>t.id===frozen.id&&t.topic_id===run.topic_id&&t.document_id===run.document_id&&t.relative_path===frozen.relative_path);
  if(!target)throw new ContractError('INPUT_STALE','回写目标登记已变化');return target;
 }
 private assertTarget(run:WritingRun,intent:ExportIntent){
  const target=this.currentTarget(run);
  if(target.id!==intent.target_id||target.relative_path!==intent.relative_path||targetHash(target)!==intent.target_registration_sha256||vaultFile(this.flow.context,target.relative_path)!==intent.target_path)throw new ContractError('INPUT_STALE','固定回写目的地或目标登记已变化，请重新核对');
 }
 prepare(request:RequestContext,id:string,input:WritingExportAction){
  WritingExportActionSchema.parse(input);this.flow.raw(request,id);const op='writing-export.prepare:'+id,db=this.flow.context.db;
  return transaction(db,()=>{
   const replay=readIdempotent<JsonObject>(db,request,op,input);if(replay)return replay;const run=this.flow.raw(request,id);
   if(run.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','运行已经变化，重新核对回写版本');
   const allIntents=this.intents(request,run);this.assertNoPendingAppend(request,run,allIntents);
   const intents=input.export_id?[this.load(request,input.export_id)]:allIntents;
   // 追加后数据库回执可能尚未提交。重新准备可找回原意图，不再次追加，也不要求旧 run/head 仍当前。
   for(const intent of intents){
    this.validateIntent(request,run,intent);
    if(!intent.target_path){
     if(!run.export_target||intent.target_id!==run.export_target.id||intent.relative_path!==run.export_target.relative_path)continue;
     const target=this.currentTarget(run),path=vaultFile(this.flow.context,target.relative_path);
     if(sha256(readCard(path))!==intent.output_file_sha256)continue;
     intent.target_path=path;intent.target_registration_sha256=targetHash(target);this.save(intent);
    }
    if(intent.state==='prepared'){
     const journal=this.loadJournal(intent);
     if(journal)this.recoverAppend(intent,journal);
     if(journal||sha256(readCard(intent.target_path))===intent.output_file_sha256){const result=this.view(intent) as unknown as JsonObject;storeIdempotent(db,request,op,input,result);return result;}
    }
   }
   if(run.phase!=='awaiting_user'||!run.adopted_revision_id||!run.export_target)throw new ContractError('VALIDATION_ERROR','先完成审读决定并选择已登记的内容卡');
   const target=this.currentTarget(run),path=vaultFile(this.flow.context,target.relative_path);
   assertRevisionExpected(getDocumentRow(db,request.workspace_id,run.document_id),run.adopted_revision_id);
   const current=readCard(path),text=this.flow.generation.revision(request,run.document_id,run.adopted_revision_id).text;
   const existing=allIntents.find(intent=>intent.revision_id===run.adopted_revision_id&&intent.target_id===target.id&&intent.relative_path===target.relative_path&&intent.target_path===path&&(intent.state==='committed'||(intent.run_version===run.version&&intent.expected_file_sha256===sha256(current))));
   if(existing){this.assertTarget(run,existing);const result=this.view(existing) as unknown as JsonObject;storeIdempotent(db,request,op,input,result);return result;}
   const fixed={run_id:run.id,revision_id:run.adopted_revision_id,text};
   if(current.includes(marker(fixed)))throw new ContractError('REVISION_CONFLICT','内容卡已有本次正文且后来发生变化；固定回写意图保留，请核对人工内容');
   const content=current+appendBlock(fixed);
   if(Buffer.byteLength(content)>maxCardBytes)throw new ContractError('VALIDATION_ERROR','回写后的内容卡超过可读回核对的大小');
   const intent:ExportIntent={id:randomUUID(),run_id:run.id,run_version:run.version,document_id:run.document_id,revision_id:run.adopted_revision_id,target_id:target.id,relative_path:target.relative_path,target_path:path,target_registration_sha256:targetHash(target),expected_file_sha256:sha256(current),output_file_sha256:sha256(content),text_sha256:sha256(text),text,full_content:content,created_at:new Date().toISOString(),state:'prepared'};
   this.save(intent);const result=this.view(intent) as unknown as JsonObject;storeIdempotent(db,request,op,input,result);return result;
  });
 }
 private write(intent:ExportIntent,run:WritingRun){
  const path=intent.target_path!,fd=openCard(path,constants.O_RDWR|constants.O_APPEND);
  try{
   this.assertTarget(run,intent);
   const {bytes,info}=readDescriptor(path,fd);
   if(sha256(bytes)!==intent.expected_file_sha256)throw new ContractError('REVISION_CONFLICT','内容卡发生人工修改，未覆盖；请重新准备');
   const journal:AppendJournal={intent_sha256:this.journalBinding(intent),dev:info.dev,ino:info.ino,state:'attempted'};
   // 先持久记录一次尝试。中断、零写入或短写都不能被新 prepare 绕过而再次追加。
   this.saveJournal(intent,journal,true);
   assertDescriptor(path,fd,info);
   const addition=Buffer.from(appendBlock(intent));
   // O_APPEND 只在这一个 descriptor 上写一次；检查与写入间的人工追加保留在正文块之前。
   // 它不提供不合作编辑器的 filesystem CAS，人工替换文件由后续 dev/ino 核对拒绝成功。
   const written=writeSync(fd,addition,0,addition.length,null);fsyncSync(fd);
   if(written!==addition.length)throw new ContractError('STORAGE_UNAVAILABLE','追加写入未确认完整，现场已保留待人工核对；未自动重写',{export_id:intent.id,recovery_state:'needs_attention'});
   this.assertTarget(run,intent);
   return this.verifyJournal(intent,journal,fd);
  }finally{closeSync(fd);}
 }
 commit(request:RequestContext,id:string,input:WritingExportAction){
  WritingExportActionSchema.parse(input);this.flow.raw(request,id);const db=this.flow.context.db,op='writing-export.commit:'+id;
  // 持有 SQLite 写事务直至回执落下，避免其他工作台动作插入写文件与保存运行之间；崩溃仍由持久意图恢复。
  return transaction(db,()=>{
   const replay=readIdempotent<JsonObject>(db,request,op,input);if(replay)return replay;
   if(!input.export_id)throw new ContractError('VALIDATION_ERROR','先准备具体回写内容');
   const run=this.flow.raw(request,id),intent=this.load(request,input.export_id);this.validateIntent(request,run,intent);
   if(intent.state==='committed'){const result=this.receipt(intent);storeIdempotent(db,request,op,input,result);return result;}
   if(!intent.target_path||!isAbsolute(intent.target_path)||!intent.target_registration_sha256)throw new ContractError('INPUT_STALE','旧回写意图没有固定目的地，请重新准备并核对');
   this.assertNoPendingAppend(request,run);
   const journal=this.loadJournal(intent);let verified:JsonObject;
   if(journal)verified=this.recoverAppend(intent,journal);
   else{
    const current=readCard(intent.target_path),hash=sha256(current);
    if(hash!==intent.output_file_sha256){
     if(run.version!==input.expected_version||run.version!==intent.run_version||run.phase!=='awaiting_user'||run.adopted_revision_id!==intent.revision_id)throw new ContractError('VERSION_CONFLICT','准备回写后运行已变化，文件尚未写入');
     assertRevisionExpected(getDocumentRow(db,request.workspace_id,run.document_id),intent.revision_id);this.assertTarget(run,intent);
     if(hash!==intent.expected_file_sha256)throw new ContractError('REVISION_CONFLICT','内容卡在准备后被人工修改，未覆盖；请重新准备');
     verified=this.write(intent,run);
    }else{
     // 兼容旧整卡输出已完成、SQLite 回执未提交的意图；此分支不写文件。
     verifyAppend(intent,Buffer.from(current));syncDirectory(intent.target_path);
     verified=this.receipt({...intent,committed_at:new Date().toISOString()});
    }
   }
   const fresh=this.flow.raw(request,id),existing=fresh.exports.find(receipt=>receipt.export_id===intent.id||(receipt.revision_id===intent.revision_id&&receipt.target_id===intent.target_id&&receipt.relative_path===intent.relative_path&&receipt.file_sha256===verified.file_sha256));
   intent.state='committed';intent.committed_at=typeof existing?.committed_at==='string'?existing.committed_at:String(verified.committed_at);intent.receipt=existing??verified;this.save(intent);
   if(!existing){fresh.exports.push(intent.receipt);fresh.version++;this.flow.save(fresh);}
   storeIdempotent(db,request,op,input,intent.receipt);return intent.receipt;
  });
 }
}
