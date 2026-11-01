import { randomUUID } from 'node:crypto';
import { ContractError, type DocumentsRow, type DocumentRevisionsRow, type WriteIntentsRow,
  type RequestContext, type SaveRevisionResponse, type Sha256 } from '@workbench/contracts';
import { type DatabaseSync, sha256, canonicalJson, transaction } from '../connection/index.ts';
import { ManagedFiles, parseRevision, serializeRevision, type RevisionMetadata } from '../files/index.ts';
export { readIdempotent, readCommittedIdempotent, storeIdempotent } from './idempotency.ts';
export { decodePageCursor, encodePageCursor } from './page.ts';

export interface HumanRevisionInput {
  document_id: string; expected_revision_id: string | null; text: string;
  origin?: 'human' | 'restore'; change_kind?: 'text' | 'restore' | 'merge' | 'core_alignment';
  restore_from_revision_id?: string | null; merge_candidate_id?: string | null;
  based_on_core_revision_id?: string | null;
}
export interface RevisionPreparation { write_intent_id: string; document_id: string; revision_id: string; hash: Sha256 }
export function assertContext(db: DatabaseSync, context: RequestContext, workspaceId: string): void {
  if (context.workspace_id !== workspaceId || !db.prepare('SELECT id FROM workspaces WHERE id=?').get(workspaceId))
    throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '请求工作区与主存不匹配');
}
export function getDocumentRow(db: DatabaseSync, workspaceId: string, documentId: string): DocumentsRow {
  const row = db.prepare('SELECT * FROM documents WHERE workspace_id=? AND id=?').get(workspaceId, documentId);
  if (!row) throw new ContractError('NOT_FOUND', '文稿不存在'); return row as unknown as DocumentsRow;
}
export function getRevisionRow(db: DatabaseSync, workspaceId: string, revisionId: string, documentId?: string): DocumentRevisionsRow {
  const row = db.prepare('SELECT * FROM document_revisions WHERE workspace_id=? AND id=?').get(workspaceId, revisionId);
  if (!row || (documentId && row.document_id !== documentId)) throw new ContractError('NOT_FOUND', '修订不属于此文稿');
  return row as unknown as DocumentRevisionsRow;
}
export function assertRevisionExpected(document: DocumentsRow, expected: string | null): void {
  if (document.head_revision_id !== expected) throw new ContractError('REVISION_CONFLICT', '人工正文已有新修订', { current_revision_id: document.head_revision_id });
}
export function assertCoreFreshness(db: DatabaseSync, workspaceId: string, topicId: string, coreRevisionId: string): void {
  const current = db.prepare('SELECT d.head_revision_id FROM topics t JOIN documents d ON d.id=t.core_document_id AND d.workspace_id=t.workspace_id WHERE t.workspace_id=? AND t.id=?').get(workspaceId, topicId);
  if (!current || current.head_revision_id !== coreRevisionId) throw new ContractError('INPUT_STALE', '输入核心稿已过时');
  if (!db.prepare('SELECT id FROM core_approvals WHERE workspace_id=? AND topic_id=? AND revision_id=?').get(workspaceId, topicId, coreRevisionId))
    throw new ContractError('CORE_NOT_CONFIRMED', '当前核心稿尚未确认');
}
// 供 WP-09 在自己的最终事务中调用；这里不生成 job/receipt 或取得 agent 提交权。
export function compareAndSetHeadInTransaction(db: DatabaseSync, workspaceId: string, documentId: string, expected: string | null, revisionId: string): boolean {
  if (!db.isTransaction) throw new Error('head CAS requires the caller final transaction');
  getRevisionRow(db, workspaceId, revisionId, documentId);
  const result = db.prepare('UPDATE documents SET head_revision_id=?,version=version+1,updated_at=? WHERE workspace_id=? AND id=? AND head_revision_id IS ?')
    .run(revisionId, new Date().toISOString(), workspaceId, documentId, expected);
  return Number(result.changes) === 1;
}
export function prepareHumanRevisionInTransaction(db: DatabaseSync, files: ManagedFiles, context: RequestContext, input: HumanRevisionInput): RevisionPreparation {
  if (!db.isTransaction) throw new Error('write_intent preparation requires transaction');
  const document = getDocumentRow(db, context.workspace_id, input.document_id); assertRevisionExpected(document, input.expected_revision_id);
  if (typeof input.text !== 'string') throw new ContractError('VALIDATION_ERROR', '正文必须提供字符串，空正文有效');
  const revisionId = randomUUID(); const intentId = randomUUID();
  const topic = db.prepare('SELECT id FROM topics WHERE workspace_id=? AND core_document_id=?').get(context.workspace_id, document.id);
  const variant = db.prepare('SELECT based_on_core_revision_id,status FROM variants WHERE workspace_id=? AND document_id=?').get(context.workspace_id, document.id);
  const head = document.head_revision_id ? getRevisionRow(db, context.workspace_id, document.head_revision_id, document.id) : null;
  // 尚未绑定核心的初始平台文稿可使用平台行；已有依据或 stale head 必须保留实际修订的依据（包括 null）。
  const inheritedCore = head && (head.based_on_core_revision_id !== null || variant?.status === 'stale')
    ? head.based_on_core_revision_id : variant?.based_on_core_revision_id as string | null ?? null;
  const metadata: RevisionMetadata = { workspace_id: context.workspace_id, document_id: document.id,
    revision_id: revisionId, parent_revision_id: input.expected_revision_id, topic_id: topic ? String(topic.id) : null,
    kind: document.kind, source_ids: [], created_at: new Date().toISOString(), origin: input.origin ?? 'human',
    change_kind: input.change_kind ?? 'text', created_by: context.request_identity_ref ?? 'human',
    based_on_core_revision_id: input.based_on_core_revision_id !== undefined ? input.based_on_core_revision_id : inheritedCore,
    restore_from_revision_id: input.restore_from_revision_id ?? null, merge_candidate_id: input.merge_candidate_id ?? null };
  const content = serializeRevision(metadata, input.text); const contentHash = sha256(content);
  db.prepare('INSERT INTO write_intents (id,workspace_id,document_id,expected_revision_id,planned_revision_id,path,sha256,pending_content,commit_purpose,state) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(intentId, context.workspace_id, document.id, input.expected_revision_id, revisionId, files.revisionPath(document.id, revisionId), contentHash, content, 'human_revision', 'pending');
  return { write_intent_id: intentId, document_id: document.id, revision_id: revisionId, hash: contentHash };
}
export function prepareHumanRevision(db: DatabaseSync, files: ManagedFiles, context: RequestContext, input: HumanRevisionInput): RevisionPreparation {
  return transaction(db, () => prepareHumanRevisionInTransaction(db, files, context, input));
}
export function getIntent(db: DatabaseSync, workspaceId: string, intentId: string): WriteIntentsRow {
  const row = db.prepare('SELECT * FROM write_intents WHERE workspace_id=? AND id=?').get(workspaceId, intentId);
  if (!row) throw new ContractError('NOT_FOUND', '写入意图不存在'); return row as unknown as WriteIntentsRow;
}
// 文件准备共用，提交授权永远由human/agent各自最终事务决定。
export function prepareRevisionFile(db: DatabaseSync, files: ManagedFiles, workspaceId: string, intentId: string): void {
  const intent = getIntent(db, workspaceId, intentId);
  if (intent.state === 'quarantined') throw new ContractError('HOST_RUN_NOT_CURRENT', '隔离写入不能重新准备');
  const registered = { workspace_id: intent.workspace_id, document_id: intent.document_id, revision_id: intent.planned_revision_id };
  if (intent.pending_content === null) { files.readRevision(intent.path, intent.sha256 as Sha256, registered); return; }
  const parsed = parseRevision(intent.pending_content);
  if (parsed.metadata.workspace_id !== intent.workspace_id || parsed.metadata.document_id !== intent.document_id ||
      parsed.metadata.revision_id !== intent.planned_revision_id || parsed.metadata.parent_revision_id !== intent.expected_revision_id)
    throw new ContractError('STORAGE_UNAVAILABLE', '写入意图与文件身份不匹配');
  files.writeUniqueRevision(intent.path, intent.pending_content, intent.sha256 as Sha256, registered);
}
function validateHumanMetadata(db: DatabaseSync, intent: WriteIntentsRow, metadata: RevisionMetadata): void {
  if (intent.commit_purpose !== 'human_revision' || intent.job_id !== null || intent.attempt_id !== null ||
      intent.result_receipt_id !== null || metadata.job_id !== undefined || metadata.attempt_id !== undefined || metadata.attempt_generation !== undefined || metadata.result_receipt_id !== undefined ||
      metadata.origin === 'agent' || !['human', 'restore'].includes(metadata.origin))
    throw new ContractError('VALIDATION_ERROR', 'agent 产物不能进入人工恢复路径');
  if (metadata.workspace_id !== intent.workspace_id || metadata.document_id !== intent.document_id ||
      metadata.revision_id !== intent.planned_revision_id || metadata.parent_revision_id !== intent.expected_revision_id ||
      !['text', 'restore', 'merge', 'core_alignment'].includes(metadata.change_kind) || typeof metadata.created_by !== 'string')
    throw new ContractError('STORAGE_UNAVAILABLE', '人工修订归属无法核对');
  if (metadata.origin === 'restore' || metadata.change_kind === 'restore') {
    if (metadata.origin !== 'restore' || metadata.change_kind !== 'restore' || !metadata.restore_from_revision_id)
      throw new ContractError('VALIDATION_ERROR', '恢复修订来源不完整');
    getRevisionRow(db, intent.workspace_id, metadata.restore_from_revision_id, intent.document_id);
  }
  if (metadata.change_kind === 'merge') {
    const candidate = metadata.merge_candidate_id && db.prepare('SELECT c.id,c.target_document_id,r.state FROM candidates c JOIN result_receipts r ON r.id=c.result_receipt_id AND r.workspace_id=c.workspace_id WHERE c.workspace_id=? AND c.id=?')
      .get(intent.workspace_id, metadata.merge_candidate_id);
    if (!candidate || candidate.target_document_id !== intent.document_id || candidate.state !== 'committed') throw new ContractError('VALIDATION_ERROR', '合并候选来源无法核对');
  }
  if (metadata.based_on_core_revision_id) getRevisionRow(db, intent.workspace_id, metadata.based_on_core_revision_id);
  if (metadata.change_kind === 'core_alignment') {
    const variant = db.prepare('SELECT topic_id FROM variants WHERE workspace_id=? AND document_id=?').get(intent.workspace_id, intent.document_id);
    if (!variant || !metadata.based_on_core_revision_id) throw new ContractError('VALIDATION_ERROR', '核心对齐缺少平台归属');
    assertCoreFreshness(db, intent.workspace_id, String(variant.topic_id), metadata.based_on_core_revision_id);
  }
}
export function commitHumanRevision(db: DatabaseSync, files: ManagedFiles, workspaceId: string, intentId: string): SaveRevisionResponse {
  const intent = getIntent(db, workspaceId, intentId);
  if (intent.commit_purpose !== 'human_revision') throw new ContractError('VALIDATION_ERROR', '人工恢复不能领取 agent 写入意图');
  if (intent.state === 'committed') {
    const revision = getRevisionRow(db, workspaceId, intent.planned_revision_id, intent.document_id);
    const document = getDocumentRow(db, workspaceId, intent.document_id);
    return { document_id: document.id, revision_id: revision.id, write_intent_id: intent.id, version: document.version, hash: revision.sha256 as Sha256, save_state: 'committed' };
  }
  if (intent.state === 'conflict') throw new ContractError('REVISION_CONFLICT', '人工冲突分支已保存', { conflict_revision_id: intent.planned_revision_id });
  if (intent.state !== 'pending') throw new ContractError('STORAGE_UNAVAILABLE', '写入意图不能提交');
  const verified = files.readRevision(intent.path, intent.sha256 as Sha256,
    { workspace_id: intent.workspace_id, document_id: intent.document_id, revision_id: intent.planned_revision_id });
  const parsed = parseRevision(verified.content);
  const result = transaction(db, () => {
    const current = getIntent(db, workspaceId, intentId);
    if (current.state === 'committed') {
      const revision = getRevisionRow(db, workspaceId, current.planned_revision_id, current.document_id);
      return { moved: true, response: { document_id: current.document_id, revision_id: revision.id, write_intent_id: current.id,
        version: getDocumentRow(db, workspaceId, current.document_id).version, hash: revision.sha256 as Sha256, save_state: 'committed' as const } };
    }
    if (current.state !== 'pending') throw new ContractError(current.state === 'conflict' ? 'REVISION_CONFLICT' : 'STORAGE_UNAVAILABLE', '人工写入意图已终结');
    validateHumanMetadata(db, current, parsed.metadata);
    if (sha256(verified.content) !== current.sha256) throw new ContractError('STORAGE_UNAVAILABLE', '人工最终提交文件校验不符');
    const metadata = parsed.metadata;
    db.prepare('INSERT INTO document_revisions (id,workspace_id,document_id,parent_revision_id,file_path,sha256,origin,change_kind,based_on_core_revision_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(current.planned_revision_id, workspaceId, current.document_id, current.expected_revision_id, current.path, current.sha256,
        metadata.origin, metadata.change_kind, metadata.based_on_core_revision_id, metadata.created_by, metadata.created_at, metadata.created_at);
    for (const [type, source] of [['document_revision', metadata.restore_from_revision_id], ['candidate', metadata.merge_candidate_id]] as const) {
      if (source) db.prepare('INSERT INTO evidence_links (id,workspace_id,owner_type,owner_id,source_type,source_id) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), workspaceId, 'document_revision', current.planned_revision_id, type, source);
    }
    const moved = compareAndSetHeadInTransaction(db, workspaceId, current.document_id, current.expected_revision_id, current.planned_revision_id);
    db.prepare('UPDATE write_intents SET state=?,pending_content=NULL,error=?,updated_at=? WHERE workspace_id=? AND id=?')
      .run(moved ? 'committed' : 'conflict', moved ? null : JSON.stringify({ code: 'REVISION_CONFLICT' }), new Date().toISOString(), workspaceId, intentId);
    if (moved) db.prepare("UPDATE variants SET status=CASE WHEN based_on_core_revision_id=? THEN status ELSE 'stale' END,updated_at=? WHERE workspace_id=? AND topic_id IN (SELECT id FROM topics WHERE workspace_id=? AND core_document_id=?)")
      .run(current.planned_revision_id, new Date().toISOString(), workspaceId, workspaceId, current.document_id);
    // 平台 head 的核心依据必须跟随实际修订；恢复旧正文不会自动成为当前核心的 ready 稿。
    if (moved) db.prepare(`UPDATE variants SET based_on_core_revision_id=COALESCE(?,based_on_core_revision_id),
      status=CASE WHEN EXISTS (SELECT 1 FROM topics t JOIN documents d ON d.workspace_id=t.workspace_id AND d.id=t.core_document_id
        JOIN core_approvals a ON a.workspace_id=t.workspace_id AND a.topic_id=t.id AND a.revision_id=d.head_revision_id
        WHERE t.workspace_id=variants.workspace_id AND t.id=variants.topic_id AND d.head_revision_id=?) THEN 'ready' ELSE 'stale' END,
      version=version+1,updated_at=? WHERE workspace_id=? AND document_id=?`)
      .run(metadata.based_on_core_revision_id, metadata.based_on_core_revision_id, new Date().toISOString(), workspaceId, current.document_id);
    const document = getDocumentRow(db, workspaceId, current.document_id);
    const response = { document_id: document.id, revision_id: current.planned_revision_id,
      write_intent_id: intentId, version: document.version, hash: current.sha256 as Sha256, save_state: 'committed' as const };
    if (moved) for (const request of db.prepare("SELECT id,response FROM idempotency_requests WHERE workspace_id=? AND state='pending' AND json_extract(response,'$.write_intent_id')=?").all(workspaceId, intentId)) {
      const pending = JSON.parse(String(request.response));
      const committedResponse = pending.committed_response ? { ...pending.committed_response, version: document.version } : response;
      db.prepare("UPDATE idempotency_requests SET response=?,state='committed',updated_at=? WHERE workspace_id=? AND id=?")
        .run(canonicalJson(committedResponse), new Date().toISOString(), workspaceId, String(request.id));
    }
    return { moved, response };
  });
  if (!result.moved) throw new ContractError('REVISION_CONFLICT', '人工冲突分支已保存，当前稿未覆盖',
    { conflict_revision_id: intent.planned_revision_id, current_revision_id: getDocumentRow(db, workspaceId, intent.document_id).head_revision_id });
  return result.response;
}
export function recoverHumanIntents(db: DatabaseSync, files: ManagedFiles, workspaceId: string): Array<{ intent_id: string; result: string }> {
  const pending = db.prepare("SELECT id FROM write_intents WHERE workspace_id=? AND commit_purpose='human_revision' AND state='pending' ORDER BY created_at,id").all(workspaceId);
  return pending.map(row => {
    const intentId = String(row.id);
    try { prepareRevisionFile(db, files, workspaceId, intentId); commitHumanRevision(db, files, workspaceId, intentId); return { intent_id: intentId, result: 'committed' }; }
    catch (error) {
      if (error instanceof ContractError && error.code === 'REVISION_CONFLICT') return { intent_id: intentId, result: 'conflict' };
      db.prepare('UPDATE write_intents SET error=?,updated_at=? WHERE workspace_id=? AND id=?').run(JSON.stringify({ code: 'STORAGE_UNAVAILABLE', reason: 'needs_repair' }), new Date().toISOString(), workspaceId, intentId);
      return { intent_id: intentId, result: 'needs_repair' };
    }
  });
}
