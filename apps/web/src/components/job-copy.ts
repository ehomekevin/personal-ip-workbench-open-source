import { EXECUTOR_NAMES } from './executors.ts';
// 任务状态与失败原因的用户文案：写作面板与平台版本面板共用；原始报错与状态码只进“详情”。
const STATE_LABELS: Record<string, string> = { queued: '排队中', running: '执行中', waiting_quota: '等待额度', waiting_input: '等待登录', reconciling: '核对中', cancel_requested: '取消中', succeeded: '已完成', failed: '未完成', cancelled: '已取消' };
export const jobStateLabel = (state: string) => STATE_LABELS[state] ?? '状态待核对';
const executorName = (executor?: string | null) => { const name = EXECUTOR_NAMES[executor as keyof typeof EXECUTOR_NAMES]; return name ? name + ' ' : '执行器'; };
export function jobIssueCopy(input: { state: string; executor?: string | null; code?: string | null; alternative?: string }): string | undefined {
  const name = executorName(input.executor), alt = input.alternative;
  const quota = name + '额度暂不可用，' + (alt ? '可改用 ' + alt + ' 或稍后恢复' : '可稍后恢复'), login = name + '需要登录，' + (alt ? '可改用 ' + alt + '，或在设置与连接登录后恢复' : '请在设置与连接登录后恢复');
  if (input.state === 'waiting_quota') return quota;
  if (input.state === 'waiting_input') return login;
  if (input.state === 'reconciling') return '正在核对执行器上次的结果，完成后再继续';
  if (input.state !== 'failed') return undefined;
  const code = input.code ?? '';
  if (['RESULT_UNKNOWN', 'LEASE_EXPIRED'].includes(code)) return '上次执行结果未能确认，可核对原任务后恢复';
  if (code === 'QUOTA_EXHAUSTED') return quota;
  if (code === 'AUTH_REQUIRED') return login;
  if (code === 'VALIDATION_ERROR') return '生成结果不完整，可以重试；原稿已保留';
  return '这次生成没有完成，可以重试；原稿已保留';
}
