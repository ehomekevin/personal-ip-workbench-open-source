import { randomUUID } from 'node:crypto';
import { ContractError, CreateTopicSchema, type CreateTopicRequest, type RequestContext, type TopicDetail,
  type TopicSummary, type Page, type JsonObject,type DocumentSnapshot } from '@workbench/contracts';
import { transaction } from '@workbench/storage/connection';
import { readIdempotent, storeIdempotent, decodePageCursor, encodePageCursor } from '@workbench/storage/revisions';
import { Documents, assertRequestIdentity } from '../documents/index.ts';
import { TopicPreparation } from '../topic-preparation/index.ts';
import type { ApplicationContext, TopicPort } from '../ports/index.ts';
import {withTopicReadState} from './read-state.ts';

export class Topics implements TopicPort {
  readonly context: ApplicationContext; readonly documents: Documents; readonly preparation: TopicPreparation;
  constructor(context: ApplicationContext) { this.context = context; this.documents = new Documents(context); this.preparation = new TopicPreparation(context); }
  async ensureViewpoints(request: RequestContext, topicId: string) {
    assertRequestIdentity(this.context, request);
    const operation='topics.viewpoints.ensure:'+topicId,input={};
    const replay=readIdempotent<DocumentSnapshot>(this.context.db,request,operation,input);if(replay)return replay;
    const documentId = transaction(this.context.db, () => {
      if (!this.context.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id, topicId)) throw new ContractError('NOT_FOUND', '主题不存在');
      const existing = this.context.db.prepare("SELECT id FROM documents WHERE workspace_id=? AND kind='topic_viewpoints' AND owner_entity_id=? ORDER BY created_at,id LIMIT 1").get(request.workspace_id, topicId);
      if (existing) return String(existing.id);
      const id = randomUUID();
      this.context.db.prepare("INSERT INTO documents(id,workspace_id,kind,owner_entity_id,version) VALUES (?,?,'topic_viewpoints',?,1)").run(id, request.workspace_id, topicId);
      return id;
    });
    const snapshot=await this.documents.get(request, documentId);
    return transaction(this.context.db,()=>{const replay=readIdempotent<DocumentSnapshot>(this.context.db,request,operation,input);if(replay)return replay;storeIdempotent(this.context.db,request,operation,input,snapshot);return snapshot;});
  }
  async create(request: RequestContext, input: CreateTopicRequest): Promise<TopicDetail> {
    assertRequestIdentity(this.context, request); CreateTopicSchema.parse(input);
    if (!input.title.trim()) throw new ContractError('VALIDATION_ERROR', '主题标题不能为空');
    return transaction(this.context.db, () => {
      const replay = readIdempotent<TopicDetail>(this.context.db, request, 'topics.create', input); if (replay) return replay;
      const topicId = randomUUID(); const documentId = randomUUID();
      this.context.db.prepare("INSERT INTO documents (id,workspace_id,kind,owner_entity_id,version) VALUES (?,?,'core',?,1)").run(documentId, request.workspace_id, topicId);
      this.context.db.prepare("INSERT INTO topics (id,workspace_id,title,category,audience,angle,expected_effort_min,core_document_id,status,version) VALUES (?,?,?,?,?,?,?,?,'active',1)")
        .run(topicId, request.workspace_id, input.title, input.category, input.audience, input.angle ?? '', input.expected_effort_min ?? 0, documentId);
      for (const sourceId of new Set(input.source_ids)) this.context.db.prepare('INSERT INTO topic_sources (id,workspace_id,topic_id,source_record_id,usage) VALUES (?,?,?,?,?)')
        .run(randomUUID(), request.workspace_id, topicId, sourceId, 'user_selected');
      const prepared = this.preparation.createInTransaction(request.workspace_id, topicId);
      const row = this.context.db.prepare('SELECT * FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id, topicId)!;
      const result: TopicDetail = { ...(row as unknown as TopicSummary), core: { document_id: documentId, head_revision_id: null, version: 1, text: '', hash: null, save_state: 'empty' },
        source_ids:[...new Set(input.source_ids)], core_approval: null, variants: [], assets: [], preparation_plan_id: prepared.plan_id, preparation_head_revision_id: prepared.plan_revision_id,
        shots: this.preparation.shots(request.workspace_id, prepared.plan_revision_id) };
      storeIdempotent(this.context.db, request, 'topics.create', input, result); return result;
    });
  }
  async get(request: RequestContext, id: string): Promise<TopicDetail> {
    assertRequestIdentity(this.context, request); const row = this.context.db.prepare('SELECT * FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id, id);
    if (!row) throw new ContractError('NOT_FOUND', '主题不存在');
    const core = await this.documents.get(request, String(row.core_document_id));
    const approval = core.head_revision_id ? this.context.db.prepare('SELECT id AS approval_id,revision_id,approved_at,actor FROM core_approvals WHERE workspace_id=? AND topic_id=? AND revision_id=? ORDER BY approved_at DESC,id DESC LIMIT 1')
      .get(request.workspace_id, id, core.head_revision_id) : null;
    const plan = this.context.db.prepare("SELECT id FROM production_plans WHERE workspace_id=? AND topic_id=? AND scope='topic_preparation'").get(request.workspace_id, id);
    if (!plan) throw new ContractError('STORAGE_UNAVAILABLE', '主题缺少准备计划');
    const preparation = await this.preparation.get(request, String(plan.id));
    return { ...(row as unknown as TopicSummary), source_ids:this.context.db.prepare('SELECT source_record_id FROM topic_sources WHERE workspace_id=? AND topic_id=? ORDER BY source_record_id').all(request.workspace_id,id).map(row=>String(row.source_record_id)), core, core_approval: (approval ?? null) as JsonObject | null,
      variants: this.context.db.prepare('SELECT * FROM variants WHERE workspace_id=? AND topic_id=? ORDER BY platform,format,id').all(request.workspace_id, id) as unknown as JsonObject[],
      assets: this.context.db.prepare('SELECT a.*,l.purpose,l.evidence_kind FROM assets a JOIN topic_asset_links l ON l.asset_id=a.id AND l.workspace_id=a.workspace_id WHERE a.workspace_id=? AND l.topic_id=? ORDER BY a.id').all(request.workspace_id, id) as unknown as JsonObject[],
      preparation_plan_id: preparation.id, preparation_head_revision_id: preparation.head_plan_revision_id, shots: preparation.shots };
  }
  list(request: RequestContext, cursor?: string, status?: string): Page<TopicSummary> {
    assertRequestIdentity(this.context, request); const [createdAt, id] = decodePageCursor(cursor);
    const rows = this.context.db.prepare('SELECT * FROM topics WHERE workspace_id=? AND (created_at>? OR (created_at=? AND id>?)) AND (? IS NULL OR status=?) ORDER BY created_at,id LIMIT 51')
      .all(request.workspace_id, createdAt, createdAt, id, status ?? null, status ?? null) as unknown as (TopicSummary & { created_at: string })[];
    const selected = rows.slice(0, 50),items=withTopicReadState(this.context.db,request.workspace_id,selected); return { items, has_more: rows.length > 50, next_cursor: rows.length > 50 ? encodePageCursor(selected.at(-1)!) : null, last_success_at: new Date().toISOString() };
  }
}
export { TopicOperationsStore } from './operations.ts';
