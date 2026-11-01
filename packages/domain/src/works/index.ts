import { randomUUID } from 'node:crypto';
import { ContractError, PLATFORMS, FORMATS, type Platform, type ContentFormat, type RequestContext, type JsonObject } from '@workbench/contracts';
import type { ApplicationContext } from '../ports/index.ts';
import { assertRequestIdentity } from '../documents/index.ts';
import { Identities, normalizeWorkUrl } from '../identity/index.ts';
import { transaction, lookupIdempotency, claimIdempotency, commitIdempotency } from '@workbench/storage/connection';
import { type WorksFilter, listWorks, workView } from '@workbench/storage/works';
import { type VerifiedWorkIdentity } from '@workbench/storage/identity';

export interface ImportExistingWorkRequest { platform: Platform; url?: string; platform_work_id?: string; topic_id?: string | null; format?: ContentFormat | null }
export function workIdCandidate(platform: Platform, url: string): string | null {
  const parsed = new URL(url), host = parsed.hostname.toLowerCase();
  const patterns: Partial<Record<Platform, [RegExp, RegExp]>> = {
    x: [/(^|\.)(x|twitter)\.com$/, /\/status\/(\d+)(?:\/|$)/],
    xiaohongshu: [/(^|\.)xiaohongshu\.com$/, /\/(?:explore|discovery\/item)\/([a-fA-F0-9]{24})(?:\/|$)/],
    douyin: [/(^|\.)douyin\.com$/, /\/video\/(\d+)(?:\/|$)/],
    bilibili: [/(^|\.)bilibili\.com$/, /\/video\/(BV[A-Za-z0-9]+)(?:\/|$)/],
  };
  const pair = patterns[platform]; return pair?.[0].test(host) ? parsed.pathname.match(pair[1])?.[1] ?? null : null;
}
export function locatorForId(platform: Platform, id: string): string {
  if (!id || id.length > 256 || /[\s/?#]/.test(id)) throw new ContractError('VALIDATION_ERROR', '平台作品 ID 无效');
  const prefix: Record<Platform, string> = { x: 'https://x.com/i/status/', xiaohongshu: 'https://www.xiaohongshu.com/explore/', douyin: 'https://www.douyin.com/video/', bilibili: 'https://www.bilibili.com/video/', wechat: 'https://mp.weixin.qq.com/s/' };
  return prefix[platform] + encodeURIComponent(id);
}
export class Works {
  readonly context: ApplicationContext; readonly identities: Identities;
  constructor(context: ApplicationContext) { this.context = context; this.identities = new Identities(context); }
  async importWork(request: RequestContext, input: ImportExistingWorkRequest) {
    assertRequestIdentity(this.context, request);
    if (!input || !PLATFORMS.includes(input.platform) || (!input.url && !input.platform_work_id) || (input.format != null && !FORMATS.includes(input.format))) throw new ContractError('VALIDATION_ERROR', '须填写平台及作品 URL 或 ID');
    const url = normalizeWorkUrl(input.url ?? locatorForId(input.platform, input.platform_work_id!)), candidate = workIdCandidate(input.platform, url);
    if (input.platform_work_id && candidate && input.platform_work_id !== candidate) throw new ContractError('VALIDATION_ERROR', 'URL 与平台 ID 候选不一致');
    const body = { platform: input.platform, url: input.url ?? null, platform_work_id: input.platform_work_id ?? null, topic_id: input.topic_id ?? null, format: input.format ?? null };
    const claim = transaction(this.context.db, () => claimIdempotency(this.context.db, request.workspace_id, 'works.import-existing', request.idempotency_key ?? '', body));
    if (claim.state === 'committed') return claim.response as unknown as { work_id: string; identity_status: string; platform_work_id_candidate: string | null };
    const result = await this.identities.importWork({ ...request, idempotency_key: 'wp12-identity:' + claim.id }, { platform: input.platform, url, topic_id: input.topic_id ?? null, format: input.format ?? null });
    const locator: JsonObject = { kind: 'import_candidate', platform_work_id_candidate: input.platform_work_id ?? candidate, url, generated_locator: !input.url, identity_status: 'pending', author_verified: false };
    return transaction(this.context.db, () => {
      const replay = lookupIdempotency(this.context.db, request.workspace_id, 'works.import-existing', request.idempotency_key ?? '', body);
      if (replay?.state === 'committed') return replay.response as unknown as { work_id: string; identity_status: string; platform_work_id_candidate: string | null };
      const encoded = JSON.stringify(locator);
      if (!this.context.db.prepare("SELECT id FROM evidence_links WHERE workspace_id=? AND owner_type='work' AND owner_id=? AND locator=?").get(request.workspace_id, result.work_id, encoded))
        this.context.db.prepare("INSERT INTO evidence_links(id,workspace_id,owner_type,owner_id,source_type,source_id,locator) VALUES (?,?,'work',?,'identity_observation',?,?)").run(randomUUID(), request.workspace_id, result.work_id, result.work_id, encoded);
      const complete = { ...result, platform_work_id_candidate: input.platform_work_id ?? candidate }; commitIdempotency(this.context.db, request.workspace_id, claim.id, complete); return complete;
    });
  }
  list(request: RequestContext, filters: WorksFilter = {}) { assertRequestIdentity(this.context, request); return listWorks(this.context.db, request.workspace_id, filters); }
  get(request: RequestContext, workId: string) { assertRequestIdentity(this.context, request); return workView(this.context.db, request.workspace_id, workId); }
  resolveVerified(request: RequestContext, workId: string, identity: VerifiedWorkIdentity) { return this.identities.resolveVerified(request, workId, identity); }
  registerPlatformMetadata(request: RequestContext, workId: string, metadata: { published_at?: string | null; format?: ContentFormat | null; evidence: JsonObject }) {
    assertRequestIdentity(this.context, request);
    if (!metadata.evidence || !Object.keys(metadata.evidence).length || (metadata.published_at != null && !Number.isFinite(Date.parse(metadata.published_at))) || (metadata.format != null && !FORMATS.includes(metadata.format))) throw new ContractError('VALIDATION_ERROR', '作品 metadata 须有有效字段及出处');
    return transaction(this.context.db, () => {
      const work = workView(this.context.db, request.workspace_id, workId);
      if (work.identity_status !== 'confirmed') throw new ContractError('CAPABILITY_UNVERIFIED', '先核对作者及平台身份');
      const published = metadata.published_at == null ? work.published_at : new Date(metadata.published_at).toISOString(), format = metadata.format ?? work.format;
      if ((work.published_at !== null && metadata.published_at != null && Date.parse(work.published_at) !== Date.parse(metadata.published_at)) || (work.format !== null && metadata.format != null && work.format !== metadata.format)) throw new ContractError('VALIDATION_ERROR', '已登记发布时间或形式冲突，需核对来源');
      this.context.db.prepare('UPDATE works SET published_at=?,format=?,format_source=?,updated_at=? WHERE workspace_id=? AND id=?').run(published, format, metadata.format != null ? 'platform_metadata' : work.format_source, new Date().toISOString(), request.workspace_id, work.id);
      this.context.db.prepare("INSERT INTO evidence_links(id,workspace_id,owner_type,owner_id,source_type,source_id,locator) VALUES (?,?,'work',?,'identity_observation',?,?)").run(randomUUID(), request.workspace_id, work.id, work.id, JSON.stringify({ kind: 'platform_metadata', published_at: published, format, evidence: metadata.evidence }));
      return workView(this.context.db, request.workspace_id, workId);
    });
  }
  identityCheck(request: RequestContext, workId: string, jobId: string) {
    assertRequestIdentity(this.context, request); this.get(request, workId);
    const job = this.context.db.prepare("SELECT state,target_id,kind FROM jobs WHERE workspace_id=? AND id=?").get(request.workspace_id, jobId);
    if (!job || job.target_id !== workId || job.kind !== 'metrics_identity_check' || job.state !== 'succeeded') throw new ContractError('CAPABILITY_UNVERIFIED', '身份核对尚未取得已验证的 resolver 结果', { reason: 'identity_resolver_unverified' });
    // 不能把 URL 候选或通用任务的自报结果变成 verified identity。
    throw new ContractError('CAPABILITY_UNVERIFIED', '真实身份 resolver 尚未装配', { reason: 'identity_resolver_unverified' });
  }
}
