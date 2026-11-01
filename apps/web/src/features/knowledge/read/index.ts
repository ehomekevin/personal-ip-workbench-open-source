import type { KnowledgeSummary, Page, SourceRecordDetail, DocumentSnapshot, SearchHit } from '@workbench/contracts';
import type { FeatureContext, PageFeaturePort } from '../../../transport/feature-ports.ts';
import type { ViewContext, UiState } from '../../../app/view-model.ts';
import { emptyIngestView, sourceReadingSemantics } from '../../sources/read/index.ts';

export interface KnowledgeReadFeature extends PageFeaturePort<'knowledge'> { loadMore(context: FeatureContext): Promise<ViewContext> }
export function createKnowledgeReadFeature(): KnowledgeReadFeature {
  let rows: KnowledgeSummary[] = [], next: string | null = null, loadGeneration = 0, localUi: Partial<UiState> = {}; const documents = new Map<string, DocumentSnapshot>(), details = new Map<string, SourceRecordDetail>();
  async function view(context: FeatureContext, generation = loadGeneration): Promise<ViewContext> {
    context.signal.throwIfAborted();
    const ui = { ...context.ui, ...localUi }, result = emptyIngestView(context, ui); if (!rows.some(row => row.id === ui.knowledge)) ui.knowledge = rows[0]?.id ?? '';
    const selected = rows.find(row => row.id === ui.knowledge);
    if (selected?.source_record_id && !details.has(selected.id)) { const detail = await context.client.request<SourceRecordDetail>('GET', '/api/v1/source-records/' + encodeURIComponent(selected.source_record_id), undefined, { signal: context.signal }); context.signal.throwIfAborted(); if (generation !== loadGeneration) return view(context); details.set(selected.id, detail); }
    if (selected?.document_id && documents.get(selected.id)?.head_revision_id !== selected.head_revision_id) { const snapshot = await context.client.getDocument(selected.document_id, context.signal); context.signal.throwIfAborted(); if (generation !== loadGeneration) return view(context); documents.set(selected.id, snapshot); }
    result.KNOWLEDGE = rows.map(row => ({ id: row.id, title: row.title, type: row.kind === 'source' ? '原始资料' : row.kind === 'wiki' ? 'Wiki' : '个人笔记', status: row.content_status === 'available' ? '可读取' : row.content_status === 'summary_only' ? '摘要可用' : row.content_status,
      text: row.source_record_id ? details.get(row.id)?.body ?? details.get(row.id)?.summary ?? '' : documents.get(row.id)?.text ?? '', refs: row.source_record_id ? details.get(row.id)?.source_locations.map(location => location.relative_path ?? location.source_url ?? location.kind) ?? [] : [], ...sourceReadingSemantics(row.source_record_id ? details.get(row.id) : undefined) }));
    for (const row of rows) if (row.kind === 'source') result.files.set('knowledge-readonly:' + row.id, 'true');
    context.surface.updateUi({ knowledge: ui.knowledge }); return result;
  }
  async function load(context: FeatureContext): Promise<ViewContext> {
    const generation = ++loadGeneration; const query = localUi.knowledgeQuery ?? context.ui.knowledgeQuery;
    if (query) { const page = await context.client.request<Page<SearchHit>>('GET', '/api/v1/search?' + new URLSearchParams({ query, types: 'source,note,wiki' }).toString(), undefined, { signal: context.signal }); if (context.signal.aborted || generation !== loadGeneration) return view(context); rows = page.items.map(hit => ({ id: hit.id, kind: hit.type as KnowledgeSummary['kind'], title: hit.title, document_id: hit.type === 'source' ? null : hit.id, source_record_id: hit.type === 'source' ? hit.id : null, head_revision_id: typeof hit.locator.revision_id === 'string' ? hit.locator.revision_id : null, content_status: 'available' })); next = null; }
    else { const page = await context.client.request<Page<KnowledgeSummary>>('GET', '/api/v1/knowledge', undefined, { signal: context.signal }); if (context.signal.aborted || generation !== loadGeneration) return view(context); rows = page.items; next = page.next_cursor; }
    return view(context);
  }
  return { page: 'knowledge', load, async loadMore(context) { if ((localUi.knowledgeQuery ?? context.ui.knowledgeQuery)) return view(context); const generation = loadGeneration; if (next) { const page = await context.client.request<Page<KnowledgeSummary>>('GET', '/api/v1/knowledge?' + new URLSearchParams({ cursor: next }).toString(), undefined, { signal: context.signal }); if (context.signal.aborted || generation !== loadGeneration) return view(context); const ids = new Set(rows.map(row => row.id)); rows.push(...page.items.filter(row => !ids.has(row.id))); next = page.next_cursor; } return view(context); }, async dispatch(action, context) {
    if (action.action === 'knowledge-query') { localUi.knowledgeQuery = String(action.fields['knowledge-query'] ?? ''); return load(context); }
    if (action.action === 'knowledge-select' || action.action === 'search-knowledge') { localUi.knowledge = action.dataset.id ?? ''; if (action.action === 'search-knowledge') { if (localUi.knowledge && !rows.some(row => row.id === localUi.knowledge)) { const snapshot = await context.client.getDocument(localUi.knowledge, context.signal); documents.set(localUi.knowledge, snapshot); rows.unshift({ id: localUi.knowledge, kind: action.dataset.kind === 'wiki' ? 'wiki' : 'note', title: /^#\s+(.+)$/m.exec(snapshot.text)?.[1] ?? '个人笔记', document_id: localUi.knowledge, source_record_id: null, head_revision_id: snapshot.head_revision_id, content_status: snapshot.save_state === 'empty' ? 'empty' : 'available' }); } context.surface.closeDialog('completed'); context.surface.navigate('knowledge'); } return view(context); }
    if (action.action === 'save-knowledge') { const id = localUi.knowledge ?? context.ui.knowledge, row = rows.find(item => item.id === id); if (!row?.document_id) { context.surface.toast('原始资料保持只读'); return; } const snapshot = documents.get(id) ?? await context.client.getDocument(row.document_id, context.signal); await context.client.saveDocument(row.document_id, { expected_revision_id: snapshot.head_revision_id, text: String(action.fields['knowledge-text'] ?? ''), origin: 'human' }, { signal: context.signal, idempotencyKey: crypto.randomUUID() }); documents.set(id, await context.client.getDocument(row.document_id, context.signal)); context.surface.toast('笔记已保存'); return view(context); }
    return view(context);
  } };
}
