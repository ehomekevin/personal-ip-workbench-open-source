import { createMcpHostBridge } from '../core/index.ts';

export const CODEX_DESKTOP_HOST_PROFILE = Object.freeze({
  surface: 'codex_desktop',
  installation_form: 'agent_plugins_v1',
  visual_target: true,
  connection_mode: 'local_stdio',
  native_task_tracking: 'unverified',
  native_session_output: 'unverified',
} as const);

type SharedOptions = Parameters<typeof createMcpHostBridge>[0];
export type CodexBridgeOptions = Omit<SharedOptions, 'hostSurface' | 'connectionMode'>;

// 仅绑定可审查的本机入口；能力仍由真实宿主与主服务上下文决定。
export function createCodexHostBridge(options: CodexBridgeOptions) {
  return createMcpHostBridge({ ...options, hostSurface: 'codex_desktop', connectionMode: 'local_stdio' });
}
