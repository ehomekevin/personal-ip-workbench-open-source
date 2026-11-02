// Browser tests run against the unpacked, running application. Only GitHub's public
// release response is simulated, including a future version for the screenshots.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const latest = 'https://api.github.com/repos/ehomekevin/personal-ip-workbench-open-source/releases/latest';
const notes = 'https://github.com/ehomekevin/personal-ip-workbench-open-source/releases/tag/';
export const topicTitle = '便携工作台保存的测试主题';

export async function checkBrowser(origin, version, output) {
  const browser = await chromium.launch();
  const checks = [];
  const [major, minor] = version.split('.').map(Number);
  const future = `v${major}.${minor + 1}.0`;
  try {
    for (const [scenario, width] of [['future', 1440], ['future', 390], ['equal', 1440], ['offline', 1440], ['not-found', 1440], ['rate-limited', 1440]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      try {
        const page = await context.newPage();
        const violations = [];
        let lookups = 0;
        page.on('pageerror', () => violations.push('page error'));
        page.on('download', () => violations.push('download'));
        await context.addCookies([{ name: 'synthetic_test_cookie', value: 'must-be-omitted', domain: 'api.github.com', path: '/', secure: true, sameSite: 'None' }]);
        await context.route('**/*', async route => {
          const request = route.request();
          if (new URL(request.url()).origin === origin) {
            await route.continue();
            return;
          }
          if (request.url() !== latest) {
            violations.push('unexpected external request');
            await route.abort();
            return;
          }
          lookups++;
          const headers = await request.allHeaders();
          if (request.method() !== 'GET' || ['authorization', 'cookie', 'referer'].some(key => key in headers)) violations.push('unexpected request headers or method');
          if (scenario === 'offline') { await route.abort('internetdisconnected'); return; }
          const status = scenario === 'not-found' ? 404 : scenario === 'rate-limited' ? 429 : 200;
          await route.fulfill({ status, headers: { 'access-control-allow-origin': '*' }, json: status === 200
            ? { tag_name: scenario === 'future' ? future : 'v' + version, draft: false, prerelease: false }
            : { message: scenario } });
        });
        await page.goto(origin, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#crumb')).toContainText('今日工作台');
        await page.waitForFunction(() => localStorage.getItem('workbench:stable-release:v1') !== null);
        const notice = page.getByRole('complementary', { name: '版本更新' });
        if (scenario === 'future') {
          await expect(notice).toContainText(`新版本 ${future} 已发布（当前 v${version}）`);
          const link = notice.getByRole('link', { name: '查看更新说明' });
          await expect(link).toHaveAttribute('href', notes + future);
          await expect(link).toBeVisible();
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
          await page.screenshot({ path: join(output, width === 390 ? 'narrow-future.png' : 'desktop-future.png') });
          await notice.getByRole('button', { name: '关闭此版本提醒' }).click();
        }
        await expect(notice).toHaveCount(0);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('#crumb')).toContainText('今日工作台');
        await expect(notice).toHaveCount(0);
        if (width === 1440) {
          await page.locator('[data-action="new-topic"]').first().click();
          await page.locator('#new-title').fill(topicTitle);
          if (scenario === 'future') {
            await page.locator('#new-category').selectOption('个人思考');
            const saved = page.waitForResponse(response => response.url() === origin + '/api/v1/topics' && response.request().method() === 'POST');
            await page.locator('#dialog [data-action="create-topic"]').click();
            assert.equal((await saved).status(), 201, 'manual topic create');
          }
        }
        assert.equal(lookups, 1, 'one lookup across reloads');
        assert.deepEqual(violations, [], 'browser isolation');
        checks.push({ scenario, width, fixture: true, externalRequests: lookups, downloadEvents: 0 });
      } finally {
        await context.close();
      }
    }
    return checks;
  } finally {
    await browser.close();
  }
}
