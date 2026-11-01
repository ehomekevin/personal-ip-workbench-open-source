import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { validateStorageDirectory } from '../../packages/storage/src/connection/storage-root.ts';

test('portable storage rejects relative, missing, symlink and file roots without creating a fallback', () => {
  const root = mkdtempSync(join(resolve('tests'), '.storage-policy-'));
  try {
    const directory = join(root, 'state'), link = join(root, 'alias'), file = join(root, 'file');
    mkdirSync(directory); writeFileSync(file, 'fixture'); symlinkSync(directory, link);
    validateStorageDirectory(directory);
    assert.throws(() => validateStorageDirectory('relative'));
    assert.throws(() => validateStorageDirectory(join(root, 'missing')));
    assert.throws(() => validateStorageDirectory(link));
    assert.throws(() => validateStorageDirectory(root + '/alias/../state'), 'dot segments must not erase symlink traversal before validation');
    assert.throws(() => validateStorageDirectory(file));
    rmSync(directory, { recursive: true });
    assert.throws(() => validateStorageDirectory(directory), 'a removed root cannot use a cached success');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
