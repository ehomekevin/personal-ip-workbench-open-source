import { readFileSync } from 'node:fs';
import { sha256 } from '@workbench/storage/connection';
import { readWritingSkill } from '@workbench/adapters/agent/codex';
import type { JsonObject } from '@workbench/contracts';

export function freezeCoreWritingSkill(): JsonObject {
  const content = readFileSync(new URL('./skills/workbench-core-writing/SKILL.md', import.meta.url), 'utf8');
  const binding = { name: 'workbench-core-writing', version: '1.1.0', sha256: sha256(content), content };
  readWritingSkill({ frozen: { content_purpose: 'core', writing_skill: binding } });
  return binding;
}
