import { ContractError } from '@workbench/contracts';
import type { ApplicationContext } from '@workbench/domain/ports';
import type { HostRuns } from '@workbench/domain/host-runs';
import type { TrustedHostPrincipal } from '@workbench/adapters/host-observer';

const fields = {
  'x-host-surface': 'host_surface',
  'x-host-runtime-version': 'runtime_version',
  'x-host-connection-mode': 'connection_mode',
  'x-host-plugin-version': 'plugin_version',
} as const;

// MCP 的连接描述必须和凭据实际所属逻辑连接一致；请求头不能授予 observer 权限。
export function authenticateHostRequest(context: ApplicationContext, runs: HostRuns, headers: Readonly<Record<string, string | undefined>>, role: TrustedHostPrincipal['role']): TrustedHostPrincipal {
  const principal = runs.authority.authenticate(headers, role);
  const selected = Object.keys(fields).map(key => headers[key]);
  if (selected.every(value => value === undefined)) return principal; // 保留 WP17 已存在的受信直连程序协议。
  if (selected.some(value => !value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value))) throw new ContractError('VALIDATION_ERROR', '宿主连接描述请求头不完整');
  const connection = context.db.prepare('SELECT host_surface,runtime_version,connection_mode,plugin_version,service_instance_id FROM host_connections WHERE workspace_id=? AND id=?').get(context.identity.workspace_id, principal.host_connection_id);
  if (!connection || connection.service_instance_id !== context.identity.service_instance_id || Object.entries(fields).some(([header, field]) => headers[header] !== connection[field])) {
    throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '宿主连接描述与受信凭据所属连接不一致');
  }
  return principal;
}
