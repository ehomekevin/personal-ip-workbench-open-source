import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../../apps/web/src/transport/workbench-client.ts';
import { DraftRegistry } from '../../apps/web/src/transport/drafts.ts';
import { initialUi } from '../../apps/web/src/app/view-model.ts';
import type { FeatureContext } from '../../apps/web/src/transport/feature-ports.ts';
import { createSourcesReadFeature, showIngestSearch } from '../../apps/web/src/features/sources/read/index.ts';
import { createKnowledgeReadFeature } from '../../apps/web/src/features/knowledge/read/index.ts';
import { fixture, evidence } from './harness.ts';

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const row = (id: string) => ({ id, title: id, category: '热点资讯', summary: id, body: id + ' 正文', published_at: null, updated_at: '2026-10-10T00:00:00Z', content_status: 'available', source_name: 'fixture', source_locations: [], external_links: [], media: [], parser_warnings: [], favorite: false });
const page = (items: unknown[]) => ({ items, next_cursor: null, has_more: false, last_success_at: null });

test('既有资料/知识/全局搜索并发：晚到的列表或正文不会倒回最新查询与选中项', async () => { const f = fixture(); try {
  const oldBody = gate<Response>(), bodyStarted = gate<void>(), oldKnowledge = gate<Response>(), knowledgeStarted = gate<void>(), oldGlobal = gate<Response>(), globalStarted = gate<void>(); const dialogs: string[] = [], selected: string[] = [];
  const client = createHttpClient('http://fixture.invalid', f.identity, async input => { const url = new URL(String(input));
    if (url.pathname === '/api/v1/identity') return json(f.identity);
    if (url.pathname === '/api/v1/accounts') return json(page([]));
    if (url.pathname === '/api/v1/source-records') return json(page([row(url.searchParams.get('query') === 'old' ? 'old-source' : 'new-source')]));
    if (url.pathname === '/api/v1/source-records/old-source') { bodyStarted.resolve(); return oldBody.promise; }
    if (url.pathname.startsWith('/api/v1/source-records/')) return json(row(url.pathname.split('/').at(-1)!));
    if (url.pathname === '/api/v1/search') { const query = url.searchParams.get('query'); if (query === 'old-knowledge') { knowledgeStarted.resolve(); return oldKnowledge.promise; } if (query === 'old-global') { globalStarted.resolve(); return oldGlobal.promise; } return json(page([{ id: query, type: 'source', title: query, score: 100, snippet: query, locator: {} }])); }
    throw new Error('unexpected fixture path ' + url.pathname);
  });
  let ui = initialUi('sources'); const context: FeatureContext = { client, identity: f.identity, ui, signal: new AbortController().signal, drafts: new DraftRegistry(client, f.identity, { getItem: () => null, setItem() {}, removeItem() {} }), surface: { updateUi(patch) { ui = { ...ui, ...patch }; context.ui = ui; if (patch.news) selected.push(patch.news); if (patch.knowledge) selected.push(patch.knowledge); }, editorFeedback() {}, presentDialog(dialog) { dialogs.push(dialog.body); }, closeDialog() {}, toast() {}, navigate() {} } };
  const sources = createSourcesReadFeature(), old = sources.dispatch({ action: 'source-query', dataset: {}, fields: { 'source-query': 'old' } }, context); await bodyStarted.promise; const newest = await sources.dispatch({ action: 'source-query', dataset: {}, fields: { 'source-query': 'new' } }, context); oldBody.resolve(json(row('old-source'))); const late = await old; assert.equal(newest?.NEWS[0]!.id, 'new-source'); assert.equal(late?.NEWS[0]!.id, 'new-source'); assert.equal(late?.ui.sourceQuery, 'new'); assert.ok(selected.every(value => value === 'new-source'));
  ui = { ...ui, page: 'knowledge' }; context.ui = ui; const knowledge = createKnowledgeReadFeature(), oldK = knowledge.dispatch({ action: 'knowledge-query', dataset: {}, fields: { 'knowledge-query': 'old-knowledge' } }, context); await knowledgeStarted.promise; const newK = await knowledge.dispatch({ action: 'knowledge-query', dataset: {}, fields: { 'knowledge-query': 'new-knowledge' } }, context); oldKnowledge.resolve(json(page([{ id: 'old-knowledge', type: 'source', title: 'old-knowledge', score: 100, snippet: '', locator: {} }]))); const lateK = await oldK; assert.equal(newK?.KNOWLEDGE[0]!.id, 'new-knowledge'); assert.equal(lateK?.KNOWLEDGE[0]!.id, 'new-knowledge'); assert.equal(lateK?.ui.knowledgeQuery, 'new-knowledge');
  const first = showIngestSearch(context, 'old-global'); await globalStarted.promise; await showIngestSearch(context, 'new-global'); oldGlobal.resolve(json(page([{ id: 'old-global', type: 'source', title: 'old-global', score: 100, snippet: '', locator: {} }]))); await first; assert.equal(dialogs.length, 1); assert.match(dialogs[0]!, /new-global/); assert.doesNotMatch(dialogs[0]!, /old-global/);
  evidence('feature-races.json', { grade: 'internal_rule', deferred_fixture_requests: true, late_source_body_rejected: true, late_knowledge_rows_rejected: true, late_global_dialog_rejected: true, selected });
} finally { f.cleanup(); } });
