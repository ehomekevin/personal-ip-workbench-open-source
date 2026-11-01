import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('实际公共复盘 dispatch：迟到账号与外层读取均不能覆盖新平台', () => {
  const probe = fileURLToPath(new URL('./fixtures/data-composition-race.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = result.stdout.trim().split('\n');
  const totals = JSON.parse(lines.at(-1)!);
  assert.deepEqual(totals, { total: 2, passed: 2, failed: 0, grade: 'internal_rule' });
});
