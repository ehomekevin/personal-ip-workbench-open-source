import type { ConfigurationSnapshot, JsonObject, Platform,BenchmarkStatisticsRefreshStatus } from '@workbench/contracts';
import { P } from '../../components/metadata.ts';
import { createTemplateHelpers } from '../../components/templateHelpers.ts';
const { esc } = createTemplateHelpers([]);
export function renderBenchmarkSettings(configuration?: ConfigurationSnapshot, busy?: string, open = false, statistics?:BenchmarkStatisticsRefreshStatus|null) {
  const accounts = configuration?.benchmarks ?? [];
  const button = (label: string, action: string, id?: unknown, disabled = false) => `<button class="button small" data-action="cfg-benchmark-${action}"${id ? ` data-id="${esc(id)}"` : ''}${busy || disabled ? ' disabled' : ''}>${label}</button>`;
  const eligible=accounts.filter(a=>a.platform==='douyin'&&a.identity_status==='confirmed'&&Number(a.work_count)>0),locked=statistics&&['queued','running','unknown'].includes(statistics.state);
  const stats=statistics?`<p class="configuration-result" role="status">${esc(statistics.state==='queued'?'播放数刷新已排队':statistics.state==='running'?'正在读取播放数':statistics.state==='succeeded'?'播放数已刷新':statistics.state==='partial'?'部分播放数已刷新':statistics.state==='unknown'?'本轮请求结果待核对，已暂停重复请求':'本轮未完成，已有播放数保留')} · 更新 ${statistics.updated_count} / ${statistics.matched_count} 篇${statistics.retained_count?` · ${statistics.retained_count} 篇保留此前状态`:''}<small>${esc(new Date(statistics.finished_at??statistics.started_at).toLocaleString('zh-CN'))} · 数据读取时间，指标观察时点未知</small></p>`:'';
  return `<p>对标账号由工作台直接采集，素材和指标留在本机。</p>
    <p class="fine">手动刷新 X / 抖音最新作品页。旧作品去重并保存新的指标快照；历史素材保留在 Obsidian，可通过只读索引接入。</p>
    <div class="button-row">${button('添加对标账号', 'add')}${button(locked?'播放数刷新处理中':'刷新已存抖音播放数','statistics',undefined,!eligible.length||Boolean(locked))}${button('查看播放数刷新状态','statistics-status')}</div>${stats}<p class="fine">播放数刷新覆盖本工作区已核对的抖音对标账号和已存作品；单次最多 4 批，不采集新作品。缺项保留此前数值。</p>
    ${accounts.length ? `<details class="configuration-benchmarks"${open ? ' open' : ''}><summary>已登记 ${accounts.length} 个账号 · 展开管理</summary>${accounts.map(a => {
      const sync = (a.sync ?? {}) as JsonObject, job = (sync.latest_job ?? {}) as JsonObject;
      const active = ['queued', 'running', 'reconciling'].includes(String(job.state));
      const supported = ['x', 'douyin'].includes(String(a.platform));
      const status = active ? '正在采集…' : job.state === 'waiting_quota' ? '额度受限' : job.state === 'failed' ? '上轮未完成 · 可重试' : a.identity_status === 'confirmed' ? '身份已核对' : '先核对身份';
      return `<div class="configuration-benchmark"><div><strong>${esc(a.name)}</strong><p>${esc(P[a.platform as Platform]?.name ?? a.platform)} · ${esc(status)}</p>
        <small>${sync.last_success_at ? `${esc(new Date(String(sync.last_success_at)).toLocaleString('zh-CN'))} · 上轮新增 ${esc(sync.inserted)} / 刷新 ${esc(sync.updated)}` : '尚未采集'} · 已收录 ${esc(a.work_count ?? 0)} 篇</small></div>
        <div class="button-row">${button('核对身份', 'identity', a.id, active)}${button(active ? '采集中…' : '采集最新作品', 'sync', a.id, active || !supported || a.identity_status !== 'confirmed')}${button('查看素材', 'materials', a.id, !sync.source_id || !a.work_count)}
          <a class="button small" href="${esc(a.canonical_url)}" target="_blank" rel="noopener noreferrer">账号主页 ↗</a></div>
        ${!supported ? '<p class="fine">已保存登记；该平台的最新作品采集尚未接入。</p>' : ''}</div>`;
    }).join('')}</details>` : '<p class="configuration-result">尚未登记对标账号，先添加主页并核对身份。</p>'}
    <p class="fine">每轮只读取最新页，不代表历史完整。平台没有给出指标观察时点时，快照保留未知，不用于固定时龄环比。</p>`;
}
