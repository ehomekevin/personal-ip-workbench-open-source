import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { configureDatabase, migrateDatabase } from '../../../../packages/storage/src/connection/index.ts';
import { IndexRunSchema, CreateSourceRecordSchema, ImportExistingWorkSchema, CollectionSchema, ContractError } from '../../../../packages/contracts/src/index.ts';

test('D07-007 v5→v6 保留正文身份和旧迁移哈希，重放不重复升级', () => {
  const db = new DatabaseSync(':memory:'); configureDatabase(db);
  try {
    migrateDatabase(db, { targetVersion: 5 });
    const registry = db.prepare('SELECT version,sha256 FROM schema_migrations ORDER BY version').all();
    db.exec("INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES('w','w','原工作区','UTC','{}','demo',1)");
    db.exec("INSERT INTO sources(id,workspace_id,kind,url,schema_version) VALUES('s','w','manual','https://example.org','v1')");
    db.exec("INSERT INTO source_records(id,workspace_id,source_id,external_id,record_kind,content_status) VALUES('r','w','s','original','article','available')");
    assert.deepEqual(migrateDatabase(db,{targetVersion:6}).applied, [6]);
    assert.equal(db.prepare('SELECT external_id FROM source_records').get()!.external_id, 'original');
    assert.equal(db.prepare('SELECT payload FROM source_records').get()!.payload, '{}');
    assert.deepEqual(db.prepare('SELECT version,sha256 FROM schema_migrations WHERE version<6 ORDER BY version').all(), registry);
    assert.throws(() => db.exec("INSERT INTO source_records(id,workspace_id,source_id,external_id,record_kind,content_status) VALUES('r2','w','s','original','article','available')"), /UNIQUE/);
    assert.deepEqual(migrateDatabase(db,{targetVersion:6}).applied, []);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('D07-007 历史唯一身份冲突使整次升级回滚，不删记录', () => {
  const db = new DatabaseSync(':memory:'); configureDatabase(db);
  try {
    migrateDatabase(db, { targetVersion: 5 });
    db.exec("INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES('w','w','原工作区','UTC','{}','demo',1)");
    db.exec("INSERT INTO sources(id,workspace_id,kind,url,schema_version) VALUES('s1','w','manual','https://example.org','v1'),('s2','w','manual','https://example.org','v1')");
    const before = db.prepare('SELECT * FROM sources ORDER BY id').all();
    assert.throws(() => migrateDatabase(db,{targetVersion:6}), /UNIQUE/);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 5);
    assert.equal(db.prepare("SELECT name FROM pragma_table_info('source_records') WHERE name='payload'").get(), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM sources ORDER BY id').all(), before);
  } finally { db.close(); }
});

test('D07-007 HTTP 输入拒绝越界批量、非字符串 roots 和非法指标窗口', () => {
  assert.equal(IndexRunSchema.parse({ roots: ['/configured/vault'], mode: 'incremental', batch_size: 500 }).batch_size, 500);
  for (const input of [{ roots: [5], mode: 'initial' }, { roots: [], mode: 'initial' }, { roots: ['x'], mode: 'initial', batch_size: 501 }])
    assert.throws(() => IndexRunSchema.parse(input), ContractError);
  assert.throws(() => CreateSourceRecordSchema.parse({ title: '只有标题' }), ContractError);
  assert.throws(() => ImportExistingWorkSchema.parse({ platform: 'x' }), ContractError);
  assert.throws(() => CollectionSchema.parse({ target_window: 48 }), ContractError);
  assert.deepEqual(CollectionSchema.parse({ target_window: null }), { target_window: null });
});
