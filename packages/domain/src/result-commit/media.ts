import {createHash} from 'node:crypto';
import {constants,openSync,readSync,closeSync,fstatSync,lstatSync,readFileSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {ContractError,type ArtifactOutput,type ArtifactManifest,type FrozenPlanInput,type JobsRow,type JobAttemptsRow} from '@workbench/contracts';
import type {ApplicationContext} from '../ports/index.ts';
import {canonicalJson} from '@workbench/storage/connection';
import {workspaceSettings} from '@workbench/storage/settings';
const invalid=(reason:string):never=>{throw new ContractError('STORAGE_UNAVAILABLE','needs_repair：'+reason);};
const hashPattern=/^[0-9a-f]{64}$/;
export function validateArtifacts(value:unknown,job:JobsRow):asserts value is ArtifactOutput[] {
  if(job.kind!=='media_generate'||job.execution_mode!=='programmatic'||!Array.isArray(value)||value.length!==1)throw new ContractError('VALIDATION_ERROR','媒体输出只能来自单个程序媒体任务');
  const keys=['artifact_id','variant_id','variant_revision_id','content_plan_revision_id','production_plan_revision_id','manifest_path','sha256','kind','producer_version'];
  for(const item of value){if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).length!==keys.length||keys.some(k=>!(k in item)))throw new ContractError('VALIDATION_ERROR','媒体输出字段不符');
    const out=item as ArtifactOutput;if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(out.artifact_id)||!hashPattern.test(out.sha256)||keys.filter(k=>!k.endsWith('_plan_revision_id')).some(k=>typeof (item as Record<string,unknown>)[k]!=='string'||!(item as Record<string,unknown>)[k])||[out.content_plan_revision_id,out.production_plan_revision_id].some(v=>v!==null&&(typeof v!=='string'||!v)))throw new ContractError('VALIDATION_ERROR','媒体输出身份或hash无效');}
}
export function controlledPath(root:string,path:string):string {
  const absolute=resolve(path),rel=relative(resolve(root),absolute);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))return invalid('媒体路径越界');
  let current=resolve(root);if(lstatSync(current).isSymbolicLink())return invalid('媒体根目录是符号链接');
  for(const part of rel.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())return invalid('媒体路径含符号链接');}
  return absolute;
}
export function verifiedFileHash(path:string):{sha256:string;size:number}{const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=fstatSync(fd);if(!before.isFile())return invalid('媒体不是普通文件');const hash=createHash('sha256'),chunk=Buffer.allocUnsafe(1024*1024);let bytes=0,n:number;while((n=readSync(fd,chunk,0,chunk.length,null))>0){hash.update(chunk.subarray(0,n));bytes+=n;}const after=fstatSync(fd);if(bytes!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)return invalid('媒体核验时发生变化');return{sha256:hash.digest('hex'),size:bytes};}finally{closeSync(fd);}}
function withoutPaths(value:unknown):unknown {if(Array.isArray(value))return value.map(withoutPaths);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='file_path'&&key!=='resolved_texts').map(([key,v])=>[key,withoutPaths(v)]));return value;}
export function verifyArtifact(context:ApplicationContext,job:JobsRow,attempt:JobAttemptsRow,output:ArtifactOutput):ArtifactManifest {
  const task=JSON.parse(job.input_manifest),plan=task.frozen_input as FrozenPlanInput;
  if(task.schema_version!=='wp19-media/1'||task.operation!=='render'||task.mode!=='none'||!plan||plan.workspace_id!==job.workspace_id||job.target_id!==plan.plan_id)return invalid('媒体任务没有固定制作输入');
  const root=join(workspaceSettings(context.db,job.workspace_id).paths.media_root,'artifacts',output.artifact_id),expected=join(root,'manifest.json');
  if(resolve(output.manifest_path)!==resolve(expected))return invalid('成品清单位置与ID不符');
  const path=controlledPath(workspaceSettings(context.db,job.workspace_id).paths.media_root,expected),bytes=verifiedFileHash(path);
  if(bytes.sha256!==output.sha256||bytes.size>8*1024*1024)return invalid('成品清单hash或大小不符');
  const m=JSON.parse(readFileSync(path,'utf8')) as ArtifactManifest;
  if(m.schema_version!=='artifact-manifest.v1'||m.artifact_id!==output.artifact_id||m.workspace_id!==job.workspace_id||m.job_id!==job.id||m.attempt_id!==attempt.id||m.attempt_generation!==attempt.attempt_generation)return invalid('成品任务或代次归属不符');
  const bindings={variant_id:plan.variant_id,variant_revision_id:plan.variant_revision_id,content_plan_revision_id:plan.plan_kind==='content'?plan.plan_revision_id:null,production_plan_revision_id:plan.plan_kind==='production'?plan.plan_revision_id:null};
  for(const [key,value] of Object.entries(bindings))if(m[key as keyof ArtifactManifest]!==value||output[key as keyof ArtifactOutput]!==value)return invalid('成品与冻结版本不符');
  for(const key of ['topic_id','plan_id','input_hash','script_revision_id','core_revision_id','core_approval_id','source_preparation_revision_id','platform','format'] as const)if(m[key]!==plan[key])return invalid('成品固定引用不符');
  if(m.mode!==task.render_mode||m.status!==(m.mode==='export'?'export_ready':'preview_ready')||m.kind!==output.kind||m.producer_version!==output.producer_version||canonicalJson(m.renderer)!==canonicalJson(plan.renderer)||canonicalJson(m.input_plan)!==canonicalJson(withoutPaths(plan)))return invalid('成品执行清单与固定输入不符');
  const table=plan.plan_kind==='content'?'content_plan_revisions':'production_plan_revisions',stored=context.db.prepare(`SELECT input_hash,input_manifest FROM ${table} WHERE workspace_id=? AND id=? AND plan_id=?`).get(job.workspace_id,plan.plan_revision_id,plan.plan_id);
  if(!stored||stored.input_hash!==plan.input_hash||stored.input_manifest!==canonicalJson(plan))return invalid('制作修订未持久固定');
  if(!Array.isArray(m.files)||!m.files.length||new Set(m.files.map(f=>f.relative_path)).size!==m.files.length||new Set(m.files.map(f=>f.file_ref)).size!==m.files.length)return invalid('成品文件集合不完整');
  for(const file of m.files){if(typeof file.relative_path!=='string'||isAbsolute(file.relative_path)||file.relative_path.split('/').some(v=>!v||v==='..'||v==='.')||file.relative_path==='manifest.json'||!hashPattern.test(file.sha256)||!Number.isSafeInteger(file.size_bytes)||file.size_bytes<0||typeof file.mime!=='string'||file.file_ref!==createHash('sha256').update(output.artifact_id+'\0'+file.relative_path).digest('hex'))return invalid('成品文件引用非法');const actual=verifiedFileHash(controlledPath(root,join(root,file.relative_path)));if(actual.sha256!==file.sha256||actual.size!==file.size_bytes)return invalid('成品文件hash或大小不符');}
  if(m.publishable!==false||m.producer_version!=='wp19-local-render/1')return invalid('当前本地渲染器不能声明真实平台可发布');
  return m;
}
