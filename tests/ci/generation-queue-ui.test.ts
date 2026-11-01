// F3：勾选的平台一次并行提交；超过服务并发上限的任务在进度里显示"排队中（前面还有 N 个）"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, stop } from 'esbuild';
import type { JobDetailResponse, JobsRow } from '../../packages/contracts/src/index.ts';
import type { DialogView, FeatureContext, GenerationProgressView } from '../../apps/web/src/transport/feature-ports.ts';
import type { WorkbenchClient } from '../../apps/web/src/transport/workbench-client.ts';
import { waitForegroundGeneration } from '../../apps/web/src/features/create/ai-actions/index.ts';
import { createContentDocumentsFeaturePort } from '../../apps/web/src/features/create/documents/index.ts';
import { DraftRegistry } from '../../apps/web/src/transport/drafts.ts';
import { initialUi } from '../../apps/web/src/app/view-model.ts';
import { emptyIngestView } from '../../apps/web/src/features/sources/read/index.ts';
import { fixture } from '../content-workflows/harness.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
// 用真实 GenerationProgress 组件做静态 DOM 渲染，核对排队态展示与运行态区分。
async function renderProgress(view: GenerationProgressView): Promise<string> {
  const out = await build({ stdin: { contents: "import {renderToStaticMarkup} from 'react-dom/server';import {createElement} from 'react';import {GenerationProgress} from './apps/web/src/components/GenerationProgress.tsx';export const render=view=>renderToStaticMarkup(createElement(GenerationProgress,{view}));", resolveDir: root, loader: 'tsx' }, bundle: true, format: 'cjs', platform: 'node', write: false, jsx: 'automatic', logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' } });
  await stop(); const dir = mkdtempSync(join(tmpdir(), 'generation-progress-')), file = join(dir, 'render.cjs');
  try { writeFileSync(file, out.outputFiles[0]!.text); return (createRequire(import.meta.url)(file) as { render(view: GenerationProgressView): string }).render(view); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const row = (id: string, created_at: string, extra: Partial<JobsRow> = {}) => ({ id, created_at, state: 'queued', execution_mode: 'service_adapter', cancel_requested_at: null, ...extra } as JobsRow);

test('F3-c 超过并发上限的排队任务显示"排队中（前面还有 N 个）"，与运行中区分', { timeout: 30_000 }, async () => {
  const mine = row('job-c', '2026-10-14T00:00:03.000Z'), states = ['queued', 'running', 'succeeded'] as const, dialogs: DialogView[] = [], lists: string[] = [];
  let reads = 0, active = false;
  const queue = [row('job-a', '2026-10-14T00:00:01.000Z'), row('job-b', '2026-10-14T00:00:02.000Z'), row('job-p', '2026-10-14T00:00:01.500Z', { execution_mode: 'programmatic' }), row('job-x', '2026-10-14T00:00:01.700Z', { cancel_requested_at: '2026-10-14T00:00:04.000Z' }), mine, row('job-d', '2026-10-14T00:00:04.000Z')];
  const context = { signal: new AbortController().signal,
    client: { request: async (_method: string, url: string) => { if (url.startsWith('/api/v1/jobs?')) { lists.push(url); return { items: queue }; } const state = states[Math.min(reads, 2)]!; reads++; return { job: { ...mine, state, version: reads } } as unknown as JobDetailResponse; } },
    surface: { presentDialog(dialog: DialogView) { dialogs.push(dialog); active = true; }, isForegroundJobActive: () => active, closeDialog() { active = false; } },
  } as unknown as FeatureContext;
  const result = await waitForegroundGeneration(context, { job_id: mine.id }, '制作平台版本', () => true, true);
  assert.equal(result?.job.state, 'succeeded');
  const queued = dialogs.find(dialog => dialog.generationProgress?.message.startsWith('排队中'))!, running = dialogs.find(dialog => dialog.generationProgress?.state === 'running')!;
  assert.equal(queued.generationProgress!.state, 'queued'); assert.equal(queued.generationProgress!.message, '排队中（前面还有 2 个）');
  assert.equal(running.generationProgress!.message, '正在整理文字候选…'); assert.equal(lists.length, 1, '只在排队态读取队列位置');
  const queuedDom = await renderProgress(queued.generationProgress!), runningDom = await renderProgress(running.generationProgress!);
  assert.match(queuedDom, /<span class="generation-progress-state">已排队<\/span><p class="generation-progress-message">排队中（前面还有 2 个）<\/p>/);
  assert.match(runningDom, /<span class="generation-progress-state">处理中<\/span>/); assert(!runningDom.includes('前面还有'));
});

test('F3-b 勾选三个平台时三条生成请求同时在途，单个提交失败不影响其他平台', { timeout: 30_000 }, async () => {
  const f = fixture(); let registry: DraftRegistry | undefined;
  try {
    const topic = await f.topic(), ui = { ...initialUi('create'), topic: topic.id }, inFlight: string[] = [], toasts: string[] = [], titles: string[] = []; let active = false, peak = 0, open = 0, releaseAll!: () => void;
    const allInFlight = new Promise<void>(resolve => { releaseAll = resolve; }), timeout = setTimeout(() => releaseAll(), 3000);
    const client = { getDocument: async (id: string) => f.documents.get(f.request(), id), request: async (method: string, url: string, body: unknown) => { const part = url.split('/');
      if (method === 'GET' && url === '/api/v1/topics/' + topic.id) return f.topics.get(f.request(), topic.id); if (url === '/api/v1/topics') return f.topics.list(f.request());
      if (method === 'POST' && part[3] === 'topics' && part[5] === 'variants') return f.generation.createVariant(f.request(), topic.id, body as Parameters<typeof f.generation.createVariant>[2]);
      if (method === 'POST' && part[3] === 'variants' && part[5] === 'generation') { inFlight.push(part[4]!); open++; peak = Math.max(peak, open); if (inFlight.length === 3) releaseAll(); await allInFlight; open--;
        if (inFlight.indexOf(part[4]!) === 1) throw new Error('提交被拒绝');
        const accepted = f.generation.variant(f.request(), part[4]!, body as Parameters<typeof f.generation.variant>[2]), claim = f.claim(), document = JSON.parse(claim.job.input_manifest).targets[0].document_id; f.finish(claim, { documents: [{ document_id: document, text: '初始化稿' }], recommendations: [] }); return accepted; }
      if (url.startsWith('/api/v1/jobs?')) return { items: [] }; if (part[3] === 'jobs') return f.jobs.get(f.request(), part[4]!);
      if (method === 'GET' && part[3] === 'documents' && part[5] === 'candidates') return { items: f.generation.candidates(f.request(), part[4]!) };
      if (method === 'GET' && part[3] === 'candidates') return f.generation.preview(f.request(), part[4]!);
      if (method === 'GET' && part[5] === 'revisions') return f.generation.revision(f.request(), part[4]!, part[6]!); throw new Error('未登记请求 ' + url); } } as unknown as WorkbenchClient;
    registry = new DraftRegistry(client, f.context.identity, { getItem: () => null, setItem() {}, removeItem() {} });
    const context = { ui, client, drafts: registry, identity: f.context.identity, signal: new AbortController().signal, surface: { editorFeedback() {}, updateUi(patch: Record<string, unknown>) { Object.assign(ui, patch); }, presentDialog(dialog: DialogView) { active = true; titles.push(dialog.title); }, isForegroundJobActive: () => active, closeDialog() { active = false; }, toast(message: string) { toasts.push(message); }, navigate() {} } } as unknown as FeatureContext;
    const port = createContentDocumentsFeaturePort({ loadBase: async current => emptyIngestView(current) }); await port.load(context);
    await port.dispatch({ action: 'do-generate', dataset: {}, fields: { 'platform:xiaohongshu': true, 'platform:x': true, 'platform:wechat': true } }, context); clearTimeout(timeout);
    assert.equal(inFlight.length, 3); assert.equal(peak, 3, '三条生成提交同时在途，而不是逐个等待完成');
    assert.equal(toasts.length, 1); assert.match(toasts[0]!, /提交被拒绝/);
    const variants = (await f.topics.get(f.request(), topic.id)).variants; assert.equal(variants.length, 3);
    const initialized = await Promise.all(variants.map(async variant => !!(await f.documents.get(f.request(), String(variant.document_id))).head_revision_id)); assert.equal(initialized.filter(Boolean).length, 2, '失败平台之外的两个平台都完成初始化');
    assert(titles.some(title => title.includes('（1/2）')) && titles.some(title => title.includes('（2/2）')));
  } finally { registry?.dispose(); f.cleanup(); }
});

test('F3-b 提交三平台后立刻离开页面：三个任务都不被取消，仍在服务端排队/执行', { timeout: 30_000 }, async () => {
  const f = fixture(); let registry: DraftRegistry | undefined;
  try {
    const topic = await f.topic(), ui = { ...initialUi('create'), topic: topic.id }, jobs: string[] = [], cancels: string[] = [];
    const client = { getDocument: async (id: string) => f.documents.get(f.request(), id), cancelJob: async (id: string) => { cancels.push(id); }, request: async (method: string, url: string, body: unknown) => { const part = url.split('/');
      if (method === 'GET' && url === '/api/v1/topics/' + topic.id) return f.topics.get(f.request(), topic.id); if (url === '/api/v1/topics') return f.topics.list(f.request());
      if (method === 'POST' && part[3] === 'topics' && part[5] === 'variants') return f.generation.createVariant(f.request(), topic.id, body as Parameters<typeof f.generation.createVariant>[2]);
      if (method === 'POST' && part[3] === 'variants' && part[5] === 'generation') { const accepted = f.generation.variant(f.request(), part[4]!, body as Parameters<typeof f.generation.variant>[2]); jobs.push(accepted.job_id); if (jobs.length === 3) ui.page = 'sources'; return accepted; }
      if (method === 'POST' && part[3] === 'jobs' && part[5] === 'cancel') { cancels.push(part[4]!); return {}; }
      if (url.startsWith('/api/v1/jobs?')) return { items: [] }; if (part[3] === 'jobs') return f.jobs.get(f.request(), part[4]!);
      throw new Error('未登记请求 ' + url); } } as unknown as WorkbenchClient;
    registry = new DraftRegistry(client, f.context.identity, { getItem: () => null, setItem() {}, removeItem() {} });
    const context = { ui, client, drafts: registry, identity: f.context.identity, signal: new AbortController().signal, surface: { editorFeedback() {}, updateUi(patch: Record<string, unknown>) { Object.assign(ui, patch); }, presentDialog() {}, isForegroundJobActive: () => true, closeDialog() {}, toast() {}, navigate() {} } } as unknown as FeatureContext;
    const port = createContentDocumentsFeaturePort({ loadBase: async current => emptyIngestView(current) }); await port.load(context);
    await port.dispatch({ action: 'do-generate', dataset: {}, fields: { 'platform:xiaohongshu': true, 'platform:x': true, 'platform:wechat': true } }, context);
    assert.equal(jobs.length, 3); assert.deepEqual(cancels, []);
    for (const id of jobs) { const job = f.jobs.get(f.request(), id).job; assert(['queued', 'running'].includes(job.state), job.state); assert.equal(job.cancel_requested_at, null); }
  } finally { registry?.dispose(); f.cleanup(); }
});

test('F3-b r3 关闭批次进度后首个任务恰好失败：按本地停止标志不再打开后续平台进度', { timeout: 30_000 }, async () => {
  const f = fixture(); let registry: DraftRegistry | undefined;
  try {
    const topic = await f.topic(), ui = { ...initialUi('create'), topic: topic.id }, jobs: string[] = [], titles: string[] = []; let active = false, polls = 0;
    const client = { getDocument: async (id: string) => f.documents.get(f.request(), id), cancelJob: async () => { throw new Error('不应取消'); }, request: async (method: string, url: string, body: unknown) => { const part = url.split('/');
      if (method === 'GET' && url === '/api/v1/topics/' + topic.id) return f.topics.get(f.request(), topic.id); if (url === '/api/v1/topics') return f.topics.list(f.request());
      if (method === 'POST' && part[3] === 'topics' && part[5] === 'variants') return f.generation.createVariant(f.request(), topic.id, body as Parameters<typeof f.generation.createVariant>[2]);
      if (method === 'POST' && part[3] === 'variants' && part[5] === 'generation') { const accepted = f.generation.variant(f.request(), part[4]!, body as Parameters<typeof f.generation.variant>[2]); jobs.push(accepted.job_id); return accepted; }
      if (url.startsWith('/api/v1/jobs?')) return { items: [] };
      if (part[3] === 'jobs' && part[4] === jobs[0]) { const detail = f.jobs.get(f.request(), part[4]!); if (++polls === 1) return { ...detail, job: { ...detail.job, state: 'running' } };
        active = false; return { ...detail, job: { ...detail.job, state: 'failed' }, error: { message: '首个平台失败' } }; }
      if (part[3] === 'jobs') return f.jobs.get(f.request(), part[4]!);
      throw new Error('未登记请求 ' + url); } } as unknown as WorkbenchClient;
    registry = new DraftRegistry(client, f.context.identity, { getItem: () => null, setItem() {}, removeItem() {} });
    const context = { ui, client, drafts: registry, identity: f.context.identity, signal: new AbortController().signal, surface: { editorFeedback() {}, updateUi(patch: Record<string, unknown>) { Object.assign(ui, patch); }, presentDialog(dialog: DialogView) { active = true; titles.push(dialog.title); }, isForegroundJobActive: () => active, closeDialog() { active = false; }, toast() {}, navigate() {} } } as unknown as FeatureContext;
    const port = createContentDocumentsFeaturePort({ loadBase: async current => emptyIngestView(current) }); await port.load(context);
    await port.dispatch({ action: 'do-generate', dataset: {}, fields: { 'platform:xiaohongshu': true, 'platform:x': true } }, context);
    assert.equal(jobs.length, 2); assert(titles.length > 0 && titles.every(title => title.includes('（1/2）')), titles.join('|'));
  } finally { registry?.dispose(); f.cleanup(); }
});

test('F3-b r4 批次中点“取消任务”只取消当前平台，继续跟随下一平台', { timeout: 30_000 }, async () => {
  const f = fixture(); let registry: DraftRegistry | undefined;
  try {
    const topic = await f.topic(), ui = { ...initialUi('create'), topic: topic.id }, jobs: string[] = [], titles: string[] = []; let active = false, closed: string | undefined, current = '';
    const client = { getDocument: async (id: string) => f.documents.get(f.request(), id), request: async (method: string, url: string, body: unknown) => { const part = url.split('/');
      if (method === 'GET' && url === '/api/v1/topics/' + topic.id) return f.topics.get(f.request(), topic.id); if (url === '/api/v1/topics') return f.topics.list(f.request());
      if (method === 'POST' && part[3] === 'topics' && part[5] === 'variants') return f.generation.createVariant(f.request(), topic.id, body as Parameters<typeof f.generation.createVariant>[2]);
      if (method === 'POST' && part[3] === 'variants' && part[5] === 'generation') { const accepted = f.generation.variant(f.request(), part[4]!, body as Parameters<typeof f.generation.variant>[2]); jobs.push(accepted.job_id); return accepted; }
      if (url.startsWith('/api/v1/jobs?')) return { items: [] };
      if (part[3] === 'jobs') { const detail = f.jobs.get(f.request(), part[4]!); if (part[4] === jobs[0]) { active = false; closed = 'cancel'; return { ...detail, job: { ...detail.job, state: 'running' } }; } if (part[4] === jobs[1]) { active = false; closed = 'user_close'; } return detail; }
      throw new Error('未登记请求 ' + url); } } as unknown as WorkbenchClient;
    registry = new DraftRegistry(client, f.context.identity, { getItem: () => null, setItem() {}, removeItem() {} });
    const context = { ui, client, drafts: registry, identity: f.context.identity, signal: new AbortController().signal, surface: { editorFeedback() {}, updateUi(patch: Record<string, unknown>) { Object.assign(ui, patch); }, presentDialog(dialog: DialogView) { active = true; closed = undefined; current = dialog.foregroundJob?.id ?? current; titles.push(dialog.title); }, isForegroundJobActive: () => active, foregroundCloseReason: (id: string) => id === current ? closed : undefined, closeDialog() { active = false; }, toast() {}, navigate() {} } } as unknown as FeatureContext;
    const port = createContentDocumentsFeaturePort({ loadBase: async current => emptyIngestView(current) }); await port.load(context);
    await port.dispatch({ action: 'do-generate', dataset: {}, fields: { 'platform:xiaohongshu': true, 'platform:x': true, 'platform:wechat': true } }, context);
    assert.equal(jobs.length, 3);
    assert(titles.some(title => title.includes('（2/3）')), '取消第一个后继续跟随第二个：' + titles.join('|'));
    assert(!titles.some(title => title.includes('（3/3）')), '第二个被关闭后停止整批');
  } finally { registry?.dispose(); f.cleanup(); }
});

test('r5 pagehide 按离开页面处理：记录 navigate，批次停止跟随且不取消任务', { timeout: 30_000 }, async () => {
  const { TaskDialogSession, bindPageHide } = await import('../../apps/web/src/transport/task-dialog.ts');
  const f = fixture(); let registry: DraftRegistry | undefined;
  try {
    const page = new EventTarget(), cancelled: string[] = [], topic = await f.topic(), ui = { ...initialUi('create'), topic: topic.id }, jobs: string[] = [], titles: string[] = [];
    let foreground: { id: string; keepOnDismiss?: boolean } | undefined, lastClose: { id: string; reason: string } | undefined, hid = false;
    // 与真实控制器同一套会话与 pagehide 绑定：关闭原因记录、keepOnDismiss 非 cancel 不取消。
    const session = new TaskDialogSession(async reason => { const job = foreground; foreground = undefined; if (job) lastClose = { id: job.id, reason }; if (job?.keepOnDismiss && reason !== 'cancel') return; if (job) cancelled.push(job.id); });
    bindPageHide(page, () => { if (foreground) void session.close('navigate'); });
    const client = { getDocument: async (id: string) => f.documents.get(f.request(), id), request: async (method: string, url: string, body: unknown) => { const part = url.split('/');
      if (method === 'GET' && url === '/api/v1/topics/' + topic.id) return f.topics.get(f.request(), topic.id); if (url === '/api/v1/topics') return f.topics.list(f.request());
      if (method === 'POST' && part[3] === 'topics' && part[5] === 'variants') return f.generation.createVariant(f.request(), topic.id, body as Parameters<typeof f.generation.createVariant>[2]);
      if (method === 'POST' && part[3] === 'variants' && part[5] === 'generation') { const accepted = f.generation.variant(f.request(), part[4]!, body as Parameters<typeof f.generation.variant>[2]); jobs.push(accepted.job_id); return accepted; }
      if (url.startsWith('/api/v1/jobs?')) return { items: [] };
      if (part[3] === 'jobs') { if (!hid) { hid = true; page.dispatchEvent(new Event('pagehide')); } return f.jobs.get(f.request(), part[4]!); }
      throw new Error('未登记请求 ' + url); } } as unknown as WorkbenchClient;
    registry = new DraftRegistry(client, f.context.identity, { getItem: () => null, setItem() {}, removeItem() {} });
    const context = { ui, client, drafts: registry, identity: f.context.identity, signal: new AbortController().signal, surface: { editorFeedback() {}, updateUi(patch: Record<string, unknown>) { Object.assign(ui, patch); },
      presentDialog(dialog: DialogView) { foreground = dialog.foregroundJob; session.begin(); titles.push(dialog.title); }, isForegroundJobActive: (id: string) => foreground?.id === id && session.isActive(), foregroundCloseReason: (id: string) => lastClose?.id === id ? lastClose.reason : undefined, closeDialog(reason: 'completed') { void session.close(reason); }, toast() {}, navigate() {} } } as unknown as FeatureContext;
    const port = createContentDocumentsFeaturePort({ loadBase: async current => emptyIngestView(current) }); await port.load(context);
    await port.dispatch({ action: 'do-generate', dataset: {}, fields: { 'platform:xiaohongshu': true, 'platform:x': true } }, context);
    assert.equal(jobs.length, 2); assert.equal(lastClose?.reason, 'navigate'); assert.deepEqual(cancelled, [], 'pagehide 不取消批次任务');
    assert(!titles.some(title => title.includes('（2/2）')), '页面隐藏后不再续跟下一平台：' + titles.join('|'));
    for (const id of jobs) assert.equal(f.jobs.get(f.request(), id).job.cancel_requested_at, null);
  } finally { registry?.dispose(); f.cleanup(); }
});
