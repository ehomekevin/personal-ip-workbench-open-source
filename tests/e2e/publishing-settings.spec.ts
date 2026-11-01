import { test, expect, identity, headers, runtime } from './fixtures.ts';
import type { Page as BrowserPage } from '@playwright/test';
import { CONTRACT_VERSION, PLATFORMS, DEFAULT_OPERATING_PREFERENCES, PUBLISHING_FORMATS_BY_PLATFORM, type PublishingSettingsResponse, type PublishingConnectionView, type Platform } from '../../packages/contracts/src/index.ts';

const mockIdentity = { workspace_id: 'publishing-ui-isolated', service_instance_id: 'publishing-ui-service', contract_version: CONTRACT_VERSION };
const button = (page: BrowserPage, action: string) => page.locator('[data-action="publishing-' + action + '"]').first();
function connection(accountId = 'owner-x'): PublishingConnectionView {
  return { id: 'connection-' + accountId, account_id: accountId, platform: 'x', route: 'x_v2', version: 1, config_revision: 1, credential_ref: { kind: 'environment', name: 'PSET_UI_X_A' }, enabled: false,
    runtime: { state: 'active', active_config_revision: 1, adapter_version: 'x-fixture-v1', host_id: 'controlled-http-fixture', applied_at: '2026-10-10T01:00:00Z', credentials_ready: true, error_code: null },
    capabilities: ['text', 'thread'].flatMap(format => ['prepareDraft', 'submit', 'queryResult'].map(operation => ({ format, operation, status: 'unverified', host_id: 'controlled-http-fixture', adapter_version: 'x-fixture-v1', evidence_kind: 'none', evidence_ref: null, verified_at: null, limitations: ['controlled HTTP fixture，尚无真实发布证据'] }))) as PublishingConnectionView['capabilities'], last_check: null };
}
async function mockService(page: BrowserPage) {
  const model: PublishingSettingsResponse = { identity: mockIdentity, version: 1, config_source: 'sqlite', credential_references: [{ kind: 'environment', name: 'PSET_UI_X_A' }, { kind: 'environment', name: 'PSET_UI_X_B' }],
    accounts: [...PLATFORMS.map(platform => ({ account_id: 'owner-' + platform, platform, name: '当前平台的本人账号 · ' + platform, platform_account_id: platform + '_001', role: 'owner' as const, identity_status: 'confirmed', publish_target_eligible: true })), { account_id: 'owner-x-second', platform: 'x', name: '示例工作台 · 业务实践与工具实测的长期内容账号（长名称折行）', platform_account_id: 'x_002', role: 'owner', identity_status: 'confirmed', publish_target_eligible: true }], connections: [connection()], defaults: [] };
  const calls: { method: string; path: string; body?: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const replay = new Map<string, unknown>();
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method(), body = request.postDataJSON() as Record<string, unknown> | null;
    calls.push({ method, path, ...(body ? { body } : {}), headers: request.headers() });
    const send = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const fail = () => send({ error: { code: 'VERSION_CONFLICT', message: '配置已由另一入口修改', details: {}, request_id: 'controlled-conflict', retryable: false } }, 409);
    if (path === '/api/v1/identity') return send(mockIdentity);
    if (path === '/api/v1/settings') return send({ workspace_id: mockIdentity.workspace_id, title: 'PSET controlled HTTP', timezone: 'America/Los_Angeles', mode: 'demo', paths: { source_vault_root: null, managed_notes_root: '/isolated/notes', state_root: '/isolated/state', media_root: '/isolated/media' }, version: 1, default_executor: 'codex', api_fallback_enabled: false, executors: ['codex','claude'].map(executor_id=>({executor_id,status:'unconfigured',auth_state:'AUTH_REQUIRED',runtime_version:null})), capabilities: [] });
    if (path === '/api/v1/settings/configuration') return send({identity:mockIdentity,version:1,preferences:DEFAULT_OPERATING_PREFERENCES,checks:{},tools:{tikhub_configured:false,credential_entry_url:null,api_credentials:{openai:false,anthropic:false},h3:{endpoint:'',reference_path:'',reference_filename:'',configured:false}},accounts:model.accounts.map(a=>({...a,id:a.account_id,record_type:'account',display_id:''}))});
    if (path === '/api/v1/settings/publishing' && method === 'GET') return send(model);
    const key = request.headers()['idempotency-key'];
    if (key && replay.has(key)) return send(replay.get(key));
    if (path === '/api/v1/settings/publishing/defaults') {
      if (body?.expected_version !== model.version) return fail();
      model.defaults = model.defaults.filter(d => !(d.platform === body.platform && d.format === body.format));
      if (body.account_id) model.defaults.push({ platform: body.platform as Platform, format: body.format as 'text', account_id: String(body.account_id) });
      model.version++; const result = structuredClone(model); replay.set(key!, result); return send(result);
    }
    if (path === '/api/v1/settings/publishing/connections' && method === 'POST') {
      if (body?.expected_version !== model.version) return fail();
      const c = connection(String(body.account_id)); c.credential_ref = body.credential_ref as PublishingConnectionView['credential_ref']; c.runtime.state = 'not_applied'; c.runtime.active_config_revision = null; model.connections.push(c); model.version++;
      const result = { identity: mockIdentity, settings_version: model.version, connection: c }; replay.set(key!, structuredClone(result)); return send(result);
    }
    const match = /^\/api\/v1\/settings\/publishing\/connections\/([^/]+)(?:\/(apply|check|enabled))?$/.exec(path);
    const c = model.connections.find(c => c.id === match?.[1]);
    if (c && match) {
      if (body?.expected_version !== c.version) return fail();
      const operation = match[2];
      if (method === 'PATCH') { c.credential_ref = body.credential_ref as PublishingConnectionView['credential_ref']; c.version++; c.config_revision++; c.runtime.state = 'pending'; model.version++; }
      if (operation === 'apply') { c.runtime.state = 'active'; c.runtime.active_config_revision = c.config_revision; }
      if (operation === 'enabled') { c.enabled = body.enabled === true; c.version++; model.version++; }
      if (operation === 'check') {
        c.last_check = { check_id: 'readonly-check', sequence: (c.last_check?.sequence ?? 0) + 1, config_revision: c.config_revision, checked_at: '2026-10-10T02:00:00Z', readonly: true, identity: 'passed', permissions: 'unavailable', reachability: 'passed', limitations: ['只读身份查询不证明发布能力'] };
        const result = { identity: mockIdentity, connection_id: c.id, connection_version: c.version, check: c.last_check, applied_to_current: true }; replay.set(key!, result); return send(result);
      }
      const result = { identity: mockIdentity, settings_version: model.version, connection: c }; replay.set(key!, structuredClone(result)); return send(result);
    }
    return send({ error: { code: 'NOT_FOUND', message: 'controlled fixture 未登记资源', details: {}, request_id: 'missing-fixture', retryable: false } }, 404);
  });
  return { model, calls };
}

test.describe('controlled HTTP 共用发布设置页面', () => {
  test.beforeEach(async () => { test.skip(test.info().project.name !== 'publishing-ui'); });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1280, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    test('发布设置布局、五平台、刷新定位与返回 ' + viewport.width, async ({ page }) => {
      await page.setViewportSize(viewport); await mockService(page);
      await page.goto('/?mode=real#settings'); await expect(page.locator('[data-action="cfg-preferences"]')).toBeVisible(); await expect(page.locator('.search-trigger')).toBeVisible();
      await page.locator('[data-action="cfg-publishing"][data-platform="x"]').click(); await expect(page.locator('#account-select')).toHaveValue('owner-x');
      await expect(page.locator('.search-trigger')).toBeHidden(); await expect(page.locator('#content #default-format')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('#scenario-select')).toHaveCount(0); await expect(page.locator('.prototype-controls').filter({ hasText: '原型测试场景' })).toHaveCount(0);
      for (const platform of PLATFORMS) {
        if (viewport.width <= 700) await page.locator('#platform-select').selectOption(platform);
        else await page.locator('#tab-' + platform).click();
        await expect(page).toHaveURL(new RegExp('#settings/publishing/' + platform + '$'));
        await expect(page.locator('#account-select')).toHaveValue('owner-' + platform);
        if (platform === 'bilibili' || platform === 'xiaohongshu') { await expect(button(page, 'configure')).toBeDisabled(); await expect(page.locator('#content')).toContainText('优先使用网页创作中心'); await expect(page.locator('.connection-empty a').first()).toHaveAttribute('href',platform==='bilibili'?'https://member.bilibili.com/platform/upload/video/frame':'https://creator.xiaohongshu.com/publish/publish'); }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await page.locator('.crumb').evaluate(crumb => {
          const textRect = (element: Element) => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect(); };
          const link = textRect(crumb.querySelector('.crumb-link')!), label = textRect(crumb.querySelector('#crumb')!);
          return Math.abs(link.y + link.height / 2 - label.y - label.height / 2) < 3;
        })).toBe(true);
      }
      if (viewport.width <= 700) await page.locator('#platform-select').selectOption('x'); else await page.locator('#tab-x').click();
      await page.locator('#account-select').selectOption('owner-x-second'); await expect(page).toHaveURL(/#settings\/publishing\/x\/owner-x-second$/);
      await page.reload(); await expect(page.locator('#account-select')).toHaveValue('owner-x-second');
      await expect(page.locator('.account-heading h3')).toContainText('长名称折行');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await test.info().attach('publishing-viewport-' + viewport.width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      await button(page, 'home').click(); await expect(page.locator('[data-action="cfg-preferences"]')).toBeVisible(); await expect(page).toHaveURL(/#settings$/); await expect(page.locator('.search-trigger')).toBeVisible();
    });
  }
  test('冲突和断网保留引用，刷新核对后保存、应用、只读检查、默认与启停来自服务', async ({ page }) => {
    const { model, calls } = await mockService(page); await page.goto('/?mode=real#settings/publishing/x/owner-x'); await expect(button(page, 'configure')).toBeVisible();
    await button(page, 'configure').click(); const dialog = page.locator('#publishing-config-dialog'), reference = dialog.locator('#connection-ref');
    await expect(reference).toBeFocused(); await expect(dialog.locator('input,textarea')).toHaveCount(0); await reference.selectOption('PSET_UI_X_B');
    const c = model.connections[0]!; c.version++; c.config_revision++; c.runtime.state = 'pending'; model.version++;
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(dialog).toContainText('输入已保留'); await expect(reference).toHaveValue('PSET_UI_X_B'); expect(c.credential_ref?.name).toBe('PSET_UI_X_A');
    await dialog.getByRole('button', { name: '核对最新版本', exact: true }).click(); await expect(dialog).toContainText('当前已保存引用'); await expect(reference).toHaveValue('PSET_UI_X_B');
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(dialog).not.toBeVisible(); await expect(button(page, 'configure')).toBeFocused(); expect(c.credential_ref?.name).toBe('PSET_UI_X_B'); expect(c.runtime.active_config_revision).toBe(1); await expect(page.locator('#content')).toContainText('待生效');
    await button(page, 'apply').click(); await expect(page.locator('#content')).toContainText('已生效'); expect(c.runtime.active_config_revision).toBe(c.config_revision);
    await button(page, 'check').click(); await expect(page.locator('#content')).toContainText('权限 尚未实现'); expect(c.capabilities.some(capability => capability.status === 'supported')).toBe(false); await expect(page.locator('#content')).not.toContainText('已验证可用');
    const check = calls.find(call => call.path.endsWith('/check'))!; expect(check.body).toEqual({ expected_version: c.version });
    await page.locator('#enable-connection').check(); await expect(page.locator('#enable-connection')).toBeChecked(); expect(c.enabled).toBe(true);
    await page.locator('#enable-connection').uncheck(); await expect(page.locator('#enable-connection')).not.toBeChecked(); expect(c.enabled).toBe(false);
    await button(page, 'default').click(); await expect(dialog.locator('#default-format')).toBeFocused(); await dialog.locator('#default-format').selectOption('thread'); expect(model.defaults).toEqual([]);
    await dialog.getByRole('button', { name: '保存默认账号', exact: true }).click(); await expect(dialog).not.toBeVisible(); await expect(button(page, 'default')).toBeFocused(); await expect(button(page, 'default')).toHaveText('默认发布账号'); expect(model.defaults).toEqual([{ platform: 'x', format: 'thread', account_id: 'owner-x' }]);
    await button(page, 'clear-default').click(); expect(model.defaults).toEqual([]);
    await button(page, 'configure').click(); await reference.selectOption('PSET_UI_X_A');
    await page.route('**/api/v1/settings/publishing/connections/*', route => route.request().method() === 'PATCH' ? route.abort('failed') : route.fallback());
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(dialog).toContainText('保存失败'); await expect(reference).toHaveValue('PSET_UI_X_A'); expect(c.credential_ref?.name).toBe('PSET_UI_X_B');
    await page.keyboard.press('Escape'); await expect(button(page, 'configure')).toBeFocused();
    const writes = calls.filter(call => call.path.startsWith('/api/v1/settings/publishing') && call.method !== 'GET'); expect(writes.length).toBeGreaterThan(7);
    for (const call of writes) { expect(call.headers['idempotency-key']).toBeTruthy(); expect(call.headers['x-workspace-id']).toBe(mockIdentity.workspace_id); expect(call.headers['x-service-instance-id']).toBe(mockIdentity.service_instance_id); }
  });
  test('键盘平台焦点跨刷新保持，未知账号不可配置，返回设置仍保留原设置入口', async ({ page }) => {
    await mockService(page); await page.goto('/?mode=real#settings/publishing/x'); await expect(page.locator('#tab-x')).toBeVisible(); await page.locator('#tab-x').focus(); await page.keyboard.press('ArrowRight'); await expect(page.locator('#tab-douyin')).toBeFocused(); await expect(page).toHaveURL(/#settings\/publishing\/douyin$/);
    await page.goto('/?mode=real#settings/publishing/x/missing-account'); await expect(page.locator('#content')).toContainText('当前工作区没有此平台发布账号'); await expect(button(page, 'configure')).toBeDisabled();
    await page.locator('#account-select').selectOption('owner-x'); await expect(button(page, 'configure')).toBeEnabled();
    await button(page, 'home').click(); await expect(page.locator('input[name="default-agent"]')).toHaveCount(2); await expect(page.locator('#api-toggle')).toHaveCount(0); await expect(page.locator('[data-action="cfg-preferences"]')).toBeVisible();
  });
  test('能力状态只取服务读模型，受限保留历史证据，默认冲突和刷新失败保留选择', async ({ page }) => {
    const { model } = await mockService(page); await page.goto('/?mode=real#settings/publishing/x/owner-x'); await expect(page.locator('#account-select')).toHaveValue('owner-x');
    const c = model.connections[0]!;
    for (const capability of c.capabilities) Object.assign(capability, { status: 'supported', evidence_kind: 'real_platform', evidence_ref: 'controlled-http-evidence-fixture', verified_at: '2026-10-10T02:00:00Z', limitations: [] });
    await button(page, 'refresh').click(); await expect(page.locator('.support-format .tag').filter({ hasText: '已验证可用' })).toHaveCount(6);
    for (const capability of c.capabilities) Object.assign(capability, { status: 'degraded', limitations: ['当前网络受限，历史证据时间仍保留'] });
    c.last_check = { check_id: 'failed-check', sequence: 2, config_revision: c.config_revision, checked_at: '2026-10-10T03:00:00Z', readonly: true, identity: 'unavailable', permissions: 'unavailable', reachability: 'failed', limitations: ['连接不可达'] };
    await button(page, 'refresh').click(); await expect(page.locator('.support-format .tag').filter({ hasText: '连接受限' })).toHaveCount(6); await expect(page.locator('.problem')).toContainText('核对同账号配置后重新检查');
    await page.locator('.details-panel summary').click(); await expect(page.locator('.trace-list').last()).toContainText('controlled-http-evidence-fixture'); await expect(page.locator('.trace-list').last()).toContainText('2026-10-10T02:00:00Z');
    await button(page, 'default').click(); const dialog = page.locator('#publishing-config-dialog'); await dialog.locator('#default-format').selectOption('thread'); model.version++;
    await dialog.getByRole('button', { name: '保存默认账号', exact: true }).click(); await expect(dialog).toContainText('默认偏好已由另一入口修改'); await expect(dialog.locator('#default-format')).toHaveValue('thread'); await expect(dialog).toContainText('当前平台的本人账号 · x'); await expect(page.locator('#account-select')).toHaveValue('owner-x'); expect(model.defaults).toEqual([]);
    await dialog.getByRole('button', { name: '核对最新版本', exact: true }).click(); await expect(dialog).toContainText('线程当前默认账号：未设置'); await expect(dialog.locator('#default-format')).toHaveValue('thread'); await expect(dialog.locator('#default-format')).toBeFocused();
    await dialog.getByRole('button', { name: '保存默认账号', exact: true }).click(); await expect(dialog).not.toBeVisible(); expect(model.defaults).toEqual([{ platform: 'x', format: 'thread', account_id: 'owner-x' }]);
    await page.route('**/api/v1/settings/publishing', route => route.abort('failed'));
    await button(page, 'refresh').click(); await expect(page.locator('.problem')).toContainText('刷新失败'); await expect(page.locator('#account-select')).toHaveValue('owner-x'); await expect(page.locator('.support-format .tag').filter({ hasText: '连接受限' })).toHaveCount(6);
    await button(page, 'default').click(); await expect(dialog.locator('#default-format')).toHaveValue('thread'); await page.keyboard.press('Escape'); await expect(button(page, 'default')).toBeFocused();
  });
});

test.describe('实际 HTTP SQLite 发布设置页面', () => {
  test.beforeEach(async () => { test.skip(test.info().project.name !== 'settings-real'); });
  test('浏览器保存、跨入口版本冲突、只读检查、默认偏好和服务重启读回', async ({ page, request }) => {
    const id = await identity(request), accountId = process.env.WORKBENCH_E2E_PUBLISHING_ACCOUNT_ID!; expect(accountId).toBeTruthy();
    const get = async () => { const response = await request.get('/api/v1/settings/publishing', { headers: headers(id) }); expect(response.status()).toBe(200); return await response.json() as PublishingSettingsResponse; };
    await page.goto('/?mode=real#settings/publishing/x/' + accountId); await expect(page.locator('#account-select')).toHaveValue(accountId);
    let current = await get(); expect(current.accounts.some(a => a.account_id === accountId && a.publish_target_eligible)).toBe(true);
    await button(page, 'configure').click(); const dialog = page.locator('#publishing-config-dialog'); await dialog.locator('#connection-ref').selectOption('PSET_UI_X_A');
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(dialog).not.toBeVisible();
    current = await get(); const c = current.connections.find(c => c.account_id === accountId)!; expect(c.credential_ref?.name).toBe('PSET_UI_X_A'); expect(c.runtime.state).toBe('not_applied');
    await button(page, 'configure').click(); await dialog.locator('#connection-ref').selectOption('PSET_UI_X_B');
    const changed = await request.patch('/api/v1/settings/publishing/connections/' + c.id, { headers: headers(id), data: { expected_version: c.version, credential_ref: null } }); expect(changed.status()).toBe(200);
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(dialog).toContainText('输入已保留'); await expect(dialog.locator('#connection-ref')).toHaveValue('PSET_UI_X_B'); expect((await get()).connections.find(item => item.id === c.id)!.credential_ref).toBeNull();
    await dialog.getByRole('button', { name: '核对最新版本', exact: true }).click(); await expect(dialog).toContainText('已读取最新版本'); await dialog.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(dialog).not.toBeVisible();
    await button(page, 'apply').click(); await expect(page.locator('#content')).toContainText('AUTH_REQUIRED'); await expect(page.locator('#enable-connection')).toBeDisabled();
    await button(page, 'check').click(); await expect(page.locator('#content')).toContainText('最近检查');
    current = await get(); const checked = current.connections.find(item => item.id === c.id)!; expect(checked.last_check?.readonly).toBe(true); expect(checked.runtime.state).toBe('apply_failed'); expect(checked.capabilities.some(capability => capability.status === 'supported')).toBe(false);
    await button(page, 'default').click(); await dialog.locator('#default-format').selectOption('thread'); await dialog.getByRole('button', { name: '保存默认账号', exact: true }).click(); await expect(dialog).not.toBeVisible(); await expect(button(page, 'default')).toHaveText('默认发布账号');
    expect((await get()).defaults.some(d => d.account_id === accountId && d.format === 'thread')).toBe(true);
    const boot = await runtime(request); const restarted = await runtime(request, true); expect(restarted.boot_id).not.toBe(boot.boot_id); await page.reload(); await expect(page.locator('#account-select')).toHaveValue(accountId); expect((await get()).connections.find(item => item.id === c.id)!.credential_ref?.name).toBe('PSET_UI_X_B');
    await button(page, 'home').click(); await expect(page.locator('[data-action="cfg-preferences"]')).toBeVisible();
  });
  test('发布连接问题跳转保留人工稿、目标平台、排期时间与返回定位', async ({ page, request }) => {
    const id = await identity(request);
    const created = await request.post('/api/v1/topics', { headers: headers(id), data: { title: 'PSET 发布连接问题返回', category: '个人思考', audience: '内部工程验收', source_ids: [] } }); expect(created.status()).toBe(201); const topic = await created.json();
    const core = await request.post('/api/v1/documents/' + topic.core_document_id + '/revisions', { headers: headers(id), data: { expected_revision_id: null, text: '人工稿保留；没有平台请求。', origin: 'human' } }); expect(core.status()).toBe(201);
    const revision = (await core.json()).revision_id;
    expect((await request.post('/api/v1/topics/' + topic.id + '/core-approvals', { headers: headers(id), data: { revision_id: revision } })).status()).toBe(200);
    const createdVariant = await request.post('/api/v1/topics/' + topic.id + '/variants', { headers: headers(id), data: { platform: 'x', format: 'text' } }); expect(createdVariant.status()).toBe(201); const variant = await createdVariant.json();
    const snapshot = await (await request.get('/api/v1/documents/' + variant.document_id, { headers: headers(id) })).json();
    expect((await request.post('/api/v1/documents/' + variant.document_id + '/revisions', { headers: headers(id), data: { expected_revision_id: snapshot.head_revision_id, text: '# X 人工稿\n\n保留连接问题发生前的内容。', origin: 'human' } })).status()).toBe(201);
    await page.goto('/?mode=real#create?topic_id=' + topic.id + '&variant_id=' + variant.id); await expect(page.locator('#version-text')).toHaveValue('保留连接问题发生前的内容。');
    await page.locator('[data-action="schedule-topic"]').first().click(); const dialog = page.locator('#dialog'); await dialog.locator('#schedule-time').fill('2026-12-10T20:30'); await expect(dialog.locator('#platform-x')).toBeChecked();
    await dialog.locator('[data-action="publishing-connection-jump"][data-platform="x"]').click(); await expect(page).toHaveURL(/#settings\/publishing\/x$/); await expect(button(page, 'return')).toBeVisible(); await expect(dialog).not.toBeVisible();
    await button(page, 'return').click(); await expect(page).toHaveURL(new RegExp('#create\\?topic_id=' + topic.id + '&variant_id=' + variant.id + '$')); await expect(page.locator('#version-text')).toHaveValue('保留连接问题发生前的内容。'); await expect(dialog).toBeVisible(); await expect(dialog.locator('#schedule-time')).toHaveValue('2026-12-10T20:30'); await expect(dialog.locator('#platform-x')).toBeChecked();
    const intents = await request.get('/api/v1/publication-intents', { headers: headers(id) }); expect((await intents.json()).items).toEqual([]);
  });
});
