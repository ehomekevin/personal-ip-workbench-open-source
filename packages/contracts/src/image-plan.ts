import {ContractError} from './errors.ts';
import {objectSchema} from './validation.ts';
import type {StudioSnapshot} from './image-studio.ts';
// 公众号配图方案（A2）：执行器先按定稿正文给出封面与正文配图的位置、图注草案和来源策略，人再逐张生成与修改。
// 方案存 application_metadata（独立 key、带版本），不新增表；真实图片仍是 image-studio 的槽位与版本。
export const IMAGE_PLAN_JOB_KIND='image_plan';
export const IMAGE_PLAN_SCHEMA='image-plan/1';
export const IMAGE_PLAN_STRATEGIES=['article_original','platform_post','ai_generate'] as const;
export type ImagePlanStrategy=typeof IMAGE_PLAN_STRATEGIES[number];
// 画幅只取工作台已有的构图目标，生成时可直接映射到渠道的可选尺寸。
export const IMAGE_PLAN_ASPECTS=['16:9','4:3','1:1','3:4','9:16','2:5'] as const;
export type ImagePlanAspect=typeof IMAGE_PLAN_ASPECTS[number];
export const IMAGE_PLAN_MAX_BODY=6;
/** 正文图数量上限：约每 500 字一张，至少 1 张，封顶 6 张（封面另计）。 */
export function imagePlanBodyLimit(chars:number):number{return Math.min(IMAGE_PLAN_MAX_BODY,Math.max(1,Math.ceil(Math.max(0,chars)/500)));}
export type ImagePlanPosition='cover'|'before'|'after';
export interface ImagePlanDraftItem {paragraph_id:string;position:ImagePlanPosition;purpose:string;source_strategy:ImagePlanStrategy;aspect:ImagePlanAspect;prompt_draft:string;candidate_id:string|null}
export interface ImagePlanDraft {cover:ImagePlanDraftItem;slots:ImagePlanDraftItem[]}
/** 冻结在任务里的规划输入：段落编号与可用网络候选（只给摘要，不给记录 ID）。 */
export interface ImagePlanFrozenCandidate {candidate_id:string;group:'article_original'|'platform_post';title:string;credit_label:string;paragraph_hits:string[]}
export interface ImagePlanFrozenInput {schema_version:typeof IMAGE_PLAN_SCHEMA;topic_id:string;topic_title:string;article_revision_id:string;article_chars:number;body_limit:number;paragraphs:Array<{id:string;index:number;text:string}>;candidates:ImagePlanFrozenCandidate[];skill:{name:string;sha256:string}}
const fail=(message:string,reason:string,extra:Record<string,unknown>={}):never=>{throw new ContractError('VALIDATION_ERROR',message,{reason,...extra});};
const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
// 执行器偶尔会把 JSON 包在一个代码块里；只接受「整段就是一个 JSON 对象」或「唯一一个 json 代码块」，其余文字一律视为不合格。
function extractJson(text:string):unknown{
 const trimmed=text.trim(),fence=/^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed),body=fence?fence[1]!.trim():trimmed;
 if(!body.startsWith('{')||!body.endsWith('}'))fail('方案不是一段完整的 JSON','not_json');
 try{return JSON.parse(body);}catch{return fail('方案不是一段完整的 JSON','not_json');}
}
function draftItem(value:unknown,where:string,frozen:Pick<ImagePlanFrozenInput,'paragraphs'|'candidates'>,cover:boolean):ImagePlanDraftItem{
 if(!isObject(value))return fail(where+'缺少内容','missing_item');
 const allowed=['paragraph_id','position','purpose','source_strategy','aspect','prompt_draft','candidate_id'];for(const key of Object.keys(value))if(!allowed.includes(key))fail(where+'有多余字段','unknown_field',{field:key});
 const paragraph=typeof value.paragraph_id==='string'?value.paragraph_id:'';if(!frozen.paragraphs.some(p=>p.id===paragraph))fail(where+'指向的段落不存在','unknown_paragraph');
 const position=value.position;if(cover?position!=='cover':position!=='before'&&position!=='after')fail(where+'的插入位置不合法','invalid_position');
 const strategy=value.source_strategy;if(!(IMAGE_PLAN_STRATEGIES as readonly unknown[]).includes(strategy))fail(where+'的来源策略不合法','invalid_strategy');
 const aspect=value.aspect;if(!(IMAGE_PLAN_ASPECTS as readonly unknown[]).includes(aspect))fail(where+'的画幅不合法','invalid_aspect');
 const purpose=typeof value.purpose==='string'?value.purpose.trim():'';if(!purpose||purpose.length>120)fail(where+'的图注草案为空或超过 120 字','invalid_purpose');
 const prompt=typeof value.prompt_draft==='string'?value.prompt_draft.trim():'';if(!prompt||prompt.length>2000)fail(where+'的画面提示为空或超过 2000 字','invalid_prompt');
 // 候选 ID 只是建议：不在冻结候选里、或与策略不符时丢弃，由服务端按段落关键词再选。
 const raw=value.candidate_id,candidate=typeof raw==='string'?frozen.candidates.find(c=>c.candidate_id===raw&&c.group===strategy):undefined;if(raw!==undefined&&raw!==null&&typeof raw!=='string')fail(where+'的候选图编号不合法','invalid_candidate');
 return{paragraph_id:paragraph,position:position as ImagePlanPosition,purpose,source_strategy:strategy as ImagePlanStrategy,aspect:aspect as ImagePlanAspect,prompt_draft:prompt,candidate_id:strategy==='ai_generate'?null:candidate?.candidate_id??null};
}
/** 解析并校验执行器交回的方案；失败抛出带用户语言说明的 VALIDATION_ERROR（details.reason 供诊断）。 */
export function parseImagePlanDraft(text:string,frozen:Pick<ImagePlanFrozenInput,'paragraphs'|'candidates'|'body_limit'>):ImagePlanDraft{
 const value=extractJson(text);if(!isObject(value))return fail('方案不是一段完整的 JSON','not_json');
 for(const key of Object.keys(value))if(!['cover','slots'].includes(key))fail('方案有多余字段','unknown_field',{field:key});
 const cover=draftItem(value.cover,'封面',frozen,true);if(!Array.isArray(value.slots))return fail('方案缺少正文配图列表','missing_slots');
 if(value.slots.length>frozen.body_limit)fail('正文配图 '+value.slots.length+' 张，超过本篇上限 '+frozen.body_limit+' 张','too_many',{count:value.slots.length,limit:frozen.body_limit});
 const slots=value.slots.map((item,index)=>draftItem(item,'第 '+(index+1)+' 张正文图',frozen,false)),seen=new Set<string>();
 for(const slot of slots){const at=slot.position+':'+slot.paragraph_id;if(seen.has(at))fail('两张正文图放在了同一位置','duplicate_position');seen.add(at);}
 return{cover,slots};
}
// ——— 保存状态 ———
export type ImagePlanRunState='queued'|'running'|'waiting'|'succeeded'|'failed'|'cancelled';
export interface ImagePlanRun {id:string;job_id:string;document_id:string;executor:'codex'|'claude';article_revision_id:string;state:ImagePlanRunState;error:string|null;requested_at:string;settled_at:string|null}
// unused：自动导入落版时用户已改了这一项，这一版只作候选留在版本条，不设为当前图。
export type ImagePlanAutoState='none'|'pending'|'selected'|'no_match'|'failed'|'unused';
export type ImagePlanItemRole='cover'|'body'|'manual';
export interface ImagePlanItem {id:string;role:ImagePlanItemRole;slot_id:string;paragraph_id:string;placement_paragraph_id:string;position:ImagePlanPosition;seq:number;purpose:string;source_strategy:ImagePlanStrategy;aspect:ImagePlanAspect;prompt_draft:string;candidate_id:string|null;skipped:boolean;auto:{state:ImagePlanAutoState;candidate_id:string|null;error:string|null};current_version_id:string|null;cleared:boolean;seen_versions:number;/** 本人删除（A2-2）：不进画布与终稿，已有版本仍留在素材库；读取视图不返回已删除项。 */removed?:boolean}
export interface ImagePlanState {schema_version:typeof IMAGE_PLAN_SCHEMA;topic_id:string;version:number;run:ImagePlanRun|null;plan:{id:string;article_revision_id:string;created_at:string;items:ImagePlanItem[]}|null}
// ——— 读取视图 ———
export type ImagePlanItemStatus='skipped'|'filled'|'generating'|'awaiting_generation'|'searching'|'pending'|'failed';
export interface ImagePlanItemView extends ImagePlanItem {status:ImagePlanItemStatus;paragraph_excerpt:string;paragraph_index:number|null;current_version:{id:string;index:number;auto_selected:boolean;credit_label:string|null;operation:string}|null;issue:string|null}
/** limit/remaining 为 null 表示不限次数。 */
export interface ImagePlanBudget {used:number;limit:number|null;remaining:number|null}
/** 配图确认摘要：pending=未跳过但还没配好并采用的张数（从未生成的项也算）；confirmed=已有配图终稿；current=终稿与当前方案一致。 */
export interface ImagePlanFinalSummary {pending:number;confirmed:boolean;current:boolean;confirmed_at:string|null}
export interface ImagePlanSnapshot {topic_id:string;topic_title:string;version:number;state:'empty'|'planning'|'ready'|'failed';run:{state:ImagePlanRunState;executor:'codex'|'claude';error:string|null;requested_at:string;job_id:string}|null;stale:boolean;items:ImagePlanItemView[];budget:{codex:ImagePlanBudget;agy:ImagePlanBudget};final:ImagePlanFinalSummary;studio:StudioSnapshot}
// ——— 配图终稿（A2-2）：确认时按方案顺序冻结，存 application_metadata；排版只读这一份，不写 Wiki。 ———
export const IMAGE_PLAN_FINAL_SCHEMA='image-plan-final/1';
/** paragraph_id 是插入锚点段落（封面为首段）；position 相对它取 before/after，封面为 cover。caption 取方案图注，credit_label 只有网络图有。 */
export interface ImagePlanFinalItem {item_id:string;role:ImagePlanItemRole;slot_id:string;asset_id:string;version_id:string;sha256:string;url:string;pixel_width:number;pixel_height:number;caption:string;credit_label:string|null;paragraph_id:string;position:ImagePlanPosition}
/** id 是终稿内容摘要：内容不变时重复确认得到同一 id，排版据此判断配图是否更新。 */
export interface ImagePlanFinal {schema_version:typeof IMAGE_PLAN_FINAL_SCHEMA;id:string;topic_id:string;plan_id:string;document_id:string;document_revision_id:string;confirmed_at:string;items:ImagePlanFinalItem[]}
// ——— 请求 ———
export interface ImagePlanRunRequest {topic_id:string;expected_version:number;replan:boolean;executor?:'codex'|'claude'}
export interface ImagePlanConfirmRequest {topic_id:string;expected_version:number}
/** placement：本人指定插入位置（段落 + 段前/段后，或封面）；move_to：拖拽到正文图列表的第几位（0 起），与上下移同样交换落点。 */
export interface ImagePlanItemUpdate {topic_id:string;expected_version:number;purpose?:string;prompt_draft?:string;source_strategy?:ImagePlanStrategy;aspect?:ImagePlanAspect;skipped?:boolean;move?:'up'|'down';move_to?:number;placement?:{position:ImagePlanPosition;paragraph_id:string|null};removed?:true;current_version_id?:string|null}
/** 本人在方案里新增一张（手动项）：先定位置，再生成、换来源或上传。 */
export interface ImagePlanItemCreate {topic_id:string;expected_version:number;position:ImagePlanPosition;paragraph_id:string|null;purpose?:string;source_strategy?:ImagePlanStrategy;aspect?:ImagePlanAspect}
const id={type:'string',minLength:1,maxLength:100};
export const ImagePlanRunSchema=objectSchema<ImagePlanRunRequest>(['topic_id','expected_version','replan'],{topic_id:id,expected_version:{type:'integer',minimum:1},replan:{type:'boolean'},executor:{type:'string',enum:['codex','claude']}});
export const ImagePlanConfirmSchema=objectSchema<ImagePlanConfirmRequest>(['topic_id','expected_version'],{topic_id:id,expected_version:{type:'integer',minimum:1}});
const placement={type:'object',required:['position','paragraph_id'],additionalProperties:false,properties:{position:{type:'string',enum:['cover','before','after']},paragraph_id:{type:['string','null'],minLength:1,maxLength:100}}};
const placementCheck=(p:unknown)=>{const v=p as {position:string;paragraph_id:string|null}|undefined;if(v&&v.position!=='cover'&&!v.paragraph_id)throw new ContractError('VALIDATION_ERROR','选择插入到哪一段');};
export const ImagePlanItemUpdateSchema=objectSchema<ImagePlanItemUpdate>(['topic_id','expected_version'],{topic_id:id,expected_version:{type:'integer',minimum:1},purpose:{type:'string',minLength:1,maxLength:120},prompt_draft:{type:'string',minLength:1,maxLength:2000},source_strategy:{type:'string',enum:[...IMAGE_PLAN_STRATEGIES]},aspect:{type:'string',enum:[...IMAGE_PLAN_ASPECTS]},skipped:{type:'boolean'},move:{type:'string',enum:['up','down']},move_to:{type:'integer',minimum:0,maximum:99},placement,removed:{type:'boolean',enum:[true]},current_version_id:{type:['string','null'],minLength:1,maxLength:100}},v=>{
 if(!['purpose','prompt_draft','source_strategy','aspect','skipped','move','move_to','placement','removed','current_version_id'].some(k=>k in v))throw new ContractError('VALIDATION_ERROR','没有要修改的内容');
 placementCheck(v.placement);
 for(const k of ['purpose','prompt_draft'])if(k in v&&!String(v[k]).trim())throw new ContractError('VALIDATION_ERROR',k==='purpose'?'图注不能为空':'画面提示不能为空');
});
export const ImagePlanItemCreateSchema=objectSchema<ImagePlanItemCreate>(['topic_id','expected_version','position','paragraph_id'],{topic_id:id,expected_version:{type:'integer',minimum:1},position:{type:'string',enum:['cover','before','after']},paragraph_id:{type:['string','null'],minLength:1,maxLength:100},purpose:{type:'string',minLength:1,maxLength:120},source_strategy:{type:'string',enum:[...IMAGE_PLAN_STRATEGIES]},aspect:{type:'string',enum:[...IMAGE_PLAN_ASPECTS]}},v=>{placementCheck(v);if('purpose' in v&&!String(v.purpose).trim())throw new ContractError('VALIDATION_ERROR','图注不能为空');});
const text={type:'string'},nullableText={type:['string','null']},integer={type:'integer'},boolean={type:'boolean'},link=(name:string)=>({$ref:'#/components/schemas/'+name});
const response=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const itemProperties={id:text,role:{enum:['cover','body','manual']},slot_id:text,paragraph_id:text,placement_paragraph_id:text,position:{enum:['cover','before','after']},seq:integer,purpose:text,source_strategy:{enum:[...IMAGE_PLAN_STRATEGIES]},aspect:{enum:[...IMAGE_PLAN_ASPECTS]},prompt_draft:text,candidate_id:nullableText,skipped:boolean,auto:response({state:{enum:['none','pending','selected','no_match','failed','unused']},candidate_id:nullableText,error:nullableText}),current_version_id:nullableText,cleared:boolean,seen_versions:integer};
const budget=response({used:integer,limit:{type:['integer','null']},remaining:{type:['integer','null']}});
export const IMAGE_PLAN_RESPONSE_SCHEMAS={
 ImagePlanItemView:response({...itemProperties,status:{enum:['skipped','filled','generating','awaiting_generation','searching','pending','failed']},paragraph_excerpt:text,paragraph_index:{type:['integer','null']},current_version:{anyOf:[response({id:text,index:integer,auto_selected:boolean,credit_label:nullableText,operation:text}),{type:'null'}]},issue:nullableText}),
 ImagePlanSnapshot:response({topic_id:text,topic_title:text,version:integer,state:{enum:['empty','planning','ready','failed']},run:{anyOf:[response({state:{enum:['queued','running','waiting','succeeded','failed','cancelled']},executor:{enum:['codex','claude']},error:nullableText,requested_at:text,job_id:text}),{type:'null'}]},stale:boolean,items:{type:'array',items:link('ImagePlanItemView')},budget:response({codex:budget,agy:budget}),final:response({pending:integer,confirmed:boolean,current:boolean,confirmed_at:nullableText}),studio:link('StudioSnapshot')}),
};
