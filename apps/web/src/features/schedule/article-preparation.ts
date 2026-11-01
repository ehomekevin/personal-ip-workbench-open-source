import type { AssetsRow, ContentPlanSnapshot, CreateContentPlanRequest, DocumentSnapshot, Page, TopicDetail } from '@workbench/contracts';
import type { FeatureContext, FeatureAction } from '../../transport/feature-ports.ts';
import { createTemplateHelpers } from '../../components/templateHelpers.ts';

const { esc, btn } = createTemplateHelpers([]);
export function articlePlanInput(variantId: string, variantRevision: string, titleRevision: string, coverAsset: string): CreateContentPlanRequest {
  return { variant_id: variantId, variant_revision_id: variantRevision, format: 'article', title_revision_id: titleRevision, cover_asset_id: coverAsset, units: [{ unit_key: 'article-body', position: 0, kind: 'block', text_revision_id: variantRevision, asset_refs: [], layout: {} }], preset: 'wp05-local/1', renderer: { id: 'wp19-local-render', version: '1' } };
}
interface ArticleDraft { topicId: string; variantId: string; variantRevision: string; approvalId: string; assets: AssetsRow[]; plan?: ContentPlanSnapshot; keys: Map<string, { title: string; plan: string }> }
export function createArticlePreparation() {
  let draft: ArticleDraft | undefined;
  async function topic(context: FeatureContext, id: string) { return context.client.request<TopicDetail>('GET', '/api/v1/topics/' + encodeURIComponent(id), undefined, { signal: context.signal }); }
  return { async dispatch(action: FeatureAction, context: FeatureContext): Promise<boolean> {
    if (action.action === 'prepare-article') {
      const current = await topic(context, action.dataset.topic ?? context.ui.topic), variants = current.variants.filter(v => v.platform === 'wechat' && v.format === 'article');
      if (!current.core_approval?.approval_id) throw new Error('先确认核心稿，再准备公众号定稿');
      if (variants.length !== 1) throw new Error('先保存一个明确的公众号文章版本');
      const variant = variants[0]!, [document, assets, plans] = await Promise.all([
        context.client.getDocument(String(variant.document_id), context.signal),
        context.client.request<Page<AssetsRow>>('GET', '/api/v1/assets?topic_id=' + encodeURIComponent(current.id), undefined, { signal: context.signal }),
        context.client.request<Page<ContentPlanSnapshot>>('GET', '/api/v1/variants/' + encodeURIComponent(String(variant.id)) + '/content-plans', undefined, { signal: context.signal }),
      ]);
      if (!document.head_revision_id || !document.text.trim()) throw new Error('先保存公众号正文');
      if (plans.items.length > 1) throw new Error('当前稿件有多个内容计划，需要先明确选择');
      const images = assets.items.filter(a => ['ready', 'referenced'].includes(a.status) && a.mime.startsWith('image/')), plan = plans.items[0];
      let title = Array.from(current.title).length <= 32 ? current.title : '';
      if (plan?.head.title_revision_id) { const ref = plan.head.texts.find(t => t.revision_id === plan.head.title_revision_id); if (ref) title = (await context.client.getDocument(ref.document_id, context.signal)).text; }
      draft = { topicId: current.id, variantId: String(variant.id), variantRevision: document.head_revision_id, approvalId: String(current.core_approval.approval_id), assets: images, keys: new Map(), ...(plan ? { plan } : {}) };
      context.surface.presentDialog({ title: '准备公众号定稿', body: '<p class="fine">标题、封面和当前已保存正文组成这次定稿。保存定稿后再选择发布账号与时间。</p><label class="field-label" for="article-title">标题 · 最多 32 字</label><input class="field" id="article-title" value="' + esc(title) + '" style="width:100%"><label class="field-label" for="article-cover">封面</label><select class="field" id="article-cover" style="width:100%"><option value="">请选择封面</option>' + images.map(a => '<option value="' + esc(a.id) + '" ' + (plan?.head.cover_asset_id === a.id ? 'selected' : '') + '>' + esc(a.file_path.split('/').at(-1) ?? a.id) + '</option>').join('') + '</select>' + (!images.length ? '<p class="fine">当前主题还没有可用图片，请先到创作页上传封面。</p>' : '') + '<div class="separator"></div><strong>本次正文</strong><div class="social-preview">' + esc(document.text) + '</div><p class="fine">' + (plan ? '保存会建立内容计划的新修订，旧版保留。' : '正文修改后，需重新准备定稿。') + '</p>', foot: btn('取消', 'close-dialog') + btn('保存定稿', 'save-article-plan', true) }); return true;
    }
    if (action.action !== 'save-article-plan') return false;
    if (!draft) throw new Error('请重新打开公众号定稿');
    const savedDraft = draft;
    const title = String(action.fields['article-title'] ?? '').trim(), cover = String(action.fields['article-cover'] ?? '');
    if (!title || Array.from(title).length > 32) throw new Error('标题需要 1 至 32 字');
    if (!savedDraft.assets.some(a => a.id === cover)) throw new Error('请选择当前主题中可用的封面');
    const current = await topic(context, savedDraft.topicId), variant = current.variants.find(v => v.id === savedDraft.variantId);
    if (!variant || current.core_approval?.approval_id !== savedDraft.approvalId) throw new Error('核心或平台稿已变化，请重新准备定稿');
    const document = await context.client.getDocument(String(variant.document_id), context.signal);
    if (document.head_revision_id !== savedDraft.variantRevision) throw new Error('正文已变化，请重新准备定稿');
    const signature = JSON.stringify([title, cover]); let keys = savedDraft.keys.get(signature);
    if (!keys) { keys = { title: crypto.randomUUID(), plan: crypto.randomUUID() }; savedDraft.keys.set(signature, keys); }
    const titleDocument = await context.client.request<DocumentSnapshot>('POST', '/api/v1/documents', { kind: 'publication_title', owner_entity_id: savedDraft.variantId, initial_text: title }, { signal: context.signal, idempotencyKey: keys.title });
    if (!titleDocument.head_revision_id) throw new Error('标题保存未完成');
    const input = articlePlanInput(savedDraft.variantId, savedDraft.variantRevision, titleDocument.head_revision_id, cover);
    if (savedDraft.plan) {
      const { variant_id: ignored, ...fields } = input;
      await context.client.request('PATCH', '/api/v1/content-plans/' + encodeURIComponent(savedDraft.plan.id), { ...fields, expected_version: savedDraft.plan.version, base_content_revision_id: savedDraft.plan.head_content_revision_id }, { signal: context.signal, idempotencyKey: keys.plan });
    } else await context.client.request('POST', '/api/v1/content-plans', input, { signal: context.signal, idempotencyKey: keys.plan });
    if (draft === savedDraft) { draft = undefined; context.surface.closeDialog('completed'); context.surface.toast('公众号定稿已保存；发布前核对账号与连接'); } return true;
  } };
}
