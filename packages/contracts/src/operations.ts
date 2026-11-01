import { objectSchema } from './validation.ts';
import { ContractError } from './errors.ts';
import type { DocumentSnapshot } from './requests.ts';

export interface OperationsBrief { reader_task:string; takeaway:string; personal_addition:string; evidence:string; goal:string; reader_next_step:string }
export interface ReaderFeedback { id:string; kind:'question'|'attempt'|'obstacle'|'business'|'response'; text:string; source:string; recorded_at:string; provenance?:'human'|'platform'; work_id?:string; work_url?:string; platform_comment_id?:string; commented_at?:string|null; author_name?:string|null; is_author?:boolean|null }
export interface FollowupContent { topic_id:string; title:string; new_help:string; candidate_id?:string; proposal_id?:string; source_version?:string }
export interface TopicOperations { schema_version:1; brief:OperationsBrief; feedback:ReaderFeedback[]; followups:FollowupContent[]; confirmed_generation?:{candidate_id:string;source_version:string} }
export interface TopicOperationsSnapshot { topic_id:string; document:DocumentSnapshot|null; data:TopicOperations; automation?:OperationsAutomation }
export interface SaveTopicOperationsRequest { expected_revision_id:string|null; data:TopicOperations }
export function emptyTopicOperations():TopicOperations { return {schema_version:1,brief:{reader_task:'',takeaway:'',personal_addition:'',evidence:'',goal:'',reader_next_step:''},feedback:[],followups:[]}; }
const text={type:'string',maxLength:12000},short={type:'string',minLength:1,maxLength:300};
const brief={type:'object',additionalProperties:false,required:['reader_task','takeaway','personal_addition','evidence','goal','reader_next_step'],properties:{reader_task:text,takeaway:text,personal_addition:text,evidence:text,goal:text,reader_next_step:text}};
export const SaveTopicOperationsSchema=objectSchema<SaveTopicOperationsRequest>(['expected_revision_id','data'],{
  expected_revision_id:{type:['string','null']},
  data:{type:'object',additionalProperties:false,required:['schema_version','brief','feedback','followups'],properties:{
    schema_version:{type:'integer',enum:[1]},brief,
    feedback:{type:'array',maxItems:1000,items:{type:'object',additionalProperties:false,required:['id','kind','text','source','recorded_at'],properties:{id:short,kind:{type:'string',enum:['question','attempt','obstacle','business','response']},text:{...text,minLength:1},source:text,recorded_at:short,provenance:{enum:['human','platform']},work_id:short,work_url:text,platform_comment_id:short,commented_at:{type:['string','null']},author_name:{type:['string','null']},is_author:{type:['boolean','null']}}}},
    followups:{type:'array',maxItems:200,items:{type:'object',additionalProperties:false,required:['topic_id','title','new_help'],properties:{topic_id:short,title:short,new_help:{...text,minLength:1},candidate_id:short,proposal_id:short,source_version:short}}},confirmed_generation:{type:'object',additionalProperties:false,required:['candidate_id','source_version'],properties:{candidate_id:short,source_version:short}}
  }}
});

export interface OperationsFollowupProposal { id:string; title:string; new_help:string; evidence_keys:string[] }
export interface OperationsCandidateData { schema_version:1; brief:OperationsBrief; feedback_labels:Array<{id:string;kind:ReaderFeedback['kind']}>; followups:OperationsFollowupProposal[]; limitations:string[] }
export interface OperationsCandidateView { id:string; status:'pending'|'adopted'|'rejected'|'conflict'; base_operations_revision_id:string|null; data:OperationsCandidateData; feedback:ReaderFeedback[] }
export interface OperationsAutomation { source_version:string; input_version:string; state:'missing'|'queued'|'running'|'waiting_input'|'waiting_quota'|'failed'|'candidate'|'confirmed'|'rejected'|'stale'|'blocked'; job_id:string|null; job_version:number|null; candidate:OperationsCandidateView|null; limitations:string[]; feedback_status:string; error:string|null }
export interface EnsureTopicOperationsRequest { retry?:boolean; refresh_feedback?:boolean }
export interface DecideTopicOperationsRequest { candidate_id:string; expected_revision_id:string|null; decision:'confirm'|'reject'; brief?:OperationsBrief; feedback_ids?:string[]; followups?:OperationsFollowupProposal[] }
export const OperationsCandidateSchema=objectSchema<OperationsCandidateData>(['schema_version','brief','feedback_labels','followups','limitations'],{
 schema_version:{const:1},brief,
 feedback_labels:{type:'array',maxItems:1000,items:{type:'object',additionalProperties:false,required:['id','kind'],properties:{id:short,kind:{enum:['question','attempt','obstacle','business','response']}}}},
 followups:{type:'array',maxItems:5,items:{type:'object',additionalProperties:false,required:['id','title','new_help','evidence_keys'],properties:{id:short,title:short,new_help:{...text,minLength:1},evidence_keys:{type:'array',minItems:1,maxItems:30,items:short}}}},
 limitations:{type:'array',maxItems:30,items:short}
});
export const EnsureTopicOperationsSchema=objectSchema<EnsureTopicOperationsRequest>([],{retry:{type:'boolean'},refresh_feedback:{type:'boolean'}});
export const DecideTopicOperationsSchema=objectSchema<DecideTopicOperationsRequest>(['candidate_id','expected_revision_id','decision'],{
 candidate_id:short,expected_revision_id:{type:['string','null']},decision:{enum:['confirm','reject']},brief,
 feedback_ids:{type:'array',maxItems:1000,uniqueItems:true,items:short},
 followups:(OperationsCandidateSchema.jsonSchema.properties as Record<string,Record<string,unknown>>).followups!
});

export function validateOperationsCandidate(value:unknown,feedbackIds:string[],evidenceKeys:string[]):OperationsCandidateData {
 const data=OperationsCandidateSchema.parse(value),seen=new Set<string>();
 for(const label of data.feedback_labels){if(seen.has(label.id)||!feedbackIds.includes(label.id))throw new ContractError('VALIDATION_ERROR','反馈分类必须引用固定的真实反馈');seen.add(label.id);}
 seen.clear();for(const next of data.followups){if(seen.has(next.id)||!next.title.trim()||!next.new_help.trim()||next.evidence_keys.some(key=>!evidenceKeys.includes(key)))throw new ContractError('VALIDATION_ERROR','后续建议需说明新增帮助并引用本次固定依据');seen.add(next.id);}
 return data;
}
