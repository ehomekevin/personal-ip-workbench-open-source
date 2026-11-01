import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { ContractError, type JsonObject } from '@workbench/contracts';
import { object } from '../../agent/codex/primitives.ts';
import { asJson, assertCheckpoint, baseCheckpoint, bindingMarker, containedFile, imageResult, numericUsage, saveCheckpoint, sha, startCheckpoint, unknown, validateInput } from './common.ts';
import { imageCapabilities, imageCompositionPrompt } from './capabilities.ts';
import type { ImageProviderInput, ImageProviderOptions, ImageProviderPort, ImageProviderResult } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPE_URL = 'type.googleapis.com/exa.cortex.core.tools.GenerateImage';
function varint(data: Buffer, start: number): [number, number] {
  let value = 0, factor = 1, pos = start;
  for (let i = 0; i < 10 && pos < data.length; i++) { const byte = data[pos++]!; value += (byte & 127) * factor; if (!Number.isSafeInteger(value)) throw unknown('原生 protobuf 数值越界'); if (!(byte & 128)) return [value, pos]; factor *= 128; }
  throw unknown('原生 protobuf varint 无效');
}
function field(data: Buffer, number: number, expectedWire = 2): Buffer | number {
  let pos = 0; const found: Array<Buffer | number> = [];
  while (pos < data.length) {
    let tag: number; [tag, pos] = varint(data, pos); const num = Math.floor(tag / 8), wire = tag % 8; let value: Buffer | number;
    if (!num) throw unknown('原生 protobuf field 无效');
    if (wire === 0) [value, pos] = varint(data, pos);
    else if ([1, 2, 5].includes(wire)) { let length = wire === 1 ? 8 : 4; if (wire === 2) [length, pos] = varint(data, pos); if (pos + length > data.length) throw unknown('原生 protobuf 被截断'); value = data.subarray(pos, pos + length); pos += length; }
    else throw unknown('原生 protobuf wire 未支持');
    if (num === number) { if (wire !== expectedWire) throw unknown('原生 protobuf field 类型不符'); found.push(value); }
  }
  if (found.length !== 1) throw unknown('原生 protobuf field 数量不符');
  return found[0]!;
}
function bufferField(data: Buffer, number: number): Buffer { return field(data, number) as Buffer; }
function unquote(value: unknown): unknown { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } }
function ownTranscript(root: string, id: string): JsonObject[] {
  if (!UUID.test(id)) throw unknown('AGY 原 conversation ID 无效');
  const path = join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(path)) throw unknown('AGY 原 conversation 本地记录尚未出现');
  const content = readFileSync(path, 'utf8'); if (content.length > 20 * 1024 * 1024) throw unknown('AGY 原 conversation 记录超限');
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as JsonObject);
}
// 「验证连接」的只读探测：只运行 `agy models` 读取当前登录可用的模型列表，不发起会话、不生图、不计入生图预算。
// 列表读到即视为本机登录与服务连通；图像工具权限仍以真实生图回执为准。
// 子进程放进独立进程组：超时先对整组发 SIGTERM，宽限期后仍未退出再发 SIGKILL；挂起的探测记为超时（inconclusive）。
export type ImageAccessProbe = { ok: true } | { ok: false; reason: 'login' | 'quota' | 'connection' | 'unconfigured'; inconclusive?: boolean; timeout?: boolean };
export function probeAgyAccess(options: ImageProviderOptions & { kill_grace_ms?: number } = {}): Promise<ImageAccessProbe> {
  const binary = options.executable ?? join(homedir(), '.local', 'bin', 'agy');
  if (!existsSync(binary)) return Promise.resolve({ ok: false, reason: 'unconfigured' });
  return new Promise(resolve => {
    let stdout = '', stderr = '', settled = false, timedOut = false, killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: ImageAccessProbe) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const group = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* 进程组已退出 */ } };
    const child = spawn(binary, ['models'], { env: options.env, cwd: options.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const cap = (chunk: Buffer, into: 'out' | 'err') => { const text = chunk.toString('utf8'); if (into === 'out') { if (stdout.length < 1024 * 1024) stdout += text; } else if (stderr.length < 1024 * 1024) stderr += text; };
    child.stdout!.on('data', (c: Buffer) => cap(c, 'out')); child.stderr!.on('data', (c: Buffer) => cap(c, 'err'));
    const timer = setTimeout(() => {
      timedOut = true; group('SIGTERM');
      killTimer = setTimeout(() => { group('SIGKILL'); finish({ ok: false, reason: 'connection', inconclusive: true, timeout: true }); }, options.kill_grace_ms ?? 2_000); killTimer.unref?.();
    }, options.timeout_ms ?? 20_000);
    child.once('error', () => { clearTimeout(killTimer); finish({ ok: false, reason: 'connection' }); });
    child.once('close', code => {
      clearTimeout(killTimer);
      if (timedOut) { finish({ ok: false, reason: 'connection', inconclusive: true, timeout: true }); return; }
      const text = stdout + '\n' + stderr;
      if (code === 0 && /^\S+\t\S/m.test(stdout)) finish({ ok: true });
      else if (/quota|rate.?limit|resource.?exhausted|429/i.test(text)) finish({ ok: false, reason: 'quota' });
      else if (/log.?in|sign.?in|unauthenticated|unauthori[sz]ed|auth|credential|401|403/i.test(text)) finish({ ok: false, reason: 'login' });
      else finish({ ok: false, reason: 'connection', inconclusive: false });
    });
  });
}
export class AgyImageProvider implements ImageProviderPort {
  readonly id = 'agy' as const;
  private readonly binary: string; private readonly stateRoot: string; private readonly options: ImageProviderOptions;
  constructor(options: ImageProviderOptions = {}) { this.options = options; this.binary = options.executable ?? join(homedir(), '.local', 'bin', 'agy'); this.stateRoot = options.state_root ?? join(homedir(), '.gemini', 'antigravity-cli'); }
  async describe(): Promise<JsonObject> {
    let version: string | null = null;
    try { const output = execFileSync(this.binary, ['changelog'], { encoding: 'utf8', env: this.options.env, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }); version = output.match(/\b1\.3\.3\b/)?.[0] ?? null; } catch { /* No request is sent. */ }
    return { provider: this.id, configured: existsSync(this.binary), runtime_version: version, model: 'gemini-3.1-flash-image',
      credential_reference: 'CLI-managed existing login; not inspected', identity: 'unverified', connection: 'unverified_current_session', permission: 'unverified_current_session',
      operations: { generate: 'supported', reference_edit: 'supported', mask: 'unverified', strict_region_control: 'unverified', writing: 'unverified' },
      operation_evidence: 'probe-r1: native typed GenerateImage; generation and single-reference edit; not current connection test',
      execution_policy: 'native CLI prompt limits and post-result audit; not a strong tool sandbox', online_query: false, remote_cancel: 'unverified',
      image_studio: imageCapabilities(this.id) };
  }
  private prompt(input: ImageProviderInput): string {
    return 'This is one explicitly authorized workbench image task. ' + bindingMarker(input) + '\n' +
      'Use only the Antigravity built-in image-generator subagent and delegate exactly ONE generate_image call. ' +
      'Forbid automatic corrections, retries, other providers, shell drawing, SVG/HTML/PNG placeholders, MCP, workspace reads, code edits and other API calls. ' +
      'Tell the subagent to keep the first result and stop on error, quota, timeout or unknown; do not resubmit. ' +
      (input.operation === 'reference_edit' ? `Edit only the supplied image with ImagePaths=${JSON.stringify(input.references.map(ref => ref.file_path))}. ` : 'Generate one image. ') +
      'Use the native image tool model, never a guessed chat-model image ID. The image brief is:\n' + imageCompositionPrompt(input) + input.prompt +
      '\nReturn only the actual image path and status; never fabricate model or usage. Do not retry to improve the image.';
  }
  async execute(input: ImageProviderInput, options: { signal: AbortSignal; checkpoint: (value: JsonObject) => void; prior?: JsonObject }): Promise<ImageProviderResult> {
    await validateInput(input, this.id, options.signal);
    if (options.prior) return this.query(input, options.prior, options.signal);
    const existing = startCheckpoint(input, options.checkpoint); if (existing) return this.query(input, existing, options.signal);
    options.signal.throwIfAborted();
    let cp = baseCheckpoint(input); cp.submit_count = 1; cp.native_state = 'submitting'; saveCheckpoint(input, cp, options.checkpoint);
    await new Promise<void>((resolve, reject) => {
      options.signal.throwIfAborted();
      const child = spawn(this.binary, ['--print', this.prompt(input), '--output-format', 'stream-json', '--disable-slash-commands', '--print-timeout', `${Math.ceil((this.options.timeout_ms ?? 600_000) / 1000)}s`],
        { cwd: input.work_directory, env: { ...(this.options.env ?? process.env), AGY_CLI_HIDE_ACCOUNT_INFO: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let closed = false, settled = false, exited = false, detached = false, stopping = false, count = 0, failure: Error | undefined;
      let hard: NodeJS.Timeout | undefined, exitDrain: NodeJS.Timeout | undefined, detachedSettle: NodeJS.Timeout | undefined;
      let reader: ReturnType<typeof createInterface> | undefined;
      const failed = (message: string, error?: unknown): Error => unknown(message, { local_stop_only: true, remote_cancel_confirmed: false,
        ...(error instanceof ContractError ? { local_error_code: error.code } : {}) });
      const stop = (error: Error) => {
        failure ??= error;
        if (settled || closed || stopping) return;
        stopping = true; reader?.close();
        if (exited) return;
        child.kill('SIGTERM');
        // Keep escalation alive until actual close; rejection never cancels it prematurely.
        hard = setTimeout(() => { if (!closed && !exited) child.kill('SIGKILL'); }, 1500);
      };
      const timer = setTimeout(() => stop(failed('AGY CLI 等待超时，原远端结果尚未确认')), this.options.timeout_ms ?? 600_000);
      const abort = () => stop(failed('AGY CLI 停止请求，原远端结果或取消未确认'));
      options.signal.addEventListener('abort', abort, { once: true });
      const discard = () => {}; // Native stderr can contain private material; never persist or emit it.
      const streamError = () => stop(failed('AGY CLI 输出流断开，原结果尚未确认'));
      const bytes = (chunk: Buffer) => { if (stopping) return; count += chunk.length; if (count > 20 * 1024 * 1024) stop(failed('AGY stream 超限')); };
      child.stdout.on('data', bytes); child.stdout.on('error', streamError); child.stderr.on('data', discard); child.stderr.on('error', streamError);
      reader = createInterface({ input: child.stdout }); reader.on('error', streamError);
      const line = (line: string) => {
        if (settled || closed || stopping) return;
        try {
          if (Buffer.byteLength(line) > 20 * 1024 * 1024) throw unknown('AGY stream 超限');
          const row: unknown = JSON.parse(line); if (!object(row)) throw unknown('AGY stream 格式错误');
          if (row.event === 'init' && typeof row.conversation_id === 'string' && UUID.test(row.conversation_id)) {
            if (cp.conversation_id && cp.conversation_id !== row.conversation_id) throw unknown('AGY init conversation 发生错配');
            cp = { ...cp, conversation_id: row.conversation_id, native_state: 'running' }; saveCheckpoint(input, cp, options.checkpoint);
          }
          const step = object(row.step_update) ? row.step_update : {}, info = object(step.subagent_info) ? step.subagent_info : {};
          if (Array.isArray(info.subagents)) for (const sub of info.subagents) if (object(sub) && sub.type_name === 'image-generator' && typeof sub.conversation_id === 'string' && UUID.test(sub.conversation_id)) {
            const ids = Array.isArray(cp.child_ids) ? cp.child_ids as string[] : []; cp = { ...cp, child_ids: [...new Set([...ids, sub.conversation_id])] }; saveCheckpoint(input, cp, options.checkpoint);
          }
          if (row.event === 'result' && object(row.result)) {
            if (row.result.conversation_id !== cp.conversation_id) throw unknown('AGY terminal conversation 错配');
            cp = { ...cp, terminal_status: typeof row.result.status === 'string' ? row.result.status : null, usage: numericUsage(row.result.usage), native_state: 'terminal_observed' }; saveCheckpoint(input, cp, options.checkpoint);
          }
        } catch (error) { stop(failed('AGY stream 无法验证，原远端结果尚未确认', error)); }
      };
      reader.on('line', line);
      const processError = () => stop(failed('AGY CLI 未能确认提交结果'));
      child.once('error', processError);
      const finish = (code: number | null, signal: NodeJS.Signals | null, closeObserved: boolean) => {
        if (settled) return;
        settled = true; closed = closeObserved; clearTimeout(timer); if (hard) clearTimeout(hard);
        if (exitDrain) clearTimeout(exitDrain); if (detachedSettle) clearTimeout(detachedSettle); options.signal.removeEventListener('abort', abort);
        reader?.removeListener('line', line); reader?.removeListener('error', streamError); reader?.close();
        child.stdout.removeListener('data', bytes); child.stdout.removeListener('error', streamError);
        child.stderr.removeListener('data', discard); child.stderr.removeListener('error', streamError);
        child.removeListener('error', processError); child.removeListener('exit', exit); child.removeListener('close', close);
        cp = { ...cp, process_exit_code: code, process_exit_signal: signal, local_process_closed: closeObserved, remote_cancel_confirmed: false };
        try { saveCheckpoint(input, cp, options.checkpoint); }
        catch (error) { failure ??= failed('AGY 终态 checkpoint 未持久保存，原结果尚未确认', error); }
        if (options.signal.aborted || code !== 0) failure ??= failed('AGY CLI 停止，远端结果或取消未确认');
        if (failure) reject(unknown(failure.message, { ...(failure instanceof ContractError ? failure.details : {}),
          direct_child_exited: exited, owned_stdio_detached: detached, local_process_closed: closeObserved, descendant_cleanup: 'not_attempted' }));
        else resolve();
      };
      const close = (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal, true);
      const exit = (code: number | null, signal: NodeJS.Signals | null) => {
        exited = true; if (hard) clearTimeout(hard);
        // The own process exited, but an unrelated descendant can still hold these pipe endpoints.
        // Stop waiting after a bounded drain without signalling an unverified process tree.
        exitDrain = setTimeout(() => {
          if (settled || closed) return;
          detached = true; failure ??= failed('AGY 直接进程已退出但输出管道未关闭，原远端结果尚未确认');
          reader?.close(); child.stdout.destroy(); child.stderr.destroy();
          // Normal stream destruction emits child close. A final guard does not require that event.
          detachedSettle = setTimeout(() => finish(code, signal, false), 50);
        }, 250);
      };
      child.once('exit', exit); child.once('close', close);
      if (options.signal.aborted) abort();
    });
    return this.query(input, cp, options.signal);
  }
  async query(input: ImageProviderInput, checkpoint: JsonObject, signal: AbortSignal): Promise<ImageProviderResult> {
    signal.throwIfAborted(); assertCheckpoint(input, checkpoint);
    if (typeof checkpoint.conversation_id !== 'string' || !UUID.test(checkpoint.conversation_id)) throw unknown('AGY 缺少原 conversation ID，未发送新 turn');
    const original = checkpoint.original_input as unknown as ImageProviderInput;
    const main = ownTranscript(this.stateRoot, checkpoint.conversation_id);
    if (!main.some(step => step.type === 'USER_INPUT' && typeof step.content === 'string' && step.content.includes(this.prompt(original)))) throw unknown('AGY 原 conversation 固定输入不符');
    const childIds = new Set<string>();
    for (const step of main) if (step.type === 'GENERIC' && typeof step.content === 'string') {
      for (const match of step.content.matchAll(/"conversationId"\s*:\s*"([a-f0-9-]{36})"/g)) if (UUID.test(match[1]!)) childIds.add(match[1]!);
    }
    if (Array.isArray(checkpoint.child_ids) && checkpoint.child_ids.some(id => typeof id !== 'string' || !childIds.has(id))) throw unknown('AGY 原 child identity 错配');
    const observedTools: string[] = [];
    for (const step of main) if (Array.isArray(step.tool_calls)) for (const tool of step.tool_calls) if (object(tool) && typeof tool.name === 'string') { observedTools.push(tool.name); if (tool.name !== 'invoke_subagent') throw unknown('AGY 主 conversation 使用了图像编排外工具'); }
    const candidates: Array<{ child: string; index: number; args: JsonObject; output: JsonObject }> = [];
    for (const child of childIds) {
      const steps = ownTranscript(this.stateRoot, child);
      for (const step of steps) if (Array.isArray(step.tool_calls)) for (const tool of step.tool_calls) if (object(tool) && typeof tool.name === 'string') { observedTools.push(tool.name); if (!['generate_image', 'send_message'].includes(tool.name)) throw unknown('AGY 图像子执行者使用了未授权工具'); }
      if (!steps.some(step => step.type === 'SYSTEM_MESSAGE' && typeof step.content === 'string' && step.content.includes('sender=' + checkpoint.conversation_id))) throw unknown('AGY 子执行者父 identity 不符');
      for (const step of steps) if (Array.isArray(step.tool_calls)) for (const call of step.tool_calls) if (object(call) && call.name === 'generate_image' && object(call.args) && typeof step.step_index === 'number') {
        const output = steps.find(row => row.step_index === Number(step.step_index) + 1);
        if (!output || output.status !== 'DONE') throw unknown('AGY 原 image call 尚未确认完成');
        candidates.push({ child, index: step.step_index, args: call.args as JsonObject, output });
      }
    }
    if (candidates.length !== 1) throw unknown('AGY 需要唯一原生 image call 与结果', { observed_image_calls: candidates.length });
    const call = candidates[0]!, refs = unquote(call.args.ImagePaths);
    if (original.operation === 'reference_edit' ? !Array.isArray(refs) || refs.length !== 1 || refs[0] !== original.references[0]!.file_path : refs !== undefined && (!Array.isArray(refs) || refs.length !== 0)) throw unknown('AGY 图像工具参考输入错配');
    const database = join(this.stateRoot, 'conversations', call.child + '.db');
    if (!existsSync(database)) throw unknown('AGY 原 image typed result 尚未持久化');
    const db = new DatabaseSync(database, { readOnly: true }); let payload: Buffer;
    try { const row = db.prepare('SELECT step_payload FROM steps WHERE idx=?').get(call.index + 1); if (!row || !(row.step_payload instanceof Uint8Array)) throw unknown('AGY 原 image typed result 不存在'); payload = Buffer.from(row.step_payload); }
    finally { db.close(); }
    const any = bufferField(bufferField(bufferField(payload, 140), 2), 6);
    if (bufferField(any, 1).toString() !== TYPE_URL) throw unknown('AGY 结果类型不是 GenerateImage');
    const typed = bufferField(any, 2), uri = bufferField(typed, 4).toString(), model = bufferField(typed, 6).toString(), size = field(typed, 5, 0) as number;
    const nativeCall = payload.toString('latin1').match(/call_[0-9]+/)?.[0]; if (!nativeCall || !model) throw unknown('AGY 原 image call ID 或模型缺失');
    if (checkpoint.tool_call_id && checkpoint.tool_call_id !== nativeCall) throw unknown('AGY 原 tool call ID 错配');
    if (typeof checkpoint.native_payload_sha256 === 'string' && checkpoint.native_payload_sha256 !== sha(payload)) throw unknown('AGY 原 typed image result 已变化');
    const media = Array.isArray(call.output.media) ? call.output.media : [];
    if (media.filter(item => object(item) && typeof item.mime_type === 'string' && item.mime_type.startsWith('image/')).length !== 1 || !media.some(item => object(item) && item.uri === uri)) throw unknown('AGY typed image URI 与本次工具 media 不符');
    let source: string; try { source = containedFile(fileURLToPath(uri), join(this.stateRoot, 'brain', checkpoint.conversation_id)); } catch { throw unknown('AGY 图像不在原 conversation 产物目录'); }
    const cp: JsonObject = { ...checkpoint, child_ids: [...childIds], image_child_id: call.child, tool_call_id: nativeCall, native_result_step_index: call.index + 1,
      protobuf_type_url: TYPE_URL, protobuf_wire_path: [140, 2, 6], native_payload_sha256: sha(payload), output_uri: uri, model,
      observed_image_calls: 1, observed_native_tools: observedTools, native_state: 'completed', remote_cancel_confirmed: false,
      ...(original.size_request || original.references.some(ref => ref.purpose) ? { accepted_image_parameters: {
        source: 'original_native_generate_image_args', parameters: asJson(call.args),
        structured_size_parameter: null, structured_aspect_parameter: null } } : {}) };
    return imageResult(source, input, cp, model, signal, size);
  }
}
