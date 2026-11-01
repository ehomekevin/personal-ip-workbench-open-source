import {ContractError} from './errors.ts';
import {objectSchema} from './validation.ts';
import type {ImageProviderId,JsonObject} from './index.ts';
export type StudioPlacement='before'|'after'|'cover';
export type StudioReference={asset_id:string;purpose:'style'|'identity'|'content'};
export interface StudioSize {width:number;height:number;aspect_ratio:string}
export interface StudioBriefInput {topic_id:string;document_revision_id:string;paragraph_id:string;placement_paragraph_id:string;description:string;title:string;position:StudioPlacement;provider:ImageProviderId;references:StudioReference[]}
export interface StudioBrief extends StudioBriefInput {id:string;reason:string;suggested_size:StudioSize;content_analysis:JsonObject;native:JsonObject;input_digest:string;created_at:string}
// 画面标注（A2-2）：坐标按图片实际比例归一化，viewBox 宽 1000、高 1000×h/w；标注只随修改请求转成文字说明并记入版本，不进入成品图。
export type StudioMarkType='rect'|'brush'|'arrow'|'text';
export interface StudioMark {id:number;type:StudioMarkType;x:number;y:number;w:number;h:number;ex:number;ey:number;path:string;note:string;text?:string}
export const STUDIO_MAX_MARKS=30;
export interface StudioGenerationRequest extends StudioBriefInput {expected_version:number;slot_id:string|null;parent_version_id:string|null;operation:'generate'|'reference_edit';size_mode:'auto'|'manual';size:StudioSize;brief_id:string|null;marks?:StudioMark[];/** 批量重新生成已配好的图（A2-2）：新版本只作候选留在版本条，不自动设为当前图。 */candidate_only?:boolean;/** 所选生图模型（须是渠道能力 models 之一）；现有适配器都是固定模型，只记录不改变调用。 */model?:string}
export type StudioImageOperation='generate'|'reference_edit'|'web_import'|'upload';
/** 上传图片的用途标签（与原型一致）：只作版本说明，不改变生成请求。 */
export const STUDIO_UPLOAD_PURPOSES=['brand','person','layout','style','object'] as const;
export type StudioUploadPurpose=typeof STUDIO_UPLOAD_PURPOSES[number];
/** 已保存的图片（上传或从已删除配图找回）作为槽位的新一版。 */
/** recover_version_id：从已删除配图找回时给出原版本，服务端复制其图源（网络图的署名进终稿）并记 recovered_from。 */
export interface StudioAssetVersionRequest {topic_id:string;expected_version:number;slot_id:string;asset_id:string;purpose?:StudioUploadPurpose;name?:string;recover_version_id?:string}
export interface StudioAssetVersionResult {slot_id:string;version_id:string;asset_id:string;version:number}
/** 版本还没有真实图片、且任务未结束或结果未知：这张图不能再提交生成/修改（服务端与界面同一判定）。 */
export const STUDIO_BLOCKING_VERSION_STATES=['queued','running','reconciling','waiting_input','waiting_quota','unknown','cancelled'] as const;
export const studioVersionBlocks=(v:{asset_id:string|null;state:string})=>!v.asset_id&&(STUDIO_BLOCKING_VERSION_STATES as readonly string[]).includes(v.state);
// 网络找图来源：原文配图或同题平台帖子图片；采用时由排版按 credit_label 生成图注（样式不在本契约）。
export type StudioWebPlatform='x'|'douyin'|'article';
export interface StudioImageSource {page_url:string;image_url:string;page_title:string|null;author:string|null;site:string|null;platform:StudioWebPlatform;captured_at:string;credit_label:string}
export interface StudioWebImageCandidate {candidate_id:string;image_url:string;thumb_url?:string;width?:number;height?:number;platform:StudioWebPlatform;record_id:string;page_url:string;page_title?:string;author_name?:string;site_name?:string;published_at?:string;expires_at?:string;availability:'available'|'expired'|'unknown';truncated?:boolean;credit_label:string}
// 资讯原文配图的后台抓取状态：fresh 缓存都在有效期内；refreshing 后台正在读取（读完后再请求即可拿到新候选）；
// stale 有旧缓存已过期且最近一次重读失败，仍返回旧图；failed 有原文没有可用缓存且最近一次读取失败。stale/failed 可带 refresh=1 立即重试。
export type StudioWebCaptureState='fresh'|'refreshing'|'stale'|'failed';
export interface StudioWebCaptureStatus {state:StudioWebCaptureState;pages_total:number;pages_ready:number;pages_failed:number;refreshed_at:string|null}
export interface StudioWebImageCandidates {candidates:StudioWebImageCandidate[];capture:StudioWebCaptureStatus}
export interface StudioWebImportRequest {topic_id:string;expected_version:number;slot_id:string|null;candidate:{candidate_id:string;image_url:string}}
export interface StudioWebImportResult {slot_id:string;version_id:string;asset_id:string;deduplicated:boolean;version:number}
/** 生图进度阶段：queued 排队或等待执行器/额度；starting 已开始、尚未把请求交给渠道；generating 渠道正在出图；saving 渠道已返回、正在保存与核对文件；checking 结果待核对（reconciling）。 */
export type StudioImageProgressStage='queued'|'starting'|'generating'|'saving'|'checking';
/** 生图进度：阶段来自任务执行记录；耗时按服务端当前时间算；typical_ms 是同渠道最近成功任务的平均耗时（开始→成功），没有历史时用保守默认值。
 * previews 为渠道在生成过程中给出的中间图（同源 URL，按出现顺序）；当前 Codex / AGY 适配器的原生协议都不提供中间图，恒为空数组。 */
export interface StudioImageProgress {stage:StudioImageProgressStage;total_ms:number;running_ms:number|null;typical_ms:number;typical_source:'history'|'default';typical_samples:number;previews:string[]}
export interface StudioImageVersion {id:string;operation:StudioImageOperation;paragraph_id:string;placement_paragraph_id:string;position:StudioPlacement;job_id:string|null;asset_id:string|null;state:string;provider:ImageProviderId;description:string;title:string;size_request:StudioSize&{mode:'auto'|'manual';policy:'prompt_guided'};accepted_parameters:JsonObject|null;actual_size:StudioSize|null;size_match:boolean|null;size_warning:string|null;references:StudioReference[];parent_version_id:string|null;document_revision_id:string;created_at:string;adoption:'pending'|'adopted';error:string|null;source?:StudioImageSource;/** 配图方案自动选源导入的网络图（A2）；人工导入或生成的版本没有此字段。 */auto_selected?:boolean;/** 这一版修改时的画面标注（A2-2），不进入成品。 */marks?:StudioMark[];/** 上传或找回的图片（A2-2）。 */upload?:{purpose:StudioUploadPurpose|null;name:string|null};/** 批量重新生成的候选版本，不自动设为当前图（A2-2）。 */candidate_only?:boolean;/** 从已删除配图找回时的原版本（A2-2）。 */recovered_from?:string;/** 请求时选的生图模型（A2-2）。 */model?:string;/** 进行中的 AI 生图的真实进度（只在快照里按任务记录现算，不持久保存）；结束后不再返回。 */progress?:StudioImageProgress}
export interface StudioSlot {id:string;title:string;paragraph_id:string;placement_paragraph_id:string;position:StudioPlacement;description:string;provider:ImageProviderId;size_mode:'auto'|'manual';references:StudioReference[];active_version_id:string|null;versions:StudioImageVersion[]}
export interface StudioSnapshot {topic_id:string;document_id:string;document_revision_id:string;article_text:string;article_source:'wechat'|'core';version:number;paragraphs:Array<{id:string;index:number;text:string}>;slots:StudioSlot[];references:Array<{id:string;mime:string;sha256:string;size_bytes:number;purpose:string}>;capabilities:JsonObject[];briefs:StudioBrief[];recording:{process_record:string;wiki_confirmation_required:true;wiki_record:string|null}}
const id={type:'string',minLength:1,maxLength:100},ref={type:'object',required:['asset_id','purpose'],additionalProperties:false,properties:{asset_id:id,purpose:{type:'string',enum:['style','identity','content']}}};
const properties={topic_id:id,document_revision_id:id,paragraph_id:id,placement_paragraph_id:id,description:{type:'string',minLength:1,maxLength:8000},title:{type:'string',maxLength:300},position:{type:'string',enum:['before','after','cover']},provider:{type:'string',enum:['codex','agy']},references:{type:'array',maxItems:1,items:ref}};
const required=Object.keys(properties);
// 坐标上限放宽到长图；是否落在图内由服务端按原图实际宽高校验（viewBox 高 = 1000×h/w）。
const coord={type:'number',minimum:-10,maximum:1000000};
export const STUDIO_MARK_JSON_SCHEMA={type:'object',required:['id','type','x','y','w','h','ex','ey','path','note'],additionalProperties:false,properties:{id:{type:'integer',minimum:1,maximum:999},type:{type:'string',enum:['rect','brush','arrow','text']},x:coord,y:coord,w:coord,h:coord,ex:coord,ey:coord,path:{type:'string',maxLength:6000},note:{type:'string',maxLength:300},text:{type:'string',maxLength:200}}};
export const StudioBriefSchema=objectSchema<StudioBriefInput>(required,properties,v=>{if(!String(v.description).trim())throw new ContractError('VALIDATION_ERROR','填写画面说明');});
export const StudioGenerationSchema=objectSchema<StudioGenerationRequest>([...required,'expected_version','slot_id','parent_version_id','operation','size_mode','size','brief_id'],{...properties,expected_version:{type:'integer',minimum:1},slot_id:{type:['string','null'],minLength:1,maxLength:100},operation:{type:'string',enum:['generate','reference_edit']},parent_version_id:{type:['string','null'],minLength:1,maxLength:100},size_mode:{type:'string',enum:['auto','manual']},brief_id:{type:['string','null'],minLength:1,maxLength:100},marks:{type:'array',maxItems:30,items:STUDIO_MARK_JSON_SCHEMA},candidate_only:{type:'boolean'},model:{type:'string',minLength:1,maxLength:100},size:{type:'object',required:['width','height','aspect_ratio'],additionalProperties:false,properties:{width:{type:'integer',minimum:320,maximum:4096},height:{type:'integer',minimum:320,maximum:4096},aspect_ratio:{type:'string',minLength:1,maxLength:20}}}},v=>{StudioBriefSchema.parse(Object.fromEntries(required.map(k=>[k,v[k]])));const s=v.size as StudioSize;const match=/^(\d+):(\d+)$/.exec(s.aspect_ratio);if(!match||!Number(match[1])||!Number(match[2])||Math.abs(s.width/s.height-Number(match[1])/Number(match[2]))>0.01)throw new ContractError('VALIDATION_ERROR','比例与期望像素宽高不一致');});
export const StudioAdoptSchema=objectSchema<{topic_id:string;expected_version:number;version_id:string}>(['topic_id','expected_version','version_id'],{topic_id:id,expected_version:{type:'integer',minimum:1},version_id:id});
export const StudioWebImportSchema=objectSchema<StudioWebImportRequest>(['topic_id','expected_version','slot_id','candidate'],{topic_id:id,expected_version:{type:'integer',minimum:1},slot_id:{type:['string','null'],minLength:1,maxLength:100},candidate:{type:'object',required:['candidate_id','image_url'],additionalProperties:false,properties:{candidate_id:{type:'string',minLength:1,maxLength:100},image_url:{type:'string',minLength:1,maxLength:8192}}}});
export const StudioAssetVersionSchema=objectSchema<StudioAssetVersionRequest>(['topic_id','expected_version','slot_id','asset_id'],{topic_id:id,expected_version:{type:'integer',minimum:1},slot_id:id,asset_id:id,purpose:{type:'string',enum:[...STUDIO_UPLOAD_PURPOSES]},name:{type:'string',maxLength:120},recover_version_id:id});
export const StudioConfirmSchema=objectSchema<{topic_id:string;document_revision_id:string;expected_version:number;confirmed:true}>(['topic_id','document_revision_id','expected_version','confirmed'],{topic_id:id,document_revision_id:id,expected_version:{type:'integer',minimum:1},confirmed:{type:'boolean'}},v=>{if(v.confirmed!==true)throw new ContractError('VALIDATION_ERROR','仅本人明确确认终稿后整理到 Wiki');});

// Explicit HTTP response shapes; JSON capability/native data is preserved without inventing native parameters.
const response=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const text={type:'string'},nullableText={type:['string','null']},json={type:'object',additionalProperties:true},integer={type:'integer'},array=(items:unknown)=>({type:'array',items}),link=(name:string)=>({$ref:'#/components/schemas/'+name});
const optional=(schema:{required:string[]}&Record<string,unknown>,keys:string[])=>({...schema,required:schema.required.filter(k=>!keys.includes(k))});
const size=response({width:integer,height:integer,aspect_ratio:text});
const webPlatform={enum:['x','douyin','article']};
const source=response({page_url:text,image_url:text,page_title:nullableText,author:nullableText,site:nullableText,platform:webPlatform,captured_at:text,credit_label:text});
const candidateProperties={candidate_id:text,image_url:text,thumb_url:text,width:integer,height:integer,platform:webPlatform,record_id:text,page_url:text,page_title:text,author_name:text,site_name:text,published_at:text,expires_at:text,availability:{enum:['available','expired','unknown']},truncated:{type:'boolean',description:'原文网页超过 2MB 时只解析前 2MB，候选可能不全；已列出的图片照常可导入。'},credit_label:text};
export const STUDIO_RESPONSE_SCHEMAS={
 StudioSize:size,
 StudioBrief:response({...properties,id:text,reason:text,suggested_size:link('StudioSize'),content_analysis:json,native:json,input_digest:text,created_at:text}),
 StudioImageVersion:optional(response({id:text,operation:{enum:['generate','reference_edit','web_import','upload']},paragraph_id:text,placement_paragraph_id:text,position:properties.position,job_id:nullableText,asset_id:nullableText,state:text,provider:properties.provider,description:text,title:text,size_request:response({width:integer,height:integer,aspect_ratio:text,mode:{enum:['auto','manual']},policy:{const:'prompt_guided'}}),accepted_parameters:{type:['object','null'],additionalProperties:true},actual_size:{anyOf:[link('StudioSize'),{type:'null'}]},size_match:{type:['boolean','null']},size_warning:nullableText,references:properties.references,parent_version_id:nullableText,document_revision_id:text,created_at:text,adoption:{enum:['pending','adopted']},error:nullableText,source:link('StudioImageSource'),auto_selected:{type:'boolean'},marks:array(STUDIO_MARK_JSON_SCHEMA),upload:response({purpose:{enum:[...STUDIO_UPLOAD_PURPOSES,null]},name:nullableText}),candidate_only:{type:'boolean'},recovered_from:text,model:text,progress:link('StudioImageProgress')}),['source','auto_selected','marks','upload','candidate_only','recovered_from','model','progress']),
 StudioImageProgress:response({stage:{enum:['queued','starting','generating','saving','checking']},total_ms:integer,running_ms:{type:['integer','null']},typical_ms:integer,typical_source:{enum:['history','default']},typical_samples:integer,previews:array(text)}),
 StudioImageSource:source,
 StudioWebImageCandidate:optional(response(candidateProperties),['thumb_url','width','height','page_title','author_name','site_name','published_at','expires_at','truncated']),
 StudioWebCaptureStatus:response({state:{enum:['fresh','refreshing','stale','failed']},pages_total:integer,pages_ready:integer,pages_failed:integer,refreshed_at:nullableText}),
 StudioWebImageCandidates:response({candidates:array(link('StudioWebImageCandidate')),capture:link('StudioWebCaptureStatus')}),
 StudioWebImportResult:response({slot_id:text,version_id:text,asset_id:text,deduplicated:{type:'boolean'},version:integer}),
 StudioSlot:response({id:text,title:text,paragraph_id:text,placement_paragraph_id:text,position:properties.position,description:text,provider:properties.provider,size_mode:{enum:['auto','manual']},references:properties.references,active_version_id:nullableText,versions:array(link('StudioImageVersion'))}),
 StudioSnapshot:response({topic_id:text,document_id:text,document_revision_id:text,article_text:text,article_source:{enum:['wechat','core']},version:integer,paragraphs:array(response({id:text,index:integer,text})),slots:array(link('StudioSlot')),references:array(response({id:text,mime:text,sha256:text,size_bytes:integer,purpose:text})),capabilities:array(json),briefs:array(link('StudioBrief')),recording:response({process_record:text,wiki_confirmation_required:{const:true},wiki_record:nullableText})}),
 StudioAssetVersionResult:response({slot_id:text,version_id:text,asset_id:text,version:integer}),
 StudioGenerationAccepted:response({job_id:text,slot_id:text,version_id:text,input_hash:text}),
};
