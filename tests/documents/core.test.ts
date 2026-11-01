import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Documents } from '../../packages/domain/src/documents/index.ts';
import { Topics } from '../../packages/domain/src/topics/index.ts';
import { TopicPreparation } from '../../packages/domain/src/topic-preparation/index.ts';
import { Identities } from '../../packages/domain/src/identity/index.ts';
import { ManagedFiles, parseRevision, serializeRevision } from '../../packages/storage/src/files/index.ts';
import { prepareHumanRevision, prepareRevisionFile, commitHumanRevision, getRevisionRow, compareAndSetHeadInTransaction } from '../../packages/storage/src/revisions/index.ts';
import { transaction, sha256 } from '../../packages/storage/src/connection/index.ts';
import type { DatabaseSync } from 'node:sqlite';
import { fixture, projectRoot, writeEvidence } from './harness.ts';

const protection: unknown[] = []; const crashMatrix: unknown[] = [];
function report(db: DatabaseSync, name: string, facts: unknown) {
  const version = Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version);
  protection.push({ substep: name, result: 'passed', observed_at: new Date().toISOString(), schema_version: version, facts });
  writeEvidence('revision-protection.json', { evidence_scope: 'internal_rule', contract_version: '0.1.1', schema_version: version, checks: protection });
}
function candidate(f: ReturnType<typeof fixture>, documentId: string, base: string | null, core: string, topicId: string) {
  const db = f.context().db; const workspace = f.config.workspace_id;
  const job = randomUUID(), attempt = randomUUID(), receipt = randomUUID(), revision = randomUUID(), id = randomUUID();
  const hash = sha256('fixed-test-input');
  const files = new ManagedFiles(f.config.paths); const content = serializeRevision({ workspace_id: workspace, document_id: documentId, revision_id: revision, parent_revision_id: base,
    topic_id: topicId, kind: 'variant', source_ids: [], created_at: new Date().toISOString(), origin: 'agent', change_kind: 'text', created_by: 'fixed-fixture', based_on_core_revision_id: core,
    restore_from_revision_id: null, merge_candidate_id: null, job_id: job, attempt_id: attempt, attempt_generation: 1, result_receipt_id: receipt }, '固定候选正文');
  const path = files.revisionPath(documentId, revision); files.writeUniqueRevision(path, content, sha256(content));
  transaction(db, () => {
    db.prepare("INSERT INTO jobs (id,workspace_id,kind,target_id,entrypoint,execution_mode,attempt_generation,input_manifest,input_hash,state,retry_policy,presentation,version) VALUES (?,?,?,?,'standalone_web','service_adapter',1,'{}',?,'succeeded','{}','background',1)").run(job, workspace, 'variant_generation', documentId, hash);
    db.prepare("INSERT INTO job_attempts (id,workspace_id,job_id,attempt_no,attempt_generation,state,lease_owner,lease_until,checkpoint) VALUES (?,?,?,1,1,'succeeded','fixed-fixture',?,'{}')").run(attempt, workspace, job, new Date().toISOString());
    db.prepare("INSERT INTO result_receipts (id,workspace_id,job_id,attempt_id,attempt_generation,input_hash,output_hash,commit_purpose,state,result_ids,idempotency_requests) VALUES (?,?,?,?,1,?,?,'agent_candidate','committed','[]','[]')").run(receipt, workspace, job, attempt, hash, hash);
    db.prepare("INSERT INTO document_revisions (id,workspace_id,document_id,parent_revision_id,file_path,sha256,origin,change_kind,job_id,attempt_id,attempt_generation,result_receipt_id,based_on_core_revision_id,created_by) VALUES (?,?,?,?,?,?,'agent','text',?,?,1,?,?,'fixed-fixture')").run(revision, workspace, documentId, base, path, sha256(content), job, attempt, receipt, core);
    db.prepare("INSERT INTO candidates (id,workspace_id,target_document_id,base_revision_id,revision_id,job_id,attempt_id,attempt_generation,result_receipt_id,status) VALUES (?,?,?,?,?,?,?,1,?,'pending')").run(id, workspace, documentId, base, revision, job, attempt, receipt);
  }); return { candidate_id: id, revision_id: revision };
}

test('core approval binds saved revision; old expected rejected; restore appends and preserves old bytes', async () => {
  const f = fixture(); try {
    const documents = new Documents(f.context()); const topics = new Topics(f.context());
    const topic = await topics.create(f.request(), { title: '固定测试主题', category: 'AI 实测', audience: '创作者', source_ids: [] });
    const r1 = await documents.save(f.request(), topic.core_document_id, { expected_revision_id: null, text: '核心 r1', origin: 'human' });
    const row1 = getRevisionRow(f.context().db, f.config.workspace_id, r1.revision_id); const original = readFileSync(row1.file_path);
    await documents.approveCore(f.request(), topic.id, r1.revision_id);
    const r2 = await documents.save(f.request(), topic.core_document_id, { expected_revision_id: r1.revision_id, text: '人工 r2', origin: 'human' });
    assert.equal((await topics.get(f.request(), topic.id)).core_approval, null);
    await assert.rejects(documents.approveCore(f.request(), topic.id, r1.revision_id), { code: 'REVISION_CONFLICT' });
    await assert.rejects(documents.save(f.request(), topic.core_document_id, { expected_revision_id: r1.revision_id, text: '旧请求', origin: 'human' }), { code: 'REVISION_CONFLICT' });
    const restored = await documents.restore(f.request(), topic.core_document_id, { expected_revision_id: r2.revision_id, revision_id: r1.revision_id });
    assert.notEqual(restored.revision_id, r1.revision_id); assert.equal((await documents.get(f.request(), topic.core_document_id)).text, '核心 r1');
    assert.deepEqual(readFileSync(row1.file_path), original);
    assert.equal(getRevisionRow(f.context().db, f.config.workspace_id, restored.revision_id).parent_revision_id, r2.revision_id);
    report(f.context().db, 'T04/T25.revision_approval_restore', { r1: r1.revision_id, r2: r2.revision_id, restored: restored.revision_id, original_sha256: sha256(original), old_approval_invalid: true });
  } finally { f.cleanup(); }
});

test('real SIGKILL at prepare/rename/DB commit; separate process recovers exactly one human revision', async () => {
  for (const phase of ['after_prepare', 'after_rename', 'after_commit']) {
    const f = fixture(); try {
      const documents = new Documents(f.context()); const initial = await documents.create(f.request(), { kind: 'note', initial_text: '原文' });
      f.closeDb();
      const child = spawnSync(process.execPath, [join(projectRoot, 'tests/documents/child-save.ts'), f.configPath, initial.document_id, initial.head_revision_id!, phase], { encoding: 'utf8' });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const recovery = spawnSync(process.execPath, [join(projectRoot, 'tests/documents/child-save.ts'), f.configPath, initial.document_id, initial.head_revision_id!, 'recover'], { encoding: 'utf8' });
      assert.equal(recovery.status, 0, recovery.stderr); f.openDb();
      const recovered = await new Documents(f.context()).get(f.request(), initial.document_id);
      assert.equal(recovered.text, `保存中断-${phase}`);
      assert.equal(f.context().db.prepare('SELECT COUNT(*) AS n FROM document_revisions WHERE workspace_id=? AND document_id=?').get(f.config.workspace_id, initial.document_id)?.n, 2);
      const replay = new Documents(f.context()).recover(); assert.deepEqual(replay, []);
      crashMatrix.push({ phase, signal: child.signal, recovery: JSON.parse(recovery.stdout), result: 'passed', revision_id: recovered.head_revision_id, text_sha256: sha256(recovered.text), replay_added_revisions: 0, observed_at: new Date().toISOString() });
      writeEvidence('crash-results.json', { evidence_scope: 'internal_rule', actual_process_termination: 'SIGKILL', checks: crashMatrix });
    } finally { f.cleanup(); }
  }
});

test('pending human save whose head changed persists human conflict branch and never moves current head', async () => {
  const f = fixture(); try {
    const documents = new Documents(f.context()); const initial = await documents.create(f.request(), { kind: 'wiki', initial_text: '' });
    assert.equal(initial.text, ''); const files = new ManagedFiles(f.config.paths);
    const pending = prepareHumanRevision(f.context().db, files, f.request(), { document_id: initial.document_id, expected_revision_id: initial.head_revision_id, text: '保留的未提交内容' });
    const newer = await documents.save(f.request(), initial.document_id, { expected_revision_id: initial.head_revision_id, text: '较新的人工稿', origin: 'human' });
    prepareRevisionFile(f.context().db, files, f.config.workspace_id, pending.write_intent_id);
    assert.throws(() => commitHumanRevision(f.context().db, files, f.config.workspace_id, pending.write_intent_id), { code: 'REVISION_CONFLICT' });
    assert.equal((await documents.get(f.request(), initial.document_id)).head_revision_id, newer.revision_id);
    const branch = getRevisionRow(f.context().db, f.config.workspace_id, pending.revision_id);
    assert.equal(branch.origin, 'human'); assert.equal(parseRevision(readFileSync(branch.file_path, 'utf8')).text, '保留的未提交内容');
    report(f.context().db, 'T21.human_conflict_branch_and_empty_wiki', { conflict_revision_id: branch.id, current_head: newer.revision_id, empty_wiki_saved: true });
  } finally { f.cleanup(); }
});

test('candidate base cannot be refreshed; core freshness checked; merge creates human revision with evidence', async () => {
  const f = fixture(); try {
    const documents = new Documents(f.context()); const topic = await new Topics(f.context()).create(f.request(), { title: '候选测试', category: 'AI 实测', audience: '', source_ids: [] });
    const core = await documents.save(f.request(), topic.core_document_id, { expected_revision_id: null, text: '已确认核心', origin: 'human' }); await documents.approveCore(f.request(), topic.id, core.revision_id);
    const variantDocument = await documents.create(f.request(), { kind: 'variant', initial_text: '人工平台 r1' }); const variantId = randomUUID();
    f.context().db.prepare("INSERT INTO variants (id,workspace_id,topic_id,platform,format,variant_key,document_id,based_on_core_revision_id,status,version) VALUES (?,?,?,'x','text','main',?,?,'ready',1)").run(variantId, f.config.workspace_id, topic.id, variantDocument.document_id, core.revision_id);
    const old = candidate(f, variantDocument.document_id, variantDocument.head_revision_id, core.revision_id, topic.id);
    const human = await documents.save(f.request(), variantDocument.document_id, { expected_revision_id: variantDocument.head_revision_id, text: '人工平台 r2', origin: 'human' });
    assert.equal(getRevisionRow(f.context().db, f.config.workspace_id, human.revision_id).based_on_core_revision_id, core.revision_id);
    await assert.rejects(documents.adoptCandidate(f.request(), old.candidate_id, { expected_revision_id: variantDocument.head_revision_id }), { code: 'REVISION_CONFLICT' });
    await assert.rejects(documents.adoptCandidate(f.request(), old.candidate_id, { expected_revision_id: human.revision_id }), { code: 'REVISION_CONFLICT' });
    const current = candidate(f, variantDocument.document_id, human.revision_id, core.revision_id, topic.id);
    const coreNew = await documents.save(f.request(), topic.core_document_id, { expected_revision_id: core.revision_id, text: '核心新版', origin: 'human' });
    await documents.approveCore(f.request(), topic.id, coreNew.revision_id);
    await assert.rejects(documents.adoptCandidate(f.request(), current.candidate_id, { expected_revision_id: human.revision_id }), { code: 'INPUT_STALE' });
    const merged = await documents.merge(f.request(), variantDocument.document_id, { expected_revision_id: human.revision_id, candidate_id: old.candidate_id, merged_text: '人工核对后的合并正文' });
    const row = getRevisionRow(f.context().db, f.config.workspace_id, merged.revision_id);
    assert.equal(row.origin, 'human'); assert.equal(row.change_kind, 'merge'); assert.equal(row.parent_revision_id, human.revision_id);
    assert.equal(f.context().db.prepare("SELECT source_id FROM evidence_links WHERE workspace_id=? AND owner_id=? AND source_type='candidate'").get(f.config.workspace_id, row.id)?.source_id, old.candidate_id);
    report(f.context().db, 'T05/T25.three_way_and_core_freshness', { fixed_candidate: old.candidate_id, refreshed_expected_still_rejected: true, stale_core_rejected: true, merge_revision: merged.revision_id, fixture_scope: 'fixed committed candidate; no real Agent' });
  } finally { f.cleanup(); }
});

test('idempotency replays original response and rejects key reused with different body or operation', async () => {
  const f = fixture(); try {
    const documents = new Documents(f.context()); const request = f.request('fixed-key'); const input = { kind: 'note', initial_text: '原始保存' };
    const first = await documents.create(request, input); await documents.save(f.request(), first.document_id, { expected_revision_id: first.head_revision_id, text: '后续保存', origin: 'human' });
    assert.deepEqual(await documents.create(request, input), first);
    await assert.rejects(documents.create(request, { ...input, initial_text: '不同正文' }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(new Topics(f.context()).create(request, { title: '不同操作', category: '', audience: '', source_ids: [] }), { code: 'IDEMPOTENCY_CONFLICT' });
    report(f.context().db, 'T21.idempotent_original_response', { document_id: first.document_id, same_response: true, cross_operation_rejected: true });
  } finally { f.cleanup(); }
});

test('completed approval and alignment replay original receipt after core changes; new requests retain freshness guards', async () => {
  const f = fixture(); try {
    const documents = new Documents(f.context()); const topic = await new Topics(f.context()).create(f.request(), { title: '重放核心确认', category: '', audience: '', source_ids: [] });
    const first = await documents.save(f.request(), topic.core_document_id, { expected_revision_id: null, text: '核心 r1', origin: 'human' });
    const approvalRequest = f.request('original-core-approval'); const approved = await documents.approveCore(approvalRequest, topic.id, first.revision_id);
    const variantDocument = await documents.create(f.request(), { kind: 'variant', initial_text: '待对齐平台文稿' }); const variant = randomUUID();
    f.context().db.prepare("INSERT INTO variants (id,workspace_id,topic_id,platform,format,variant_key,document_id,based_on_core_revision_id,status,version) VALUES (?,?,?,'x','text','replay',?,?,'ready',1)").run(variant, f.config.workspace_id, topic.id, variantDocument.document_id, first.revision_id);
    const alignmentRequest = f.request('original-core-alignment'); const alignmentInput = { expected_revision_id: variantDocument.head_revision_id, confirmed_core_revision_id: first.revision_id };
    const aligned = await documents.alignCore(alignmentRequest, variant, alignmentInput);
    const next = await documents.save(f.request(), topic.core_document_id, { expected_revision_id: first.revision_id, text: '核心 r2', origin: 'human' }); await documents.approveCore(f.request(), topic.id, next.revision_id);
    assert.deepEqual(await documents.approveCore(approvalRequest, topic.id, first.revision_id), approved);
    assert.deepEqual(await documents.alignCore(alignmentRequest, variant, alignmentInput), aligned);
    await assert.rejects(documents.approveCore(f.request(), topic.id, first.revision_id), { code: 'REVISION_CONFLICT' });
    await assert.rejects(documents.alignCore(f.request(), variant, { expected_revision_id: aligned.revision_id, confirmed_core_revision_id: first.revision_id }), { code: 'INPUT_STALE' });
    await assert.rejects(documents.alignCore(alignmentRequest, variant, { ...alignmentInput, confirmed_core_revision_id: next.revision_id }), { code: 'IDEMPOTENCY_CONFLICT' });
    report(f.context().db, 'T21.approval_alignment_replay_before_mutable_checks', { approval_id: approved.approval_id, aligned_revision: aligned.revision_id,
      old_receipt_replayed_after_core_change: true, different_key_old_core_rejected: true, same_key_changed_body_rejected: true });
  } finally { f.cleanup(); }
});

test('恢复旧平台修订保持旧核心和 stale，后续人工编辑不自动对齐；无核心旧稿同样不能 ready', async () => {
  const f = fixture(); try {
    const documents = new Documents(f.context()); const topic = await new Topics(f.context()).create(f.request(), { title: '旧稿核心回归', category: '', audience: '', source_ids: [] });
    const core1 = await documents.save(f.request(), topic.core_document_id, { expected_revision_id: null, text: '核心一', origin: 'human' });
    await documents.approveCore(f.request(), topic.id, core1.revision_id);
    const initial = await documents.create(f.request(), { kind: 'variant', initial_text: '尚未绑定核心的初始正文' }); const variantId = randomUUID();
    f.context().db.prepare("INSERT INTO variants (id,workspace_id,topic_id,platform,format,variant_key,document_id,based_on_core_revision_id,status,version) VALUES (?,?,?,'x','text','restore-regression',?,?,'ready',1)").run(variantId, f.config.workspace_id, topic.id, initial.document_id, core1.revision_id);
    const r1 = await documents.alignCore(f.request(), variantId, { expected_revision_id: initial.head_revision_id, confirmed_core_revision_id: core1.revision_id });
    const core2 = await documents.save(f.request(), topic.core_document_id, { expected_revision_id: core1.revision_id, text: '核心二', origin: 'human' });
    await documents.approveCore(f.request(), topic.id, core2.revision_id);
    const aligned = await documents.alignCore(f.request(), variantId, { expected_revision_id: r1.revision_id, confirmed_core_revision_id: core2.revision_id });
    const restoreRequest = f.request('restore-old-platform'); const input = { expected_revision_id: aligned.revision_id, revision_id: r1.revision_id };
    const restored = await documents.restore(restoreRequest, initial.document_id, input);
    const variant = () => f.context().db.prepare('SELECT * FROM variants WHERE id=?').get(variantId)!;
    assert.equal(variant().based_on_core_revision_id, core1.revision_id); assert.equal(variant().status, 'stale');
    const snapshot = await documents.get(f.request(), initial.document_id);
    assert.equal(parseRevision(readFileSync(getRevisionRow(f.context().db, f.config.workspace_id, restored.revision_id).file_path, 'utf8')).metadata.based_on_core_revision_id, core1.revision_id);
    const saved = await documents.save(f.request(), initial.document_id, { expected_revision_id: snapshot.head_revision_id, text: '基于旧核心的人工修改', origin: 'human' });
    assert.equal(getRevisionRow(f.context().db, f.config.workspace_id, saved.revision_id).based_on_core_revision_id, core1.revision_id); assert.equal(variant().status, 'stale');
    const beforeReplay = variant(); assert.deepEqual(await documents.restore(restoreRequest, initial.document_id, input), restored); assert.deepEqual(variant(), beforeReplay);
    await assert.rejects(documents.restore(f.request(), initial.document_id, input), { code: 'REVISION_CONFLICT' }); assert.deepEqual(variant(), beforeReplay);
    const realigned = await documents.alignCore(f.request(), variantId, { expected_revision_id: saved.revision_id, confirmed_core_revision_id: core2.revision_id });
    assert.equal(variant().status, 'ready'); assert.equal(variant().based_on_core_revision_id, core2.revision_id);
    const withoutCore = await documents.restore(f.request(), initial.document_id, { expected_revision_id: realigned.revision_id, revision_id: initial.head_revision_id! });
    let head = withoutCore.revision_id; assert.equal(variant().status, 'stale');
    for (const text of ['无核心旧稿编辑一', '无核心旧稿编辑二']) {
      const edit = await documents.save(f.request(), initial.document_id, { expected_revision_id: head, text, origin: 'human' }); head = edit.revision_id;
      assert.equal(getRevisionRow(f.context().db, f.config.workspace_id, head).based_on_core_revision_id, null); assert.equal(variant().status, 'stale');
    }
    await documents.alignCore(f.request(), variantId, { expected_revision_id: head, confirmed_core_revision_id: core2.revision_id }); assert.equal(variant().status, 'ready');
    report(f.context().db, 'review.R3.restore_variant_core_basis', { old_core_preserved: true, old_and_null_core_stale: true, human_edits_do_not_align: true, explicit_alignment_ready: true, replay_and_conflict_do_not_change_variant: true });
  } finally { f.cleanup(); }
});

test('conditional empty-head CAS allows one move; this is not task-level double initialization', async () => {
  const f = fixture(); try {
    const document = await new Documents(f.context()).create(f.request(), { kind: 'note', initial_text: '固定保存' });
    const db = f.context().db; const id = randomUUID(); db.prepare("INSERT INTO documents (id,workspace_id,kind,version) VALUES (?,?,'note',1)").run(id, f.config.workspace_id);
    const files = new ManagedFiles(f.config.paths); const prepared = prepareHumanRevision(db, files, f.request(), { document_id: id, expected_revision_id: null, text: '新空目标正文' });
    prepareRevisionFile(db, files, f.config.workspace_id, prepared.write_intent_id); commitHumanRevision(db, files, f.config.workspace_id, prepared.write_intent_id);
    assert.equal(transaction(db, () => compareAndSetHeadInTransaction(db, f.config.workspace_id, id, null, prepared.revision_id)), false);
    assert.throws(() => transaction(db, () => compareAndSetHeadInTransaction(db, f.config.workspace_id, id, prepared.revision_id, document.head_revision_id!)), { code: 'NOT_FOUND' });
    report(f.context().db, 'T28.empty_head_CAS_primitive', { primitive_only: true, first_move: true, second_empty_move: false, wrong_document_revision_rejected: true, task_finalizer: 'not_run/WP-09' });
  } finally { f.cleanup(); }
});

test('external working edit conflicts on fixed base; archived mutation preserved and repaired from verified backup', async () => {
  const f = fixture(); try {
    const documents = new Documents(f.context()); const initial = await documents.create(f.request(), { kind: 'note', initial_text: '已归档原文' });
    const row = getRevisionRow(f.context().db, f.config.workspace_id, initial.head_revision_id!); const original = readFileSync(row.file_path, 'utf8'); const parsed = parseRevision(original);
    const working = new ManagedFiles(f.config.paths).workingPath(initial.document_id); mkdirSync(join(f.config.paths.managed_notes_root, 'working'));
    writeFileSync(working, serializeRevision({ ...parsed.metadata, base_revision_id: initial.head_revision_id }, '外部副本编辑'));
    const newer = await documents.save(f.request(), initial.document_id, { expected_revision_id: initial.head_revision_id, text: '当前人工头', origin: 'human' });
    await assert.rejects(documents.importWorking(f.request(), initial.document_id), { code: 'REVISION_CONFLICT' });
    assert.equal((await documents.get(f.request(), initial.document_id)).head_revision_id, newer.revision_id);
    chmodSync(row.file_path, 0o644); writeFileSync(row.file_path, '直接改归档的异常内容');
    const read = new ManagedFiles(f.config.paths).readRevision(row.file_path, row.sha256 as ReturnType<typeof sha256>);
    assert.equal(read.repaired, true); assert.equal(read.content, original); assert.ok(read.modified_copy && existsSync(read.modified_copy));
    report(f.context().db, 'T21.working_and_archive_detection', { preserved_current_head: newer.revision_id, working_conflict: true, archive_backup_hash: row.sha256, archive_repaired: true, modified_copy_preserved: true });
  } finally { f.cleanup(); }
});

test('new topic without variant or approved core edits preparation; real SQLite close/reopen recovers immutable shots', async () => {
  const f = fixture(); try {
    const topic = await new Topics(f.context()).create(f.request(), { title: '无平台准备', category: '个人思考', audience: '', source_ids: [] });
    assert.equal(topic.core_approval, null); assert.equal(topic.variants.length, 0); assert.equal(topic.core.head_revision_id, null); assert.ok(topic.shots.length);
    const preparation = new TopicPreparation(f.context()); const before = await preparation.get(f.request(), topic.preparation_plan_id);
    const shots = [{ shot_key: 'b', position: 0, title: '开场实拍', kind: 'live_action', duration_ms: 2000, source_requirement: { status: 'pending' } },
      { shot_key: 'a', position: 1, title: '操作录屏', kind: 'screen_recording', duration_ms: 3000, source_requirement: { status: 'pending' } }];
    const revised = await preparation.revise(f.request(), before.id, { expected_version: before.version, base_plan_revision_id: before.head_plan_revision_id, shots });
    await assert.rejects(preparation.revise(f.request(), before.id, { expected_version: 1, base_plan_revision_id: before.head_plan_revision_id, shots }), { code: 'VERSION_CONFLICT' });
    assert.throws(() => preparation.requireRenderable(f.request(), before.id), { code: 'VALIDATION_ERROR' });
    f.reopen(); const recovered = await new TopicPreparation(f.context()).get(f.request(), before.id);
    assert.equal(recovered.head_plan_revision_id, revised.plan_revision_id); assert.equal(recovered.shots[0]?.duration_ms, 2000); assert.equal(recovered.shots[1]?.shot_key, 'a');
    assert.equal(f.context().db.prepare('SELECT variant_revision_id,script_revision_id FROM production_plan_revisions WHERE id=?').get(revised.plan_revision_id)?.script_revision_id, null);
    const old = new TopicPreparation(f.context()).revision(f.request(), before.id, before.head_plan_revision_id); assert.equal(old.shots[0]?.title, '待准备镜头');
    writeEvidence('preparation-recovery.json', { evidence_scope: 'internal_rule', result: 'passed', observed_at: new Date().toISOString(), topic_id: topic.id,
      no_variant: true, no_core_approval: true, initial_revision: before.head_plan_revision_id, recovered_revision: revised.plan_revision_id, old_shots_unchanged: true,
      script_revision_id: null, render_rejected: true, actual_close_reopen: true, ordered_shots: recovered.shots });
  } finally { f.cleanup(); }
});

test('pending work preserves null ID/author/format; canonical collision keeps alias and provenance, counts once', async () => {
  const f = fixture(); try {
    const identities = new Identities(f.context()); const first = await identities.importWork(f.request(), { platform: 'x', url: 'https://x.com/example/status/123?utm_source=test' });
    const second = await identities.importWork(f.request(), { platform: 'x', url: 'https://x.com/example/status/123?source=identity' });
    const firstRow = identities.get(f.request(), first.work_id); assert.equal(firstRow.platform_work_id, null); assert.equal(firstRow.account_id, null); assert.equal(firstRow.format, null);
    const duplicateUrl = await identities.importWork(f.request(), { platform: 'x', url: 'https://x.com/example/status/123?utm_medium=other' }); assert.equal(duplicateUrl.work_id, first.work_id);
    const account = randomUUID(); f.context().db.prepare("INSERT INTO accounts (id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'x','account-1','owner','固定身份','https://x.com/example','confirmed')").run(account, f.config.workspace_id);
    identities.resolveVerified(f.request(), first.work_id, { platform_work_id: '123', account_id: account, evidence: { source: 'fixed_identity_fixture', confirmed_author: true } });
    const sourceId = randomUUID(), recordId = randomUUID();
    f.context().db.prepare("INSERT INTO sources (id,workspace_id,kind,url,schema_version) VALUES (?,?,'fixed_identity_fixture','https://example.invalid/wp08','fixture-v1')").run(sourceId, f.config.workspace_id);
    f.context().db.prepare("INSERT INTO source_records (id,workspace_id,source_id,work_id,record_kind,content_status) VALUES (?,?,?,?,'fixed_identity_fixture','unknown')").run(recordId, f.config.workspace_id, sourceId, second.work_id);
    const snapshotId = randomUUID();
    f.context().db.prepare("INSERT INTO snapshots (id,workspace_id,work_id,source_id,collection_request_id,request_fingerprint,observed_time_basis,observed_time_reason,collected_at,raw_path,raw_sha256,adapter_version) VALUES (?,?,?,?,?,?,'unknown','fixed fixture without real observation',?,?,?,'fixture-v1')")
      .run(snapshotId, f.config.workspace_id, second.work_id, sourceId, randomUUID(), sha256('fixed-fixture-request'), new Date().toISOString(), join(f.root, 'fixed-fixture-no-real-metrics'), sha256('fixed-fixture-no-real-metrics'));
    identities.resolveVerified(f.request(), second.work_id, { platform_work_id: '123', account_id: account, evidence: { source: 'fixed_alias_fixture', source_work_id: second.work_id } });
    assert.equal(await identities.resolveCanonical(f.request(), second.work_id), first.work_id); assert.equal(identities.list(f.request()).items.length, 1);
    assert.equal(f.context().db.prepare('SELECT COUNT(*) AS n FROM works WHERE workspace_id=?').get(f.config.workspace_id)?.n, 2);
    const alias = f.context().db.prepare('SELECT source_url,resolution_evidence FROM work_aliases WHERE workspace_id=? AND alias_work_id=?').get(f.config.workspace_id, second.work_id);
    assert.ok(alias?.resolution_evidence); assert.equal(alias?.source_url, 'https://x.com/example/status/123?source=identity');
    assert.equal(f.context().db.prepare('SELECT work_id FROM source_records WHERE id=?').get(recordId)?.work_id, second.work_id);
    assert.equal(f.context().db.prepare('SELECT work_id FROM snapshots WHERE id=?').get(snapshotId)?.work_id, second.work_id);
    assert.throws(() => identities.resolveVerified(f.request(), first.work_id, { platform_work_id: 'different-id', account_id: account, evidence: { source: 'conflicting_fixture' } }), { code: 'VALIDATION_ERROR' });
    const unknownAuthor = await identities.importWork(f.request(), { platform: 'x', url: 'https://x.com/unknown/status/789' });
    identities.resolveVerified(f.request(), unknownAuthor.work_id, { platform_work_id: '789', account_id: null, evidence: { source: 'fixed_id_only_fixture' } });
    assert.equal(identities.get(f.request(), unknownAuthor.work_id).account_id, null); assert.equal(identities.get(f.request(), unknownAuthor.work_id).format, null);
    writeEvidence('identity-merge.json', { evidence_scope: 'internal_rule', result: 'passed', observed_at: new Date().toISOString(), null_before_resolution: { platform_work_id: null, account_id: null, format: null },
      canonical_work_id: first.work_id, alias_work_id: second.work_id, duplicate_group_stored_rows: 2, duplicate_group_canonical_rows: 1,
      source_url_preserved: true, resolution_evidence_preserved: true, source_record_and_snapshot_original_work_id_preserved: true,
      known_id_unknown_author_stays_null: true, conflicting_established_identity_rejected: true, fixture_snapshot_contains_no_metric_values: true, real_provider: 'not_run' });
  } finally { f.cleanup(); }
});
