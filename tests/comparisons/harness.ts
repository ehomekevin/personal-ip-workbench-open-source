import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONTRACT_VERSION, type CreateComparisonRequest, type RequestContext, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage, assertStorageRoot, sha256 } from '../../packages/storage/src/connection/index.ts';
import { Comparisons } from '../../packages/domain/src/comparisons/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';
export const projectRoot = resolve(import.meta.dirname, '../..');
export const runId = `run-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const evidenceRoot = process.env.WORKBENCH_TEST_EVIDENCE_DIR ? join(resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR), 'wp13') : join(projectRoot, '.ci-artifacts/evidence/wp-13');
export const runRoot = join(evidenceRoot, 'runs', runId); mkdirSync(runRoot, { recursive: true });
export const records: unknown[] = [];
export function evidence(name: string, value: unknown) { const path = join(runRoot, name + '.json'); const content = JSON.stringify(value, null, 2) + '\n'; writeFileSync(path, content, { flag: 'wx' }); return { path, sha256: sha256(content) }; }
export const implementationFiles = ['packages/domain/src/comparisons/index.ts','packages/domain/src/comparisons/rules.ts','packages/domain/src/comparisons/decimal.ts','packages/storage/src/comparisons/index.ts','apps/service/src/routes/comparisons.ts','apps/web/src/features/retro/comparisons/index.ts','packages/contracts/src/comparisons.ts','packages/storage/src/metrics/index.ts','tests/comparisons/comparisons.test.ts','tests/comparisons/harness.ts','tests/comparisons/frontend.test.ts'];
export function implementationHashes() { return Object.fromEntries(implementationFiles.map(path => [path, sha256(readFileSync(join(projectRoot, path)))])); }
export const sourceHashes = implementationHashes(); evidence('input-source-hashes', { captured_at: new Date().toISOString(), hashes: sourceHashes });
export function fixture() {
  assertStorageRoot(projectRoot); const root = mkdtempSync(join(projectRoot, 'tests/comparisons/.wp13-'));
  const paths = { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') };
  for (const path of [paths.managed_notes_root, paths.state_root, paths.media_root, join(paths.state_root, 'raw-responses')]) mkdirSync(path, { recursive: true });
  const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: 'WP13 internal_rule', mode: 'demo', timezone: 'America/Los_Angeles', paths, listen: { host: '127.0.0.1', port: 4319 } };
  const workspace = config.workspace_id, identity = { workspace_id: workspace, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION };
  const account = randomUUID(), definition = randomUUID(), source = randomUUID();
  let storage = (() => { let opened: ReturnType<typeof openWorkspaceStorage> | undefined; try {
    opened = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite'));
  opened.db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,?,?,?,?,1)').run(workspace, workspace, config.title, config.timezone, JSON.stringify(paths), 'demo');
  opened.db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'x','owner-test','owner','fixture','https://fixture.invalid','confirmed')").run(account, workspace);
  opened.db.prepare("INSERT INTO metric_definitions(id,workspace_id,platform,key,raw_field,unit,kind,visibility,definition_version,scope) VALUES (?,?,'x','views','views','count','cumulative','public','v1','work')").run(definition, workspace);
  opened.db.prepare("INSERT INTO sources(id,workspace_id,kind,external_id,url,schema_version) VALUES (?,?,'metrics','tikhub','https://fixture.invalid','fixture-v1')").run(source, workspace);
    return opened;
  } catch (error) { opened?.close(); rmSync(root, { recursive: true, force: true }); throw error; } })();
  const now = Date.parse('2026-10-31T00:00:00Z');
  const context = (): ApplicationContext => ({ db: storage.db, identity, config, paths, getExecutorHealth: async () => [] });
  const request = (key = randomUUID()): RequestContext => ({ ...identity, request_id: randomUUID(), idempotency_key: key, request_identity_ref: null });
  const query = (patch: Partial<CreateComparisonRequest> = {}): CreateComparisonRequest => ({ kind: 'self_period', platform: 'x', account_ids: [account], format: 'text', metric_definition_id: definition, timezone: 'America/Los_Angeles', cohort_windows: { target: { start: '2026-10-01T07:00:00Z', end: '2026-10-08T07:00:00Z' }, baseline: { start: '2026-09-24T07:00:00Z', end: '2026-10-01T07:00:00Z' } }, as_of: '2026-10-31T00:00:00Z', ...patch });
  function work(published = '2026-10-02T12:00:00Z', patch: Record<string, unknown> = {}) { const id = randomUUID(); storage.db.prepare("INSERT INTO works(id,workspace_id,platform,platform_work_id,account_id,format,format_source,url,published_at,origin,identity_status,canonical_work_id) VALUES (?,?,?,?,?,?,?,?,?,'fixture',?,?)").run(id, workspace, String(patch.platform ?? 'x'), String(patch.platform_work_id ?? id), String(patch.account_id ?? account), patch.format === null ? null : String(patch.format ?? 'text'), patch.format_source === null ? null : 'human_classification', 'https://fixture.invalid/' + id, patch.published_at === null ? null : published, String(patch.identity_status ?? 'confirmed'), patch.canonical_work_id as string ?? null); return id; }
  function snapshot(workId: string, value = '100', patch: Record<string, unknown> = {}) {
    const id = String(patch.id ?? randomUUID()), published = storage.db.prepare('SELECT published_at FROM works WHERE id=?').get(workId)!.published_at;
    const observed = patch.observed_at === null ? null : String(patch.observed_at ?? new Date(Date.parse(String(published)) + 72 * 3600000).toISOString()), collected = String(patch.collected_at ?? (observed ? new Date(Date.parse(observed) + 60000).toISOString() : '2026-10-10T00:00:00Z'));
    const rawPath = join(paths.state_root, 'raw-responses', id + '.json'), raw = JSON.stringify({ internal_rule: true, workId, value }); writeFileSync(rawPath, raw);
    storage.db.prepare('INSERT INTO snapshots(id,workspace_id,work_id,source_id,collection_request_id,request_fingerprint,observed_at,observed_time_basis,observed_time_reason,collected_at,observed_age_s,raw_path,raw_sha256,adapter_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, workspace, workId, source, randomUUID(), sha256(id), observed, observed === null ? 'unknown' : 'provider', observed === null ? 'fixture unknown' : null, collected, observed === null || published === null ? null : Math.floor((Date.parse(observed) - Date.parse(String(published))) / 1000), rawPath, sha256(raw), 'fixture-v1');
    const available = String(patch.availability ?? 'available'); storage.db.prepare('INSERT INTO metric_values(id,workspace_id,snapshot_id,definition_id,value,availability,reason) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), workspace, id, String(patch.definition_id ?? definition), available === 'available' ? value : null, available, available === 'available' ? null : 'fixture missing'); return { id, rawPath };
  }
  function seedPeriods() { const current = [work('2026-10-02T12:00:00Z'), work('2026-10-03T12:00:00Z')], previous = [work('2026-09-26T12:00:00Z'), work('2026-09-27T12:00:00Z')]; current.forEach((id, index) => snapshot(id, ['100','200'][index])); previous.forEach((id, index) => snapshot(id, ['50','150'][index])); return { current, previous }; }
  return { root, paths, config, identity, account, definition, source, now, context, request, query, work, snapshot, seedPeriods, comparisons: () => new Comparisons(context(), { clock: () => now }),
    reopen() { storage.close(); storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite')); },
    cleanup() { storage.close(); rmSync(root, { recursive: true, force: true }); return { root, removed: !existsSync(root) }; } };
}
