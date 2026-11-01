import { randomUUID } from 'node:crypto';
import { ContractError, CreateTopicSchema, CreateAccountSchema, PLATFORMS, type RequestContext, type JsonObject, type CreateTopicRequest, type CreateAccountRequest } from '@workbench/contracts';
import { canonicalJson, transaction } from '@workbench/storage/connection';
import { readIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import { recommendationCandidate, recommendationRun, recommendationRuns } from '@workbench/storage/recommendations';
import { assertRequestIdentity } from '../documents/index.ts';
import { TopicPreparation } from '../topic-preparation/index.ts';
import { normalizeWorkUrl } from '../identity/index.ts';
import { ContentGeneration, assertExecutor, type GenerationOptions } from '../content-agents/index.ts';
import { actionEvidence, evidenceFromSources, auditCitations, type ContentEvidence } from '../content-agents/evidence.ts';
import type { AccountRecommendationInput, TopicRecommendationInput, RecommendationAdoptionInput, GenerationAccepted } from '../content-agents/contracts.ts';
import type { ApplicationContext } from '../ports/index.ts';
import type { TypedOutput } from '../result-commit/index.ts';
export type { RecommendationCandidate, RecommendationRun } from '@workbench/storage/recommendations';
export interface RecommendationAdoption { candidate_id: string; kind: 'topic' | 'account'; adopted_target_id: string; identity_status?: string }
export function validateRecommendationOutput(manifest: JsonObject, output: TypedOutput): TypedOutput {
  if (manifest.schema_version !== 'wp16-content-v1' || manifest.mode !== 'recommendation') return output;
  const evidence = manifest.input_evidence as unknown as ContentEvidence[], platforms = manifest.platforms as string[] | undefined;
  for (const item of output.recommendations) {
    if (!item.rationale.trim()) throw new ContractError('VALIDATION_ERROR', '推荐缺少具体依据'); auditCitations(item.rationale, evidence);
    for (const source of item.rationale.matchAll(/\[source:([^\]]+)\]/g)) if (!item.source_ids.includes(source[1]!)) throw new ContractError('VALIDATION_ERROR', '推荐引用必须登记在候选 source_ids');
    if (manifest.recommendation_kind === 'topic') {
      if (Object.keys(item.payload).some(key => !['title', 'category', 'audience', 'angle', 'expected_effort_min'].includes(key))) throw new ContractError('VALIDATION_ERROR', '选题候选字段无效');
      CreateTopicSchema.parse({ ...item.payload, source_ids: item.source_ids }); if (!String(item.payload.title).trim()) throw new ContractError('VALIDATION_ERROR', '选题标题不能为空');
    } else {
      if (Object.keys(item.payload).some(key => !['platform', 'url', 'name'].includes(key))) throw new ContractError('VALIDATION_ERROR', '账号候选字段无效');
      CreateAccountSchema.parse({ ...item.payload, role: 'benchmark' }); const url = normalizeWorkUrl(String(item.payload.url));
      if (!platforms?.includes(String(item.payload.platform)) || !evidence.some(entry => entry.kind === 'work' && entry.data.platform === item.payload.platform && entry.data.account_url && normalizeWorkUrl(String(entry.data.account_url)) === url)) throw new ContractError('VALIDATION_ERROR', '账号候选必须来自所选平台和已核对作品作者');
    }
  }
  return output;
}
export class Recommendations {
  readonly context: ApplicationContext; readonly generation: ContentGeneration;
  constructor(context: ApplicationContext, options: GenerationOptions = {}) { this.context = context; this.generation = new ContentGeneration(context, options); }
  topic(request: RequestContext, input: TopicRecommendationInput): GenerationAccepted { return this.start(request, 'topic', input); }
  account(request: RequestContext, input: AccountRecommendationInput): GenerationAccepted { return this.start(request, 'account', input); }
  private start(request: RequestContext, kind: 'topic' | 'account', input: TopicRecommendationInput | AccountRecommendationInput): GenerationAccepted {
    assertRequestIdentity(this.context, request); assertExecutor(input.executor); const op = `recommendations.${kind}.start`;
    return transaction(this.context.db, () => {
      const replay = readIdempotent<GenerationAccepted>(this.context.db, request, op, input); if (replay) return replay;
      const evidence = evidenceFromSources(this.context, request, input.source_ids);
      if ('action_ids' in input) evidence.push(...actionEvidence(this.context, request, input.action_ids));
      if (!evidence.length) throw new ContractError('VALIDATION_ERROR', '推荐需要固定资料或复盘依据');
      if ('platforms' in input && (!input.positioning.trim() || !input.platforms.length || input.platforms.some(platform => !PLATFORMS.includes(platform)) || !evidence.some(item => item.kind === 'work'))) throw new ContractError('CAPABILITY_UNVERIFIED', '账号推荐需要定位、选定平台和可核对的真实作品依据');
      const runId = randomUUID(), extra: JsonObject = { recommendation_kind: kind, recommendation_run_id: runId, ...('platforms' in input ? { positioning: input.positioning, platforms: [...new Set(input.platforms)] } : { action_ids: input.action_ids }) };
      const instruction = kind === 'topic' ? '只推荐一个有固定依据的选题。payload_json 为 JSON 字符串，字段只有 title/category/audience/angle/expected_effort_min；source_ids 为引用的固定资料 ID，rationale 必须含固定引用。' : '只推荐一个固定作品作者账号。payload_json 为 JSON 字符串，字段只有 platform/url/name，url 必须是 input_evidence 中该作品作者的 account_url，不能虚构账号；rationale 引用作品 URL，身份仍待核对。';
      const result = { ...this.generation.enqueueInTransaction(request, `${kind}_recommendation`, null, input.executor, 'recommendation', [], evidence, instruction, extra), run_id: runId };
      const job = this.context.db.prepare('SELECT input_manifest FROM jobs WHERE workspace_id=? AND id=?').get(request.workspace_id, result.job_id)!;
      this.context.db.prepare("INSERT INTO recommendation_runs(id,workspace_id,kind,input_manifest,job_id,status) VALUES (?,?,?,?,?,'queued')").run(runId, request.workspace_id, kind, String(job.input_manifest), result.job_id); storeIdempotent(this.context.db, request, op, input, result); return result;
    });
  }
  get(request: RequestContext, id: string) { assertRequestIdentity(this.context, request); return recommendationRun(this.context.db, request.workspace_id, id); }
  list(request: RequestContext, query: { kind?: string; state?: string; cursor?: string } = {}) { assertRequestIdentity(this.context, request); return recommendationRuns(this.context.db, request.workspace_id, query); }
  adopt(request: RequestContext, id: string, input: RecommendationAdoptionInput = {}): RecommendationAdoption {
    assertRequestIdentity(this.context, request); if (Object.keys(input).some(key => !['topic', 'account'].includes(key)) || (input.topic && input.account)) throw new ContractError('VALIDATION_ERROR', '推荐采用只能有对应类型的表单');
    return transaction(this.context.db, () => {
      const op = 'recommendations.adopt', body = { candidate_id: id, ...input }, replay = readIdempotent<RecommendationAdoption>(this.context.db, request, op, body); if (replay) return replay;
      const stable = { ...request, idempotency_key: `recommendation-adoption:${id}` }, existing = readIdempotent<RecommendationAdoption>(this.context.db, stable, op, body); if (existing) { storeIdempotent(this.context.db, request, op, body, existing); return existing; }
      const candidate = recommendationCandidate(this.context.db, request.workspace_id, id);
      if (input.topic && candidate.kind !== 'topic' || input.account && candidate.kind !== 'account') throw new ContractError('VALIDATION_ERROR', '表单与推荐类型不同');
      const provenance = this.context.db.prepare('SELECT r.state,j.cancel_requested_at FROM result_receipts r JOIN jobs j ON j.workspace_id=r.workspace_id AND j.id=r.job_id WHERE r.workspace_id=? AND r.id=?').get(request.workspace_id, candidate.result_receipt_id);
      if (!provenance || provenance.state !== 'committed' || provenance.cancel_requested_at !== null || candidate.status !== 'pending' || candidate.adopted_target_id !== null) throw new ContractError('HOST_RUN_NOT_CURRENT', '推荐未提交或已取消，不能采用');
      const run = recommendationRun(this.context.db, request.workspace_id, candidate.run_id); validateRecommendationOutput(run.input_manifest, { documents: [], recommendations: [{ payload: candidate.payload, source_ids: candidate.source_ids, rationale: candidate.rationale }] });
      let target: string, identity: string | undefined;
      if (candidate.kind === 'topic') {
        const topic = input.topic ?? { ...candidate.payload, source_ids: candidate.source_ids } as unknown as CreateTopicRequest; CreateTopicSchema.parse(topic); if (!topic.title.trim()) throw new ContractError('VALIDATION_ERROR', '主题标题不能为空');
        for (const source of topic.source_ids) if (!this.context.db.prepare('SELECT id FROM source_records WHERE workspace_id=? AND id=?').get(request.workspace_id, source)) throw new ContractError('NOT_FOUND', '采用来源不存在');
        target = randomUUID(); const document = randomUUID(); this.context.db.prepare("INSERT INTO documents(id,workspace_id,kind,owner_entity_id,version) VALUES (?,?,'core',?,1)").run(document, request.workspace_id, target);
        this.context.db.prepare("INSERT INTO topics(id,workspace_id,title,category,audience,angle,expected_effort_min,core_document_id,status,version) VALUES (?,?,?,?,?,?,?,?,'active',1)").run(target, request.workspace_id, topic.title, topic.category, topic.audience, topic.angle ?? '', topic.expected_effort_min ?? 0, document);
        for (const source of new Set(topic.source_ids)) this.context.db.prepare('INSERT INTO topic_sources(id,workspace_id,topic_id,source_record_id,usage) VALUES (?,?,?,?,?)').run(randomUUID(), request.workspace_id, target, source, 'recommendation_adoption'); new TopicPreparation(this.context).createInTransaction(request.workspace_id, target);
      } else {
        const account = input.account ?? { ...candidate.payload, role: 'benchmark' } as unknown as CreateAccountRequest; CreateAccountSchema.parse(account); if (account.role !== 'benchmark') throw new ContractError('VALIDATION_ERROR', '推荐采用只能新增对标账号');
        const url = normalizeWorkUrl(account.url), old = this.context.db.prepare("SELECT id,identity_status FROM accounts WHERE workspace_id=? AND platform=? AND canonical_url=? AND role='benchmark'").get(request.workspace_id, account.platform, url); target = old ? String(old.id) : randomUUID(); identity = old ? String(old.identity_status) : 'pending';
        if (!old) this.context.db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,?,NULL,'benchmark',?,?,'pending')").run(target, request.workspace_id, account.platform, account.name.trim(), url);
      }
      this.context.db.prepare("UPDATE recommendation_candidates SET status='adopted',adopted_target_id=?,updated_at=? WHERE workspace_id=? AND id=? AND adopted_target_id IS NULL").run(target, new Date().toISOString(), request.workspace_id, id);
      for (const source of candidate.source_ids) this.context.db.prepare('INSERT INTO evidence_links(id,workspace_id,owner_type,owner_id,source_type,source_id,locator) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), request.workspace_id, candidate.kind, target, 'source_record', source, canonicalJson({ recommendation_candidate_id: id, run_id: candidate.run_id, result_receipt_id: candidate.result_receipt_id }));
      const result: RecommendationAdoption = { candidate_id: id, kind: candidate.kind, adopted_target_id: target, ...(identity ? { identity_status: identity } : {}) }; storeIdempotent(this.context.db, stable, op, body, result); storeIdempotent(this.context.db, request, op, body, result); return result;
    });
  }
}
