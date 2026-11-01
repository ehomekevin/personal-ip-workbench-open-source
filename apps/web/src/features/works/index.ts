import type { Page, Platform } from '@workbench/contracts';
import type { WorkView } from './types.ts';
import type { PageFeaturePort, FeatureContext, FeatureAction } from '../../transport/feature-ports.ts';
import type { WorkbenchClient } from '../../transport/workbench-client.ts';
import { loadWorkSnapshots } from '../retro/snapshots/index.ts';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export async function loadWorks(client: WorkbenchClient, platform?: Platform, signal?: AbortSignal): Promise<WorkView[]> {
  const rows: WorkView[] = []; let cursor: string | null = null; const seen = new Set<string>();
  do { const page: Page<WorkView> = await client.request('GET', `/api/v1/works?limit=200${platform ? '&platform=' + platform : ''}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, undefined, { signal }); rows.push(...page.items); cursor = page.next_cursor;
    if (cursor && seen.has(cursor)) throw new Error('作品游标重复'); if (cursor) seen.add(cursor);
  } while (cursor); return rows;
}
export async function dispatchWorks(action: FeatureAction, context: FeatureContext): Promise<boolean> {
  if (action.action === 'work-detail') {
    const id = action.dataset.id; if (!id) throw new Error('作品 ID 未提供');
    const [work, snapshots] = await Promise.all([context.client.request<WorkView>('GET', '/api/v1/works/' + encodeURIComponent(id), undefined, { signal: context.signal }), loadWorkSnapshots(context.client, id, context.signal)]);
    const detail = snapshots.length ? snapshots.map(snapshot => `<div class="reason-row"><strong>${escape(snapshot.observed_at ?? '观察时间未知')}</strong><br>采集：${escape(snapshot.collected_at)}<br>计划窗口：${snapshot.target_window === null ? '手动当下采集' : escape(snapshot.target_window / 3600) + 'h'} · 实际年龄：${snapshot.observed_age_s === null ? '未知' : escape((snapshot.observed_age_s / 3600).toFixed(2)) + 'h'}<br>${snapshot.metrics.map(metric => `${escape(metric.key)}：${metric.value === null ? '— · ' + escape(metric.reason ?? metric.availability) : escape(metric.value)} · ${escape(metric.definition.definition_version)}`).join('<br>')}<br><span class="mono">${escape(snapshot.collection_request_id)}</span></div>`).join('') : '<p class="fine">尚未采集，24h / 72h / 7d 保留缺失。</p>';
    context.surface.presentDialog({ title: '作品与快照依据', body: `<p>${escape(work.platform)} · ${escape(work.format ?? '形式待确认')} · ${escape(work.identity_status)}</p><p class="fine">${escape(work.url)}</p><p class="fine">主题：${escape(work.topic_id ?? '未关联主题')}<br>平台 ID：${escape(work.platform_work_id ?? '待解析')}<br>别名来源：${work.aliases.map(alias => escape(alias.source_url)).join('<br>') || '无'}</p>${detail}`, foot: '每个请求与原始响应独立留存；未知时间不参加同龄比较。' }); return true;
  }
  if (action.action === 'collect-metrics') {
    const works = await loadWorks(context.client, context.ui.retroPlatform as Platform, context.signal), eligible = works.filter(work => work.identity_status === 'confirmed' && work.account_role === 'owner');
    if (!eligible.length) { context.surface.toast('当前平台没有已核对作者身份的本人作品'); return true; }
    const jobs: Array<{ work_id: string; job_id: string; state: string }> = [];
    for (const work of eligible) { const result = await context.client.request<{ job_id: string; state: string }>('POST', `/api/v1/works/${encodeURIComponent(work.id)}/collections`, { connector: 'tikhub' }, { signal: context.signal, idempotencyKey: crypto.randomUUID() }); jobs.push({ work_id: work.id, ...result }); }
    context.surface.presentDialog({ title: '数据回收任务', body: `<p>已建立 ${jobs.length} 项持久采集任务。</p>${jobs.map(job => `<p class="fine">${escape(job.work_id)} · ${escape(job.state)}<br><span class="mono">${escape(job.job_id)}</span></p>`).join('')}`, foot: '采集结果以服务快照为准；缺少配置、权限和限流会保留实际任务状态。' }); return true;
  }
  return false;
}
export function withWorksFeaturePort(base: PageFeaturePort<'retro'>): PageFeaturePort<'retro'> {
  return { page: 'retro', load: context => base.load(context), async dispatch(action, context) { if (await dispatchWorks(action, context)) return; return base.dispatch(action, context); }, ...(base.input ? { input: (action: FeatureAction, context: FeatureContext) => base.input!(action, context) } : {}) };
}
