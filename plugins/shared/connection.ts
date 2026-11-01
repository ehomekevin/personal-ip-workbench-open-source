import { CONTRACT_VERSION, ContractError, type ServiceIdentity } from '../../packages/contracts/src/index.ts';

export const PLUGIN_ID = 'personal-ip-workbench';
export const PLUGIN_VERSION = '0.1.0';
export interface WorkbenchConnectionDescriptor {
  descriptor_version: 1;
  plugin_id: typeof PLUGIN_ID;
  base_url: string;
  identity: ServiceIdentity;
  host: { surface: string; runtime_version: string; connection_mode: string; plugin_version: string };
  web_url?: string;
  connection_credential?: string;
}
export function assertLoopbackUrl(value: string, baseOnly = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ContractError('VALIDATION_ERROR', '主服务连接地址无效'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash || (baseOnly && (url.pathname !== '/' || url.search)))
    throw new ContractError('VALIDATION_ERROR', '本地连接仅允许明确的回环 HTTP 地址');
  return baseOnly ? url.origin : url.href;
}
export function parseConnectionDescriptor(value: unknown): WorkbenchConnectionDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('VALIDATION_ERROR', '连接描述必须是对象');
  const d = value as WorkbenchConnectionDescriptor;
  if (!d.identity || typeof d.identity !== 'object' || Array.isArray(d.identity) || !d.host || typeof d.host !== 'object' || Array.isArray(d.host))
    throw new ContractError('VALIDATION_ERROR', '连接描述身份和宿主必须是对象');
  const allowed = ['descriptor_version', 'plugin_id', 'base_url', 'identity', 'host', 'web_url', 'connection_credential'];
  if (Object.keys(d).some(key => !allowed.includes(key)) || !d.identity || Object.keys(d.identity).some(key => !['workspace_id', 'service_instance_id', 'contract_version'].includes(key)) || !d.host || Object.keys(d.host).some(key => !['surface', 'runtime_version', 'connection_mode', 'plugin_version'].includes(key)))
    throw new ContractError('VALIDATION_ERROR', '连接描述含未登记字段');
  if (d.descriptor_version !== 1 || d.plugin_id !== PLUGIN_ID || !d.identity || d.identity.contract_version !== CONTRACT_VERSION ||
      typeof d.identity.workspace_id !== 'string' || !d.identity.workspace_id.trim() || typeof d.identity.service_instance_id !== 'string' || !d.identity.service_instance_id.trim() || !d.host ||
      Object.values(d.host).some(item => typeof item !== 'string' || !item.trim() || item.length > 200 || /[\x00-\x1f\x7f]/.test(item)) ||
      ['surface', 'runtime_version', 'connection_mode', 'plugin_version'].some(key => !(key in d.host)))
    throw new ContractError('VALIDATION_ERROR', '连接描述版本、身份或宿主信息不完整');
  if (!['codex_desktop', 'claude_desktop_chat', 'claude_cowork', 'claude_code'].includes(d.host.surface) || d.host.connection_mode !== 'local_stdio') throw new ContractError('VALIDATION_ERROR', '连接描述宿主或连接方式未登记');
  if (d.connection_credential !== undefined && (typeof d.connection_credential !== 'string' || d.connection_credential.length < 32))
    throw new ContractError('VALIDATION_ERROR', '连接凭据无效');
  if (typeof d.base_url !== 'string' || (d.web_url !== undefined && typeof d.web_url !== 'string')) throw new ContractError('VALIDATION_ERROR', '连接描述地址必须是字符串');
  return { ...d, base_url: assertLoopbackUrl(d.base_url, true), ...(d.web_url !== undefined ? { web_url: assertLoopbackUrl(d.web_url) } : {}) };
}
