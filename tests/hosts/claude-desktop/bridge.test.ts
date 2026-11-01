import test from 'node:test';
import { createClaudeDesktopHostBridge } from '../../../packages/host-bridge/src/claude-desktop/index.ts';
import { verifySurfaceBoundary } from '../codex/bridge-fixture.ts';
test('Desktop chat bridge 不接受 Cowork/Code 或云连接身份', () => verifySurfaceBoundary(createClaudeDesktopHostBridge, 'claude_desktop_chat'));
