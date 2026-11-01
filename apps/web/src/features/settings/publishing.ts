import { PUBLISHING_FORMATS_BY_PLATFORM, PUBLISHING_ROUTE_PLATFORMS, PLATFORMS, ContractError, type CapabilityStatus, type ContentFormat, type Platform, type PublishingSettingsLocation, type PublishingSettingsResponse, type PublishingConnectionView, type PublishingConnectionResponse, type PublishingCheckResponse, type PublishingRoute, type ServiceIdentity, type Page, type AccountSnapshotView } from '@workbench/contracts';
import type { WorkbenchClient } from '../../transport/workbench-client.ts';
import { createTemplateHelpers } from '../../components/templateHelpers.ts';
import { P } from '../../components/metadata.ts';

const { esc, btn, tag, heading, icon } = createTemplateHelpers([]);
const labels: Record<CapabilityStatus, string> = { unconfigured: '未配置', unverified: '待验证', supported: '已验证可用', unsupported: '当前不支持', degraded: '连接受限' };
const formatLabels: Record<ContentFormat, string> = { text: '文字单帖', thread: '线程', article: '文章', image_post: '图文', short_video: '短视频', long_video: '视频' };
const runtimeLabels = { not_applied: '尚未生效', active: '已生效', pending: '待生效', apply_failed: '生效失败' };
const checkLabels = { passed: '通过', failed: '失败', unavailable: '尚未实现' };
const reasons: Record<Platform, string> = {
  xiaohongshu: '官方分享 SDK 当前暂停接入，且不支持自动填充标题、正文和话题。优先使用网页创作中心；公开作品另行核对。',
  wechat: '文章草稿与公开发布分别核对，账号发布资格和权限仍需真实验证。',
  x: '单帖与线程按账号、形式及操作分别验证，连接检查不等于可以提交发布。',
  douyin: '上传、处理中与公开发布分别记录，不从上传成功推断作品已经发布。',
  bilibili: '官方投稿 API 需要开发者应用、ARC_BASE 权限和账号授权；入驻文档目前未开放个人开发者申请。普通账号优先使用网页投稿。',
};
const routeFor = (platform: Platform): PublishingRoute | undefined => (Object.entries(PUBLISHING_ROUTE_PLATFORMS).find(([, value]) => value === platform)?.[0] as PublishingRoute | undefined);
const rows = (values: [string, string][], cls = '') => '<dl class="status-list ' + cls + '">' + values.map(([name, value]) => '<div><dt>' + esc(name) + '</dt><dd>' + value + '</dd></div>').join('') + '</dl>';
const panel = (title: string, body: string, suffix = '', cls = '') => '<section class="panel ' + cls + '"><div class="panel-head"><h2>' + title + '</h2>' + suffix + '</div><div class="panel-body">' + body + '</div></section>';
const statusTag = (status: CapabilityStatus) => tag(labels[status], 'capability-status status-' + status);
// 完整静态路径同时供 Web 与插件构建器内嵌品牌素材。
const platformLogoPaths: Record<Platform, string> = { xiaohongshu: '/workbench/platforms/xiaohongshu.svg', wechat: '/workbench/platforms/wechat.svg', x: '/workbench/platforms/x.svg', douyin: '/workbench/platforms/douyin.svg', bilibili: '/workbench/platforms/bilibili.svg' };
const platformLogo = (platform: Platform) => '<img class="publisher-platform-logo" src="' + platformLogoPaths[platform] + '" alt="" width="32" height="32">';
const authenticatedConnection = (c?: PublishingConnectionView) => !!c && c.runtime.state === 'active' && c.runtime.credentials_ready && c.runtime.active_config_revision === c.config_revision && c.last_check?.config_revision === c.config_revision && c.last_check.identity === 'passed' && c.last_check.reachability === 'passed' && c.last_check.permissions !== 'failed';
function errorCode(error: unknown): string { return error && typeof error === 'object' && 'response' in error ? String((error as { response: { error: { code: string } } }).response.error.code) : error instanceof ContractError ? error.code : ''; }
function stamp(value: string | null | undefined): string { return value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '尚未检查'; }
export function publishingSummary(data: PublishingSettingsResponse, platform: Platform): CapabilityStatus {
  const account = data.defaults.find(d => d.platform === platform)?.account_id ?? data.accounts.find(a => a.platform === platform && a.publish_target_eligible)?.account_id;
  const connection = data.connections.find(c => c.platform === platform && c.account_id === account);
  if (!connection) return routeFor(platform) ? 'unconfigured' : 'unsupported';
  const statuses = connection.capabilities.filter(c => c.operation === 'submit').map(c => c.status);
  return ['degraded', 'unconfigured', 'unverified', 'unsupported', 'supported'].find(s => statuses.includes(s as CapabilityStatus)) as CapabilityStatus ?? 'unverified';
}
interface Draft { accountId: string; connectionId?: string; expectedVersion: number; reference: string; format: ContentFormat; key: string; error: string; conflict: boolean; reviewed: boolean; mode: 'configure' | 'bind' | 'default' }
interface Options { root: HTMLElement; client: WorkbenchClient; signal: AbortSignal; identity(): ServiceIdentity | undefined; render(): void; toast(message: string): void; navigate(location: PublishingSettingsLocation | { page: 'settings' }): void|Promise<void>; returnToPublishing?(): void; hasReturn?(): boolean }

// 仅保存页面草稿；所有配置、能力和检查结果仍来自唯一主服务。
export class PublishingSettingsController {
  data?: PublishingSettingsResponse;
  location: PublishingSettingsLocation = { page: 'settings', settings_view: 'publishing', platform: 'x' };
  format: ContentFormat = 'text';
  busy = false;
  problem = '';
  private accountMetrics?: { accountId: string; text: string };
  draft?: Draft;
  private generation = 0;
  private focusGeneration = 0;
  private opener?: HTMLElement;
  private dialog: HTMLDialogElement;
  private options: Options;
  constructor(options: Options) {
    this.options = options;
    this.dialog = options.root.ownerDocument.createElement('dialog');
    this.dialog.id = 'publishing-config-dialog'; this.dialog.setAttribute('aria-labelledby', 'publishing-dialog-title');
    options.root.append(this.dialog);
    // MCP Apps 宿主可禁止原生 form 提交；按钮点击（含 Enter / Space）仍可保存草稿。
    this.dialog.addEventListener('click', event => {
      const submit = (event.target as Element).closest<HTMLButtonElement>('button[type="submit"]');
      if (!submit || submit.disabled) return;
      event.preventDefault(); void this.save();
    }, { signal: options.signal });
    this.dialog.addEventListener('submit', event => { event.preventDefault(); void this.save(); }, { signal: options.signal });
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); }, { signal: options.signal });
  }
  setLocation(location: PublishingSettingsLocation) {
    if (this.location.platform !== location.platform) this.format = PUBLISHING_FORMATS_BY_PLATFORM[location.platform][0];
    this.location = location;
    this.problem = '';
  }
  // Navigation retires this dialog, but an already accepted save keeps its
  // original lifetime signal and may still finish normally.
  deactivate() { this.generation++; this.focusGeneration++; this.close(false); this.draft = undefined; this.opener = undefined; }
  private checkIdentity(data: { identity: ServiceIdentity }) {
    const identity = this.options.identity();
    if (!identity || data.identity.workspace_id !== identity.workspace_id || data.identity.service_instance_id !== identity.service_instance_id || data.identity.contract_version !== identity.contract_version)
      throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '发布设置与固定工作区身份不一致');
  }
  async load(): Promise<void> {
    const own = ++this.generation;
    const data = await this.options.client.request<PublishingSettingsResponse>('GET', '/api/v1/settings/publishing', undefined, { signal: this.options.signal });
    this.checkIdentity(data);
    if (own !== this.generation || this.options.signal.aborted) return;
    this.data = data;
  }
  private accounts() { return this.data?.accounts.filter(a => a.platform === this.location.platform) ?? []; }
  account() {
    const accounts = this.accounts();
    if (this.location.account_id) return accounts.find(a => a.account_id === this.location.account_id);
    const preferred = this.data?.defaults.find(d => d.platform === this.location.platform && d.format === this.format)?.account_id;
    return accounts.find(a => a.account_id === preferred) ?? accounts.find(a => a.publish_target_eligible) ?? accounts[0];
  }
  connection() { const account = this.account(); return this.data?.connections.find(c => c.platform === this.location.platform && c.account_id === account?.account_id); }
  private choose(platform: Platform, account_id?: string) { return this.options.navigate({ page: 'settings', settings_view: 'publishing', platform, ...(account_id ? { account_id } : {}) }); }
  render(): string {
    const data = this.data, p = this.location.platform, a = this.account(), c = this.connection();
    if (!data) return heading('PREFERENCES / CONNECTIONS', '平台发布', '选好账号，检查连接，再到排期页发布内容。', btn('返回设置', 'publishing-home')) + '<div class="note">正在读取发布账号与连接…</div>';
    const available = !!routeFor(p), configured = !!c, isDefault = !!a && data.defaults.some(d => d.platform === p && d.format === this.format && d.account_id === a.account_id);
    const status: CapabilityStatus = c ? publishingSummary({ ...data, defaults: [{ platform: p, format: this.format, account_id: c.account_id }] }, p) : available ? 'unconfigured' : 'unsupported';
    const canEnable = !!a?.publish_target_eligible && !!c && c.runtime.state === 'active' && c.runtime.credentials_ready && c.config_revision === c.runtime.active_config_revision;
    const tabs = '<div class="platform-tabs publisher-platform-tabs" role="tablist" aria-label="发布平台">' + PLATFORMS.map(platform => '<button role="tab" id="tab-' + platform + '" aria-selected="' + (p === platform) + '" aria-controls="platform-panel" tabindex="' + (p === platform ? 0 : -1) + '" data-action="publishing-platform" data-platform="' + platform + '">' + platformLogo(platform) + '<span><strong>' + P[platform]!.name + '</strong><small>' + (publishingSummary(data, platform) === 'unsupported' ? '通道待接入' : labels[publishingSummary(data, platform)]) + '</small></span></button>').join('') + '</div><div class="platform-mobile"><label class="field-label" for="platform-select">选择平台</label><select class="field" id="platform-select">' + PLATFORMS.map(platform => '<option value="' + platform + '" ' + (p === platform ? 'selected' : '') + '>' + P[platform]!.name + ' · ' + labels[publishingSummary(data, platform)] + '</option>').join('') + '</select></div>';
    const accountHelp = !a ? '选择并核对本人账号后，再配置发布连接。' : !a.publish_target_eligible ? '账号已登记，核对平台身份后才能用于发布。' : !c ? '配置连接后，可设置新计划的默认发布账号。' : '切换默认只影响新计划。已冻结的账号和内容继续保留。';
    const account = '<label class="field-label" for="account-select">发布账号</label><select class="field account-select" id="account-select" ' + (!this.accounts().length ? 'disabled' : '') + '>' + (!a ? '<option>尚无可用本人账号</option>' : '') + this.accounts().map(item => '<option value="' + esc(item.account_id) + '" ' + (a?.account_id === item.account_id ? 'selected' : '') + '>' + esc(item.name) + (data.defaults.some(d => d.platform === p && d.account_id === item.account_id) ? ' · 默认' : '') + '</option>').join('') + '</select>'
      + (a ? '<div class="account-heading"><img src="/workbench/avatar.svg" alt="本人账号头像" width="52" height="52"><div><h3>' + esc(a.name) + '</h3><p class="mono">' + esc(a.platform_account_id ?? '平台身份待补充') + '</p><div class="account-tags">' + tag('本人账号') + tag(a.publish_target_eligible ? '身份已确认' : '身份待核对') + (isDefault ? tag('新计划默认') : '') + '</div></div></div>' : '<div class="note">' + (this.location.account_id ? '当前工作区没有此平台发布账号。选择其他账号后再配置。' : '当前平台尚无本人账号。完成账号身份核对后刷新本页。') + '</div>')
      + '<div class="button-row">' + btn(isDefault ? '默认发布账号' : '设为默认账号', 'publishing-default', false, !a?.publish_target_eligible || !c || this.busy ? 'disabled aria-describedby="publishing-account-help"' : '')
      + btn('绑定账号', 'publishing-bind', false, this.busy || !this.accounts().some(item => item.publish_target_eligible) ? 'disabled aria-describedby="publishing-account-help"' : '')
      + (a?.publish_target_eligible ? btn('查看账号数据', 'publishing-account-metrics', false, this.busy ? 'disabled' : '') : '')
      + (a ? btn(this.busy ? '正在核对…' : p === 'wechat' ? '核对公众号身份' : '用 TikHub 核对身份', 'publishing-account-check', false, this.busy ? 'disabled' : '') : '')
      + (isDefault ? btn('清除默认', 'publishing-clear-default', false, this.busy ? 'disabled' : '') : '') + '</div>'
      + '<p class="support-note" id="publishing-account-help">' + accountHelp + '</p>'
      + (this.accountMetrics && a && this.accountMetrics.accountId === a.account_id ? '<div class="note">' + esc(this.accountMetrics.text) + '</div>' : '');
    const check = c?.last_check;
    const failedCheck = check?.config_revision === c?.config_revision && check && [check.identity, check.permissions, check.reachability].includes('failed');
    const issue = this.problem || (c?.runtime.error_code ? '配置生效失败：' + c.runtime.error_code + '。此前成功生效的修订继续保留。' : failedCheck ? check.limitations.join('；') + '。核对同账号配置后重新检查。' : !available ? reasons[p] : !a?.publish_target_eligible ? '先核对当前工作区的本人账号身份，再配置连接。' : !c ? '先为这个账号配置连接，再检查账号与权限。' : c.runtime.state === 'pending' || c.runtime.state === 'not_applied' ? '配置已保存，应用已保存配置后生效。此前有效连接继续保留。' : status === 'unverified' ? '只读检查不包含真实提交，发布能力仍待验证。' : '');
    const configuration = (available ? rows(c ? [
      ['连接方式', available ? '平台服务连接' : '自动发布尚未开放'], ['配置保存', configured ? '已保存' : '尚未配置'],
      ['运行状态', c ? runtimeLabels[c.runtime.state] : '尚未生效'], ['凭据就绪', c?.runtime.credentials_ready ? '已就绪' : '未就绪'],
      ['连接检查', this.busy ? '<span class="check-progress">正在核对</span>' : check ? '身份 ' + checkLabels[check.identity] + ' / 权限 ' + (p === 'wechat' && check.permissions === 'unavailable' ? '待验证' : checkLabels[check.permissions]) + ' / 可达性 ' + checkLabels[check.reachability] : '尚未检查'],
      ['最近检查', esc(stamp(check?.checked_at)) + (check && check.config_revision !== c?.config_revision ? ' · 旧修订' : '')],
    ] : [['连接方式', '平台服务连接'], ['配置状态', '尚未配置']]) : '<div class="connection-empty"><span class="connection-empty-icon">' + icon('link') + '</span><div><h3>优先使用网页创作中心</h3><p>'+esc(reasons[p])+'</p><a class="button small" target="_blank" rel="noopener noreferrer" href="'+(p==='bilibili'?'https://member.bilibili.com/platform/upload/video/frame':'https://creator.xiaohongshu.com/publish/publish')+'">打开'+P[p]!.name+'创作中心 ↗</a><p class="support-note">打开页面不会发布内容。标题、正文和素材由本人核对后提交。</p><a target="_blank" rel="noopener noreferrer" href="'+(p==='bilibili'?'https://open.bilibili.com/doc/4/cbdcee3b-f57e-5c7b-cf27-83892fb811c4':'https://agora.xiaohongshu.com/doc/js')+'">查看官方接入条件 ↗</a></div></div>') + '<div class="connection-actions">' + btn(configured ? '编辑连接' : '配置连接', 'publishing-configure', true, !available || !a?.publish_target_eligible || this.busy ? 'disabled' : '') + (available ? btn(this.busy ? '检查中…' : '检查连接', 'publishing-check', false, !c || this.busy ? 'disabled' : '') : '') + (available && c && c.runtime.state !== 'active' ? btn('应用已保存配置', 'publishing-apply', false, this.busy ? 'disabled' : '') : '') + '</div>' + (issue && (available || this.problem) ? '<div class="problem" role="status"><strong>' + (this.problem || c?.runtime.error_code ? '需要处理' : '下一步') + '</strong><p>' + esc(issue) + '</p></div>' : '');
    const support = PUBLISHING_FORMATS_BY_PLATFORM[p].map(format => '<div class="support-format"><h3>' + formatLabels[format] + '</h3>' + ([['草稿准备', 'prepareDraft'], ['提交发布', 'submit'], ['结果查询', 'queryResult']] as const).map(([label, operation]) => {
      const capabilities = c?.capabilities.filter(item => item.format === format && item.operation === operation) ?? [];
      return capabilities.length ? capabilities.map(capability => '<div class="capability-row"><span>' + (p === 'wechat' && operation === 'queryResult' && capability.status === 'supported' && capability.limitations.some(limit => limit.includes('只验证已存在草稿')) ? '结果查询 · 草稿读回' : label) + (capabilities.length > 1 ? ' · ' + esc(capability.host_id) : '') + '</span>' + statusTag(capability.status) + '</div>' + (capability.limitations.length ? '<p class="support-note">' + esc(capability.limitations.join('；')) + '</p>' : '')).join('') : '<div class="capability-row"><span>' + label + '</span>' + statusTag(available ? c ? 'unverified' : 'unconfigured' : 'unsupported') + '</div>';
    }).join('') + '</div>').join('') + '<p class="support-note">' + reasons[p] + '</p>';
    const lifecycle = '<div class="setting-row"><div class="setting-copy"><strong>启用发布连接</strong><p>' + (!available ? '通道接入后开放' : c?.enabled ? '新计划仍会核对各项发布能力' : '当前处于关闭状态') + '</p></div><label class="publisher-toggle-target"><span class="screen-reader">启用发布连接</span><input type="checkbox" class="toggle publisher-switch" id="enable-connection" aria-label="启用发布连接" aria-describedby="enable-connection-help" ' + (c?.enabled ? 'checked' : '') + ((!c?.enabled && !canEnable) || this.busy ? ' disabled' : '') + '></label></div><p class="support-note" id="enable-connection-help">' + (!available ? '发布通道的接入状态不会改变数据采集配置。' : !canEnable && !c?.enabled ? '配置生效且凭据就绪后才能启用，提交仍需真实能力证据。' : '停用后不发起新的提交，发送中与未知结果仍保留核对路径。') + '</p><div class="separator"></div>' + '<div class="publisher-data-row"><span class="publisher-data-icon">' + icon('chart') + '</span><div><strong>数据采集</strong><p>由 TikHub 独立配置</p></div>' + tag('独立连接') + '</div><div class="publisher-data-row"><span class="publisher-data-icon">' + icon('calendar') + '</span><div><strong>实际发布</strong><p>' + (available ? '在排期与发布页发起' : '自动发布通道待接入') + '</p></div></div>';
    const evidence = c?.capabilities.map(capability => '<p>' + esc(formatLabels[capability.format] + ' / ' + capability.operation + ' / ' + capability.host_id + ' / ' + capability.adapter_version + ' · ' + (capability.evidence_ref ?? '无真实证据') + ' · ' + (capability.verified_at ?? '尚未验证')) + '</p>').join('') ?? '';
    const diagnostic = '<details class="panel details-panel wide"><summary>诊断与证据范围</summary><div class="panel-body">' + rows([
      ['适配器', esc(c?.runtime.adapter_version ?? '尚未生效')], ['配置引用', esc(c?.credential_ref?.name ?? '未配置')], ['工作区', esc(data.identity.workspace_id)], ['服务', esc(data.identity.service_instance_id)], ['配置版本', c ? String(c.version) + ' / 修订 ' + c.config_revision + ' / 生效 ' + (c.runtime.active_config_revision ?? '无') : '尚无连接'], ['配置主存', 'SQLite · aggregate ' + data.version], ['宿主范围', esc(c?.runtime.host_id ?? '尚未生效')], ['脱敏错误', esc(c?.runtime.error_code ?? '无')],
    ], 'diagnostic-list') + '<p class="fine">只读检查不会上传、创建草稿或发布内容；不把身份查询通过当作提交证据。</p>' + (check ? '<div class="trace-list"><p>只读检查 #' + check.sequence + ' / 修订 ' + check.config_revision + ' / ' + esc(check.check_id) + '</p><p>' + esc(check.limitations.join('；') || '本次检查没有额外限制') + '</p></div>' : '') + '<div class="trace-list">' + evidence + '</div></div></details>';
    const wechatConnected = p === 'wechat' && authenticatedConnection(c);
    const overviewTitle = !available ? '发布通道待接入' : this.problem || c?.runtime.error_code || failedCheck ? '连接需要处理' : !a?.publish_target_eligible ? '账号身份待核对' : !c ? '下一步，配置发布连接' : c.runtime.state !== 'active' ? '连接配置待生效' : !c.runtime.credentials_ready ? '连接凭据尚未就绪' : wechatConnected ? '公众号已连接' : status === 'supported' ? c.enabled ? '发布连接已启用' : '发布能力已验证，连接尚未启用' : labels[status] === '待验证' ? '发布能力待验证' : labels[status];
    const localCredentialEntry = ['x','wechat','douyin'].includes(p) ? '<a class="button small" href="http://127.0.0.1:5190/?kind='+p+(a?'&amp;account_id='+encodeURIComponent(a.account_id):'')+'" target="_blank" rel="noopener noreferrer">填写 / 更新凭据 ↗</a>' : '';
    const overview = '<div class="publisher-overview"><div class="publisher-overview-copy"><span class="publisher-overview-logo">' + platformLogo(p) + '</span><div><p class="publisher-overview-label">' + P[p]!.name + ' · ' + PUBLISHING_FORMATS_BY_PLATFORM[p].map(f => formatLabels[f]).join(' / ') + '</p><h2>' + overviewTitle + '</h2><p>' + (!available ? '账号可以保留在这里，自动投稿需等通道接入后使用。' : wechatConnected ? c?.capabilities.some(item => item.format === 'article' && item.operation === 'prepareDraft' && item.status === 'supported') ? '测试草稿已写入并读回，公开发布仍待验证。' : '账号认证与网络检查通过。草稿写入和公开发布权限仍需分别验证。' : '配置 → 检查 → 验证能力；完成后再安排内容发布。') + '</p></div></div><div class="publisher-connection-actions">'+localCredentialEntry+'<button class="button publisher-refresh" data-action="publishing-refresh" ' + (this.busy ? 'disabled' : '') + '>' + icon('refresh') + '<span>刷新状态</span></button></div></div>';
    return heading('PREFERENCES / CONNECTIONS', '平台发布', '连接你的内容阵地，让每次发布都有序发生。', btn('返回设置', 'publishing-home') + (this.options.hasReturn?.() ? btn('返回发布计划', 'publishing-return') : '')).replace('class="page-heading"', 'class="page-heading publisher-heading"') + tabs + '<div id="platform-panel" class="publisher-refined" role="tabpanel" aria-labelledby="tab-' + p + '">' + overview + '<div class="publisher-grid publisher-grid-refined">' + panel('发布账号', account, tag(P[p]!.name), 'publisher-account') + panel('连接配置', configuration, tag(!available ? '待接入' : c?.enabled ? '已启用' : '未启用'), 'publisher-configuration') + panel('支持的内容', support, statusTag(status), 'publisher-support') + panel('连接与数据', lifecycle, '', 'publisher-lifecycle') + diagnostic + '</div><p class="publisher-footnote">' + icon('check') + '<span>配置和检查不会发布内容。实际提交仍需确认稿件、账号和排期。</span></p></div>';
  }
  handleClick(el: HTMLElement): boolean {
    const action = el.dataset.action;
    if (!action?.startsWith('publishing-')) return false;
    if (action === 'publishing-home') { this.close(false); this.options.navigate({ page: 'settings' }); }
    else if (action === 'publishing-return') this.options.returnToPublishing?.();
    else if (action === 'publishing-platform') this.choose(el.dataset.platform as Platform);
    else if (action === 'publishing-configure' || action === 'publishing-bind' || action === 'publishing-default') this.open(action === 'publishing-bind' ? 'bind' : action === 'publishing-default' ? 'default' : 'configure', el);
    else if (action === 'publishing-close') this.close();
    else if (action === 'publishing-review') void this.reviewDraft();
    else if (action === 'publishing-account-metrics') void this.readAccountMetrics();
    else if (action === 'publishing-account-check') void this.checkAccountIdentity();
    else if (action === 'publishing-refresh') void this.refresh();
    else if (action === 'publishing-apply' || action === 'publishing-check') void this.mutate(action === 'publishing-apply' ? 'apply' : 'check');
    else if (action === 'publishing-clear-default') void this.setDefault(true);
    return true;
  }
  handleChange(el: HTMLInputElement): boolean {
    if (el.id === 'platform-select') this.choose(el.value as Platform);
    else if (el.id === 'account-select') this.choose(this.location.platform, el.value);
    else if (el.id === 'default-format' && this.draft) { this.draft.format = el.value as ContentFormat; this.draft.key = crypto.randomUUID(); }
    else if (el.id === 'enable-connection') void this.mutate('enabled', el.checked);
    else if (el.id === 'connection-ref' && this.draft) { this.draft.reference = el.value; this.draft.key = crypto.randomUUID(); }
    else if (el.id === 'binding-account' && this.draft) this.draft.accountId = el.value;
    else return false;
    return true;
  }
  handleKey(event: KeyboardEvent): boolean {
    const el = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"][data-action="publishing-platform"]');
    if (!el || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return false;
    event.preventDefault();
    const index = PLATFORMS.indexOf(el.dataset.platform as Platform), next = event.key === 'Home' ? 0 : event.key === 'End' ? PLATFORMS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + PLATFORMS.length) % PLATFORMS.length;
    const target=PLATFORMS[next]!,navigation=this.choose(target),own=++this.focusGeneration;
    void Promise.resolve(navigation).then(()=>{if(own===this.focusGeneration&&this.location.platform===target&&!this.options.signal.aborted)this.options.root.querySelector<HTMLElement>('#tab-'+target+'[aria-selected="true"]')?.focus();},()=>{});return true;
  }
  private open(mode: Draft['mode'], opener: HTMLElement) {
    const a = this.account(), c = this.connection();
    if (mode === 'configure' && (!a?.publish_target_eligible || !routeFor(this.location.platform))) return;
    this.opener = opener;
    this.draft = { mode, accountId: a?.account_id ?? this.accounts().find(a => a.publish_target_eligible)?.account_id ?? '', connectionId: c?.id, expectedVersion: mode === 'default' ? this.data!.version : c?.version ?? this.data!.version, reference: c?.credential_ref?.name ?? '', format: this.format, error: '', conflict: false, reviewed: false, key: crypto.randomUUID() };
    this.renderDialog(); this.dialog.showModal(); this.dialog.querySelector<HTMLElement>('select')?.focus();
  }
  private renderDialog() {
    const draft = this.draft; if (!draft) return;
    const bind = draft.mode === 'bind', defaults = draft.mode === 'default', refs = (this.data?.credential_references ?? []).filter(ref => ref.name !== 'WORKBENCH_WECHAT_CREDENTIALS' || this.location.platform === 'wechat'), accounts = this.accounts().filter(a => a.publish_target_eligible);
    this.dialog.innerHTML = '<form class="dialog-form"><div class="dialog-head"><h2 id="publishing-dialog-title">' + (bind ? '绑定本人账号' : defaults ? '设置默认账号' : '配置发布连接') + '</h2><button type="button" class="button ghost dialog-close" data-action="publishing-close" aria-label="关闭配置">✕</button></div><div class="dialog-body"><div class="note config-note">' + (defaults ? '为选定内容形式设置新计划的默认账号。已冻结的账号和内容继续保留。' : '仅选择当前工作区的已确认本人账号和服务允许的连接引用。凭据在服务侧单独配置。') + '</div><p class="fine">' + P[this.location.platform]!.name + ' · ' + esc(this.data?.accounts.find(a => a.account_id === draft.accountId)?.platform_account_id ?? '账号身份待补充') + '</p>' + (defaults ? '<label class="field-label" for="default-format">默认内容形式</label><select class="field" id="default-format">' + PUBLISHING_FORMATS_BY_PLATFORM[this.location.platform].map(f => '<option value="' + f + '" ' + (f === draft.format ? 'selected' : '') + '>' + formatLabels[f] + '</option>').join('') + '</select><p class="fine">默认发布账号：' + esc(this.data?.accounts.find(a => a.account_id === draft.accountId)?.name ?? '账号身份待补充') + '</p>' : bind ? '<label class="field-label" for="binding-account">选择本人账号</label><select class="field" id="binding-account" ' + (!accounts.length ? 'disabled' : '') + '>' + (!accounts.length ? '<option value="">暂无已确认本人账号</option>' : '') + accounts.map(a => '<option value="' + esc(a.account_id) + '" ' + (draft.accountId === a.account_id ? 'selected' : '') + '>' + esc(a.name) + '</option>').join('') + '</select><p class="fine">发布账号复用主服务的账号记录。新账号需要完成本人身份核对后，才会出现在此列表。</p>' : '<label class="field-label" for="connection-ref">连接引用</label><select class="field mono" id="connection-ref" aria-describedby="reference-help"><option value="">未配置 / 清空引用</option>' + (draft.reference && !refs.some(r => r.name === draft.reference) ? '<option value="' + esc(draft.reference) + '" selected disabled>' + esc(draft.reference) + ' · 不在当前允许集合</option>' : '') + refs.map(r => '<option value="' + esc(r.name) + '" ' + (draft.reference === r.name ? 'selected' : '') + '>' + esc(r.name) + '</option>').join('') + '</select><p class="fine" id="reference-help">只显示服务登记的环境引用名称。这里不接收 API Key、令牌或任何秘密值。</p><details class="prototype-controls"><summary>这次保存会做什么</summary><div><p class="fine">保存非敏感配置，不产生平台操作。应用已保存配置后再核对运行状态。</p></div></details>') + '<div id="publishing-form-error" role="alert">' + this.errorHtml() + '</div></div><div class="dialog-foot dialog-actions"><button type="button" class="button" data-action="publishing-close">取消</button><button type="submit" class="button primary" ' + (this.busy || bind && !accounts.length || draft.conflict && !draft.reviewed ? 'disabled' : '') + '>' + (this.busy ? '正在保存…' : bind ? '选择账号' : defaults ? '保存默认账号' : '保存配置') + '</button></div></form>';
  }
  private errorHtml() { const d = this.draft; return d?.error ? '<div class="note error-note"><strong>' + esc(d.error) + '</strong>' + (d.conflict && !d.reviewed ? '<div>' + btn('核对最新版本', 'publishing-review') + '</div>' : '') + '</div>' : ''; }
  private close(focus = true) { if (!this.dialog.open) return; this.dialog.close(); this.draft = undefined; if (focus) this.options.root.querySelector<HTMLElement>('[data-action="' + (this.opener?.dataset.action ?? 'publishing-configure') + '"]')?.focus(); }
  private async reviewDraft() {
    const draft = this.draft; if (!draft || this.busy) return;
    try {
      await this.load();
      if (this.draft !== draft) return;
      const c = this.data?.connections.find(c => c.id === draft.connectionId || !draft.connectionId && c.account_id === draft.accountId && c.platform === this.location.platform);
      draft.connectionId = c?.id; draft.expectedVersion = draft.mode === 'default' ? this.data!.version : c?.version ?? this.data!.version; draft.reviewed = true; draft.key = crypto.randomUUID();
      const currentDefault = this.data?.defaults.find(d => d.platform === this.location.platform && d.format === draft.format);
      draft.error = draft.mode === 'default' ? '已读取最新版本 ' + draft.expectedVersion + '；' + formatLabels[draft.format] + '当前默认账号：' + (this.data?.accounts.find(a => a.account_id === currentDefault?.account_id)?.name ?? '未设置') + '。你的账号与内容形式选择已保留，核对后可再次保存。' : '已读取最新版本 ' + draft.expectedVersion + '；当前已保存引用：' + (c?.credential_ref?.name ?? '未配置') + '。你的选择仍为 ' + (draft.reference || '清空引用') + '，核对后可再次保存。';
      this.options.render(); this.renderDialog(); this.dialog.querySelector<HTMLElement>(draft.mode === 'default' ? '#default-format' : '#connection-ref')?.focus();
    } catch (error) { draft.error = '读取最新版本失败，输入已保留：' + (error instanceof Error ? error.message : '服务暂不可用'); this.renderDialog(); }
  }
  private async save() {
    const draft = this.draft; if (!draft || this.busy || draft.conflict && !draft.reviewed) return;
    if (draft.mode === 'bind') { const account = this.data?.accounts.find(a => a.account_id === draft.accountId && a.platform === this.location.platform && a.publish_target_eligible); if (!account) return; this.close(false); this.choose(this.location.platform, account.account_id); return; }
    if (draft.mode === 'configure' && draft.reference && !this.data?.credential_references.some(ref => ref.name === draft.reference)) { draft.error = '所选引用不在主服务允许集合中，请刷新并核对。'; this.renderDialog(); return; }
    const credential_ref = draft.reference ? { kind: 'environment' as const, name: draft.reference } : null;
    this.busy = true; this.renderDialog();
    try {
      if (draft.mode === 'default') {
        const data = await this.options.client.request<PublishingSettingsResponse>('PUT', '/api/v1/settings/publishing/defaults', { expected_version: draft.expectedVersion, platform: this.location.platform, format: draft.format, account_id: draft.accountId }, { signal: this.options.signal, idempotencyKey: draft.key });
        this.checkIdentity(data); this.generation++; this.data = data; this.format = draft.format; this.close(false); this.options.toast('新计划将预选这个账号；已冻结意图不变。');
      } else {
        const result = draft.connectionId ? await this.options.client.request<PublishingConnectionResponse>('PATCH', '/api/v1/settings/publishing/connections/' + encodeURIComponent(draft.connectionId), { expected_version: draft.expectedVersion, credential_ref }, { signal: this.options.signal, idempotencyKey: draft.key }) : await this.options.client.request<PublishingConnectionResponse>('POST', '/api/v1/settings/publishing/connections', { expected_version: draft.expectedVersion, account_id: draft.accountId, platform: this.location.platform, route: routeFor(this.location.platform), credential_ref }, { signal: this.options.signal, idempotencyKey: draft.key });
        this.acceptConnection(result); this.close(false); this.options.toast('连接配置已保存；应用已保存配置后生效。');
      }
    } catch (error) {
      draft.conflict = errorCode(error) === 'VERSION_CONFLICT'; draft.reviewed = false;
      draft.error = draft.conflict ? (draft.mode === 'default' ? '默认偏好已由另一入口修改，当前账号和内容形式已保留。请核对最新版本。' : '配置已由另一入口修改，输入已保留。请核对最新版本。') : '保存失败，输入与此前配置已保留：' + (error instanceof Error ? error.message : '服务暂不可用');
    } finally { this.busy = false; if (this.draft === draft) this.renderDialog(); else { this.options.render(); this.options.root.querySelector<HTMLElement>('[data-action="publishing-' + (draft.mode === 'default' ? 'default' : 'configure') + '"]')?.focus(); } }
  }
  private acceptConnection(result: PublishingConnectionResponse) { this.checkIdentity(result); if (!this.data) return; this.generation++; const other = this.data.connections.filter(c => c.id !== result.connection.id); this.data = { ...this.data, version: result.settings_version, connections: [...other, result.connection] }; }
  private async refresh() { if (this.busy) return; try { await this.load(); this.problem = ''; this.options.render(); this.options.toast('已刷新主服务账号与连接。'); } catch (error) { this.problem = '刷新失败，已有配置仍保留：' + (error instanceof Error ? error.message : '服务暂不可用'); this.options.render(); } }
  private async mutate(operation: 'apply' | 'check' | 'enabled', enabled?: boolean) {
    const c = this.connection(); if (!c || this.busy) return;
    this.busy = true; this.problem = ''; this.options.render();
    try {
      const input = { expected_version: c.version, ...(operation === 'enabled' ? { enabled } : {}) };
      const result = await this.options.client.request<PublishingConnectionResponse | PublishingCheckResponse>(operation === 'enabled' ? 'PUT' : 'POST', '/api/v1/settings/publishing/connections/' + encodeURIComponent(c.id) + '/' + operation, input, { signal: this.options.signal, idempotencyKey: crypto.randomUUID() });
      this.checkIdentity(result);
      if ('connection' in result) this.acceptConnection(result);
      else if (result.applied_to_current && this.connection()?.id === c.id && this.connection()?.version === result.connection_version && this.data) {
        this.data = { ...this.data, connections: this.data.connections.map(item => item.id === c.id ? { ...item, last_check: result.check } : item) };
      }
      if (operation === 'check') { await this.load(); this.options.toast('只读检查已保存；发布能力仍按真实证据核对。'); }
      else this.options.toast(operation === 'apply' ? '已读取配置生效结果。' : enabled ? '连接已启用；提交仍需真实能力证据。' : '连接已停用；发送中与未知结果仍需核对。');
    } catch (error) { this.problem = errorCode(error) === 'VERSION_CONFLICT' ? '连接已由另一入口修改。刷新并核对最新配置后重试。' : '操作失败，此前有效修订与结果仍保留：' + (error instanceof Error ? error.message : '服务暂不可用'); }
    finally { this.busy = false; this.options.render(); this.options.root.querySelector<HTMLElement>('[data-action="publishing-' + (operation === 'enabled' ? 'refresh' : operation) + '"]')?.focus(); }
  }
  private async readAccountMetrics() {
    const account = this.account(); if (!account || this.busy) return;
    this.busy = true; this.problem = ''; this.options.render();
    try {
      const page = await this.options.client.request<Page<AccountSnapshotView>>('GET', '/api/v1/accounts/' + encodeURIComponent(account.account_id) + '/snapshots?limit=100', undefined, { signal: this.options.signal });
      if (this.account()?.account_id !== account.account_id || this.options.signal.aborted) return;
      const snapshot = page.items[0], names: Record<string,string> = { account_posts: '历史发帖', account_following: '关注', account_followers: '粉丝' };
      this.accountMetrics = { accountId: account.account_id, text: snapshot ? snapshot.metrics.map(m => (names[m.key] ?? m.key) + '：' + (m.value ?? '—') + (m.availability === 'unsupported' ? '（接口未提供）' : m.value === null ? '（暂不可用）' : '')).join(' · ') + '。采集于 ' + stamp(snapshot.collected_at) + (snapshot.observed_at ? '，观察于 ' + stamp(snapshot.observed_at) : '；指标观察时间未知，暂不用于趋势比较。') : '尚未采集这个账号的数据。' };
    } catch (error) { this.problem = error instanceof Error ? error.message : '账号数据暂不可用'; }
    finally { this.busy = false; this.options.render(); }
  }
  private async checkAccountIdentity() {
    const account = this.account(), platform = this.location.platform; if (!account || this.busy || !['x','wechat','xiaohongshu','bilibili','douyin'].includes(platform)) return;
    this.busy = true; this.problem = ''; this.options.render();
    try {
      await this.options.client.request('POST', '/api/v1/accounts/' + encodeURIComponent(account.account_id) + '/identity-check', {}, { signal: this.options.signal, idempotencyKey: crypto.randomUUID() });
      await this.load(); this.options.toast((platform === 'wechat' ? '公众号 AppID 认证已通过' : 'X 账号身份已核对') + '；发布权限仍需单独验证。');
    } catch (error) { this.problem = error instanceof Error ? error.message : '账号核对暂未成功'; }
    finally { this.busy = false; this.options.render(); }
  }
  private async setDefault(clear: boolean) {
    if (!this.data || !this.account() || this.busy) return;
    this.busy = true;
    try { const data = await this.options.client.request<PublishingSettingsResponse>('PUT', '/api/v1/settings/publishing/defaults', { expected_version: this.data.version, platform: this.location.platform, format: this.format, account_id: clear ? null : this.account()!.account_id }, { signal: this.options.signal, idempotencyKey: crypto.randomUUID() }); this.checkIdentity(data); this.data = data; this.options.toast(clear ? '已清除该形式的默认账号；已冻结意图不变。' : '新计划将预选这个账号；已冻结意图不变。'); }
    catch (error) { this.problem = errorCode(error) === 'VERSION_CONFLICT' ? '默认偏好已由另一入口修改，当前账号和形式仍保留。刷新并核对后重试。' : '默认账号保存失败，当前选择仍保留：' + (error instanceof Error ? error.message : '服务暂不可用'); }
    finally { this.busy = false; this.options.render(); }
  }
  dispose() { this.generation++; this.dialog.remove(); }
}
