// Loaded only by the portable node:test command; production has no bypass flag.
import { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { dirname, relative, resolve, sep } from 'node:path';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as production from '../../packages/storage/src/connection/index.ts';
import { ContractError } from '../../packages/contracts/src/index.ts';

const projectRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
// The local portable run still verifies the actual configured external volume.
if (process.platform === 'darwin') production.assertStorageRoot(projectRoot);
function assertFixtureRoot(path: string) {
  const actual = realpathSync(path), part = relative(projectRoot, actual);
  if (resolve(path) !== actual || (part !== '' && !part.startsWith('tests' + sep) && !part.startsWith('.ci-artifacts' + sep)) || statSync(actual).dev !== statSync(projectRoot).dev)
    throw new ContractError('STORAGE_UNAVAILABLE', '可移植测试只能使用本次仓库中的隔离 fixture');
}
function openFixtureStorage(databasePath: string): production.WorkspaceStorage {
  const parent = dirname(databasePath); assertFixtureRoot(parent);
  if (realpathSync(parent) === projectRoot) throw new ContractError('STORAGE_UNAVAILABLE', '测试数据库不能写入仓库根');
  let file: ReturnType<typeof lstatSync> | undefined;
  try { file = lstatSync(databasePath); } catch (error) {
    if ((error as {code?:string}).code !== 'ENOENT') throw error;
  }
  if (file) {
    if (file.isSymbolicLink() || !file.isFile() || realpathSync(databasePath) !== resolve(databasePath))
      throw new ContractError('STORAGE_UNAVAILABLE', '测试数据库必须是隔离目录中的普通文件');
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath, { timeout: 1000 }); production.configureDatabase(db);
    const migration = production.migrateDatabase(db), connection = db;
    return { db: connection, path: databasePath, migration, close: () => connection.close() };
  } catch (error) { db?.close(); throw error; }
}
mock.module(new URL('../../packages/storage/src/connection/index.ts', import.meta.url).href, {
  exports: { ...production, assertStorageRoot: assertFixtureRoot, openWorkspaceStorage: openFixtureStorage },
});
