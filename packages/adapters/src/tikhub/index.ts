import { createHash } from 'node:crypto';
import { ContractError, PLATFORMS, type Platform, type JsonObject, type MetricAvailability, type CapabilityDescription } from '@workbench/contracts';
import {resolveOtherAccount,discoverAccount} from './accounts.ts';
import {fetchBenchmarkFeed} from './benchmark-feed.ts';

export const TIKHUB_ADAPTER_VERSION = 'wp12-tikhub/0.1.0';
export const ENDPOINTS = {
  xiaohongshu_image: { platform: 'xiaohongshu', scope: 'work', method: 'GET', path: '/api/v1/xiaohongshu/app_v2/get_image_note_detail', params: ['note_id', 'share_text'], identity: 'note_id' },
  xiaohongshu_video: { platform: 'xiaohongshu', scope: 'work', method: 'GET', path: '/api/v1/xiaohongshu/app_v2/get_video_note_detail', params: ['note_id', 'share_text'], identity: 'note_id' },
  xiaohongshu_account: { platform: 'xiaohongshu', scope: 'account', method: 'GET', path: '/api/v1/xiaohongshu/app_v2/get_user_info', params: ['user_id', 'share_text'], identity: 'user_id' },
  wechat_article: { platform: 'wechat', scope: 'work', method: 'POST', path: '/api/v1/wechat_mp/v2/fetch_article_stats', params: ['url', 'raw'], identity: 'url' },
  wechat_article_h5: { platform: 'wechat', scope: 'work', method: 'POST', path: '/api/v1/wechat_mp/v2/fetch_article_stats_h5', params: ['url', 'raw', 'comment_id'], identity: 'url' },
  wechat_account: { platform: 'wechat', scope: 'account', method: 'POST', path: '/api/v1/wechat_mp/v2/fetch_account_profile', params: ['username', 'raw'], identity: 'username' },
  x_post: { platform: 'x', scope: 'work', method: 'GET', path: '/api/v1/twitter/web/fetch_tweet_detail', params: ['tweet_id'], identity: 'tweet_id' },
  x_account: { platform: 'x', scope: 'account', method: 'GET', path: '/api/v1/twitter/web/fetch_user_profile', params: ['screen_name', 'rest_id'], identity: 'rest_id' },
  douyin_video: { platform: 'douyin', scope: 'work', method: 'GET', path: '/api/v1/douyin/web/fetch_one_video', params: ['aweme_id', 'need_anchor_info'], identity: 'aweme_id' },
  douyin_account: { platform: 'douyin', scope: 'account', method: 'GET', path: '/api/v1/douyin/web/fetch_user_profile_by_uid', params: ['uid'], identity: 'uid' },
  bilibili_video: { platform: 'bilibili', scope: 'work', method: 'GET', path: '/api/v1/bilibili/web/fetch_one_video', params: ['bv_id'], identity: 'bv_id' },
  bilibili_account: { platform: 'bilibili', scope: 'account', method: 'GET', path: '/api/v1/bilibili/web/fetch_user_profile', params: ['uid'], identity: 'uid' },
} as const;
export type EndpointKey = keyof typeof ENDPOINTS;
export interface MetricMapping { key: string; path: string | null; unit: string; kind: string; definition_version: string; denominator_key?: string | null; visibility: string; unsupported?: boolean; mapping_evidence_ref: string | null }
export interface VerifiedTarget {
  target_id: string; platform: Platform; scope: 'work' | 'account'; platform_work_id: string | null; platform_account_id: string; url: string | null;
  identity_evidence_ref: string; endpoint_key: EndpointKey; params: Record<string, string | boolean>; metrics: MetricMapping[];
  observation: { basis: 'unknown' | 'provider' | 'collector_verified'; path?: string; evidence_ref: string | null };
}
export interface CollectionIdentity { target_id: string; platform: Platform; scope: 'work' | 'account'; platform_work_id: string | null; account_id: string; platform_account_id: string; url: string | null; published_at: string | null; role: 'owner' | 'benchmark' }
export interface CollectionDescriptor { collection_request_id: string; request_fingerprint: string; endpoint_key: EndpointKey; identity: CollectionIdentity }
export interface AdapterReading { definition: { platform: Platform; key: string; raw_field: string; unit: string; kind: string; denominator_key: string | null; visibility: string; definition_version: string; scope: 'work' | 'account' }; value: string | null; availability: MetricAvailability; reason: string | null }
export interface AdapterObservation { collection_request_id: string; request_fingerprint: string; platform: Platform; scope: 'work' | 'account'; target_id: string; platform_work_id: string | null; account_id: string; observed_at: string | null; observed_time_basis: 'provider' | 'collector_verified' | 'unknown'; observed_time_reason: string | null; observation_evidence_ref: string | null; collected_at: string; published_at: string | null; adapter_version: string; metrics: AdapterReading[]; failure: string | null; retry_after_s: number | null; evidence_kind: 'internal_rule' | 'real_platform' }
export interface AdapterResponse { observation: AdapterObservation; raw_body: string }
export interface TikHubOptions { targets?: VerifiedTarget[]; token_env?: string; token_provider?: () => string | null; fetcher?: typeof fetch; clock?: () => number; fixture?: boolean; timeout_ms?: number }
export interface ResolvedAccount { platform: Platform; platform_account_id: string; canonical_url: string; checked_at: string; raw_body: string; evidence_kind: 'internal_rule' | 'real_platform';display_id?:string;display_name?:string;endpoint_url?:string }
function canonical(value: unknown): string { if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'; if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'; return JSON.stringify(value); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function valueAt(payload: unknown, path: string): { exists: boolean; value: unknown } {
  let value = payload;
  for (const key of path.split('.')) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return { exists: false, value: undefined }; value = (value as Record<string, unknown>)[key]; }
  return { exists: true, value };
}
export function normalizeMetric(payload: unknown, mapping: MetricMapping, platform: Platform, scope: 'work' | 'account', failure: string | null = null): AdapterReading {
  const base: AdapterReading = { definition: { platform, scope, key: mapping.key, raw_field: mapping.path ?? 'unverified:' + mapping.key, unit: mapping.unit, kind: mapping.kind, denominator_key: mapping.denominator_key ?? null, visibility: mapping.visibility, definition_version: mapping.definition_version }, value: null, availability: 'not_collected', reason: 'mapping_unverified' };
  if (mapping.unsupported) return { ...base, availability: 'unsupported', reason: 'endpoint_field_unsupported' };
  if (failure) return { ...base, availability: 'unavailable', reason: failure };
  if (!mapping.path || !mapping.mapping_evidence_ref) return base;
  const reading = valueAt(payload, mapping.path);
  if (!reading.exists || reading.value === null) return { ...base, availability: 'unavailable', reason: reading.exists ? 'provider_null' : 'missing_field' };
  const raw = reading.value;
  if ((typeof raw !== 'number' && typeof raw !== 'string') || (typeof raw === 'number' && (!Number.isFinite(raw) || (mapping.unit === 'count' && !Number.isSafeInteger(raw))))) return { ...base, availability: 'invalid', reason: 'invalid_numeric_value' };
  const value = String(raw);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || (mapping.unit === 'count' && !/^(?:0|[1-9]\d*)$/.test(value))) return { ...base, availability: 'invalid', reason: 'invalid_numeric_value' };
  return { ...base, value, availability: 'available', reason: null };
}
export class TikHubAdapter {
  private readonly tokenProvider: () => string | null;
  readonly targets: readonly VerifiedTarget[]; readonly tokenEnv: string; readonly fetcher: typeof fetch; readonly clock: () => number; readonly fixture: boolean; readonly timeoutMs: number;
  constructor(options: TikHubOptions = {}) {
    this.targets = options.targets ?? []; this.tokenEnv = options.token_env ?? 'TIKHUB_API_KEY'; this.fetcher = options.fetcher ?? fetch; this.clock = options.clock ?? Date.now; this.fixture = options.fixture ?? false;
    this.tokenProvider = options.token_provider ?? (() => process.env[this.tokenEnv]?.trim() || null);
    this.timeoutMs = options.timeout_ms ?? 30_000; if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new ContractError('VALIDATION_ERROR', '采集超时范围无效');
    if (!/^[A-Z_][A-Z0-9_]*$/.test(this.tokenEnv)) throw new ContractError('VALIDATION_ERROR', '凭据只能使用环境变量引用');
    if (new Set(this.targets.map(target => `${target.scope}:${target.target_id}`)).size !== this.targets.length) throw new ContractError('VALIDATION_ERROR', '采集目标重复');
    for (const target of this.targets) this.validateTarget(target);
  }
  credentialPresent(): boolean { return !!this.tokenProvider(); }
  async resolveAccount(url: string): Promise<ResolvedAccount> {
    if(!['x.com','twitter.com','www.x.com','www.twitter.com'].includes(new URL(url).hostname))return resolveOtherAccount(url,this.accountOptions());
    const parsed = new URL(url), match = parsed.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (parsed.protocol !== 'https:' || !['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || !match || ['home', 'explore', 'i', 'settings', 'search', 'intent'].includes(match[1]!.toLowerCase())) throw new ContractError('CAPABILITY_UNSUPPORTED', '当前只支持核对明确的 X 用户主页');
    const token = this.tokenProvider(); if (!token) throw new ContractError('AUTH_REQUIRED', '请先配置 TikHub 密钥');
    let response: Response;
    try { response = await this.fetcher('https://api.tikhub.io' + ENDPOINTS.x_account.path + '?screen_name=' + match[1], { method: 'GET', headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) }); } catch { throw new ContractError('CAPABILITY_UNVERIFIED', 'TikHub 账号核对请求暂未成功'); }
    const raw = (await response.text()).replaceAll(token, '[REDACTED]').replaceAll(JSON.stringify(token).slice(1, -1), '[REDACTED]');
    if (Buffer.byteLength(raw) > 256 * 1024) throw new ContractError('CAPABILITY_UNVERIFIED', 'TikHub 账号响应过大');
    if ([401, 403].includes(response.status)) throw new ContractError('AUTH_REQUIRED', 'TikHub 密钥或权限需要核对');
    if (!response.ok) throw new ContractError('CAPABILITY_UNVERIFIED', 'TikHub 账号请求暂不可用');
    let payload: { code?: unknown; data?: { profile?: unknown; rest_id?: unknown; status?: unknown } };
    try { payload = JSON.parse(raw); } catch { throw new ContractError('CAPABILITY_UNVERIFIED', 'TikHub 账号响应格式需要核对'); }
    const data = payload?.data;
    if (!data || Number(payload.code) !== 200 || data.status !== 'active' || typeof data.profile !== 'string' || data.profile.toLowerCase() !== match[1]!.toLowerCase() || typeof data.rest_id !== 'string' || !/^\d{1,30}$/.test(data.rest_id)) throw new ContractError('CAPABILITY_UNVERIFIED', 'TikHub 返回的账号身份与登记主页不符');
    return { platform: 'x', platform_account_id: data.rest_id, canonical_url: 'https://x.com/' + data.profile.toLowerCase(), checked_at: new Date(this.clock()).toISOString(), raw_body: raw, evidence_kind: this.fixture ? 'internal_rule' : 'real_platform' };
  }
  private accountOptions(){return {token:this.tokenProvider(),fetcher:this.fetcher,timeout:this.timeoutMs,now:this.clock,fixture:this.fixture};}
  fetchBenchmarkFeed(url:string,platform:Platform,platformAccountId:string,signal?:AbortSignal,cursor?:string|null){return fetchBenchmarkFeed(url,platform,platformAccountId,this.accountOptions(),signal,cursor);}
  discoverAccount(platform:'xiaohongshu'|'douyin',displayId:string){return discoverAccount(platform,displayId,this.accountOptions());}
  async describe(): Promise<CapabilityDescription[]> { return PLATFORMS.flatMap(platform => ['work', 'account'].map(scope => ({ operation: `${platform}:${scope}`, status: this.credentialPresent() ? 'unverified' as const : 'unconfigured' as const, limitations: ['需用户选择的已核对目标和实际平台响应', '响应生成时间不能充当指标观察时间', '账户粉丝不归属单篇'], verified_at: null, evidence_ref: null }))); }
  async resolveWork(url: string): Promise<JsonObject> {
    const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new ContractError('VALIDATION_ERROR', 'URL 无效');
    const candidates: Array<[Platform, RegExp, RegExp]> = [['x', /(^|\.)(x|twitter)\.com$/, /\/status\/(\d+)(?:\/|$)/], ['xiaohongshu', /(^|\.)xiaohongshu\.com$/, /\/(?:explore|discovery\/item)\/([a-fA-F0-9]{24})(?:\/|$)/], ['douyin', /(^|\.)douyin\.com$/, /\/video\/(\d+)(?:\/|$)/], ['bilibili', /(^|\.)bilibili\.com$/, /\/video\/(BV[A-Za-z0-9]+)(?:\/|$)/]];
    const pair = candidates.find(row => row[1].test(parsed.hostname)); return { platform: pair?.[0] ?? (parsed.hostname === 'mp.weixin.qq.com' ? 'wechat' : null), platform_work_id_candidate: pair ? parsed.pathname.match(pair[2])?.[1] ?? null : null, platform_work_id: null, account_id: null, identity_status: 'pending', url };
  }
  checkReadiness(identity: CollectionIdentity): { ready: boolean; reason: string | null } {
    if (!this.credentialPresent()) return { ready: false, reason: 'missing_config' };
    const target = this.targets.find(target => target.target_id === identity.target_id && target.scope === identity.scope);
    if (!target) return { ready: false, reason: 'missing_selected_verified_target' };
    if (target.platform !== identity.platform || target.platform_work_id !== identity.platform_work_id || target.platform_account_id !== identity.platform_account_id || (identity.scope === 'work' && target.url !== identity.url)) return { ready: false, reason: 'verified_target_identity_mismatch' };
    if (!target.metrics.some(metric => !metric.unsupported && !!metric.path && !!metric.mapping_evidence_ref)) return { ready: false, reason: 'missing_verified_metric_mapping' };
    return { ready: true, reason: null };
  }
  prepare(identity: CollectionIdentity, requestId: string): CollectionDescriptor {
    const readiness = this.checkReadiness(identity); if (!readiness.ready) throw new ContractError(readiness.reason === 'missing_config' ? 'AUTH_REQUIRED' : 'CAPABILITY_UNVERIFIED', 'TikHub 采集尚未配置可验证目标', { reason: readiness.reason });
    const target = this.targets.find(target => target.target_id === identity.target_id && target.scope === identity.scope)!;
    const endpoint = ENDPOINTS[target.endpoint_key];
    return { collection_request_id: requestId, request_fingerprint: digest(canonical({ collection_request_id: requestId, method: endpoint.method, endpoint: endpoint.path, target: identity, params: target.params })), endpoint_key: target.endpoint_key, identity };
  }
  async collect(descriptor: CollectionDescriptor, signal?: AbortSignal): Promise<AdapterResponse> {
    const expected = this.prepare(descriptor.identity, descriptor.collection_request_id);
    if (expected.request_fingerprint !== descriptor.request_fingerprint || expected.endpoint_key !== descriptor.endpoint_key) throw new ContractError('VALIDATION_ERROR', '采集请求 fingerprint 不符');
    const target = this.targets.find(target => target.target_id === descriptor.identity.target_id && target.scope === descriptor.identity.scope)!, endpoint = ENDPOINTS[target.endpoint_key];
    const url = new URL('https://api.tikhub.io' + endpoint.path); if (endpoint.method === 'GET') for (const [key, value] of Object.entries(target.params)) url.searchParams.set(key, String(value));
    let body = '', status = 0, failure: string | null = null, retryAfter: number | null = null;
    const deadline = AbortSignal.timeout(this.timeoutMs), requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const token = this.tokenProvider(); if (!token) throw new ContractError('AUTH_REQUIRED', 'TikHub 密钥尚未配置');
      const response = await this.fetcher(url, { method: endpoint.method, headers: { Authorization: 'Bearer ' + token, ...(endpoint.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(endpoint.method === 'POST' ? { body: JSON.stringify(target.params) } : {}), signal: requestSignal, redirect: 'error' });
      status = response.status; body = await response.text();
      // 原始响应同样脱敏，避免厂商错误体回显密钥进入持久证据。
      body = body.replaceAll(token, '[REDACTED]');
      if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new ContractError('VALIDATION_ERROR', '响应过大');
      if ([401, 403].includes(status)) failure = 'provider_permission_denied'; else if (status === 429) { failure = 'provider_rate_limited'; const raw = response.headers.get('retry-after'); const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? (Date.parse(raw) - this.clock()) / 1000 : 60; retryAfter = Number.isFinite(seconds) ? Math.max(1, Math.min(86_400, Math.ceil(seconds))) : 60; }
      else if (status < 200 || status >= 300) failure = 'provider_http_error';
    } catch (error) { if (error instanceof ContractError) throw error; failure = signal?.aborted ? 'request_aborted' : deadline.aborted ? 'request_timeout' : 'network_error'; body = JSON.stringify({ error: failure }); }
    let payload: unknown; try { payload = JSON.parse(body); } catch { payload = null; failure ??= 'invalid_json_response'; }
    if (!failure && payload && typeof payload === 'object') {
      const object = payload as Record<string, unknown>; if (object.code != null && ![0, 200].includes(Number(object.code))) failure = [401, 403].includes(Number(object.code)) ? 'provider_permission_denied' : Number(object.code) === 429 ? 'provider_rate_limited' : 'provider_application_error';
      if (!failure && object.data == null) failure = 'provider_data_null_or_missing';
      if (!failure && object.data && typeof object.data === 'object' && [false, 0].includes((object.data as Record<string, unknown>).get_data_succ as boolean)) failure = 'provider_fetch_unsuccessful';
    }
    const collectedAt = new Date(this.clock()).toISOString(); let observedAt: string | null = null, basis: AdapterObservation['observed_time_basis'] = 'unknown', reason: string | null = 'endpoint_observation_time_unverified';
    if (!failure && target.observation.evidence_ref && target.observation.basis === 'collector_verified') { basis = 'collector_verified'; observedAt = collectedAt; reason = null; }
    else if (!failure && target.observation.evidence_ref && target.observation.basis === 'provider' && target.observation.path) { const reading = valueAt(payload, target.observation.path); if (typeof reading.value === 'string' && Number.isFinite(Date.parse(reading.value))) { basis = 'provider'; observedAt = new Date(reading.value).toISOString(); reason = null; } else reason = 'provider_observed_at_missing'; }
    const identity = descriptor.identity;
    return { raw_body: JSON.stringify({ http_status: status, endpoint_key: descriptor.endpoint_key, collection_request_id: descriptor.collection_request_id, request_fingerprint: descriptor.request_fingerprint, collected_at: collectedAt, body }), observation: {
      collection_request_id: descriptor.collection_request_id, request_fingerprint: descriptor.request_fingerprint, platform: identity.platform, scope: identity.scope, target_id: identity.target_id, platform_work_id: identity.platform_work_id, account_id: identity.account_id,
      observed_at: observedAt, observed_time_basis: basis, observed_time_reason: reason, observation_evidence_ref: target.observation.evidence_ref, collected_at: collectedAt, published_at: identity.published_at, adapter_version: TIKHUB_ADAPTER_VERSION,
      metrics: target.metrics.map(mapping => normalizeMetric(payload, mapping, identity.platform, identity.scope, failure)), failure, retry_after_s: failure === 'provider_rate_limited' ? retryAfter ?? 60 : null, evidence_kind: this.fixture ? 'internal_rule' : 'real_platform' } };
  }
  private validateTarget(target: VerifiedTarget): void {
    const endpoint = ENDPOINTS[target.endpoint_key];
    if (!endpoint || endpoint.platform !== target.platform || endpoint.scope !== target.scope || !target.identity_evidence_ref || !target.platform_account_id || (target.scope === 'work' && (!target.platform_work_id || !target.url)) || !Object.keys(target.params).length || Object.keys(target.params).some(key => !(endpoint.params as readonly string[]).includes(key))) throw new ContractError('VALIDATION_ERROR', 'TikHub 目标、身份或只读端点尚未核对');
    const expected = target.scope === 'account' ? target.platform_account_id : endpoint.identity === 'url' ? target.url : target.platform_work_id;
    if (String(target.params[endpoint.identity] ?? '') !== expected) throw new ContractError('VALIDATION_ERROR', '请求目标须与已核对身份一致');
    if (target.platform === 'wechat' && target.scope === 'work') { const url = new URL(target.url!); if (url.hostname !== 'mp.weixin.qq.com' || !url.pathname.startsWith('/s') || url.username || url.password) throw new ContractError('VALIDATION_ERROR', '公众号链接无效'); }
    if (target.metrics.length > 64 || new Set(target.metrics.map(metric => metric.key)).size !== target.metrics.length) throw new ContractError('VALIDATION_ERROR', '指标映射重复或过多');
    if (target.observation.basis !== 'unknown' && !target.observation.evidence_ref) throw new ContractError('VALIDATION_ERROR', '当前观察语义必须有验证依据');
  }
}
export { createTikHubReaderFeedbackAdapter, READER_FEEDBACK_ENDPOINTS } from './reader-feedback.ts';
