import { randomUUID } from 'node:crypto';
import { ContractError, SaveRevisionSchema, type CandidatesRow, type CreateDocumentRequest,
  type DocumentSnapshot, type DocumentRevisionsRow, type RequestContext, type SaveRevisionRequest,
  type SaveRevisionResponse, type ExpectedRevision, type Page, type JsonObject } from '@workbench/contracts';
import { transaction } from '@workbench/storage/connection';
import { ManagedFiles, parseRevision } from '@workbench/storage/files';
import { workspaceSettings } from '@workbench/storage/settings';
import { getDocumentRow, getRevisionRow, assertRevisionExpected, assertCoreFreshness,
  compareAndSetHeadInTransaction, prepareHumanRevisionInTransaction, prepareRevisionFile,
  commitHumanRevision, recoverHumanIntents, readIdempotent, readCommittedIdempotent, storeIdempotent, decodePageCursor, encodePageCursor,
  type RevisionPreparation, type HumanRevisionInput } from '@workbench/storage/revisions';
import type { ApplicationContext, DocumentPort } from '../ports/index.ts';

export function assertRequestIdentity(context: ApplicationContext, request: RequestContext): void {
  if (request.workspace_id !== context.identity.workspace_id || request.service_instance_id !== context.identity.service_instance_id ||
      request.contract_version !== context.identity.contract_version) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '请求身份与唯一主服务不匹配');
}
export class Documents implements DocumentPort {
  readonly context: ApplicationContext;
  constructor(context: ApplicationContext) { this.context = context; }
  get files(): ManagedFiles { return new ManagedFiles(workspaceSettings(this.context.db, this.context.identity.workspace_id).paths); }
  recover() { return recoverHumanIntents(this.context.db, this.files, this.context.identity.workspace_id); }
  async create(request: RequestContext, input: CreateDocumentRequest): Promise<DocumentSnapshot> {
    assertRequestIdentity(this.context, request);
    if (typeof input.kind !== 'string' || !input.kind || typeof input.initial_text !== 'string') throw new ContractError('VALIDATION_ERROR', '文稿类型和初始正文必须提供');
    const operation = 'documents.create';
    const preparation = transaction(this.context.db, () => {
      const replay = readIdempotent<RevisionPreparation | DocumentSnapshot>(this.context.db, request, operation, input); if (replay) return replay;
      const documentId = randomUUID();
      this.context.db.prepare('INSERT INTO documents (id,workspace_id,kind,owner_entity_id,version) VALUES (?,?,?,?,1)')
        .run(documentId, request.workspace_id, input.kind, input.owner_entity_id ?? null);
      const prepared = prepareHumanRevisionInTransaction(this.context.db, this.files, request,
        { document_id: documentId, expected_revision_id: null, text: input.initial_text });
      const snapshot: DocumentSnapshot = { document_id: documentId, head_revision_id: prepared.revision_id, version: 2,
        text: input.initial_text, hash: prepared.hash, save_state: 'committed' };
      storeIdempotent(this.context.db, request, operation, input, { ...prepared, committed_response: snapshot }, 'pending'); return prepared;
    });
    if ('head_revision_id' in preparation) return preparation;
    prepareRevisionFile(this.context.db, this.files, request.workspace_id, preparation.write_intent_id);
    commitHumanRevision(this.context.db, this.files, request.workspace_id, preparation.write_intent_id);
    return readIdempotent<DocumentSnapshot>(this.context.db, request, operation, input)!;
  }
  async get(request: RequestContext, id: string): Promise<DocumentSnapshot> {
    assertRequestIdentity(this.context, request); const document = getDocumentRow(this.context.db, request.workspace_id, id);
    if (!document.head_revision_id) return { document_id: id, head_revision_id: null, version: document.version, text: '', hash: null, save_state: 'empty' };
    const revision = getRevisionRow(this.context.db, request.workspace_id, document.head_revision_id, id);
    const read = this.files.readRevision(revision.file_path, revision.sha256 as DocumentSnapshot['hash'] & string,
      { workspace_id: revision.workspace_id, document_id: revision.document_id, revision_id: revision.id });
    const parsed = parseRevision(read.content);
    if (parsed.metadata.document_id !== id || parsed.metadata.revision_id !== revision.id || parsed.metadata.workspace_id !== request.workspace_id)
      throw new ContractError('STORAGE_UNAVAILABLE', '修订文件归属与主存不符');
    return { document_id: id, head_revision_id: revision.id, version: document.version, text: parsed.text,
      hash: revision.sha256 as DocumentSnapshot['hash'], save_state: 'committed' };
  }
  async save(request: RequestContext, id: string, input: SaveRevisionRequest): Promise<SaveRevisionResponse> {
    SaveRevisionSchema.parse(input);
    return this.saveHuman(request, `documents.save:${id}`, input,
      { document_id: id, expected_revision_id: input.expected_revision_id, text: input.text });
  }
  private async saveHuman(request: RequestContext, operation: string, original: unknown, input: HumanRevisionInput): Promise<SaveRevisionResponse> {
    assertRequestIdentity(this.context, request);
    const saved = transaction(this.context.db, () => {
      const replay = readIdempotent<RevisionPreparation | SaveRevisionResponse>(this.context.db, request, operation, original);
      if (replay) return replay;
      const prepared = prepareHumanRevisionInTransaction(this.context.db, this.files, request, input);
      storeIdempotent(this.context.db, request, operation, original, prepared, 'pending'); return prepared;
    });
    if ('save_state' in saved && saved.save_state === 'committed' && 'version' in saved) return saved as SaveRevisionResponse;
    prepareRevisionFile(this.context.db, this.files, request.workspace_id, saved.write_intent_id);
    const committed = commitHumanRevision(this.context.db, this.files, request.workspace_id, saved.write_intent_id);
    transaction(this.context.db, () => storeIdempotent(this.context.db, request, operation, original, committed));
    return committed;
  }
  async restore(request: RequestContext, id: string, input: ExpectedRevision & { revision_id: string }): Promise<SaveRevisionResponse> {
    assertRequestIdentity(this.context, request);
    const replay = readCommittedIdempotent<SaveRevisionResponse>(this.context.db, request, `documents.restore:${id}`, input); if (replay) return replay;
    const revision = getRevisionRow(this.context.db, request.workspace_id, input.revision_id, id);
    const body = parseRevision(this.files.readRevision(revision.file_path, revision.sha256 as SaveRevisionResponse['hash'],
      { workspace_id: revision.workspace_id, document_id: revision.document_id, revision_id: revision.id }).content).text;
    return this.saveHuman(request, `documents.restore:${id}`, input, { document_id: id,
      expected_revision_id: input.expected_revision_id, text: body, origin: 'restore', change_kind: 'restore',
      restore_from_revision_id: revision.id, based_on_core_revision_id: revision.based_on_core_revision_id });
  }
  async approveCore(request: RequestContext, topicId: string, revisionId: string): Promise<{ approval_id: string; revision_id: string }> {
    assertRequestIdentity(this.context, request);
    if (typeof revisionId !== 'string' || !revisionId) throw new ContractError('VALIDATION_ERROR', '确认必须指向已保存修订');
    const input = { revision_id: revisionId }; const op = `topics.approve:${topicId}`;
    const completed = readCommittedIdempotent<{ approval_id: string; revision_id: string }>(this.context.db, request, op, input); if (completed) return completed;
    const topic = this.context.db.prepare('SELECT core_document_id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id, topicId);
    if (!topic) throw new ContractError('NOT_FOUND', '主题不存在');
    const snapshot = await this.get(request, String(topic.core_document_id));
    if (snapshot.head_revision_id !== revisionId) throw new ContractError('REVISION_CONFLICT', '不能确认旧核心修订', { current_revision_id: snapshot.head_revision_id });
    if (!snapshot.text.trim()) throw new ContractError('CORE_NOT_CONFIRMED', '空核心稿不能确认');
    return transaction(this.context.db, () => {
      const replay = readIdempotent<{ approval_id: string; revision_id: string }>(this.context.db, request, op, input); if (replay) return replay;
      assertRevisionExpected(getDocumentRow(this.context.db, request.workspace_id, String(topic.core_document_id)), revisionId);
      const existing = this.context.db.prepare('SELECT id FROM core_approvals WHERE workspace_id=? AND topic_id=? AND revision_id=?').get(request.workspace_id, topicId, revisionId);
      const result = { approval_id: existing ? String(existing.id) : randomUUID(), revision_id: revisionId };
      if (!existing) this.context.db.prepare('INSERT INTO core_approvals (id,workspace_id,topic_id,revision_id,approved_at,actor) VALUES (?,?,?,?,?,?)')
        .run(result.approval_id, request.workspace_id, topicId, revisionId, new Date().toISOString(), request.request_identity_ref ?? 'human');
      storeIdempotent(this.context.db, request, op, input, result); return result;
    });
  }
  async merge(request: RequestContext, id: string, input: ExpectedRevision & { candidate_id: string; merged_text: string }): Promise<SaveRevisionResponse> {
    assertRequestIdentity(this.context, request);
    const replay = readCommittedIdempotent<SaveRevisionResponse>(this.context.db, request, `documents.merge:${id}`, input); if (replay) return replay;
    const candidate = this.context.db.prepare('SELECT * FROM candidates WHERE workspace_id=? AND id=? AND target_document_id=?').get(request.workspace_id, input.candidate_id, id);
    if (!candidate) throw new ContractError('NOT_FOUND', '合并来源候选不属于此文稿');
    return this.saveHuman(request, `documents.merge:${id}`, input, { document_id: id, expected_revision_id: input.expected_revision_id,
      text: input.merged_text, change_kind: 'merge', merge_candidate_id: input.candidate_id });
  }
  async alignCore(request: RequestContext, variantId: string, input: ExpectedRevision & { confirmed_core_revision_id: string }): Promise<SaveRevisionResponse> {
    assertRequestIdentity(this.context, request);
    const replay = readCommittedIdempotent<SaveRevisionResponse>(this.context.db, request, `variants.align:${variantId}`, input); if (replay) return replay;
    const variant = this.context.db.prepare('SELECT * FROM variants WHERE workspace_id=? AND id=?').get(request.workspace_id, variantId);
    if (!variant) throw new ContractError('NOT_FOUND', '平台版本不存在');
    assertCoreFreshness(this.context.db, request.workspace_id, String(variant.topic_id), input.confirmed_core_revision_id);
    const current = await this.get(request, String(variant.document_id));
    const saved = await this.saveHuman(request, `variants.align:${variantId}`, input, { document_id: current.document_id,
      expected_revision_id: input.expected_revision_id, text: current.text, change_kind: 'core_alignment', based_on_core_revision_id: input.confirmed_core_revision_id });
    return saved;
  }
  async adoptCandidate(request: RequestContext, candidateId: string, input: ExpectedRevision): Promise<JsonObject> {
    assertRequestIdentity(this.context, request);
    return transaction(this.context.db, () => {
      const op = `candidates.adopt:${candidateId}`; const replay = readIdempotent<JsonObject>(this.context.db, request, op, input); if (replay) return replay;
      const raw = this.context.db.prepare('SELECT * FROM candidates WHERE workspace_id=? AND id=?').get(request.workspace_id, candidateId);
      if (!raw) throw new ContractError('NOT_FOUND', '候选不存在'); const candidate = raw as unknown as CandidatesRow;
      const document = getDocumentRow(this.context.db, request.workspace_id, candidate.target_document_id);
      if (candidate.base_revision_id !== input.expected_revision_id || input.expected_revision_id !== document.head_revision_id)
        throw new ContractError('REVISION_CONFLICT', '候选 base、expected 与当前 head 不一致', { current_revision_id: document.head_revision_id, candidate_base_revision_id: candidate.base_revision_id });
      const provenance = this.context.db.prepare('SELECT r.state,j.cancel_requested_at FROM result_receipts r JOIN jobs j ON j.id=r.job_id AND j.workspace_id=r.workspace_id WHERE r.workspace_id=? AND r.id=?').get(request.workspace_id, candidate.result_receipt_id);
      if (!provenance || provenance.state !== 'committed' || provenance.cancel_requested_at !== null || !['pending', 'conflict'].includes(candidate.status))
        throw new ContractError('HOST_RUN_NOT_CURRENT', '候选提交归属无效或已取消');
      const revision = getRevisionRow(this.context.db, request.workspace_id, candidate.revision_id, document.id);
      const content = parseRevision(this.files.readRevision(revision.file_path, revision.sha256 as SaveRevisionResponse['hash'],
        { workspace_id: revision.workspace_id, document_id: revision.document_id, revision_id: revision.id }).content);
      if (content.metadata.workspace_id !== request.workspace_id || content.metadata.document_id !== document.id || content.metadata.revision_id !== revision.id)
        throw new ContractError('STORAGE_UNAVAILABLE', '候选文件身份与已提交修订不符');
      const variant = this.context.db.prepare('SELECT topic_id FROM variants WHERE workspace_id=? AND document_id=?').get(request.workspace_id, document.id);
      if (variant) {
        if (!revision.based_on_core_revision_id) throw new ContractError('INPUT_STALE', '平台候选没有冻结核心输入');
        assertCoreFreshness(this.context.db, request.workspace_id, String(variant.topic_id), revision.based_on_core_revision_id);
      }
      if (!compareAndSetHeadInTransaction(this.context.db, request.workspace_id, document.id, input.expected_revision_id, revision.id)) throw new ContractError('REVISION_CONFLICT', '采用时正文已有新修订');
      this.context.db.prepare("UPDATE candidates SET status='adopted',adopted_revision_id=?,adoption_mode='manual',adopted_at=?,adopted_by=?,updated_at=? WHERE workspace_id=? AND id=?")
        .run(revision.id, new Date().toISOString(), request.request_identity_ref ?? 'human', new Date().toISOString(), request.workspace_id, candidateId);
      const result = { candidate_id: candidateId, document_id: document.id, revision_id: revision.id, adopted: true };
      storeIdempotent(this.context.db, request, op, input, result); return result;
    });
  }
  history(request: RequestContext, documentId: string, cursor?: string): Page<DocumentRevisionsRow> {
    assertRequestIdentity(this.context, request); getDocumentRow(this.context.db, request.workspace_id, documentId);
    const [createdAt, id] = decodePageCursor(cursor);
    const rows = this.context.db.prepare('SELECT * FROM document_revisions WHERE workspace_id=? AND document_id=? AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 51')
      .all(request.workspace_id, documentId, createdAt, createdAt, id) as unknown as DocumentRevisionsRow[];
    const items = rows.slice(0, 50); return { items, has_more: rows.length > 50,
      next_cursor: rows.length > 50 ? encodePageCursor(items.at(-1)!) : null, last_success_at: new Date().toISOString() };
  }
  async importWorking(request: RequestContext, documentId: string): Promise<SaveRevisionResponse> {
    assertRequestIdentity(this.context, request);
    const content = this.files.readWorking(documentId); const parsed = parseRevision(content);
    if (parsed.metadata.document_id !== documentId || parsed.metadata.workspace_id !== request.workspace_id) throw new ContractError('VALIDATION_ERROR', '工作副本身份不匹配');
    const document = getDocumentRow(this.context.db, request.workspace_id, documentId);
    const base = parsed.metadata.base_revision_id;
    if (base === undefined) throw new ContractError('VALIDATION_ERROR', '工作副本缺少 base_revision_id');
    if (base !== document.head_revision_id) {
      const copy = this.files.preserveWorkingConflict(documentId, content);
      throw new ContractError('REVISION_CONFLICT', '外部工作副本基线已变化，已保存冲突副本', { conflict_copy: copy, current_revision_id: document.head_revision_id });
    }
    return this.save(request, documentId, { expected_revision_id: base, text: parsed.text, origin: 'human' });
  }
}
