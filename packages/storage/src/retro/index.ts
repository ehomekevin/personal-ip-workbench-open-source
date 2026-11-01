import { ContractError, type ActionAdoptionsRow, type AdoptionWorksRow, type ActionEvaluationsRow, type RetroActionsRow, type RetroReportsRow, type ObservationPlan, type ObservationPlanInput, type JsonObject, type Page, type ListQuery } from '@workbench/contracts';
import { canonicalJson, type DatabaseSync } from '../connection/index.ts';
import { decodePageCursor, encodePageCursor } from '../revisions/page.ts';
export interface AdoptionTarget { topic_id:string; core_revision_id:string|null; variant_id:string|null; variant_revision_id:string|null }
export interface FrozenAdoptionPlan extends ObservationPlan { target:AdoptionTarget; adoption_request_hash:string }
export interface RetroAdoption extends Omit<ActionAdoptionsRow,'observation_plan'> { observation_plan:FrozenAdoptionPlan; works:AdoptionWork[]; evaluations:ActionEvaluation[] }
export interface AdoptionWork extends Omit<AdoptionWorksRow,'link_evidence'> { link_evidence:JsonObject }
export interface ActionEvaluation extends Omit<ActionEvaluationsRow,'limitations'> { limitations:string }
export interface RetroAction extends Omit<RetroActionsRow,'observation_plan'> { observation_plan:ObservationPlanInput; adoptions:RetroAdoption[] }
export interface RetroReport extends Omit<RetroReportsRow,'source_record_ids'> { source_record_ids:string[]; action_ids:string[]; revision_ids:string[] }
export function rowOf<T>(db:DatabaseSync,workspaceId:string,table:'retro_reports'|'retro_actions'|'action_adoptions',id:string):T {
  const row=db.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND id=?`).get(workspaceId,id);
  if(!row)throw new ContractError('NOT_FOUND','复盘记录不存在'); return row as unknown as T;
}
export function getAdoption(db:DatabaseSync,workspaceId:string,id:string):RetroAdoption {
  const row=rowOf<ActionAdoptionsRow>(db,workspaceId,'action_adoptions',id);
  const works=db.prepare('SELECT * FROM adoption_works WHERE workspace_id=? AND adoption_id=? ORDER BY created_at,id').all(workspaceId,id) as unknown as AdoptionWorksRow[];
  const evaluations=db.prepare('SELECT * FROM action_evaluations WHERE workspace_id=? AND adoption_id=? ORDER BY created_at,id').all(workspaceId,id) as unknown as ActionEvaluationsRow[];
  return {...row,observation_plan:JSON.parse(row.observation_plan),works:works.map(work=>({...work,link_evidence:JSON.parse(work.link_evidence)})),evaluations:evaluations.map(evaluation=>({...evaluation,limitations:JSON.parse(evaluation.limitations)}))};
}
export function getAction(db:DatabaseSync,workspaceId:string,id:string):RetroAction {
  const row=rowOf<RetroActionsRow>(db,workspaceId,'retro_actions',id);
  const adoptions=db.prepare('SELECT id FROM action_adoptions WHERE workspace_id=? AND action_id=? ORDER BY created_at,id').all(workspaceId,id);
  return {...row,observation_plan:JSON.parse(row.observation_plan),adoptions:adoptions.map(adoption=>getAdoption(db,workspaceId,String(adoption.id)))};
}
export function getReport(db:DatabaseSync,workspaceId:string,id:string):RetroReport {
  const row=rowOf<RetroReportsRow>(db,workspaceId,'retro_reports',id);
  return {...row,source_record_ids:JSON.parse(row.source_record_ids),action_ids:db.prepare('SELECT id FROM retro_actions WHERE workspace_id=? AND report_id=? ORDER BY created_at,id').all(workspaceId,id).map(item=>String(item.id)),revision_ids:db.prepare('SELECT id FROM document_revisions WHERE workspace_id=? AND document_id=? ORDER BY created_at,id').all(workspaceId,row.document_id).map(item=>String(item.id))};
}
export interface RetroListQuery extends ListQuery { platform?:string; topic_id?:string; status?:string; comparison_run_id?:string }
export function listRetro<T>(db:DatabaseSync,workspaceId:string,kind:'actions'|'reports',query:RetroListQuery,decode:(id:string)=>T):Page<T> {
  const [created,id]=decodePageCursor(query.cursor),limit=query.limit ?? 50;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ContractError('VALIDATION_ERROR','复盘分页大小无效');
  const predicate=kind==='actions' ? `(? IS NULL OR r.status=?) AND (? IS NULL OR json_extract(r.observation_plan,'$.platform')=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM action_adoptions a WHERE a.workspace_id=r.workspace_id AND a.action_id=r.id AND a.topic_id=?))` : `(? IS NULL OR r.comparison_run_id=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM comparison_runs c WHERE c.workspace_id=r.workspace_id AND c.id=r.comparison_run_id AND json_extract(c.query_spec,'$.platform')=?)) AND (? IS NULL OR EXISTS(SELECT 1 FROM retro_actions x JOIN action_adoptions a ON a.workspace_id=x.workspace_id AND a.action_id=x.id WHERE x.workspace_id=r.workspace_id AND x.report_id=r.id AND a.topic_id=?))`;
  const rows=db.prepare(`SELECT r.id,r.created_at FROM retro_${kind} r WHERE r.workspace_id=? AND (r.created_at>? OR (r.created_at=? AND r.id>?)) AND ${predicate} ORDER BY r.created_at,r.id LIMIT ?`).all(workspaceId,created,created,id,kind==='actions'?query.status ?? null:query.comparison_run_id ?? null,kind==='actions'?query.status ?? null:query.comparison_run_id ?? null,query.platform ?? null,query.platform ?? null,query.topic_id ?? null,query.topic_id ?? null,limit+1);
  const selected=rows.slice(0,limit),last=selected.at(-1);return {items:selected.map(row=>decode(String(row.id))),has_more:rows.length>limit,next_cursor:rows.length>limit&&last?encodePageCursor({created_at:last.created_at,id:last.id}):null,last_success_at:new Date().toISOString()};
}
export function insertJson(db:DatabaseSync,table:'retro_actions'|'action_adoptions'|'adoption_works'|'action_evaluations',row:Record<string,unknown>):void {
  if(!db.isTransaction)throw new Error('复盘写入需要最终领域事务');
  const columns=Object.keys(row),values=Object.entries(row).map(([key,value])=>['observation_plan','link_evidence','limitations'].includes(key)?canonicalJson(value):value);
  db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...values as (string|number|null)[]);
}
