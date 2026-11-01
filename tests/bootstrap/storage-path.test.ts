import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openWorkspaceStorage } from '../../packages/storage/src/connection/index.ts';

test('real SQLite uses only a canonical physical path and refuses database links before opening', () => {
  const root = mkdtempSync(join(resolve('tests/bootstrap'), '.storage-path-'));
  try {
    const state = join(root, 'state'); mkdirSync(state);
    const path = join(state, 'workbench.sqlite');
    const storage = openWorkspaceStorage(path);
    storage.db.exec('CREATE TABLE public_fixture(value TEXT); INSERT INTO public_fixture VALUES (\'saved\')');
    storage.close();
    const reopened = openWorkspaceStorage(path);
    assert.equal(reopened.db.prepare('SELECT value FROM public_fixture').get()?.value, 'saved');
    reopened.close();
    const alias = join(root, 'alias'); symlinkSync(state, alias);
    assert.throws(() => openWorkspaceStorage(join(alias, 'workbench.sqlite')));
    assert.throws(() => openWorkspaceStorage(root + '/alias/../state/workbench.sqlite'));
    symlinkSync(path, join(state, 'linked.sqlite'));
    assert.throws(() => openWorkspaceStorage(join(state, 'linked.sqlite')));
    const missing = join(root, 'missing.sqlite'); symlinkSync(missing, join(state, 'dangling.sqlite'));
    assert.throws(() => openWorkspaceStorage(join(state, 'dangling.sqlite')));
    assert.equal(existsSync(missing), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
