import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { SourceRecordPayload } from '../../packages/contracts/src/index.ts';
import { sha256, canonicalJson } from '../../packages/storage/src/connection/index.ts';
import { parseBenchmarkFeed } from '../../packages/adapters/src/tikhub/benchmark-feed.ts';
import { TikHubAdapter } from '../../packages/adapters/src/tikhub/index.ts';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { BenchmarkSync } from '../../packages/domain/src/sources/benchmark-sync.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { fixture, projectRoot } from '../documents/harness.ts';
import { inspectBenchmarkMaterialCopy, projectSavedBenchmarkMaterials, projectionCopyOptions } from '../../scripts/runtime/reproject-benchmark-materials.ts';

const at = '2026-10-13T00:00:00Z', xUrl = 'https://x.com/bench', sec = 'MS4w' + 'a'.repeat(20), dyUrl = 'https://www.douyin.com/user/' + sec;
const heic = 'https://p3-pc.douyinpic.com/c~tplv-dy.heic?sign=real-heic', jpeg = 'https://p3-pc.douyinpic.com/c~tplv-dy.jpeg?sign=real-jpeg';
const tweet = (fields: Record<string, unknown> = {}) => ({ tweet_id: '101', text: '平台说明', created_at: at, author: { id_str: '123', screen_name: 'bench', name: '作者' }, ...fields });
function oldPayload(): SourceRecordPayload {
  return { title: '已整理标题', summary: '已整理摘要', body: '人工保留正文\n完整转写', category: '对标内容', author_name: '已核对作者', reply_author_name: null, quoted_author_name: null, external_links: ['https://example.com/source'], identity_status: 'confirmed', parser_warnings: ['原始来源说明'], media: [{ type: 'cover', url: heic }, { type: 'image', path: '/saved/local.jpg', asset_id: 'local-asset' }], provider_metadata: { curation: { selected: true, rank: 1, reason: '人工选定' }, source_name: '保留出处', metrics: { likes: '999', views: '999' }, body_parser_version: 'old-body/1', duration_ms: '9999', format: 'short_video' } };
}
function project(platform: 'x' | 'douyin', body: unknown, existing = oldPayload()) {
  const raw = JSON.stringify(body), accountUrl = platform === 'x' ? xUrl : dyUrl;
  return projectSavedBenchmarkMaterials({ platform, account_url: accountUrl, platform_account_id: '123', raw_body: raw, raw_sha256: sha256(raw), evidence_kind: 'real_platform', existing: [{ external_id: platform === 'x' ? '101' : '201', canonical_url: platform === 'x' ? xUrl + '/status/101' : 'https://www.douyin.com/video/201', payload: existing }] })[0]!;
}
function douyin(fields: Record<string, unknown> = {}) {
  return { data: { aweme_list: [{ aweme_id: '201', desc: '平台视频', create_time: 1720000000, author: { uid: '123', sec_uid: sec }, ...fields }] } };
}

test('离线投影保留真实零值；缺失、非法与不安全指标保持未知', () => {
  const zero = project('x', { data: { timeline: [tweet({ favorites: 0, views: '0', retweets: 0, replies: 0 })] } });
  assert.deepEqual(zero.payload.provider_metadata.metrics, { likes: '0', reposts: '0', replies: '0', views: '0', bookmarks: null, quotes: null });
  for (const value of [undefined, null, '', '00', '-1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true]) {
    const result = project('x', { data: { timeline: [tweet({ favorites: value, views: value })] } });
    assert.equal((result.payload.provider_metadata.metrics as any).likes, null, String(value));
    assert.equal((result.payload.provider_metadata.metrics as any).views, null, String(value));
  }
  const d = project('douyin', douyin({ statistics: { digg_count: 0, play_count: 0, collect_count: 0 } }));
  assert.equal((d.payload.provider_metadata.metrics as any).likes, '0');
  assert.equal((d.payload.provider_metadata.metrics as any).saves, '0');
  assert.equal((d.payload.provider_metadata.metrics as any).plays, null);
  assert.equal(d.payload.provider_metadata.play_count_raw, '0');
});

test('时长从真实 raw 重算；缺失、非法和零时长不会沿用旧值', () => {
  const video = { cover: { url_list: [heic, jpeg] }, play_addr: { url_list: ['https://v5-dy.zjcdn.com/v.mp4'] } };
  for (const duration of [undefined, null, '', -1, 'bad', 1.5, Number.MAX_SAFE_INTEGER + 1, 0]) {
    const result = project('douyin', douyin({ video: { ...video, duration } }));
    assert.equal(result.summary.media_type, 'video'); assert.equal(result.summary.duration_ms, null, String(duration));
    assert.equal(result.payload.provider_metadata.duration_ms, duration === 0 ? '0' : null);
  }
  const result = project('douyin', douyin({ video: { ...video, duration: 65340 } }));
  assert.equal(result.payload.provider_metadata.duration_ms, '65340'); assert.equal(result.summary.duration_ms, '65340');
  const x = project('x', { data: { timeline: [tweet({ media: { video: [{ media_url_https: 'https://pbs.twimg.com/v.jpg', duration: 4000, variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/v.mp4' }] }] } })] } });
  assert.equal(x.summary.duration_ms, '4000');
});

test('HEIC 重投影选用平台已有真实 JPEG URL，保留正文、人工整理、出处与本地资产', () => {
  const before = oldPayload(), original = structuredClone(before);
  const result = project('douyin', douyin({ statistics: { digg_count: 0 }, video: { duration: 6000, cover: { url_list: [heic, jpeg] }, play_addr: { url_list: ['https://v5-dy.zjcdn.com/v.mp4'] } } }), before);
  assert.equal(result.summary.preview_url, jpeg); assert.equal(result.changed, true);
  assert.equal(result.payload.media.find(item => item.type === 'cover')?.url, jpeg);
  assert.ok(!result.payload.media.some(item => item.url === heic));
  assert.deepEqual(result.payload.media.find(item => item.asset_id === 'local-asset'), original.media[1]);
  for (const key of ['body', 'title', 'summary', 'category', 'author_name', 'external_links', 'parser_warnings', 'identity_status'] as const) assert.deepEqual(result.payload[key], original[key]);
  assert.deepEqual(result.payload.provider_metadata.curation, original.provider_metadata.curation);
  assert.equal(result.payload.provider_metadata.source_name, original.provider_metadata.source_name);
  assert.equal(result.payload.provider_metadata.body_parser_version, 'old-body/1');
  assert.deepEqual(before, original, '纯函数不能改动输入');
  const onlyHeic = project('douyin', douyin({ video: { cover: { url_list: [heic] } } }));
  assert.equal(onlyHeic.payload.media.find(item => item.type === 'cover')?.url, heic, '没有 JPEG 候选时不能拼接一个新的签名 URL');
  assert.equal(project('douyin', douyin({ video: { cover: { url_list: [heic, jpeg] } } })).summary.preview_url, jpeg, '本地资产不能遮住平台真实封面候选');
});

test('raw hash、身份与证据类别不匹配时明确失败', () => {
  const raw = JSON.stringify({ data: { timeline: [tweet()] } }), input = { platform: 'x' as const, account_url: xUrl, platform_account_id: '123', raw_body: raw, raw_sha256: sha256(raw), evidence_kind: 'real_platform' as const, existing: [{ external_id: '101', canonical_url: xUrl + '/status/101', payload: oldPayload() }] };
  assert.throws(() => projectSavedBenchmarkMaterials({ ...input, raw_sha256: sha256('{}') }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => projectSavedBenchmarkMaterials({ ...input, platform_account_id: '456' }), { code: 'CAPABILITY_UNVERIFIED' });
  assert.throws(() => projectSavedBenchmarkMaterials({ ...input, evidence_kind: 'internal_rule' }), { code: 'CAPABILITY_UNVERIFIED' });
  assert.equal(projectSavedBenchmarkMaterials({ ...input, evidence_kind: 'internal_rule', allow_internal_rule: true }).length, 1);
  assert.throws(() => projectSavedBenchmarkMaterials({ ...input, account_url: 'https://other.example/bench' }), { code: 'CAPABILITY_UNVERIFIED' });
  assert.throws(() => projectSavedBenchmarkMaterials({ ...input, existing: [{ ...input.existing[0]!, canonical_url: 'https://x.com/other/status/101' }] }), { code: 'CAPABILITY_UNVERIFIED' });
});

async function savedCopy() {
  const f = fixture(), sources = new Sources(f.context()), id = sources.createAccount(f.request(), { role: 'benchmark', platform: 'douyin', url: dyUrl, name: '测试作者' }).account_id;
  try {
  const db = f.context().db; db.prepare("UPDATE accounts SET platform_account_id='123',identity_status='confirmed' WHERE id=?").run(id);
  const raw = { code: 200, ...douyin({ statistics: { digg_count: 0 }, video: { duration: 6543, cover: { url_list: [heic, jpeg] }, play_addr: { url_list: ['https://v5-dy.zjcdn.com/v.mp4'] } } }) };
  const sync = new BenchmarkSync(f.context(), new TikHubAdapter({ fixture: true, token_provider: () => 'offline-fixture', fetcher: async () => new Response(JSON.stringify(raw)) }));
  sync.enqueue(f.request(), id);
  const worker = new DurableWorker(f.context(), [{ registration: { kind: 'benchmark_sync', execution_mode: 'programmatic', recovery: 'read_only' }, async execute(e) { await sync.execute(e.claim.job.id, JSON.parse(e.claim.job.input_manifest), { fence: e.claim.fence, signal: e.signal, checkpoint: e.checkpoint }); return { documents: [], recommendations: [] }; } }]);
  assert.equal((await worker.runOnce())?.state, 'committed', JSON.stringify(db.prepare('SELECT error FROM job_attempts ORDER BY rowid DESC LIMIT 1').get()));
  const row = db.prepare('SELECT id FROM source_records WHERE author_account_id=?').get(id)!;
  const payload = oldPayload(); db.prepare('UPDATE source_records SET payload=? WHERE id=?').run(canonicalJson(payload), row.id!);
  const location = db.prepare('SELECT id,raw_response_ref FROM source_locations WHERE record_id=?').get(row.id!)!, ref = JSON.parse(String(location.raw_response_ref));
  ref.adapter_version = 'benchmark-feed/2'; db.prepare("UPDATE source_locations SET parser_version='benchmark-feed/2',raw_response_ref=? WHERE id=?").run(JSON.stringify(ref), location.id!);
  const originalRoot = f.context().paths.state_root, copyRoot = join(f.root, 'projection-copy', 'state'), database = join(f.root, 'projection-copy', 'workbench.sqlite');
  mkdirSync(copyRoot, { recursive: true }); f.closeDb();
  cpSync(join(originalRoot, 'benchmark-runs'), join(copyRoot, 'benchmark-runs'), { recursive: true }); copyFileSync(join(originalRoot, 'workbench.sqlite'), database);
  return { ...f, recordId: String(row.id), ref, originalRoot, options: { database_copy: database, state_copy: copyRoot, workspace_id: f.config.workspace_id } };
  } catch (error) { f.cleanup(); throw error; }
}

test('副本 CLI 只输出提案；旧解析版本可用，原数据库与 raw 保持原字节', async () => {
  const f = await savedCopy(); try {
    const paths = [f.options.database_copy, join(f.originalRoot, 'workbench.sqlite'), f.ref.path], hashes = paths.map(path => sha256(readFileSync(path)));
    const result = inspectBenchmarkMaterialCopy(f.options); assert.equal(result.complete, true, JSON.stringify(result.failures)); assert.equal(result.proposed, 1); assert.equal(result.writes, 0); assert.equal(result.remote_calls, 0);
    const proposal = result.proposals[0]!; assert.equal(proposal.record_id, f.recordId); assert.equal(proposal.previous_parser_version, 'benchmark-feed/2'); assert.deepEqual(proposal.raw_response_ref, f.ref);
    assert.equal((proposal.summary as any).preview_url, jpeg); assert.equal((proposal.payload as any).body, oldPayload().body);
    const stdout = execFileSync(process.execPath, ['scripts/runtime/reproject-benchmark-materials.ts', '--database-copy', f.options.database_copy, '--state-copy', f.options.state_copy, '--workspace', f.options.workspace_id], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(JSON.parse(stdout).proposed, 1); assert.deepEqual(paths.map(path => sha256(readFileSync(path))), hashes);
    assert.throws(() => inspectBenchmarkMaterialCopy({ ...f.options, state_copy: f.originalRoot }), { code: 'VALIDATION_ERROR' });
  } finally { f.cleanup(); }
});

test('损坏 raw 和链接文件保留失败明示，不降级采用旧平台媒体', async () => {
  const f = await savedCopy(); try {
    const copiedRaw = join(f.options.state_copy, 'benchmark-runs', f.ref.path.split('/').at(-2)!, 'response.json');
    writeFileSync(copiedRaw, '{}'); const result = inspectBenchmarkMaterialCopy(f.options);
    assert.equal(result.complete, false); assert.equal(result.proposed, 0); assert.equal(result.failed, 1); assert.equal(result.failures[0]!.code, 'IDEMPOTENCY_CONFLICT');
    const cli = spawnSync(process.execPath, ['scripts/runtime/reproject-benchmark-materials.ts', '--database-copy', f.options.database_copy, '--state-copy', f.options.state_copy, '--workspace', f.options.workspace_id], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(cli.status, 1); assert.equal(JSON.parse(cli.stdout).failed, 1);
    const linkedCopy = join(f.root, 'linked-state'); symlinkSync(f.options.state_copy, linkedCopy);
    assert.throws(() => inspectBenchmarkMaterialCopy({ ...f.options, state_copy: linkedCopy }), { code: 'STORAGE_UNAVAILABLE' });
  } finally { f.cleanup(); }
});

test('CLI 必须显式选择副本；没有默认路径、写入、采集或应用参数', () => {
  assert.throws(() => projectionCopyOptions([]), { code: 'VALIDATION_ERROR' });
  for (const option of ['--apply', '--write', '--fetch', '--config']) assert.throws(() => projectionCopyOptions([option, 'true']), { code: 'VALIDATION_ERROR' });
  assert.throws(() => projectionCopyOptions(['--database-copy', '/copy/a', '--database-copy', '/copy/b']), { code: 'VALIDATION_ERROR' });
  assert.equal(parseBenchmarkFeed('douyin', dyUrl, '123', douyin()).records.length, 1, '复用现有解析器，不用另一套平台规则');
});
