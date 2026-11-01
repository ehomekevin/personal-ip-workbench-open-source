import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, stat, rename, unlink, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ContractError, type RequestContext, type JsonObject } from '@workbench/contracts';
import { metadata } from '@workbench/adapters/media/render';
import { assertRequestIdentity } from '../documents/index.ts';
import type { ApplicationContext } from '../ports/index.ts';
import { ensureManagedDirectory, safeManagedChild } from '@workbench/storage/files';
import { transaction } from '@workbench/storage/connection';
import { readIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import { workspaceSettings } from '@workbench/storage/settings';
import type { MediaImportMetadata, MediaProgress } from './types.ts';
export interface MediaImportResult { asset_id:string;sha256:string;status:'ready';size_bytes:number;deduplicated:boolean;metadata:JsonObject|null }
function readyCandidate(root:string,row:Record<string,unknown>,digest:string,size:number):boolean {
  let fd:number|undefined;try{const path=safeManagedChild(root,String(row.file_path));if(!statSync(path).isFile()||statSync(path).size!==size)return false;fd=openSync(path,'r');const hash=createHash('sha256'),chunk=Buffer.allocUnsafe(1024*1024);let count;while((count=readSync(fd,chunk,0,chunk.length,null))>0)hash.update(chunk.subarray(0,count));return hash.digest('hex')===digest;}catch{return false;}finally{if(fd!==undefined)closeSync(fd);}
}
async function syncDirectory(path:string){const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
export class MediaImporter {
  readonly context:ApplicationContext;constructor(context:ApplicationContext){this.context=context;}
  async importFile(request:RequestContext,source:AsyncIterable<Uint8Array>,input:MediaImportMetadata,options:{signal?:AbortSignal;onProgress?:(progress:MediaProgress)=>void;commit?:(result:MediaImportResult)=>void}={}):Promise<MediaImportResult> {
    assertRequestIdentity(this.context,request);const paths=workspaceSettings(this.context.db,request.workspace_id).paths;ensureManagedDirectory(paths.media_root);ensureManagedDirectory(paths.state_root);
    if(!input.kind||!input.mime||!request.idempotency_key)throw new ContractError('VALIDATION_ERROR','素材类型、MIME和Idempotency-Key必须提供');
    if(input.topic_id&&!this.context.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,input.topic_id))throw new ContractError('NOT_FOUND','素材主题不存在');
    const id=randomUUID(),root=safeManagedChild(paths.state_root,join(paths.state_root,'media-import-staging')),path=safeManagedChild(root,join(root,`${id}.asset`));await mkdir(root,{recursive:true});const handle=await open(path,'wx',0o600),hash=createHash('sha256'),begin=Date.now();let size=0,promoted:string|null=null,closed=false,committed=false,rejected=false;
    const progress=(phase:string)=>options.onProgress?.({phase,completed:size,total:input.total_bytes??null,unit:'bytes',elapsed_ms:Date.now()-begin});
    try {progress('staging');for await(const chunk of source){options.signal?.throwIfAborted();if(!(chunk instanceof Uint8Array))throw new ContractError('VALIDATION_ERROR','素材流chunk无效');for(let offset=0;offset<chunk.byteLength;offset+=1024*1024){const part=chunk.subarray(offset,Math.min(chunk.byteLength,offset+1024*1024));options.signal?.throwIfAborted();let written=0;while(written<part.byteLength){const value=await handle.write(part,written,part.byteLength-written,size+written);if(!value.bytesWritten)throw new ContractError('STORAGE_UNAVAILABLE','素材流写入停止');written+=value.bytesWritten;}hash.update(part);size+=part.byteLength;progress('staging');}}
      await handle.sync();await handle.close();closed=true;options.signal?.throwIfAborted();const digest=hash.digest('hex');if(input.expected_sha256&&input.expected_sha256!==digest)throw new ContractError('INPUT_STALE','上传素材hash与固定输入不同');if(input.total_bytes!==undefined&&input.total_bytes!==null&&input.total_bytes!==size)throw new ContractError('VALIDATION_ERROR','上传素材字节数不完整');
      const info=/^(image|audio|video)\//.test(input.mime)?await metadata(path,{signal:options.signal}):null;const fmt=info?.format as Record<string,unknown>|undefined,streams=info?.streams as Array<Record<string,unknown>>|undefined,video=streams?.find(s=>s.codec_type==='video');const duration=fmt?.duration===undefined?null:Math.round(Number(fmt.duration)*1000),dimensions=video?.width&&video?.height?{width:Number(video.width),height:Number(video.height)}:null;
      const frozen={...input,sha256:digest,size_bytes:size,duration_ms:duration,dimensions};const old=readIdempotent<MediaImportResult>(this.context.db,request,'media.import',frozen);if(old){await unlink(path);return old;}
      const candidates=()=>this.context.db.prepare("SELECT id,file_path,sha256 FROM assets WHERE workspace_id=? AND sha256=? AND size_bytes=? AND status='ready' ORDER BY created_at,id").all(request.workspace_id,digest,size);
      const row=candidates().find(candidate=>readyCandidate(paths.media_root,candidate,digest,size));
      if(!row){const assetRoot=safeManagedChild(paths.media_root,join(paths.media_root,id));await mkdir(assetRoot);const target=safeManagedChild(assetRoot,join(assetRoot,'original'));if((await stat(root)).dev!==(await stat(assetRoot)).dev)throw new ContractError('STORAGE_UNAVAILABLE','素材staging与媒体根必须同卷');await rename(path,target);promoted=target;await syncDirectory(assetRoot);await syncDirectory(paths.media_root);}
      options.signal?.throwIfAborted();progress('verified');const result=transaction(this.context.db,()=>{options.signal?.throwIfAborted();const replay=readIdempotent<MediaImportResult>(this.context.db,request,'media.import',frozen);if(replay)return replay;
        const current=candidates().find(candidate=>readyCandidate(paths.media_root,candidate,digest,size));const assetId=current?String(current.id):id;if(!current&&!promoted)throw new ContractError('INPUT_STALE','去重候选已不可达或hash变化，重新导入会使用新文件');
        if(!current)this.context.db.prepare("INSERT INTO assets(id,workspace_id,kind,origin,file_path,sha256,size_bytes,mime,duration_ms,dimensions,status,generation_metadata) VALUES (?,?,?,?,?,?,?,?,?,?,'ready',?)").run(id,request.workspace_id,input.kind,input.origin==='web'?'web':'import',promoted!,digest,size,input.mime,duration,dimensions?JSON.stringify(dimensions):null,JSON.stringify({source_kind:input.source_kind??'user_uploaded',purpose:input.purpose??'',is_user_footage:input.is_user_footage??false,actual_usage:null,actual_cost:null}));
        // 网络配图同一张图重复导入复用原资产，主题关联只保留一条。
        if(input.topic_id&&!(input.source_kind==='web_reference'&&this.context.db.prepare('SELECT id FROM topic_asset_links WHERE workspace_id=? AND topic_id=? AND asset_id=?').get(request.workspace_id,input.topic_id,assetId)))this.context.db.prepare('INSERT INTO topic_asset_links(id,workspace_id,topic_id,asset_id,purpose,evidence_kind) VALUES (?,?,?,?,?,?)').run(randomUUID(),request.workspace_id,input.topic_id,assetId,input.purpose??'',input.is_user_footage?'user_footage':'user_input');
        const result:MediaImportResult={asset_id:assetId,sha256:digest,status:'ready',size_bytes:size,deduplicated:!!current,metadata:info};
        // 调用方在同一事务内追加业务记录（如配图版本）；它拒绝时资产、主题关联与幂等记录一起回滚。
        if(options.commit){try{options.commit(result);}catch(error){rejected=true;throw error;}}storeIdempotent(this.context.db,request,'media.import',frozen,result);return result;});committed=true;progress('committed');if(row)await unlink(path);if(promoted&&result.asset_id!==id){const quarantine=safeManagedChild(paths.state_root,join(paths.state_root,'media-import-quarantine',id));await mkdir(quarantine,{recursive:true});await rename(promoted,join(quarantine,'deduplicated-copy'));await writeFile(join(quarantine,'trace.json'),JSON.stringify({state:'deduplicated',asset_id:result.asset_id,asset_associated:false,size_bytes:size})+'\n',{flag:'wx'});}return result;
    }catch(error){if(committed)throw error;if(!closed){await handle.close();closed=true;}const actual=promoted??path;
      // 业务拒绝（如版本冲突）不是导入故障：直接删除未提交文件，不留孤儿资产或隔离副本。
      if(rejected){await unlink(actual).catch(()=>{});if(promoted)await rm(dirname(promoted),{recursive:true,force:true});throw error;}if(existsSync(actual)){const quarantine=safeManagedChild(paths.state_root,join(paths.state_root,'media-import-quarantine',id));await mkdir(quarantine,{recursive:true});await rename(actual,join(quarantine,'uncommitted'));await writeFile(join(quarantine,'trace.json'),JSON.stringify({state:options.signal?.aborted?'cancelled':'waiting_input',copied_bytes:size,total_bytes:input.total_bytes??null,asset_associated:false,error:error instanceof Error?error.message:'IMPORT_FAILED'},null,2)+'\n',{flag:'wx'});}throw error;
    }finally{if(!closed)await handle.close();}
  }
}
