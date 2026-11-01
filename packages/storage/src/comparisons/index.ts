import { ContractError, type ComparisonRun, type ComparisonListQuery, type Page, type FrozenMetricDefinition } from '@workbench/contracts';
import { canonicalJson, type DatabaseSync } from '../connection/index.ts';
import { listSnapshotInputs } from '../metrics/index.ts';
import { decodePageCursor, encodePageCursor } from '../revisions/page.ts';

export function readComparisonData(db: DatabaseSync, workspaceId: string, definitionId: string) {
  const definition = db.prepare('SELECT id,platform,key,unit,kind,scope,definition_version FROM metric_definitions WHERE workspace_id=? AND id=?').get(workspaceId, definitionId) as unknown as FrozenMetricDefinition | undefined;
  if (!definition) throw new ContractError('NOT_FOUND', '指标定义不存在');
  const works = db.prepare(`SELECT w.id,COALESCE(w.canonical_work_id,w.id) AS canonical_work_id,c.platform,c.platform_work_id,c.account_id,
    COALESCE(a.identity_status,'pending') AS account_identity_status,COALESCE(a.role,'unknown') AS account_role,c.format,c.format_source,
    w.identity_status,c.identity_status AS canonical_identity_status,c.published_at,c.topic_id,t.category,c.url
    FROM works w JOIN works c ON c.workspace_id=w.workspace_id AND c.id=COALESCE(w.canonical_work_id,w.id)
    LEFT JOIN accounts a ON a.workspace_id=c.workspace_id AND a.id=c.account_id
    LEFT JOIN topics t ON t.workspace_id=c.workspace_id AND t.id=c.topic_id WHERE w.workspace_id=? ORDER BY w.id`).all(workspaceId);
  const snapshots = listSnapshotInputs(db, workspaceId).map(snapshot => {
    const metric = snapshot.metrics.find(metric => metric.definition.id === definitionId);
    return { id: snapshot.id, work_id: snapshot.source_work_id, canonical_work_id: snapshot.canonical_work_id,
      source_id: snapshot.source_id, collection_request_id: snapshot.collection_request_id, request_fingerprint: snapshot.request_fingerprint,
      observed_at: snapshot.observed_at, observed_time_basis: snapshot.observed_time_basis, observed_age_s: snapshot.observed_age_s,
      collected_at: snapshot.collected_at, raw_path: snapshot.raw_path, raw_sha256: snapshot.raw_sha256, adapter_version: snapshot.adapter_version,
      definition_id: metric?.definition.id ?? '', availability: metric?.availability ?? 'not_collected', reason: metric?.reason ?? 'definition_missing', value: metric?.value ?? null };
  });
  return { definition, works, snapshots };
}
export function insertComparison(db: DatabaseSync, run: ComparisonRun): void {
  if (!db.isTransaction) throw new Error('Comparison insert requires a domain transaction');
  db.prepare(`INSERT INTO comparison_runs(id,workspace_id,created_at,updated_at,query_spec,selected_snapshot_ids,selected_inputs_by_cohort,excluded_work_ids,excluded_reasons,definition_versions,result)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(run.id, run.workspace_id, run.created_at, run.created_at, canonicalJson(run.query_spec), canonicalJson(run.selected_snapshot_ids), canonicalJson(run.selected_inputs_by_cohort), canonicalJson(run.excluded_work_ids), canonicalJson(run.excluded_reasons), canonicalJson(run.definition_versions), canonicalJson(run.result));
}
function decode(row: Record<string, unknown>): ComparisonRun {
  return { id: String(row.id), workspace_id: String(row.workspace_id), created_at: String(row.created_at), query_spec: JSON.parse(String(row.query_spec)), selected_snapshot_ids: JSON.parse(String(row.selected_snapshot_ids)), selected_inputs_by_cohort: JSON.parse(String(row.selected_inputs_by_cohort)), excluded_work_ids: JSON.parse(String(row.excluded_work_ids)), excluded_reasons: JSON.parse(String(row.excluded_reasons)), definition_versions: JSON.parse(String(row.definition_versions)), result: JSON.parse(String(row.result)) };
}
export function getComparison(db: DatabaseSync, workspaceId: string, id: string): ComparisonRun {
  const row = db.prepare('SELECT * FROM comparison_runs WHERE workspace_id=? AND id=?').get(workspaceId, id); if (!row) throw new ContractError('NOT_FOUND', '已保存比较不存在'); return decode(row);
}
export function listComparisons(db: DatabaseSync, workspaceId: string, query: ComparisonListQuery = {}): Page<ComparisonRun> {
  const [created, id] = decodePageCursor(query.cursor), limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ContractError('VALIDATION_ERROR', '比较分页大小无效');
  const rows = db.prepare(`SELECT * FROM comparison_runs WHERE workspace_id=? AND (created_at>? OR (created_at=? AND id>?))
    AND (? IS NULL OR json_extract(query_spec,'$.platform')=?)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(json_extract(query_spec,'$.account_ids')) WHERE value=?))
    AND (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<?) ORDER BY created_at,id LIMIT ?`).all(workspaceId, created, created, id, query.platform ?? null, query.platform ?? null, query.account_id ?? null, query.account_id ?? null, query.created_start ?? null, query.created_start ?? null, query.created_end ?? null, query.created_end ?? null, limit + 1);
  const hasMore = rows.length > limit, selected = rows.slice(0, limit); return { items: selected.map(decode), next_cursor: hasMore ? encodePageCursor({ created_at: selected.at(-1)!.created_at, id: selected.at(-1)!.id }) : null, has_more: hasMore, last_success_at: new Date().toISOString() };
}
