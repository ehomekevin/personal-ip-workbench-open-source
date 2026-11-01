import { randomUUID } from 'node:crypto';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodexAdapter } from '../../packages/adapters/src/agent/codex/index.ts';
import { ClaudeAdapter } from '../../packages/adapters/src/agent/claude/index.ts';
import { canonical, hash, redact } from '../../packages/adapters/src/agent/codex/primitives.ts';
import { createServiceAgentHandlers } from '../../apps/service/src/worker/handlers/agent/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import type { AgentRunInput, AgentRunHandle, AgentResult } from '../../packages/contracts/src/index.ts';
import { fixture, projectRoot, schemaDirectory } from './harness.ts';
import { sourceSnapshot } from './source-snapshot.ts';

const out = resolve(process.argv[2] ?? join(projectRoot, '.ci-artifacts/evidence/wp-15/native-event-traces', `live-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`)); mkdirSync(out, { recursive: true });
const summary: Record<string, unknown> = { at: new Date().toISOString(), grade: 'real_provider', source_snapshot: sourceSnapshot(), model: 'gpt-6.1-sol', effort: 'xhigh', billing_amount: null, codex: {}, claude: {}, outputs: [] };
const sink = (label: string) => (entry: unknown) => appendFileSync(join(out, `${label}.jsonl`), JSON.stringify(redact(entry)) + '\n', { mode: 0o600 });
const options = { workspace_id: randomUUID(), cwd: out, lock_root: join(out, 'locks'), schema_directory: schemaDirectory, sink: sink('codex'), timeout_ms: 120_000 };
const codex = new CodexAdapter(options); let resumed: CodexAdapter | undefined; const handles: AgentRunHandle[] = []; const f = fixture();
async function collect(adapter: CodexAdapter, handle: AgentRunHandle) { const events = []; for await (const event of adapter.streamEvents(handle)) events.push(event); return events; }
try {
  const readiness = await codex.checkReadiness(); summary.codex = { readiness, billing_route: readiness.billing_route, status: 'running' };
  const j = f.enqueue(); const worker = new DurableWorker(f.context, createServiceAgentHandlers(f.context, { staging_root: f.staging, createAdapter: plan => new CodexAdapter({ ...options, workspace_id: f.context.identity.workspace_id, cwd: plan.cwd, sink: sink('codex-worker') }) }));
  const result = await worker.runOnce(); const attempts = f.context.db.prepare('SELECT * FROM job_attempts WHERE job_id=?').all(j.id); const receipts = f.context.db.prepare('SELECT * FROM result_receipts WHERE job_id=?').all(j.id); const intents = f.context.db.prepare('SELECT * FROM write_intents WHERE job_id=?').all(j.id).map(row => ({ ...row, actual_sha256: hash(readFileSync(String(row.path))) }));
  for (const attempt of attempts) if (typeof attempt.runtime_session_id === 'string') handles.push({ runtime_session_id: attempt.runtime_session_id, supports_resume: true, checkpoint: {} });
  const manifest = { grade: 'real_provider', job: f.jobs.get(f.request(), j.id).job, result, attempts, receipts, intents, candidates: f.context.db.prepare('SELECT * FROM candidates WHERE job_id=?').all(j.id), events: f.jobs.events(f.request(), j.id).events, head: f.context.db.prepare('SELECT head_revision_id FROM documents WHERE id=?').get(f.document) };
  writeFileSync(join(out, 'worker-actual-output-manifest.json'), JSON.stringify(redact(manifest), null, 2) + '\n'); summary.worker = { state: result?.state, receipt_state: receipts[0]?.state, attempts: attempts.map(row => ({ runtime_session_id: row.runtime_session_id, runtime_turn_id: row.runtime_turn_id })), evidence: 'worker-actual-output-manifest.json' };
  if (result?.state !== 'committed') throw new Error('real worker did not commit candidate receipt');
  const input: AgentRunInput = { job_id: randomUUID(), kind: 'document_modify', task_instruction: 'Prove that every odd square is congruent to 1 modulo 8. Return the proof in one short sentence as answer.', target_document_id: null, base_revision_id: null, input_manifest: { schema_version: 'wp15-live-v1', source: 'small_math_text_probe' }, allowed_tools: [], output_schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } };
  const handle = await codex.start(input); handles.push(handle); writeFileSync(join(out, 'persisted-checkpoint.json'), JSON.stringify(handle, null, 2) + '\n'); const ack = await codex.cancel(handle);
  let cancelError: unknown; try { await collect(codex, handle); } catch (error) { cancelError = { code: (error as { code?: string }).code ?? null, message: (error as Error).message }; }
  summary.cancel = { ack, terminal: cancelError, session_id: handle.runtime_session_id, turn_id: handle.runtime_turn_id, logical_fence: 'internal_rule worker cancellation test separately; direct provider probe has no business submission authority' }; await codex.close();
  if ((cancelError as { code?: string })?.code !== 'HOST_INTERRUPTED') throw new Error('native interruption not confirmed');
  resumed = new CodexAdapter({ ...options, sink: sink('codex-resume') }); const persisted = JSON.parse(readFileSync(join(out, 'persisted-checkpoint.json'), 'utf8')) as AgentRunHandle; const next = await resumed.resume(persisted, {}); handles.push(next); const events = await collect(resumed, next); const output = events.find(event => 'status' in event) as AgentResult | undefined;
  const resumeManifest = { grade: 'real_provider', previous: persisted, resumed: next, same_session: persisted.runtime_session_id === next.runtime_session_id, new_turn: persisted.runtime_turn_id !== next.runtime_turn_id, output, events };
  writeFileSync(join(out, 'resume-actual-output-manifest.json'), JSON.stringify(redact(resumeManifest), null, 2) + '\n'); summary.resume = { same_session: resumeManifest.same_session, new_turn: resumeManifest.new_turn, session_id: next.runtime_session_id, turn_id: next.runtime_turn_id, status: output?.status ?? 'missing', output_sha256: output?.resume_info.output_sha256 ?? null, actual_usage: output?.actual_usage ?? null, evidence: 'resume-actual-output-manifest.json' };
  summary.codex = { ...(summary.codex as object), status: 'passed' };
} catch (error) { summary.codex = { ...(summary.codex as object), status: 'failed', error: { code: (error as { code?: string }).code ?? null, message: (error as Error).message, details: (error as { details?: unknown }).details ?? null } }; }
finally { await codex.close(); await resumed?.close(); f.cleanup(); const ids = new Set<string>(); const cleanup = []; for (const handle of handles) { if (ids.has(handle.runtime_session_id)) continue; ids.add(handle.runtime_session_id); try { await codex.deleteSession(handle); cleanup.push({ session_id: handle.runtime_session_id, status: 'created_probe_session_deleted' }); } catch (error) { cleanup.push({ session_id: handle.runtime_session_id, status: 'unverified', message: (error as Error).message }); } } summary.cleanup = cleanup; }
const claude = new ClaudeAdapter({ workspace_id: randomUUID(), cwd: out, lock_root: join(out, 'locks'), sink: sink('claude-readiness') });
try { summary.claude = { readiness: await claude.checkReadiness(), status: 'readiness_only', real_provider: 'not_run; separate candidate route requires live model readiness and actual protocol validation' }; } catch (error) { summary.claude = { status: 'blocked', code: (error as { code?: string }).code ?? null, message: (error as Error).message, details: (error as { details?: unknown }).details ?? null, real_provider: 'not_run', actual_usage: null, billing_amount: null }; } finally { await claude.close(); }
writeFileSync(join(out, 'summary.json'), JSON.stringify(redact(summary), null, 2) + '\n'); process.stdout.write(JSON.stringify({ out, codex: summary.codex, worker: summary.worker, cancel: summary.cancel, resume: summary.resume, claude: summary.claude }, null, 2) + '\n');
