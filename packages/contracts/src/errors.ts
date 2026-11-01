import type { JsonObject } from './common.ts';
export const ERROR_HTTP = {
  VALIDATION_ERROR: 400, NOT_FOUND: 404, REVISION_CONFLICT: 409, VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409, CAPABILITY_UNVERIFIED: 422, CAPABILITY_UNSUPPORTED: 422,
  HOST_RUN_EXPIRED: 409, HOST_RUN_NOT_CURRENT: 409, HOST_OBSERVER_NOT_READY: 409,
  HOST_TASK_BINDING_INVALID: 409, HOST_RUN_OUTPUT_CONFLICT: 409, RESULT_OUTPUT_CONFLICT: 409,
  WORKSPACE_INSTANCE_MISMATCH: 409, ACCOUNT_NOT_CONNECTED: 422, CORE_NOT_CONFIRMED: 422,
  INPUT_STALE: 422, RESULT_UNKNOWN: 409, SCHEDULE_REPLACEMENT_UNSAFE: 409,
  EVALUATION_INPUT_MISMATCH: 422, OBSERVATION_PENDING: 422, AUTH_REQUIRED: 401,
  QUOTA_EXHAUSTED: 429, STORAGE_UNAVAILABLE: 503,
  HOST_OUTPUT_MISSING: 409, HOST_INTERRUPTED: 409, SCHEDULE_ALREADY_RUNNING: 409,
} as const;
export type ErrorCode = keyof typeof ERROR_HTTP;
export interface ApiError { error: { code: ErrorCode; message: string; retryable: boolean; details: JsonObject; request_id: string } }
export class ContractError extends Error {
  readonly code: ErrorCode;
  readonly details: JsonObject;
  readonly retryable: boolean;
  constructor(code: ErrorCode, message: string, details: JsonObject = {}, retryable = false) {
    super(message); this.name = 'ContractError'; this.code = code; this.details = details; this.retryable = retryable;
  }
}
