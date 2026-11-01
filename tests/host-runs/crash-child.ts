import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONTRACT_VERSION, CancelJobSchema, ResumeJobSchema, type RequestContext, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { startApplication, type RunningApplication } from '../../apps/service/src/bootstrap/application.ts';
import { createHostRunsModule } from '../../apps/service/src/routes/host-runs.ts';
import { createHostObserversModule } from '../../apps/service/src/routes/host-observers.ts';
import { createDocumentsModule } from '../../apps/service/src/routes/documents.ts';
import { HostRuns } from '../../packages/domain/src/host-runs/index.ts';
import { Jobs } from '../../packages/domain/src/jobs/index.ts';
import type { ReceiveOutput } from '../../packages/domain/src/result-commit/index.ts';
import { sha256 } from '../../packages/storage/src/connection/index.ts';
import type { TrustedObserverProgram } from '../../packages/adapters/src/host-observer/index.ts';
import { seedTracking, profile } from './harness.ts';

let app: RunningApplication | undefined, runs: HostRuns | undefined, program: TrustedObserverProgram | undefined, now = Date.now();
let chain = Promise.resolve();
function snapshot(jobId: string) {
  const db = app!.context.db;
  return { job: db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId), attempts: db.prepare('SELECT * FROM job_attempts WHERE job_id=? ORDER BY attempt_no').all(jobId),
    receipts: db.prepare('SELECT * FROM result_receipts WHERE job_id=?').all(jobId), intents: db.prepare('SELECT * FROM write_intents WHERE job_id=?').all(jobId).map(row => { let actual_file_hash = null; try { actual_file_hash = sha256(readFileSync(String(row.path))); } catch {} return { ...row, actual_file_hash }; }),
    candidates: db.prepare('SELECT * FROM candidates WHERE job_id=?').all(jobId), documents: db.prepare('SELECT id,head_revision_id,version FROM documents').all(),
    bindings: db.prepare('SELECT b.* FROM native_task_bindings b JOIN job_attempts a ON a.native_task_binding_id=b.id WHERE a.job_id=?').all(jobId), foreign_key_check: db.prepare('PRAGMA foreign_key_check').all() };
}
process.on('message', (message: { id: string; command: string; input: Record<string, unknown> }) => {
  chain = chain.then(async () => {
    try {
      let value: unknown; const input = message.input;
      if (message.command === 'start') {
        const config = input.config as unknown as ServiceConfiguration; program = input.program as unknown as TrustedObserverProgram; now = Number(input.now);
        app = await startApplication(config, { port: 0, moduleFactories: [context => { runs = new HostRuns(context, { clock: () => now, profile, trustedPrograms: [program!] }); return createHostRunsModule(context, runs); }, context => createHostObserversModule(context, runs!), createDocumentsModule, context => {
          const jobs = new Jobs(context, { clock: () => now }); return { id: 'wp17-test-job-routes', register(registrar) {
            registrar.register({ method: 'POST', path: '/api/v1/jobs/{id}/cancel', owner: 'WP-09', mutation: true, idempotent: true, schema: CancelJobSchema, handle: request => { runs!.authority.authenticate(request.headers, 'connection'); return { body: jobs.cancel(request.context, request.params.id!, request.body) }; } });
            registrar.register({ method: 'POST', path: '/api/v1/jobs/{id}/resume', owner: 'WP-17', mutation: true, idempotent: true, schema: ResumeJobSchema, handle: request => ({ body: runs!.resume(request.context, runs!.authority.authenticate(request.headers, 'connection'), request.params.id!, request.body) }) });
          }, health: () => ({ module: 'wp17-test-job-routes', status: 'ready' }) };
        }] });
        if (input.seed) seedTracking(app.context, program, String(input.capability_id)); value = { identity: app.identity, boot_id: app.boot_id, address: app.address, pid: process.pid };
      } else if (message.command === 'checkpoint') {
        const context: RequestContext = { ...app!.identity, contract_version: CONTRACT_VERSION, request_id: randomUUID(), idempotency_key: String(input.key), request_identity_ref: null };
        const principal = runs!.authority.authenticate({ 'x-host-connection-credential': program!.connection_credential }, 'connection');
        const receipt = runs!.receive(context, principal, String(input.job_id), input.output as unknown as ReceiveOutput);
        if (input.phase !== 'pending_intent') runs!.results.prepare(receipt.receipt_id);
        value = { receipt, checkpoint: String(input.phase), snapshot: snapshot(String(input.job_id)), final_commit_invoked: false };
      } else if (message.command === 'snapshot') value = snapshot(String(input.job_id));
      else if (message.command === 'clock') { now = Number(input.now); runs!.recoverExpired(); runs!.results.recover(); value = { now }; }
      else if (message.command === 'close') { await app!.close(); value = { closed: true }; }
      else throw new Error('Unknown internal child command');
      process.send?.({ id: message.id, ok: true, value }); if (message.command === 'close') process.exit(0);
    } catch (error) { process.send?.({ id: message.id, ok: false, error: error instanceof Error ? error.stack : String(error) }); }
  });
});
