// 生图加载态状态机：用假的 img-fx 加载器驱动（不跑真实 WebGL），核对 running 才循环、排队静态、成功揭示、失败静态、降级与名额上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { LoaderMachine, createGpuSlots, sameOriginImages, BRAND_MOSAIC, MAX_MOSAIC, ESTIMATE_CAP, MAX_BLOCK, loaderRunMemorySize, REDUCED_LEVELS, estimateFraction, formatElapsed, type LoaderEnv, type LoaderOptions, type LoaderProgress } from '../../apps/web/src/components/image-generation-loader-core.ts';
import { studioLoaderProgress, studioLoaderFailure } from '../../apps/web/src/features/media/image-studio/loader-progress.ts';

const settle = () => new Promise<void>(r => setImmediate(r));
function env(extra: Partial<LoaderEnv> = {}) {
  let loads = 0, timers: Array<() => void> = [];
  const value: LoaderEnv = { webgl: () => true, reducedMotion: () => false, load: async () => { loads++; return { ImageGeneration: () => null }; }, slots: createGpuSlots(4), origin: () => 'http://app.test',
    setTimer: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimer: () => { timers = []; }, ...extra };
  return { value, get loads() { return loads; }, fireTimers() { const list = timers; timers = []; list.forEach(fn => fn()); } };
}
const opts = (state: LoaderOptions['state'], extra: Partial<LoaderOptions> = {}): LoaderOptions => ({ state, images: ['/workbench/avatar.svg'], width: 1600, height: 900, ...extra });

test('排队与等待执行器：静态占位，不加载 img-fx、不占着色器名额', async () => {
  const e = env(), m = new LoaderMachine(e.value, opts('queued'), () => {});
  await settle();
  assert.equal(m.view().mode, 'static');
  assert.equal(m.view().autoReveal, false);
  assert.equal(e.loads, 0, '排队时不加载库');
  assert.equal(e.value.slots.active(), 0);
  assert.equal(m.view().ratio, 1600 / 900);
  assert.equal(m.view().preset, 'pixels-organic', '默认 preset');
});

test('running：先占名额并动态加载，加载完成后跑着色器；只加载一次（库自带的图片循环不再使用）', async () => {
  const e = env(); let changes = 0;
  const m = new LoaderMachine(e.value, opts('running'), () => changes++);
  assert.equal(m.view().mode, 'loading');
  await settle();
  assert.equal(m.view().mode, 'shader');
  assert.equal(m.view().autoReveal, false, '揭示由底图锐化完成，不用库的自动揭示循环');
  assert.equal(e.loads, 1);
  assert.equal(e.value.slots.active(), 1);
  m.update(opts('running', { label: '正在生成' }));
  await settle();
  assert.equal(e.loads, 1, '轮询更新不重复加载');
  assert.ok(changes >= 1);
  m.dispose();
  assert.equal(e.value.slots.active(), 0, '卸载释放名额');
});

test('成功：真图作为 images 末项触发揭示，揭示完成换成真图并释放名额；兜底超时也会结束', async () => {
  const e = env(), revealed: string[] = [];
  const m = new LoaderMachine(e.value, opts('running'), () => {});
  await settle();
  m.update(opts('succeeded', { images: ['/workbench/avatar.svg', 'blob:http://app.test/final'], onRevealed: () => revealed.push('done') }));
  m.settle();
  const view = m.view();
  assert.equal(view.mode, 'reveal');
  assert.equal(view.finalImage, 'blob:http://app.test/final');
  assert.deepEqual(view.images, ['blob:http://app.test/final'], '揭示池只放真图');
  assert.equal(view.autoReveal, false);
  m.revealDone();
  assert.equal(m.view().mode, 'done');
  assert.deepEqual(revealed, ['done']);
  assert.equal(e.value.slots.active(), 0);
  m.revealDone();
  assert.deepEqual(revealed, ['done'], '只通知一次');

  const e2 = env(), late: string[] = [], m2 = new LoaderMachine(e2.value, opts('running'), () => {});
  await settle();
  m2.update(opts('succeeded', { images: ['/x.png'], onRevealed: () => late.push('timeout') }));
  assert.equal(m2.view().mode, 'reveal');
  e2.fireTimers();
  assert.equal(m2.view().mode, 'done');
  assert.deepEqual(late, ['timeout']);
});

test('排队直接成功（从没跑过着色器）：不放动画，直接视为已揭示', async () => {
  const e = env(), revealed: string[] = [], m = new LoaderMachine(e.value, opts('queued'), () => {});
  m.update(opts('succeeded', { images: ['/final.png'], onRevealed: () => revealed.push('done') }));
  m.settle();
  assert.equal(m.view().mode, 'done');
  assert.deepEqual(revealed, ['done']);
  assert.equal(e.loads, 0);
});

test('失败：回到静态失败态并释放名额', async () => {
  const e = env(), m = new LoaderMachine(e.value, opts('running'), () => {});
  await settle();
  m.update(opts('failed'));
  assert.equal(m.view().mode, 'failed');
  assert.equal(m.view().autoReveal, false);
  assert.equal(e.value.slots.active(), 0);
});

test('降级：无 WebGL、减少动态、动态加载失败、渲染期报错都回到静态，不抛错', async () => {
  for (const extra of [{ webgl: () => false }, { reducedMotion: () => true }] as Partial<LoaderEnv>[]) {
    const e = env(extra), m = new LoaderMachine(e.value, opts('running'), () => {});
    await settle();
    assert.equal(m.view().mode, 'static');
    assert.equal(m.view().degraded, true);
    assert.equal(e.loads, 0);
    assert.equal(e.value.slots.active(), 0);
  }
  const broken = env({ load: () => Promise.reject(new Error('chunk 404')) }), m = new LoaderMachine(broken.value, opts('running'), () => {});
  await settle();
  assert.equal(m.view().mode, 'static');
  assert.equal(broken.value.slots.active(), 0, '加载失败释放名额');
  const e = env(), crashed = new LoaderMachine(e.value, opts('running'), () => {});
  await settle();
  crashed.fail();
  assert.equal(crashed.view().mode, 'static');
  assert.equal(e.value.slots.active(), 0);
});

test('同时最多 4 个着色器：第 5、6 个静态排队，前面的释放后依次补上', async () => {
  const e = env(), list = Array.from({ length: 6 }, () => new LoaderMachine(e.value, opts('running'), () => {}));
  await settle();
  assert.deepEqual(list.map(m => m.view().mode), ['shader', 'shader', 'shader', 'shader', 'static', 'static']);
  list[0]!.update(opts('failed'));
  await settle();
  assert.deepEqual(list.map(m => m.view().mode), ['failed', 'shader', 'shader', 'shader', 'shader', 'static']);
  list[1]!.dispose();
  await settle();
  assert.equal(list[5]!.view().mode, 'shader');
  assert.equal(e.value.slots.active(), 4);
});

test('马赛克素材只收同源：按 URL 解析比较 origin，反斜杠/协议相对/伪 blob/data 都拒绝，没有素材时用品牌图', () => {
  const o = 'http://app.test';
  assert.deepEqual(sameOriginImages(['https://cdn.other.com/a.png', '/workbench/icon.svg', 'blob:http://app.test/1', 'blob:https://evil.test/2', 'http://app.test/b.png', '//cdn.x/a.png', '', null], o), ['http://app.test/workbench/icon.svg', 'blob:http://app.test/1', 'http://app.test/b.png']);
  assert.deepEqual(sameOriginImages(['\\\\evil.com/a.png', '/\\evil.com/a.png', '\\/evil.com/a.png', 'blob:null/1', 'blob:http://evil.test@app.test/1', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'ftp://app.test/a.png', 'HTTP://APP.TEST/ok.png'], o), ['http://app.test/ok.png']);
  const e = env(), m = new LoaderMachine(e.value, opts('queued', { images: ['https://cdn.other.com/a.png', '/\\evil.com/x.png'] }), () => {});
  assert.deepEqual(m.view().images, BRAND_MOSAIC);
});

test('单槽位反复换图：传给库的图片去重且最多 MAX_MOSAIC 张，成功时真图保留在末项', async () => {
  const e = env(), m = new LoaderMachine(e.value, opts('running'), () => {}), seen = new Set<string>();
  await settle();
  for (let i = 0; i < 30; i++) {
    const images = Array.from({ length: i + 1 }, (_, k) => '/img/' + k + '.png').concat('/img/0.png');
    m.update(opts('running', { images }));
    const view = m.view();
    assert.ok(view.images.length <= MAX_MOSAIC, '第 ' + i + ' 次：' + view.images.length);
    assert.equal(new Set(view.images).size, view.images.length, '去重');
    view.images.forEach(u => seen.add(u));
  }
  assert.equal(MAX_MOSAIC, 4);
  m.update(opts('succeeded', { images: [...Array.from({ length: 9 }, (_, k) => '/img/' + k + '.png'), 'blob:http://app.test/final'] }));
  assert.equal(m.view().finalImage, 'blob:http://app.test/final');
  assert.deepEqual(m.view().images, ['blob:http://app.test/final']);
});

test('加载器 chunk 失败：错误边界换成 fallback（进度根降级回球体），不清空', async () => {
  const { FallbackBoundary } = await import('../../apps/web/src/components/fallback-boundary.ts');
  let errors = 0;
  const boundary = new FallbackBoundary({ fallback: 'orb', onError: () => errors++, children: 'loader' });
  assert.equal(boundary.render(), 'loader');
  boundary.state = { ...boundary.state, ...FallbackBoundary.getDerivedStateFromError() };
  boundary.componentDidCatch();
  assert.equal(boundary.render(), 'orb');
  assert.equal(errors, 1);
  const source = (await import('node:fs')).readFileSync(new URL('../../apps/web/src/components/GenerationProgress.tsx', import.meta.url), 'utf8');
  assert.match(source, /<FallbackBoundary fallback=\{<XiaoliuGenerationOrb[^>]*\/>\}><Suspense/, '生图加载器外包错误边界，失败回球体');
});

// ---- 真实进度：mock 渠道依次推送中间图与阶段事件（不触发真实生图） ----
const prog = (extra: Partial<LoaderProgress> = {}): LoaderProgress => ({ stage: 'generating', previews: [], totalMs: 4000, runningMs: 3000, typicalMs: 60000, at: 0, ...extra });

test('有中间图：每张新中间图块尺寸下降一档（单调），底图换成最新中间图；终图到达锐化到 1px 再换成普通图片', async () => {
  let clock = 0; const e = env({ now: () => clock }), revealed: string[] = [];
  const m = new LoaderMachine(e.value, opts('running', { images: [], progress: prog({ stage: 'starting', runningMs: 500 }), seed: '海军蓝背景的流程图' }), () => {});
  await settle();
  const blocks = [m.view().block];
  assert.equal(m.view().base.kind, 'noise', '还没有中间图：提示词色调噪点');
  assert.equal(m.view().readout.estimated, true);
  for (let n = 1; n <= 3; n++) {
    clock += 4000;
    const previews = Array.from({ length: n }, (_, k) => '/api/v1/previews/p' + (k + 1) + '.png');
    m.update(opts('running', { images: [], progress: prog({ previews, runningMs: 3000 * n, at: clock }) }));
    const view = m.view();
    blocks.push(view.block);
    assert.equal(view.base.kind, 'preview');
    assert.equal(view.base.src, 'http://app.test/api/v1/previews/p' + n + '.png', '底图是最新一张中间图');
    assert.equal(view.readout.stage, '正在生成·已出 ' + n + ' 张预览');
    assert.equal(view.readout.estimated, false, '有中间图时不再显示估算百分比');
    assert.doesNotMatch(view.label, /预计|%/);
    clock += 5000; assert.equal(m.view().block, view.block, '两张中间图之间不按时间假装变清晰');
  }
  for (let i = 1; i < blocks.length; i++) assert.ok(blocks[i]! < blocks[i - 1]!, '块尺寸单调下降：' + blocks.join(' → '));
  // 同一张数的重复轮询不降档；张数回退（异常）也不会变粗。
  m.update(opts('running', { images: [], progress: prog({ previews: ['/api/v1/previews/p1.png'], at: clock }) }));
  assert.equal(m.view().block, blocks.at(-1));
  m.update(opts('succeeded', { images: ['blob:http://app.test/final'], progress: prog({ previews: ['/a.png', '/b.png', '/c.png'] }), onRevealed: () => revealed.push('done') }));
  m.settle();
  const final = m.view();
  assert.equal(final.mode, 'reveal');
  assert.equal(final.base.kind, 'final');
  assert.equal(final.base.src, 'blob:http://app.test/final');
  assert.equal(final.block, 1, '终图：收敛到清晰');
  assert.equal(final.animate, true, '从当前块尺寸平滑过渡');
  m.revealDone();
  assert.equal(m.view().mode, 'done');
  assert.deepEqual(revealed, ['done']);
});

test('无中间图：按阶段 + 历史均值估算，封顶不到 100% 并标「预计」；超过均值 2 倍提示比平时慢', async () => {
  let clock = 0; const e = env({ now: () => clock });
  const m = new LoaderMachine(e.value, opts('queued', { images: [], progress: prog({ stage: 'queued', runningMs: null, totalMs: 2000 }) }), () => {});
  assert.equal(m.view().readout.stage, '排队中');
  assert.equal(m.view().readout.estimated, false, '排队时不显示百分比');
  assert.match(m.view().readout.detail, /^已等 2 秒$/);
  const fractions: number[] = [], blocks: number[] = [m.view().block];
  m.update(opts('running', { images: [], progress: prog({ stage: 'starting', runningMs: 0, at: clock }) }));
  await settle();
  assert.equal(m.view().readout.stage, '正在启动');
  for (const t of [5000, 20000, 60000, 90000]) {
    clock = t; m.update(opts('running', { images: [], progress: prog({ stage: 'generating', runningMs: t, totalMs: t + 1000, at: clock }) }));
    const v = m.view(); fractions.push(v.readout.fraction!); blocks.push(v.block);
    assert.equal(v.readout.estimated, true);
    assert.match(v.readout.detail, /^预计 \d+% · 已用 /);
    assert.equal(v.base.kind, 'noise');
  }
  clock = 100000; m.update(opts('running', { images: [], progress: prog({ stage: 'saving', runningMs: 100000, at: clock }) }));
  assert.equal(m.view().readout.stage, '正在保存');
  // 本地时钟往前推（两次轮询之间），估算也随之推进但不越过上限。
  clock = 10_000_000; const late = m.view();
  fractions.push(late.readout.fraction!); blocks.push(late.block);
  for (let i = 1; i < fractions.length; i++) assert.ok(fractions[i]! >= fractions[i - 1]!, '估算进度不倒退：' + fractions.join(','));
  for (let i = 1; i < blocks.length; i++) assert.ok(blocks[i]! <= blocks[i - 1]!, '块尺寸不变粗：' + blocks.join(','));
  assert.ok(Math.max(...fractions) <= ESTIMATE_CAP && ESTIMATE_CAP < 1, '封顶 ' + ESTIMATE_CAP);
  assert.doesNotMatch(late.label, /100%/);
  assert.match(late.label, /预计 (8[5-9]|90)%/, '长时间后停在上限附近');
  assert.equal(late.readout.slow, true, '超过历史均值 2 倍');
  assert.equal(estimateFraction(prog({ runningMs: 59_000 }), 0) < 0.9, true);
  assert.equal(prog().typicalMs * 2 > 3000 && !new LoaderMachine(env().value, opts('running', { progress: prog({ runningMs: 3000 }) }), () => {}).readout(0).slow, true, '没超时不提示');
  assert.equal(formatElapsed(65_000), '1 分 05 秒');
});

test('等待执行器 / 额度：用宿主文案，不显示百分比；没有进度信息时不编造进度', () => {
  const e = env({ now: () => 0 });
  const waiting = new LoaderMachine(e.value, opts('queued', { label: '等待额度', progress: prog({ stage: 'waiting', runningMs: null }) }), () => {});
  assert.equal(waiting.view().readout.stage, '等待额度');
  assert.equal(waiting.view().readout.estimated, false);
  const legacy = new LoaderMachine(e.value, opts('running', { label: '正在生成' }), () => {});
  assert.equal(legacy.view().label, '正在生成', '旧快照没有 progress：只显示阶段');
  assert.equal(legacy.view().readout.fraction, null);
});

test('失败 / 取消：停止动效、块尺寸冻结在最后一档、显示原因', async () => {
  let clock = 0; const e = env({ now: () => clock });
  const m = new LoaderMachine(e.value, opts('running', { images: [], progress: prog({ previews: ['/p1.png', '/p2.png'] }) }), () => {});
  await settle();
  const before = m.view();
  m.update(opts('failed', { images: [], label: '未成功：这张没有生成成功，可以重试', progress: prog({ previews: ['/p1.png', '/p2.png'] }) }));
  clock = 10_000_000;
  const v = m.view();
  assert.equal(v.mode, 'failed');
  assert.equal(v.animate, false, '失败不再做动画');
  assert.equal(v.block, before.block, '停在最后一档');
  assert.equal(v.base.src, before.base.src, '停在最后一帧的底图');
  assert.equal(v.label, '未成功：这张没有生成成功，可以重试');
  assert.equal(v.readout.slow, false);
  assert.equal(e.value.slots.active(), 0, '释放着色器名额');
});

test('减少动态效果：不跑着色器、不做动画，只按进度切换清晰度档位', async () => {
  let clock = 0; const e = env({ reducedMotion: () => true, now: () => clock });
  const m = new LoaderMachine(e.value, opts('running', { images: [], progress: prog({ runningMs: 0, at: 0 }) }), () => {});
  await settle();
  const seen = new Set<number>();
  for (const t of [0, 10000, 30000, 60000, 120000, 400000]) { clock = t; const v = m.view(); assert.equal(v.mode, 'static'); assert.equal(v.animate, false); assert.ok(REDUCED_LEVELS.includes(v.block), '档位 ' + v.block); seen.add(v.block); }
  assert.ok(seen.size >= 3, '随进度切换多个档位：' + [...seen].join(','));
  assert.equal(e.loads, 0);
  assert.ok(Math.max(...seen) <= MAX_BLOCK);
});

test('配图版本 → 加载器进度：阶段/中间图/耗时来自快照；等待执行器映射为 waiting；失败文案带原因', () => {
  const base = { id: 'v2', description: '海军蓝背景的流程图', state: 'running', error: null, parent_version_id: null, reference_assets: [], progress: { stage: 'generating' as const, total_ms: 9000, running_ms: 7000, typical_ms: 80000, typical_source: 'history' as const, typical_samples: 3, previews: ['/x.png'], received_at: 123 } };
  assert.deepEqual(studioLoaderProgress(base as never), { runKey: 'v2', seed: '海军蓝背景的流程图', progress: { stage: 'generating', previews: ['/x.png'], totalMs: 9000, runningMs: 7000, typicalMs: 80000, at: 123 } });
  assert.equal(studioLoaderProgress({ ...base, state: 'waiting_input' } as never).progress?.stage, 'waiting');
  assert.deepEqual(studioLoaderProgress({ ...base, progress: undefined } as never), { runKey: 'v2', seed: '海军蓝背景的流程图' });
  assert.equal(studioLoaderFailure({ ...base, state: 'failed', error: 'RESULT_UNKNOWN: AGY CLI' } as never), '生成失败，可重试', '不暴露状态码或渠道报错');
  assert.equal(studioLoaderFailure({ ...base, state: 'cancelled' } as never), '已取消，结果待核对', '契约把取消视为结果未知、不能再提交');
  assert.equal(studioLoaderFailure({ ...base, state: 'unknown' } as never), '生成结果待核对');
});

test('历史均值变化（轮询）时估算进度只增不减；新一轮生成才清零', async () => {
  let clock = 0; const e = env({ now: () => clock });
  const m = new LoaderMachine(e.value, opts('running', { images: [], progress: prog({ runningMs: 50000, typicalMs: 40000 }) }), () => {});
  await settle();
  const high = m.view().readout.fraction!;
  assert.ok(high > 0.75, String(high));
  m.update(opts('running', { images: [], progress: prog({ runningMs: 51000, typicalMs: 120000, at: clock }) }));
  const after = m.view();
  assert.ok(after.readout.fraction! >= high, '均值变大不倒退：' + high + ' → ' + after.readout.fraction);
  assert.match(after.label, new RegExp('预计 ' + Math.floor(high * 100) + '%'));
  m.update(opts('failed', { images: [] }));
  m.update(opts('running', { images: [], progress: prog({ runningMs: 1000, typicalMs: 120000 }) }));
  assert.ok(m.view().readout.fraction! < 0.2, '重试从头算');
});

test('超过历史均值未到 2 倍：说明快好了；超过 2 倍：比平时慢', () => {
  const e = env({ now: () => 0 }), at = (ms: number) => new LoaderMachine(e.value, opts('running', { progress: prog({ runningMs: ms, typicalMs: 40000 }) }), () => {}).readout(0);
  assert.equal(at(30000).note, null);
  assert.equal(at(50000).note, 'finishing');
  assert.equal(at(50000).slow, false);
  assert.equal(at(90000).note, 'slow');
  assert.equal(at(90000).slow, true);
});

test('结果待核对（reconciling）：停止估算，冻结块尺寸，文案为生成结果待核对', async () => {
  let clock = 0; const e = env({ now: () => clock });
  const m = new LoaderMachine(e.value, opts('running', { images: [], progress: prog({ runningMs: 30000 }) }), () => {});
  await settle();
  const before = m.view().block;
  m.update(opts('queued', { images: [], progress: prog({ stage: 'checking', runningMs: 30000 }) }));
  clock = 10_000_000;
  const v = m.view();
  assert.equal(v.readout.stage, '生成结果待核对');
  assert.equal(v.readout.estimated, false);
  assert.doesNotMatch(v.label, /预计|%|生成中/);
  assert.equal(v.block, before, '不再随时间变清晰');
  const shell = studioLoaderProgress({ id: 'v', description: '', state: 'reconciling', reference_assets: [], parent_version_id: null } as never);
  assert.equal(shell.progress?.stage, 'checking', '旧快照没有 progress 的 reconciling 也不估算');
});

test('修改 / 参考修改：底图用父版本真实图片，文案写正在基于第 N 版修改；全新生成才用噪点', async () => {
  const v1 = { id: 'v1', asset_id: 'a1', reference_assets: [], parent_version_id: null, description: 'x', state: 'succeeded' };
  const edit = { id: 'v2', asset_id: '', reference_assets: [], parent_version_id: 'v1', description: '改成竖图', state: 'running', progress: { stage: 'generating', total_ms: 1, running_ms: 1, typical_ms: 60000, typical_source: 'default', typical_samples: 0, previews: [], received_at: 0 } };
  const url = (v: { asset_id: string }) => v.asset_id ? '/fixture-img/' + v.asset_id + '.png' : undefined;
  const mapped = studioLoaderProgress(edit as never, [v1, edit] as never, url as never);
  assert.equal(mapped.parentImage, '/fixture-img/a1.png');
  assert.equal(mapped.parentLabel, '正在基于第 1 版修改');
  const byRef = studioLoaderProgress({ ...edit, parent_version_id: null, reference_assets: [{ asset_id: 'a1' }] } as never, [v1, edit] as never, url as never);
  assert.equal(byRef.parentImage, '/fixture-img/a1.png', '参考图对应已保存版本');
  assert.equal(studioLoaderProgress({ ...edit, parent_version_id: null } as never, [v1, edit] as never, url as never).parentImage, undefined, '全新生成没有原图');
  const e = env({ now: () => 0 }), m = new LoaderMachine(e.value, opts('running', { images: [], ...mapped }), () => {});
  await settle();
  const v = m.view();
  assert.equal(v.base.kind, 'parent');
  assert.equal(v.base.src, 'http://app.test/fixture-img/a1.png');
  assert.match(v.readout.stage, /^正在基于第 1 版修改$/);
  m.update(opts('running', { images: [], ...mapped, progress: { ...mapped.progress!, previews: ['/p1.png'] } }));
  assert.equal(m.view().base.kind, 'preview', '有中间图时换成中间图');
  assert.equal(m.view().readout.stage, '正在基于第 1 版修改·已出 1 张预览');
  const cross = new LoaderMachine(e.value, opts('running', { images: [], parentImage: 'https://cdn.other.com/a.png' }), () => {});
  assert.equal(cross.view().base.kind, 'noise', '跨域原图不进 canvas，回到噪点');
});

test('切图 / 重新挂载：进度按任务保存在模块级，不倒退；任务到终态后清理', async () => {
  let clock = 0; const e = env({ now: () => clock });
  const a = new LoaderMachine(e.value, opts('running', { images: [], runKey: 'run-1', progress: prog({ runningMs: 50000, typicalMs: 40000 }) }), () => {});
  await settle();
  const high = a.view().readout.fraction!, block = a.view().block;
  a.dispose();
  const size = loaderRunMemorySize();
  assert.ok(size >= 1);
  // 重新挂载时轮询给出的均值变大：仍从已显示的进度继续。
  const b = new LoaderMachine(e.value, opts('running', { images: [], runKey: 'run-1', progress: prog({ runningMs: 51000, typicalMs: 200000 }) }), () => {});
  await settle();
  assert.ok(b.view().readout.fraction! >= high, '重挂载不倒退：' + high + ' → ' + b.view().readout.fraction);
  assert.ok(b.view().block <= block, '块尺寸也不变粗');
  // 另一个任务各算各的。
  const other = new LoaderMachine(e.value, opts('running', { images: [], runKey: 'run-2', progress: prog({ runningMs: 1000, typicalMs: 200000 }) }), () => {});
  assert.ok(other.view().readout.fraction! < 0.2);
  b.update(opts('failed', { images: [], runKey: 'run-1' })); b.view();
  other.update(opts('queued', { images: [], runKey: 'run-2', progress: prog({ stage: 'checking' }) })); other.view();
  assert.equal(loaderRunMemorySize(), size - 1, '终态（失败 / 待核对）后清理条目');
  const c = new LoaderMachine(e.value, opts('running', { images: [], runKey: 'run-1', progress: prog({ runningMs: 1000, typicalMs: 200000 }) }), () => {});
  assert.ok(c.view().readout.fraction! < 0.2, '清理后同 key 重新开始');
  c.update(opts('succeeded', { images: ['/x.png'], runKey: 'run-1' })); c.view();
  assert.equal(loaderRunMemorySize(), size - 1);
});
