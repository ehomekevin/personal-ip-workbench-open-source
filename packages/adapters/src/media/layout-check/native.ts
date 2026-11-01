import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ContractError } from '@workbench/contracts';
import { CodexNative } from '../../agent/codex/native.ts';
import { object, type WorkspaceSlot } from '../../agent/codex/primitives.ts';
import type { LayoutCheckOptions, LayoutNativeClient } from './types.ts';

const SAFE_CONFIG = `import json,pathlib,sys,tomllib
p=pathlib.Path(sys.argv[1]); c=tomllib.loads(p.read_text()) if p.exists() else {}
names=set(); overrides=False
def visit(v):
 global overrides
 if isinstance(v,list):
  for child in v: visit(child)
 elif isinstance(v,dict):
  if v.get('openai_base_url') or v.get('openai_api_base') or v.get('model_providers',{}).get('openai'): overrides=True
  for key,child in v.items():
   if key=='mcp_servers':
    if not isinstance(child,dict): raise ValueError('invalid config')
    names.update(child)
   elif isinstance(child,(dict,list)): visit(child)
visit(c); print(json.dumps({'mcp_names':sorted(names),'override':overrides}))`;
/** No inference, account authentication files, configuration values or secrets are read by this inspection. */
export function inspectLayoutNativeConfiguration(): { mcp_names: string[]; official_provider_unmodified: true } {
  if (['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'].some(key => !!process.env[key])) throw new ContractError('AUTH_REQUIRED', '现有订阅路线被 API 环境覆盖，未准备视觉任务', { pre_submit_failure: true });
  let value: unknown;
  try { value = JSON.parse(execFileSync('python3', ['-c', SAFE_CONFIG, join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  })); } catch { throw new ContractError('CAPABILITY_UNVERIFIED', '订阅配置无法安全核实，未启动视觉任务', { pre_submit_failure: true }); }
  if (!object(value) || value.override !== false || !Array.isArray(value.mcp_names) || value.mcp_names.some(n => typeof n !== 'string' || !/^[A-Za-z0-9_-]+$/.test(n))) throw new ContractError('CAPABILITY_UNVERIFIED', '官方 provider 或 MCP 隔离未确认', { pre_submit_failure: true });
  return { mcp_names: value.mcp_names as string[], official_provider_unmodified: true };
}
export function createLayoutNativeClient(options: LayoutCheckOptions, slot: WorkspaceSlot): LayoutNativeClient {
  const config = inspectLayoutNativeConfiguration();
  let spawned = false; slot.starting();
  try { return new CodexNative({ cwd: options.cwd, schemaDirectory: options.schema_directory, executable: options.executable,
    mcpNames: config.mcp_names, imageGeneration: false, sink: entry => {
      if (entry.direction === 'spawn' && object(entry.message) && typeof entry.message.pid === 'number') { spawned = true; slot.bindChild(entry.message.pid); }
    } }); } catch (error) { if (!spawned) slot.childExited(); throw error; }
}
export async function assertLayoutVisionReady(native: LayoutNativeClient, signal: AbortSignal): Promise<void> {
  await native.initialize(); signal.throwIfAborted();
  const account = await native.request('account/read', { refreshToken: false }); signal.throwIfAborted();
  if (!object(account) || !object(account.account) || account.account.type !== 'chatgpt') throw new ContractError('AUTH_REQUIRED', '视觉检查需要现有 Codex 订阅身份', { pre_submit_failure: true });
  const rate = await native.request('account/rateLimits/read', {}); signal.throwIfAborted();
  if (!object(rate) || rate.ordinaryUsageAllowed !== true) throw new ContractError('CAPABILITY_UNVERIFIED', 'Codex included usage 未确认，未提交检查', { pre_submit_failure: true });
  const catalog = await native.request('model/list', {}); signal.throwIfAborted();
  const model = object(catalog) && Array.isArray(catalog.data) ? catalog.data.find(m => object(m) && m.id === 'gpt-6.1-sol') : null;
  if (!object(model) || !Array.isArray(model.inputModalities) || !model.inputModalities.includes('image') ||
    !Array.isArray(model.supportedReasoningEfforts) || !model.supportedReasoningEfforts.some(e => object(e) && e.reasoningEffort === 'xhigh')) throw new ContractError('CAPABILITY_UNSUPPORTED', '原生模型未明确声明 image 输入与固定推理档位，不切文本或其他模型', { pre_submit_failure: true });
}
