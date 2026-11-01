import { randomUUID } from 'node:crypto';
import { ContractError, type RequestContext, type Platform, type JsonObject, type JsonValue, type Page, type CollectionRequest, type AccountCollectionRequest, type JobsRow } from '@workbench/contracts';
import type { ApplicationContext } from '../ports/index.ts';
import { assertRequestIdentity } from '../documents/index.ts';
import { Jobs } from '../jobs/index.ts';
import { operatingPreferences } from '../settings/configuration.ts';
import { transaction, claimIdempotency, lookupIdempotency, commitIdempotency } from '@workbench/storage/connection';
import { canonicalWorkId, getWork } from '@workbench/storage/identity';
import { decodePageCursor, encodePageCursor } from '@workbench/storage/revisions';
import { getJob, getAttempt, fenceReason, queueJobInTransaction, type Clock, type ClaimedJob } from '@workbench/storage/jobs';
import { commitObservationInTransaction, ensureMetricsSourceInTransaction, listWorkSnapshots, listAccountSnapshots, MetricsRawFiles, type ObservationInput, type SnapshotView, type AccountSnapshotView } from '@workbench/storage/metrics';
import { TikHubAdapter, type CollectionIdentity, type CollectionDescriptor, type AdapterObservation } from '@workbench/adapters/tikhub';

export const METRIC_WINDOWS_H = [24, 72, 168] as const;
export interface MetricsOptions { adapter?: TikHubAdapter; clock?: Clock }
interface MetricsManifest extends JsonObject { schema_version: string; mode: 'none'; targets: JsonValue[]; source_ids: string[]; scope: 'work' | 'account'; source_target_id: string; identity: JsonObject; target_window: number | null; schedule_key: string | null }
export class Metrics {
  readonly context: ApplicationContext; readonly adapter: TikHubAdapter; readonly clock: Clock; readonly jobs: Jobs;
  constructor(context: ApplicationContext, options: MetricsOptions = {}) {
    this.context = context; this.clock = options.clock ?? Date.now; this.adapter = options.adapter ?? new TikHubAdapter({ clock: this.clock });
    if (this.adapter.fixture && context.config.mode !== 'demo') throw new ContractError('VALIDATION_ERROR', 'fixture adapter 仅能使用隔离 demo 工作区');
    this.jobs = new Jobs(context, { clock: this.clock, registrations: [{ kind: 'metrics_collect', execution_mode: 'programmatic', recovery: 'read_only' }] });
  }
  private request(key: string = randomUUID()): RequestContext { return { ...this.context.identity, request_id: randomUUID(), idempotency_key: key, request_identity_ref: 'metrics-worker' }; }
  identity(scope: 'work' | 'account', targetId: string): CollectionIdentity {
    const db = this.context.db, workspace = this.context.identity.workspace_id;
    const work = scope === 'work' ? getWork(db, workspace, canonicalWorkId(db, workspace, targetId)) : null;
    const accountId = work ? work.account_id : targetId;
    if (work && (work.identity_status !== 'confirmed' || !work.platform_work_id || !work.account_id)) throw new ContractError('CAPABILITY_UNVERIFIED', '待解析作品不能安排指标采集', { reason: 'work_identity_pending' });
    const account = accountId ? db.prepare('SELECT * FROM accounts WHERE workspace_id=? AND id=?').get(workspace, accountId) : null;
    if (!account || account.identity_status !== 'confirmed' || !account.platform_account_id || !['owner', 'benchmark'].includes(String(account.role))) throw new ContractError('CAPABILITY_UNVERIFIED', '作者身份尚未核对', { reason: 'account_identity_pending' });
    if (work && work.platform !== account.platform) throw new ContractError('VALIDATION_ERROR', '作品和账户平台不一致');
    return { target_id: work?.id ?? targetId, platform: account.platform as Platform, scope, platform_work_id: work?.platform_work_id ?? null, account_id: String(account.id), platform_account_id: String(account.platform_account_id), url: work?.url ?? null, published_at: work?.published_at ?? null, role: account.role as 'owner' | 'benchmark' };
  }
  collectWork(request: RequestContext, workId: string, input: CollectionRequest) { return this.enqueue(request, 'work', workId, input); }
  collectAccount(request: RequestContext, accountId: string, input: AccountCollectionRequest) { return this.enqueue(request, 'account', accountId, input); }
  private enqueue(request: RequestContext, scope: 'work' | 'account', targetId: string, input: CollectionRequest | AccountCollectionRequest) {
    assertRequestIdentity(this.context, request);
    if (input.connector !== undefined && input.connector !== 'tikhub') throw new ContractError('CAPABILITY_UNSUPPORTED', '指标 connector 未支持');
    const hours = 'target_window' in input ? input.target_window ?? null : null;
    if (hours !== null && !(METRIC_WINDOWS_H as readonly number[]).includes(hours)) throw new ContractError('VALIDATION_ERROR', '采集窗口无效');
    const identity = this.identity(scope, targetId), targetWindow = hours === null ? null : hours * 3600;
    const body = { scope, target_id: targetId, input };
    return transaction(this.context.db, () => {
      const old = request.idempotency_key ? lookupIdempotency(this.context.db, request.workspace_id, 'metrics.collection', request.idempotency_key, body) : null;
      if (old?.state === 'committed') return old.response as unknown as { job_id: string; state: string; target_window: number | null };
      const claim = claimIdempotency(this.context.db, request.workspace_id, 'metrics.collection', request.idempotency_key ?? '', body);
      const job = this.queueInTransaction(scope, targetId, identity, targetWindow, null, null);
      const result = { job_id: job.id, state: job.state, target_window: targetWindow }; commitIdempotency(this.context.db, request.workspace_id, claim.id, result); return result;
    });
  }
  private queueInTransaction(scope: 'work' | 'account', sourceId: string, identity: CollectionIdentity, window: number | null, dueAt: string | null, key: string | null) {
    const manifest: MetricsManifest = { schema_version: 'wp12-metrics-v1', mode: 'none', targets: [], source_ids: [], scope, source_target_id: sourceId, identity: identity as unknown as JsonObject, target_window: window, schedule_key: key };
    return queueJobInTransaction(this.context.db, this.context.identity.workspace_id, { kind: 'metrics_collect', target_id: sourceId, entrypoint: 'standalone_web', execution_mode: 'programmatic', input_manifest: manifest, retry_policy: { recovery: 'read_only', max_attempts: 3 }, presentation: 'background', due_at: dueAt }, this.clock());
  }
  private collectionReadiness(scope: 'work' | 'account', targetId: string): { ready: boolean; reason: string | null } {
    try { return this.adapter.checkReadiness(this.identity(scope, targetId)); }
    catch (error) {
      if (error instanceof ContractError && ['CAPABILITY_UNVERIFIED', 'NOT_FOUND'].includes(error.code)) return { ready: false, reason: typeof error.details.reason === 'string' ? error.details.reason : 'target_identity_unavailable' };
      throw error;
    }
  }
  private latestDueWindow(publishedAt: string, hours: readonly number[]): number | null {
    const elapsed = hours.filter(hour => Date.parse(publishedAt) + hour * 3600_000 <= this.clock());
    return elapsed.length ? Math.max(...elapsed) * 3600 : null;
  }
  private savedResponse(manifest: MetricsManifest, checkpoint: JsonObject): ObservationInput {
    const observation = checkpoint.response as unknown as ObservationInput, request = checkpoint.request as unknown as CollectionDescriptor, frozen = manifest.identity as unknown as CollectionIdentity;
    if (!observation || !request || !request.identity || ['target_id', 'platform', 'scope', 'platform_work_id', 'account_id', 'platform_account_id', 'url', 'published_at', 'role'].some(key => request.identity[key as keyof CollectionIdentity] !== frozen[key as keyof CollectionIdentity])
      || observation.target_id !== manifest.source_target_id || observation.target_window !== manifest.target_window || observation.platform !== frozen.platform || observation.scope !== frozen.scope || observation.platform_work_id !== frozen.platform_work_id || observation.account_id !== frozen.account_id || observation.published_at !== frozen.published_at
      || observation.collection_request_id !== request.collection_request_id || observation.request_fingerprint !== request.request_fingerprint) throw new ContractError('VALIDATION_ERROR', '已保存指标响应与固定任务归属不符');
    const raw = new MetricsRawFiles(this.context.paths.state_root);
    if (raw.path(request.collection_request_id) !== observation.raw_path) throw new ContractError('STORAGE_UNAVAILABLE', '已保存指标响应路径不符');
    const receipt = JSON.parse(raw.read(observation.raw_path, observation.raw_sha256));
    if (receipt.collection_request_id !== request.collection_request_id || receipt.request_fingerprint !== request.request_fingerprint || receipt.endpoint_key !== request.endpoint_key || receipt.collected_at !== observation.collected_at) throw new ContractError('STORAGE_UNAVAILABLE', '已保存指标原始回执归属不符');
    return observation;
  }
  automaticReadiness(job: Pick<JobsRow, 'input_manifest'>, checkpoint: JsonObject = {}): { ready: boolean; reason: string | null } {
    const manifest = JSON.parse(job.input_manifest) as MetricsManifest;
    // 手动请求仍按原路径处理；已收到 raw 的恢复只重放落库，不再采集。
    if (manifest.schema_version !== 'wp12-metrics-v1' || typeof manifest.schedule_key !== 'string') return { ready: true, reason: null };
    if (checkpoint.response) { try { this.savedResponse(manifest, checkpoint); return { ready: true, reason: null }; } catch { return { ready: false, reason: 'saved_response_invalid' }; } }
    const preferences = operatingPreferences(this.context.db, this.context.identity.workspace_id);
    if (!preferences.auto_observation) return { ready: false, reason: 'auto_observation_disabled' };
    const readiness = this.collectionReadiness(manifest.scope, manifest.source_target_id);
    if (!readiness.ready) return readiness;
    if (!preferences.observation_hours.some(hour => hour * 3600 === manifest.target_window)) return { ready: false, reason: 'observation_window_not_selected' };
    const publishedAt = (manifest.identity as unknown as CollectionIdentity).published_at;
    const latest = publishedAt ? this.latestDueWindow(publishedAt, preferences.observation_hours) : null;
    // 详情端点没有历史年龄参数，晚配置只能采当前窗口，不能补造更早窗口。
    if (latest !== null && manifest.target_window !== null && manifest.target_window < latest) return { ready: false, reason: 'observation_window_elapsed' };
    return { ready: true, reason: null };
  }
  scheduleWindows(): Array<{ work_id: string; target_window: number; due_at: string; job_id: string }> {
    const db = this.context.db, workspace = this.context.identity.workspace_id, output: Array<{ work_id: string; target_window: number; due_at: string; job_id: string }> = [];
    const preferences=operatingPreferences(db,workspace);if(!preferences.auto_observation)return output;
    const rows = db.prepare("SELECT id,published_at FROM works WHERE workspace_id=? AND canonical_work_id IS NULL AND identity_status='confirmed' AND published_at IS NOT NULL ORDER BY created_at,id").all(workspace);
    for (const row of rows) {
      let identity: CollectionIdentity; try { identity = this.identity('work', String(row.id)); } catch (error) { if (error instanceof ContractError && error.code === 'CAPABILITY_UNVERIFIED') continue; throw error; }
      if (!this.adapter.checkReadiness(identity).ready) continue;
      const published = Date.parse(String(row.published_at)); if (!Number.isFinite(published)) throw new ContractError('VALIDATION_ERROR', '作品发布时间无效');
      const latest = this.latestDueWindow(String(row.published_at), preferences.observation_hours);
      for (const hours of preferences.observation_hours) {
        const seconds = hours * 3600, dueAt = new Date(published + seconds * 1000).toISOString(), key = `${identity.target_id}:${String(row.published_at)}:${seconds}`;
        if (latest !== null && seconds < latest) continue;
        const id = transaction(db, () => {
          const existing = db.prepare("SELECT j.id,j.due_at,j.input_manifest,j.target_id FROM jobs j JOIN works w ON w.workspace_id=j.workspace_id AND w.id=j.target_id WHERE j.workspace_id=? AND j.kind='metrics_collect' AND (w.id=? OR w.canonical_work_id=?) ORDER BY j.created_at,j.id").all(workspace, identity.target_id, identity.target_id)
            .find(job => { const manifest = JSON.parse(String(job.input_manifest));
              return manifest.schema_version === 'wp12-metrics-v1' && manifest.scope === 'work' && typeof manifest.schedule_key === 'string'
                && manifest.schedule_key === `${String(job.target_id)}:${String(row.published_at)}:${seconds}` && manifest.target_window === seconds && manifest.identity?.published_at === row.published_at
                && Date.parse(String(job.due_at)) >= Date.parse(dueAt); });
          return existing ? String(existing.id) : this.queueInTransaction('work', identity.target_id, identity, seconds, dueAt, key).id;
        });
        output.push({ work_id: identity.target_id, target_window: seconds, due_at: dueAt, job_id: id });
      }
    }
    return output;
  }
  resumeDueRetries(): number {
    const rows = this.context.db.prepare("SELECT j.id,j.version,j.retry_policy,a.checkpoint,a.attempt_no FROM jobs j JOIN job_attempts a ON a.workspace_id=j.workspace_id AND a.job_id=j.id WHERE j.workspace_id=? AND j.kind='metrics_collect' AND j.state IN ('failed','waiting_quota') AND a.attempt_no=(SELECT MAX(b.attempt_no) FROM job_attempts b WHERE b.workspace_id=j.workspace_id AND b.job_id=j.id) ORDER BY j.created_at,j.id").all(this.context.identity.workspace_id);
    let count = 0;
    for (const row of rows) { const checkpoint = JSON.parse(String(row.checkpoint)), max = Number(JSON.parse(String(row.retry_policy)).max_attempts ?? 3);
      if (!checkpoint.retry_at || Date.parse(String(checkpoint.retry_at)) > this.clock() || Number(row.attempt_no) >= max) continue;
      if (!this.automaticReadiness(getJob(this.context.db, this.context.identity.workspace_id, String(row.id)), checkpoint).ready) continue;
      this.jobs.resume(this.request(`metrics-retry:${String(row.id)}:${row.version}`), String(row.id), { expected_version: Number(row.version) }); count++;
    }
    return count;
  }
  async executeCollection(input: { claim: ClaimedJob; signal: AbortSignal; checkpoint(value: JsonObject): void }): Promise<{ documents: []; recommendations: [] }> {
    const { claim } = input, manifest = JSON.parse(claim.job.input_manifest) as MetricsManifest;
    if (manifest.schema_version !== 'wp12-metrics-v1' || manifest.mode !== 'none' || !['work', 'account'].includes(manifest.scope) || manifest.source_target_id !== claim.job.target_id) throw new ContractError('VALIDATION_ERROR', '指标任务固定输入无效');
    const identity = this.identity(manifest.scope, manifest.source_target_id), frozen = manifest.identity as unknown as CollectionIdentity;
    if (identity.platform !== frozen.platform || identity.platform_work_id !== frozen.platform_work_id || identity.account_id !== frozen.account_id || identity.platform_account_id !== frozen.platform_account_id || identity.published_at !== frozen.published_at) throw new ContractError('INPUT_STALE', '采集身份或发布时间已变化');
    if (manifest.schedule_key !== null) {
      const expectedDue = frozen.published_at && manifest.target_window !== null ? Date.parse(frozen.published_at) + manifest.target_window * 1000 : NaN;
      if (manifest.schedule_key !== `${manifest.source_target_id}:${String(frozen.published_at)}:${manifest.target_window}` || !Number.isFinite(expectedDue) || !claim.job.due_at || Date.parse(claim.job.due_at) < expectedDue || this.clock() < expectedDue) throw new ContractError('INPUT_STALE', '持久窗口任务的计划时间不符');
    }
    const raw = new MetricsRawFiles(this.context.paths.state_root); let checkpoint = JSON.parse(claim.attempt.checkpoint) as JsonObject;
    let observation = checkpoint.response as unknown as ObservationInput | undefined;
    if (observation) observation = this.savedResponse(manifest, checkpoint);
    else {
      // 没有收到 raw 的旧尝试不能重用 collection_request_id 发第二次实际请求。
      const descriptor = this.adapter.prepare(identity, randomUUID()); checkpoint = { ...checkpoint, request: descriptor as unknown as JsonObject, request_started_at: new Date(this.clock()).toISOString(), response: null, retry_at: null }; input.checkpoint(checkpoint);
      const response = await this.adapter.collect(descriptor, input.signal), saved = raw.write(descriptor.collection_request_id, response.raw_body);
      observation = { ...response.observation, target_id: manifest.source_target_id, target_window: manifest.target_window, raw_path: saved.path, raw_sha256: saved.sha256 };
      checkpoint = { ...checkpoint, response: observation as unknown as JsonObject }; input.checkpoint(checkpoint);
    }
    const savedObservation = observation;
    const result = transaction(this.context.db, () => {
      const job = getJob(this.context.db, this.context.identity.workspace_id, claim.job.id), attempt = getAttempt(this.context.db, this.context.identity.workspace_id, claim.attempt.id);
      const reason = fenceReason(job, attempt, claim.fence, this.clock());
      if (reason || attempt.lease_owner !== claim.fence.lease_owner) throw new ContractError('HOST_RUN_NOT_CURRENT', '指标执行 lease 已失效', { reason: reason ?? 'owner_mismatch' });
      const source = ensureMetricsSourceInTransaction(this.context.db, this.context.identity.workspace_id);
      return commitObservationInTransaction(this.context.db, this.context.identity.workspace_id, source, savedObservation);
    });
    if (savedObservation.failure) {
      const retryable = ['provider_rate_limited', 'network_error', 'request_timeout', 'provider_http_error', 'provider_application_error', 'provider_fetch_unsuccessful'].includes(savedObservation.failure);
      const seconds = savedObservation.retry_after_s ?? 30 * 2 ** (claim.attempt.attempt_no - 1), retryAt = retryable ? new Date(this.clock() + seconds * 1000).toISOString() : null;
      checkpoint = { ...checkpoint, response: null, last_snapshot_id: result.snapshot_id, last_failure: savedObservation.failure, retry_at: retryAt }; input.checkpoint(checkpoint);
      if (retryAt) transaction(this.context.db, () => this.context.db.prepare('UPDATE jobs SET due_at=? WHERE workspace_id=? AND id=?').run(retryAt, this.context.identity.workspace_id, claim.job.id));
      throw new ContractError(savedObservation.failure === 'provider_rate_limited' ? 'QUOTA_EXHAUSTED' : savedObservation.failure === 'provider_permission_denied' ? 'AUTH_REQUIRED' : 'CAPABILITY_UNVERIFIED', '指标采集未完成', { reason: savedObservation.failure, snapshot_id: result.snapshot_id, retry_at: retryAt }, retryable);
    }
    input.checkpoint({ ...checkpoint, snapshot_id: result.snapshot_id, replay: result.replay, retry_at: null }); return { documents: [], recommendations: [] };
  }
  workSnapshots(request: RequestContext, id: string, filter: { metric_keys?: string[]; window?: number; cursor?: string; limit?: number } = {}): Page<SnapshotView> {
    assertRequestIdentity(this.context, request); let rows = listWorkSnapshots(this.context.db, request.workspace_id, id);
    if (filter.window !== undefined) rows = rows.filter(row => row.target_window === filter.window! * 3600);
    if (filter.metric_keys?.length) rows = rows.map(row => ({ ...row, metrics: row.metrics.filter(metric => filter.metric_keys!.includes(metric.key)) }));
    return this.page(rows, filter);
  }
  accountSnapshots(request: RequestContext, id: string, filter: { cursor?: string; limit?: number } = {}): Page<AccountSnapshotView> { assertRequestIdentity(this.context, request); return this.page(listAccountSnapshots(this.context.db, request.workspace_id, id), filter); }
  private page<T extends { id: string; created_at: string }>(rows: T[], filter: { cursor?: string; limit?: number }): Page<T> {
    const limit = filter.limit ?? 50; if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ContractError('VALIDATION_ERROR', '快照分页参数无效');
    const [at, id] = decodePageCursor(filter.cursor); rows = rows.filter(row => !at || row.created_at > at || (row.created_at === at && row.id > id)).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const items = rows.slice(0, limit), last = items.at(-1); return { items, next_cursor: rows.length > limit && last ? encodePageCursor(last) : null, has_more: rows.length > limit, last_success_at: rows.at(-1)?.created_at ?? null };
  }
  readiness() {
    const db = this.context.db, workspace = this.context.identity.workspace_id, preferences = operatingPreferences(db, workspace);
    const targets = this.adapter.targets.map(target => this.collectionReadiness(target.scope, target.target_id));
    const works = db.prepare("SELECT id FROM works WHERE workspace_id=? AND canonical_work_id IS NULL AND identity_status='confirmed' AND published_at IS NOT NULL").all(workspace);
    const blockedReasons: Record<string, number> = {}, queuedBlockedReasons: Record<string, number> = {}; let readyWorks = 0, queuedReady = 0;
    for (const work of works) { const readiness = this.collectionReadiness('work', String(work.id)); if (readiness.ready) readyWorks++; else blockedReasons[readiness.reason!] = (blockedReasons[readiness.reason!] ?? 0) + 1; }
    const queued = db.prepare("SELECT j.input_manifest,(SELECT a.checkpoint FROM job_attempts a WHERE a.workspace_id=j.workspace_id AND a.job_id=j.id ORDER BY a.attempt_no DESC LIMIT 1) AS checkpoint FROM jobs j WHERE j.workspace_id=? AND j.kind='metrics_collect' AND j.state='queued'").all(workspace);
    let automaticQueued = 0;
    for (const job of queued) {
      if (typeof JSON.parse(String(job.input_manifest)).schedule_key !== 'string') continue;
      automaticQueued++; const readiness = this.automaticReadiness({ input_manifest: String(job.input_manifest) }, job.checkpoint ? JSON.parse(String(job.checkpoint)) : {});
      if (readiness.ready) queuedReady++; else queuedBlockedReasons[readiness.reason!] = (queuedBlockedReasons[readiness.reason!] ?? 0) + 1;
    }
    const credentialPresent = this.adapter.credentialPresent(), readyTargets = targets.filter(target => target.ready).length;
    return { credential_present: credentialPresent, selected_verified_targets: this.adapter.targets.length, ready_targets: readyTargets, real_platform: 'unverified',
      reason: !credentialPresent ? 'missing_config' : !this.adapter.targets.length ? 'missing_selected_verified_target' : readyTargets ? null : targets.find(target => !target.ready)?.reason ?? 'missing_selected_verified_target',
      auto_observation: { enabled: preferences.auto_observation, candidate_works: works.length, ready_works: readyWorks, blocked_works: works.length - readyWorks, blocked_reasons: blockedReasons, queued: automaticQueued, queued_ready: queuedReady, queued_blocked: automaticQueued - queuedReady, queued_blocked_reasons: queuedBlockedReasons } };
  }
}
