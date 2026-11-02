import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
const baseURL = process.env.WORKBENCH_E2E_URL;
const report = process.env.WORKBENCH_E2E_REPORT;
if (!baseURL || !report) throw new Error('请通过 pnpm test:e2e 或 pnpm test:e2e:portable 运行隔离 E2E');
export default defineConfig({
  testDir: './tests/e2e', forbidOnly: true, retries: 0, workers: 1,
  timeout: 45000, globalTimeout: process.env.WORKBENCH_E2E_SCOPE === 'local' ? 900000 : 300000, expect: { timeout: 10000 },
  outputDir: join(report, 'test-results'),
  reporter: [['list'], ['json', { outputFile: join(report, 'results.json') }], ['html', { outputFolder: join(report, 'html'), open: 'never' }], ['junit', { outputFile: join(report, 'junit.xml') }]],
  use: { baseURL, browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL || undefined, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light', reducedMotion: 'reduce', trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off' },
  projects: [
    { name: 'demo-desktop', testMatch: ['demo.spec.ts', 'release-notice.spec.ts'], use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'demo-mobile', testMatch: ['demo.spec.ts', 'release-notice.spec.ts'], use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'publishing-ui', testMatch: 'publishing-settings.spec.ts', use: { viewport: { width: 1440, height: 1000 } } },
    ...(process.env.WORKBENCH_E2E_SCOPE === 'local' ? [{ name: 'settings-real', testMatch: /(?:settings|backend|data|content)\.spec\.ts/, use: { viewport: { width: 1440, height: 1000 } } }] : []),
  ],
});
