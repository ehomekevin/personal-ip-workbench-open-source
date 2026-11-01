import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BenchmarkMaterialReprojectionRequest, RawResponseRef } from '../../packages/contracts/src/index.ts';
import { canonicalJson, inputHash, sha256 } from '../../packages/storage/src/connection/index.ts';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { BenchmarkSync } from '../../packages/domain/src/sources/benchmark-sync.ts';
import { BenchmarkMaterialReprojection } from '../../packages/domain/src/sources/material-reprojection.ts';
import { TikHubAdapter } from '../../packages/adapters/src/tikhub/index.ts';
import { BENCHMARK_FEED_VERSION } from '../../packages/adapters/src/tikhub/benchmark-feed.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { fixture } from '../documents/harness.ts';

const at = '2026-10-13T00:00:00Z', xUrl = 'https://x.com/bench', sec = 'MS4w' + 'a'.repeat(20), dyUrl = 'https://www.douyin.com/user/' + sec;
const heic = 'https://p3-pc.douyinpic.com/c~tplv-dy.heic?sign=original', jpeg = 'https://p3-pc.douyinpic.com/c~tplv-dy.jpeg?sign=original';
const tweet = (id: string) => ({ tweet_id: id, text: '平台原说明', created_at: at, author: { id_str: '123', screen_name: 'bench', name: '平台作者' }, favorites: 0, views: '100', media: { video: [{ media_url_https: 'https://pbs.twimg.com/v.jpg', duration: 4000, variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/v.mp4' }] }] } });
const video = (id: string) => ({ aweme_id: id, desc: '平台视频说明', create_time: 1720000000, author: { uid: '123', sec_uid: sec, nickname: '平台作者' }, statistics: { digg_count: 0, play_count: 0 }, video: { duration: 6543, cover: { url_list: [heic, jpeg] }, play_addr: { url_list: ['https://v5-dy.zjcdn.com/v.mp4'] } } });
async function collected(platform: 'x' | 'douyin' = 'douyin', count = 2) {
  const f = fixture(), sources = new Sources(f.context());
  try {
    const id = sources.createAccount(f.request(), { role: 'benchmark', platform, url: platform === 'x' ? xUrl : dyUrl, name: '隔离测试账号' }).account_id;
    const db = f.context().db; db.prepare("UPDATE accounts SET platform_account_id='123',identity_status='confirmed' WHERE id=?").run(id);
    let calls = 0;
    const ids = Array.from({ length: count }, (_, i) => String((platform === 'x' ? 101 : 201) + i));
    const raw = { code: 200, data: platform === 'x' ? { timeline: ids.map(tweet), has_more: true, next_cursor: 'saved-history' } : { aweme_list: ids.map(video), has_more: true, max_cursor: '12345' } };
    const sync = new BenchmarkSync(f.context(), new TikHubAdapter({ fixture: true, token_provider: () => 'isolated-fixture', fetcher: async () => { calls++; return new Response(JSON.stringify(raw)); } }));
    const jobId = sync.enqueue(f.request(), id).job_id;
    const worker = new DurableWorker(f.context(), [{ registration: { kind: 'benchmark_sync', execution_mode: 'programmatic', recovery: 'read_only' }, async execute(e) { await sync.execute(e.claim.job.id, JSON.parse(e.claim.job.input_manifest), { fence: e.claim.fence, signal: e.signal, checkpoint: e.checkpoint }); return { documents: [], recommendations: [] }; } }]);
    assert.equal((await worker.runOnce())?.state, 'committed', JSON.stringify(db.prepare('SELECT error FROM job_attempts ORDER BY rowid DESC LIMIT 1').get()));
    const rows = db.prepare('SELECT * FROM source_records WHERE workspace_id=? AND author_account_id=? ORDER BY id').all(f.config.workspace_id, id);
    const ref = JSON.parse(String(db.prepare('SELECT raw_response_ref FROM source_locations WHERE record_id=?').get(rows[0]!.id!)!.raw_response_ref)) as RawResponseRef;
    return { ...f, id, sources, jobId, rows, ref, calls: () => calls, sync };
  } catch (error) { f.cleanup(); throw error; }
}
type Collected = Awaited<ReturnType<typeof collected>>;
function oldMaterial(f: Collected, recordId: string) {
  const db = f.context().db, payload = JSON.parse(String(db.prepare('SELECT payload FROM source_records WHERE id=?').get(recordId)!.payload));
  Object.assign(payload, { title: '人工标题', summary: '人工摘要', body: '人工整理正文\n完整转写', human_annotation: { accepted: true, note: '必须保留' }, parser_warnings: ['人工核对后保留的说明'] });
  payload.provider_metadata.curation = { selected: true, status: 'active', rank: 1, reason: '人工整理' };
  payload.provider_metadata.body_parser_version = 'human-transcript/1';
  payload.provider_metadata.metrics = { likes: '999', plays: '999' };
  payload.provider_metadata.duration_ms = '9999';
  payload.media = [{ type: 'cover', url: heic }, { type: 'image', path: '/saved/local.jpg', asset_id: 'local-asset' }];
  db.prepare('UPDATE source_records SET payload=? WHERE id=?').run(canonicalJson(payload), recordId);
  return payload;
}
const receipts = (f: Collected) => f.context().db.prepare("SELECT key,value FROM application_metadata WHERE key LIKE 'benchmark-material-reprojection.v1:%' ORDER BY key").all();
const payloads = (f: Collected) => f.context().db.prepare('SELECT id,payload FROM source_records WHERE author_account_id=? ORDER BY id').all(f.id);
function retainedState(f: Collected) {
  const db = f.context().db;
  const tables = ['source_locations', 'user_source_marks', 'snapshots', 'metric_values', 'account_snapshots', 'account_metric_values', 'jobs', 'job_attempts', 'job_events', 'sources', 'connectors', 'sync_checkpoints', 'works', 'index_entries'];
  return canonicalJson({ tables: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])), history: db.prepare("SELECT key,value FROM application_metadata WHERE key LIKE 'benchmark-sync.v1:%' OR key LIKE 'benchmark-result.v1:%' ORDER BY key").all(), raw: [f.ref.path, join(dirname(f.ref.path), 'request.json'), join(dirname(f.ref.path), 'result.json')].map(path => sha256(readFileSync(path))) });
}

test('正式重解析返回实际counts、来源refs与hash；保留正文、人工整理、本地资产、标记与采集历史', async () => {
  const f = await collected(); try {
    const action = new BenchmarkMaterialReprojection(f.context());
    action.refresh(f.request(), f.id); // 把另一条保持为本版本的 unchanged 基线。
    const id = String(f.rows[0]!.id), original = oldMaterial(f, id);
    new Sources(f.context()).marks(f.request(), id, { favorite: true, read: true });
    const before = retainedState(f), beforePayload = String(f.context().db.prepare('SELECT payload FROM source_records WHERE id=?').get(id)!.payload), request = f.request('formal-key');
    const response = action.refresh(request, f.id);
    assert.equal(response.projection_version, BENCHMARK_FEED_VERSION);
    assert.equal(response.account_id, f.id); assert.equal(response.matched_count, 2); assert.equal(response.updated_count, 1); assert.equal(response.unchanged_count, 1);
    const item = response.items.find(item => item.record_id === id)!;
    assert.deepEqual(item.raw_response_ref, f.ref); assert.equal(item.job_id, f.jobId); assert.equal(item.preview_url, jpeg); assert.equal(item.duration_ms, '6543'); assert.equal(item.media_type, 'video');
    assert.equal(item.before_payload_sha256, sha256(beforePayload));
    const afterPayload = String(f.context().db.prepare('SELECT payload FROM source_records WHERE id=?').get(id)!.payload), after = JSON.parse(afterPayload);
    assert.equal(item.after_payload_sha256, sha256(afterPayload));
    for (const key of ['title', 'summary', 'body', 'human_annotation', 'parser_warnings']) assert.deepEqual(after[key], original[key]);
    assert.deepEqual(after.provider_metadata.curation, original.provider_metadata.curation); assert.equal(after.provider_metadata.body_parser_version, 'human-transcript/1');
    assert.ok(after.media.some((item: any) => item.asset_id === 'local-asset')); assert.ok(!after.media.some((item: any) => item.url === heic)); assert.equal(after.provider_metadata.metrics.likes, '0'); assert.equal(after.provider_metadata.metrics.plays, null);
    assert.equal(retainedState(f), before); assert.equal(f.calls(), 1);
    const receipt = JSON.parse(String(f.context().db.prepare('SELECT value FROM application_metadata WHERE key=?').get(`benchmark-material-reprojection.v1:${f.config.workspace_id}:${response.projection_id}`)!.value));
    assert.equal(receipt.request_id, request.request_id); assert.equal(receipt.workspace_id, f.config.workspace_id); assert.deepEqual(receipt.items, response.items); assert.equal(receipts(f).length, 2);
    assert.deepEqual(action.refresh(request, f.id), response); assert.equal(receipts(f).length, 2);
    f.reopen(); assert.deepEqual(new BenchmarkMaterialReprojection(f.context()).refresh(f.request('formal-key'), f.id), response); assert.equal(receipts(f).length, 2);
    const unchanged = new BenchmarkMaterialReprojection(f.context()).refresh(f.request('fresh-formal-key'), f.id);
    assert.equal(unchanged.updated_count, 0); assert.equal(unchanged.unchanged_count, 2); assert.equal(receipts(f).length, 3);
    assert.notEqual(unchanged.projection_id, response.projection_id);
    for (const item of unchanged.items) assert.equal(item.after_payload_sha256, item.before_payload_sha256);
  } finally { f.cleanup(); }
});

test('X 也从已保存原响应重算视频时长与真实零值，不再调用provider', async () => {
  const f = await collected('x', 1); try {
    const id = String(f.rows[0]!.id); oldMaterial(f, id);
    const result = new BenchmarkMaterialReprojection(f.context()).refresh(f.request(), f.id);
    assert.equal(result.matched_count, 1); assert.equal(result.updated_count, 1); assert.equal(result.items[0]!.duration_ms, '4000');
    const payload = JSON.parse(String(payloads(f)[0]!.payload)); assert.equal(payload.provider_metadata.metrics.likes, '0'); assert.equal(payload.provider_metadata.metrics.views, '100'); assert.equal(f.calls(), 1);
  } finally { f.cleanup(); }
});

test('已确认账号没有已保存平台素材时也保存零项正式回执', () => {
  const f = fixture(); try {
    const id = new Sources(f.context()).createAccount(f.request(), { role: 'benchmark', platform: 'x', url: xUrl, name: '尚未采集' }).account_id;
    f.context().db.prepare("UPDATE accounts SET platform_account_id='123',identity_status='confirmed' WHERE id=?").run(id);
    const response = new BenchmarkMaterialReprojection(f.context()).refresh(f.request(), id);
    assert.deepEqual([response.matched_count, response.updated_count, response.unchanged_count], [0, 0, 0]); assert.deepEqual(response.items, []);
    assert.ok(f.context().db.prepare('SELECT key FROM application_metadata WHERE key=?').get(`benchmark-material-reprojection.v1:${f.config.workspace_id}:${response.projection_id}`));
  } finally { f.cleanup(); }
});

test('请求身份、账号workspace、角色、平台与confirmed身份必须匹配，空body禁止额外field', async () => {
  const f = await collected('x', 1); try {
    const action = new BenchmarkMaterialReprojection(f.context()), before = payloads(f);
    for (const key of ['workspace_id', 'service_instance_id', 'contract_version']) assert.throws(() => action.refresh({ ...f.request(), [key]: randomUUID() }, f.id), { code: 'WORKSPACE_INSTANCE_MISMATCH' });
    assert.throws(() => action.refresh(f.request(), randomUUID()), { code: 'NOT_FOUND' });
    for (const input of [{ path: f.ref.path }, { payload: {} }, { state_root: f.context().paths.state_root }, { dry_run: true }, null, []]) assert.throws(() => action.refresh(f.request(), f.id, input as unknown as BenchmarkMaterialReprojectionRequest), { code: 'VALIDATION_ERROR' });
    assert.throws(() => action.refresh({ ...f.request(), idempotency_key: null }, f.id), { code: 'VALIDATION_ERROR' });
    f.context().db.prepare("UPDATE accounts SET role='owner' WHERE id=?").run(f.id); assert.throws(() => action.refresh(f.request(), f.id), { code: 'VALIDATION_ERROR' });
    f.context().db.prepare("UPDATE accounts SET role='benchmark',platform='xiaohongshu' WHERE id=?").run(f.id); assert.throws(() => action.refresh(f.request(), f.id), { code: 'CAPABILITY_UNSUPPORTED' });
    f.context().db.prepare("UPDATE accounts SET platform='x',identity_status='pending' WHERE id=?").run(f.id); assert.throws(() => action.refresh(f.request(), f.id), { code: 'CAPABILITY_UNVERIFIED' });
    assert.deepEqual(payloads(f), before); assert.equal(receipts(f).length, 0);
  } finally { f.cleanup(); }
});

test('唯一主服务state root与workspace登记不一致时拒绝，不重定位读取另一个目录', async () => {
  const f = await collected('x', 1); try {
    const other = join(f.root, 'other-state'); mkdirSync(other);
    const context = f.context();
    assert.throws(() => new BenchmarkMaterialReprojection({ ...context, paths: { ...context.paths, state_root: other } }).refresh(f.request(), f.id), { code: 'WORKSPACE_INSTANCE_MISMATCH' });
    f.context().db.prepare('UPDATE workspaces SET paths=? WHERE id=?').run(JSON.stringify({ ...context.paths, state_root: other }), f.config.workspace_id);
    assert.throws(() => new BenchmarkMaterialReprojection(context).refresh(f.request(), f.id), { code: 'WORKSPACE_INSTANCE_MISMATCH' }); assert.equal(receipts(f).length, 0);
  } finally { f.cleanup(); }
});

test('internal_rule只允许demo工作区与demo服务，real模式不采用模拟回执', async () => {
  const f = await collected('x', 1); try {
    const context = f.context();
    assert.throws(() => new BenchmarkMaterialReprojection({ ...context, config: { ...context.config, mode: 'real' } }).refresh(f.request(), f.id), { code: 'CAPABILITY_UNVERIFIED' });
    f.context().db.prepare("UPDATE workspaces SET mode='real' WHERE id=?").run(f.config.workspace_id);
    assert.throws(() => new BenchmarkMaterialReprojection(context).refresh(f.request(), f.id), { code: 'CAPABILITY_UNVERIFIED' });
    const resultPath = join(dirname(f.ref.path), 'result.json'), result = JSON.parse(readFileSync(resultPath, 'utf8')); result.feed.evidence_kind = 'real_platform'; writeFileSync(resultPath, JSON.stringify(result));
    assert.equal(new BenchmarkMaterialReprojection({ ...context, config: { ...context.config, mode: 'real' } }).refresh(f.request(), f.id).matched_count, 1);
  } finally { f.cleanup(); }
});

const damages: Array<{ name: string; code: string; change(f: Collected): void }> = [
  { name: 'raw bytes', code: 'IDEMPOTENCY_CONFLICT', change: f => writeFileSync(f.ref.path, '{}') },
  { name: 'raw hash', code: 'CAPABILITY_UNVERIFIED', change: f => f.context().db.prepare("UPDATE source_locations SET sha256=? WHERE record_id=?").run(sha256('{}'), f.rows[0]!.id!) },
  { name: 'missing commit receipt', code: 'CAPABILITY_UNVERIFIED', change: f => f.context().db.prepare('DELETE FROM application_metadata WHERE key=?').run(`benchmark-result.v1:${f.config.workspace_id}:${f.jobId}`) },
  { name: 'bad receipt ref', code: 'CAPABILITY_UNVERIFIED', change: f => { const key = `benchmark-result.v1:${f.config.workspace_id}:${f.jobId}`, receipt = JSON.parse(String(f.context().db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key)!.value)); receipt.raw_response_ref.sha256 = sha256('{}'); f.context().db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(receipt), key); } },
  // 只在隔离 fixture 关闭不可变约束，模拟磁盘/副本损坏后的不可信 job。
  { name: 'manifest hash', code: 'CAPABILITY_UNVERIFIED', change: f => { f.context().db.exec('DROP TRIGGER job_fixed_input'); f.context().db.prepare('UPDATE jobs SET input_hash=? WHERE id=?').run(sha256('{}'), f.jobId); } },
  { name: 'frozen manifest target', code: 'CAPABILITY_UNVERIFIED', change: f => { f.context().db.exec('DROP TRIGGER job_fixed_input'); const manifest = JSON.parse(String(f.context().db.prepare('SELECT input_manifest FROM jobs WHERE id=?').get(f.jobId)!.input_manifest)); manifest.account.platform_account_id = '456'; f.context().db.prepare('UPDATE jobs SET input_manifest=?,input_hash=? WHERE id=?').run(canonicalJson(manifest), inputHash(manifest), f.jobId); } },
  { name: 'request fingerprint', code: 'CAPABILITY_UNVERIFIED', change: f => { const path = join(dirname(f.ref.path), 'request.json'), saved = JSON.parse(readFileSync(path, 'utf8')); saved.request_fingerprint = sha256('{}'); writeFileSync(path, JSON.stringify(saved)); } },
  { name: 'result fingerprint', code: 'CAPABILITY_UNVERIFIED', change: f => { const path = join(dirname(f.ref.path), 'result.json'), saved = JSON.parse(readFileSync(path, 'utf8')); saved.request_fingerprint = sha256('{}'); writeFileSync(path, JSON.stringify(saved)); } },
  { name: 'raw outside registered root', code: 'CAPABILITY_UNVERIFIED', change: f => f.context().db.prepare('UPDATE source_locations SET raw_response_ref=? WHERE record_id=?').run(JSON.stringify({ ...f.ref, path: join(f.root, 'response.json') }), f.rows[0]!.id!) },
  { name: 'raw symlink', code: 'STORAGE_UNAVAILABLE', change: f => { const saved = join(f.root, 'raw-copy.json'); writeFileSync(saved, readFileSync(f.ref.path)); unlinkSync(f.ref.path); symlinkSync(saved, f.ref.path); } },
  { name: 'job not succeeded', code: 'CAPABILITY_UNVERIFIED', change: f => f.context().db.prepare("UPDATE jobs SET state='queued' WHERE id=?").run(f.jobId) },
];
for (const damage of damages) test(`可信来源链拒绝 ${damage.name}，整次动作没有partial成功或receipt`, async () => {
  const f = await collected(); try {
    for (const row of f.rows) oldMaterial(f, String(row.id));
    damage.change(f); const before = payloads(f), state = retainedState(f);
    assert.throws(() => new BenchmarkMaterialReprojection(f.context()).refresh(f.request(), f.id), { code: damage.code });
    assert.deepEqual(payloads(f), before); assert.equal(retainedState(f), state); assert.equal(receipts(f).length, 0); assert.equal(f.calls(), 1);
  } finally { f.cleanup(); }
});

test('计划后payload字符串变化即使语义相等也拒绝；unchanged条目也在事务内复核', async () => {
  const f = await collected(); try {
    new BenchmarkMaterialReprojection(f.context()).refresh(f.request(), f.id);
    oldMaterial(f, String(f.rows[0]!.id));
    const unchangedId = String(f.rows[1]!.id), before = payloads(f), receiptsBefore = receipts(f).length;
    class ConcurrentEdit extends BenchmarkMaterialReprojection { protected override beforeCommit() { const row = this.context.db.prepare('SELECT payload FROM source_records WHERE id=?').get(unchangedId)!; this.context.db.prepare('UPDATE source_records SET payload=? WHERE id=?').run(JSON.stringify(JSON.parse(String(row.payload)), null, 2), unchangedId); } }
    assert.throws(() => new ConcurrentEdit(f.context()).refresh(f.request(), f.id), { code: 'INPUT_STALE' });
    assert.equal(payloads(f)[0]!.payload, before[0]!.payload); assert.equal(receipts(f).length, receiptsBefore);
  } finally { f.cleanup(); }
});

test('计划后source ref、合法raw回执集合变化都会拒绝整次动作', async () => {
  for (const mode of ['location', 'raw'] as const) {
    const f = await collected(); try {
      for (const row of f.rows) oldMaterial(f, String(row.id));
      const before = payloads(f);
      class ConcurrentSource extends BenchmarkMaterialReprojection { protected override beforeCommit() {
        if (mode === 'location') this.context.db.prepare('UPDATE source_locations SET parser_version=? WHERE record_id=?').run('benchmark-feed/2', f.rows[0]!.id!);
        else {
          const path = join(dirname(f.ref.path), 'result.json'), saved = JSON.parse(readFileSync(path, 'utf8'));
          saved.feed.raw_body += '\n'; const rawHash = sha256(saved.feed.raw_body), ref = { ...f.ref, sha256: rawHash };
          writeFileSync(f.ref.path, saved.feed.raw_body); writeFileSync(path, JSON.stringify(saved));
          this.context.db.prepare('UPDATE source_locations SET sha256=?,raw_response_ref=? WHERE record_id IN (?,?)').run(rawHash, JSON.stringify(ref), f.rows[0]!.id!, f.rows[1]!.id!);
          const key = `benchmark-result.v1:${f.config.workspace_id}:${f.jobId}`, receipt = JSON.parse(String(this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key)!.value));
          receipt.raw_response_ref = ref; this.context.db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(receipt), key);
        }
      } }
      assert.throws(() => new ConcurrentSource(f.context()).refresh(f.request(), f.id), { code: 'INPUT_STALE' });
      assert.deepEqual(payloads(f), before); assert.equal(receipts(f).length, 0);
    } finally { f.cleanup(); }
  }
});

test('事务中CAS失败回滚此前已改的其他记录，不能产生partial成功', async () => {
  const f = await collected(); try {
    for (const row of f.rows) oldMaterial(f, String(row.id));
    const first = String(f.rows[0]!.id), second = String(f.rows[1]!.id), before = payloads(f);
    f.context().db.exec(`CREATE TRIGGER simulate_concurrent_payload AFTER UPDATE OF payload ON source_records WHEN NEW.id='${first}' BEGIN UPDATE source_records SET payload='{"body":"并发写入"}' WHERE id='${second}'; END`);
    assert.throws(() => new BenchmarkMaterialReprojection(f.context()).refresh(f.request(), f.id), { code: 'INPUT_STALE' });
    assert.deepEqual(payloads(f), before); assert.equal(receipts(f).length, 0);
  } finally { f.cleanup(); }
});

test('提交期间unchanged记录被改写也回滚全部更新，不保存与实际字节不符的receipt', async () => {
  const f = await collected(); try {
    new BenchmarkMaterialReprojection(f.context()).refresh(f.request(), f.id);
    const first = String(f.rows[0]!.id), second = String(f.rows[1]!.id); oldMaterial(f, first);
    const before = payloads(f), receiptCount = receipts(f).length;
    f.context().db.exec(`CREATE TRIGGER simulate_changed_unchanged AFTER UPDATE OF payload ON source_records WHEN NEW.id='${first}' BEGIN UPDATE source_records SET payload='{"body":"提交期间改写未更新记录"}' WHERE id='${second}'; END`);
    assert.throws(() => new BenchmarkMaterialReprojection(f.context()).refresh(f.request(), f.id), { code: 'INPUT_STALE' });
    assert.deepEqual(payloads(f), before); assert.equal(receipts(f).length, receiptCount);
  } finally { f.cleanup(); }
});
