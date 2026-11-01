import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectPackage } from '../../codex/scripts/package-lib.mjs';
const out = resolve(process.argv[2] ?? '.ci-artifacts/plugins/claude');
await inspectPackage(join(out, 'plugin'), 'claude');
await inspectPackage(join(out, 'desktop'), 'mcpb');
for (const [command, args] of [
  ['claude', ['plugin', 'validate', '--strict', '--json', join(out, 'plugin')]],
  ['npm', ['exec', '--yes', '--package=@anthropic-ai/mcpb@2.1.2', '--', 'mcpb', 'validate', join(out, 'desktop/manifest.json')]],
  ['python3', ['-m', 'zipfile', '-t', join(out, 'personal-ip-workbench-claude-plugin-0.1.0.zip')]],
  ['python3', ['-m', 'zipfile', '-t', join(out, 'personal-ip-workbench-claude-desktop-0.1.0.mcpb')]],
]) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  if (command === 'claude' && !JSON.parse(result.stdout).success) throw new Error('Claude strict validator rejected package');
}
process.stdout.write(JSON.stringify({ result: 'passed', grade: 'internal_rule', claude_plugin_strict: 'passed', mcpb_schema: 'passed', archive_crc: 'passed', actual_host_installation: 'not_run' }) + '\n');
