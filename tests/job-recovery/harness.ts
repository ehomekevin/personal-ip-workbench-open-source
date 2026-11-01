import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION, type RequestContext, type ServiceConfiguration, type JsonObject, type JobsRow } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage, assertStorageRoot, transaction, canonicalJson, sha256 } from '../../packages/storage/src/connection/index.ts';
import { Jobs } from '../../packages/domain/src/jobs/index.ts';
import { ResultCommit, type FrozenTarget, type TypedOutput, type ReceiveOutput } from '../../packages/domain/src/result-commit/index.ts';
import { queueJobInTransaction, startAttemptInTransaction, type ClaimedJob } from '../../packages/storage/src/jobs/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const runId = `run-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
export const evidenceRoot = process.env.WORKBENCH_TEST_EVIDENCE_DIR ? resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR) : join(projectRoot, '.ci-artifacts/evidence/wp-09');
export const runRoot = join(evidenceRoot, 'runs', runId);
mkdirSync(runRoot, { recursive: true });
export function evidence(name: string, value: unknown): string {
  const path = join(runRoot, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); return path;
}
export function snapshot(context: ApplicationContext, jobId: string) {
  const db = context.db, workspace = context.identity.workspace_id;
  const receipts = db.prepare('SELECT * FROM result_receipts WHERE workspace_id=? AND job_id=? ORDER BY created_at,id').all(workspace, jobId);
  const intents = db.prepare('SELECT * FROM write_intents WHERE workspace_id=? AND job_id=? ORDER BY document_id,id').all(workspace, jobId).map(row => {
    let actualHash: string | null = null; try { actualHash = sha256(readFileSync(String(row.path))); } catch { /* 未 rename 的文件按缺失记录。 */ }
    return { ...row, actual_file_hash: actualHash } as Record<string, unknown> & { actual_file_hash: string | null };
  });
  return { job: db.prepare('SELECT * FROM jobs WHERE workspace_id=? AND id=?').get(workspace, jobId),
    attempts: db.prepare('SELECT * FROM job_attempts WHERE workspace_id=? AND job_id=? ORDER BY attempt_no').all(workspace, jobId), receipts, intents,
    documents: db.prepare('SELECT id,head_revision_id,version FROM documents WHERE workspace_id=? ORDER BY id').all(workspace),
    revisions: db.prepare('SELECT * FROM document_revisions WHERE workspace_id=? AND job_id=? ORDER BY id').all(workspace, jobId),
    candidates: db.prepare('SELECT * FROM candidates WHERE workspace_id=? AND job_id=? ORDER BY id').all(workspace, jobId),
    recommendations: db.prepare('SELECT c.* FROM recommendation_candidates c JOIN recommendation_runs r ON r.workspace_id=c.workspace_id AND r.id=c.run_id WHERE r.workspace_id=? AND r.job_id=?').all(workspace, jobId),
    events: db.prepare('SELECT * FROM job_events WHERE workspace_id=? AND job_id=? ORDER BY seq').all(workspace, jobId),
    foreign_key_check: db.prepare('PRAGMA foreign_key_check').all(), integrity_check: db.prepare('PRAGMA integrity_check').all() };
}
export function fixture() {
  assertStorageRoot(projectRoot); const root = mkdtempSync(join(projectRoot, 'tests/job-recovery/.wp09-'));
  const paths = { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') };
  for (const path of [paths.managed_notes_root, paths.state_root, paths.media_root]) mkdirSync(path);
  const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: 'WP-09 isolated internal fixture', mode: 'demo', timezone: 'America/Los_Angeles', paths,
    listen: { host: '127.0.0.1', port: 4319 } };
  const configPath = join(root, 'config.json'); writeFileSync(configPath, JSON.stringify(config));
  let storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite'));
  storage.db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,?,?,?,?,1)').run(config.workspace_id, config.workspace_id, config.title, config.timezone, JSON.stringify(paths), 'demo');
  const identity = { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION };
  let now = Date.now(), ready = true;
  const context = (): ApplicationContext => ({ db: storage.db, identity, config, paths, getExecutorHealth: async () => [] });
  const request = (key: string = randomUUID()): RequestContext => ({ ...identity, request_id: randomUUID(), idempotency_key: key, request_identity_ref: 'internal-fixture' });
  const jobs = () => new Jobs(context(), { clock: () => now });
  const results = () => new ResultCommit(context(), { clock: () => now, observerReady: () => ready });
  function document(kind = 'wiki'): string { const id = randomUUID(); storage.db.prepare('INSERT INTO documents(id,workspace_id,kind,version) VALUES (?,?,?,1)').run(id, config.workspace_id, kind); return id; }
  function hostClaim(job: JobsRow): ClaimedJob {
    const db = storage.db, workspace = config.workspace_id;
    return transaction(db, () => {
      const connection = randomUUID(), capability = randomUUID(), observer = randomUUID(), binding = randomUUID(), observation = randomUUID(), epoch = randomUUID(), at = new Date(now).toISOString();
      // 这些仅为控制规则的数据库 fixture，不是实际宿主 observer 或 supported 证据。
      db.prepare(`INSERT INTO host_connections(id,workspace_id,service_instance_id,host_surface,plugin_id,plugin_version,runtime_version,connection_mode,request_identity_ref,status)
        VALUES (?,?,?,'internal_fixture','fixture','0','fixture','fixture','trusted-fixture','connected')`).run(connection, workspace, config.service_instance_id);
      db.prepare(`INSERT INTO host_capability_records(id,workspace_id,host_surface,runtime_version,connection_mode,operation,plugin_version,status,limitations,verified_at,evidence_ref,version)
        VALUES (?,?,'internal_fixture','fixture','fixture','native_task_tracking','0','supported','["internal_rule fixture only"]',?,'internal-fixture',1)`).run(capability, workspace, at);
      db.prepare("INSERT INTO host_task_observers(id,workspace_id,observer_epoch,host_connection_id,capability_record_id,capability_version,request_identity_ref,state) VALUES (?,?,?,?,?,1,'trusted-fixture','ready')").run(observer, workspace, epoch, connection, capability);
      db.prepare("INSERT INTO native_task_bindings(id,workspace_id,observer_id,observer_epoch,host_connection_id,scope,native_namespace,native_session_id,native_turn_id,state) VALUES (?,?,?,?,?,'turn','internal_fixture',?,?,'active')").run(binding, workspace, observer, epoch, connection, randomUUID(), randomUUID());
      db.prepare("INSERT INTO native_task_observations(id,workspace_id,binding_id,observer_id,observer_epoch,sequence,native_state,observed_at,received_at,native_evidence_ref) VALUES (?,?,?,?,?,1,'running',?,?,'internal-fixture-running')").run(observation, workspace, binding, observer, epoch, at, at);
      const claim = startAttemptInTransaction(db, workspace, job.id, 'trusted-fixture', now, { host_connection_id: connection, native_task_binding_id: binding });
      db.prepare('UPDATE native_task_bindings SET current_attempt_id=?,latest_observation_id=?,last_renewed_observation_id=? WHERE id=?').run(claim.attempt.id, observation, observation, binding);
      return claim;
    });
  }
  function create(targets: FrozenTarget[], options: { mode?: string; kind?: string; execution_mode?: 'host_session' | 'service_adapter' | 'programmatic'; recommendation_kind?: 'topic' | 'account' } = {}): ClaimedJob {
    const mode = options.mode ?? 'candidate', kind = options.kind ?? 'document_modify', execution_mode = options.execution_mode ?? 'service_adapter';
    const input_manifest: JsonObject = { schema_version: 'wp09-input-v1', mode, targets: targets as unknown as JsonObject[], source_ids: [], ...(options.recommendation_kind ? { recommendation_kind: options.recommendation_kind } : {}) };
    const input = { kind, target_id: targets[0]?.document_id ?? null, entrypoint: execution_mode === 'host_session' ? 'codex_plugin' as const : 'standalone_web' as const, execution_mode, input_manifest, presentation: execution_mode === 'host_session' ? 'host_conversation' as const : 'foreground_dialog' as const };
    const job = execution_mode === 'host_session' ? transaction(storage.db, () => queueJobInTransaction(storage.db, config.workspace_id, { ...input, retry_policy: { recovery: 'manual' } }, now)) : jobs().enqueue(request(), input);
    return execution_mode === 'host_session' ? hostClaim(job) : jobs().claim('worker:fixture')!;
  }
  function output(claim: ClaimedJob, typed_output?: TypedOutput): ReceiveOutput {
    const manifest = JSON.parse(claim.job.input_manifest);
    return { attempt_id: claim.attempt.id, attempt_generation: claim.attempt.attempt_generation, expected_version: claim.job.version, input_hash: claim.job.input_hash,
      typed_output: typed_output ?? { documents: manifest.targets.map((target: FrozenTarget) => ({ document_id: target.document_id, text: `内部规则正文:${target.document_id}` })), recommendations: [] } };
  }
  return { root, config, configPath, context, request, jobs, results, document, create, output, hostClaim,
    get now() { return now; }, set now(value: number) { now = value; }, set ready(value: boolean) { ready = value; },
    reopen() { storage.close(); storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite')); },
    cleanup() { try { storage.close(); } catch { /* 测试连接已关闭。 */ } rmSync(root, { recursive: true, force: true }); } };
}
