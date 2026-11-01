import { executorAvailability, type ContentExecutor, type ExecutorHealth, type SettingsResponse } from '@workbench/contracts';
// 执行器状态翻译成用户语言；选择只对本次任务生效，不改全局 default_executor。
export interface ExecutorChoice { id: ContentExecutor; name: string; status: string; blocked: boolean; usable: boolean }
export const EXECUTOR_NAMES: Record<ContentExecutor, string> = { codex: 'Codex', claude: 'Claude' };
// 可用判定与服务端共用 executorAvailability：以认证状态为准，unverified 只提示“未经真实验收”。手动选择与“改用重跑”同一判定。
export function executorChoice(id: ContentExecutor, health?: ExecutorHealth): ExecutorChoice {
  const { usable, blocked, reason } = executorAvailability(health);
  return { id, name: EXECUTOR_NAMES[id], blocked, usable, status: reason === 'quota' ? '额度暂不可用' : reason === 'login' ? '需要登录' : reason === 'unsupported' ? '暂不支持' : usable ? (health?.status === 'supported' ? '可用' : '可用 · 未经真实验收') : '待检查' };
}
export function executorChoices(settings?: Pick<SettingsResponse, 'executors'> | null): ExecutorChoice[] {
  return (['codex', 'claude'] as const).map(id => executorChoice(id, settings?.executors?.find(e => e.executor_id === id)));
}
// 默认取全局设置；默认项被额度/登录阻塞时退到另一个未阻塞的执行器。
export function preferredExecutor(choices: ExecutorChoice[], fallback: ContentExecutor = 'codex'): ContentExecutor {
  const preferred = choices.find(c => c.id === fallback);
  return preferred && !preferred.blocked ? fallback : choices.find(c => !c.blocked)?.id ?? fallback;
}
export function executorOptions(choices: ExecutorChoice[], selected: ContentExecutor, esc: (value: unknown) => string): string {
  return choices.map(c => '<option value="' + c.id + '"' + (c.id === selected ? ' selected' : '') + (c.blocked ? ' disabled' : '') + '>' + esc(c.name + ' · ' + c.status) + '</option>').join('');
}
