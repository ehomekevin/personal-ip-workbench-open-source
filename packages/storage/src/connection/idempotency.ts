import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ContractError, type JsonValue, type RequestHash } from '@workbench/contracts';
import { canonicalJson, requestHash } from './index.ts';
export interface IdempotencyEntry { id: string; operation: string; key: string; request_hash: RequestHash; state: string; response: JsonValue | null }
function asEntry(row: Record<string, unknown>): IdempotencyEntry { return { id: String(row.id), operation: String(row.operation), key: String(row.key), request_hash: String(row.request_hash) as RequestHash, state: String(row.state), response: row.response === null ? null : JSON.parse(String(row.response)) as JsonValue }; }
export function lookupIdempotency(db: DatabaseSync, workspaceId: string, operation: string, key: string, body: unknown): IdempotencyEntry | null {
  const row = db.prepare('SELECT * FROM idempotency_requests WHERE workspace_id=? AND key=?').get(workspaceId, key);
  if (!row) return null;
  const hash = requestHash({ workspace_id: workspaceId, operation, body });
  if (row.operation !== operation || row.request_hash !== hash) throw new ContractError('IDEMPOTENCY_CONFLICT', '相同 key 对应不同请求');
  return asEntry(row);
}
// 调用者在同一领域事务创建 intent / 目标；不能跨异步文件 I/O 持有事务。
export function claimIdempotency(db: DatabaseSync, workspaceId: string, operation: string, key: string, body: unknown): IdempotencyEntry {
  if (!db.isTransaction) throw new Error('Idempotency claim requires an active domain transaction');
  if (!key || key.length > 200) throw new ContractError('VALIDATION_ERROR', '缺少有效 Idempotency-Key');
  const existing = lookupIdempotency(db, workspaceId, operation, key, body); if (existing) return existing;
  const id = randomUUID(); const hash = requestHash({ workspace_id: workspaceId, operation, body });
  db.prepare('INSERT INTO idempotency_requests(id,workspace_id,operation,key,request_hash,response,state) VALUES (?,?,?,?,?,NULL,?)').run(id, workspaceId, operation, key, hash, 'pending');
  return { id, operation, key, request_hash: hash, state: 'pending', response: null };
}
export function commitIdempotency(db: DatabaseSync, workspaceId: string, id: string, response: JsonValue): void {
  if (!db.isTransaction) throw new Error('Idempotency commit requires the final domain transaction');
  const row = db.prepare('SELECT * FROM idempotency_requests WHERE workspace_id=? AND id=?').get(workspaceId, id);
  if (!row) throw new ContractError('NOT_FOUND', '幂等请求不存在');
  const encoded = canonicalJson(response);
  if (row.state === 'committed') { if (row.response !== encoded) throw new ContractError('IDEMPOTENCY_CONFLICT', '已提交请求的结果不一致'); return; }
  db.prepare("UPDATE idempotency_requests SET response=?,state='committed',updated_at=? WHERE workspace_id=? AND id=?").run(encoded, new Date().toISOString(), workspaceId, id);
}
