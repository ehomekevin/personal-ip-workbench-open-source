import { ContractError, PatchSettingsSchema, maxConcurrentGenerations, type PatchSettingsRequest, type RequestContext,
  type SettingsResponse, type ExecutorHealth, type WorkspacePaths } from '@workbench/contracts';
import { transaction } from '@workbench/storage/connection';
import { workspaceSettings, connectorCapabilities } from '@workbench/storage/settings';
import { readIdempotent, readCommittedIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import type { ApplicationContext, SettingsPort } from '../ports/index.ts';
import { assertRequestIdentity } from '../documents/index.ts';
import { runConfigurationProbe } from './process-probe.ts';

export function safeExecutor(row: ExecutorHealth): ExecutorHealth {
  const statuses = ['unconfigured', 'unverified', 'supported', 'unsupported', 'degraded'];
  const status = statuses.includes(row.status) ? row.status : 'unverified';
  return { executor_id: ['codex', 'claude'].includes(row.executor_id) ? row.executor_id : 'unknown', status,
    runtime_version: row.runtime_version && /^(?:codex-cli )?[0-9]+(?:\.[0-9A-Za-z_-]+){1,3}(?: \(Claude Code\))?$/.test(row.runtime_version) ? row.runtime_version : null,
    auth_state: ['unconfigured', 'unknown', 'authenticated', 'subscription_authenticated', 'auth_required', 'not_checked', 'AUTH_REQUIRED', 'QUOTA_EXHAUSTED', 'CAPABILITY_UNVERIFIED', 'READINESS_UNAVAILABLE'].includes(row.auth_state) ? row.auth_state : 'unknown',
    billing_route: ['subscription', 'api', 'unknown', 'chatgpt_subscription', 'claude_subscription'].includes(row.billing_route ?? '') ? row.billing_route : null,
    limitations: status === 'supported' ? [] : ['执行器能力尚未通过对应真实验收'] };
}
export class Settings implements SettingsPort {
  readonly context: ApplicationContext;
  constructor(context: ApplicationContext) { this.context = context; }
  async get(request: RequestContext): Promise<SettingsResponse> {
    assertRequestIdentity(this.context, request);
    return { ...workspaceSettings(this.context.db, request.workspace_id), max_concurrent_generations: maxConcurrentGenerations(this.context.config),
      executors: (await this.context.getExecutorHealth()).map(safeExecutor), capabilities: connectorCapabilities(this.context.db, request.workspace_id) };
  }
  async patch(request: RequestContext, input: PatchSettingsRequest): Promise<SettingsResponse> {
    assertRequestIdentity(this.context, request); PatchSettingsSchema.parse(input);
    const completed = readCommittedIdempotent<SettingsResponse>(this.context.db, request, 'settings.patch', input); if (completed) return completed;
    if (input.timezone !== undefined) {
      if (!input.timezone) throw new ContractError('VALIDATION_ERROR', 'IANA 时区不能为空');
      try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); } catch { throw new ContractError('VALIDATION_ERROR', 'IANA 时区无效'); }
    }
    const current = workspaceSettings(this.context.db, request.workspace_id);
    const paths: WorkspacePaths = { ...current.paths, ...input.paths };
    if (paths.state_root !== current.paths.state_root) throw new ContractError('VALIDATION_ERROR', '不能热切换正在运行的唯一主存；须通过显式迁移与重启处理', { field: 'paths.state_root' });
    if (input.paths) {
      const registered = this.context.db.prepare('SELECT file_path AS path FROM document_revisions WHERE workspace_id=? UNION SELECT path FROM write_intents WHERE workspace_id=?').all(request.workspace_id,request.workspace_id).map(row=>String(row.path));
      await runConfigurationProbe(new URL('./path-probe.ts',import.meta.url),{paths,registered});
    }
    const health = (await this.context.getExecutorHealth()).map(safeExecutor);
    return transaction(this.context.db, () => {
      const replay = readIdempotent<SettingsResponse>(this.context.db, request, 'settings.patch', input); if (replay) return replay;
      const latest = workspaceSettings(this.context.db, request.workspace_id);
      if (latest.version !== input.expected_version) throw new ContractError('VERSION_CONFLICT', '设置已由另一入口修改', { current_version: latest.version });
      this.context.db.prepare('UPDATE workspaces SET timezone=?,paths=?,default_executor=?,api_fallback_enabled=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(input.timezone ?? latest.timezone, JSON.stringify({ ...latest.paths, ...input.paths }), input.default_executor ?? latest.default_executor,
          (input.api_fallback_enabled ?? latest.api_fallback_enabled) ? 1 : 0, new Date().toISOString(), request.workspace_id, input.expected_version);
      const result: SettingsResponse = { ...workspaceSettings(this.context.db, request.workspace_id), max_concurrent_generations: maxConcurrentGenerations(this.context.config),
        executors: health, capabilities: connectorCapabilities(this.context.db, request.workspace_id) };
      storeIdempotent(this.context.db, request, 'settings.patch', input, result); return result;
    });
  }
}

export {ImageProviderSettings,type ImageProviderSettingsOptions} from './image-providers.ts';
