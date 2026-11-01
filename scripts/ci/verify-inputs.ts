import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './common.ts';

const required = ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.gitleaks.toml', 'pnpm-lock.yaml',
  'docs/architecture.md', 'assets/visual-theme.json', 'packages/adapters/src/media/render/preset.json',
  'packages/domain/src/artifact-execution/image-studio/skills/wechat-image-plan/SKILL.md',
  'packages/domain/src/speech-input/skills/speech-cleanup/SKILL.md',
  'scripts/runtime/init-workspace.ts', 'tests/foundation/wp-07/foundation.test.ts'];
for (const name of required) if (!existsSync(join(projectRoot, name))) throw new Error('Missing distribution input: ' + name);
if (!readFileSync(join(projectRoot, 'LICENSE'), 'utf8').startsWith('MIT License')) throw new Error('Project license must be MIT');
for (const directory of ['docs/evidence', 'baselines', 'brand-assets'])
  if (existsSync(join(projectRoot, directory))) throw new Error('Private historical material is not part of the source distribution: ' + directory);
const scripts = JSON.stringify(JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).scripts);
if (scripts.includes('docs/evidence')) throw new Error('A test entry point still depends on private historical evidence');
console.log(JSON.stringify({ result: 'passed', checked: required.length, scope: 'public_distribution_inputs_not_historical_private_baseline' }));
