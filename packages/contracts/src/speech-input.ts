import { objectSchema } from './validation.ts';
import { ContractError } from './errors.ts';
const SPEECH_FORMAT={ sample_rate: 16000, channels: 1, bits: 16 } as const,SPEECH_MAX_SECONDS=600;
export const SPEECH_INPUT_LIMITS = { ...SPEECH_FORMAT, max_seconds: SPEECH_MAX_SECONDS, max_bytes: SPEECH_MAX_SECONDS*SPEECH_FORMAT.sample_rate*SPEECH_FORMAT.channels*SPEECH_FORMAT.bits/8, chunk_bytes: 6400, afp_per_hour: 450 } as const;
const base64Length=(bytes:number)=>Math.ceil(bytes/3)*4,wavBytes=SPEECH_INPUT_LIMITS.max_bytes+65536;
// Every speech size/duration bound is derived from SPEECH_INPUT_LIMITS; the final empty chunk takes one extra sequence.
export const SPEECH_INPUT_DERIVED_LIMITS={max_minutes:SPEECH_INPUT_LIMITS.max_seconds/60,max_duration_ms:SPEECH_INPUT_LIMITS.max_seconds*1000,max_estimated_afp:SPEECH_INPUT_LIMITS.max_seconds/3600*SPEECH_INPUT_LIMITS.afp_per_hour,max_sequence:SPEECH_INPUT_LIMITS.max_bytes/SPEECH_INPUT_LIMITS.chunk_bytes+1,chunk_base64:base64Length(SPEECH_INPUT_LIMITS.chunk_bytes),max_wav_bytes:wavBytes,max_wav_base64:base64Length(wavBytes)} as const;
export type SpeechInputState = 'starting' | 'recording' | 'finalizing' | 'final' | 'cancelled' | 'failed' | 'unknown';
export interface SpeechInputSnapshot {
  id: string; state: SpeechInputState; provider: 'ark_agent_plan'; model: 'doubao-seed-asr-2.0';
  partial_text: string; final_text: string | null; duration_ms: number; estimated_afp: number;
  request_id: string; log_id: string | null; error: string | null; source_record_id: string | null; created_at: string;
  accepted_sequence?:number; cancellation?:CancelSpeechInput;
  // Cleanup draft runs beside the raw transcript; raw final_text is never replaced. Absent on records made before cleanup existed.
  cleanup_state?:SpeechCleanupState|null; cleaned_text?:string|null; cleanup_error?:string|null;
  // Current cleanup job; the dialog sends it back as the fence for re-running cleanup.
  cleanup_job_id?:string|null;
  // Topics the adopted personal material is linked to (adoption with topic_id, or a later topic-link).
  linked_topic_ids?:string[];
}
// One executor job per final transcript; queued/running/waiting drive the dialog hint (waiting = executor needs login or quota, the job can still resume), failed always leaves the raw text adoptable.
export const SPEECH_CLEANUP_JOB_KIND='speech_cleanup';
export const SPEECH_CLEANUP_STATES=['queued','running','waiting','succeeded','failed'] as const;
export type SpeechCleanupState=typeof SPEECH_CLEANUP_STATES[number];
// The cleaned draft may not drift more than this share of the raw character count (whitespace excluded).
export const SPEECH_CLEANUP_MAX_LENGTH_DEVIATION=0.4;
export const SPEECH_ADOPTED_FROM=['raw','cleaned'] as const;
export type SpeechAdoptedFrom=typeof SPEECH_ADOPTED_FROM[number];
export interface SpeechInputConfiguration { enabled: boolean; credential_present: boolean; connection: 'unverified' | 'verified'; setup_url: string | null; limits: typeof SPEECH_INPUT_LIMITS }
export interface StartSpeechInput { mode: 'live' | 'recording'; capture_id?:string }
export interface SpeechInputChunk { sequence: number; audio_base64: string; final: boolean }
export const SPEECH_INPUT_BATCH_LIMIT=10;
export interface SpeechInputBatch { chunks:SpeechInputChunk[] }
export type SpeechInputCancelReason='user'|'closed'|'buffer_full'|'state_unavailable'|'chunk_receipt_unconfirmed'|'capture_failed';
export interface CancelSpeechInput { reason?:SpeechInputCancelReason; transport_code?:string; http_status?:number }
export interface AdoptSpeechInput { title: string; text: string; topic_id?: string; adopted_from?: SpeechAdoptedFrom }
export interface LinkSpeechInputTopic { topic_id: string }
// Re-run cleanup on the text currently in the editor: expected_cleanup_job_id fences against a concurrent replacement; a queued/waiting old job is cancelled first. executor applies to this job only.
export interface RecleanupSpeechInput { text: string; expected_cleanup_job_id: string | null; executor?: 'codex' | 'claude' }
export interface TranscribeRecording { audio_base64: string; format: 'wav'; capture_id?:string }
export const ConfigureSpeechInputSchema = objectSchema<{enabled:boolean}>(['enabled'], { enabled: { type:'boolean' } });
const captureId={type:'string',minLength:36,maxLength:36,format:'uuid'};
const validateCaptureId=(value:Record<string,unknown>)=>{if(value.capture_id!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value.capture_id)))throw new ContractError('VALIDATION_ERROR','录音标识无效');};
export const StartSpeechInputSchema = objectSchema<StartSpeechInput>(['mode'], { mode: { type:'string', enum:['live','recording'] },capture_id:captureId },validateCaptureId);
export const SpeechInputChunkSchema = objectSchema<SpeechInputChunk>(['sequence','audio_base64','final'], { sequence: { type:'integer',minimum:1,maximum:SPEECH_INPUT_DERIVED_LIMITS.max_sequence }, audio_base64: { type:'string',maxLength:SPEECH_INPUT_DERIVED_LIMITS.chunk_base64 }, final: { type:'boolean' } });
export const SpeechInputBatchSchema=objectSchema<SpeechInputBatch>(['chunks'],{chunks:{type:'array',minItems:1,maxItems:SPEECH_INPUT_BATCH_LIMIT,items:SpeechInputChunkSchema.jsonSchema}},value=>{
  const chunks=value.chunks as SpeechInputChunk[];
  if(chunks.some((chunk,index)=>index>0&&chunk.sequence!==chunks[index-1]!.sequence+1||chunk.final&&index!==chunks.length-1))throw new ContractError('VALIDATION_ERROR','批次音频必须连续，结束片段只能放在最后');
});
export const CancelSpeechInputSchema=objectSchema<CancelSpeechInput>([],{reason:{type:'string',enum:['user','closed','buffer_full','state_unavailable','chunk_receipt_unconfirmed','capture_failed']},transport_code:{type:'string',minLength:1,maxLength:64},http_status:{type:'integer',minimum:100,maximum:599}},value=>{
  if(value.transport_code!==undefined&&!/^[A-Z][A-Z0-9_]{0,63}$/.test(String(value.transport_code)))throw new ContractError('VALIDATION_ERROR','传输原因代码无效');
});
export const AdoptSpeechInputSchema = objectSchema<AdoptSpeechInput>(['title','text'], { title:{type:'string',minLength:1,maxLength:240}, text:{type:'string',minLength:1,maxLength:100000}, topic_id:{type:'string',minLength:1,maxLength:128}, adopted_from:{type:'string',enum:[...SPEECH_ADOPTED_FROM]} });
export const LinkSpeechInputTopicSchema = objectSchema<LinkSpeechInputTopic>(['topic_id'], { topic_id:{type:'string',minLength:1,maxLength:128} });
export const TranscribeRecordingSchema = objectSchema<TranscribeRecording>(['audio_base64','format'], { audio_base64:{type:'string',minLength:60,maxLength:SPEECH_INPUT_DERIVED_LIMITS.max_wav_base64}, format:{type:'string',enum:['wav']},capture_id:captureId },validateCaptureId);
export const RecleanupSpeechInputSchema = objectSchema<RecleanupSpeechInput>(['text','expected_cleanup_job_id'], { text:{type:'string',minLength:1,maxLength:100000}, expected_cleanup_job_id:{type:['string','null'],minLength:1,maxLength:128}, executor:{type:'string',enum:['codex','claude']} },value=>{if(!String(value.text).trim())throw new ContractError('VALIDATION_ERROR','先核对要整理的文字');});
