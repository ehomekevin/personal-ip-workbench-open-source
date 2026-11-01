import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { CONTRACT_VERSION, type ServiceConfiguration, type JsonObject } from '../../packages/contracts/src/index.ts';
import type { HostRunView } from '../../packages/domain/src/host-runs/index.ts';
import type { ReceiveOutput } from '../../packages/domain/src/result-commit/index.ts';
import type { TrustedObserverProgram } from '../../packages/adapters/src/host-observer/index.ts';
import { evidence, projectRoot, runId } from './harness.ts';

interface Snapshot { job: { state: string; version: number }; receipts: Array<{ id: string; state: string; quarantine_reason: string | null }>; intents: Array<{ sha256: string; actual_file_hash: string | null }>; candidates: JsonObject[]; documents: Array<{ head_revision_id: string | null }>; foreign_key_check: unknown[] }
interface Started { identity: { workspace_id: string; service_instance_id: string }; boot_id: string; address: { host: string; port: number }; pid: number }
function child() {
  const process = fork(new URL('./crash-child.ts', import.meta.url), [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...globalThis.process.env, WP17_RUN_ID: runId } });
  let output = ''; process.stdout?.on('data', chunk => { output += String(chunk); }); process.stderr?.on('data', chunk => { output += String(chunk); });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  process.on('message', (message: { id: string; ok: boolean; value: unknown; error?: string }) => { const p = pending.get(message.id); if (!p) return; clearTimeout(p.timer); pending.delete(message.id); if (message.ok) p.resolve(message.value); else p.reject(new Error(message.error)); });
  process.on('exit', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`child exited: ${output}`)); } pending.clear(); });
  const rpc = <T>(command: string, input: Record<string, unknown> = {}): Promise<T> => new Promise((resolve, reject) => { const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error(`child timeout ${command}: ${output}`)); }, 20_000); pending.set(id, { resolve: value => resolve(value as T), reject, timer }); process.send({ id, command, input }); });
  return { process, rpc, get output() { return output; } };
}
async function kill(process: ChildProcess) { if (process.exitCode !== null || process.signalCode !== null) return; const ended = once(process, 'exit'); process.kill('SIGKILL'); await ended; }
const cases: Array<Record<string, unknown>> = [];
for (const phase of ['pending_intent', 'after_rename', 'before_commit'] as const) for (const reason of ['expired', 'new_attempt', 'cancelled', 'still_valid'] as const) {
  test(`T47 隔离HTTP服务 ${phase} × ${reason} SIGKILL恢复`, async () => {
    const name = `${phase}-${reason}`, root = mkdtempSync(join(projectRoot, 'tests/host-runs/.service17-')), now = Date.now();
    const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: 'WP17 subprocess internal_rule', mode: 'demo', timezone: 'America/Los_Angeles', paths: { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') }, listen: { host: '127.0.0.1', port: 4317 } };
    const program: TrustedObserverProgram = { owner: 'wp17-isolated-service', host_connection_id: randomUUID(), observer_credential: randomUUID(), connection_credential: randomUUID() }, capabilityId = randomUUID();
    let active = child(); const traces: unknown[] = []; let current: Started;
    async function http<T>(path: string, body?: unknown, observer = false): Promise<{ status: number; body: T }> {
      const response = await fetch(`http://127.0.0.1:${current.address.port}/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': config.workspace_id, 'x-service-instance-id': config.service_instance_id, 'idempotency-key': randomUUID(), ...(observer ? { authorization: `Bearer ${program.observer_credential}` } : { 'x-host-connection-credential': program.connection_credential }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json() as T; traces.push({ at: new Date().toISOString(), path, status: response.status, response: value }); return { status: response.status, body: value };
    }
    try {
      current = await active.rpc<Started>('start', { config, program, capability_id: capabilityId, now, seed: true }); traces.push({ boot: current });
      const doc = (await http<{ document_id: string; head_revision_id: string; version: number }>('/documents', { kind: 'wiki', initial_text: '真实文件 r1 / internal_rule' })).body;
      const observer = (await http<{ id: string; observer_epoch: string }>('/host-task-observers', { host_connection_id: program.host_connection_id, observer_epoch: randomUUID(), capability_record_id: capabilityId, capability_version: 1 }, true)).body;
      assert.ok(observer.id);
      const identity = { scope: 'turn', native_namespace: 'internal_fixture', native_session_id: 'internal-session', native_turn_id: randomUUID() };
      const binding = (await http<{ id: string }>(`/host-task-observers/${observer.id}/bindings`, { observer_epoch: observer.observer_epoch, native_identity: identity }, true)).body;
      await http(`/native-task-bindings/${binding.id}/observations`, { observer_epoch: observer.observer_epoch, sequence: 1, native_state: 'running', observed_at: new Date(now).toISOString(), native_evidence_ref: 'internal-service-running-fixture' }, true);
      const run = (await http<HostRunView>('/host-runs', { kind: 'document_modify', mode: 'candidate', targets: [{ document_id: doc.document_id, base_revision_id: doc.head_revision_id, core_revision_id: null }], source_ids: [], instruction: '固定资料产出候选', request_context: 'conversation', native_task_binding_id: binding.id, expected_version: doc.version })).body;
      assert.ok(run.attempt_id);
      const output: ReceiveOutput = { attempt_id: run.attempt_id, attempt_generation: run.attempt_generation, expected_version: run.version, input_hash: run.input_hash, typed_output: { documents: [{ document_id: doc.document_id, text: '跨进程固定候选' }], recommendations: [] } };
      const checkpoint = await active.rpc<{ receipt: { receipt_id: string }; snapshot: Snapshot }>('checkpoint', { phase, job_id: run.job_id, output, key: 'before-crash-output' }); traces.push({ checkpoint });
      assert.equal(checkpoint.snapshot.receipts[0]!.state, 'pending'); assert.equal(checkpoint.snapshot.candidates.length, 0);
      for (const intent of checkpoint.snapshot.intents) assert.equal(intent.actual_file_hash, phase === 'pending_intent' ? null : intent.sha256);
      await kill(active.process); traces.push({ at: new Date().toISOString(), signal: 'SIGKILL', owned_process_pid: current.pid });
      active = child(); current = await active.rpc<Started>('start', { config, program, capability_id: capabilityId, now: now + (['expired', 'new_attempt'].includes(reason) ? 4000 : 100), seed: false }); traces.push({ reboot: current });
      let snapshot = await active.rpc<Snapshot>('snapshot', { job_id: run.job_id });
      assert.equal(snapshot.documents.find(row => row.head_revision_id === doc.head_revision_id)?.head_revision_id, doc.head_revision_id);
      if (reason === 'cancelled') {
        const cancelled = await http(`/jobs/${run.job_id}/cancel`, { expected_version: snapshot.job.version }); assert.equal(cancelled.status, 200);
      } else if (reason === 'new_attempt') {
        const registered = await http<{ id: string }>('/host-task-observers', { host_connection_id: program.host_connection_id, observer_epoch: observer.observer_epoch, capability_record_id: capabilityId, capability_version: 1 }, true); assert.equal(registered.status, 201);
        const next = (await http<{ id: string }>(`/host-task-observers/${observer.id}/bindings`, { observer_epoch: observer.observer_epoch, native_identity: { ...identity, native_turn_id: randomUUID() } }, true)).body;
        await http(`/native-task-bindings/${next.id}/observations`, { observer_epoch: observer.observer_epoch, sequence: 1, native_state: 'running', observed_at: new Date(now + 4000).toISOString(), native_evidence_ref: 'new-native-turn-internal-fixture' }, true);
        const resumed = await http<HostRunView>(`/jobs/${run.job_id}/resume`, { expected_version: snapshot.job.version, native_task_binding_id: next.id }); assert.equal(resumed.status, 200); assert.notEqual(resumed.body.attempt_id, run.attempt_id);
      } else if (reason === 'still_valid') {
        assert.equal(snapshot.receipts[0]!.state, 'pending');
        const rejected = await http<{ error: { code: string } }>(`/host-runs/${run.job_id}/outputs`, output); assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'HOST_OBSERVER_NOT_READY');
        const attached = await http(`/native-task-bindings/${binding.id}/reattach`, { observer_epoch: observer.observer_epoch, native_identity: identity, observation: { sequence: 2, native_state: 'running', observed_at: new Date(now + 100).toISOString(), native_evidence_ref: 'reattach-current-query-internal-fixture' } }, true); assert.equal(attached.status, 200);
      }
      const received = await http<{ receipt_id: string; state: string }>(`/host-runs/${run.job_id}/outputs`, output); assert.equal(received.status, 200); assert.equal(received.body.receipt_id, checkpoint.receipt.receipt_id); assert.equal(received.body.state, reason === 'still_valid' ? 'committed' : 'quarantined');
      snapshot = await active.rpc<Snapshot>('snapshot', { job_id: run.job_id }); assert.equal(snapshot.candidates.length, reason === 'still_valid' ? 1 : 0); assert.deepEqual(snapshot.foreign_key_check, []);
      const replay = await http<{ receipt_id: string }>(`/host-runs/${run.job_id}/outputs`, output); assert.equal(replay.body.receipt_id, received.body.receipt_id);
      traces.push({ final: snapshot }); evidence(`service-${name}.json`, { scope: 'internal_rule', actual_service: true, real_native_observation: false, test_controlled_time: true, checkpoints: traces });
      await active.rpc('close'); cases.push({ case: 'T47/T48', substep: name, scope: 'internal_rule', result: 'passed', actual_operation_at: new Date().toISOString(), evidence_path: `service-${name}.json` });
    } catch (error) { evidence(`service-${name}-failed.json`, { traces, error: error instanceof Error ? error.stack : String(error), process_output: active.output }); cases.push({ case: 'T47/T48', substep: name, scope: 'internal_rule', result: 'failed' }); throw error; }
    finally { await kill(active.process); rmSync(root, { recursive: true, force: true }); evidence('service-recovery-results.json', cases); }
  });
}
