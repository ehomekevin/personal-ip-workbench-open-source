import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lazyModule, LazyController } from '../../apps/web/src/app/lazy-features.ts';

const source = (path: string) => readFileSync(new URL('../../apps/web/src/' + path, import.meta.url), 'utf8');
const staticImports = (text: string) => [...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map(match => match[1]!);

test('首屏入口不静态引用按需加载的大功能（配图工作台、语音输入、设置子页、账号研究）', () => {
  const lazy = ['features/media/image-studio/index.ts', 'features/speech-input/index.ts', 'features/settings/skills.ts', 'features/settings/publishing.ts', 'features/settings/configuration.ts', 'features/sources/accounts-manual/index.ts'];
  for (const [file, text] of [['app/real-controller.ts', source('app/real-controller.ts')], ['features/sources/read/index.ts', source('features/sources/read/index.ts')], ['transport/data-features.ts', source('transport/data-features.ts')]] as const)
    for (const target of staticImports(text)) assert.ok(!lazy.some(path => target.endsWith(path.split('/').slice(-2).join('/'))), file + ' 静态引用了按需模块 ' + target);
  const shims = source('app/lazy-features.ts');
  for (const path of lazy.slice(0, 5)) assert.ok(shims.includes("import('../" + path + "')"), '按需模块缺少动态加载入口 ' + path);
  assert.ok(source('features/sources/accounts-manual/lazy.ts').includes("import('./index.ts')"));
});

test('按需模块：成功后同步可用且只加载一次；失败不缓存，下次重新加载', async () => {
  let calls = 0, fail = true;
  const module = lazyModule(async () => { calls++; if (fail) throw new Error('chunk 404'); return { ok: true }; });
  assert.equal(module.value, undefined);
  await assert.rejects(module.load(), /chunk 404/); assert.equal(module.value, undefined);
  fail = false; const [a, b] = await Promise.all([module.load(), module.load()]);
  assert.equal(a, b); assert.deepEqual(module.value, { ok: true }); assert.equal(calls, 2);
  await module.load(); assert.equal(calls, 2);
});

test('慢加载期间排队的点击：关闭/离开页面后作废，元素已移除也不执行；未作废时照常交给原控制器', async () => {
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  const handled: string[] = [];
  class Fake { handleClick(el: { id: string }) { handled.push(el.id); } }
  const module = lazyModule(async () => { await gate; return { Fake }; });
  class Proxy extends LazyController<{ Fake: typeof Fake }, Fake, { signal: AbortSignal; toast(message: string): void }> {
    constructor(signal: AbortSignal) { super({ signal, toast() {} }, module, loaded => new loaded.Fake()); }
    handleClick(el: { id: string; isConnected: boolean; dataset: { action?: string } }) { return this.inner ? (this.inner.handleClick(el), true) : this.deferClick(el as never, !!el.dataset.action?.startsWith('speech-'), inner => inner.handleClick(el)); }
    close() { this.cancelQueued(); }
  }
  const signal = new AbortController().signal, proxy = new Proxy(signal);
  const button = (id: string, isConnected = true) => ({ id, isConnected, dataset: { action: 'speech-open' } });
  assert.equal(proxy.handleClick({ id: 'other', isConnected: true, dataset: { action: 'skills-x' } }), false);
  assert.equal(proxy.handleClick(button('left-page')), true); proxy.close();
  const detached = button('detached'); assert.equal(proxy.handleClick(detached), true); detached.isConnected = false;
  assert.equal(proxy.handleClick(button('kept')), true);
  release(); await module.load(); await new Promise(done => setTimeout(done, 0));
  assert.deepEqual(handled, ['kept']);
  proxy.handleClick(button('loaded')); assert.deepEqual(handled, ['kept', 'loaded']);
});
