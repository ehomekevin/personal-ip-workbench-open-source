import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ContractError,SPEECH_CLEANUP_MAX_LENGTH_DEVIATION,type JsonObject,type TextExecutionPolicy } from '@workbench/contracts';
import type { TypedOutput } from '../result-commit/index.ts';
// Speech cleanup rules live in one fixed skill file; each job freezes its text and hash so later edits never change a queued job.
export const SPEECH_CLEANUP_SKILL_NAME='speech-cleanup',SPEECH_CLEANUP_SCHEMA='speech-cleanup/1';
// Cleanup is a light rewrite: lower effort and a short ceiling keep one slot from being held as long as a full draft.
export const SPEECH_CLEANUP_EXECUTION:TextExecutionPolicy={model:'gpt-6.1-sol',reasoning_effort:'medium',idle_timeout_ms:120000,max_duration_ms:300000};
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export function readSpeechCleanupSkill(url:URL=new URL('./skills/speech-cleanup/SKILL.md',import.meta.url)){const content=readFileSync(url,'utf8');if(!content.startsWith('---\nname: '+SPEECH_CLEANUP_SKILL_NAME+'\n'))throw new ContractError('INPUT_STALE','语音整理规则文件身份不符');return {name:SPEECH_CLEANUP_SKILL_NAME,content,sha256:sha(content)};}
/** Characters that carry meaning: whitespace is ignored so line breaks and spacing never count toward the guard. */
export function cleanupChars(text:string){return Array.from(text.replace(/\s+/gu,'')).length;}
export function cleanupDeviation(raw:string,cleaned:string){const base=cleanupChars(raw);return base?Math.abs(cleanupChars(cleaned)-base)/base:cleanupChars(cleaned)?1:0;}
export function speechCleanupContext(speechInputId:string,rawText:string,skill:{name:string;content:string;sha256:string}):JsonObject{return {schema_version:SPEECH_CLEANUP_SCHEMA,speech_input_id:speechInputId,raw_text:rawText,raw_text_sha256:sha(rawText),max_length_deviation:SPEECH_CLEANUP_MAX_LENGTH_DEVIATION,skill:{name:skill.name,sha256:skill.sha256}};}
export function speechCleanupInstruction(skill:{content:string}){return '按下面固定的 speech-cleanup 技能整理 input_manifest.frozen.speech_cleanup.raw_text 中的本人口述转写。documents[].text 只放整理后的正文。\n\n'+skill.content;}
// Runs in the worker before the result is committed: an empty or length-drifting draft never becomes a candidate.
export function validateSpeechCleanup(manifest:JsonObject,output:TypedOutput):TypedOutput{
  const context=manifest.speech_cleanup as JsonObject|undefined;
  if(!context||typeof context!=='object'||Array.isArray(context)||context.schema_version!==SPEECH_CLEANUP_SCHEMA||typeof context.raw_text!=='string'||sha(context.raw_text)!==context.raw_text_sha256)throw new ContractError('VALIDATION_ERROR','语音整理缺少固定原文');
  if(output.documents.length!==1||output.recommendations.length)throw new ContractError('VALIDATION_ERROR','语音整理只能返回一段正文');
  const text=output.documents[0]!.text;if(!text.trim())throw new ContractError('VALIDATION_ERROR','整理稿为空',{reason:'empty'});
  const deviation=cleanupDeviation(context.raw_text,text);
  if(deviation>SPEECH_CLEANUP_MAX_LENGTH_DEVIATION)throw new ContractError('VALIDATION_ERROR','整理稿字数偏离原文 '+Math.round(deviation*100)+'%，超过 '+Math.round(SPEECH_CLEANUP_MAX_LENGTH_DEVIATION*100)+'% 护栏',{reason:'length_guard',raw_chars:cleanupChars(context.raw_text),cleaned_chars:cleanupChars(text),deviation:Math.round(deviation*1000)/1000});
  return output;
}
