import { ContractError, type ResultReceiptsRow, type WriteIntentsRow } from '@workbench/contracts';
import { type DatabaseSync, canonicalJson } from '../connection/index.ts';

export function getReceipt(db: DatabaseSync, workspaceId: string, receiptId: string): ResultReceiptsRow {
  const row = db.prepare('SELECT * FROM result_receipts WHERE workspace_id=? AND id=?').get(workspaceId, receiptId);
  if (!row) throw new ContractError('NOT_FOUND', '结果收据不存在'); return row as unknown as ResultReceiptsRow;
}
export function receiptForAttempt(db: DatabaseSync, workspaceId: string, jobId: string, attemptId: string, generation: number): ResultReceiptsRow | null {
  return db.prepare('SELECT * FROM result_receipts WHERE workspace_id=? AND job_id=? AND attempt_id=? AND attempt_generation=?').get(workspaceId, jobId, attemptId, generation) as unknown as ResultReceiptsRow | undefined ?? null;
}
export function receiptIntents(db: DatabaseSync, workspaceId: string, receiptId: string): WriteIntentsRow[] {
  return db.prepare('SELECT * FROM write_intents WHERE workspace_id=? AND result_receipt_id=? ORDER BY document_id,id').all(workspaceId, receiptId) as unknown as WriteIntentsRow[];
}
export function quarantineReceiptInTransaction(db: DatabaseSync, workspaceId: string, receiptId: string, reason: string, now: number): void {
  if (!db.isTransaction) throw new Error('receipt quarantine requires final transaction');
  const receipt = getReceipt(db, workspaceId, receiptId); if (receipt.state !== 'pending') return;
  const at = new Date(now).toISOString();
  db.prepare("UPDATE result_receipts SET state='quarantined',quarantine_reason=?,updated_at=? WHERE workspace_id=? AND id=?").run(reason, at, workspaceId, receiptId);
  db.prepare("UPDATE write_intents SET state='quarantined',error=?,updated_at=? WHERE workspace_id=? AND result_receipt_id=? AND state='pending'").run(canonicalJson({ code: reason }), at, workspaceId, receiptId);
}
