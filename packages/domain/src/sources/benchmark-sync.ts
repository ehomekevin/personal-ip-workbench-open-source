import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, lstatSync, openSync, closeSync, fsyncSync, constants } from 'node:fs';
import { join } from 'node:path';
import { ContractError,BenchmarkSyncSchema,type BenchmarkSyncRequest, type JsonObject, type RequestContext, type Platform } from '@workbench/contracts';
import { transaction, sha256 } from '@workbench/storage/connection';
import { readIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import { ensureSource, upsertSourceRecord, setCheckpoint, sourceRow } from '@workbench/storage/sources';
import { upsertIndex } from '@workbench/storage/knowledge-index';
import { commitObservationInTransaction, ensureMetricsSourceInTransaction, type ReadingInput } from '@workbench/storage/metrics';
import { queueJobInTransaction, type AttemptFence } from '@workbench/storage/jobs';
import { BENCHMARK_FEED_VERSION, type BenchmarkFeed } from '../../../adapters/src/tikhub/benchmark-feed.ts';
import type { TikHubAdapter } from '@workbench/adapters/tikhub';
import { assertRequestIdentity } from '../documents/index.ts';
import { assertIngestFence } from './index.ts';
import type { ApplicationContext } from '../ports/index.ts';

const stateKey = (workspace: string, id: string) => `benchmark-sync.v1:${workspace}:${id}`;
export class BenchmarkSync {
  readonly context: ApplicationContext; readonly adapter: Pick<TikHubAdapter, 'credentialPresent' | 'fetchBenchmarkFeed'>;
  constructor(context: ApplicationContext, adapter: BenchmarkSync['adapter']) { this.context = context; this.adapter = adapter; }
  private account(id: string) {
    const row = this.context.db.prepare('SELECT * FROM accounts WHERE workspace_id=? AND id=?').get(this.context.identity.workspace_id, id);
    if (!row) throw new ContractError('NOT_FOUND', '账号不存在');
    if (row.role !== 'benchmark') throw new ContractError('VALIDATION_ERROR', '此入口只用于对标账号');
    if (!['x', 'douyin'].includes(String(row.platform))) throw new ContractError('CAPABILITY_UNSUPPORTED', '最新作品采集目前支持 X 和抖音；其他平台可先登记');
    if (row.identity_status !== 'confirmed' || !row.platform_account_id) throw new ContractError('CAPABILITY_UNVERIFIED', '先核对对标账号的唯一平台身份');
    return row;
  }
  status(request: RequestContext, id: string): JsonObject {
    assertRequestIdentity(this.context, request);
    if (!this.context.db.prepare("SELECT id FROM accounts WHERE workspace_id=? AND id=? AND role='benchmark'").get(request.workspace_id, id)) throw new ContractError('NOT_FOUND', '对标账号不存在');
    const state = this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(stateKey(request.workspace_id, id));
    const job = this.context.db.prepare("SELECT j.id,j.state,j.created_at,(SELECT a.error FROM job_attempts a WHERE a.workspace_id=j.workspace_id AND a.job_id=j.id ORDER BY a.attempt_no DESC LIMIT 1) AS error FROM jobs j WHERE j.workspace_id=? AND j.kind='benchmark_sync' AND j.target_id=? ORDER BY j.created_at DESC,j.id DESC LIMIT 1").get(request.workspace_id, id);
    const source = this.context.db.prepare("SELECT id FROM sources WHERE workspace_id=? AND kind='tikhub_benchmark' AND external_id=? ORDER BY created_at,id LIMIT 1").get(request.workspace_id, id);
    return { ...(state ? JSON.parse(String(state.value)) : { last_success_at: null }), source_id: source ? String(source.id) : null, latest_job: job as unknown as JsonObject ?? null, trigger: 'manual', automatic: false };
  }
  enqueue(request: RequestContext, id: string,input:BenchmarkSyncRequest={}) {
    assertRequestIdentity(this.context, request);
    BenchmarkSyncSchema.parse(input);
    if (!this.adapter.credentialPresent()) throw new ContractError('AUTH_REQUIRED', '先填写 TikHub 密钥');
    return transaction(this.context.db, () => {
      const op = 'benchmark-sync:' + id, replay = readIdempotent<{job_id: string}>(this.context.db, request, op, input); if (replay) return replay;
      const account = this.account(id), active = this.context.db.prepare("SELECT id FROM jobs WHERE workspace_id=? AND kind='benchmark_sync' AND target_id=? AND state IN ('queued','running','reconciling') ORDER BY created_at,id LIMIT 1").get(request.workspace_id, id);
      if (active) { const response = { job_id: String(active.id) }; storeIdempotent(this.context.db, request, op, input, response); return response; }
      const scope=input.scope??'latest_page',previous=this.status(request,id),cursor=scope==='older_page'?previous.history_cursor:null;
      if(scope==='older_page'&&(typeof cursor!=='string'||!cursor))throw new ContractError('CAPABILITY_UNVERIFIED','尚无可继续的历史游标，请先采集最新作品；平台到末页或游标停滞时不重复补采');
      const sourceId = ensureSource(this.context.db, request.workspace_id, 'tikhub_benchmark', String(account.canonical_url), id);
      const manifest: JsonObject = { schema_version: 'benchmark-sync/1', mode: 'none', targets: [], source_ids: [], source_id: sourceId,
        account_id: id, account: { platform: account.platform, canonical_url: account.canonical_url, platform_account_id: account.platform_account_id, identity_status: account.identity_status, role: account.role, updated_at: account.updated_at } as JsonObject, scope,...(typeof cursor==='string'?{cursor}:{}) };
      const job = queueJobInTransaction(this.context.db, request.workspace_id, { kind: 'benchmark_sync', target_id: id, entrypoint: 'standalone_web', execution_mode: 'programmatic', input_manifest: manifest, retry_policy: { recovery: 'read_only', max_attempts: 1 }, presentation: 'background' }, Date.now());
      const response = { job_id: job.id }; storeIdempotent(this.context.db, request, op, input, response); return response;
    });
  }
  async execute(jobId: string, manifest: JsonObject, options: {fence: AttemptFence; signal: AbortSignal; checkpoint(value: JsonObject): void}) {
    if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new ContractError('VALIDATION_ERROR', '采集任务 ID 无效');
    if (manifest.schema_version !== 'benchmark-sync/1' || manifest.mode !== 'none' || typeof manifest.account_id !== 'string' || typeof manifest.source_id !== 'string' || !['latest_page','older_page'].includes(String(manifest.scope)) || manifest.scope==='older_page'&&(typeof manifest.cursor!=='string'||!manifest.cursor)) throw new ContractError('VALIDATION_ERROR', '对标任务输入无效');
    const frozen = manifest.account as JsonObject;
    const assertCurrent = () => { assertIngestFence(this.context, options.fence); const a = this.account(String(manifest.account_id));
      if (['platform', 'canonical_url', 'platform_account_id', 'identity_status', 'role', 'updated_at'].some(k => a[k] !== frozen[k])) throw new ContractError('INPUT_STALE', '对标账号已变化，请重新核对后采集'); return a; };
    const account = assertCurrent(), workspace = this.context.identity.workspace_id, folder = join(this.context.paths.state_root, 'benchmark-runs', jobId);
    const resultKey=`benchmark-result.v1:${workspace}:${jobId}`;
    const committedState = this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(resultKey);
    if (committedState) { const previous = JSON.parse(String(committedState.value)); options.checkpoint({benchmark_result:previous}); return previous; }
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const requestPath = join(folder, 'request.json'), resultPath = join(folder, 'result.json');
    const write = (path:string,value:string) => {const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}};
    const fingerprint = sha256(JSON.stringify({ jobId, account: frozen, scope: manifest.scope,...(typeof manifest.cursor==='string'?{cursor:manifest.cursor}:{}) }));
    const read = (path: string): JsonObject | null => {
      try { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error();
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { return JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new ContractError('STORAGE_UNAVAILABLE', '本轮采集回执不可读'); }
    };
    let saved = read(resultPath);
    if (!saved) {
      // 请求前写凭据无关的日志；进程中断后的未知请求不得恢复成第二次计费调用。
      if (read(requestPath)) throw new ContractError('CAPABILITY_UNVERIFIED', '上次采集结果未确认，未重复请求；请手动发起新一轮');
      write(requestPath, JSON.stringify({ request_fingerprint: fingerprint, account_id: String(account.id), started_at: new Date().toISOString(), state: 'sending' }));
      const feed = await this.adapter.fetchBenchmarkFeed(String(account.canonical_url), account.platform as Platform, String(account.platform_account_id), options.signal,typeof manifest.cursor==='string'?manifest.cursor:null);
      saved = { request_fingerprint: fingerprint, feed: feed as unknown as JsonObject }; write(resultPath, JSON.stringify(saved));
    }
    if (saved.request_fingerprint !== fingerprint) throw new ContractError('IDEMPOTENCY_CONFLICT', '采集回执与冻结目标不符');
    const feed = saved.feed as unknown as BenchmarkFeed;
    if (feed.evidence_kind === 'internal_rule' && this.context.config.mode !== 'demo') throw new ContractError('CAPABILITY_UNVERIFIED', '真实工作区不能采用模拟平台响应');
    const rawPath = join(folder, 'response.json'), existingRaw = read(rawPath);
    if (!existingRaw) write(rawPath, feed.raw_body);
    else if (sha256(JSON.stringify(existingRaw)) !== sha256(JSON.stringify(JSON.parse(feed.raw_body)))) throw new ContractError('IDEMPOTENCY_CONFLICT', '平台原始响应已变化');
    const rawFd=openSync(rawPath,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(sha256(readFileSync(rawFd,'utf8'))!==sha256(feed.raw_body))throw new ContractError('IDEMPOTENCY_CONFLICT','平台原始响应字节与回执不符');}finally{closeSync(rawFd);}
    const rawHash = sha256(feed.raw_body), rawRef = { path: rawPath, sha256: rawHash, adapter_version: BENCHMARK_FEED_VERSION };
    const result = transaction(this.context.db, () => {
      assertCurrent(); const db = this.context.db, source = sourceRow(db, workspace, String(manifest.source_id)), metricsSource = ensureMetricsSourceInTransaction(db, workspace);
      let inserted = 0, updated = 0, snapshots = 0;
      for (const record of feed.records) {
        record.payload.provider_metadata.collected_at=feed.collected_at;
        record.identity = { platform: account.platform as Platform, platform_work_id: record.external_id, account_id: String(account.id), evidence: { kind: 'tikhub_account_works', author_platform_id: String(account.platform_account_id), account_id: String(account.id), evidence_kind: feed.evidence_kind, raw_response_ref: rawRef, collected_at: feed.collected_at } };
        const stored = upsertSourceRecord(db, workspace, String(source.id), record, { external_id: record.external_id, kind: 'tikhub_benchmark:' + account.platform, relative_path: null, source_url: record.canonical_url, capture_time: feed.collected_at, sha256: rawHash, parser_version: BENCHMARK_FEED_VERSION, availability: 'available', raw_response_ref: rawRef },{replace_platform_media:true});
        if (stored.inserted) inserted++; else updated++;
        const row = db.prepare('SELECT work_id FROM source_records WHERE workspace_id=? AND id=?').get(workspace, stored.record_id)!, workId = String(row.work_id);
        db.prepare('UPDATE source_records SET author_account_id=? WHERE workspace_id=? AND id=?').run(String(account.id), workspace, stored.record_id);
        db.prepare('UPDATE works SET published_at=COALESCE(published_at,?),format=COALESCE(format,?),format_source=COALESCE(format_source,?),updated_at=? WHERE workspace_id=? AND id=?').run(record.published_at, String(record.payload.provider_metadata.format), 'tikhub_account_works', feed.collected_at, workspace, workId);
        upsertIndex(db, workspace, { path: `benchmark:${account.id}:${record.external_id}`, location_id: stored.location_id, mtime: 0, size: Buffer.byteLength(record.payload.body ?? ''), sha256: rawHash, parser_version: BENCHMARK_FEED_VERSION, payload: record.payload });
        const readings: ReadingInput[] = Object.entries(record.payload.provider_metadata.metrics as JsonObject).map(([key, value]) => ({ definition: { platform: account.platform as Platform, scope: 'work', key, raw_field: 'account_feed.' + key, unit: 'count', kind: 'cumulative', denominator_key: null, visibility: 'public', definition_version: BENCHMARK_FEED_VERSION }, value: typeof value === 'string' ? value : null, availability: typeof value === 'string' ? 'available' : 'unavailable', reason: typeof value === 'string' ? null : 'endpoint_field_missing' }));
        const committed = commitObservationInTransaction(db, workspace, metricsSource, { collection_request_id: jobId + ':' + record.external_id, request_fingerprint: sha256(fingerprint + ':' + record.external_id), platform: account.platform as Platform, scope: 'work', target_id: workId, platform_work_id: record.external_id, account_id: String(account.id), published_at: record.published_at, observed_at: null, observed_time_basis: 'unknown', observed_time_reason: 'account_feed_observation_time_unverified', observation_evidence_ref: null, collected_at: feed.collected_at, target_window: null, raw_path: rawPath, raw_sha256: rawHash, adapter_version: BENCHMARK_FEED_VERSION, metrics: readings, failure: null, retry_after_s: null, evidence_kind: feed.evidence_kind });
        if (!committed.replay) snapshots++;
      }
      const old=db.prepare('SELECT value FROM application_metadata WHERE key=?').get(stateKey(workspace,String(account.id))),previous=old?JSON.parse(String(old.value)) as JsonObject:{};
      const older=manifest.scope==='older_page',stalled=older&&feed.has_more&&feed.next_cursor===manifest.cursor;
      const historyCursor=older?(stalled?null:feed.next_cursor??null):typeof previous.history_cursor==='string'?previous.history_cursor:previous.history_stop_reason==='endpoint_end'?null:feed.next_cursor??null;
      const stop=older?(stalled?'cursor_stalled':!feed.has_more?'endpoint_end':historyCursor?null:'cursor_missing'):previous.history_stop_reason==='endpoint_end'?'endpoint_end':!feed.has_more?'endpoint_end':historyCursor?null:'cursor_missing';
      const oldest=db.prepare('SELECT MIN(published_at) oldest FROM works WHERE workspace_id=? AND account_id=? AND canonical_work_id IS NULL').get(workspace,String(account.id));
      const stats: JsonObject = { last_success_at: feed.collected_at,last_newest_at:older?previous.last_newest_at??previous.last_success_at??null:feed.collected_at, inserted, updated, snapshots, total: feed.records.length, skipped: feed.skipped, has_more: feed.has_more,next_cursor:feed.next_cursor??null,history_cursor:historyCursor,history_pages:Number(previous.history_pages??0)+(older?1:0),history_stop_reason:stop,oldest_published_at:(oldest?.oldest as string|null)??null, scope: manifest.scope, observation_time: 'unknown', raw_response_ref: rawRef, job_id: jobId };
      db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?)').run(resultKey,JSON.stringify(stats));
      setCheckpoint(db, workspace, String(source.connector_id), String(account.id), { ...stats, seen_ids: feed.records.map(r => r.external_id) }, false);
      db.prepare('UPDATE sources SET last_sync_at=?,updated_at=? WHERE workspace_id=? AND id=?').run(feed.collected_at, feed.collected_at, workspace, String(source.id));
      db.prepare("UPDATE connectors SET capability_status='supported',last_success_at=?,last_error=NULL WHERE workspace_id=? AND id=?").run(feed.collected_at, workspace, String(source.connector_id));
      db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(stateKey(workspace, String(account.id)), JSON.stringify(stats)); return stats;
    });
    options.checkpoint({ benchmark_result: result }); return result;
  }
}
