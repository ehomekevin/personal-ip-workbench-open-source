import { randomUUID } from 'node:crypto';
import { ContractError, type JsonObject, type WorksRow, type Platform } from '@workbench/contracts';
import { type DatabaseSync, transaction } from '../connection/index.ts';

export function getWork(db: DatabaseSync, workspaceId: string, workId: string): WorksRow {
  const row = db.prepare('SELECT * FROM works WHERE workspace_id=? AND id=?').get(workspaceId, workId);
  if (!row) throw new ContractError('NOT_FOUND', '作品不存在'); return row as unknown as WorksRow;
}
export function canonicalWorkId(db: DatabaseSync, workspaceId: string, workId: string): string {
  const source = getWork(db, workspaceId, workId);
  if (source.canonical_work_id === null) return source.id;
  const canonical = getWork(db, workspaceId, source.canonical_work_id);
  if (canonical.canonical_work_id !== null || canonical.platform !== source.platform) throw new ContractError('VALIDATION_ERROR', '作品 alias 归属无效');
  return canonical.id;
}
export interface VerifiedWorkIdentity { platform_work_id: string; account_id: string | null; evidence: JsonObject }
export function resolveVerifiedWorkIdentity(db: DatabaseSync, workspaceId: string, workId: string, identity: VerifiedWorkIdentity): { work_id: string; canonical_work_id: string; alias: boolean } {
  return transaction(db, () => resolveVerifiedWorkIdentityInTransaction(db, workspaceId, workId, identity));
}
export function resolveVerifiedWorkIdentityInTransaction(db: DatabaseSync, workspaceId: string, workId: string, identity: VerifiedWorkIdentity): { work_id: string; canonical_work_id: string; alias: boolean } {
  if (!db.isTransaction) throw new Error('Verified identity requires a domain transaction');
  if (!identity.platform_work_id || !identity.evidence || !Object.keys(identity.evidence).length) throw new ContractError('VALIDATION_ERROR', '身份核对必须有实际平台标识和出处');
    const work = getWork(db, workspaceId, workId);
    if ((work.platform_work_id !== null && work.platform_work_id !== identity.platform_work_id) ||
        (work.account_id !== null && identity.account_id !== null && work.account_id !== identity.account_id))
      throw new ContractError('VALIDATION_ERROR', '已登记作品或作者身份冲突，不能自动改写');
    if (work.canonical_work_id) return { work_id: workId, canonical_work_id: canonicalWorkId(db, workspaceId, workId), alias: true };
    if (identity.account_id !== null) {
      const account = db.prepare('SELECT platform,identity_status FROM accounts WHERE workspace_id=? AND id=?').get(workspaceId, identity.account_id);
      if (!account || account.platform !== work.platform || account.identity_status !== 'confirmed') throw new ContractError('VALIDATION_ERROR', '作者身份尚未核对或平台不符');
    }
    const canonical = db.prepare('SELECT * FROM works WHERE workspace_id=? AND platform=? AND platform_work_id=? AND canonical_work_id IS NULL').get(workspaceId, work.platform, identity.platform_work_id);
    const accountId = identity.account_id ?? work.account_id;
    if (canonical && canonical.id !== workId) {
      if (canonical.account_id !== null && accountId !== null && canonical.account_id !== accountId) throw new ContractError('VALIDATION_ERROR', '不同作者身份冲突，不能自动合并');
      if (db.prepare('SELECT id FROM works WHERE workspace_id=? AND canonical_work_id=?').get(workspaceId, workId)) throw new ContractError('VALIDATION_ERROR', '有alias的规范记录不能直接改为alias');
      db.prepare("UPDATE works SET platform_work_id=?,account_id=?,identity_status='alias',canonical_work_id=?,updated_at=? WHERE workspace_id=? AND id=?")
        .run(identity.platform_work_id, accountId, canonical.id, new Date().toISOString(), workspaceId, workId);
      db.prepare('INSERT INTO work_aliases (id,workspace_id,alias_work_id,canonical_work_id,source_url,resolution_evidence) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), workspaceId, workId, canonical.id, work.url, JSON.stringify(identity.evidence));
      return { work_id: workId, canonical_work_id: String(canonical.id), alias: true };
    }
    db.prepare('UPDATE works SET platform_work_id=?,account_id=?,identity_status=?,updated_at=? WHERE workspace_id=? AND id=?')
      .run(identity.platform_work_id, accountId, accountId === null ? 'pending' : 'confirmed', new Date().toISOString(), workspaceId, workId);
    db.prepare('INSERT INTO evidence_links (id,workspace_id,owner_type,owner_id,source_type,source_id,locator) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), workspaceId, 'work', workId, 'identity_observation', workId,
        JSON.stringify({ platform_work_id: identity.platform_work_id, evidence: identity.evidence }));
    return { work_id: workId, canonical_work_id: workId, alias: false };
}

export function canonicalWorks(db: DatabaseSync, workspaceId: string, platform?: Platform): WorksRow[] {
  return db.prepare('SELECT * FROM works WHERE workspace_id=? AND canonical_work_id IS NULL AND (? IS NULL OR platform=?) ORDER BY created_at,id').all(workspaceId, platform ?? null, platform ?? null) as unknown as WorksRow[];
}
