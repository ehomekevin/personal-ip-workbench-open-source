import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApplication, type RunningApplication } from '../../apps/service/src/bootstrap/application.ts';
import { createSourcesModule } from '../../apps/service/src/routes/sources.ts';
import { createBenchmarkAccountsModule } from '../../apps/service/src/routes/benchmark-accounts.ts';
import { createKnowledgeModule } from '../../apps/service/src/routes/knowledge.ts';
import { createDocumentsModule } from '../../apps/service/src/routes/documents.ts';
import { createTopicsModule } from '../../apps/service/src/routes/topics.ts';
import { createJobsModule } from '../../apps/service/src/routes/jobs.ts';
import { createHttpClient } from '../../apps/web/src/transport/workbench-client.ts';
import { createSourcesReadFeature, showIngestSearch } from '../../apps/web/src/features/sources/read/index.ts';
import { createKnowledgeReadFeature } from '../../apps/web/src/features/knowledge/read/index.ts';
import { initialUi } from '../../apps/web/src/app/view-model.ts';
import type { FeatureContext } from '../../apps/web/src/transport/feature-ports.ts';
import { DraftRegistry } from '../../apps/web/src/transport/drafts.ts';
import { fixture, evidence } from './harness.ts';
import type { Page, SourceRecordSummary, SourceRecordDetail, DocumentSnapshot, KnowledgeSummary, JobDetailResponse } from '../../packages/contracts/src/index.ts';

test('随机端口真实HTTP与既有feature ports：分页、pending账号、收藏/关联、readonly资料和人工修订冲突', async () => { const f = fixture(); let app: RunningApplication | undefined;
  try {
    app = await startApplication(f.config, { port: 0, moduleFactories: [createDocumentsModule, createTopicsModule, createJobsModule, createSourcesModule, createBenchmarkAccountsModule, createKnowledgeModule] });
    const base = `http://127.0.0.1:${app.address.port}`, client = createHttpClient(base, app.identity); await client.identity();
    const created: string[] = []; for (let i = 0; i < 53; i++) { const row = await client.request<{ record_id: string }>('POST', '/api/v1/source-records', { title: `中文资料 ${i}`, text: `# 中文资料 ${i}\n\n搜索正文 ${i}`, category: '个人思考' }, { idempotencyKey: 'manual-' + i }); created.push(row.record_id); }
    const first = await client.request<Page<SourceRecordSummary>>('GET', '/api/v1/source-records'); assert.equal(first.items.length, 50); assert.equal(first.has_more, true); assert.equal('body' in first.items[0]!, false); assert.equal(first.items[0]!.id, created.at(-1));
    const second = await client.request<Page<SourceRecordSummary>>('GET', '/api/v1/source-records?' + new URLSearchParams({ cursor: first.next_cursor! }).toString()); assert.equal(second.items.length, 3); assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 53);
    await assert.rejects(client.request('GET', '/api/v1/source-records?' + new URLSearchParams({ category: '热点资讯', cursor: first.next_cursor! }).toString()));
    let ui = initialUi('sources'); let dialogTitle = '', dialogBody = '', toasted = ''; const context: FeatureContext = { client, identity: app.identity, ui, signal: new AbortController().signal, drafts: new DraftRegistry(client, app.identity, { getItem: () => null, setItem() {}, removeItem() {} }), surface: { updateUi(patch) { ui = { ...ui, ...patch }; context.ui = ui; }, editorFeedback() {}, presentDialog(dialog) { dialogTitle = dialog.title; dialogBody = dialog.body; }, closeDialog() {}, toast(value) { toasted = value; }, navigate(page) { ui = { ...ui, page }; context.ui = ui; } } };
    const sources = createSourcesReadFeature(), loaded = await sources.load(context); assert.equal(loaded.NEWS.length, 50); assert.ok(loaded.NEWS.find(row => row.id === ui.news)?.body.includes('搜索正文')); const more = await sources.loadMore(context); assert.equal(more.NEWS.length, 53);
    await sources.dispatch({ action: 'favorite', dataset: { id: ui.news }, fields: {} }, context); assert.equal((await client.request<SourceRecordDetail>('GET', '/api/v1/source-records/' + ui.news)).favorite, true);
    await sources.dispatch({ action: 'save-account', dataset: {}, fields: { 'account-name': '中文账号', 'account-platform': 'x', 'account-url': 'https://x.com/manual' } }, context); assert.match(toasted, /账号已保存.*平台资料读取未完成/); const accounts = await sources.load(context); assert.equal(accounts.state.accounts[0]?.focus, '身份待核对'); assert.equal(accounts.state.accounts[0]?.count, null);
    await sources.dispatch({ action: 'news-topic', dataset: { id: created.at(-1)! }, fields: {} }, context); assert.equal(dialogTitle, '建立一个新主题'); assert.match(dialogBody, /关联资料/);
    await sources.dispatch({ action: 'create-topic', dataset: { source: created.at(-1)! }, fields: { 'new-title': '真实HTTP主题', 'new-category': '个人思考', 'new-angle': '读者' } }, context); assert.equal(ui.page, 'create'); assert.equal(app.context.db.prepare('SELECT COUNT(*) AS n FROM topic_sources WHERE source_record_id=?').get(created.at(-1)!)!.n, 1);
    const note = await client.request<DocumentSnapshot>('POST', '/api/v1/documents', { kind: 'user_note', initial_text: '# 人工笔记\n初始正文' }, { idempotencyKey: 'note-create' });
    ui = { ...ui, page: 'knowledge', knowledge: note.document_id }; context.ui = ui; const knowledge = createKnowledgeReadFeature(); await knowledge.load(context);
    await knowledge.dispatch({ action: 'knowledge-query', dataset: {}, fields: { 'knowledge-query': '人工笔记' } }, context); await knowledge.dispatch({ action: 'knowledge-select', dataset: { id: note.document_id }, fields: {} }, context);
    await client.saveDocument(note.document_id, { expected_revision_id: note.head_revision_id, text: '# 人工笔记\n别处人工更新', origin: 'human' }, { idempotencyKey: 'other-human' }); await assert.rejects(knowledge.dispatch({ action: 'save-knowledge', dataset: {}, fields: { 'knowledge-text': '旧输入不能覆盖' } }, context)); assert.equal((await client.getDocument(note.document_id)).text, '# 人工笔记\n别处人工更新');
    const refreshed = await knowledge.load(context); assert.equal(refreshed.KNOWLEDGE.find(row => row.id === note.document_id)!.text, '# 人工笔记\n别处人工更新'); await knowledge.dispatch({ action: 'save-knowledge', dataset: {}, fields: { 'knowledge-text': '# 人工笔记\n刷新后的人工保存' } }, context); assert.equal((await client.getDocument(note.document_id)).text, '# 人工笔记\n刷新后的人工保存');
    await knowledge.dispatch({ action: 'knowledge-query', dataset: {}, fields: { 'knowledge-query': '中文资料 52' } }, context); await knowledge.dispatch({ action: 'knowledge-select', dataset: { id: created.at(-1)! }, fields: {} }, context); const readOnly = await knowledge.load(context); assert.equal(readOnly.files.get('knowledge-readonly:' + created.at(-1)), 'true'); await knowledge.dispatch({ action: 'save-knowledge', dataset: {}, fields: { 'knowledge-text': '不应写原资料' } }, context); assert.equal(toasted, '原始资料保持只读');
    writeFileSync(join(f.paths.source_vault_root, 'worker-http.md'), '# HTTP索引\n\n真实HTTP工作器'); const run = await client.request<{ job_id: string }>('POST', '/api/v1/index-runs', { roots: [f.paths.source_vault_root], mode: 'initial' }, { idempotencyKey: 'index-http' });
    let done: JobDetailResponse | undefined; for (let attempt = 0; attempt < 30; attempt++) { done = await client.request<JobDetailResponse>('GET', '/api/v1/jobs/' + run.job_id); if (done.job.state === 'succeeded') break; await new Promise<void>(resolve => setTimeout(resolve, 100)); } assert.equal(done?.job.state, 'succeeded');
    await showIngestSearch(context, 'HTTP索引'); assert.match(dialogBody, /HTTP索引/); const summaries = await client.request<Page<KnowledgeSummary>>('GET', '/api/v1/knowledge'); assert.equal(summaries.items.length, 50);
    evidence('http-features.json', { grade: 'internal_rule', random_port: app.address.port, source_pages: [first.items.length, second.items.length], persisted_favorite: true, pending_account: accounts.state.accounts[0], topic_id: ui.topic, note_conflict_rejected: true, review_R12_head_refresh_and_save: true, source_readonly: true, index_job: done });
  } finally { await app?.close(); f.cleanup(); }
});
