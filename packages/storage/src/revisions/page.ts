import { ContractError } from '@workbench/contracts';
export function decodePageCursor(cursor?: string): [string, string] {
  if (!cursor) return ['', ''];
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 2 || value.some(v => typeof v !== 'string') || !value[0] || !value[1]) throw new Error('invalid cursor');
    return value as [string, string];
  } catch { throw new ContractError('VALIDATION_ERROR', '分页游标无效'); }
}
export function encodePageCursor(row: { created_at: unknown; id: unknown }): string { return Buffer.from(JSON.stringify([row.created_at, row.id])).toString('base64url'); }
