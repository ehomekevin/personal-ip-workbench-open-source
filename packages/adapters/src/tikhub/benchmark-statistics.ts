import { ContractError } from '@workbench/contracts';

export const BENCHMARK_STATISTICS_ENDPOINT = 'https://api.tikhub.io/api/v1/douyin/app/v3/fetch_multi_video_statistics';
const MAX_IDS = 50;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface BenchmarkStatistic { aweme_id: string; play_count: string | null }
export interface BenchmarkStatisticsResult {
  raw_body: string;
  collected_at: string;
  evidence_kind: 'real_platform' | 'internal_rule';
  statistics: BenchmarkStatistic[];
}
export interface BenchmarkStatisticsOptions {
  token_provider: () => string | null;
  fetcher?: typeof fetch;
  clock?: () => number;
  timeout_ms?: number;
  fixture?: boolean;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validateIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IDS) {
    throw new ContractError('VALIDATION_ERROR', '统计请求需包含 1 至 50 个不重复的数字作品 ID');
  }
  const copied = [...ids];
  if (copied.some(id => typeof id !== 'string' || !/^\d{1,30}$/.test(id)) || new Set(copied).size !== copied.length) {
    throw new ContractError('VALIDATION_ERROR', '统计请求需包含 1 至 50 个不重复的数字作品 ID');
  }
  return copied;
}

function count(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,29})$/.test(value) ? value : null;
}

function providerError(payload: Record<string, unknown>): void {
  const rawCode = payload.code;
  const code = typeof rawCode === 'number' && Number.isSafeInteger(rawCode) ? rawCode
    : typeof rawCode === 'string' && /^(?:0|[1-9]\d{0,5})$/.test(rawCode) ? Number(rawCode) : null;
  if (code === 401 || code === 403) {
    throw new ContractError('AUTH_REQUIRED', 'TikHub 密钥或统计权限需要核对', { provider_code: code });
  }
  const message = [payload.message, payload.message_zh, payload.detail].filter(value => typeof value === 'string').join(' ');
  const quotaError = /quota\s+(?:exhausted|exceeded|limit\s+(?:reached|exceeded))|(?:insufficient|not\s+enough)\s+(?:balance|credits?)|(?:balance|credits?)\s+(?:insufficient|exhausted)|rate\s+limit\s+(?:exceeded|reached)|额度(?:不足|耗尽|用尽|已用完)|余额不足/i.test(message);
  if (code === 402 || code === 429 || quotaError) {
    throw new ContractError('QUOTA_EXHAUSTED', 'TikHub 额度不足或统计请求受限，本轮停止', { provider_code: code });
  }
  if (code !== 200) {
    throw new ContractError('CAPABILITY_UNVERIFIED', 'TikHub 未返回成功的统计响应', { provider_code: code });
  }
}

/** Only the statistics_list structure observed on the dedicated statistics route is supported. */
export function parseBenchmarkStatistics(rawBody: string, requestedIds?: readonly string[]): BenchmarkStatistic[] {
  const requested = requestedIds === undefined ? null : new Set(validateIds(requestedIds));
  if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new ContractError('CAPABILITY_UNVERIFIED', '统计响应过大或格式无效，本轮未采用');
  }
  let payload: unknown;
  try { payload = JSON.parse(rawBody); }
  catch { throw new ContractError('CAPABILITY_UNVERIFIED', '统计响应不是有效 JSON'); }
  const root = object(payload);
  providerError(root);
  const rows = object(root.data).statistics_list;
  if (!Array.isArray(rows) || rows.length > MAX_IDS) {
    throw new ContractError('CAPABILITY_UNVERIFIED', '统计响应缺少受支持的 statistics_list');
  }
  const seen = new Set<string>(), statistics: BenchmarkStatistic[] = [];
  for (const value of rows) {
    const row = object(value), id = row.aweme_id;
    if (typeof id !== 'string' || !/^\d{1,30}$/.test(id)) continue;
    if (seen.has(id)) throw new ContractError('CAPABILITY_UNVERIFIED', '统计响应包含重复作品 ID');
    seen.add(id);
    if (requested && !requested.has(id)) throw new ContractError('CAPABILITY_UNVERIFIED', '统计响应包含未请求的作品 ID');
    statistics.push({ aweme_id: id, play_count: count(row.play_count) });
  }
  return statistics;
}

function redact(raw: string, token: string): string {
  const escaped = JSON.stringify(token).slice(1, -1);
  return raw.replaceAll(escaped, '[REDACTED]').replaceAll(token, '[REDACTED]');
}

function cancelled(): ContractError {
  return new ContractError('CAPABILITY_UNVERIFIED', '统计请求已取消或超时，本轮未采用');
}

async function bounded<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw cancelled();
  let onAbort: () => void = () => {};
  const interruption = new Promise<T>((_resolve, reject) => {
    onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([action(), interruption]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

async function readLimited(response: Response, signal: AbortSignal): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    cancelBody(response);
    throw new ContractError('CAPABILITY_UNVERIFIED', '统计响应超过 5 MiB，本轮未采用');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ContractError('CAPABILITY_UNVERIFIED', '统计响应为空');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, raw = '';
  try {
    while (true) {
      const chunk = await bounded(() => reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ContractError('CAPABILITY_UNVERIFIED', '统计响应超过 5 MiB，本轮未采用');
      raw += decoder.decode(chunk.value, { stream: true });
    }
    return raw + decoder.decode();
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError('CAPABILITY_UNVERIFIED', '统计响应读取未完成或编码无效，本轮未采用');
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export class BenchmarkStatisticsAdapter {
  private readonly tokenProvider: () => string | null;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly fixture: boolean;

  constructor(options: BenchmarkStatisticsOptions) {
    if (typeof options?.token_provider !== 'function') throw new ContractError('VALIDATION_ERROR', '统计客户端需要凭据提供器');
    this.timeoutMs = options.timeout_ms ?? 25_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 25_000) {
      throw new ContractError('VALIDATION_ERROR', '统计超时需在 1 至 25000 毫秒内');
    }
    this.fixture = options.fixture ?? false;
    if (this.fixture && !options.fetcher) throw new ContractError('VALIDATION_ERROR', '统计测试样例必须使用独立 fetcher');
    this.tokenProvider = options.token_provider;
    this.fetcher = options.fetcher ?? fetch;
    this.clock = options.clock ?? Date.now;
  }

  credentialPresent(): boolean { return !!this.tokenProvider()?.trim(); }

  async fetch(ids: string[], signal?: AbortSignal): Promise<BenchmarkStatisticsResult> {
    const requestedIds = validateIds(ids);
    const token = this.tokenProvider()?.trim();
    if (!token) throw new ContractError('AUTH_REQUIRED', '请先配置 TikHub 密钥');
    const timeout = AbortSignal.timeout(this.timeoutMs), requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const url = new URL(BENCHMARK_STATISTICS_ENDPOINT);
    url.searchParams.set('aweme_ids', requestedIds.join(','));
    let response: Response;
    try {
      response = await bounded(() => this.fetcher(url, {
        method: 'GET', headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: requestSignal,
      }), requestSignal);
    } catch { throw new ContractError('CAPABILITY_UNVERIFIED', 'TikHub 统计请求未完成，请核对任务状态后再发起新一轮'); }
    if (!response.ok) {
      cancelBody(response);
      if (response.status === 401 || response.status === 403) throw new ContractError('AUTH_REQUIRED', 'TikHub 密钥或统计权限需要核对', { http_status: response.status });
      if (response.status === 402 || response.status === 429) throw new ContractError('QUOTA_EXHAUSTED', 'TikHub 额度不足或统计请求受限，本轮停止', { http_status: response.status });
      throw new ContractError('CAPABILITY_UNVERIFIED', 'TikHub 统计响应暂不可用', { http_status: response.status });
    }
    const raw = redact(await readLimited(response, requestSignal), token);
    return {
      raw_body: raw, collected_at: new Date(this.clock()).toISOString(),
      evidence_kind: this.fixture ? 'internal_rule' : 'real_platform',
      statistics: parseBenchmarkStatistics(raw, requestedIds),
    };
  }
}
