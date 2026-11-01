import test from 'node:test';
import assert from 'node:assert/strict';
import type { JobDetailResponse } from '../../packages/contracts/src/index.ts';
import type { DialogView, FeatureContext } from '../../apps/web/src/transport/feature-ports.ts';
import { waitForegroundGeneration } from '../../apps/web/src/features/create/ai-actions/index.ts';

test('前台生成投影真实状态与最新取消版本，不虚构百分比；读取成功结果期间保持任务身份', async () => {
  const dialogs: DialogView[] = [], closes: string[] = [];
  const states = ['queued', 'running', 'succeeded'] as const;
  let active = false, reads = 0;
  const context = { signal: new AbortController().signal,
    // 排队位置读取走 /api/v1/jobs 列表，不计入任务详情轮询。
    client: { request: async (_method: string, url: string) => url.startsWith('/api/v1/jobs?') ? { items: [] } : ({ job: { state: states[reads], version: ++reads } } as JobDetailResponse) },
    surface: { presentDialog(dialog: DialogView) { dialogs.push(dialog); active = true; }, isForegroundJobActive: () => active, closeDialog(reason: string) { closes.push(reason); active = false; } },
  } as unknown as FeatureContext;
  const result = await waitForegroundGeneration(context, { job_id: 'fixture-job' }, '制作平台版本', () => true, true);
  assert.equal(result?.job.state, 'succeeded');
  assert.deepEqual(dialogs.map(dialog => dialog.generationProgress?.state), ['queued', 'queued', 'running', 'succeeded']);
  assert.deepEqual(dialogs.map(dialog => dialog.foregroundJob?.version), [1, 1, 2, 3]);
  assert.ok(dialogs.every(dialog => !dialog.body.includes('task-progress') && !dialog.body.includes('%')));
  assert.equal(active, true);
  assert.deepEqual(closes, []);
});

const issueCopy: Record<string, string> = { failed: '这次生成没有完成，可以重试；原稿已保留', waiting_input: 'Codex 需要登录，请在设置与连接登录后恢复', waiting_quota: 'Codex 额度暂不可用，可稍后恢复', reconciling: '正在核对执行器上次的结果，完成后再继续' };
for (const state of ['failed', 'waiting_input', 'waiting_quota', 'reconciling'] as const) {
  test('生成服务状态 ' + state + ' 结束前台跟随，用用户文案说明，原始报错只进详情', async () => {
    let active = false;
    const closes: string[] = [], toasts: string[] = [], dialogs: DialogView[] = [];
    const context = { signal: new AbortController().signal,
      client: { request: async () => ({ job: { state, version: 5, executor_id: 'codex' }, error: { code: state === 'failed' ? 'PROVIDER_ERROR' : 'QUOTA_EXHAUSTED', message: 'fixture 原始错误' } }) },
      surface: { presentDialog(dialog: DialogView) { dialogs.push(dialog); active = true; }, isForegroundJobActive: () => active, closeDialog(reason: string) { closes.push(reason); active = false; }, toast(message: string) { toasts.push(message); } },
    } as unknown as FeatureContext;
    assert.equal(await waitForegroundGeneration(context, { job_id: 'fixture-job' }, '制作平台版本'), null);
    assert.deepEqual(closes, ['completed']);
    assert.deepEqual(toasts, [], '不再 toast 原文');
    const last = dialogs.at(-1)!;
    assert.equal(last.foregroundJob, undefined, '结果说明弹窗关闭时不取消任务');
    assert.equal(last.generationProgress!.state, state === 'failed' ? 'failed' : 'waiting');
    assert.equal(last.generationProgress!.message, issueCopy[state]);
    assert(!last.body.includes('fixture 原始错误') && !last.generationProgress!.message.includes('fixture'));
    assert(last.generationProgress!.details!.some(d => d.value === 'fixture 原始错误'));
  });
}

test('轮询读取失败释放等待弹窗且抛出原异常，不发送取消或吞掉错误', async () => {
  let active = false;
  const error = new Error('fixture 网络读取失败'), closes: string[] = [];
  const context = { signal: new AbortController().signal,
    client: { request: async () => { throw error; }, cancelJob: async () => { throw new Error('读取异常不能额外取消'); } },
    surface: { presentDialog() { active = true; }, isForegroundJobActive: () => active, closeDialog(reason: string) { closes.push(reason); active = false; } },
  } as unknown as FeatureContext;
  await assert.rejects(waitForegroundGeneration(context, { job_id: 'fixture-job' }, '制作平台版本'), value => value === error);
  assert.equal(active, false);
  assert.deepEqual(closes, ['completed']);
});
