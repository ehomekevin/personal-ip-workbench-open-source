import assert from 'node:assert/strict';
import { CONTRACT_VERSION } from '../../../packages/contracts/src/index.ts';
import type { McpHostBridgeOptions, McpHostBridge } from '../../../packages/host-bridge/src/core/index.ts';

const identity = { service_instance_id: 'test-service', workspace_id: 'test-workspace', contract_version: CONTRACT_VERSION };
type Factory = (options: Omit<McpHostBridgeOptions, 'hostSurface' | 'connectionMode'>) => Promise<McpHostBridge>;
function appFixture(surface: string, connectionMode = 'local_stdio'): McpHostBridgeOptions['app'] {
  return {
    async callServerTool(request: { name: string }) {
      assert.equal(request.name, 'get_context');
      return { content: [], structuredContent: { identity, data: { identity, capabilities: [], host: { surface, runtime_version: 'fixture/0.1.0', connection_mode: connectionMode, plugin_version: '0.1.0' }, standalone_url: null }, request_id: 'fixture-request' } };
    },
    getHostContext: () => ({ availableDisplayModes: ['inline', 'fullscreen'] }),
    getHostCapabilities: () => ({ openLinks: {} }),
  } as unknown as McpHostBridgeOptions['app'];
}

export async function verifySurfaceBoundary(factory: Factory, surface: string) {
  const bridge = await factory({ app: appFixture(surface), expectedIdentity: identity });
  assert.equal(bridge.requestDisplayMode, undefined, 'MCP Apps 广告不提升未验证的 fullscreen');
  assert.equal(bridge.openExternal, undefined, 'MCP Apps 广告不提升未验证的 external_link');
  assert.deepEqual((await bridge.describeCapabilities()).identity, identity);
  await assert.rejects(() => factory({ app: appFixture('wrong_surface'), expectedIdentity: identity }), { code: 'WORKSPACE_INSTANCE_MISMATCH' });
  await assert.rejects(() => factory({ app: appFixture(surface, 'remote_cloud'), expectedIdentity: identity }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(() => factory({ app: appFixture(surface), expectedIdentity: { ...identity, workspace_id: 'another-workspace' } }), { code: 'WORKSPACE_INSTANCE_MISMATCH' });
}
