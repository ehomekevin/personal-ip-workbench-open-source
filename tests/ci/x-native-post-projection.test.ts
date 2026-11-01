import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SourceRecordPayload } from '../../packages/contracts/src/index.ts';
import { BENCHMARK_FEED_VERSION, parseBenchmarkFeed } from '../../packages/adapters/src/tikhub/benchmark-feed.ts';
import type { XPost } from '../../packages/adapters/src/tikhub/x-post.ts';
import { projectSavedBenchmarkMaterials } from '../../packages/domain/src/sources/material-reprojection.ts';
import { benchmarkMediaSummary } from '../../packages/storage/src/sources/index.ts';
import { sha256 } from '../../packages/storage/src/connection/index.ts';

const saved = JSON.parse(readFileSync(new URL('./fixtures/x-post-saved-shapes.json', import.meta.url), 'utf8'));
const at = '2026-10-13T00:00:00Z', accountUrl = 'https://x.com/bench';
const tweet = (fields: Record<string, unknown> = {}) => ({ tweet_id: '101', text: '主账号的评论', created_at: at, author: { rest_id: '123', name: '主账号', screen_name: 'bench', avatar: 'https://pbs.twimg.com/bench.jpg' }, favorites: 0, ...fields });
const parse = (rows: unknown[], profile?: unknown) => parseBenchmarkFeed('x', accountUrl, '123', { data: { timeline: rows, user: profile } });
const xPost = (payload: SourceRecordPayload) => payload.provider_metadata.x_post as XPost;

test('保存的合成作者1回复原样保留正文、身份、时间和两条实体展开链接', () => {
  const result = parseBenchmarkFeed('x', 'https://x.com/fixture_author1', '9000000000000000001', saved.sampleAuthor);
  const record = result.records.find(row => row.external_id === '9000000000000000002')!, post = xPost(record.payload);
  assert.equal(BENCHMARK_FEED_VERSION, 'benchmark-feed/6');
  assert.equal(post.kind, 'post'); assert.equal(post.availability, 'available');
  assert.equal(record.payload.author_name, '合成作者1');
  assert.deepEqual(post.author, { id: '9000000000000000001', name: '合成作者1', handle: 'fixture_author1', avatar_url: saved.sampleAuthor.data.user.avatar });
  assert.equal(post.text, '合成测试正文 1：用于验证回复、引用及转发结构。');
  assert.equal(record.payload.body, post.text); assert.equal(record.published_at, '2024-01-02T12:00:00.000Z');
  assert.equal(post.canonical_url, record.canonical_url); assert.equal(record.payload.provider_metadata.in_reply_to_work_id, '9000000000000000003');
  assert.deepEqual(post.links, [
    { url: 'https://example.invalid/url-1', expanded_url: 'https://example.invalid/expanded_url-1', display_url: 'example.invalid/source-1' },
    { url: 'https://example.invalid/url-2', expanded_url: 'https://example.invalid/expanded_url-2', display_url: 'example.invalid/source-2' },
  ]);
  assert.deepEqual(post.media, []); assert.deepEqual(record.payload.media, []);
  assert.ok(record.payload.external_links.includes(post.links[0]!.expanded_url!));
  assert.equal((record.payload.provider_metadata.metrics as any).likes, '0');
});

test('同批保存的引用保留原推正文与媒体，主账号评论和指标仍属于外层', () => {
  const raw = saved.sampleAuthor.data.timeline[1], record = parseBenchmarkFeed('x', 'https://x.com/fixture_author1', '9000000000000000001', saved.sampleAuthor).records.find(row => row.external_id === raw.tweet_id)!;
  const post = xPost(record.payload), quoted = post.quoted_post!;
  assert.equal(post.kind, 'quote'); assert.equal(record.payload.body, raw.text);
  assert.equal(quoted.text, raw.quoted.text); assert.equal(quoted.id, raw.quoted.tweet_id); assert.equal(quoted.availability, 'available');
  assert.equal(quoted.media.length, 1); assert.equal(record.payload.media.length, 0);
  assert.equal((record.payload.provider_metadata.metrics as any).likes, String(raw.favorites));
  assert.notEqual((record.payload.provider_metadata.metrics as any).likes, String(raw.quoted.favorites));
  assert.equal(benchmarkMediaSummary(record.payload).preview_url, quoted.media[0]!.preview_url);
  assert.equal(benchmarkMediaSummary(record.payload).media_type, 'text', '原推媒体不冒充主账号上传的图片');
  const withOwnVideo = parseBenchmarkFeed('x', 'https://x.com/fixture_author1', '9000000000000000001', saved.sampleAuthor).records.find(row => row.external_id === saved.sampleAuthor.data.timeline[2].tweet_id)!;
  assert.equal(benchmarkMediaSummary(withOwnVideo.payload).preview_url, withOwnVideo.payload.media[0]!.preview_url, '外层封面优先');
});

test('note 正文优先且完整保留；legacy 和可见性包装中的引用独立解析作者、链接、媒体', () => {
  const fullText = '主帖完整正文\n' + '完整内容'.repeat(150) + '\nhttps://t.co/full', quoteText = '引用的完整长文\n' + '原作者'.repeat(120);
  const original = {
    __typename: 'Tweet', rest_id: '909', legacy: { id_str: '909', full_text: '引用短摘要', created_at: at },
    core: { user_results: { result: { rest_id: '456', legacy: { name: '原作者', screen_name: 'original', profile_image_url_https: 'https://pbs.twimg.com/original.jpg' } } } },
    note_tweet: { note_tweet_results: { result: { text: quoteText } } },
    legacy_extra: '不传递任意 provider 字段',
    media: { photo: [{ media_url_https: 'https://pbs.twimg.com/quote.jpg', sizes: { w: 640, h: 360 }, ext_alt_text: '引用插图' }] },
  };
  const row = { __typename: 'TweetWithVisibilityResults', tweet: {
    rest_id: '101', legacy: { id_str: '101', full_text: '主帖短摘要', created_at: at },
    core: { user_results: { result: { rest_id: '123', legacy: { name: '主账号', screen_name: 'bench', profile_image_url_https: 'https://pbs.twimg.com/bench.jpg' } } } },
    note_tweet: { note_tweet_results: { result: { text: fullText, entity_set: { urls: [{ url: 'https://t.co/full', expanded_url: 'https://example.com/full', display_url: 'example.com/full' }] } } } },
    quoted_status_result: { result: { __typename: 'TweetWithVisibilityResults', tweet: original } },
  } };
  const record = parse([row]).records[0]!, post = xPost(record.payload), quoted = post.quoted_post!;
  assert.equal(record.payload.body, fullText); assert.equal(post.text, fullText); assert.equal(quoted.text, quoteText);
  assert.equal(post.author.name, '主账号'); assert.equal(quoted.author.name, '原作者'); assert.equal(quoted.author.handle, 'original');
  assert.equal(quoted.author.avatar_url, 'https://pbs.twimg.com/original.jpg'); assert.equal(quoted.canonical_url, 'https://x.com/original/status/909');
  assert.equal(post.links[0]!.expanded_url, 'https://example.com/full'); assert.equal(quoted.media[0]!.width, '640');
  assert.equal(quoted.media[0]!.alt_text, '引用插图'); assert.equal(record.payload.media.length, 0);
  assert.equal(post.legacy_extra, undefined);
});

test('可验证的真实转推保留外层归属；没有外层作者证明和只有 RT 字符串时跳过', () => {
  const row = saved.repost.data.timeline[0], profile = saved.repost.data.user;
  const result = parseBenchmarkFeed('x', 'https://x.com/' + profile.profile, profile.rest_id, saved.repost), record = result.records[0]!, post = xPost(record.payload);
  assert.equal(result.records.length, 1); assert.equal(post.kind, 'repost'); assert.equal(post.author.id, profile.rest_id);
  assert.equal(record.external_id, row.tweet_id); assert.equal(post.text, row.text); assert.equal(record.payload.author_name, profile.name);
  assert.equal(post.reposted_post!.id, row.retweeted_tweet.tweet_id); assert.equal(post.reposted_post!.text, row.retweeted_tweet.text);
  assert.equal(post.reposted_post!.author.id, row.retweeted_tweet.author.rest_id); assert.equal(post.reposted_post!.author.name, null);
  assert.equal(post.reposted_post!.quoted_post!.id, row.retweeted_tweet.quoted.tweet_id);
  assert.equal((record.payload.provider_metadata.metrics as any).likes, String(row.favorites));
  assert.equal(post.reposted_post!.canonical_url, 'https://x.com/i/status/' + row.retweeted_tweet.tweet_id);
  for (const author of [undefined, { rest_id: '999' }, { screen_name: profile.profile }]) {
    const bad = parseBenchmarkFeed('x', 'https://x.com/' + profile.profile, profile.rest_id, { data: { user: profile, timeline: [{ ...row, author }] } });
    assert.equal(bad.records.length, 0); assert.equal(bad.skipped, 1);
  }
  assert.equal(parse([tweet({ text: 'RT @original: 没有原推回执' })]).records.length, 0);
  assert.equal(parse([tweet({ text: null, quoted: tweet({ tweet_id: '202' }) })]).records.length, 0, '缺失外层正文时不把内部引用提升成新作品');
});

test('缺失的引用和平台明确不可用的引用保留状态、ID和原文入口', () => {
  const unavailable = parse([tweet({ quoted_status_id_str: '909', quoted_status_result: { result: { __typename: 'TweetUnavailable', reason: 'Deleted' } } })]).records[0]!, post = xPost(unavailable.payload);
  assert.equal(post.kind, 'quote'); assert.equal(post.quoted_post!.id, '909'); assert.equal(post.quoted_post!.availability, 'unavailable');
  assert.equal(post.quoted_post!.canonical_url, 'https://x.com/i/status/909'); assert.equal(post.quoted_post!.text, null);
  assert.deepEqual(post.quoted_post!.media, []);
  const missing = xPost(parse([tweet({ quoted_status_id_str: '909', is_quote_status: true })]).records[0]!.payload).quoted_post!;
  assert.equal(missing.availability, 'unknown'); assert.equal(missing.text, null);
});

test('同 ID 资料可补主账号缺项，异作者引用和危险 URL 不继承主账号资料', () => {
  const profile = { rest_id: '123', name: '已核对主账号', profile: 'bench', avatar: 'https://pbs.twimg.com/profile.jpg' };
  const row = tweet({ author: { rest_id: '123', name: null, screen_name: null, avatar: null }, quoted: { tweet_id: '909', text: '原作者正文', author: { rest_id: '456', avatar: 'javascript:alert(1)' } }, entities: { urls: [
    { url: 'https://t.co/safe', expanded_url: 'javascript:alert(1)' },
    { url: 'https://t.co/credentials', expanded_url: 'https://user:secret@example.com/private' },
    { url: 'javascript:alert(1)', expanded_url: 'javascript:alert(1)' },
    { url: 'https://t.co/control', expanded_url: 'https://example.com/\nsecret' },
  ] }, media: { photo: [{ media_url_https: 'javascript:alert(1)' }], video: [{ media_url_https: 'https://pbs.twimg.com/safe.jpg', variants: [{ content_type: 'video/mp4', url: 'https://user:secret@video.twimg.com/private.mp4' }, { content_type: 'video/mp4', url: 'https://video.twimg.com/safe.mp4' }] }] } });
  const post = xPost(parse([row], profile).records[0]!.payload);
  assert.equal(post.author.name, profile.name); assert.equal(post.author.avatar_url, profile.avatar);
  assert.deepEqual(post.quoted_post!.author, { id: '456', name: null, handle: null, avatar_url: null });
  assert.equal(post.quoted_post!.canonical_url, 'https://x.com/i/status/909');
  assert.equal(post.links.length, 3); assert.ok(post.links.every(link => link.expanded_url === null));
  assert.equal(post.media.length, 1); assert.equal(post.media[0]!.play_url, 'https://video.twimg.com/safe.mp4');
  const mismatched = xPost(parse([row], { ...profile, rest_id: '456' }).records[0]!.payload);
  assert.equal(mismatched.author.name, null); assert.equal(mismatched.author.avatar_url, null);
});

test('保存 raw 回投影更新 X 结构，保留人工正文、标题、作者名、出处和整理字段', () => {
  const body = { data: { timeline: [tweet({ quoted: { tweet_id: '909', text: '原推正文', author: { rest_id: '456', name: '原作者', screen_name: 'original' }, media: { photo: [{ media_url_https: 'https://pbs.twimg.com/quote.jpg' }] } } })] } };
  const parsed = parseBenchmarkFeed('x', accountUrl, '123', body).records[0]!, existing: SourceRecordPayload = {
    ...parsed.payload, title: '人工标题', summary: '人工摘要', body: '人工全文及解读', author_name: '人工已核对作者',
    quoted_author_name: '人工引用标注', external_links: ['https://example.com/editorial'],
    media: [{ type: 'image', path: '/saved/local.jpg', asset_id: 'local-asset' }],
    provider_metadata: { curation: { selected: true }, source_name: '人工出处', body_parser_version: 'old-body/1', x_post: { text: '旧平台短摘要' } },
  };
  const raw = JSON.stringify(body), input = { platform: 'x' as const, account_url: accountUrl, platform_account_id: '123', raw_body: raw, raw_sha256: sha256(raw), evidence_kind: 'real_platform' as const, existing: [{ external_id: '101', canonical_url: parsed.canonical_url!, payload: existing }] };
  const before = structuredClone(existing), projected = projectSavedBenchmarkMaterials(input)[0]!;
  assert.equal(projected.changed, true); assert.equal(xPost(projected.payload).text, '主账号的评论');
  assert.equal(xPost(projected.payload).quoted_post!.text, '原推正文'); assert.equal(projected.payload.provider_metadata.quoted_author, '原作者');
  assert.equal(projected.summary.preview_url, 'https://pbs.twimg.com/quote.jpg');
  for (const field of ['title', 'summary', 'body', 'author_name', 'quoted_author_name', 'external_links', 'parser_warnings'] as const) assert.deepEqual(projected.payload[field], before[field]);
  for (const field of ['curation', 'source_name', 'body_parser_version']) assert.deepEqual(projected.payload.provider_metadata[field], before.provider_metadata[field]);
  assert.equal(projected.payload.media.length, 1); assert.equal(projected.payload.media[0]!.asset_id, 'local-asset');
  assert.deepEqual(existing, before);
  assert.equal(projectSavedBenchmarkMaterials({ ...input, existing: [{ ...input.existing[0]!, payload: projected.payload }] })[0]!.changed, false);
});
