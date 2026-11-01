import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ContractError,IMAGE_PLAN_SCHEMA,parseImagePlanDraft,type ImagePlanFrozenInput,type JsonObject,type TextExecutionPolicy} from '@workbench/contracts';
import type {TypedOutput} from '../../result-commit/index.ts';
// 配图规划规则只在一份固定 skill 文件里；每个任务冻结规则正文的 hash，之后改文件不影响已排队任务。
export const IMAGE_PLAN_SKILL_NAME='wechat-image-plan';
// 规划是轻量判断：中等推理、较短上限，避免长时间占住执行器槽位。
export const IMAGE_PLAN_EXECUTION:TextExecutionPolicy={model:'gpt-6.1-sol',reasoning_effort:'medium',idle_timeout_ms:180000,max_duration_ms:600000};
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export function readImagePlanSkill(url:URL=new URL('./skills/wechat-image-plan/SKILL.md',import.meta.url)){const content=readFileSync(url,'utf8');if(!content.startsWith('---\nname: '+IMAGE_PLAN_SKILL_NAME+'\n'))throw new ContractError('INPUT_STALE','配图规划规则文件身份不符');return{name:IMAGE_PLAN_SKILL_NAME,content,sha256:sha(content)};}
export function imagePlanInstruction(skill:{content:string}){return '按下面固定的 wechat-image-plan 技能，为 input_manifest.frozen.image_plan 中的定稿正文规划封面与正文配图。documents[].text 只放方案 JSON。\n\n'+skill.content;}
function frozenOf(manifest:JsonObject):ImagePlanFrozenInput{
 const value=manifest.image_plan as unknown as ImagePlanFrozenInput|undefined;
 if(!value||typeof value!=='object'||value.schema_version!==IMAGE_PLAN_SCHEMA||!Array.isArray(value.paragraphs)||!Array.isArray(value.candidates)||!Number.isSafeInteger(value.body_limit))throw new ContractError('VALIDATION_ERROR','配图规划缺少固定正文');
 return value;
}
/** worker 提交前校验：方案不合格时整份作废，任务失败并记下用户语言原因，不留候选。 */
export function validateImagePlanOutput(manifest:JsonObject,output:TypedOutput):TypedOutput{
 const frozen=frozenOf(manifest);
 if(output.documents.length!==1||output.recommendations.length)throw new ContractError('VALIDATION_ERROR','配图方案只能返回一段 JSON',{reason:'shape'});
 parseImagePlanDraft(output.documents[0]!.text,frozen);return output;
}
export function frozenImagePlan(manifest:JsonObject):ImagePlanFrozenInput{return frozenOf(manifest);}
