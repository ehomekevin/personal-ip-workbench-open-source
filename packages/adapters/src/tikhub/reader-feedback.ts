import { ContractError, type Platform, type ReaderFeedback } from '@workbench/contracts';

// Endpoint parameters verified against the provider docs; no paid probe is needed to create this adapter.
export const READER_FEEDBACK_ENDPOINTS = {
  x: { path: '/api/v1/twitter/web/fetch_post_comments', docs: 'https://docs.tikhub.io/215701674e0' },
  douyin: { path: '/api/v1/douyin/web/fetch_video_comments', docs: 'https://docs.tikhub.io/186826152e0' },
} as const;
export interface ReaderFeedbackWork { id: string; platform: Platform; url: string | null; platform_item_id: string | null }
export interface ReaderFeedbackCollection { status: 'collected' | 'empty' | 'unsupported' | 'unavailable'; feedback: ReaderFeedback[]; limitations: string[] }
export interface TikHubReaderFeedbackOptions {
  token_env?: string; token_provider?: () => string | null; fetcher?: typeof fetch; clock?: () => number;
  timeout_ms?: number; max_pages?: number; page_size?: number;
}
type Row = Record<string, unknown>;
type Target = { platform: 'x' | 'douyin'; itemId: string; source: string; ownerHandle: string | null };
type ParsedPage = { feedback: ReaderFeedback[]; cursor: string | null; hasMore: boolean; limitations: string[]; failure: string | null };
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const first = (...values: unknown[]) => values.find(value => value !== undefined && value !== null);
const id = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
const itemId = (value: unknown) => /^[1-9]\d{0,29}$/.test(id(value)) ? id(value) : '';
const flag = (value: unknown): boolean | null => value === true || value === 1 ? true : value === false || value === 0 ? false : null;
const time = (value: unknown): string | null => {
  const millis = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15 ? new Date(millis).toISOString() : null;
};
function targetFor(work: ReaderFeedbackWork): Target {
  if (!work.id || work.id.length > 300) throw new Error('作品登记 ID 无效，未读取评论');
  let located = '', ownerHandle: string | null = null;
  if (work.url) {
    let url: URL; try { url = new URL(work.url); } catch { throw new Error('作品链接无效，未读取评论'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('作品链接须是明确的 HTTPS 平台链接');
    const match = work.platform === 'x' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)
      ? url.pathname.match(/^\/(?:([A-Za-z0-9_]{1,15})|i)\/status\/([1-9]\d{0,29})\/?$/)
      : work.platform === 'douyin' && ['douyin.com', 'www.douyin.com'].includes(url.hostname)
        ? url.pathname.match(/^\/video\/([1-9]\d{0,29})\/?$/) : null;
    if (!match) throw new Error('作品链接未提供可核对的平台作品 ID');
    located = work.platform === 'x' ? match[2]! : match[1]!;
    ownerHandle = work.platform === 'x' && match[1] !== 'i' ? match[1]!.toLowerCase() : null;
  }
  const registered = work.platform_item_id == null ? '' : itemId(work.platform_item_id);
  if (work.platform_item_id != null && !registered) throw new Error('平台作品 ID 无效，未读取评论');
  if (registered && located && registered !== located) throw new Error('登记作品 ID 与链接不一致，未读取评论');
  const resolved = registered || located;
  if (!resolved) throw new Error('作品缺少已登记的平台 ID 或明确作品链接');
  return { platform: work.platform as Target['platform'], itemId: resolved,
    source: work.platform === 'x' ? `https://x.com/${ownerHandle ?? 'i'}/status/${resolved}` : `https://www.douyin.com/video/${resolved}`, ownerHandle };
}
function payloadData(payload: unknown): Row {
  const root = object(payload);
  const successfulCode = (value: unknown) => value === 0 || value === 200 || value === '0' || value === '200';
  if (!successfulCode(root.code)) throw new Error(providerFailure(typeof root.code === 'string' || typeof root.code === 'number' ? Number(root.code) : NaN, '平台评论请求失败'));
  const data = object(root.data);
  if (!Object.keys(data).length) throw new Error('平台未返回可核对的评论数据，不能判断为无评论');
  const nested = object(data.data), result = Array.isArray(data.comments) || Array.isArray(data.timeline) || Array.isArray(data.tweets) ? data : Object.keys(nested).length ? nested : data;
  for (const layer of [root, data, nested]) {
    if (Object.hasOwn(layer, 'code') && !successfulCode(layer.code)) throw new Error(providerFailure(typeof layer.code === 'number' || typeof layer.code === 'string' ? Number(layer.code) : NaN, '平台评论请求失败'));
    if (Object.hasOwn(layer, 'status_code') && layer.status_code !== 0 && layer.status_code !== '0') throw new Error('平台评论读取失败，不能判断为无评论');
    if (['get_data_succ', 'success'].some(key => Object.hasOwn(layer, key) && flag(layer[key]) !== true)
      || Array.isArray(layer.errors) && layer.errors.length > 0 || Object.keys(object(layer.errors)).length > 0) throw new Error('平台未成功读取评论，不能判断为无评论');
  }
  return result;
}
function providerFailure(code: number, fallback: string): string {
  return [401, 403].includes(code) ? `TikHub 密钥或评论读取权限需要核对（${code}）`
    : [402, 429].includes(code) ? `TikHub 额度不足或请求受限（${code}），本轮停止` : `${fallback}（${Number.isFinite(code) ? code : '状态未知'}）`;
}
function pagination(data: Row, platform: Target['platform'], graphCursor: unknown): Pick<ParsedPage, 'cursor' | 'hasMore' | 'limitations' | 'failure'> {
  const rawCursor = platform === 'douyin' ? data.cursor : first(data.next_cursor, graphCursor);
  const cursorValue = id(rawCursor), cursor = cursorValue && cursorValue.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(cursorValue)
    && (platform !== 'douyin' || /^[1-9]\d{0,18}$/.test(cursorValue)) ? cursorValue : null;
  const more = flag(data.has_more), hasMore = more ?? (platform === 'x' && !!cursor);
  return { cursor: hasMore ? cursor : null, hasMore, failure: hasMore && !cursor ? '平台表示还有评论，但未返回有效游标；已停止补采' : null,
    limitations: more === null && !cursor ? ['平台未提供后续分页状态；当前结果仅代表本次可读评论'] : [] };
}
function parsePage(payload: unknown, work: ReaderFeedbackWork, target: Target, recordedAt: string): ParsedPage {
  const data = payloadData(payload), rows: Row[] = [], limitations: string[] = []; let graphCursor: unknown, invalid = 0, unrelated = 0, unknownParent = 0;
  if (target.platform === 'douyin') {
    if (!Array.isArray(data.comments)) throw new Error('抖音评论响应结构尚未核对，不能判断为无评论');
    rows.push(...data.comments.map(object));
  } else {
    const list = first(data.comments, data.tweets, data.timeline);
    const thread = object(data.threaded_conversation_with_injections_v2), instructions = first(data.instructions, thread.instructions);
    if (!Array.isArray(list) && !Array.isArray(instructions)) throw new Error('X 评论响应结构尚未核对，不能判断为无评论');
    const visit = (value: unknown, depth = 0): boolean => {
      if (depth > 24 || !value || typeof value !== 'object') return false;
      if (Array.isArray(value)) { const recognized = value.map(row => visit(row, depth + 1)); return recognized.every(Boolean); }
      const row = object(value), legacy = object(row.legacy);
      if (['Bottom', 'Top'].includes(String(row.cursorType)) && typeof row.value === 'string' && row.value.length > 0) { if (row.cursorType === 'Bottom') graphCursor = row.value; return true; }
      if (row.type === 'TimelineTerminateTimeline') return true;
      if (itemId(first(row.tweet_id, row.id_str, legacy.id_str, row.rest_id))
        && typeof first(object(object(object(row.note_tweet).note_tweet_results).result).text, row.text, row.full_text, legacy.full_text) === 'string') { rows.push(row); return true; }
      // Traverse only known timeline envelopes. Unknown payloads and quoted/retweeted children cannot become replies.
      const keys = ['entries', 'entry', 'content', 'items', 'item', 'itemContent', 'tweet_results', 'result', 'tweet', 'instructions'].filter(key => Object.hasOwn(row, key));
      const recognized = keys.map(key => visit(row[key], depth + 1));
      return keys.length > 0 && recognized.every(Boolean);
    };
    if (Array.isArray(list)) {
      for (const value of list) {
        if (!visit(value)) invalid++;
      }
    }
    else if (Array.isArray(instructions)) for (const value of instructions) { if (!visit(value)) invalid++; }
  }
  const feedback: ReaderFeedback[] = [], seen = new Set<string>();
  if (rows.length > 100) limitations.push('单页超过 100 条，本轮仅采用前 100 条评论');
  for (const row of rows.slice(0, 100)) {
    const legacy = object(row.legacy), commentId = itemId(target.platform === 'douyin' ? row.cid : first(row.tweet_id, row.id_str, legacy.id_str, row.rest_id));
    const text = target.platform === 'douyin' ? row.text : first(object(object(object(row.note_tweet).note_tweet_results).result).text, row.full_text, row.text, legacy.full_text);
    if (!commentId || typeof text !== 'string' || !text.trim() || text.length > 12000) { invalid++; continue; }
    if (target.platform === 'x') {
      const parent = itemId(first(row.in_reply_to_status_id, row.in_reply_to_status_id_str, legacy.in_reply_to_status_id_str, legacy.in_reply_to_status_id));
      if (commentId === target.itemId || parent && parent !== target.itemId) { unrelated++; continue; }
      if (!parent) { unknownParent++; continue; }
      if (row.retweeted_tweet || legacy.retweeted_status_result || /^RT @/.test(text)) { unrelated++; continue; }
    } else if (row.aweme_id !== undefined && itemId(row.aweme_id) !== target.itemId) { unrelated++; continue; }
    const key = `${target.platform}:${commentId}`; if (seen.has(key)) continue; seen.add(key);
    const user = object(first(row.author, row.user, object(object(row.core).user_results).result)), author = { ...user, ...object(user.legacy), ...object(user.core) };
    const handle = id(first(author.screen_name, author.username));
    const name = first(author.name, author.nickname), explicitAuthor = flag(row.is_author);
    const isAuthor = explicitAuthor ?? (target.platform === 'x' && target.ownerHandle && /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle.toLowerCase() === target.ownerHandle : null);
    feedback.push({ id: key, kind: 'response', text, provenance: 'platform', work_id: work.id, work_url: work.url ?? target.source, platform_comment_id: commentId,
      source: target.platform === 'x' ? `https://x.com/${/^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : 'i'}/status/${commentId}` : target.source,
      recorded_at: recordedAt, commented_at: time(target.platform === 'douyin' ? row.create_time : first(row.created_at, legacy.created_at)),
      author_name: typeof name === 'string' ? name : handle || null, is_author: isAuthor });
  }
  if (invalid) limitations.push(`${invalid} 条评论缺少有效 ID 或完整原文，未采用`);
  if (unrelated) limitations.push(`${unrelated} 条原帖、引用或其他作品回复未采用`);
  if (unknownParent) limitations.push(`${unknownParent} 条 X 回复未明确关联当前作品，未采用`);
  if (!feedback.length && (invalid || unknownParent || unrelated)) throw new Error(limitations.join('；'));
  if (feedback.some(row => row.commented_at === null)) limitations.push('部分评论缺少平台时间，保留未知');
  if (feedback.some(row => row.is_author === null)) limitations.push('部分评论未提供作者身份标记，保留未知');
  const page = pagination(data, target.platform, graphCursor);
  return { feedback, ...page, limitations: [...limitations, ...page.limitations] };
}
async function readPayload(response: Response, token: string): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('平台评论响应为空，不能判断为无评论');
  const decoder = new TextDecoder(); let bytes = 0, raw = '';
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 2 * 1024 * 1024) throw new Error('评论响应超过 2 MiB，本轮停止'); raw += decoder.decode(chunk.value, { stream: true }); }
    raw += decoder.decode();
  } finally { await reader.cancel(); }
  raw = raw.replaceAll(token, '[REDACTED]').replaceAll(JSON.stringify(token).slice(1, -1), '[REDACTED]');
  try { return JSON.parse(raw); } catch { throw new Error('平台评论响应不是有效 JSON，不能判断为无评论'); }
}
export function createTikHubReaderFeedbackAdapter(options: TikHubReaderFeedbackOptions = {}) {
  const tokenEnv = options.token_env ?? 'TIKHUB_API_KEY', tokenProvider = options.token_provider ?? (() => process.env[tokenEnv]?.trim() || null);
  const fetcher = options.fetcher ?? fetch, clock = options.clock ?? Date.now;
  const timeout = options.timeout_ms ?? 30_000, maxPages = options.max_pages ?? 2, pageSize = options.page_size ?? 20;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new ContractError('VALIDATION_ERROR', '评论采集配置范围无效');
  return {
    async collect(work: ReaderFeedbackWork, options: { signal?: AbortSignal } = {}): Promise<ReaderFeedbackCollection> {
      const feedback: ReaderFeedback[] = [], limitations: string[] = [], seen = new Set<string>();
      const result = (status: ReaderFeedbackCollection['status']) => ({ status, feedback, limitations: [...new Set(limitations)] });
      if (!['x', 'douyin'].includes(work.platform)) { limitations.push('评论采集当前仅支持 X 和抖音'); return result('unsupported'); }
      let target: Target, token: string;
      try { target = targetFor(work); token = tokenProvider()?.trim() ?? ''; } catch (error) { limitations.push(error instanceof Error ? error.message : '评论采集目标或凭据不可用'); return result('unavailable'); }
      if (!token) { limitations.push('TikHub 密钥尚未配置，未读取评论'); return result('unavailable'); }
      let cursor: string | null = target.platform === 'douyin' ? '0' : null;
      const cursors = new Set<string>();
      for (let page = 0; page < maxPages; page++) {
        if (options.signal?.aborted) { limitations.push('评论采集已取消'); return result('unavailable'); }
        const endpoint = new URL('https://api.tikhub.io' + READER_FEEDBACK_ENDPOINTS[target.platform].path);
        endpoint.searchParams.set(target.platform === 'x' ? 'tweet_id' : 'aweme_id', target.itemId);
        if (cursor !== null) endpoint.searchParams.set('cursor', cursor);
        if (target.platform === 'douyin') endpoint.searchParams.set('count', String(pageSize));
        const deadline = AbortSignal.timeout(timeout), signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
        try {
          const response = await fetcher(endpoint, { method: 'GET', headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal });
          if (!response.ok) { await response.body?.cancel(); throw new Error(providerFailure(response.status, '评论读取 HTTP 失败')); }
          const payload = await readPayload(response, token);
          if (signal.aborted) throw new Error('评论采集已中断');
          const parsed = parsePage(payload, work, target, new Date(clock()).toISOString());
          for (const row of parsed.feedback) { if (!seen.has(row.id)) { seen.add(row.id); feedback.push(row); } }
          limitations.push(...parsed.limitations);
          if (parsed.failure) { limitations.push(parsed.failure); return result('unavailable'); }
          if (!parsed.hasMore) return result(feedback.length ? 'collected' : 'empty');
          if (parsed.cursor === cursor || cursors.has(parsed.cursor!)) { limitations.push('评论分页游标重复，已停止补采'); return result('unavailable'); }
          cursors.add(parsed.cursor!); cursor = parsed.cursor;
          if (page + 1 === maxPages) { limitations.push(`本轮已达到 ${maxPages} 页上限，仍有后续评论未采集`); return result(feedback.length ? 'collected' : 'unavailable'); }
        } catch (error) {
          limitations.push(options.signal?.aborted ? '评论采集已取消' : deadline.aborted ? '评论采集超时，不能判断为无评论'
            : error instanceof Error && !/fetch failed|network|ECONN|ENOTFOUND/i.test(error.message) ? error.message.replaceAll(token, '[REDACTED]') : '评论网络请求未完成，不能判断为无评论');
          return result('unavailable');
        }
      }
      return result(feedback.length ? 'collected' : 'empty');
    },
  };
}
