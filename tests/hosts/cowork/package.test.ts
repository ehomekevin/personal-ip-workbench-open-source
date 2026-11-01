import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildPackage, withPackageFixture, jsonFile, inspectZip } from '../codex/package-fixture.ts';

test('Cowork / Code 共享私有 ZIP 不含 chat-only manifest、bin 或远程 loopback 配置', async () => withPackageFixture(async fixture => {
  const out = join(fixture.root, 'out'); buildPackage('claude', fixture, out);
  const files = inspectZip(join(out, 'personal-ip-workbench-claude-plugin-0.1.0.zip'));
  assert.ok(files.includes('.claude-plugin/plugin.json') && files.includes('.mcp.json'));
  assert.ok(!files.includes('manifest.json') && !files.some(path => path.startsWith('bin/')));
  const config = await jsonFile(join(out, 'plugin/.mcp.json'));
  const server = config.mcpServers['personal-ip-workbench'];
  assert.deepEqual(server.args, ['${CLAUDE_PLUGIN_ROOT}/server/server.mjs']);
  assert.equal(server.env.WORKBENCH_EXPECTED_HOST_SURFACES, 'claude_cowork,claude_code');
  assert.equal(server.url, undefined);
  assert.equal(server.env.WORKBENCH_CONNECTION_PATH, undefined);
}));
