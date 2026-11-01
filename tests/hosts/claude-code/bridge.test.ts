import test from 'node:test';
import { createClaudeCodeHostBridge } from '../../../packages/host-bridge/src/claude-code/index.ts';
import { verifySurfaceBoundary } from '../codex/bridge-fixture.ts';
test('Code bridge 工具通过不提升其它 Claude surface', () => verifySurfaceBoundary(createClaudeCodeHostBridge, 'claude_code'));
