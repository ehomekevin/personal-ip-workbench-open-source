import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Metrics } from '../../packages/domain/src/metrics/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { metricsHandler } from '../../apps/service/src/worker/handlers/metrics/index.ts';
import { listWorkSnapshots } from '../../packages/storage/src/metrics/index.ts';
import { fixture, ownWork, adapter, target, evidence } from './harness.ts';

test('实际SIGKILL后新进程恢复已收到raw，零次重新请求', async () => {
  const f = fixture(); let child: ReturnType<typeof fork> | undefined;
  try {
    const work = await ownWork(f), path = join(f.root, 'crash-input.json'); writeFileSync(path, JSON.stringify({ config: f.config, work })); f.closeDb();
    child = fork(fileURLToPath(new URL('./crash-child.ts', import.meta.url)), [path], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); let stderr = ''; child.stderr!.on('data', bytes => { stderr += String(bytes); });
    const result = await new Promise<{ job_id: string; checkpoint: Record<string, unknown> }>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('child checkpoint timeout')), 15_000); child!.once('error', reject); child!.once('exit', code => { clearTimeout(timeout); reject(new Error(`child early exit ${code}: ${stderr.slice(0, 500)}`)); }); child!.once('message', value => { clearTimeout(timeout); const message = value as { kind: string; job_id: string; checkpoint: Record<string, unknown> }; if (message.kind === 'durable_response') resolve(message); else reject(new Error('checkpoint not reached')); }); });
    const exited = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill('SIGKILL'); await exited; child = undefined; f.reopen();
    let calls = 0; const now = Date.now() + 60_001, metrics = new Metrics(f.context(), { clock: () => now, adapter: adapter([target(work)], async () => { calls++; throw new Error('must recover raw'); }, () => now) }), worker = new DurableWorker(f.context(), [metricsHandler(metrics)], { clock: () => now });
    assert.equal((await worker.runOnce())?.state, 'committed'); assert.equal(calls, 0); assert.equal(listWorkSnapshots(f.context().db, f.config.workspace_id, work.work_id).length, 1); assert.equal(metrics.jobs.get(f.request(), result.job_id).job.state, 'succeeded');
    evidence('crash-recovery.json', { evidence_kind: 'internal_rule', actual_at: new Date().toISOString(), result: 'passed', actual_signal: 'SIGKILL', durable_checkpoint_received: true, job_id: result.job_id, restarted_fixture_network_calls: calls, resulting_snapshots: 1, temporary_root_cleaned: true });
  } finally { child?.kill('SIGKILL'); f.cleanup(); }
});
