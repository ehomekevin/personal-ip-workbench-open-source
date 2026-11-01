import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage } from '../../packages/storage/src/connection/index.ts';
import { ResultCommit, type ReceiveOutput } from '../../packages/domain/src/result-commit/index.ts';

const [scenarioPath, phase] = process.argv.slice(2);
if (!scenarioPath) throw new Error('scenario required');
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as { config: ServiceConfiguration; job_id: string; input: ReceiveOutput; owner: string; key: string; now: number };
const config = scenario.config, storage = openWorkspaceStorage(join(config.paths.state_root, 'workbench.sqlite'));
const identity = { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION };
const context = { db: storage.db, identity, config, paths: config.paths, getExecutorHealth: async () => [] };
const result = new ResultCommit(context, { clock: () => scenario.now, observerReady: () => true });
const receipt = result.receive({ ...identity, request_id: randomUUID(), idempotency_key: scenario.key, request_identity_ref: 'internal-fixture' }, scenario.job_id, scenario.input, scenario.owner);
function interrupt(point: string) { process.stdout.write(JSON.stringify({ phase: point, receipt_id: receipt.receipt_id, pid: process.pid }) + '\n'); process.kill(process.pid, 'SIGKILL'); }
if (phase === 'pending_intent') interrupt('pending_intent');
result.prepare(receipt.receipt_id, index => { if (phase === 'partial_prepare' && index === 0) interrupt('partial_prepare'); });
if (phase === 'after_rename') interrupt('after_rename');
if (phase === 'before_commit') {
  storage.db.function('interrupt_before_final_commit', () => { interrupt('before_commit:sqlite_transaction_after_receipt_revisions_candidates_intents'); return 0; });
  storage.db.exec(`CREATE TEMP TRIGGER interrupt_transaction BEFORE UPDATE OF state ON jobs WHEN NEW.id='${scenario.job_id}' AND NEW.state='succeeded' BEGIN SELECT interrupt_before_final_commit(); END`);
}
const committed = result.commitResult(receipt.receipt_id);
if (phase === 'response_lost') interrupt('response_lost');
process.stdout.write(JSON.stringify(committed)); storage.close();
