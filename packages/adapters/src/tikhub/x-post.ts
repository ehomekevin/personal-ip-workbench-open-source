import type { JsonObject } from '@workbench/contracts';
import { publicUrl } from './profile.ts';

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const first = (...values: unknown[]) => values.find(value => value !== undefined && value !== null);
const stringId = (value: unknown): string | null => typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
const label = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const handle = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(value) ? value : null;
const count = (value: unknown): string | null => typeof value === 'string' && /^(0|[1-9]\d{0,29})$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
const safeUrl = (value: unknown): string | null => typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value) ? publicUrl(value, true) : null;
const timestamp = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export interface XPostAuthor extends JsonObject { id: string | null; name: string | null; handle: string | null; avatar_url: string | null }
export interface XPostLink extends JsonObject { url: string; expanded_url: string | null; display_url: string | null }
export type XPost = JsonObject & {
  id: string | null; author: XPostAuthor; text: string | null; published_at: string | null; canonical_url: string | null;
  links: XPostLink[]; media: JsonObject[]; availability: 'available' | 'unavailable' | 'unknown';
  quoted_post?: XPost; reposted_post?: XPost; kind?: 'post' | 'quote' | 'repost';
};

export function unwrapXPost(value: unknown): Record<string, any> {
  let row = object(value);
  for (let depth = 0; depth < 4; depth++) {
    if (row.tweet_id || row.id_str || object(row.legacy).id_str || typeof row.text === 'string' || typeof row.full_text === 'string' || typeof object(row.legacy).full_text === 'string') break;
    const nested = first(row.tweet, row.result, object(row.tweet_results).result);
    if (!nested || typeof nested !== 'object') break;
    row = object(nested);
  }
  return row;
}

export function xPostId(value: unknown): string | null {
  const row = unwrapXPost(value), legacy = object(row.legacy);
  return stringId(first(row.tweet_id, row.id_str, legacy.id_str, row.rest_id));
}

function noteResult(row: Record<string, any>): Record<string, any> {
  return object(first(object(object(row.note_tweet).note_tweet_results).result, object(row.note_tweet_results).result));
}
export function xPostText(value: unknown): string | null {
  const row = unwrapXPost(value);
  const text = first(noteResult(row).text, row.full_text, row.text, object(row.legacy).full_text);
  return typeof text === 'string' ? text : null;
}
export function xPostPublishedAt(value: unknown): string | null {
  const row = unwrapXPost(value);
  return timestamp(first(row.created_at, object(row.legacy).created_at));
}

function rawAuthor(value: unknown): Record<string, any> {
  const user = object(value);
  return { ...user, ...object(user.legacy), ...object(user.core) };
}
export function xPostAuthor(value: unknown, profile?: unknown): XPostAuthor {
  const row = unwrapXPost(value), user = rawAuthor(first(row.author, row.user, object(object(row.core).user_results).result));
  const authorId = stringId(first(user.rest_id, user.id_str, user.id)), fallback = rawAuthor(profile);
  // 回执中的同 ID 用户资料只补缺失字段，不能代替每条作品自己的作者证明。
  const trusted = authorId && authorId === stringId(first(fallback.rest_id, fallback.id_str, fallback.id)) ? fallback : {};
  return {
    id: authorId,
    name: label(user.name) ?? label(trusted.name),
    handle: handle(first(user.screen_name, user.username, user.profile)) ?? handle(first(trusted.screen_name, trusted.username, trusted.profile)),
    avatar_url: [user.avatar, object(user.avatar).image_url, user.profile_image_url_https, user.profile_image_url, trusted.avatar, object(trusted.avatar).image_url, trusted.profile_image_url_https].map(safeUrl).find(Boolean) ?? null,
  };
}

export function xPostMetrics(value: unknown): JsonObject {
  const row = unwrapXPost(value), legacy = object(row.legacy);
  return {
    likes: count(first(row.favorites, row.favorite_count, legacy.favorite_count)),
    reposts: count(first(row.retweets, row.retweet_count, legacy.retweet_count)),
    replies: count(first(row.replies, row.reply_count, legacy.reply_count)),
    views: count(typeof row.views === 'object' ? object(row.views).count : row.views),
    bookmarks: count(first(row.bookmarks, legacy.bookmark_count)), quotes: count(first(row.quotes, legacy.quote_count)),
  };
}

export function xPostLinks(value: unknown): XPostLink[] {
  const row = unwrapXPost(value), note = noteResult(row), links = new Map<string, XPostLink>();
  const entities = [object(note.entity_set), object(note.entities), object(row.entities), object(object(row.legacy).entities)];
  for (const entity of entities) for (const entry of Array.isArray(entity.urls) ? entity.urls : []) {
    const item = object(entry), expanded = safeUrl(item.expanded_url), url = safeUrl(item.url) ?? expanded;
    if (url && !links.has(url)) links.set(url, { url, expanded_url: expanded, display_url: label(item.display_url) });
  }
  // 没有 entities 的保存回执仍保留可点击短链；没有平台展开值时不猜目的地。
  for (const match of (xPostText(row) ?? '').matchAll(/https:\/\/[^\s<>"'，。！？）)]+/g)) {
    const url = safeUrl(match[0]);
    if (url && !links.has(url)) links.set(url, { url, expanded_url: null, display_url: null });
  }
  return [...links.values()].slice(0, 100);
}

export function xPostMedia(value: unknown): JsonObject[] {
  const row = unwrapXPost(value), legacy = object(row.legacy), media = object(row.media);
  const entries = [
    ...[row.extended_entities, legacy.extended_entities, row.entities, legacy.entities].flatMap(value => Array.isArray(object(value).media) ? object(value).media : []),
    ...(Array.isArray(row.media) ? row.media : []),
    ...(Array.isArray(media.photo) ? media.photo : Array.isArray(media.photos) ? media.photos : []).map(value => ({ ...object(value), type: 'photo' })),
    ...(Array.isArray(media.video) ? media.video : Array.isArray(media.videos) ? media.videos : []).map(value => ({ ...object(value), type: 'video' })),
  ];
  const normalized = new Map<string, JsonObject>();
  for (const entry of entries.slice(0, 100)) {
    const item = object(entry), type = ['photo', 'image', 'video', 'animated_gif'].includes(item.type) ? item.type : 'image';
    const variants = first(item.variants, object(item.video_info).variants);
    const mp4 = Array.isArray(variants) ? variants.map(object).filter(value => value.content_type === 'video/mp4' && safeUrl(value.url)).sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0))[0] : null;
    const preview = [item.media_url_https, item.preview_url, item.thumbnail_url, item.url].map(safeUrl).find(Boolean) ?? null;
    const play = safeUrl(mp4?.url) ?? safeUrl(item.play_url);
    if (!preview && !play) continue;
    const size = object(first(item.original_info, item.sizes)), medium: JsonObject = {
      type, url: preview, preview_url: preview, play_url: play,
      duration_ms: count(first(item.duration_ms, item.duration, object(item.video_info).duration_millis)),
      width: count(first(size.width, size.w)), height: count(first(size.height, size.h)),
      alt_text: label(first(item.ext_alt_text, item.alt_text)),
    };
    normalized.set(type + ':' + (play ?? preview), medium);
  }
  return [...normalized.values()];
}

function related(row: Record<string, any>, kind: 'quote' | 'repost'): { value: unknown; id: string | null; present: boolean } {
  const legacy = object(row.legacy);
  const value = kind === 'quote'
    ? first(row.quoted, row.quoted_status, row.quoted_status_result, legacy.quoted_status_result, legacy.quoted_status)
    : first(row.retweeted_tweet, row.retweeted_status, row.retweeted_status_result, legacy.retweeted_status_result, legacy.retweeted_status);
  const relatedId = kind === 'quote' ? stringId(first(row.quoted_status_id_str, row.quoted_status_id, legacy.quoted_status_id_str)) : stringId(first(object(row.retweeted).id, row.retweeted_status_id_str, legacy.retweeted_status_id_str));
  return { value, id: xPostId(value) ?? relatedId, present: value !== undefined && value !== null || !!relatedId || kind === 'quote' && first(row.is_quote_status, legacy.is_quote_status) === true };
}

function canonical(id: string | null, author: XPostAuthor, accountHandle?: string): string | null {
  if (!id) return null;
  const authorHandle = author.handle ?? handle(accountHandle);
  return authorHandle ? `https://x.com/${authorHandle}/status/${id}` : `https://x.com/i/status/${id}`;
}

export function projectXPost(value: unknown, options: { profile?: unknown; account_handle?: string; id?: string | null } = {}, depth = 0): XPost {
  const row = unwrapXPost(value), author = xPostAuthor(row, options.profile), id = xPostId(row) ?? options.id ?? null, text = xPostText(row);
  const unavailable = /Unavailable|Tombstone|Deleted/.test(String(row.__typename ?? '')) || row.unavailable === true || row.available === false || ['unavailable', 'deleted', 'not_found'].includes(row.availability);
  const post: XPost = {
    id, author, text: unavailable ? null : text, published_at: xPostPublishedAt(row), canonical_url: canonical(id, author, options.account_handle),
    links: unavailable ? [] : xPostLinks(row), media: unavailable ? [] : xPostMedia(row), availability: unavailable ? 'unavailable' : text !== null ? 'available' : 'unknown',
  };
  if (depth < 3) {
    const quote = related(row, 'quote'), repost = related(row, 'repost');
    if (quote.present) post.quoted_post = projectXPost(quote.value, { profile: options.profile, id: quote.id }, depth + 1);
    if (repost.present) post.reposted_post = projectXPost(repost.value, { profile: options.profile, id: repost.id }, depth + 1);
    post.kind = repost.present ? 'repost' : quote.present ? 'quote' : 'post';
  }
  return post;
}
