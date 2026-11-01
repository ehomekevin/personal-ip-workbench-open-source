import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION, type RequestContext, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage } from '../../packages/storage/src/connection/index.ts';
import { Jobs } from '../../packages/domain/src/jobs/index.ts';
import { ResultCommit } from '../../packages/domain/src/result-commit/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';
export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const schemaDirectory = resolve(projectRoot, '.ci-artifacts/evidence/wp-03/local-inventory/codex-schema-0.161.0');
export function fixture() {
 const root = mkdtempSync(join(projectRoot, 'tests/service-agent/.wp15-')); const paths = { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') }; const staging = join(root, 'staging');
 for (const path of [paths.managed_notes_root, paths.state_root, paths.media_root, staging]) mkdirSync(path);
 const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: 'WP15 isolated internal_rule', mode: 'demo', timezone: 'America/Los_Angeles', paths, listen: { host: '127.0.0.1', port: 0 } };
 const storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite')); storage.db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,?,?,?,?,1)').run(config.workspace_id, config.workspace_id, config.title, config.timezone, JSON.stringify(paths), 'demo');
 const identity = { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION }; const context: ApplicationContext = { db: storage.db, config, identity, paths, getExecutorHealth: async () => [] }; const jobs = new Jobs(context); const results = new ResultCommit(context);
 const request = (): RequestContext => ({ ...identity, request_id: randomUUID(), idempotency_key: randomUUID(), request_identity_ref: 'internal_rule' });
 const document = randomUUID(); storage.db.prepare("INSERT INTO documents(id,workspace_id,kind,version) VALUES (?,?,'wiki',1)").run(document, config.workspace_id);
 function enqueue(executor = 'codex', taskInstruction = 'Write one short sentence.') { return jobs.enqueue(request(), { kind: 'document_modify', execution_mode: 'service_adapter', executor_id: executor, entrypoint: 'standalone_web', presentation: 'foreground_dialog', target_id: document,
 input_manifest: { schema_version: 'wp15-service-v1', mode: 'candidate', targets: [{ document_id: document, base_revision_id: null, core_revision_id: null }], source_ids: [], service_agent: { cwd: staging, task_instruction: taskInstruction, allowed_tools: [] } } }); }
 return { root, staging, context, jobs, results, request, document, enqueue, cleanup() { storage.close(); rmSync(root, { recursive: true, force: true }); } };
}
