import {readFileSync} from 'node:fs';
import {getJob,getAttempt} from '../../../packages/storage/src/jobs/index.ts';
import {verifyImageAsset} from '../../../packages/domain/src/result-commit/image.ts';
import {readImageReceipt} from '../../../packages/domain/src/artifact-execution/image.ts';
import {decode,metadata} from '../../../packages/adapters/src/media/render/index.ts';
import type {ApplicationContext} from '../../../packages/domain/src/ports/index.ts';
import type {GeneratedAssetOutput} from '../../../packages/contracts/src/index.ts';
import type {ImageEvidence} from './runner.ts';
export async function verifyReady(context:ApplicationContext,jobId:string,signal:AbortSignal,refresh:(assetId:string)=>Promise<boolean>):Promise<ImageEvidence>{
 const job=getJob(context.db,context.identity.workspace_id,jobId);if(job.state!=='succeeded')throw new Error('Job not succeeded');
 const row=context.db.prepare("SELECT attempt_id,output_payload FROM result_receipts WHERE workspace_id=? AND job_id=? AND state='committed'").get(job.workspace_id,jobId);if(!row)throw new Error('No committed receipt');
 const outputs=JSON.parse(String(row.output_payload)).typed_output?.generated_assets as GeneratedAssetOutput[];if(!Array.isArray(outputs)||outputs.length!==1)throw new Error('Expected one committed image');
 const out=outputs[0]!,attempt=getAttempt(context.db,job.workspace_id,String(row.attempt_id)),verified=verifyImageAsset(context,job,attempt,out),receipt=readImageReceipt(context,jobId,job.input_hash),native=receipt.result!.native;
 if(verified.manifest.provider!=='codex'||!Array.isArray(native.image_item_ids)||native.image_item_ids.length!==1||typeof native.image_item_ids[0]!=='string'||native.native_state!=='completed'||native.observed_image_calls!==1||typeof native.thread_id!=='string'||typeof native.turn_id!=='string')throw new Error('Original completed typed Codex image absent');
 const asset=context.db.prepare("SELECT status,sha256,size_bytes FROM assets WHERE workspace_id=? AND id=? AND job_id=?").get(job.workspace_id,out.asset_id,jobId);if(!asset||asset.status!=='ready'||asset.sha256!==verified.manifest.file_sha256||Number(asset.size_bytes)!==readFileSync(verified.file_path).length)throw new Error('Ready bytes missing');
 await decode(verified.file_path,{signal});const info=await metadata(verified.file_path,{signal}),streams=info.streams as Array<{codec_type?:string;width?:number;height?:number}>;if(!streams?.some(s=>s.codec_type==='video'&&s.width===verified.manifest.width&&s.height===verified.manifest.height))throw new Error('Decoded dimensions mismatch');
 if(!await refresh(out.asset_id))throw new Error('Refreshed ready image not readable');
 return{workspace_id:job.workspace_id,topic_id:job.target_id!,job_id:jobId,attempt_id:attempt.id,attempt_generation:attempt.attempt_generation,input_hash:job.input_hash,thread_id:native.thread_id,turn_id:native.turn_id,asset_id:out.asset_id,image_item_ids:native.image_item_ids as string[],file_path:verified.file_path,mime:verified.manifest.mime as 'image/png'|'image/jpeg',bytes:verified.manifest.size_bytes,sha256:verified.manifest.file_sha256,width:verified.manifest.width,height:verified.manifest.height,fully_decoded:true,ready:true,committed:true,refresh_readable:true,native_proof_verified:true};
}
