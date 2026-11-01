import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { configureDatabase, migrateDatabase } from '../../../../packages/storage/src/connection/index.ts';
import { CancelJobSchema, ResumeJobSchema, ContractError } from '../../../../packages/contracts/src/index.ts';

test('D07-006 upgrades v4 receipts without inventing output and keeps prior checksums', () => {
  const db = new DatabaseSync(':memory:'); configureDatabase(db);
  try {
    migrateDatabase(db, { targetVersion: 4 });
    const hashes = db.prepare('SELECT version,sha256 FROM schema_migrations ORDER BY version').all();
    db.prepare("INSERT INTO workspaces (id,workspace_id,title,timezone,paths,mode,version) VALUES ('w','w','隔离迁移','UTC','{}','demo',1)").run();
    db.prepare(`INSERT INTO jobs (id,workspace_id,kind,entrypoint,execution_mode,attempt_generation,input_manifest,input_hash,state,retry_policy,presentation,version)
      VALUES ('j','w','draft','standalone_web','service_adapter',0,'{}',?,'queued','{}','background',1)`).run('a'.repeat(64));
    db.prepare(`INSERT INTO job_attempts (id,workspace_id,job_id,attempt_no,attempt_generation,state,lease_owner,lease_until,checkpoint)
      VALUES ('a','w','j',1,1,'active','worker','2026-10-11T00:00:00.000Z','{}')`).run();
    db.prepare("UPDATE jobs SET current_attempt_id='a',attempt_generation=1,state='running' WHERE id='j'").run();
    db.prepare(`INSERT INTO result_receipts (id,workspace_id,job_id,attempt_id,attempt_generation,input_hash,output_hash,commit_purpose,state,result_ids,idempotency_requests)
      VALUES ('r','w','j','a',1,?,?,'document_edit','pending','[]','[]')`).run('a'.repeat(64), 'b'.repeat(64));
    const old = db.prepare('SELECT * FROM result_receipts').get()!;
    assert.deepEqual(migrateDatabase(db, { targetVersion: 5 }).applied, [5]);
    const upgraded = db.prepare('SELECT * FROM result_receipts').get()!;
    assert.equal(upgraded.output_payload, null);
    const { output_payload: _payload, ...preserved } = upgraded;
    assert.deepEqual(preserved, { ...old });
    assert.deepEqual(db.prepare('SELECT version,sha256 FROM schema_migrations WHERE version<5 ORDER BY version').all(), hashes);
    assert.throws(() => db.prepare('UPDATE result_receipts SET output_payload=? WHERE id=?').run('{}', 'r'), /FIXED_PROVENANCE/);
    assert.deepEqual(migrateDatabase(db, { targetVersion: 5 }).applied, []);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 5);
  } finally { db.close(); }
});

test('D07-006 cancel/resume validate version, fields and recovery identities', () => {
  assert.deepEqual(CancelJobSchema.parse({ expected_version: 1 }), { expected_version: 1 });
  assert.deepEqual(ResumeJobSchema.parse({ expected_version: 2, input: { credential_ready: true }, executor: 'codex' }),
    { expected_version: 2, input: { credential_ready: true }, executor: 'codex' });
  for (const body of [{}, { expected_version: 0 }, { expected_version: 1, text: 'replace frozen input' }, { expected_version: 1.5 }])
    assert.throws(() => CancelJobSchema.parse(body), ContractError);
  for (const body of [{ expected_version: 1, execution_mode: 'host_session' }, { expected_version: 1, executor: '' },
    { expected_version: 1, native_task_binding_id: ' ' }, { expected_version: 1, input: [] }])
    assert.throws(() => ResumeJobSchema.parse(body), ContractError);
});
