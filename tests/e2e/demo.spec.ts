import { test, expect, action, demoState, generateTopic, newTopic } from './fixtures.ts';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/?mode=demo#today'); await expect(page.locator('#nav button').first()).toBeVisible(); });
const pages = ['today', 'sources', 'create', 'schedule', 'retro', 'knowledge', 'settings'];
for (const name of pages) test(`公开演示：${name} 页面、布局和资源可用`, async ({ page }, info) => {
  await page.goto('/?mode=demo#' + name);
  await expect(page.locator('.page h1')).toBeVisible();
  await expect(page.locator('#content')).not.toBeEmpty();
  for (const selector of ['.app', '.sidebar', '.topbar', '.content']) await expect(page.locator(selector)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await page.locator('img').evaluateAll(elements => (elements as HTMLImageElement[]).filter(image => !image.complete || image.naturalWidth === 0).map(image => image.getAttribute('src')))).toEqual([]);
  await info.attach('public-demo', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
});

test('主题确认后生成五平台草稿；人工修改、候选采用和恢复相互隔离', async ({ page }) => {
  await newTopic(page); await expect(action(page, 'generate-versions')).toBeDisabled();
  const topicId = (await demoState(page)).topics[0].id;
  await page.locator('#core-editor').fill('人工核心稿：保留原文和依据。');
  await action(page, 'ai-suggest').click(); await action(page, 'close-dialog', true).click();
  await expect(page.locator('#core-editor')).toHaveValue('人工核心稿：保留原文和依据。');
  await action(page, 'confirm-core').click(); await action(page, 'generate-versions').click(); await action(page, 'do-generate', true).click();
  await expect(page.locator('#version-text')).toBeVisible();
  expect(Object.keys((await demoState(page)).topics[0].versions).sort()).toEqual(['bilibili', 'douyin', 'wechat', 'x', 'xiaohongshu']);
  for (const platform of ['xiaohongshu', 'wechat', 'x', 'douyin', 'bilibili']) {
    await page.locator(`[data-action="platform-tab"][data-value="${platform}"]`).click();
    await page.locator('#version-title').fill('人工标题 ' + platform); await page.locator('#version-text').fill('人工正文 ' + platform);
  }
  await page.locator('[data-action="platform-tab"][data-value="xiaohongshu"]').click();
  await action(page, 'regenerate-version').click(); await page.locator('#regenerated-text').fill('待采用候选');
  await action(page, 'apply-version', true).click(); await expect(page.locator('#version-text')).toHaveValue('待采用候选');
  await action(page, 'previous-version').click(); await action(page, 'restore-version', true).click();
  await expect(page.locator('#version-text')).toHaveValue('人工正文 xiaohongshu');
  expect((await demoState(page)).topics[0].versions.wechat.text).toBe('人工正文 wechat');
  await page.reload(); await expect(page.locator('#core-editor')).toBeVisible();
  await page.locator(`[data-action="select-topic"][data-id="${topicId}"]`).click();
  await page.locator('[data-action="edit-tab"][data-value="versions"]').click();
  await page.locator('[data-action="platform-tab"][data-value="xiaohongshu"]').click(); await expect(page.locator('#version-text')).toHaveValue('人工正文 xiaohongshu');
});
for (const close of ['close-dialog', 'cancel-task', 'escape']) test(`关闭生成任务 ${close} 后不采用迟到结果`, async ({ page }) => {
  await newTopic(page); await page.locator('#core-editor').fill('取消验证稿'); await action(page, 'confirm-core').click();
  await action(page, 'generate-versions').click(); await action(page, 'do-generate', true).click();
  if (close === 'escape') await page.keyboard.press('Escape'); else await action(page, close, true).click();
  await page.waitForTimeout(1100); expect(Object.keys((await demoState(page)).topics[0].versions)).toEqual([]);
  await expect(page.locator('#dialog')).not.toBeVisible();
});
test('资讯收藏和空搜索保留状态；素材可在无平台草稿时准备', async ({ page }) => {
  await page.locator('.sidebar [data-page="sources"]').click(); await action(page, 'favorite').click();
  await page.locator('[data-action="source-filter"][data-value="已收藏"]').click(); await expect(page.locator('.feed-item')).toHaveCount(1);
  await page.locator('#source-query').fill('不存在的资料'); await expect(page.locator('#feed-list .empty')).toBeVisible(); await page.locator('#source-query').fill('');
  await action(page, 'news-topic').click(); await page.locator('#new-title').fill('来源主题'); await action(page, 'create-topic', true).click();
  await page.locator('[data-action="edit-tab"][data-value="assets"]').click(); await page.locator('.shot-duration').first().fill('12'); await page.locator('.shot-duration').first().blur();
  await page.locator('#file-input').setInputFiles({ name: 'fixture.md', mimeType: 'text/markdown', buffer: Buffer.from('隔离上传素材') });
  const topic = (await demoState(page)).topics[0]; expect(topic.confirmed).toBe(false); expect(Object.keys(topic.versions)).toHaveLength(0); expect(topic.assets).toHaveLength(1); expect(topic.shots[0].duration).toBe(12);
});
test('五平台排期与演示发布结果可回查；重试不重复成功作品', async ({ page }) => {
  await generateTopic(page); await action(page, 'schedule-topic').click(); await page.locator('#schedule-time').fill('2026-10-10T20:00');
  for (const checkbox of await page.locator('#dialog input[name="platform"]').all()) await checkbox.check();
  await action(page, 'save-schedule', true).click();
  const topicId = (await demoState(page)).topics[0].id; expect((await demoState(page)).schedules.filter((s: { topic: string }) => s.topic === topicId)).toHaveLength(5);
  await action(page, 'publish').click(); for (const checkbox of await page.locator('#dialog input[name="platform"]').all()) await checkbox.check();
  await action(page, 'do-publish', true).click(); await expect(page.locator('#dialog')).not.toBeVisible();
  const before = await demoState(page); const succeeded = before.publications.find((p: { topic: string; platform: string }) => p.topic === topicId && p.platform === 'x');
  expect(succeeded.status).toContain('已发布');
  const failed = before.publications.find((p: { topic: string; platform: string }) => p.topic === topicId && p.platform === 'douyin');
  await page.locator(`[data-action="retry-publish"][data-id="${failed.id}"]`).click();
  const after = await demoState(page); expect(after.publications).toHaveLength(before.publications.length); expect(after.publications.find((p: { topic: string; platform: string }) => p.topic === topicId && p.platform === 'x').workId).toBe(succeeded.workId);
});
test('演示复盘采用生成后续主题，刷新后关联仍存在', async ({ page }) => {
  await page.locator('.sidebar [data-page="retro"]').click();
  for (const tab of ['mine', 'benchmark', 'peer', 'single']) await page.locator(`[data-action="retro-tab"][data-value="${tab}"]`).click();
  await action(page, 'adopt-retro').click(); const state = await demoState(page); expect(typeof state.adopted).toBe('string'); expect(state.topics.some((topic: { id: string }) => topic.id === state.adopted)).toBe(true);
  await action(page, 'open-adopted').click(); await expect(page.locator('#core-editor')).toBeVisible();
  const title = await page.locator('.editor-top h2').innerText(); await page.reload();
  await page.locator('.sidebar [data-page="retro"]').click(); await action(page, 'open-adopted').click(); await expect(page.locator('.editor-top h2')).toHaveText(title);
});
test('全局搜索支持键盘导航，空知识笔记可以保存', async ({ page }) => {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k'); await expect(page.locator('#global-search')).toBeFocused();
  await page.locator('#global-search').fill('数据复盘'); await page.keyboard.press('ArrowDown'); await expect(page.locator('.search-result').first()).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.locator('.page h1')).toHaveText('数据复盘');
  await page.locator('.sidebar [data-page="knowledge"]').click(); await page.locator('#knowledge-text').fill(''); await action(page, 'save-knowledge').click();
  await page.reload(); await expect(page.locator('#knowledge-text')).toHaveValue('');
});
test('窄视口日历和表格局部滚动，页面不横向溢出', async ({ page }, info) => {
  test.skip(info.project.name !== 'demo-mobile', '仅窄视口验证');
  await page.locator('.sidebar [data-page="schedule"]').click();
  const localScroll = async (target: Page, selector: string) => target.locator(selector).first().evaluate(element => { element.scrollLeft = 300; return { local: element.scrollLeft > 0, page: document.documentElement.scrollWidth > innerWidth }; });
  expect(await localScroll(page, '.calendar-wrap')).toEqual({ local: true, page: false });
  await page.locator('[data-action="schedule-view"][data-value="list"]').click(); expect(await localScroll(page, '.table-wrap')).toEqual({ local: true, page: false });
});
test('正常动效和减少动态偏好保留各自行为', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' });
  expect(await page.locator('.brand-mark .cursor').evaluate(e => getComputedStyle(e).animationName)).toBe('brand-cursor');
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  expect(await page.locator('.brand-mark .cursor').evaluate(e => ({ animation: getComputedStyle(e).animationName, opacity: getComputedStyle(e).opacity, scheme: getComputedStyle(document.documentElement).colorScheme }))).toEqual({ animation: 'none', opacity: '1', scheme: 'light' });
});
