// 生图加载态「真实进度」浏览器用例：生产 ImageWorkbench + 生产加载器（真实 WebGL / Canvas），mock 渠道依次推送 3 张中间图 + 终图，
// 断言底图块尺寸单调下降、终图锐化到清晰后换成普通图片；无中间图时按阶段 + 历史均值估算、封顶不到 100% 且标「预计」、超时提示；
// 失败 / 取消 / 待核对停在最后一帧；修改时底图用原图；减少动态效果不做动画只切档位；没有 WebGL 时 Canvas 底图照样体现进度。不连服务、不触发真实生图。
// 连续帧截图（同一次生成从粗到清晰）写到 WORKBENCH_PROGRESS_FRAMES_DIR（默认 .ci-artifacts/image-gen-progress）。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Page } from '@playwright/test';
import { pixelPng } from '../helpers/png.ts';

const root = resolve(import.meta.dirname, '../..'), out = resolve(process.env.WORKBENCH_PROGRESS_FRAMES_DIR ?? join(root, '.ci-artifacts/image-gen-progress'));
mkdirSync(out, { recursive: true });
const errors: string[] = [], screens: string[] = [];
const bundle = await build({ absWorkingDir: root, entryPoints: [join(root, 'tests/ui-fidelity/image-gen-loader.fixture.ts')], bundle: true, write: false, outdir: join(out, 'bundle'), splitting: true, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, external: ['/workbench/*'], loader: { '.woff2': 'empty' } });
const files = new Map(bundle.outputFiles!.map(file => ['/' + basename(file.path), file]));
const entry = [...files.keys()].find(name => name.startsWith('/image-gen-loader.fixture') && name.endsWith('.js'))!, css = [...files.values()].filter(f => f.path.endsWith('.css')).map(f => f.text).join('\n');
// 模拟渠道的画面：同一张流程示意图，中间图细节逐张增加（1：底色与大块；2：+ 方框；3：+ 箭头与圆点），终图再加细纹理。
type Rgb = readonly [number, number, number];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
function scene(detail: number) {
  const W = 640, H = 360;
  return pixelPng(W, H, (x, y) => {
    let c = mix([11, 31, 82], [91, 95, 214], (x + y * 0.6) / (W + H * 0.6));
    if (detail >= 1) { const d = Math.hypot(x - 470, y - 90); if (d < 140) c = mix(c, [204, 248, 102], 0.35 * (1 - d / 140)); }
    const boxes: Array<[number, number, Rgb]> = [[60, 140, [255, 255, 255]], [250, 140, [204, 248, 102]], [440, 140, [226, 227, 251]]];
    if (detail >= 2) for (const [bx, by, col] of boxes) if (x >= bx && x < bx + 140 && y >= by && y < by + 90) { c = col; if (detail >= 3 && y > by + 30 && y < by + 38 && x > bx + 20 && x < bx + 110) c = [11, 31, 82]; }
    if (detail >= 3) { if (y >= 181 && y <= 189 && ((x > 200 && x < 250) || (x > 390 && x < 440))) c = [255, 255, 255]; const d = Math.hypot(x - 320, y - 290); if (d < 16) c = [204, 248, 102]; }
    if (detail >= 4 && (x + y) % 9 === 0) c = mix(c, [255, 255, 255], 0.18);
    return c;
  });
}
const variant = pixelPng(640, 360, (x, y) => (Math.hypot(x - 320, y - 180) < 120 ? [204, 248, 102] : ((x >> 5) + (y >> 5)) % 2 ? [226, 227, 251] : [91, 95, 214]));
const images = new Map([['/fixture-img/final-a2.png', variant], ['/fixture-img/preview-a-1.png', scene(1)], ['/fixture-img/preview-a-2.png', scene(2)], ['/fixture-img/preview-a-3.png', scene(3)], ['/fixture-img/final-a.png', scene(4)]]);
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]!;
  try {
    if (url.startsWith('/workbench/')) { const leaf = url.slice(7); if (!/^[\w./-]+$/.test(leaf) || leaf.includes('..')) throw new Error('bad path'); res.setHeader('content-type', leaf.endsWith('.svg') ? 'image/svg+xml' : leaf.endsWith('.webp') ? 'image/webp' : 'application/octet-stream'); res.end(readFileSync(join(root, 'apps/web/public/workbench', leaf))); return; }
    const img = images.get(url) ?? (/^\/fixture-img\/(final|preview)-[a-f](-\d)?\.png$/.test(url) ? scene(4) : undefined); if (img) { res.setHeader('content-type', 'image/png'); res.end(img); return; }
    const file = files.get(url); if (file) { res.setHeader('content-type', 'text/javascript'); res.end(file.contents); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style><div id="root"><main id="content"><div class="page"></div></main></div><script type="module" src="' + entry + '"></script></html>');
  } catch (e) { res.statusCode = 500; res.end(String(e)); }
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
type MockProgress = { stage: 'queued' | 'starting' | 'generating' | 'saving' | 'checking'; previews?: number; runningMs?: number | null; totalMs?: number; typicalMs?: number };
const set = (page: Page, next: Record<string, string>, progress: Record<string, MockProgress | null> = {}) => page.evaluate(([n, p]) => (window as unknown as { fixture: { set(n: unknown, p: unknown): Promise<void> } }).fixture.set(n, p), [next, progress] as const);
const base = '.iwb-stage .img-gen-loader-base';
const read = (page: Page) => page.locator(base).evaluate(el => { const d = (el as HTMLElement).dataset; return { block: Number(d.block), target: Number(d.target), kind: d.kind ?? '' }; });
const label = (page: Page) => page.locator('.iwb-stage .img-gen-loader-label').evaluate(el => el.textContent ?? '');
// 等底图块尺寸收敛到目标；期间每 40ms 采样一次，核对过渡过程本身单调（只降不升、不跳闪回粗）。
async function settleBlock(page: Page, samples: number[], timeout = 6000) {
  const start = Date.now();
  for (;;) { const v = await read(page); if (Number.isFinite(v.block)) samples.push(v.block); /* 首帧绘制前没有读数 */ if (Math.abs(v.block - v.target) < 0.02 && v.kind !== 'none') return v; if (Date.now() - start > timeout) throw new Error('块尺寸没有收敛：' + JSON.stringify(v)); await page.waitForTimeout(40); }
}
async function frame(page: Page, name: string, width: number) { await page.evaluate(() => document.querySelector('.iwb-gen-loader')?.scrollIntoView({ block: 'center' })); const file = join(out, name + '-' + width + '.png'); await page.locator('.iwb-stage-col').screenshot({ path: file }); screens.push(file); }
const monotone = (list: number[], what: string) => { for (let i = 1; i < list.length; i++) assert.ok(list[i]! <= list[i - 1]! + 0.01, what + ' 出现变粗：' + list.slice(Math.max(0, i - 3), i + 2).join(' → ')); };
const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results: Record<string, unknown> = {};
try {
  for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844]] as const) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', e => errors.push(width + ':' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(width + ':console:' + m.text()); });
    await page.goto(origin + '/'); await page.locator('.iwb-art').first().waitFor();
    // ① 有中间图：开始生成（还没有中间图）→ 3 张中间图 → 终图。同一次生成连续取帧。
    await set(page, { a: 'running' }, { a: { stage: 'generating', previews: 0, runningMs: 1500, typicalMs: 60000 } });
    await page.locator(base).waitFor(); const samples: number[] = [], targets: number[] = [];
    let v = await settleBlock(page, samples); targets.push(v.target); assert.equal(v.kind, 'noise', '还没有中间图：提示词色调噪点');
    assert.match(await label(page), /正在生成.*预计 \d+%.*已用/);
    await frame(page, '1-started', width);
    for (let n = 1; n <= 3; n++) {
      await set(page, { a: 'running' }, { a: { stage: 'generating', previews: n, runningMs: 1500 + n * 6000, typicalMs: 60000 } });
      await page.waitForFunction(([sel, k, prev]) => { const el = document.querySelector(sel) as HTMLElement | null; return el?.dataset.kind === 'preview' && Number(el.dataset.target) < prev && !!document.querySelector('.iwb-stage .img-gen-loader-label')?.textContent?.includes('已出 ' + k + ' 张预览'); }, [base, n, targets.at(-1)!] as const, { timeout: 8000 });
      v = await settleBlock(page, samples); targets.push(v.target);
      const text = await label(page); assert.match(text, new RegExp('正在生成·已出 ' + n + ' 张预览')); assert.doesNotMatch(text, /预计|%/, '有中间图时不显示估算百分比');
      await frame(page, (n + 1) + '-preview-' + n, width);
    }
    for (let i = 1; i < targets.length; i++) assert.ok(targets[i]! < targets[i - 1]!, '每张新中间图块尺寸下降一档：' + targets.join(' → '));
    monotone(samples, '中间图过渡');
    // 终图：从当前块尺寸平滑锐化到 1px（中途取一帧），完成后换成普通图片。
    const before = (await read(page)).block, sharpen: number[] = [];
    await set(page, { a: 'succeeded' }, { a: null });
    await page.waitForFunction(sel => (document.querySelector(sel) as HTMLElement | null)?.dataset.kind === 'final', base, { timeout: 8000 }).catch(() => {});
    let mid = false;
    for (let i = 0; i < 200; i++) {
      const has = await page.locator(base).count(); if (!has) break;
      const r = await read(page); if (r.kind === 'final') { sharpen.push(r.block); if (!mid && r.block > 1.3 && r.block < before - 0.5) { mid = true; await frame(page, '5-sharpening', width); } }
      await page.waitForTimeout(25);
    }
    assert.ok(sharpen.length > 0 && sharpen[0]! <= before + 0.01, '终图从当前块尺寸开始锐化：' + before + ' → ' + sharpen.slice(0, 3).join(','));
    monotone(sharpen, '终图锐化');
    await page.locator('.iwb-stage .iwb-art > img[src$="/fixture-img/final-a.png"]').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.iwb-stage .img-gen-loader').count(), 0, '锐化完成后换成普通图片');
    await frame(page, '6-final', width);
    results['frames-' + width] = { targets, sharpen_first: sharpen[0], sharpen_last: sharpen.at(-1), mid_frame: mid };
    // ② 无中间图：按阶段 + 历史均值估算，封顶不到 100%，标「预计」；超过均值 2 倍提示比平时慢。
    await set(page, { a: 'running' }, { a: { stage: 'starting', runningMs: 800, typicalMs: 40000 } });
    await page.locator('.iwb-stage .img-gen-loader').waitFor(); assert.match(await label(page), /正在启动 · 预计 \d+% · 已用/);
    await set(page, { a: 'running' }, { a: { stage: 'generating', runningMs: 30000, totalMs: 32000, typicalMs: 40000 } });
    await page.waitForFunction(() => /^正在生成 · 预计/.test(document.querySelector('.iwb-stage .img-gen-loader-label')?.textContent ?? ''), undefined, { timeout: 5000 });
    const mids = await label(page); assert.match(mids, /预计 \d+%/); assert.equal(await page.locator('.iwb-stage .img-gen-loader-slow').count(), 0, '没超时不提示');
    await set(page, { a: 'running' }, { a: { stage: 'generating', runningMs: 60000, totalMs: 61000, typicalMs: 40000 } });
    await page.locator('.iwb-stage .img-gen-loader-slow[data-note="finishing"]').filter({ hasText: '快好了，正在收尾' }).waitFor({ timeout: 5000 });
    await frame(page, 'estimate-finishing', width);
    await set(page, { a: 'running' }, { a: { stage: 'generating', runningMs: 400000, totalMs: 401000, typicalMs: 40000 } });
    await page.locator('.iwb-stage .img-gen-loader-slow').filter({ hasText: '比平时慢，仍在生成' }).waitFor({ timeout: 5000 });
    const capped = await label(page), pct = Number(/预计 (\d+)%/.exec(capped)?.[1]);
    assert.ok(pct >= 85 && pct <= 90, '封顶约 90%：' + capped); assert.doesNotMatch(capped, /100%/);
    await page.waitForTimeout(1200); assert.ok(Number(/预计 (\d+)%/.exec(await label(page))?.[1]) <= 90, '本地时钟推进也不越过上限');
    await set(page, { a: 'running' }, { a: { stage: 'saving', runningMs: 401000, totalMs: 402000, typicalMs: 40000 } });
    await page.waitForFunction(() => document.querySelector('.iwb-stage .img-gen-loader-label')?.textContent?.startsWith('正在保存'), undefined, { timeout: 5000 });
    await frame(page, 'estimate-slow', width);
    // ③ 失败：停在最后一帧（块尺寸不再变化、无着色器），写明原因。过渡进行中失败也冻结在当前帧，不跳到目标尺寸。
    await set(page, { a: 'running' }, { a: { stage: 'generating', previews: 0, runningMs: 1000, typicalMs: 60000 } });
    await page.locator(base).waitFor(); await settleBlock(page, []);
    await set(page, { a: 'running' }, { a: { stage: 'generating', previews: 1, runningMs: 2000, typicalMs: 60000 } });
    await page.waitForFunction(sel => (document.querySelector(sel) as HTMLElement | null)?.dataset.kind === 'preview', base, { timeout: 8000 });
    await set(page, { a: 'failed' }, { a: null });
    await page.locator('.iwb-stage .img-gen-loader[data-mode="failed"]').waitFor({ timeout: 8000 });
    await page.waitForFunction(sel => (document.querySelector(sel) as HTMLElement | null)?.dataset.frozen === 'true', base, { timeout: 3000 });
    const f1 = await read(page); await page.waitForTimeout(1200); const f2 = await read(page);
    assert.equal(f1.block, f2.block, '失败后不再动画'); assert.equal(await page.locator('.iwb-stage .image-gen-shader').count(), 0);
    results['freeze-' + width] = { frozen_at: f1.block, target: f1.target, mid_transition: f1.block > f1.target + 0.05 };
    assert.equal(await label(page), '生成失败，可重试');
    await frame(page, 'failed', width);
    // 取消：同样停下并写明。
    await set(page, { a: 'running' }, { a: { stage: 'generating', runningMs: 3000, typicalMs: 60000 } });
    await page.waitForFunction(() => document.querySelector('.iwb-stage .img-gen-loader')?.getAttribute('data-mode') !== 'failed', undefined, { timeout: 8000 });
    await set(page, { a: 'cancelled' }, { a: null });
    await page.locator('.iwb-stage .img-gen-loader[data-mode="failed"]').waitFor({ timeout: 8000 });
    assert.equal(await label(page), '已取消，结果待核对');
    await frame(page, 'cancelled', width);
    // 结果待核对（reconciling）：不再估算，文案为生成结果待核对；结果不明（unknown）同样。
    await set(page, { a: 'reconciling' }, { a: { stage: 'checking', runningMs: 50000, totalMs: 52000, typicalMs: 60000 } });
    await page.waitForFunction(() => document.querySelector('.iwb-stage .img-gen-loader-label')?.textContent === '生成结果待核对', undefined, { timeout: 8000 });
    const c1 = await read(page); await page.waitForTimeout(1200); const c2 = await read(page); assert.equal(c1.block, c2.block, '待核对时不再变清晰');
    assert.doesNotMatch(await label(page), /预计|%|生成中/);
    await frame(page, 'reconciling', width);
    await set(page, { a: 'unknown' }, { a: null });
    await page.locator('.iwb-stage .img-gen-loader[data-mode="failed"]').waitFor({ timeout: 8000 });
    assert.equal(await label(page), '生成结果待核对');
    // ④ 修改（基于第 1 版）：底图从第 1 版真实图片像素化开始，随进度变清晰；新图到达后过渡到新图。
    await set(page, { a: 'editing' }, { a: { stage: 'generating', runningMs: 1000, typicalMs: 60000 } });
    await page.waitForFunction(sel => (document.querySelector(sel) as HTMLElement | null)?.dataset.kind === 'parent', base, { timeout: 8000 });
    const e1 = await settleBlock(page, []); assert.match(await label(page), /^正在基于第 1 版修改 · 预计 \d+%/);
    await frame(page, 'edit-1-start', width);
    await set(page, { a: 'editing' }, { a: { stage: 'generating', runningMs: 45000, typicalMs: 60000 } });
    await page.waitForFunction(([sel, prev]) => Number((document.querySelector(sel) as HTMLElement | null)?.dataset.target) < prev, [base, e1.target] as const, { timeout: 8000 });
    const e2 = await settleBlock(page, []); assert.equal(e2.kind, 'parent'); assert.ok(e2.target < e1.target, '原图随进度变清晰：' + e1.target + ' → ' + e2.target);
    await frame(page, 'edit-2-progress', width);
    await set(page, { a: 'edited' }, { a: null });
    await page.locator('.iwb-stage .iwb-art > img[src$="/fixture-img/final-a2.png"]').waitFor({ timeout: 10000 });
    await frame(page, 'edit-3-final', width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, '横向溢出');
    await page.close();
  }
  // ⑦ 图片底加载失败 / 迟到：父图加载失败时停在噪点底（不留空）；冻结后迟到的中间图加载不再改画面。
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', e => errors.push('late:' + e.message));
    await page.goto(origin + '/'); await page.locator('.iwb-art').first().waitFor();
    await set(page, { a: 'succeeded' }, { a: null }); await page.locator('.iwb-stage .iwb-art > img[src$="/fixture-img/final-a.png"]').waitFor({ timeout: 8000 });
    await page.route('**/fixture-img/final-a.png', route => route.abort());
    await set(page, { a: 'editing' }, { a: { stage: 'generating', runningMs: 1000, typicalMs: 60000 } });
    await page.locator(base).waitFor(); await page.waitForTimeout(1500);
    const broken = await read(page); assert.equal(broken.kind, 'noise', '父图加载失败：噪点底，不留空'); assert.ok(Number.isFinite(broken.block), '已经画出底图');
    assert.match(await label(page), /^正在基于第 1 版修改/);
    await page.unroute('**/fixture-img/final-a.png');
    await set(page, { a: 'idle' }, { a: null });
    await page.route('**/fixture-img/preview-a-1.png', async route => { await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
    await set(page, { a: 'running' }, { a: { stage: 'generating', previews: 1, runningMs: 2000, typicalMs: 60000 } });
    await page.locator(base).waitFor();
    await set(page, { a: 'failed' }, { a: null });
    await page.locator('.iwb-stage .img-gen-loader[data-mode="failed"]').waitFor({ timeout: 8000 });
    const atFreeze = await read(page); await page.waitForTimeout(2500); const later = await read(page);
    assert.equal(later.kind, atFreeze.kind, '冻结后迟到的图片加载不改画面：' + atFreeze.kind + ' → ' + later.kind); assert.equal(later.kind, 'noise'); assert.equal(later.block, atFreeze.block);
    results.late_load = { parent_failed: broken.kind, frozen_kind: later.kind };
    await page.close();
  }
  for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844]] as const) {
    // ⑤ 减少动态效果：不跑着色器、块尺寸直接落到档位（不做过渡），随中间图切换档位。
    const reduced = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    reduced.on('pageerror', e => errors.push('reduced:' + e.message));
    await reduced.goto(origin + '/'); await reduced.locator('.iwb-art').first().waitFor();
    const levels: number[] = [];
    for (const n of [0, 1, 2, 3]) {
      await set(reduced, { a: 'running' }, { a: { stage: 'generating', previews: n, runningMs: 2000 + n * 5000, typicalMs: 60000 } });
      await reduced.waitForFunction(([sel, k, prev]) => { const el = document.querySelector(sel) as HTMLElement | null; return !!el && (k === 0 ? el.dataset.kind === 'noise' : el.dataset.kind === 'preview' && !!document.querySelector('.iwb-stage .img-gen-loader-label')?.textContent?.includes('已出 ' + k) && Number(el.dataset.target) < prev); }, [base, n, levels.at(-1) ?? Infinity] as const, { timeout: 8000 });
      const r = await read(reduced); assert.equal(r.block, r.target, '减少动态：直接切到档位，没有过渡'); levels.push(r.block);
      assert.equal(await reduced.locator('.image-gen-shader').count(), 0, '减少动态：不跑着色器');
      if (n === 1 || n === 3) await frame(reduced, 'reduced-motion-preview-' + n, width);
    }
    for (let i = 1; i < levels.length; i++) assert.ok(levels[i]! < levels[i - 1]!, '减少动态下仍按中间图切换清晰度：' + levels.join(' → '));
    await set(reduced, { a: 'succeeded' }, { a: null });
    await reduced.locator('.iwb-stage .iwb-art > img[src$="/fixture-img/final-a.png"]').waitFor({ timeout: 5000 });
    results['reduced-' + width] = levels; await reduced.close();
    // ⑥ 没有 WebGL（降级）：不跑着色器，Canvas 底图照样随中间图变清晰。
    const nogl = await browser.newPage({ viewport: { width, height } });
    nogl.on('pageerror', e => errors.push('nogl:' + e.message));
    await nogl.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) { return /webgl/.test(type) ? null : (original as (...a: unknown[]) => unknown).call(this, type, ...rest); } as typeof original; });
    await nogl.goto(origin + '/'); await nogl.locator('.iwb-art').first().waitFor();
    const degraded: number[] = [];
    for (const n of [0, 1, 2, 3]) {
      await set(nogl, { a: 'running' }, { a: { stage: 'generating', previews: n, runningMs: 2000 + n * 5000, typicalMs: 60000 } });
      await nogl.waitForFunction(([sel, k, prev]) => { const el = document.querySelector(sel) as HTMLElement | null; return !!el && (k === 0 ? el.dataset.kind === 'noise' : el.dataset.kind === 'preview' && !!document.querySelector('.iwb-stage .img-gen-loader-label')?.textContent?.includes('已出 ' + k) && Number(el.dataset.target) < prev); }, [base, n, degraded.at(-1) ?? Infinity] as const, { timeout: 8000 });
      const r = await settleBlock(nogl, []); degraded.push(r.target);
      assert.equal(await nogl.locator('.iwb-stage .img-gen-loader').getAttribute('data-mode'), 'static'); assert.equal(await nogl.locator('.image-gen-shader').count(), 0);
      if (n === 1 || n === 3) await frame(nogl, 'no-webgl-preview-' + n, width);
    }
    for (let i = 1; i < degraded.length; i++) assert.ok(degraded[i]! < degraded[i - 1]!, '降级时仍体现进度：' + degraded.join(' → '));
    results['no-webgl-' + width] = degraded; await nogl.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', ...results, screens }, null, 1));
} finally { await browser.close(); server.close(); }
