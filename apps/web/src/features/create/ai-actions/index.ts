import type { CandidatesRow, JobDetailResponse, JobsRow } from '@workbench/contracts';
import type { FeatureContext, GenerationProgressView, ForegroundDismissReason } from '../../../transport/feature-ports.ts';
import { createTemplateHelpers } from '../../../components/templateHelpers.ts';
import { jobIssueCopy, jobStateLabel } from '../../../components/job-copy.ts';
import { originalResultState, originalQueryAttributes } from '../original-result.ts';
export interface CandidatePreview extends CandidatesRow { text: string }
export interface AcceptedGeneration { job_id: string; document_id?: string; run_id?: string; report_id?: string }
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => { const done = () => { signal.removeEventListener('abort', abort); resolve(); }, timer = setTimeout(done, ms), abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); }; if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); });
// 从实际原生执行 checkpoint 读取；旧任务和仅排队的绑定不显示为已调用。
export function writingSkillLabel(detail: JobDetailResponse): string | undefined {
  const handle = detail.checkpoint?.agent_handle;
  if (!handle || typeof handle !== 'object' || Array.isArray(handle)) return undefined;
  const checkpoint = handle.checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return undefined;
  const execution=checkpoint.skill_execution;
  if(execution&&typeof execution==='object'&&!Array.isArray(execution)&&['claude_native_recipe','api_fixed_instructions'].includes(String(execution.mode))&&Array.isArray(execution.skills)){const labels=execution.skills.filter(s=>s&&typeof s==='object'&&!Array.isArray(s)&&typeof s.name==='string'&&typeof s.version==='string').map(s=>{const v=s as {name:string;version:string};return v.name+' · v'+v.version;}).join(' → ');const route=checkpoint.api_route;if(execution.mode==='api_fixed_instructions'&&route&&typeof route==='object'&&!Array.isArray(route))return (route.provider==='anthropic'?'Claude API':'OpenAI API')+' · '+String(route.model)+' · 独立 Key 计费'+(labels?' · 固定 Skill 指令：'+labels:'');if(labels)return 'Claude 原生配方：'+labels;}
  const skills = Array.isArray(checkpoint.writing_skills) ? checkpoint.writing_skills : [checkpoint.writing_skill];
  const labels = skills.filter(skill => skill && typeof skill === 'object' && !Array.isArray(skill) && skill.invocation === 'codex_native_skill_input' && typeof skill.name === 'string' && typeof skill.version === 'string').map(skill => { const item = skill as {name:string;version:string}; return item.name+' · v'+item.version; });
  if (labels.length) return labels.join(' → ');
  const skill = checkpoint.writing_skill;
  if (!skill || typeof skill !== 'object' || Array.isArray(skill) || skill.invocation !== 'codex_native_skill_input' || typeof skill.name !== 'string' || typeof skill.version !== 'string') return undefined;
  return skill.name + ' · v' + skill.version;
}
// 服务按 created_at,id 顺序领取；超过并发上限的生成任务保持 queued。读取失败只退回原排队文案。
export async function queuedAhead(context: FeatureContext, job: JobsRow): Promise<number> {
  try { const page = await context.client.request<{ items?: JobsRow[] }>('GET', '/api/v1/jobs?state=queued&limit=200', undefined, { signal: context.signal });
    return (Array.isArray(page?.items) ? page.items : []).filter(row => row.id !== job.id && row.execution_mode === 'service_adapter' && !row.cancel_requested_at && (row.created_at < job.created_at || (row.created_at === job.created_at && row.id < job.id))).length; }
  catch (error) { if (context.signal.aborted) throw error; return 0; }
}
export async function waitForegroundGeneration(context: FeatureContext, accepted: AcceptedGeneration, title: string, relevant: () => boolean = () => true, deferCompletionClose = false, copy?: { queued: string; running: string; note: string }, options: { keepWhenIrrelevant?: boolean; queryOriginal?: boolean; onDismiss?: (reason: ForegroundDismissReason) => void } = {}): Promise<JobDetailResponse | null> {
  // onDismiss 只在用户关闭/离开导致停止跟随时调用；服务端失败、取消不算，调用方不必从任务状态反推。
  const dismissed = (reason?: ForegroundDismissReason) => { options.onDismiss?.(reason ?? context.surface.foregroundCloseReason?.(accepted.job_id) ?? 'user_close'); return null; };
  // 批量提交的任务由服务继续执行：离开页面只停止前台跟随，不取消任何一个。
  const { btn, esc } = createTemplateHelpers([]); if (!relevant() && (options.keepWhenIrrelevant || options.queryOriginal)) return dismissed('navigate'); if (!relevant()) { const detail = await context.client.request<JobDetailResponse>('GET', '/api/v1/jobs/' + encodeURIComponent(accepted.job_id), undefined, { signal: context.signal }); if (!['succeeded', 'failed', 'cancelled', 'cancel_requested'].includes(detail.job.state)) await context.client.cancelJob(accepted.job_id, detail.job.version, { signal: context.signal, idempotencyKey: crypto.randomUUID() }); return null; } const active = () => context.surface.isForegroundJobActive?.(accepted.job_id) ?? false;
  const present = (version: number, progress: GenerationProgressView) => context.surface.presentDialog({ title, body: '<p class="fine">'+esc(progress.message)+'</p><p class="fine">'+esc(progress.note)+'</p>', generationProgress: progress, foot: options.queryOriginal ? btn('停止查看', 'close-dialog') : btn('取消任务', 'cancel-task'), foregroundJob: { id: accepted.job_id, version, ...(options.keepWhenIrrelevant || options.queryOriginal ? { keepOnDismiss: true } : {}) } });
  present(1, { state: 'queued', message: copy?.queued ?? '等待执行器领取…', note: copy?.note ?? '真实任务已排队，现有人工稿件保留。' });
  try { while (!context.signal.aborted && active()) {
    const detail = await context.client.request<JobDetailResponse>('GET', '/api/v1/jobs/' + encodeURIComponent(accepted.job_id), undefined, { signal: context.signal }); if (!active()) return dismissed();
    if (detail.job.state === 'succeeded') { if (!deferCompletionClose) context.surface.closeDialog('completed'); else present(detail.job.version, { state: 'succeeded', message: '正在读取生成结果…', note: '现有稿件保留，结果读取完成后继续。' }); return detail; }
    if (['cancelled', 'cancel_requested'].includes(detail.job.state)) { context.surface.closeDialog('completed'); return null; }
    if (['failed', 'waiting_input', 'waiting_quota', 'reconciling'].includes(detail.job.state)) {
      // 结束前台跟随（关闭不取消），再用静态球体给出用户文案；执行器原始报错与状态码只进默认收起的详情。
      context.surface.closeDialog('completed'); const error = detail.error, code = typeof error?.code === 'string' ? error.code : null, raw = typeof error?.message === 'string' ? error.message : '', skill = writingSkillLabel(detail), state = detail.job.state;
      const original = detail.job.kind === 'variant_generate' && typeof detail.job.target_id === 'string' ? originalResultState(detail) : undefined;
      const message = original?.message ?? jobIssueCopy({ state, executor: detail.job.executor_id, code }) ?? '任务需要处理，固定输入和原稿已保存';
      const originalButton = original ? btn('核对原结果', 'regenerate-version', true, originalQueryAttributes(accepted.job_id, detail.job.target_id!) + (original.canQuery ? '' : ' disabled')) : '';
      context.surface.presentDialog({ title, body: '<p class="fine">'+esc(message)+'</p>', progressKey: 'job-issue:' + accepted.job_id, generationProgress: { state: state === 'failed' ? 'failed' : 'waiting', label: state === 'failed' ? '未完成' : state === 'reconciling' ? '核对中' : '等待执行器', message, note: '固定输入和原稿已保存。', details: [...(skill ? [{ label: '本次执行', value: skill }] : []), { label: '任务状态', value: jobStateLabel(state) }, ...(code ? [{ label: '错误代码', value: code }] : []), ...(raw ? [{ label: '原始信息', value: raw }] : [])] }, foot: btn('知道了', 'close-dialog') + originalButton });
      return null;
    }
    // 重新投影当前版本，取消使用服务确认的版本；不声称模型百分比。
    const skill = writingSkillLabel(detail), ahead = detail.job.state === 'queued' ? await queuedAhead(context, detail.job) : 0; if (!active()) return dismissed();
    present(detail.job.version, { state: detail.job.state === 'queued' ? 'queued' : 'running', message: detail.job.state === 'queued' ? ahead > 0 ? '排队中（前面还有 ' + ahead + ' 个）' : copy?.queued ?? '等待执行器领取…' : copy?.running ?? '正在整理文字候选…', note: copy?.note ?? '固定资料与原稿修订已登记，现有人工稿件保留。', ...(skill ? { details: [{ label: '本次执行', value: skill }] } : {}) });
    await delay(250, context.signal);
  } } catch (error) {
    // 读取失败结束前台视觉；服务任务状态仍以服务为准，原异常交给现有调用方处理。
    if (!context.signal.aborted && active()) context.surface.closeDialog('completed');
    throw error;
  }
  return dismissed();
}
export async function candidateForJob(context: FeatureContext, documentId: string, jobId: string): Promise<CandidatePreview | undefined> {
  const page = await context.client.request<{ items: CandidatesRow[] }>('GET', '/api/v1/documents/' + encodeURIComponent(documentId) + '/candidates', undefined, { signal: context.signal }); const candidate = page.items.find(candidate => candidate.job_id === jobId); if (!candidate) return undefined;
  return context.client.request<CandidatePreview>('GET', '/api/v1/candidates/' + encodeURIComponent(candidate.id), undefined, { signal: context.signal });
}
export function showCandidate(context: FeatureContext, candidate: CandidatePreview, action: 'apply-suggestion' | 'apply-version', title: string, skillLabel?: string): void {
  const { esc, btn } = createTemplateHelpers([]); context.surface.presentDialog({ title, body: '<p class="fine">真实 AI 候选 · 当前稿件保持原文</p>'+(skillLabel ? '<details class="generation-details"><summary>详情</summary><p class="fine">本次执行：'+esc(skillLabel)+'</p></details>' : '')+'<div class="separator"></div><div class="social-preview">'+esc(candidate.text)+'</div><p class="fine" style="margin-top:15px">采用按生成时的固定 base 与当前 head 核对。</p>', foot: btn('保留原稿', 'close-dialog') + btn(action === 'apply-suggestion' ? '采用到核心稿' : '采用新版草稿', action, true, 'data-candidate="'+esc(candidate.id)+'"') });
}

// 成功状态出现后仍保留前台任务身份，直到候选读取完毕；用户关闭能阻止迟到预览。
export async function readForegroundResult<T>(context: FeatureContext, accepted: AcceptedGeneration, read: () => Promise<T>, relevant: () => boolean = () => true, onDismiss?: (reason: ForegroundDismissReason) => void): Promise<T | undefined> {
  const active = () => context.surface.isForegroundJobActive?.(accepted.job_id) ?? false;
  try { const result = await read(); if (!active()) { onDismiss?.(context.surface.foregroundCloseReason?.(accepted.job_id) ?? 'user_close'); return undefined; } if (!relevant()) { context.surface.closeDialog('user_close'); onDismiss?.('navigate'); return undefined; } context.surface.closeDialog('completed'); return result; }
  catch (error) { if (active()) context.surface.closeDialog('completed'); throw error; }
}
