import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { JsonObject, HostRunView, BeginHostRunRequest, ReceiveHostOutputRequest } from '../../packages/contracts/src/index.ts';
import { HostRuns } from '../../packages/domain/src/host-runs/index.ts';
import type { TrustedObserverProgram } from '../../packages/adapters/src/host-observer/index.ts';
import { createDocumentsModule } from '../../apps/service/src/routes/documents.ts';
import { createTopicsModule } from '../../apps/service/src/routes/topics.ts';
import { createHostCapabilitiesModule } from '../../apps/service/src/routes/host-capabilities.ts';
import { createHostObserversModule } from '../../apps/service/src/routes/host-observers.ts';
import { createHostRunsModule } from '../../apps/service/src/routes/host-runs.ts';
import { createJobsModule } from '../../apps/service/src/routes/jobs.ts';
import { fixture, call, evidence } from './harness.ts';

test('原生候选真实 HTTP / stdio 生命周期边界（internal_rule 观察程序）', async t => {
  let offset = 0, runs: HostRuns;
  const now = () => Date.now() + offset;
  const program: TrustedObserverProgram = { owner: 'wp23-internal-rule-observer', host_connection_id: randomUUID(), observer_credential: randomUUID(), connection_credential: randomUUID() };
  const capabilityId = randomUUID(), alternateCapabilityId = randomUUID(), epoch = randomUUID();
  const f = await fixture([createDocumentsModule, createTopicsModule, createHostCapabilitiesModule,
    context => {
      if (!context.db.prepare('SELECT id FROM host_connections WHERE id=?').get(program.host_connection_id)) {
        context.db.prepare("INSERT INTO host_connections(id,workspace_id,service_instance_id,host_surface,plugin_id,plugin_version,runtime_version,connection_mode,request_identity_ref,status) VALUES (?,?,?,'codex_desktop','personal-ip-workbench','0.1.0','fixture','local_stdio',?,'connected')").run(program.host_connection_id, context.identity.workspace_id, context.identity.service_instance_id, program.owner);
        context.db.prepare("INSERT INTO host_capability_records(id,workspace_id,host_surface,runtime_version,connection_mode,operation,plugin_version,status,limitations,verified_at,evidence_ref,version) VALUES (?,?,'codex_desktop','fixture','local_stdio','native_task_tracking','0.1.0','supported','[\"internal_rule fixture only; no actual Codex host\"]',?,'wp23-internal-rule-observer',1)").run(capabilityId, context.identity.workspace_id, new Date(now()).toISOString());
        context.db.prepare("INSERT INTO host_capability_records(id,workspace_id,host_surface,runtime_version,connection_mode,operation,plugin_version,status,limitations,verified_at,evidence_ref,version) VALUES (?,?,'codex_desktop','runtime-b','local_stdio','native_task_tracking','0.1.0','supported','[\"internal_rule capability only; no runtime-b connection or observer\"]',?,'wp23-runtime-b-capability-fixture',1)").run(alternateCapabilityId, context.identity.workspace_id, new Date(now()).toISOString());
      }
      runs = new HostRuns(context, { trustedPrograms: [program], clock: now, profile: { freshness_ms: 1500, lease_ms: 60_000, output_grace_ms: 1000, future_skew_ms: 250 } });
      return createHostObserversModule(context, runs);
    }, context => createHostRunsModule(context, runs), context => createJobsModule(context, runs)]);
  const outcomes: Array<Record<string, unknown>> = [];
  async function checked(name: string, operation: () => Promise<void>) {
    const actual_operation_at = new Date().toISOString();
    try { await operation(); outcomes.push({ name, scope: 'internal_rule', result: 'passed', actual_operation_at }); }
    catch (error) { outcomes.push({ name, scope: 'internal_rule', result: 'failed', actual_operation_at, error: error instanceof Error ? error.stack : String(error) }); throw error; }
    finally { evidence('native-results.json', outcomes); }
  }
  try {
    const a = await f.connect({ connection_credential: program.connection_credential });
    const b = await f.connect({ connection_credential: program.connection_credential });
    const borrowed = await f.connect({ connection_credential: program.connection_credential, host: { ...f.descriptor().host, runtime_version: 'runtime-b' } });
    const hostHeaders = { 'X-Host-Surface': 'codex_desktop', 'X-Host-Runtime-Version': 'fixture', 'X-Host-Connection-Mode': 'local_stdio', 'X-Host-Plugin-Version': '0.1.0', 'X-Host-Connection-Credential': program.connection_credential };
    const observer = await f.http('POST', '/api/v1/host-task-observers', { host_connection_id: program.host_connection_id, observer_epoch: epoch, capability_record_id: capabilityId, capability_version: 1 }, { Authorization: 'Bearer ' + program.observer_credential });
    assert.equal(observer.status, 201);
    const observerId = String(observer.body.id);
    async function bind() {
      const native_identity = { scope: 'turn', native_namespace: 'wp23-internal-rule', native_session_id: 'fixture-session', native_turn_id: randomUUID() };
      const value = await f.http('POST', '/api/v1/host-task-observers/' + observerId + '/bindings', { observer_epoch: epoch, native_identity }, { Authorization: 'Bearer ' + program.observer_credential });
      assert.equal(value.status, 201); return { binding_id: String(value.body.id), native_identity };
    }
    async function observe(binding_id: string, sequence = 1, state = 'running') {
      const value = await f.http('POST', '/api/v1/native-task-bindings/' + binding_id + '/observations', { observer_epoch: epoch, sequence, native_state: state, observed_at: new Date(now()).toISOString(), native_evidence_ref: 'wp23-internal-rule:' + state + ':' + sequence }, { Authorization: 'Bearer ' + program.observer_credential });
      assert.equal(value.status, 201); return value;
    }
    async function start(observed = true) {
      const document = await call(a, 'create_document', { kind: 'wiki', initial_text: '固定输入文稿', idempotency_key: randomUUID() });
      const binding = await bind(); if (observed) await observe(binding.binding_id);
      const input: BeginHostRunRequest = { kind: 'document_modify', mode: 'candidate', targets: [{ document_id: String(document.data.document_id), base_revision_id: String(document.data.head_revision_id), core_revision_id: null }], source_ids: [], instruction: '使用固定输入生成候选', request_context: 'conversation', native_task_binding_id: binding.binding_id, expected_version: Number(document.data.version) };
      const accepted = await call(a, 'begin_host_run', { ...input as unknown as JsonObject, idempotency_key: randomUUID() });
      return { input, accepted, run: accepted.data as unknown as HostRunView, document: document.data, binding };
    }
    async function output(run: HostRunView, text: string, key: string = randomUUID(), connection = b) {
      const current = await call(a, 'get_job', { id: run.job_id });
      const body: ReceiveHostOutputRequest = { attempt_id: run.attempt_id, attempt_generation: run.attempt_generation, expected_version: Number((current.data.job as JsonObject).version), input_hash: run.input_hash, typed_output: { documents: [{ document_id: String((run.input_manifest.targets as JsonObject[])[0]!.document_id), text }], recommendations: [] } };
      return call(connection, 'submit_host_output', { job_id: run.job_id, ...body as unknown as JsonObject, idempotency_key: key });
    }
    await t.test('supported runtime-B 不能借用 A credential/observer，HTTP 与 stdio 均拒绝且无业务副作用', async () => checked('cross-host-credential-borrow-rejected', async () => {
      const document = await call(a, 'create_document', { kind: 'wiki', initial_text: '跨宿主固定输入', idempotency_key: randomUUID() });
      const binding = await bind(); await observe(binding.binding_id);
      const input: BeginHostRunRequest = { kind: 'document_modify', mode: 'candidate', targets: [{ document_id: String(document.data.document_id), base_revision_id: String(document.data.head_revision_id), core_revision_id: null }], source_ids: [], instruction: '不允许借用宿主身份', request_context: 'conversation', native_task_binding_id: binding.binding_id, expected_version: Number(document.data.version) };
      const context = await call(borrowed, 'get_context');
      assert.equal((context.data.capabilities as JsonObject[]).find(cap => cap.operation === 'native_task_tracking')!.status, 'supported');
      const http = await f.http('POST', '/api/v1/host-runs', input, { ...hostHeaders, 'X-Host-Runtime-Version': 'runtime-b' });
      assert.equal(http.status, 409); assert.equal((http.body.error as JsonObject).code, 'WORKSPACE_INSTANCE_MISMATCH');
      const stdio = await call(borrowed, 'begin_host_run', { ...input as unknown as JsonObject, idempotency_key: randomUUID() });
      assert.equal(stdio.error?.code, 'WORKSPACE_INSTANCE_MISMATCH'); assert.equal(stdio.status, 409);
      const partialResults = [];
      for (const field of ['X-Host-Surface', 'X-Host-Runtime-Version', 'X-Host-Connection-Mode', 'X-Host-Plugin-Version']) {
        const partial: Record<string, string> = { ...hostHeaders }; delete partial[field];
        const rejected = await f.http('POST', '/api/v1/host-runs', input, partial);
        assert.equal(rejected.status, 400); assert.equal((rejected.body.error as JsonObject).code, 'VALIDATION_ERROR');
        partialResults.push({ omitted: field, status: rejected.status, code: (rejected.body.error as JsonObject).code });
      }
      const counts = Object.fromEntries(['jobs', 'job_attempts', 'result_receipts'].map(table => [table, Number(f.app.context.db.prepare('SELECT COUNT(*) n FROM ' + table).get()!.n)]));
      assert.deepEqual(counts, { jobs: 0, job_attempts: 0, result_receipts: 0 });
      for (const forbidden of [program.connection_credential, program.observer_credential, program.owner]) assert.ok(!JSON.stringify([context.data, http.body, stdio.result]).includes(forbidden));
      evidence('cross-host-identity-rejection.json', { scope: 'internal_rule', source_runtime: 'fixture', descriptor_runtime: 'runtime-b', capability_status_both: 'supported', http: { status: http.status, code: (http.body.error as JsonObject).code }, stdio: { status: stdio.status, code: stdio.error?.code }, partial_header_results: partialResults, counts, actual_host_tracking: 'unverified' });
    }));
    await t.test('tracking 未验证和缺少观察真正拒绝，无 service_adapter 回退', async () => checked('native-admission-rejection-no-fallback', async () => {
      const pending = await start(false); assert.equal(pending.accepted.error?.code, 'HOST_OBSERVER_NOT_READY');
      await observe(pending.binding.binding_id);
      f.app.context.db.prepare("UPDATE host_capability_records SET status='unverified' WHERE id=?").run(capabilityId);
      const rejected = await call(a, 'begin_host_run', { ...pending.input as unknown as JsonObject, idempotency_key: randomUUID() });
      assert.equal(rejected.error?.code, 'CAPABILITY_UNVERIFIED');
      assert.equal(Number(f.app.context.db.prepare('SELECT COUNT(*) n FROM jobs').get()!.n), 0);
      f.app.context.db.prepare("UPDATE host_capability_records SET status='supported' WHERE id=?").run(capabilityId);
      const wrongRuntime = await f.connect({ connection_credential: program.connection_credential, host: { ...f.descriptor().host, runtime_version: 'unverified-runtime' } });
      const capabilities = (await call(wrongRuntime, 'get_context')).data.capabilities as JsonObject[];
      assert.equal(capabilities.find(cap => cap.operation === 'native_task_tracking')!.status, 'unverified');
      assert.equal((await call(wrongRuntime, 'begin_host_run', { ...pending.input as unknown as JsonObject, idempotency_key: randomUUID() })).error?.code, 'CAPABILITY_UNVERIFIED');
    }));
    await t.test('固定输入候选、跨 key 收据重放、冲突拒绝、head 保持人工版本', async () => checked('native-candidate-receipt-idempotency', async () => {
      const session = await start(); assert.equal(session.accepted.result.isError, undefined);
      const first = await output(session.run, 'MCP 原生候选', 'output-one'); assert.equal(first.data.state, 'committed');
      const replay = await output(session.run, 'MCP 原生候选', 'output-two'); assert.equal(replay.data.receipt_id, first.data.receipt_id);
      assert.equal((await output(session.run, '另一输出', 'output-one')).error?.code, 'IDEMPOTENCY_CONFLICT');
      assert.equal((await output(session.run, '另一输出', 'output-three')).error?.code, 'HOST_RUN_OUTPUT_CONFLICT');
      assert.equal((await call(a, 'get_document', { id: String(session.document.document_id) })).data.head_revision_id, session.document.head_revision_id);
      const receipt = await call(a, 'get_host_receipt', { id: String(first.data.receipt_id) }); assert.equal(receipt.data.state, 'committed');
      const mismatch = await output(session.run, 'MCP 原生候选', 'output-cross-runtime', borrowed); assert.equal(mismatch.error?.code, 'WORKSPACE_INSTANCE_MISMATCH');
      assert.equal((await call(borrowed, 'get_host_receipt', { id: String(first.data.receipt_id) })).error?.code, 'WORKSPACE_INSTANCE_MISMATCH');
      assert.equal((await call(borrowed, 'list_host_receipts', { job_id: session.run.job_id })).error?.code, 'WORKSPACE_INSTANCE_MISMATCH');
      assert.equal(Number(f.app.context.db.prepare('SELECT COUNT(*) n FROM result_receipts WHERE job_id=?').get(session.run.job_id)!.n), 1);
      assert.equal(Number(f.app.context.db.prepare('SELECT COUNT(*) n FROM candidates WHERE job_id=?').get(session.run.job_id)!.n), 1);
      await f.restart(); const replayAfterRestart = await output(session.run, 'MCP 原生候选', 'output-four'); assert.equal(replayAfterRestart.data.receipt_id, first.data.receipt_id);
      evidence('native-committed-receipt.json', { scope: 'internal_rule', identity: f.app.identity, run: session.run, receipt: receipt.data, replay_receipt_id: replayAfterRestart.data.receipt_id, real_host_tracking: 'unverified' });
    }));
    // 重启清空 observer readiness；同 epoch 的注册只恢复连接，具体运行绑定还需观察。
    const reregister = await f.http('POST', '/api/v1/host-task-observers', { host_connection_id: program.host_connection_id, observer_epoch: epoch, capability_record_id: capabilityId, capability_version: 1 }, { Authorization: 'Bearer ' + program.observer_credential }); assert.equal(reregister.status, 201);
    await t.test('主服务重启不能凭旧磁盘观察提交；真实 reattach 后同 attempt 恢复', async () => checked('native-restart-observer-readiness', async () => {
      const session = await start(); assert.equal(session.accepted.result.isError, undefined);
      await f.restart();
      const rejected = await output(session.run, '重启候选'); assert.equal(rejected.error?.code, 'HOST_OBSERVER_NOT_READY');
      const reattached = await f.http('POST', '/api/v1/native-task-bindings/' + session.binding.binding_id + '/reattach', { observer_epoch: epoch, native_identity: session.binding.native_identity, observation: { sequence: 2, native_state: 'running', observed_at: new Date(now()).toISOString(), native_evidence_ref: 'wp23-internal-rule:actual-fixture-reattach' } }, { Authorization: 'Bearer ' + program.observer_credential }); assert.equal(reattached.status, 200);
      assert.equal((await output(session.run, '重启候选')).data.state, 'committed');
    }));
    await t.test('过期输出隔离、resume 新 generation、旧输出不能挂新 attempt', async () => checked('expired-output-resume-fence', async () => {
      const session = await start(); assert.equal(session.accepted.result.isError, undefined);
      offset += 60_100; runs!.recoverExpired();
      const old = await output(session.run, '过期候选'); assert.equal(old.data.state, 'quarantined');
      assert.equal(Number(f.app.context.db.prepare('SELECT COUNT(*) n FROM candidates WHERE job_id=?').get(session.run.job_id)!.n), 0);
      assert.equal((await call(a, 'get_document', { id: String(session.document.document_id) })).data.head_revision_id, session.document.head_revision_id);
      const current = await call(a, 'get_job', { id: session.run.job_id });
      assert.equal((current.data.job as JsonObject).state, 'waiting_input');
      assert.equal((await call(a, 'resume_service_job', { id: session.run.job_id, expected_version: Number((current.data.job as JsonObject).version), idempotency_key: randomUUID() })).error?.code, 'VALIDATION_ERROR');
      const nextBinding = await bind(); await observe(nextBinding.binding_id);
      const countBeforeMismatch = Number(f.app.context.db.prepare('SELECT COUNT(*) n FROM job_attempts WHERE job_id=?').get(session.run.job_id)!.n);
      const wrongResume = await call(borrowed, 'resume_host_run', { id: session.run.job_id, expected_version: Number((current.data.job as JsonObject).version), native_task_binding_id: nextBinding.binding_id, idempotency_key: randomUUID() });
      assert.equal(wrongResume.error?.code, 'WORKSPACE_INSTANCE_MISMATCH');
      assert.equal(Number(f.app.context.db.prepare('SELECT COUNT(*) n FROM job_attempts WHERE job_id=?').get(session.run.job_id)!.n), countBeforeMismatch);
      const resumed = await call(a, 'resume_host_run', { id: session.run.job_id, expected_version: Number((current.data.job as JsonObject).version), native_task_binding_id: nextBinding.binding_id, idempotency_key: randomUUID() });
      assert.equal(resumed.result.isError, undefined);
      const nextRun = resumed.data as unknown as HostRunView; assert.ok(nextRun.attempt_generation > session.run.attempt_generation); assert.notEqual(nextRun.attempt_id, session.run.attempt_id); assert.equal(nextRun.input_hash, session.run.input_hash);
      assert.equal((await output(session.run, '过期候选')).data.receipt_id, old.data.receipt_id);
      assert.equal((await output(nextRun, '新 attempt 候选')).data.state, 'committed');
      assert.equal(Number(f.app.context.db.prepare("SELECT COUNT(*) n FROM jobs WHERE execution_mode='service_adapter'").get()!.n), 0);
      evidence('native-expired-resume.json', { scope: 'internal_rule', synthetic_clock: true, original_run: session.run, old_receipt: old.data, new_run: nextRun, real_host_tracking: 'unverified' });
    }));
    await t.test('取消撤销提交权，晚到输出隔离且无候选/head 改动', async () => checked('native-cancel-output-fence', async () => {
      const session = await start(); assert.equal(session.accepted.result.isError, undefined);
      const current = await call(a, 'get_job', { id: session.run.job_id });
      const cancelled = await call(b, 'cancel_job', { id: session.run.job_id, expected_version: Number((current.data.job as JsonObject).version), idempotency_key: 'cancel-current' });
      assert.equal(cancelled.data.state, 'cancelled');
      const late = await output(session.run, '取消后晚到候选'); assert.equal(late.data.state, 'quarantined');
      assert.equal(Number(f.app.context.db.prepare('SELECT COUNT(*) n FROM candidates WHERE job_id=?').get(session.run.job_id)!.n), 0);
      assert.equal((await call(a, 'get_document', { id: String(session.document.document_id) })).data.head_revision_id, session.document.head_revision_id);
      evidence('native-cancelled-receipt.json', { scope: 'internal_rule', job_id: session.run.job_id, receipt: late.data, native_interrupt_acknowledged: false, actual_host_tracking: 'unverified' });
    }));
    assert.equal(f.app.context.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { await f.cleanup(); }
});
