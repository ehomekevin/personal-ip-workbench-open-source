import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, sha256 } from '../../packages/storage/src/connection/index.ts';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { BenchmarkSync } from '../../packages/domain/src/sources/benchmark-sync.ts';
import { BenchmarkMaterialReprojection } from '../../packages/domain/src/sources/material-reprojection.ts';
import { TikHubAdapter } from '../../packages/adapters/src/tikhub/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { fixture } from '../documents/harness.ts';

const firstAt = '2026-10-13T01:00:00.000Z', secondAt = '2026-10-13T02:00:00.000Z';
const sec = 'MS4w' + 'a'.repeat(20), jpeg = 'https://p3-pc.douyinpic.com/c~tplv-dy.jpeg?sign=real-candidate';
const rawFor = (platform: 'x' | 'douyin') => JSON.stringify({ code: 200, data: platform === 'x'
  ? { timeline: [{ tweet_id: '101', text: '', created_at: '2026-10-12T00:00:00Z', author: { id_str: '123', screen_name: 'bench', name: '原作者' }, favorites: 0 }], has_more: true, next_cursor: 'saved-history' }
  : { aweme_list: [{ aweme_id: '201', desc: '', create_time: 1720000000, author: { uid: '123', sec_uid: sec, nickname: '原作者' }, statistics: { digg_count: 0 }, video: { duration: 6543, cover: { url_list: [jpeg] }, play_addr: { url_list: ['https://v5-dy.zjcdn.com/v.mp4'] } } }], has_more: true, max_cursor: '12345' } });

for (const platform of ['x', 'douyin'] as const) test(`${platform} 两个成功job保存相同raw时复用location，新ref与capture_time对应同一回执且正式重解析可用`, async () => {
  const f = fixture();
  try {
    const context = f.context(), db = context.db, sources = new Sources(context), url = platform === 'x' ? 'https://x.com/bench' : 'https://www.douyin.com/user/' + sec;
    const accountId = sources.createAccount(f.request(), { role: 'benchmark', platform, url, name: '隔离原作者' }).account_id;
    db.prepare("UPDATE accounts SET platform_account_id='123',identity_status='confirmed' WHERE id=?").run(accountId);
    const raw = rawFor(platform); let clock = Date.parse(firstAt), calls = 0;
    const sync = new BenchmarkSync(context, new TikHubAdapter({ fixture: true, clock: () => clock, token_provider: () => 'isolated-fixture', fetcher: async () => { calls++; return new Response(raw); } }));
    const worker = new DurableWorker(context, [{ registration: { kind: 'benchmark_sync', execution_mode: 'programmatic', recovery: 'read_only' }, async execute(e) { await sync.execute(e.claim.job.id, JSON.parse(e.claim.job.input_manifest), { fence: e.claim.fence, signal: e.signal, checkpoint: e.checkpoint }); return { documents: [], recommendations: [] }; } }]);
    const firstJob = sync.enqueue(f.request(), accountId).job_id;
    assert.equal((await worker.runOnce())?.state, 'committed');
    const record = db.prepare('SELECT id,payload FROM source_records WHERE author_account_id=?').get(accountId)!;
    const firstLocation = db.prepare('SELECT * FROM source_locations WHERE record_id=?').get(record.id!)!, firstRef = JSON.parse(String(firstLocation.raw_response_ref));
    const firstReceiptKey = `benchmark-result.v1:${f.config.workspace_id}:${firstJob}`, firstReceipt = String(db.prepare('SELECT value FROM application_metadata WHERE key=?').get(firstReceiptKey)!.value);
    assert.equal(firstLocation.capture_time, firstAt); assert.equal(firstRef.sha256, sha256(raw));
    const payload = JSON.parse(String(record.payload));
    payload.body = '人工补充正文\n完整转写'; payload.provider_metadata.curation = { selected: true, status: 'active', rank: 1, reason: '人工核对' };
    db.prepare('UPDATE source_records SET payload=? WHERE id=?').run(canonicalJson(payload), record.id!);
    sources.marks(f.request(), String(record.id), { favorite: true, read: true });
    const marksBefore = db.prepare('SELECT * FROM user_source_marks WHERE record_id=?').get(record.id!);
    clock = Date.parse(secondAt);
    const secondJob = sync.enqueue(f.request(), accountId).job_id;
    assert.notEqual(secondJob, firstJob); assert.equal((await worker.runOnce())?.state, 'committed'); assert.equal(calls, 2);
    const secondLocation = db.prepare('SELECT * FROM source_locations WHERE record_id=?').get(record.id!)!, secondRef = JSON.parse(String(secondLocation.raw_response_ref));
    assert.equal(secondLocation.id, firstLocation.id); assert.equal(db.prepare('SELECT COUNT(*) n FROM source_locations WHERE record_id=?').get(record.id!)!.n, 1);
    assert.equal(secondRef.sha256, firstRef.sha256); assert.notEqual(secondRef.path, firstRef.path); assert.equal(dirname(secondRef.path).split('/').at(-1), secondJob);
    const secondResult = JSON.parse(readFileSync(join(dirname(secondRef.path), 'result.json'), 'utf8'));
    assert.equal(secondResult.feed.collected_at, secondAt); assert.equal(readFileSync(secondRef.path, 'utf8'), readFileSync(firstRef.path, 'utf8'));
    const beforeFormal = canonicalJson({ history: sync.status(f.request(), accountId), jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(), locations: db.prepare('SELECT * FROM source_locations ORDER BY id').all(), snapshots: db.prepare('SELECT * FROM snapshots ORDER BY id').all(), receipts: db.prepare("SELECT key,value FROM application_metadata WHERE key LIKE 'benchmark-result.v1:%' ORDER BY key").all() });
    const response = new BenchmarkMaterialReprojection(context).refresh(f.request(), accountId);
    assert.equal(response.matched_count, 1); assert.equal(response.items[0]!.source_location_id, firstLocation.id); assert.equal(response.items[0]!.job_id, secondJob); assert.deepEqual(response.items[0]!.raw_response_ref, secondRef);
    assert.equal(secondLocation.capture_time, secondResult.feed.collected_at);
    const secondReceipt = JSON.parse(String(db.prepare('SELECT value FROM application_metadata WHERE key=?').get(`benchmark-result.v1:${f.config.workspace_id}:${secondJob}`)!.value));
    assert.equal(secondLocation.capture_time, secondReceipt.last_success_at); assert.deepEqual(secondRef, secondReceipt.raw_response_ref);
    assert.equal(String(db.prepare('SELECT value FROM application_metadata WHERE key=?').get(firstReceiptKey)!.value), firstReceipt);
    const detail = sources.detail(f.request(), String(record.id)); assert.equal(detail.body, payload.body); assert.equal(detail.favorite, true); assert.equal(detail.read, true); assert.deepEqual(detail.benchmark?.curation, payload.provider_metadata.curation);
    assert.deepEqual(db.prepare('SELECT * FROM user_source_marks WHERE record_id=?').get(record.id!), marksBefore);
    assert.equal(canonicalJson({ history: sync.status(f.request(), accountId), jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(), locations: db.prepare('SELECT * FROM source_locations ORDER BY id').all(), snapshots: db.prepare('SELECT * FROM snapshots ORDER BY id').all(), receipts: db.prepare("SELECT key,value FROM application_metadata WHERE key LIKE 'benchmark-result.v1:%' ORDER BY key").all() }), beforeFormal);
    assert.equal(calls, 2, '正式重解析只读取已保存回执');
  } finally { f.cleanup(); }
});
