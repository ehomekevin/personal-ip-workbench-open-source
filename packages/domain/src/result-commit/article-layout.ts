import {ContractError,type JobsRow,type JobAttemptsRow} from '@workbench/contracts';
import type {ApplicationContext} from '../ports/index.ts';
import {digest,assertArticleSnapshot} from '../article-layout/index.ts';
import {readVisualRecord,type ArticleVisualJobRecord,type ArticleVisualRenderRecord} from '../../../storage/src/article-layout/visual-store.ts';
import {SqliteLayoutCheckJournalV2,readLayoutCheckAdmissionReservationV2} from '../../../storage/src/article-layout/check-admission.ts';
import {assertLayoutCheckExecutionProof} from '../../../adapters/src/media/layout-check/proof.ts';
import {validateLayoutVisualInput,layoutVisualManifestHash} from '../../../adapters/src/media/layout-check/input.ts';
import {outputHash} from '../../../storage/src/connection/index.ts';
import {getJob,getAttempt} from '../../../storage/src/jobs/index.ts';
import type {LayoutCheckExecution} from '../../../adapters/src/media/layout-check/types.ts';

export interface LayoutCheckOutput {job_id:string;attempt_id:string;attempt_generation:number;render_id:string;context_sha256:string;execution_attempt_id:string;execution_sha256:string}
const keys=['job_id','attempt_id','attempt_generation','render_id','context_sha256','execution_attempt_id','execution_sha256'];
function bad(message:string):never{throw new ContractError('VALIDATION_ERROR',message);}
export function validateLayoutCheckOutput(value:unknown,job:JobsRow):asserts value is LayoutCheckOutput {
 if(job.kind!=='article_layout_check'||job.execution_mode!=='programmatic'||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!(k in value)))bad('视觉输出归属或字段无效');
 const x=value as LayoutCheckOutput,body=JSON.parse(job.input_manifest);
 if(keys.filter(k=>k!=='attempt_generation').some(k=>typeof (x as unknown as Record<string,unknown>)[k]!=='string'||!(x as unknown as Record<string,unknown>)[k])||!Number.isSafeInteger(x.attempt_generation)||x.attempt_generation<1||x.job_id!==job.id||x.render_id!==body.render_id||x.context_sha256!==body.context_sha256||![x.context_sha256,x.execution_sha256].every(h=>/^[a-f0-9]{64}$/.test(h))||body.schema_version!=='article-layout-visual-job.v2'||body.operation!=='layout_visual'||body.mode!=='none'||body.targets.length||body.source_ids.length)bad('视觉输出与固定输入不符');
}
/** Full execution retained privately; never accepts client proof or result booleans. */
export function verifyLayoutCheckOutput(context:ApplicationContext,job:JobsRow,attempt:JobAttemptsRow,output:LayoutCheckOutput):LayoutCheckExecution {
 validateLayoutCheckOutput(output,job);const db=context.db,workspace=job.workspace_id;
 if(output.attempt_id!==attempt.id||output.attempt_generation!==attempt.attempt_generation||attempt.job_id!==job.id)bad('视觉结果SQL代次不符');
 const binding=readVisualRecord<ArticleVisualJobRecord>(db,workspace,'job',job.id),render=readVisualRecord<ArticleVisualRenderRecord>(db,workspace,'render',output.render_id);
 if(!binding||!render||binding.execution_attempt_id!==output.execution_attempt_id||binding.render_id!==render.render_id||binding.topic_id!==render.context.topic_id||render.context.workspace_id!==workspace||render.context_sha256!==output.context_sha256||digest(render.context)!==render.context_sha256||digest(render.snapshot)!==render.context.snapshot_sha256||render.manifest_sha256!==layoutVisualManifestHash(render.input))bad('视觉结果上下文或原始执行绑定不符');
 const admission=readLayoutCheckAdmissionReservationV2(db,workspace,job.id),body=JSON.parse(job.input_manifest);
 if(!admission||admission.intent_id!==binding.intent_id||admission.attempt_id!==output.execution_attempt_id||admission.manifest_sha256!==render.manifest_sha256||admission.context_sha256!==render.context_sha256||admission.authority_sha256!==body.authority_sha256||admission.state!=='completed'||!admission.reserved_at)bad('视觉准入、权限或上下文绑定不符');
 assertArticleSnapshot(render.snapshot);validateLayoutVisualInput(render.input);
 const execution=new SqliteLayoutCheckJournalV2(db,workspace).read(output.execution_attempt_id);
 if(!execution)bad('视觉原journal不存在');assertLayoutCheckExecutionProof(execution);
 if(execution.candidate_sha256!==admission.candidate_sha256||execution.attempt.job_id!==job.id||execution.attempt.id!==binding.intent_id||execution.attempt.state!=='completed'||!execution.attempt.result||execution.submit_count!==1||!execution.proof.original_input_verified||execution.proof.output_sha256!==digest(execution.attempt.result)||digest(execution)!==output.execution_sha256||digest(execution.input_manifest)!==digest(render.input))bad('视觉原生证明或完整执行摘要不符');
 const original=db.prepare('SELECT id,job_id,attempt_generation FROM job_attempts WHERE workspace_id=? AND id=?').get(workspace,execution.attempt.attempt_id);
 if(!original||original.job_id!==job.id||original.attempt_generation!==binding.execution_generation)bad('视觉原始SQL执行不存在');
 if(attempt.id!==original.id){const checkpoint=JSON.parse(attempt.checkpoint);if(checkpoint.layout_original_attempt_id!==original.id||checkpoint.layout_query_only!==true)bad('视觉恢复未固定原身份');}
 return execution;
}
export function loadCommittedLayoutExecution(context:ApplicationContext,executionAttemptId:string):LayoutCheckExecution|null {
 const ws=context.identity.workspace_id,execution=new SqliteLayoutCheckJournalV2(context.db,ws).read(executionAttemptId);if(!execution)return null;
 const job=getJob(context.db,ws,execution.attempt.job_id);if(job.state!=='succeeded'||job.cancel_requested_at||!job.current_attempt_id)return null;
 const row=context.db.prepare("SELECT * FROM result_receipts WHERE workspace_id=? AND job_id=? AND attempt_id=? AND attempt_generation=? AND state='committed'").get(ws,job.id,job.current_attempt_id,job.attempt_generation);if(!row)return null;
 const payload=JSON.parse(String(row.output_payload)),typed=payload.typed_output;
 if(row.input_hash!==job.input_hash||row.output_hash!==outputHash(payload)||Object.keys(typed).sort().join(',')!=='documents,layout_check,recommendations'||!Array.isArray(typed.documents)||typed.documents.length||!Array.isArray(typed.recommendations)||typed.recommendations.length||typed.layout_check?.execution_attempt_id!==executionAttemptId)bad('已提交视觉收据绑定不符');
 return verifyLayoutCheckOutput(context,job,getAttempt(context.db,ws,job.current_attempt_id),typed.layout_check);
}
