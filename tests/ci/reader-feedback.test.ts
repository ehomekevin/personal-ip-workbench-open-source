import test from 'node:test';
import assert from 'node:assert/strict';
import { createTikHubReaderFeedbackAdapter } from '../../packages/adapters/src/tikhub/reader-feedback.ts';
import type { ReaderFeedbackPort, ReaderFeedbackWork } from '../../packages/domain/src/ports/index.ts';

const at = '2026-10-13T12:00:00.000Z', token = 'PRIVATE_READER_TOKEN';
const x: ReaderFeedbackWork = { id: 'owner-work-x', platform: 'x', url: 'https://x.com/owner/status/101', platform_item_id: '101' };
const douyin: ReaderFeedbackWork = { id: 'owner-work-douyin', platform: 'douyin', url: 'https://www.douyin.com/video/201', platform_item_id: '201' };
const reply = (id = '102', parent = '101', text = '我按步骤做了，卡在连接权限。') => ({ tweet_id: id, text, in_reply_to_status_id: parent, created_at: at, author: { name: '读者', screen_name: 'reader' } });
const comment = (cid = '202', text = '这个能减少手工核对吗？') => ({ cid, text, aweme_id: '201', create_time: 1720000000, user: { nickname: '真实读者' }, is_author: false });
const response = (data: unknown, code = 200) => new Response(JSON.stringify({ code, data }));
const adapter = (fetcher: typeof fetch, extra = {}) => createTikHubReaderFeedbackAdapter({ token_provider: () => token, clock: () => Date.parse(at), fetcher, ...extra });

test('X 仅采当前作品的明确回复，保留原文、来源、时间与作者；跨页按平台评论 ID 去重', async () => {
  let calls = 0;
  const port: ReaderFeedbackPort = adapter(async (input, init) => {
    const url = new URL(String(input)); calls++;
    assert.equal(url.origin, 'https://api.tikhub.io'); assert.equal(url.pathname, '/api/v1/twitter/web/fetch_post_comments');
    assert.equal(url.searchParams.get('tweet_id'), '101'); assert.equal(url.searchParams.has('count'), false);
    assert.equal(init!.method, 'GET'); assert.equal(init!.redirect, 'error'); assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer ' + token);
    assert.ok(init!.signal);
    if (calls === 1) {
      assert.equal(url.searchParams.has('cursor'), false);
      return response({ comments: [reply(), reply('103', '999'), { ...reply('104'), in_reply_to_status_id: undefined },
        { ...reply('105'), quoted: reply('106') }, { ...reply('107'), author: { screen_name: 'OWNER', name: '作者' } }], next_cursor: 'next-1', has_more: true });
    }
    assert.equal(url.searchParams.get('cursor'), 'next-1');
    return response({ comments: [reply(), reply('108', '101', '第一行\n第二行')], has_more: false });
  });
  const result = await port.collect(x);
  assert.equal(result.status, 'collected'); assert.equal(calls, 2);
  assert.deepEqual(result.feedback.map(row => row.id), ['x:102', 'x:105', 'x:107', 'x:108']);
  assert.deepEqual(result.feedback[0], { id: 'x:102', kind: 'response', text: '我按步骤做了，卡在连接权限。', provenance: 'platform',
    work_id: x.id, work_url: x.url, platform_comment_id: '102', source: 'https://x.com/reader/status/102', recorded_at: at, commented_at: at, author_name: '读者', is_author: false });
  assert.equal(result.feedback[2]!.is_author, true); assert.equal(result.feedback[3]!.text, '第一行\n第二行');
  assert.ok(result.limitations.some(value => value.includes('其他作品回复'))); assert.ok(result.limitations.some(value => value.includes('未明确关联')));
});

test('X 原始 timeline envelope 不采引用帖；Bottom 游标驱动补采', async () => {
  let calls = 0;
  const result = await adapter(async input => {
    calls++; assert.equal(new URL(String(input)).searchParams.get('cursor'), calls === 1 ? null : 'graph-next');
    const tweet = { rest_id: '109', legacy: { id_str: '109', full_text: '原始 X 回复', in_reply_to_status_id_str: '101', created_at: at },
      core: { user_results: { result: { legacy: { screen_name: 'reader', name: '图谱读者' } } } }, quoted_status_result: { result: reply('999') } };
    return response({ threaded_conversation_with_injections_v2: { instructions: [{ entries: calls === 1
      ? [{ content: { itemContent: { tweet_results: { result: tweet } } } }, { content: { cursorType: 'Bottom', value: 'graph-next' } }]
      : [] }] } });
  }).collect(x);
  assert.equal(result.status, 'collected'); assert.equal(calls, 2); assert.deepEqual(result.feedback.map(row => row.id), ['x:109']);
  assert.equal(result.feedback[0]!.author_name, '图谱读者');
});

test('抖音用已登记本人作品 ID，保留未知时间与作者标记，不把 author_digg 当作者身份', async () => {
  let calls = 0;
  const result = await adapter(async input => {
    const url = new URL(String(input)); calls++; assert.equal(url.pathname, '/api/v1/douyin/web/fetch_video_comments');
    assert.equal(url.searchParams.get('aweme_id'), '201'); assert.equal(url.searchParams.get('count'), '20');
    assert.equal(url.searchParams.get('cursor'), calls === 1 ? '0' : '20');
    return response({ data: { status_code: 0, comments: calls === 1 ? [comment(), { ...comment('203'), is_author: undefined, create_time: undefined, author_digg: 1 }]
      : [comment(), { ...comment('204'), is_author: true }], cursor: 20, has_more: calls === 1 ? 1 : 0 } });
  }).collect(douyin);
  assert.equal(result.status, 'collected'); assert.equal(calls, 2); assert.deepEqual(result.feedback.map(row => row.id), ['douyin:202', 'douyin:203', 'douyin:204']);
  assert.equal(result.feedback[0]!.source, douyin.url); assert.equal(result.feedback[0]!.work_url, douyin.url); assert.equal(result.feedback[0]!.author_name, '真实读者');
  assert.equal(result.feedback[0]!.commented_at, new Date(1720000000000).toISOString());
  assert.equal(result.feedback[1]!.commented_at, null); assert.equal(result.feedback[1]!.is_author, null); assert.equal(result.feedback[2]!.is_author, true);
});

test('无评论只由成功且可识别的空列表产生；不支持平台与无凭据不发请求', async () => {
  let calls = 0; const fetcher: typeof fetch = async () => { calls++; return response({ comments: [], has_more: false }); };
  assert.equal((await adapter(fetcher).collect(x)).status, 'empty'); assert.equal((await adapter(fetcher).collect(douyin)).status, 'empty');
  const unsupported = await adapter(fetcher).collect({ ...x, platform: 'bilibili' }); assert.equal(unsupported.status, 'unsupported'); assert.deepEqual(unsupported.feedback, []);
  assert.equal((await createTikHubReaderFeedbackAdapter({ fetcher, token_provider: () => null }).collect(x)).status, 'unavailable'); assert.equal(calls, 2);
});

test('错误响应、无权限、额度与网络失败均为 unavailable，不冒充空评论', async () => {
  for (const status of [401, 403, 402, 429, 500]) {
    let calls = 0; const result = await adapter(async () => { calls++; return new Response('', { status }); }).collect(x);
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.feedback, []); assert.equal(calls, 1); assert.ok(result.limitations.some(value => value.includes(String(status))));
  }
  for (const body of [response(null), response({ unknown: [] }), response({ timeline: [{ unexpected: 'bad' }] }), response({ instructions: [{ unexpected: 'bad' }] }), response({ comments: null }), response({ comments: [] }, 401),
    response({ comments: [], status_code: 1 }), response({ comments: [], success: false }),
    response({ data: { comments: [], success: false } }), response({ data: { comments: [], errors: [{ message: 'denied' }] } }),
    response({ status_code: 0, data: { comments: [], status_code: 1 } }), response({ data: { comments: [], get_data_succ: 0 } }), new Response('{bad')]) {
    const result = await adapter(async () => body).collect(x); assert.equal(result.status, 'unavailable'); assert.deepEqual(result.feedback, []);
  }
  const result = await adapter(async () => { throw new Error('network ' + token); }).collect(x); assert.equal(result.status, 'unavailable'); assert.ok(!JSON.stringify(result).includes(token));
  for (const code of [null, false, '', [], {}, undefined]) {
    const result = await adapter(async () => new Response(JSON.stringify({ code, data: { comments: [], has_more: false } }))).collect(x);
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.feedback, []);
  }
});

test('后续页失败保留已经核对的评论，同时显式返回 unavailable', async () => {
  let calls = 0; const result = await adapter(async () => ++calls === 1 ? response({ comments: [reply()], next_cursor: 'next', has_more: true }) : new Response('', { status: 402 })).collect(x);
  assert.equal(result.status, 'unavailable'); assert.equal(result.feedback.length, 1); assert.equal(calls, 2); assert.ok(result.limitations.some(value => value.includes('402')));
});

test('翻页次数有硬上限，重复或缺失游标停止，不产生重复评论', async () => {
  let calls = 0;
  const limited = await adapter(async () => { calls++; return response({ comments: [comment()], cursor: calls * 20, has_more: 1 }); }, { max_pages: 2 }).collect(douyin);
  assert.equal(calls, 2); assert.equal(limited.status, 'collected'); assert.equal(limited.feedback.length, 1); assert.ok(limited.limitations.some(value => value.includes('2 页上限')));
  calls = 0; const repeated = await adapter(async () => { calls++; return response({ comments: [reply()], next_cursor: 'same', has_more: true }); }, { max_pages: 5 }).collect(x);
  assert.equal(calls, 2); assert.equal(repeated.status, 'unavailable'); assert.equal(repeated.feedback.length, 1); assert.ok(repeated.limitations.some(value => value.includes('游标重复')));
  const invalid = await adapter(async () => response({ comments: [comment()], cursor: 'bad', has_more: 1 })).collect(douyin);
  assert.equal(invalid.status, 'unavailable'); assert.equal(invalid.feedback.length, 1); assert.ok(invalid.limitations.some(value => value.includes('有效游标')));
  const incompleteEmpty = await adapter(async () => response({ comments: [], cursor: 20, has_more: 1 }), { max_pages: 1 }).collect(douyin);
  assert.equal(incompleteEmpty.status, 'unavailable'); assert.deepEqual(incompleteEmpty.feedback, []);
});

test('无效、错平台、错作品与不安全 ID 在请求前拦截；只 ID 或明确链接可定位', async () => {
  let calls = 0; const read = adapter(async () => { calls++; return response({ comments: [], has_more: false }); });
  for (const work of [{ ...x, platform_item_id: '999' }, { ...x, url: 'https://evil.example/owner/status/101' },
    { ...x, url: 'https://x.com@evil.example/owner/status/101' }, { ...x, url: 'https://x.com/owner/status/101', platform_item_id: '9007199254740992oops' },
    { ...x, url: null, platform_item_id: null }, { ...douyin, url: x.url }]) assert.equal((await read.collect(work)).status, 'unavailable');
  assert.equal(calls, 0); assert.equal((await read.collect({ ...x, url: null })).status, 'empty'); assert.equal((await read.collect({ ...x, platform_item_id: null })).status, 'empty'); assert.equal(calls, 2);
});

test('缺少关联、无效原文与不安全数字不能生成平台评论，也不能伪装成无评论', async () => {
  for (const row of [{ ...reply(), in_reply_to_status_id: undefined }, { ...reply(), tweet_id: 9007199254740992 }, { ...reply(), text: '' }, { ...reply(), text: '字'.repeat(12001) }, { description: 'AI 补全不是评论' }]) {
    const result = await adapter(async () => response({ comments: [row], has_more: false })).collect(x); assert.equal(result.status, 'unavailable'); assert.deepEqual(result.feedback, []);
  }
  const foreign = await adapter(async () => response({ comments: [comment('203'), { ...comment('204'), aweme_id: '999' }], has_more: 0 })).collect(douyin);
  assert.equal(foreign.feedback.length, 1); assert.equal(foreign.feedback[0]!.work_id, douyin.id);
});

test('取消信号停止请求，组合信号传播且响应中断不会变成 empty', async () => {
  let calls = 0; const aborted = new AbortController(); aborted.abort();
  const result = await adapter(async () => { calls++; return response({ comments: [], has_more: false }); }).collect(x, { signal: aborted.signal });
  assert.equal(result.status, 'unavailable'); assert.equal(calls, 0);
  const during = new AbortController(); const interrupted = await adapter(async (_input, init) => { assert.equal(init!.signal!.aborted, false); during.abort(); assert.equal(init!.signal!.aborted, true); return response({ comments: [reply()], has_more: false }); }).collect(x, { signal: during.signal });
  assert.equal(interrupted.status, 'unavailable'); assert.deepEqual(interrupted.feedback, []);
});

test('流式响应有大小限制，供应商回显凭据先脱敏', async () => {
  const sanitized = await adapter(async () => response({ comments: [reply('102', '101', '回显 ' + token)], has_more: false })).collect(x);
  assert.equal(sanitized.feedback[0]!.text, '回显 [REDACTED]'); assert.ok(!JSON.stringify(sanitized).includes(token));
  let cancelled = false;
  const oversized = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } }));
  const result = await adapter(async () => oversized).collect(x); assert.equal(result.status, 'unavailable'); assert.ok(cancelled); assert.ok(result.limitations.some(value => value.includes('2 MiB')));
});

test('采集配置拒绝无限分页、过长超时和任意凭据引用', () => {
  for (const options of [{ max_pages: 0 }, { max_pages: 6 }, { max_pages: 1.5 }, { page_size: 51 }, { timeout_ms: 60001 }, { token_env: 'path/to/secret' }])
    assert.throws(() => createTikHubReaderFeedbackAdapter(options), { code: 'VALIDATION_ERROR' });
});
