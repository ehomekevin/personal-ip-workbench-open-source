import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError, type NativeIdentity } from '../../packages/contracts/src/index.ts';
import { HostRuns } from '../../packages/domain/src/host-runs/index.ts';
import { Documents } from '../../packages/domain/src/documents/index.ts';
import { getJob, getAttempt } from '../../packages/storage/src/jobs/index.ts';
import { identityOf } from '../../packages/storage/src/host-tracking/index.ts';
import { Topics } from '../../packages/domain/src/topics/index.ts';
import { randomUUID } from 'node:crypto';
import { fixture, evidence, profile } from './harness.ts';
const error = (code: string) => (e: unknown) => e instanceof ContractError && e.code === code;
const results: Array<Record<string, unknown>> = [];
async function checked(name: string, cases: string[], act: () => Promise<void> | void) {
  const start = new Date().toISOString(); try { await act(); results.push({ name, cases, scope: 'internal_rule', result: 'passed', actual_operation_at: start }); }
  catch (e) { results.push({ name, cases, scope: 'internal_rule', result: 'failed', actual_operation_at: start, error: e instanceof Error ? e.stack : String(e) }); throw e; }
  finally { evidence('protocol-results.json', results); }
}

test('T46 来源凭据、角色与缺 tracking 拒绝', async () => checked('T46-trusted-provenance', ['T46'], async () => {
  const f = fixture(); try {
    assert.throws(() => new HostRuns(f.context()).authority.authenticate({ authorization: `Bearer ${f.program.observer_credential}` }, 'observer'), error('AUTH_REQUIRED'));
    assert.throws(() => f.runs.authority.authenticate({ 'x-request-identity': f.program.owner }, 'observer'), error('AUTH_REQUIRED'));
    assert.throws(() => f.runs.register(f.request(), { owner: f.program.owner, host_connection_id: f.program.host_connection_id, role: 'observer' }, { host_connection_id: f.program.host_connection_id, observer_epoch: 'epoch', capability_record_id: f.capabilityId, capability_version: 1 }), error('AUTH_REQUIRED'));
    f.context().db.prepare("UPDATE host_capability_records SET status='unverified' WHERE id=?").run(f.capabilityId);
    assert.throws(() => f.observer(), error('CAPABILITY_UNVERIFIED'));
    assert.equal(f.context().db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n, 0);
    f.context().db.prepare("UPDATE host_capability_records SET status='unsupported' WHERE id=?").run(f.capabilityId); assert.throws(() => f.observer(), error('CAPABILITY_UNSUPPORTED'));
  } finally { f.cleanup(); }
}));

for (const source of ['conversation', 'page_action'] as const) test(`T46 ${source} owner/identity/观察准入与同事务消费`, async () => checked(`T46-admission-${source}`, ['T46', 'T44'], async () => {
  const f = fixture(); try {
    const doc = await f.document(), observer = f.observer();
    for (const native_identity of [{ scope: 'turn', native_namespace: 'n', native_session_id: '', native_turn_id: 't' }, { scope: 'task', native_namespace: '', native_task_id: 't' }] as NativeIdentity[]) assert.throws(() => f.binding(observer, native_identity), error('HOST_TASK_BINDING_INVALID'));
    const b = f.binding(observer); assert.throws(() => f.binding(observer, identityOf(b)), error('HOST_TASK_BINDING_INVALID'));
    const input = f.beginInput(doc, b, source);
    assert.throws(() => f.runs.begin(f.request(), f.principal('connection'), input), error('HOST_OBSERVER_NOT_READY'));
    assert.throws(() => f.runs.begin(f.request(), f.principal('observer'), input), error('AUTH_REQUIRED'));
    const observed = f.observation(b), run = f.runs.begin(f.request(), f.principal('connection'), input);
    assert.equal(f.context().db.prepare('SELECT last_renewed_observation_id FROM native_task_bindings WHERE id=?').get(b.id)!.last_renewed_observation_id, observed.id);
    assert.throws(() => f.runs.renew(f.request(), f.principal('observer'), run.job_id, { attempt_id: run.attempt_id, attempt_generation: run.attempt_generation, observation_id: observed.id, expected_version: run.version }), error('HOST_OBSERVER_NOT_READY'));
    assert.equal(f.jobs().claim('worker:fixture'), null);
    assert.equal(getJob(f.context().db, f.config.workspace_id, run.job_id).presentation, source === 'conversation' ? 'host_conversation' : 'foreground_dialog');
    evidence(`${source}-admission.json`, f.snapshot(run.job_id));
  } finally { f.cleanup(); }
}));

test('T46 新鲜度、乱序、重放、未来时钟与终态拒绝', async () => checked('T46-observation-rejections', ['T46', 'T48'], async () => {
  const f = fixture(); try {
    const { b, run } = await f.begin();
    assert.throws(() => f.observation(b, 'running', 1), error('HOST_OBSERVER_NOT_READY'));
    assert.throws(() => f.observation(b, 'running', 2, new Date(f.now - profile.freshness_ms - 1).toISOString()), error('HOST_OBSERVER_NOT_READY'));
    assert.throws(() => f.observation(b, 'running', 2, new Date(f.now + profile.future_skew_ms + 1).toISOString()), error('HOST_OBSERVER_NOT_READY'));
    f.now += 100; const latest = f.observation(b, 'waiting_tool', 2);
    assert.throws(() => f.observation(b, 'running', 3, new Date(f.now - 50).toISOString()), error('HOST_OBSERVER_NOT_READY'));
    f.now += profile.freshness_ms + 1;
    assert.throws(() => f.runs.renew(f.request(), f.principal('observer'), run.job_id, { attempt_id: run.attempt_id, attempt_generation: run.attempt_generation, observation_id: latest.id, expected_version: run.version }), error('HOST_OBSERVER_NOT_READY'));
    f.observation(b, 'completed', 3); const deadline = getAttempt(f.context().db, f.config.workspace_id, run.attempt_id).output_deadline;
    assert.throws(() => f.observation(b, 'running', 4), error('HOST_TASK_BINDING_INVALID'));
    f.now += 100; f.observation(b, 'completed', 4); assert.equal(getAttempt(f.context().db, f.config.workspace_id, run.attempt_id).output_deadline, deadline);
    assert.throws(() => f.runs.renew(f.request(), f.principal('observer'), run.job_id, { attempt_id: run.attempt_id, attempt_generation: run.attempt_generation, observation_id: latest.id, expected_version: getJob(f.context().db, f.config.workspace_id, run.job_id).version }), error('HOST_OBSERVER_NOT_READY'));
    evidence('observation-rejections.json', f.snapshot(run.job_id));
  } finally { f.cleanup(); }
}));

test('T46 内部长任务跨初始 lease 必须逐次新观察', async () => checked('T46-long-task-renewal', ['T46'], async () => {
  const f = fixture(); try {
    const { b, run } = await f.begin(), initialLease = run.lease_until; let latest = run;
    for (let n = 0; n < 6; n++) { f.now += 1000; const observation = f.observation(b, n % 2 ? 'waiting_tool' : 'running'); latest = f.runs.renew(f.request(), f.principal('observer'), run.job_id, { attempt_id: run.attempt_id, attempt_generation: run.attempt_generation, observation_id: observation.id, expected_version: latest.version }); }
    assert.ok(f.now > Date.parse(initialLease)); assert.ok(Date.parse(latest.lease_until) > f.now);
    evidence('internal-long-task.json', f.snapshot(run.job_id));
  } finally { f.cleanup(); }
}));

test('T42 断线不续期、原截止恢复、到期新身份 resume 与旧输出隔离', async () => checked('T42-disconnect-resume', ['T42', 'T46', 'T48'], async () => {
  const f = fixture(); try {
    const { b, run } = await f.begin(); f.now += 100; f.observation(b, 'disconnected');
    assert.throws(() => f.runs.submit(f.request(), f.principal('connection'), run.job_id, f.output(run)), error('HOST_OBSERVER_NOT_READY'));
    const originalLease = getAttempt(f.context().db, f.config.workspace_id, run.attempt_id).lease_until;
    f.now += 100; f.runs.reattach(f.request(), f.principal('observer'), b.id, { observer_epoch: b.observer_epoch, native_identity: identityOf(b), observation: { sequence: 3, native_state: 'running', observed_at: new Date(f.now).toISOString(), native_evidence_ref: 'internal-reattach-query' } });
    assert.equal(getAttempt(f.context().db, f.config.workspace_id, run.attempt_id).lease_until, originalLease);
    f.now = Date.parse(originalLease); f.runs.recoverExpired(); const expired = getJob(f.context().db, f.config.workspace_id, run.job_id); assert.equal(expired.state, 'waiting_input');
    assert.throws(() => f.binding(f.observer(b.observer_epoch), identityOf(b)), error('HOST_TASK_BINDING_INVALID'));
    const newBinding = f.binding(f.observer(b.observer_epoch)); f.observation(newBinding);
    const resumed = f.runs.resume(f.request(), f.principal('connection'), run.job_id, { expected_version: expired.version, native_task_binding_id: newBinding.id });
    assert.notEqual(resumed.attempt_id, run.attempt_id); assert.ok(resumed.attempt_generation > run.attempt_generation); assert.equal(resumed.input_hash, run.input_hash);
    assert.throws(() => f.runs.renew(f.request(), f.principal('observer'), run.job_id, { attempt_id: run.attempt_id, attempt_generation: run.attempt_generation, observation_id: String(f.snapshot(run.job_id).observations[0]!.id), expected_version: resumed.version }), error('HOST_RUN_NOT_CURRENT'));
    const late = f.runs.submit(f.request(), f.principal('connection'), run.job_id, f.output(run)); assert.equal(late.state, 'quarantined'); assert.equal(f.snapshot(run.job_id).candidates.length, 0);
    evidence('disconnect-resume.json', f.snapshot(run.job_id));
  } finally { f.cleanup(); }
}));

test('T48 completed 固定截止与缺输出 waiting_input', async () => checked('T48-completed-deadline', ['T48'], async () => {
  const f = fixture(); try {
    const { b, run } = await f.begin(); f.now += 2500; f.observation(b, 'completed');
    const attempt = getAttempt(f.context().db, f.config.workspace_id, run.attempt_id); assert.equal(attempt.output_deadline, run.lease_until);
    f.now = Date.parse(attempt.output_deadline!); f.runs.recoverExpired();
    assert.equal(getJob(f.context().db, f.config.workspace_id, run.job_id).state, 'waiting_input'); assert.equal(JSON.parse(getAttempt(f.context().db, f.config.workspace_id, run.attempt_id).error!).code, 'HOST_OUTPUT_MISSING');
    assert.equal(f.runs.submit(f.request(), f.principal('connection'), run.job_id, f.output(run)).state, 'quarantined');
    evidence('completed-deadline.json', f.snapshot(run.job_id));
  } finally { f.cleanup(); }
}));

for (const [nativeState, state] of [['failed', 'failed'], ['auth_required', 'waiting_input'], ['quota_exhausted', 'waiting_quota'], ['interrupted', 'failed']] as const) test(`T48 ${nativeState} 撤销提交权`, async () => checked(`T48-terminal-${nativeState}`, ['T48'], async () => {
  const f = fixture(); try { const { b, run } = await f.begin(); f.observation(b, nativeState); assert.equal(getJob(f.context().db, f.config.workspace_id, run.job_id).state, state); assert.equal(f.runs.submit(f.request(), f.principal('connection'), run.job_id, f.output(run)).state, 'quarantined'); evidence(`terminal-${nativeState}.json`, f.snapshot(run.job_id)); } finally { f.cleanup(); }
}));

test('T48 重启磁盘 running 不授提交权；新查询恢复不延期', async () => checked('T48-restart-readiness', ['T48', 'T47'], async () => {
  const f = fixture(); try {
    const { b, run } = await f.begin(), received = f.runs.receive(f.request(), f.principal('connection'), run.job_id, f.output(run)); f.runs.results.prepare(received.receipt_id); f.reopen();
    assert.equal(f.runs.results.commitResult(received.receipt_id).state, 'pending'); assert.throws(() => f.runs.submit(f.request(), f.principal('connection'), run.job_id, f.output(run)), error('HOST_OBSERVER_NOT_READY'));
    assert.throws(() => f.runs.reattach(f.request(), f.principal('observer'), b.id, { observer_epoch: 'wrong-epoch', native_identity: identityOf(b), observation: { sequence: 2, native_state: 'running', observed_at: new Date(f.now).toISOString(), native_evidence_ref: 'fixture' } }), error('HOST_TASK_BINDING_INVALID'));
    f.now += 100; f.runs.reattach(f.request(), f.principal('observer'), b.id, { observer_epoch: b.observer_epoch, native_identity: identityOf(b), observation: { sequence: 2, native_state: 'running', observed_at: new Date(f.now).toISOString(), native_evidence_ref: 'internal-restart-query' } });
    assert.equal(getAttempt(f.context().db, f.config.workspace_id, run.attempt_id).lease_until, run.lease_until);
    assert.equal(f.runs.results.commitResult(received.receipt_id).state, 'committed'); assert.equal(f.snapshot(run.job_id).candidates.length, 1);
    evidence('restart-readiness.json', f.snapshot(run.job_id));
  } finally { f.cleanup(); }
}));

test('T48 epoch 替换拒绝旧 owner/epoch；已撤权 pending 隔离', async () => checked('T48-epoch-replacement', ['T46', 'T48'], async () => {
  const f = fixture(); try {
    const { b, run } = await f.begin(), receipt = f.runs.receive(f.request(), f.principal('connection'), run.job_id, f.output(run)); f.observer();
    assert.throws(() => f.observation(b), error('HOST_OBSERVER_NOT_READY'));
    assert.throws(() => f.observer(b.observer_epoch), error('HOST_TASK_BINDING_INVALID'));
    assert.equal(f.runs.results.read(f.request(), receipt.receipt_id).state, 'quarantined');
    evidence('epoch-replacement.json', f.snapshot(run.job_id));
  } finally { f.cleanup(); }
}));

test('T48 逻辑取消隔离晚到输出，实际中断 ACK 不自报推理停止', async () => checked('T48-logical-cancel', ['T42', 'T48'], async () => {
  const f = fixture(); try {
    const { b, run } = await f.begin(), receipt = f.runs.receive(f.request(), f.principal('connection'), run.job_id, f.output(run)); f.runs.results.prepare(receipt.receipt_id);
    f.jobs().cancel(f.request(), run.job_id, { expected_version: run.version });
    assert.equal(f.runs.results.commitResult(receipt.receipt_id).state, 'quarantined');
    const unsupported = await f.runs.requestNativeInterrupt(f.request(), f.principal('observer'), run.job_id); assert.equal(unsupported.native_interrupt, 'unsupported'); assert.equal(unsupported.inference_stopped, false);
    const ack = await f.runs.requestNativeInterrupt(f.request(), f.principal('observer'), run.job_id, { requestInterrupt: async () => ({ acknowledged: true, evidence_ref: 'internal-ACK-fixture' }) }); assert.equal(ack.native_interrupt, 'acknowledged'); assert.equal(ack.inference_stopped, false);
    f.observation(b, 'interrupted'); assert.equal(getJob(f.context().db, f.config.workspace_id, run.job_id).state, 'cancelled'); assert.equal(f.snapshot(run.job_id).candidates.length, 0);
    assert.throws(() => f.runs.resume(f.request(), f.principal('connection'), run.job_id, { expected_version: getJob(f.context().db, f.config.workspace_id, run.job_id).version, native_task_binding_id: b.id }), error('HOST_RUN_NOT_CURRENT'));
    assert.throws(() => f.binding(f.observer(b.observer_epoch), { scope: 'turn', native_namespace: 'native', native_session_id: 'session', native_turn_id: run.job_id }), error('HOST_TASK_BINDING_INVALID'));
    evidence('logical-cancel.json', f.snapshot(run.job_id));
  } finally { f.cleanup(); }
}));

test('T41 固定r1/人工r2/跨key幂等/不同输出冲突/committed不回退', async () => checked('T41-receipt-integration', ['T41', 'T47', 'T48'], async () => {
  const f = fixture(); try {
    const { doc, b, run } = await f.begin(), r2 = await new Documents(f.context()).save(f.request(), doc.document_id, { expected_revision_id: doc.head_revision_id, origin: 'human', text: '人工 r2' });
    assert.equal((run.input_manifest.host_task as Record<string, unknown>).materials && JSON.stringify(run.input_manifest).includes('r1 固定材料'), true);
    const output = f.output(run), receipt = f.runs.submit(f.request(), f.principal('connection'), run.job_id, output); assert.equal(receipt.state, 'committed');
    assert.equal(f.runs.submit(f.request(), f.principal('connection'), run.job_id, output).receipt_id, receipt.receipt_id);
    assert.throws(() => f.runs.submit(f.request(), f.principal('connection'), run.job_id, { ...output, typed_output: { documents: [{ document_id: doc.document_id, text: '异输出' }], recommendations: [] } }), error('HOST_RUN_OUTPUT_CONFLICT'));
    const snapshot = f.snapshot(run.job_id); assert.equal(snapshot.candidates.length, 1); assert.equal(snapshot.candidates[0]!.base_revision_id, doc.head_revision_id); assert.equal(snapshot.documents[0]!.head_revision_id, r2.revision_id);
    const candidateId = String(snapshot.candidates[0]!.id); await assert.rejects(() => new Documents(f.context()).adoptCandidate(f.request(), candidateId, { expected_revision_id: r2.revision_id }), error('REVISION_CONFLICT'));
    f.observation(b, 'failed'); assert.equal(getJob(f.context().db, f.config.workspace_id, run.job_id).state, 'succeeded');
    assert.equal(f.runs.readReceipt(f.request(), f.principal('connection'), receipt.receipt_id).state, 'committed'); evidence('receipt-integration.json', f.snapshot(run.job_id));
  } finally { f.cleanup(); }
}));

test('T41 无Markdown推荐与多正文集合共用收据finalizer', async () => checked('T41-output-collections', ['T41', 'T47'], async () => {
  const f = fixture(); try {
    const b = f.binding(); f.observation(b);
    const recommended = f.runs.begin(f.request(), f.principal('connection'), { kind: 'topic_recommendation', mode: 'recommendation', targets: [], source_ids: [], instruction: '内部推荐协议检查', request_context: 'conversation', native_task_binding_id: b.id, expected_version: 1, recommendation_kind: 'topic' });
    const output = { attempt_id: recommended.attempt_id, attempt_generation: recommended.attempt_generation, expected_version: recommended.version, input_hash: recommended.input_hash, typed_output: { documents: [], recommendations: [{ payload: { title: '内部候选' }, source_ids: [], rationale: '内部规则' }] } };
    const receipt = f.runs.submit(f.request(), f.principal('connection'), recommended.job_id, output); assert.equal(receipt.state, 'committed'); assert.equal(receipt.files.length, 0); assert.ok(receipt.results.recommendation_run_id);
    evidence('no-markdown-recommendation.json', f.snapshot(recommended.job_id));
    const first = await f.document(), second = await f.document('第二材料'), next = f.binding(f.observer(b.observer_epoch)); f.observation(next);
    const multiple = f.runs.begin(f.request(), f.principal('connection'), { ...f.beginInput(first, next), targets: [first, second].map(doc => ({ document_id: doc.document_id, base_revision_id: doc.head_revision_id, core_revision_id: null })) });
    const received = f.runs.receive(f.request(), f.principal('connection'), multiple.job_id, f.output(multiple)); f.runs.results.prepare(received.receipt_id); f.reopen();
    assert.equal(f.runs.results.commitResult(received.receipt_id).state, 'pending');
    f.runs.reattach(f.request(), f.principal('observer'), next.id, { observer_epoch: next.observer_epoch, native_identity: identityOf(next), observation: { sequence: 2, native_state: 'waiting_tool', observed_at: new Date(f.now).toISOString(), native_evidence_ref: 'internal-multi-query' } });
    assert.equal(f.runs.results.commitResult(received.receipt_id).state, 'committed'); assert.equal(f.snapshot(multiple.job_id).candidates.length, 2); evidence('multi-document-recovery.json', f.snapshot(multiple.job_id));
  } finally { f.cleanup(); }
}));

test('T28 host initialize保留auto_initial与空head/core校验', async () => checked('T28-host-initialize', ['T41', 'T28'], async () => {
  const f = fixture(); try {
    const topic = await new Topics(f.context()).create(f.request(), { title: '内部主题', category: 'ai', audience: '内部规则', source_ids: [] }), docs = new Documents(f.context());
    const core = await docs.save(f.request(), topic.core.document_id, { expected_revision_id: null, origin: 'human', text: '内部确认核心' }); await docs.approveCore(f.request(), topic.id, core.revision_id);
    const document = randomUUID(), variant = randomUUID();
    f.context().db.prepare("INSERT INTO documents(id,workspace_id,kind,version) VALUES (?,?,'variant',1)").run(document, f.config.workspace_id);
    f.context().db.prepare("INSERT INTO variants(id,workspace_id,topic_id,platform,format,variant_key,document_id,based_on_core_revision_id,status,version) VALUES (?,?,?,'x','text','internal',?,?,'uninitialized',1)").run(variant, f.config.workspace_id, topic.id, document, core.revision_id);
    const b = f.binding(); f.observation(b);
    const run = f.runs.begin(f.request(), f.principal('connection'), { kind: 'variant_generate', mode: 'initialize', targets: [{ document_id: document, base_revision_id: null, core_revision_id: core.revision_id }], source_ids: [], instruction: '初始平台文稿', request_context: 'page_action', native_task_binding_id: b.id, expected_version: 1 });
    const receipt = f.runs.submit(f.request(), f.principal('connection'), run.job_id, f.output(run)); assert.equal(receipt.state, 'committed');
    const snapshot = f.snapshot(run.job_id); assert.equal(snapshot.candidates[0]!.adoption_mode, 'auto_initial'); assert.ok(snapshot.documents.find(row => row.id === document)!.head_revision_id); evidence('host-initialize.json', snapshot);
  } finally { f.cleanup(); }
}));

test('T46 task scope与能力路线版本/其他owner拒绝', async () => checked('T46-task-scope-owner', ['T46'], async () => {
  const f = fixture(); try {
    const doc = await f.document(), observer = f.observer(), b = f.binding(observer, f.identityFor('task')); f.observation(b);
    f.context().db.prepare("UPDATE host_connections SET request_identity_ref='other-owner' WHERE id=?").run(f.program.host_connection_id);
    assert.throws(() => f.runs.begin(f.request(), f.principal('connection'), f.beginInput(doc, b)), error('AUTH_REQUIRED'));
    f.context().db.prepare('UPDATE host_connections SET request_identity_ref=?,runtime_version=? WHERE id=?').run(f.program.owner, 'different-runtime', f.program.host_connection_id);
    assert.throws(() => f.runs.begin(f.request(), f.principal('connection'), f.beginInput(doc, b)), error('CAPABILITY_UNVERIFIED'));
    f.context().db.prepare("UPDATE host_connections SET runtime_version='fixture' WHERE id=?").run(f.program.host_connection_id);
    const run = f.runs.begin(f.request(), f.principal('connection'), f.beginInput(doc, b)); assert.equal(f.runs.submit(f.request(), f.principal('connection'), run.job_id, f.output(run)).state, 'committed'); evidence('task-scope-owner.json', f.snapshot(run.job_id));
  } finally { f.cleanup(); }
}));
