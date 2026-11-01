import { useEffect, useRef, useState } from 'react';
import { FallbackBoundary } from './fallback-boundary.ts';
import { createRoot, type Root } from 'react-dom/client';
import { LoaderMachine, createGpuSlots, MAX_BLOCK, MIN_ESTIMATE_BLOCK, type LoaderEnv, type LoaderOptions, type LoaderView } from './image-generation-loader-core.ts';
import { PixelBase } from './image-generation-loader-canvas.ts';

// 生图加载态：底图按真实进度像素化（中间图 / 噪点 → 终图），任务真实 running 时叠一层 img-fx 像素着色器动效；
// 成功后底图从当前块尺寸平滑锐化到终图，再换成普通图片。img-fx 与 three 只在第一次出现 running 槽位时动态加载，不进主包。
type ImgFx = typeof import('img-fx');
let library: Promise<ImgFx> | undefined, loaded: ImgFx | undefined;
const loadImgFx = () => library ??= import('img-fx').then(mod => { loaded = mod; return mod; });
let webglCache: boolean | undefined;
// 探测一次 WebGL 并立刻释放探测用的上下文，不占浏览器的上下文名额。
// 只认硬件加速：软件渲染（SwiftShader / llvmpipe）下着色器每帧很慢、会拖住整页合成，按「不可用」降级为静态占位。
function webglAvailable(): boolean {
  if (webglCache !== undefined) return webglCache;
  try {
    const canvas = document.createElement('canvas'), gl = (canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true }) ?? canvas.getContext('webgl', { failIfMajorPerformanceCaveat: true })) as WebGLRenderingContext | null;
    const info = gl?.getExtension('WEBGL_debug_renderer_info'), renderer = gl ? String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : '';
    webglCache = !!gl && !/swiftshader|llvmpipe|softpipe|software|basic render driver/i.test(renderer); gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { webglCache = false; }
  return webglCache;
}
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const slots = createGpuSlots(4);
export const defaultLoaderEnv: LoaderEnv = { webgl: webglAvailable, reducedMotion, load: loadImgFx, slots, origin: () => location.origin };

// 着色器只作为底图上方的半透明动效层：块越细强度越低，揭示时淡出；像素格与底图块尺寸同步缩小。
function Shader({ view }: { view: LoaderView }) {
  const Fx = loaded!.ImageGeneration, strength = view.mode === 'reveal' ? 0 : 0.12 + 0.3 * Math.max(0, Math.min(1, (view.block - MIN_ESTIMATE_BLOCK) / (MAX_BLOCK - MIN_ESTIMATE_BLOCK)));
  return <Fx className="img-gen-loader-fx" preset={view.preset} theme="light" images={[]} autoReveal={false} strength={strength} pixelScale={Math.max(0.35, Math.min(3, view.block / 14))} style={{ background: 'transparent' }}>
    <div className="img-gen-loader-card" />
  </Fx>;
}
// 底图：Canvas 2D 像素化（不依赖 WebGL），降级与减少动态效果时同样按进度切换清晰度。
function Base({ view, checking, onSettled }: { view: LoaderView; checking: boolean; onSettled(): void }) {
  const ref = useRef<HTMLCanvasElement>(null), painter = useRef<PixelBase | undefined>(undefined), settle = useRef(onSettled);
  settle.current = onSettled;
  useEffect(() => { painter.current = new PixelBase(ref.current!); return () => { painter.current?.dispose(); painter.current = undefined; }; }, []);
  useEffect(() => { painter.current?.set({ base: view.base, block: view.block, animate: view.animate, frozen: view.mode === 'failed' || checking, onSettled: () => settle.current() }); });
  return <canvas ref={ref} className="img-gen-loader-base" aria-hidden="true" />;
}

export interface ImageGenerationLoaderProps extends LoaderOptions { env?: LoaderEnv }
export function ImageGenerationLoader(props: ImageGenerationLoaderProps) {
  const [, setTick] = useState(0), latest = useRef(props);
  latest.current = props;
  const machine = useRef<LoaderMachine | undefined>(undefined);
  machine.current ??= new LoaderMachine(props.env ?? defaultLoaderEnv, { ...props, onRevealed: () => latest.current.onRevealed?.() }, () => setTick(n => n + 1));
  const m = machine.current;
  const { state, images, width, height, preset, label, progress, seed, parentImage, parentLabel, runKey } = props, key = images.join('\n'), progressKey = progress ? JSON.stringify(progress) : '';
  useEffect(() => { m.update({ state, images, width, height, ...(preset ? { preset } : {}), ...(label ? { label } : {}), ...(progress ? { progress } : {}), ...(seed ? { seed } : {}), ...(parentImage ? { parentImage } : {}), ...(parentLabel ? { parentLabel } : {}), ...(runKey ? { runKey } : {}), onRevealed: () => latest.current.onRevealed?.() }); m.settle(); }, [m, state, key, width, height, preset, label, progressKey, seed, parentImage, parentLabel, runKey]);
  useEffect(() => () => m.dispose(), [m]);
  // 进行中每秒刷新一次：已用时间、估算进度与块尺寸随本地时钟推进（不额外请求服务）。
  const ticking = (state === 'queued' || state === 'running') && !!progress && progress.stage !== 'checking';
  useEffect(() => { if (!ticking) return; const timer = setInterval(() => setTick(n => n + 1), 1000); return () => clearInterval(timer); }, [ticking]);
  const view = m.view(), live = view.mode === 'shader' || view.mode === 'reveal', r = view.readout;
  return <div className="img-gen-loader" data-mode={view.mode} data-state={view.state} data-stage={progress?.stage ?? view.state} data-estimated={r.estimated ? 'true' : 'false'} style={{ ['--img-gen-ratio' as string]: String(view.ratio), aspectRatio: String(view.ratio) }}>
    {view.mode === 'done' && view.finalImage ? <img className="img-gen-loader-final" src={view.finalImage} alt="" />
      : <><Base view={view} checking={progress?.stage === 'checking'} onSettled={() => m.revealDone()} />{live && loaded ? <FallbackBoundary fallback={null} onError={() => m.fail()}><Shader view={view} /></FallbackBoundary> : null}</>}
    <span className="img-gen-loader-label"><b role="status" aria-live="polite">{r.stage}</b>{r.detail ? <span className="img-gen-loader-detail">{' · ' + r.detail}</span> : null}</span>
    {r.note ? <span className="img-gen-loader-slow" data-note={r.note} role="note">{r.note === 'slow' ? '比平时慢，仍在生成' : '快好了，正在收尾'}</span> : null}
  </div>;
}

// 给原生 TS 调用：照 GenerationProgressMount，一个槽位一个 React root；update 复用同一个 root，不重建着色器。
export interface ImageGenerationLoaderHandle { update(options: LoaderOptions): void; dispose(): void }
export function mount(el: HTMLElement, options: LoaderOptions): ImageGenerationLoaderHandle {
  let root: Root | undefined = createRoot(el);
  const render = (o: LoaderOptions) => root?.render(<ImageGenerationLoader {...o} />);
  render(options);
  return { update: render, dispose() { root?.unmount(); root = undefined; } };
}
