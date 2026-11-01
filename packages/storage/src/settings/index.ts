import { ContractError, type WorkspaceSettings, type WorkspacePaths } from '@workbench/contracts';
import { type DatabaseSync } from '../connection/index.ts';

export function workspaceSettings(db: DatabaseSync, workspaceId: string): WorkspaceSettings {
  const row = db.prepare('SELECT * FROM workspaces WHERE id=? AND workspace_id=?').get(workspaceId, workspaceId);
  if (!row) throw new ContractError('NOT_FOUND', '工作区不存在');
  const paths = JSON.parse(String(row.paths));
  const filtered: WorkspacePaths = { source_vault_root: typeof paths.source_vault_root === 'string' ? paths.source_vault_root : null,
    managed_notes_root: String(paths.managed_notes_root), state_root: String(paths.state_root), media_root: String(paths.media_root) };
  return { workspace_id: workspaceId, title: String(row.title), timezone: String(row.timezone), mode: row.mode as 'real' | 'demo',
    paths: filtered, version: Number(row.version), default_executor: row.default_executor as 'codex' | 'claude', api_fallback_enabled: row.api_fallback_enabled === 1 };
}
export function safeConfigReference(reference: unknown): string | null {
  return typeof reference === 'string' && /^env:[A-Z][A-Z0-9_]{0,199}$/.test(reference) ? reference : null;
}
export function setConnectorReference(db: DatabaseSync, workspaceId: string, connectorId: string, reference: string): void {
  const validated = safeConfigReference(reference);
  if (!validated) throw new ContractError('VALIDATION_ERROR', '凭据配置只允许环境变量名称引用');
  const updated = db.prepare('UPDATE connectors SET config_ref=?,updated_at=? WHERE workspace_id=? AND id=?').run(validated, new Date().toISOString(), workspaceId, connectorId);
  if (!Number(updated.changes)) throw new ContractError('NOT_FOUND', '连接器不存在');
}
export function connectorCapabilities(db: DatabaseSync, workspaceId: string) {
  return db.prepare('SELECT id,kind,capability_status,config_ref,last_success_at FROM connectors WHERE workspace_id=? ORDER BY id').all(workspaceId)
    .map(row => ({ connector_id: String(row.id), kind: String(row.kind), status: String(row.capability_status),
      configured: safeConfigReference(row.config_ref) !== null, config_ref: safeConfigReference(row.config_ref), last_success_at: row.last_success_at as string | null }));
}
