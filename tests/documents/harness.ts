import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION, type RequestContext, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage, assertStorageRoot } from '../../packages/storage/src/connection/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function fixture() {
  assertStorageRoot(projectRoot);
  const root = mkdtempSync(join(projectRoot, 'tests/documents/.wp08-'));
  const paths = { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') };
  for (const path of [paths.managed_notes_root, paths.state_root, paths.media_root]) mkdirSync(path);
  const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: 'WP-08 isolated test', mode: 'demo', timezone: 'America/Los_Angeles', paths,
    listen: { host: '127.0.0.1', port: 4318 }, default_executor: 'codex', api_fallback_enabled: false };
  const configPath = join(root, 'config.json'); writeFileSync(configPath, JSON.stringify(config));
  let storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite'));
  storage.db.prepare('INSERT INTO workspaces (id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,?,?,?,?,1)').run(config.workspace_id, config.workspace_id, config.title, config.timezone, JSON.stringify(paths), 'demo');
  const identity = { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION };
  const context = (): ApplicationContext => ({ db: storage.db, identity, config, paths,
    getExecutorHealth: async () => ['codex', 'claude'].map(executor_id => ({ executor_id, status: 'unconfigured', runtime_version: null, auth_state: 'unknown', billing_route: null, limitations: [] })) });
  return { root, config, configPath, context, request: (key: string = randomUUID()): RequestContext => ({ ...identity, request_id: randomUUID(), idempotency_key: key, request_identity_ref: 'human-test' }),
    reopen() { storage.close(); storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite')); },
    closeDb() { storage.close(); },
    openDb() { storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite')); },
    cleanup() { try { storage.close(); } catch { /* 已关闭测试连接。 */ } rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); },
  };
}
export function writeEvidence(filename: string, data: unknown) {
  const root = process.env.WORKBENCH_TEST_EVIDENCE_DIR ? resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR) : join(projectRoot, '.ci-artifacts/evidence/wp-08'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, filename), JSON.stringify(data, null, 2) + '\n');
}
