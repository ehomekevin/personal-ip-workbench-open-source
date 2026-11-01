import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { API_RESOURCES, BenchmarkStatisticsRefreshSchema, type BenchmarkStatisticsRefreshResponse, type BenchmarkStatisticsRefreshStatusResponse, type JsonObject, type Page, type RawResponseRef, type SourceRecordDetail, type SourceRecordSummary } from '../../packages/contracts/src/index.ts';
import { fixture } from '../documents/harness.ts';
import { startApplication } from '../../apps/service/src/bootstrap/application.ts';
import { createBenchmarkAccountsModule } from '../../apps/service/src/routes/benchmark-accounts.ts';
import { createSourcesModule } from '../../apps/service/src/routes/sources.ts';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { BenchmarkSync } from '../../packages/domain/src/sources/benchmark-sync.ts';
import type { BenchmarkStatisticsClient } from '../../packages/domain/src/sources/benchmark-statistics.ts';
import { TikHubAdapter } from '../../packages/adapters/src/tikhub/index.ts';
import { parseBenchmarkStatistics } from '../../packages/adapters/src/tikhub/benchmark-statistics.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { sha256 } from '../../packages/storage/src/connection/index.ts';
import { resolveWorkbenchRoute, routeRequest, WORKBENCH_TOOL_ROUTES, MCP_TOOL_INVENTORY, validateToolInput } from '../../packages/host-bridge/src/core/tools.ts';

const resource = '/api/v1/accounts/material-statistics-refresh';
const sec = 'MS4w' + 'a'.repeat(20), url = 'https://www.douyin.com/user/' + sec;
const collectedAt = '2026-10-13T13:00:00Z';
const statsRaw = JSON.stringify({ code: 200, data: { statistics_list: [{ aweme_id: '201', play_count: '0' }, { aweme_id: '202', play_count: '215879' }] } });
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }

async function setup(statistics: BenchmarkStatisticsClient) {
  const f = fixture(); let feedCalls = 0;
  const adapter = new TikHubAdapter({ fixture: true, token_provider: () => 'fixture-only', fetcher: async () => {
    feedCalls++;
    return new Response(JSON.stringify({ code: 200, data: { has_more: true, max_cursor: '12345', aweme_list: ['201', '202'].map(aweme_id => ({
      aweme_id, desc: '平台原始说明 ' + aweme_id, create_time: 1720000000, author: { uid: '123', sec_uid: sec },
      statistics: { digg_count: 0, comment_count: 2, play_count: 0 },
      video: { duration: 129967, cover: { url_list: ['https://media.example.com/' + aweme_id + '.jpeg'] }, play_addr: { url_list: ['https://video.example.com/' + aweme_id + '.mp4'] } },
    })) } }));
  } });
  const factories = [
    (context: Parameters<typeof createBenchmarkAccountsModule>[0]) => ({ ...createBenchmarkAccountsModule(context, { adapter, statistics }), initialize: undefined }),
    (context: Parameters<typeof createSourcesModule>[0]) => ({ ...createSourcesModule(context), initialize: undefined }),
  ];
  f.closeDb();
  let app: Awaited<ReturnType<typeof startApplication>>;
  try { app = await startApplication(f.config, { port: 0, moduleFactories: factories, executorHealth: async () => [] }); }
  catch (error) { f.cleanup(); throw error; }
  const sources = new Sources(app.context), id = sources.createAccount(f.request(), { role: 'benchmark', platform: 'douyin', url, name: '隔离统计 HTTP 测试' }).account_id;
  app.context.db.prepare("UPDATE accounts SET platform_account_id='123',identity_status='confirmed' WHERE id=?").run(id);
  const sync = new BenchmarkSync(app.context, adapter);
  const worker = new DurableWorker(app.context, [{ registration: { kind: 'benchmark_sync', execution_mode: 'programmatic', recovery: 'read_only' }, async execute(e) {
    await sync.execute(e.claim.job.id, JSON.parse(e.claim.job.input_manifest), { fence: e.claim.fence, signal: e.signal, checkpoint: e.checkpoint });
    return { documents: [], recommendations: [] };
  } }]);
  const headers = { 'Content-Type': 'application/json', 'X-Workspace-Id': f.config.workspace_id, 'X-Service-Instance-Id': f.config.service_instance_id };
  const call = async <T = unknown>(method: 'GET' | 'POST', path = resource, body: unknown = undefined, key: string | null = null, extra: Record<string, string> = {}) => {
    const response = await fetch('http://127.0.0.1:' + app.address.port + path, { method, headers: { ...headers, ...(key ? { 'Idempotency-Key': key } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json() as T };
  };
  return { f, app, sources, id, sync, worker, call, feedCalls: () => feedCalls, async cleanup() { await app.close(); f.cleanup(); } };
}

async function terminal(read: () => Promise<{ status: number; body: BenchmarkStatisticsRefreshStatusResponse }>, refreshId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await read(); assert.equal(response.status, 200);
    const status = response.body.current;
    if (status?.refresh_id === refreshId && !['queued', 'running'].includes(status.state)) return status;
    await delay(25);
  }
  assert.fail('统计刷新没有在隔离测试期限内进入终态');
}

test('统计 HTTP 立即返回 queued，后台采用精确作品及零值；原素材和历史保留，feed 占位零不覆盖专属统计投影', async () => {
  const release = gate(), started = gate(); let statisticsCalls = 0;
  const h = await setup({ credentialPresent: () => true, async fetch(ids, signal) {
    statisticsCalls++; assert.deepEqual([...ids].sort(), ['201', '202']); assert.equal(signal?.aborted, false);
    started.release(); await release.wait;
    return { raw_body: statsRaw, collected_at: collectedAt, evidence_kind: 'internal_rule', statistics: parseBenchmarkStatistics(statsRaw, ids) };
  } });
  try {
    h.sync.enqueue(h.f.request(), h.id); assert.equal((await h.worker.runOnce())?.state, 'committed');
    const db = h.app.context.db, records = h.sources.records(h.f.request()).items;
    for (const record of records) {
      const payload = JSON.parse(String(db.prepare('SELECT payload FROM source_records WHERE id=?').get(record.id)!.payload));
      payload.body = '人工补充正文 ' + record.external_id; payload.provider_metadata.curation = { selected: true, rank: 1, reason: '保留人工选定' };
      db.prepare('UPDATE source_records SET payload=? WHERE id=?').run(JSON.stringify(payload), record.id);
      h.sources.marks(h.f.request(), record.id, { favorite: true, read: true });
    }
    const preserved = () => ({
      records: db.prepare('SELECT * FROM source_records ORDER BY id').all(), works: db.prepare('SELECT * FROM works ORDER BY id').all(),
      locations: db.prepare('SELECT * FROM source_locations ORDER BY id').all(), snapshots: db.prepare('SELECT * FROM snapshots ORDER BY id').all(),
      marks: db.prepare('SELECT * FROM user_source_marks ORDER BY id').all(), jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      checkpoints: db.prepare('SELECT * FROM sync_checkpoints ORDER BY id').all(), history: h.sync.status(h.f.request(), h.id),
    });
    const before = preserved(), feedRef = before.history.raw_response_ref as unknown as RawResponseRef, feedBytes = readFileSync(feedRef.path, 'utf8');
    assert.equal(sha256(feedBytes), feedRef.sha256);
    const post = await h.call<BenchmarkStatisticsRefreshResponse>('POST', resource, {}, 'statistics-http');
    assert.equal(post.status, 202); assert.equal(post.body.state, 'queued'); assert.equal(post.body.matched_count, 2); assert.equal(post.body.batch_count, 1);
    await started.wait;
    const running = await h.call<BenchmarkStatisticsRefreshStatusResponse>('GET');
    assert.equal(running.body.current?.refresh_id, post.body.refresh_id); assert.equal(running.body.current?.state, 'running');
    assert.deepEqual((await h.call<BenchmarkStatisticsRefreshResponse>('POST', resource, {}, 'statistics-http')).body, post.body);
    assert.equal(statisticsCalls, 1);
    release.release();
    const completed = await terminal(() => h.call<BenchmarkStatisticsRefreshStatusResponse>('GET'), post.body.refresh_id);
    assert.equal(completed.state, 'succeeded'); assert.equal(completed.updated_count, 2); assert.equal(completed.remote_attempts, 1);
    assert.equal(completed.completed_batches, 1); assert.equal(completed.missing_count, 0); assert.equal(completed.retained_count, 0);
    assert.deepEqual(preserved(), before); assert.equal(readFileSync(feedRef.path, 'utf8'), feedBytes);
    for (const record of records) {
      const response = await h.call<SourceRecordDetail>('GET', '/api/v1/source-records/' + record.id);
      assert.equal(response.status, 200); const detail = response.body;
      assert.equal(detail.body, '人工补充正文 ' + record.external_id); assert.equal(detail.favorite, true); assert.equal(detail.read, true);
      assert.equal((detail.benchmark?.metrics as JsonObject).plays, record.external_id === '201' ? '0' : '215879');
      const source = (detail.benchmark?.metric_sources as JsonObject).plays as JsonObject;
      assert.equal(source.status, 'available'); assert.equal(source.source_kind, 'tikhub_douyin_video_statistics');
      assert.equal(source.observed_at, null); assert.equal(source.observed_time_basis, 'unknown'); assert.equal(source.collected_at, collectedAt);
      const rawRef = source.raw_response_ref as unknown as RawResponseRef;
      assert.equal(readFileSync(rawRef.path, 'utf8'), statsRaw); assert.equal(rawRef.sha256, sha256(statsRaw));
    }
    assert.deepEqual((await h.call<BenchmarkStatisticsRefreshResponse>('POST', resource, {}, 'statistics-http')).body, post.body);
    assert.equal(statisticsCalls, 1); assert.equal(h.feedCalls(), 1);
    h.sync.enqueue(h.f.request(), h.id); assert.equal((await h.worker.runOnce())?.state, 'committed');
    const list = await h.call<Page<SourceRecordSummary>>('GET', '/api/v1/source-records'); assert.equal(list.status, 200);
    for (const record of list.body.items) {
      assert.equal((record.metrics as JsonObject).plays, record.external_id === '201' ? '0' : '215879');
      const detail = (await h.call<SourceRecordDetail>('GET', '/api/v1/source-records/' + record.id)).body;
      assert.equal((detail.benchmark?.metrics as JsonObject).plays, (record.metrics as JsonObject).plays);
      const saved = JSON.parse(String(db.prepare('SELECT payload FROM source_records WHERE id=?').get(record.id)!.payload));
      assert.equal(saved.provider_metadata.metrics.plays, null); assert.equal(saved.provider_metadata.play_count_raw, '0');
    }
    assert.equal(statisticsCalls, 1); assert.equal(h.feedCalls(), 2);
  } finally { release.release(); await h.cleanup(); }
});

test('固定统计 HTTP GET 回读 current；错误工作区、服务、幂等键和额外 body 均在远程调用前拒绝', async () => {
  let calls = 0;
  const h = await setup({ credentialPresent: () => true, async fetch(ids) { calls++; return { raw_body: statsRaw, collected_at: collectedAt, evidence_kind: 'internal_rule', statistics: parseBenchmarkStatistics(statsRaw, ids) }; } });
  try {
    const initial = await h.call<BenchmarkStatisticsRefreshStatusResponse>('GET'); assert.equal(initial.status, 200); assert.deepEqual(initial.body, { current: null });
    assert.equal((await h.call('POST', resource, {})).status, 400);
    for (const body of [{ aweme_ids: ['201'] }, { account_id: h.id }, { path: '/tmp/raw.json' }, { raw_body: statsRaw }, { payload: {} }, null, []]) {
      assert.equal((await h.call('POST', resource, body, randomUUID())).status, 400);
    }
    const mismatchedHeaders: Record<string, string>[] = [{ 'X-Workspace-Id': randomUUID() }, { 'X-Service-Instance-Id': randomUUID() }];
    for (const extra of mismatchedHeaders) {
      assert.equal((await h.call('POST', resource, {}, randomUUID(), extra)).status, 409);
      assert.equal((await h.call('GET', resource, undefined, null, extra)).status, 409);
    }
    assert.equal((await h.call('POST', '/api/v1/accounts/' + h.id + '/material-statistics-refresh', {}, randomUUID())).status, 404);
    assert.equal(calls, 0); assert.equal(h.feedCalls(), 0);
    assert.deepEqual((await h.call<BenchmarkStatisticsRefreshStatusResponse>('GET')).body, { current: null });
    assert.equal(h.app.context.db.prepare("SELECT COUNT(*) n FROM application_metadata WHERE key LIKE 'benchmark-statistics-%'").get()!.n, 0);
  } finally { await h.cleanup(); }
});

test('统计公开契约与 MCP 白名单固定 GET/POST 路径，仅写操作接受幂等键，不接受账号、作品 ID 或本机路径', () => {
  for (const method of ['GET', 'POST']) assert.ok(API_RESOURCES.some(r => r.method === method && r.path === resource));
  assert.ok(API_RESOURCES.some(r => r.method === 'POST' && r.path === resource && 'idempotent' in r && r.idempotent));
  assert.deepEqual(BenchmarkStatisticsRefreshSchema.parse({}), {});
  const write = resolveWorkbenchRoute('POST', resource, {}, { idempotencyKey: 'stats-contract' });
  const read = resolveWorkbenchRoute('GET', resource, undefined);
  assert.equal(write.name, 'refresh_benchmark_material_statistics'); assert.equal(read.name, 'read_benchmark_material_statistics');
  const writeRoute = WORKBENCH_TOOL_ROUTES.find(r => r.name === write.name)!, readRoute = WORKBENCH_TOOL_ROUTES.find(r => r.name === read.name)!;
  assert.deepEqual(routeRequest(writeRoute, write.input), { method: 'POST', path: resource, body: {}, idempotencyKey: 'stats-contract' });
  assert.deepEqual(routeRequest(readRoute, read.input), { method: 'GET', path: resource });
  assert.deepEqual(Object.keys(writeRoute.inputSchema.properties as object), ['idempotency_key']);
  assert.deepEqual(Object.keys(readRoute.inputSchema.properties as object), []);
  for (const body of [{ aweme_ids: ['201'] }, { id: 'account-1' }, { account_id: 'account-1' }, { path: '/tmp/raw' }, { raw_body: '{}' }, { payload: {} }]) {
    assert.throws(() => BenchmarkStatisticsRefreshSchema.parse(body), { code: 'VALIDATION_ERROR' });
    assert.throws(() => resolveWorkbenchRoute('POST', resource, body, { idempotencyKey: 'stats-contract' }), { code: 'VALIDATION_ERROR' });
    assert.throws(() => validateToolInput(readRoute, body), { code: 'VALIDATION_ERROR' });
  }
  assert.throws(() => validateToolInput(writeRoute, {}), { code: 'VALIDATION_ERROR' });
  assert.throws(() => resolveWorkbenchRoute('GET', resource + '?aweme_ids=201', undefined), { code: 'VALIDATION_ERROR' });
  const writeTool = MCP_TOOL_INVENTORY.find(t => t.name === write.name)!, readTool = MCP_TOOL_INVENTORY.find(t => t.name === read.name)!;
  assert.equal(writeTool.annotations.openWorldHint, true); assert.equal(writeTool.annotations.idempotentHint, true); assert.equal(writeTool.annotations.readOnlyHint, false);
  assert.equal(readTool.annotations.openWorldHint, false); assert.equal(readTool.annotations.readOnlyHint, true);
  const openapi = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8')), path = openapi.paths[resource];
  assert.equal(path.post.requestBody.content['application/json'].schema.$ref, '#/components/schemas/BenchmarkStatisticsRefreshRequest');
  assert.equal(path.post.responses['202'].content['application/json'].schema.$ref, '#/components/schemas/BenchmarkStatisticsRefreshResponse');
  assert.equal(path.get.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/BenchmarkStatisticsRefreshStatusResponse');
  assert.equal(openapi.components.schemas.BenchmarkStatisticsRefreshRequest.additionalProperties, false);
  assert.deepEqual(openapi.components.schemas.BenchmarkStatisticsRefreshRequest.properties, {});
  for (const name of ['SourceRecordSummary', 'SourceRecordDetail']) {
    assert.ok(openapi.components.schemas[name].properties.metric_sources);
    assert.equal(openapi.components.schemas[name].required.includes('metric_sources'), false, '普通素材不必带专用统计来源');
  }
  assert.equal(path.get.parameters.some((p: { in: string }) => p.in === 'path'), false);
  assert.equal(path.post.parameters.some((p: { name: string; required: boolean }) => p.name === 'Idempotency-Key' && p.required), true);
});
