import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture } from '../../tests/mcp-bridge/harness.ts';
import { WORKBENCH_RESOURCE_URI } from '../../packages/host-bridge/src/core/tools.ts';
import { artifactDirectory, projectRoot, saveJson } from './common.ts';

// 官方 AppBridge + 实际编译 STDIO server + 实际 SQLite；fixture 不宣称真实 Codex / Claude 通过。
const root = artifactDirectory('plugin-browser'), token = randomUUID(), f = await fixture();
const connections: Array<{ client: Client; transport: StdioClientTransport }> = [];
const errors: string[] = [], cases: Record<string, unknown>[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof createServer> | undefined;
let result = 'failed';
async function connect() {
  const descriptor = join(f.root, 'connection-' + randomUUID() + '.json'); writeFileSync(descriptor, JSON.stringify(f.descriptor()));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, '.ci-artifacts/plugins/shared/server/server.mjs')], env: { ...process.env as Record<string,string>, WORKBENCH_CONNECTION_PATH: descriptor, WORKBENCH_EXPECTED_HOST_SURFACE: 'codex_desktop' }, stderr: 'pipe' });
  const client = new Client({ name: 'WP23 actual bundle browser fixture', version: '0.1.0' });
  connections.push({ client, transport }); await client.connect(transport); return client;
}
try {
  const client = await connect(), second = await connect();
  const resource = await client.readResource({ uri: WORKBENCH_RESOURCE_URI });
  const content = resource.contents[0]; assert.ok(content && 'text' in content);
  const html = content.text;
  assert.equal(html, readFileSync(join(projectRoot, '.ci-artifacts/plugins/shared/ui/workbench.html'), 'utf8'));
  assert.equal(html.split('data:font/woff2;base64,').length - 1, 1, '自包含字体只嵌入一次');
  assert.ok(Buffer.byteLength(html) < 8 * 1024 * 1024, '实际资源超出本轮明确的内部大小预算');
  const compiled = await build({ absWorkingDir: projectRoot, entryPoints: ['tests/e2e/plugin-host.ts'], write: false, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', define: { __E2E_CONTROL__: JSON.stringify(token) } });
  const script = compiled.outputFiles[0]!.text;
  server = createServer((request, response) => { void (async () => {
    if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (request.url === '/rpc' && request.method === 'POST') {
      if (request.headers['x-e2e-control'] !== token) { response.writeHead(403).end(); return; }
      let body = ''; for await (const bytes of request) { body += bytes; if (body.length > 8 * 1024 * 1024) throw new Error('测试输入过大'); }
      const data = JSON.parse(body) as { operation: string; params: { name: string; arguments?: Record<string, unknown>; uri: string } };
      const value = data.operation === 'tool' ? await client.callTool({ name: data.params.name, arguments: data.params.arguments }) : data.operation === 'resource' ? await client.readResource({ uri: data.params.uri }) : null;
      if (!value) { response.writeHead(400).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value)); return;
    }
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    const page = request.url === '/' ? '<!doctype html><html><head><meta charset="UTF-8"><style>html,body{margin:0;width:100%;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><span id="status" hidden>connecting</span><iframe id="workbench" title="共享工作台" sandbox="allow-scripts allow-same-origin"></iframe><script type="module" src="/host.js"></script></body></html>' : request.url === '/workbench' ? html : request.url === '/host.js' ? script : null;
    if (page === null) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': request.url === '/host.js' ? 'text/javascript' : 'text/html', 'cache-control': 'no-store' }).end(page);
  })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end('fixture error'); }); });
  await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done); });
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'darwin' ? 'chrome' : undefined) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== base) errors.push('外部浏览器请求：' + request.url()); });
  await page.goto(base); await expect(page.locator('#status')).toHaveText('ready');
  const frame = page.frameLocator('#workbench'); await expect(frame.locator('.app')).toBeVisible();
  for (const id of ['sources', 'knowledge', 'schedule', 'retro', 'settings', 'today']) {
    await frame.locator('[data-action="nav"][data-page="' + id + '"]').first().click();
    await expect(frame.locator('#crumb')).not.toBeEmpty();
  }
  cases.push({ name: 'actual_resource_handshake_and_navigation', result: 'passed', scope: 'internal_browser_host' });
  await frame.locator('[data-action="nav"][data-page="create"]').first().click();
  await frame.locator('[data-action="new-topic"]').first().click();
  const title = 'WP23 插件桥接真实保存 ' + randomUUID();
  await frame.locator('#new-title').fill(title); await frame.locator('#new-angle').fill('实际 STDIO 与唯一主服务');
  await frame.locator('#dialog [data-action="create-topic"]').click();
  await expect(frame.locator('#core-editor')).toBeVisible();
  const text = '人工核心稿：MCP Apps fixture 已通过，实际宿主仍需独立验收。';
  await frame.locator('#core-editor').fill(text);
  await page.evaluate(async () => { await (window as unknown as { notifyWorkbench(): Promise<void> }).notifyWorkbench(); });
  await expect(frame.locator('#core-editor')).toHaveValue(text);
  await frame.locator('#core-editor').blur(); await expect(frame.locator('#save-state')).toHaveText('已保存');
  const topics = (await second.callTool({ name: 'list_topics', arguments: {} })).structuredContent as { data: { items: Array<{ id: string; title: string }> } };
  const topic = topics.data.items.find(item => item.title === title); assert.ok(topic);
  const detail = (await second.callTool({ name: 'get_topic', arguments: { id: topic.id } })).structuredContent as { data: { core: { text: string; head_revision_id: string } } };
  assert.equal(detail.data.core.text, text);
  const revision = f.app.context.db.prepare('SELECT file_path,sha256 FROM document_revisions WHERE workspace_id=? AND id=?').get(f.app.identity.workspace_id, detail.data.core.head_revision_id)!;
  const markdown = readFileSync(String(revision.file_path)); assert.equal(createHash('sha256').update(markdown).digest('hex'), revision.sha256);
  cases.push({ name: 'unsaved_input_survives_notification_and_real_save_readback', result: 'passed', scope: 'actual_stdio_SQLite_Markdown_internal_browser_host', revision_id: detail.data.core.head_revision_id });
  await page.screenshot({ path: join(root, 'shared-workbench-desktop.png'), fullPage: true });
  for (const viewport of [{width:1280,height:900},{width:768,height:1024},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => frame.locator('html').evaluate(el => el.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: join(root, 'shared-workbench-' + viewport.width + '.png'), fullPage: true });
  }
  assert.deepEqual(errors, []);
  cases.push({ name: 'desktop_mobile_and_no_browser_errors', result: 'passed', scope: 'internal_browser_host' });
  // 新子页通过实际打包资源、AppBridge、STDIO 和同一主存验证，仍属于隔离宿主。
  const publishingAccount = randomUUID();
  f.app.context.db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'x','internal-plugin-publishing','owner','插件发布隔离账号','https://x.com/internal-plugin-fixture','confirmed')").run(publishingAccount, f.config.workspace_id);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async accountId => {
    await (window as unknown as { openWorkbench(args: Record<string, unknown>): Promise<void> }).openWorkbench({ page: 'settings', settings_view: 'publishing', platform: 'x', account_id: accountId });
  }, publishingAccount);
  await expect(frame.locator('.publishing-workbench')).toBeVisible();
  await expect(frame.locator('#account-select')).toHaveValue(publishingAccount);
  await frame.locator('[data-action="publishing-configure"]').click();
  await expect(frame.locator('#connection-ref')).toHaveValue('');
  await frame.locator('#publishing-config-dialog button[type="submit"]').click();
  await expect(frame.locator('#publishing-config-dialog')).not.toBeVisible();
  const settings = (await second.callTool({ name: 'get_publishing_settings', arguments: {} })).structuredContent as { data: { connections: Array<{ account_id: string; credential_ref: unknown; version: number; runtime: { state: string } }> } };
  assert.equal(settings.data.connections.length, 1);
  assert.equal(settings.data.connections[0]!.account_id, publishingAccount);
  assert.equal(settings.data.connections[0]!.credential_ref, null);
  assert.equal(settings.data.connections[0]!.runtime.state, 'not_applied');
  await page.evaluate(async () => { await (window as unknown as { notifyWorkbench(): Promise<void> }).notifyWorkbench(); });
  await expect(frame.locator('#account-select')).toHaveValue(publishingAccount);
  await frame.locator('[data-action="publishing-apply"]').click();
  await expect(frame.locator('.publishing-workbench')).toContainText('AUTH_REQUIRED');
  await frame.locator('[data-action="publishing-configure"]').click();
  const saveButton = frame.locator('#publishing-config-dialog button[type="submit"]');
  await saveButton.focus(); await saveButton.press('Enter');
  await expect(frame.locator('#publishing-config-dialog')).not.toBeVisible();
  await frame.locator('[data-action="publishing-default"]').click();
  await frame.locator('#default-format').selectOption('thread');
  await saveButton.focus(); await saveButton.press('Space');
  await expect(frame.locator('#publishing-config-dialog')).not.toBeVisible();
  const keyboardReadback = (await second.callTool({ name: 'get_publishing_settings', arguments: {} })).structuredContent as { data: { connections: Array<{ version: number }>; defaults: Array<{ platform: string; format: string; account_id: string }> } };
  assert.equal(keyboardReadback.data.connections[0]!.version, settings.data.connections[0]!.version);
  assert.deepEqual(keyboardReadback.data.defaults, [{ platform: 'x', format: 'thread', account_id: publishingAccount }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => frame.locator('html').evaluate(el => el.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: join(root, 'shared-publishing-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  cases.push({ name: 'publishing_location_save_and_failed_apply_shared_service', result: 'passed', scope: 'actual_bundle_stdio_SQLite_MCP_Apps_browser_fixture' });
  result = 'passed';
} catch (error) {
  if (browser) { try { await browser.contexts()[0]?.pages()[0]?.screenshot({ path: join(root, 'failure.png'), fullPage: true }); } catch {} }
  errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); throw error;
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
  for (const { client, transport } of connections) { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
  await f.cleanup();
  saveJson(join(root, 'summary.json'), { result, scope: 'actual_bundle_stdio_SQLite_Markdown_MCP_Apps_browser_fixture', cases, errors, real_codex_claude_surfaces: 'not_run', external_publishing: 'not_run' });
  console.log('插件浏览器证据：' + root);
}
