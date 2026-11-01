import { randomUUID } from 'node:crypto';
import {readAccountProfile} from './account-profiles.ts';
import { join } from 'node:path';
import { ContractError, CreateSourceRecordSchema, CreateAccountSchema, SourceMarksSchema, LinkTopicSourceSchema, SourceSyncSchema,
  type RequestContext, type JsonObject, type CreateSourceRecordRequest, type CreateAccountRequest, type SourceMarksRequest, type LinkTopicSourceRequest, type SourceSyncRequest, type SourceRecordPayload, type AccountSummary, type Page } from '@workbench/contracts';
import { transaction, sha256 } from '@workbench/storage/connection';
import { ensureSource, sourceRow, getCheckpoint, setCheckpoint, upsertSourceRecord, sourcePage, getRecordDetail, readSourcePayload, type SourceFilters } from '@workbench/storage/sources';
import { upsertIndex, indexFile } from '@workbench/storage/knowledge-index';
import { readIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import { getJob, getAttempt, fenceReason, type AttemptFence, queueJobInTransaction } from '@workbench/storage/jobs';
import { workspaceSettings } from '@workbench/storage/settings';
import { PersonalSiteAdapter, personalSiteOrigin, PERSONAL_SITE_STREAMS, PERSONAL_SITE_VERSION, type PersonalSiteStream } from '@workbench/adapters/personal-site';
import { Jobs } from '../jobs/index.ts';
import { normalizeWorkUrl } from '../identity/index.ts';
import { assertRequestIdentity } from '../documents/index.ts';
import type { ApplicationContext } from '../ports/index.ts';
import { CREATOR_FEED_VERSION } from '../../../adapters/src/personal-site/creator-feed.ts';
import { findCreatorRecords, storeCreatorRecords } from './creator-records.ts';

export function assertIngestFence(context: ApplicationContext, fence?: AttemptFence): void {
  if (!fence) return;
  const workspace = context.identity.workspace_id, job = getJob(context.db, workspace, fence.job_id), attempt = getAttempt(context.db, workspace, fence.attempt_id);
  const reason = fenceReason(job, attempt, fence, Date.now());
  if (attempt.lease_owner !== fence.lease_owner || reason) throw new ContractError('HOST_RUN_NOT_CURRENT', '同步尝试已失效', { reason: reason ?? 'LEASE_OWNER_MISMATCH' });
}
export class Sources {
  readonly context: ApplicationContext;
  constructor(context: ApplicationContext) { this.context = context; }
  ensurePublicSources(baseUrl?: string): void {
    // Startup without an explicit registration must not create or contact a personal source.
    if (baseUrl === undefined) return;
    const origin = personalSiteOrigin(baseUrl);
    transaction(this.context.db, () => { for (const stream of PERSONAL_SITE_STREAMS) ensureSource(this.context.db, this.context.identity.workspace_id, 'personal_site', `${origin}/api/v1/${stream}.json`, stream); });
  }
  list(request: RequestContext) { assertRequestIdentity(this.context, request); return { items: this.context.db.prepare('SELECT s.*,c.capability_status,c.last_error FROM sources s LEFT JOIN connectors c ON c.workspace_id=s.workspace_id AND c.id=s.connector_id WHERE s.workspace_id=? ORDER BY s.created_at,s.id').all(request.workspace_id), next_cursor: null, has_more: false, last_success_at: null }; }
  records(request: RequestContext, filters: SourceFilters = {}) { assertRequestIdentity(this.context, request); return sourcePage(this.context.db, request.workspace_id, filters); }
  detail(request: RequestContext, id: string) { assertRequestIdentity(this.context, request); return getRecordDetail(this.context.db, request.workspace_id, id); }
  async readDetail(request: RequestContext, id: string, signal?: AbortSignal, fetcher?: typeof fetch) {
    const detail = this.detail(request, id);
    const db = this.context.db, row = db.prepare('SELECT * FROM source_records WHERE workspace_id=? AND id=?').get(request.workspace_id, id)!, source = sourceRow(db, request.workspace_id, String(row.source_id));
    const payload = readSourcePayload(row),creator=payload.provider_metadata.creator_feed;
    const creatorMeta=creator&&typeof creator==='object'&&!Array.isArray(creator)?creator:null;
    const stream = (creatorMeta?'creator-feed':String(source.external_id)) as PersonalSiteStream;
    if (source.kind !== 'personal_site' || detail.body !== null && payload.provider_metadata.body_parser_version === (creatorMeta?CREATOR_FEED_VERSION:PERSONAL_SITE_VERSION)&&(!creatorMeta||creatorMeta.detail_content_version===creatorMeta.content_version)) return detail;
    const eventId = creatorMeta?creatorMeta.candidate_id:stream === 'dailies' ? String(row.external_id) : payload.provider_metadata.event_id;
    if (typeof eventId !== 'string') return detail;
    const adapter = this.adapter(stream, source, fetcher); let fetched: Awaited<ReturnType<PersonalSiteAdapter['fetchDetail']>>;
    try { fetched = await adapter.fetchDetail(eventId, signal,typeof creatorMeta?.content_version==='string'?creatorMeta.content_version:undefined); }
    catch (error) { if (signal?.aborted) throw error;
      transaction(db, () => { const old = readSourcePayload(db.prepare('SELECT * FROM source_records WHERE workspace_id=? AND id=?').get(request.workspace_id, id)!);
        const failure = { code: error instanceof ContractError ? error.code : 'REQUEST_FAILED', http_status: error instanceof ContractError && typeof error.details.http_status === 'number' ? error.details.http_status : null };
        db.prepare('UPDATE source_records SET payload=?,updated_at=? WHERE workspace_id=? AND id=?').run(JSON.stringify({ ...old, parser_warnings: [...new Set([...old.parser_warnings, old.body === null ? '详情当前不可用；保留摘要和原文链接。' : '详情更新暂不可用；保留已有解读和原文链接。'])], provider_metadata: { ...old.provider_metadata, detail_availability: 'unavailable', detail_error: failure } }), new Date().toISOString(), request.workspace_id, id);
        db.prepare('UPDATE connectors SET last_error=? WHERE workspace_id=? AND id=?').run(JSON.stringify({ ...failure, operation: 'fetchDetail', record_id: id }), request.workspace_id, String(source.connector_id)); });
      return this.detail(request, id);
    }
    transaction(db, () => { const latest = db.prepare('SELECT * FROM source_records WHERE workspace_id=? AND id=?').get(request.workspace_id, id); if (!latest) throw new ContractError('NOT_FOUND', '资料不存在');
      const previous = readSourcePayload(latest);
      const currentCreator=previous.provider_metadata.creator_feed as JsonObject|undefined,detailCreator=fetched.record.payload.provider_metadata.creator_feed as JsonObject|undefined;
      if(creatorMeta&&currentCreator?.content_version!==creatorMeta.content_version)throw new ContractError('INPUT_STALE','候选在读取详情时已更新，请重新打开');
      const previousWarnings = previous.parser_warnings.filter(warning => !['正文尚未读取；列表仅含摘要。', '详情当前不可用；保留摘要和原文链接。', '详情更新暂不可用；保留已有解读和原文链接。','候选正文尚未与当前内容版本核对；保留历史正文，等待刷新。'].includes(warning));
      const parserVersion=creatorMeta?CREATOR_FEED_VERSION:PERSONAL_SITE_VERSION;
      const merged = { ...previous, body: fetched.record.payload.body, external_links: [...new Set([...previous.external_links, ...fetched.record.payload.external_links])], parser_warnings: [...new Set([...previousWarnings, ...fetched.record.payload.parser_warnings])], provider_metadata: { ...previous.provider_metadata, ...(currentCreator&&detailCreator?{creator_feed:{...currentCreator,detail_content_version:detailCreator.content_version,detail_snapshot_id:detailCreator.snapshot_id,content:detailCreator.content??{},reports:detailCreator.reports??[]}}:{}), body_start_line: 1, body_parser_version: parserVersion, detail_availability: 'available', detail_error: null } };
      db.prepare("UPDATE source_records SET payload=?,content_status='available',updated_at=? WHERE workspace_id=? AND id=?").run(JSON.stringify(merged), new Date().toISOString(), request.workspace_id, id);
      const location = upsertSourceRecord(db, request.workspace_id, String(source.id), { ...fetched.record, external_id: String(row.external_id), canonical_url: row.canonical_url as string | null, published_at: row.published_at as string | null, payload: merged }, { external_id: String(row.external_id), kind: `personal_site:${stream}:detail`, relative_path: null, source_url: row.canonical_url as string | null, capture_time: fetched.captured_at, sha256: fetched.raw_response_ref.sha256, parser_version: parserVersion, availability: 'available', raw_response_ref: fetched.raw_response_ref });
      upsertIndex(db, request.workspace_id, { path: `site:${source.id}:${row.external_id}`, location_id: location.location_id, mtime: 0, size: Buffer.byteLength(merged.body ?? ''), sha256: fetched.raw_response_ref.sha256, parser_version: parserVersion, payload: { ...merged, author_name: fetched.record.payload.author_name, reply_author_name: fetched.record.payload.reply_author_name, quoted_author_name: fetched.record.payload.quoted_author_name } }); });
    return this.detail(request, id);
  }
  create(request: RequestContext, input: CreateSourceRecordRequest) { assertRequestIdentity(this.context, request); CreateSourceRecordSchema.parse(input); const url = input.url ? normalizeWorkUrl(input.url) : null;
    return transaction(this.context.db, () => { const replay = readIdempotent<{ record_id: string }>(this.context.db, request, 'source-records.create', input); if (replay) return replay;
      const source = ensureSource(this.context.db, request.workspace_id, 'manual', 'workbench:manual', 'manual');
      const payload: SourceRecordPayload = { title: input.title?.trim() || url || '个人笔记', summary: input.text?.slice(0, 240) ?? '', body: input.text ?? null, category: input.category ?? '个人思考', author_name: null, reply_author_name: null, quoted_author_name: null, external_links: url ? [url] : [], media: [], identity_status: 'pending', parser_warnings: [], provider_metadata: {} };
      const hash = sha256(JSON.stringify({ url, text: input.text ?? null })), identity = url ?? `manual:${randomUUID()}`;
      const result = upsertSourceRecord(this.context.db, request.workspace_id, source, { external_id: identity, canonical_url: url, record_kind: 'manual_note', published_at: null, payload }, { external_id: identity, kind: 'manual', relative_path: null, source_url: url, capture_time: new Date().toISOString(), sha256: hash, parser_version: 'manual/1', availability: 'available', raw_response_ref: null });
      upsertIndex(this.context.db, request.workspace_id, { path: `manual:${result.record_id}`, location_id: result.location_id, mtime: 0, size: Buffer.byteLength(payload.body ?? ''), sha256: hash, parser_version: 'manual/1', payload });
      const response = { record_id: result.record_id }; storeIdempotent(this.context.db, request, 'source-records.create', input, response); return response; }); }
  marks(request: RequestContext, id: string, input: SourceMarksRequest) { assertRequestIdentity(this.context, request); SourceMarksSchema.parse(input);
    return transaction(this.context.db, () => { this.detail(request, id); const old = this.context.db.prepare('SELECT * FROM user_source_marks WHERE workspace_id=? AND record_id=?').get(request.workspace_id, id), at = new Date().toISOString();
      const favorite = input.favorite === undefined ? Number(old?.favorite ?? 0) : input.favorite ? 1 : 0, readAt = input.read === undefined ? old?.read_at ?? null : input.read ? at : null;
      if (old) this.context.db.prepare('UPDATE user_source_marks SET favorite=?,read_at=?,updated_at=? WHERE workspace_id=? AND id=?').run(favorite, readAt as string | null, at, request.workspace_id, String(old.id));
      else this.context.db.prepare('INSERT INTO user_source_marks(id,workspace_id,record_id,favorite,read_at) VALUES (?,?,?,?,?)').run(randomUUID(), request.workspace_id, id, favorite, readAt as string | null); return this.detail(request, id); }); }
  linkTopic(request: RequestContext, topicId: string, input: LinkTopicSourceRequest) { assertRequestIdentity(this.context, request); LinkTopicSourceSchema.parse(input);
    return transaction(this.context.db, () => { const replay = readIdempotent<{ topic_id: string; record_id: string }>(this.context.db, request, 'topics.sources', { topicId, input }); if (replay) return replay;
      this.detail(request, input.record_id); if (!this.context.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id, topicId)) throw new ContractError('NOT_FOUND', '主题不存在');
      this.context.db.prepare('INSERT INTO topic_sources(id,workspace_id,topic_id,source_record_id,usage,locator) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,topic_id,source_record_id) DO NOTHING').run(randomUUID(), request.workspace_id, topicId, input.record_id, input.usage, input.locator ?? null);
      const response = { topic_id: topicId, record_id: input.record_id }; storeIdempotent(this.context.db, request, 'topics.sources', { topicId, input }, response); return response; }); }
  sync(request: RequestContext, id: string, input: SourceSyncRequest) { assertRequestIdentity(this.context, request); SourceSyncSchema.parse(input);
    return transaction(this.context.db, () => { const replay = readIdempotent<{ job_id: string }>(this.context.db, request, 'sources.sync', { id, input }); if (replay) return replay;
      const source = sourceRow(this.context.db, request.workspace_id, id); if (source.kind !== 'personal_site' || !PERSONAL_SITE_STREAMS.includes(source.external_id as PersonalSiteStream) || input.stream && input.stream !== source.external_id) throw new ContractError('CAPABILITY_UNVERIFIED', '资料源流尚未准入');
      const job = queueJobInTransaction(this.context.db, request.workspace_id, { retry_policy: { recovery: 'read_only', max_attempts: 3 }, kind: 'source_sync', target_id: id, entrypoint: 'standalone_web', execution_mode: 'programmatic', input_manifest: { schema_version: 'wp11-ingest/1', mode: 'none', targets: [], source_ids: [], source_id: id, stream: String(source.external_id) }, presentation: 'background' }, Date.now());
      const response = { job_id: job.id }; storeIdempotent(this.context.db, request, 'sources.sync', { id, input }, response); return response; }); }
  private adapter(stream: PersonalSiteStream, source: Record<string, unknown>, fetcher?: typeof fetch) {
    let url: URL;
    try { url = new URL(String(source.url)); } catch { throw new ContractError('CAPABILITY_UNVERIFIED', '个人站资料源地址尚未明确配置'); }
    if (!PERSONAL_SITE_STREAMS.includes(source.external_id as PersonalSiteStream) || url.pathname !== `/api/v1/${source.external_id}.json` || url.username || url.password || url.search || url.hash) throw new ContractError('CAPABILITY_UNVERIFIED', '个人站资料源地址与流不匹配');
    return new PersonalSiteAdapter({ stream, baseUrl: personalSiteOrigin(url.origin), rawRoot: join(workspaceSettings(this.context.db, this.context.identity.workspace_id).paths.state_root, 'ingest-raw'), ...(fetcher ? { fetcher } : {}) });
  }
  async ingest(id: string, options: { fence?: AttemptFence; signal?: AbortSignal; checkpoint?: (value: JsonObject) => void; fetcher?: typeof fetch } = {}) {
    const db = this.context.db, workspace = this.context.identity.workspace_id, source = sourceRow(db, workspace, id), stream = source.external_id as PersonalSiteStream;
    if (source.kind !== 'personal_site' || !PERSONAL_SITE_STREAMS.includes(stream)) throw new ContractError('CAPABILITY_UNVERIFIED', '仅已准入的公开资讯流可同步');
    options.signal?.throwIfAborted(); assertIngestFence(this.context, options.fence); const adapter = this.adapter(stream, source, options.fetcher);
    const batch = await adapter.fetchBatch(getCheckpoint(db, workspace, String(source.connector_id), stream), options.signal);
    const result = transaction(db, () => { options.signal?.throwIfAborted(); assertIngestFence(this.context, options.fence); let inserted = 0;
      for (const [i, record] of batch.records.entries()) { const matches=stream==='creator-feed'?findCreatorRecords(db,workspace,record):null;
        const item = upsertSourceRecord(db, workspace, id, record, batch.source_locations[i]!,matches?{...(matches.existing_record_id?{existing_record_id:matches.existing_record_id}:{}),skip_url_dedup:true}:{}); if (item.inserted) inserted++;
        if(matches)storeCreatorRecords(db,workspace,item.record_id,record,matches);
        const path = `site:${id}:${record.external_id}`, oldIndex = indexFile(db, workspace, path), oldSearch = oldIndex ? JSON.parse(String(oldIndex.search_text)) as Record<string, unknown> : null;
        // 摘要不能将其他来源正文挂在此次 raw 上；已懒载的本站正文保留其详情出处。
        const retainedBody = typeof oldSearch?.body === 'string' && oldSearch.body.length > 0;
        const indexedPayload = retainedBody ? { ...record.payload, body: oldSearch.body as string, provider_metadata: { ...record.payload.provider_metadata, body_start_line: 1 } } : record.payload;
        upsertIndex(db, workspace, { path, location_id: retainedBody ? String(oldIndex!.source_location_id) : item.location_id, mtime: 0, size: Buffer.byteLength(JSON.stringify(indexedPayload)), sha256: retainedBody ? String(oldIndex!.sha256) as ReturnType<typeof sha256> : batch.raw_response_ref.sha256, parser_version: PERSONAL_SITE_VERSION, payload: indexedPayload }); }
      setCheckpoint(db, workspace, String(source.connector_id), stream, batch.next_checkpoint_candidate, true); const at = new Date().toISOString();
      db.prepare('UPDATE sources SET last_sync_at=?,updated_at=? WHERE workspace_id=? AND id=?').run(at, at, workspace, id);
      db.prepare("UPDATE connectors SET capability_status='supported',last_success_at=?,last_error=NULL,updated_at=? WHERE workspace_id=? AND id=?").run(at, at, workspace, String(source.connector_id));
      return { inserted, total: batch.records.length, raw_response_ref: batch.raw_response_ref, checkpoint: batch.next_checkpoint_candidate }; });
    options.checkpoint?.(result.checkpoint); return result;
  }
  accounts(request: RequestContext, filters: { role?: string; platform?: string; identity_status?: string; cursor?: string } = {}): Page<AccountSummary> { assertRequestIdentity(this.context, request);
    const scope = JSON.stringify([filters.role ?? null, filters.platform ?? null, filters.identity_status ?? null]); let cursor: [string, string] | null = null;
    if (filters.cursor) { try { const parsed = JSON.parse(Buffer.from(filters.cursor, 'base64url').toString()); if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== scope || typeof parsed[1] !== 'string' || typeof parsed[2] !== 'string') throw new Error(); cursor = [parsed[1], parsed[2]]; } catch { throw new ContractError('VALIDATION_ERROR', '账号分页游标无效'); } }
    const clauses = ['a.workspace_id=?'], values: (string | number)[] = [request.workspace_id]; for (const key of ['role', 'platform', 'identity_status'] as const) if (filters[key]) { clauses.push(`a.${key}=?`); values.push(filters[key]!); }
    if (cursor) { clauses.push('(a.created_at>? OR(a.created_at=? AND a.id>?))'); values.push(cursor[0], cursor[0], cursor[1]); }
    const rows = this.context.db.prepare(`SELECT a.*,(SELECT COUNT(*) FROM works w WHERE w.workspace_id=a.workspace_id AND w.account_id=a.id AND w.canonical_work_id IS NULL) AS work_count FROM accounts a WHERE ${clauses.join(' AND ')} ORDER BY a.created_at,a.id LIMIT 51`).all(...values), selected = rows.slice(0, 50), last = selected.at(-1);
    return { items: selected.map(row => ({ ...row, collection_status: Number(row.work_count) ? 'available' : 'not_collected',profile:row.identity_status==='confirmed'?readAccountProfile(this.context,row as {id:unknown;platform:unknown;platform_account_id:unknown;canonical_url:unknown}):null })) as unknown as AccountSummary[], next_cursor: rows.length > 50 && last ? Buffer.from(JSON.stringify([scope, last.created_at, last.id])).toString('base64url') : null, has_more: rows.length > 50, last_success_at: null }; }
  createAccount(request: RequestContext, input: CreateAccountRequest) { assertRequestIdentity(this.context, request); CreateAccountSchema.parse(input); const url = normalizeWorkUrl(input.url);
    return transaction(this.context.db, () => { const replay = readIdempotent<{ account_id: string; identity_status: string; collection_status: string }>(this.context.db, request, 'accounts.create', input); if (replay) return replay;
      const old = this.context.db.prepare('SELECT id,identity_status FROM accounts WHERE workspace_id=? AND platform=? AND canonical_url=? AND role=?').get(request.workspace_id, input.platform, url, input.role); const id = old ? String(old.id) : randomUUID();
      if (!old) this.context.db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,?,NULL,?,?,?,'pending')").run(id, request.workspace_id, input.platform, input.role, input.name.trim(), url);
      const response = { account_id: id, identity_status: old ? String(old.identity_status) : 'pending', collection_status: 'not_collected' }; storeIdempotent(this.context.db, request, 'accounts.create', input, response); return response; }); }
}
