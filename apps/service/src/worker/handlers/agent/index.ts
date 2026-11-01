import { ContractError, type JsonObject, type AgentRunHandle, type AgentResult } from '@workbench/contracts';
import type { ApplicationContext, AgentPort } from '@workbench/domain/ports';
import { buildServiceAgentPlan, resultTypedOutput, type ServiceAgentPlan, type ServiceExecutor } from '@workbench/domain/service-agent';
import { assertOriginalQueryTargets } from '@workbench/domain/jobs';
import { canonicalJson, transaction } from '@workbench/storage/connection';
import { appendEvent, fenceReason, getJob, getAttempt, assertWorkerRecoveryIntent } from '@workbench/storage/jobs';
import type { WorkerHandler, WorkerExecution } from '../../core/index.ts';

export const SERVICE_AGENT_KINDS = ['document_modify', 'variant_generate', 'wiki_generate', 'retro_generate', 'topic_recommendation', 'account_recommendation', 'speech_cleanup', 'image_plan'] as const;
export interface ServiceAgentHandlersOptions { staging_root: string; createAdapter(plan: ServiceAgentPlan): AgentPort & { close?(): Promise<void> }; plan?(execution: WorkerExecution): ServiceAgentPlan }
// WP-16 显式装配这些 handler；本模块不修改 bootstrap，不创建 host_session、不增加公开执行入口。
export function createServiceAgentHandlers(context: ApplicationContext, options: ServiceAgentHandlersOptions): WorkerHandler[] {
  return SERVICE_AGENT_KINDS.map(kind => ({ registration: { kind, execution_mode: 'service_adapter', recovery: 'read_only' }, async execute(execution) {
    const { claim, signal, checkpoint } = execution;
    const plan = options.plan?.(execution) ?? buildServiceAgentPlan(context, claim, { staging_root: options.staging_root });
    if (plan.fixed_input_hash !== claim.job.input_hash || plan.input.job_id !== claim.job.id || plan.input.kind !== claim.job.kind || plan.executor_id !== claim.job.executor_id) throw new ContractError('INPUT_STALE', 'handler 计划与固定 job 归属不符');
    const previous = JSON.parse(claim.attempt.checkpoint) as JsonObject;
    assertWorkerRecoveryIntent(context.db, getJob(context.db, claim.job.workspace_id, claim.job.id), getAttempt(context.db, claim.job.workspace_id, claim.attempt.id), previous);
    const queryOnly = previous.recovery_action === 'query_original';
    const old = previous.agent_handle as unknown as AgentRunHandle | undefined;
    if ((old || previous.executor_id) && previous.executor_id !== plan.executor_id && previous.pre_submit_failure !== true) throw new ContractError('RESULT_UNKNOWN', '旧任务结果未核清，不能换执行器启动新请求', { executor_id: previous.executor_id ?? null, no_new_turn_started: true });
    if (!old && previous.executor_id && previous.pre_submit_failure !== true) throw new ContractError('RESULT_UNKNOWN', '此前启动未取得可恢复句柄，先核对原请求；不能重新启动', { executor_id: previous.executor_id, no_new_turn_started: true });
    const adapter = options.createAdapter(plan); let handle: AgentRunHandle | undefined; let nativeCancel: Promise<unknown> | undefined;
    const snapshot = (extra: JsonObject = {}): JsonObject => ({ executor_id: plan.executor_id, fixed_input_hash: plan.fixed_input_hash, attempt_id: claim.attempt.id, attempt_generation: claim.attempt.attempt_generation, ...(handle ? { agent_handle: handle as unknown as JsonObject } : {}), pre_submit_failure: false, ...(previous.recovery_intent ? { recovery_intent: previous.recovery_intent } : {}), ...(queryOnly ? { recovery_action: 'query_original' } : {}), ...extra });
    const persist = (payload: JsonObject, event?: { type: Parameters<typeof appendEvent>[3]; payload: JsonObject }): void => {
      // WP-09 checkpoint callback 自有事务并同步落盘；禁止嵌套它的事务。
      checkpoint(payload);
      transaction(context.db, () => {
        const job = getJob(context.db, claim.job.workspace_id, claim.job.id), attempt = getAttempt(context.db, claim.job.workspace_id, claim.attempt.id);
        const invalid = fenceReason(job, attempt, claim.fence, Date.now()); if (invalid) throw new ContractError('HOST_RUN_NOT_CURRENT', '服务观察不能跨越失效 fence', { reason: invalid });
        context.db.prepare('UPDATE job_attempts SET runtime_session_id=?,runtime_turn_id=? WHERE workspace_id=? AND id=?').run(handle?.runtime_session_id ?? null, handle?.runtime_turn_id ?? null, claim.job.workspace_id, claim.attempt.id);
        if (event) appendEvent(context.db, claim.job.workspace_id, claim.job.id, event.type, event.payload, Date.now(), claim.attempt.attempt_no);
      });
    };
    const cancelled = () => { if (queryOnly) return; if (handle && !nativeCancel) nativeCancel = adapter.cancel(handle).then(fact => {
      // 逻辑取消以后仍保留实际中断观察；不更新 lease，不恢复提交权。
      transaction(context.db, () => appendEvent(context.db, claim.job.workspace_id, claim.job.id, 'phase_changed', { phase: 'native_cancel_observation', attempt_id: claim.attempt.id, attempt_generation: claim.attempt.attempt_generation, fact: fact as JsonObject }, Date.now(), claim.attempt.attempt_no));
    }).catch(error => transaction(context.db, () => appendEvent(context.db, claim.job.workspace_id, claim.job.id, 'phase_changed', { phase: 'native_cancel_observation', attempt_id: claim.attempt.id, native_interrupt: 'unknown', error: error instanceof ContractError ? error.details : {} }, Date.now(), claim.attempt.attempt_no))); };
    signal.addEventListener('abort', cancelled, { once: true });
    try {
      if (signal.aborted) throw new ContractError('HOST_RUN_NOT_CURRENT', '启动前 lease 已撤销');
      if (queryOnly) {
        if (!old || plan.executor_id !== 'codex' || old.runtime_session_id.startsWith('api:')) throw new ContractError('CAPABILITY_UNSUPPORTED','缺少原订阅任务身份，不能重发',{pre_submit_failure:true,no_new_turn_started:true});
        assertOriginalQueryTargets(context,claim.job);
      }
      if (old && previous.executor_id === plan.executor_id && (previous.fixed_input_hash !== plan.fixed_input_hash || canonicalJson(old.checkpoint.run_input) !== canonicalJson(plan.input))) throw new ContractError('INPUT_STALE', '恢复 checkpoint 与固定计划不符');
      // 在可能提交的新调用前消费旧的未提交证明；无 handle 的启动断线也不能重复 start。
      persist({ ...previous, ...snapshot() });
      if (old && previous.executor_id === plan.executor_id) handle = await adapter.resume(old, queryOnly ? { recovery_action: 'query_original' } : {});
      else handle = await adapter.start(plan.input);
      if (signal.aborted) cancelled();
      persist(snapshot()); let result: AgentResult | undefined; const usage = new Map<string, string>();
      for await (const event of adapter.streamEvents(handle)) {
        if ('status' in event) { if (result) throw new ContractError('RESULT_OUTPUT_CONFLICT', '同一原生 turn 重复结果'); result = event; persist(snapshot({ actual_usage: result.actual_usage, result_manifest: { output_sha256: result.resume_info.output_sha256 ?? null, native_status: result.resume_info.native_status ?? null } })); }
        else { const key = `${handle.runtime_session_id}:${handle.runtime_turn_id ?? ''}`; const actual = event.payload.actual_usage; if (actual) { const content = canonicalJson(actual); if (usage.get(key) === content) continue; usage.set(key, content); } persist(snapshot(actual ? { actual_usage: actual } : {}), { type: event.type, payload: { ...event.payload, attempt_id: claim.attempt.id, attempt_generation: claim.attempt.attempt_generation, executor_id: plan.executor_id } }); }
      }
      if (!result) throw new ContractError('RESULT_UNKNOWN', '原生执行结束但没有结构化结果');
      if (queryOnly) assertOriginalQueryTargets(context,claim.job);
      return resultTypedOutput(result);
    } catch (error) {
      if (!handle && (!old || previous.pre_submit_failure === true) && error instanceof ContractError && error.details.pre_submit_failure === true) persist({ ...previous, ...snapshot({ pre_submit_failure: true }) });
      if (handle && error instanceof ContractError && ['HOST_INTERRUPTED', 'RESULT_UNKNOWN', 'AUTH_REQUIRED', 'QUOTA_EXHAUSTED', 'VALIDATION_ERROR'].includes(error.code)) transaction(context.db, () => appendEvent(context.db, claim.job.workspace_id, claim.job.id, 'phase_changed', {
        phase: 'native_terminal_observation', attempt_id: claim.attempt.id, attempt_generation: claim.attempt.attempt_generation,
        native_status: error.code === 'HOST_INTERRUPTED' ? 'interrupted' : 'unknown', error: { code: error.code, details: error.details },
      }, Date.now(), claim.attempt.attempt_no));
      throw error;
    } finally { signal.removeEventListener('abort', cancelled); if (signal.aborted) cancelled(); if (nativeCancel) await nativeCancel; await adapter.close?.(); }
  } }));
}
export type { ServiceAgentPlan, ServiceExecutor };
