import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ContractError, type GeneratedAssetOutput, type JobsRow, type JobAttemptsRow } from '@workbench/contracts';
import { workspaceSettings } from '@workbench/storage/settings';
import { canonicalJson, inputHash } from '@workbench/storage/connection';
import type { ApplicationContext } from '../ports/index.ts';
import type { VoiceAssetManifest, VoiceInput } from '../artifact-execution/voice.ts';
import { controlledPath, verifiedFileHash } from './media.ts';

export function validateVoiceAssets(value:unknown,job:JobsRow):asserts value is GeneratedAssetOutput[]{
  const body=JSON.parse(job.input_manifest);if(job.kind!=='media_generate'||job.execution_mode!=='programmatic'||body.operation!=='h3_voice'||!Array.isArray(value)||value.length!==1)throw new ContractError('VALIDATION_ERROR','声音素材只能来自单段声音程序任务');
  const out=value[0] as GeneratedAssetOutput;if(!out||Object.keys(out).length!==3||!['asset_id','manifest_path','sha256'].every(key=>typeof (out as unknown as Record<string,unknown>)[key]==='string')||!/^[a-f0-9-]{36}$/.test(out.asset_id)||!/^[a-f0-9]{64}$/.test(out.sha256))throw new ContractError('VALIDATION_ERROR','声音素材输出身份无效');
}
export function verifyVoiceAsset(context:ApplicationContext,job:JobsRow,attempt:JobAttemptsRow,out:GeneratedAssetOutput){
  const invalid=(message:string):never=>{throw new ContractError('STORAGE_UNAVAILABLE','needs_repair：'+message);},voice=(JSON.parse(job.input_manifest) as {voice:VoiceInput}).voice,media=workspaceSettings(context.db,job.workspace_id).paths.media_root,root=join(media,'h3-voice',out.asset_id),path=join(root,'manifest.json');
  if(resolve(out.manifest_path)!==path)return invalid('声音清单位置不符');const actual=verifiedFileHash(controlledPath(media,path));if(actual.sha256!==out.sha256||actual.size>65536)return invalid('声音清单 hash 不符');
  const m=JSON.parse(readFileSync(path,'utf8')) as VoiceAssetManifest;
  if(m.schema_version!=='h3-voice-asset/1'||m.asset_id!==out.asset_id||m.workspace_id!==job.workspace_id||m.topic_id!==voice.topic_id||job.target_id!==voice.topic_id||m.job_id!==job.id||m.attempt_id!==attempt.id||m.attempt_generation!==attempt.attempt_generation||m.input_hash!==job.input_hash||!m.provider_id||voice.provider_id&&m.provider_id!==voice.provider_id)return invalid('声音任务与代次不符');
  const state=workspaceSettings(context.db,job.workspace_id).paths.state_root,receipt=JSON.parse(readFileSync(controlledPath(state,join(state,'h3-voice',voice.original_job_id||job.id,'provider-receipt.json')),'utf8')) as {tag:string;graph_hash:string;state:string;provider_id:string|null};
  if(receipt.tag!==voice.tag||receipt.graph_hash!==inputHash(voice.graph)||(!voice.provider_id&&(receipt.state!=='accepted'||receipt.provider_id!==m.provider_id)))return invalid('声音清单没有对应的原提交回执');
  const expected={source_kind:'h3_owner_reference',purpose:'口播声音试听',owner_voice:true,skill_name:voice.profile.skill_name,skill_sha256:voice.profile.skill_sha256,reference_sha256:voice.profile.reference_sha256,template_sha256:voice.profile.template_sha256,transcript:voice.transcript,frames:voice.frames,original_job_id:voice.original_job_id||job.id,provider_id:m.provider_id,full_decode:true,content_check:'not_run',listening:'pending',actual_cost:null};
  if(canonicalJson(m.metadata)!==canonicalJson(expected)||!Number.isSafeInteger(m.duration_ms)||m.duration_ms<=0)return invalid('声音来源或审听状态不符');
  const file=controlledPath(root,join(root,'audio.flac')),audio=verifiedFileHash(file);if(audio.sha256!==m.file_sha256||audio.size!==m.size_bytes)return invalid('声音文件 hash 或大小不符');
  return {manifest:m,file_path:file};
}
