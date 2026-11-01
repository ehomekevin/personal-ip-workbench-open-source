import { ContractError, type HostCapabilitiesResponse, type HostCapabilityRecordView, type HostConnectionView } from '@workbench/contracts';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';

const filters = ['host_surface', 'connection_mode', 'runtime_version', 'plugin_version'] as const;
const surfaces = ['codex_desktop', 'claude_desktop_chat', 'claude_cowork', 'claude_code'];
function limitations(value: string): string[] {
  try {
    const decoded: unknown = JSON.parse(value);
    if (Array.isArray(decoded) && decoded.every(item => typeof item === 'string')) return decoded;
  } catch { /* 历史文字限制同样保留，不生成虚构能力。 */ }
  return value ? [value] : [];
}

export function createHostCapabilitiesModule(context: ApplicationContext): ApplicationModule {
  return { id: 'host-capabilities', register(registrar) {
    registrar.register({ method: 'GET', path: '/api/v1/host-capabilities', owner: 'WP-23', handle(request) {
      const where = ['workspace_id=?'], values: string[] = [context.identity.workspace_id];
      for (const [key, value] of request.query) {
        if (!filters.includes(key as typeof filters[number]) || request.query.getAll(key).length !== 1 || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new ContractError('VALIDATION_ERROR', '宿主能力查询条件无效');
        if (key === 'host_surface' && !surfaces.includes(value)) throw new ContractError('VALIDATION_ERROR', '宿主入口不存在');
        where.push(key + '=?'); values.push(value);
      }
      const predicate = where.join(' AND ');
      const connections = context.db.prepare('SELECT id,host_surface,runtime_version,connection_mode,plugin_version,status FROM host_connections WHERE ' + predicate + ' ORDER BY host_surface,runtime_version,connection_mode,plugin_version,id').all(...values) as unknown as HostConnectionView[];
      const rows = context.db.prepare('SELECT id,host_surface,runtime_version,connection_mode,plugin_version,operation,status,limitations,verified_at,evidence_ref,version FROM host_capability_records WHERE ' + predicate + ' ORDER BY host_surface,runtime_version,connection_mode,plugin_version,operation,id').all(...values) as unknown as Array<Omit<HostCapabilityRecordView, 'limitations'> & { limitations: string }>;
      const body: HostCapabilitiesResponse = { identity: context.identity, connections, capabilities: rows.map(row => ({ ...row, limitations: limitations(row.limitations) })) };
      return { body };
    } });
  }, health: () => ({ module: 'host-capabilities', status: 'ready', details: { source: 'persisted_workspace_records', writes: false, inferred_tracking: false } }) };
}
