import { randomUUID } from 'node:crypto';
import { ContractError, type RequestContext, type PreparationShotInput, type PatchPreparationPlanRequest,
  type ProductionPlansRow, type ProductionPlanRevisionsRow } from '@workbench/contracts';
import { inputHash, transaction } from '@workbench/storage/connection';
import { readIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import type { ApplicationContext, PreparationPort } from '../ports/index.ts';
import { assertRequestIdentity } from '../documents/index.ts';

function validateShots(shots: PreparationShotInput[]): void {
  if (!Array.isArray(shots)) throw new ContractError('VALIDATION_ERROR', '镜头必须是完整数组');
  const keys = new Set<string>(); const positions = new Set<number>();
  for (const shot of shots) {
    if (!shot || typeof shot !== 'object' || Array.isArray(shot) || typeof shot.shot_key !== 'string' || !shot.shot_key || keys.has(shot.shot_key) || positions.has(shot.position) ||
        !Number.isSafeInteger(shot.position) || shot.position < 0 || !Number.isSafeInteger(shot.duration_ms) || shot.duration_ms < 0 ||
        typeof shot.title !== 'string' || typeof shot.kind !== 'string' || !shot.source_requirement || typeof shot.source_requirement !== 'object' || Array.isArray(shot.source_requirement) ||
        (shot.asset_refs !== undefined && !Array.isArray(shot.asset_refs)))
      throw new ContractError('VALIDATION_ERROR', '镜头身份、排序或时长无效');
    keys.add(shot.shot_key); positions.add(shot.position);
  }
}
export class TopicPreparation implements PreparationPort {
  readonly context: ApplicationContext;
  constructor(context: ApplicationContext) { this.context = context; }
  createInTransaction(workspaceId: string, topicId: string, shots: PreparationShotInput[] = [{
    shot_key: 'shot-1', position: 0, title: '待准备镜头', kind: 'pending', duration_ms: 0,
    source_requirement: { status: 'pending' },
  }]): { plan_id: string; plan_revision_id: string } {
    if (!this.context.db.isTransaction) throw new Error('topic preparation creation requires the topic transaction');
    validateShots(shots); const planId = randomUUID(); const revisionId = randomUUID();
    this.context.db.prepare("INSERT INTO production_plans (id,workspace_id,topic_id,scope,head_plan_revision_id,version) VALUES (?,?,?,'topic_preparation',?,1)")
      .run(planId, workspaceId, topicId, revisionId);
    this.appendRevision(workspaceId, planId, revisionId, 1, null, shots); return { plan_id: planId, plan_revision_id: revisionId };
  }
  private appendRevision(workspaceId: string, planId: string, revisionId: string, revisionNo: number, parentId: string | null, shots: PreparationShotInput[]) {
    this.context.db.prepare('INSERT INTO production_plan_revisions (id,workspace_id,plan_id,revision_no,parent_revision_id,input_hash) VALUES (?,?,?,?,?,?)')
      .run(revisionId, workspaceId, planId, revisionNo, parentId, inputHash({ plan_id: planId, parent_revision_id: parentId, shots }));
    for (const shot of shots) {
      const shotId = randomUUID();
      this.context.db.prepare('INSERT INTO shots (id,workspace_id,plan_revision_id,shot_key,position,title,kind,duration_ms,narration_revision_id,subtitle_revision_id,source_requirement) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(shotId, workspaceId, revisionId, shot.shot_key, shot.position, shot.title, shot.kind, shot.duration_ms,
          shot.narration_revision_id ?? null, shot.subtitle_revision_id ?? null, JSON.stringify(shot.source_requirement));
      for (const asset of shot.asset_refs ?? []) {
        if (!asset || typeof asset.asset_id !== 'string' || typeof asset.role !== 'string' ||
            [asset.in_ms, asset.out_ms].some(value => value != null && (!Number.isSafeInteger(value) || value < 0)))
          throw new ContractError('VALIDATION_ERROR', '镜头素材引用字段无效');
        const row = this.context.db.prepare('SELECT duration_ms,status FROM assets WHERE workspace_id=? AND id=?').get(workspaceId, asset.asset_id);
        if (!row || !['ready', 'referenced'].includes(String(row.status)) ||
            ((asset.in_ms != null || asset.out_ms != null) && (row.duration_ms === null || asset.in_ms == null || asset.out_ms == null || !(asset.out_ms > asset.in_ms) || asset.out_ms > Number(row.duration_ms))))
          throw new ContractError('VALIDATION_ERROR', '镜头引用素材不可用或范围越界');
        this.context.db.prepare('INSERT INTO shot_assets (id,workspace_id,shot_id,asset_id,role,in_ms,out_ms) VALUES (?,?,?,?,?,?,?)')
          .run(randomUUID(), workspaceId, shotId, asset.asset_id, asset.role, asset.in_ms ?? null, asset.out_ms ?? null);
      }
    }
  }
  private plan(workspaceId: string, id: string): ProductionPlansRow {
    const row = this.context.db.prepare('SELECT * FROM production_plans WHERE workspace_id=? AND id=?').get(workspaceId, id);
    if (!row) throw new ContractError('NOT_FOUND', '准备计划不存在');
    if (row.scope !== 'topic_preparation') throw new ContractError('VALIDATION_ERROR', '此 port 只操作主题准备计划');
    return row as unknown as ProductionPlansRow;
  }
  async get(request: RequestContext, planId: string) {
    assertRequestIdentity(this.context, request); return this.snapshot(request.workspace_id, planId);
  }
  private snapshot(workspaceId: string, planId: string) {
    const plan = this.plan(workspaceId, planId);
    if (!plan.head_plan_revision_id) throw new ContractError('STORAGE_UNAVAILABLE', '准备计划缺少已提交修订');
    return { id: plan.id, topic_id: plan.topic_id, head_plan_revision_id: plan.head_plan_revision_id, version: plan.version,
      shots: this.shots(workspaceId, plan.head_plan_revision_id) };
  }
  async ensure(request: RequestContext, input: { scope: 'topic_preparation'; topic_id: string; shots: PreparationShotInput[] }) {
    assertRequestIdentity(this.context, request); validateShots(input.shots);
    if (input.scope !== 'topic_preparation') throw new ContractError('VALIDATION_ERROR', '此模块只建立主题准备计划');
    return transaction(this.context.db, () => {
      const replay = readIdempotent<ReturnType<TopicPreparation['snapshot']>>(this.context.db, request, 'preparation.ensure', input); if (replay) return replay;
      if (!this.context.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id, input.topic_id)) throw new ContractError('NOT_FOUND', '主题不存在');
      const existing = this.context.db.prepare("SELECT id FROM production_plans WHERE workspace_id=? AND topic_id=? AND scope='topic_preparation'").get(request.workspace_id, input.topic_id);
      const id = existing ? String(existing.id) : this.createInTransaction(request.workspace_id, input.topic_id, input.shots).plan_id;
      const result = this.snapshot(request.workspace_id, id); storeIdempotent(this.context.db, request, 'preparation.ensure', input, result); return result;
    });
  }
  shots(workspaceId: string, revisionId: string): PreparationShotInput[] {
    return this.context.db.prepare('SELECT * FROM shots WHERE workspace_id=? AND plan_revision_id=? ORDER BY position,shot_key').all(workspaceId, revisionId)
      .map(shot => ({ shot_key: String(shot.shot_key), position: Number(shot.position), title: String(shot.title), kind: String(shot.kind), duration_ms: Number(shot.duration_ms),
        narration_revision_id: shot.narration_revision_id as string | null, subtitle_revision_id: shot.subtitle_revision_id as string | null,
        source_requirement: JSON.parse(String(shot.source_requirement)), asset_refs: this.context.db.prepare('SELECT asset_id,role,in_ms,out_ms FROM shot_assets WHERE workspace_id=? AND shot_id=? ORDER BY id').all(workspaceId, String(shot.id)) as unknown as PreparationShotInput['asset_refs'] }));
  }
  revision(request: RequestContext, planId: string, revisionId: string) {
    assertRequestIdentity(this.context, request); this.plan(request.workspace_id, planId);
    const row = this.context.db.prepare('SELECT * FROM production_plan_revisions WHERE workspace_id=? AND plan_id=? AND id=?').get(request.workspace_id, planId, revisionId);
    if (!row) throw new ContractError('NOT_FOUND', '计划修订不存在');
    return { ...(row as unknown as ProductionPlanRevisionsRow), shots: this.shots(request.workspace_id, revisionId) };
  }
  async revise(request: RequestContext, planId: string, input: PatchPreparationPlanRequest) {
    assertRequestIdentity(this.context, request); validateShots(input.shots);
    return transaction(this.context.db, () => {
      const op = `preparation.revise:${planId}`; const replay = readIdempotent<{ plan_revision_id: string; version: number }>(this.context.db, request, op, input); if (replay) return replay;
      const plan = this.plan(request.workspace_id, planId);
      if (plan.version !== input.expected_version || plan.head_plan_revision_id !== input.base_plan_revision_id)
        throw new ContractError('VERSION_CONFLICT', '准备计划已有新修订', { current_version: plan.version, current_revision_id: plan.head_plan_revision_id });
      const revisionId = randomUUID(); this.appendRevision(request.workspace_id, planId, revisionId, plan.version + 1, plan.head_plan_revision_id, input.shots);
      this.context.db.prepare('UPDATE production_plans SET head_plan_revision_id=?,version=version+1,updated_at=? WHERE workspace_id=? AND id=? AND version=?')
        .run(revisionId, new Date().toISOString(), request.workspace_id, planId, input.expected_version);
      const result = { plan_revision_id: revisionId, version: plan.version + 1 }; storeIdempotent(this.context.db, request, op, input, result); return result;
    });
  }
  requireRenderable(request: RequestContext, planId: string): never {
    assertRequestIdentity(this.context, request); this.plan(request.workspace_id, planId);
    throw new ContractError('VALIDATION_ERROR', '主题准备计划没有平台和脚本输入，不能渲染成品', { state: 'waiting_input' });
  }
}
