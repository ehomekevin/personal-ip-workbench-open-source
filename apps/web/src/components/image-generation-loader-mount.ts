import type { LoaderOptions } from './image-generation-loader-core.ts';
// 主包里只留这个薄挂载层：先画静态占位，再按需加载加载器组件（img-fx / three 由组件在 running 时再动态加载）。
type LoaderModule = typeof import('./ImageGenerationLoader.tsx');
let loaderModule: Promise<LoaderModule> | undefined;
// 静态占位与组件静态态同款；文案由组件加载后接管，这里只放宿主给的标签。
function placeholder(el: HTMLElement, o: LoaderOptions) {
  const ratio = String(o.width > 0 && o.height > 0 ? o.width / o.height : 1);
  el.innerHTML = '<div class="img-gen-loader" data-mode="' + (o.state === 'failed' ? 'failed' : 'static') + '" style="--img-gen-ratio:' + ratio + ';aspect-ratio:' + ratio + '"><div class="img-gen-loader-static" aria-hidden="true"><span></span><span></span><span></span></div><span class="img-gen-loader-label" role="status"></span></div>';
  el.querySelector('.img-gen-loader-label')!.textContent = o.label ?? '';
}
export function mountImageLoader(el: HTMLElement, options: LoaderOptions): { update(options: LoaderOptions): void; dispose(): void } {
  let latest = options, disposed = false, failed = false, handle: ReturnType<LoaderModule['mount']> | undefined;
  // 组件还没加载（或加载失败）时任务就成功了：没有动画可放，直接告诉宿主换成真图。
  const settleWithoutAnimation = () => { if (latest.state === 'succeeded') latest.onRevealed?.(); };
  placeholder(el, latest);
  (loaderModule ??= import('./ImageGenerationLoader.tsx')).then(mod => { if (disposed || failed) return; el.replaceChildren(); handle = mod.mount(el, latest); }, () => { failed = true; loaderModule = undefined; if (!disposed) settleWithoutAnimation(); });
  return {
    update(o) { latest = o; if (handle) { handle.update(o); return; } if (disposed) return; placeholder(el, o); if (failed) settleWithoutAnimation(); },
    dispose() { disposed = true; handle?.dispose(); handle = undefined; },
  };
}
