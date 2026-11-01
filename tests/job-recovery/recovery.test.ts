import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, ContractError, type JsonObject } from '../../packages/contracts/src/index.ts';
import { transaction, sha256, canonicalJson } from '../../packages/storage/src/connection/index.ts';
import { getJob, getAttempt, revokeAttemptInTransaction, renewWorkerLease, startAttemptInTransaction } from '../../packages/storage/src/jobs/index.ts';
import { getReceipt, receiptIntents } from '../../packages/storage/src/receipts/index.ts';
import { ResultCommit, type ReceiveOutput } from '../../packages/domain/src/result-commit/index.ts';
import { Jobs } from '../../packages/domain/src/jobs/index.ts';
import { Documents } from '../../packages/domain/src/documents/index.ts';
import { Topics } from '../../packages/domain/src/topics/index.ts';
import { Settings } from '../../packages/domain/src/settings/index.ts';
import { startApplication } from '../../apps/service/src/bootstrap/application.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { fixture, snapshot, evidence, evidenceRoot, runId, runRoot, projectRoot } from './harness.ts';

type Fixture = ReturnType<typeof fixture>;
const ledger: Array<Record<string, unknown>> = [], matrix: Array<Record<string, unknown>> = [], hashes: Array<Record<string, unknown>> = [];
const reviewFindings: Record<string, string[]> = {
  'review-host-owner-connection-association': ['WP09-R1'], 'review-raw-byte-hash-before-UTF8-decoding': ['WP09-R2'],
  'review-worker-recovery-registration-scope': ['WP09-R3'], 'review-worker-auth-quota-states': ['WP09-R4'],
  'review-checkpoint-fast-failure-crash-and-invalid-fence': ['WP09-R5'],
};
const restrictions = ['仅 internal_rule；未调用实际宿主、模型、媒体供应商或发布平台', '模拟时钟仅验证截止规则，数据库 host observer 行是可控 fixture', 'UI 未改动，T26/T27 本 WP 未执行'];
async function checked(name: string, cases: string[], operation: () => Promise<unknown> | unknown) {
  const started = new Date().toISOString(); let result: unknown;
  try {
    result = await operation();
    const path = evidence(`${name}.json`, { name, status: 'passed', started_at: started, finished_at: new Date().toISOString(), result });
    ledger.push({ case: cases, substep: name, review_findings: reviewFindings[name] ?? [], scope: 'internal_rule', platform: 'controlled_fixture', format: 'Markdown / structured JSON', host: 'internal_fixture; not real host',
      versions: { contracts: CONTRACT_VERSION, handoff: 'D07-006', schema: 5, node: process.version }, actual_operation_at: started, result: 'passed', limitations: restrictions, evidence_path: path.replace(projectRoot + '/', '') });
  } catch (error) {
    const path = evidence(`${name}.failed.json`, { name, status: 'failed', started_at: started, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error), result });
    ledger.push({ case: cases, substep: name, review_findings: reviewFindings[name] ?? [], scope: 'internal_rule', result: 'failed', versions: { contracts: CONTRACT_VERSION, handoff: 'D07-006', schema: 5, node: process.version }, evidence_path: path.replace(projectRoot + '/', ''), limitations: restrictions }); throw error;
  }
}
function errorCode(code: string) { return (error: unknown) => error instanceof ContractError && error.code === code; }
function target(document_id: string, base_revision_id: string | null = null, core_revision_id: string | null = null) { return { document_id, base_revision_id, core_revision_id }; }
function interrupt(f: Fixture, claim: ReturnType<Fixture['create']>, phase: string, key = `crash:${randomUUID()}`, customInput?: ReceiveOutput) {
  const scenario = join(f.root, `${phase}-${randomUUID()}.json`);
  writeFileSync(scenario, JSON.stringify({ config: f.config, job_id: claim.job.id, input: customInput ?? f.output(claim), owner: claim.attempt.lease_owner, key, now: f.now }));
  const child = spawnSync(process.execPath, [join(projectRoot, 'tests/job-recovery/crash-child.ts'), scenario, phase], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr); assert.equal(child.status, null); assert.match(child.stdout, /receipt_id/);
  const checkpoint = JSON.parse(child.stdout.trim()); f.reopen();
  return { scenario, checkpoint, process: { actual_signal: child.signal, exit_code: child.status, stdout: child.stdout, stderr: child.stderr, pid: child.pid }, key };
}

for (const mode of ['service_adapter', 'host_session'] as const) for (const phase of ['pending_intent', 'after_rename', 'before_commit']) for (const reason of ['expired', 'new_attempt', 'cancelled', 'still_valid']) {
  const name = `T47-${mode}-${phase}-${reason}`;
  test(name, async () => checked(name, ['T47'], () => {
    const f = fixture();
    try {
      const documentId = f.document(), claim = f.create([target(documentId)], { execution_mode: mode });
      const crashed = interrupt(f, claim, phase), before = snapshot(f.context(), claim.job.id), db = f.context().db;
      assert.equal(before.receipts.length, 1); assert.equal(before.revisions.length, 0); assert.equal(before.candidates.length, 0);
      if (reason === 'expired') { f.now += 60_001; f.jobs().recoverExpired(); }
      if (reason === 'cancelled') f.jobs().cancel(f.request(), claim.job.id, { expected_version: getJob(db, f.config.workspace_id, claim.job.id).version });
      let newAttempt: string | null = null;
      if (reason === 'new_attempt') {
        transaction(db, () => revokeAttemptInTransaction(db, f.config.workspace_id, claim.job.id, 'NEW_ATTEMPT', 'superseded', 'queued', f.now));
        const next = mode === 'host_session' ? f.hostClaim(getJob(db, f.config.workspace_id, claim.job.id)) : f.jobs().claim('worker:replacement')!;
        assert.ok(next.attempt.attempt_generation > claim.attempt.attempt_generation); newAttempt = next.attempt.id;
      }
      const recovery = f.results().recover(), afterState = snapshot(f.context(), claim.job.id), receipt = getReceipt(db, f.config.workspace_id, crashed.checkpoint.receipt_id);
      assert.deepEqual(afterState.foreign_key_check, []); assert.equal(afterState.integrity_check[0]?.integrity_check, 'ok');
      if (reason === 'still_valid') {
        assert.equal(receipt.state, 'committed'); assert.equal(afterState.revisions.length, 1); assert.equal(afterState.candidates.length, 1);
        assert.equal(afterState.job?.state, 'succeeded'); assert.equal(afterState.documents[0]?.head_revision_id, null);
        assert.equal(afterState.intents[0]?.actual_file_hash, afterState.intents[0]?.sha256);
        assert.deepEqual(f.results().recover(), []);
      } else {
        assert.equal(receipt.state, 'quarantined'); assert.equal(afterState.revisions.length, 0); assert.equal(afterState.candidates.length, 0); assert.equal(afterState.documents[0]?.head_revision_id, null);
        assert.ok(afterState.intents.every(intent => intent.state === 'quarantined')); assert.notEqual(afterState.job?.state, 'succeeded');
        if (newAttempt) assert.equal(afterState.job?.current_attempt_id, newAttempt);
      }
      const trace = { execution_mode: mode, phase, reason, clock_basis: 'controlled_internal_clock', crashed, before, recovery, after: afterState };
      const path = evidence(`crash-recovery-traces/${name}.json`, trace);
      matrix.push({ phase, invalidation: reason, execution_mode: mode, result: 'passed', receipt_state: receipt.state, evidence_path: path.replace(projectRoot + '/', '') });
      return trace;
    } finally { f.cleanup(); }
  }));
}

test('T47-response-lost-and-hash-idempotency', async () => checked('T47-response-lost-and-hash-idempotency', ['T47', 'T41'], () => {
  const f = fixture();
  try {
    const claim = f.create([target(f.document())]), crashed = interrupt(f, claim, 'response_lost', 'stable-key');
    const committed = f.results().read(f.request(), crashed.checkpoint.receipt_id), before = snapshot(f.context(), claim.job.id);
    assert.equal(committed.state, 'committed'); f.now += 600_000;
    const input = f.output(claim), replay = f.results().receive(f.request('stable-key'), claim.job.id, input, claim.attempt.lease_owner);
    assert.deepEqual(replay, committed);
    const crossKey = f.results().receive(f.request('second-key'), claim.job.id, { ...input, expected_version: 999 }, claim.attempt.lease_owner);
    assert.deepEqual(crossKey, committed);
    assert.throws(() => f.results().receive(f.request('stable-key'), claim.job.id, { ...input, expected_version: 999 }, claim.attempt.lease_owner), errorCode('IDEMPOTENCY_CONFLICT'));
    const different = { ...input, typed_output: { ...input.typed_output, documents: input.typed_output.documents.map(doc => ({ ...doc, text: '不同输出' })) } };
    assert.throws(() => f.results().receive(f.request('third-key'), claim.job.id, different, claim.attempt.lease_owner), errorCode('RESULT_OUTPUT_CONFLICT'));
    assert.equal(snapshot(f.context(), claim.job.id).revisions.length, before.revisions.length); assert.equal(snapshot(f.context(), claim.job.id).receipts.length, 1);
    const caseData = { crashed, before, replay, cross_key: crossKey, request_conflict: 'IDEMPOTENCY_CONFLICT', semantic_conflict: 'RESULT_OUTPUT_CONFLICT', after: snapshot(f.context(), claim.job.id) };
    hashes.push({ name: 'committed-response-lost', request_hash_basis: 'workspace+operation+job+whole input', output_hash_basis: 'target+purpose+input_hash+typed_output', result: 'passed', case: caseData }); return caseData;
  } finally { f.cleanup(); }
}));

test('T47-multi-body-partial-prepare-and-atomic-rollback', async () => checked('T47-multi-body-partial-prepare-and-atomic-rollback', ['T47'], () => {
  const f = fixture();
  try {
    const claim = f.create([target(f.document()), target(f.document())]), crashed = interrupt(f, claim, 'partial_prepare'), before = snapshot(f.context(), claim.job.id);
    assert.equal(before.intents.filter(intent => intent.actual_file_hash !== null).length, 1); assert.equal(before.revisions.length, 0);
    const receiptId = crashed.checkpoint.receipt_id; f.results().prepare(receiptId);
    const intents = receiptIntents(f.context().db, f.config.workspace_id, receiptId);
    const failDocument = intents[1]!.document_id;
    f.context().db.exec(`CREATE TEMP TRIGGER injected_second_candidate BEFORE INSERT ON candidates WHEN NEW.target_document_id='${failDocument}' BEGIN SELECT RAISE(ABORT,'INJECTED_ATOMIC_FAILURE'); END`);
    assert.throws(() => f.results().commitResult(receiptId), /INJECTED_ATOMIC_FAILURE/);
    const rollback = snapshot(f.context(), claim.job.id);
    assert.equal(rollback.revisions.length, 0); assert.equal(rollback.candidates.length, 0); assert.equal(rollback.receipts[0]?.state, 'pending'); assert.equal(rollback.attempts[0]?.state, 'active');
    f.context().db.exec('DROP TRIGGER injected_second_candidate'); f.reopen();
    const recovery = f.results().recover(), completed = snapshot(f.context(), claim.job.id);
    assert.equal(completed.revisions.length, 2); assert.equal(completed.candidates.length, 2); assert.equal(completed.receipts[0]?.state, 'committed');
    assert.ok(completed.intents.every(intent => intent.actual_file_hash === intent.sha256));
    return { crashed, before, rollback, recovery, after: completed };
  } finally { f.cleanup(); }
}));

test('T47-no-Markdown-recommendation-recovery', async () => checked('T47-no-Markdown-recommendation-recovery', ['T47', 'T23'], () => {
  const f = fixture();
  try {
    const claim = f.create([], { mode: 'recommendation', kind: 'topic_recommendation', recommendation_kind: 'topic' });
    const input = f.output(claim, { documents: [], recommendations: [{ payload: { title: '内部规则推荐', audience: 'fixture' }, source_ids: [], rationale: '受控输入' }] });
    const receipt = f.results().receive(f.request('recommendation-key'), claim.job.id, input, claim.attempt.lease_owner), before = snapshot(f.context(), claim.job.id);
    assert.equal(before.intents.length, 0); f.reopen();
    const recovery = f.results().recover(), afterState = snapshot(f.context(), claim.job.id);
    assert.equal(afterState.recommendations.length, 1); assert.equal(afterState.receipts[0]?.state, 'committed'); assert.equal(afterState.job?.state, 'succeeded');
    const repeat = f.results().receive(f.request('recommendation-cross-key'), claim.job.id, { ...input, expected_version: 222 }, claim.attempt.lease_owner);
    assert.equal(repeat.receipt_id, receipt.receipt_id); assert.equal(snapshot(f.context(), claim.job.id).recommendations.length, 1);
    hashes.push({ name: 'no-Markdown-cross-key', result: 'passed', receipt_id: receipt.receipt_id, output_hash: receipt.output_hash });
    return { input, before, recovery, after: afterState, repeat };
  } finally { f.cleanup(); }
}));

test('T29-cancel-late-result-and-committed-late-failure', async () => checked('T29-cancel-late-result-and-committed-late-failure', ['T29', 'T48'], () => {
  const f = fixture();
  try {
    const claim = f.create([target(f.document())]);
    const cancelled = f.jobs().cancel(f.request('cancel-key'), claim.job.id, { expected_version: claim.job.version });
    const late = f.results().submit(f.request(), claim.job.id, f.output(claim), claim.attempt.lease_owner);
    assert.equal(late.state, 'quarantined'); assert.equal(late.quarantine_reason, 'CANCEL_REQUESTED'); assert.equal(snapshot(f.context(), claim.job.id).candidates.length, 0);
    const successful = f.create([target(f.document())]), committed = f.results().submit(f.request(), successful.job.id, f.output(successful), successful.attempt.lease_owner);
    f.jobs().fail(successful.fence, { code: 'LATE_NATIVE_FAILURE' }); assert.equal(f.jobs().get(f.request(), successful.job.id).job.state, 'succeeded');
    assert.throws(() => f.jobs().fail({ ...successful.fence, attempt_id: claim.attempt.id }, { code: 'WRONG_JOB_FAILURE' }), errorCode('HOST_RUN_NOT_CURRENT'));
    const successEvents = f.jobs().events(f.request(), successful.job.id).events;
    assert.equal(successEvents.at(-1)?.payload.ignored_late_failure, true);
    const terminalCancel = f.jobs().cancel(f.request(), successful.job.id, { expected_version: f.jobs().get(f.request(), successful.job.id).job.version });
    assert.equal(terminalCancel.state, 'succeeded');
    return { cancelled, late, committed, success_events: successEvents, after_cancelled: snapshot(f.context(), claim.job.id), after_successful: snapshot(f.context(), successful.job.id) };
  } finally { f.cleanup(); }
}));

test('T48-observer-readiness-and-output-deadline', async () => checked('T48-observer-readiness-and-output-deadline', ['T48', 'T42'], () => {
  const f = fixture();
  try {
    const claim = f.create([target(f.document())], { execution_mode: 'host_session' }), input = f.output(claim);
    const receipt = f.results().receive(f.request(), claim.job.id, input, claim.attempt.lease_owner); f.results().prepare(receipt.receipt_id); f.reopen();
    const defaultAfterRestart = new ResultCommit(f.context(), { clock: () => f.now });
    const pending = defaultAfterRestart.recover(); assert.equal(pending[0]?.state, 'pending'); assert.equal(snapshot(f.context(), claim.job.id).candidates.length, 0);
    f.ready = false; assert.equal(f.results().recover()[0]?.state, 'pending');
    assert.throws(() => renewWorkerLease(f.context().db, f.config.workspace_id, claim.fence, f.now), errorCode('HOST_RUN_NOT_CURRENT'));
    f.ready = true; const recovered = f.results().recover(); assert.equal(recovered[0]?.state, 'committed');
    const deadlineClaim = f.create([target(f.document())], { execution_mode: 'host_session' });
    f.context().db.prepare('UPDATE job_attempts SET output_deadline=? WHERE id=?').run(new Date(f.now + 1000).toISOString(), deadlineClaim.attempt.id);
    const deadlineReceipt = f.results().receive(f.request(), deadlineClaim.job.id, f.output(deadlineClaim), deadlineClaim.attempt.lease_owner);
    f.now += 1000; const expiry = f.jobs().recoverExpired(); const late = f.results().recover();
    assert.equal(getReceipt(f.context().db, f.config.workspace_id, deadlineReceipt.receipt_id).state, 'quarantined'); assert.equal(getJob(f.context().db, f.config.workspace_id, deadlineClaim.job.id).state, 'waiting_input');
    return { observation_basis: 'controlled relational fixture and process readiness callback', pending_default_after_restart: pending, recovered, expiry, late, after: snapshot(f.context(), deadlineClaim.job.id) };
  } finally { f.cleanup(); }
}));

test('T47-fixed-input-owner-file-hash-and-human-path', async () => checked('T47-fixed-input-owner-file-hash-and-human-path', ['T47', 'T21'], () => {
  const f = fixture();
  try {
    const claim = f.create([target(f.document())]), input = f.output(claim), db = f.context().db;
    assert.throws(() => f.results().receive(f.request(), claim.job.id, { ...input, input_hash: 'a'.repeat(64) }, claim.attempt.lease_owner), errorCode('INPUT_STALE'));
    assert.throws(() => f.results().receive(f.request(), claim.job.id, input, 'different-owner'), errorCode('HOST_RUN_NOT_CURRENT'));
    const receipt = f.results().receive(f.request(), claim.job.id, input, claim.attempt.lease_owner); f.results().prepare(receipt.receipt_id);
    const intent = receiptIntents(db, f.config.workspace_id, receipt.receipt_id)[0]!, original = readFileSync(intent.path);
    chmodSync(intent.path, 0o644); writeFileSync(intent.path, 'tampered');
    const mismatch = f.results().commitResult(receipt.receipt_id); assert.equal(mismatch.state, 'pending'); assert.equal(snapshot(f.context(), claim.job.id).candidates.length, 0);
    assert.equal(readFileSync(intent.path, 'utf8'), 'tampered');
    assert.throws(() => db.prepare('UPDATE result_receipts SET output_payload=? WHERE id=?').run('{}', receipt.receipt_id), /FIXED_PROVENANCE/);
    assert.throws(() => db.prepare('UPDATE write_intents SET attempt_generation=attempt_generation+1 WHERE id=?').run(intent.id), /FIXED_PROVENANCE/);
    const documents = new Documents(f.context()); documents.recover(); assert.equal(snapshot(f.context(), claim.job.id).candidates.length, 0);
    writeFileSync(intent.path, original); chmodSync(intent.path, 0o444); const repaired = f.results().commitResult(receipt.receipt_id); assert.equal(repaired.state, 'committed');
    const invalidLeaseClaim = f.create([target(f.document())]);
    db.prepare('UPDATE job_attempts SET lease_until=? WHERE id=?').run('invalid-time', invalidLeaseClaim.attempt.id);
    const invalidLease = f.results().receive(f.request(), invalidLeaseClaim.job.id, f.output(invalidLeaseClaim), invalidLeaseClaim.attempt.lease_owner);
    assert.equal(invalidLease.state, 'quarantined'); assert.equal(invalidLease.quarantine_reason, 'INVALID_LEASE_TIME');
    const invalidRecovery = f.jobs().recoverExpired(); assert.equal(invalidRecovery.find(row => row.job_id === invalidLeaseClaim.job.id)?.reason, 'INVALID_LEASE_TIME');
    return { mismatch, actual_tampered_hash: sha256('tampered'), registered_hash: intent.sha256, repaired, invalidLease, invalidRecovery, after: snapshot(f.context(), claim.job.id) };
  } finally { f.cleanup(); }
}));

test('jobs-claim-events-readonly-retry-and-side-effect-recovery', async () => checked('jobs-claim-events-readonly-retry-and-side-effect-recovery', ['T23', 'T42'], async () => {
  const f = fixture();
  try {
    const host = f.create([target(f.document())], { execution_mode: 'host_session' }); assert.equal(f.jobs().claim('worker:other'), null);
    const readOnly = f.create([], { mode: 'none', kind: 'source_sync', execution_mode: 'programmatic' });
    f.jobs().heartbeat(readOnly.fence, { cursor: 'batch-1' });
    f.jobs().fail(readOnly.fence, { code: 'READ_ONLY_FAILURE' });
    const failed = f.jobs().get(f.request(), readOnly.job.id).job;
    const retry = f.jobs().resume(f.request('resume-stable'), readOnly.job.id, { expected_version: failed.version });
    const repeated = f.jobs().resume(f.request('resume-stable'), readOnly.job.id, { expected_version: failed.version }); assert.deepEqual(repeated, retry);
    const second = f.jobs().claim('worker:retry')!; assert.ok(second.attempt.attempt_generation > readOnly.attempt.attempt_generation); assert.equal(JSON.parse(second.attempt.checkpoint).cursor, 'batch-1');
    assert.throws(() => f.jobs().heartbeat(readOnly.fence), errorCode('HOST_RUN_NOT_CURRENT'));
    const media = f.create([], { mode: 'none', kind: 'media_generate', execution_mode: 'programmatic' });
    const publication = f.create([], { mode: 'none', kind: 'publication', execution_mode: 'programmatic' });
    f.now += 60_001; const expiry = f.jobs().recoverExpired();
    assert.equal(f.jobs().get(f.request(), media.job.id).job.state, 'reconciling'); assert.equal(f.jobs().get(f.request(), publication.job.id).job.state, 'reconciling'); assert.equal(f.jobs().get(f.request(), host.job.id).job.state, 'waiting_input');
    const reconciling = f.jobs().get(f.request(), publication.job.id).job;
    assert.throws(() => f.jobs().resume(f.request(), publication.job.id, { expected_version: reconciling.version }), errorCode('RESULT_UNKNOWN'));
    const firstPage = f.jobs().events(f.request(), readOnly.job.id, 0, 2), secondPage = f.jobs().events(f.request(), readOnly.job.id, firstPage.last_seq, 200);
    assert.equal(firstPage.has_more, true); const seqs = [...firstPage.events, ...secondPage.events].map(event => event.seq); assert.deepEqual(seqs, seqs.map((_, index) => index + 1));
    const jobList = f.jobs().list(f.request(), { limit: 1 }), nextList = f.jobs().list(f.request(), { limit: 200, cursor: jobList.next_cursor! });
    assert.equal(jobList.items.length + nextList.items.length, 4);
    return { host_excluded: true, claimed_modes: [readOnly.job.execution_mode, media.job.execution_mode, publication.job.execution_mode], retry, second, expiry,
      first_page: firstPage, second_page: secondPage, persisted: snapshot(f.context(), readOnly.job.id) };
  } finally { f.cleanup(); }
}));

async function prepareVariant(f: Fixture) {
  const topics = new Topics(f.context()), documents = new Documents(f.context());
  const topic = await topics.create(f.request(), { title: '内部初始化竞争', category: 'fixture', audience: 'fixture', source_ids: [] });
  const core = await documents.save(f.request(), topic.core_document_id, { expected_revision_id: null, text: '已确认核心 r1', origin: 'human' });
  await documents.approveCore(f.request(), topic.id, core.revision_id);
  const documentId = f.document('variant'), variantId = randomUUID();
  f.context().db.prepare("INSERT INTO variants(id,workspace_id,topic_id,platform,format,variant_key,document_id,based_on_core_revision_id,status,version) VALUES (?,?,?,'x','text','default',?,?,'pending',1)")
    .run(variantId, f.config.workspace_id, topic.id, documentId, core.revision_id);
  return { topic, core, documentId };
}
function runChild(scenario: string): Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(projectRoot, 'tests/job-recovery/crash-child.ts'), scenario, 'complete']); let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.once('error', reject);
    child.once('exit', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}
test('T28-two-process-initialize-race-and-core-change', async () => checked('T28-two-process-initialize-race-and-core-change', ['T28', 'T47'], async () => {
  const f = fixture();
  try {
    const variant = await prepareVariant(f), first = f.create([target(variant.documentId, null, variant.core.revision_id)], { kind: 'variant_generate', mode: 'initialize' });
    const queued = f.jobs().enqueue(f.request(),{kind:'variant_generate',execution_mode:'service_adapter',entrypoint:'standalone_web',presentation:'foreground_dialog',target_id:variant.documentId,input_manifest:JSON.parse(first.job.input_manifest)});
    assert.equal(f.jobs().claim('ordinary-worker'),null,'正常 worker 同目标保持串行');
    // 仅在 finalizer 对抗测试中合成竞争 attempt，不代表正常领取可以绕过同目标保护。
    const second=transaction(f.context().db,()=>startAttemptInTransaction(f.context().db,f.config.workspace_id,queued.id,'synthetic-cas-adversary',f.now));
    const scenarios = [first, second].map((claim, index) => {
      const path = join(f.root, `race-${index}.json`); writeFileSync(path, JSON.stringify({ config: f.config, job_id: claim.job.id, input: f.output(claim), owner: claim.attempt.lease_owner, key: `race-${index}`, now: f.now })); return path;
    });
    const concurrent = await Promise.all(scenarios.map(runChild)); assert.ok(concurrent.every(result => result.status === 0), canonicalJson(concurrent)); f.reopen();
    const rows = f.context().db.prepare('SELECT * FROM candidates WHERE target_document_id=?').all(variant.documentId);
    assert.equal(rows.length, 2); assert.equal(rows.filter(row => row.adoption_mode === 'auto_initial').length, 1); assert.equal(rows.filter(row => row.status === 'pending').length, 1);
    const head = f.context().db.prepare('SELECT head_revision_id FROM documents WHERE id=?').get(variant.documentId); assert.equal(head?.head_revision_id, rows.find(row => row.status === 'adopted')?.revision_id);
    const changed = await prepareVariant(f), oldInput = f.create([target(changed.documentId, null, changed.core.revision_id)], { kind: 'variant_generate', mode: 'initialize' });
    const receipt = f.results().receive(f.request(), oldInput.job.id, f.output(oldInput), oldInput.attempt.lease_owner); f.results().prepare(receipt.receipt_id);
    await new Documents(f.context()).save(f.request(), changed.topic.core_document_id, { expected_revision_id: changed.core.revision_id, text: '人工核心 r2', origin: 'human' });
    const stale = f.results().commitResult(receipt.receipt_id); assert.equal(stale.state, 'committed');
    const pending = f.context().db.prepare('SELECT status,adoption_mode FROM candidates WHERE job_id=?').get(oldInput.job.id); assert.equal(pending?.status, 'pending'); assert.equal(pending?.adoption_mode, null);
    assert.equal(f.context().db.prepare('SELECT head_revision_id FROM documents WHERE id=?').get(changed.documentId)?.head_revision_id, null);
    return { concurrent_processes: concurrent, candidates: rows, head, stale_core_result: stale, after_stale: snapshot(f.context(), oldInput.job.id) };
  } finally { f.cleanup(); }
}));

test('T41-candidate-survives-human-edit-and-base-conflict', async () => checked('T41-candidate-survives-human-edit-and-base-conflict', ['T41', 'T28'], async () => {
  const f = fixture();
  try {
    const documents = new Documents(f.context()), document = await documents.create(f.request(), { kind: 'wiki', initial_text: '人工 r1' });
    const claim = f.create([target(document.document_id, document.head_revision_id)]), receipt = f.results().receive(f.request(), claim.job.id, f.output(claim), claim.attempt.lease_owner);
    const newHead = await documents.save(f.request(), document.document_id, { expected_revision_id: document.head_revision_id, text: '人工 r2', origin: 'human' });
    f.results().prepare(receipt.receipt_id); const committed = f.results().commitResult(receipt.receipt_id);
    const candidate = f.context().db.prepare('SELECT * FROM candidates WHERE job_id=?').get(claim.job.id)!;
    await assert.rejects(() => documents.adoptCandidate(f.request(), String(candidate.id), { expected_revision_id: newHead.revision_id }), errorCode('REVISION_CONFLICT'));
    assert.equal((await documents.get(f.request(), document.document_id)).head_revision_id, newHead.revision_id);
    return { frozen_base: document.head_revision_id, human_head: newHead.revision_id, committed, candidate, after: snapshot(f.context(), claim.job.id) };
  } finally { f.cleanup(); }
}));

test('settings-new-root-and-frozen-old-intent-recovery', async () => checked('settings-new-root-and-frozen-old-intent-recovery', ['T47'], async () => {
  const f = fixture();
  try {
    const first = f.create([target(f.document())]), resultService = f.results(), oldReceipt = resultService.receive(f.request(), first.job.id, f.output(first), first.attempt.lease_owner);
    const oldPath = receiptIntents(f.context().db, f.config.workspace_id, oldReceipt.receipt_id)[0]!.path;
    const newRoot = join(f.root, 'new-notes'); mkdirSync(newRoot);
    await new Settings(f.context()).patch(f.request(), { expected_version: 1, paths: { managed_notes_root: newRoot } });
    const second = f.create([target(f.document())]), newReceipt = resultService.receive(f.request(), second.job.id, f.output(second), second.attempt.lease_owner);
    const newPath = receiptIntents(f.context().db, f.config.workspace_id, newReceipt.receipt_id)[0]!.path;
    assert.ok(newPath.startsWith(newRoot + '/')); assert.ok(oldPath.startsWith(f.config.paths.managed_notes_root + '/'));
    f.reopen(); const recovery = f.results().recover(); assert.ok(recovery.every(row => row.state === 'committed'));
    assert.ok(readFileSync(oldPath).length > 0); assert.ok(readFileSync(newPath).length > 0);
    return { old_path: oldPath, new_path: newPath, recovery, old: snapshot(f.context(), first.job.id), new: snapshot(f.context(), second.job.id) };
  } finally { f.cleanup(); }
}));

test('jobs-HTTP-auth-version-idempotency-and-worker-handler', async () => checked('jobs-HTTP-auth-version-idempotency-and-worker-handler', ['T23', 'T29'], async () => {
  const f = fixture(); let app: Awaited<ReturnType<typeof startApplication>> | undefined;
  try {
    const claim = f.create([target(f.document())]);
    app = await startApplication(f.config, { port: 0 }); const url = `http://127.0.0.1:${app.address.port}`;
    const headers = { 'x-workspace-id': f.config.workspace_id, 'x-service-instance-id': f.config.service_instance_id, 'content-type': 'application/json', 'idempotency-key': 'http-cancel' };
    const detail = await fetch(`${url}/api/v1/jobs/${claim.job.id}`, { headers }); assert.equal(detail.status, 200); assert.equal((await detail.json() as { job: { id: string } }).job.id, claim.job.id);
    const invalid = await fetch(`${url}/api/v1/jobs/${claim.job.id}/cancel`, { method: 'POST', headers, body: JSON.stringify({ expected_version: 0 }) }); assert.equal(invalid.status, 400);
    const cancel = await fetch(`${url}/api/v1/jobs/${claim.job.id}/cancel`, { method: 'POST', headers, body: JSON.stringify({ expected_version: claim.job.version }) }); assert.equal(cancel.status, 200);
    const replay = await fetch(`${url}/api/v1/jobs/${claim.job.id}/cancel`, { method: 'POST', headers, body: JSON.stringify({ expected_version: claim.job.version }) }); assert.equal(replay.status, 200);
    const conflict = await fetch(`${url}/api/v1/jobs/${claim.job.id}/cancel`, { method: 'POST', headers, body: JSON.stringify({ expected_version: 999 }) }); assert.equal(conflict.status, 409);
    const wrong = await fetch(`${url}/api/v1/jobs/${claim.job.id}`, { headers: { ...headers, 'x-service-instance-id': 'wrong' } }); assert.equal(wrong.status, 409);
    const host = f.create([target(f.document())], { execution_mode: 'host_session' });
    const queuedDocument = f.document();
    f.jobs().enqueue(f.request(), { kind: 'document_modify', target_id: queuedDocument, execution_mode: 'service_adapter', entrypoint: 'standalone_web', presentation: 'background',
      input_manifest: { schema_version: 'wp09-input-v1', mode: 'candidate', targets: [target(queuedDocument)] as unknown as JsonObject[], source_ids: [] } });
    let count = 0;
    const worker = new DurableWorker(app.context, [{ registration: { kind: 'document_modify', execution_mode: 'service_adapter', recovery: 'read_only' },
      async execute({ claim: executed }) { count++; return { documents: JSON.parse(executed.job.input_manifest).targets.map((item: { document_id: string }) => ({ document_id: item.document_id, text: '受控 handler 输出' })), recommendations: [] }; } }]);
    const worked = await worker.runOnce(); assert.equal(worked?.state, 'committed'); assert.equal(count, 1); assert.equal(await worker.runOnce(), null); assert.equal(f.jobs().get(f.request(), host.job.id).job.state, 'running');
    return { HTTP: { detail: detail.status, invalid: invalid.status, cancel: cancel.status, replay: replay.status, conflict: conflict.status, wrong_service: wrong.status }, worker: { handler_count: count, worked, host_job: host.job.id, host_state: 'running' } };
  } finally { await app?.close(); f.cleanup(); }
}));

test('T47-structured-output-crash-cancel-expiry-new-attempt', async () => checked('T47-structured-output-crash-cancel-expiry-new-attempt', ['T47', 'T29'], () => {
  const traces: unknown[] = [];
  for (const reason of ['expired', 'cancelled', 'new_attempt', 'still_valid']) {
    const f = fixture();
    try {
      const claim = f.create([], { mode: 'recommendation', kind: 'account_recommendation', recommendation_kind: 'account', execution_mode: 'host_session' });
      const input = f.output(claim, { documents: [], recommendations: [{ payload: { name: '受控推荐账号', identity_status: 'pending' }, source_ids: [], rationale: '内部规则' }] });
      const crashed = interrupt(f, claim, 'before_commit', `recommendation-crash:${reason}`, input), before = snapshot(f.context(), claim.job.id);
      assert.equal(before.receipts[0]?.state, 'pending'); assert.equal(before.recommendations.length, 0);
      if (reason === 'expired') { f.now += 60_001; f.jobs().recoverExpired(); }
      if (reason === 'cancelled') f.jobs().cancel(f.request(), claim.job.id, { expected_version: claim.job.version });
      if (reason === 'new_attempt') {
        transaction(f.context().db, () => revokeAttemptInTransaction(f.context().db, f.config.workspace_id, claim.job.id, 'NEW_ATTEMPT', 'superseded', 'queued', f.now));
        f.hostClaim(getJob(f.context().db, f.config.workspace_id, claim.job.id));
      }
      const recovery = f.results().recover(), replay = f.results().receive(f.request(`rec-cross-key:${reason}`), claim.job.id, { ...input, expected_version: 999 }, claim.attempt.lease_owner), afterState = snapshot(f.context(), claim.job.id);
      assert.equal(afterState.intents.length, 0); assert.equal(replay.state, reason === 'still_valid' ? 'committed' : 'quarantined'); assert.equal(afterState.recommendations.length, reason === 'still_valid' ? 1 : 0);
      traces.push({ reason, crashed, before, recovery, replay, after: afterState });
    } finally { f.cleanup(); }
  }
  return { output_form: 'structured_only; no Markdown, no rename stage', traces };
}));

test('T47-final-check-deadline-and-legacy-payload-repair', async () => checked('T47-final-check-deadline-and-legacy-payload-repair', ['T47', 'T48'], () => {
  const f = fixture();
  try {
    const claim = f.create([target(f.document())]), receipt = f.results().receive(f.request(), claim.job.id, f.output(claim), claim.attempt.lease_owner); f.results().prepare(receipt.receipt_id);
    let clockReads = 0; const crossing = new ResultCommit(f.context(), { clock: () => f.now + (clockReads++ === 0 ? 59_999 : 60_000) });
    const expiredWithinCommit = crossing.commitResult(receipt.receipt_id); assert.equal(expiredWithinCommit.state, 'quarantined'); assert.equal(snapshot(f.context(), claim.job.id).revisions.length, 0);
    const legacy = f.create([], { mode: 'recommendation', kind: 'topic_recommendation', recommendation_kind: 'topic' }), legacyReceipt = randomUUID();
    f.context().db.prepare("INSERT INTO result_receipts(id,workspace_id,job_id,attempt_id,attempt_generation,input_hash,output_hash,commit_purpose,state,result_ids,idempotency_requests) VALUES (?,?,?,?,?,?,?,'agent_recommendation','pending','{}','[]')")
      .run(legacyReceipt, f.config.workspace_id, legacy.job.id, legacy.attempt.id, legacy.attempt.attempt_generation, legacy.job.input_hash, 'b'.repeat(64));
    const first = f.results().commitResult(legacyReceipt), repeated = f.results().commitResult(legacyReceipt);
    assert.equal(first.state, 'pending'); assert.equal(repeated.state, 'pending');
    const repairEvents = f.jobs().events(f.request(), legacy.job.id).events.filter(event => event.payload.reason === 'needs_repair'); assert.equal(repairEvents.length, 1); assert.equal(snapshot(f.context(), legacy.job.id).recommendations.length, 0);
    return { clock_reads: clockReads, expiredWithinCommit, legacy_pending: first, durable_repair_events: repairEvents, legacy: snapshot(f.context(), legacy.job.id) };
  } finally { f.cleanup(); }
}));

test('worker-late-output-isolation-and-side-effect-error-reconcile', async () => checked('worker-late-output-isolation-and-side-effect-error-reconcile', ['T29', 'T23'], async () => {
  const f = fixture();
  try {
    const documentId = f.document(); f.jobs().enqueue(f.request(), { kind: 'document_modify', execution_mode: 'service_adapter', entrypoint: 'standalone_web', presentation: 'foreground_dialog',
      input_manifest: { schema_version: 'wp09-input-v1', mode: 'candidate', targets: [target(documentId)] as unknown as JsonObject[], source_ids: [] } });
    const worker = new DurableWorker(f.context(), [{ registration: { kind: 'document_modify', execution_mode: 'service_adapter', recovery: 'read_only' }, async execute({ claim }) {
      f.jobs().cancel(f.request(), claim.job.id, { expected_version: claim.job.version }); return { documents: [{ document_id: documentId, text: '取消之后晚到的文字' }], recommendations: [] };
    } }], { clock: () => f.now });
    const late = await worker.runOnce(); assert.equal(late?.state, 'quarantined'); const lateSnapshot = snapshot(f.context(), late!.job_id); assert.equal(lateSnapshot.candidates.length, 0);
    f.jobs().enqueue(f.request(), { kind: 'publication', execution_mode: 'programmatic', entrypoint: 'standalone_web', presentation: 'background', input_manifest: { schema_version: 'wp09-input-v1', mode: 'none', targets: [], source_ids: [] } });
    const sideEffectWorker = new DurableWorker(f.context(), [{ registration: { kind: 'publication', execution_mode: 'programmatic', recovery: 'external_side_effect' }, async execute() { throw new Error('受控模拟：请求结果未知'); } }], { clock: () => f.now });
    const unknown = await sideEffectWorker.runOnce(); assert.equal(unknown?.state, 'reconciling');
    return { actual_platform_request: 'not_run', late, late_snapshot: lateSnapshot, unknown, unknown_snapshot: snapshot(f.context(), unknown!.job_id) };
  } finally { f.cleanup(); }
}));

test('review-host-owner-connection-association', async () => checked('review-host-owner-connection-association', ['T47', 'T48'], () => {
  const cases: unknown[] = [];
  for (const mutation of ['replacement_owner', 'replacement_connection', 'legal_control']) {
    const f = fixture();
    try {
      const claim = f.create([target(f.document())], { execution_mode: 'host_session' }), input = f.output(claim), key = `association:${mutation}`;
      const receipt = f.results().receive(f.request(key), claim.job.id, input, claim.attempt.lease_owner); f.results().prepare(receipt.receipt_id);
      const db = f.context().db, binding = db.prepare('SELECT * FROM native_task_bindings WHERE id=?').get(claim.attempt.native_task_binding_id!)!;
      if (mutation === 'replacement_owner') {
        db.prepare("UPDATE host_connections SET request_identity_ref='replacement-owner' WHERE id=?").run(claim.attempt.host_connection_id!);
        db.prepare("UPDATE host_task_observers SET request_identity_ref='replacement-owner' WHERE id=?").run(String(binding.observer_id));
      }
      if (mutation === 'replacement_connection') {
        const replacement = randomUUID();
        db.prepare(`INSERT INTO host_connections(id,workspace_id,service_instance_id,host_surface,plugin_id,plugin_version,runtime_version,connection_mode,request_identity_ref,status)
          SELECT ?,workspace_id,service_instance_id,host_surface,plugin_id,plugin_version,runtime_version,connection_mode,request_identity_ref,status FROM host_connections WHERE id=?`).run(replacement, claim.attempt.host_connection_id!);
        db.prepare('UPDATE host_task_observers SET host_connection_id=? WHERE id=?').run(replacement, String(binding.observer_id));
      }
      const associations = { attempt: getAttempt(db, f.config.workspace_id, claim.attempt.id), binding: db.prepare('SELECT * FROM native_task_bindings WHERE id=?').get(String(binding.id)),
        observer: db.prepare('SELECT * FROM host_task_observers WHERE id=?').get(String(binding.observer_id)), connections: db.prepare('SELECT * FROM host_connections WHERE workspace_id=?').all(f.config.workspace_id) };
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      const finalized = f.results().commitResult(receipt.receipt_id), afterState = snapshot(f.context(), claim.job.id);
      const trace = { mutation, associations, finalized, after: afterState }; evidence(`review-repros/host-association-${mutation}.json`, trace);
      if (mutation === 'legal_control') {
        assert.equal(finalized.state, 'committed'); assert.equal(afterState.candidates.length, 1);
        assert.equal(f.results().receive(f.request('committed-replay'), claim.job.id, input, claim.attempt.lease_owner).state, 'committed');
      } else {
        assert.equal(finalized.state, 'pending'); assert.equal(afterState.candidates.length, 0); assert.equal(afterState.revisions.length, 0);
        assert.throws(() => f.results().receive(f.request(key), claim.job.id, input, claim.attempt.lease_owner), errorCode('HOST_OBSERVER_NOT_READY'));
        assert.throws(() => f.results().receive(f.request('changed-association-cross-key'), claim.job.id, input, claim.attempt.lease_owner), errorCode('HOST_OBSERVER_NOT_READY'));
        assert.equal(f.results().recover()[0]?.state, 'pending');
        f.now += 60_001; f.jobs().recoverExpired(); assert.equal(getReceipt(db, f.config.workspace_id, receipt.receipt_id).state, 'quarantined');
      }
      cases.push(trace);
    } finally { f.cleanup(); }
  }
  return { cases, observation_basis: 'controlled relationship fixture; real host not_run' };
}));

test('review-raw-byte-hash-before-UTF8-decoding', async () => checked('review-raw-byte-hash-before-UTF8-decoding', ['T47'], () => {
  const cases: unknown[] = [];
  for (const corrupt of [true, false]) {
    const f = fixture();
    try {
      const documentId = f.document(), claim = f.create([target(documentId)]), input = f.output(claim, { documents: [{ document_id: documentId, text: 'before\uFFFDafter' }], recommendations: [] });
      const receipt = f.results().receive(f.request(), claim.job.id, input, claim.attempt.lease_owner); f.results().prepare(receipt.receipt_id);
      const intent = receiptIntents(f.context().db, f.config.workspace_id, receipt.receipt_id)[0]!, original = readFileSync(intent.path), index = original.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
      assert.ok(index >= 0); const actual = corrupt ? Buffer.concat([original.subarray(0, index), Buffer.from([0xff]), original.subarray(index + 3)]) : original;
      assert.equal(actual.toString('utf8'), original.toString('utf8'));
      if (corrupt) { chmodSync(intent.path, 0o644); writeFileSync(intent.path, actual); chmodSync(intent.path, 0o444); assert.notEqual(sha256(actual), intent.sha256); }
      const finalized = f.results().commitResult(receipt.receipt_id), afterState = snapshot(f.context(), claim.job.id);
      const trace = { corrupt, original_byte_hash: sha256(original), actual_byte_hash: sha256(actual), decoded_string_hash: sha256(actual.toString('utf8')), registered_hash: intent.sha256, finalized, after: afterState };
      evidence(`review-repros/byte-hash-${corrupt ? 'invalid' : 'valid'}.json`, trace);
      if (corrupt) {
        assert.equal(finalized.state, 'pending'); assert.equal(finalized.files[0]?.error?.reason, 'needs_repair'); assert.equal(afterState.candidates.length, 0); assert.equal(afterState.revisions.length, 0);
        assert.equal(readFileSync(intent.path).equals(actual), true); f.reopen(); assert.equal(f.results().commitResult(receipt.receipt_id).state, 'pending'); assert.equal(snapshot(f.context(), claim.job.id).candidates.length, 0);
      } else { assert.equal(finalized.state, 'committed'); assert.equal(afterState.candidates.length, 1); }
      cases.push(trace);
    } finally { f.cleanup(); }
  }
  return { cases };
}));

test('review-worker-recovery-registration-scope', async () => checked('review-worker-recovery-registration-scope', ['T23'], async () => {
  const cases: unknown[] = [];
  for (const kind of ['publication', 'media_generate', 'source_index']) {
    const f = fixture();
    try {
      const claim = f.create([], { mode: 'none', kind, execution_mode: 'programmatic' }); f.now += 60_001;
      const unrelated = new DurableWorker(f.context(), [{ registration: { kind: 'source_sync', execution_mode: 'programmatic', recovery: 'read_only' }, async execute() { throw new Error('不应执行'); } }], { clock: () => f.now });
      assert.equal(await unrelated.runOnce(), null);
      const beforeGlobalRecovery = snapshot(f.context(), claim.job.id); evidence(`review-repros/unrelated-worker-recovery-${kind}.json`, beforeGlobalRecovery);
      assert.equal(beforeGlobalRecovery.job?.state, 'running'); assert.equal(beforeGlobalRecovery.attempts[0]?.state, 'active');
      const globalRecovery = f.jobs().recoverExpired(), afterState = snapshot(f.context(), claim.job.id);
      assert.equal(afterState.job?.state, kind === 'source_index' ? 'queued' : 'reconciling'); assert.equal(globalRecovery[0]?.reason, 'LEASE_EXPIRED');
      cases.push({ kind, before_global_recovery: beforeGlobalRecovery, globalRecovery, after: afterState });
    } finally { f.cleanup(); }
  }
  return { cases };
}));

test('review-worker-auth-quota-states', async () => checked('review-worker-auth-quota-states', ['T23', 'T48'], async () => {
  const cases: unknown[] = [];
  for (const code of ['AUTH_REQUIRED', 'QUOTA_EXHAUSTED'] as const) for (const sideEffect of [false, true]) {
    const f = fixture();
    try {
      const kind = sideEffect ? 'publication' : 'source_sync';
      f.jobs().enqueue(f.request(), { kind, execution_mode: 'programmatic', entrypoint: 'standalone_web', presentation: 'background', input_manifest: { schema_version: 'wp09-input-v1', mode: 'none', targets: [], source_ids: [] } });
      const worker = new DurableWorker(f.context(), [{ registration: { kind, execution_mode: 'programmatic', recovery: sideEffect ? 'external_side_effect' : 'read_only' }, async execute() { throw new ContractError(code, '受控认证/额度拒绝', { evidence: 'controlled_runtime_error' }, true); } }], { clock: () => f.now });
      const result = await worker.runOnce(), afterState = snapshot(f.context(), result!.job_id), expected = sideEffect ? 'reconciling' : code === 'AUTH_REQUIRED' ? 'waiting_input' : 'waiting_quota';
      evidence(`review-repros/worker-${code}-${sideEffect ? 'side_effect' : 'read_only'}.json`, { expected, result, after: afterState });
      assert.equal(result?.state, expected); assert.equal(JSON.parse(String(afterState.attempts[0]?.error)).code, code);
      assert.equal(afterState.events.at(-1)?.type, sideEffect ? 'reconciling' : code === 'AUTH_REQUIRED' ? 'needs_input' : 'quota_exhausted');
      cases.push({ code, side_effect_possible: sideEffect, result, after: afterState });
    } finally { f.cleanup(); }
  }
  return { cases, side_effect_rule: '认证/额度错误不足以证明平台请求未发送，保留reconciling及原code' };
}));

test('review-checkpoint-fast-failure-crash-and-invalid-fence', async () => checked('review-checkpoint-fast-failure-crash-and-invalid-fence', ['T23', 'T47'], async () => {
  const cases: unknown[] = [];
  for (const kind of ['publication', 'media_generate'] as const) {
    const f = fixture();
    try {
      f.jobs().enqueue(f.request(), { kind, execution_mode: 'programmatic', entrypoint: 'standalone_web', presentation: 'background', input_manifest: { schema_version: 'wp09-input-v1', mode: 'none', targets: [], source_ids: [] } });
      const checkpoint = { remote_task_id: 'known-remote-task-123', sent: true }; let immediatelyPersisted: unknown;
      const worker = new DurableWorker(f.context(), [{ registration: { kind, execution_mode: 'programmatic', recovery: kind === 'publication' ? 'external_side_effect' : 'media' }, async execute(input) {
        input.checkpoint(checkpoint); immediatelyPersisted = f.jobs().get(f.request(), input.claim.job.id).checkpoint; throw new Error('checkpoint之后立即失败');
      } }], { clock: () => f.now });
      const start = performance.now(), result = await worker.runOnce(), elapsedMs = performance.now() - start, afterState = snapshot(f.context(), result!.job_id);
      evidence(`review-repros/checkpoint-immediate-${kind}.json`, { checkpoint, immediatelyPersisted, elapsed_ms: elapsedMs, result, after: afterState });
      assert.deepEqual(immediatelyPersisted, checkpoint); assert.deepEqual(JSON.parse(String(afterState.attempts[0]?.checkpoint)), checkpoint); assert.equal(result?.state, 'reconciling');
      cases.push({ kind, elapsed_ms: elapsedMs, result, after: afterState });
    } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    const queued = f.jobs().enqueue(f.request(), { kind: 'media_generate', execution_mode: 'programmatic', entrypoint: 'standalone_web', presentation: 'background', input_manifest: { schema_version: 'wp09-input-v1', mode: 'none', targets: [], source_ids: [] } });
    const scenario = join(f.root, 'checkpoint-crash.json'); writeFileSync(scenario, JSON.stringify({ config: f.config, kind: queued.kind, now: f.now }));
    const child = spawnSync(process.execPath, [join(projectRoot, 'tests/job-recovery/checkpoint-child.ts'), scenario], { encoding: 'utf8' }); assert.equal(child.signal, 'SIGKILL', child.stderr);
    const childCheckpoint = JSON.parse(child.stdout.trim()); assert.deepEqual(childCheckpoint.checkpoint, { remote_task_id: 'known-remote-task-child', sent: true }); f.reopen();
    const persisted = snapshot(f.context(), queued.id); assert.deepEqual(JSON.parse(String(persisted.attempts[0]?.checkpoint)), childCheckpoint.checkpoint);
    f.now += 60_001; f.jobs().recoverExpired(); assert.equal(f.jobs().get(f.request(), queued.id).job.state, 'reconciling');
    const expiredFence = { job_id: queued.id, attempt_id: childCheckpoint.attempt_id, attempt_generation: Number(persisted.attempts[0]?.attempt_generation), lease_owner: String(persisted.attempts[0]?.lease_owner) };
    assert.throws(() => f.jobs().checkpoint(expiredFence, { remote_task_id: 'expired-owner-overwrite' }), errorCode('HOST_RUN_NOT_CURRENT'));
    const active = f.create([], { mode: 'none', kind: 'media_generate', execution_mode: 'programmatic' });
    assert.throws(() => f.jobs().checkpoint({ ...active.fence, lease_owner: 'wrong-owner' }, { remote_task_id: 'wrong' }), errorCode('HOST_RUN_NOT_CURRENT'));
    f.jobs().checkpoint(active.fence, { remote_task_id: 'before-cancel' }); assert.equal(getAttempt(f.context().db, f.config.workspace_id, active.attempt.id).lease_until, active.attempt.lease_until);
    f.jobs().cancel(f.request(), active.job.id, { expected_version: active.job.version });
    assert.throws(() => f.jobs().checkpoint(active.fence, { remote_task_id: 'after-cancel' }), errorCode('HOST_RUN_NOT_CURRENT'));
    assert.equal(JSON.parse(getAttempt(f.context().db, f.config.workspace_id, active.attempt.id).checkpoint).remote_task_id, 'before-cancel');
    const host = f.create([target(f.document())], { execution_mode: 'host_session' });
    assert.throws(() => f.jobs().checkpoint(host.fence, { remote_task_id: 'host-forbidden' }), errorCode('HOST_RUN_NOT_CURRENT'));
    cases.push({ actual_signal: child.signal, childCheckpoint, persisted, after_recovery: snapshot(f.context(), queued.id), after_cancel: snapshot(f.context(), active.job.id) });
  } finally { f.cleanup(); }
  return { cases };
}));

after(() => {
  const notRun = ['T41/T42/T46/T48 real_observation', 'real_provider', 'real_platform', 'T26/T27 ui_fidelity'].map(substep => ({ substep, scope: substep.includes('ui_fidelity') ? 'ui_fidelity' : substep.includes('real_provider') ? 'real_provider' : substep.includes('real_platform') ? 'real_platform' : 'real_observation', result: 'not_run', limitation: restrictions[0] }));
  const meta = { run_id: runId, generated_at: new Date().toISOString(), versions: { contracts: CONTRACT_VERSION, handoff: 'D07-006', schema: 5, node: process.version }, limitations: restrictions };
  const records = { ...meta, cases: [...ledger, ...notRun], summary: { passed: ledger.filter(row => row.result === 'passed').length, failed: ledger.filter(row => row.result === 'failed').length, not_run: notRun.length }, raw_run_path: runRoot.replace(projectRoot + '/', '') };
  evidence('ledger.json', records); evidence('receipt-fence-matrix.json', { ...meta, cases: matrix }); evidence('hash-idempotency-cases.json', { ...meta, cases: hashes });
  // 根目录仅保存本次索引；每次原始 passed/failed 证据保留在独立 run 下。
  writeFileSync(join(evidenceRoot, 'ledger.json'), JSON.stringify(records, null, 2) + '\n');
  writeFileSync(join(evidenceRoot, 'receipt-fence-matrix.json'), JSON.stringify({ ...meta, cases: matrix }, null, 2) + '\n');
  writeFileSync(join(evidenceRoot, 'hash-idempotency-cases.json'), JSON.stringify({ ...meta, cases: hashes }, null, 2) + '\n');
});
