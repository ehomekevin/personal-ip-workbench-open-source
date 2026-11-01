import type { SourceRecordSummary, SourceRecordDetail, Page, AccountSummary, SearchHit, TopicDetail } from '@workbench/contracts';
import type { FeatureContext, FeatureAction, PageFeaturePort } from '../../../transport/feature-ports.ts';
import type { ViewContext, SourceView, UiState, AccountView } from '../../../app/view-model.ts';
import { createTemplateHelpers } from '../../../components/templateHelpers.ts';
import { listManualAccounts, dispatchManualAccount } from '../accounts-manual/lazy.ts';
import { waitForegroundGeneration } from '../../create/ai-actions/index.ts';
import {xPostPreviewText} from '../../../components/x-post-card.ts';

export function emptyIngestView(context: FeatureContext, ui: UiState = { ...context.ui }): ViewContext { return { provenance: 'service', projections: {}, state: { version: 1, agent: 'codex', api: false, compact: false, favorites: [], adopted: false, topics: [], schedules: [], publications: [], accounts: [], notes: {}, business: { count: 0, source: '待补充' } }, ui, NEWS: [], KNOWLEDGE: [], files: new Map() }; }
export function sourceReadingSemantics(detail?: SourceRecordDetail): Pick<SourceView, 'bodyLabel' | 'notices'> {
  if (!detail) return {};
  const notices = [...new Set(detail.parser_warnings)];
  if(detail.benchmark)return {bodyLabel:detail.record_kind==='douyin_video'?detail.benchmark.transcript_status==='platform_caption'?'平台视频说明与字幕':'平台视频说明':'平台作品正文',notices};
  if(detail.curation?.type)return {bodyLabel:detail.curation.type==='practice'?'AI 整理的玩法':'个人站事件解读',notices};
  return { ...(notices.some(notice => notice.includes('站点解读不代表每篇外站全文')) ? { bodyLabel: detail.record_kind === 'site_daily' ? '个人站日报' : '个人站事件解读' } : {}), ...(notices.length ? { notices } : {}) };
}
export function sourceView(row: SourceRecordSummary, detail?: SourceRecordDetail): SourceView {
  const xPost=detail?.benchmark?.x_post,links=xPost&&typeof xPost==='object'&&!Array.isArray(xPost)?xPost.links:[];
  return { id: row.id, title: row.record_kind==='x_post'?xPostPreviewText(row.title,links):row.title, category: row.category, time: row.record_kind === 'site_daily' && row.external_id ? row.external_id : row.published_at ?? '发布时间未提供', source: row.source_name, summary: row.record_kind==='x_post'?xPostPreviewText(row.summary,links):row.summary,
    curation:row.curation??undefined, body: detail?.body ?? (row.content_status === 'summary_only' ? '此资料目前提供摘要；原文可从来源打开。' : '正文尚未读取。'), sources: row.source_locations.map(location => location.relative_path ?? location.source_url ?? location.kind),media:detail?.media,benchmark:detail?.benchmark,canonical_url:detail?.canonical_url??row.canonical_url, ...sourceReadingSemantics(detail) };
}
export function accountView(row: AccountSummary): AccountView { return { id: row.id, name: row.profile?.display_name??row.name, platform: row.platform, focus: row.identity_status === 'pending' ? '身份待核对' : row.profile?.display_id?(row.platform==='x'?'@':'平台号 · ')+row.profile.display_id:'平台身份已核对', count: null, previous: null, reason: row.profile?.bio??(row.collection_status === 'not_collected' ? '尚未采集平台作品。' : '平台未提供账号简介。'), url: row.canonical_url,workCount:row.work_count,profile:row.profile }; }
export interface SourcesReadFeature extends PageFeaturePort<'sources'> { loadMore(context: FeatureContext): Promise<ViewContext> }
export function createSourcesReadFeature(): SourcesReadFeature {
  let rows: SourceRecordSummary[] = [], next: string | null = null, scope = '', loadGeneration = 0, syncing = false, localUi: Partial<UiState> = {}; const details = new Map<string, SourceRecordDetail>();
  function query(context: FeatureContext): URLSearchParams { const ui = { ...context.ui, ...localUi }, params = new URLSearchParams({ order: 'published_desc' }); if (ui.sourceFilter==='全部'||ui.sourceFilter==='热点资讯'||ui.sourceFilter==='AI 实测')params.set('curated','true');if (ui.sourceQuery) params.set('query', ui.sourceQuery); if (ui.sourceFilter === '已收藏') params.set('favorite', 'true'); else if (ui.sourceFilter !== '全部') params.set('category', ui.sourceFilter); return params; }
  async function view(context: FeatureContext, generation = loadGeneration): Promise<ViewContext> {
    context.signal.throwIfAborted();
    const ui = { ...context.ui, ...localUi }, result = emptyIngestView(context, ui);
    if (!rows.some(row => row.id === ui.news)) ui.news = rows[0]?.id ?? '';
    if (ui.news && ui.sourceTab === 'news' && !details.has(ui.news)) { const detail = await context.client.request<SourceRecordDetail>('GET', '/api/v1/source-records/' + encodeURIComponent(ui.news), undefined, { signal: context.signal }); context.signal.throwIfAborted(); if (generation !== loadGeneration) return view(context); details.set(ui.news, detail); }
    result.NEWS = rows.map(row => sourceView(row, details.get(row.id))); result.state.favorites = rows.filter(row => row.favorite).map(row => row.id);
    for (const row of rows) { const detail = details.get(row.id); const original = detail?.external_links[0] ?? row.canonical_url ?? row.source_locations.find(location => location.source_url)?.source_url; if (original) result.files.set('source-original:' + row.id, original); }
    const accounts = await listManualAccounts(context); context.signal.throwIfAborted(); if (generation !== loadGeneration) return view(context); result.state.accounts = accounts.map(accountView); context.surface.updateUi({ news: ui.news }); return result;
  }
  async function load(context: FeatureContext): Promise<ViewContext> { const generation = ++loadGeneration, params = query(context), requestedScope = params.toString(); const page = await context.client.request<Page<SourceRecordSummary>>('GET', '/api/v1/source-records?' + requestedScope, undefined, { signal: context.signal }); if (context.signal.aborted || generation !== loadGeneration) return view(context); scope = requestedScope; rows = page.items;for(const row of rows){if(details.get(row.id)?.updated_at!==row.updated_at)details.delete(row.id);}next = page.next_cursor; return view(context); }
  const port: SourcesReadFeature = { page: 'sources', load, async loadMore(context) { if (!next || query(context).toString() !== scope) return view(context); const generation = loadGeneration, params = query(context); params.set('cursor', next); const page = await context.client.request<Page<SourceRecordSummary>>('GET', '/api/v1/source-records?' + params.toString(), undefined, { signal: context.signal }); if (context.signal.aborted || generation !== loadGeneration) return view(context); const ids = new Set(rows.map(row => row.id)); rows.push(...page.items.filter(row => !ids.has(row.id))); next = page.next_cursor; return view(context); }, async dispatch(action, context) {
    if (action.action === 'source-sync') {
      if (syncing) return;
      syncing = true;
      try {
        const sources = await context.client.request<{ items: { id: string; kind: string; external_id: string }[] }>('GET', '/api/v1/sources', undefined, { signal: context.signal });
        const selected = sources.items.filter(source => source.kind === 'personal_site'&&source.external_id==='creator-feed');
        if (!selected.length) throw new Error('尚未登记可采集的资讯源');
        for (const [index, source] of selected.entries()) {
          if (context.signal.aborted || context.ui.page !== 'sources') return;
          const accepted = await context.client.request<{ job_id: string }>('POST', '/api/v1/sources/' + encodeURIComponent(source.id) + '/sync', {}, { signal: context.signal, idempotencyKey: crypto.randomUUID() });
          const result = await waitForegroundGeneration(context, accepted, '更新资讯 · ' + (index + 1) + ' / ' + selected.length, () => context.ui.page === 'sources', false,
            { queued: '等待采集任务开始…', running: '正在从个人站采集资讯…', note: '只更新最多 30 条创作候选：热点、实用事件和玩法。保留入选依据、收藏和已有主题。' });
          if (!result) return load(context);
        }
        details.clear(); context.surface.toast('资讯已更新，收藏和关联主题已保留。'); return load(context);
      } finally { syncing = false; }
    }
    if (await dispatchManualAccount(action, context)) return load(context);
    if (action.action === 'source-tab') localUi.sourceTab = action.dataset.value ?? 'news';
    else if (action.action === 'source-filter') { localUi.sourceFilter = action.dataset.value ?? '全部'; return load(context); }
    else if (action.action === 'source-query') { localUi.sourceQuery = String(action.fields['source-query'] ?? ''); return load(context); }
    else if (['select-news', 'read-news'].includes(action.action)) { localUi.news = action.dataset.id ?? ''; localUi.sourceTab = 'news'; if (action.action === 'read-news') { context.surface.closeDialog('completed'); if(context.ui.page!=='sources')context.surface.navigate('sources'); }
      const id = localUi.news; if (id) { const detail = await context.client.request<SourceRecordDetail>('GET', '/api/v1/source-records/' + encodeURIComponent(id), undefined, { signal: context.signal }); details.set(id, detail); if (!rows.some(row => row.id === id)) rows.unshift(detail); await context.client.request('PUT', '/api/v1/source-records/' + encodeURIComponent(id) + '/marks', { read: true }, { signal: context.signal }); } }
    else if (action.action === 'favorite') { const id = action.dataset.id ?? '', current = rows.find(row => row.id === id); if (current) { const marked = await context.client.request<SourceRecordDetail>('PUT', '/api/v1/source-records/' + encodeURIComponent(id) + '/marks', { favorite: !current.favorite }, { signal: context.signal }); details.set(id, marked); rows = rows.map(row => row.id === id ? marked : row); } }
    else if (action.action === 'news-topic') { const row = rows.find(item => item.id === action.dataset.id), { btn, esc } = createTemplateHelpers([]); if (row) context.surface.presentDialog({ title: '建立一个新主题', body: '<label class="field-label" for="new-title">你想讲什么？</label><input class="field" id="new-title" placeholder="一个具体问题、一条实测或一个判断" value="' + esc(row.title) + '"><label class="field-label" for="new-category">内容方向</label><select class="field" id="new-category" style="width:100%">' + ['AI 实测', '热点资讯', '个人思考'].map(category => '<option ' + (row.category === category ? 'selected' : '') + '>' + category + '</option>').join('') + '</select><label class="field-label" for="new-angle">你的角度 / 目标读者</label><textarea class="field" id="new-angle" rows="3" placeholder="谁遇到了什么问题？你已有的依据是什么？">' + esc(row.summary) + '</textarea><p class="fine" style="margin-top:15px">关联资料：' + esc(row.title) + '</p>', foot: btn('取消', 'close-dialog') + btn('进入核心稿', 'create-topic', true, 'data-source="' + esc(row.id) + '"') }); }
    else if (action.action === 'create-topic') { const title = String(action.fields['new-title'] ?? '').trim(); if (!title) { context.surface.toast('写一个主题，再进入核心稿'); return; } const record = action.dataset.source ?? ''; const topic = await context.client.request<TopicDetail>('POST', '/api/v1/topics', { title, category: String(action.fields['new-category'] ?? '个人思考'), audience: String(action.fields['new-angle'] ?? ''), angle: String(action.fields['new-angle'] ?? ''), source_ids: record ? [record] : [] }, { signal: context.signal, idempotencyKey: crypto.randomUUID() }); context.surface.updateUi({ topic: topic.id, editTab: 'core' }); context.surface.closeDialog('completed'); context.surface.navigate('create'); return; }
    else if (action.action === 'global-search') { await showIngestSearch(context, String(action.fields['global-search'] ?? '')); return; }
    return view(context);
  } };
  return port;
}
const searchSequences = new WeakMap<object, number>();
export async function showIngestSearch(context: FeatureContext, query: string): Promise<void> {
  const generation = (searchSequences.get(context.client) ?? 0) + 1; searchSequences.set(context.client, generation);
  const { esc, btn } = createTemplateHelpers([]), params = new URLSearchParams({ query }), page = await context.client.request<Page<SearchHit>>('GET', '/api/v1/search?' + params.toString(), undefined, { signal: context.signal });
  if (context.signal.aborted || searchSequences.get(context.client) !== generation) return;
  const body = page.items.filter(hit => ['source','note','wiki','topic'].includes(hit.type)).slice(0, 10).map(hit => '<button class="search-result" data-action="' + (hit.type === 'source' ? 'read-news' : hit.type === 'topic' ? 'select-topic' : 'search-knowledge') + '" data-id="' + esc(hit.id) + '" data-kind="' + esc(hit.type) + '"><span>' + esc(hit.title) + '</span><span class="tag">' + esc(hit.type) + '</span></button>').join('') || '<div class="empty">没有匹配结果</div>';
  context.surface.presentDialog({ title: '搜索', body: '<input class="field" id="global-search" aria-label="全局搜索" placeholder="搜索主题、资料与笔记" value="' + esc(query) + '"><div id="global-results">' + body + '</div>', foot: btn('关闭', 'close-dialog') });
}
