import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { API_RESOURCES, CONTRACT_VERSION, ERROR_HTTP, PatchSettingsSchema, SaveRevisionSchema, ContractError } from '../../../packages/contracts/src/index.ts';
import { openWorkspaceStorage, configureDatabase, migrateDatabase, transaction, requestHash, outputHash, inputHash, claimIdempotency, lookupIdempotency, commitIdempotency, type WorkspaceStorage } from '../../../packages/storage/src/connection/index.ts';
import { startApplication, type RunningApplication } from '../../../apps/service/src/bootstrap/application.ts';
import { createRouteRegistry } from '../../../apps/service/src/routes/index.ts';
import { SCHEMA_VERSION } from '../../../packages/storage/src/schema/index.ts';
import { validateConfiguration } from '../../../apps/service/src/bootstrap/config.ts';
import type { ApplicationContext, ApplicationModule, ModuleFactory } from '../../../packages/domain/src/ports/index.ts';
const evidenceRoot = resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR ?? '.ci-artifacts/foundation');
mkdirSync(evidenceRoot, { recursive: true });
const startedAt = new Date().toISOString();
const steps: Record<string, unknown>[] = [];
const W = '10ad8e1b-b08f-45e0-9427-4ebfdba4e5ed';
const W2 = '0139ad95-f57f-4d44-933f-4204c6fe66fc';
const S = '7556313d-a8b6-4969-8b8b-d4f0c5bc9d6d';
const H = 'a'.repeat(64);
const registry = JSON.parse(readFileSync(resolve('packages/storage/src/schema/registry.json'), 'utf8')) as Record<string, { fields: Record<string, string> }>;
function record(substep: string, evidence: Record<string, unknown> = {}) { steps.push({ substep, result: 'passed', observed_at: new Date().toISOString(), ...evidence }); }
function insert(db: DatabaseSync, table: string, values: Record<string, string | number | null> = {}) {
  const fields = registry[table]!.fields;
  const row: Record<string, string | number | null> = { id: randomUUID(), workspace_id: W };
  for (const [name, type] of Object.entries(fields)) row[name] = type.endsWith('?') ? null : type[0] === 'n' ? (name === 'version' || name === 'revision_no' || name === 'attempt_no' || name === 'sequence' || name === 'seq' ? 1 : 0) : type[0] === 'b' ? 0 : type[0] === 'j' ? '{}' : (name.endsWith('hash') || name === 'sha256' ? H : 'test');
  if (table === 'source_locations') row.availability = 'available';
  Object.assign(row, values);
  const keys = Object.keys(row); db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]!)); return String(row.id);
}
function workspace(db: DatabaseSync, id = W) { return insert(db, 'workspaces', { id, workspace_id: id, title: '隔离内部规则测试', timezone: 'America/Los_Angeles', paths: '{}', mode: 'demo', version: 1 }); }
function core(db: DatabaseSync) {
  const document = insert(db, 'documents', { kind: 'core', owner_entity_id: null, head_revision_id: null, version: 1 });
  const topic = insert(db, 'topics', { core_document_id: document, status: 'active' });
  const revision = insert(db, 'document_revisions', { document_id: document, file_path: `notes/${randomUUID()}.md`, origin: 'human', change_kind: 'text', created_by: 'test' });
  db.prepare('UPDATE documents SET head_revision_id=? WHERE id=?').run(revision, document);
  return { document, topic, revision };
}
function job(db: DatabaseSync) {
  const id = insert(db, 'jobs', { entrypoint: 'standalone_web', execution_mode: 'service_adapter', state: 'queued', presentation: 'background', target_id: null, attempt_generation: 0 });
  const attempt = insert(db, 'job_attempts', { job_id: id, attempt_generation: 1, state: 'active', lease_owner: 'worker-test', lease_until: '2026-10-10T08:00:00Z' });
  db.prepare("UPDATE jobs SET current_attempt_id=?,attempt_generation=1,state='running' WHERE id=?").run(attempt, id);
  return { id, attempt };
}
function receipt(db: DatabaseSync, j: ReturnType<typeof job>, state = 'pending') { return insert(db, 'result_receipts', { job_id: j.id, attempt_id: j.attempt, attempt_generation: 1, commit_purpose: 'document_edit', state, result_ids: '[]', idempotency_requests: '[]' }); }
function withDb(action: (db: DatabaseSync, storage: WorkspaceStorage, root: string) => void) {
  const root = mkdtempSync(join(evidenceRoot, '.db-')); const storage = openWorkspaceStorage(join(root, 'workbench.sqlite'));
  try { workspace(storage.db); action(storage.db, storage, root); } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
}

test('empty database migrates, replays, reopens and verifies checksums', () => {
  const root = mkdtempSync(join(evidenceRoot, '.migration-')); let db = new DatabaseSync(join(root, 'workbench.sqlite')); configureDatabase(db);
  try {
    const first = migrateDatabase(db, { targetVersion: 1 }); assert.deepEqual(first.applied, [1]); workspace(db);
    const upgraded = migrateDatabase(db); assert.deepEqual(upgraded.applied, [2, 3, 4, 5, 6, 7, 8, 9]); assert.equal(db.prepare('SELECT default_executor FROM workspaces').get()?.default_executor, 'codex');
    assert.deepEqual(migrateDatabase(db).applied, []); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close(); db = new DatabaseSync(join(root, 'workbench.sqlite')); configureDatabase(db); assert.equal(migrateDatabase(db).to_version, SCHEMA_VERSION);
    const old = db.prepare('SELECT sha256 FROM schema_migrations WHERE version=1').get()!.sha256;
    db.prepare('UPDATE schema_migrations SET sha256=? WHERE version=1').run(H); assert.throws(() => migrateDatabase(db), /checksum mismatch/);
    db.prepare('UPDATE schema_migrations SET sha256=? WHERE version=1').run(old!); assert.throws(() => migrateDatabase(db, { targetVersion: 1 }), /downgrade/);
    record('migration.empty_upgrade_replay_reopen_checksum', { driver: 'node:sqlite', sqlite_version: db.prepare('SELECT sqlite_version() AS v').get()!.v, from: 0, intermediate: 1, final: SCHEMA_VERSION, applied: [1, 2, 3, 4, 5, 6, 7, 8, 9], fk_check_rows: 0 });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('unversioned nonempty state refuses guessed legacy provenance', () => {
  const db = new DatabaseSync(':memory:'); configureDatabase(db); db.exec('CREATE TABLE legacy_agent_output(id TEXT)');
  assert.throws(() => migrateDatabase(db), /unresolved_provenance/); db.close(); record('migration.unresolved_provenance_rejected');
});

test('migration precondition rejects a same-workspace head from another document', () => {
  const db = new DatabaseSync(':memory:'); configureDatabase(db); migrateDatabase(db, { targetVersion: 2 }); workspace(db);
  const c = core(db); const other = insert(db, 'documents', { kind: 'note', head_revision_id: c.revision });
  assert.throws(() => migrateDatabase(db), /constraint failed/); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 2); assert.equal(db.prepare('SELECT head_revision_id FROM documents WHERE id=?').get(other)!.head_revision_id, c.revision);
  db.close(); record('migration.invalid_existing_head_rejected', { state_unchanged: true });
});

test('polymorphic evidence accepts real revisions/candidates/works and rejects foreign or missing sources', () => withDb(db => {
  const c = core(db); const other = core(db); const j = job(db); const r = receipt(db, j, 'committed');
  const revision = insert(db, 'document_revisions', { document_id: c.document, file_path: 'evidence-agent.md', origin: 'agent', change_kind: 'text', job_id: j.id, attempt_id: j.attempt, attempt_generation: 1, result_receipt_id: r });
  const candidate = insert(db, 'candidates', { target_document_id: c.document, base_revision_id: c.revision, revision_id: revision, job_id: j.id, attempt_id: j.attempt, attempt_generation: 1, result_receipt_id: r, status: 'pending' });
  const owner = { owner_type: 'document_revision', owner_id: c.revision };
  const link = insert(db, 'evidence_links', { ...owner, source_type: 'document_revision', source_id: revision });
  insert(db, 'evidence_links', { ...owner, source_type: 'candidate', source_id: candidate });
  const work = insert(db, 'works', { platform: 'x', identity_status: 'pending', url: 'https://x.example/evidence' });
  insert(db, 'evidence_links', { owner_type: 'work', owner_id: work, source_type: 'identity_observation', source_id: work, locator: '{"platform_work_id":"external-id"}' });
  assert.throws(() => insert(db, 'evidence_links', { owner_type: 'document_revision', owner_id: other.revision, source_type: 'candidate', source_id: candidate }), /EVIDENCE_CANDIDATE_WRONG_DOCUMENT/);
  assert.throws(() => insert(db, 'evidence_links', { ...owner, source_type: 'document_revision', source_id: randomUUID() }), /EVIDENCE_SOURCE_INVALID/);
  workspace(db, W2); const foreignWork = insert(db, 'works', { workspace_id: W2, platform: 'x', identity_status: 'pending', url: 'https://x.example/foreign-evidence' });
  assert.throws(() => insert(db, 'evidence_links', { ...owner, source_type: 'work', source_id: foreignWork }), /EVIDENCE_SOURCE_INVALID/);
  assert.throws(() => insert(db, 'evidence_links', { ...owner, source_type: 'unverified_future_type', source_id: work }), /UNDECLARED/);
  assert.throws(() => db.prepare('UPDATE evidence_links SET source_id=? WHERE id=?').run(work, link), /IMMUTABLE_EVIDENCE_LINK/);
  record('evidence.polymorphic_workspace_and_candidate_ownership', { sources_rows: 0, accepted: ['document_revision', 'candidate', 'identity_observation'], unknown_type: 'rejected_pending_D07' });
}));

test('v3 evidence upgrade preserves valid rows and refuses unresolved polymorphic provenance', () => {
  for (const valid of [true, false]) {
    const db = new DatabaseSync(':memory:'); configureDatabase(db); migrateDatabase(db, { targetVersion: 3 }); workspace(db);
    const source = insert(db, 'sources'); const work = insert(db, 'works', { platform: 'x', identity_status: 'pending', url: 'https://x.example/legacy-evidence' });
    const link = insert(db, 'evidence_links', { owner_type: 'work', owner_id: work, source_type: valid ? 'source' : 'candidate', source_id: source });
    const before = db.prepare('SELECT * FROM evidence_links WHERE id=?').get(link);
    if (valid) { assert.deepEqual(migrateDatabase(db).applied, [4, 5, 6, 7, 8, 9]); assert.deepEqual(db.prepare('SELECT * FROM evidence_links WHERE id=?').get(link), before); }
    else { assert.throws(() => migrateDatabase(db), /EVIDENCE_SOURCE_INVALID/); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3); assert.deepEqual(db.prepare('SELECT * FROM evidence_links WHERE id=?').get(link), before); }
    db.close();
  }
  record('migration.polymorphic_evidence_preserve_or_rollback', { valid_rows_preserved: true, invalid_rows_not_guessed: true });
});

test('workspace foreign keys reject cross-workspace targets and rollback the whole group', () => withDb(db => {
  workspace(db, W2); const c = core(db); const count = db.prepare('SELECT COUNT(*) AS n FROM topics').get()!.n;
  assert.throws(() => transaction(db, () => insert(db, 'topics', { workspace_id: W2, core_document_id: c.document, status: 'active' })), /FOREIGN KEY/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topics').get()!.n, count);
  const other = insert(db, 'documents', { kind: 'note' }); assert.throws(() => db.prepare('UPDATE documents SET head_revision_id=? WHERE id=?').run(c.revision, other), /REVISION_OWNER_MISMATCH/);
  record('workspace.foreign_keys_and_same_document_owner', { rollback: true });
}));

test('canonical and pending URL identities are unique while aliases retain references', () => withDb(db => {
  const owner = insert(db, 'accounts', { platform: 'x', role: 'owner', platform_account_id: 'owner-external', identity_status: 'confirmed' });
  assert.throws(() => insert(db, 'accounts', { platform: 'x', role: 'benchmark', platform_account_id: 'owner-external', identity_status: 'confirmed' }), /UNIQUE/);
  const canonical = insert(db, 'works', { platform: 'x', platform_work_id: 'external-1', account_id: owner, url: 'https://x.example/1', identity_status: 'confirmed' });
  assert.throws(() => insert(db, 'works', { platform: 'x', platform_work_id: 'external-1', url: 'https://x.example/duplicate', identity_status: 'confirmed' }), /UNIQUE/);
  const alias = insert(db, 'works', { platform: 'x', platform_work_id: 'external-1', canonical_work_id: canonical, url: 'https://x.example/alias', identity_status: 'alias' });
  insert(db, 'work_aliases', { alias_work_id: alias, canonical_work_id: canonical, source_url: 'https://x.example/alias', resolution_evidence: '{}' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM works WHERE canonical_work_id IS NULL AND platform_work_id=?').get('external-1')!.n, 1);
  assert.throws(() => insert(db, 'works', { platform: 'wechat', canonical_work_id: canonical, identity_status: 'alias' }), /WORK_ALIAS_TARGET_INVALID/);
  assert.throws(() => db.prepare('UPDATE works SET canonical_work_id=? WHERE id=?').run(alias, canonical), /WORK_ALIAS_TARGET_INVALID/);
  insert(db, 'works', { platform: 'x', url: 'https://x.example/pending', identity_status: 'pending' }); assert.throws(() => insert(db, 'works', { platform: 'x', url: 'https://x.example/pending', identity_status: 'pending' }), /UNIQUE/);
  record('identity.canonical_pending_alias_constraints', { canonical_count: 1, alias_retained: true });
}));

test('action adoption key is semantic uniqueness independent of HTTP key', () => withDb(db => {
  const c = core(db); const comparison = insert(db, 'comparison_runs'); const report = insert(db, 'retro_reports', { document_id: c.document, comparison_run_id: comparison }); const action = insert(db, 'retro_actions', { report_id: report, report_revision_id: c.revision, status: 'proposed' });
  insert(db, 'action_adoptions', { action_id: action, adoption_key: 'create_topic:main', topic_id: c.topic });
  assert.throws(() => insert(db, 'action_adoptions', { action_id: action, adoption_key: 'create_topic:main', topic_id: c.topic }), /UNIQUE/);
  record('adoption.semantic_key_unique', { scope: 'database constraint; domain target creation belongs WP-14' });
}));

test('active attempts, generations and receipt output sets cannot be duplicated or reassigned', () => withDb(db => {
  const j = job(db); assert.throws(() => insert(db, 'job_attempts', { job_id: j.id, attempt_generation: 2, state: 'active' }), /UNIQUE/);
  const another = job(db); assert.throws(() => db.prepare('UPDATE jobs SET current_attempt_id=? WHERE id=?').run(another.attempt, j.id), /CURRENT_ATTEMPT_INVALID/);
  assert.throws(() => db.prepare('UPDATE jobs SET current_attempt_id=NULL,attempt_generation=0 WHERE id=?').run(j.id), /ATTEMPT_GENERATION_DECREASE/);
  const r = receipt(db, j); assert.throws(() => receipt(db, j), /UNIQUE/);
  assert.throws(() => db.prepare('UPDATE result_receipts SET output_hash=? WHERE id=?').run('b'.repeat(64), r), /FIXED_PROVENANCE/);
  db.prepare("UPDATE result_receipts SET state='quarantined' WHERE id=?").run(r); assert.throws(() => db.prepare("UPDATE result_receipts SET state='committed' WHERE id=?").run(r), /RECEIPT_TERMINAL/);
  assert.throws(() => db.prepare("UPDATE jobs SET execution_mode='host_session' WHERE id=?").run(j.id), /FIXED_JOB_INPUT/);
  record('attempt.receipt_generation_semantic_output_constraints');
}));

test('agent revision and write intent cannot bypass committed receipt/provenance', () => withDb(db => {
  const c = core(db); const j = job(db); const r = receipt(db, j);
  assert.throws(() => insert(db, 'document_revisions', { document_id: c.document, file_path: 'agent.md', origin: 'agent', change_kind: 'text' }), /RECEIPT_NOT_COMMITTED|CHECK/);
  assert.throws(() => insert(db, 'document_revisions', { document_id: c.document, file_path: 'agent.md', origin: 'agent', change_kind: 'text', job_id: j.id, attempt_id: j.attempt, attempt_generation: 1, result_receipt_id: r }), /RECEIPT_NOT_COMMITTED/);
  assert.throws(() => insert(db, 'write_intents', { document_id: c.document, planned_revision_id: randomUUID(), commit_purpose: 'agent_candidate', state: 'pending' }), /CHECK/);
  assert.throws(() => insert(db, 'write_intents', { document_id: c.document, planned_revision_id: randomUUID(), commit_purpose: 'human_revision', state: 'pending', job_id: j.id }), /CHECK/);
  transaction(db, () => { db.prepare("UPDATE result_receipts SET state='committed' WHERE id=?").run(r); const revision = insert(db, 'document_revisions', { document_id: c.document, file_path: 'agent.md', origin: 'agent', change_kind: 'text', job_id: j.id, attempt_id: j.attempt, attempt_generation: 1, result_receipt_id: r }); insert(db, 'candidates', { target_document_id: c.document, base_revision_id: c.revision, revision_id: revision, job_id: j.id, attempt_id: j.attempt, attempt_generation: 1, result_receipt_id: r, status: 'pending' }); });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidates').get()!.n, 1); assert.equal(db.prepare('SELECT head_revision_id FROM documents WHERE id=?').get(c.document)!.head_revision_id, c.revision);
  const intent = insert(db, 'write_intents', { document_id: c.document, planned_revision_id: randomUUID(), path: 'candidate.md', commit_purpose: 'agent_candidate', state: 'pending', result_receipt_id: r, job_id: j.id, attempt_id: j.attempt, attempt_generation: 1, input_hash: H, output_hash: H });
  assert.throws(() => db.prepare('UPDATE write_intents SET attempt_generation=2 WHERE id=?').run(intent), /FIXED_PROVENANCE/);
  record('agent.provenance_committed_receipt_and_human_separation', { candidate_does_not_move_head: true, limitation: 'finalizer leases/cancel/file protocol remain WP-09' });
}));

test('native turn identity, observer epoch and observation sequence are constrained', () => withDb(db => {
  const connection = insert(db, 'host_connections', { service_instance_id: S }); const cap = insert(db, 'host_capability_records', { status: 'unverified', version: 1 }); const observer = insert(db, 'host_task_observers', { host_connection_id: connection, capability_record_id: cap, capability_version: 1, observer_epoch: 'epoch-1', state: 'active' });
  const fields = { observer_id: observer, observer_epoch: 'epoch-1', host_connection_id: connection, scope: 'turn', native_namespace: 'test-namespace', native_session_id: 'native-session', native_turn_id: 'native-turn', state: 'active' };
  const binding = insert(db, 'native_task_bindings', fields); assert.throws(() => insert(db, 'native_task_bindings', fields), /UNIQUE/);
  assert.throws(() => insert(db, 'native_task_bindings', { ...fields, native_turn_id: '' }), /CHECK/);
  assert.throws(() => transaction(db, () => insert(db, 'native_task_bindings', { ...fields, observer_epoch: 'wrong-epoch', native_turn_id: 'another' })), /FOREIGN KEY/);
  insert(db, 'native_task_observations', { binding_id: binding, observer_id: observer, observer_epoch: 'epoch-1', sequence: 1, native_state: 'running', native_evidence_ref: 'internal-fixture' });
  assert.throws(() => insert(db, 'native_task_observations', { binding_id: binding, observer_id: observer, observer_epoch: 'epoch-1', sequence: 1, native_state: 'running' }), /UNIQUE/);
  db.prepare("UPDATE native_task_bindings SET state='closed' WHERE id=?").run(binding); assert.throws(() => db.prepare("UPDATE native_task_bindings SET state='active' WHERE id=?").run(binding), /BINDING_TERMINAL/);
  assert.throws(() => db.prepare("UPDATE native_task_bindings SET native_turn_id='new' WHERE id=?").run(binding), /FIXED_NATIVE_IDENTITY/);
  record('native.identity_epoch_sequence_constraints', { evidence_scope: 'internal_rule', native_tracking_real_provider: 'not_run', capability_status: 'unverified' });
}));

test('unknown observation and unavailable metrics remain null while real zero is valid', () => withDb(db => {
  const work = insert(db, 'works', { platform: 'x', identity_status: 'pending', url: 'https://x.example/zero' }); const source = insert(db, 'sources'); const definition = insert(db, 'metric_definitions', { platform: 'x', key: 'views' });
  const snapshot = insert(db, 'snapshots', { work_id: work, source_id: source, observed_time_basis: 'unknown', observed_at: null, observed_time_reason: 'provider_time_unknown', observed_age_s: null });
  insert(db, 'metric_values', { snapshot_id: snapshot, definition_id: definition, availability: 'available', value: '0', reason: null }); assert.equal(db.prepare('SELECT value FROM metric_values').get()!.value, '0');
  const definition2 = insert(db, 'metric_definitions', { platform: 'x', key: 'likes' }); insert(db, 'metric_values', { snapshot_id: snapshot, definition_id: definition2, availability: 'unavailable', value: null, reason: 'no_permission' });
  assert.throws(() => insert(db, 'metric_values', { snapshot_id: snapshot, definition_id: randomUUID(), availability: 'unavailable', value: '0', reason: 'missing' }), /CHECK/);
  assert.throws(() => insert(db, 'snapshots', { work_id: work, source_id: source, request_fingerprint: 'b'.repeat(64), observed_time_basis: 'unknown', observed_at: '2026-10-10T07:00:00Z', observed_time_reason: 'unknown' }), /CHECK/);
  assert.throws(() => db.prepare("UPDATE metric_values SET value='1'").run(), /IMMUTABLE_RECORD/);
  assert.throws(() => insert(db, 'metric_values', { snapshot_id: snapshot, definition_id: definition2, availability: 'available', value: 'NaN' }), /CHECK/);
  record('metrics.null_zero_availability_observation', { available_value: '0', unavailable_value: null, unknown_observed_at: null, unknown_observed_age_s: null });
}));

test('daily and production models preserve budget and append-only preparation ownership', () => withDb(db => {
  const c = core(db); const daily = insert(db, 'daily_plans', { local_date: '2026-10-10', timezone: 'America/Los_Angeles', budget_min: 120 }); insert(db, 'daily_plan_items', { plan_id: daily, topic_id: c.topic, effort_min: 30 });
  assert.throws(() => insert(db, 'daily_plans', { local_date: '2026-10-10', timezone: 'America/Los_Angeles', budget_min: -1 }), /CHECK|UNIQUE/);
  const plan = insert(db, 'production_plans', { topic_id: c.topic, scope: 'topic_preparation', variant_id: null }); assert.throws(() => insert(db, 'production_plans', { topic_id: c.topic, scope: 'topic_preparation' }), /UNIQUE/);
  const revision = insert(db, 'production_plan_revisions', { plan_id: plan, variant_revision_id: null, script_revision_id: null }); insert(db, 'shots', { plan_revision_id: revision, shot_key: 'opening', position: 0, title: '开场', duration_ms: 3000 });
  db.prepare('UPDATE production_plans SET head_plan_revision_id=? WHERE id=?').run(revision, plan); assert.throws(() => db.prepare('UPDATE shots SET duration_ms=4000 WHERE plan_revision_id=?').run(revision), /IMMUTABLE_RECORD/);
  assert.equal(API_RESOURCES.some(resource => resource.path === '/api/v1/daily-plans/{local_date}' && resource.method === 'PUT'), true);assert.equal(API_RESOURCES.some(resource => String(resource.path) === '/api/v1/daily-plans' && resource.method === 'POST'), false); assert.equal(API_RESOURCES.some(resource => resource.path === '/api/v1/overview' && resource.method === 'GET'), true);
  record('plans.daily_model_preparation_immutable_boundary', { initial_budget_min: 120, daily_write_endpoint: 'PUT /api/v1/daily-plans/{local_date}', preparation_script: null });
}));

test('request and output hashes have separate canonical semantics; idempotency is persisted', () => withDb(db => {
  assert.equal(requestHash({ b: 2, a: 1 }), requestHash({ a: 1, b: 2 })); const input = inputHash({ source_ids: ['fixed-source'] });
  assert.equal(outputHash({ target: 'document', commit_purpose: 'document_edit', input_hash: input, typed_output: { text: 'same' } }), outputHash({ typed_output: { text: 'same' }, input_hash: input, commit_purpose: 'document_edit', target: 'document' }));
  const first = transaction(db, () => claimIdempotency(db, W, 'POST:/topics', 'key-1', { title: 'same' })); transaction(db, () => commitIdempotency(db, W, first.id, { topic_id: 'stable' }));
  const replay = lookupIdempotency(db, W, 'POST:/topics', 'key-1', { title: 'same' }); assert.equal(replay!.id, first.id); assert.deepEqual(replay!.response, { topic_id: 'stable' });
  assert.throws(() => lookupIdempotency(db, W, 'POST:/topics', 'key-1', { title: 'different' }), (error: unknown) => error instanceof ContractError && error.code === 'IDEMPOTENCY_CONFLICT');
  assert.throws(() => lookupIdempotency(db, W, 'POST:/documents', 'key-1', { title: 'same' }), /相同 key/);
  record('idempotency.request_output_hashes_and_persisted_replay', { same_record_id: true, changed_body_conflict: true, changed_operation_conflict: true });
}));

test('common validation distinguishes empty text/null base and rejects secrets or invalid settings', () => {
  assert.deepEqual(SaveRevisionSchema.parse({ expected_revision_id: null, text: '', origin: 'human' }), { expected_revision_id: null, text: '', origin: 'human' });
  assert.throws(() => SaveRevisionSchema.parse({ text: '', origin: 'human' }), /必填/); assert.throws(() => PatchSettingsSchema.parse({ expected_version: 1, token: 'redacted-fixture' }), /未知字段/);
  assert.throws(() => PatchSettingsSchema.parse({ expected_version: 0 }), (error:unknown)=>error instanceof ContractError&&error.code==='VALIDATION_ERROR'&&error.details.field==='expected_version'); assert.throws(() => PatchSettingsSchema.parse({ expected_version: 1, api_fallback_enabled: 'yes' }), /布尔值/); assert.throws(() => PatchSettingsSchema.parse({ expected_version: 1, timezone: 'not-a-zone' }), /时区/);
  assert.equal(PatchSettingsSchema.parse({ expected_version: 1, default_executor: 'claude', api_fallback_enabled: true }).api_fallback_enabled, true);
  for (const code of ['HOST_OBSERVER_NOT_READY', 'HOST_TASK_BINDING_INVALID', 'HOST_RUN_OUTPUT_CONFLICT', 'RESULT_OUTPUT_CONFLICT', 'WORKSPACE_INSTANCE_MISMATCH']) assert.equal(ERROR_HTTP[code as keyof typeof ERROR_HTTP], 409);
  record('contracts.settings_save_tracking_error_enumeration');
});

test('registered route inventory rejects unknown endpoints and duplicate handlers', () => {
  const module: ApplicationModule = { id: 'route-contract-test', health: () => ({ module: 'test', status: 'ready' }), register: registrar => { registrar.register({ method: 'GET', path: '/api/v1/settings', owner: 'test', handle: () => ({ body: {} }) }); } };
  assert.equal(createRouteRegistry([module]).routes.filter(route => route.definition.path === '/api/v1/settings' && route.definition.method === 'GET').length, 1);
  assert.throws(() => createRouteRegistry([module, module]), /Duplicate/);
  assert.throws(() => createRouteRegistry([{ ...module, register: registrar => registrar.register({ method: 'POST', path: '/api/v1/daily-plans', owner: 'test', handle: () => ({ body: {} }) }) }]), /outside registered contract/);
  record('api.resource_enumeration_and_registration', { unique_resources: API_RESOURCES.length });
});

function config(root: string) { return validateConfiguration({ workspace_id: W, service_instance_id: S, title: '隔离真实HTTP/SQLite', mode: 'demo', timezone: 'America/Los_Angeles', paths: { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') }, listen: { host: '127.0.0.1', port: 4318 } }); }

test('real loopback service keeps identity across reboot and rejects missing/wrong write contexts', async () => {
  const root = mkdtempSync(join(evidenceRoot, '.service-')); let application: RunningApplication | undefined;
  const factory: ModuleFactory = (context: ApplicationContext) => ({ id: 'wp07-http-contract-probe', health: () => ({ module: 'wp07-http-contract-probe', status: 'ready' }), register: registrar => registrar.register({ method: 'POST', path: '/api/v1/topics', owner: 'internal-http-test', idempotent: true, handle: request => {
    const existing = lookupIdempotency(context.db, W, 'POST:/topics', request.context.idempotency_key!, request.body); if (existing?.state === 'committed') return { body: existing.response };
    return transaction(context.db, () => { const claimed = claimIdempotency(context.db, W, 'POST:/topics', request.context.idempotency_key!, request.body); const result = { accepted_request_id: claimed.id }; commitIdempotency(context.db, W, claimed.id, result); return { body: result }; });
  } }) });
  try {
    application = await startApplication(config(root), { port: 0, moduleFactories: [factory] }); const base = `http://${application.address.host}:${application.address.port}`; assert.equal(application.address.host, '127.0.0.1');
    const identity = await fetch(base + '/api/v1/identity').then(response => response.json()); assert.deepEqual(identity, { workspace_id: W, service_instance_id: S, contract_version: CONTRACT_VERSION });
    const health = await fetch(base + '/health').then(response => response.json()) as { schema_version: number }; assert.equal(health.schema_version, SCHEMA_VERSION);
    for (const headers of ([{}, { 'x-workspace-id': W2, 'x-service-instance-id': S }, { 'x-workspace-id': W, 'x-service-instance-id': 'wrong-service' }] as Array<Record<string, string>>)) { const response = await fetch(base + '/api/v1/topics', { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'first' }, body: '{}' }); assert.equal(response.status, 409); const error = await response.json() as { error: { code: string; request_id: string } }; assert.equal(error.error.code, 'WORKSPACE_INSTANCE_MISMATCH'); assert.ok(error.error.request_id); }
    const headers = { 'x-workspace-id': W, 'x-service-instance-id': S, 'content-type': 'application/json', 'idempotency-key': 'first' };
    const accepted = await fetch(base + '/api/v1/topics', { method: 'POST', headers, body: '{}' }).then(response => response.json()); const replay = await fetch(base + '/api/v1/topics', { method: 'POST', headers, body: '{}' }).then(response => response.json()); assert.deepEqual(accepted, replay);
    assert.equal((await fetch(base + '/api/v1/topics', { method: 'POST', headers, body: '{"changed":true}' })).status, 409);
    const unverified = await fetch(base + '/api/v1/host-runs', { method: 'POST', headers, body: '{}' }); assert.equal(unverified.status, 422); assert.equal(application.context.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n, 0);
    assert.equal((await fetch(base + '/api/v1/topics', { method: 'POST', headers: { ...headers, origin: 'https://external.example' }, body: '{}' })).status, 400);
    await assert.rejects(startApplication(config(root), { port: 0 }), /已有主服务/);
    const firstBoot = application.boot_id; await application.close(); application = await startApplication(config(root), { port: 0 }); assert.notEqual(application.boot_id, firstBoot); assert.deepEqual(application.identity, identity);
    record('service.loopback_identity_idempotency_health_lock_restart', { persistent_identity: identity, boot_id_changed: true, second_writer_rejected: true, wrong_identity_http: 409, host_route_unimplemented_http: 422, host_running_jobs: 0, domain_probe_isolation: 'test module; no provider or business workflow claimed' });
  } finally { await application?.close(); rmSync(root, { recursive: true, force: true }); }
});

after(() => {
  writeFileSync(join(evidenceRoot, 'verification-output.json'), JSON.stringify({ kind: 'wp07_foundation_verification', started_at: startedAt, finished_at: new Date().toISOString(), contract_version: CONTRACT_VERSION, schema_version: SCHEMA_VERSION, evidence_scope: 'internal_rule', recorded_passed_substeps: steps.length, steps, limitations: ['No real provider/platform/host/observation calls.', 'HTTP test module verifies common protocol only; actual documents/settings are WP-08.', 'Full T cases, native tracking and file finalizer remain assigned to later WPs.', 'All temporary database/service roots removed by finally; no history Vault read or write.'] }, null, 2) + '\n');
});
