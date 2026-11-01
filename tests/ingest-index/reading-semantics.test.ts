import test from 'node:test';
import assert from 'node:assert/strict';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { KnowledgeIndex } from '../../packages/domain/src/knowledge-index/index.ts';
import { sha256 } from '../../packages/storage/src/connection/index.ts';
import { createSourcesReadFeature, sourceReadingSemantics } from '../../apps/web/src/features/sources/read/index.ts';
import { createKnowledgeReadFeature } from '../../apps/web/src/features/knowledge/read/index.ts';
import { createApprovedPageViews } from '../../apps/web/src/pages/approvedViews.ts';
import { createHttpClient } from '../../apps/web/src/transport/workbench-client.ts';
import { DraftRegistry } from '../../apps/web/src/transport/drafts.ts';
import { initialUi } from '../../apps/web/src/app/view-model.ts';
import type { FeatureContext } from '../../apps/web/src/transport/feature-ports.ts';
import type { JsonObject } from '../../packages/contracts/src/index.ts';
import { fixture, evidence } from './harness.ts';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('合成双报道回放：资料与知识呈现事件解读提示，标题原文与正文保持独立原值', async () => { const f = fixture(), startedAt = new Date().toISOString(); try {
  const eventPath = 'synthetic/event.json', itemsPath = 'synthetic/items.json';
  const eventResponse: JsonObject = { schemaVersion: 1, event: { id: 'synthetic-event', title: '合成事件解读', summary: '合成事件摘要', firstAt: '2024-01-02T12:00:00Z', brief: { tldr: '两篇独立报道归于同一事件。', facts: [{ k: '测试条件', v: '全部资料均为合成。' }] }, links: { original: 'https://example.invalid/event' } } };
  const itemsResponse: JsonObject = { schemaVersion: 1, items: [1, 2].map(i => ({ id: 'synthetic-report-' + i, eventId: 'synthetic-event', title: '合成报道标题 ' + i, summary: '合成报道摘要 ' + i, publishedAt: '2024-01-02T12:00:00Z', source: { name: '合成来源 ' + i }, links: { original: 'https://example.invalid/report-' + i } })) };
  const eventBytes = Buffer.from(JSON.stringify({ body: eventResponse })), itemsBytes = Buffer.from(JSON.stringify({ body: itemsResponse }));
  const event = eventResponse.event as JsonObject, reports = (itemsResponse.items as JsonObject[]).filter(item => item.eventId === event.id); assert.equal(event.id, 'synthetic-event'); assert.equal(reports.length, 2);
  const sources = new Sources(f.context()); sources.ensurePublicSources('https://site.example.invalid'); const sourceId = String(f.context().db.prepare("SELECT id FROM sources WHERE external_id='items'").get()!.id);
  await sources.ingest(sourceId, { fetcher: async () => json({ ...itemsResponse, items: reports }) });
  const snapshots: unknown[] = [], bodyHashes: string[] = [];
  for (const report of reports) {
    const id = String(f.context().db.prepare('SELECT id FROM source_records WHERE external_id=?').get(String(report.id))!.id), detail = await sources.readDetail(f.request(), id, undefined, async () => json(eventResponse));
    const original = String((report.links as JsonObject).original); assert.equal(detail.title, report.title); assert.equal(detail.canonical_url, original); assert.ok(detail.body); bodyHashes.push(sha256(detail.body!));
    const client = createHttpClient('http://fixture.invalid', f.identity, async input => { const url = new URL(String(input));
      if (url.pathname === '/api/v1/identity') return json(f.identity);
      if (url.pathname === '/api/v1/accounts') return json({ items: [], next_cursor: null, has_more: false, last_success_at: null });
      if (url.pathname === '/api/v1/source-records') return json(sources.records(f.request(), { order: 'published_desc' }));
      if (url.pathname.startsWith('/api/v1/source-records/')) return json(sources.detail(f.request(), url.pathname.split('/').at(-1)!));
      if (url.pathname === '/api/v1/knowledge') return json(new KnowledgeIndex(f.context()).list(f.request()));
      throw new Error('unexpected replay path ' + url.pathname);
    });
    let ui = { ...initialUi('sources'), news: id, knowledge: id }; const context: FeatureContext = { client, identity: f.identity, ui, signal: new AbortController().signal, drafts: new DraftRegistry(client, f.identity, { getItem: () => null, setItem() {}, removeItem() {} }), surface: { updateUi(patch) { ui = { ...ui, ...patch }; context.ui = ui; }, editorFeedback() {}, presentDialog() {}, closeDialog() {}, toast() {}, navigate() {} } };
    const sourceContext = await createSourcesReadFeature().load(context), sourceProjection = sourceContext.NEWS.find(row => row.id === id)!, sourceHtml = createApprovedPageViews(sourceContext).sources();
    assert.equal(sourceProjection.bodyLabel, '个人站事件解读'); assert.deepEqual(sourceProjection.notices, [...new Set(detail.parser_warnings)]); assert.equal(sourceProjection.title, report.title); assert.equal(sourceProjection.source, (report.source as JsonObject).name); assert.equal(sourceProjection.body, detail.body); assert.equal(sourceContext.files.get('source-original:' + id), original); assert.ok(sourceHtml.includes('个人站事件解读')); assert.ok(sourceHtml.includes('站点解读不代表每篇外站全文。')); assert.ok(sourceHtml.includes(original));
    ui = { ...ui, page: 'knowledge' }; context.ui = ui; const knowledgeContext = await createKnowledgeReadFeature().load(context), knowledgeProjection = knowledgeContext.KNOWLEDGE.find(row => row.id === id)!, knowledgeHtml = createApprovedPageViews(knowledgeContext).knowledge();
    assert.equal(knowledgeProjection.bodyLabel, '个人站事件解读'); assert.deepEqual(knowledgeProjection.notices, sourceProjection.notices); assert.equal(knowledgeProjection.text, detail.body); assert.equal(knowledgeProjection.title, report.title); assert.ok(knowledgeProjection.refs.includes(original)); assert.ok(knowledgeHtml.includes('个人站事件解读')); assert.ok(knowledgeHtml.includes('站点解读不代表每篇外站全文。'));
    assert.deepEqual(sourceReadingSemantics(undefined), {}); assert.equal(sourceReadingSemantics({ ...detail, parser_warnings: ['原作者待核对'] }).bodyLabel, undefined);
    snapshots.push({ report_id: report.id, record_id: id, title: detail.title, source: sourceProjection.source, original_url: original, body_sha256: sha256(detail.body!), label: sourceProjection.bodyLabel, notices: sourceProjection.notices, source_renderer_sha256: sha256(sourceHtml), knowledge_renderer_sha256: sha256(knowledgeHtml) });
  }
  assert.equal(bodyHashes[0], bodyHashes[1]);
  evidence('review-R16-reading-semantics.json', { grade: 'internal_rule', scope: 'existing WP02 real synthetic fields replayed through domain + both actual feature ports + actual renderer; no external calls, no browser claim', started_at: startedAt, completed_at: new Date().toISOString(), input_refs: [{ path: eventPath, sha256: sha256(eventBytes) }, { path: itemsPath, sha256: sha256(itemsBytes) }], event_id: event.id, snapshots, original_titles_and_urls_preserved: true, same_event_body_explicitly_labeled: true, other_type_label_unchanged: true });
} finally { f.cleanup(); } });
