import { createMcpHostBridge } from '../core/index.ts';

export const CLAUDE_COWORK_HOST_PROFILE = Object.freeze({
  surface: 'claude_cowork',
  installation_form: 'claude_plugin',
  visual_target: true,
  connection_mode: 'local_stdio',
  native_task_tracking: 'unverified',
  native_session_output: 'unverified',
} as const);

type SharedOptions = Parameters<typeof createMcpHostBridge>[0];
export type CoworkBridgeOptions = Omit<SharedOptions, 'hostSurface' | 'connectionMode'>;

// 仅绑定可审查的本机入口；能力仍由真实宿主与主服务上下文决定。
export function createCoworkHostBridge(options: CoworkBridgeOptions) {
  return createMcpHostBridge({ ...options, hostSurface: 'claude_cowork', connectionMode: 'local_stdio' });
}
