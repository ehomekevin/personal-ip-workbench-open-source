import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { ContractError, IndexRunSchema, type RequestContext, type IndexRunRequest, type JsonObject, type KnowledgeSummary, type Page, type SearchHit, type NormalizedSourceRecord, type SourceLocationInput, type SourceRecordPayload } from '@workbench/contracts';
import { transaction, sha256, canonicalJson } from '@workbench/storage/connection';
import { ensureSource, sourceRow, setCheckpoint, getCheckpoint, upsertSourceRecord, readSourcePayload } from '@workbench/storage/sources';
import { indexFile, upsertIndex, markMissingPaths, sourceSearch, rankText } from '@workbench/storage/knowledge-index';
import { workspaceSettings } from '@workbench/storage/settings';
import { readIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import { queueJobInTransaction, type AttemptFence } from '@workbench/storage/jobs';
import { VaultAdapter, VAULT_PARSER_VERSION } from '@workbench/adapters/vault';
import { assertRequestIdentity, Documents } from '../documents/index.ts';
import { assertIngestFence } from '../sources/index.ts';
import { Jobs } from '../jobs/index.ts';
import type { ApplicationContext } from '../ports/index.ts';

export class KnowledgeIndex {
  readonly context: ApplicationContext;
  constructor(context: ApplicationContext) { this.context = context; }
  private configuredRoots(input: IndexRunRequest): string[] {
    IndexRunSchema.parse(input); const configured = workspaceSettings(this.context.db, this.context.identity.workspace_id).paths.source_vault_root;
    if (!configured) throw new ContractError('CAPABILITY_UNVERIFIED', '请先配置本次指定的 Vault 路径');
    if (!input.roots.length || input.roots.some(root => typeof root !== 'string' || resolve(root) !== resolve(configured)) || new Set(input.roots.map(root => resolve(root))).size !== 1) throw new ContractError('VALIDATION_ERROR', '索引 roots 必须是已配置的只读 Vault 根');
    if (input.batch_size !== undefined && (!Number.isSafeInteger(input.batch_size) || input.batch_size < 1 || input.batch_size > 500)) throw new ContractError('VALIDATION_ERROR', '索引批次应为1至500');
    return [resolve(configured)];
  }
  start(request: RequestContext, input: IndexRunRequest) { assertRequestIdentity(this.context, request); const roots = this.configuredRoots(input);
    return transaction(this.context.db, () => { const old = readIdempotent<{ job_id: string }>(this.context.db, request, 'index-runs.create', input); if (old) return old;
      const job = queueJobInTransaction(this.context.db, request.workspace_id, { retry_policy: { recovery: 'read_only', max_attempts: 3 }, kind: 'source_index', target_id: request.workspace_id, entrypoint: 'standalone_web', execution_mode: 'programmatic', input_manifest: { schema_version: 'wp11-ingest/1', mode: 'none', targets: [], source_ids: [], roots, index_mode: input.mode, batch_size: input.batch_size ?? 500 }, presentation: 'background' }, Date.now());
      const result = { job_id: job.id }; storeIdempotent(this.context.db, request, 'index-runs.create', input, result); return result; }); }
  async scan(input: IndexRunRequest, options: { fence?: AttemptFence; signal?: AbortSignal; checkpoint?: (value: JsonObject) => void; afterBatch?: (value: JsonObject) => Promise<void> | void } = {}) {
    const [root] = this.configuredRoots(input), workspace = this.context.identity.workspace_id, db = this.context.db, adapter = new VaultAdapter(root!);
    assertIngestFence(this.context, options.fence); const files = await adapter.discover(options.signal), scanHash = sha256(canonicalJson(files.map(file => ({ path: file.relative_path, mtime: file.mtime, size: file.size }))));
    const sourceId = transaction(db, () => ensureSource(db, workspace, 'vault', root!, 'historical_notes')), source = sourceRow(db, workspace, sourceId), stream = `vault:${root}`;
    const old = getCheckpoint(db, workspace, String(source.connector_id), stream);
    let offset = old?.scan_hash === scanHash && old?.complete === false && typeof old.next_offset === 'number' ? old.next_offset : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > files.length) offset = 0;
    let parsed = 0, unchanged = 0, errors = 0, missing = 0; const batchSize = input.batch_size ?? 500;
    while (offset < files.length) {
      options.signal?.throwIfAborted(); assertIngestFence(this.context, options.fence);
      const batch = files.slice(offset, offset + batchSize), prepared: Array<{ file: typeof files[number]; record?: NormalizedSourceRecord; location?: SourceLocationInput; hash: ReturnType<typeof sha256>; unchanged: boolean; status: string }> = [];
      for (const file of batch) {
        options.signal?.throwIfAborted(); const bytes = await adapter.read(file, options.signal), current = indexFile(db, workspace, file.path);
        if (input.mode === 'incremental' && current?.sha256 === bytes.sha256 && current.parser_version === VAULT_PARSER_VERSION && current.status !== 'parse_error') { prepared.push({ file, hash: bytes.sha256, unchanged: true, status: 'available' }); continue; }
        try { const item = adapter.parse(file, bytes); prepared.push({ file, record: item.record, location: item.location, hash: bytes.sha256, unchanged: false, status: 'available' }); }
        catch (error) { const message = error instanceof ContractError ? error.message : 'Markdown 编码/解析失败';
          const payload: SourceRecordPayload = { title: file.relative_path, summary: '', body: null, category: '原始资料', author_name: null, reply_author_name: null, quoted_author_name: null, external_links: [], media: [], identity_status: 'pending', parser_warnings: [message], provider_metadata: { relative_path: file.relative_path, parser_error: error instanceof ContractError ? error.details : { line: 1 } } };
          prepared.push({ file, record: { external_id: file.relative_path, canonical_url: null, record_kind: 'vault_note', published_at: null, payload }, location: { external_id: file.relative_path, kind: 'vault', relative_path: file.relative_path, source_url: null, capture_time: null, sha256: bytes.sha256, parser_version: VAULT_PARSER_VERSION, availability: 'parse_error', raw_response_ref: null }, hash: bytes.sha256, unchanged: false, status: 'parse_error' }); }
      }
      const nextOffset = offset + batch.length, complete = nextOffset === files.length;
      const checkpoint: JsonObject = { root, scan_hash: scanHash, next_offset: nextOffset, total: files.length, complete, parser_version: VAULT_PARSER_VERSION };
      transaction(db, () => { options.signal?.throwIfAborted(); assertIngestFence(this.context, options.fence);
        for (const item of prepared) {
          if (item.unchanged) { unchanged++; const current = indexFile(db, workspace, item.file.path)!; db.prepare("UPDATE index_entries SET mtime=?,size=?,status='available',updated_at=? WHERE workspace_id=? AND id=?").run(item.file.mtime, item.file.size, new Date().toISOString(), workspace, String(current.id)); db.prepare("UPDATE source_locations SET availability='available' WHERE workspace_id=? AND id=?").run(workspace, String(current.source_location_id)); continue; }
          const stored = upsertSourceRecord(db, workspace, sourceId, item.record!, { ...item.location!, kind: `vault:${sourceId}` });
          upsertIndex(db, workspace, { path: item.file.path, location_id: stored.location_id, mtime: item.file.mtime, size: item.file.size, sha256: item.hash, parser_version: VAULT_PARSER_VERSION, payload: item.record!.payload, status: item.status });
          parsed++; if (item.status === 'parse_error') errors++;
        }
        if (complete) missing = markMissingPaths(db, workspace, root!, new Set(files.map(file => file.path)));
        setCheckpoint(db, workspace, String(source.connector_id), stream, checkpoint, complete);
        if (complete) { const at = new Date().toISOString(); db.prepare('UPDATE sources SET last_sync_at=?,updated_at=? WHERE workspace_id=? AND id=?').run(at, at, workspace, sourceId); }
      });
      offset = nextOffset; options.checkpoint?.(checkpoint); await options.afterBatch?.(checkpoint);
    }
    if (!files.length) { transaction(db, () => { options.signal?.throwIfAborted(); assertIngestFence(this.context, options.fence); missing = markMissingPaths(db, workspace, root!, new Set()); setCheckpoint(db, workspace, String(source.connector_id), stream, { root, scan_hash: scanHash, next_offset: 0, total: 0, complete: true, parser_version: VAULT_PARSER_VERSION }, true); }); }
    return { total: files.length, parsed, unchanged, errors, missing, scan_hash: scanHash, checkpoint: getCheckpoint(db, workspace, String(source.connector_id), stream) };
  }
  list(request: RequestContext, filters: { kind?: string; query?: string; cursor?: string } = {}): Page<KnowledgeSummary> { assertRequestIdentity(this.context, request);
    if (filters.kind && !['source', 'note', 'wiki'].includes(filters.kind)) throw new ContractError('VALIDATION_ERROR', '知识分类无效');
    const workspace = request.workspace_id, db = this.context.db;
    const sources = (!filters.kind || filters.kind === 'source') ? db.prepare('SELECT id,created_at,payload,content_status FROM source_records WHERE workspace_id=? ORDER BY created_at,id').all(workspace).map(row => ({ id: String(row.id), created_at: String(row.created_at), kind: 'source' as const, title: readSourcePayload(row).title, document_id: null, source_record_id: String(row.id), head_revision_id: null, content_status: String(row.content_status) })) : [];
    const documents = !filters.kind || filters.kind !== 'source' ? db.prepare("SELECT id,created_at,kind,head_revision_id FROM documents WHERE workspace_id=? AND kind IN ('note','user_note','wiki') ORDER BY created_at,id").all(workspace).filter(row => !filters.kind || (row.kind === 'wiki' ? 'wiki' : 'note') === filters.kind).map(row => ({ id: String(row.id), created_at: String(row.created_at), kind: row.kind === 'wiki' ? 'wiki' as const : 'note' as const, title: `${row.kind === 'wiki' ? 'AI Wiki' : '个人笔记'} ${String(row.id).slice(0, 8)}`, document_id: String(row.id), source_record_id: null, head_revision_id: row.head_revision_id as string | null, content_status: row.head_revision_id ? 'available' : 'empty' })) : [];
    let rows = [...sources, ...documents].filter(row => !filters.query || rankText(filters.query, { title: row.title }) > 0).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const scope = canonicalJson({ kind: filters.kind ?? null, query: filters.query ?? null });
    if (filters.cursor) { let parsed: unknown; try { parsed = JSON.parse(Buffer.from(filters.cursor, 'base64url').toString()); } catch { throw new ContractError('VALIDATION_ERROR', '知识游标无效'); } if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== scope || typeof parsed[1] !== 'string' || typeof parsed[2] !== 'string') throw new ContractError('VALIDATION_ERROR', '知识游标与筛选不符'); const at = parsed[1], id = parsed[2]; rows = rows.filter(row => row.created_at > at || row.created_at === at && row.id > id); }
    const selected = rows.slice(0, 50), last = selected.at(-1); return { items: selected.map(({ created_at: _createdAt, ...row }) => row), next_cursor: rows.length > 50 && last ? Buffer.from(JSON.stringify([scope, last.created_at, last.id])).toString('base64url') : null, has_more: rows.length > 50, last_success_at: null };
  }
  async search(request: RequestContext, input: { query: string; types?: string[]; cursor?: string }): Promise<Page<SearchHit>> { assertRequestIdentity(this.context, request);
    if (!input.query.trim()) return { items: [], next_cursor: null, has_more: false, last_success_at: null };
    const types = input.types ?? ['source', 'note', 'wiki', 'topic', 'work', 'account']; if (types.some(type => !['source', 'note', 'wiki', 'topic', 'work', 'account'].includes(type))) throw new ContractError('VALIDATION_ERROR', '搜索类型无效');
    let hits: SearchHit[] = types.includes('source') ? sourceSearch(this.context.db, request.workspace_id, input.query) : [];
    for (const [type, table, column] of [['topic', 'topics', 'title'], ['work', 'works', 'url'], ['account', 'accounts', 'name']] as const) if (types.includes(type)) {
      const rows = this.context.db.prepare(`SELECT id,${column} AS title FROM ${table} WHERE workspace_id=?${type === 'work' ? ' AND canonical_work_id IS NULL' : ''}`).all(request.workspace_id); for (const row of rows) { const score = rankText(input.query, { title: String(row.title) }); if (score) hits.push({ id: String(row.id), type, title: String(row.title), score, snippet: String(row.title), locator: { [`${type}_id`]: String(row.id) } }); }
    }
    if (types.includes('note') || types.includes('wiki')) for (const row of this.context.db.prepare("SELECT id,kind FROM documents WHERE workspace_id=? AND kind IN ('note','user_note','wiki')").all(request.workspace_id)) {
      const type = row.kind === 'wiki' ? 'wiki' : 'note'; if (!types.includes(type)) continue; const document = await new Documents(this.context).get(request, String(row.id)), title = /^#\s+(.+)$/m.exec(document.text)?.[1] ?? `${type} ${row.id}`, score = rankText(input.query, { title, body: document.text }); if (score) hits.push({ id: String(row.id), type, title, score, snippet: document.text.slice(0, 180), locator: { document_id: String(row.id), revision_id: document.head_revision_id, sha256: document.hash } });
    }
    hits.sort((a, b) => b.score - a.score || a.type.localeCompare(b.type) || a.id.localeCompare(b.id)); const scope = canonicalJson({ workspace: request.workspace_id, query: input.query, types: [...types].sort() }), fingerprint = sha256(canonicalJson(hits.map(hit => ({ id: hit.id, type: hit.type, score: hit.score, locator: hit.locator })))); let offset = 0;
    if (input.cursor) { try { const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()); if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== scope || cursor[1] !== fingerprint || !Number.isSafeInteger(cursor[2]) || cursor[2] < 0) throw new Error(); offset = cursor[2]; } catch { throw new ContractError('VALIDATION_ERROR', '搜索游标无效'); } }
    return { items: hits.slice(offset, offset + 50), next_cursor: hits.length > offset + 50 ? Buffer.from(JSON.stringify([scope, fingerprint, offset + 50])).toString('base64url') : null, has_more: hits.length > offset + 50, last_success_at: null };
  }
}
