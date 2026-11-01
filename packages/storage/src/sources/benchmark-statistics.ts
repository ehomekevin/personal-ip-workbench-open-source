import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { JsonObject } from '@workbench/contracts';
import { canonicalJson, sha256, type DatabaseSync } from '../connection/index.ts';

export interface TrustedBenchmarkPlayCount { value: string; source: JsonObject }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const identifier = /^\d{1,30}$/;
const decimal = /^(0|[1-9]\d{0,29})$/;
function invalid(): never { throw new Error('Untrusted benchmark statistic'); }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const parsed = (bytes: string): Record<string, unknown> => object(JSON.parse(bytes));
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

function directory(path: string): void {
  const info = lstatSync(path);
  if (!isAbsolute(path) || resolve(path) !== path || !info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) invalid();
}
function plainFile(path: string, max: number): string {
  let fd: number | undefined;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max || realpathSync(path) !== path) invalid();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size || before.nlink !== 1) invalid();
    const bytes = readFileSync(fd), after = fstatSync(fd), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (bytes.byteLength > max || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || !Buffer.from(text).equals(bytes)) invalid();
    return text;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function referencedFile(value: unknown, path: string, max: number, adapter = false): string {
  const ref = object(value);
  if (ref.path !== path || typeof ref.sha256 !== 'string' || !hash.test(ref.sha256) || adapter && ref.adapter_version !== 'benchmark-statistics/1') invalid();
  const bytes = plainFile(path, max);
  if (sha256(bytes) !== ref.sha256) invalid();
  return bytes;
}
function metadata(db: DatabaseSync, key: string): Record<string, unknown> {
  const row = db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key);
  if (!row || typeof row.value !== 'string' || Buffer.byteLength(row.value) > 2 * 1024 * 1024) invalid();
  return parsed(row.value);
}
function count(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === 'string' && decimal.test(value) ? value : null;
}
// 独立于 adapter 的只读核对：只接受专用统计接口已保存的 statistics_list。
function rawStatistics(bytes: string, ids: string[]): Array<{ aweme_id: string; play_count: string | null }> {
  const root = parsed(bytes), data = object(root.data), rows = data.statistics_list;
  if (root.code !== 200 && root.code !== '200' || !Array.isArray(rows) || rows.length > 50) invalid();
  const requested = new Set(ids), seen = new Set<string>(), result: Array<{ aweme_id: string; play_count: string | null }> = [];
  for (const entry of rows) {
    const row = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    if (typeof row.aweme_id !== 'string' || !identifier.test(row.aweme_id)) continue;
    if (!requested.has(row.aweme_id) || seen.has(row.aweme_id)) invalid();
    seen.add(row.aweme_id); result.push({ aweme_id: row.aweme_id, play_count: count(row.play_count) });
  }
  return result;
}
function targets(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 200) invalid();
  const rows = value.map(object);
  if (new Set(rows.map(row => row.aweme_id)).size !== rows.length) invalid();
  for (const row of rows) {
    if (typeof row.aweme_id !== 'string' || !identifier.test(row.aweme_id) || typeof row.platform_account_id !== 'string' || !identifier.test(row.platform_account_id) || typeof row.record_id !== 'string' || typeof row.account_id !== 'string' || typeof row.canonical_url !== 'string' || typeof row.account_url !== 'string' || typeof row.source_location_id !== 'string' || typeof row.source_signature !== 'string' || !hash.test(row.source_signature)) invalid();
    const ref = object(row.source_raw_response_ref);
    if (typeof ref.path !== 'string' || !isAbsolute(ref.path) || typeof ref.sha256 !== 'string' || !hash.test(ref.sha256) || typeof ref.adapter_version !== 'string' || !/^benchmark-feed\/\d+$/.test(ref.adapter_version)) invalid();
  }
  return rows;
}

/** Invalid or missing provenance keeps plays unknown; this reader never writes or calls a provider. */
export function readTrustedBenchmarkPlayCount(db: DatabaseSync, workspace: string, row: Record<string, unknown>): TrustedBenchmarkPlayCount | null {
  try {
    if (typeof row.id !== 'string' || typeof row.author_account_id !== 'string' || typeof row.external_id !== 'string' || !identifier.test(row.external_id) || typeof row.canonical_url !== 'string') return null;
    const current = db.prepare(`SELECT r.id,r.workspace_id,r.author_account_id,r.external_id,r.canonical_url,
      a.role,a.platform,a.identity_status,a.platform_account_id,a.canonical_url AS account_url
      FROM source_records r JOIN accounts a ON a.workspace_id=r.workspace_id AND a.id=r.author_account_id
      WHERE r.workspace_id=? AND r.id=?`).get(workspace, row.id);
    if (!current || current.author_account_id !== row.author_account_id || current.external_id !== row.external_id || current.canonical_url !== row.canonical_url || current.role !== 'benchmark' || current.platform !== 'douyin' || current.identity_status !== 'confirmed' || typeof current.platform_account_id !== 'string' || !identifier.test(current.platform_account_id)) return null;
    const metric = metadata(db, `benchmark-play-count.v1:${workspace}:${row.author_account_id}:${row.external_id}`);
    if (metric.schema_version !== 'benchmark-play-count/1' || metric.workspace_id !== workspace || metric.account_id !== row.author_account_id || metric.platform_account_id !== current.platform_account_id || metric.record_id !== row.id || metric.aweme_id !== row.external_id || metric.canonical_url !== row.canonical_url || metric.source_kind !== 'tikhub_douyin_video_statistics' || typeof metric.value !== 'string' || !decimal.test(metric.value) || typeof metric.refresh_id !== 'string' || !uuid.test(metric.refresh_id) || !Number.isSafeInteger(metric.batch_index) || Number(metric.batch_index) < 0 || Number(metric.batch_index) > 3 || typeof metric.collected_at !== 'string' || !Number.isFinite(Date.parse(metric.collected_at)) || metric.observed_at !== null || metric.observed_time_basis !== 'unknown') return null;
    const registered = db.prepare('SELECT paths,mode FROM workspaces WHERE workspace_id=? AND id=?').get(workspace, workspace);
    if (!registered || typeof registered.paths !== 'string') return null;
    const paths = parsed(registered.paths), root = paths.state_root;
    if (typeof root !== 'string' || metric.evidence_kind !== 'real_platform' && !(metric.evidence_kind === 'internal_rule' && registered.mode === 'demo')) return null;
    directory(root); const runs = join(root, 'benchmark-statistics-runs'), folder = join(runs, metric.refresh_id);
    directory(runs); directory(folder);
    const op = metadata(db, `benchmark-statistics-refresh.v1:${workspace}:${metric.refresh_id}`), frozen = targets(op.targets);
    if (op.schema_version !== 'benchmark-statistics-refresh/1' || op.workspace_id !== workspace || op.refresh_id !== metric.refresh_id || !Array.isArray(op.batches) || op.batches.length > 4 || op.matched_count !== frozen.length || op.batch_count !== op.batches.length) return null;
    const batches = op.batches.map(object), requestedIds: string[] = [];
    for (const [index, batch] of batches.entries()) {
      if (batch.batch_index !== index || !Array.isArray(batch.aweme_ids) || batch.aweme_ids.length < 1 || batch.aweme_ids.length > 50 || batch.aweme_ids.some(id => typeof id !== 'string' || !identifier.test(id))) return null;
      requestedIds.push(...batch.aweme_ids as string[]);
    }
    if (new Set(requestedIds).size !== requestedIds.length || requestedIds.length !== frozen.length || requestedIds.some(id => !frozen.some(target => target.aweme_id === id))) return null;
    const manifest = parsed(referencedFile(op.request_ref, join(folder, 'request.json'), 1024 * 1024));
    if (manifest.schema_version !== 'benchmark-statistics-refresh-request/1' || manifest.workspace_id !== workspace || manifest.refresh_id !== metric.refresh_id || !same(manifest.targets, frozen) || !same(manifest.batches, batches.map(batch => ({ batch_index: batch.batch_index, aweme_ids: batch.aweme_ids, request_fingerprint: batch.request_fingerprint })))) return null;
    const batch = batches[Number(metric.batch_index)];
    if (!batch || batch.state !== 'applied' || !Array.isArray(batch.aweme_ids) || !batch.aweme_ids.includes(row.external_id)) return null;
    const ids = batch.aweme_ids as string[], batchTargets = ids.map(id => frozen.find(target => target.aweme_id === id)!), target = batchTargets.find(target => target.aweme_id === row.external_id);
    if (!target || target.account_id !== row.author_account_id || target.platform_account_id !== current.platform_account_id || target.record_id !== row.id || target.canonical_url !== row.canonical_url || target.account_url !== current.account_url) return null;
    const fingerprint = sha256(canonicalJson({ workspace_id: workspace, refresh_id: metric.refresh_id, batch_index: metric.batch_index, aweme_ids: ids, targets: batchTargets }));
    if (metric.request_fingerprint !== fingerprint || batch.request_fingerprint !== fingerprint) return null;
    const batchFolder = join(folder, 'batch-' + String(Number(metric.batch_index) + 1).padStart(2, '0')); directory(batchFolder);
    const requestRef = object(batch.request_ref), resultRef = object(batch.result_ref), rawRef = object(batch.raw_response_ref);
    const request = parsed(referencedFile(requestRef, join(batchFolder, 'request.json'), 300 * 1024));
    const result = parsed(referencedFile(resultRef, join(batchFolder, 'result.json'), 8 * 1024 * 1024));
    const raw = referencedFile(rawRef, join(batchFolder, 'response.json'), 5 * 1024 * 1024, true);
    if (request.schema_version !== 'benchmark-statistics-batch-request/1' || request.workspace_id !== workspace || request.refresh_id !== metric.refresh_id || request.batch_index !== metric.batch_index || request.request_fingerprint !== fingerprint || !same(request.aweme_ids, ids) || !same(request.targets, batchTargets) || result.schema_version !== 'benchmark-statistics-batch-result/1' || result.workspace_id !== workspace || result.refresh_id !== metric.refresh_id || result.batch_index !== metric.batch_index || result.request_fingerprint !== fingerprint || !same(result.raw_response_ref, rawRef) || !same(metric.raw_response_ref, rawRef)) return null;
    const feed = object(result.feed), statistics = rawStatistics(raw, ids), statistic = statistics.find(item => item.aweme_id === row.external_id);
    if (feed.raw_body !== raw || feed.evidence_kind !== metric.evidence_kind || feed.collected_at !== metric.collected_at || !same(feed.statistics, statistics) || !statistic || statistic.play_count !== metric.value) return null;
    return { value: metric.value, source: { status: 'available', source_kind: 'tikhub_douyin_video_statistics', collected_at: metric.collected_at, observed_at: null, observed_time_basis: 'unknown', evidence_kind: String(metric.evidence_kind), refresh_id: metric.refresh_id, batch_index: Number(metric.batch_index), request_fingerprint: fingerprint, request_ref: { path: String(requestRef.path), sha256: String(requestRef.sha256) }, result_ref: { path: String(resultRef.path), sha256: String(resultRef.sha256) }, raw_response_ref: { path: String(rawRef.path), sha256: String(rawRef.sha256), adapter_version: 'benchmark-statistics/1' } } };
  } catch { return null; }
}
