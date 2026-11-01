import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, sha256 } from '../../packages/storage/src/connection/index.ts';
import { readTrustedBenchmarkPlayCount } from '../../packages/storage/src/sources/benchmark-statistics.ts';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { BenchmarkSync } from '../../packages/domain/src/sources/benchmark-sync.ts';
import { BenchmarkStatistics } from '../../packages/domain/src/sources/benchmark-statistics.ts';
import { BenchmarkMaterialReprojection } from '../../packages/domain/src/sources/material-reprojection.ts';
import { TikHubAdapter } from '../../packages/adapters/src/tikhub/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { fixture } from '../documents/harness.ts';

const sec = 'MS4w' + 'a'.repeat(20), at = '2026-10-13T02:00:00.000Z';
async function captured() {
  const f = fixture();
  try {
    const db = f.context().db, sources = new Sources(f.context());
    const account = sources.createAccount(f.request(), { role: 'benchmark', platform: 'douyin', url: 'https://www.douyin.com/user/' + sec, name: '隔离读回账号' }).account_id;
    db.prepare("UPDATE accounts SET platform_account_id='123',identity_status='confirmed' WHERE id=?").run(account);
    const feed = JSON.stringify({ code: 200, data: { aweme_list: ['201', '202'].map(aweme_id => ({ aweme_id, desc: '平台原正文', create_time: 1720000000, author: { uid: '123', sec_uid: sec, nickname: '隔离作者' }, statistics: { play_count: 0, digg_count: 7 }, video: { duration: 6543, cover: { url_list: ['https://p3-pc.douyinpic.com/c.jpeg'] } } })), has_more: false } });
    const sync = new BenchmarkSync(f.context(), new TikHubAdapter({ fixture: true, token_provider: () => 'isolated-reader', fetcher: async () => new Response(feed) }));
    sync.enqueue(f.request(), account);
    const worker = new DurableWorker(f.context(), [{ registration: { kind: 'benchmark_sync', execution_mode: 'programmatic', recovery: 'read_only' }, async execute(e) { await sync.execute(e.claim.job.id, JSON.parse(e.claim.job.input_manifest), { fence: e.claim.fence, signal: e.signal, checkpoint: e.checkpoint }); return { documents: [], recommendations: [] }; } }]);
    assert.equal((await worker.runOnce())?.state, 'committed');
    const rows = db.prepare('SELECT * FROM source_records ORDER BY external_id').all();
    for (const row of rows) assert.equal(readTrustedBenchmarkPlayCount(db, f.config.workspace_id, row), null, '普通 feed 的 0 不能成为已知播放数');
    const action = new BenchmarkStatistics(f.context(), { async fetch(ids) {
      const statistics = ids.map(aweme_id => ({ aweme_id, play_count: aweme_id === '201' ? '215879' : '0' }));
      return { raw_body: JSON.stringify({ code: 200, data: { statistics_list: statistics } }), collected_at: at, evidence_kind: 'internal_rule', statistics };
    } });
    const accepted = action.start(f.request()); await action.close();
    assert.equal(action.status(f.request())!.state, 'succeeded');
    const key = `benchmark-play-count.v1:${f.config.workspace_id}:${account}:201`, opKey = `benchmark-statistics-refresh.v1:${f.config.workspace_id}:${accepted.refresh_id}`;
    const metric = JSON.parse(String(db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key)!.value));
    const op = JSON.parse(String(db.prepare('SELECT value FROM application_metadata WHERE key=?').get(opKey)!.value));
    return { ...f, db, account, rows, key, opKey, metric, op };
  } catch (error) { f.cleanup(); throw error; }
}
type Captured = Awaited<ReturnType<typeof captured>>;
function read(f: Captured, row: Record<string, unknown> = f.rows[0]!) { return readTrustedBenchmarkPlayCount(f.db, f.config.workspace_id, row); }
function save(f: Captured, key: string, value: unknown) { f.db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(canonicalJson(value), key); }

test('真实 domain 保存的专用统计，正数和真实零值可读且来源时间仍为未知；读取不写数据库', async () => {
  const f = await captured();
  try {
    const before = canonicalJson({ records: f.db.prepare('SELECT * FROM source_records ORDER BY id').all(), metadata: f.db.prepare('SELECT * FROM application_metadata ORDER BY key').all() });
    assert.equal(read(f)!.value, '215879'); assert.equal(read(f, f.rows[1]!)!.value, '0');
    const source = read(f)!.source;
    assert.equal(source.status, 'available'); assert.equal(source.source_kind, 'tikhub_douyin_video_statistics'); assert.equal(source.collected_at, at); assert.equal(source.observed_at, null); assert.equal(source.observed_time_basis, 'unknown'); assert.deepEqual(source.raw_response_ref, f.metric.raw_response_ref);
    assert.equal(canonicalJson({ records: f.db.prepare('SELECT * FROM source_records ORDER BY id').all(), metadata: f.db.prepare('SELECT * FROM application_metadata ORDER BY key').all() }), before);
    f.reopen(); assert.equal(readTrustedBenchmarkPlayCount(f.context().db, f.config.workspace_id, f.rows[0]!)!.value, '215879');
  } finally { f.cleanup(); }
});

test('仅有伪造 metadata、错误身份/时间/数值，或尚未 applied 的批次均保留未知', async () => {
  const f = await captured();
  try {
    const changes: Array<[string, unknown]> = [
      ['schema_version', 'benchmark-play-count/99'], ['workspace_id', randomUUID()], ['account_id', randomUUID()], ['platform_account_id', '999'], ['record_id', String(f.rows[1]!.id)], ['aweme_id', '202'], ['canonical_url', 'https://www.douyin.com/video/202'], ['source_kind', 'ordinary_feed'], ['value', '215880'], ['value', '-1'], ['value', '00'], ['value', 215879], ['value', '9'.repeat(31)], ['refresh_id', randomUUID()], ['batch_index', 1], ['batch_index', -1], ['collected_at', 'invalid'], ['collected_at', '2026-10-13T03:00:00.000Z'], ['observed_at', at], ['observed_time_basis', 'published_at'], ['evidence_kind', 'unknown'], ['request_fingerprint', sha256('{}')], ['raw_response_ref', { ...f.metric.raw_response_ref, sha256: sha256('{}') }],
    ];
    for (const [field, value] of changes) { save(f, f.key, { ...f.metric, [field]: value }); assert.equal(read(f), null, field + ':' + String(value)); }
    save(f, f.key, f.metric);
    for (const state of ['pending', 'sending', 'unknown', 'failed', 'not_sent']) {
      const changed = structuredClone(f.op); changed.batches[0].state = state; save(f, f.opKey, changed); assert.equal(read(f), null, state);
    }
    save(f, f.opKey, { ...f.op, state: 'unknown' }); assert.equal(read(f)!.value, '215879', '另一批未知不影响本批已应用回执');
    f.db.prepare('DELETE FROM application_metadata WHERE key=?').run(f.opKey); assert.equal(read(f), null, 'metric 不可脱离 operation 单独使用');
  } finally { f.cleanup(); }
});

test('读回必须匹配当前账号 UID、canonical URL、角色、confirmed 状态以及同工作区原作品', async () => {
  const f = await captured();
  try {
    const account = f.db.prepare('SELECT * FROM accounts WHERE id=?').get(f.account)!;
    for (const [field, value] of [['platform_account_id', '999'], ['canonical_url', 'https://www.douyin.com/user/' + 'MS4w' + 'b'.repeat(20)], ['role', 'owner'], ['platform', 'x'], ['identity_status', 'pending']] as const) {
      f.db.prepare(`UPDATE accounts SET ${field}=? WHERE id=?`).run(value, f.account); assert.equal(read(f), null, field);
      f.db.prepare(`UPDATE accounts SET ${field}=? WHERE id=?`).run(account[field]!, f.account);
    }
    assert.equal(readTrustedBenchmarkPlayCount(f.db, randomUUID(), f.rows[0]!), null);
    assert.equal(read(f, { ...f.rows[0], external_id: '202' }), null);
    f.db.prepare('UPDATE source_records SET canonical_url=? WHERE id=?').run('https://www.douyin.com/video/other', f.rows[0]!.id!); assert.equal(read(f), null);
    f.db.prepare('UPDATE source_records SET canonical_url=? WHERE id=?').run(f.rows[0]!.canonical_url!, f.rows[0]!.id!);
    f.db.prepare("UPDATE workspaces SET mode='real' WHERE id=?").run(f.config.workspace_id); assert.equal(read(f), null, '真实工作区拒绝 internal_rule 统计');
    f.db.prepare("UPDATE workspaces SET mode='demo' WHERE id=?").run(f.config.workspace_id); assert.equal(read(f)!.value, '215879');
  } finally { f.cleanup(); }
});

test('raw、result、request 和 root manifest 任何一环不符都不投影；hash 不能代替冻结 fingerprint 或 raw 数值核对', async () => {
  const f = await captured();
  try {
    const batch = f.op.batches[0], paths = [f.op.request_ref.path, batch.request_ref.path, batch.result_ref.path, batch.raw_response_ref.path] as string[];
    const originals = new Map(paths.map(path => [path, readFileSync(path, 'utf8')]));
    function restore() { for (const [path, bytes] of originals) writeFileSync(path, bytes); save(f, f.key, f.metric); save(f, f.opKey, f.op); }
    const damages: Array<[string, () => void]> = [
      ['missing root', () => unlinkSync(paths[0]!)],
      ['root bytes', () => writeFileSync(paths[0]!, '{}')],
      ['request bytes', () => writeFileSync(paths[1]!, '{}')],
      ['result bytes', () => writeFileSync(paths[2]!, '{}')],
      ['raw bytes', () => writeFileSync(paths[3]!, '{}')],
      ['root ref outside state', () => { const changed = structuredClone(f.op); changed.request_ref.path = join(f.root, 'request.json'); save(f, f.opKey, changed); }],
      ['root target even with matching file hash', () => { const changed = structuredClone(f.op), manifest = JSON.parse(originals.get(paths[0]!)!); manifest.targets[0].platform_account_id = '999'; const bytes = canonicalJson(manifest); writeFileSync(paths[0]!, bytes); changed.request_ref.sha256 = sha256(bytes); save(f, f.opKey, changed); }],
      ['batch fingerprint even with matching file hash', () => { const changed = structuredClone(f.op), request = JSON.parse(originals.get(paths[1]!)!); request.request_fingerprint = sha256('{}'); const bytes = canonicalJson(request); writeFileSync(paths[1]!, bytes); changed.batches[0].request_ref.sha256 = sha256(bytes); save(f, f.opKey, changed); }],
      ['normalized result even with matching file hash', () => { const changed = structuredClone(f.op), result = JSON.parse(originals.get(paths[2]!)!); result.feed.statistics[0].play_count = '1'; const bytes = canonicalJson(result); writeFileSync(paths[2]!, bytes); changed.batches[0].result_ref.sha256 = sha256(bytes); save(f, f.opKey, changed); }],
      ['raw value vs metric after updating hashes', () => { const changed = structuredClone(f.op), metric = structuredClone(f.metric), result = JSON.parse(originals.get(paths[2]!)!), raw = JSON.parse(originals.get(paths[3]!)!); raw.data.statistics_list[0].play_count = '1'; const bytes = canonicalJson(raw), rawRef = { ...batch.raw_response_ref, sha256: sha256(bytes) }; writeFileSync(paths[3]!, bytes); result.feed.raw_body = bytes; result.feed.statistics[0].play_count = '1'; result.raw_response_ref = rawRef; const resultBytes = canonicalJson(result); writeFileSync(paths[2]!, resultBytes); changed.batches[0].raw_response_ref = rawRef; changed.batches[0].result_ref.sha256 = sha256(resultBytes); metric.raw_response_ref = rawRef; save(f, f.opKey, changed); save(f, f.key, metric); }],
      ['foreign ID even with updated raw/result hashes', () => { const changed = structuredClone(f.op), metric = structuredClone(f.metric), result = JSON.parse(originals.get(paths[2]!)!), raw = JSON.parse(originals.get(paths[3]!)!); raw.data.statistics_list.push({ aweme_id: '999', play_count: '1' }); const bytes = canonicalJson(raw), ref = { ...batch.raw_response_ref, sha256: sha256(bytes) }; writeFileSync(paths[3]!, bytes); result.feed.raw_body = bytes; result.feed.statistics.push({ aweme_id: '999', play_count: '1' }); result.raw_response_ref = ref; const resultBytes = canonicalJson(result); writeFileSync(paths[2]!, resultBytes); changed.batches[0].raw_response_ref = ref; changed.batches[0].result_ref.sha256 = sha256(resultBytes); metric.raw_response_ref = ref; save(f, f.opKey, changed); save(f, f.key, metric); }],
    ];
    for (const [name, damage] of damages) { damage(); assert.equal(read(f), null, name); restore(); assert.equal(read(f)!.value, '215879', name + ' restore'); }
  } finally { f.cleanup(); }
});

test('来源文件 hardlink、symlink 或 state 目录链接不可作为专用播放数证据', async () => {
  const f = await captured();
  try {
    const rawPath = String(f.metric.raw_response_ref.path), raw = readFileSync(rawPath), copied = join(f.root, 'outside-response.json');
    writeFileSync(copied, raw); unlinkSync(rawPath); symlinkSync(copied, rawPath); assert.equal(read(f), null, 'symlink'); unlinkSync(rawPath); writeFileSync(rawPath, raw);
    const linked = join(f.root, 'hardlink.json'); linkSync(rawPath, linked); assert.equal(read(f), null, 'hardlink'); unlinkSync(linked); assert.equal(read(f)!.value, '215879');
    const alias = join(f.root, 'state-alias'); symlinkSync(f.context().paths.state_root, alias); const paths = { ...f.context().paths, state_root: alias };
    f.db.prepare('UPDATE workspaces SET paths=? WHERE id=?').run(canonicalJson(paths), f.config.workspace_id); assert.equal(read(f), null, 'registered state symlink');
    f.db.prepare('UPDATE workspaces SET paths=? WHERE id=?').run(canonicalJson(f.context().paths), f.config.workspace_id); assert.equal(read(f)!.value, '215879');
    assert.equal(dirname(rawPath).split('/').at(-1), 'batch-01');
  } finally { f.cleanup(); }
});

test('正式素材重解析仍保存 feed 播放占位，读取保留独立可信统计和完整正文', async () => {
  const f = await captured();
  try {
    const row = f.rows[0]!, payload = JSON.parse(String(row.payload)); payload.body = '人工补充完整正文';
    f.db.prepare('UPDATE source_records SET payload=? WHERE id=?').run(canonicalJson(payload), row.id!);
    const before = String(f.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(f.key)!.value);
    new BenchmarkMaterialReprojection(f.context()).refresh(f.request(), f.account);
    const current = f.db.prepare('SELECT * FROM source_records WHERE id=?').get(row.id!)!;
    assert.equal(JSON.parse(String(current.payload)).provider_metadata.metrics.plays, null); assert.equal(JSON.parse(String(current.payload)).body, '人工补充完整正文');
    assert.equal(read(f, current)!.value, '215879'); assert.equal(String(f.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(f.key)!.value), before);
  } finally { f.cleanup(); }
});
