import packageInfo from '../../package.json' with {type:'json'};
import {test, expect, latestReleaseUrl, newTopic, demoState} from './fixtures.ts';

test('a late release notice preserves editing, can be dismissed, and stays dismissed after reload', async ({page}) => {
  let respond!: () => void;
  const waitForEditor = new Promise<void>(resolve => { respond = resolve; });
  let requests = 0;
  const nextVersion = `${Number(packageInfo.version.split('.')[0]) + 1}.0.0`;
  await page.route(latestReleaseUrl, async route => {
    requests++;
    await waitForEditor;
    await route.fulfill({json:{tag_name:`v${nextVersion}`, draft:false, prerelease:false}});
  });
  await page.goto('/?mode=demo', {waitUntil:'domcontentloaded'});
  await newTopic(page);
  const topicId = (await demoState(page)).topics[0].id;
  const editor = page.locator('#core-editor');
  await editor.fill('更新提醒出现时保留这段草稿');
  respond();
  const notice = page.getByRole('complementary', {name:'版本更新'});
  await expect(notice).toContainText(`新版本 v${nextVersion} 已发布（当前 v${packageInfo.version}）`);
  await expect(notice.getByRole('link')).toHaveAttribute('href', `https://github.com/ehomekevin/personal-ip-workbench-open-source/releases/tag/v${nextVersion}`);
  await expect(editor).toHaveValue('更新提醒出现时保留这段草稿');
  await notice.getByRole('button', {name:'关闭此版本提醒'}).click();
  await page.reload();
  await page.locator(`[data-action="select-topic"][data-id="${topicId}"]`).click();
  await expect(editor).toHaveValue('更新提醒出现时保留这段草稿');
  await expect(notice).toHaveCount(0);
  expect(requests).toBe(1);
});
