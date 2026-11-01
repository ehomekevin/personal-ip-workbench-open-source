import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { ContractError } from '@workbench/contracts';
import { CODEX_SCHEMA_HASHES } from './schema-hashes.ts';
import { object, hash, matches, trace, providerError, type TraceSink } from './primitives.ts';

export interface NativeMessage { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
const requests: Record<string, string> = { 'thread/read':'ThreadRead','thread/start': 'ThreadStart', 'thread/resume': 'ThreadResume', 'turn/start': 'TurnStart', 'turn/interrupt': 'TurnInterrupt' };
const responses: Record<string, string> = { 'account/read': 'GetAccountResponse', 'account/rateLimits/read': 'GetAccountRateLimitsResponse', 'model/list': 'ModelListResponse' };
const notifications: Record<string, string> = { 'turn/started': 'TurnStartedNotification', 'turn/completed': 'TurnCompletedNotification', 'thread/tokenUsage/updated': 'ThreadTokenUsageUpdatedNotification', 'item/agentMessage/delta': 'AgentMessageDeltaNotification', 'item/completed': 'ItemCompletedNotification' };
// 新工作区从已核对版本的本机 CLI 准备协议文件；已有文件有差异时拒绝覆盖。
export function prepareCodexSchemas(binary: string, directory: string, env?: NodeJS.ProcessEnv): void {
  const missing: string[] = [];
  for (const [name, expected] of Object.entries(CODEX_SCHEMA_HASHES)) {
    const path = join(directory, 'v2', name + '.json');
    if (!existsSync(path)) missing.push(name);
    else if (hash(readFileSync(path)) !== expected) throw new ContractError('INPUT_STALE', '固定 Codex schema hash 不符', { schema: name });
  }
  if (!missing.length) return;
  mkdirSync(dirname(directory), { recursive: true });
  const staging = mkdtempSync(join(dirname(directory), '.codex-schema-'));
  try {
    execFileSync(binary, ['app-server', 'generate-json-schema', '--out', staging], { env, timeout: 15_000, stdio: 'pipe' });
    const files = missing.map(name => {
      const bytes = readFileSync(join(staging, 'v2', name + '.json'));
      if (hash(bytes) !== CODEX_SCHEMA_HASHES[name]) throw new ContractError('INPUT_STALE', '本机生成的 Codex schema 与已核对协议不符', { schema: name });
      return { name, bytes };
    });
    mkdirSync(join(directory, 'v2'), { recursive: true });
    for (const { name, bytes } of files) {
      try { writeFileSync(join(directory, 'v2', name + '.json'), bytes, { flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
export class CodexNative {
  readonly process: ChildProcessWithoutNullStreams; readonly version: string;
  private schemas = new Map<string, unknown>(); private pending = new Map<number, { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(message: NativeMessage) => void>(); private history: NativeMessage[] = []; private nextId = 0; private closing = false;
  constructor(options: { executable?: string; cwd: string; schemaDirectory: string; mcpNames: readonly string[]; sink?: TraceSink; env?: NodeJS.ProcessEnv; imageGeneration?: boolean }) {
    const binary = options.executable ?? 'codex'; this.version = execFileSync(binary, ['--version'], { encoding: 'utf8', env: options.env }).trim();
    if (this.version !== 'codex-cli 0.161.0') throw new ContractError('CAPABILITY_UNVERIFIED', 'Codex 版本与固定 schema 不符', { actual_version: this.version });
    prepareCodexSchemas(binary, options.schemaDirectory, options.env);
    for (const [name, expected] of Object.entries(CODEX_SCHEMA_HASHES)) { const bytes = readFileSync(join(options.schemaDirectory, 'v2', `${name}.json`)); if (hash(bytes) !== expected) throw new ContractError('INPUT_STALE', '固定 Codex schema hash 不符', { schema: name }); this.schemas.set(name, JSON.parse(bytes.toString('utf8'))); }
    if (options.mcpNames.some(name => !/^[A-Za-z0-9_-]+$/.test(name))) throw new ContractError('VALIDATION_ERROR', 'MCP 名称无法安全隔离');
    // 0.161.0 实际 features list 已核对；无工具计划也关闭 shell/code/browser/image，不能仅依靠提示词。
    const disabled = ['hooks', 'memories', 'chronicle', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'code_mode_host', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'image_generation', 'view_image', 'sleep_tool', 'tool_suggest', 'workspace_dependencies', 'skill_mcp_dependency_install'];
    // Only the dedicated image adapter opts in. Writing keeps the original disabled list.
    const settings = [...disabled.filter(feature => !(options.imageGeneration && ['image_generation', 'code_mode_host'].includes(feature))).map(feature => `features.${feature}=false`), ...(options.imageGeneration ? ['features.image_generation=true', 'features.code_mode_host=true'] : []), 'features.skip_host_skill_discovery=true', 'web_search="disabled"', 'model_provider="openai"', 'model="gpt-6.1-sol"', 'model_reasoning_effort="xhigh"', ...options.mcpNames.map(name => `mcp_servers.${name}.enabled=false`)];
    this.process = spawn(binary, ['app-server', '--stdio', ...settings.flatMap(setting => ['-c', setting])], { cwd: options.cwd, env: options.env ?? process.env, stdio: 'pipe' });
    trace(options.sink, 'spawn', { pid: this.process.pid ?? null, runtime_version: this.version, cwd: options.cwd, settings, schema_hashes: CODEX_SCHEMA_HASHES });
    const sendTrace = options.sink;
    createInterface({ input: this.process.stdout }).on('line', line => { try { const message: unknown = JSON.parse(line); if (!object(message)) throw new Error('原生消息不是 object'); trace(sendTrace, 'receive', message); this.receive(message as NativeMessage); } catch (error) { this.fail(error instanceof Error ? error : new Error('原生协议错误')); } });
    createInterface({ input: this.process.stderr }).on('line', line => trace(sendTrace, 'stderr', line));
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', (code, signal) => { trace(sendTrace, 'exit', { code, signal, intentional: this.closing }); if (!this.closing) this.fail(new ContractError('RESULT_UNKNOWN', '原生进程断开', { code, signal })); });
    this.sink = sendTrace;
  }
  private readonly sink?: TraceSink;
  async initialize(experimentalApi = false): Promise<void> { await this.request('initialize', { clientInfo: { name: 'workbench_wp15_service', version: '0.1.0' }, ...(experimentalApi ? { capabilities: { experimentalApi: true } } : {}) }); this.send({ method: 'initialized', params: {} }); }
  private send(message: NativeMessage): void { if (this.closing || !this.process.stdin.writable) throw new ContractError('RESULT_UNKNOWN', '原生进程已关闭'); trace(this.sink, 'send', message); this.process.stdin.write(JSON.stringify(message) + '\n'); }
  request(method: string, params: Record<string, unknown>, timeout = 30_000): Promise<unknown> {
    const request = requests[method]; if (request && !matches(params, this.schemas.get(`${request}Params`))) throw new ContractError('VALIDATION_ERROR', '原生请求不符合固定 schema', { method });
    const id = ++this.nextId; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new ContractError('RESULT_UNKNOWN', '原生请求超时', { method })); }, timeout); this.pending.set(id, { method, resolve, reject, timer }); try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
  }
  private receive(message: NativeMessage): void {
    if (typeof message.id === 'number' && !message.method) { const pending = this.pending.get(message.id); if (!pending) return; clearTimeout(pending.timer); this.pending.delete(message.id); if (message.error) { pending.reject(providerError(message.error)); return; } const name = responses[pending.method] ?? (requests[pending.method] ? `${requests[pending.method]}Response` : undefined); if (name && !matches(message.result, this.schemas.get(name))) { pending.reject(new ContractError('VALIDATION_ERROR', '原生响应不符合固定 schema', { method: pending.method })); return; } pending.resolve(message.result); return; }
    const name = notifications[message.method ?? '']; if (name && !matches(message.params, this.schemas.get(name))) { this.fail(new ContractError('VALIDATION_ERROR', '原生事件不符合固定 schema', { method: message.method ?? null })); return; }
    this.history.push(message); for (const listener of this.listeners) listener(message);
  }
  observe(listener: (message: NativeMessage) => void): () => void { for (const message of this.history) listener(message); this.listeners.add(listener); return () => this.listeners.delete(listener); }
  respond(id: string | number, result: unknown): void { this.send({ id, result }); }
  deny(id: string | number): void { this.send({ id, error: { code: -32000, message: 'Service does not authorize native tools' } }); }
  private fail(error: Error): void { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); const message = { method: '$transport/error', params: { error } }; this.history.push(message); for (const listener of this.listeners) listener(message); }
  private closePromise?: Promise<void>;
  close(): Promise<void> { return this.closePromise ??= this.stop(); }
  private async stop(): Promise<void> {
    this.closing = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new ContractError('RESULT_UNKNOWN', '原生连接已关闭')); } this.pending.clear();
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    await new Promise<void>(resolve => { const kill = setTimeout(() => this.process.kill('SIGKILL'), 4_000); const term = setTimeout(() => this.process.kill('SIGTERM'), 1_000); this.process.once('exit', () => { clearTimeout(kill); clearTimeout(term); resolve(); }); this.process.stdin.end(); });
  }
}
