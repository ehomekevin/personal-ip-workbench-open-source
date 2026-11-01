import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,readSync,fstatSync,lstatSync,readdirSync,writeFileSync,chmodSync,fsyncSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {ContractError,type JsonObject} from '@workbench/contracts';
import {canonicalJson,sha256,transaction} from '@workbench/storage/connection';
import {safeManagedChild} from '@workbench/storage/files';
import {appendEvent,type ClaimedJob} from '@workbench/storage/jobs';
import type {ApplicationContext} from '../ports/index.ts';
import type {ArtifactManifest,ArtifactOutput} from './types.ts';

interface FileProof {relative_path:string;sha256:string;size_bytes:number}
export interface IsolationProof {
  schema_version:'wp19-isolation/1';workspace_id:string;job_id:string;attempt_id:string;
  attempt_generation:number;lease_owner:string;artifact_id:string;renderer_settled:true;
  manifest_sha256:string|null;files:FileProof[];reason:string;nonce:string;
}
const invalid=(message:string):never=>{throw new ContractError('STORAGE_UNAVAILABLE','needs_repair：'+message);};
const JSON_LIMIT=8*1024*1024;
export function present(path:string):boolean {return lstatSync(path,{throwIfNoEntry:false})!==undefined;}

// 实际文件逐块核验；只有有界JSON收集字节，解析和hash使用同一fd取得的字节。
function inspect(root:string,path:string,json=false):{sha256:string;size_bytes:number;bytes?:Buffer} {
  const safe=safeManagedChild(root,path);
  if(!present(safe))return invalid('隔离证明或实际文件缺失');
  const fd=openSync(safe,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=fstatSync(fd);
    if(!before.isFile())return invalid('隔离对象不是普通文件');
    if(json&&before.size>JSON_LIMIT)return invalid('隔离JSON超过允许大小');
    const hash=createHash('sha256'),chunk=Buffer.allocUnsafe(1024*1024),parts=json?[] as Buffer[]:undefined;
    let count,total=0;
    while((count=readSync(fd,chunk,0,chunk.length,null))>0){
      total+=count;if(json&&total>JSON_LIMIT)return invalid('隔离JSON读取时超过允许大小');
      hash.update(chunk.subarray(0,count));parts?.push(Buffer.from(chunk.subarray(0,count)));
    }
    const after=fstatSync(fd);
    if(total!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)
      return invalid('隔离核验时文件发生变化');
    return{sha256:hash.digest('hex'),size_bytes:total,...(parts?{bytes:Buffer.concat(parts)}:{})};
  } finally {closeSync(fd);}
}
function json<T>(bytes:Buffer):T {try{return JSON.parse(bytes.toString('utf8')) as T;}catch{return invalid('隔离JSON内容无效');}}
function snapshot(root:string,path=''):FileProof[] {
  if(!lstatSync(root).isDirectory())return invalid('隔离根不是普通目录');
  const files:FileProof[]=[];
  for(const entry of readdirSync(join(root,path),{withFileTypes:true})){
    const relative_path=path?path+'/'+entry.name:entry.name,target=safeManagedChild(root,join(root,relative_path));
    if(entry.isDirectory())files.push(...snapshot(root,relative_path));
    else if(entry.isFile()){
      if(relative_path!=='quarantine.json')files.push({relative_path,...inspect(root,target)});
    }else return invalid('隔离目录含链接或特殊文件');
  }
  return files.sort((a,b)=>a.relative_path.localeCompare(b.relative_path));
}
function event(context:ApplicationContext,claim:ClaimedJob,phase:string,artifactId:string):JsonObject|undefined {
  const rows=context.db.prepare("SELECT payload FROM job_events WHERE workspace_id=? AND job_id=? AND type='progress' AND attempt_no=? ORDER BY seq DESC")
    .all(claim.job.workspace_id,claim.job.id,claim.attempt.attempt_no);
  return rows.map(row=>JSON.parse(String(row.payload)) as JsonObject).find(payload=>payload.phase===phase&&payload.artifact_id===artifactId
    &&payload.attempt_id===claim.attempt.id&&payload.attempt_generation===claim.attempt.attempt_generation&&payload.lease_owner===claim.fence.lease_owner);
}

// 证明只能由本地执行层写入普通progress事件；客户端收据和checkpoint不是结束证明。
export function recordVerifiedOutput(context:ApplicationContext,claim:ClaimedJob,output:ArtifactOutput,files:ArtifactManifest['files']):void {
  transaction(context.db,()=>appendEvent(context.db,claim.job.workspace_id,claim.job.id,'progress',{
    phase:'media_verified_output',artifact_id:output.artifact_id,attempt_id:claim.attempt.id,
    attempt_generation:claim.attempt.attempt_generation,lease_owner:claim.fence.lease_owner,
    manifest_sha256:output.sha256,files_hash:sha256(canonicalJson(files)),renderer_settled:true
  },Date.now(),claim.attempt.attempt_no));
}
export function verifyRenderedOutput(context:ApplicationContext,claim:ClaimedJob,output:ArtifactOutput,root:string):void {
  const observed=event(context,claim,'media_verified_output',output.artifact_id);
  if(!observed||observed.renderer_settled!==true||observed.manifest_sha256!==output.sha256)
    return invalid('缺少本地执行器结束与输出hash证明');
  const actual=inspect(root,join(root,'manifest.json'),true);
  if(actual.sha256!==output.sha256)return invalid('撤销成品manifest hash不符');
  const manifest=json<ArtifactManifest>(actual.bytes!);
  if(manifest.workspace_id!==claim.job.workspace_id||manifest.job_id!==claim.job.id||manifest.attempt_id!==claim.attempt.id
    ||manifest.attempt_generation!==claim.attempt.attempt_generation||manifest.artifact_id!==output.artifact_id
    ||manifest.variant_id!==output.variant_id||manifest.variant_revision_id!==output.variant_revision_id
    ||manifest.content_plan_revision_id!==output.content_plan_revision_id||manifest.production_plan_revision_id!==output.production_plan_revision_id
    ||!Array.isArray(manifest.files)||!manifest.files.length||sha256(canonicalJson(manifest.files))!==observed.files_hash)
    return invalid('撤销成品归属/固定文件集合不符');
  for(const file of manifest.files){
    if(!file.relative_path||isAbsolute(file.relative_path)||file.relative_path.split('/').some(segment=>!segment||segment==='.'||segment==='..')
      ||file.relative_path==='manifest.json')return invalid('撤销成品文件路径无效');
    const value=inspect(root,join(root,file.relative_path));
    if(value.sha256!==file.sha256||value.size_bytes!==file.size_bytes)return invalid('撤销成品文件hash/大小不符');
  }
}
function flushDirectory(path:string):void {const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
export function recordIsolation(context:ApplicationContext,claim:ClaimedJob,artifactId:string,root:string,reason:string,manifestHash:string|null):boolean {
  const files=snapshot(root);if(!files.length)return false;
  const proof:IsolationProof={schema_version:'wp19-isolation/1',workspace_id:claim.job.workspace_id,job_id:claim.job.id,
    attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,lease_owner:claim.fence.lease_owner,
    artifact_id:artifactId,renderer_settled:true,manifest_sha256:manifestHash,files,reason,nonce:randomUUID()};
  const path=safeManagedChild(root,join(root,'quarantine.json')),bytes=canonicalJson(proof)+'\n';
  writeFileSync(path,bytes,{flag:'wx',mode:0o444});const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  chmodSync(path,0o444);flushDirectory(root);flushDirectory(dirname(root));
  // 先落实际文件标记，再用数据库事件绑定其hash；中断产生的无可信记录标记必须待修复。
  transaction(context.db,()=>appendEvent(context.db,claim.job.workspace_id,claim.job.id,'progress',{
    phase:'media_output_isolated',artifact_id:artifactId,attempt_id:claim.attempt.id,
    attempt_generation:claim.attempt.attempt_generation,lease_owner:claim.fence.lease_owner,
    proof_sha256:sha256(bytes),manifest_sha256:manifestHash,renderer_settled:true
  },Date.now(),claim.attempt.attempt_no));
  return true;
}
export function verifyIsolation(context:ApplicationContext,claim:ClaimedJob,artifactId:string,root:string,expectedManifestHash?:string):{proof_sha256:string;files_verified:number} {
  const marker=inspect(root,join(root,'quarantine.json'),true),observed=event(context,claim,'media_output_isolated',artifactId);
  if(!observed||observed.proof_sha256!==marker.sha256||observed.renderer_settled!==true)
    return invalid('隔离证明缺少可信记录或已篡改');
  const proof=json<IsolationProof>(marker.bytes!);
  if(proof.schema_version!=='wp19-isolation/1'||proof.workspace_id!==claim.job.workspace_id||proof.job_id!==claim.job.id
    ||proof.attempt_id!==claim.attempt.id||proof.attempt_generation!==claim.attempt.attempt_generation||proof.lease_owner!==claim.fence.lease_owner
    ||proof.artifact_id!==artifactId||proof.renderer_settled!==true||proof.manifest_sha256!==observed.manifest_sha256
    ||(expectedManifestHash!==undefined&&proof.manifest_sha256!==expectedManifestHash)||!Array.isArray(proof.files)||!proof.files.length)
    return invalid('隔离证明任务/代次/manifest hash不符');
  const files=snapshot(root);
  if(canonicalJson(files)!==canonicalJson(proof.files))return invalid('隔离实际文件集合或hash已变化');
  if(proof.manifest_sha256!==null&&files.find(file=>file.relative_path==='manifest.json')?.sha256!==proof.manifest_sha256)
    return invalid('隔离manifest与可信证明不符');
  return{proof_sha256:marker.sha256,files_verified:files.length};
}
