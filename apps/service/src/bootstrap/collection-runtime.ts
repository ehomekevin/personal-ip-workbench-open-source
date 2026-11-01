import { lstatSync, openSync, readFileSync, closeSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ContractError } from '@workbench/contracts';
import { assertStorageRoot } from '@workbench/storage/connection';
import { TikHubAdapter, type VerifiedTarget } from '@workbench/adapters/tikhub';
import type { ApplicationContext } from '@workbench/domain/ports';
import { readTikHubCredential } from './tikhub-credentials.ts';

export function readCollectionTargets(context: ApplicationContext, path: string | undefined): VerifiedTarget[] {
  if (!path) return [];
  if (!isAbsolute(path)) throw new ContractError('VALIDATION_ERROR', 'TikHub 配置必须使用绝对路径');
  if (process.platform === 'darwin') assertStorageRoot(path);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new ContractError('VALIDATION_ERROR', 'TikHub 配置文件无效');
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); let input: unknown;
  try { input = JSON.parse(readFileSync(file, 'utf8')); } finally { closeSync(file); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContractError('VALIDATION_ERROR', 'TikHub 配置无效');
  const config = input as Record<string, unknown>;
  if (Object.keys(config).some(key => !['config_version', 'workspace_id', 'targets'].includes(key)) || config.config_version !== 1 || config.workspace_id !== context.identity.workspace_id || !Array.isArray(config.targets) || config.targets.length > 1000) throw new ContractError('VALIDATION_ERROR', 'TikHub 配置版本或工作区不符');
  const targets = config.targets as VerifiedTarget[];
  // Adapter 校验只读端点、请求参数和字段映射；启动侧另外核对实际本机实体归属。
  try { new TikHubAdapter({ targets }); } catch { throw new ContractError('VALIDATION_ERROR', 'TikHub 目标配置尚未核对'); }
  for (const target of targets) {
    const table = target.scope === 'work' ? 'works' : 'accounts';
    const row = context.db.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND id=?`).get(context.identity.workspace_id, target.target_id);
    const account = target.scope === 'work' && row ? context.db.prepare('SELECT * FROM accounts WHERE workspace_id=? AND id=?').get(context.identity.workspace_id, row.account_id) : row;
    if (!row || row.identity_status !== 'confirmed' || row.platform !== target.platform || !account || account.identity_status !== 'confirmed' || account.platform_account_id !== target.platform_account_id || (target.scope === 'work' && (row.platform_work_id !== target.platform_work_id || row.url !== target.url))) throw new ContractError('CAPABILITY_UNVERIFIED', 'TikHub 目标身份与工作区记录不符');
  }
  return targets;
}
export function createCollectionRuntime(context: ApplicationContext, env: NodeJS.ProcessEnv = process.env): TikHubAdapter {
  const targets = readCollectionTargets(context, env.WORKBENCH_TIKHUB_CONFIG_PATH);
  // 本机手填凭据只在明确开启后读取，未开启时继续沿用已有环境变量路线。
  const useLocal = env.WORKBENCH_TIKHUB_LOCAL_CREDENTIAL === '1';
  return new TikHubAdapter({ targets, ...(useLocal ? { token_provider: () => readTikHubCredential(context.paths.state_root) } : { token_provider: () => env.TIKHUB_API_KEY?.trim() || null }) });
}
