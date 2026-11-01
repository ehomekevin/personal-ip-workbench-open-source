import { randomUUID } from 'node:crypto';
import { ContractError, type SourceRecordPayload, type Sha256, type SearchHit, type JsonObject } from '@workbench/contracts';
import { canonicalJson, type DatabaseSync } from '../connection/index.ts';

export function indexFile(db: DatabaseSync, workspace: string, path: string) { return db.prepare('SELECT * FROM index_entries WHERE workspace_id=? AND path=?').get(workspace, path); }
export function upsertIndex(db: DatabaseSync, workspace: string, input: { path: string; location_id: string; mtime: number; size: number; sha256: Sha256; parser_version: string; payload: SourceRecordPayload; status?: string }): void {
  if (!db.isTransaction) throw new Error('index update requires batch transaction');
  const search = canonicalJson({ title: input.payload.title, summary: input.payload.summary, body: input.payload.body ?? '', author: input.payload.author_name ?? '', reply_author: input.payload.reply_author_name ?? '', quoted_author: input.payload.quoted_author_name ?? '', locator: { body_start_line: input.payload.provider_metadata.body_start_line ?? 1 } });
  const row = indexFile(db, workspace, input.path), at = new Date().toISOString();
  if (row) db.prepare('UPDATE index_entries SET source_location_id=?,mtime=?,size=?,sha256=?,parser_version=?,status=?,search_text=?,updated_at=? WHERE workspace_id=? AND id=?').run(input.location_id, input.mtime, input.size, input.sha256, input.parser_version, input.status ?? 'available', search, at, workspace, String(row.id));
  else db.prepare('INSERT INTO index_entries(id,workspace_id,source_location_id,path,mtime,size,sha256,parser_version,status,search_text) VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), workspace, input.location_id, input.path, input.mtime, input.size, input.sha256, input.parser_version, input.status ?? 'available', search);
}
export function markMissingPaths(db: DatabaseSync, workspace: string, root: string, present: ReadonlySet<string>): number {
  if (!db.isTransaction) throw new Error('offline marking requires complete scan transaction'); let missing = 0;
  const entries = db.prepare('SELECT i.id,i.path,i.source_location_id,l.record_id,l.relative_path,l.kind FROM index_entries i JOIN source_locations l ON l.workspace_id=i.workspace_id AND l.id=i.source_location_id WHERE i.workspace_id=? AND substr(i.path,1,?)=?').all(workspace, root.length + 1, root + '/');
  for (const row of entries) if (!present.has(String(row.path))) { const at = new Date().toISOString(); db.prepare("UPDATE index_entries SET status='offline',updated_at=? WHERE workspace_id=? AND id=?").run(at, workspace, String(row.id)); db.prepare("UPDATE source_locations SET availability='offline',updated_at=? WHERE workspace_id=? AND record_id=? AND kind=? AND relative_path IS ?").run(at, workspace, String(row.record_id), String(row.kind), row.relative_path as string | null); missing++; }
  return missing;
}
export function normalizeSearch(value: string): string { return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim(); }
export function searchTerms(query: string): string[] { const folded = normalizeSearch(query); return [...new Set(folded.split(/[\s\p{P}\p{S}]+/u).filter(Boolean))]; }
export function rankText(query: string, fields: Record<string, string>): number {
  const terms = searchTerms(query); if (!terms.length) return 0;
  const weights: Record<string, number> = { title: 100, author: 60, reply_author: 45, quoted_author: 40, summary: 30, body: 20 };
  const normalized = Object.fromEntries(Object.entries(fields).map(([name, text]) => [name, normalizeSearch(text)]));
  if (terms.some(term => !Object.values(normalized).some(text => text.includes(term)))) return 0;
  let score = 0; for (const [name, text] of Object.entries(normalized)) for (const term of terms) if (text.includes(term)) score += weights[name] ?? 10;
  if (normalized.title === normalizeSearch(query)) score += 100; return score;
}
export function sourceSearch(db: DatabaseSync, workspace: string, query: string): SearchHit[] {
  if (query.length > 250) throw new ContractError('VALIDATION_ERROR', '搜索词过长'); if (!searchTerms(query).length) return [];
  const rows = db.prepare(`SELECT i.search_text,i.path,i.source_location_id,l.relative_path,l.source_url,l.sha256,l.record_id FROM index_entries i JOIN source_locations l ON l.workspace_id=i.workspace_id AND l.id=i.source_location_id WHERE i.workspace_id=? AND i.status='available' AND l.availability='available' ORDER BY i.id`).all(workspace);
  const hits = new Map<string, SearchHit>();
  for (const row of rows) { const stored = JSON.parse(String(row.search_text)) as Record<string, unknown>, fields = Object.fromEntries(['title','summary','body','author','reply_author','quoted_author'].map(key => [key, typeof stored[key] === 'string' ? stored[key] as string : ''])), score = rankText(query, fields); if (!score) continue;
    const storedLocator = stored.locator && typeof stored.locator === 'object' && !Array.isArray(stored.locator) ? stored.locator as Record<string, unknown> : {}, startLine = Number.isSafeInteger(storedLocator.body_start_line) && Number(storedLocator.body_start_line) > 0 ? Number(storedLocator.body_start_line) : 1;
    const body = fields.body ?? '', bodyLines = body.split('\n'), lineIndex = bodyLines.findIndex(line => searchTerms(query).some(term => normalizeSearch(line).includes(term))), line = lineIndex < 0 ? null : lineIndex + startLine;
    const locator: JsonObject = { source_record_id: String(row.record_id), source_location_id: String(row.source_location_id), relative_path: row.relative_path as string | null, source_url: row.source_url as string | null, sha256: String(row.sha256), line, matched_roles: ['author', 'reply_author', 'quoted_author'].filter(role => searchTerms(query).some(value => normalizeSearch(fields[role] ?? '').includes(value))) };
    const hit: SearchHit = { id: String(row.record_id), type: 'source', title: fields.title ?? '', score, snippet: lineIndex < 0 ? fields.summary ?? '' : bodyLines.slice(Math.max(0, lineIndex - 1), lineIndex + 3).join('\n').slice(0, 180), locator };
    if ((hits.get(hit.id)?.score ?? -1) < score) hits.set(hit.id, hit);
  }
  return [...hits.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
