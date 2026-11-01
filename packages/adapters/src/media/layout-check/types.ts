import type { LayoutCheckAttempt, LayoutCheckResult, LayoutVisualInput } from '../../../../contracts/src/article-layout.ts';
export type { LayoutRenderSlice, LayoutRenderedBlock, LayoutVisualInput } from '../../../../contracts/src/article-layout.ts';
import type { NativeMessage } from '../../agent/codex/native.ts';
import type { JsonObject } from '@workbench/contracts';
import type { LayoutCheckSessions } from './sessions.ts';

/** Private original-read evidence, never a browser DTO or a substitute result/receipt. */
export interface LayoutCheckTerminalEvidence {
  schema_version: 'article-layout-terminal-read.v1';
  raw_read: JsonObject; raw_read_sha256: string;
  status: 'failed' | 'interrupted'; thread_id: string; turn_id: string; expected_cwd: string;
  candidate_sha256: string | null; input_manifest_sha256: string; native_input_sha256: string;
}

export interface LayoutNativeProof {
  source: 'codex_app_server' | 'fixture'; runtime_version: string | null;
  input_channel: 'localImage'; submitted_local_images: Array<{ path: string; sha256: string; purpose: 'article_render' | 'standard' }>;
  native_input_sha256: string; output_sha256: string | null; original_input_verified: boolean;
  thread_start?: { thread_id: string; model: string; model_provider: string; cwd: string } | null;
  terminal_read?: LayoutCheckTerminalEvidence;
  usage: JsonObject | null; billing_route: 'chatgpt_subscription' | 'fixture'; billing_amount: number | null;
}
/** Persist this before dispatch. reserve must atomically refuse an existing attempt/job reservation. */
export interface LayoutCheckExecution {
  schema_version: 'article-layout-check-execution.v1'; fixture: boolean; candidate_sha256: string | null;
  attempt: LayoutCheckAttempt; input_manifest: LayoutVisualInput; proof: LayoutNativeProof;
  submit_count: 0 | 1; no_automatic_retry: true;
}
export interface LayoutCheckJournal {
  reserve(execution: LayoutCheckExecution): Promise<boolean>;
  load(attempt_id: string): Promise<LayoutCheckExecution | null>;
  save(execution: LayoutCheckExecution): Promise<void>;
}
export interface LayoutNativeClient {
  readonly version: string;
  initialize(): Promise<void>;
  request(method: string, params: Record<string, unknown>, timeout?: number): Promise<unknown>;
  observe(listener: (message: NativeMessage) => void): () => void;
  deny(id: string | number): void;
  close(): Promise<void>;
}
export interface LayoutCheckPermit {
  candidate_sha256: string; authorized_job_ids: readonly string[];
  /** Durable budget reservation shared by the two authorized cases; no new or duplicate reservation on recovery. */
  reserve_submission(job_id: string, attempt_id: string, manifest_sha256: string): Promise<boolean>;
}
/** New intents are admitted durably per job; legacy two-case permits remain query compatible. */
export interface LayoutCheckPermitV2 {
  version: 'v2'; candidate_sha256: string;
  authorize_job(job_id: string): boolean;
  reserve_submission(job_id: string, attempt_id: string, manifest_sha256: string): Promise<boolean>;
}
export interface LayoutCheckOptions {
  workspace_id: string; cwd: string; lock_root: string; schema_directory: string;
  journal: LayoutCheckJournal; fixture: boolean;
  permit?: LayoutCheckPermit | LayoutCheckPermitV2;
  /** Server-owned current snapshot/context/lease fence, checked before native acquisition and requests. */
  is_current?: () => boolean;
  /** Layout-local owner of an in-progress transport beyond one observation window. */
  session_owner?: LayoutCheckSessions;
  /** Current SQL fence for diagnostic persistence only; requests/results still require is_current. */
  is_fence_current?: () => boolean;
  native_factory?: () => LayoutNativeClient;
  executable?: string; timeout_ms?: number;
}
export interface LayoutCheckIdentity { id: string; job_id: string; attempt_id: string }
export interface LayoutCheckObservation { execution: LayoutCheckExecution; result: LayoutCheckResult | null }
