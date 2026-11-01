import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { KnowledgeIndex } from '../../packages/domain/src/knowledge-index/index.ts';
import { Topics } from '../../packages/domain/src/topics/index.ts';
import { PERSONAL_SITE_STREAMS } from '../../packages/adapters/src/personal-site/index.ts';
import { fixture, evidence, runRoot, projectRoot } from './harness.ts';
const f = fixture(), receipts: unknown[] = [], startedAt = new Date().toISOString();
let failed: unknown = null;
try {
  const sources = new Sources(f.context()); sources.ensurePublicSources();
  for (const stream of PERSONAL_SITE_STREAMS) {
    const id = String(f.context().db.prepare('SELECT id FROM sources WHERE workspace_id=? AND external_id=?').get(f.identity.workspace_id, stream)!.id);
    const first = await sources.ingest(id), count = Number(f.context().db.prepare('SELECT COUNT(*) AS n FROM source_records').get()!.n), second = await sources.ingest(id), afterCount = Number(f.context().db.prepare('SELECT COUNT(*) AS n FROM source_records').get()!.n);
    assert.equal(second.inserted, 0); assert.equal(afterCount, count); receipts.push({ stream, source_id: id, first, second, before_count: count, after_count: afterCount }); process.stdout.write(`${stream}: ${first.total}/${second.total}, duplicate inserted ${second.inserted}\n`);
  }
  const first = sources.records(f.request()).items[0]!; sources.marks(f.request(), first.id, { favorite: true, read: true }); const topic = await new Topics(f.context()).create(f.request(), { title: first.title, category: first.category, audience: 'WP11隔离真实公开来源核对', source_ids: [first.id] });
  const detailReceipts: unknown[] = [];
  for (const kind of ['site_item', 'site_event', 'site_daily']) { const stream = kind === 'site_item' ? 'items' : kind === 'site_daily' ? 'dailies' : 'events'; const checkpoint = (receipts.find(row => (row as {stream:string}).stream === stream) as {first:{checkpoint:{seen_ids:string[]}}}).first.checkpoint; const row = f.context().db.prepare('SELECT id FROM source_records WHERE record_kind=? AND external_id=? ORDER BY id LIMIT 1').get(kind, checkpoint.seen_ids[0]!); if (row) { const before = sources.detail(f.request(), String(row.id)), detail = await sources.readDetail(f.request(), String(row.id)); assert.ok(detail.body?.length, 'provider returned summary-only detail: '+kind); assert.equal(detail.published_at, before.published_at, 'detail must retain record publication semantics'); detailReceipts.push({ record_id: detail.id, kind, title: detail.title, published_at_before: before.published_at, published_at_after: detail.published_at, body_bytes: Buffer.byteLength(detail.body!), external_links: detail.external_links, source_locations: detail.source_locations, author_name: detail.author_name }); } }
  const index = new KnowledgeIndex(f.context());
  const samples = [
    ['中文命中','数学研究'],['中文命中','蛋白质'],['中文命中','智能体'],['中文命中','谷歌'],['中文命中','生成式'],['中文命中','模型'],['中文命中','开源'],['中文命中','安全'],['中文命中','代理'],['中文命中','浏览器'],['中文命中','训练'],['中文命中','代码'],['中文命中','融资'],['中文命中','视频'],['中文命中','工作流'],
    ['人名/机构','Hinton'],['人名/机构','Simon Willison'],['人名/机构','Anthropic'],['空结果','无此名字吴永远不存在6294'],['空结果','虾皮会飞不存在中文样例6294'],
  ];
  const searchResults: unknown[] = [];
  for (const [kind, query] of samples) { const page = await index.search(f.request(), { query: query!, types: ['source'] }); if (kind === '空结果') assert.equal(page.items.length, 0); else assert.ok(page.items.length > 0, `actual public sample no hit: ${query}`); searchResults.push({ kind, query, actual_hits_first50: page.items.length, top: page.items.slice(0, 3) }); }
  const locations = f.context().db.prepare('SELECT id,record_id,kind,relative_path,source_url,sha256,parser_version,availability,raw_response_ref FROM source_locations ORDER BY id').all();
  const rawDir = join(runRoot, 'ingest-raw'); cpSync(join(f.paths.state_root, 'ingest-raw'), rawDir, { recursive: true });
  const evidencePath = evidence('real-provider.json', { grade: 'real_provider', scope: 'four public anonymous informational streams; isolated SQLite; no real Vault/benchmark work identity', started_at: startedAt, completed_at: new Date().toISOString(), streams: receipts, detail: detailReceipts, favorite: sources.records(f.request(), { favorite: true }).items.map(row => row.id), topic_id: topic.id, source_locations: locations,
    raw_response_mapping: { from: join(f.paths.state_root, 'ingest-raw'), to: rawDir }, source_records: f.context().db.prepare('SELECT COUNT(*) AS n FROM source_records').get()!.n, works: f.context().db.prepare('SELECT COUNT(*) AS n FROM works').get()!.n, integrity: f.context().db.prepare('PRAGMA integrity_check').all(), foreign_keys: f.context().db.prepare('PRAGMA foreign_key_check').all() });
  evidence('search-quality.json', { grade: 'real_provider', corpus: 'newly requested public content only', count: searchResults.length, samples: searchResults });
  mkdirSync(join(projectRoot, '.ci-artifacts/evidence/wp-11/ingest-raw'), { recursive: true });
  writeFileSync(join(projectRoot, '.ci-artifacts/evidence/wp-11/ingest-raw', `run-${relative(runRoot, rawDir) === 'ingest-raw' ? runRoot.split('/').at(-1) : Date.now()}.json`), JSON.stringify({ grade: 'real_provider', evidence_ref: relative(projectRoot, evidencePath), raw_root: relative(projectRoot, rawDir) }, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`real public search samples: ${searchResults.length}; evidence ${relative(projectRoot, evidencePath)}\n`);
} catch (error) {
  failed = { code: error instanceof Error ? error.name : 'UNKNOWN', message: error instanceof Error ? error.message : 'failed', details: error && typeof error === 'object' && 'details' in error ? error.details : null };
  if (existsSync(join(f.paths.state_root, 'ingest-raw'))) cpSync(join(f.paths.state_root, 'ingest-raw'), join(runRoot, 'ingest-raw'), { recursive: true });
  evidence('real-provider-failed.json', { grade: 'real_provider', started_at: startedAt, completed_at: new Date().toISOString(), receipts, error: failed }); throw error;
} finally { f.cleanup(); }
