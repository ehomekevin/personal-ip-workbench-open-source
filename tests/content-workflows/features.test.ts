import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './harness.ts';
import { DraftRegistry } from '../../apps/web/src/transport/drafts.ts';
import type { WorkbenchClient } from '../../apps/web/src/transport/workbench-client.ts';
import { TaskDialogSession } from '../../apps/web/src/transport/task-dialog.ts';
import { waitForegroundGeneration, readForegroundResult } from '../../apps/web/src/features/create/ai-actions/index.ts';
import type { FeatureContext } from '../../apps/web/src/transport/feature-ports.ts';
test('T22 断线 ACK 丢失后原 key 回取服务 revision，串行后改稿与新 head 刷新不覆盖本地副本', async () => {
  const f = fixture(); try { const topic = await f.topic(), initial = await f.documents.get(f.request(), topic.core_document_id), storage = new Map<string, string>(), local = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } }; let first = true, calls = 0;
    const client = { saveDocument: async (id, input, options) => { calls++; const result = await f.documents.save(f.request(options?.idempotencyKey), id, input); if (first) { first = false; throw new Error('内部构造 ACK 丢失'); } return result; } } as WorkbenchClient;
    const registry = new DraftRegistry(client, f.context.identity, local), draft = registry.attach(initial); draft.edit(f.text('离线人工 r2')); await draft.flush(); assert.equal(draft.status, 'offline'); assert.equal(storage.size, 1); registry.dispose(); const remote = await f.documents.get(f.request(), initial.document_id), recovered = new DraftRegistry(client, f.context.identity, local), resumed = recovered.attach(remote); assert.equal(resumed.value(), f.text('离线人工 r2')); await resumed.flush(); assert.equal(resumed.status, 'committed'); assert.equal(storage.size, 0); assert.equal((await f.documents.get(f.request(), initial.document_id)).head_revision_id, remote.head_revision_id); assert.equal(calls, 2);
    const next = await f.documents.save(f.request(), initial.document_id, { expected_revision_id: remote.head_revision_id, text: f.text('AI 采用后新的服务正文'), origin: 'human' }); recovered.attach(await f.documents.get(f.request(), initial.document_id)); assert.equal(resumed.value(), f.text('AI 采用后新的服务正文')); resumed.edit(f.text('本地尚未提交')); recovered.attach({ ...remote, head_revision_id: next.revision_id }); assert.equal(resumed.value(), f.text('本地尚未提交')); recovered.dispose(); } finally { f.cleanup(); }
});
test('取消/关闭/Escape 同一任务各仅一次；completed 程序关闭不取消', async () => {
  for (const reason of ['cancel', 'user_close', 'escape', 'completed'] as const) { const sent: string[] = [], dialog = new TaskDialogSession(async reason => { sent.push(reason); }); dialog.begin(); await dialog.close(reason); await dialog.close('user_close'); assert.deepEqual(sent, reason === 'completed' ? [] : [reason]); }
});
test('前台关闭后迟到 succeeded 响应不打开候选，服务 succeeded 的程序关闭不发取消', async () => {
  for (const closeBeforeResponse of [true, false]) { let active = false, resolve!: (value: unknown) => void; const closes: string[] = [], response = new Promise(resolveValue => { resolve = resolveValue; }), abort = new AbortController(), context = { signal: abort.signal, client: { request: async () => response }, surface: { presentDialog: () => { active = true; }, isForegroundJobActive: () => active, closeDialog: (reason: string) => { closes.push(reason); active = false; }, toast: () => {} } } as unknown as FeatureContext;
    const promise = waitForegroundGeneration(context, { job_id: 'internal-task' }, '内部任务'); if (closeBeforeResponse) active = false; resolve({ job: { id: 'internal-task', state: 'succeeded', version: 3 } }); const result = await promise; assert.equal(result === null, closeBeforeResponse); assert.deepEqual(closes, closeBeforeResponse ? [] : ['completed']); }
});
test('生成接受响应前离开原页面，未呈现的任务按服务 version 取消且不重开弹窗', async () => {
  const cancelled: unknown[] = [], abort = new AbortController(), context = { signal: abort.signal, client: { request: async () => ({ job: { state: 'queued', version: 7 } }), cancelJob: async (id: string, version: number) => { cancelled.push([id, version]); } }, surface: { presentDialog: () => { throw new Error('离开后不得开弹窗'); } } } as unknown as FeatureContext;
  assert.equal(await waitForegroundGeneration(context, { job_id: 'internal-task' }, '内部任务', () => false), null); assert.deepEqual(cancelled, [['internal-task', 7]]);
});

test('succeeded后候选读取期间仍保留任务身份，用户关闭后读取结果被丢弃', async () => {
  let active = false, resolve!: (value: string) => void; const closes: string[] = [], context = { signal: new AbortController().signal, client: { request: async () => ({ job: { state: 'succeeded', version: 2 } }) }, surface: { presentDialog() { active = true; }, isForegroundJobActive: () => active, closeDialog(reason: string) { closes.push(reason); active = false; } } } as unknown as FeatureContext, accepted = { job_id: 'internal-task' };
  await waitForegroundGeneration(context, accepted, '内部任务', () => true, true); assert.equal(active, true); assert.deepEqual(closes, []); const pending = readForegroundResult(context, accepted, () => new Promise<string>(r => { resolve = r; })); active = false; resolve('已读取候选'); assert.equal(await pending, undefined); assert.deepEqual(closes, []);
});
