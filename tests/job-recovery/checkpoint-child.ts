import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_VERSION, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage } from '../../packages/storage/src/connection/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';

const scenarioPath = process.argv[2]; if (!scenarioPath) throw new Error('scenario required');
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as { config: ServiceConfiguration; kind: 'publication' | 'media_generate'; now: number };
const { config } = scenario, storage = openWorkspaceStorage(join(config.paths.state_root, 'workbench.sqlite'));
const context = { db: storage.db, identity: { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION }, config, paths: config.paths, getExecutorHealth: async () => [] };
const worker = new DurableWorker(context, [{ registration: { kind: scenario.kind, execution_mode: 'programmatic', recovery: scenario.kind === 'publication' ? 'external_side_effect' : 'media' },
  async execute({ claim, checkpoint }) {
    checkpoint({ remote_task_id: 'known-remote-task-child', sent: true });
    const durable = storage.db.prepare('SELECT checkpoint FROM job_attempts WHERE id=?').get(claim.attempt.id);
    process.stdout.write(JSON.stringify({ job_id: claim.job.id, attempt_id: claim.attempt.id, checkpoint: JSON.parse(String(durable?.checkpoint)), phase: 'after_checkpoint_committed_before_handler_return', pid: process.pid }) + '\n');
    process.kill(process.pid, 'SIGKILL'); throw new Error('SIGKILL must terminate process');
  } }], { clock: () => scenario.now });
await worker.runOnce(); storage.close();
