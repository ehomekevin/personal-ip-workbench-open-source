import { ContractError, type NormalizedSourceRecord, type JsonObject, type Platform, type PlatformVideoCandidate, type PlatformVideoMedia } from '@workbench/contracts';
import type { AccountLookupOptions } from './accounts.ts';
import {publicUrl} from './profile.ts';
import { projectXPost, unwrapXPost, xPostId, xPostText, xPostPublishedAt, xPostMetrics } from './x-post.ts';

export const BENCHMARK_FEED_VERSION = 'benchmark-feed/6';
export interface BenchmarkFeed {
  endpoint: string; raw_body: string; collected_at: string; records: NormalizedSourceRecord[];
  evidence_kind: 'internal_rule' | 'real_platform'; skipped: number; has_more: boolean;next_cursor?:string|null;
}
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const id = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : '';
const count = (v: unknown): string | null => (typeof v === 'string' && /^(0|[1-9]\d{0,29})$/.test(v)) ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
const first = (...values: unknown[]) => values.find(v => v !== undefined && v !== null);
const date = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const safeLinks = (values: unknown[]) => values.filter((v): v is string => typeof v === 'string' && /^https:\/\//.test(v));
const expiryDate = (value: unknown): string | null => {
  const seconds = count(value), ms = seconds === null ? NaN : Number(seconds) * 1000;
  return Number.isSafeInteger(ms) && ms > 0 && ms <= 8640000000000000 ? new Date(ms).toISOString() : null;
};

export function parseBenchmarkFeed(platform: Platform, url: string, platformAccountId: string, body: unknown): { records: NormalizedSourceRecord[]; skipped: number; has_more: boolean;next_cursor:string|null } {
  const root = obj(body), data = obj(root.data), records: NormalizedSourceRecord[] = []; let skipped = 0;
  const push = (workId: string, text: string, publishedAt: string | null, author: string, metrics: JsonObject, metadata: JsonObject, media: JsonObject[] = []) => {
    if (!/^\d{1,30}$/.test(workId) || !publishedAt) { skipped++; return; }
    if (records.some(r => r.external_id === workId)) return;
    const canonical = platform === 'x' ? `https://x.com/${new URL(url).pathname.split('/')[1]}/status/${workId}` : `https://www.douyin.com/video/${workId}`;
    records.push({ external_id: workId, canonical_url: canonical, record_kind: platform === 'x' ? 'x_post' : 'douyin_video', published_at: publishedAt,
      payload: { title: text.split('\n')[0]?.slice(0, 120) || (platform === 'x' ? 'X 作品' : '抖音作品'), summary: text.slice(0, 240), body: text || null, category: '对标内容', author_name: author, reply_author_name: null,
        quoted_author_name: typeof metadata.quoted_author === 'string' ? metadata.quoted_author : null,
        external_links: [canonical, ...safeLinks(Array.isArray(metadata.external_links) ? metadata.external_links : [])], media, identity_status: 'confirmed',
        parser_warnings: platform === 'douyin' ? ['视频说明与媒体来自平台；没有平台字幕时，口播正文尚未转写。','公开作品页未提供有效播放数时保持未知，不把占位零值当成播放表现。'] : [],
        provider_metadata: { ...metadata, platform, platform_account_id: platformAccountId, platform_work_id: workId, metrics, observed_at: null, observed_time_basis: 'unknown', source_name: author, body_parser_version: BENCHMARK_FEED_VERSION } } });
  };
  if (platform === 'x') {
    const handle = new URL(url).pathname.split('/')[1]!;
    const candidates: Record<string, any>[] = [];
    const visit = (v: unknown, depth = 0) => {
      if (depth > 24 || !v || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(x => visit(x, depth + 1)); return; }
      const row = unwrapXPost(v), workId = xPostId(row), text = xPostText(row);
      if (workId && text !== null && xPostPublishedAt(row)) { candidates.push(row); return; }
      // 不把缺正文或时间的外层作品里的原推、引用误提升成账号自己的 timeline row。
      if (workId && (row.author || row.user || obj(obj(row.core).user_results).result)) return;
      Object.values(row).forEach(x => visit(x, depth + 1));
    };
    visit(data);
    const recognized = candidates.length > 0 || Array.isArray(data.timeline) || Array.isArray(data.tweets) || Array.isArray(obj(data.data).timeline);
    if (!recognized) throw new ContractError('CAPABILITY_UNVERIFIED', 'X 最新作品响应结构尚未核对，保留上次结果');
    for (const row of candidates) {
      const l = obj(row.legacy), post = projectXPost(row, { profile: first(data.user, obj(data.data).user), account_handle: handle });
      // 每条外层作品先核对账号 ID；原推作者或查询账号都不能代替转推归属证明。
      if (post.author.id !== platformAccountId) { skipped++; continue; }
      const text = post.text ?? '';
      if (post.kind === 'repost' ? !post.reposted_post?.id || post.reposted_post.availability === 'unknown' : /^RT @/.test(text)) { skipped++; continue; }
      const quoted = post.quoted_post;
      push(post.id ?? '', text, post.published_at, post.author.name || '@' + (post.author.handle || handle), xPostMetrics(row),
        { author_handle: post.author.handle, author_platform_id: post.author.id, format: 'text', x_post: post,
          quoted_work_id: quoted?.id ?? null, quoted_author: quoted?.author.name ?? null, quoted_text: quoted?.text ?? null,
          conversation_id: id(first(row.conversation_id, l.conversation_id_str)) || null,
          in_reply_to_work_id: id(first(row.reply_to, row.in_reply_to_status_id, l.in_reply_to_status_id_str)) || null,
          hashtags: Array.isArray(obj(first(row.entities, l.entities)).hashtags) ? obj(first(row.entities, l.entities)).hashtags.map((v: unknown) => id(obj(v).text)) : [],
          external_links: post.links.map(link => link.expanded_url ?? link.url) }, post.media);
    }
  } else if (platform === 'douyin') {
    const d = Array.isArray(data.aweme_list) ? data : obj(data.data);
    if (!Array.isArray(d.aweme_list) || (d.status_code !== undefined && d.status_code !== 0)) throw new ContractError('CAPABILITY_UNVERIFIED', '抖音最新作品响应结构尚未核对，保留上次结果');
    const sec = new URL(url).pathname.split('/')[2];
    for (const value of d.aweme_list) {
      const a = obj(value), author = obj(a.author), st = obj(a.statistics);
      if (id(author.uid) !== platformAccountId || (author.sec_uid && author.sec_uid !== sec)) { skipped++; continue; }
      const timestamp=typeof a.create_time==='number'&&Number.isSafeInteger(a.create_time)&&a.create_time>=0?a.create_time*1000:NaN;
      const at = Number.isFinite(timestamp)&&timestamp<=8640000000000000 ? new Date(timestamp).toISOString() : null;
      const video=obj(a.video),coverUrls = obj(video.cover).url_list;
      // 保留平台实际签名的候选；地址和声明格式不证明浏览器已解码。
      const coverCandidates=Array.isArray(coverUrls)?coverUrls.filter((u:unknown)=>publicUrl(u,true)):[];
      const cover=coverCandidates.find((u:string)=>/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(u))??coverCandidates[0]??null;
      const captions=typeof a.video_text==='string'?a.video_text:Array.isArray(a.video_text)?a.video_text.map(v=>typeof v==='string'?v:id(obj(v).text)).filter(Boolean).join('\n'):null;
      const media:JsonObject[]=[];
      if(Array.isArray(a.images))for(const item of a.images.slice(0,100)){const img=obj(item),url=publicUrl(first(img.url_list?.[0],obj(img.display_image).url_list?.[0]),true);if(url)media.push({type:'image',url,width:count(img.width),height:count(img.height)});}
      if(cover)media.push({type:'cover',url:publicUrl(cover,true)});
      const candidates:PlatformVideoCandidate[]=[];
      for(const field of ['play_addr_h264','play_addr']){
        const urls=obj(video[field]).url_list;
        if(Array.isArray(urls))urls.forEach((value:unknown,index:number)=>{const url=publicUrl(value,true);if(url)candidates.push({url,source_field:'video.'+field+'.url_list['+index+']'});});
      }
      const selected=candidates[0];
      if(selected){
        const medium:PlatformVideoMedia={type:'video',url:selected.url,play_url:selected.url,play_source_field:selected.source_field,play_candidates:candidates,preview_url:publicUrl(cover,true),download_url:publicUrl(obj(video.download_addr).url_list?.[0],true),duration_ms:count(first(a.duration,video.duration)),width:count(video.width),height:count(video.height),cdn_url_expired:typeof video.cdn_url_expired==='string'||typeof video.cdn_url_expired==='number'&&Number.isFinite(video.cdn_url_expired)?video.cdn_url_expired:null,expires_at:expiryDate(video.cdn_url_expired),expiry_source_field:video.cdn_url_expired===undefined||video.cdn_url_expired===null?null:'video.cdn_url_expired'};
        media.push(medium);
      }
      for(const item of Array.isArray(video.subtitle_infos)?video.subtitle_infos:[]){const s=obj(item),url=publicUrl(s.url??s.subtitle_url,true);if(url)media.push({type:'subtitle',url,language:id(s.language)||null});}
      const description=String(first(a.desc,a.preview_title,a.item_title)??'');
      push(id(first(a.aweme_id, a.aweme_id_str)), captions?description+'\n\n平台提供的字幕：\n'+captions:description, at, id(author.nickname) || '抖音作者',
        { likes: count(st.digg_count), comments: count(st.comment_count), shares: count(st.share_count), saves: count(st.collect_count), plays: count(st.play_count)==='0'?null:count(st.play_count) },
        { author_platform_id: id(author.uid), format: Array.isArray(a.images)&&a.images.length?'image_post':'short_video', duration_ms: count(first(a.duration,video.duration)), pinned: a.is_top === 1,hashtags:Array.isArray(a.text_extra)?a.text_extra.map(v=>id(obj(v).hashtag_name)).filter(Boolean):[],platform_caption:captions||null,transcript_status:captions?'platform_caption':'not_provided',play_count_raw:count(st.play_count),download_allowed:a.prevent_download===false||a.prevent_download===0,comment_preview:Array.isArray(a.comment_list)?a.comment_list.slice(0,20).map(v=>{const c=obj(v);return {id:id(c.cid),text:id(c.text),likes:count(c.digg_count)};}):[] },
        media);
    }
  } else throw new ContractError('CAPABILITY_UNSUPPORTED', '账号最新作品采集当前支持 X 和抖音');
  records.sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? '') || (b.external_id ?? '').localeCompare(a.external_id ?? ''));
  const d=platform==='douyin'?(Array.isArray(data.aweme_list)?data:obj(data.data)):data;
  const rawCursor=platform==='douyin'?count(d.max_cursor):id(first(d.next_cursor,obj(d.data).next_cursor));
  const nextCursor=rawCursor&&rawCursor!=='0'&&rawCursor.length<=4096&&!/[\u0000-\u001f\u007f]/.test(rawCursor)?rawCursor:null;
  const hasMore=d.has_more===false||d.has_more===0?false:d.has_more===true||d.has_more===1?true:!!nextCursor;
  return { records: records.slice(0, 100), skipped, has_more:hasMore,next_cursor:hasMore?nextCursor:null };
}

export async function fetchBenchmarkFeed(url: string, platform: Platform, platformAccountId: string, options: AccountLookupOptions, signal?: AbortSignal,cursor?:string|null): Promise<BenchmarkFeed> {
  if (!options.token) throw new ContractError('AUTH_REQUIRED', '先填写 TikHub 密钥');
  const u = new URL(url); let endpoint: URL;
  if (platform === 'x' && u.protocol === 'https:' && ['x.com', 'twitter.com'].includes(u.hostname) && /^\/[A-Za-z0-9_]{1,15}\/?$/.test(u.pathname))
    endpoint = new URL('https://api.tikhub.io/api/v1/twitter/web/fetch_user_post_tweet?screen_name=' + u.pathname.split('/')[1]);
  else if (platform === 'douyin' && u.protocol === 'https:' && ['douyin.com', 'www.douyin.com'].includes(u.hostname) && /^\/user\/[A-Za-z0-9_-]{16,256}\/?$/.test(u.pathname))
    endpoint = new URL('https://api.tikhub.io/api/v1/douyin/app/v3/fetch_user_post_videos?' + new URLSearchParams({ sec_user_id: u.pathname.split('/')[2]!, max_cursor: '0', count: '20', sort_type:'0',channel:'normal' }));
  else throw new ContractError('CAPABILITY_UNSUPPORTED', '请使用已核对的 X 或抖音账号主页');
  if(cursor!==undefined&&cursor!==null){if(!cursor||cursor.length>4096||/[\u0000-\u001f\u007f]/.test(cursor)||(platform==='douyin'&&!/^[1-9]\d{0,18}$/.test(cursor)))throw new ContractError('VALIDATION_ERROR','平台补采游标无效');endpoint.searchParams.set(platform==='x'?'cursor':'max_cursor',cursor);}
  if (u.username || u.password || u.port || u.search || u.hash || !/^\d{1,30}$/.test(platformAccountId)) throw new ContractError('VALIDATION_ERROR', '采集目标身份无效');
  const timeout = AbortSignal.timeout(options.timeout), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try { response = await options.fetcher(endpoint, { method: 'GET', headers: { Authorization: 'Bearer ' + options.token }, redirect: 'error', signal: combined }); }
  catch { throw new ContractError('CAPABILITY_UNVERIFIED', '采集请求未完成，请查看任务后再发起新一轮'); }
  if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw new ContractError('AUTH_REQUIRED', 'TikHub 密钥或权限需要核对'); }
  if ([402, 429].includes(response.status)) { await response.body?.cancel(); throw new ContractError('QUOTA_EXHAUSTED', 'TikHub 额度不足或请求受限，本轮停止'); }
  if (!response.ok) { await response.body?.cancel(); throw new ContractError('CAPABILITY_UNVERIFIED', '平台最新作品暂不可读，保留已有内容',{http_status:response.status,endpoint:endpoint.pathname}); }
  const reader = response.body?.getReader(); if (!reader) throw new ContractError('CAPABILITY_UNVERIFIED', '平台响应为空');
  let bytes = 0, raw = ''; const decoder = new TextDecoder();
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 5 * 1024 * 1024) throw new ContractError('CAPABILITY_UNVERIFIED', '作品响应过大，本轮未采用'); raw += decoder.decode(chunk.value, { stream: true }); } raw += decoder.decode(); } finally { await reader.cancel(); }
  raw = raw.replaceAll(options.token, '[REDACTED]').replaceAll(JSON.stringify(options.token).slice(1, -1), '[REDACTED]');
  let body: unknown; try { body = JSON.parse(raw); } catch { throw new ContractError('CAPABILITY_UNVERIFIED', '平台作品响应不是有效 JSON'); }
  const code = Number(obj(body).code); if (![0, 200].includes(code)) throw new ContractError([402, 429].includes(code) ? 'QUOTA_EXHAUSTED' : [401, 403].includes(code) ? 'AUTH_REQUIRED' : 'CAPABILITY_UNVERIFIED', '平台未返回有效作品，本轮停止');
  return { endpoint: endpoint.toString(), raw_body: raw, collected_at: new Date(options.now()).toISOString(), ...parseBenchmarkFeed(platform, url, platformAccountId, body), evidence_kind: options.fixture ? 'internal_rule' : 'real_platform' };
}
