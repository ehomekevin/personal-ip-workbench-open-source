import { CONTRACT_VERSION, OpenWorkbenchSchema, PLATFORMS, workbenchLocationHash, type OpenWorkbenchRequest, type Platform, type ServiceIdentity } from '@workbench/contracts';

export { workbenchLocationHash };
export function parseWorkbenchLocation(hash: string): OpenWorkbenchRequest {
  const value = hash.replace(/^#/, '');
  if (!value) return { page: 'today' };
  const [path = '', query = ''] = value.split('?');
  const parts = path.split('/');
  if (path === 'settings/skills' && !query) return OpenWorkbenchSchema.parse({page:'settings',settings_view:'skills'});
  if (parts[0] === 'settings' && parts[1] === 'publishing') {
    if (parts.length < 3 || parts.length > 4 || query) throw new Error('平台发布定位无效');
    return OpenWorkbenchSchema.parse({ page: 'settings', settings_view: 'publishing', platform: parts[2], ...(parts[3] ? { account_id: decodeURIComponent(parts[3]) } : {}) });
  }
  if (parts.length !== 1) throw new Error('工作台定位无效');
  const input: Record<string, unknown> = { page: parts[0] };
  const params = new URLSearchParams(query);
  for (const [key, item] of params) {
    if (parts[0] === 'create' && VIEW_KEYS.includes(key)) continue;
    if (!['topic_id', 'variant_id'].includes(key) || params.getAll(key).length !== 1) throw new Error('工作台定位字段无效');
    input[key] = item;
  }
  return OpenWorkbenchSchema.parse(input);
}
// 创作页的子位置（只属于浏览器地址，不进宿主定位 schema）：编辑页签、平台、公众号配图/排版子页。刷新后据此回到同一处。
const VIEW_KEYS = ['tab', 'platform', 'step'];
const TABS = ['core', 'versions', 'assets'] as const, STEPS = ['images', 'layout'] as const;
export interface WorkbenchView { tab?: (typeof TABS)[number]; platform?: Platform; step?: (typeof STEPS)[number] }
/** 读出创作页子位置；不认识的值直接忽略（回到默认页签）。 */
export function parseWorkbenchView(hash: string): WorkbenchView {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  if (path !== 'create') return {};
  const params = new URLSearchParams(query), view: WorkbenchView = {};
  const tab = params.get('tab'), platform = params.get('platform'), step = params.get('step');
  if (tab && (TABS as readonly string[]).includes(tab)) view.tab = tab as WorkbenchView['tab'];
  if (view.tab === 'versions' && platform && (PLATFORMS as readonly string[]).includes(platform)) view.platform = platform as Platform;
  if ((view.tab === 'versions' && view.platform === 'wechat' || params.has('variant_id')) && step && (STEPS as readonly string[]).includes(step)) view.step = step as WorkbenchView['step'];
  return view;
}
/** 定位 + 创作页子位置 → 地址 hash。 */
export function workbenchViewHash(input: OpenWorkbenchRequest, view: WorkbenchView): string {
  const base = workbenchLocationHash(input);
  if (input.page !== 'create' || input.settings_view) return base;
  const extra = new URLSearchParams();
  if (view.tab && view.tab !== 'core' && !input.variant_id) extra.set('tab', view.tab);
  if (view.tab === 'versions' && view.platform && !input.variant_id) extra.set('platform', view.platform);
  if ((view.tab === 'versions' && view.platform === 'wechat' || input.variant_id) && view.step) extra.set('step', view.step);
  if (!extra.size) return base;
  return base + (base.includes('?') ? '&' : '?') + extra;
}
// 已绑定宿主的 toolresult 和浏览器使用相同的定位 schema 与 hash。
export function locationFromToolResult(result: { isError?: boolean; structuredContent?: unknown }, identity?: ServiceIdentity): OpenWorkbenchRequest | null {
  const envelope = result.structuredContent as { identity?: ServiceIdentity; data?: { resource_uri?: string; location?: unknown } } | undefined;
  if (result.isError || envelope?.data?.resource_uri !== 'ui://personal-ip-workbench/0.1.0.html') return null;
  const actual = envelope.identity;
  if (!actual || actual.contract_version !== CONTRACT_VERSION || identity && (actual.workspace_id !== identity.workspace_id || actual.service_instance_id !== identity.service_instance_id || actual.contract_version !== identity.contract_version)) return null;
  try { return OpenWorkbenchSchema.parse(envelope.data.location); } catch { return null; }
}
