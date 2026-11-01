import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

export async function withPackageFixture(test: (fixture: { root: string; server: string; ui: string; skills: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-host-package-'));
  try {
    const skills = join(root, 'skills');
    await mkdir(join(skills, 'open-workbench'), { recursive: true });
    await writeFile(join(skills, 'open-workbench/SKILL.md'), '---\nname: open-workbench\ndescription: Open the shared workbench.\n---\nCall the registered `open_workbench` tool.\n');
    const server = join(root, 'server.mjs'), ui = join(root, 'workbench.html');
    // 包格式测试输入；不将这个空程序记为 MCP 或宿主实测。
    await writeFile(server, 'export const packagingFixtureOnly = true;\n');
    await writeFile(ui, '<!doctype html><html><body>Packaging fixture only</body></html>\n');
    await test({ root, server, ui, skills });
  } finally { await rm(root, { recursive: true, force: true }); }
}

export function buildPackage(kind: 'codex' | 'claude', fixture: { server: string; ui: string; skills: string }, out: string) {
  const result = spawnSync(process.execPath, [`plugins/${kind}/scripts/package.mjs`, '--server', fixture.server, '--ui', fixture.ui, '--skills', fixture.skills, '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

export async function jsonFile(path: string): Promise<Record<string, any>> { return JSON.parse(await readFile(path, 'utf8')); }

export function inspectZip(path: string) {
  const script = 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n assert all(i.date_time==(1980,1,1,0,0,0) for i in z.infolist())\n print(json.dumps(z.namelist()))\n';
  const result = spawnSync('python3', ['-c', script, path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as string[];
}
