import { ContractError, type Page, type Platform, type WorksRow, type JsonObject, type WorkView } from '@workbench/contracts';
import type { DatabaseSync } from '../connection/index.ts';
import { canonicalWorkId, getWork } from '../identity/index.ts';
import { decodePageCursor, encodePageCursor } from '../revisions/page.ts';

export type { WorkAliasView, WorkView } from '@workbench/contracts';
export interface WorksFilter { platform?: Platform; account_id?: string; identity_status?: string; topic_id?: string; cursor?: string; limit?: number }
export function workView(db: DatabaseSync, workspaceId: string, workId: string): WorkView {
  const source = getWork(db, workspaceId, workId), work = getWork(db, workspaceId, canonicalWorkId(db, workspaceId, workId));
  const aliases = db.prepare('SELECT alias_work_id,source_url,resolution_evidence FROM work_aliases WHERE workspace_id=? AND canonical_work_id=? ORDER BY created_at,id')
    .all(workspaceId, work.id).map(row => ({ alias_work_id: String(row.alias_work_id), source_url: String(row.source_url), resolution_evidence: JSON.parse(String(row.resolution_evidence)) as JsonObject }));
  const account = work.account_id ? db.prepare('SELECT role FROM accounts WHERE workspace_id=? AND id=?').get(workspaceId, work.account_id) : null;
  return { ...work, source_work_id: source.id, aliases, account_role: account ? String(account.role) : null };
}
export function listWorks(db: DatabaseSync, workspaceId: string, filter: WorksFilter = {}): Page<WorkView> {
  const limit = filter.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ContractError('VALIDATION_ERROR', '作品分页参数无效');
  const [at, id] = decodePageCursor(filter.cursor), where = ['workspace_id=?', 'canonical_work_id IS NULL'], args: Array<string | number> = [workspaceId];
  for (const key of ['platform', 'account_id', 'identity_status', 'topic_id'] as const) if (filter[key] !== undefined) { where.push(`${key}=?`); args.push(filter[key]!); }
  if (at) { where.push('(created_at>? OR (created_at=? AND id>?))'); args.push(at, at, id); }
  const rows = db.prepare(`SELECT * FROM works WHERE ${where.join(' AND ')} ORDER BY created_at,id LIMIT ?`).all(...args, limit + 1) as unknown as WorksRow[];
  const selected = rows.slice(0, limit), last = selected.at(-1);
  return { items: selected.map(row => workView(db, workspaceId, row.id)), next_cursor: rows.length > limit && last ? encodePageCursor(last) : null, has_more: rows.length > limit, last_success_at: null };
}
