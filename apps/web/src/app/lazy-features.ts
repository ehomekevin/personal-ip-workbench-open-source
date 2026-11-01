// 首屏不需要的大功能按需加载：配图工作台、语音输入、设置子页（配方、发布连接、连接配置）。
// 这里的同名类/函数与原模块接口一致，real-controller 只换 import 路径；原模块本身不改。
// 加载前：同步渲染方法返回占位（或空），加载完成后由 options.render() 重绘一次；点击属于本功能前缀的动作先加载再交给原控制器；
// 生命周期调用（activate/setLocation 等）记下最后一次意图，加载后补上。挂载后空闲时预取，通常在用户切到这些页面前就已就绪。
type StudioModule = typeof import('../features/media/image-studio/index.ts');
type SpeechModule = typeof import('../features/speech-input/index.ts');
type SkillsModule = typeof import('../features/settings/skills.ts');
type PublishingModule = typeof import('../features/settings/publishing.ts');
type ConfigurationModule = typeof import('../features/settings/configuration.ts');

const PLACEHOLDER = '<div class="empty" role="status">正在打开…</div>';
export interface LazyModule<T> { readonly value: T | undefined; load(): Promise<T> }
/** 失败不缓存（下一次调用重新加载）；成功后 value 同步可用。 */
export function lazyModule<T>(importer: () => Promise<T>): LazyModule<T> {
  let value: T | undefined, pending: Promise<T> | undefined;
  return { get value() { return value; }, load() { return pending ??= importer().then(loaded => (value = loaded), error => { pending = undefined; throw error; }); } };
}
const idle = (run: () => void) => { const w = globalThis as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number }; if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 2000 }); else setTimeout(run, 300); };
const studioModule = lazyModule<StudioModule>(() => import('../features/media/image-studio/index.ts'));
const speechModule = lazyModule<SpeechModule>(() => import('../features/speech-input/index.ts'));
const skillsModule = lazyModule<SkillsModule>(() => import('../features/settings/skills.ts'));
const publishingModule = lazyModule<PublishingModule>(() => import('../features/settings/publishing.ts'));
const configurationModule = lazyModule<ConfigurationModule>(() => import('../features/settings/configuration.ts'));

interface BaseOptions { signal: AbortSignal; toast(message: string): void; render?(): void }
/** 控制器代理的公共部分：加载模块 → 构造原控制器 → 若加载前有同步渲染请求则重绘一次。 */
export abstract class LazyController<M, C, O extends BaseOptions> {
  protected inner: C | undefined; private ready: Promise<C> | undefined; protected renderWanted = false; protected disposed = false; private queued = 0;
  protected readonly options: O; private readonly module: LazyModule<M>; private readonly create: (module: M, options: O) => C;
  constructor(options: O, module: LazyModule<M>, create: (module: M, options: O) => C) {
    this.options = options; this.module = module; this.create = create;
    if (module.value) this.inner = create(module.value, options); else idle(() => { if (!this.disposed && !options.signal.aborted) void this.ensure().catch(() => undefined); });
  }
  protected ensure(): Promise<C> {
    if (this.inner) return Promise.resolve(this.inner);
    return this.ready ??= this.module.load().then(loaded => {
      if (this.disposed || this.options.signal.aborted) throw new DOMException('页面已关闭', 'AbortError');
      this.inner ??= this.create(loaded, this.options); this.afterLoad(this.inner);
      if (this.renderWanted) { this.renderWanted = false; this.options.render?.(); }
      return this.inner;
    }, error => { this.ready = undefined; if (!this.options.signal.aborted) this.options.toast('页面模块未能加载，请刷新页面后重试'); throw error; });
  }
  protected afterLoad(_inner: C): void { /* 子类补上加载前记下的意图。 */ }
  /** 加载前的同步渲染：返回占位并在加载后重绘。 */
  protected placeholder<T>(fallback: T): T { this.renderWanted = true; void this.ensure().catch(() => undefined); return fallback; }
  /** 关闭/失活/离开页面时作废加载期间排队的动作。 */
  protected cancelQueued() { this.queued++; }
  /** 排队动作执行前核对：未被作废、未释放、页面未关闭，且触发它的元素仍在页面上（导航会整体重绘内容）。 */
  protected async whenCurrent(el?: { isConnected?: boolean }): Promise<C | undefined> {
    const queued = this.queued, inner = await this.ensure();
    return queued === this.queued && !this.disposed && !this.options.signal.aborted && el?.isConnected !== false ? inner : undefined;
  }
  /** 属于本功能的点击：已加载直接处理，否则先加载、核对仍是当前页面后再交给原控制器。 */
  protected deferClick(el: HTMLElement, handled: boolean, run: (inner: C) => void): boolean { if (!handled) return false; void this.whenCurrent(el).then(inner => { if (inner) run(inner); }, () => undefined); return true; }
}

type StudioOptions = ConstructorParameters<StudioModule['ImageStudioController']>[0];
type Studio = InstanceType<StudioModule['ImageStudioController']>;
export type StudioStep = 'images' | 'layout';
/** 配图步骤入口：模块未就绪时先按“可挂载”处理，由代理在加载后补挂（真实返回 false 时不激活，与原逻辑一致）。 */
export function mountImageStep(root: HTMLElement): boolean { return studioModule.value ? studioModule.value.mountImageStep(root) : true; }
export function hideGenericImageEntry(root: ParentNode, platform: string): void {
  if (studioModule.value) studioModule.value.hideGenericImageEntry(root, platform);
  else void studioModule.load().then(loaded => loaded.hideGenericImageEntry(root, platform), () => undefined);
}
export class ImageStudioController extends LazyController<StudioModule, Studio, StudioOptions> {
  private intent: { topic: string; mount: boolean } | undefined; private stepIntent: { topic: string; step: StudioStep } | undefined;
  constructor(options: StudioOptions) { super(options, studioModule, (loaded, o) => new loaded.ImageStudioController(o)); }
  protected override afterLoad(inner: Studio) {
    const intent = this.intent; this.intent = undefined;
    if (intent && this.options.active() && studioModule.value!.mountImageStep(this.options.root)) { inner.activate(intent.topic); if (intent.mount) inner.mount(); }
    const step = this.stepIntent; this.stepIntent = undefined; if (step) this.applyStep(inner, step.topic, step.step);
  }
  /** 当前打开的子页：排版 / 配图工作台（用于写进地址，刷新后回到同一处）。 */
  step(): StudioStep | undefined { const inner = this.inner; return inner?.layout?.isOpen ? 'layout' : inner?.workbench.isOpen ? 'images' : undefined; }
  /** 按地址回到子页（刷新后）；模块未加载时加载后补上。 */
  openStep(topic: string, step: StudioStep) { if (this.inner) this.applyStep(this.inner, topic, step); else { this.stepIntent = { topic, step }; void this.ensure().catch(() => undefined); } }
  private applyStep(inner: Studio, topic: string, step: StudioStep) {
    if (!this.options.active()) return;
    if (step === 'layout') { if (!inner.layout?.isOpen) inner.openLayout(topic); }
    else if (!inner.workbench.isOpen) { inner.layout?.close(); inner.workbench.open(topic); }
  }
  activate(topic: string) { if (this.inner) this.inner.activate(topic); else { this.intent = { topic, mount: false }; void this.ensure().catch(() => undefined); } }
  mount() { if (this.inner) this.inner.mount(); else if (this.intent) this.intent.mount = true; }
  deactivate() { this.intent = undefined; this.stepIntent = undefined; this.cancelQueued(); this.inner?.deactivate(); }
  close(...args: Parameters<Studio['close']>) { this.cancelQueued(); this.inner?.close(...args); }
  replace(title: string) { this.inner?.replace(title); }
  dispose() { this.disposed = true; this.intent = undefined; this.cancelQueued(); this.inner?.dispose(); }
  handle(el: HTMLElement) { return this.inner ? this.inner.handle(el) : this.deferClick(el, !!el.dataset.action?.startsWith('studio-'), inner => inner.handle(el)); }
  handleInput(input: HTMLInputElement) { return this.inner?.handleInput(input) ?? false; }
  handleChange(input: HTMLInputElement) { return this.inner?.handleChange(input) ?? false; }
  handleKey(event: KeyboardEvent) { return this.inner?.handleKey(event) ?? false; }
}

type SpeechOptions = ConstructorParameters<SpeechModule['SpeechInputController']>[0];
type Speech = InstanceType<SpeechModule['SpeechInputController']>;
export class SpeechInputController extends LazyController<SpeechModule, Speech, SpeechOptions> {
  constructor(options: SpeechOptions) { super(options, speechModule, (loaded, o) => new loaded.SpeechInputController(o)); }
  async load() { const inner = await this.ensure(); return inner.load(); }
  async openForTopic(...args: Parameters<Speech['openForTopic']>) { if (this.inner) return this.inner.openForTopic(...args); const inner = await this.whenCurrent(); if (inner) return inner.openForTopic(...args); }
  panel() { return this.inner ? this.inner.panel() : this.placeholder(PLACEHOLDER); }
  handleClick(el: HTMLElement) { return this.inner ? this.inner.handleClick(el) : this.deferClick(el, !!el.dataset.action?.startsWith('speech-'), inner => inner.handleClick(el)); }
  handleInput(el: HTMLInputElement) { return this.inner?.handleInput(el) ?? false; }
  handleChange(el: HTMLInputElement) { return this.inner?.handleChange(el) ?? false; }
  replace(title: string) { this.inner?.replace(title); }
  close() { this.cancelQueued(); this.inner?.close(); }
  dispose() { this.disposed = true; this.cancelQueued(); this.inner?.dispose(); }
}

type SkillsOptions = ConstructorParameters<SkillsModule['SkillSettingsController']>[0];
type Skills = InstanceType<SkillsModule['SkillSettingsController']>;
export class SkillSettingsController extends LazyController<SkillsModule, Skills, SkillsOptions> {
  constructor(options: SkillsOptions) { super(options, skillsModule, (loaded, o) => new loaded.SkillSettingsController(o)); }
  async load() { const inner = await this.ensure(); return inner.load(); }
  render() { return this.inner ? this.inner.render() : this.placeholder(PLACEHOLDER); }
  picker(...args: Parameters<Skills['picker']>) { return this.inner ? this.inner.picker(...args) : this.placeholder(''); }
  selection(...args: Parameters<Skills['selection']>) { return this.inner?.selection(...args); }
  handleClick(el: HTMLElement) { return this.inner ? this.inner.handleClick(el) : this.deferClick(el, !!el.dataset.action?.startsWith('skills-'), inner => inner.handleClick(el)); }
  handleInput(...args: Parameters<Skills['handleInput']>) { return this.inner?.handleInput(...args) ?? false; }
  handleChange(...args: Parameters<Skills['handleChange']>) { return this.inner?.handleChange(...args) ?? false; }
}

type PublishingOptions = ConstructorParameters<PublishingModule['PublishingSettingsController']>[0];
type Publishing = InstanceType<PublishingModule['PublishingSettingsController']>;
export class PublishingSettingsController extends LazyController<PublishingModule, Publishing, PublishingOptions> {
  private location: Parameters<Publishing['setLocation']>[0] | undefined;
  constructor(options: PublishingOptions) { super(options, publishingModule, (loaded, o) => new loaded.PublishingSettingsController(o)); }
  protected override afterLoad(inner: Publishing) { if (this.location) inner.setLocation(this.location); this.location = undefined; }
  async load() { const inner = await this.ensure(); return inner.load(); }
  setLocation(location: Parameters<Publishing['setLocation']>[0]) { if (this.inner) this.inner.setLocation(location); else this.location = location; }
  render() { return this.inner ? this.inner.render() : this.placeholder(PLACEHOLDER); }
  deactivate() { this.cancelQueued(); this.inner?.deactivate(); }
  dispose() { this.disposed = true; this.cancelQueued(); this.inner?.dispose(); }
  handleClick(el: HTMLElement) { return this.inner ? this.inner.handleClick(el) : this.deferClick(el, !!el.dataset.action?.startsWith('publishing-'), inner => inner.handleClick(el)); }
  handleChange(el: HTMLInputElement) { return this.inner?.handleChange(el) ?? false; }
  handleKey(event: KeyboardEvent) { return this.inner?.handleKey(event) ?? false; }
}

type ConfigurationOptions = ConstructorParameters<ConfigurationModule['ConfigurationController']>[0];
type Configuration = InstanceType<ConfigurationModule['ConfigurationController']>;
export class ConfigurationController extends LazyController<ConfigurationModule, Configuration, ConfigurationOptions> {
  constructor(options: ConfigurationOptions) { super(options, configurationModule, (loaded, o) => new loaded.ConfigurationController(o)); }
  /** 加载前与原控制器初始值一致（空状态）。 */
  get state(): Configuration['state'] { return this.inner ? this.inner.state : {}; }
  async load(...args: Parameters<Configuration['load']>) { const inner = await this.ensure(); return inner.load(...args); }
  handleClick(el: HTMLElement) { return this.inner ? this.inner.handleClick(el) : this.deferClick(el, !!el.dataset.action?.startsWith('cfg-'), inner => inner.handleClick(el)); }
  handleInput(input: HTMLInputElement) { return this.inner?.handleInput(input) ?? false; }
  handleChange(input: HTMLInputElement) { return this.inner?.handleChange(input) ?? false; }
}
