import { ContractError } from '@workbench/contracts';
import { canonical, hash, type WorkspaceSlot } from '../../agent/codex/primitives.ts';
import type { LayoutCheckExecution, LayoutCheckOptions, LayoutNativeClient } from './types.ts';

export interface LayoutCheckSession {
  readonly native: LayoutNativeClient;
  readonly slot?: WorkspaceSlot;
  readonly identity: string;
  readonly attempt_id: string;
  readonly workspace_id: string;
  readonly job_id: string;
  thread_id: string | null;
  turn_id: string | null;
  readonly stop_controller: AbortController;
  initialized: boolean;
  carries_submission: boolean;
  active: boolean;
  terminal: boolean;
  poisoned: boolean;
  detached: () => void;
  closing?: Promise<void>;
}
const mismatch = () => new ContractError('RESULT_UNKNOWN', '原生会话与原 workspace/job/attempt/candidate/input 身份不符，未发出请求');
const identity = (execution: LayoutCheckExecution, options: LayoutCheckOptions): string => hash(canonical({
  workspace_id: options.workspace_id, cwd: options.cwd, fixture: execution.fixture, candidate: execution.candidate_sha256,
  id: execution.attempt.id, job_id: execution.attempt.job_id, attempt_id: execution.attempt.attempt_id,
  input: execution.attempt.input_manifest_sha256, native_input: execution.proof.native_input_sha256,
}));
/** One workflow owns the raw transports. Observation leases never own or capture a transport's request guard. */
export class LayoutCheckSessions {
  private readonly sessions = new Map<string, LayoutCheckSession>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private closing = false;
  get size(): number { return this.sessions.size; }
  async exclusive<T>(attemptId: string, action: () => Promise<T>): Promise<T> {
    const prior = this.operations.get(attemptId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => {
      if (this.closing) throw new ContractError('RESULT_UNKNOWN', '排版原生会话已关闭');
      return action();
    });
    this.operations.set(attemptId, next);
    try { return await next; } finally { if (this.operations.get(attemptId) === next) this.operations.delete(attemptId); }
  }
  assertCompatible(execution: LayoutCheckExecution, options: LayoutCheckOptions): void {
    const prior = this.sessions.get(execution.attempt.attempt_id);
    if (prior && (prior.identity !== identity(execution, options) || prior.thread_id && prior.thread_id !== execution.attempt.native.thread_id || prior.turn_id && prior.turn_id !== execution.attempt.native.turn_id)) throw mismatch();
  }
  take(execution: LayoutCheckExecution, options: LayoutCheckOptions, open: () => {native: LayoutNativeClient; slot?: WorkspaceSlot}): LayoutCheckSession {
    if (this.closing) throw new ContractError('RESULT_UNKNOWN', '排版原生会话已关闭');
    const key = execution.attempt.attempt_id, prior = this.sessions.get(key);
    if (prior) {
      if (prior.identity !== identity(execution, options) || prior.closing || prior.poisoned || prior.active) throw mismatch();
      this.bind(prior, execution); prior.active = true; return prior;
    }
    const client = open(), session: LayoutCheckSession = {...client, identity: identity(execution, options), attempt_id: key,
      workspace_id: options.workspace_id, job_id: execution.attempt.job_id, thread_id: execution.attempt.native.thread_id,
      turn_id: execution.attempt.native.turn_id, stop_controller: new AbortController(), initialized: false, carries_submission: false, active: true, terminal: false, poisoned: false, detached: () => {}};
    this.sessions.set(key, session);
    session.detached = session.native.observe(message => {
      if (message.id !== undefined && message.method) {
        try { session.native.deny(message.id); } catch { /* Poisoned transports are still reclaimed. */ }
        session.poisoned = true; if (!session.stop_controller.signal.aborted) void this.stop(session); return;
      }
      if (message.method === '$transport/error') { session.poisoned = true; if (!session.stop_controller.signal.aborted) void this.stop(session); return; }
      const p = message.params;
      if (message.method === 'turn/completed' && p?.threadId === session.thread_id && p.turn && typeof p.turn === 'object' &&
          'id' in p.turn && typeof p.turn.id === 'string' && session.carries_submission && (session.turn_id === null || p.turn.id === session.turn_id)) {
        session.terminal = true;
        // A terminal notification is a cleanup hint, never proof for a journal/result write.
        if (!session.active && !session.stop_controller.signal.aborted) void this.stop(session);
      }
    });
    return session;
  }
  bind(session: LayoutCheckSession, execution: LayoutCheckExecution): void {
    const id = execution.attempt.native;
    if (session.thread_id && id.thread_id !== session.thread_id || session.turn_id && id.turn_id !== session.turn_id) throw mismatch();
    session.thread_id = id.thread_id; session.turn_id = id.turn_id;
  }
  markSubmission(session: LayoutCheckSession): void {
    if (this.sessions.get(session.attempt_id) !== session || session.closing) throw mismatch();
    session.carries_submission = true;
  }
  async release(session: LayoutCheckSession, retain: boolean): Promise<void> {
    session.active = false;
    if (!retain || !session.carries_submission || session.terminal || session.poisoned || this.closing) await this.stop(session);
  }
  private stop(session: LayoutCheckSession): Promise<void> {
    if (session.closing) return session.closing;
    // Assign before calling native.close(): synchronous exit callbacks cannot begin a second close.
    session.stop_controller.abort(new Error('LAYOUT_NATIVE_SESSION_CLOSED'));
    const stopped = Promise.resolve().then(async () => {
      try { await session.native.close(); }
      catch (error) { session.closing = undefined; throw error; }
      session.detached();
      // Native.close resolves only after actual child exit. Never release a live child's workspace slot.
      session.slot?.childExited(); session.slot?.();
      if (this.sessions.get(session.attempt_id) === session) this.sessions.delete(session.attempt_id);
    });
    session.closing = stopped;
    void stopped.catch(() => {});
    return stopped;
  }
  async cancel(workspace: string, job: string): Promise<void> {
    await Promise.all([...this.sessions.values()].filter(s => s.workspace_id === workspace && s.job_id === job).map(s => this.stop(s)));
  }
  beginClose(): void { this.closing = true; for (const session of this.sessions.values()) void this.stop(session); }
  async close(): Promise<void> { this.beginClose(); await Promise.all([...this.sessions.values()].map(session => this.stop(session))); }
}
