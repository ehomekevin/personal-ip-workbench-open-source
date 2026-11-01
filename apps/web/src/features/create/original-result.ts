import type { JobDetailResponse, JobsRow, JsonObject, TopicDetail } from '@workbench/contracts';
import type { FeatureContext } from '../../transport/feature-ports.ts';

export interface PlatformOriginalTask { jobId: string; variantId: string; canQuery: boolean; message: string }
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);

// 这里只决定入口可用性；原身份、固定输入和消费权限仍由服务重新核对。
export function originalResultState(detail: JobDetailResponse): { canQuery: boolean; message: string } {
  const job = detail.job, error = detail.error, details = object(error?.details) ? error.details : {};
  if (error?.code === 'HOST_INTERRUPTED' || details.native_status === 'interrupted') return { canQuery: false, message: '原任务已中断，没有可回收的最终结果。原稿和输入已保留；重新制作需另行操作。' };
  if (details.original_result_unavailable === true) return { canQuery: false, message: '原任务没有可回收的完整最终结果。原稿和输入已保留；重新制作需另行操作。' };
  if (job.cancel_requested_at || ['cancelled', 'cancel_requested'].includes(job.state)) return { canQuery: false, message: '原任务已取消，当前稿件保留。' };
  if (['queued', 'running', 'reconciling'].includes(job.state)) return { canQuery: false, message: '原任务仍在执行或核对中，稍后可查看结果。' };
  if (job.state === 'succeeded') return { canQuery: false, message: '原任务已有结果，正在读取稿件记录。' };
  if (job.kind !== 'variant_generate' || job.execution_mode !== 'service_adapter' || job.executor_id !== 'codex') return { canQuery: false, message: '此任务暂不支持核对原结果，原稿和输入已保留。' };
  const handle = detail.checkpoint?.agent_handle;
  if (!object(handle) || typeof handle.runtime_session_id !== 'string' || !handle.runtime_session_id || typeof handle.runtime_turn_id !== 'string' || !handle.runtime_turn_id) return { canQuery: false, message: '原任务记录不完整，暂时无法核对。原稿和输入已保留。' };
  return { canQuery: ['failed', 'waiting_input', 'waiting_quota'].includes(job.state), message: '上次制作未完成，可先核对原结果；已有输入和稿件保留。' };
}

export async function readPlatformOriginalTask(context: FeatureContext, variantId: string): Promise<PlatformOriginalTask | undefined> {
  // Jobs are paged oldest first. Read the full target stream so a refreshed page
  // never offers an old failure after a newer result has already been saved.
  let cursor: string | null = null, job: JobsRow | undefined;
  const seen = new Set<string>();
  do {
    const page: { items: JobsRow[]; next_cursor?: string | null } = await context.client.request('GET', '/api/v1/jobs?target_id=' + encodeURIComponent(variantId) + '&kind=variant_generate&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), undefined, { signal: context.readSignal ?? context.signal });
    for (const item of page.items ?? []) if (item.target_id === variantId && item.kind === 'variant_generate') job = item;
    cursor = page.next_cursor ?? null;
    if (cursor && seen.has(cursor)) throw new Error('任务分页游标未前进');
    if (cursor) seen.add(cursor);
  } while (cursor);
  if (!job || job.target_id !== variantId || job.kind !== 'variant_generate' || job.state === 'succeeded') return undefined;
  const detail = await context.client.request<JobDetailResponse>('GET', '/api/v1/jobs/' + encodeURIComponent(job.id), undefined, { signal: context.readSignal ?? context.signal });
  if (detail.job.id !== job.id || detail.job.target_id !== variantId || detail.job.kind !== 'variant_generate') throw new Error('平台任务归属已变化，请重新读取');
  return { jobId: job.id, variantId, ...originalResultState(detail) };
}

export function originalQueryAttributes(jobId: string, variantId: string): string {
  // Attribute values originate in service identities but still require HTML escaping.
  const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  return 'data-original-job="' + esc(jobId) + '" data-original-variant="' + esc(variantId) + '"';
}

export async function readOriginalVariantResult(context: FeatureContext, detail: JobDetailResponse, topicId: string, variantId: string, documentId: string): Promise<{ recovered: boolean; message: string }> {
  // Job succeeded can also mean a pending candidate. Only a committed, adopted
  // receipt matching the current target revision and core can report recovery.
  context.client.invalidateReads?.();
  const [topic, document] = await Promise.all([
    context.client.request<TopicDetail>('GET', '/api/v1/topics/' + encodeURIComponent(topicId), undefined, { signal: context.signal }),
    context.client.getDocument(documentId, context.signal),
  ]);
  const variant = topic.variants.find(value => value.id === variantId && value.document_id === documentId);
  const documents = detail.receipts.filter(receipt => receipt.state === 'committed').flatMap(receipt => object(receipt.result_ids) && Array.isArray(receipt.result_ids.documents) ? receipt.result_ids.documents : []).filter(object);
  const saved = documents.find(value => value.document_id === documentId && value.adopted === true && value.adoption_mode === 'auto_initial' && value.revision_id === document.head_revision_id);
  let frozen: JsonObject = {}; try { const parsed: unknown = JSON.parse(detail.job.input_manifest); if (object(parsed)) frozen = parsed; } catch { /* Missing trusted input cannot prove a restored target. */ }
  const target = Array.isArray(frozen.targets) ? frozen.targets.filter(object).find(value => value.document_id === documentId) : undefined;
  const coreFresh = target?.core_revision_id === topic.core.head_revision_id && topic.core_approval?.revision_id === topic.core.head_revision_id && variant?.based_on_core_revision_id === topic.core.head_revision_id;
  const recovered = detail.job.state === 'succeeded' && detail.job.target_id === variantId && !!saved && variant?.status === 'ready' && coreFresh && !!document.head_revision_id && !!document.hash && !!document.text.trim();
  return { recovered, message: recovered ? '原结果已恢复到这个平台，稿件已保存。' : '原结果已有记录，但没有替换当前稿。请核对待审候选、人工修改或核心稿变化。' };
}

export function originalQueryErrorMessage(error: unknown): string {
  const response = object(error) && object(error.response) && object(error.response.error) ? error.response.error : undefined;
  const details = response && object(response.details) ? response.details : {};
  if (response?.code === 'HOST_INTERRUPTED' || details.native_status === 'interrupted') return '原任务已中断，没有可回收的最终结果。原稿和输入已保留；重新制作需另行操作。';
  if (details.original_result_unavailable === true) return '原任务没有可回收的完整最终结果。原稿和输入已保留；重新制作需另行操作。';
  if (['INPUT_STALE', 'REVISION_CONFLICT', 'VERSION_CONFLICT'].includes(String(response?.code ?? ''))) return '稿件或任务状态已变化，本次未恢复。当前稿件保留，请重新读取后核对。';
  return '原结果暂未能确认，当前稿件和输入已保留。稍后可再次核对。';
}
