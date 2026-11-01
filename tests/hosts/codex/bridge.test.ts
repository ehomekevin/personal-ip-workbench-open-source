import test from 'node:test';
import { createCodexHostBridge } from '../../../packages/host-bridge/src/codex/index.ts';
import { verifySurfaceBoundary } from './bridge-fixture.ts';
test('Codex bridge 拒绝其它 surface、remote 与错误工作区', () => verifySurfaceBoundary(createCodexHostBridge, 'codex_desktop'));
