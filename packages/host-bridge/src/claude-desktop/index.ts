import { createMcpHostBridge } from '../core/index.ts';

export const CLAUDE_DESKTOP_CHAT_HOST_PROFILE = Object.freeze({
  surface: 'claude_desktop_chat',
  installation_form: 'mcpb_0_3',
  visual_target: true,
  connection_mode: 'local_stdio',
  native_task_tracking: 'unverified',
  native_session_output: 'unverified',
} as const);

type SharedOptions = Parameters<typeof createMcpHostBridge>[0];
export type ClaudeDesktopBridgeOptions = Omit<SharedOptions, 'hostSurface' | 'connectionMode'>;

// 仅绑定可审查的本机入口；能力仍由真实宿主与主服务上下文决定。
export function createClaudeDesktopHostBridge(options: ClaudeDesktopBridgeOptions) {
  return createMcpHostBridge({ ...options, hostSurface: 'claude_desktop_chat', connectionMode: 'local_stdio' });
}
