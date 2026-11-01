import { randomUUID } from 'node:crypto';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter } from '../../packages/adapters/src/agent/codex/index.ts';
import { createServiceAgentHandlers } from '../../apps/service/src/worker/handlers/agent/index.ts';
import type { AgentRunHandle } from '../../packages/contracts/src/index.ts';
import { fixture, projectRoot, schemaDirectory } from './harness.ts';
import { sourceSnapshot } from './source-snapshot.ts';
const out = join(projectRoot, '.ci-artifacts/evidence/wp-15/native-event-traces', `worker-cancel-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`); mkdirSync(out, { recursive: true });
const f = fixture(), abort = new AbortController(); let adapter: CodexAdapter | undefined; let handle: AgentRunHandle | undefined; let scheduled = false; const trace: unknown[] = [];
const summary: Record<string, unknown> = { at: new Date().toISOString(), grade: 'real_provider', source_snapshot: sourceSnapshot(), billing_amount: null, model: 'gpt-6.1-sol', effort: 'xhigh' };
try {
 const j = f.enqueue('codex', 'Prove that every odd square is congruent to one modulo eight; give one short sentence.'); const claim = f.jobs.claim('worker:real-cancel-probe')!;
 const handler = createServiceAgentHandlers(f.context, { staging_root: f.staging, createAdapter: plan => adapter = new CodexAdapter({ workspace_id: f.context.identity.workspace_id, cwd: plan.cwd, lock_root: join(out, 'locks'), schema_directory: schemaDirectory, sink: entry => { trace.push(entry); appendFileSync(join(out, 'codex-events.jsonl'), JSON.stringify(entry)+'\n'); } }) })[0];
 try { await handler.execute({ claim, signal: abort.signal, checkpoint: value => { f.jobs.checkpoint(claim.fence, value); handle = value.agent_handle as unknown as AgentRunHandle; if (!scheduled) { scheduled = true; setTimeout(() => { const current = f.jobs.get(f.request(), j.id).job; summary.logical_cancel = f.jobs.cancel(f.request(), j.id, { expected_version: current.version }); abort.abort(); }, 0); } } }); }
 catch (error) { summary.handler_terminal = { code: (error as { code?: string }).code ?? null, message: (error as Error).message }; }
 summary.detail = f.jobs.get(f.request(), j.id); summary.events = f.jobs.events(f.request(), j.id).events; summary.candidate_count = f.context.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE job_id=?').get(j.id)!.n; summary.receipt_count = f.context.db.prepare('SELECT COUNT(*) AS n FROM result_receipts WHERE job_id=?').get(j.id)!.n;
 const interrupted = trace.some((entry: any) => entry.direction === 'receive' && entry.message?.method === 'turn/completed' && entry.message.params?.turn?.status === 'interrupted'); const detail = summary.detail as { job: { state: string } }; summary.status = detail.job.state === 'cancelled' && interrupted && summary.candidate_count === 0 ? 'passed' : 'failed'; summary.native_interrupted = interrupted;
} catch (error) { summary.status = 'failed'; summary.error = { code: (error as { code?: string }).code ?? null, message: (error as Error).message }; }
finally { await adapter?.close(); if (handle && adapter) { try { await adapter.deleteSession(handle); summary.cleanup = 'created_probe_session_deleted'; } catch (error) { summary.cleanup = { status: 'unverified', message: (error as Error).message }; } } f.cleanup(); writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2)+'\n'); }
process.stdout.write(JSON.stringify({ out, status: summary.status, native_interrupted: summary.native_interrupted, candidate_count: summary.candidate_count, receipt_count: summary.receipt_count, handler_terminal: summary.handler_terminal })+'\n');
