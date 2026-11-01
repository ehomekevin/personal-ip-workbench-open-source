import { join } from 'node:path';
import { assertExternalVolume } from '../probes/runtime/mount-guard.ts';
import { artifactDirectory, projectRoot, runCommand, saveJson } from './common.ts';

const local = process.argv.includes('--local');
if (local || process.platform === 'darwin') assertExternalVolume(projectRoot);
const root = artifactDirectory(local ? 'local' : 'checks');
const steps: unknown[] = [];
let result = 'failed';
try {
  for (const [label, args] of [
    ['source-distribution', ['check:source']], ['workspaces-typecheck', ['typecheck']],
    ['test-tools-typecheck', ['typecheck:ci']], ['portable-rules', ['test:portable']],
    ...(local ? [['plugin-build', ['build:plugins']], ['local-integration', ['test:integration']], ['local-e2e', ['test:e2e']], ['plugin-browser', ['test:e2e:plugins']]] : []),
  ] as [string, string[]][]) {
    steps.push(await runCommand('pnpm', args, { root, label, env: { WORKBENCH_CI_ARTIFACT_ROOT: root } }));
  }
  result = 'passed';
} finally {
  saveJson(join(root, 'summary.json'), { result, scope: local ? 'local_internal_and_browser' : 'portable_static_and_internal_rules', steps, external_provider_platform_and_host_acceptance: 'not_run' });
  console.log('验证记录：' + root);
}
