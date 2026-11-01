import type { ExecutorHealth } from './requests.ts';
// 执行器可用判定（前端选择、改用重跑与服务端重跑校验共用）：以认证状态为准；status=unverified 只是“未经真实验收”的提示。
// 额度不足、需要登录、未配置或不受支持时阻塞；只有订阅/凭据已认证才算可用，其他（未检查）既不阻塞也不算可用。
export const USABLE_EXECUTOR_AUTH = ['subscription_authenticated', 'authenticated', 'api_key_authenticated'] as const;
export function executorAvailability(health?: Pick<ExecutorHealth, 'status' | 'auth_state'> | null): { usable: boolean; blocked: boolean; reason: 'quota' | 'login' | 'unsupported' | 'unknown' | null } {
  const auth = health?.auth_state ?? '', quota = auth === 'QUOTA_EXHAUSTED', login = auth === 'AUTH_REQUIRED' || auth === 'auth_required' || health?.status === 'unconfigured', unsupported = health?.status === 'unsupported';
  const blocked = quota || login || unsupported, usable = !blocked && (USABLE_EXECUTOR_AUTH as readonly string[]).includes(auth);
  return { usable, blocked, reason: quota ? 'quota' : login ? 'login' : unsupported ? 'unsupported' : usable ? null : 'unknown' };
}
