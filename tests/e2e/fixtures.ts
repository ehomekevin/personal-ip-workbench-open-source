import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ServiceIdentity } from '../../packages/contracts/src/index.ts';

export { expect };
export const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page, baseURL }, use, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const allowedOrigins = new Set([new URL(baseURL!).origin]);
    if (process.env.WORKBENCH_E2E_SCOPE === 'local') {
      const backend = new URL(process.env.WORKBENCH_E2E_BACKEND_URL!);
      if (backend.protocol !== 'http:' || backend.hostname !== '127.0.0.1') throw new Error('隔离后端必须为本机 HTTP');
      allowedOrigins.add(backend.origin);
    }
    page.on('request', request => { if (/^https?:/.test(request.url()) && !allowedOrigins.has(new URL(request.url()).origin)) errors.push('浏览器请求超出隔离服务：' + request.url()); });
    await page.context().addInitScript(() => { Date.now = () => 1791577200000; Math.random = () => 0.123456789; });
    await use(errors);
    if (errors.length) await testInfo.attach('browser-errors', { body: JSON.stringify(errors), contentType: 'application/json' });
    expect(errors, '浏览器异常与非隔离网络请求').toEqual([]);
  }, { auto: true }],
});
export function action(page: Page, name: string, dialog = false) { return page.locator((dialog ? '#dialog ' : '') + `[data-action="${name}"]`).first(); }
export async function demoState(page: Page) { return page.evaluate(() => JSON.parse(localStorage.getItem('flowo-workbench-demo-v1')!)); }
export async function newTopic(page: Page, title = 'E2E 人工主题') {
  await action(page, 'new-topic').click(); await page.locator('#new-title').fill(title); await page.locator('#new-angle').fill('保留依据、人工稿和平台差异');
  await action(page, 'create-topic', true).click();
  await expect(page.locator('#dialog')).not.toBeVisible();
  await expect(page.locator('.editor-top h2')).toHaveText(title);
  await expect(page.locator('#core-editor')).toBeVisible();
}
export async function generateTopic(page: Page) {
  await newTopic(page); await page.locator('#core-editor').fill('人工核心稿：先核对输入，再观察结果。');
  await action(page, 'confirm-core').click(); await action(page, 'generate-versions').click(); await action(page, 'do-generate', true).click();
  await expect(page.locator('#version-text')).toBeVisible();
}
export async function identity(request: APIRequestContext): Promise<ServiceIdentity> {
  const response = await request.get('/api/v1/identity'); expect(response.status()).toBe(200); return response.json();
}
export function headers(id: ServiceIdentity, key = randomUUID()) {
  return { 'X-Workspace-Id': id.workspace_id, 'X-Service-Instance-Id': id.service_instance_id, 'X-Request-Id': randomUUID(), 'Idempotency-Key': key };
}
export async function getSettings(request: APIRequestContext, id: ServiceIdentity) {
  const response = await request.get('/api/v1/settings', { headers: headers(id) }); expect(response.status()).toBe(200); return response.json();
}
export async function runtime(request: APIRequestContext, restart = false) {
  const options = { headers: { 'X-E2E-Control': process.env.WORKBENCH_E2E_CONTROL! } };
  const response = restart ? await request.post('/__test/restart', options) : await request.get('/__test/runtime', options);
  expect(response.status()).toBe(200); return response.json();
}
