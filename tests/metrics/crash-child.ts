import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_VERSION, type ServiceConfiguration, type RequestContext } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage } from '../../packages/storage/src/connection/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';
import { Metrics } from '../../packages/domain/src/metrics/index.ts';
import { adapter, target } from './harness.ts';

const { config, work } = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as { config: ServiceConfiguration; work: Parameters<typeof target>[0] };
const storage = openWorkspaceStorage(join(config.paths.state_root, 'workbench.sqlite'));
const identity = { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION }, context: ApplicationContext = { db: storage.db, identity, config, paths: config.paths, getExecutorHealth: async () => [] };
const metrics = new Metrics(context, { adapter: adapter([target(work)], async () => new Response(JSON.stringify({ data: { like_count: 5 } }))) });
const request: RequestContext = { ...identity, request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), request_identity_ref: 'wp12-kill-fixture' }, job = metrics.collectWork(request, work.work_id, {}), claim = metrics.jobs.claim('crash-child')!;
try { await metrics.executeCollection({ claim, signal: new AbortController().signal, checkpoint(value) { metrics.jobs.checkpoint(claim.fence, value); if (value.response) { process.send?.({ kind: 'durable_response', job_id: job.job_id, checkpoint: value }); throw new Error('pause-before-commit'); } } }); }
catch (error) { if (!(error instanceof Error) || error.message !== 'pause-before-commit') { process.send?.({ kind: 'failure', error: 'crash fixture did not reach checkpoint' }); process.exit(1); } }
setInterval(() => {}, 1000);
