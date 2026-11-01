import { ContractError } from './errors.ts';
import { objectSchema } from './validation.ts';
import { executorAvailability } from './executor-availability.ts';
import type { ExecutorHealth } from './requests.ts';
export type ImageProviderId = 'agy'|'codex';
export type ImageOperation = 'generate'|'reference_edit';
export interface ImageGenerationRequest {
  generator:'image'; provider:ImageProviderId; operation:ImageOperation;
  topic_id:string; purpose:string; prompt:string; input_asset_ids:string[];
  size_request?:{mode:'auto'|'manual';width:number;height:number;aspect_ratio:string;policy:'prompt_guided'};
  studio_binding?:{slot_id:string;version_id:string;document_id:string;paragraph_id:string;placement_paragraph_id:string;position:'before'|'after'|'cover';title:string;parent_version_id:string|null;context_prompt?:string;references:Array<{asset_id:string;purpose:'style'|'identity'|'content'}>};
  parent_asset_id:string|null; document_revision_id:string|null; plan_revision_id:string|null;
}
export interface ImageProviderChannel {
  provider:ImageProviderId; label:string; enabled:boolean; configured:boolean;
  identity:string; connection:string; permission:string; model:string|null;
  operations:{generation:string;reference_edit:string;mask:string;writing:string};
  last_job_id:string|null; last_asset_id:string|null; limitations:string[];
  // 以下三项由服务端随 GET 一并给出（旧客户端/夹具可缺省）：最近一次只读连接验证、Codex 执行器认证状态、本渠道真实生图预算。
  verification?:ImageProviderVerification; executor?:Pick<ExecutorHealth,'status'|'auth_state'>|null; budget?:{used:number;limit:number|null;remaining:number|null};
}
// 「验证连接」只做身份/连接/权限只读探测，不发生真实生图；failed 视为明确阻塞，inconclusive（超时/未能确认）只提示不阻塞。
export interface ImageProviderVerification {state:'not_run'|'passed'|'failed'|'inconclusive';reason:'quota'|'login'|'connection'|'unconfigured'|null;message:string|null;checked_at:string|null}
export interface ImageProviderSettingsResponse {version:number;default_provider:ImageProviderId;channels:ImageProviderChannel[]}
export interface SaveImageProviderSettingsRequest {expected_version:number;default_provider:ImageProviderId;enabled:{agy:boolean;codex:boolean}}
const id={type:'string',minLength:1,maxLength:100},nullable={type:['string','null'],minLength:1,maxLength:100};
export const ImageGenerationSchema=objectSchema<ImageGenerationRequest>(['generator','provider','operation','topic_id','purpose','prompt','input_asset_ids','parent_asset_id','document_revision_id','plan_revision_id'],{
  generator:{type:'string',const:'image'},provider:{type:'string',enum:['agy','codex']},operation:{type:'string',enum:['generate','reference_edit']},topic_id:id,
  purpose:{type:'string',minLength:1,maxLength:300},prompt:{type:'string',minLength:1,maxLength:8000},
  size_request:{type:'object',required:['mode','width','height','aspect_ratio','policy'],additionalProperties:false,properties:{mode:{type:'string',enum:['auto','manual']},width:{type:'integer',minimum:320,maximum:4096},height:{type:'integer',minimum:320,maximum:4096},aspect_ratio:{type:'string',minLength:3,maxLength:32},policy:{type:'string',enum:['prompt_guided']}}},
  studio_binding:{type:'object',required:['slot_id','version_id','document_id','paragraph_id','placement_paragraph_id','position','title','parent_version_id','references'],additionalProperties:false,properties:{slot_id:id,version_id:id,document_id:id,paragraph_id:id,placement_paragraph_id:id,position:{type:'string',enum:['before','after','cover']},title:{type:'string',maxLength:300},parent_version_id:nullable,context_prompt:{type:'string',minLength:1,maxLength:8000},references:{type:'array',maxItems:1,items:{type:'object',required:['asset_id','purpose'],additionalProperties:false,properties:{asset_id:id,purpose:{type:'string',enum:['style','identity','content']}}}}}},
  input_asset_ids:{type:'array',maxItems:1,uniqueItems:true,items:id},parent_asset_id:nullable,document_revision_id:nullable,plan_revision_id:nullable,
},v=>{if(!String(v.prompt).trim()||!String(v.purpose).trim())throw new ContractError('VALIDATION_ERROR','填写图片用途与画面说明');
  const references=v.input_asset_ids as string[];
  if(v.operation==='reference_edit'&&(references.length!==1||v.parent_asset_id!==references[0]))throw new ContractError('VALIDATION_ERROR','参考编辑须绑定一张既有参考图及父图');
  if(v.operation==='generate'&&(references.length||v.parent_asset_id!==null))throw new ContractError('CAPABILITY_UNVERIFIED','多图参考与生成混合参考尚未准入');
});
export function imageProviderPrompt(input:Pick<ImageGenerationRequest,'prompt'|'studio_binding'>):string {
  const context=input.studio_binding?.context_prompt;
  return context===undefined?input.prompt:input.prompt+'\n'+context;
}
export const SaveImageProviderSettingsSchema=objectSchema<SaveImageProviderSettingsRequest>(['expected_version','default_provider','enabled'],{
  expected_version:{type:'integer',minimum:1},default_provider:{type:'string',enum:['agy','codex']},enabled:{type:'object',required:['agy','codex'],additionalProperties:false,properties:{agy:{type:'boolean'},codex:{type:'boolean'}}},
});
export const ImageQuerySchema=objectSchema<{expected_version:number}>(['expected_version'],{expected_version:{type:'integer',minimum:1}});

// 图像渠道可用判定（生成弹窗与设置页共用）：已启用 && 已配置 && 无明确阻塞。
// 明确阻塞 = 执行器额度耗尽/登录失效、最近一次连接验证明确失败、本渠道真实生图次数用完；operations.generation 为 unverified 只提示「未经真实验收」，不禁用。
export type ImageProviderBlock='disabled'|'unconfigured'|'quota'|'login'|'unsupported'|'probe_failed'|'budget';
// message 是下拉项/标签用的短句；detail 是最近一次连接验证给出的完整原因（用户语言），用于设置页与弹窗提示。
export interface ImageProviderAvailability {selectable:boolean;block:ImageProviderBlock|null;message:string;detail:string|null;unverified:boolean;remaining:number|null;limit:number|null}
export function imageProviderAvailability(channel:Pick<ImageProviderChannel,'enabled'|'configured'|'operations'>&Partial<Pick<ImageProviderChannel,'verification'|'executor'|'budget'>>):ImageProviderAvailability {
  const executor=channel.executor?executorAvailability(channel.executor):null,verification=channel.verification,budget=channel.budget;
  const probe=verification?.state==='failed'&&!executor?.usable?verification:null;
  const block:ImageProviderBlock|null=!channel.enabled?'disabled':!channel.configured||probe?.reason==='unconfigured'?'unconfigured':executor?.reason==='quota'||probe?.reason==='quota'?'quota':executor?.reason==='login'||probe?.reason==='login'?'login':executor?.reason==='unsupported'?'unsupported':probe?'probe_failed':budget&&budget.remaining!==null&&budget.remaining<=0?'budget':null;
  const messages:Record<ImageProviderBlock,string>={disabled:'未启用',unconfigured:'本机未找到命令行工具',quota:'额度暂不可用',login:'需要重新登录',unsupported:'暂不支持',probe_failed:'连接验证未通过',budget:'本渠道真实生图次数已达上限'};
  return {selectable:block===null,block,message:block?messages[block]:'',detail:block&&probe?probe.message:null,unverified:channel.operations.generation!=='supported',remaining:budget&&budget.remaining!==null?Math.max(0,budget.remaining):null,limit:budget?budget.limit:null};
}
