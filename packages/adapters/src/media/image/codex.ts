import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ContractError, type JsonObject } from '@workbench/contracts';
import { CodexNative, type NativeMessage } from '../../agent/codex/native.ts';
import { object } from '../../agent/codex/primitives.ts';
import { asJson, assertCheckpoint, baseCheckpoint, bindingMarker, containedFile, imageResult, saveCheckpoint, sha, startCheckpoint, unknown, validateInput } from './common.ts';
import type { ImageProviderInput, ImageProviderOptions, ImageProviderPort, ImageProviderResult } from './types.ts';
import { imageRpcAudit } from './audit.ts';
import { imageMcpNames } from './mcp-configuration.ts';
import { imageCapabilities, imageCompositionPrompt } from './capabilities.ts';
export class CodexImageProvider implements ImageProviderPort {
  readonly id = 'codex' as const;
  private readonly options: ImageProviderOptions;
  constructor(options: ImageProviderOptions = {}) { this.options = options; }
  private native(input: ImageProviderInput, purpose: 'execute' | 'query' = 'execute'): CodexNative { return new CodexNative({ executable: this.options.executable,
    cwd: input.work_directory, schemaDirectory: this.options.schema_directory ?? join(input.work_directory, 'codex-schema'),
    mcpNames: imageMcpNames(this.options), env: this.options.env, imageGeneration: true, sink: imageRpcAudit(input, purpose) }); }
  async describe(): Promise<JsonObject> {
    let version: string | null = null;
    try { version = execFileSync(this.options.executable ?? 'codex', ['--version'], { encoding: 'utf8', timeout: 10_000, env: this.options.env, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* no provider request */ }
    return { provider: this.id, configured: version !== null, runtime_version: version, model: null,
      credential_reference: 'native subscription account/read; credential material not copied', identity: 'unverified', connection: 'unverified_current_session', permission: 'unverified_current_session',
      operations: { generate: 'unverified', reference_edit: 'unverified', mask: 'unverified', strict_region_control: 'unverified' },
      operation_evidence: 'probe-r1 host image passed; CLI imageGeneration capability true; native image turn requires workbench test',
      execution_policy: 'image/code-mode wrapper features; other native tools disabled and read-only sandbox; image-only wrapper prompt is not a strong code-mode tool allowlist', online_query: true, remote_cancel: 'unverified',
      image_studio: imageCapabilities(this.id) };
  }
  private prompt(input: ImageProviderInput, version = 'image-exec.v2'): string {
    if (version === 'image-only.v1') return bindingMarker(input) + '\nGenerate exactly ONE image using only the native image_generation tool. ' +
      'Keep the first result. No automatic correction, retry, alternative provider, shell, code, web, MCP or file reads. ' +
      'Stop on any failure or unknown. ' + (input.operation === 'reference_edit' ? 'Edit the supplied single reference image. ' : '') +
      'Image brief:\n' + input.prompt + '\nReturn the image artifact; never fabricate a model ID or result.';
    return bindingMarker(input) + '\nGenerate exactly ONE image. Use exec only as the native image wrapper: call tools.image_gen__imagegen once, then emit its result with generatedImage(result). ' +
    'No other exec tools, arbitrary code, filesystem APIs, shell, web, MCP or file reads are authorized. Keep the first result. No automatic correction, retry or alternative provider. ' +
    'Stop on any failure or unknown. ' + (input.operation === 'reference_edit' ? 'Edit the supplied single reference image. ' : '') +
    'Image brief:\n' + imageCompositionPrompt(input) + input.prompt + '\nReturn the image artifact; never fabricate a model ID or result.';
  }
  private preSubmitError(error: unknown, phase: string, cp: JsonObject, signal: AbortSignal): ContractError {
    const details: JsonObject = { pre_submit_failure: true, no_new_turn_started: true, no_new_submit: true, pre_submit_phase: phase,
      underlying_error_type: error instanceof Error ? error.name : typeof error, native_thread_created: typeof cp.thread_id === 'string',
      ...(typeof cp.thread_id === 'string' ? { native_thread_id: cp.thread_id } : {}) };
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError'))
      return new ContractError('HOST_INTERRUPTED', 'Codex 图像任务在原生准备阶段已被停止，尚未发出 turn/start', details);
    if (error instanceof ContractError) return new ContractError(error.code, error.message, { ...error.details, ...details }, error.retryable);
    return new ContractError('CAPABILITY_UNVERIFIED', 'Codex 图像原生准备未完成，未提交图像 turn', details);
  }
  async execute(input: ImageProviderInput, options: { signal: AbortSignal; checkpoint: (value: JsonObject) => void; prior?: JsonObject }): Promise<ImageProviderResult> {
    await validateInput(input, this.id, options.signal);
    if (options.prior) return this.query(input, options.prior, options.signal);
    const existing = startCheckpoint(input, options.checkpoint); if (existing) return this.query(input, existing, options.signal);
    let cp: JsonObject = { ...baseCheckpoint(input), native_prompt_version: 'image-exec.v2' }, submitted = false, phase = 'native_setup';
    let native: CodexNative;
    try { native = this.native(input); } catch (error) { throw this.preSubmitError(error, phase, cp, options.signal); }
    try {
      options.signal.throwIfAborted(); phase = 'initialize';
      await native.initialize(true);
      options.signal.throwIfAborted(); phase = 'account_read';
      const account = await native.request('account/read', {}) as JsonObject;
      options.signal.throwIfAborted();
      if (!object(account.account) || account.account.type !== 'chatgpt') throw new ContractError('AUTH_REQUIRED', '图像渠道需要已有 Codex 订阅身份', { pre_submit_failure: true });
      phase = 'capability_read'; const caps = await native.request('modelProvider/capabilities/read', {}) as JsonObject;
      options.signal.throwIfAborted();
      if (caps.imageGeneration !== true) throw new ContractError('CAPABILITY_UNSUPPORTED', '原生 Codex 未提供图像能力', { pre_submit_failure: true });
      phase = 'thread_create'; options.signal.throwIfAborted();
      const started = await native.request('thread/start', { cwd: input.work_directory, modelProvider: 'openai', model: 'gpt-6.1-sol',
        serviceTier: 'default', sandbox: 'read-only', approvalPolicy: 'never',
        baseInstructions: 'Use exec only as a wrapper for exactly one native tools.image_gen__imagegen invocation and generatedImage(result). No other exec tools, arbitrary code, shell, browser, web, MCP, hooks, skills or alternative providers. Never retry.',
        developerInstructions: 'Only the native image generation call through exec is authorized. Wrapper access to any other tool or filesystem is forbidden. No file access except explicit image reference input. Preserve the workbench binding. Keep the first image.',
        config: { web_search: 'disabled' } }) as { thread: { id: string }; modelProvider: string };
      if (started.modelProvider !== 'openai' || !started.thread?.id) throw new ContractError('AUTH_REQUIRED', '原生图像 thread provider 与订阅路线不符', { pre_submit_failure: true });
      cp = { ...cp, thread_id: started.thread.id, native_state: 'thread_ready', model_provider: 'openai', capability_image_generation: true };
      phase = 'thread_checkpoint'; saveCheckpoint(input, cp, options.checkpoint);
      options.signal.throwIfAborted();
      let resolveDone: () => void, rejectDone: (error: Error) => void;
      const completed = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      // Attach before turn/start because turn/started may arrive before its response.
      let timer: NodeJS.Timeout | undefined, disposed = false;
      const cleanup = () => { if (disposed) return; disposed = true; if (timer) clearTimeout(timer); options.signal.removeEventListener('abort', abort); unobserve(); };
      const fail = (error: Error) => { cleanup(); rejectDone!(error); };
      const abort = () => { if (typeof cp.turn_id === 'string') void native.request('turn/interrupt', { threadId: cp.thread_id, turnId: cp.turn_id }).catch(() => {}); fail(unknown('Codex 图像停止请求，远端终态尚未确认')); };
      const unobserve = native.observe((message: NativeMessage) => {
        const params = message.params;
        if (message.id !== undefined && message.method) { native.deny(message.id); return; }
        if (message.method === '$transport/error') { fail(unknown('Codex 图像原生连接断开')); return; }
        if (!params || params.threadId !== cp.thread_id) return;
        try {
          if (message.method === 'turn/started' && object(params.turn) && typeof params.turn.id === 'string') {
            if (cp.turn_id && cp.turn_id !== params.turn.id) throw unknown('Codex 图像 turn identity 错配');
            cp = { ...cp, turn_id: params.turn.id, native_state: 'running' }; saveCheckpoint(input, cp, options.checkpoint);
          }
          if (typeof cp.turn_id === 'string' && params.turnId !== undefined && params.turnId !== cp.turn_id) return;
          if (message.method === 'item/completed' && object(params.item) && params.item.type === 'imageGeneration') {
            const prior = Array.isArray(cp.image_item_ids) ? cp.image_item_ids : [];
            cp = { ...cp, image_item_ids: [...new Set([...prior, String(params.item.id)])], image_item: asJson(params.item) }; saveCheckpoint(input, cp, options.checkpoint);
          }
          if (message.method === 'thread/tokenUsage/updated' && object(params.tokenUsage)) { cp = { ...cp, usage: asJson(params.tokenUsage) }; saveCheckpoint(input, cp, options.checkpoint); }
          if (message.method === 'turn/completed' && object(params.turn) && params.turn.id === cp.turn_id) {
            cp = { ...cp, terminal_status: String(params.turn.status), native_state: 'terminal_observed' }; saveCheckpoint(input, cp, options.checkpoint);
            cleanup(); resolveDone!();
          }
        } catch (error) { fail(error instanceof Error ? error : unknown('Codex 图像事件无效')); }
      });
      timer = setTimeout(() => fail(unknown('Codex 图像等待超时，仅可查询原 turn')), this.options.timeout_ms ?? 600_000);
      options.signal.addEventListener('abort', abort, { once: true });
      // A rejection must always have a handler, including failures during the turn/start RPC.
      void completed.catch(() => {});
      try {
        options.signal.throwIfAborted(); cp = { ...cp, submit_count: 1, native_state: 'submitting' }; phase = 'turn_checkpoint'; saveCheckpoint(input, cp, options.checkpoint);
        options.signal.throwIfAborted(); phase = 'turn_submit'; submitted = true;
        const result = await native.request('turn/start', { threadId: started.thread.id, cwd: input.work_directory, model: 'gpt-6.1-sol',
          effort: 'high', serviceTierForTurn: 'default', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
          input: [{ type: 'text', text: this.prompt(input) }, ...input.references.map(ref => ({ type: 'localImage', path: ref.file_path }))] }, 30_000) as { turn: { id: string } };
        if (cp.turn_id && cp.turn_id !== result.turn.id) throw unknown('Codex 图像 turn response identity 错配');
        cp = { ...cp, turn_id: result.turn.id }; saveCheckpoint(input, cp, options.checkpoint);
        await completed;
      } finally { cleanup(); }
      return await this.read(native, input, cp, options.signal);
    } catch (error) {
      if (!submitted) throw this.preSubmitError(error, phase, cp, options.signal);
      if (submitted && !(error instanceof ContractError)) throw unknown('Codex 图像提交后结果不明');
      throw error;
    } finally { await native.close(); }
  }
  async query(input: ImageProviderInput, checkpoint: JsonObject, signal: AbortSignal): Promise<ImageProviderResult> {
    signal.throwIfAborted(); assertCheckpoint(input, checkpoint);
    if (typeof checkpoint.thread_id !== 'string' || typeof checkpoint.turn_id !== 'string' || !checkpoint.thread_id || !checkpoint.turn_id) throw unknown('Codex 图像缺少原 thread/turn ID，未提交新 turn');
    const native = this.native(input, 'query');
    try { await native.initialize(true); return await this.read(native, input, checkpoint, signal); }
    finally { await native.close(); }
  }
  private async read(native: CodexNative, input: ImageProviderInput, cp: JsonObject, signal: AbortSignal): Promise<ImageProviderResult> {
    signal.throwIfAborted(); assertCheckpoint(input, cp);
    if (typeof cp.thread_id !== 'string' || typeof cp.turn_id !== 'string') throw unknown('Codex 图像原 IDs 不完整');
    const reply = await native.request('thread/read', { threadId: cp.thread_id, includeTurns: true }) as { thread: { id: string; modelProvider: string; turns: JsonObject[] } };
    signal.throwIfAborted(); if (reply.thread.id !== cp.thread_id) throw unknown('Codex 图像只读查询 thread 错配');
    if (cp.model_provider !== 'openai' || reply.thread.modelProvider !== 'openai') throw unknown('Codex 图像原 provider 绑定不符');
    const turn = reply.thread.turns.find(item => item.id === cp.turn_id);
    if (!turn || turn.status !== 'completed' || !Array.isArray(turn.items)) throw unknown('Codex 图像原 turn 尚未确认完成');
    const original = cp.original_input as unknown as ImageProviderInput;
    if (cp.native_prompt_version !== undefined && cp.native_prompt_version !== 'image-exec.v2') throw unknown('Codex 原图像 prompt 版本未知');
    const originalPrompt = this.prompt(original, cp.native_prompt_version === 'image-exec.v2' ? 'image-exec.v2' : 'image-only.v1');
    if (!turn.items.some(item => object(item) && item.type === 'userMessage' && Array.isArray(item.content) && item.content.some(content => object(content) && content.type === 'text' && content.text === originalPrompt))) throw unknown('Codex 图像原 turn 固定输入不符');
    const user = turn.items.find(item => object(item) && item.type === 'userMessage' && Array.isArray(item.content) && item.content.some(content => object(content) && content.type === 'text' && content.text === originalPrompt)) as JsonObject;
    const localImages = (user.content as JsonObject[]).filter(item => item.type === 'localImage');
    if (localImages.length !== original.references.length || localImages.some((item, index) => item.path !== original.references[index]!.file_path)) throw unknown('Codex 原 image reference 输入错配');
    const images = turn.items.filter(item => object(item) && item.type === 'imageGeneration') as JsonObject[];
    if (images.length === 0 && turn.itemsView === 'full' && !cp.image_item_ids)
      throw new ContractError('CAPABILITY_UNVERIFIED', '原 Codex 图像 turn 已完成但未返回图片，当前路线尚未通过真实准入', {
        no_new_submit: true, provider_terminal_confirmed: true, native_turn_status: 'completed', observed_image_calls: 0, image_route_unavailable: true });
    if (images.length !== 1) throw unknown('Codex 原 turn 需要唯一 imageGeneration item', { observed_image_calls: images.length });
    const image = images[0]!;
    if (Array.isArray(cp.image_item_ids) && (cp.image_item_ids.length !== 1 || cp.image_item_ids[0] !== image.id)) throw unknown('Codex 原 image item ID 错配');
    if (image.failure) throw new ContractError('QUOTA_EXHAUSTED', 'Codex 原 imageGeneration 返回额度失败', { no_new_submit: true });
    if (!['completed', 'succeeded', 'success'].includes(String(image.status))) throw unknown('Codex 原 imageGeneration 未确认成功');
    let source: string;
    if (typeof image.savedPath === 'string') {
      // Native generation may save under the original cwd or native-owned image cache.
      const path = image.savedPath, ownRoots = [original.work_directory, join(this.options.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'generated_images')];
      const valid = ownRoots.map(root => { try { return containedFile(path, root); } catch { return null; } }).find(Boolean);
      if (!valid) throw unknown('Codex savedPath 不属于原任务或原生图像目录'); source = valid;
    } else {
      // Typed imageGeneration.result is image bytes. Do not consume agent text paths.
      const encoded = typeof image.result === 'string' ? image.result.replace(/^data:image\/(?:png|jpeg|webp);base64,/, '') : '';
      if (encoded.length > 42 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw unknown('Codex 原 imageGeneration 缺少 savedPath 或有效图像字节');
      const bytes = Buffer.from(encoded, 'base64'); if (bytes.toString('base64') !== encoded) throw unknown('Codex 图像 base64 不是规范编码');
      source = join(input.output_directory, '.native-result-' + sha(bytes));
      try { writeFileSync(source, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || sha(readFileSync(source)) !== sha(bytes)) throw error; }
    }
    return imageResult(source, input, { ...cp, image_item_ids: [String(image.id)], native_state: 'completed', observed_image_calls: 1,
      revised_prompt: image.revisedPrompt ?? null, image_status: image.status ?? null, model: null, remote_cancel_confirmed: false,
      ...(original.size_request || original.references.some(ref => ref.purpose) ? { accepted_image_parameters: {
        source: 'original_native_turn_input', parameters: { prompt: originalPrompt, local_images: localImages.map(item => ({ path: item.path })) },
        revised_prompt: image.revisedPrompt ?? null, inner_image_tool_arguments: 'not_exposed_in_typed_item',
        structured_size_parameter: null, structured_aspect_parameter: null } } : {}) }, null, signal);
  }
}
