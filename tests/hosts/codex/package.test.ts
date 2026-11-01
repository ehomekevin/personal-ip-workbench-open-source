import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { inspectPackage } from '../../../plugins/codex/scripts/package-lib.mjs';
import { buildPackage, withPackageFixture, jsonFile, inspectZip } from './package-fixture.ts';

test('Codex 包保持 portable schema、宿主隔离和确定性 ZIP', async () => withPackageFixture(async fixture => {
  const first = join(fixture.root, 'first'), second = join(fixture.root, 'second');
  buildPackage('codex', fixture, first); buildPackage('codex', fixture, second);
  const name = 'personal-ip-workbench-codex-0.1.0.zip';
  assert.deepEqual(await readFile(join(first, name)), await readFile(join(second, name)));
  const files = inspectZip(join(first, name));
  assert.ok(files.includes('plugin.json') && files.includes('mcp.json') && files.includes('ui/workbench.html'));
  assert.ok(!files.includes('.mcp.json') && !files.includes('manifest.json'));
  const mcp = await jsonFile(join(first, 'personal-ip-workbench/mcp.json'));
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(mcp.mcpServers['personal-ip-workbench'].args, ['${PLUGIN_ROOT}/server/server.mjs']);
  assert.equal(mcp.mcpServers['personal-ip-workbench'].env.WORKBENCH_EXPECTED_HOST_SURFACES, 'codex_desktop');
}));

test('包拒绝 descriptor、绝对用户路径和符号链接，失败不触及服务数据', async () => withPackageFixture(async fixture => {
  const out = join(fixture.root, 'out'); buildPackage('codex', fixture, out);
  const root = join(out, 'personal-ip-workbench');
  await writeFile(join(root, 'connection.json'), '{}');
  await assert.rejects(() => inspectPackage(root, 'codex'), /forbidden/);
  await rm(join(root, 'connection.json'));
  await writeFile(join(root, 'server/server.mjs'), 'const accidentalUserPath = "/Users/private/workspace";');
  await assert.rejects(() => inspectPackage(root, 'codex'), /Nonportable path/);
  await writeFile(join(root, 'server/server.mjs'), 'export const packagingFixtureOnly = true;');
  const target = join(fixture.root, 'private-data.sqlite'); await writeFile(target, 'service-owned sentinel');
  await symlink(target, join(root, 'secret-link'));
  await assert.rejects(() => inspectPackage(root, 'codex'), /symlink/);
  assert.equal(await readFile(target, 'utf8'), 'service-owned sentinel');
}));
