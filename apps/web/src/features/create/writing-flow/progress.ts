import type { ContentExecutor, JobDetailResponse, JsonObject, WritingRun } from '@workbench/contracts';
import type { GenerationProgressView } from '../../../transport/feature-ports.ts';
import { writingSkillLabel } from '../ai-actions/index.ts';
import { EXECUTOR_NAMES, type ExecutorChoice } from '../../../components/executors.ts';
import { jobIssueCopy, jobStateLabel } from '../../../components/job-copy.ts';
export interface WritingJob { id: string; state: string; version: number; error: { message?: string; code?: string } | null; checkpoint?: JsonObject | null; created_at?: string; started_at?: string | null; last_output_at?: string | null }
type Run = Pick<WritingRun, 'id' | 'executor' | 'execution_policy' | 'stages' | 'input_revision_id' | 'adopted_revision_id' | 'switch_pending' | 'switched_to' | 'switch_abandoned'> & { current_job: WritingJob };
const stageLabels: Record<string, string> = { writing: '写作中', review: '审读中', revision: '改稿中', recheck: '复核中' };
const stageMessages: Record<string, string> = { writing: '正在写完整稿…', review: '正在独立审读…', revision: '正在按决定改稿…', recheck: '正在复核改稿…' };
const other = (id: ContentExecutor): ContentExecutor => id === 'claude' ? 'codex' : 'claude';
// 运行编号、模型、推理档位、时限、skill 链与原始错误只进“详情”，主路径不露。
export function writingDiagnostics(run: Run): { label: string; value: string }[] {
  const skill = writingSkillLabel({ checkpoint: run.current_job.checkpoint ?? null } as JobDetailResponse);
  return [
    { label: '运行', value: run.id },
    { label: '执行器', value: run.executor === 'claude' ? 'Claude Code · 订阅默认模型' : 'Codex · ' + run.execution_policy.model + ' / ' + run.execution_policy.reasoning_effort },
    { label: '时限', value: run.executor === 'codex' ? '最长 ' + run.execution_policy.max_duration_ms / 60000 + ' 分钟' : '沿用订阅执行器设置' },
    ...(skill ? [{ label: '本次执行', value: skill }] : []),
    { label: '任务状态', value: jobStateLabel(run.current_job.state) },
    ...(run.current_job.error?.code ? [{ label: '错误代码', value: run.current_job.error.code }] : []),
    ...(run.current_job.error?.message ? [{ label: '原始信息', value: run.current_job.error.message }] : []),
    { label: '输入修订', value: run.input_revision_id ?? '空核心稿' },
    { label: '当前采用', value: run.adopted_revision_id ?? '尚未采用' },
  ];
}
// 主路径的失败/等待说明；原文在详情里。
export function writingIssue(run: Run, alternative?: string) { return jobIssueCopy({ state: run.current_job.state, executor: run.executor, code: run.current_job.error?.code ?? null, ...(alternative ? { alternative } : {}) }); }
// 由真实 job 状态驱动；没有对应等待态时返回 undefined，面板保持原有结果视图。retry 表示服务端已取消原任务但新运行尚未入队，只能用原请求补入队。
export function writingProgress(run: Run, choices: ExecutorChoice[] = []): { view: GenerationProgressView; switchTo?: ContentExecutor; retry?: boolean } | undefined {
  const job = run.current_job, stage = run.stages.at(-1)?.stage ?? 'writing', details = writingDiagnostics(run);
  if (run.switch_pending) return { view: { state: 'waiting', label: '待重跑', message: '原任务已取消，改用 ' + EXECUTOR_NAMES[run.switch_pending.executor] + ' 重跑还没完成，可以重试', note: '', details }, switchTo: run.switch_pending.executor, retry: true };
  if (run.switch_abandoned) return { view: { state: 'failed', label: '未能重跑', message: '原输入已变化，请新开完整稿流程', note: '', details } };
  if (run.switched_to) return undefined;
  if (job.state === 'queued') return { view: { state: 'queued', label: '排队中', message: '已收到，等待执行器领取…', note: '', details } };
  if (job.state === 'running') return { view: { state: 'running', label: stageLabels[stage] ?? '处理中', message: stageMessages[stage] ?? '正在处理…', note: '', timing: { since: job.started_at ?? job.created_at ?? '', last_output_at: job.last_output_at ?? null }, details } };
  if (job.state === 'waiting_quota' || job.state === 'waiting_input') {
    const target = choices.find(c => c.id === other(run.executor)), switchTo = target?.usable && stage === 'writing' && run.stages.length === 1 ? target.id : undefined;
    return { view: { state: 'waiting', label: '等待执行器', message: writingIssue(run, switchTo ? EXECUTOR_NAMES[switchTo] : undefined)!, note: '', details }, ...(switchTo ? { switchTo } : {}) };
  }
  if (job.state === 'reconciling') return { view: { state: 'waiting', label: '核对中', message: writingIssue(run)!, note: '', details } };
  if (job.state === 'failed' && ['RESULT_UNKNOWN', 'LEASE_EXPIRED'].includes(job.error?.code ?? '')) return { view: { state: 'failed', label: '需要核对', message: writingIssue(run)!, note: '', details } };
  return undefined;
}
