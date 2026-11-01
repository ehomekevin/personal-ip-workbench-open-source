import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspectPackage } from './package-lib.mjs';
const out = resolve(process.argv[2] ?? '.ci-artifacts/plugins/codex');
const root = join(out, 'personal-ip-workbench');
await inspectPackage(root, 'codex');
const schemas = fileURLToPath(new URL('../validation/', import.meta.url));
for (const file of ['plugin', 'mcp']) {
  const result = spawnSync('npm', ['exec', '--yes', '--package=ajv-cli@5.0.0', '--', 'ajv', 'validate', '--spec=draft2020', '-s', join(schemas, file + '.schema.json'), '-d', join(root, file + '.json')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
const zip = spawnSync('python3', ['-m', 'zipfile', '-t', join(out, 'personal-ip-workbench-codex-0.1.0.zip')], { encoding: 'utf8' });
if (zip.status !== 0) throw new Error(zip.stderr || zip.stdout);
process.stdout.write(JSON.stringify({ result: 'passed', grade: 'internal_rule', plugin_schema: 'Agent Plugins 1.0.0', mcp_schema: 'Agent Plugins 1.0.0', archive_crc: 'passed', actual_host_installation: 'not_run' }) + '\n');
