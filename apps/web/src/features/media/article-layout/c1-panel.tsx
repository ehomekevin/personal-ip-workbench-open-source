import './render-surface.tsx';
import { createRoot, type Root } from 'react-dom/client';
import type { FeatureContext } from '../../../transport/feature-ports.ts';
import type { ArticleLayoutView, ArticleLayoutVisualStatus, ArticleLayoutVisualJobView } from '../../../../../../packages/contracts/src/article-layout.ts';
import { ArticleLayoutController, type ArticleDraftStorage } from './controller.ts';
import { LayoutPage, type LayoutPageState } from './c1-page.tsx';
import { layoutHttpPort, type LayoutPagePort } from './c1-port.ts';
import { layoutErrorCopy } from './c1-model.ts';
import { articleConfirmationIsCurrent } from '../../../../../../packages/domain/src/article-layout/index.ts';
// 公众号排版 C1 面板：创作页内全宽，与配图工作台同级（同一位置、互斥打开）。React 根挂在一个常驻节点上，页面重绘后把同一节点放回原处。
export interface LayoutPanelHost { root: HTMLElement; context(): FeatureContext; active(): boolean; signal: AbortSignal; toast(message: string): void; backToImages(topic: string): void; storage?(): ArticleDraftStorage | null; /** 进入排版时清掉配图页留下的提示。 */ clearToast?(): void }
const memoryStore = (): ArticleDraftStorage => { const m = new Map<string, string>(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: k => { m.delete(k); } }; };
export class ArticleLayoutPanel {
  readonly host: LayoutPanelHost; readonly port: LayoutPagePort;
  private topic = ''; private epoch = 0; private node?: HTMLElement; private root?: Root; private controller?: ArticleLayoutController;
  private view?: Omit<ArticleLayoutView, 'snapshot'>; private error = ''; private busy = false; private message = '';
  private visualSequence = 0; private visual: ArticleLayoutVisualStatus | undefined; private visualPhase = ''; private visualTimer?: ReturnType<typeof setTimeout>;
  private urls = new Map<string, string>(); private failed = new Map<string, string>(); private loading = new Set<string>();
  constructor(host: LayoutPanelHost, port: LayoutPagePort = layoutHttpPort()) { this.host = host; this.port = port; }
  get isOpen() { return !!this.topic; }
  get openTopic() { return this.topic; }
  private owns(epoch: number) { return !this.host.signal.aborted && !!this.topic && epoch === this.epoch; }
  private sessionKey(topic: string) { const i = this.host.context().identity; return 'workbench-layout-open:' + i.workspace_id + ':' + i.service_instance_id + ':' + encodeURIComponent(topic); }
  private remember(topic: string, on: boolean) { try { if (on) sessionStorage.setItem(this.sessionKey(topic), '1'); else sessionStorage.removeItem(this.sessionKey(topic)); } catch { /* 会话存储不可用时只是刷新后不自动回到排版。 */ } }
  /** 刷新页面后回到上次打开的排版（同一会话、同一篇）。 */
  wasOpen(topic: string) { try { return sessionStorage.getItem(this.sessionKey(topic)) === '1'; } catch { return false; } }
  open(topic: string) {
    if (this.topic === topic) { this.mount(); return; }
    this.close(); this.host.clearToast?.(); this.topic = topic; this.epoch++; this.remember(topic, true); this.mount();
    const epoch = this.epoch; void this.port.open(topic, this.host.context()).then(view => { if (this.owns(epoch)) this.apply(view); }).catch(e => { if (!this.owns(epoch)) return; this.error = layoutErrorCopy(e); this.render(); });
  }
  close() {
    const was = this.topic; this.epoch++; this.visualSequence++; clearTimeout(this.visualTimer); this.visual = undefined; this.visualPhase = ''; void this.controller?.leave(); this.controller = undefined; this.root?.unmount(); this.root = undefined; this.node?.remove(); this.node = undefined;
    for (const url of this.urls.values()) URL.revokeObjectURL(url); this.urls.clear(); this.failed.clear(); this.loading.clear();
    this.view = undefined; this.error = ''; this.message = ''; this.busy = false; this.topic = ''; this.host.root.classList.remove('studio-layout-open'); if (was) this.remember(was, false);
  }
  /** 页面切走（导航）时收起，但保留「刷新后回到排版」的记号。 */
  suspend() { const topic = this.topic; this.close(); if (topic) this.remember(topic, true); }
  mount() {
    if (!this.topic || !this.host.active()) return; const page = this.host.root.querySelector('#content .page'); if (!page) return;
    this.host.root.classList.add('studio-layout-open');
    if (!this.node) { this.node = this.host.root.ownerDocument.createElement('div'); this.node.className = 'article-layout-host'; }
    if (this.node.parentElement !== page) page.prepend(this.node);
    this.render();
  }
  /** 每个浏览器标签页一个 id（会话存储），本地未提交缓存按标签页分开。 */
  private tabId() { try { let id = sessionStorage.getItem('article-layout-tab-id'); if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('article-layout-tab-id', id); } return id; } catch { return crypto.randomUUID(); } }
  private storage() { if (this.host.storage) return this.host.storage() ?? memoryStore(); try { return localStorage; } catch { return memoryStore(); } }
  private apply(view: ArticleLayoutView) {
    const { snapshot, ...rest } = view; this.view = rest; this.error = '';
    this.controller?.dispose(); const topic = this.topic, c = this.host.context(), epoch = this.epoch;
    this.controller = new ArticleLayoutController(snapshot, {
      load: async () => (await this.port.load(topic, this.host.context())).snapshot, save: async input => { const saved = await this.port.save(topic, input, this.host.context()); if (saved.state === 'saved' && this.owns(epoch)) void this.refreshVisual(epoch); return saved; },
      check: async () => (await this.port.load(topic, this.host.context())).snapshot,
      // C2：确认排版只认服务端结果；视图（配图状态）随确认回执一起更新。
      confirm: async base => { const { snapshot: confirmed, ...next } = await this.port.confirm(topic, base.version, this.host.context()); if (this.owns(epoch)) { this.view = next; void this.refreshVisual(epoch); } return { snapshot: confirmed, message: '排版已确认为终稿' }; },
    }, this.storage(), { ...c.identity, tab_id: this.tabId() });
    this.controller.subscribe(() => this.loadImages()); this.loadImages(); this.render(); void this.controller.resume(); void this.refreshVisual(this.epoch);
  }
  private loadImages() {
    const snapshot = this.controller?.state().snapshot; if (!snapshot) return; const epoch = this.epoch;
    for (const b of snapshot.blocks) if (b.kind === 'image' && !this.urls.has(b.image.asset_id) && !this.loading.has(b.image.asset_id) && !this.failed.has(b.image.asset_id)) {
      const id = b.image.asset_id; this.loading.add(id);
      void this.port.image({ asset_id: id, sha256: b.image.sha256 }, this.host.context()).then(url => { if (!this.owns(epoch)) { URL.revokeObjectURL(url); return; } this.urls.set(id, url); }).catch(() => { if (this.owns(epoch)) this.failed.set(id, '图片暂时读不到'); }).finally(() => { this.loading.delete(id); if (this.owns(epoch)) this.render(); });
    }
  }
  private async acceptVisual(job: ArticleLayoutVisualJobView, epoch: number) {
    if (!this.owns(epoch)) return;
    this.visualSequence++; // An explicit job response supersedes any status read started by a preceding save.
    this.visual = { available: this.visual?.available ?? true, reason: this.visual?.reason ?? null, latest: job };
    if (job.state === 'completed' && job.current && this.controller && this.node) await this.controller.check(this.node);
    if (!this.owns(epoch)) return;
    this.render(); this.scheduleVisual(epoch);
  }
  private scheduleVisual(epoch: number) {
    clearTimeout(this.visualTimer);
    if (this.owns(epoch) && this.visual?.latest && ['queued','running'].includes(this.visual.latest.state)) this.visualTimer = setTimeout(() => { void this.refreshVisual(epoch); }, 1500);
  }
  private async refreshVisual(epoch: number) {
    if (!this.port.visualStatus || !this.owns(epoch)) return;
    const sequence = ++this.visualSequence;
    try {
      const status = await this.port.visualStatus(this.topic, this.host.context()); if (!this.owns(epoch) || sequence !== this.visualSequence) return;
      const previous = this.visual?.latest; this.visual = status;
      if (status.latest?.state === 'completed' && status.latest.current && (previous?.state !== 'completed' || previous.job_id !== status.latest.job_id) && this.controller && this.node) await this.controller.check(this.node);
      if (!this.owns(epoch)) return; this.render(); this.scheduleVisual(epoch);
    } catch (error) { if (this.owns(epoch) && sequence === this.visualSequence) { this.visual = { available: false, reason: layoutErrorCopy(error), latest: this.visual?.latest ?? null }; this.render(); } }
  }
  private checkVisual() {
    const epoch = this.epoch, controller = this.controller; if (!controller || !this.port.visualRender || !this.port.visualCheck) return;
    this.visualSequence++; clearTimeout(this.visualTimer);
    void this.run(async () => {
      await controller.flush(); if (controller.state().status !== 'saved') { this.message = '先保存当前修改，再检查排版'; return; }
      if (!this.owns(epoch)) return;
      const version = controller.state().snapshot.version;
      this.visualPhase = '正在生成当前文章的完整手机渲染'; this.render();
      try {
        const rendered = await this.port.visualRender!(this.topic, version, this.host.context()); if (!this.owns(epoch)) return;
        if (controller.state().status !== 'saved' || controller.state().snapshot.version !== version) { this.message = '渲染期间文章已修改，请保存后检查当前版本'; return; }
        this.visualPhase = '正在提交当前排版检查'; this.render();
        const job = await this.port.visualCheck!(this.topic, version, rendered.render_id, this.host.context()); await this.acceptVisual(job, epoch);
      } catch (error) { await this.refreshVisual(epoch); throw error; } finally { if (this.owns(epoch)) this.visualPhase = ''; }
    });
  }
  private queryVisual(cancel = false) {
    const epoch = this.epoch, job = this.visual?.latest, action = cancel ? this.port.visualCancel : this.port.visualQuery;
    if (!job || !action) return;
    this.visualSequence++; clearTimeout(this.visualTimer);
    void this.run(async () => { const next = await action(this.topic, job.job_id, this.host.context()); await this.acceptVisual(next, epoch); });
  }
  private async run(action: () => Promise<void>) { if (this.busy) return; const epoch = this.epoch; this.busy = true; this.message = ''; this.render(); try { await action(); } catch (e) { if (this.owns(epoch)) this.message = layoutErrorCopy(e); } finally { if (this.owns(epoch)) { this.busy = false; this.render(); } } }
  private resync() {
    const epoch = this.epoch, controller = this.controller; if (!controller) return;
    void this.run(async () => {
      await controller.flush(); if (controller.state().status !== 'saved') { this.message = '先等当前修改保存好，再同步配图'; return; }
      const view = await this.port.syncImages(this.topic, controller.state().snapshot.version, this.host.context()); if (!this.owns(epoch)) return;
      this.apply(view); this.host.toast('配图已同步，你改过的文字、宽度和位置都保留了');
    });
  }
  private confirm() {
    const epoch = this.epoch, controller = this.controller; if (!controller) return;
    void this.run(async () => { const message = await controller.confirm(); if (!this.owns(epoch)) return; if (articleConfirmationIsCurrent(controller.state().snapshot)) this.host.toast(message); else this.message = message; });
  }
  private reloadLatest() {
    const controller = this.controller; if (!controller) return;
    void this.run(async () => { const server = await controller.compareCurrent(); controller.resolveConflict(server); await controller.flush(); });
  }
  private render() {
    if (!this.node || !this.topic) return; this.root ??= createRoot(this.node);
    const back = () => { const topic = this.topic; this.close(); this.host.backToImages(topic); };
    const exit = () => { this.close(); };
    if (!this.controller || !this.view) {
      this.root.render(<section className="image-workbench article-layout-c1" aria-label="公众号排版"><div className="iwb-empty" role={this.error ? 'alert' : 'status'}>{this.error ? <><b>排版暂时打不开</b><p>{this.error}</p><div className="alc-row"><button type="button" className="button primary" onClick={back}>返回配图</button><button type="button" className="button" onClick={exit}>返回平台稿</button></div></> : <p>正在按确认的配图排入正文…</p>}</div></section>);
      return;
    }
    const state: LayoutPageState = { topic_title: this.view.topic_title, images: this.view.images, busy: this.busy, message: this.message, visual: this.visual, visual_phase: this.visualPhase };
    this.root.render(<LayoutPage controller={this.controller} state={state} imageUrl={id => this.urls.get(id)} imageError={id => this.failed.get(id)} onBack={back} onClose={exit} onResync={() => this.resync()} onReloadLatest={() => this.reloadLatest()} onConfirm={() => this.confirm()} onVisualCheck={() => this.checkVisual()} onVisualQuery={() => this.queryVisual()} onVisualCancel={() => this.queryVisual(true)} onVisualRefresh={() => { void this.refreshVisual(this.epoch); }} />);
  }
}
