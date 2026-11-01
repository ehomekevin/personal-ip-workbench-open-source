import { ContractError } from './errors.ts';
import { objectSchema } from './validation.ts';
import type { ServiceIdentity } from './common.ts';

export interface VoiceSampleRequest { topic_id: string; transcript: string; frames: number }
export interface VoiceReadinessResponse { identity: ServiceIdentity; status: 'ready'|'offline'|'unconfigured'|'input_changed'; message: string; profile: {id:string;skill_name:string;skill_sha256:string;reference_sha256:string;template_sha256:string}|null; running: number|null; pending: number|null }
export interface GeneratedAssetOutput { asset_id:string; manifest_path:string; sha256:string }
export const VoiceSampleSchema = objectSchema<VoiceSampleRequest>(['topic_id','transcript','frames'], {
  topic_id:{type:'string',minLength:1,maxLength:100}, transcript:{type:'string',minLength:1,maxLength:400}, frames:{type:'integer',minimum:124,maximum:362},
},value=>{
  if(!String(value.transcript).trim()||/<\/?d>|<\|/.test(String(value.transcript))||(Number(value.frames)-5)%17)throw new ContractError('VALIDATION_ERROR','需要纯口播台词；生成窗口为 124–362 帧，满足 17*k+5');
});

export const VoiceRecoverSchema = objectSchema<Record<string,never>>([],{});
