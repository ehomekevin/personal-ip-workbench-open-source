import type { JsonObject,Platform,ContentFormat } from './common.ts';
import type { FrozenComparisonBaseline,ComparisonAggregation,ComparisonRun } from './comparisons.ts';
import type { CreateTopicRequest,DocumentSnapshot } from './requests.ts';
import type { ActionAdoptionsRow,AdoptionWorksRow,ActionEvaluationsRow,RetroActionsRow,RetroReportsRow } from './entities.ts';
import { PLATFORMS,FORMATS } from './common.ts';
import { objectSchema,CreateTopicSchema } from './validation.ts';
import { ContractError } from './errors.ts';
export interface ObservationPlanInput { platform:Platform; account_id:string; format:ContentFormat; metric_definition_id:string; timezone:string; aggregation:ComparisonAggregation; observation_window_h:number; tolerance_h:number; min_target_samples:number; earliest_evaluation_at:string|null; baseline_run_id:string|null; baseline_cohort_key:string|null }
export interface ObservationPlan extends ObservationPlanInput { schema_version:'retro-observation-v1'; baseline_input_hash:string|null; frozen_baseline:FrozenComparisonBaseline|null }
export interface CreateRetroActionRequest { report_revision_id:string; description:string; hypothesis:string; metric:string; observation_plan:ObservationPlanInput }
export interface AdoptRetroActionRequest { target_topic_id?:string; create_topic?:CreateTopicRequest; variant_id?:string|null; observation_plan:ObservationPlanInput }
export interface LinkAdoptionWorkRequest { work_id:string; link_evidence:JsonObject }
export interface CreateAdoptionComparisonRequest { target_work_ids:string[]; target_as_of:string }
export interface CreateAdoptionEvaluationRequest { comparison_run_id:string; result:'supported'|'not_supported'|'mixed'|'insufficient'; limitations:string }
export interface CreateBusinessEventRequest { kind:string; time:string; count?:string|null; amount?:string|null; work_id?:string|null; topic_id?:string|null; note:string; attribution:'unknown'|'user_reported'|'source_verified' }
const nonempty={type:'string',minLength:1},nullable={type:['string','null']};
const planProperties={platform:{type:'string',enum:[...PLATFORMS]},account_id:nonempty,format:{type:'string',enum:[...FORMATS]},metric_definition_id:nonempty,timezone:nonempty,aggregation:{type:'string',enum:['sum','mean','median']},observation_window_h:{type:'integer',minimum:1},tolerance_h:{type:'integer',minimum:0},min_target_samples:{type:'integer',minimum:1},earliest_evaluation_at:nullable,baseline_run_id:nullable,baseline_cohort_key:nullable};
const planSchema={type:'object',additionalProperties:false,required:Object.keys(planProperties),properties:planProperties};
function checkPlan(value:Record<string,unknown>):void {const plan=value.observation_plan as ObservationPlanInput;if((plan.baseline_run_id===null)!==(plan.baseline_cohort_key===null))throw new ContractError('VALIDATION_ERROR','基线运行与 cohort 必须同时提供');}
export const CreateRetroActionSchema=objectSchema<CreateRetroActionRequest>(['report_revision_id','description','hypothesis','metric','observation_plan'],{report_revision_id:nonempty,description:nonempty,hypothesis:nonempty,metric:nonempty,observation_plan:planSchema},checkPlan);
export const AdoptRetroActionSchema=objectSchema<AdoptRetroActionRequest>(['observation_plan'],{target_topic_id:nonempty,create_topic:CreateTopicSchema.jsonSchema,variant_id:nullable,observation_plan:planSchema},value=>{checkPlan(value);if(('target_topic_id' in value)===('create_topic' in value))throw new ContractError('VALIDATION_ERROR','选择现有主题或创建主题');if(value.create_topic)CreateTopicSchema.parse(value.create_topic);});
export const LinkAdoptionWorkSchema=objectSchema<LinkAdoptionWorkRequest>(['work_id','link_evidence'],{work_id:nonempty,link_evidence:{type:'object'}});
export const CreateAdoptionComparisonSchema=objectSchema<CreateAdoptionComparisonRequest>(['target_work_ids','target_as_of'],{target_work_ids:{type:'array',minItems:1,items:nonempty},target_as_of:nonempty});
export const CreateAdoptionEvaluationSchema=objectSchema<CreateAdoptionEvaluationRequest>(['comparison_run_id','result','limitations'],{comparison_run_id:nonempty,result:{type:'string',enum:['supported','not_supported','mixed','insufficient']},limitations:{type:'string'}});
export const CreateBusinessEventSchema=objectSchema<CreateBusinessEventRequest>(['kind','time','note','attribution'],{kind:nonempty,time:nonempty,count:nullable,amount:nullable,work_id:nullable,topic_id:nullable,note:{type:'string'},attribution:{type:'string',enum:['unknown','user_reported','source_verified']}});

export interface AdoptionTarget { topic_id:string; core_revision_id:string|null; variant_id:string|null; variant_revision_id:string|null }
export interface FrozenAdoptionPlan extends ObservationPlan { target:AdoptionTarget; adoption_request_hash:string }
export interface RetroAdoption extends Omit<ActionAdoptionsRow,'observation_plan'> { observation_plan:FrozenAdoptionPlan; works:AdoptionWork[]; evaluations:ActionEvaluation[] }
export interface AdoptionWork extends Omit<AdoptionWorksRow,'link_evidence'> { link_evidence:JsonObject }
export interface ActionEvaluation extends Omit<ActionEvaluationsRow,'limitations'> { limitations:string }
export interface RetroAction extends Omit<RetroActionsRow,'observation_plan'> { observation_plan:ObservationPlanInput; adoptions:RetroAdoption[] }
export interface RetroReport extends Omit<RetroReportsRow,'source_record_ids'> { source_record_ids:string[]; action_ids:string[]; revision_ids:string[] }
export interface RetroReportDetail extends RetroReport { document:DocumentSnapshot; actions:RetroAction[]; comparison:ComparisonRun }
