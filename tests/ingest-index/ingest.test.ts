import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { KnowledgeIndex } from '../../packages/domain/src/knowledge-index/index.ts';
import { Documents } from '../../packages/domain/src/documents/index.ts';
import { Topics } from '../../packages/domain/src/topics/index.ts';
import { Jobs } from '../../packages/domain/src/jobs/index.ts';
import { sha256, transaction } from '../../packages/storage/src/connection/index.ts';
import { sourceRow, getCheckpoint, ensureSource, upsertSourceRecord } from '../../packages/storage/src/sources/index.ts';
import { canonicalWorks } from '../../packages/storage/src/identity/index.ts';
import { rankText } from '../../packages/storage/src/knowledge-index/index.ts';
import { PersonalSiteAdapter, normalizePersonalSiteRecord } from '../../packages/adapters/src/personal-site/index.ts';
import { parseVaultMarkdown, VaultAdapter } from '../../packages/adapters/src/vault/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { createIngestHandlers } from '../../apps/service/src/worker/handlers/ingest/index.ts';
import { fixture, evidence } from './harness.ts';

const response = (id = 'event001') => ({ schemaVersion: 1, generatedAt: '2026-10-10T05:00:00Z', items: [{ id, eventId: id, title: '中文检索与作者区分', summary: '资料正文懒加载', category: 'industry', source: { name: 'Publisher' }, links: { original: 'https://example.com/' + id, site: 'https://site.example.invalid/hot/event/' + id + '/' }, publishedAt: '2026-10-10T04:00:00Z' }] });
function fakeFetcher(value: unknown): typeof fetch { return async () => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', etag: 'fixture' } }); }
function streamSource(f: ReturnType<typeof fixture>, stream = 'items') { new Sources(f.context()).ensurePublicSources('https://site.example.invalid'); return String(f.context().db.prepare('SELECT id FROM sources WHERE workspace_id=? AND external_id=?').get(f.identity.workspace_id, stream)!.id); }

test('公开流实际批次事务、重复拉取、收藏、主题关联、重启读取与正文懒载', async () => { const f = fixture(); try {
  const sources = new Sources(f.context()), id = streamSource(f); const first = await sources.ingest(id, { fetcher: fakeFetcher(response()) }), second = await sources.ingest(id, { fetcher: fakeFetcher(response()) });
  assert.equal(first.inserted, 1); assert.equal(second.inserted, 0); const page = sources.records(f.request()); assert.equal(page.items.length, 1); assert.equal('body' in page.items[0]!, false); assert.equal(page.items[0]!.author_name, null);
  const record = page.items[0]!.id; sources.marks(f.request(), record, { favorite: true, read: true }); assert.equal(sources.records(f.request(), { favorite: true }).items.length, 1);
  const topic = await new Topics(f.context()).create(f.request(), { title: '测试主题', category: 'AI 实测', audience: '内部规则', source_ids: [] }); sources.linkTopic(f.request(), topic.id, { record_id: record, usage: 'evidence', locator: 'paragraph:1' }); sources.linkTopic(f.request(), topic.id, { record_id: record, usage: 'evidence', locator: 'paragraph:1' }); assert.equal(f.context().db.prepare('SELECT COUNT(*) AS n FROM topic_sources').get()!.n, 1);
  f.reopen(); const persisted = new Sources(f.context()).detail(f.request(), record); assert.equal(persisted.favorite, true); assert.equal(persisted.source_locations.length, 1); assert.equal(persisted.body, null);
  const checkpoint = getCheckpoint(f.context().db, f.identity.workspace_id, String(sourceRow(f.context().db, f.identity.workspace_id, id).connector_id), 'items'); assert.equal(checkpoint?.mode, 'full_static');
  evidence('public-fixture.json', { grade: 'internal_rule', first, second, persisted, checkpoint, topic_id: topic.id });
} finally { f.cleanup(); } });

test('批次中出错全回滚、checkpoint不前移；原始失败请求有独立证据', async () => { const f = fixture(); try {
  const sources = new Sources(f.context()), id = streamSource(f), payload = response(); payload.items.push({ ...payload.items[0]!, id: 'event002', eventId: 'event002', links: { original: 'https://example.com/other', site: 'https://site.example.invalid/hot/event/event002/' } });
  f.context().db.exec("CREATE TRIGGER wp11_fail BEFORE INSERT ON source_records WHEN NEW.external_id='event002' BEGIN SELECT RAISE(ABORT,'batch fixture failure'); END;");
  await assert.rejects(sources.ingest(id, { fetcher: fakeFetcher(payload) })); assert.equal(sources.records(f.request()).items.length, 0); assert.equal(f.context().db.prepare('SELECT COUNT(*) AS n FROM sync_checkpoints').get()!.n, 0);
  const adapter = new PersonalSiteAdapter({ baseUrl: 'https://site.example.invalid', stream: 'items', rawRoot: join(f.paths.state_root, 'ingest-raw'), fetcher: async () => new Response('unavailable', { status: 503 }) }); await assert.rejects(adapter.fetchBatch(null));
  evidence('atomic-rollback.json', { grade: 'internal_rule', rows: 0, checkpoints: 0, http_error_kept_separate: true });
} finally { f.cleanup(); } });

test('Vault hash确认增量、500批次断线后重启续扫，原文件hash不变', async () => { const f = fixture(); try {
  for (let i = 0; i < 503; i++) writeFileSync(join(f.paths.source_vault_root, `${String(i).padStart(4, '0')}.md`), `# 资料 ${i}\n\n中文检索正文 ${i}\n`);
  const before = sha256(readFileSync(join(f.paths.source_vault_root, '0000.md'))), index = new KnowledgeIndex(f.context()); let seen = 0;
  await assert.rejects(index.scan({ roots: [f.paths.source_vault_root], mode: 'initial' }, { afterBatch(checkpoint) { seen++; assert.equal(checkpoint.next_offset, 500); throw new Error('simulated disconnect after committed batch'); } })); assert.equal(seen, 1); assert.equal(f.context().db.prepare('SELECT COUNT(*) AS n FROM index_entries').get()!.n, 500);
  f.reopen(); const continued = await new KnowledgeIndex(f.context()).scan({ roots: [f.paths.source_vault_root], mode: 'initial' }); assert.equal(continued.parsed, 3); assert.equal(continued.total, 503);
  const incremental = await new KnowledgeIndex(f.context()).scan({ roots: [f.paths.source_vault_root], mode: 'incremental' }); assert.equal(incremental.parsed, 0); assert.equal(incremental.unchanged, 503);
  assert.equal(sha256(readFileSync(join(f.paths.source_vault_root, '0000.md'))), before);
  const file = join(f.paths.source_vault_root, '0000.md'), beforeTime = (await import('node:fs/promises')).stat(file); const stat = await beforeTime; writeFileSync(file, '# 资料 0\n\n中文检索正文 X\n'); utimesSync(file, stat.atime, stat.mtime);
  const changed = await new KnowledgeIndex(f.context()).scan({ roots: [f.paths.source_vault_root], mode: 'incremental' }); assert.equal(changed.parsed, 1);
  evidence('checkpoint-recovery.json', { grade: 'internal_rule', first_committed_batch: 500, resumed: continued, unchanged: incremental, same_mtime_changed_hash: changed, before, after: before });
} finally { f.cleanup(); } });

test('相同平台作品跨源只计canonical一次，原作者/回复者/引用者分开，pending可枚举', async () => { const f = fixture(); try {
  writeFileSync(join(f.paths.source_vault_root, 'a.md'), '---\nplatform: x\nplatform_work_id: 12345\nurl: https://x.com/author/status/12345\noriginal_author: 原作者\nreply_author: 回复者\nquoted_author: 引用者\ncaptured_at: 2026-10-01T00:00:00Z\n---\n# 作品甲\n\n同一个作品的历史资料');
  await new KnowledgeIndex(f.context()).scan({ roots: [f.paths.source_vault_root], mode: 'initial' });
  const db = f.context().db; transaction(db, () => { const source = ensureSource(db, f.identity.workspace_id, 'fixture_personal_site', 'fixture:site', 'work'); const parsed = parseVaultMarkdown('increment.md', Buffer.from('---\nplatform: x\nplatform_work_id: 12345\nurl: https://x.com/other/status/12345\noriginal_author: 原作者\n---\n# 增量作品\n正文')); upsertSourceRecord(db, f.identity.workspace_id, source, parsed, { external_id: '12345', kind: 'fixture_site', relative_path: null, source_url: parsed.canonical_url, capture_time: null, sha256: sha256('fixture increment'), parser_version: 'fixture/1', availability: 'available', raw_response_ref: null }); });
  assert.equal(canonicalWorks(db, f.identity.workspace_id).length, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_records').get()!.n, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_locations').get()!.n, 2);
  const parsed = parseVaultMarkdown('roles.md', Buffer.from('---\noriginal_author: 张三\nreply_author: 李四\nquoted_author: 王五\n---\n# 作者区分\n正文')); assert.equal(parsed.payload.author_name, '张三'); assert.equal(parsed.payload.reply_author_name, '李四'); assert.equal(parsed.payload.quoted_author_name, '王五'); assert.equal(parsed.payload.provider_metadata.observed_at, null);
  const account = new Sources(f.context()).createAccount(f.request(), { role: 'benchmark', platform: 'x', url: 'https://x.com/pending', name: '待核对账号' }); assert.equal(account.identity_status, 'pending'); assert.equal(new Sources(f.context()).accounts(f.request(), { identity_status: 'pending' }).items.length, 1);
  evidence('source-identity-links.json', { grade: 'internal_rule', canonical: canonicalWorks(db, f.identity.workspace_id), source_locations: db.prepare('SELECT * FROM source_locations').all(), account, parsed_roles: parsed.payload });
} finally { f.cleanup(); } });

test('失效fence和取消拒绝晚到批次；持久任务沿用worker共用finalizer', async () => { const f = fixture(); try {
  const sources = new Sources(f.context()), id = streamSource(f), queued = sources.sync(f.request(), id, {}), jobs = new Jobs(f.context()), claim = jobs.claim('wp11-fixture')!;
  let release!: () => void; const waiting = new Promise<void>(done => { release = done; }); let started!: () => void; const ready = new Promise<void>(done => { started = done; });
  const late = sources.ingest(id, { fence: claim.fence, fetcher: async () => { started(); await waiting; return new Response(JSON.stringify(response())); } }); await ready; const job = jobs.get(f.request(), queued.job_id).job; jobs.cancel(f.request(), job.id, { expected_version: job.version }); release(); await assert.rejects(late, (error: unknown) => error instanceof Error && error.message.includes('失效')); assert.equal(sources.records(f.request()).items.length, 0);
  writeFileSync(join(f.paths.source_vault_root, 'worker.md'), '# worker资料\n\n中文正文'); const indexed = new KnowledgeIndex(f.context()).start(f.request(), { roots: [f.paths.source_vault_root], mode: 'initial' }); const result = await new DurableWorker(f.context(), createIngestHandlers(f.context())).runOnce(); assert.equal(result?.job_id, indexed.job_id); assert.equal(result?.state, 'committed'); assert.equal(jobs.get(f.request(), indexed.job_id).job.state, 'succeeded');
  evidence('cancel-fence-worker.json', { grade: 'internal_rule', cancelled: jobs.get(f.request(), queued.job_id), indexed: jobs.get(f.request(), indexed.job_id), result });
} finally { f.cleanup(); } });

test('索引重建与文件删除保留笔记修订、主题、作品、采用、发布运营行', async () => { const f = fixture(); try {
  writeFileSync(join(f.paths.source_vault_root, 'history.md'), '# 历史资料\n\n原文'); const index = new KnowledgeIndex(f.context()); await index.scan({ roots: [f.paths.source_vault_root], mode: 'initial' });
  const document = await new Documents(f.context()).create(f.request(), { kind: 'user_note', initial_text: '# 人工笔记\n人工不可覆盖' }), topic = await new Topics(f.context()).create(f.request(), { title: '运营主题', category: '个人思考', audience: '读者', source_ids: [] });
  const before = JSON.stringify(f.context().db.prepare('SELECT * FROM documents ORDER BY id').all()); const refs = JSON.stringify(f.context().db.prepare('SELECT * FROM topics ORDER BY id').all());
  await index.scan({ roots: [f.paths.source_vault_root], mode: 'initial' }); rmSync(join(f.paths.source_vault_root, 'history.md')); const missing = await index.scan({ roots: [f.paths.source_vault_root], mode: 'incremental' }); assert.equal(missing.missing, 1);
  assert.equal(JSON.stringify(f.context().db.prepare('SELECT * FROM documents ORDER BY id').all()), before); assert.equal(JSON.stringify(f.context().db.prepare('SELECT * FROM topics ORDER BY id').all()), refs); assert.equal((await new Documents(f.context()).get(f.request(), document.document_id)).text, '# 人工笔记\n人工不可覆盖'); assert.equal(f.context().db.prepare('SELECT availability FROM source_locations').get()!.availability, 'offline');
  evidence('rebuild-preservation.json', { grade: 'internal_rule', document_id: document.document_id, head_revision_id: document.head_revision_id, topic_id: topic.id, documents_sha256: sha256(before), topics_sha256: sha256(refs), missing });
} finally { f.cleanup(); } });

test('中文搜索按标题/作者/回复/引用/正文权重，返回真实引用行；解析错误和symlink隔离', async () => { const f = fixture(); try {
  writeFileSync(join(f.paths.source_vault_root, 'search.md'), '---\noriginal_author: 王小明\nreply_author: 陈回复\nquoted_author: 张引用\n---\n# 中文测试标题\n\n第一段正文\n第二段检索位置'); writeFileSync(join(f.paths.source_vault_root, 'broken.md'), '---\nauthor: 没有结束'); symlinkSync(join(f.paths.source_vault_root, 'search.md'), join(f.paths.source_vault_root, 'link.md'));
  const index = new KnowledgeIndex(f.context()), scan = await index.scan({ roots: [f.paths.source_vault_root], mode: 'initial' }); assert.equal(scan.errors, 1); assert.equal(scan.total, 2); const hit = await index.search(f.request(), { query: '检索位置', types: ['source'] }); assert.equal(hit.items.length, 1); assert.equal(hit.items[0]!.locator.relative_path, 'search.md'); assert.equal(hit.items[0]!.locator.line, 9); assert.ok(readFileSync(join(f.paths.source_vault_root, 'search.md'), 'utf8').split('\n')[Number(hit.items[0]!.locator.line) - 1]!.includes('检索位置'));
  const roles = (await index.search(f.request(), { query: '陈回复', types: ['source'] })).items[0]!.locator.matched_roles; assert.equal(Array.isArray(roles) && roles.includes('reply_author'), true);
  assert.ok(rankText('中文', { title: '中文', body: '' }) > rankText('中文', { title: '', body: '中文' })); assert.ok(rankText('小明', { author: '王小明' }) > rankText('小明', { reply_author: '王小明' })); assert.equal((await index.search(f.request(), { query: '不存在的汉字词', types: ['source'] })).items.length, 0);
  await assert.rejects(index.scan({ roots: ['/tmp/unapproved'], mode: 'initial' })); const discovered = await new VaultAdapter(f.paths.source_vault_root).discover(); assert.equal(discovered.length, 2);
  evidence('search-rule.json', { grade: 'internal_rule', scan, hit, author_weights: { title: 100, author: 60, reply_author: 45, quoted_author: 40, summary: 30, body: 20 } });
} finally { f.cleanup(); } });

test('懒载事件正文保留文章发布时间，随后摘要同步保留详情引用hash', async () => { const f = fixture(); try {
  const sources = new Sources(f.context()), id = streamSource(f), article = response('article-time'); article.items[0]!.publishedAt = '2026-10-09T19:09:44Z'; await sources.ingest(id, { fetcher: fakeFetcher(article) });
  const row = sources.records(f.request()).items[0]!; const body = await sources.readDetail(f.request(), row.id, undefined, fakeFetcher({ schemaVersion: 1, event: { id: 'event-time', title: '事件详情', firstAt: '2026-10-06T12:00:00Z', brief: { overview: '事件正文精确命中' } } }));
  assert.equal(body.published_at, row.published_at); const before = (await new KnowledgeIndex(f.context()).search(f.request(), { query: '事件正文精确命中', types: ['source'] })).items[0]!;
  await sources.ingest(id, { fetcher: fakeFetcher(article) }); const after = (await new KnowledgeIndex(f.context()).search(f.request(), { query: '事件正文精确命中', types: ['source'] })).items[0]!; assert.equal(after.locator.source_location_id, before.locator.source_location_id); assert.equal(after.locator.sha256, before.locator.sha256);
  evidence('review-R9-published-body-provenance.json', { grade: 'internal_rule', article_published_at: row.published_at, detail_published_at: body.published_at, before, after });
} finally { f.cleanup(); } });

test('较少字段公开摘要不清空Vault作者角色与frontmatter归属，不冒用本站raw引用历史正文', async () => { const f = fixture(); try {
  writeFileSync(join(f.paths.source_vault_root, 'roles-source.md'), '---\nurl: https://example.com/roles-source\noriginal_author: 王小明\nreply_author: 陈回复\nquoted_author: 张引用\n---\n# 角色资料\n\n历史正文唯一短语'); const index = new KnowledgeIndex(f.context()); await index.scan({ roots: [f.paths.source_vault_root], mode: 'initial' });
  const sources = new Sources(f.context()), site = streamSource(f); await sources.ingest(site, { fetcher: fakeFetcher(response('roles-source')) }); const detail = sources.detail(f.request(), sources.records(f.request()).items[0]!.id); assert.deepEqual([detail.author_name, detail.reply_author_name, detail.quoted_author_name], ['王小明','陈回复','张引用']);
  const row = f.context().db.prepare('SELECT payload FROM source_records WHERE id=?').get(detail.id)!; assert.equal(JSON.parse(String(row.payload)).provider_metadata.frontmatter.original_author, '王小明'); const hit = (await index.search(f.request(), { query: '历史正文唯一短语', types: ['source'] })).items[0]!; assert.equal(hit.locator.relative_path, 'roles-source.md');
  assert.equal(sources.records(f.request(), { source: site }).items.length, 1);
  writeFileSync(join(f.paths.source_vault_root, 'z-conflict.md'), '---\nurl: https://example.com/roles-source\noriginal_author: 另一个原作者候选\n---\n# 冲突归属\n保留待核对依据'); await index.scan({ roots: [f.paths.source_vault_root], mode: 'initial' }); const conflict = sources.detail(f.request(), detail.id); assert.equal(conflict.author_name, '王小明'); assert.ok(conflict.parser_warnings.some(value => value.includes('不同来源候选')));
  const claims = JSON.parse(String(f.context().db.prepare('SELECT payload FROM source_records WHERE id=?').get(detail.id)!.payload)).provider_metadata.author_role_claims; assert.ok(claims.some((value: {name:string}) => value.name === '王小明')); assert.ok(claims.some((value: {name:string}) => value.name === '另一个原作者候选'));
  evidence('review-R10-role-provenance.json', { grade: 'internal_rule', detail, hit, conflict, claims, original_author_provenance_retained: true });
} finally { f.cleanup(); } });

test('来源筛选与全部hash离线按Vault source命名空间隔离，双根同路径不串入或误伤', async () => { const f = fixture(); try {
  const sources = new Sources(f.context()), site = streamSource(f); await sources.ingest(site, { fetcher: fakeFetcher(response('shared-root')) }); const originalRoot = f.paths.source_vault_root, secondRoot = join(f.root, 'second-vault'); mkdirSync(secondRoot);
  const file = join(originalRoot, 'same.md'), content = '---\nurl: https://example.com/shared-root\n---\n# 共用作品\n版本 A'; writeFileSync(file, content); await new KnowledgeIndex(f.context()).scan({ roots: [originalRoot], mode: 'initial' });
  const sourceA = String(f.context().db.prepare("SELECT id FROM sources WHERE kind='vault' AND url=?").get(originalRoot)!.id); assert.equal(sources.records(f.request(), { source: sourceA }).items.length, 1);
  writeFileSync(file, content.replace('版本 A', '版本 B')); await new KnowledgeIndex(f.context()).scan({ roots: [originalRoot], mode: 'incremental' }); const changed = f.context().db.prepare('SELECT availability FROM source_locations WHERE kind=? ORDER BY created_at,id').all('vault:' + sourceA); assert.deepEqual(changed.map(row => row.availability).sort(), ['available','offline']);
  writeFileSync(join(secondRoot, 'same.md'), content.replace('版本 A', '版本 B')); writeFileSync(join(secondRoot, 'only-b.md'), '# 只在根 B\n根 B 唯一正文'); f.context().db.prepare('UPDATE workspaces SET paths=? WHERE id=?').run(JSON.stringify({ ...f.paths, source_vault_root: secondRoot }), f.identity.workspace_id); await new KnowledgeIndex(f.context()).scan({ roots: [secondRoot], mode: 'initial' });
  const sourceB = String(f.context().db.prepare("SELECT id FROM sources WHERE kind='vault' AND url=?").get(secondRoot)!.id); assert.equal(sources.records(f.request(), { source: sourceA }).items.length, 1); assert.equal(sources.records(f.request(), { source: sourceB }).items.length, 2);
  f.context().db.prepare('UPDATE workspaces SET paths=? WHERE id=?').run(JSON.stringify(f.paths), f.identity.workspace_id); rmSync(file); await new KnowledgeIndex(f.context()).scan({ roots: [originalRoot], mode: 'incremental' });
  const locations = f.context().db.prepare('SELECT kind,relative_path,sha256,availability FROM source_locations WHERE kind LIKE ? ORDER BY kind,sha256').all('vault:%'); assert.ok(locations.filter(row => row.kind === 'vault:' + sourceA).every(row => row.availability === 'offline')); assert.ok(locations.filter(row => row.kind === 'vault:' + sourceB).every(row => row.availability === 'available')); assert.equal(f.context().db.prepare('SELECT COUNT(*) AS n FROM source_records').get()!.n, 2);
  evidence('review-R11-R14-root-offline.json', { grade: 'internal_rule', source_a: sourceA, source_b: sourceB, source_filtered_counts: [1,2], locations, operational_records_preserved: 2 });
} finally { f.cleanup(); } });

test('真实来源详情不可用时保留已入库摘要与原文，不使既有阅读页面失效', async () => { const f = fixture(); try {
  const sources = new Sources(f.context()), id = streamSource(f); await sources.ingest(id, { fetcher: fakeFetcher(response()) }); const record = sources.records(f.request()).items[0]!.id;
  const unavailable = await sources.readDetail(f.request(), record, undefined, async () => new Response('missing detail', { status: 404 })); assert.equal(unavailable.body, null); assert.equal(unavailable.summary, '资料正文懒加载'); assert.ok(unavailable.parser_warnings.includes('详情当前不可用；保留摘要和原文链接。')); assert.equal(unavailable.external_links[0], 'https://example.com/event001');
  evidence('detail-unavailable.json', { grade: 'internal_rule', unavailable, limitation: '404 is retained as source detail unavailable, never passed as complete detail' });
} finally { f.cleanup(); } });

test('captured/published排序明确分开、过滤任何保留来源出处、cursor绑定order', async () => { const f = fixture(); try {
  const sources = new Sources(f.context()), items = streamSource(f), events = streamSource(f, 'events'); const early = response('early'); early.items[0]!.publishedAt = '2026-10-10T00:00:00Z'; await sources.ingest(items, { fetcher: fakeFetcher(early) });
  const laterCapture = response('later-capture'); laterCapture.items[0]!.publishedAt = '2026-10-09T00:00:00Z'; await sources.ingest(items, { fetcher: fakeFetcher(laterCapture) });
  const captured = sources.records(f.request(), { order: 'captured_desc', limit: 1 }), published = sources.records(f.request(), { order: 'published_desc', limit: 1 }); assert.notEqual(captured.items[0]!.id, published.items[0]!.id); assert.equal(published.items[0]!.canonical_url, 'https://example.com/early');
  assert.throws(() => sources.records(f.request(), { order: 'published_desc', limit: 1, cursor: captured.next_cursor! }));
  await sources.ingest(events, { fetcher: fakeFetcher({ schemaVersion: 1, generatedAt: '2026-10-10T00:00:00Z', events: [early.items[0]] }) }); assert.equal(sources.records(f.request(), { source: events }).items.length, 1);
  evidence('sorting-and-filter-scope.json', { grade: 'internal_rule', captured_id: captured.items[0]!.id, published_id: published.items[0]!.id, switch_order_rejected: true, retained_alternate_source_filter_count: 1 });
} finally { f.cleanup(); } });

test('schema6迁移旧空payload保留未知与原出处，列表详情均可读且不写回', async () => { const f = fixture(); try {
  const sources = new Sources(f.context()), source = streamSource(f), db = f.context().db, id = randomUUID();
  db.prepare('INSERT INTO source_records(id,workspace_id,source_id,external_id,canonical_url,record_kind,content_status) VALUES (?,?,?,?,?,?,?)').run(id, f.identity.workspace_id, source, 'legacy', 'https://example.com/legacy', 'site_item', 'summary_only');
  const row = sources.records(f.request()).items[0]!; assert.equal(row.title, 'https://example.com/legacy'); assert.equal(row.author_name, null);
  const detail = await sources.readDetail(f.request(), id); assert.equal(detail.body, null); assert.ok(detail.parser_warnings[0]!.includes('历史记录'));
  const knowledge = await new KnowledgeIndex(f.context()).list(f.request()); assert.equal(knowledge.items[0]!.id, id);
  assert.equal(db.prepare('SELECT payload FROM source_records WHERE id=?').get(id)!.payload, '{}');
  evidence('legacy-payload.json', { grade: 'internal_rule', row, detail, payload_unchanged: true });
} finally { f.cleanup(); } });
