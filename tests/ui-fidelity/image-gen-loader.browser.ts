// 生图加载态（img-fx）浏览器用例：配图工作台单图舞台上 AI 生图 running 时跑像素马赛克着色器、成功后揭示到真图；
// 生产挂载层同时挂 6 个 running 加载器只有 4 个着色器实例；减少动态下没有着色器；失败停在最后一帧并写明原因。三视口截图（running 中间帧与揭示完成帧）。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Page } from '@playwright/test';
import { solidPng } from '../helpers/png.ts';

const root = resolve(import.meta.dirname, '../..'), out = resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR ?? join(root, '.ci-artifacts/image-gen-loader'));
mkdirSync(out, { recursive: true });
const errors: string[] = [], screens: string[] = [];
// 按 chunk 拆分打包：加载器组件与 img-fx / three 是动态 import 的独立文件，记录它们何时被请求。
const bundle = await build({ absWorkingDir: root, entryPoints: [join(root, 'tests/ui-fidelity/image-gen-loader.fixture.ts')], bundle: true, write: false, outdir: join(out, 'bundle'), splitting: true, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, external: ['/workbench/*'], loader: { '.woff2': 'empty' } });
const files = new Map(bundle.outputFiles!.map(file => ['/' + basename(file.path), file]));
const entry = [...files.keys()].find(name => name.startsWith('/image-gen-loader.fixture') && name.endsWith('.js'))!, css = [...files.values()].filter(f => f.path.endsWith('.css')).map(f => f.text).join('\n');
const finals = new Map([['a', [91, 95, 214]], ['b', [11, 31, 82]], ['c', [204, 248, 102]], ['d', [226, 227, 251]], ['e', [196, 202, 231]], ['f', [74, 85, 128]]] as const);
const requested: string[] = [];
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]!; requested.push(url);
  try {
    if (url.startsWith('/workbench/')) { const leaf = url.slice(7); if (!/^[\w./-]+$/.test(leaf) || leaf.includes('..')) throw new Error('bad path'); res.setHeader('content-type', leaf.endsWith('.svg') ? 'image/svg+xml' : leaf.endsWith('.webp') ? 'image/webp' : 'application/octet-stream'); res.end(readFileSync(join(root, 'apps/web/public/workbench', leaf))); return; }
    const img = /^\/fixture-img\/final-([a-f])\.png$/.exec(url); if (img) { res.setHeader('content-type', 'image/png'); res.end(solidPng(320, 240, finals.get(img[1]!)!)); return; }
    const file = files.get(url); if (file) { res.setHeader('content-type', 'text/javascript'); res.end(file.contents); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style><div id="root"><main id="content"><div class="page"></div></main></div><script type="module" src="' + entry + '"></script></html>');
  } catch (e) { res.statusCode = 500; res.end(String(e)); }
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const set = (page: Page, next: Record<string, string>) => page.evaluate(n => (window as unknown as { fixture: { set(n: Record<string, string>): Promise<void> } }).fixture.set(n), next);
const shaders = (page: Page, scope = '.iwb-stage') => page.locator(scope + ' .img-gen-loader .image-gen-shader').count();
async function shot(page: Page, name: string, width: number, selector = '.iwb-gen-loader, .iwb-art') { await page.evaluate(sel => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), selector); await page.waitForTimeout(300); const file = join(out, name + '-' + width + '.png'); await page.screenshot({ path: file }); screens.push(file); }
// 着色器在 SwiftShader（CPU 软渲染）下每帧很慢，会拖住合成器导致截图超时；macOS 本机用 Metal 真 GPU，其余平台退回 SwiftShader。
const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results: Record<string, unknown> = {};
try {
  // 先确认 headless 浏览器能拿到 WebGL；拿不到时如实标记，不把降级当作通过。
  const probe = await browser.newPage(); await probe.goto(origin + '/probe'); const webgl = await probe.evaluate(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: true }) ?? c.getContext('webgl', { failIfMajorPerformanceCaveat: true }), info = gl?.getExtension('WEBGL_debug_renderer_info'); return !!gl && !/swiftshader|llvmpipe|softpipe|software|basic render driver/i.test(String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))); }); await probe.close();
  results.webgl = webgl; assert.ok(webgl, 'headless Chromium 没有硬件加速 WebGL（加载器会按设计降级为静态），无法验证着色器路径');
  for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844]] as const) {
    requested.length = 0;
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', e => errors.push(width + ':' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(width + ':console:' + m.text()); });
    await page.goto(origin + '/');
    await page.locator('.iwb-art').first().waitFor();
    assert.equal(await page.locator('.img-gen-loader').count(), 0, '待生成的槽位不显示加载动效');
    // 排队：静态占位，不跑着色器，也不加载 img-fx。
    await set(page, { a: 'queued' });
    await page.locator('.iwb-stage .img-gen-loader[data-mode="static"]').first().waitFor();
    await page.waitForTimeout(400);
    assert.equal(await shaders(page), 0, 'queued 不跑着色器');
    assert.equal(await page.locator('.iwb-stage .img-gen-loader-label').first().innerText(), '排队中');
    // running：出现着色器 canvas，循环中间帧截图。
    await set(page, { a: 'running' });
    await page.locator('.iwb-stage .img-gen-loader[data-mode="shader"] .image-gen-shader').first().waitFor({ state: 'attached', timeout: 15000 }).catch(async e => { throw new Error(width + ' 没出现着色器：' + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.img-gen-loader')].map(n => (n as HTMLElement).dataset.mode + ':' + n.innerHTML.slice(0, 160)))) + ' errors=' + errors.join('|') + ' ' + String(e).slice(0, 80)); });
    assert.equal(await shaders(page), 1);
    const ratio = await page.locator('.iwb-stage .img-gen-loader').first().evaluate(el => { const r = el.getBoundingClientRect(); return r.width / r.height; });
    assert.ok(Math.abs(ratio - 16 / 9) < 0.05, '按槽位画幅比例：' + ratio);
    await page.waitForTimeout(1600);
    await shot(page, 'running', width);
    // 成功：揭示到真图，完成后画布换成普通图片、加载器卸载。
    await set(page, { a: 'succeeded' });
    await page.waitForFunction(() => !!document.querySelector('.iwb-stage .img-gen-loader[data-mode="reveal"]') || !!document.querySelector('.iwb-stage .iwb-art img[src$="/fixture-img/final-a.png"]'), undefined, { timeout: 10000 });
    const sawReveal = await page.locator('.iwb-stage .img-gen-loader[data-mode="reveal"]').count();
    if (sawReveal) { await page.waitForTimeout(500); await shot(page, 'revealing', width); }
    // 揭示完成：工作台立即重绘，舞台换成普通图片（恢复标注工具）、卸载加载器并释放着色器。
    await page.locator('.iwb-stage .iwb-art > img[src$="/fixture-img/final-a.png"]').waitFor({ timeout: 10000 });
    assert.equal(await shaders(page), 0, '揭示完成后释放着色器');
    assert.equal(await page.locator('.iwb-tool[data-tool="rect"]').isDisabled(), false, '揭示完成后标注工具恢复可用');
    assert.equal(await page.locator('.iwb-stage .img-gen-loader').count(), 0, '重绘后加载器卸载');
    await shot(page, 'revealed', width, '.iwb-art img');
    // 实例上限：生产挂载层同时挂 6 个 running 加载器，只有 4 个着色器，另外 2 个静态排队。
    await page.evaluate(() => (window as unknown as { fixture: { cap(n: number): void } }).fixture.cap(6));
    await page.waitForFunction(() => document.querySelectorAll('#cap-test .img-gen-loader .image-gen-shader').length === 4, undefined, { timeout: 15000 }).catch(async e => { throw new Error('6 实例：' + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('#cap-test .img-gen-loader')].map(n => (n as HTMLElement).dataset.mode))) + String(e).slice(0, 60)); });
    await page.waitForTimeout(800);
    const counts = await page.evaluate(() => ({ shader: document.querySelectorAll('#cap-test .image-gen-shader').length, loaders: document.querySelectorAll('#cap-test .img-gen-loader').length, still: document.querySelectorAll('#cap-test .img-gen-loader[data-mode="static"]').length }));
    assert.deepEqual(counts, { shader: 4, loaders: 6, still: 2 });
    await shot(page, 'six-running', width, '#cap-test');
    // 空出名额后补给排队中的实例；舞台上失败回到普通的「未成功」占位。
    await page.evaluate(() => (window as unknown as { fixture: { cap(n: number): void } }).fixture.cap(5));
    await page.waitForFunction(() => document.querySelectorAll('#cap-test .img-gen-loader').length === 5 && document.querySelectorAll('#cap-test .image-gen-shader').length === 4, undefined, { timeout: 15000 });
    await page.evaluate(() => (window as unknown as { fixture: { cap(n: number): void } }).fixture.cap(0));
    await set(page, { a: 'running' });await page.locator('.iwb-stage .img-gen-loader').first().waitFor();
    await set(page, { a: 'failed' });
    // 失败：没有可显示的图时加载器停在最后一帧（不跑着色器），文案写明原因。
    await page.locator('.iwb-stage .img-gen-loader[data-mode="failed"]').waitFor({ timeout: 15000 });
    assert.equal(await shaders(page), 0, '失败释放着色器');
    assert.match(await page.locator(".iwb-stage .img-gen-loader-label").evaluate(el => el.textContent ?? ""), /^生成失败，可重试$/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, '横向溢出');
    results['requests-' + width] = requested.filter(u => u.endsWith('.js')).length;
    await page.close();
  }
  // 减少动态：running 也只显示静态占位，不创建 canvas。
  const reduced = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  reduced.on('pageerror', e => errors.push('reduced:' + e.message));
  await reduced.goto(origin + '/'); await reduced.locator('.iwb-art').first().waitFor();
  await set(reduced, { a: 'running' });
  await reduced.locator('.iwb-stage .img-gen-loader').first().waitFor();
  await reduced.waitForTimeout(1200);
  assert.equal(await reduced.locator('.image-gen-shader').count(), 0, 'reduced-motion 下不跑 WebGL 着色器');
  const still = await reduced.locator('.iwb-stage .img-gen-loader-base').evaluate(el => [(el as HTMLElement).dataset.block, (el as HTMLElement).dataset.target]);
  assert.equal(still[0], still[1], 'reduced-motion 下底图直接停在目标档位，不做过渡动画');
  assert.equal(await reduced.locator('.iwb-stage .img-gen-loader[data-mode="static"]').count(), 1);
  await shot(reduced, 'reduced-motion-static', 1440, '.iwb-gen-loader');
  await set(reduced, { a: 'succeeded' });
  await reduced.locator('.iwb-stage .iwb-art img[src$="/fixture-img/final-a.png"]').waitFor({ timeout: 5000 });
  await shot(reduced, 'reduced-motion-revealed', 1440);
  await reduced.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', ...results, screens }, null, 1));
} finally { await browser.close(); server.close(); }
