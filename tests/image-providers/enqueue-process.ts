// Credential-free cross-process fixture: only enqueues in its supplied isolated workspace.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage } from '../../packages/storage/src/connection/index.ts';
import { ImageGenerationWorkflow } from '../../packages/domain/src/artifact-execution/image.ts';
const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as ServiceConfiguration;
const input = JSON.parse(readFileSync(process.argv[3]!, 'utf8'));
const storage = openWorkspaceStorage(join(config.paths.state_root, 'workbench.sqlite'));
try { const identity = { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION };
  const workflow = new ImageGenerationWorkflow({ db: storage.db, config, identity, paths: config.paths });
  process.stdout.write(JSON.stringify(workflow.enqueue({ ...identity, request_id: randomUUID(), request_identity_ref: 'r3-process-fixture', idempotency_key: process.argv[4]! }, input)));
} finally { storage.close(); }
