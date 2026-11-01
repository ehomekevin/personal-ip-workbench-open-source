import type { GenerationProgressView } from '../transport/feature-ports.ts';
export const STALE_OUTPUT_MS = 90_000;
export const STALE_OUTPUT_MESSAGE = '执行器较长时间无输出，可继续等待或取消';

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)), hours = Math.floor(seconds / 3600); return (hours ? hours + ':' : '') + pad(Math.floor(seconds % 3600 / 60)) + ':' + pad(seconds % 60); };
const ago = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? seconds + ' 秒前' : Math.floor(seconds / 60) + ' 分钟前'; };

// 已用时间和“最近一次有输出”只由服务时间戳与本地时钟相减得到，不显示百分比或推算阶段。
export function progressTiming(timing: NonNullable<GenerationProgressView['timing']>, now: number) {
  const since = Date.parse(timing.since), output = timing.last_output_at ? Date.parse(timing.last_output_at) : NaN;
  const quietSince = Number.isFinite(output) ? output : since, stale = Number.isFinite(quietSince) && now - quietSince >= (timing.stale_after_ms ?? STALE_OUTPUT_MS);
  return { elapsed: Number.isFinite(since) ? '已用时 ' + clock(now - since) : '', output: Number.isFinite(output) ? '最近一次有输出 ' + ago(now - output) : '已开始，暂未收到输出', stale };
}

