import { ContractError, type HostConnectionsRow, type HostCapabilityRecordsRow, type HostTaskObserversRow,
  type NativeTaskBindingsRow, type NativeTaskObservationsRow, type NativeIdentity } from '@workbench/contracts';
import type { DatabaseSync } from '../connection/index.ts';

function read<T>(db: DatabaseSync, table: string, workspace: string, id: string): T {
  const row = db.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND id=?`).get(workspace, id);
  if (!row) throw new ContractError('HOST_TASK_BINDING_INVALID', '原生观察归属不存在');
  return row as unknown as T;
}
export const getConnection = (db: DatabaseSync, workspace: string, id: string) => read<HostConnectionsRow>(db, 'host_connections', workspace, id);
export const getCapability = (db: DatabaseSync, workspace: string, id: string) => read<HostCapabilityRecordsRow>(db, 'host_capability_records', workspace, id);
export const getObserver = (db: DatabaseSync, workspace: string, id: string) => read<HostTaskObserversRow>(db, 'host_task_observers', workspace, id);
export const getBinding = (db: DatabaseSync, workspace: string, id: string) => read<NativeTaskBindingsRow>(db, 'native_task_bindings', workspace, id);
export const getObservation = (db: DatabaseSync, workspace: string, id: string) => read<NativeTaskObservationsRow>(db, 'native_task_observations', workspace, id);

export function assertIdentity(identity: NativeIdentity): void {
  if (!identity || typeof identity !== 'object' || typeof identity.native_namespace !== 'string' || !identity.native_namespace.trim()) throw new ContractError('HOST_TASK_BINDING_INVALID', '原生 namespace 不可为空');
  const keys = identity.scope === 'turn' ? ['scope', 'native_namespace', 'native_session_id', 'native_turn_id', 'native_task_id'] : ['scope', 'native_namespace', 'native_session_id', 'native_turn_id', 'native_task_id'];
  if (Object.keys(identity).some(key => !keys.includes(key))) throw new ContractError('HOST_TASK_BINDING_INVALID', '原生身份字段无效');
  if (identity.scope === 'turn') {
    if (typeof identity.native_session_id !== 'string' || !identity.native_session_id.trim() || typeof identity.native_turn_id !== 'string' || !identity.native_turn_id.trim() || identity.native_task_id != null) throw new ContractError('HOST_TASK_BINDING_INVALID', 'turn 必须有非空原生 session 与 turn');
  } else if (identity.scope === 'task') {
    if (typeof identity.native_task_id !== 'string' || !identity.native_task_id.trim() || identity.native_turn_id != null || (identity.native_session_id != null && (typeof identity.native_session_id !== 'string' || !identity.native_session_id.trim()))) throw new ContractError('HOST_TASK_BINDING_INVALID', 'task 必须有非空原生 task');
  } else throw new ContractError('HOST_TASK_BINDING_INVALID', '原生身份 scope 无效');
}
export function identityOf(binding: NativeTaskBindingsRow): NativeIdentity {
  return binding.scope === 'turn' ? { scope: 'turn', native_namespace: binding.native_namespace, native_session_id: binding.native_session_id!, native_turn_id: binding.native_turn_id! }
    : { scope: 'task', native_namespace: binding.native_namespace, native_task_id: binding.native_task_id!, native_session_id: binding.native_session_id };
}
export function sameIdentity(binding: NativeTaskBindingsRow, identity: NativeIdentity): boolean {
  return binding.scope === identity.scope && binding.native_namespace === identity.native_namespace && (identity.scope === 'turn'
    ? binding.native_session_id === identity.native_session_id && binding.native_turn_id === identity.native_turn_id
    : binding.native_task_id === identity.native_task_id);
}
export function assertTracking(connection: HostConnectionsRow, capability: HostCapabilityRecordsRow, serviceInstance: string, version: number): void {
  if (capability.status !== 'supported') throw new ContractError(capability.status === 'unsupported' ? 'CAPABILITY_UNSUPPORTED' : 'CAPABILITY_UNVERIFIED', '该宿主原生任务观察尚未通过准入');
  if (capability.operation !== 'native_task_tracking' || capability.version !== version || !capability.verified_at || !capability.evidence_ref?.trim()
    || capability.host_surface !== connection.host_surface || capability.runtime_version !== connection.runtime_version || capability.connection_mode !== connection.connection_mode || capability.plugin_version !== connection.plugin_version)
    throw new ContractError('CAPABILITY_UNVERIFIED', 'tracking 版本或实际宿主路线不匹配');
  if (connection.service_instance_id !== serviceInstance || !['active', 'connected'].includes(connection.status)) throw new ContractError('HOST_OBSERVER_NOT_READY', '宿主逻辑连接未就绪');
}
export function rfc3339(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ContractError('VALIDATION_ERROR', '观察时间必须为有效 RFC3339');
  const fields = value.slice(0, 19).split(/[-T:]/).map(Number), [year, month, day, hour, minute, second] = fields;
  const maxDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  if (month! < 1 || month! > 12 || day! < 1 || day! > maxDay || hour! > 23 || minute! > 59 || second! > 59) throw new ContractError('VALIDATION_ERROR', '观察时间日历值无效');
  return Date.parse(value);
}
export interface TrackingTimeProfile { freshness_ms: number; lease_ms: number; output_grace_ms: number; future_skew_ms: number }
// 仅是保守内部默认参数；真实 surface 的生产 profile 仍需独立观察证据。
export const DEFAULT_TRACKING_PROFILE: Readonly<TrackingTimeProfile> = { freshness_ms: 15_000, lease_ms: 60_000, output_grace_ms: 10_000, future_skew_ms: 250 };
export function assertFresh(observation: Pick<NativeTaskObservationsRow, 'observed_at' | 'received_at' | 'native_evidence_ref'>, now: number, profile: TrackingTimeProfile): void {
  const observed = rfc3339(observation.observed_at), received = rfc3339(observation.received_at);
  if (!observation.native_evidence_ref?.trim() || received > now || observed > received + profile.future_skew_ms || observed > now + profile.future_skew_ms || now - observed > profile.freshness_ms || now - received > profile.freshness_ms)
    throw new ContractError('HOST_OBSERVER_NOT_READY', '缺少新鲜的原生事件或当前任务查询依据');
}
export function bindingRows(db: DatabaseSync, workspace: string, connectionId: string): NativeTaskBindingsRow[] {
  return db.prepare('SELECT * FROM native_task_bindings WHERE workspace_id=? AND host_connection_id=? ORDER BY created_at,id').all(workspace, connectionId) as unknown as NativeTaskBindingsRow[];
}
