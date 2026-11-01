import type { WikiGenerationRequest, GenerationAccepted } from '@workbench/contracts';
import type { FeatureContext } from '../../../transport/feature-ports.ts';
import { candidateForJob, waitForegroundGeneration, readForegroundResult } from '../../create/ai-actions/index.ts';
export function createKnowledgeGenerationApi(context: FeatureContext) {
  return { async generate(input: WikiGenerationRequest) { const accepted = await context.client.request<GenerationAccepted>('POST', '/api/v1/wiki-generations', input, { signal: context.signal, idempotencyKey: crypto.randomUUID() }); if (!await waitForegroundGeneration(context, accepted, '整理知识候选', () => context.ui.page === 'knowledge', true)) return undefined; return readForegroundResult(context, accepted, () => candidateForJob(context, input.target_document_id, accepted.job_id), () => context.ui.page === 'knowledge'); }, async adopt(candidateId: string, baseRevision: string | null) { return context.client.request('POST', '/api/v1/candidates/'+encodeURIComponent(candidateId)+'/adoption', { expected_revision_id: baseRevision }, { signal: context.signal, idempotencyKey: crypto.randomUUID() }); } };
}
