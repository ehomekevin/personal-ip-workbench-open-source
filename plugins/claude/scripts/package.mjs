import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBuildArgs, copyTemplate, stageRuntime, archivePackage } from '../../codex/scripts/package-lib.mjs';
const options = parseBuildArgs(process.argv.slice(2));
await mkdir(options.out, { recursive: false });
const artifacts = [];
for (const [folder, form, extension] of [['desktop', 'mcpb', 'mcpb'], ['plugin', 'claude', 'zip']]) {
  const root = join(options.out, folder);
  await copyTemplate(fileURLToPath(new URL('../' + folder, import.meta.url)), root);
  await stageRuntime(root, options);
  artifacts.push({ package_form: form, host_surfaces: form === 'mcpb' ? ['claude_desktop_chat'] : ['claude_cowork', 'claude_code'], ...await archivePackage(root, join(options.out, `personal-ip-workbench-claude-${folder}-0.1.0.${extension}`), form) });
}
await writeFile(join(options.out, 'artifact-manifest.json'), JSON.stringify({ plugin_id: 'personal-ip-workbench', plugin_version: '0.1.0', node_target: 24, installation: 'not_run', artifacts }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ artifacts: artifacts.map(({ file, sha256 }) => ({ file, sha256 })), installation: 'not_run' }) + '\n');
