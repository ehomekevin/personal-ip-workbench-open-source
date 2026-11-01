import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {ContractError,type GeneratedAssetOutput,type JobsRow,type JobAttemptsRow} from '@workbench/contracts';
import {canonicalJson,inputHash} from '@workbench/storage/connection';
import {workspaceSettings} from '@workbench/storage/settings';
import type {ApplicationContext} from '../ports/index.ts';
import {readImageReceipt,verifyImageTerminalProof,assertCurrentImageInputs,publicImageNative,compactImageNative,type FrozenImageInput,type ImageAssetManifest} from '../artifact-execution/image.ts';
import {controlledPath,verifiedFileHash} from './media.ts';
export function validateImageAssets(value:unknown,job:JobsRow):asserts value is GeneratedAssetOutput[]{
  const body=JSON.parse(job.input_manifest);if(job.kind!=='media_generate'||job.execution_mode!=='programmatic'||body.operation!=='image_provider'||!Array.isArray(value)||value.length!==1)throw new ContractError('VALIDATION_ERROR','图片结果只能来自单个持久程序图像任务');
  const out=value[0] as GeneratedAssetOutput;if(!out||Object.keys(out).length!==3||!['asset_id','manifest_path','sha256'].every(key=>typeof (out as unknown as Record<string,unknown>)[key]==='string')||!/^[a-f0-9-]{36}$/.test(out.asset_id)||!/^[a-f0-9]{64}$/.test(out.sha256))throw new ContractError('VALIDATION_ERROR','图片输出身份无效');
}
export function verifyImageAsset(context:ApplicationContext,job:JobsRow,attempt:JobAttemptsRow,out:GeneratedAssetOutput){
  return verifyImageAssetBytes(context,job,attempt,out,true);
}
// A historical ready image is verified against its committed SQL receipt and immutable
// input/native/files. Current article freshness governs adoption, never historical reads.
export function verifyCommittedImageAsset(context:ApplicationContext,job:JobsRow,attempt:JobAttemptsRow,out:GeneratedAssetOutput){
  const committed=context.db.prepare("SELECT j.state,j.input_hash,j.cancel_requested_at,r.output_payload,a.file_path,a.sha256,a.size_bytes,a.generation_metadata FROM jobs j JOIN result_receipts r ON r.workspace_id=j.workspace_id AND r.job_id=j.id JOIN assets a ON a.workspace_id=j.workspace_id AND a.job_id=j.id WHERE j.workspace_id=? AND j.id=? AND j.state='succeeded' AND r.state='committed' AND r.attempt_id=? AND r.attempt_generation=? AND r.input_hash=j.input_hash AND a.id=? AND a.kind='image' AND a.status='ready'").get(job.workspace_id,job.id,attempt.id,attempt.attempt_generation,out.asset_id);
  if(!committed||committed.cancel_requested_at||committed.input_hash!==job.input_hash||job.state!=='succeeded')throw new ContractError('STORAGE_UNAVAILABLE','已保存图片缺少对应的成功主存收据');
  const outputs=JSON.parse(String(committed.output_payload)).typed_output?.generated_assets;validateImageAssets(outputs,job);
  if(canonicalJson(outputs[0])!==canonicalJson(out))throw new ContractError('STORAGE_UNAVAILABLE','读取图片与已提交输出不符');
  const verified=verifyImageAssetBytes(context,job,attempt,out,false);
  if(committed.file_path!==verified.file_path||committed.sha256!==verified.manifest.file_sha256||Number(committed.size_bytes)!==verified.manifest.size_bytes||canonicalJson(JSON.parse(String(committed.generation_metadata)))!==canonicalJson(verified.manifest.metadata))throw new ContractError('STORAGE_UNAVAILABLE','已保存图片文件与主存素材不符');
  return verified;
}
function verifyImageAssetBytes(context:ApplicationContext,job:JobsRow,attempt:JobAttemptsRow,out:GeneratedAssetOutput,requireCurrentInputs:boolean){
  const bad=(message:string):never=>{throw new ContractError('STORAGE_UNAVAILABLE','needs_repair：'+message);},body=JSON.parse(job.input_manifest),image=body.image as FrozenImageInput;
  if(body.schema_version!=='image-provider/1'||body.mode!=='none'||inputHash(body)!==job.input_hash||job.target_id!==image.topic_id)return bad('图片冻结输入不符');
  if(requireCurrentInputs)assertCurrentImageInputs(context,image);
  const media=workspaceSettings(context.db,job.workspace_id).paths.media_root,root=join(media,'image-provider',out.asset_id),path=join(root,'manifest.json');if(resolve(out.manifest_path)!==path)return bad('图片清单路径不符');
  const actual=verifiedFileHash(controlledPath(media,path));if(actual.sha256!==out.sha256||actual.size>1024*1024)return bad('图片清单hash不符');
  const m=JSON.parse(readFileSync(path,'utf8')) as ImageAssetManifest;
  if(m.schema_version!=='image-provider-asset/1'||m.asset_id!==out.asset_id||m.workspace_id!==job.workspace_id||m.job_id!==job.id||m.topic_id!==image.topic_id||m.attempt_id!==attempt.id||m.attempt_generation!==attempt.attempt_generation||m.input_hash!==job.input_hash||m.provider!==image.provider)return bad('图片任务代次与来源不符');
  const receipt=readImageReceipt(context,job.id,job.input_hash),result=receipt.result;
  verifyImageTerminalProof(context,job,attempt,receipt);
  if(receipt.state!=='result'||!result||result.model!==m.model||result.sha256!==m.file_sha256||result.size_bytes!==m.size_bytes||result.mime!==m.mime||result.width!==m.width||result.height!==m.height||canonicalJson(compactImageNative(result.native))!==canonicalJson(m.native))return bad('图片没有对应原提交结果');
  if(image.provider==='agy'&&m.model!=='gemini-3.1-flash-image')return bad('AGY返回图像模型与已准入实际模型不符');
  if(m.mime!=='image/png'&&m.mime!=='image/jpeg'||m.file_name!==(m.mime==='image/png'?'image.png':'image.jpg')||m.width<=0||m.height<=0)return bad('图片MIME、尺寸或文件名不符');
  const publicNative=publicImageNative(m.native);
  const expected={source_kind:'image_provider',provider:image.provider,operation:image.operation,purpose:image.purpose,prompt:image.prompt,model:m.model,native:publicNative,reference_assets:image.reference_assets.map(r=>({asset_id:r.asset_id,sha256:r.sha256})),parent_asset_id:image.parent_asset_id,brand_manifest_sha256:image.brand_manifest_sha256,brand_manifest:image.brand_manifest,document_revision_id:image.document_revision_id,plan_revision_id:image.plan_revision_id,config_version:image.config_version,job_id:job.id,version_id:out.asset_id,full_decode:true,actual_usage:result.usage,actual_cost:null,adoption:'pending',publishable:false,...(image.size_request?{requested_size:image.size_request,accepted_image_parameters:result.native.accepted_image_parameters??null}:{}),...(image.studio_binding?{studio_binding:image.studio_binding}:{})};
  if(canonicalJson(m.metadata)!==canonicalJson(expected))return bad('图片输入、品牌、版本或人工采用元信息不符');
  const file=controlledPath(root,join(root,m.file_name)),bytes=verifiedFileHash(file);if(bytes.sha256!==m.file_sha256||bytes.size!==m.size_bytes)return bad('图片文件hash不符');
  const prefix=readFileSync(file).subarray(0,8);if(m.mime==='image/png'&&!prefix.equals(Buffer.from([137,80,78,71,13,10,26,10]))||m.mime==='image/jpeg'&&(prefix[0]!==255||prefix[1]!==216||prefix[2]!==255))return bad('图片实际格式不符');
  return{manifest:m,file_path:file};
}
