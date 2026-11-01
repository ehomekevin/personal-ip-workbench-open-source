import { createHash, timingSafeEqual } from 'node:crypto';
import { ContractError, type NativeIdentity, type NativeObservedState } from '@workbench/contracts';

export interface TrustedObserverProgram { owner: string; host_connection_id: string; observer_credential: string; connection_credential: string }
export interface TrustedHostPrincipal { readonly owner: string; readonly host_connection_id: string; readonly role: 'observer' | 'connection' }
export type ObservedNativeState = NativeObservedState;
export interface HostTaskObserverProgram {
  describe(): Promise<{ native_task_tracking: 'unverified' | 'supported' | 'unsupported'; evidence_ref: string | null }>;
  bindNativeTask(): Promise<NativeIdentity>;
  observe(identity: NativeIdentity): AsyncIterable<ObservedNativeState>;
  reattach(identity: NativeIdentity): Promise<ObservedNativeState>;
  requestInterrupt?(identity: NativeIdentity): Promise<{ acknowledged: boolean; evidence_ref: string | null }>;
}
const digest = (value: string) => createHash('sha256').update(value).digest();
// 服务启动时注入；凭据不进数据库、模型参数、返回值或日志。空配置默认拒绝。
export class TrustedObserverAuthority {
  private readonly programs: Array<{ owner: string; connection: string; observer: Buffer; bridge: Buffer }>;
  private readonly issued = new WeakSet<object>();
  constructor(programs: readonly TrustedObserverProgram[] = []) {
    if (programs.some(p => !p.owner.trim() || !p.host_connection_id.trim() || p.observer_credential.length < 32 || p.connection_credential.length < 32 || p.observer_credential === p.connection_credential)
      || new Set(programs.map(p => p.host_connection_id)).size !== programs.length || new Set(programs.flatMap(p => [p.observer_credential, p.connection_credential])).size !== programs.length * 2) throw new ContractError('VALIDATION_ERROR', '受信程序配置必须有唯一连接与独立强凭据');
    this.programs = programs.map(p => ({ owner: p.owner, connection: p.host_connection_id, observer: digest(p.observer_credential), bridge: digest(p.connection_credential) }));
  }
  authenticate(headers: Readonly<Record<string, string | undefined>>, role: TrustedHostPrincipal['role']): TrustedHostPrincipal {
    const credential = role === 'observer' ? headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1] : headers['x-host-connection-credential'];
    if (!credential) throw new ContractError('AUTH_REQUIRED', '该接口仅允许已安装的受信宿主桥接程序');
    const hash = digest(credential), program = this.programs.find(p => timingSafeEqual(hash, role === 'observer' ? p.observer : p.bridge));
    if (!program) throw new ContractError('AUTH_REQUIRED', '宿主桥接程序凭据无效');
    const principal = Object.freeze({ owner: program.owner, host_connection_id: program.connection, role }); this.issued.add(principal); return principal;
  }
  assert(principal: TrustedHostPrincipal, role?: TrustedHostPrincipal['role']): void {
    if (!principal || !this.issued.has(principal) || (role && principal.role !== role)) throw new ContractError('AUTH_REQUIRED', '观察来源未经受信桥接程序认证');
  }
}
