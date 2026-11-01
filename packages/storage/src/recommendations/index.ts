import { ContractError, type JsonObject, type Page, type RecommendationCandidatesRow } from '@workbench/contracts';
import type { DatabaseSync } from '../connection/index.ts';
import { decodePageCursor, encodePageCursor } from '../revisions/page.ts';
export interface RecommendationCandidate extends Omit<RecommendationCandidatesRow, 'payload' | 'source_ids'> { payload: JsonObject; source_ids: string[] }
export interface RecommendationRun { id: string; kind: 'topic' | 'account'; input_manifest: JsonObject; job_id: string; status: string; candidates: RecommendationCandidate[]; job: JsonObject }
export function recommendationCandidate(db: DatabaseSync, workspace: string, id: string): RecommendationCandidate {
  const row = db.prepare('SELECT * FROM recommendation_candidates WHERE workspace_id=? AND id=?').get(workspace, id) as unknown as RecommendationCandidatesRow | undefined;
  if (!row) throw new ContractError('NOT_FOUND', '推荐候选不存在');
  return { ...row, payload: JSON.parse(row.payload), source_ids: JSON.parse(row.source_ids) };
}
export function recommendationRun(db: DatabaseSync, workspace: string, id: string): RecommendationRun {
  const row = db.prepare('SELECT * FROM recommendation_runs WHERE workspace_id=? AND id=?').get(workspace, id);
  if (!row) throw new ContractError('NOT_FOUND', '推荐运行不存在');
  const job = db.prepare('SELECT j.id,j.kind,j.state,j.version,j.input_hash,a.error FROM jobs j LEFT JOIN job_attempts a ON a.workspace_id=j.workspace_id AND a.id=j.current_attempt_id WHERE j.workspace_id=? AND j.id=?').get(workspace, String(row.job_id));
  if (!job) throw new ContractError('STORAGE_UNAVAILABLE', '推荐运行缺少任务归属');
  return { id: String(row.id), kind: row.kind as 'topic' | 'account', input_manifest: JSON.parse(String(row.input_manifest)), job_id: String(row.job_id), status: String(job.state), job: job as JsonObject,
    candidates: db.prepare('SELECT id FROM recommendation_candidates WHERE workspace_id=? AND run_id=? ORDER BY created_at,id').all(workspace, id).map(row => recommendationCandidate(db, workspace, String(row.id))) };
}
export function recommendationRuns(db: DatabaseSync, workspace: string, query: { kind?: string; state?: string; cursor?: string } = {}): Page<RecommendationRun> {
  if (query.kind && !['topic', 'account'].includes(query.kind)) throw new ContractError('VALIDATION_ERROR', '推荐类型无效');
  const [at, id] = decodePageCursor(query.cursor);
  const rows = db.prepare('SELECT r.id,r.created_at FROM recommendation_runs r JOIN jobs j ON j.workspace_id=r.workspace_id AND j.id=r.job_id WHERE r.workspace_id=? AND (? IS NULL OR r.kind=?) AND (? IS NULL OR j.state=?) AND (r.created_at>? OR (r.created_at=? AND r.id>?)) ORDER BY r.created_at,r.id LIMIT 51').all(workspace, query.kind ?? null, query.kind ?? null, query.state ?? null, query.state ?? null, at, at, id);
  const items = rows.slice(0, 50), last = items.at(-1); return { items: items.map(row => recommendationRun(db, workspace, String(row.id))), has_more: rows.length > 50, next_cursor: rows.length > 50 && last ? encodePageCursor({ id: last.id, created_at: last.created_at }) : null, last_success_at: new Date().toISOString() };
}
