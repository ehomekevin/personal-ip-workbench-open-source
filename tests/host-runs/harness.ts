import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION, type RequestContext, type ServiceConfiguration, type NativeIdentity, type JsonObject } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage, sha256 } from '../../packages/storage/src/connection/index.ts';
import { HostRuns, type HostRunView, type BeginHostRunRequest } from '../../packages/domain/src/host-runs/index.ts';
import { Documents } from '../../packages/domain/src/documents/index.ts';
import { Jobs } from '../../packages/domain/src/jobs/index.ts';
import { getJob } from '../../packages/storage/src/jobs/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';
import type { ReceiveOutput } from '../../packages/domain/src/result-commit/index.ts';
import type { TrackingTimeProfile } from '../../packages/storage/src/host-tracking/index.ts';
import type { TrustedObserverProgram } from '../../packages/adapters/src/host-observer/index.ts';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const runId = process.env.WP17_RUN_ID ?? `run-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const evidenceRoot = process.env.WORKBENCH_TEST_EVIDENCE_DIR
  ? join(resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR), 'wp17')
  : join(projectRoot, '.ci-artifacts/evidence/wp-17');
export const runRoot = join(evidenceRoot, 'native-lifecycle-traces', runId);
mkdirSync(runRoot, { recursive: true });
export const profile: TrackingTimeProfile = { freshness_ms: 1500, lease_ms: 3000, output_grace_ms: 1000, future_skew_ms: 250 };
export function evidence(name: string, value: unknown): void { const path = join(runRoot, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); }
export function seedTracking(context: ApplicationContext, program: TrustedObserverProgram, capabilityId: string): void {
  const db = context.db, workspace = context.identity.workspace_id;
  // 明示 internal fixture；不是四宿主 supported 能力证据，不写真实工作区。
  db.prepare("INSERT INTO host_connections(id,workspace_id,service_instance_id,host_surface,plugin_id,plugin_version,runtime_version,connection_mode,request_identity_ref,status) VALUES (?,?,?,'internal_fixture','fixture','0','fixture','fixture',?,'connected')").run(program.host_connection_id, workspace, context.identity.service_instance_id, program.owner);
  db.prepare("INSERT INTO host_capability_records(id,workspace_id,host_surface,runtime_version,connection_mode,operation,plugin_version,status,limitations,verified_at,evidence_ref,version) VALUES (?,?,'internal_fixture','fixture','fixture','native_task_tracking','0','supported','[\"internal_rule only\"]',?,'wp17-internal-fixture',1)").run(capabilityId, workspace, new Date().toISOString());
}
export function fixture() {
  const root = mkdtempSync(join(projectRoot, 'tests/host-runs/.wp17-'));
  const paths = { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') };
  for (const path of [paths.managed_notes_root, paths.state_root, paths.media_root]) mkdirSync(path);
  const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: 'WP-17 isolated protocol fixture', mode: 'demo', timezone: 'America/Los_Angeles', paths, listen: { host: '127.0.0.1', port: 0 } };
  const program: TrustedObserverProgram = { owner: 'trusted-wp17-fixture', host_connection_id: randomUUID(), observer_credential: randomUUID(), connection_credential: randomUUID() }, capabilityId = randomUUID();
  let storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite')), now = Date.now();
  const identity = { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION };
  storage.db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,?,?,?,?,1)').run(config.workspace_id, config.workspace_id, config.title, config.timezone, JSON.stringify(paths), 'demo');
  const context = (): ApplicationContext => ({ db: storage.db, identity, config, paths, getExecutorHealth: async () => [] });
  seedTracking(context(), program, capabilityId);
  const request = (key = randomUUID()): RequestContext => ({ ...identity, request_id: randomUUID(), idempotency_key: key, request_identity_ref: null });
  const controller = () => new HostRuns(context(), { clock: () => now, profile, trustedPrograms: [program] });
  let runs = controller();
  const principal = (role: 'observer' | 'connection') => runs.authority.authenticate(role === 'observer' ? { authorization: `Bearer ${program.observer_credential}` } : { 'x-host-connection-credential': program.connection_credential }, role);
  const observer = (epoch: string = randomUUID()) => runs.register(request(), principal('observer'), { host_connection_id: program.host_connection_id, observer_epoch: epoch, capability_record_id: capabilityId, capability_version: 1 });
  const identityFor = (scope: 'turn' | 'task' = 'turn'): NativeIdentity => scope === 'turn' ? { scope, native_namespace: 'wp17-internal-fixture', native_session_id: 'session-fixture', native_turn_id: randomUUID() } : { scope, native_namespace: 'wp17-internal-fixture', native_task_id: randomUUID() };
  const binding = (owner = observer(), nativeIdentity = identityFor()) => runs.bind(request(), principal('observer'), owner.id, { observer_epoch: owner.observer_epoch, native_identity: nativeIdentity });
  const observation = (b: ReturnType<typeof binding>, state: 'running' | 'waiting_tool' | 'completed' | 'failed' | 'interrupted' | 'auth_required' | 'quota_exhausted' | 'disconnected' = 'running', sequence?: number, observedAt = new Date(now).toISOString()) => {
    const last = storage.db.prepare('SELECT MAX(sequence) AS n FROM native_task_observations WHERE binding_id=?').get(b.id);
    return runs.observe(request(), principal('observer'), b.id, { observer_epoch: b.observer_epoch, sequence: sequence ?? Number(last?.n ?? 0) + 1, native_state: state, observed_at: observedAt, native_evidence_ref: `internal-fixture:${state}:${sequence ?? Number(last?.n ?? 0) + 1}` });
  };
  async function document(initial_text = 'r1 固定材料') { const documents = new Documents(context()); return documents.create(request(), { kind: 'wiki', initial_text }); }
  const beginInput = (doc: Awaited<ReturnType<typeof document>>, b: ReturnType<typeof binding>, request_context: 'conversation' | 'page_action' = 'conversation'): BeginHostRunRequest => ({ kind: 'document_modify', mode: 'candidate', targets: [{ document_id: doc.document_id, base_revision_id: doc.head_revision_id, core_revision_id: null }], source_ids: [], instruction: '以固定资料修改正文', request_context, native_task_binding_id: b.id, expected_version: doc.version });
  async function begin(requestContext: 'conversation' | 'page_action' = 'conversation') { const doc = await document(), b = binding(); observation(b); const input = beginInput(doc, b, requestContext), run = runs.begin(request(), principal('connection'), input); return { doc, b, input, run }; }
  const output = (run: HostRunView, text = '受信规则候选'): ReceiveOutput => ({ attempt_id: run.attempt_id, attempt_generation: run.attempt_generation, expected_version: getJob(storage.db, config.workspace_id, run.job_id).version, input_hash: run.input_hash, typed_output: { documents: (run.input_manifest.targets as JsonObject[]).map(target => ({ document_id: String(target.document_id), text })), recommendations: [] } });
  function snapshot(jobId: string) {
    const db = storage.db;
    return { job: db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId), attempts: db.prepare('SELECT * FROM job_attempts WHERE job_id=? ORDER BY attempt_no').all(jobId),
      bindings: db.prepare('SELECT b.* FROM native_task_bindings b JOIN job_attempts a ON a.native_task_binding_id=b.id WHERE a.job_id=?').all(jobId),
      observations: db.prepare('SELECT n.* FROM native_task_observations n JOIN native_task_bindings b ON b.id=n.binding_id JOIN job_attempts a ON a.native_task_binding_id=b.id WHERE a.job_id=? ORDER BY n.sequence').all(jobId),
      receipts: db.prepare('SELECT * FROM result_receipts WHERE job_id=?').all(jobId), intents: db.prepare('SELECT * FROM write_intents WHERE job_id=?').all(jobId).map(row => { let actual_file_hash = null; try { actual_file_hash = sha256(readFileSync(String(row.path))); } catch {} return { ...row, actual_file_hash }; }),
      candidates: db.prepare('SELECT * FROM candidates WHERE job_id=?').all(jobId), documents: db.prepare('SELECT id,head_revision_id,version FROM documents').all(), events: db.prepare('SELECT * FROM job_events WHERE job_id=? ORDER BY seq').all(jobId), foreign_key_check: db.prepare('PRAGMA foreign_key_check').all() };
  }
  return { root, config, program, capabilityId, context, request, principal, observer, binding, observation, identityFor, document, beginInput, begin, output, snapshot,
    get runs() { return runs; }, get now() { return now; }, set now(value: number) { now = value; }, jobs: () => new Jobs(context(), { clock: () => now }),
    reopen() { storage.close(); storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite')); runs = controller(); runs.initialize(); },
    cleanup() { try { storage.close(); } catch {} rmSync(root, { recursive: true, force: true }); } };
}
