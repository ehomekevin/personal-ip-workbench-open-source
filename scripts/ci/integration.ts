import { join } from 'node:path';
import { assertExternalVolume } from '../probes/runtime/mount-guard.ts';
import { artifactDirectory, projectRoot, runCommand, saveJson } from './common.ts';

// Exercise real local storage and service processes in isolated test directories.
assertExternalVolume(projectRoot);
const root = artifactDirectory('integration');
const steps: unknown[] = [];
let result = 'failed';
try {
  steps.push(await runCommand(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=90000', 'tests/foundation/wp-07/foundation.test.ts'], { root, label: 'foundation', env: { WORKBENCH_TEST_EVIDENCE_DIR: join(root, 'wp07') } }));
  steps.push(await runCommand(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=90000', 'tests/bootstrap/*.test.ts'], { root, label: 'runtime-regressions', env: { WORKBENCH_TEST_EVIDENCE_DIR: join(root, 'runtime') } }));
  steps.push(await runCommand(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=90000', 'tests/documents/*.test.ts', 'tests/settings/*.test.ts'], { root, label: 'persistence', env: { WORKBENCH_TEST_EVIDENCE_DIR: join(root, 'wp08') } }));
  steps.push(await runCommand(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=90000', 'tests/foundation/wp-07/D07-006/*.test.ts', 'tests/job-recovery/*.test.ts'], { root, label: 'durable-jobs', env: { WORKBENCH_TEST_EVIDENCE_DIR: join(root, 'wp09') } }));
  steps.push(await runCommand(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=120000', 'tests/ingest-index/*.test.ts', 'tests/metrics/*.test.ts', 'tests/comparisons/*.test.ts', 'tests/service-agent/*.test.ts', 'tests/retro-adoption/*.test.ts', 'tests/daily-plans/*.test.ts'], { root, label: 'data-retro-agents', env: { WORKBENCH_TEST_EVIDENCE_DIR: join(root, 'wp11-15') } }));
  steps.push(await runCommand(process.execPath,['--test','--test-concurrency=1','--test-timeout=240000','tests/content-workflows/*.test.ts','tests/host-runs/*.test.ts','tests/plans/*.test.ts','tests/media-artifacts/*.test.ts','tests/publication-domain/*.test.ts'],{root,label:'content-production-publishing',env:{WORKBENCH_TEST_EVIDENCE_DIR:join(root,'wp16-20')}}));
  steps.push(await runCommand('pnpm',['test:plugins'],{root,label:'platform-adapters-and-stdio-mcp',env:{WORKBENCH_TEST_EVIDENCE_DIR:join(root,'wp21-25')}}));
  result = 'passed';
} finally {
  saveJson(join(root, 'summary.json'), { result, scope: 'actual_local_SQLite_Markdown_HTTP_and_process_recovery', steps, provider_platform_host_and_complete_business_cases: 'not_run' });
}
