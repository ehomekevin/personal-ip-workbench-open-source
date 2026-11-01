import { PLATFORMS, type TopicDetail, type DocumentSnapshot, type JsonObject, type Page, type Platform, type ContentFormat, type TopicSummary, type JobDetailResponse, type JobsRow } from '@workbench/contracts';
import type { FeatureAction, FeatureContext, PageFeaturePort } from '../../../transport/feature-ports.ts';
import type { ViewContext, TopicView, VariantView } from '../../../app/view-model.ts';
import type { DocumentDraft, DraftStatus } from '../../../transport/drafts.ts';
import { createTemplateHelpers } from '../../../components/templateHelpers.ts';
import { P } from '../../../components/metadata.ts';
import {DEFAULT_FORMAT,projectTopicSummary} from '../../../transport/topic-summary.ts';
import { waitForegroundGeneration, readForegroundResult, candidateForJob, showCandidate, writingSkillLabel, type CandidatePreview, type AcceptedGeneration } from '../ai-actions/index.ts';
import { originalResultState, originalQueryErrorMessage, readOriginalVariantResult, readPlatformOriginalTask, type PlatformOriginalTask } from '../original-result.ts';
export interface ContentDocumentsOptions { loadBase(context: FeatureContext): Promise<ViewContext>; dispatchRelated?(action: FeatureAction, context: FeatureContext): Promise<ViewContext | void> }
const path = encodeURIComponent;
interface HistoricalRevision { revision_id: string; parent_revision_id: string | null; text: string }
function split(text: string, fallback: string) { const heading = /^# (.+)\n\n/.exec(text); return heading ? { title: heading[1]!, text: text.slice(heading[0].length) } : { title: fallback, text }; }
const SAVE_LABEL: Record<DraftStatus, string> = { committed: '已保存', dirty: '待保存', saving: '正在保存…', offline: '未提交副本已保留，等待恢复', conflict: '正文已变化，未提交副本已保留' };
export function createContentDocumentsFeaturePort(options: ContentDocumentsOptions): PageFeaturePort<'create'> {
  let latest: ViewContext | undefined, topics: TopicDetail[] = [], generation = 0, editorGeneration = 0; const snapshots = new Map<string, DocumentSnapshot>(), drafts = new Map<string, DocumentDraft>(); let generating = false; let preview: CandidatePreview | undefined, restore: { document: string; revision: string; topic:string; platform:string } | undefined;
  const selected = (context: FeatureContext) => topics.find(topic => topic.id === context.ui.topic) ?? (latest?.state.topics.some(topic=>topic.id===context.ui.topic)?undefined:topics[0]);
  const variant = (context: FeatureContext) => selected(context)?.variants.find(v => v.platform === context.ui.platform && v.format === DEFAULT_FORMAT[context.ui.platform as Platform]);
  function attach(context: FeatureContext, snapshot: DocumentSnapshot, core: boolean) {
    const own = editorGeneration;
    const draft = context.drafts.attach(snapshot, status => {
      if (context.signal.aborted || context.ui.page !== 'create' || own !== editorGeneration) return;
      const active = context.ui.editTab === 'versions' ? String(variant(context)?.document_id ?? '') : context.ui.editTab === 'core' ? selected(context)?.core_document_id : undefined;
      if (active !== snapshot.document_id) return;
      context.surface.editorFeedback({ saveState: SAVE_LABEL[status], ...(core && status !== 'committed' ? { coreStatus: '已修改，请重新确认；平台稿件保留原版本', generationEnabled: false, confirmationLabel: '确认核心稿' } : {}) });
    }); drafts.set(snapshot.document_id, draft); return draft;
  }
  async function load(context: FeatureContext): Promise<ViewContext> {
    const own=++generation,base=await options.loadBase(context);if(base.provenance!=='service')throw new Error('创作文稿只接受 service 数据');
    const listed:TopicSummary[]=[];let cursor:string|null=null;
    do{const page:Page<TopicSummary>=await context.client.request('GET','/api/v1/topics'+(cursor?'?cursor='+path(cursor):''),undefined,{signal:context.signal});listed.push(...page.items);cursor=page.next_cursor;context.signal.throwIfAborted();}while(cursor);
    const ui={...context.ui,topic:listed.some(topic=>topic.id===context.ui.topic)?context.ui.topic:listed[0]?.id??''};
    // Old services have no metadata projection. Schedule choices still need their
    // saved heads, so that compatibility path keeps the previous full read.
    const legacySchedule=ui.page==='schedule'&&listed.some(topic=>!topic.read_state);
    const targets=legacySchedule?listed:listed.filter(topic=>topic.id===ui.topic);
    const loaded=await Promise.all(targets.map(topic=>context.client.request<TopicDetail>('GET','/api/v1/topics/'+path(topic.id),undefined,{signal:context.signal})));
    const current=loaded.find(topic=>topic.id===ui.topic),metadata=listed.find(topic=>topic.id===ui.topic)?.read_state;
    const readAllVariants=legacySchedule||!metadata;
    const selectedPlatform=metadata?.variants.some(v=>v.platform===ui.platform&&v.format===DEFAULT_FORMAT[ui.platform as Platform])?ui.platform:metadata?.variants.find(v=>v.head_revision_id&&v.format===DEFAULT_FORMAT[v.platform])?.platform??metadata?.variants.find(v=>v.format===DEFAULT_FORMAT[v.platform])?.platform;
    if(ui.editTab==='versions'&&selectedPlatform)ui.platform=selectedPlatform;
    const variantTargets=readAllVariants?loaded.flatMap(topic=>topic.variants):ui.page==='create'&&ui.editTab==='versions'?(current?.variants.filter(v=>v.platform===ui.platform&&v.format===DEFAULT_FORMAT[ui.platform as Platform])??[]):[];
    const docs=await Promise.all(variantTargets.map(v=>context.client.getDocument(String(v.document_id),context.signal)));context.signal.throwIfAborted();if(own!==generation)return latest??base;
    let originalTask: PlatformOriginalTask | undefined;
    const activeVariant = ui.page === 'create' && ui.editTab === 'versions' ? current?.variants.find(v => v.platform === ui.platform && v.format === DEFAULT_FORMAT[ui.platform as Platform]) : undefined;
    if (activeVariant) {
      try { originalTask = await readPlatformOriginalTask(context, String(activeVariant.id)); }
      catch (error) { context.signal.throwIfAborted(); if (context.readSignal?.aborted) throw error; originalTask = { jobId: '', variantId: String(activeVariant.id), canQuery: false, message: '上次制作记录暂时未能读取，稿件和输入保留。请稍后重新打开平台页。' }; }
      if (own !== generation) return latest ?? base;
    }
    topics=loaded;snapshots.clear();for(const doc of [...loaded.map(topic=>topic.core),...docs])snapshots.set(doc.document_id,doc);
    editorGeneration=own;if(current){attach(context,current.core,true);for(const v of current.variants){const doc=snapshots.get(String(v.document_id));if(doc)attach(context,doc,false);}}
    const viewTopics:TopicView[]=listed.map(summary=>{
      const t=loaded.find(topic=>topic.id===summary.id),projected=projectTopicSummary(summary);if(drafts.get(summary.core_document_id)?.status&&drafts.get(summary.core_document_id)?.status!=='committed')projected.confirmed=false;if(!t)return projected;
      const versions={...projected.versions};for(const v of t.variants){if(v.format!==DEFAULT_FORMAT[v.platform as Platform])continue;const doc=snapshots.get(String(v.document_id)),known=summary.read_state?.variants.find(row=>row.id===v.id);
        if (!doc && known?.head_revision_id) continue;
        if (!doc?.head_revision_id) {
          // Existing empty variants stay in the platform tabs. Otherwise a
          // saved platform could hide the failed empty platform on refresh.
          versions[String(v.platform)] = { title: t.title, text: doc ? drafts.get(doc.document_id)?.value() ?? doc.text : '', rev: doc?.version ?? 1, edited: false, status: originalTask?.variantId === v.id ? '上次制作未完成' : '平台稿为空', contentLoaded: !!doc, ...(originalTask?.variantId === v.id ? { originalTask } : {}) };
          continue;
        }
        const content=split(drafts.get(doc.document_id)?.value()??doc.text,t.title);
        versions[String(v.platform)]={...content,rev:doc.version,edited:true,status:v.based_on_core_revision_id===t.core.head_revision_id&&t.core_approval?'已保存':'核心稿已变化',contentLoaded:true,historyAvailable:known?!!known.parent_revision_id:true,...(originalTask?.variantId === v.id ? { originalTask } : {})};
      }
      return {...projected,source:t.source_ids[0]??'',confirmed:!!t.core_approval&&!(drafts.get(t.core_document_id)?.status!==undefined&&drafts.get(t.core_document_id)?.status!=='committed'),coreRev:t.core.version,core:drafts.get(t.core_document_id)?.value()??t.core.text,versions,detailsLoaded:true,assets:base.state.topics.find(old=>old.id===t.id)?.assets??[],shots:t.shots.map(shot=>({title:shot.title,kind:shot.kind,duration:shot.duration_ms/1000,status:'已保存'})),preparation:{plan_id:t.preparation_plan_id,shot_keys:[...t.shots].sort((a,b)=>a.position-b.position).map(shot=>shot.shot_key)}};
    });
    const clean=!current||drafts.get(current.core_document_id)?.status==='committed',active=ui.editTab==='versions'?String(current?.variants.find(v=>v.platform===ui.platform&&v.format===DEFAULT_FORMAT[ui.platform as Platform])?.document_id??''):current?.core_document_id;
    latest={...base,ui,state:{...base.state,topics:viewTopics},editorFeedback:{saveState:SAVE_LABEL[drafts.get(active??'')?.status??'committed'],coreStatus:current?.core_approval&&clean?'当前核心稿已确认':'核心稿等待确认',generationEnabled:!!current?.core_approval&&clean,confirmationLabel:'确认核心稿'}};return latest;
  }
  async function saved(context: FeatureContext, document: string) { const draft = drafts.get(document); await draft?.flush(); context.client.invalidateReads?.(); if (draft && draft.status !== 'committed') throw new Error('先恢复未提交正文，再继续此操作'); const value = await context.client.getDocument(document, context.signal); snapshots.set(document, value); return value; }
  async function submit(context: FeatureContext, variant: JsonObject, mode: 'initialize' | 'candidate') {
    const topic = selected(context)!; await saved(context, topic.core_document_id); const doc = await saved(context, String(variant.document_id)), core = await context.client.getDocument(topic.core_document_id, context.signal);
    const accepted = await context.client.request<AcceptedGeneration>('POST', '/api/v1/variants/' + path(String(variant.id)) + '/generation', { core_revision_id: core.head_revision_id, base_revision_id: doc.head_revision_id, mode, source_ids: sourceIds(topic), ...(context.skillSelection?.('variant',variant.platform as Platform) ? {skill_route:context.skillSelection('variant',variant.platform as Platform)} : {}), executor: latest?.state.agent === 'claude' ? 'claude' : 'codex' }, { signal: context.signal, idempotencyKey: crypto.randomUUID() });
    return { accepted, document_id: doc.document_id };
  }
  async function follow(context: FeatureContext, submitted: { accepted: AcceptedGeneration; document_id: string }, title = '制作平台版本', batch?: { stopped: boolean }) {
    // 只有关闭、Esc、离开页面停止整批；“取消任务”只取消当前任务，继续跟随下一平台。
    const stop = (reason: string) => { if (batch && reason !== 'cancel') batch.stopped = true; };
    const topic = selected(context)!, own = generation, relevant = () => !context.signal.aborted && context.ui.page === 'create' && context.ui.topic === topic.id && generation === own, { accepted } = submitted;
    const completed = await waitForegroundGeneration(context, accepted, title, relevant, true, undefined, { keepWhenIrrelevant: !!batch, onDismiss: stop }); if (!completed || !relevant()) return false; const candidate = await readForegroundResult(context, accepted, () => candidateForJob(context, submitted.document_id, accepted.job_id), relevant, stop); if (!candidate || !relevant()) return false; if (!candidate.adoption_mode) { preview = candidate; showCandidate(context, candidate, 'apply-version', '新版平台草稿'); } return true;
  }
  async function generate(context: FeatureContext, variant: JsonObject, mode: 'initialize' | 'candidate') { return follow(context, await submit(context, variant, mode)); }
  async function queryOriginal(context: FeatureContext, jobId: string, variantId: string) {
    const topicId = selected(context)!.id, own = generation, relevant = () => !context.signal.aborted && context.ui.page === 'create' && context.ui.topic === topicId && generation === own;
    const { btn, esc } = createTemplateHelpers([]), visible = () => relevant() && (context.surface.isForegroundJobActive?.(jobId) ?? false), present = (message: string) => { context.surface.closeDialog('completed'); context.surface.presentDialog({ title: '核对原结果', body: '<p class="fine">' + esc(message) + '</p>', foot: btn('知道了', 'close-dialog') }); };
    // Own the viewing session before the first HTTP read. Closing during that
    // read or the resume POST must not reopen a late result or cancel the job.
    context.surface.presentDialog({ title: '核对原结果', body: '<p class="fine">正在读取原任务…</p>', generationProgress: { state: 'running', message: '正在读取原任务…', note: '只核对原任务，不会重新生成；当前稿件保留。' }, foot: btn('停止查看', 'close-dialog'), foregroundJob: { id: jobId, version: 1, keepOnDismiss: true } });
    try {
      const current = await context.client.request<TopicDetail>('GET', '/api/v1/topics/' + path(topicId), undefined, { signal: context.signal });
      if (!visible()) return;
      const target = current.variants.find(value => value.id === variantId);
      if (!target) throw new Error('平台任务不属于当前主题');
      for (const documentId of [current.core_document_id, String(target.document_id)]) {
        const status = context.drafts.status(documentId);
        if (status && status !== 'committed') { present('当前正文尚未保存，先处理保存状态，再核对原结果。已有输入保留。'); return; }
      }
      context.client.invalidateReads?.();
      const detail = await context.client.request<JobDetailResponse>('GET', '/api/v1/jobs/' + path(jobId), undefined, { signal: context.signal });
      if (!visible()) return;
      if (detail.job.id !== jobId || detail.job.target_id !== variantId || detail.job.kind !== 'variant_generate') throw new Error('平台任务归属已变化');
      if (detail.job.state === 'succeeded') { const result = await readOriginalVariantResult(context, detail, topicId, variantId, String(target.document_id)); if (visible()) present(result.message); return; }
      const state = originalResultState(detail);
      if (!state.canQuery) { present(state.message); return; }
      await context.client.request<JobsRow>('POST', '/api/v1/jobs/' + path(jobId) + '/resume', { expected_version: detail.job.version, recovery_action: 'query_original' }, { signal: context.signal, idempotencyKey: crypto.randomUUID() });
      if (!visible()) return;
      context.client.invalidateReads?.();
      const accepted = { job_id: jobId }, completed = await waitForegroundGeneration(context, accepted, '核对原结果', relevant, true, { queued: '等待核对原任务…', running: '正在核对原任务的结果…', note: '只核对原任务，不会重新生成；当前稿件保留。' }, { keepWhenIrrelevant: true, queryOriginal: true });
      if (!completed || !relevant()) return;
      const result = await readForegroundResult(context, accepted, () => readOriginalVariantResult(context, completed, topicId, variantId, String(target.document_id)), relevant);
      if (result && relevant()) present(result.message);
    } catch (error) { if (visible()) present(originalQueryErrorMessage(error)); }
  }
  function sourceIds(topic: TopicDetail): string[] { return topic.source_ids; }
  return { page: 'create', load, async input(action, context) { const topic = selected(context); if (!topic) return; if (action.action === 'agent-select') { if (latest) latest.state.agent = String(action.fields['agent-select'] ?? 'codex'); return; } if (action.action === 'core-editor') { const draft = drafts.get(topic.core_document_id) ?? attach(context, topic.core, true); draft.edit(String(action.fields['core-editor'] ?? '')); if (latest) { const view = latest.state.topics.find(t => t.id === topic.id)!; view.core = draft.value(); view.confirmed = false; } return; } if (action.action === 'version-title' || action.action === 'version-text') { const v = variant(context); if (!v) return; const doc = snapshots.get(String(v.document_id))!, draft = drafts.get(doc.document_id) ?? attach(context, doc, false), fields = split(draft.value(), topic.title); draft.edit('# '+String(action.fields['version-title'] ?? fields.title)+'\n\n'+String(action.fields['version-text'] ?? fields.text)); if (latest) latest.state.topics.find(t => t.id === topic.id)!.versions[context.ui.platform] = { ...fields, title: String(action.fields['version-title'] ?? fields.title), text: String(action.fields['version-text'] ?? fields.text), rev: doc.version, edited: true, status: '待保存' }; } }, async dispatch(action, context) {
    const topic = selected(context); if (action.action === 'select-topic') { context.surface.updateUi({ topic: action.dataset.id ?? '' }); return load(context); } if (!topic) return options.dispatchRelated?.(action, context);
    if (action.action === 'edit-tab' || action.action === 'platform-tab' || action.action === 'back-core') { await context.drafts.leave(); context.surface.updateUi(action.action === 'platform-tab' ? { platform: action.dataset.value ?? 'xiaohongshu', slide: 0 } : { editTab: action.action === 'back-core' ? 'core' : action.dataset.value ?? 'core' }); return load(context); }
    if (action.action === 'confirm-core') { const core = await saved(context, topic.core_document_id); if (!core.head_revision_id || !core.text.trim()) throw new Error('核心稿为空，请先补充'); await context.client.request('POST', '/api/v1/topics/' + path(topic.id) + '/core-approvals', { revision_id: core.head_revision_id }, { signal: context.signal, idempotencyKey: crypto.randomUUID() }); return load(context); }
    if (action.action === 'ai-suggest') { if (generating) return; generating = true; try { const own = generation, relevant = () => !context.signal.aborted && context.ui.page === 'create' && context.ui.topic === topic.id && generation === own; const core = await saved(context, topic.core_document_id), accepted = await context.client.request<AcceptedGeneration>('POST', '/api/v1/documents/' + path(topic.core_document_id) + '/ai-edits', { base_revision_id: core.head_revision_id, source_ids: sourceIds(topic), ...(context.skillSelection?.('core') ? {skill_route:context.skillSelection('core')} : {}), instruction: String(action.fields['agent-request'] ?? '').trim() || '整理固定资料，保留人工内容，指出待补充的实测依据。', executor: latest?.state.agent === 'claude' ? 'claude' : 'codex' }, { signal: context.signal, idempotencyKey: crypto.randomUUID() }); const completed = await waitForegroundGeneration(context, accepted, '修改建议 · 先预览', relevant, true); if (completed && relevant()) { const candidate = await readForegroundResult(context, accepted, () => candidateForJob(context, topic.core_document_id, accepted.job_id), relevant); if (relevant() && candidate) { preview = candidate; showCandidate(context, preview, 'apply-suggestion', '修改建议 · 先预览', writingSkillLabel(completed)); } } return; } finally { generating = false; } }
    if (action.action === 'apply-suggestion' || action.action === 'apply-version') { if (!preview || action.dataset.candidate && action.dataset.candidate !== preview.id) throw new Error('候选预览已变化，请重新读取'); await saved(context, preview.target_document_id); await context.client.request('POST', '/api/v1/candidates/' + path(preview.id) + '/adoption', { expected_revision_id: preview.base_revision_id }, { signal: context.signal, idempotencyKey: crypto.randomUUID() }); preview = undefined; context.surface.closeDialog('completed'); return load(context); }
    if (action.action === 'generate-versions') { const { btn, esc, platformBadge } = createTemplateHelpers([]); await saved(context, topic.core_document_id); context.surface.presentDialog({ title: '制作平台版本', body: '<p class="fine" style="margin-bottom:8px">选择本条适合的平台，已有稿件保留，新增平台从当前核心稿开始。</p>'+PLATFORMS.map(p => '<label class="check-row"><input type="checkbox" name="platform" value="'+p+'" checked><div><strong>'+esc(P[p].name)+'</strong><small>'+esc(P[p].type)+(topic.variants.some(v => v.platform === p) ? ' · 已有版本' : '')+'</small></div>'+platformBadge(p)+'</label>').join(''), foot: btn('取消', 'close-dialog') + btn('生成平台版本', 'do-generate', true) }); return; }
    if (action.action === 'do-generate') { if (generating) return; generating = true; try { const platforms = PLATFORMS.filter(p => action.fields['platform:'+p] === true); if (!platforms.length) throw new Error('至少选择一个平台'); const pending: Array<{ platform: Platform; variant: JsonObject }> = []; for (const p of platforms) { const v = topic.variants.find(v => v.platform === p && v.format === DEFAULT_FORMAT[p]) ?? await context.client.request<JsonObject>('POST', '/api/v1/topics/' + path(topic.id) + '/variants', { platform: p, format: DEFAULT_FORMAT[p] }, { signal: context.signal, idempotencyKey: crypto.randomUUID() }); const doc = await context.client.getDocument(String(v.document_id), context.signal); if (!doc.head_revision_id) pending.push({ platform: p, variant: v }); }
      // 勾选的平台一次全部提交，由服务按并发上限执行、其余排队；单个提交失败不影响其他平台。前台进度按平台依次跟随。
      const submitted = await Promise.allSettled(pending.map(item => submit(context, item.variant, 'initialize')));
      submitted.forEach((result, index) => { if (result.status === 'rejected') context.surface.toast(P[pending[index]!.platform].name + '：' + (result.reason instanceof Error ? result.reason.message : '提交未完成')); });
      const accepted = submitted.flatMap((result, index) => result.status === 'fulfilled' ? [{ ...result.value, platform: pending[index]!.platform }] : []);
      // 用户关闭或离开即停止跟随整批（本地标志），不从任务状态反推；失败/取消的任务只跳到下一个。
      const batch = { stopped: false };
      for (const [index, item] of accepted.entries()) { const title = accepted.length > 1 ? '制作平台版本 · ' + P[item.platform].name + '（' + (index + 1) + '/' + accepted.length + '）' : '制作平台版本'; await follow(context, item, title, batch); if (batch.stopped) return load(context); }
      context.surface.updateUi({ editTab: 'versions', platform: platforms[0]!, slide: 0 }); return load(context); } finally { generating = false; } }
    if (action.action === 'regenerate-version') { if (generating) return; generating = true; try { if (action.dataset.originalJob !== undefined || action.dataset.originalVariant !== undefined) { if (!action.dataset.originalJob || !action.dataset.originalVariant) throw new Error('原任务入口不完整，请重新读取'); await queryOriginal(context, action.dataset.originalJob, action.dataset.originalVariant); return load(context); } const v = variant(context); if (v) await generate(context, v, 'candidate'); return; } finally { generating = false; } }
    if (action.action === 'previous-version') {
      const v=variant(context);if(!v)return;const own=generation,owner=topic.id,platform=context.ui.platform,visible=()=>generation===own&&context.ui.topic===owner&&context.ui.platform===platform&&context.ui.page==='create'&&!context.signal.aborted&&!context.readSignal?.aborted;
      const doc=await saved(context,String(v.document_id));if(!visible()||!doc.head_revision_id)return;
      const current=await context.client.request<HistoricalRevision>('GET','/api/v1/documents/'+path(doc.document_id)+'/revisions/'+path(doc.head_revision_id),undefined,{signal:context.signal});if(!visible())return;
      if(!current.parent_revision_id){context.surface.toast('当前没有可恢复的上版稿');return;}
      const old=await context.client.request<{text:string}>('GET','/api/v1/documents/'+path(doc.document_id)+'/revisions/'+path(current.parent_revision_id),undefined,{signal:context.signal});if(!visible())return;
      restore={document:doc.document_id,revision:current.parent_revision_id,topic:owner,platform};const {esc,btn}=createTemplateHelpers([]);context.surface.presentDialog({title:'上版平台稿',body:'<p class="fine">上版修订 '+esc(current.parent_revision_id)+'</p><div class="separator"></div><div class="social-preview">'+esc(old.text)+'</div>',foot:btn('保留当前版','close-dialog')+btn('恢复这一版','restore-version',true)});return;
    }
    if (action.action === 'restore-version') {const intent=restore;if(!intent)return;const own=generation,visible=()=>own===generation&&context.ui.topic===intent.topic&&context.ui.platform===intent.platform&&context.ui.page==='create'&&!context.signal.aborted&&!context.readSignal?.aborted;if(!visible())throw new Error('主题或平台已变化，请重新打开上版稿');const current=await saved(context,intent.document);if(!visible())return;await context.client.request('POST','/api/v1/documents/'+path(intent.document)+'/restores',{expected_revision_id:current.head_revision_id,revision_id:intent.revision},{signal:context.signal,idempotencyKey:crypto.randomUUID()});if(!visible()||restore!==intent)return;restore=undefined;context.surface.closeDialog('completed');return load(context);}
    return options.dispatchRelated?.(action, context);
  } };
}
