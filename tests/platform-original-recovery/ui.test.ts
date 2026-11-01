import test from 'node:test';
import assert from 'node:assert/strict';
import type { JobDetailResponse, JsonObject } from '../../packages/contracts/src/index.ts';
import type { FeatureContext, DialogView } from '../../apps/web/src/transport/feature-ports.ts';
import { initialUi } from '../../apps/web/src/app/view-model.ts';
import { createContentDocumentsFeaturePort } from '../../apps/web/src/features/create/documents/index.ts';
import { originalResultState, readOriginalVariantResult, readPlatformOriginalTask } from '../../apps/web/src/features/create/original-result.ts';
import { waitForegroundGeneration } from '../../apps/web/src/features/create/ai-actions/index.ts';
import { DraftRegistry } from '../../apps/web/src/transport/drafts.ts';
import type { RequestOptions } from '../../apps/web/src/transport/workbench-client.ts';

function fixture(mode = 'completed') {
  const source = { document_id: 'core', head_revision_id: 'core-r1', version: 1, text: '受控核心稿', hash: 'core-hash', save_state: 'committed' };
  const doc = { document_id: 'document', head_revision_id: null as string | null, version: 1, text: '', hash: null as string | null, save_state: 'empty' };
  const variant = { id: 'variant', document_id: doc.document_id, topic_id: 'topic', platform: 'wechat', format: 'article', status: 'empty', based_on_core_revision_id: 'core-r1', version: 1 };
  const topic = { id: 'topic', title: '受控平台稿', category: '个人思考', core_document_id: 'core', core: source, core_approval: { revision_id: 'core-r1' }, source_ids: [], variants: [variant], shots: [], assets: [], preparation_plan_id: null };
  const job = { id: 'job', state: 'failed', version: 3, target_id: 'variant', kind: 'variant_generate', execution_mode: 'service_adapter', executor_id: 'codex', input_manifest: JSON.stringify({ mode: 'initialize', targets: [{ document_id: 'document', base_revision_id: null, core_revision_id: 'core-r1' }] }), cancel_requested_at: null };
  const detail = { job, checkpoint: { agent_handle: { runtime_session_id: 'fixture-thread', runtime_turn_id: 'fixture-turn' } }, error: { code: 'RESULT_UNKNOWN', details: {} }, receipts: [] as JsonObject[], attempts: [], artifacts: [] } as unknown as JobDetailResponse;
  const ui = { ...initialUi('create'), topic: 'topic' }, dialogs: DialogView[] = [], calls: { method: string; url: string; body?: unknown }[] = [], notices: string[] = [];
  let active = false, cancelCount = 0, closeDuringQuery = false;
  const client = {
    invalidateReads() {}, getDocument: async (id: string) => structuredClone(id === 'core' ? source : doc), saveDocument: async () => { throw new Error('No document writes in UI query fixture'); }, cancelJob: async () => { cancelCount++; },
    request: async (method: string, url: string, body?: unknown) => {
      calls.push({ method, url, ...(body ? { body } : {}) });
      if (method === 'GET' && url === '/api/v1/topics') return { items: [structuredClone(topic)], next_cursor: null };
      if (method === 'GET' && url === '/api/v1/topics/topic') return structuredClone(topic);
      if (method === 'GET' && url.startsWith('/api/v1/jobs?')) return { items: [structuredClone(job)] };
      if (method === 'GET' && url === '/api/v1/jobs/job') return structuredClone(detail);
      if (method === 'POST' && url === '/api/v1/jobs/job/resume') {
        assert.deepEqual(body, { expected_version: 3, recovery_action: 'query_original' }); job.version++;
        if (mode === 'interrupted') { job.state = 'failed'; detail.error = { code: 'HOST_INTERRUPTED', details: { original_result_unavailable: true } }; }
        else if (mode === 'unknown') { job.state = 'failed'; detail.error = { code: 'RESULT_UNKNOWN', details: { native_status: 'inProgress' } }; }
        else if (mode === 'running') job.state = 'running';
        else {
          job.state = 'succeeded'; detail.error = null;
          const adopted = mode === 'completed';
          detail.receipts = [{ state: 'committed', receipt_id: 'receipt', result_ids: { documents: [{ document_id: 'document', revision_id: 'result-r1', adopted, adoption_mode: adopted ? 'auto_initial' : null }] } }];
          doc.head_revision_id = adopted ? 'result-r1' : 'manual-r1'; doc.text = adopted ? '受控已保存平台稿' : '人工稿保留'; doc.hash = 'document-hash'; doc.save_state = 'committed'; variant.status = adopted ? 'ready' : 'empty';
          if (mode === 'core-changed') source.head_revision_id = 'core-r2';
        }
        return structuredClone(job);
      }
      throw new Error('Unexpected fixture request: ' + method + ' ' + url);
    },
  };
  const identity = { workspace_id: 'fixture-workspace', service_instance_id: 'fixture-service', contract_version: '0.1.1' as const }, registry = new DraftRegistry(client as never, identity, { getItem: () => null, setItem() {}, removeItem() {} });
  const context = { identity, ui, client, signal: new AbortController().signal, drafts: registry, surface: {
    editorFeedback() {}, toast(message: string) { notices.push(message); }, updateUi(patch: unknown) { Object.assign(ui, patch); }, navigate() {},
    presentDialog(dialog: DialogView) { dialogs.push(dialog); active = !!dialog.foregroundJob; if (closeDuringQuery && dialog.foregroundJob && job.version > 3) active = false; }, isForegroundJobActive() { return active; }, foregroundCloseReason() { return 'user_close'; }, closeDialog() { active = false; },
  } } as unknown as FeatureContext;
  const port = createContentDocumentsFeaturePort({ loadBase: async () => ({ provenance: 'service', projections: {}, ui, state: { topics: [], agent: 'codex' }, NEWS: [], KNOWLEDGE: [], files: new Map() }) as never });
  return { context, port, detail, doc, source, variant, topic, calls, dialogs, notices, registry, cancelCount: () => cancelCount, closeDuringQuery: () => { closeDuringQuery = true; } };
}

test('平台失败弹窗绑定原job/variant，原任务无final时入口禁用且准确说明', async () => {
  const f = fixture(); try {
    const result = await waitForegroundGeneration(f.context, { job_id: 'job' }, '制作平台版本');
    assert.equal(result, null); const dialog = f.dialogs.at(-1)!;
    assert.match(dialog.foot!, /核对原结果/); assert.match(dialog.foot!, /data-original-job="job"/); assert.match(dialog.foot!, /data-original-variant="variant"/); assert.ok(!dialog.foot!.includes('disabled'));
    f.detail.error = { code: 'HOST_INTERRUPTED', details: { original_result_unavailable: true } };
    await waitForegroundGeneration(f.context, { job_id: 'job' }, '制作平台版本');
    assert.match(f.dialogs.at(-1)!.generationProgress!.message, /没有可回收/); assert.match(f.dialogs.at(-1)!.foot!, /disabled/);
    assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
  } finally { f.registry.dispose(); }
});

for (const mode of ['completed', 'manual', 'core-changed', 'interrupted', 'unknown'] as const) test('平台严格核对原结果：' + mode, async () => {
  const f = fixture(mode); try {
    await f.port.load(f.context);
    await f.port.dispatch({ action: 'regenerate-version', dataset: { originalJob: 'job', originalVariant: 'variant' }, fields: {} }, f.context);
    const posts = f.calls.filter(call => call.method === 'POST');
    assert.deepEqual(posts, [{ method: 'POST', url: '/api/v1/jobs/job/resume', body: { expected_version: 3, recovery_action: 'query_original' } }]);
    const output = JSON.stringify(f.dialogs.at(-1));
    if (mode === 'completed') assert.match(output, /原结果已恢复到这个平台/);
    else { assert.ok(!output.includes('原结果已恢复到这个平台')); assert.match(output, mode === 'interrupted' ? /没有可回收/ : mode === 'unknown' ? /未完成|未能确认|核对/ : /没有替换当前稿/); }
    assert.equal(f.cancelCount(), 0); assert.equal(f.source.text, '受控核心稿');
  } finally { f.registry.dispose(); }
});

test('关闭query-only前台只停止查看；离页也不发取消或新生成', async () => {
  const f = fixture('running'); try {
    await f.port.load(f.context); f.closeDuringQuery();
    await f.port.dispatch({ action: 'regenerate-version', dataset: { originalJob: 'job', originalVariant: 'variant' }, fields: {} }, f.context);
    assert.ok(f.dialogs.some(dialog => dialog.foregroundJob?.keepOnDismiss && dialog.foot?.includes('停止查看')));
    assert.equal(f.cancelCount(), 0); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    const count = f.calls.length;
    await waitForegroundGeneration(f.context, { job_id: 'job' }, '核对原结果', () => false, false, undefined, { queryOriginal: true });
    assert.equal(f.calls.length, count); assert.equal(f.cancelCount(), 0); assert.equal(f.doc.text, '');
  } finally { f.registry.dispose(); }
});

test('未保存人工输入、缺失原任务身份、伪造其他variant都不触发POST', async () => {
  for (const reason of ['dirty', 'missing-handle', 'foreign-variant']) {
    const f = fixture(); try {
      await f.port.load(f.context);
      if (reason === 'dirty') f.context.drafts.status = () => 'dirty';
      if (reason === 'missing-handle') f.detail.checkpoint = null;
      await f.port.dispatch({ action: 'regenerate-version', dataset: { originalJob: 'job', originalVariant: reason === 'foreign-variant' ? 'other' : 'variant' }, fields: {} }, f.context);
      assert.equal(f.calls.filter(call => call.method === 'POST').length, 0, reason); assert.equal(f.doc.text, '');
    } finally { f.registry.dispose(); }
  }
});

test('持久任务读取必须匹配variant，回读仅凭job succeeded不报恢复', async () => {
  const f = fixture(); try {
    assert.deepEqual(await readPlatformOriginalTask(f.context, 'variant'), { jobId: 'job', variantId: 'variant', canQuery: true, message: originalResultState(f.detail).message });
    assert.equal(await readPlatformOriginalTask(f.context, 'foreign'), undefined);
    f.detail.job.state = 'succeeded'; assert.equal((await readOriginalVariantResult(f.context, f.detail, 'topic', 'variant', 'document')).recovered, false);
  } finally { f.registry.dispose(); }
});


test('刷新平台页读完整正序分页，较新成功任务不会被旧失败入口遮盖', async () => {
  const f = fixture(); try {
    const requested: string[] = [];
    const original = f.context.client.request;
    f.context.client.request = async (method, url, body, options) => {
      if (url.startsWith('/api/v1/jobs?')) { requested.push(url); return (url.includes('cursor=') ? { items: [{ ...f.detail.job, id: 'newer', state: 'succeeded' }], next_cursor: null } : { items: [f.detail.job], next_cursor: 'page/2' }) as never; }
      return original(method, url, body, options);
    };
    assert.equal(await readPlatformOriginalTask(f.context, 'variant'), undefined);
    assert.equal(requested.length, 2); assert.match(requested[1]!, /cursor=page%2F2/);
  } finally { f.registry.dispose(); }
});

test('刷新后空平台稿保留准确核对入口；部分身份dataset不降级为新生成', async () => {
  const f = fixture(); try {
    f.context.surface.updateUi({ editTab: 'versions', platform: 'wechat' });
    const view = await f.port.load(f.context);
    const version = view.state.topics[0]!.versions.wechat!;
    assert.equal(version.text, ''); assert.equal(version.originalTask?.jobId, 'job'); assert.equal(version.originalTask?.canQuery, true);
    await assert.rejects(f.port.dispatch({ action: 'regenerate-version', dataset: { originalJob: 'job' }, fields: {} }, f.context), /入口不完整/);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  } finally { f.registry.dispose(); }
});


for (const boundary of ['read', 'post'] as const) test('核对期间关闭 '+boundary+' 阶段，迟到响应不重开弹窗、不取消或补发', async () => {
  const f = fixture(); try {
    await f.port.load(f.context);
    const original = f.context.client.request; let release: (() => void) | undefined, held = false;
    f.context.client.request = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: unknown, options?: RequestOptions): Promise<T> => {
      if (!held && (boundary === 'read' ? method === 'GET' && url === '/api/v1/topics/topic' : method === 'POST')) {
        held = true; const value = await original<T>(method, url, body, options); return await new Promise<T>(resolve => { release = () => resolve(value); });
      }
      return original<T>(method, url, body, options);
    };
    const pending = f.port.dispatch({ action: 'regenerate-version', dataset: { originalJob: 'job', originalVariant: 'variant' }, fields: {} }, f.context);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    f.context.surface.closeDialog('user_close'); const count = f.dialogs.length; release(); await pending;
    assert.equal(f.dialogs.length, count); assert.equal(f.cancelCount(), 0);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, boundary === 'read' ? 0 : 1);
  } finally { f.registry.dispose(); }
});

test('completed但缺完整final只报告结果不可回收，不误报原任务中断', () => {
  const f = fixture(); try {
    f.detail.error = { code: 'RESULT_UNKNOWN', details: { original_result_unavailable: true, native_status: 'completed' } };
    const result = originalResultState(f.detail);
    assert.equal(result.canQuery, false); assert.match(result.message, /没有可回收的完整最终结果/); assert.ok(!result.message.includes('已中断'));
  } finally { f.registry.dispose(); }
});


test('已有平台稿不会遮住另一个空平台的核对路径', async () => {
  const f = fixture(); try {
    f.topic.variants.push({ ...f.variant, id: 'other', platform: 'x', document_id: 'other-document' });
    f.context.surface.updateUi({ editTab: 'versions', platform: 'x' });
    const view = await f.port.load(f.context);
    assert.ok(view.state.topics[0]!.versions.wechat);
    f.context.surface.updateUi({ platform: 'wechat' });
    const opened = await f.port.load(f.context);
    assert.equal(opened.state.topics[0]!.versions.wechat!.originalTask?.jobId, 'job');
    assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
  } finally { f.registry.dispose(); }
});


test('尚未加载正文但metadata有head的平台保留历史入口与未加载状态', async () => {
  const f = fixture(); try {
    Object.assign(f.topic, { read_state: { core_confirmed: true, core_version: 1, core_revision_id: 'core-r1', variants: [{ ...f.variant, head_revision_id: 'saved-r1', document_version: 4, parent_revision_id: 'saved-parent' }] } });
    const view = await f.port.load(f.context);
    const version = view.state.topics[0]!.versions.wechat!;
    assert.equal(version.historyAvailable, true); assert.equal(version.contentLoaded, false); assert.equal(version.rev, 4);
    assert.ok(!version.status.includes('为空')); assert.equal(version.originalTask, undefined);
    assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
  } finally { f.registry.dispose(); }
});
