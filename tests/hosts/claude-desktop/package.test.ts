import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildPackage, withPackageFixture, jsonFile, inspectZip } from '../codex/package-fixture.ts';

test('Desktop chat 独立 MCPB 使用内置 Node24 与用户选择的外部 descriptor', async () => withPackageFixture(async fixture => {
  const first = join(fixture.root, 'first'), second = join(fixture.root, 'second');
  buildPackage('claude', fixture, first); buildPackage('claude', fixture, second);
  const file = 'personal-ip-workbench-claude-desktop-0.1.0.mcpb';
  assert.deepEqual(await readFile(join(first, file)), await readFile(join(second, file)));
  const files = inspectZip(join(first, file)); assert.ok(files.includes('manifest.json') && !files.includes('.claude-plugin/plugin.json'));
  const manifest = await jsonFile(join(first, 'desktop/manifest.json'));
  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.entry_point, 'server/server.mjs');
  assert.equal(manifest.compatibility.runtimes.node, '>=24.0.0');
  assert.equal(manifest.user_config.connection_descriptor.type, 'file');
  assert.equal(manifest.user_config.connection_descriptor.required, true);
  assert.equal(manifest.server.mcp_config.env.WORKBENCH_CONNECTION_PATH, '${user_config.connection_descriptor}');
  assert.equal(manifest.server.mcp_config.env.WORKBENCH_EXPECTED_HOST_SURFACES, 'claude_desktop_chat');
}));
