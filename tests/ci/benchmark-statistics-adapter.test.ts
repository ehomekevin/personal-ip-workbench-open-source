import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../../packages/contracts/src/errors.ts';
import {
  BENCHMARK_STATISTICS_ENDPOINT, BenchmarkStatisticsAdapter, parseBenchmarkStatistics,
  type BenchmarkStatisticsOptions,
} from '../../packages/adapters/src/tikhub/benchmark-statistics.ts';

const aweme = '7695964257132891434', second = '7448118827402972455';
const collectedAt = '2026-10-13T12:08:12.466Z';
const raw = (rows: unknown[]) => JSON.stringify({ code: 200, data: { statistics_list: rows } });
const valid = raw([{ aweme_id: aweme, play_count: 215879 }]);
function adapter(fetcher: typeof fetch, options: Partial<BenchmarkStatisticsOptions> = {}) {
  return new BenchmarkStatisticsAdapter({ token_provider: () => 'test-only-secret', fetcher,
    fixture: true, clock: () => Date.parse(collectedAt), ...options });
}

test('统计客户端仅 GET 官方批量端点，精确传递 requested IDs 且 fixture 标为 internal_rule', async () => {
  let calls = 0;
  const client = adapter(async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, BENCHMARK_STATISTICS_ENDPOINT);
    assert.equal(url.searchParams.get('aweme_ids'), aweme + ',' + second);
    assert.deepEqual([...url.searchParams.keys()], ['aweme_ids']);
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-only-secret');
    assert.equal(init?.body, undefined); assert.ok(init?.signal);
    return new Response(raw([{ aweme_id: second, play_count: '0' }, { aweme_id: aweme, play_count: 215879 }]));
  });
  const result = await client.fetch([aweme, second]);
  assert.equal(calls, 1); assert.equal(result.collected_at, collectedAt);
  assert.equal(result.evidence_kind, 'internal_rule');
  assert.deepEqual(result.statistics, [{ aweme_id: second, play_count: '0' }, { aweme_id: aweme, play_count: '215879' }]);
  assert.deepEqual(parseBenchmarkStatistics(result.raw_body, [aweme, second]), result.statistics);
});

test('默认 evidence kind 为 real_platform，fixture 不能使用默认网络 fetcher', async () => {
  const result = await adapter(async () => new Response(valid), { fixture: false }).fetch([aweme]);
  assert.equal(result.evidence_kind, 'real_platform');
  assert.throws(() => new BenchmarkStatisticsAdapter({ token_provider: () => 'fixture', fixture: true }), { code: 'VALIDATION_ERROR' });
});

test('空、超额、重复、非数字和非字符串 IDs 均在 fetch 之前拒绝', async () => {
  let calls = 0;
  const client = adapter(async () => { calls++; return new Response(valid); });
  const invalid: unknown[] = [[], [aweme, aweme], [''], ['123,456'], [' 123'], ['123\n'], ['-1'], ['1'.repeat(31)], [123], new Array(1), Array.from({ length: 51 }, (_, index) => String(index)), '123', null];
  for (const ids of invalid) await assert.rejects(client.fetch(ids as string[]), { code: 'VALIDATION_ERROR' });
  assert.equal(calls, 0);
});

test('恰好 50 个 ID 可以一次请求；fetch 冻结调用时 IDs，忽略调用方后续数组变更', async () => {
  const ids = Array.from({ length: 50 }, (_, index) => String(index));
  const client = adapter(async input => {
    assert.equal(new URL(String(input)).searchParams.get('aweme_ids'), ids.join(','));
    return new Response(raw(ids.map(aweme_id => ({ aweme_id, play_count: 0 }))));
  });
  assert.equal((await client.fetch(ids)).statistics.length, 50);
  const mutable = [aweme]; let release: (response: Response) => void = () => {};
  const waiting = adapter(async () => new Promise<Response>(resolve => { release = resolve; })).fetch(mutable);
  mutable[0] = second;
  release(new Response(valid));
  assert.equal((await waiting).statistics[0]!.aweme_id, aweme);
});

test('凭据由 token_provider 获取，空白视为缺失，不请求 provider', async () => {
  let token: string | null = null, calls = 0;
  const client = adapter(async () => { calls++; return new Response(valid); }, { token_provider: () => token });
  assert.equal(client.credentialPresent(), false);
  await assert.rejects(client.fetch([aweme]), { code: 'AUTH_REQUIRED' });
  token = ' \t'; assert.equal(client.credentialPresent(), false);
  await assert.rejects(client.fetch([aweme]), { code: 'AUTH_REQUIRED' });
  assert.equal(calls, 0);
  token = '  supplied-only-token  '; assert.equal(client.credentialPresent(), true);
  await client.fetch([aweme]); assert.equal(calls, 1);
});

test('播放数只接受非负 safeInteger 或至多 30 位十进制规范字符串，真实 0 保留', () => {
  const values: unknown[] = [0, 215879, Number.MAX_SAFE_INTEGER, '0', '9'.repeat(30),
    undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '00', '01', '1.0', '1e3', '+1', '-1', '1 ', '9'.repeat(31), true, {}];
  const stats = parseBenchmarkStatistics(raw(values.map((play_count, index) => ({ aweme_id: String(index), play_count }))));
  assert.deepEqual(stats.map(row => row.play_count), ['0', '215879', String(Number.MAX_SAFE_INTEGER), '0', '9'.repeat(30), ...Array<string | null>(15).fill(null)]);
});

test('缺失或无效 ID 无法归属作品，缺失 requested ID 不凭空制造 0', async () => {
  const body = raw([{ aweme_id: aweme }, { play_count: 13 }, { aweme_id: 123, play_count: 9 }, null, { aweme_id: 'bad-id', play_count: 8 }]);
  const result = await adapter(async () => new Response(body)).fetch([aweme, second]);
  assert.deepEqual(result.statistics, [{ aweme_id: aweme, play_count: null }]);
  assert.deepEqual(parseBenchmarkStatistics(raw([]), [aweme]), []);
});

test('重复 ID 或未请求的精确 ID 拒绝整份响应，不能按顺序或相似 ID 归属', async () => {
  for (const rows of [
    [{ aweme_id: aweme, play_count: 1 }, { aweme_id: aweme, play_count: 2 }],
    [{ aweme_id: aweme, play_count: 1 }, { aweme_id: second, play_count: 2 }],
    [{ aweme_id: '0' + aweme, play_count: 1 }],
  ]) await assert.rejects(adapter(async () => new Response(raw(rows))).fetch([aweme]), { code: 'CAPABILITY_UNVERIFIED' });
  assert.throws(() => parseBenchmarkStatistics(raw([{ aweme_id: aweme }, { aweme_id: aweme }])), { code: 'CAPABILITY_UNVERIFIED' });
});

test('只支持 root.data.statistics_list，不猜其它响应路径或 data:null', async () => {
  for (const body of [
    { code: 200, data: null }, { code: 200, statistics_list: [{ aweme_id: aweme, play_count: 1 }] },
    { code: 200, data: { statistics: [{ aweme_id: aweme, play_count: 1 }] } },
    { code: 200, data: { data: { statistics_list: [{ aweme_id: aweme, play_count: 1 }] } } },
  ]) await assert.rejects(adapter(async () => new Response(JSON.stringify(body))).fetch([aweme]), { code: 'CAPABILITY_UNVERIFIED' });
  await assert.rejects(adapter(async () => new Response('not JSON')).fetch([aweme]), { code: 'CAPABILITY_UNVERIFIED' });
  assert.throws(() => parseBenchmarkStatistics(raw(Array.from({ length: 51 }, (_, index) => ({ aweme_id: String(index) })))), { code: 'CAPABILITY_UNVERIFIED' });
});

test('HTTP 401/403 与 402/429 保留不同错误，无自动 retry，取消错误响应 body', async () => {
  for (const status of [401, 403, 402, 429, 500]) {
    let calls = 0, cancelled = 0;
    const client = adapter(async () => {
      calls++;
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { status });
    });
    await assert.rejects(client.fetch([aweme]), error => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.code, [401, 403].includes(status) ? 'AUTH_REQUIRED' : [402, 429].includes(status) ? 'QUOTA_EXHAUSTED' : 'CAPABILITY_UNVERIFIED');
      assert.equal(error.details.http_status, status); assert.equal(error.retryable, false); return true;
    });
    assert.equal(calls, 1); assert.equal(cancelled, 1);
  }
});

test('HTTP 200 中 provider 错误码与显式额度错误不会冒充成功', async () => {
  for (const code of [401, '403', 402, '429', 500, 0, undefined]) {
    let calls = 0;
    await assert.rejects(adapter(async () => { calls++; return new Response(JSON.stringify({ code, data: { statistics_list: [{ aweme_id: aweme, play_count: 0 }] } })); }).fetch([aweme]),
      { code: [401, '403'].includes(code!) ? 'AUTH_REQUIRED' : [402, '429'].includes(code!) ? 'QUOTA_EXHAUSTED' : 'CAPABILITY_UNVERIFIED' });
    assert.equal(calls, 1);
  }
  for (const message of ['Quota exhausted', 'Insufficient balance', '余额不足', '额度已用完']) {
    await assert.rejects(adapter(async () => new Response(JSON.stringify({ code: 500, message }))).fetch([aweme]), { code: 'QUOTA_EXHAUSTED' });
  }
});

test('raw body 遮蔽原 token 与 JSON escaped token；网络错误不透传含凭据的异常', async () => {
  const token = 'fixture-"token\\path';
  const body = JSON.stringify({ code: 200, data: { statistics_list: [{ aweme_id: aweme, play_count: 0 }] }, echo: token, nested: JSON.stringify(token) });
  const result = await adapter(async () => new Response(body), { token_provider: () => token }).fetch([aweme]);
  assert.equal(result.raw_body.includes(token), false);
  assert.equal(result.raw_body.includes(JSON.stringify(token).slice(1, -1)), false);
  assert.equal(JSON.parse(result.raw_body).echo, '[REDACTED]');
  assert.equal(result.statistics[0]!.play_count, '0');
  await assert.rejects(adapter(async () => { throw new Error('provider failed ' + token); }, { token_provider: () => token }).fetch([aweme]), error => {
    assert.ok(error instanceof ContractError); assert.equal(error.code, 'CAPABILITY_UNVERIFIED');
    assert.equal(error.message.includes(token), false); assert.equal(JSON.stringify(error.details).includes(token), false);
    assert.equal(error.cause, undefined); return true;
  });
});

test('5 MiB 限制在流读取时执行并取消 body，不依赖 Content-Length', async () => {
  const limit = 5 * 1024 * 1024; let cancelled = 0;
  const client = adapter(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled++; },
  })));
  await assert.rejects(client.fetch([aweme]), { code: 'CAPABILITY_UNVERIFIED' }); assert.equal(cancelled, 1);
  await assert.rejects(adapter(async () => new Response(valid, { headers: { 'content-length': String(limit + 1) } })).fetch([aweme]), { code: 'CAPABILITY_UNVERIFIED' });
  assert.throws(() => parseBenchmarkStatistics(' '.repeat(limit + 1)), { code: 'CAPABILITY_UNVERIFIED' });
  const padded = JSON.stringify({ code: 200, data: { statistics_list: [{ aweme_id: aweme, play_count: 0 }] }, padding: '' });
  const boundary = padded.replace('"padding":""', '"padding":"' + 'a'.repeat(limit - Buffer.byteLength(padded)) + '"');
  assert.equal(Buffer.byteLength(boundary), limit);
  assert.equal((await adapter(async () => new Response(boundary)).fetch([aweme])).statistics[0]!.play_count, '0');
});

test('UTF-8 分块正确解码，非法 UTF-8 与读取异常拒绝且不泄漏异常原文', async () => {
  const body = JSON.stringify({ code: 200, data: { statistics_list: [{ aweme_id: aweme, play_count: 0 }] }, message: '统计成功' });
  const bytes = new TextEncoder().encode(body);
  const good = adapter(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } })));
  assert.equal((await good.fetch([aweme])).raw_body, body);
  await assert.rejects(adapter(async () => new Response(new Uint8Array([0xff]))).fetch([aweme]), { code: 'CAPABILITY_UNVERIFIED' });
  await assert.rejects(adapter(async () => new Response(new ReadableStream<Uint8Array>({ pull() { throw new Error('test-only-secret'); } }))).fetch([aweme]), error => {
    assert.ok(error instanceof ContractError); assert.equal(error.message.includes('test-only-secret'), false); return true;
  });
});

test('提前取消不调用 fetch；请求超时与流读取取消有界且无 retry', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort(new Error('test-only-secret'));
  await assert.rejects(adapter(async () => { calls++; return new Response(valid); }).fetch([aweme], controller.signal), { code: 'CAPABILITY_UNVERIFIED' });
  assert.equal(calls, 0);
  const timeoutClient = adapter(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 50)); return new Response(valid); }, { timeout_ms: 5 });
  await assert.rejects(timeoutClient.fetch([aweme]), { code: 'CAPABILITY_UNVERIFIED' }); assert.equal(calls, 1);
  let streamCancelled = 0;
  const streamingController = new AbortController();
  const streaming = adapter(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { streamCancelled++; } })));
  const pending = streaming.fetch([aweme], streamingController.signal);
  const timer = setTimeout(() => streamingController.abort(), 5);
  try { await assert.rejects(pending, { code: 'CAPABILITY_UNVERIFIED' }); }
  finally { clearTimeout(timer); }
  assert.equal(streamCancelled, 1);
});

test('统计 timeout 不能超过 25 秒或使用无效值', () => {
  for (const timeout_ms of [0, -1, 25_001, 1.5, NaN, Infinity]) assert.throws(() => adapter(async () => new Response(valid), { timeout_ms }), { code: 'VALIDATION_ERROR' });
});
