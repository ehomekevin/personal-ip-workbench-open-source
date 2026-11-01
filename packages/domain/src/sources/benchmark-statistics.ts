import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ContractError, BenchmarkStatisticsRefreshSchema, type BenchmarkStatisticsRefreshRequest, type BenchmarkStatisticsRefreshResponse, type RawResponseRef, type RequestContext } from '@workbench/contracts';
import { canonicalJson, sha256, transaction } from '@workbench/storage/connection';
import { readIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import { parseBenchmarkStatistics, type BenchmarkStatisticsResult } from '../../../adapters/src/tikhub/benchmark-statistics.ts';
import { assertRequestIdentity } from '../documents/index.ts';
import type { ApplicationContext } from '../ports/index.ts';
import { readTrustedDouyinBenchmarkTargets, type TrustedDouyinBenchmarkTarget } from './material-reprojection.ts';

export interface BenchmarkStatisticsClient { credentialPresent?(): boolean; fetch(ids: string[], signal?: AbortSignal): Promise<BenchmarkStatisticsResult> }
export type BenchmarkStatisticsState = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'unknown';
export interface BenchmarkStatisticsStatus {
  refresh_id: string; state: BenchmarkStatisticsState; matched_count: number; batch_count: number;
  completed_batches: number; updated_count: number; missing_count: number; stale_count: number;
  remote_attempts: number; started_at: string; finished_at: string | null; error: string | null;
  invalid_count: number; retained_count: number;
}
type FileRef = { path: string; sha256: string };
interface Batch {
  batch_index: number; aweme_ids: string[]; state: 'pending' | 'sending' | 'applied' | 'failed' | 'unknown' | 'not_sent';
  request_fingerprint: string; request_ref: FileRef | null; result_ref: FileRef | null; raw_response_ref: RawResponseRef | null;
  updated_count: number; missing_count: number; stale_count: number; invalid_count: number; error: string | null;
}
interface Operation extends BenchmarkStatisticsStatus {
  schema_version: 'benchmark-statistics-refresh/1'; workspace_id: string; created_at: string; updated_at: string;
  targets: TrustedDouyinBenchmarkTarget[]; batches: Batch[]; request_ref: FileRef;
}
const operationKey = (workspace: string, id: string) => `benchmark-statistics-refresh.v1:${workspace}:${id}`;
const latestKey = (workspace: string) => `benchmark-statistics-latest.v1:${workspace}`;
const metricKey = (workspace: string, account: string, aweme: string) => `benchmark-play-count.v1:${workspace}:${account}:${aweme}`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const activeStates = new Set<BenchmarkStatisticsState>(['queued', 'running', 'unknown']);
const stamp = () => new Date().toISOString();
const storageError = (message: string): never => { throw new ContractError('STORAGE_UNAVAILABLE', message); };
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return storageError('统计回执结构无效'); return value as Record<string, unknown>; }
function decoded(text: string): Record<string, unknown> { try { return object(JSON.parse(text)); } catch (e) { if (e instanceof ContractError) throw e; return storageError('统计回执不是有效 JSON'); } }
function readPlain(path: string, max = 8 * 1024 * 1024): string | null {
  let fd: number | undefined;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max || realpathSync(path) !== path) return storageError('统计回执不是可核对的普通文件');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const bytes = readFileSync(fd);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (bytes.byteLength > max || !Buffer.from(text).equals(bytes)) return storageError('统计回执字节无效');
    return text;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; if (e instanceof ContractError) throw e; return storageError('统计回执不可读'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function safeDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) storageError('统计目录必须位于唯一 state 且没有链接');
}
function writeExclusive(path: string, bytes: string): FileRef {
  const parent = dirname(path); safeDirectory(parent); let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    const directory = openSync(parent, constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); }
    return { path, sha256: sha256(bytes) };
  } finally { if (fd !== undefined) closeSync(fd); }
}
const countString = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,29})$/.test(value);
const batchName = (index: number) => 'batch-' + String(index + 1).padStart(2, '0');
function batchFingerprint(workspace: string, id: string, batch: Pick<Batch, 'batch_index' | 'aweme_ids'>, targets: TrustedDouyinBenchmarkTarget[]): string {
  return sha256(canonicalJson({ workspace_id: workspace, refresh_id: id, batch_index: batch.batch_index, aweme_ids: batch.aweme_ids, targets }));
}
function summary(op: Operation): BenchmarkStatisticsStatus {
  return { refresh_id: op.refresh_id, state: op.state, matched_count: op.matched_count, batch_count: op.batch_count, completed_batches: op.completed_batches, updated_count: op.updated_count, missing_count: op.missing_count, stale_count: op.stale_count, invalid_count: op.invalid_count, retained_count: op.retained_count, remote_attempts: op.remote_attempts, started_at: op.started_at, finished_at: op.finished_at, error: op.error };
}
function startResponse(op: Operation): BenchmarkStatisticsRefreshResponse { return { refresh_id: op.refresh_id, state: op.state, matched_count: op.matched_count, batch_count: op.batch_count }; }

export class BenchmarkStatistics {
  readonly context: ApplicationContext; readonly client: BenchmarkStatisticsClient;
  private readonly active = new Set<Promise<void>>(); private closed = false;
  constructor(context: ApplicationContext, client: BenchmarkStatisticsClient) { this.context = context; this.client = client; }
  private root(): string {
    const root = this.context.paths.state_root;
    const workspace = this.context.db.prepare('SELECT paths FROM workspaces WHERE workspace_id=? AND id=?').get(this.context.identity.workspace_id, this.context.identity.workspace_id);
    if (!workspace || !isAbsolute(root) || resolve(root) !== root || decoded(String(workspace.paths)).state_root !== root) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '统计刷新只能使用主服务唯一已登记的 state');
    const info = lstatSync(root); if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(root) !== root) return storageError('统计 state 路径不可核对');
    return root;
  }
  private folder(id: string): string { if (!uuid.test(id)) return storageError('统计 operation ID 无效'); return join(this.root(), 'benchmark-statistics-runs', id); }
  private read(id: string): Operation {
    const row = this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(operationKey(this.context.identity.workspace_id, id));
    if (!row) throw new ContractError('NOT_FOUND', '统计刷新不存在');
    const value = decoded(String(row.value));
    if (value.schema_version !== 'benchmark-statistics-refresh/1' || value.workspace_id !== this.context.identity.workspace_id || value.refresh_id !== id || !uuid.test(id) || !Array.isArray(value.targets) || !Array.isArray(value.batches) || value.targets.length > 200 || value.batches.length > 4 || value.matched_count !== value.targets.length || value.batch_count !== value.batches.length || value.batches.some((entry, index) => { const b = object(entry); return b.batch_index !== index || !Array.isArray(b.aweme_ids) || b.aweme_ids.length < 1 || b.aweme_ids.length > 50 || b.aweme_ids.some(id => typeof id !== 'string' || !/^\d{1,30}$/.test(id)); })) return storageError('统计 operation 与当前工作区不符');
    return value as unknown as Operation;
  }
  private save(op: Operation): void {
    if (!this.context.db.isTransaction) throw new Error('Statistics status requires a transaction');
    op.updated_at = stamp(); this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(operationKey(op.workspace_id, op.refresh_id), canonicalJson(op));
  }
  private edit(id: string, change: (op: Operation) => void): Operation { return transaction(this.context.db, () => { const op = this.read(id); change(op); this.save(op); return op; }); }
  private current(): Operation | null {
    const row = this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(latestKey(this.context.identity.workspace_id));
    return row ? this.read(String(decoded(String(row.value)).refresh_id)) : null;
  }
  status(request: RequestContext): BenchmarkStatisticsStatus | null { assertRequestIdentity(this.context, request); const op = this.current(); return op ? summary(op) : null; }
  start(request: RequestContext, input: BenchmarkStatisticsRefreshRequest = {}): BenchmarkStatisticsRefreshResponse {
    assertRequestIdentity(this.context, request); BenchmarkStatisticsRefreshSchema.parse(input);
    if (this.closed) throw new ContractError('STORAGE_UNAVAILABLE', '统计刷新已关闭');
    if (!request.idempotency_key || request.idempotency_key.length > 200) throw new ContractError('VALIDATION_ERROR', '此写操作需要有效 Idempotency-Key');
    const db = this.context.db, operation = 'benchmark-statistics-refresh', replay = readIdempotent<BenchmarkStatisticsRefreshResponse>(db, request, operation, input); if (replay) return replay;
    let created: string | null = null;
    const response = transaction(db, () => {
      const replay = readIdempotent<BenchmarkStatisticsRefreshResponse>(db, request, operation, input); if (replay) return replay;
      const current = this.current();
      if (current && activeStates.has(current.state)) { const response = startResponse(current); storeIdempotent(db, request, operation, input, response); return response; }
      const targets = readTrustedDouyinBenchmarkTargets(this.context);
      if (targets.length > 200 || new Set(targets.map(t => t.account_id)).size > 7 || new Set(targets.map(t => t.aweme_id)).size !== targets.length) throw new ContractError('CAPABILITY_UNSUPPORTED', '统计刷新限定最多 7 个已确认对标账号、200 个唯一作品和 4 批');
      if (targets.length && this.client.credentialPresent?.() === false) throw new ContractError('AUTH_REQUIRED', '先填写 TikHub 密钥');
      const refreshId = randomUUID(), at = stamp(), batches: Batch[] = [];
      for (let i = 0; i < targets.length; i += 50) {
        const selected = targets.slice(i, i + 50), batch = { batch_index: batches.length, aweme_ids: selected.map(t => t.aweme_id) };
        batches.push({ ...batch, state: 'pending', request_fingerprint: batchFingerprint(request.workspace_id, refreshId, batch, selected), request_ref: null, result_ref: null, raw_response_ref: null, updated_count: 0, missing_count: 0, stale_count: 0, invalid_count: 0, error: null });
      }
      const runs = join(this.root(), 'benchmark-statistics-runs'); safeDirectory(runs); const folder = join(runs, refreshId); safeDirectory(folder);
      const manifest = { schema_version: 'benchmark-statistics-refresh-request/1', workspace_id: request.workspace_id, refresh_id: refreshId, created_at: at, targets, batches: batches.map(b => ({ batch_index: b.batch_index, aweme_ids: b.aweme_ids, request_fingerprint: b.request_fingerprint })) };
      const requestRef = writeExclusive(join(folder, 'request.json'), canonicalJson(manifest));
      const op: Operation = { schema_version: 'benchmark-statistics-refresh/1', workspace_id: request.workspace_id, refresh_id: refreshId, state: 'queued', matched_count: targets.length, batch_count: batches.length, completed_batches: 0, updated_count: 0, missing_count: 0, invalid_count: 0, stale_count: 0, retained_count: targets.length, remote_attempts: 0, started_at: at, finished_at: null, error: null, created_at: at, updated_at: at, targets, batches, request_ref: requestRef };
      this.save(op); db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(latestKey(request.workspace_id), canonicalJson({ refresh_id: refreshId }));
      const response = startResponse(op); storeIdempotent(db, request, operation, input, response); created = refreshId; return response;
    });
    if (created) this.schedule(created); return response;
  }
  private schedule(id: string): void {
    const task = Promise.resolve().then(() => this.run(id)).catch(error => { this.edit(id, op => { op.error = error instanceof Error ? error.message : '统计刷新未完成'; const batch = op.batches.find(b => b.state === 'sending'); if (batch) { batch.state = 'unknown'; batch.error = op.error; } }); this.finish(id); }).finally(() => this.active.delete(task));
    this.active.add(task);
  }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.active]); }
  private targets(op: Operation, batch: Batch): TrustedDouyinBenchmarkTarget[] { return batch.aweme_ids.map(id => { const t = op.targets.find(t => t.aweme_id === id); if (!t) return storageError('批次作品与冻结目标不符'); return t; }); }
  private bound(target: TrustedDouyinBenchmarkTarget): boolean {
    const row = this.context.db.prepare(`SELECT r.id,r.external_id,r.canonical_url,r.author_account_id,a.role,a.platform,a.identity_status,a.platform_account_id,a.canonical_url AS account_url FROM source_records r JOIN accounts a ON a.workspace_id=r.workspace_id AND a.id=r.author_account_id WHERE r.workspace_id=? AND r.id=?`).get(this.context.identity.workspace_id, target.record_id);
    return !!row && row.author_account_id === target.account_id && row.external_id === target.aweme_id && row.canonical_url === target.canonical_url && row.role === 'benchmark' && row.platform === 'douyin' && row.identity_status === 'confirmed' && row.platform_account_id === target.platform_account_id && row.account_url === target.account_url;
  }
  private checkedManifest(op: Operation): void {
    const expectedPath = join(this.folder(op.refresh_id), 'request.json'), bytes = readPlain(expectedPath);
    if (!bytes || op.request_ref.path !== expectedPath || sha256(bytes) !== op.request_ref.sha256) return storageError('统计冻结请求与 operation 不符');
    const manifest = decoded(bytes);
    if (manifest.schema_version !== 'benchmark-statistics-refresh-request/1' || manifest.workspace_id !== op.workspace_id || manifest.refresh_id !== op.refresh_id || canonicalJson(manifest.targets) !== canonicalJson(op.targets) || canonicalJson(manifest.batches) !== canonicalJson(op.batches.map(b => ({ batch_index: b.batch_index, aweme_ids: b.aweme_ids, request_fingerprint: b.request_fingerprint })))) return storageError('统计冻结目标已变化');
  }
  private savedResult(op: Operation, batch: Batch): { feed: BenchmarkStatisticsResult; request_ref: FileRef; result_ref: FileRef; raw_response_ref: RawResponseRef } {
    this.checkedManifest(op); const folder = join(this.folder(op.refresh_id), batchName(batch.batch_index)), requestPath = join(folder, 'request.json'), resultPath = join(folder, 'result.json'), rawPath = join(folder, 'response.json');
    const requestBytes = readPlain(requestPath), resultBytes = readPlain(resultPath), raw = readPlain(rawPath, 5 * 1024 * 1024);
    if (!requestBytes || !resultBytes || raw === null) return storageError('已发送批次没有完整已保存结果');
    const targets = this.targets(op, batch), fingerprint = batchFingerprint(op.workspace_id, op.refresh_id, batch, targets), request = decoded(requestBytes), result = decoded(resultBytes), feed = object(result.feed) as unknown as BenchmarkStatisticsResult, ref = object(result.raw_response_ref);
    if (fingerprint !== batch.request_fingerprint || request.schema_version !== 'benchmark-statistics-batch-request/1' || result.schema_version !== 'benchmark-statistics-batch-result/1' || request.request_fingerprint !== fingerprint || request.workspace_id !== op.workspace_id || request.refresh_id !== op.refresh_id || request.batch_index !== batch.batch_index || canonicalJson(request.aweme_ids) !== canonicalJson(batch.aweme_ids) || canonicalJson(request.targets) !== canonicalJson(targets) || result.request_fingerprint !== fingerprint || result.workspace_id !== op.workspace_id || result.refresh_id !== op.refresh_id || result.batch_index !== batch.batch_index || ref.path !== rawPath || ref.sha256 !== sha256(raw) || ref.adapter_version !== 'benchmark-statistics/1' || feed.raw_body !== raw) return storageError('统计批次回执、raw 与冻结请求不符');
    if (batch.request_ref && (batch.request_ref.path !== requestPath || batch.request_ref.sha256 !== sha256(requestBytes)) || batch.result_ref && (batch.result_ref.path !== resultPath || batch.result_ref.sha256 !== sha256(resultBytes)) || batch.raw_response_ref && (batch.raw_response_ref.path !== rawPath || batch.raw_response_ref.sha256 !== sha256(raw))) return storageError('统计已保存回执 hash 不符');
    const workspace = this.context.db.prepare('SELECT mode FROM workspaces WHERE id=? AND workspace_id=?').get(op.workspace_id, op.workspace_id);
    if (!['real_platform', 'internal_rule'].includes(feed.evidence_kind) || feed.evidence_kind === 'internal_rule' && (this.context.config.mode !== 'demo' || workspace?.mode !== 'demo') || typeof feed.collected_at !== 'string' || !Number.isFinite(Date.parse(feed.collected_at)) || canonicalJson(parseBenchmarkStatistics(raw, batch.aweme_ids)) !== canonicalJson(feed.statistics)) throw new ContractError('CAPABILITY_UNVERIFIED', '统计结果尚未与真实 raw 核对');
    return { feed, request_ref: { path: requestPath, sha256: sha256(requestBytes) }, result_ref: { path: resultPath, sha256: sha256(resultBytes) }, raw_response_ref: ref as unknown as RawResponseRef };
  }
  // 仅供隔离测试在结果已落盘、应用前模拟进程中断。
  protected beforeApply(): void {}
  private apply(id: string, index: number): void {
    transaction(this.context.db, () => {
      const op = this.read(id), batch = op.batches[index]!; if (batch.state === 'applied') return;
      const saved = this.savedResult(op, batch); let updated = 0, missing = 0, invalid = 0, stale = 0;
      for (const target of this.targets(op, batch)) {
        if (!this.bound(target)) { stale++; continue; }
        const statistic = saved.feed.statistics.find(row => row.aweme_id === target.aweme_id);
        if (!statistic) { missing++; continue; } if (!countString(statistic.play_count)) { invalid++; continue; }
        const key = metricKey(op.workspace_id, target.account_id, target.aweme_id), previous = this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key);
        if (previous && Date.parse(String(decoded(String(previous.value)).collected_at)) > Date.parse(saved.feed.collected_at)) { stale++; continue; }
        const metric = { schema_version: 'benchmark-play-count/1', workspace_id: op.workspace_id, account_id: target.account_id, platform_account_id: target.platform_account_id, record_id: target.record_id, aweme_id: target.aweme_id, canonical_url: target.canonical_url, refresh_id: id, batch_index: index, value: statistic.play_count, source_kind: 'tikhub_douyin_video_statistics', raw_response_ref: saved.raw_response_ref, collected_at: saved.feed.collected_at, observed_at: null, observed_time_basis: 'unknown', evidence_kind: saved.feed.evidence_kind, request_fingerprint: batch.request_fingerprint };
        this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, canonicalJson(metric)); updated++;
      }
      Object.assign(batch, { request_ref: saved.request_ref, result_ref: saved.result_ref, raw_response_ref: saved.raw_response_ref, state: 'applied', updated_count: updated, missing_count: missing, invalid_count: invalid, stale_count: stale, error: null }); this.save(op);
    });
  }
  private finish(id: string): void {
    const op = this.edit(id, op => {
      for (const batch of op.batches) if (batch.state === 'pending') { batch.state = 'not_sent'; batch.error = '本次停止后未发送此批次'; }
      op.completed_batches = op.batches.filter(b => ['applied', 'failed'].includes(b.state)).length;
      for (const key of ['updated_count', 'missing_count', 'invalid_count', 'stale_count'] as const) op[key] = op.batches.reduce((sum, b) => sum + b[key], 0);
      op.retained_count = op.matched_count - op.updated_count;
      op.state = op.batches.some(b => b.state === 'unknown' || b.state === 'sending') ? 'unknown' : op.updated_count === op.matched_count ? 'succeeded' : op.batches.some(b => b.state === 'applied') ? 'partial' : 'failed';
      op.error = op.batches.find(b => b.error)?.error ?? null; op.finished_at = op.state === 'unknown' ? null : stamp();
    });
    if (op.state !== 'unknown') { const path = join(this.folder(id), 'result.json'); if (!existsSync(path)) writeExclusive(path, canonicalJson({ schema_version: 'benchmark-statistics-refresh-result/1', workspace_id: op.workspace_id, ...summary(op), batches: op.batches })); }
  }
  private async run(id: string): Promise<void> {
    this.edit(id, op => { this.checkedManifest(op); op.state = 'running'; });
    for (let index = 0; index < this.read(id).batch_count; index++) {
      const op = this.read(id), batch = op.batches[index]!, targets = this.targets(op, batch), folder = join(this.folder(id), batchName(index)); safeDirectory(folder);
      if (existsSync(join(folder, 'request.json'))) { if (existsSync(join(folder, 'result.json'))) this.apply(id, index); else this.edit(id, op => { op.batches[index]!.state = 'unknown'; op.batches[index]!.error = '请求已发送但没有已保存结果，未重复请求'; }); if (this.read(id).batches[index]!.state === 'unknown') break; continue; }
      const stale = targets.filter(target => !this.bound(target)).length;
      if (stale) { this.edit(id, op => { Object.assign(op.batches[index]!, { state: 'failed', stale_count: stale, error: '冻结目标已变化，此批次未发送' }); }); continue; }
      const requestRef = writeExclusive(join(folder, 'request.json'), canonicalJson({ schema_version: 'benchmark-statistics-batch-request/1', workspace_id: op.workspace_id, refresh_id: id, batch_index: index, aweme_ids: batch.aweme_ids, targets, request_fingerprint: batch.request_fingerprint, started_at: stamp() }));
      this.edit(id, op => { Object.assign(op.batches[index]!, { state: 'sending', request_ref: requestRef }); op.remote_attempts++; });
      try {
        const feed = await this.client.fetch(batch.aweme_ids, AbortSignal.timeout(30_000));
        if (typeof feed.raw_body !== 'string' || Buffer.byteLength(feed.raw_body) > 5 * 1024 * 1024) throw new ContractError('CAPABILITY_UNVERIFIED', '统计结果超出限制');
        const rawRef = { ...writeExclusive(join(folder, 'response.json'), feed.raw_body), adapter_version: 'benchmark-statistics/1' } as RawResponseRef;
        const resultRef = writeExclusive(join(folder, 'result.json'), canonicalJson({ schema_version: 'benchmark-statistics-batch-result/1', workspace_id: op.workspace_id, refresh_id: id, batch_index: index, request_fingerprint: batch.request_fingerprint, feed, raw_response_ref: rawRef }));
        this.edit(id, op => { Object.assign(op.batches[index]!, { raw_response_ref: rawRef, result_ref: resultRef }); });
        this.beforeApply(); this.apply(id, index);
      } catch (error) {
        const knownFailure = error instanceof ContractError && ['AUTH_REQUIRED', 'QUOTA_EXHAUSTED', 'VALIDATION_ERROR'].includes(error.code);
        this.edit(id, op => { Object.assign(op.batches[index]!, { state: knownFailure ? 'failed' : 'unknown', error: error instanceof Error ? error.message : '统计结果未确认' }); }); break;
      }
    }
    this.finish(id);
  }
  async initialize(): Promise<void> {
    const rows = this.context.db.prepare('SELECT key,value FROM application_metadata WHERE key LIKE ? ORDER BY key').all(`benchmark-statistics-refresh.v1:${this.context.identity.workspace_id}:%`);
    for (const row of rows) {
      const saved = decoded(String(row.value)), id = String(saved.refresh_id); if (!activeStates.has(saved.state as BenchmarkStatisticsState)) continue;
      let op = this.read(id);
      try {
        this.checkedManifest(op);
        for (let index = 0; index < op.batch_count; index++) {
          const batch = this.read(id).batches[index]!; if (batch.state === 'applied') continue;
          const folder = join(this.folder(id), batchName(index));
          if (existsSync(join(folder, 'result.json'))) this.apply(id, index);
          else this.edit(id, op => { const batch = op.batches[index]!; batch.state = existsSync(join(folder, 'request.json')) ? 'unknown' : 'not_sent'; batch.error = batch.state === 'unknown' ? '恢复只核对已保存回执；请求结果未确认，未重复请求' : '恢复未发送批次，未自动请求'; });
        }
      } catch (error) { this.edit(id, op => { const batch = op.batches.find(b => b.state !== 'applied'); if (batch) Object.assign(batch, { state: 'unknown', error: error instanceof Error ? error.message : '恢复回执不可核对' }); }); }
      this.finish(id); op = this.read(id);
    }
  }
}
