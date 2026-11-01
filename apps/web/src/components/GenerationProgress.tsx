import { lazy, Suspense, useEffect, useState } from 'react';
import type { GenerationProgressView } from '../transport/feature-ports.ts';
import { XiaoliuGenerationOrb } from './XiaoliuGenerationOrb.tsx';
import { FallbackBoundary } from './fallback-boundary.ts';
import { progressTiming, STALE_OUTPUT_MESSAGE } from './generation-progress-timing.ts';

// 生图任务的像素马赛克加载器按需加载，不进主包；加载期间先显示同款静态占位。
const ImageGenerationLoader = lazy(() => import('./ImageGenerationLoader.tsx').then(mod => ({ default: mod.ImageGenerationLoader })));
const stillLoader = (ratio: number) => <div className="img-gen-loader" data-mode="static" style={{ ['--img-gen-ratio' as string]: String(ratio), aspectRatio: String(ratio) }}><div className="img-gen-loader-static"><span /><span /><span /></div></div>;
const stateLabels: Record<GenerationProgressView['state'], string> = {
  queued: '已排队',
  running: '处理中',
  waiting: '等待执行器',
  failed: '需要核对',
  succeeded: '候选已生成',
};
function Timing({ view }: { view: GenerationProgressView }) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = !!view.timing && view.state === 'running';
  useEffect(() => { if (!ticking) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [ticking, view.timing?.since, view.timing?.last_output_at]);
  if (!view.timing || view.state !== 'running') return null;
  const value = progressTiming(view.timing, now);
  return <p className="generation-progress-timing" data-stale={value.stale ? 'true' : 'false'}>
    <span>{value.elapsed}</span>
    <span>{value.stale ? STALE_OUTPUT_MESSAGE : value.output}</span>
  </p>;
}

export function GenerationProgress({ view }: { view: GenerationProgressView }) {
  return <section className="generation-progress" data-state={view.state} aria-busy={view.state === 'queued' || view.state === 'running'}>
    {view.image ? <div className="generation-progress-visual is-image" aria-hidden="true">
      <FallbackBoundary fallback={<XiaoliuGenerationOrb animated={view.state === 'running'} />}><Suspense fallback={stillLoader(view.image.width > 0 && view.image.height > 0 ? view.image.width / view.image.height : 1)}><ImageGenerationLoader state={view.state === 'running' ? 'running' : view.state === 'failed' ? 'failed' : 'queued'} images={view.image.images} width={view.image.width} height={view.image.height} label={view.label ?? stateLabels[view.state]} /></Suspense></FallbackBoundary>
    </div> : <div className="generation-progress-visual" aria-hidden="true">
      <XiaoliuGenerationOrb animated={view.state === 'running'} />
    </div>}
    <div role="status" aria-live="polite" aria-atomic="true">
      <span className="generation-progress-state">{view.label ?? stateLabels[view.state]}</span>
      <p className="generation-progress-message">{view.message}</p>
    </div>
    <Timing view={view} />
    {view.note ? <p className="generation-progress-note">{view.note}</p> : null}
    {view.details?.length ? <details className="generation-progress-details">
      <summary>详情</summary>
      <dl>{view.details.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
    </details> : null}
  </section>;
}
