import type { LoaderBase } from './image-generation-loader-core.ts';
// 生图加载态的底图（Canvas 2D，不依赖 WebGL）：把中间图 / 终图 / 提示词色调噪点按块尺寸像素化画出来。
// 块尺寸在对数空间里平滑收敛到目标值，换图时交叉淡入，避免跳闪；animate=false（减少动态效果）时直接切到目标档位。
// 终图到达后收敛到 1px 并完成淡入时回调 onSettled，由宿主把加载器换成普通图片。
/** frozen：失败 / 取消 / 结果待核对时停在当前这一帧（取消进行中的过渡与 rAF），不再跳到目标尺寸。 */
export interface PixelBaseInput { base: LoaderBase; block: number; animate: boolean; frozen?: boolean; onSettled?(): void }
interface Layer { key: string; base: LoaderBase; img: HTMLImageElement | null }
const TAU_MS = 260, FADE_MS = 360;
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
// 低饱和的平滑噪点：几组正弦叠加给出大块明暗，再叠一点逐格颗粒；色相围绕提示词色调小幅摆动。
function noiseColor(u: number, v: number, hue: number, grain: number): [number, number, number] {
  const p = hue / 57.3, n = 0.5 + 0.22 * Math.sin(5.3 * u + 2.1 * Math.sin(3.7 * v + p)) + 0.18 * Math.sin(7.9 * v - 1.7 * Math.cos(4.3 * u - p)) + 0.1 * (grain - 0.5);
  const x = Math.max(0, Math.min(1, n));
  return hslToRgb((hue + 26 * (x - 0.5) + 360) % 360, 0.12 + 0.14 * x, 0.7 + 0.18 * x);
}
const hash = (x: number, y: number) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
export class PixelBase {
  private readonly canvas: HTMLCanvasElement; private readonly off: HTMLCanvasElement;
  private input: PixelBaseInput | undefined; private current: Layer | undefined; private previous: Layer | undefined; private pending: Layer | undefined;
  private level = Math.log2(48); private fadeStart = 0; private frame = 0; private disposed = false; private settled = false; private last = 0; private drawn = false;
  private readonly cache = new Map<string, HTMLImageElement>();
  constructor(canvas: HTMLCanvasElement) { this.canvas = canvas; this.off = canvas.ownerDocument.createElement('canvas'); }
  set(input: PixelBaseInput) {
    if (this.disposed) return;
    if (input.frozen && this.current) { this.input = input; if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; this.previous = undefined; this.pending = undefined; this.canvas.dataset.frozen = 'true'; return; }
    delete this.canvas.dataset.frozen;
    const first = !this.input; this.input = input;
    if (first || !input.animate) this.level = Math.log2(Math.max(1, input.block));
    const key = input.base.kind === 'noise' ? 'noise:' + input.base.hue : input.base.src ?? '';
    const shown = this.pending?.key ?? this.current?.key;
    if (key !== shown) {
      const layer: Layer = { key, base: input.base, img: null };
      // 图片底（父图 / 中间图 / 终图）还没加载好时先画噪点底，加载失败也不会留空。
      if (input.base.src) { if (!this.current) this.swap({ key: 'noise:' + input.base.hue, base: { kind: 'noise', src: null, hue: input.base.hue }, img: null }); this.pending = layer; this.load(layer); } else this.swap(layer);
    }
    this.kick();
  }
  private load(layer: Layer) {
    const src = layer.base.src!, cached = this.cache.get(src);
    // 冻结（失败 / 取消 / 待核对）后迟到的加载回调一律忽略。
    const done = (img: HTMLImageElement) => { if (this.disposed || this.input?.frozen || this.pending !== layer) return; layer.img = img; this.pending = undefined; this.swap(layer); this.kick(); };
    if (cached?.complete && cached.naturalWidth) { done(cached); return; }
    const img = cached ?? new Image(); if (!cached) { img.decoding = 'async'; img.src = src; this.cache.set(src, img); if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!); }
    img.decode().then(() => done(img), () => { if (this.pending === layer) this.pending = undefined; });
  }
  private swap(layer: Layer) { this.previous = this.input?.animate && this.current ? this.current : undefined; this.current = layer; this.fadeStart = performance.now(); this.settled = false; }
  private kick() { if (this.frame || this.disposed) return; this.last = performance.now(); this.frame = requestAnimationFrame(t => this.tick(t)); }
  private tick(now: number) {
    this.frame = 0; if (this.disposed || !this.input) return;
    if (this.input.frozen && this.drawn) return; // 冻结后迟到的 rAF 不再改画面
    const target = Math.log2(Math.max(1, this.input.block)), dt = Math.min(100, Math.max(0, now - this.last)); this.last = now;
    if (this.input.animate) { this.level += (target - this.level) * (1 - Math.exp(-dt / TAU_MS)); if (Math.abs(target - this.level) < 0.015) this.level = target; } else this.level = target;
    const fade = this.previous ? Math.min(1, (now - this.fadeStart) / FADE_MS) : 1; if (fade >= 1) this.previous = undefined;
    this.draw(fade); this.drawn = true;
    if (this.input.frozen) return;
    const moving = this.level !== target || !!this.previous;
    if (moving) { this.frame = requestAnimationFrame(t => this.tick(t)); return; }
    if (!this.settled && this.current?.base.kind === 'final' && this.current.img && target === 0) { this.settled = true; this.canvas.dataset.settled = 'true'; this.input.onSettled?.(); }
  }
  private draw(fade: number) {
    const rect = this.canvas.getBoundingClientRect(), w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height)), dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) { this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr); }
    const ctx = this.canvas.getContext('2d'); if (!ctx) return;
    const block = Math.pow(2, this.level);
    ctx.globalAlpha = 1; ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.previous) this.paint(ctx, this.previous, block, w, h, dpr, 1);
    if (this.current) this.paint(ctx, this.current, block, w, h, dpr, this.previous ? fade : 1);
    ctx.globalAlpha = 1;
    const d = this.canvas.dataset; d.block = block.toFixed(2); d.target = Math.max(1, this.input!.block).toFixed(2); d.kind = this.current?.base.kind ?? 'none';
  }
  private paint(ctx: CanvasRenderingContext2D, layer: Layer, block: number, w: number, h: number, dpr: number, alpha: number) {
    ctx.globalAlpha = alpha;
    if (layer.img && block <= 1.05) { ctx.imageSmoothingEnabled = true; this.cover(ctx, layer.img, this.canvas.width, this.canvas.height); return; }
    const cw = Math.max(1, Math.ceil(w / block)), ch = Math.max(1, Math.ceil(h / block)), o = this.off;
    if (o.width !== cw || o.height !== ch) { o.width = cw; o.height = ch; }
    const octx = o.getContext('2d'); if (!octx) return;
    if (layer.img) { octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = 'medium'; this.cover(octx, layer.img, cw, ch); }
    else {
      const data = octx.createImageData(cw, ch), hue = layer.base.hue;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const [r, g, b] = noiseColor((x + 0.5) / cw * (w / Math.max(w, h)) * 2, (y + 0.5) / ch * (h / Math.max(w, h)) * 2, hue, hash(x / cw * 97, y / ch * 61)); const i = (y * cw + x) * 4; data.data[i] = r; data.data[i + 1] = g; data.data[i + 2] = b; data.data[i + 3] = 255; }
      octx.putImageData(data, 0, 0);
    }
    ctx.imageSmoothingEnabled = false; ctx.drawImage(o, 0, 0, cw, ch, 0, 0, cw * block * dpr, ch * block * dpr);
  }
  // object-fit: cover，与成图 <img> 的裁切一致。
  private cover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
    const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1, scale = Math.max(w / iw, h / ih), sw = w / scale, sh = h / scale;
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, w, h);
  }
  dispose() { this.disposed = true; if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; }
}
