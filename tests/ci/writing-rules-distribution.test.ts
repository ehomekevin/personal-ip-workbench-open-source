import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeWritingRules, ruleBindings } from '../../packages/domain/src/writing-flow/rules.ts';
import { sha256 } from '../../packages/storage/src/connection/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';

test('default writing rules freeze without a private home skill, source vault or historical samples', () => {
  const snapshot = freezeWritingRules({ paths: { source_vault_root: null } } as ApplicationContext);
  assert.equal(snapshot.skill.name, 'personal-ip-writing');
  assert.equal(snapshot.skill.sha256, sha256(snapshot.skill.content));
  assert.ok(snapshot.files.length > 0);
  for (const file of snapshot.files) assert.equal(file.sha256, sha256(file.content));
  assert.deepEqual(ruleBindings(snapshot).writing_skills, [snapshot.skill]);
  assert.equal(snapshot.files.some(file => file.kind === 'style_reference'), false);
  assert.equal(freezeWritingRules({ paths: { source_vault_root: null } } as ApplicationContext).id, snapshot.id);
});
