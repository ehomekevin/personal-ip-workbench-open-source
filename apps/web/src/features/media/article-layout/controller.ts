import type { ArticleBlock, ArticleLayoutSnapshot, ArticleLayoutSaveResult } from '../../../../../../packages/contracts/src/article-layout.ts';
import { editArticleText, updateArticleStyle, reorderArticleBlocks, updateArticleImageDisplay, restoreArticleContent, restoreArticleLayout } from '../../../../../../packages/domain/src/article-layout/index.ts';

export interface ArticleLayoutPort {
  load(): Promise<ArticleLayoutSnapshot>;
  save(input: { expected_version: number; snapshot: ArticleLayoutSnapshot; idempotency_key: string }): Promise<ArticleLayoutSaveResult>;
  check?(snapshot: ArticleLayoutSnapshot, article: HTMLElement): Promise<ArticleLayoutSnapshot>;
  confirm?(snapshot: ArticleLayoutSnapshot): Promise<{ snapshot: ArticleLayoutSnapshot; message: string }>;
  check_unavailable_reason?: string;
  confirm_unavailable_reason?: string;
}
export interface ArticleDraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export type LayoutSaveStatus = 'saved' | 'dirty' | 'saving' | 'offline' | 'conflict';
/** foreign：同一篇在另一个浏览器窗口（标签页）还有没保存的修改；这里不会覆盖它。 */
export interface LayoutUiState { snapshot: ArticleLayoutSnapshot; status: LayoutSaveStatus; error: string; generation: number; foreign?: boolean }
interface DraftEnvelope { owner?: string; article_id: string; base_version: number; base_document_revision_id: string | null; generation: number; snapshot: ArticleLayoutSnapshot; pending: { key: string; snapshot: ArticleLayoutSnapshot; expected_version: number; generation: number } | null }
const clone = <T,>(value: T): T => structuredClone(value);
const text = (block: ArticleBlock): string | null => 'text' in block ? block.text : block.kind === 'image' ? block.caption : null;

/** Replay only user edits onto an acknowledged save. Never import an old job's text. */
export function rebaseLocalEdits(ack: ArticleLayoutSnapshot, before: ArticleLayoutSnapshot, after: ArticleLayoutSnapshot): ArticleLayoutSnapshot {
  const next = clone(ack);
  for (const block of after.blocks) {
    const previous = before.blocks.find(b => b.id === block.id), target = next.blocks.find(b => b.id === block.id);
    if (!previous || !target) continue;
    if (text(block) !== text(previous)) {
      if ('text' in target && 'text' in block) target.text = block.text;
      if (target.kind === 'image' && block.kind === 'image') target.caption = block.caption;
    }
    if (target.kind === 'image' && block.kind === 'image' && previous.kind === 'image' && block.display_width_percent !== previous.display_width_percent) target.display_width_percent = block.display_width_percent;
  }
  for (const name of Object.keys(after.style) as Array<keyof typeof after.style>) if (after.style[name] !== before.style[name]) Object.assign(next.style, { [name]: after.style[name] });
  if (JSON.stringify(before.order) !== JSON.stringify(after.order)) {
    const available = new Set(next.blocks.map(b => b.id)); next.order = after.order.filter(id => available.has(id));
    // New adopted images/blocks from the saved head must survive an older local reorder.
    for (const id of ack.order) if (!next.order.includes(id)) { const preceding = ack.order.slice(0, ack.order.indexOf(id)).reverse().find(item => next.order.includes(item)); const at = preceding ? next.order.indexOf(preceding) + 1 : 0; next.order.splice(at, 0, id); }
  }
  return next;
}
export function prepareLayoutSave(base: ArticleLayoutSnapshot, draft: ArticleLayoutSnapshot): ArticleLayoutSnapshot {
  // Explicit history restore is already a domain mutation with its own provenance.
  if (draft.events.length > base.events.length && ['content_restore', 'layout_restore'].includes(draft.events.at(-1)?.kind ?? '')) return clone(draft);
  let next = clone(base);
  for (const block of draft.blocks) {
    const current = next.blocks.find(b => b.id === block.id);
    if (!current) throw new Error('图文块已变化，请先核对当前文章。');
    if (text(block) !== text(current) && text(block) !== null) next = editArticleText(next, block.id, text(block)!);
    if (block.kind === 'image' && current.kind === 'image' && block.display_width_percent !== current.display_width_percent) next = updateArticleImageDisplay(next, block.id, block.display_width_percent);
  }
  if (JSON.stringify(base.style) !== JSON.stringify(draft.style)) next = updateArticleStyle(next, draft.style);
  if (JSON.stringify(base.order) !== JSON.stringify(draft.order)) next = reorderArticleBlocks(next, draft.order);
  return next;
}

/** Content and layout saves are serial; unacknowledged input is a recovery buffer only. */
export class ArticleLayoutController {
  private base: ArticleLayoutSnapshot;
  private current: LayoutUiState;
  private readonly listeners = new Set<() => void>();
  private pending: DraftEnvelope['pending'] = null;
  private saving: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** 离开中：排空保存队列，不再接受新输入。 */
  private closing = false;
  private readonly tabs: string;
  private readonly baseKey: string;
  private readonly tab: string | null;
  readonly port: ArticleLayoutPort;
  private readonly cache: ArticleDraftStorage;
  private readonly key: string;
  /** 本控制器实例；本地未提交缓存只由写入它的实例按代次清除，晚到的旧保存回执不会删掉新实例的缓存。 */
  private readonly owner = globalThis.crypto.randomUUID();
  /** identity.tab_id：每个浏览器标签页一份本地未提交缓存（键带标签页 id），多个窗口离线编辑互不覆盖；不传时沿用单键（叶子行为）。 */
  constructor(initial: ArticleLayoutSnapshot, port: ArticleLayoutPort, cache: ArticleDraftStorage, identity: { workspace_id: string; service_instance_id: string; tab_id?: string }) {
    this.base = clone(initial); this.port = port; this.cache = cache;
    const base = ['article-layout-unsubmitted.v1', identity.workspace_id, identity.service_instance_id, initial.article_id].map(encodeURIComponent).join(':');
    this.tab = identity.tab_id ?? null; this.key = this.tab ? base + ':' + encodeURIComponent(this.tab) : base; this.tabs = base + ':tabs'; this.baseKey = base;
    this.current = { snapshot: clone(initial), status: 'saved', error: '', generation: 0 };
    try {
      const raw = cache.getItem(this.key); const recovered = raw ? JSON.parse(raw) as DraftEnvelope : null;
      if (recovered?.article_id === initial.article_id && recovered.snapshot.document_id === initial.document_id) {
        const conflict = recovered.base_version !== initial.version || recovered.base_document_revision_id !== initial.document_revision_id;
        this.current = { snapshot: recovered.snapshot, status: conflict && !recovered.pending ? 'conflict' : 'dirty', error: conflict && !recovered.pending ? '服务器已有新版本，本机修改已保留，请对照后再保存。' : '', generation: recovered.generation ?? 1 };
        this.pending = recovered.pending;
      }
    } catch { this.current = { ...this.current, status: 'offline', error: '未提交副本暂时无法读取，请先保持页面打开。' }; }
    if (this.tab) this.current = { ...this.current, foreign: this.otherTabs().length > 0 };
  }
  private tabList(): string[] { try { const raw = this.cache.getItem(this.tabs); const list = raw ? JSON.parse(raw) as unknown : []; return Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : []; } catch { return []; } }
  private otherTabs(): string[] { return this.tabList().filter(t => t !== this.tab && this.cache.getItem(this.baseKey + ':' + encodeURIComponent(t)) !== null); }
  private markTab(on: boolean) { if (!this.tab) return; try { const list = this.tabList().filter(t => t !== this.tab); if (on) list.push(this.tab); if (list.length) this.cache.setItem(this.tabs, JSON.stringify(list)); else this.cache.removeItem(this.tabs); } catch { /* 标签页索引只用于提示。 */ } }
  state = (): LayoutUiState => this.current;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  private emit() { for (const fn of this.listeners) fn(); }
  private persist() {
    if (this.disposed) return;
    this.markTab(true);
    try { this.cache.setItem(this.key, JSON.stringify({ owner: this.owner, article_id: this.base.article_id, base_version: this.base.version, base_document_revision_id: this.base.document_revision_id, generation: this.current.generation, snapshot: this.current.snapshot, pending: this.pending } satisfies DraftEnvelope)); }
    catch { this.current = { ...this.current, status: 'offline', error: '本机未提交副本保存失败，服务保存前请保持页面打开。' }; }
  }
  private clearOwn(generation: number) {
    try { const raw = this.cache.getItem(this.key); if (!raw) return; const stored = JSON.parse(raw) as DraftEnvelope; if (stored.owner === this.owner && stored.generation <= generation) { this.cache.removeItem(this.key); this.markTab(false); } }
    catch { /* 读不出的缓存保持原样，不当作可以删除。 */ }
  }
  edit(mutator: (snapshot: ArticleLayoutSnapshot) => void) {
    if (this.closing || this.disposed) return;
    const snapshot = clone(this.current.snapshot); mutator(snapshot);
    this.current = { snapshot, status: this.current.status === 'conflict' ? 'conflict' : 'dirty', error: this.current.status === 'conflict' ? this.current.error : '', generation: this.current.generation + 1 };
    this.persist(); this.emit(); clearTimeout(this.timer);
    if (this.current.status !== 'conflict') this.timer = setTimeout(() => { void this.flush(); }, 1000);
  }
  editText(id: string, value: string) { this.edit(snapshot => { const block = snapshot.blocks.find(b => b.id === id); if (block && 'text' in block) block.text = value; else if (block?.kind === 'image') block.caption = value; }); }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.saving) { await this.saving; if (this.current.status === 'dirty') return this.flush(); return; }
    if (this.current.status === 'conflict' || this.current.status === 'saved' || this.disposed) return;
    this.saving = (async () => {
      const captured = clone(this.current.snapshot), generation = this.current.generation;
      try {
        const command = this.pending ?? { key: crypto.randomUUID(), expected_version: this.base.version, snapshot: prepareLayoutSave(this.base, captured), generation };
        this.pending = command; this.persist(); this.current = { ...this.current, status: 'saving', error: '' }; this.emit();
        const result = await this.port.save({ expected_version: command.expected_version, snapshot: command.snapshot, idempotency_key: command.key });
        if (result.state === 'conflict') { this.pending = null; this.current = { ...this.current, status: 'conflict', error: '服务器已有新版本，本机修改已保留，请对照后再保存。' }; this.persist(); this.emit(); return; }
        // An idempotent replay can return an older receipt than the head loaded on refresh.
        // Keep the newer known head, including images adopted since that command committed.
        const acknowledged = result.snapshot.version < this.base.version ? this.base : result.snapshot;
        this.base = clone(acknowledged); this.pending = null;
        const changedWhileSaving = this.current.generation !== command.generation;
        const snapshot = changedWhileSaving ? rebaseLocalEdits(acknowledged, command.snapshot, this.current.snapshot) : clone(acknowledged);
        this.current = { ...this.current, snapshot, status: changedWhileSaving ? 'dirty' : 'saved', error: '' };
        if (changedWhileSaving) this.persist(); else this.clearOwn(command.generation);
        this.emit();
      } catch (error) { this.current = { ...this.current, status: 'offline', error: error instanceof Error ? error.message : String(error) }; this.persist(); this.emit(); }
    })().finally(() => { this.saving = null; });
    await this.saving;
    if (this.current.status === 'dirty') return this.flush();
  }
  async compareCurrent(): Promise<ArticleLayoutSnapshot> { return this.port.load(); }
  /** Called only after the user has compared the persisted head with their retained draft. */
  resolveConflict(server: ArticleLayoutSnapshot) {
    if (server.article_id !== this.base.article_id || server.document_id !== this.base.document_id) throw new Error('不能用另一篇文章解决保存冲突。');
    this.base = clone(server); this.pending = null;
    this.current = { ...this.current, snapshot: rebaseLocalEdits(server, server, this.current.snapshot), status: 'dirty', error: '', generation: this.current.generation + 1 };
    this.persist(); this.emit();
  }
  async restore(kind: 'content' | 'layout', id: string) {
    await this.flush(); if (this.current.status !== 'saved') return;
    const snapshot = kind === 'content' ? restoreArticleContent(this.base, id) : restoreArticleLayout(this.base, id);
    this.current = { ...this.current, snapshot, status: 'dirty', generation: this.current.generation + 1 }; this.persist(); this.emit(); await this.flush();
  }
  async check(article: HTMLElement) {
    await this.flush(); if (this.current.status !== 'saved' || !this.port.check) return;
    const generation = this.current.generation, snapshot = clone(this.base);
    try { const result = await this.port.check(snapshot, article); if (generation !== this.current.generation) return; this.base = clone(result); this.current = { ...this.current, snapshot: result }; this.emit(); }
    catch (error) { this.current = { ...this.current, error: error instanceof Error ? error.message : String(error) }; this.emit(); }
  }
  async confirm(): Promise<string> {
    await this.flush(); if (this.current.status !== 'saved' || !this.port.confirm) return '先保存当前修改。';
    const generation = this.current.generation, result = await this.port.confirm(clone(this.base));
    if (generation === this.current.generation) { this.base = clone(result.snapshot); this.current = { ...this.current, snapshot: result.snapshot }; this.emit(); }
    return result.message;
  }
  /** 离开排版（关闭、导航、返回配图）：先把未保存的修改发出去，再收起；保存回执晚到也不会删掉之后新开编辑器的缓存。 */
  // 排空保存队列：等进行中的保存完成，把之后的修改再提交一次；排空期间不接受新输入，排空后才收起。
  leave(): Promise<void> {
    if (this.closing || this.disposed) return Promise.resolve(); this.closing = true; clearTimeout(this.timer);
    return (async () => { if (this.saving) await this.saving; if (this.current.status === 'dirty' || this.current.status === 'offline') await this.flush(); })().catch(() => undefined).finally(() => this.dispose());
  }
  /** 重新打开时恢复出未提交的修改：继续调度保存（沿用原保存身份，可安全重发）。 */
  resume(): Promise<void> { return this.current.status === 'dirty' ? this.flush() : Promise.resolve(); }
  dispose() { clearTimeout(this.timer); if (this.current.status !== 'saved') this.persist(); this.disposed = true; this.listeners.clear(); }
}
