import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONTRACT_VERSION, type RequestContext, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { assertStorageRoot, openWorkspaceStorage } from '../../packages/storage/src/connection/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';
export const projectRoot = resolve(import.meta.dirname, '../..');
export const runId = `run-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
export const evidenceRoot = process.env.WORKBENCH_TEST_EVIDENCE_DIR ? resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR) : join(projectRoot, '.ci-artifacts/evidence/wp-11');
export const runRoot = join(evidenceRoot, 'runs', runId); mkdirSync(runRoot, { recursive: true });
export function evidence(name: string, value: unknown): string { const path = join(runRoot, name); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); return path; }
export function fixture() {
  assertStorageRoot(projectRoot); const root = mkdtempSync(join(projectRoot, 'tests/ingest-index/.wp11-'));
  const paths = { source_vault_root: join(root, 'vault'), managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') }; Object.values(paths).forEach(path => mkdirSync(path));
  const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: 'WP11 isolated internal fixture', mode: 'demo', timezone: 'America/Los_Angeles', paths, listen: { host: '127.0.0.1', port: 4319 } };
  let storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite'));
  storage.db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,?,?,?,?,1)').run(config.workspace_id, config.workspace_id, config.title, config.timezone, JSON.stringify(paths), 'demo');
  const identity = { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION };
  const context = (): ApplicationContext => ({ db: storage.db, identity, config, paths, getExecutorHealth: async () => [] });
  const request = (key: string = randomUUID()): RequestContext => ({ ...identity, request_id: randomUUID(), idempotency_key: key, request_identity_ref: 'WP11-internal-fixture' });
  return { root, paths, context, request, config, identity, reopen() { storage.close(); storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite')); }, cleanup() { storage.close(); rmSync(root, { recursive: true, force: true }); } };
}
