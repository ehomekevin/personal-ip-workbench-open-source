import test from 'node:test';
import { createCoworkHostBridge } from '../../../packages/host-bridge/src/cowork/index.ts';
import { verifySurfaceBoundary } from '../codex/bridge-fixture.ts';
test('Cowork bridge 单独核对本机 surface 与工作区', () => verifySurfaceBoundary(createCoworkHostBridge, 'claude_cowork'));
