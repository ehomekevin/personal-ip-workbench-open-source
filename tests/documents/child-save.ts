import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage } from '../../packages/storage/src/connection/index.ts';
import { ManagedFiles } from '../../packages/storage/src/files/index.ts';
import { prepareHumanRevision, prepareRevisionFile, commitHumanRevision, recoverHumanIntents } from '../../packages/storage/src/revisions/index.ts';

const [configPath, documentId, baseRevision, phase] = process.argv.slice(2);
if (!configPath) throw new Error('config required');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as ServiceConfiguration;
const storage = openWorkspaceStorage(join(config.paths.state_root, 'workbench.sqlite')); const files = new ManagedFiles(config.paths);
if (phase === 'recover') {
  process.stdout.write(JSON.stringify(recoverHumanIntents(storage.db, files, config.workspace_id))); storage.close();
} else {
  const request = { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION,
    request_id: randomUUID(), idempotency_key: `crash-${phase}`, request_identity_ref: 'human-test' };
  const prepared = prepareHumanRevision(storage.db, files, request, { document_id: documentId!, expected_revision_id: baseRevision ?? null, text: `保存中断-${phase}` });
  if (phase === 'after_prepare') process.kill(process.pid, 'SIGKILL');
  prepareRevisionFile(storage.db, files, config.workspace_id, prepared.write_intent_id);
  if (phase === 'after_rename') process.kill(process.pid, 'SIGKILL');
  commitHumanRevision(storage.db, files, config.workspace_id, prepared.write_intent_id);
  if (phase === 'after_commit') process.kill(process.pid, 'SIGKILL');
}
