import { randomUUID } from 'node:crypto';
import { ContractError, PLATFORMS, FORMATS, type ImportWorkRequest, type RequestContext } from '@workbench/contracts';
import { transaction } from '@workbench/storage/connection';
import { canonicalWorkId, getWork, canonicalWorks, resolveVerifiedWorkIdentity, type VerifiedWorkIdentity } from '@workbench/storage/identity';
import { readIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import type { ApplicationContext, IdentityPort } from '../ports/index.ts';
import { assertRequestIdentity } from '../documents/index.ts';

export function normalizeWorkUrl(raw: string): string {
  let url: URL; try { url = new URL(raw); } catch { throw new ContractError('VALIDATION_ERROR', '作品 URL 无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ContractError('VALIDATION_ERROR', '作品 URL 不能包含凭据');
  for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_') || ['fbclid', 'gclid'].includes(key)) url.searchParams.delete(key);
  return url.toString();
}
export class Identities implements IdentityPort {
  readonly context: ApplicationContext;
  constructor(context: ApplicationContext) { this.context = context; }
  async importWork(request: RequestContext, input: ImportWorkRequest) {
    assertRequestIdentity(this.context, request);
    if (!PLATFORMS.includes(input.platform) || (input.format != null && !FORMATS.includes(input.format))) throw new ContractError('VALIDATION_ERROR', '平台或形式无效');
    const url = normalizeWorkUrl(input.url);
    return transaction(this.context.db, () => {
      const replay = readIdempotent<{ work_id: string; identity_status: string }>(this.context.db, request, 'works.import', input); if (replay) return replay;
      const existing = this.context.db.prepare('SELECT id,identity_status FROM works WHERE workspace_id=? AND platform=? AND url=? ORDER BY canonical_work_id IS NOT NULL,id LIMIT 1').get(request.workspace_id, input.platform, url);
      const workId = existing ? String(existing.id) : randomUUID();
      if (!existing) this.context.db.prepare("INSERT INTO works (id,workspace_id,platform,url,topic_id,format,format_source,origin,identity_status) VALUES (?,?,?,?,?,?,?,'import','pending')")
        .run(workId, request.workspace_id, input.platform, url, input.topic_id ?? null, input.format ?? null, input.format ? 'human_classification' : null);
      const result = { work_id: canonicalWorkId(this.context.db, request.workspace_id, workId), identity_status: existing ? String(existing.identity_status) : 'pending' };
      storeIdempotent(this.context.db, request, 'works.import', input, result); return result;
    });
  }
  async resolveCanonical(request: RequestContext, workId: string): Promise<string> {
    assertRequestIdentity(this.context, request); return canonicalWorkId(this.context.db, request.workspace_id, workId);
  }
  resolveVerified(request: RequestContext, workId: string, input: VerifiedWorkIdentity) {
    assertRequestIdentity(this.context, request); return resolveVerifiedWorkIdentity(this.context.db, request.workspace_id, workId, input);
  }
  get(request: RequestContext, workId: string) {
    assertRequestIdentity(this.context, request); const source = getWork(this.context.db, request.workspace_id, workId);
    const canonical = getWork(this.context.db, request.workspace_id, canonicalWorkId(this.context.db, request.workspace_id, workId));
    return { ...canonical, source_work_id: source.id,
      aliases: this.context.db.prepare('SELECT alias_work_id,source_url,resolution_evidence FROM work_aliases WHERE workspace_id=? AND canonical_work_id=? ORDER BY id').all(request.workspace_id, canonical.id) };
  }
  list(request: RequestContext) {
    assertRequestIdentity(this.context, request); return { items: canonicalWorks(this.context.db, request.workspace_id),
      next_cursor: null, has_more: false, last_success_at: new Date().toISOString() };
  }
}
