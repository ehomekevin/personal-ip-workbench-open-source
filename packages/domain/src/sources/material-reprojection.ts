import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContractError, BenchmarkMaterialReprojectionSchema, type BenchmarkMaterialReprojectionRequest, type BenchmarkMaterialReprojectionResponse, type JsonObject, type RawResponseRef, type RequestContext, type SourceRecordPayload } from '@workbench/contracts';
import { canonicalJson, inputHash, sha256, transaction } from '@workbench/storage/connection';
import { readIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import { benchmarkMediaSummary, readSourcePayload } from '@workbench/storage/sources';
import { BENCHMARK_FEED_VERSION, parseBenchmarkFeed } from '../../../adapters/src/tikhub/benchmark-feed.ts';
import { assertRequestIdentity } from '../documents/index.ts';
import type { ApplicationContext } from '../ports/index.ts';

type BenchmarkPlatform = 'x' | 'douyin';
type ExistingMaterial = { external_id: string; canonical_url: string; payload: SourceRecordPayload };
export interface SavedBenchmarkProjectionInput {
  platform: BenchmarkPlatform; account_url: string; platform_account_id: string;
  raw_body: string; raw_sha256: string; evidence_kind: 'real_platform' | 'internal_rule';
  allow_internal_rule?: boolean; existing: ExistingMaterial[];
}
const platformFields = ['platform', 'platform_account_id', 'platform_work_id', 'metrics', 'duration_ms', 'format', 'play_count_raw'] as const;
const xPlatformFields = ['x_post', 'quoted_text', 'quoted_author', 'quoted_work_id'] as const;
const fail = (message: string): never => { throw new ContractError('CAPABILITY_UNVERIFIED', message); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('已保存回执结构无效');
function savedObject(value: string): Record<string, unknown> {
  try { return object(JSON.parse(value)); } catch (error) { if (error instanceof ContractError) throw error; return fail('已保存回执不是有效 JSON'); }
}
function assertAccountTarget(platform: BenchmarkPlatform, accountUrl: string, platformAccountId: string): void {
  let url: URL; try { url = new URL(accountUrl); } catch { return fail('已保存账号身份无效'); }
  const validTarget = platform === 'x'
    ? ['x.com', 'twitter.com'].includes(url.hostname) && /^\/[A-Za-z0-9_]{1,15}\/?$/.test(url.pathname)
    : platform === 'douyin' && ['douyin.com', 'www.douyin.com'].includes(url.hostname) && /^\/user\/[A-Za-z0-9_-]{16,256}\/?$/.test(url.pathname);
  if (!validTarget || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !/^\d{1,30}$/.test(platformAccountId)) fail('已保存账号身份无效');
}

// 纯离线投影：调用者提供保存字节和已知 hash；不获取媒体，也不改正文或人工整理字段。
export function projectSavedBenchmarkMaterials(input: SavedBenchmarkProjectionInput) {
  if (!/^[a-f0-9]{64}$/.test(input.raw_sha256) || sha256(input.raw_body) !== input.raw_sha256) throw new ContractError('IDEMPOTENCY_CONFLICT', '已保存 raw 字节与来源 hash 不符');
  if (Buffer.byteLength(input.raw_body) > 5 * 1024 * 1024) fail('已保存 raw 超出平台响应大小限制');
  if (input.evidence_kind !== 'real_platform' && !(input.evidence_kind === 'internal_rule' && input.allow_internal_rule === true)) fail('真实工作区不能采用模拟平台响应');
  assertAccountTarget(input.platform, input.account_url, input.platform_account_id);
  let body: unknown;
  try { body = JSON.parse(input.raw_body); } catch { return fail('已保存 raw 不是有效 JSON'); }
  const parsed = parseBenchmarkFeed(input.platform, input.account_url, input.platform_account_id, body);
  return input.existing.map(existing => {
    const record = parsed.records.find(row => row.external_id === existing.external_id);
    if (!record || record.canonical_url !== existing.canonical_url) return fail('已保存 raw 未核对到此账号的原作品：' + existing.external_id);
    const metadata = { ...existing.payload.provider_metadata };
    for (const key of platformFields) metadata[key] = record.payload.provider_metadata[key] ?? null;
    if (input.platform === 'x') for (const key of xPlatformFields) metadata[key] = record.payload.provider_metadata[key] ?? null;
    const localMedia = existing.payload.media.filter(item => typeof item.asset_id === 'string' || typeof item.path === 'string');
    const media = [...new Map([...record.payload.media, ...localMedia].map(item => [canonicalJson(item), item])).values()];
    const payload: SourceRecordPayload = { ...existing.payload, media, provider_metadata: metadata };
    return { external_id: existing.external_id, payload, summary: benchmarkMediaSummary(payload), changed: canonicalJson(existing.payload) !== canonicalJson(payload) };
  });
}

function plainFile(path: string, max: number): string {
  let fd: number | undefined;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max || realpathSync(path) !== path) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size || opened.size > max) throw new Error();
    const bytes = readFileSync(fd), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), after = fstatSync(fd);
    if (bytes.byteLength > max || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || !Buffer.from(text).equals(bytes)) throw new Error();
    return text;
  } catch { throw new ContractError('STORAGE_UNAVAILABLE', '已保存来源文件缺失、越界或不是可核对的普通文件：' + path); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function checkedPath(path: string, directory: boolean): string {
  if (!isAbsolute(path)) throw new ContractError('VALIDATION_ERROR', '已保存来源路径必须是绝对路径');
  const normalized = resolve(path);
  try { const info = lstatSync(normalized);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) || realpathSync(normalized) !== normalized) throw new Error();
    return normalized;
  } catch { throw new ContractError('STORAGE_UNAVAILABLE', '已保存来源路径必须是没有链接的普通文件或目录'); }
}
const within = (root: string, path: string) => path === root || path.startsWith(root + sep);

function registeredWorkspace(db: DatabaseSync, workspaceId: string) {
  const workspace = db.prepare('SELECT paths,mode FROM workspaces WHERE workspace_id=? AND id=?').get(workspaceId, workspaceId);
  if (!workspace) throw new ContractError('NOT_FOUND', '没有指定工作区');
  const paths = savedObject(String(workspace.paths));
  if (typeof paths.state_root !== 'string' || !isAbsolute(paths.state_root) || resolve(paths.state_root) !== paths.state_root) return fail('工作区缺少唯一已登记的 state 路径');
  return { state_root: paths.state_root, mode: String(workspace.mode) };
}
function accountRow(db: DatabaseSync, workspaceId: string, accountId: string) {
  const row = db.prepare('SELECT * FROM accounts WHERE workspace_id=? AND id=?').get(workspaceId, accountId);
  if (!row) throw new ContractError('NOT_FOUND', '对标账号不存在');
  if (row.role !== 'benchmark') throw new ContractError('VALIDATION_ERROR', '此入口只用于对标账号');
  if (!['x', 'douyin'].includes(String(row.platform))) throw new ContractError('CAPABILITY_UNSUPPORTED', '素材重解析目前支持 X 和抖音');
  if (row.identity_status !== 'confirmed' || !/^\d{1,30}$/.test(String(row.platform_account_id))) fail('先核对对标账号的唯一平台身份');
  assertAccountTarget(row.platform as BenchmarkPlatform, String(row.canonical_url), String(row.platform_account_id));
  return row;
}
function latestMaterialRows(db: DatabaseSync, workspaceId: string, accountId?: string) {
  const rows = db.prepare(`SELECT r.id,r.external_id,r.canonical_url,r.payload,r.author_account_id,r.updated_at,
    l.id AS location_id,l.kind,l.capture_time,l.sha256,l.parser_version,l.raw_response_ref,l.source_url,
    l.availability AS location_availability,l.updated_at AS location_updated_at,
    a.platform,a.platform_account_id,a.canonical_url AS account_url,a.role,a.identity_status,a.updated_at AS account_updated_at
    FROM source_records r JOIN source_locations l ON l.workspace_id=r.workspace_id AND l.record_id=r.id
    LEFT JOIN accounts a ON a.workspace_id=r.workspace_id AND a.id=r.author_account_id
    WHERE r.workspace_id=? AND l.kind IN ('tikhub_benchmark:x','tikhub_benchmark:douyin')
    ${accountId ? 'AND r.author_account_id=?' : ''}
    ORDER BY r.id,COALESCE(l.capture_time,l.created_at) DESC,l.created_at DESC,l.id DESC`).all(workspaceId, ...(accountId ? [accountId] : []));
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of rows) if (!latest.has(String(row.id))) latest.set(String(row.id), row);
  return [...latest.values()];
}
interface TrustedMaterial {
  record_id: string; source_location_id: string; account_id: string; external_id: string; job_id: string;
  before_payload: string; after_payload: string; before_payload_sha256: ReturnType<typeof sha256>; after_payload_sha256: ReturnType<typeof sha256>;
  raw_response_ref: RawResponseRef; previous_parser_version: string; payload: SourceRecordPayload;
  summary: ReturnType<typeof benchmarkMediaSummary>; changed: boolean; evidence_signature: string;
}
// 正式动作和副本 CLI 使用同一条可信来源链，读取根由模式决定。
function inspectTrustedMaterial(db: DatabaseSync, workspaceId: string, row: Record<string, unknown>, roots: { registered: string; readable: string; allow_internal_rule: boolean }): TrustedMaterial {
  if (row.role !== 'benchmark' || row.identity_status !== 'confirmed' || !['x', 'douyin'].includes(String(row.platform)) || row.kind !== 'tikhub_benchmark:' + row.platform) fail('来源账号身份不再匹配');
  if (row.location_availability !== 'available' || row.source_url !== row.canonical_url) fail('来源位置与当前作品不符');
  const ref = savedObject(String(row.raw_response_ref));
  if (typeof ref.path !== 'string' || !isAbsolute(ref.path) || ref.sha256 !== row.sha256 || !/^[a-f0-9]{64}$/.test(String(row.sha256)) || !/^benchmark-feed\/\d+$/.test(String(ref.adapter_version)) || !/^benchmark-feed\/\d+$/.test(String(row.parser_version))) fail('来源位置缺少可核对的 raw 引用');
  const rawRelative = relative(roots.registered, String(ref.path));
  if (!/^benchmark-runs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/response\.json$/.test(rawRelative) || resolve(roots.registered, rawRelative) !== ref.path) fail('raw 不在已登记的对标任务目录');
  const rawPath = join(roots.readable, rawRelative), jobId = rawRelative.split('/')[1]!, folder = dirname(rawPath);
  const job = db.prepare("SELECT input_manifest,input_hash,state FROM jobs WHERE workspace_id=? AND id=? AND kind='benchmark_sync' AND target_id=?").get(workspaceId, jobId, String(row.author_account_id));
  if (!job || job.state !== 'succeeded') return fail('来源缺少已完成的对标任务');
  const manifest = savedObject(String(job.input_manifest)), frozen = object(manifest.account);
  if (inputHash(manifest) !== job.input_hash || manifest.schema_version !== 'benchmark-sync/1' || manifest.mode !== 'none' || manifest.account_id !== row.author_account_id || !['latest_page', 'older_page'].includes(String(manifest.scope)) || manifest.scope === 'older_page' && (typeof manifest.cursor !== 'string' || !manifest.cursor) || frozen.platform !== row.platform || frozen.platform_account_id !== row.platform_account_id || frozen.canonical_url !== row.account_url || frozen.role !== 'benchmark' || frozen.identity_status !== 'confirmed') fail('任务冻结目标与来源账号不符');
  const source = typeof manifest.source_id === 'string' ? db.prepare("SELECT id FROM sources WHERE workspace_id=? AND id=? AND kind='tikhub_benchmark' AND external_id=? AND url=?").get(workspaceId, manifest.source_id, String(row.author_account_id), String(row.account_url)) : null;
  if (!source) fail('任务冻结资料源与来源账号不符');
  const fingerprint = sha256(JSON.stringify({ jobId, account: frozen, scope: manifest.scope, ...(typeof manifest.cursor === 'string' ? { cursor: manifest.cursor } : {}) }));
  const requestBytes = plainFile(join(folder, 'request.json'), 8192), resultBytes = plainFile(join(folder, 'result.json'), 8 * 1024 * 1024);
  const request = savedObject(requestBytes), result = savedObject(resultBytes), feed = object(result.feed);
  if (request.request_fingerprint !== fingerprint || request.account_id !== row.author_account_id || result.request_fingerprint !== fingerprint || typeof feed.raw_body !== 'string' || typeof feed.collected_at !== 'string' || !Number.isFinite(Date.parse(feed.collected_at)) || feed.collected_at !== row.capture_time) fail('平台回执与来源任务不符');
  const committed = db.prepare('SELECT value FROM application_metadata WHERE key=?').get(`benchmark-result.v1:${workspaceId}:${jobId}`);
  if (!committed) return fail('来源任务缺少落库回执');
  const stats = savedObject(String(committed.value)), statsRef = object(stats.raw_response_ref);
  if (stats.job_id !== jobId || statsRef.path !== ref.path || statsRef.sha256 !== row.sha256 || stats.last_success_at !== feed.collected_at) fail('落库回执与来源 raw 不符');
  const raw = plainFile(rawPath, 5 * 1024 * 1024);
  if (raw !== feed.raw_body || sha256(raw) !== row.sha256) throw new ContractError('IDEMPOTENCY_CONFLICT', 'raw 字节与平台回执或来源 hash 不符');
  const before = String(row.payload), stored = savedObject(before);
  const projection = projectSavedBenchmarkMaterials({ platform: row.platform as BenchmarkPlatform, account_url: String(row.account_url), platform_account_id: String(row.platform_account_id), raw_body: raw, raw_sha256: String(row.sha256), evidence_kind: feed.evidence_kind as SavedBenchmarkProjectionInput['evidence_kind'], allow_internal_rule: roots.allow_internal_rule, existing: [{ external_id: String(row.external_id), canonical_url: String(row.canonical_url), payload: readSourcePayload(row) }] })[0]!;
  // 未参与投影的历史字段原样留下，不因结构化读取的默认值被改写。
  const payload = { ...stored, media: projection.payload.media, provider_metadata: projection.payload.provider_metadata } as unknown as SourceRecordPayload;
  const changed = canonicalJson(stored) !== canonicalJson(payload), after = changed ? canonicalJson(payload) : before;
  const rawRef = { path: String(ref.path), sha256: row.sha256, adapter_version: String(ref.adapter_version) } as RawResponseRef;
  return { record_id: String(row.id), source_location_id: String(row.location_id), account_id: String(row.author_account_id), external_id: String(row.external_id), job_id: jobId, before_payload: before, after_payload: after, before_payload_sha256: sha256(before), after_payload_sha256: sha256(after), raw_response_ref: rawRef, previous_parser_version: String(row.parser_version), payload, summary: projection.summary, changed,
    evidence_signature: sha256(canonicalJson({ row, job, receipt: String(committed.value), request_sha256: sha256(requestBytes), result_sha256: sha256(resultBytes), raw_sha256: sha256(raw) })) };
}

export class BenchmarkMaterialReprojection {
  readonly context: ApplicationContext;
  constructor(context: ApplicationContext) { this.context = context; }
  // 测试子类可在事务边界模拟计划之后发生的并发变化。
  protected beforeCommit(): void {}
  refresh(request: RequestContext, accountId: string, input: BenchmarkMaterialReprojectionRequest = {}): BenchmarkMaterialReprojectionResponse {
    assertRequestIdentity(this.context, request); BenchmarkMaterialReprojectionSchema.parse(input);
    const db = this.context.db, operation = 'benchmark-material-reprojection:' + accountId;
    const replay = readIdempotent<BenchmarkMaterialReprojectionResponse>(db, request, operation, input); if (replay) return replay;
    const workspaceId = request.workspace_id;
    const plan = () => {
      accountRow(db, workspaceId, accountId);
      const workspace = registeredWorkspace(db, workspaceId), root = checkedPath(this.context.paths.state_root, true);
      if (workspace.state_root !== root) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '重解析只能读取主服务唯一已登记的 state');
      const roots = { registered: root, readable: root, allow_internal_rule: workspace.mode === 'demo' && this.context.config.mode === 'demo' };
      return { workspace, items: latestMaterialRows(db, workspaceId, accountId).map(row => inspectTrustedMaterial(db, workspaceId, row, roots)) };
    };
    const proposed = plan(); this.beforeCommit();
    return transaction(db, () => {
      const replay = readIdempotent<BenchmarkMaterialReprojectionResponse>(db, request, operation, input); if (replay) return replay;
      const current = plan();
      if (canonicalJson(current.workspace) !== canonicalJson(proposed.workspace) || current.items.length !== proposed.items.length || current.items.some((item, i) => item.evidence_signature !== proposed.items[i]!.evidence_signature || item.before_payload !== proposed.items[i]!.before_payload || item.before_payload_sha256 !== proposed.items[i]!.before_payload_sha256)) throw new ContractError('INPUT_STALE', '素材或已保存来源在计划后发生变化，请重新发起重解析');
      const projectionId = randomUUID(), at = new Date().toISOString();
      for (const item of proposed.items) {
        if (!item.changed) continue;
        const result = db.prepare('UPDATE source_records SET payload=?,updated_at=? WHERE workspace_id=? AND id=? AND payload=?').run(item.after_payload, at, workspaceId, item.record_id, item.before_payload);
        if (result.changes !== 1) throw new ContractError('INPUT_STALE', '素材正文已变化，本次重解析未提交');
      }
      // 回执中的 unchanged 与 changed hash 均核对事务内的实际最终字节。
      for (const item of proposed.items) {
        const row = db.prepare('SELECT payload FROM source_records WHERE workspace_id=? AND id=?').get(workspaceId, item.record_id);
        if (!row || row.payload !== item.after_payload || sha256(String(row.payload)) !== item.after_payload_sha256) throw new ContractError('INPUT_STALE', '素材在提交期间发生变化，本次重解析未提交');
      }
      const items = proposed.items.map(item => ({ record_id: item.record_id, source_location_id: item.source_location_id, job_id: item.job_id, before_payload_sha256: item.before_payload_sha256, after_payload_sha256: item.after_payload_sha256, raw_response_ref: item.raw_response_ref, media_type: item.summary.media_type ?? 'unknown', duration_ms: item.summary.duration_ms ?? null, preview_url: item.summary.preview_url ?? null }));
      const updated = proposed.items.filter(item => item.changed).length;
      const response: BenchmarkMaterialReprojectionResponse = { projection_id: projectionId, projection_version: BENCHMARK_FEED_VERSION, account_id: accountId, matched_count: items.length, updated_count: updated, unchanged_count: items.length - updated, items };
      db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?)').run(`benchmark-material-reprojection.v1:${workspaceId}:${projectionId}`, canonicalJson({ schema_version: 'benchmark-material-reprojection/1', workspace_id: workspaceId, request_id: request.request_id, idempotency_key: request.idempotency_key, created_at: at, ...response }));
      storeIdempotent(db, request, operation, input, response); return response;
    });
  }
}

export interface ProjectionCopyOptions { database_copy: string; state_copy: string; workspace_id: string; account_id?: string }
export function inspectBenchmarkMaterialCopy(options: ProjectionCopyOptions) {
  const databasePath = checkedPath(options.database_copy, false), copyRoot = checkedPath(options.state_copy, true);
  // 直接 readOnly 打开副本；不调用服务 bootstrap、迁移或默认配置解析。
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const workspace = registeredWorkspace(db, options.workspace_id), originalRoot = workspace.state_root;
    if (within(originalRoot, databasePath) || within(originalRoot, copyRoot) || within(copyRoot, originalRoot)) throw new ContractError('VALIDATION_ERROR', '需要独立数据库和 state 副本，不能使用已登记的日用 state');
    const rows = latestMaterialRows(db, options.workspace_id, options.account_id), proposals: Array<JsonObject> = [], failures: Array<JsonObject> = []; let unchanged = 0;
    for (const row of rows) {
      try {
        const projection = inspectTrustedMaterial(db, options.workspace_id, row, { registered: originalRoot, readable: copyRoot, allow_internal_rule: workspace.mode === 'demo' });
        if (!projection.changed) { unchanged++; continue; }
        proposals.push({ record_id: projection.record_id, source_location_id: projection.source_location_id, account_id: projection.account_id, external_id: projection.external_id, job_id: projection.job_id, before_payload_sha256: projection.before_payload_sha256, raw_response_ref: projection.raw_response_ref as unknown as JsonObject, previous_parser_version: projection.previous_parser_version, projection_parser_version: BENCHMARK_FEED_VERSION, payload: projection.payload as unknown as JsonObject, summary: projection.summary });
      } catch (error) { failures.push({ record_id: String(row.id), source_location_id: String(row.location_id), code: error instanceof ContractError ? error.code : 'STORAGE_UNAVAILABLE', message: error instanceof Error ? error.message : '已保存来源不可核对' }); }
    }
    return { schema_version: 'benchmark-material-projection/1', mode: 'proposal_only', workspace_id: options.workspace_id, selected: rows.length, unchanged, proposed: proposals.length, failed: failures.length, complete: failures.length === 0, remote_calls: 0, writes: 0, proposals, failures };
  } finally { db.close(); }
}

export function projectionCopyOptions(args: string[]): ProjectionCopyOptions {
  const allowed = new Set(['--database-copy', '--state-copy', '--workspace', '--account']), values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!, value = args[i + 1];
    if (!allowed.has(name) || !value || value.startsWith('--') || values.has(name)) throw new ContractError('VALIDATION_ERROR', '只接受 --database-copy、--state-copy、--workspace 和可选 --account；不提供写入模式');
    values.set(name, value);
  }
  if (!values.get('--database-copy') || !values.get('--state-copy') || !values.get('--workspace')) throw new ContractError('VALIDATION_ERROR', '需要显式 --database-copy、--state-copy 和 --workspace；默认不读取任何工作区');
  return { database_copy: values.get('--database-copy')!, state_copy: values.get('--state-copy')!, workspace_id: values.get('--workspace')!, ...(values.has('--account') ? { account_id: values.get('--account')! } : {}) };
}

export interface TrustedDouyinBenchmarkTarget {
  record_id: string; account_id: string; platform_account_id: string; aweme_id: string;
  canonical_url: string; account_url: string; source_location_id: string;
  source_raw_response_ref: RawResponseRef; source_signature: string;
}
// 统计刷新只读冻结目标；复用已有可信链，不改变正式重解析或副本 CLI。
export function readTrustedDouyinBenchmarkTargets(context: ApplicationContext): TrustedDouyinBenchmarkTarget[] {
  const workspaceId = context.identity.workspace_id, workspace = registeredWorkspace(context.db, workspaceId), root = checkedPath(context.paths.state_root, true);
  if (workspace.state_root !== root) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '统计刷新只能读取主服务唯一已登记的 state');
  const roots = { registered: root, readable: root, allow_internal_rule: workspace.mode === 'demo' && context.config.mode === 'demo' };
  return latestMaterialRows(context.db, workspaceId).filter(row => row.platform === 'douyin' && row.role === 'benchmark' && row.identity_status === 'confirmed').map(row => {
    accountRow(context.db, workspaceId, String(row.author_account_id));
    const checked = inspectTrustedMaterial(context.db, workspaceId, row, roots);
    return { record_id: checked.record_id, account_id: checked.account_id, platform_account_id: String(row.platform_account_id), aweme_id: checked.external_id, canonical_url: String(row.canonical_url), account_url: String(row.account_url), source_location_id: checked.source_location_id, source_raw_response_ref: checked.raw_response_ref, source_signature: checked.evidence_signature };
  }).sort((a, b) => a.account_id.localeCompare(b.account_id) || a.aweme_id.localeCompare(b.aweme_id));
}
