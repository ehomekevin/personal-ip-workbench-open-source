import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { configureDatabase, migrateDatabase, transaction } from '../../packages/storage/src/connection/index.ts';

function database() { const db = new DatabaseSync(':memory:'); configureDatabase(db); return db; }
test('真实 SQLite 逐版迁移保留工作区，重复执行不追加迁移', () => {
  const db = database();
  try {
    assert.deepEqual(migrateDatabase(db, { targetVersion: 1 }).applied, [1]);
    db.prepare('INSERT INTO workspaces (id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,?,?,?,?,?)').run('workspace', 'workspace', '迁移前内容', 'Asia/Shanghai', '{}', 'demo', 1);
    assert.deepEqual(migrateDatabase(db, { targetVersion: 3 }).applied, [2, 3]);
    assert.deepEqual(migrateDatabase(db).applied, [4, 5, 6, 7, 8, 9]);
    assert.equal(db.prepare('SELECT title FROM workspaces').get()!.title, '迁移前内容');
    assert.deepEqual(migrateDatabase(db).applied, []);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n, 9);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
test('实际迁移登记哈希篡改与降级被拒绝', () => {
  const db = database();
  try {
    migrateDatabase(db);
    assert.throws(() => migrateDatabase(db, { targetVersion: 3 }), /downgrade/);
    db.prepare('UPDATE schema_migrations SET sha256=? WHERE version=4').run('bad-checksum');
    assert.throws(() => migrateDatabase(db), /checksum mismatch/);
  } finally { db.close(); }
});
test('失败事务与异步误用都回滚已写入数据', () => {
  const db = database();
  try {
    db.exec('CREATE TABLE effects (value TEXT) STRICT');
    assert.throws(() => transaction(db, () => { db.exec("INSERT INTO effects VALUES ('rejected')"); throw new Error('abort'); }), /abort/);
    assert.throws(() => transaction(db, () => { db.exec("INSERT INTO effects VALUES ('async')"); return Promise.resolve(); }), /asynchronous/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM effects').get()!.n, 0);
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});
