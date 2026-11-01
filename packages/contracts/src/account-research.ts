import { ContractError } from './errors.ts';
import type { JsonObject } from './common.ts';
import type { ContentExecutor } from './generation.ts';

export const ACCOUNT_RESEARCH_VERSION = 'account-research/1';
export const RESEARCH_DIMENSIONS = ['structure','expression','operations','audience','trends'] as const;
export const RESEARCH_GOALS = ['professional_influence','consistent_quality','followers','consulting'] as const;
export type ResearchDimension = typeof RESEARCH_DIMENSIONS[number];
export type ResearchGoal = typeof RESEARCH_GOALS[number];
export interface ResearchStatement { text:string; evidence_keys:string[] }
export interface AccountResearchReport {
 schema_version:1; summary:string;
 facts:ResearchStatement[];
 analyses:Array<ResearchStatement&{dimension:ResearchDimension;status:'supported'|'insufficient'}>;
 samples:Array<ResearchStatement&{source_id:string;polarity:'positive'|'negative'|'contrast';aspect:string;analysis_scope:'written_text'|'video_description'|'spoken_text';performance_claim:'comparable'|'not_comparable'}>;
 hypotheses:Array<ResearchStatement&{missing_evidence:string}>;
 recommendations:Array<ResearchStatement&{goal:ResearchGoal;action:string;prerequisite:string;measurement:string;adoption_status:'proposed'}>;
 limitations:string[];
}
export interface ResearchSample {
 source_id:string;work_id:string;title:string;url:string;published_at:string|null;format:string|null;
 selection:'recent'|'higher_observed'|'lower_observed'|'contrast';content_basis:'full_text'|'platform_caption'|'transcript'|'description_only'|'summary_only';
 evidence_keys:string[];comparison_group:string|null;snapshot_id:string|null;metric_key:string|null;metric_value:string|null;
}
export interface AccountResearchPlan {
 account_id:string;strategy_version:string;input_version:string;source_record_ids:string[];samples:ResearchSample[];
 coverage:{eligible_count:number;sample_count:number;excluded_count:number;full_text_count:number;video_count:number;transcribed_video_count:number;transcription_rate:number|null;window_start:string|null;window_end:string|null;window_days:number};
 comparisons:{status:'available'|'insufficient';groups:number;reason:string};
 trends:{account:'comparable'|'captures_only'|'insufficient';works:'comparable'|'captures_only'|'insufficient';profile_capture_count:number;account_snapshot_count:number;repeated_work_count:number;reason:string};
 skill:{id:string;name:string;sha256:string}|null;limitations:string[];blocked:string|null;
}
export interface AccountResearchHistoryItem {
 document_id:string;job_id:string;created_at:string;state:string;version:number;executor:ContentExecutor;input_version:string|null;source_ids:string[];
 candidate_id:string|null;candidate_status:string|null;revision_id:string|null;adopted_revision_id:string|null;
 skill_name:string|null;skill_sha256:string|null;model:string|null;reasoning_effort:string|null;error:string|null;
 coverage:AccountResearchPlan['coverage']|null;
}
export interface AccountResearchView { plan:AccountResearchPlan;history:AccountResearchHistoryItem[] }
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const invalid=(message:string):never=>{throw new ContractError('VALIDATION_ERROR',message);};
export function validateAccountResearchReport(value:unknown,allowedKeys:string[],sourceIds:string[],options:{comparison_groups?:Record<string,string>;content_bases?:Record<string,ResearchSample['content_basis']>;account_trend_comparable?:boolean}={}):asserts value is AccountResearchReport {
 if(!object(value)||value.schema_version!==1||typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>5000||Object.keys(value).some(k=>!['schema_version','summary','facts','analyses','samples','hypotheses','recommendations','limitations'].includes(k)))invalid('研究报告必须按固定结构返回');
 const report=value as Record<string,unknown>,keys=new Set(allowedKeys),sources=new Set(sourceIds),groups=options.comparison_groups??{},bases=options.content_bases??{};
 const statements=(name:string,min:number,max:number,extras:string[])=>{
  const rows=report[name];if(!Array.isArray(rows)||rows.length<min||rows.length>max)invalid('研究报告 '+name+' 数量不符合约定');
  for(const row of rows as unknown[]){if(!object(row)||typeof row.text!=='string'||!row.text.trim()||row.text.length>5000||!Array.isArray(row.evidence_keys)||row.evidence_keys.some(k=>typeof k!=='string'||!keys.has(k))||Object.keys(row).some(k=>!['text','evidence_keys',...extras].includes(k)))invalid('研究报告引用不属于冻结材料或条目结构无效');}
  return rows as Array<Record<string,unknown>>;
 };
 const facts=statements('facts',1,30,[]);if(facts.some(row=>!(row.evidence_keys as string[]).length))invalid('研究事实必须引用固定依据');
 const analyses=statements('analyses',5,15,['dimension','status']);
 for(const dimension of RESEARCH_DIMENSIONS)if(!analyses.some(row=>row.dimension===dimension))invalid('研究报告缺少内容、表达、运营、受众或趋势分析');
 for(const row of analyses)if(!RESEARCH_DIMENSIONS.includes(row.dimension as ResearchDimension)||!['supported','insufficient'].includes(String(row.status))||(row.status==='supported'&&!(row.evidence_keys as string[]).length))invalid('分析维度、证据状态或引用无效');
 const samples=statements('samples',Math.min(2,sourceIds.length),24,['source_id','polarity','aspect','analysis_scope','performance_claim']);
 for(const row of samples){
  if(!sources.has(String(row.source_id))||!['positive','negative','contrast'].includes(String(row.polarity))||typeof row.aspect!=='string'||!row.aspect.trim()||!['comparable','not_comparable'].includes(String(row.performance_claim))||!(row.evidence_keys as string[]).includes('source:'+row.source_id)||!['written_text','video_description','spoken_text'].includes(String(row.analysis_scope)))invalid('样本拆解必须引用本条素材并写明分析范围');
  if(row.analysis_scope==='spoken_text'&&!['platform_caption','transcript'].includes(bases[String(row.source_id)]??''))invalid('没有字幕或转写正文，不能拆完整口播');
  if(row.analysis_scope==='written_text'&&bases[String(row.source_id)]==='description_only')invalid('视频说明不能冒充完整正文');
  if(row.performance_claim==='comparable'&&(!groups[String(row.source_id)]||!samples.some(other=>other.source_id!==row.source_id&&other.performance_claim==='comparable'&&groups[String(other.source_id)]===groups[String(row.source_id)])))invalid('表现对照须有足量可比组中的两条同组作品');
 }
 if(new Set(samples.map(row=>row.source_id)).size<Math.min(2,sourceIds.length))invalid('样本对照不能重复同一作品');
 for(const row of statements('hypotheses',1,12,['missing_evidence']))if(typeof row.missing_evidence!=='string'||!row.missing_evidence.trim())invalid('假设必须写出仍缺的证据');
 const recommendations=statements('recommendations',4,12,['goal','action','prerequisite','measurement','adoption_status']);
 for(const goal of RESEARCH_GOALS)if(!recommendations.some(row=>row.goal===goal))invalid('研究建议须分别回应影响力、质量、涨粉和咨询目标');
 for(const row of recommendations)if(!RESEARCH_GOALS.includes(row.goal as ResearchGoal)||row.adoption_status!=='proposed'||['action','prerequisite','measurement'].some(k=>typeof row[k]!=='string'||!String(row[k]).trim()))invalid('建议必须有行动、适用条件、观察办法，且等待人工采用');
 if(!Array.isArray(report.limitations)||!report.limitations.length||report.limitations.length>20||report.limitations.some(v=>typeof v!=='string'||!v.trim()))invalid('研究报告必须写明数据与使用边界');
 // 增粉的因果效果不能从对标互动或两次资料采集推导；即使快照可比也不证明创作因果。
 const factualText=[report.summary,...facts.map(row=>row.text),...analyses.filter(row=>row.status==='supported').map(row=>row.text),...samples.flatMap(row=>[row.aspect,row.text])].join('\n');
 const causePattern=/(?:带来|导致|使其|因此|所以).{0,20}?(?:涨粉|增粉|粉丝增长)/,numericPattern=/(?:涨粉|增粉|粉丝增长).{0,12}?\d/;
 const asserted=(pattern:RegExp,causal=false)=>factualText.split(/[。；;\n]/).some(statement=>{
  // 转折和并列引出独立命题，否定/假设不能越过这些边界豁免新结果。
  const clauses=statement.split(/[，,]|但(?:是)?|然而|不过|而是|并且|且|而/).map(clause=>clause.trim()).filter(Boolean);
  const experiment=/(?:(?:仍需|需要|需|有待).{0,16}(?:实验|试验|检验|验证|复核|证据|观察)|待(?:验证|检验|证实)|下一条.{0,12}(?:实验|试验|观察)|尚未发布|假定条件)/.test(statement);
  return clauses.some((clause,clauseIndex)=>{
   // 实绩语气只属于当前命题，另一被否定命题中的“实际”不能影响这里。
   const actual=/(?:实际|确实|已经|已)(?:.{0,4})(?:导致|带来|涨粉|增粉|粉丝增长)/.test(clause);
   // “如果 A 导致增长，则本次实际涨粉”仍肯定了条件的结果；按因果规则核对。
   const conditionalResult=causal&&/^则/.test(clause)&&clauses.slice(0,clauseIndex).some(prior=>/(?:如果|假如|若)/.test(prior)&&causePattern.test(prior));
   const effectPattern=pattern.source+(conditionalResult?'|'+numericPattern.source:'');
   for(const match of clause.matchAll(new RegExp('(?='+effectPattern+')','g'))){
    const prefix=clause.slice(0,match.index),suffix=clause.slice(match.index);
    // 否定须指向证明/判断这一效果，而不是任意出现的“不能”或“不是”。
    const denial=[...prefix.matchAll(/(?:不能|无法|不足以|未能)(?:直接|据此)?(?:证明|支持|断言|确认|认定|判断)|(?:不证明|不支持|未证明)|(?:尚无证据|没有证据|无证据|缺乏证据)(?:证明|支持|表明)?/g)].at(-1);
    const denialObject=denial?prefix.slice(denial.index+denial[0].length):'';
    const deniedBefore=!!denial&&!/(?:显示|表明|证实|宣称|声称|发现)/.test(denialObject)
     ||/(?:并)?不是(?:由)?(?:(?:这个|该|此|这类)?(?:标题|内容|写法|文案|开头)(?:所)?(?:已经|已)?(?:带来|导致|使其|因此|所以)?)?$/.test(prefix);
    // 后置否定必须明确指代当前说法；逗号后指代仍有效，其他命题单独校验。
    const evidenceDenial='(?:说法|结论|声明|推断|因果(?:关系)?)(?:目前|仍|尚)?(?:无证据|没有证据|缺乏证据|未获证实|未得到支持)';
    const deniedAfter=new RegExp('(?:这一|这个|该|上述)?'+evidenceDenial).test(suffix)
     ||new RegExp('^(?:这一|这个|该|上述)'+evidenceDenial).test(clauses[clauseIndex+1]??'');
    const hypothetical=!actual&&/(?:待验证假设|假设[:：])/.test(prefix)&&/(?:可能|或许|也许)(?:会|能)?(?:(?:带来|导致|使其|因此|所以)(?:更多|持续)?)?$/.test(prefix);
    // 显式条件只有在实验/缺证据语境下才是待验证条件，不能仅靠“如果”绕过实绩。
    const conditional=!actual&&experiment&&/(?:如果|假如|若)/.test(prefix);
    const futureObservation=!actual&&/(?:下一条|后续|未来|计划).{0,20}(?:实验|试验|观察|检验|验证).{0,12}(?:能否|是否|会不会)/.test(prefix);
    // 要求通过实验验证某个效果的问题，并未肯定效果已发生；问题必须紧贴谓词。
    const pendingVerification=!actual&&/(?:仍需|需要|需|有待)(?:通过|进行|开展)?(?:本人|后续)?(?:实验|试验)(?:来|去)?(?:验证|检验|观察).{0,12}(?:能否|是否|会不会)(?:会|能)?(?:(?:带来|导致|使其|因此|所以)(?:更多|持续)?)?$/.test(prefix);
    if(!deniedBefore&&!deniedAfter&&!hypothetical&&!conditional&&!futureObservation&&!pendingVerification)return true;
   }
   return false;
  });
 });
 if(asserted(causePattern,true))invalid('账号快照变化不能证明创作导致增粉');
 if(asserted(numericPattern)&&options.account_trend_comparable!==true)invalid('没有可比账号观察数据，不能声明增粉实绩');
}

const text:JsonObject={type:'string'},nonempty:JsonObject={type:'string',minLength:1},nullable:JsonObject={type:['string','null']},integer:JsonObject={type:'integer',minimum:0};
const record=(properties:Record<string,JsonObject>):JsonObject=>({type:'object',required:Object.keys(properties),additionalProperties:false,properties});
const array=(items:JsonObject,maxItems=100):JsonObject=>({type:'array',items,maxItems});
const ref=(name:string):JsonObject=>({$ref:'#/components/schemas/'+name});
const statement={text:{...nonempty,maxLength:5000},evidence_keys:{...array(nonempty),uniqueItems:true}};
const coverage=record({eligible_count:integer,sample_count:integer,excluded_count:integer,full_text_count:integer,video_count:integer,transcribed_video_count:integer,transcription_rate:{type:['number','null'],minimum:0,maximum:1},window_start:nullable,window_end:nullable,window_days:integer});
export const ACCOUNT_RESEARCH_RESPONSE_SCHEMAS:Record<string,JsonObject>={
 AccountResearchReport:record({schema_version:{type:'integer',const:1},summary:{...nonempty,maxLength:5000},facts:{...array(record(statement),30),minItems:1},analyses:{...array(record({...statement,dimension:{enum:[...RESEARCH_DIMENSIONS]},status:{enum:['supported','insufficient']}}),15),minItems:5},samples:{...array(record({...statement,source_id:nonempty,polarity:{enum:['positive','negative','contrast']},aspect:nonempty,analysis_scope:{enum:['written_text','video_description','spoken_text']},performance_claim:{enum:['comparable','not_comparable']}}),24),minItems:1},hypotheses:{...array(record({...statement,missing_evidence:nonempty}),12),minItems:1},recommendations:{...array(record({...statement,goal:{enum:[...RESEARCH_GOALS]},action:nonempty,prerequisite:nonempty,measurement:nonempty,adoption_status:{const:'proposed'}}),12),minItems:4},limitations:{...array(nonempty,20),minItems:1}}),
 ResearchSample:record({source_id:nonempty,work_id:nonempty,title:text,url:nonempty,published_at:nullable,format:nullable,selection:{enum:['recent','higher_observed','lower_observed','contrast']},content_basis:{enum:['full_text','platform_caption','transcript','description_only','summary_only']},evidence_keys:array(nonempty),comparison_group:nullable,snapshot_id:nullable,metric_key:nullable,metric_value:nullable}),
 AccountResearchPlan:record({account_id:nonempty,strategy_version:nonempty,input_version:{type:'string',pattern:'^[a-f0-9]{64}$'},source_record_ids:array(nonempty,12),samples:array(ref('ResearchSample'),12),coverage,comparisons:record({status:{enum:['available','insufficient']},groups:integer,reason:nonempty}),trends:record({account:{enum:['comparable','captures_only','insufficient']},works:{enum:['comparable','captures_only','insufficient']},profile_capture_count:integer,account_snapshot_count:integer,repeated_work_count:integer,reason:nonempty}),skill:{...record({id:nonempty,name:nonempty,sha256:nonempty}),type:['object','null']},limitations:array(nonempty,20),blocked:nullable}),
 AccountResearchHistoryItem:record({document_id:nonempty,job_id:nonempty,created_at:text,state:text,version:{type:'integer',minimum:1},executor:{enum:['codex','claude']},input_version:nullable,source_ids:array(nonempty),candidate_id:nullable,candidate_status:nullable,revision_id:nullable,adopted_revision_id:nullable,skill_name:nullable,skill_sha256:nullable,model:nullable,reasoning_effort:nullable,error:nullable,coverage:{...coverage,type:['object','null']}}),
 AccountResearchView:record({plan:ref('AccountResearchPlan'),history:array(ref('AccountResearchHistoryItem'),30)}),
};
