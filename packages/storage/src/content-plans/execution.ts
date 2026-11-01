import type {JobState,PlanExecutionSnapshot,PlanExecutionState} from '@workbench/contracts';
import type {DatabaseSync} from '../connection/index.ts';
export function getPlanExecution(db:DatabaseSync,workspaceId:string,kind:'content'|'production',planId:string,headRevisionId:string):PlanExecutionSnapshot {
  const table=kind==='content'?'content_plan_revisions':'production_plan_revisions',reference=kind==='content'?'content_plan_revision_id':'production_plan_revision_id',plans=kind==='content'?'content_plans':'production_plans';
  const jobs=db.prepare(`SELECT j.id,j.state,j.created_at,r.id AS plan_revision_id FROM jobs j JOIN ${table} r ON r.workspace_id=j.workspace_id AND r.id=json_extract(j.input_manifest,'$.frozen_input.plan_revision_id') WHERE j.workspace_id=? AND r.plan_id=? AND json_extract(j.input_manifest,'$.frozen_input.plan_id')=? AND json_extract(j.input_manifest,'$.frozen_input.plan_kind')=? ORDER BY j.created_at DESC,j.id DESC`).all(workspaceId,planId,planId,kind).map(row=>({id:String(row.id),state:String(row.state) as JobState,plan_revision_id:String(row.plan_revision_id),created_at:String(row.created_at)}));
  const artifacts=db.prepare(`SELECT a.id,a.status,a.kind,a.sha256,a.producer_version,a.created_at,r.id AS plan_revision_id FROM artifacts a JOIN ${table} r ON r.workspace_id=a.workspace_id AND r.id=a.${reference} JOIN ${plans} p ON p.workspace_id=r.workspace_id AND p.id=r.plan_id AND p.variant_id=a.variant_id AND r.variant_revision_id=a.variant_revision_id WHERE a.workspace_id=? AND r.plan_id=? ORDER BY a.created_at DESC,a.id DESC`).all(workspaceId,planId).map(row=>({id:String(row.id),status:String(row.status),kind:String(row.kind),plan_revision_id:String(row.plan_revision_id),sha256:String(row.sha256),producer_version:String(row.producer_version),created_at:String(row.created_at),stale:row.plan_revision_id!==headRevisionId}));
  return {jobs,artifacts};
}
export function planExecutionState(execution:PlanExecutionSnapshot,headRevisionId:string,structural:PlanExecutionState):PlanExecutionState {
  const job=execution.jobs.find(item=>item.plan_revision_id===headRevisionId),artifact=execution.artifacts.find(item=>item.plan_revision_id===headRevisionId&&['preview_ready','export_ready'].includes(item.status));
  if(job&&['queued','running','reconciling','cancel_requested'].includes(job.state))return 'rendering';
  if(job?.state==='failed')return 'failed';
  if(job&&['waiting_input','waiting_quota'].includes(job.state))return 'waiting_input';
  if(artifact)return artifact.status as 'preview_ready'|'export_ready';
  return structural;
}
