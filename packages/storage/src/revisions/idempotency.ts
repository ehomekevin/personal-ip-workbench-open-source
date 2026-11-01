import { ContractError, type RequestContext, type JsonValue } from '@workbench/contracts';
import { type DatabaseSync, lookupIdempotency, claimIdempotency, commitIdempotency } from '../connection/index.ts';

export function readIdempotent<T>(db: DatabaseSync, context: RequestContext, operation: string, input: unknown): T | null {
  if (!context.idempotency_key) throw new ContractError('VALIDATION_ERROR', '此写操作需要 Idempotency-Key');
  const row = lookupIdempotency(db, context.workspace_id, operation, context.idempotency_key, input);
  if (!row) return null;
  return row.response === null ? null : row.response as T;
}
export function readCommittedIdempotent<T>(db: DatabaseSync, context: RequestContext, operation: string, input: unknown): T | null {
  if (!context.idempotency_key) throw new ContractError('VALIDATION_ERROR', '此写操作需要 Idempotency-Key');
  const row = lookupIdempotency(db, context.workspace_id, operation, context.idempotency_key, input);
  return row?.state === 'committed' ? row.response as T : null;
}
export function storeIdempotent(db: DatabaseSync, context: RequestContext, operation: string, input: unknown, response: unknown, state = 'committed'): void {
  if (!context.idempotency_key) throw new ContractError('VALIDATION_ERROR', '此写操作需要 Idempotency-Key');
  const row = claimIdempotency(db, context.workspace_id, operation, context.idempotency_key, input);
  if (state === 'committed') commitIdempotency(db, context.workspace_id, row.id, response as JsonValue);
  else db.prepare('UPDATE idempotency_requests SET response=?,state=?,updated_at=? WHERE workspace_id=? AND id=?')
    .run(JSON.stringify(response), state, new Date().toISOString(), context.workspace_id, row.id);
}
