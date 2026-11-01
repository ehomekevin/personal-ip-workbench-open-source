import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { ContractError, type AgentRunInput, type AgentRunHandle, type AgentResult, type JsonObject, type AgentReadiness, type AdapterEvent } from '../../packages/contracts/src/index.ts';
import type { AgentPort } from '../../packages/domain/src/ports/index.ts';
import { ApiTextAdapter } from '../../packages/adapters/src/agent/api.ts';
import { RoutedTextAdapter, routedTextAdapter } from '../../apps/service/src/bootstrap/configuration/api-execution.ts';
import { createServiceAgentHandlers } from '../../apps/service/src/worker/handlers/agent/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { fixture } from './harness.ts';

class NativeFixture implements AgentPort {
  starts = 0; resumes = 0; ready: 'ready' | 'auth' = 'auth';
  async describe() { return []; }
  async checkReadiness(): Promise<AgentReadiness> {
    if (this.ready === 'auth') throw new ContractError('AUTH_REQUIRED', 'fixture subscription login unavailable');
    return { executor_id: 'codex', runtime_version: 'fixture', auth_state: 'subscription_authenticated', billing_route: 'chatgpt_subscription', capabilities: [], limitations: [] };
  }
  async start(input: AgentRunInput): Promise<AgentRunHandle> { this.starts++; return { runtime_session_id: randomUUID(), supports_resume: true, checkpoint: { run_input: input as unknown as JsonObject } }; }
  async resume(handle: AgentRunHandle) { this.resumes++; return handle; }
  async *streamEvents(handle: AgentRunHandle): AsyncIterable<AdapterEvent | AgentResult> {
    const input = handle.checkpoint.run_input as unknown as AgentRunInput;
    const frozen = input.input_manifest.frozen as JsonObject;
    const documents = (frozen.targets as JsonObject[]).map(target => ({ document_id: target.document_id, text: 'recovered fixture draft' }));
    yield { status: 'completed', candidate_documents: documents, evidence_links: [], asset_candidates: [], actual_usage: null, resume_info: { output: { documents, recommendations: [] }, native_status: 'completed' } };
  }
  async requestInput() {} async cancel() { return {}; } async close() {}
}

function routedFixture(provider: 'openai' | 'anthropic' = 'openai') {
  const f = fixture(), root = join(f.root, 'api-receipts'), native = new NativeFixture();
  const route = { provider, model: 'fixture-model', max_output_tokens: 4096, settings_version: 2, enabled: true };
  const calls: string[] = []; let mode: 'unknown' | 'success' | 'http_401' | 'http_429' = 'unknown';
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname; calls.push(`${init?.method} ${path}`);
    if (path.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: route.model }] }));
    if (mode === 'unknown') throw new Error('connection lost after provider accepted POST');
    if (mode === 'http_401' || mode === 'http_429') return new Response('{}', { status: mode === 'http_401' ? 401 : 429 });
    const output = { documents: [{ document_id: f.document, text: 'API draft' }], recommendations: [] };
    return new Response(JSON.stringify(provider === 'openai'
      ? { id: 'resp_fixture', model: route.model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }
      : { id: 'msg_fixture', model: route.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }] }));
  };
  const enqueue = () => f.jobs.enqueue(f.request(), { kind: 'document_modify', execution_mode: 'service_adapter', executor_id: 'codex', entrypoint: 'standalone_web', presentation: 'foreground_dialog', target_id: f.document,
    input_manifest: { schema_version: 'wp15-service-v1', mode: 'candidate', targets: [{ document_id: f.document, base_revision_id: null, core_revision_id: null }], source_ids: [], service_agent: { cwd: f.staging, task_instruction: 'Write a draft', allowed_tools: [], api_fallback: route } } });
  const worker = new DurableWorker(f.context, createServiceAgentHandlers(f.context, { staging_root: f.staging, createAdapter: plan => {
    assert.deepEqual(plan.api_fallback, route);
    return new RoutedTextAdapter(native, new ApiTextAdapter({ workspace_id: f.context.identity.workspace_id, root, route, key: () => 'fixture-private-key', fetcher }));
  } }));
  return { ...f, worker, native, calls, root, enqueue, setMode(value: typeof mode) { mode = value; }, postCount: () => calls.filter(call => call.startsWith('POST ')).length };
}

test('worker + Jobs.resume 跨执行器恢复未知 API 结果始终只有 1 次 POST，保留原回执', async () => {
  for (const provider of ['openai', 'anthropic'] as const) {
    const f = routedFixture(provider);
    try {
      const job = f.enqueue(); assert.equal((await f.worker.runOnce())!.state, 'failed');
      const before = f.jobs.get(f.request(), job.id), handle = before.checkpoint!.agent_handle as unknown as AgentRunHandle;
      assert.equal(before.error!.code, 'RESULT_UNKNOWN'); assert.equal(f.postCount(), 1);
      assert.ok(handle.runtime_session_id.startsWith('api:')); assert.equal(handle.checkpoint.billing_route, `${provider}_api`);
      assert.throws(() => f.jobs.resume(f.request(), job.id, { expected_version: before.job.version, executor: 'claude' }), { code: 'RESULT_UNKNOWN' });
      assert.deepEqual(f.jobs.get(f.request(), job.id), before); assert.equal(await f.worker.runOnce(), null);
      // 当前配置关闭、订阅恢复就绪，都不能把旧 API 请求切到新原生请求。
      f.context.db.prepare('UPDATE workspaces SET api_fallback_enabled=0').run(); f.native.ready = 'ready';
      f.jobs.resume(f.request(), job.id, { expected_version: before.job.version });
      assert.equal((await f.worker.runOnce())!.state, 'failed');
      const after = f.jobs.get(f.request(), job.id);
      assert.equal(after.error!.code, 'RESULT_UNKNOWN'); assert.equal(after.attempts.length, 2);
      assert.equal((after.checkpoint!.agent_handle as unknown as AgentRunHandle).runtime_session_id, handle.runtime_session_id);
      assert.equal(f.postCount(), 1); assert.equal(f.native.starts, 0); assert.equal(f.native.resumes, 0);
      assert.equal(readdirSync(f.root).length, 1); assert.equal(JSON.parse(readFileSync(join(f.root, readdirSync(f.root)[0]!), 'utf8')).state, 'sending');
    } finally { f.cleanup(); }
  }
});

test('claim 在未知旧 handle 的 executor 被篡改后拒绝领取，保留全部恢复状态', async () => {
  const f = routedFixture();
  try {
    const job = f.enqueue(); await f.worker.runOnce(); const before = f.jobs.get(f.request(), job.id);
    f.jobs.resume(f.request(), job.id, { expected_version: before.job.version });
    f.context.db.prepare("UPDATE jobs SET executor_id='claude' WHERE id=?").run(job.id);
    const corrupted = f.jobs.get(f.request(), job.id), events = f.jobs.events(f.request(), job.id);
    assert.throws(() => f.worker.runOnce(), error => error instanceof ContractError && error.code === 'RESULT_UNKNOWN'
      && error.details.recovery_intent_invalid === true && error.details.no_new_turn_started === true);
    assert.deepEqual(f.jobs.get(f.request(), job.id), corrupted);
    assert.deepEqual(f.jobs.events(f.request(), job.id), events);
    assert.equal(f.postCount(), 1); assert.equal(f.native.starts, 0); assert.equal(f.native.resumes, 0);
    assert.deepEqual(corrupted.checkpoint, before.checkpoint);
  } finally { f.cleanup(); }
});

test('handler 独立拒绝已领取快照中的 executor 漂移，不创建适配器或写 checkpoint', async () => {
  const f = routedFixture();
  try {
    const job = f.enqueue(); await f.worker.runOnce();
    f.jobs.resume(f.request(), job.id, { expected_version: f.jobs.get(f.request(), job.id).job.version });
    const claim = f.jobs.claim('handler-executor-drift'); assert.ok(claim);
    const before = f.jobs.get(f.request(), job.id), events = f.jobs.events(f.request(), job.id);
    let adapters = 0, checkpoints = 0;
    const handler = createServiceAgentHandlers(f.context, { staging_root: f.staging,
      createAdapter: () => { adapters++; return f.native; },
    }).find(handler => handler.registration.kind === 'document_modify')!;
    await assert.rejects(() => handler.execute({ claim: { ...claim, job: { ...claim.job, executor_id: 'claude' } },
      signal: new AbortController().signal, checkpoint: () => { checkpoints++; },
    }), error => error instanceof ContractError && error.code === 'RESULT_UNKNOWN'
      && error.details.executor_id === 'codex' && error.details.no_new_turn_started === true
      && error.details.recovery_intent_invalid === undefined);
    assert.equal(adapters, 0); assert.equal(checkpoints, 0); assert.equal(f.postCount(), 1);
    assert.equal(f.native.starts, 0); assert.equal(f.native.resumes, 0);
    assert.deepEqual(f.jobs.get(f.request(), job.id), before);
    assert.deepEqual(f.jobs.events(f.request(), job.id), events);
  } finally { f.cleanup(); }
});

test('明确执行前 readiness 失败可换执行器；disabled API 仍只使用订阅路线', async () => {
  const f = fixture(), native = new NativeFixture();
  try {
    const job = f.enqueue();
    const worker = new DurableWorker(f.context, createServiceAgentHandlers(f.context, { staging_root: f.staging, createAdapter: plan => routedTextAdapter(plan, f.context.identity.workspace_id, f.context.paths.state_root, native) }));
    assert.equal((await worker.runOnce())!.state, 'waiting_input');
    const before = f.jobs.get(f.request(), job.id);
    assert.equal(before.checkpoint!.pre_submit_failure, true); assert.equal(before.checkpoint!.agent_handle, undefined); assert.equal(native.starts, 0);
    f.jobs.resume(f.request(), job.id, { expected_version: before.job.version, executor: 'claude' }); native.ready = 'ready';
    assert.equal((await worker.runOnce())!.state, 'committed');
    assert.equal(f.jobs.get(f.request(), job.id).job.executor_id, 'claude'); assert.equal(native.starts, 1); assert.equal(native.resumes, 0);
    assert.equal(f.jobs.get(f.request(), job.id).checkpoint!.pre_submit_failure, false);
    assert.equal(f.context.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE job_id=?').get(job.id)!.n, 1);
  } finally { f.cleanup(); }
});

test('旧 readiness 未提交证明在新 start 前消费：无 handle 的未知提交不能换执行器或再次 start', async () => {
  const f = fixture(), native = new NativeFixture();
  try {
    const job = f.enqueue();
    native.start = async () => { native.starts++; throw new ContractError('RESULT_UNKNOWN', 'fixture native submit lost its handle'); };
    const worker = new DurableWorker(f.context, createServiceAgentHandlers(f.context, { staging_root: f.staging, createAdapter: plan => routedTextAdapter(plan, f.context.identity.workspace_id, f.context.paths.state_root, native) }));
    await worker.runOnce(); const readinessFailure = f.jobs.get(f.request(), job.id); assert.equal(readinessFailure.checkpoint!.pre_submit_failure, true);
    native.ready = 'ready'; f.jobs.resume(f.request(), job.id, { expected_version: readinessFailure.job.version });
    assert.equal((await worker.runOnce())!.state, 'failed');
    const unknown = f.jobs.get(f.request(), job.id); assert.equal(unknown.error!.code, 'RESULT_UNKNOWN'); assert.equal(unknown.checkpoint!.pre_submit_failure, false);
    assert.equal(native.starts, 1); assert.equal(unknown.checkpoint!.agent_handle, undefined);
    assert.throws(() => f.jobs.resume(f.request(), job.id, { expected_version: unknown.job.version, executor: 'claude' }), { code: 'RESULT_UNKNOWN' });
    f.jobs.resume(f.request(), job.id, { expected_version: unknown.job.version }); await worker.runOnce();
    assert.equal(native.starts, 1); assert.equal(f.jobs.get(f.request(), job.id).error!.code, 'RESULT_UNKNOWN');
  } finally { f.cleanup(); }
});

test('执行前只读检查的普通异常也证明未提交，可换执行器恢复', async () => {
  const f = fixture(), native = new NativeFixture();
  try {
    const job = f.enqueue(); let unavailable = true;
    const readiness = native.checkReadiness.bind(native); native.ready = 'ready';
    native.checkReadiness = async () => { if (unavailable) throw new Error('fixture CLI missing or readiness timed out'); return readiness(); };
    const worker = new DurableWorker(f.context, createServiceAgentHandlers(f.context, { staging_root: f.staging, createAdapter: plan => routedTextAdapter(plan, f.context.identity.workspace_id, f.context.paths.state_root, native) }));
    assert.equal((await worker.runOnce())!.state, 'failed');
    const before = f.jobs.get(f.request(), job.id); assert.equal(before.error!.code, 'CAPABILITY_UNVERIFIED');
    assert.equal(before.checkpoint!.pre_submit_failure, true); assert.equal(native.starts, 0);
    f.jobs.resume(f.request(), job.id, { expected_version: before.job.version, executor: 'claude' }); unavailable = false;
    assert.equal((await worker.runOnce())!.state, 'committed'); assert.equal(native.starts, 1);
    assert.equal(f.jobs.get(f.request(), job.id).job.executor_id, 'claude');
  } finally { f.cleanup(); }
});

test('start 返回 handle 前 lease 失效也保留未知提交事实，恢复不再 start', async () => {
  const f = fixture(), native = new NativeFixture(); native.ready = 'ready';
  let signalStarted!: () => void, rejectStart!: (error: Error) => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  try {
    const job = f.enqueue();
    native.start = async () => { native.starts++; signalStarted(); return new Promise<AgentRunHandle>((_, reject) => { rejectStart = reject; }); };
    const worker = new DurableWorker(f.context, createServiceAgentHandlers(f.context, { staging_root: f.staging, createAdapter: plan => routedTextAdapter(plan, f.context.identity.workspace_id, f.context.paths.state_root, native) }));
    const running = worker.runOnce(); await started;
    const duringStart = f.jobs.get(f.request(), job.id);
    assert.equal(duringStart.checkpoint!.pre_submit_failure, false); assert.equal(duringStart.checkpoint!.executor_id, 'codex');
    f.context.db.prepare("UPDATE job_attempts SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(duringStart.attempts[0].id);
    assert.equal(worker.jobs.recoverExpired({ registered_only: true })[0].state, 'queued');
    rejectStart(new ContractError('RESULT_UNKNOWN', 'fixture lost handle after lease expiry')); await running;
    assert.equal((await worker.runOnce())!.state, 'failed'); assert.equal(native.starts, 1);
    assert.equal(f.jobs.get(f.request(), job.id).error!.code, 'RESULT_UNKNOWN');
  } finally { f.cleanup(); }
});

test('API POST 的认证或额度错误也不是执行前证明，不放行换执行器', async () => {
  for (const mode of ['http_401', 'http_429'] as const) {
    const f = routedFixture();
    try {
      const job = f.enqueue(); f.setMode(mode); await f.worker.runOnce();
      const before = f.jobs.get(f.request(), job.id);
      assert.equal(before.job.state, mode === 'http_401' ? 'waiting_input' : 'waiting_quota');
      assert.equal(before.checkpoint!.pre_submit_failure, false); assert.equal(f.postCount(), 1);
      assert.throws(() => f.jobs.resume(f.request(), job.id, { expected_version: before.job.version, executor: 'claude' }), { code: 'RESULT_UNKNOWN' });
      assert.deepEqual(f.jobs.get(f.request(), job.id), before); assert.equal(f.postCount(), 1);
    } finally { f.cleanup(); }
  }
});

test('新 worker 恢复已完成 API 回执可正常提交，不检查订阅或再次 POST', async () => {
  const f = routedFixture();
  try {
    const job = f.enqueue(); f.setMode('success');
    // 在 finalizer 前断开 worker 的观察，provider 回执已完整持久化。
    const submit = f.worker.results.submit.bind(f.worker.results);
    f.worker.results.submit = () => { throw new ContractError('RESULT_UNKNOWN', 'fixture result delivery lost'); };
    assert.equal((await f.worker.runOnce())!.state, 'failed');
    const before = f.jobs.get(f.request(), job.id); assert.equal(f.postCount(), 1);
    f.worker.results.submit = submit; f.jobs.resume(f.request(), job.id, { expected_version: before.job.version });
    assert.equal((await f.worker.runOnce())!.state, 'committed');
    assert.equal(f.postCount(), 1); assert.equal(f.native.starts, 0); assert.equal(f.native.resumes, 0);
    const after = f.jobs.get(f.request(), job.id); assert.equal(after.receipts.length, 1); assert.equal(after.job.state, 'succeeded');
    assert.equal(after.attempts[1].runtime_session_id, after.attempts[0].runtime_session_id);
  } finally { f.cleanup(); }
});
