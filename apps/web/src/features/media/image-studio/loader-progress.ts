import type { LoaderOptions } from '../../../components/image-generation-loader-core.ts';
import type { StudioVersion } from './model.ts';
// 配图版本 → 生图加载器的进度输入：阶段、中间图与耗时都来自服务端快照（任务记录现算），这里只换成加载器的字段。
// 等待执行器 / 等待额度沿用宿主文案；结果待核对（reconciling）不再估算；没有进度信息（旧快照）时不编造。
// 修改 / 调整画幅 / 参考修改：底图用原图（父版本或参考图对应的已保存版本，同源 URL），文案写「正在基于第 N 版修改」。
export function studioLoaderProgress(version: StudioVersion | undefined, versions: readonly StudioVersion[] = [], imageUrl: (v: StudioVersion) => string | undefined = () => undefined): Pick<LoaderOptions, 'progress' | 'seed' | 'parentImage' | 'parentLabel' | 'runKey'> {
  if (!version) return {};
  const out: Pick<LoaderOptions, 'progress' | 'seed' | 'parentImage' | 'parentLabel' | 'runKey'> = { runKey: version.id, ...(version.description.trim() ? { seed: version.description } : {}) };
  const refs = new Set(version.reference_assets.map(r => r.asset_id));
  const parent = (version.parent_version_id ? versions.find(v => v.id === version.parent_version_id) : undefined) ?? versions.find(v => v.id !== version.id && !!v.asset_id && refs.has(v.asset_id));
  const url = parent ? imageUrl(parent) : undefined;
  if (parent && url) { out.parentImage = url; out.parentLabel = '正在基于第 ' + (versions.indexOf(parent) + 1) + ' 版修改'; }
  const p = version.progress;
  if (!p) { if (version.state === 'reconciling') out.progress = { stage: 'checking', previews: [], totalMs: 0, runningMs: null, typicalMs: 0, at: 0 }; return out; }
  const stage = version.state === 'reconciling' ? 'checking' as const : version.state === 'waiting_input' || version.state === 'waiting_quota' ? 'waiting' as const : p.stage;
  out.progress = { stage, previews: [...p.previews], totalMs: p.total_ms, runningMs: p.running_ms, typicalMs: p.typical_ms, at: p.received_at };
  return out;
}
/** 生成失败 / 取消 / 结果不明时加载器停在最后一帧；文案只用中文说明，不暴露状态码或渠道报错原文。
 * 取消：契约 STUDIO_BLOCKING_VERSION_STATES 把 cancelled 视为结果未知、不能再提交，所以写「结果待核对」而不是「可重试」。 */
export function studioLoaderFailure(version: StudioVersion): string {
  return version.state === 'unknown' || version.state === 'reconciling' ? '生成结果待核对' : version.state === 'cancelled' ? '已取消，结果待核对' : '生成失败，可重试';
}
