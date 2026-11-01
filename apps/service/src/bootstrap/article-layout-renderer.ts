import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { ApplicationContext } from '@workbench/domain/ports';
import type { ArticleLayoutSnapshot, ArticleLayoutVisualContext, LayoutRenderedBlock, LayoutVisualInput } from '../../../../packages/contracts/src/article-layout.ts';
import { captionDisplayText, canonicalJson } from '../../../../packages/domain/src/article-layout/index.ts';
import { WECHAT_LAYOUT_STANDARD, layoutRenderSnapshotHash, layoutBlockStructureHash, validateLayoutVisualInput } from '../../../../packages/adapters/src/media/layout-check/input.ts';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const ARTICLE_LAYOUT_RENDERER_VERSION = 'c1-reader.v3';
type Message = { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } };
type Pending = { resolve(value: Record<string, unknown>): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> };
/** Chrome DevTools pipe is local to this owned child; there is no debugging TCP port or npm browser dependency. */
class ChromePipe {
  readonly child: ChildProcess;
  private sequence = 0; private pending = new Map<number, Pending>(); private buffered = ''; private stopped = false; private exited: Promise<void>; private closing?: Promise<void>;
  onEvent?: (message: Message) => void;
  constructor(executable: string, profile: string) {
    this.child = spawn(executable, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1','--proxy-server=direct://','--metrics-recording-only','--remote-debugging-pipe','--force-device-scale-factor=1','--user-data-dir=' + profile,'about:blank'], { detached: true, stdio: ['ignore','ignore','ignore','pipe','pipe'] });
    this.exited = new Promise(done => { this.child.once('exit', () => { this.fail(new Error('排版渲染 Chrome 已关闭')); done(); }); this.child.once('error', error => { this.fail(error); done(); }); });
    (this.child.stdio[4] as Readable).setEncoding('utf8').on('data', (chunk: string) => {
      this.buffered += chunk; let end: number;
      while ((end = this.buffered.indexOf('\0')) >= 0) {
        const raw = this.buffered.slice(0, end); this.buffered = this.buffered.slice(end + 1); if (!raw) continue;
        let message: Message; try { message = JSON.parse(raw) as Message; } catch { this.fail(new Error('Chrome pipe 返回无效 JSON')); continue; }
        if (message.id) { const p = this.pending.get(message.id); if (!p) continue; clearTimeout(p.timer); this.pending.delete(message.id); if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result ?? {}); }
        else this.onEvent?.(message);
      }
    });
    (this.child.stdio[3] as Writable).on('error', error => this.fail(error));
  }
  private fail(error: Error) { this.stopped = true; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.stopped) return Promise.reject(new Error('排版渲染 Chrome 不可用'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('排版渲染 Chrome 操作超时：' + method)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      (this.child.stdio[3] as Writable).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  close(): Promise<void> { return this.closing ??= this.stop(); }
  private async stop() {
    if (!this.stopped) {
      let gracefulTimer: ReturnType<typeof setTimeout> | undefined;
      void this.send('Browser.close').catch(() => undefined);
      await Promise.race([this.exited, new Promise<void>(done => { gracefulTimer = setTimeout(done, 1000); })]);
      clearTimeout(gracefulTimer);
    }
    this.fail(new Error('排版渲染已结束'));
    const kill = (signal: NodeJS.Signals) => { if (this.child.pid) try { process.kill(-this.child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
    kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.exited, new Promise<void>(done => { timer = setTimeout(() => { kill('SIGKILL'); done(); }, 2000); })]);
    clearTimeout(timer); await this.exited;
    for (const fd of this.child.stdio) if (fd && 'destroy' in fd) fd.destroy();
  }
}
interface RenderDOM { width: number; height: number; blocks: LayoutRenderedBlock[]; texts: Record<string, string>; captions: Record<string, string>; images: Array<{ id: string; width: number; height: number; source: string }> }
export interface ArticleLayoutRendererOptions { web_url: string; standard_png: string; standard_html: string; chrome_executable?: string }
export class ArticleLayoutRenderer {
  private readonly context: ApplicationContext; private readonly options: ArticleLayoutRendererOptions;
  private active = new Map<AbortController, Promise<LayoutVisualInput>>(); private closed = false;
  constructor(context: ApplicationContext, options: ArticleLayoutRendererOptions) {
    const url = new URL(options.web_url);
    if (url.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(url.hostname) || url.username || url.password) throw new Error('排版 renderer 只接受自己的本机工作台 URL');
    this.context = context; this.options = { ...options };
  }
  render(snapshot: ArticleLayoutSnapshot, visualContext: ArticleLayoutVisualContext, directory: string, signal: AbortSignal): Promise<LayoutVisualInput> {
    if (this.closed) return Promise.reject(new Error('排版 renderer 已关闭'));
    const own = new AbortController(), abort = () => own.abort(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    const work = this.perform(structuredClone(snapshot), structuredClone(visualContext), directory, own.signal).finally(() => { signal.removeEventListener('abort', abort); this.active.delete(own); });
    this.active.set(own, work); return work;
  }
  async close(): Promise<void> { this.closed = true; for (const controller of this.active.keys()) controller.abort(new Error('服务关闭，停止自己的排版渲染')); await Promise.allSettled([...this.active.values()]); }
  private async perform(snapshot: ArticleLayoutSnapshot, visualContext: ArticleLayoutVisualContext, directory: string, signal: AbortSignal): Promise<LayoutVisualInput> {
    signal.throwIfAborted();
    if (visualContext.workspace_id !== this.context.identity.workspace_id || visualContext.renderer_version !== ARTICLE_LAYOUT_RENDERER_VERSION || visualContext.snapshot_version !== snapshot.version || visualContext.snapshot_sha256 !== sha256(canonicalJson(snapshot)) || visualContext.content_revision_id !== snapshot.content_revision_id || visualContext.layout_revision_id !== snapshot.layout_revision_id || visualContext.text_hash !== snapshot.text_hash || visualContext.images_hash !== snapshot.images_hash) throw new Error('排版渲染上下文与冻结快照不符');
    if (snapshot.style.mobile_width !== 390 || snapshot.style.page_padding !== 16 || snapshot.blocks.some(b => b.id === '__topic_title__') || new Set(snapshot.order).size !== snapshot.order.length) throw new Error('当前渲染要求 390px/16px 及唯一块身份');
    await mkdir(directory, { recursive: true }); const workDirectory = await realpath(directory); if (!isAbsolute(directory) || resolve(directory) !== workDirectory) throw new Error('排版渲染目录必须是规范绝对路径');
    const freeze = async (name: string, bytes: Buffer | string) => { const path = join(workDirectory, name); await writeFile(path, bytes, { flag: 'wx', mode: 0o444 }); return path; };
    const png = await readFile(this.options.standard_png), html = await readFile(this.options.standard_html);
    if (sha256(png) !== WECHAT_LAYOUT_STANDARD.png_sha256 || sha256(html) !== WECHAT_LAYOUT_STANDARD.html_sha256) throw new Error('排版原版标准字节已变化');
    const standard_png = { path: await freeze('original-standard.png', png), sha256: sha256(png) }, standard_html = { path: await freeze('original-standard.html', html), sha256: sha256(html) };
    await freeze('visual-context.json', canonicalJson(visualContext)); await freeze('snapshot.json', canonicalJson(snapshot));
    const data: Record<string, string> = {}, imageFacts = new Map<string, Record<string, unknown>>(), mediaRoot = await realpath(this.context.paths.media_root);
    for (const block of snapshot.blocks) if (block.kind === 'image' && snapshot.order.includes(block.id)) {
      signal.throwIfAborted(); const row = this.context.db.prepare('SELECT file_path,sha256,size_bytes,mime,status FROM assets WHERE workspace_id=? AND id=?').get(visualContext.workspace_id, block.image.asset_id);
      if (!row || row.status !== 'ready' || row.sha256 !== block.image.sha256) throw new Error('排版图片不属于当前可用资产或摘要不符');
      const path = await realpath(String(row.file_path)), rel = relative(mediaRoot, path), info = await stat(path);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || !info.isFile() || info.size > 32 * 1024 * 1024 || info.size !== Number(row.size_bytes)) throw new Error('排版图片必须是当前 media 内有界实际文件');
      const bytes = await readFile(path), mime = String(row.mime);
      const magic = bytes.subarray(0, 12), actualMime = magic.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'image/png' : magic.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'image/jpeg' : magic.subarray(0, 3).toString() === 'GIF' ? 'image/gif' : magic.subarray(0, 4).toString() === 'RIFF' && magic.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
      if (!actualMime || actualMime !== mime || sha256(bytes) !== block.image.sha256) throw new Error('排版图片实际字节、格式或 hash 不符');
      data[block.image.asset_id] = 'data:' + mime + ';base64,' + bytes.toString('base64');
      const frozen = await freeze('asset-' + imageFacts.size + '.' + mime.split('/')[1], bytes);
      imageFacts.set(block.id, { ...block.image, path: frozen, caption: block.caption, caption_display: captionDisplayText(block), source_caption: block.original_caption });
    }
    signal.throwIfAborted(); const profile = await mkdtemp(join(tmpdir(), 'workbench-layout-chrome-'));
    const chrome = new ChromePipe(this.options.chrome_executable ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', profile);
    const abort = () => { void chrome.close().catch(() => undefined); }; signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true }); if (typeof sessionId !== 'string') throw new Error('Chrome 缺少渲染 session');
      const command = (method: string, params: Record<string, unknown> = {}) => chrome.send(method, params, sessionId);
      const allowedOrigin = new URL(this.options.web_url).origin;
      chrome.onEvent = message => { if (message.method !== 'Fetch.requestPaused' || message.sessionId !== sessionId) return;
        const params = message.params!, request = params.request as { url: string; method: string }, requestId = params.requestId;
        let allowed = false; try { const url = new URL(request.url); allowed = request.method === 'GET' && url.origin === allowedOrigin && (url.pathname === new URL(this.options.web_url).pathname || url.pathname === '/index.html' || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/workbench/')); } catch { /* blocked */ }
        void command(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) }).catch(() => undefined);
      };
      await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable'); await command('Network.setBlockedURLs', { urls: ['ws://*','wss://*','ftp://*','file://*'] }); await command('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      await command('Page.navigate', { url: this.options.web_url });
      const evaluate = async (expression: string) => { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error('C1 Reader 实际渲染失败：' + JSON.stringify(result.exceptionDetails)); return (result.result as { value: unknown }).value; };
      await evaluate("new Promise((resolve,reject)=>{const end=Date.now()+20000;const poll=()=>{if(typeof window.__articleLayoutRender==='function')resolve(true);else if(Date.now()>end)reject(new Error('C1 Reader bridge unavailable'));else setTimeout(poll,25)};poll()})");
      const dom = await evaluate('window.__articleLayoutRender(' + JSON.stringify(snapshot) + ',' + JSON.stringify(visualContext.topic_title) + ',' + JSON.stringify(data) + ')') as RenderDOM;
      if (dom.width !== 390 || !Number.isFinite(dom.height) || dom.height <= 0 || dom.height > 131072) throw new Error('C1 Reader 宽度或自然全文高度无效');
      const expectedIds = [...(!snapshot.blocks.some(b => b.kind === 'title') && visualContext.topic_title ? ['__topic_title__'] : []), ...snapshot.order];
      if (canonicalJson(dom.blocks.map(b => b.id)) !== canonicalJson(expectedIds)) throw new Error('实际渲染未完整覆盖当前图文顺序与 fallback 标题');
      for (const block of snapshot.blocks) if (snapshot.order.includes(block.id)) {
        if ('text' in block && dom.texts[block.id] !== block.text) throw new Error('C1 实际文字与当前排版不符');
        if (block.kind === 'image') { const actual = dom.images.find(i => i.id === block.id); if (!actual || actual.width !== block.image.pixel_width || actual.height !== block.image.pixel_height || actual.source !== data[block.image.asset_id] || dom.captions[block.id] !== captionDisplayText(block)) throw new Error('C1 实际图片尺寸、图注或图源不符'); dom.blocks.find(b => b.id === block.id)!.image = imageFacts.get(block.id); }
      }
      if (expectedIds[0] === '__topic_title__' && dom.texts.__topic_title__ !== visualContext.topic_title) throw new Error('C1 fallback 标题不符');
      const slices: LayoutVisualInput['render_pngs'] = [];
      for (let y = 0; y < dom.height; y += 4096) {
        signal.throwIfAborted(); const height = Math.min(4096, dom.height - y), result = await command('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y, width: 390, height, scale: 1 } });
        const bytes = Buffer.from(String(result.data), 'base64');
        slices.push({ path: await freeze('article-' + slices.length + '.png', bytes), sha256: sha256(bytes), width: 390, height, offset_y: y, block_ids: dom.blocks.filter(b => b.bounds.y < y + height && b.bounds.y + b.bounds.height >= y).map(b => b.id) });
      }
      const input: LayoutVisualInput = { work_directory: workDirectory, standard_png, standard_html, blocks: dom.blocks, render_pngs: slices, binding: { article_id: snapshot.article_id, content_revision_id: snapshot.content_revision_id, layout_revision_id: snapshot.layout_revision_id, text_hash: snapshot.text_hash, images_hash: snapshot.images_hash, standard_version: snapshot.standard.version, standard_png_sha256: standard_png.sha256, standard_html_sha256: standard_html.sha256, render_snapshot_sha256: layoutRenderSnapshotHash(slices), block_structure_sha256: layoutBlockStructureHash(dom.blocks) } };
      validateLayoutVisualInput(input); await freeze('visual-input.json', canonicalJson(input)); signal.throwIfAborted(); return input;
    } finally { signal.removeEventListener('abort', abort); await chrome.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }
}
