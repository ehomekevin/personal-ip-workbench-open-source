// 写作面板等待态：复用 GenerationProgress 球体，由真实 job 状态驱动；内部信息收进默认收起的详情；执行器额度不可用时用用户语言并可一键改用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, stop } from 'esbuild';
import { DEFAULT_WRITING_EXECUTION } from '../../packages/contracts/src/index.ts';
import type { DialogView, FeatureContext, GenerationProgressView } from '../../apps/web/src/transport/feature-ports.ts';
import { WritingFlowController } from '../../apps/web/src/features/create/writing-flow/index.ts';
import { writingProgress } from '../../apps/web/src/features/create/writing-flow/progress.ts';
import { executorChoices } from '../../apps/web/src/components/executors.ts';
import { progressTiming, STALE_OUTPUT_MESSAGE } from '../../apps/web/src/components/generation-progress-timing.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function renderProgress(view: GenerationProgressView): Promise<string> {
  const out = await build({ stdin: { contents: "import {renderToStaticMarkup} from 'react-dom/server';import {createElement} from 'react';import {GenerationProgress} from './apps/web/src/components/GenerationProgress.tsx';export const render=view=>renderToStaticMarkup(createElement(GenerationProgress,{view}));", resolveDir: root, loader: 'tsx' }, bundle: true, format: 'cjs', platform: 'node', write: false, jsx: 'automatic', logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' } });
  await stop(); const dir = mkdtempSync(join(tmpdir(), 'writing-progress-')), file = join(dir, 'render.cjs');
  try { writeFileSync(file, out.outputFiles[0]!.text); return (createRequire(import.meta.url)(file) as { render(view: GenerationProgressView): string }).render(view); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const settings = (codex: [string, string], claude: [string, string]) => ({ executors: [{ executor_id: 'codex', status: codex[0], auth_state: codex[1] }, { executor_id: 'claude', status: claude[0], auth_state: claude[1] }] });
const quotaCodex = settings(['unverified', 'QUOTA_EXHAUSTED'], ['supported', 'subscription_authenticated']);
function run(state: string, extra: Record<string, unknown> = {}): any {
  return { schema_version: 'writing-flow/1', id: 'run-1', version: 1, topic_id: 'topic', document_id: 'core', input_revision_id: 'base', input_text_sha256: 'hash', instruction: '冻结的完整稿要求', executor: 'codex', execution_policy: DEFAULT_WRITING_EXECUTION, source_ids: ['s1'], rule_snapshot: { id: 'rules', created_at: 'now', files: [], skill: { name: 'personal-ip-writing', version: '0.1.0', sha256: 'h', content: 'r' }, scope: '本人' }, viewpoints: { topic_id: 'topic', document_id: 'vp', revision_id: 'vp-r1', text: '观点', text_sha256: 'h' }, skill_bindings: { writing_skills: [] }, export_target: null, created_at: 'now', parent_run_id: null, phase: state === 'running' || state === 'queued' ? 'writing' : 'needs_attention', stages: [{ stage: 'writing', job_id: 'job-1', document_id: 'core', input_revision_id: 'base' }], decisions: [], adopted_revision_id: null, exports: [], candidate: null, review: null, input_draft: '', core_head: 'base',
    current_job: { id: 'job-1', state, version: 4, error: state === 'waiting_quota' ? { code: 'QUOTA_EXHAUSTED', message: 'Codex included usage 当前不可用' } : null, created_at: '2026-10-14T00:00:00.000Z', started_at: '2026-10-14T00:00:05.000Z', last_output_at: '2026-10-14T00:00:20.000Z', checkpoint: { agent_handle: { checkpoint: { writing_skills: [{ name: 'personal-ip-writing', version: '0.1.0', invocation: 'codex_native_skill_input' }] } } } }, ...extra };
}
function fixture(reader: (method: string, url: string, body: unknown) => unknown) {
  const dialogs: DialogView[] = [], calls: { method: string; url: string; body: unknown }[] = [], cancels: { id: string; version: number; key: string }[] = [];
  const panel = { set outerHTML(_v: string) {} }, root = { querySelector: (selector: string) => selector === '.writing-flow-panel' ? panel : null } as unknown as HTMLElement;
  const context = { ui: { page: 'create', topic: 'topic' }, signal: new AbortController().signal, skillSelection: () => ({ mode: 'recipe', recipe_id: 'r1' }),
    client: { request: async (method: string, url: string, body: unknown) => { calls.push({ method, url, body }); return reader(method, url, body); }, cancelJob: async (id: string, version: number, options: { idempotencyKey: string }) => { cancels.push({ id, version, key: options.idempotencyKey }); return {}; } },
    drafts: { leave: async () => {} }, surface: { presentDialog: (dialog: DialogView) => dialogs.push(dialog), closeDialog: () => {}, dialogBusy: () => {}, toast: () => {}, navigate: () => {} } } as unknown as FeatureContext;
  globalThis.CSS ??= { escape: (value: string) => value } as unknown as typeof CSS;
  const controller = new WritingFlowController({ root, context: () => context, render: () => {}, active: () => true }), internal = controller as any;
  internal.topicId = 'topic';
  return { controller, internal, dialogs, calls, cancels };
}

test('running 显示动效球体、阶段标签与真实时间；主路径不露运行编号、模型与时限，详情默认收起', async () => {
  const f = fixture(() => ({ items: [], targets: [] }));
  try {
    f.internal.showRun(run('running'));
    const dialog = f.dialogs.at(-1)!, view = dialog.generationProgress!;
    assert.equal(view.state, 'running'); assert.equal(view.label, '写作中'); assert.equal(dialog.progressKey, 'writing-job:job-1');
    assert.deepEqual(view.timing, { since: '2026-10-14T00:00:05.000Z', last_output_at: '2026-10-14T00:00:20.000Z' });
    assert.match(dialog.body, /class="generation-progress-host"/);
    for (const internal of ['run-1', 'gpt-6.1-sol', '最长 15 分钟', 'personal-ip-writing · v0.1.0']) assert(!dialog.body.includes(internal), internal + ' 不在主路径');
    assert(view.details!.some(d => d.value === 'run-1') && view.details!.some(d => d.value.includes('gpt-6.1-sol')) && view.details!.some(d => d.value === 'personal-ip-writing · v0.1.0'));
    const dom = await renderProgress(view);
    assert.match(dom, /data-motion="animated"/); assert.match(dom, /<canvas class="generation-orb-canvas"/);
    assert.match(dom, /<details class="generation-progress-details"><summary>详情<\/summary>/); assert(!/<details[^>]*\sopen/.test(dom), '详情默认收起');
    assert.match(dom, /<span class="generation-progress-state">写作中<\/span>/); assert.match(dom, /已用时 (\d+:)?\d\d:\d\d/);
    const queued = await renderProgress(writingProgress(run('queued'))!.view);
    assert.match(queued, /data-motion="static"/); assert.match(queued, /排队中/); assert(!queued.includes('已用时'));
  } finally { f.controller.dispose(); }
});

test('超过 90 秒无新输出时提示可继续等待或取消；没有输出时按开始时间计算', () => {
  const timing = { since: '2026-10-14T00:00:00.000Z', last_output_at: '2026-10-14T00:01:00.000Z' }, at = (s: number) => Date.parse('2026-10-14T00:00:00.000Z') + s * 1000;
  assert.deepEqual(progressTiming(timing, at(100)), { elapsed: '已用时 01:40', output: '最近一次有输出 40 秒前', stale: false });
  assert.equal(progressTiming(timing, at(150)).stale, true);
  assert.equal(progressTiming({ since: timing.since, last_output_at: null }, at(89)).stale, false);
  assert.equal(progressTiming({ since: timing.since, last_output_at: null }, at(90)).output, '已开始，暂未收到输出');
  assert.equal(progressTiming({ since: timing.since, last_output_at: null }, at(90)).stale, true);
  assert.equal(STALE_OUTPUT_MESSAGE, '执行器较长时间无输出，可继续等待或取消');
});

test('waiting_quota 用用户语言并在另一执行器可用时显示改用按钮；不可用时不显示', async () => {
  const quota = writingProgress(run('waiting_quota'), executorChoices(quotaCodex as never))!;
  assert.equal(quota.view.state, 'waiting'); assert.equal(quota.view.message, 'Codex 额度暂不可用，可改用 Claude 或稍后恢复'); assert.equal(quota.switchTo, 'claude');
  assert(quota.view.details!.some(d => d.value === 'Codex included usage 当前不可用'), '原始信息只在详情');
  const blocked = writingProgress(run('waiting_quota'), executorChoices(settings(['unverified', 'QUOTA_EXHAUSTED'], ['unconfigured', 'AUTH_REQUIRED']) as never))!;
  assert.equal(blocked.switchTo, undefined); assert.equal(blocked.view.message, 'Codex 额度暂不可用，可稍后恢复');
  const login = writingProgress(run('waiting_input', { executor: 'claude' }), executorChoices(settings(['supported', 'subscription_authenticated'], ['unconfigured', 'AUTH_REQUIRED']) as never))!;
  assert.equal(login.view.message, 'Claude 需要登录，可改用 Codex，或在设置与连接登录后恢复'); assert.equal(login.switchTo, 'codex');
  const review = writingProgress(run('waiting_quota', { stages: [{ stage: 'writing', job_id: 'w' }, { stage: 'review', job_id: 'job-1' }] }), executorChoices(quotaCodex as never))!;
  assert.equal(review.switchTo, undefined, '审读阶段不整轮重跑');
  const dom = await renderProgress(quota.view); assert.match(dom, /data-motion="static"/); assert.match(dom, /等待执行器/); assert(!dom.includes('已用时'));

  const f = fixture((_m, url) => url === '/api/v1/settings' ? quotaCodex : { items: [], targets: [] });
  try {
    f.internal.showRun(run('waiting_quota')); await new Promise(r => setImmediate(r));
    const dialog = f.dialogs.at(-1)!;
    assert.match(dialog.foot!, /data-action="wf-switch"[^>]*data-executor="claude"[^>]*>改用 Claude 重跑/);
    assert(!dialog.body.includes('included usage'), '主路径不露执行器内部文案');
    assert.equal(dialog.generationProgress!.message, 'Codex 额度暂不可用，可改用 Claude 或稍后恢复');
  } finally { f.controller.dispose(); }
});

test('改用 Claude 重跑走服务端接口（执行器 + 运行版本 + 幂等键）；待完成重跑在刷新后仍显示“重试”，沿用服务端保存的幂等键', async () => {
  const created = run('queued', { id: 'run-2', executor: 'claude', parent_run_id: 'run-1' });
  const f = fixture((method, url) => url === '/api/v1/settings' ? quotaCodex : method === 'POST' ? created : url.includes('?summary=1') ? { items: [], targets: [] } : created);
  try {
    f.internal.showRun(run('waiting_quota')); await new Promise(r => setImmediate(r));
    await f.internal.dispatch('wf-switch', { dataset: { run: 'run-1', executor: 'claude' } });
    const post = f.calls.find(c => c.method === 'POST')!;
    assert.equal(post.url, '/api/v1/writing-runs/run-1/switch-executor'); assert.deepEqual(post.body, { executor: 'claude', expected_version: 1 });
    assert.equal(f.cancels.length, 0, '取消由服务端在同一流程内完成'); assert.equal(f.dialogs.at(-1)!.generationProgress!.state, 'queued');
  } finally { f.controller.dispose(); }
  const pending = run('cancelled', { switch_pending: { executor: 'claude', idempotency_key: 'server-kept-key', requested_at: 'now' } });
  const g = fixture((method, url) => url === '/api/v1/settings' ? quotaCodex : method === 'POST' ? created : url.includes('?summary=1') ? { items: [], targets: [] } : created), keys: string[] = [];
  const request = (g as any).internal.options.context().client.request; (g as any).internal.options.context().client.request = async (m: string, u: string, b: unknown, o?: { idempotencyKey?: string }) => { if (m === 'POST') keys.push(o!.idempotencyKey!); return request(m, u, b, o); };
  try {
    g.internal.showRun(pending); const dialog = g.dialogs.at(-1)!;
    assert.match(dialog.foot!, /data-action="wf-switch"[^>]*data-executor="claude"[^>]*>重试改用 Claude 重跑/); assert.equal(dialog.generationProgress!.label, '待重跑');
    await g.internal.dispatch('wf-switch', { dataset: { run: 'run-1', executor: 'claude' } }); assert.deepEqual(keys, ['server-kept-key']);
  } finally { g.controller.dispose(); }
  const h = fixture((_m, url) => url === '/api/v1/settings' ? settings(['unverified', 'QUOTA_EXHAUSTED'], ['unconfigured', 'AUTH_REQUIRED']) : { items: [], targets: [] });
  try { h.internal.showRun(run('waiting_quota')); await new Promise(r => setImmediate(r)); await assert.rejects(h.internal.dispatch('wf-switch', { dataset: { run: 'run-1', executor: 'claude' } }), /不可用/); assert.equal(h.calls.filter(c => c.method === 'POST').length, 0); } finally { h.controller.dispose(); }
});

test('生产现状：两执行器都未经真实验收、Codex 额度不足、Claude 订阅已认证 → Claude 可选且显示改用按钮', () => {
  const production = settings(['unverified', 'QUOTA_EXHAUSTED'], ['unverified', 'subscription_authenticated']), choices = executorChoices(production as never);
  assert.deepEqual(choices.map(c => [c.id, c.blocked, c.usable, c.status]), [['codex', true, false, '额度暂不可用'], ['claude', false, true, '可用 · 未经真实验收']]);
  assert.equal(writingProgress(run('waiting_quota'), choices)!.switchTo, 'claude');
  assert.equal(executorChoices(settings(['unverified', 'not_checked'], ['unverified', 'not_checked']) as never)[1]!.usable, false, '未检查不当作可用，但也不禁用');
  assert.equal(executorChoices(settings(['unverified', 'not_checked'], ['unverified', 'not_checked']) as never)[1]!.blocked, false);
});

test('自动换尝试后同步任务版本与开始时间：取消用新版本，90 秒判断按新尝试；普通失败主路径用用户文案，等待态不提不存在的取消按钮', async () => {
  const detail = run('running'), f = fixture((_m, url) => url.includes('?summary=1') ? { items: [{ id: 'run-1', version: 1, topic_id: 'topic', phase: 'writing', skill: 's', exports: [], current_job: { ...detail.current_job, version: 9, started_at: '2026-10-14T00:05:00.000Z', last_output_at: null } }], targets: [] } : detail);
  try {
    f.internal.showRun(detail); await f.internal.load();
    assert.equal(f.internal.detail.current_job.version, 9); assert.equal(f.dialogs.at(-1)!.generationProgress!.timing!.since, '2026-10-14T00:05:00.000Z'); assert.equal(f.dialogs.at(-1)!.generationProgress!.timing!.last_output_at, null);
    f.internal.showRun(run('failed', { current_job: { ...detail.current_job, state: 'failed', error: { code: 'PROVIDER_ERROR', message: 'stderr: raw provider trace' } } }));
    const failed = f.dialogs.at(-1)!; assert.match(failed.body, /role="alert" class="note">这次生成没有完成，可以重试；原稿已保留/); assert(!/role="alert"[^<]*raw provider trace/.test(failed.body));
    assert.match(failed.body, /<details class="writing-flow-diagnostics"><summary>详情<\/summary>[\s\S]*任务状态 · 未完成[\s\S]*原始信息 · stderr: raw provider trace/);
    f.internal.showRun(run('waiting_quota')); assert(!f.dialogs.at(-1)!.body.includes('取消请使用'), '等待态没有取消按钮时不提它');
    f.internal.showRun(run('running')); assert(f.dialogs.at(-1)!.body.includes('取消请使用'));
  } finally { f.controller.dispose(); }
});

test('平台版本面板：skill 链从主路径移到默认收起的详情；排队态静态、运行态动效', async () => {
  const { waitForegroundGeneration } = await import('../../apps/web/src/features/create/ai-actions/index.ts');
  const states = ['queued', 'running', 'succeeded'] as const, dialogs: DialogView[] = []; let reads = 0, active = false;
  const checkpoint = { agent_handle: { checkpoint: { writing_skills: [{ name: 'workbench-platform-adapt', version: '1.0.0', invocation: 'codex_native_skill_input' }, { name: 'personal-ip-writing', version: '0.1.0', invocation: 'codex_native_skill_input' }] } } };
  const context = { signal: new AbortController().signal, client: { request: async (_m: string, url: string) => url.startsWith('/api/v1/jobs?') ? { items: [] } : { job: { state: states[Math.min(reads, 2)], version: ++reads, created_at: 'now' }, checkpoint } },
    surface: { presentDialog(dialog: DialogView) { dialogs.push(dialog); active = true; }, isForegroundJobActive: () => active, closeDialog() { active = false; } } } as unknown as FeatureContext;
  await waitForegroundGeneration(context, { job_id: 'job-p' }, '制作平台版本 · 公众号 (1/2)', () => true, true);
  const running = dialogs.find(d => d.generationProgress?.state === 'running')!.generationProgress!;
  assert(!running.note.includes('本次执行') && !running.note.includes('workbench-platform-adapt'));
  assert.deepEqual(running.details, [{ label: '本次执行', value: 'workbench-platform-adapt · v1.0.0 → personal-ip-writing · v0.1.0' }]);
  const dom = await renderProgress(running); assert.match(dom, /data-motion="animated"/); assert.match(dom, /<details class="generation-progress-details"><summary>详情<\/summary>/); assert(!/<details[^>]*\sopen/.test(dom));
  assert.match(await renderProgress(dialogs[0]!.generationProgress!), /data-motion="static"/);
});

test('平台版本面板失败/等待态 DOM：主路径是用户文案，原始报错在默认收起的详情', async () => {
  const { waitForegroundGeneration } = await import('../../apps/web/src/features/create/ai-actions/index.ts');
  const dialogs: DialogView[] = []; let active = false;
  const context = { signal: new AbortController().signal, client: { request: async () => ({ job: { state: 'waiting_quota', version: 3, executor_id: 'codex' }, error: { code: 'QUOTA_EXHAUSTED', message: 'Codex included usage 当前不可用' } }) },
    surface: { presentDialog(d: DialogView) { dialogs.push(d); active = true; }, isForegroundJobActive: () => active, closeDialog() { active = false; }, toast() { throw new Error('不应 toast 原文'); } } } as unknown as FeatureContext;
  await waitForegroundGeneration(context, { job_id: 'job-q' }, '制作平台版本 · 公众号 (1/2)');
  const dom = await renderProgress(dialogs.at(-1)!.generationProgress!), status = /<div role="status"[^>]*>([\s\S]*?)<\/div>/.exec(dom)![1]!;
  assert.match(status, /等待执行器[\s\S]*Codex 额度暂不可用，可稍后恢复/); assert(!status.includes('included usage'));
  assert.match(dom, /<details class="generation-progress-details"><summary>详情<\/summary>[\s\S]*Codex included usage 当前不可用/); assert(!/<details[^>]*\sopen/.test(dom)); assert.match(dom, /data-motion="static"/);
});

test('待完成重跑：重试前刷新执行器就绪，目标不可用不发请求；原输入已变化时显示“请新开完整稿流程”且没有重试按钮', async () => {
  let claude = ['supported', 'subscription_authenticated'];
  const f = fixture((_m, url) => url === '/api/v1/settings' ? settings(['unverified', 'QUOTA_EXHAUSTED'], claude as [string, string]) : { items: [], targets: [] });
  try {
    f.internal.showRun(run('cancelled', { switch_pending: { executor: 'claude', idempotency_key: 'kept', requested_at: 'now' } })); await new Promise(r => setImmediate(r));
    claude = ['unverified', 'QUOTA_EXHAUSTED'];
    await assert.rejects(f.internal.dispatch('wf-switch', { dataset: { run: 'run-1', executor: 'claude' } }), /Claude 当前不可用/);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 0); assert(f.calls.filter(c => c.url === '/api/v1/settings').length >= 2, '点击时重新读取就绪状态');
    f.internal.showRun(run('cancelled', { switch_abandoned: { executor: 'claude', reason: 'input_changed', at: 'now' } }));
    const dialog = f.dialogs.at(-1)!; assert.equal(dialog.generationProgress!.message, '原输入已变化，请新开完整稿流程'); assert.doesNotMatch(dialog.foot!, /wf-switch/);
  } finally { f.controller.dispose(); }
});
