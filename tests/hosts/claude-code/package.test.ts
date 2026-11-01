import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildPackage, withPackageFixture, jsonFile } from '../codex/package-fixture.ts';

test('Code 共用包不注册 hooks/agents/observer，生命周期不包含业务数据路径', async () => withPackageFixture(async fixture => {
  const out = join(fixture.root, 'out'); buildPackage('claude', fixture, out);
  const manifest = await jsonFile(join(out, 'plugin/.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'personal-ip-workbench');
  assert.equal(manifest.hooks, undefined); assert.equal(manifest.agents, undefined);
  const artifact = await jsonFile(join(out, 'artifact-manifest.json'));
  assert.equal(artifact.installation, 'not_run');
  for (const packageInfo of artifact.artifacts) for (const entry of packageInfo.inventory) {
    assert.ok(!/descriptor|sqlite|credential|connection\.json/.test(entry.path));
    assert.ok(!entry.path.startsWith('/'));
  }
}));
