import { randomUUID } from 'node:crypto';
import { ContractError, type Platform, type MetricAvailability, type MetricDefinitionsRow, type SnapshotsRow, type AccountSnapshotsRow, type JsonObject, type WorksRow, type MetricView, type SnapshotView, type AccountSnapshotView } from '@workbench/contracts';
import { type DatabaseSync, canonicalJson } from '../connection/index.ts';
import { canonicalWorkId, getWork } from '../identity/index.ts';
export { MetricsRawFiles } from './raw-files.ts';
export type { MetricView, SnapshotView, AccountSnapshotView } from '@workbench/contracts';

export interface DefinitionInput { id?: string; platform: Platform; key: string; raw_field: string; unit: string; kind: string; denominator_key?: string | null; visibility: string; definition_version: string; scope: 'work' | 'account' }
export interface ReadingInput { definition: DefinitionInput; value: string | null; availability: MetricAvailability; reason: string | null }
export interface ObservationInput {
  platform: Platform; scope: 'work' | 'account'; target_id: string; platform_work_id: string | null; account_id: string;
  collection_request_id: string; request_fingerprint: string; observed_at: string | null; observed_time_basis: 'provider' | 'collector_verified' | 'unknown'; observed_time_reason: string | null;
  observation_evidence_ref: string | null; collected_at: string; published_at: string | null; target_window: number | null; raw_path: string; raw_sha256: string; adapter_version: string;
  metrics: ReadingInput[]; failure: string | null; retry_after_s: number | null; evidence_kind: 'internal_rule' | 'real_platform'; supersedes_snapshot_id?: string | null;
}
export interface SnapshotInput extends SnapshotView { work: WorksRow }
function required(value: string, label: string): void { if (!value || typeof value !== 'string') throw new ContractError('VALIDATION_ERROR', `${label}不能为空`); }
export function validateReading(reading: ReadingInput): void {
  const def = reading.definition;
  for (const field of ['key', 'raw_field', 'unit', 'kind', 'visibility', 'definition_version'] as const) required(def[field], field);
  if (!['work', 'account'].includes(def.scope)) throw new ContractError('VALIDATION_ERROR', '指标定义 scope 无效');
  if (!['available', 'not_collected', 'unavailable', 'unsupported', 'invalid'].includes(reading.availability)) throw new ContractError('VALIDATION_ERROR', '指标可用性无效');
  if (reading.availability === 'available') {
    if (typeof reading.value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(reading.value) || (def.unit === 'count' && !/^(?:0|[1-9]\d*)$/.test(reading.value))) throw new ContractError('VALIDATION_ERROR', '指标不是合法非负数值字符串');
  } else if (reading.value !== null || !reading.reason) throw new ContractError('VALIDATION_ERROR', '缺失指标必须保留 null 和原因');
}
export function observedAge(input: Pick<ObservationInput, 'observed_at' | 'observed_time_basis' | 'observed_time_reason' | 'published_at' | 'observation_evidence_ref' | 'collected_at'>): number | null {
  if (!Number.isFinite(Date.parse(input.collected_at))) throw new ContractError('VALIDATION_ERROR', '采集时间无效');
  if (input.observed_time_basis === 'unknown') {
    if (input.observed_at !== null || !input.observed_time_reason) throw new ContractError('VALIDATION_ERROR', '未知观察时间必须为 null 并给原因'); return null;
  }
  if (!input.observed_at || !Number.isFinite(Date.parse(input.observed_at)) || !input.observation_evidence_ref) throw new ContractError('VALIDATION_ERROR', '已知观察时间须有时点和端点语义依据');
  if (Date.parse(input.observed_at) > Date.parse(input.collected_at)) throw new ContractError('VALIDATION_ERROR', '观察时间晚于本地收到时间');
  if (!input.published_at) return null;
  const age = (Date.parse(input.observed_at) - Date.parse(input.published_at)) / 1000;
  if (!Number.isFinite(age) || age < 0) throw new ContractError('VALIDATION_ERROR', '实际作品年龄无效'); return Math.floor(age);
}
function definitionInTransaction(db: DatabaseSync, workspaceId: string, input: DefinitionInput): string {
  const expected = { platform: input.platform, key: input.key, raw_field: input.raw_field, unit: input.unit, kind: input.kind, denominator_key: input.denominator_key ?? null, visibility: input.visibility, definition_version: input.definition_version, scope: input.scope };
  const row = input.id ? db.prepare('SELECT * FROM metric_definitions WHERE workspace_id=? AND id=?').get(workspaceId, input.id)
    : db.prepare('SELECT * FROM metric_definitions WHERE workspace_id=? AND platform=? AND key=? AND scope=? AND definition_version=? ORDER BY id LIMIT 1').get(workspaceId, input.platform, input.key, input.scope, input.definition_version);
  if (row) { for (const [key, value] of Object.entries(expected)) if (row[key] !== value) throw new ContractError('VALIDATION_ERROR', '相同指标定义版本的口径冲突'); return String(row.id); }
  const id = input.id ?? randomUUID();
  db.prepare('INSERT INTO metric_definitions(id,workspace_id,platform,key,raw_field,unit,kind,denominator_key,visibility,definition_version,scope) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, workspaceId, expected.platform, expected.key, expected.raw_field, expected.unit, expected.kind, expected.denominator_key, expected.visibility, expected.definition_version, expected.scope);
  return id;
}
function validateObservation(input: ObservationInput): number | null {
  required(input.collection_request_id, 'collection_request_id'); required(input.request_fingerprint, 'request_fingerprint'); required(input.raw_path, 'raw_path'); required(input.adapter_version, 'adapter_version');
  if (!/^[0-9a-f]{64}$/.test(input.raw_sha256) || !/^[0-9a-f]{64}$/.test(input.request_fingerprint)) throw new ContractError('VALIDATION_ERROR', '响应或请求 hash 无效');
  if (input.metrics.length > 64 || new Set(input.metrics.map(reading => reading.definition.key)).size !== input.metrics.length) throw new ContractError('VALIDATION_ERROR', '指标定义重复或过多');
  for (const metric of input.metrics) { validateReading(metric); if (metric.definition.platform !== input.platform || metric.definition.scope !== input.scope) throw new ContractError('VALIDATION_ERROR', '指标定义与平台或 scope 不符'); }
  return observedAge(input);
}
export function ensureMetricsSourceInTransaction(db: DatabaseSync, workspaceId: string): string {
  if (!db.isTransaction) throw new Error('metrics source requires transaction');
  const old = db.prepare("SELECT id FROM sources WHERE workspace_id=? AND kind='metrics' AND external_id='tikhub' ORDER BY id LIMIT 1").get(workspaceId);
  if (old) return String(old.id); const id = randomUUID();
  db.prepare("INSERT INTO sources(id,workspace_id,kind,external_id,url,schema_version) VALUES (?,?,'metrics','tikhub',?,'wp12-observation-v1')").run(id, workspaceId, 'https://api.tikhub.io'); return id;
}
function lineage(db: DatabaseSync, workspaceId: string, ownerType: string, id: string): JsonObject {
  const row = db.prepare('SELECT locator FROM evidence_links WHERE workspace_id=? AND owner_type=? AND owner_id=? ORDER BY created_at,id LIMIT 1').get(workspaceId, ownerType, id);
  return row?.locator ? JSON.parse(String(row.locator)) as JsonObject : {};
}
export function commitObservationInTransaction(db: DatabaseSync, workspaceId: string, sourceId: string, input: ObservationInput): { snapshot_id: string; replay: boolean } {
  if (!db.isTransaction) throw new Error('snapshot commit requires fenced transaction'); const age = validateObservation(input);
  const source = db.prepare('SELECT kind,external_id FROM sources WHERE workspace_id=? AND id=?').get(workspaceId, sourceId);
  if (!source || source.kind !== 'metrics' || source.external_id !== 'tikhub') throw new ContractError('VALIDATION_ERROR', '快照来源不符');
  const old = input.scope === 'work' ? db.prepare('SELECT id,work_id,request_fingerprint,raw_sha256 FROM snapshots WHERE workspace_id=? AND source_id=? AND collection_request_id=? ORDER BY id').get(workspaceId, sourceId, input.collection_request_id)
    : db.prepare('SELECT id,account_id FROM account_snapshots WHERE workspace_id=? AND id=?').get(workspaceId, input.collection_request_id);
  if (old) {
    const saved = input.scope === 'work' ? old : lineage(db, workspaceId, 'account_snapshot', String(old.id));
    if (saved.request_fingerprint !== input.request_fingerprint || saved.raw_sha256 !== input.raw_sha256 || (old.work_id ?? old.account_id) !== input.target_id) throw new ContractError('IDEMPOTENCY_CONFLICT', '同一实际请求的响应或归属变化');
    return { snapshot_id: String(old.id), replay: true };
  }
  const id = input.scope === 'work' ? randomUUID() : input.collection_request_id;
  if (input.scope === 'work') {
    const work = getWork(db, workspaceId, input.target_id), canonical = getWork(db, workspaceId, canonicalWorkId(db, workspaceId, input.target_id));
    if (canonical.platform !== input.platform || canonical.account_id !== input.account_id || canonical.platform_work_id !== input.platform_work_id || canonical.identity_status !== 'confirmed') throw new ContractError('VALIDATION_ERROR', '作品快照身份与已确认作品不符');
    if (input.supersedes_snapshot_id) { const previous = db.prepare('SELECT work_id FROM snapshots WHERE workspace_id=? AND id=?').get(workspaceId, input.supersedes_snapshot_id); if (!previous || canonicalWorkId(db, workspaceId, String(previous.work_id)) !== canonical.id) throw new ContractError('VALIDATION_ERROR', '修正快照不属于同一作品'); }
    db.prepare('INSERT INTO snapshots(id,workspace_id,work_id,source_id,collection_request_id,request_fingerprint,observed_at,observed_time_basis,observed_time_reason,collected_at,target_window,observed_age_s,raw_path,raw_sha256,adapter_version,supersedes_snapshot_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, workspaceId, work.id, sourceId, input.collection_request_id, input.request_fingerprint, input.observed_at, input.observed_time_basis, input.observed_time_reason, input.collected_at, input.target_window, age, input.raw_path, input.raw_sha256, input.adapter_version, input.supersedes_snapshot_id ?? null);
  } else {
    const account = db.prepare('SELECT platform,identity_status FROM accounts WHERE workspace_id=? AND id=?').get(workspaceId, input.target_id);
    if (!account || account.platform !== input.platform || account.identity_status !== 'confirmed' || input.account_id !== input.target_id) throw new ContractError('VALIDATION_ERROR', '账户快照身份不符');
    db.prepare('INSERT INTO account_snapshots(id,workspace_id,account_id,observed_at,observed_time_basis,observed_time_reason,collected_at,raw_path,adapter_version) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, workspaceId, input.target_id, input.observed_at, input.observed_time_basis, input.observed_time_reason, input.collected_at, input.raw_path, input.adapter_version);
  }
  for (const metric of input.metrics) {
    const definitionId = definitionInTransaction(db, workspaceId, metric.definition);
    const table = input.scope === 'work' ? 'metric_values' : 'account_metric_values', foreign = input.scope === 'work' ? 'snapshot_id' : 'account_snapshot_id';
    db.prepare(`INSERT INTO ${table}(id,workspace_id,${foreign},definition_id,value,availability,reason) VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), workspaceId, id, definitionId, metric.value, metric.availability, metric.reason);
  }
  const metadata: JsonObject = { source_id: sourceId, collection_request_id: input.collection_request_id, request_fingerprint: input.request_fingerprint, raw_sha256: input.raw_sha256, published_at: input.published_at, observation_evidence_ref: input.observation_evidence_ref, evidence_kind: input.evidence_kind, failure: input.failure, scope: input.scope };
  db.prepare('INSERT INTO evidence_links(id,workspace_id,owner_type,owner_id,source_type,source_id,locator,quote_hash) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(), workspaceId, input.scope === 'work' ? 'snapshot' : 'account_snapshot', id, 'source', sourceId, canonicalJson(metadata), input.raw_sha256);
  return { snapshot_id: id, replay: false };
}
function values(db: DatabaseSync, workspaceId: string, id: string, scope: 'work' | 'account'): MetricView[] {
  const table = scope === 'work' ? 'metric_values' : 'account_metric_values', field = scope === 'work' ? 'snapshot_id' : 'account_snapshot_id';
  return db.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND ${field}=? ORDER BY definition_id`).all(workspaceId, id).map(row => {
    const definition = db.prepare('SELECT * FROM metric_definitions WHERE workspace_id=? AND id=?').get(workspaceId, row.definition_id!);
    if (!definition) throw new ContractError('STORAGE_UNAVAILABLE', '快照指标定义丢失');
    return { id: String(row.id), key: String(definition.key), value: row.value as string | null, availability: row.availability as MetricAvailability, reason: row.reason as string | null, definition: definition as unknown as MetricDefinitionsRow };
  });
}
export function listWorkSnapshots(db: DatabaseSync, workspaceId: string, workId: string): SnapshotView[] {
  const canonical = canonicalWorkId(db, workspaceId, workId);
  const snapshots = db.prepare('SELECT s.* FROM snapshots s JOIN works w ON w.workspace_id=s.workspace_id AND w.id=s.work_id WHERE s.workspace_id=? AND (w.id=? OR w.canonical_work_id=?) ORDER BY s.collected_at,s.id').all(workspaceId, canonical, canonical) as unknown as SnapshotsRow[];
  return snapshots.map(row => { const meta = lineage(db, workspaceId, 'snapshot', row.id); return { ...row, source_work_id: row.work_id, canonical_work_id: canonical,
    published_at: typeof meta.published_at === 'string' ? meta.published_at : null, evidence_kind: typeof meta.evidence_kind === 'string' ? meta.evidence_kind : 'unverified',
    identity_mapping: { source_work_id: row.work_id, canonical_work_id: canonical, aliases: db.prepare('SELECT alias_work_id,canonical_work_id,source_url,resolution_evidence FROM work_aliases WHERE workspace_id=? AND canonical_work_id=? ORDER BY id').all(workspaceId, canonical) as unknown as JsonObject[] }, metrics: values(db, workspaceId, row.id, 'work') }; });
}
export function listSnapshotInputs(db: DatabaseSync, workspaceId: string, filter: { platform?: Platform; account_id?: string } = {}): SnapshotInput[] {
  const works = db.prepare('SELECT * FROM works WHERE workspace_id=? AND canonical_work_id IS NULL AND (? IS NULL OR platform=?) AND (? IS NULL OR account_id=?) ORDER BY created_at,id')
    .all(workspaceId, filter.platform ?? null, filter.platform ?? null, filter.account_id ?? null, filter.account_id ?? null) as unknown as WorksRow[];
  return works.flatMap(work => listWorkSnapshots(db, workspaceId, work.id).map(snapshot => ({ ...snapshot, work })));
}
export function listAccountSnapshots(db: DatabaseSync, workspaceId: string, accountId: string): AccountSnapshotView[] {
  if (!db.prepare('SELECT id FROM accounts WHERE workspace_id=? AND id=?').get(workspaceId, accountId)) throw new ContractError('NOT_FOUND', '账户不存在');
  return (db.prepare('SELECT * FROM account_snapshots WHERE workspace_id=? AND account_id=? ORDER BY collected_at,id').all(workspaceId, accountId) as unknown as AccountSnapshotsRow[]).map(row => {
    const meta = lineage(db, workspaceId, 'account_snapshot', row.id); return { ...row, source_id: String(meta.source_id ?? ''), collection_request_id: String(meta.collection_request_id ?? ''), request_fingerprint: String(meta.request_fingerprint ?? ''), raw_sha256: String(meta.raw_sha256 ?? ''), evidence_kind: String(meta.evidence_kind ?? 'unverified'), metrics: values(db, workspaceId, row.id, 'account') };
  });
}
