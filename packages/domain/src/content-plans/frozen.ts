import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import { ContractError, type RequestContext, type VariantsRow, type DocumentRevisionsRow, type AssetsRow, type Sha256 } from '@workbench/contracts';
import {inputHash} from '@workbench/storage/connection';
import {getRevisionRow} from '@workbench/storage/revisions';
import {ManagedFiles,parseRevision} from '@workbench/storage/files';
import {workspaceSettings} from '@workbench/storage/settings';
import type {ApplicationContext} from '../ports/index.ts';
import type {FrozenPlanInput,FrozenTextRef,FrozenAssetRef,RendererIdentity,ResolvedPlanInput} from './types.ts';
export function waiting(message:string,details:Record<string,string>={}):never {throw new ContractError('VALIDATION_ERROR',message,{state:'waiting_input',...details});}
export function variantBinding(context:ApplicationContext,workspaceId:string,id:string,revisionId:string) {
  const row=context.db.prepare('SELECT * FROM variants WHERE workspace_id=? AND id=?').get(workspaceId,id);if(!row)waiting('平台版本引用不存在');const variant=row as unknown as VariantsRow;
  let revision:DocumentRevisionsRow;try{revision=getRevisionRow(context.db,workspaceId,revisionId,variant.document_id);}catch{waiting('平台文字修订引用不存在或归属不同');}
  if(!revision.based_on_core_revision_id)waiting('平台稿缺少确切核心修订');
  const approval=context.db.prepare('SELECT id FROM core_approvals WHERE workspace_id=? AND topic_id=? AND revision_id=? ORDER BY created_at,id LIMIT 1').get(workspaceId,variant.topic_id,revision.based_on_core_revision_id);
  if(!approval)waiting('平台稿引用的核心修订没有确认记录');
  return {variant,revision,core_revision_id:revision.based_on_core_revision_id,core_approval_id:String(approval.id)};
}
export function freezeText(context:ApplicationContext,workspaceId:string,id:string,purpose:string,topicId:string,variantId:string):FrozenTextRef {
  let row:DocumentRevisionsRow;try{row=getRevisionRow(context.db,workspaceId,id);}catch{waiting('文字修订引用不存在',{revision_id:id});}
  const doc=context.db.prepare('SELECT owner_entity_id FROM documents WHERE workspace_id=? AND id=?').get(workspaceId,row.document_id);
  const topic=context.db.prepare('SELECT core_document_id FROM topics WHERE workspace_id=? AND id=?').get(workspaceId,topicId);
  const variant=context.db.prepare('SELECT document_id FROM variants WHERE workspace_id=? AND id=?').get(workspaceId,variantId);
  if(row.document_id!==topic?.core_document_id && row.document_id!==variant?.document_id && doc?.owner_entity_id!==topicId && doc?.owner_entity_id!==variantId)waiting('文字修订不属于本主题或平台稿');
  return {revision_id:row.id,document_id:row.document_id,sha256:row.sha256,file_path:row.file_path,purpose};
}
export function freezeAsset(context:ApplicationContext,workspaceId:string,id:string,hash?:string):FrozenAssetRef {
  const row=context.db.prepare('SELECT * FROM assets WHERE workspace_id=? AND id=?').get(workspaceId,id) as unknown as AssetsRow|undefined;
  if(!row||!['ready','referenced'].includes(row.status))waiting('素材引用不可用',{asset_id:id});if(hash!==undefined&&hash!==row.sha256)waiting('素材引用 hash 不匹配',{asset_id:id});
  return {asset_id:row.id,sha256:row.sha256,file_path:row.file_path,mime:row.mime,size_bytes:row.size_bytes,duration_ms:row.duration_ms,kind:row.kind};
}
export function seal(input:Omit<FrozenPlanInput,'input_hash'>):FrozenPlanInput {return {...input,input_hash:inputHash(input)};}
export function readFrozen(raw:string|null|undefined,hash:string,identity:{workspace_id:string;plan_id:string;plan_revision_id:string}):FrozenPlanInput {
  if(!raw)waiting('历史计划没有完整冻结输入，须显式建立新修订');let parsed:FrozenPlanInput;try{parsed=JSON.parse(raw) as FrozenPlanInput;}catch{waiting('计划冻结输入损坏');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))waiting('计划冻结输入必须为对象');const {input_hash,...rest}=parsed;if(parsed.schema_version!=='plan-input.v1'||input_hash!==hash||inputHash(rest)!==hash||parsed.workspace_id!==identity.workspace_id||parsed.plan_id!==identity.plan_id||parsed.plan_revision_id!==identity.plan_revision_id)waiting('计划冻结输入身份或 hash 无效');return structuredClone(parsed);
}
export async function resolveFrozen(context:ApplicationContext,request:RequestContext,input:FrozenPlanInput,options?:{preset:string;renderer:RendererIdentity}):Promise<ResolvedPlanInput> {
  if(options&&(options.preset!==input.preset||options.renderer.id!==input.renderer.id||options.renderer.version!==input.renderer.version))waiting('渲染参数与固定计划不兼容');
  const files=new ManagedFiles(workspaceSettings(context.db,request.workspace_id).paths);
  const resolved_texts=input.texts.map(ref=>{const row=getRevisionRow(context.db,request.workspace_id,ref.revision_id,ref.document_id);if(row.sha256!==ref.sha256||row.file_path!==ref.file_path)waiting('固定文字修订元信息改变');try{const read=files.readRevision(ref.file_path,ref.sha256 as Sha256,{workspace_id:request.workspace_id,document_id:ref.document_id,revision_id:ref.revision_id});return {...ref,text:parseRevision(read.content).text};}catch{waiting('固定文字文件不可读或 hash 不匹配',{revision_id:ref.revision_id});}});
  for(const asset of input.assets){const row=context.db.prepare('SELECT file_path,sha256,size_bytes FROM assets WHERE workspace_id=? AND id=?').get(request.workspace_id,asset.asset_id);if(!row||row.file_path!==asset.file_path||row.sha256!==asset.sha256||Number(row.size_bytes)!==asset.size_bytes)waiting('固定素材登记发生变化',{asset_id:asset.asset_id});try{const hash=createHash('sha256');let size=0;for await(const chunk of createReadStream(asset.file_path)){hash.update(chunk);size+=chunk.length;}if(hash.digest('hex')!==asset.sha256||size!==asset.size_bytes)waiting('固定素材 hash 不匹配',{asset_id:asset.asset_id});}catch{waiting('固定素材缺失或 hash 不匹配',{asset_id:asset.asset_id});}}
  for(const unit of input.units){if(unit.text_segment){const text=resolved_texts.find(ref=>ref.revision_id===unit.text_revision_id)?.text;if(text===undefined||unit.text_segment.end>text.length)waiting('文字区段超出固定正文');}}
  return {...input,resolved_texts};
}
