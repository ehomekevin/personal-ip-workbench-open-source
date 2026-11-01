import { test, expect, identity, headers, action, runtime } from './fixtures.ts';
import { randomUUID } from 'node:crypto';

test('真实资料收藏、筛选、只读索引与新会话恢复', async ({ page, request }) => {
  const id = await identity(request), title = '内部回放资料 ' + randomUUID().slice(0, 8);
  const created = await request.post('/api/v1/source-records', { headers: headers(id), data: { title, text: '人工添加的资料正文，带有出处。', category: 'AI 实测' } });
  expect(created.status()).toBe(201); const record = await created.json();
  await page.goto('/?mode=real#sources');
  await page.locator('#source-query').fill(title);
  await expect(page.locator('#source-query')).toHaveValue(title);
  await expect(page.locator('#feed-list .feed-item')).toHaveCount(1);
  await expect(page.locator('article')).toContainText('人工添加的资料正文');
  await action(page, 'favorite').click();
  await expect(page.locator('#feed-list')).toContainText('已收藏');
  await page.reload();
  await page.locator('#source-query').fill(title);
  await expect(page.locator('#feed-list')).toContainText('已收藏');
  const detail = await request.get(`/api/v1/source-records/${record.record_id}`, { headers: headers(id) });
  expect(detail.status()).toBe(200); expect((await detail.json()).favorite).toBe(true);
  await page.goto('/?mode=real#knowledge');
  await page.locator('#knowledge-query').fill(title);
  await expect(page.locator('#knowledge-text')).toHaveValue('人工添加的资料正文，带有出处。');
  await expect(page.locator('#knowledge-text')).toHaveAttribute('readonly', '');
  await expect(action(page, 'save-knowledge')).toBeDisabled();
  await page.context().clearCookies(); await page.reload();
  await page.locator('#knowledge-query').fill(title);
  await expect(page.locator('#knowledge-text')).toHaveAttribute('readonly', '');
});

test('既有账号弹窗保存待核对账号，不伪造数据，服务重启可读', async ({ page, request }) => {
  const name = '回放待核对账号 ' + randomUUID().slice(0, 8);
  await page.goto('/?mode=real#sources');
  await action(page, 'add-account').click();
  await page.locator('#account-name').fill(name);
  await page.locator('#account-platform').selectOption('x');
  await page.locator('#account-url').fill('https://x.com/' + name.replace(/[^0-9a-z]/g, ''));
  await action(page, 'save-account', true).click();
  await expect(page.locator('#content')).toContainText(name);
  await expect(page.locator('#content')).toContainText('未采集');
  const id = await identity(request), first = await request.get('/api/v1/accounts?role=benchmark&platform=x', { headers: headers(id) });
  const rows = (await first.json()).items; const saved = rows.find((row: { name: string }) => row.name === name);
  expect(saved.identity_status).toBe('pending');
  await runtime(request, true);
  const after = await request.get('/api/v1/accounts?role=benchmark&platform=x', { headers: headers(id) });
  expect((await after.json()).items.some((row: { id: string }) => row.id === saved.id)).toBe(true);
  await page.reload();
  await page.locator('[data-action="source-tab"][data-value="accounts"]').click();
  await expect(page.locator('#content')).toContainText(name);
});

test('全局搜索使用真实索引，输入保持焦点，来源可回查', async ({ page, request }) => {
  const id = await identity(request), title = '全局搜索证据 ' + randomUUID().slice(0, 8);
  const added = await request.post('/api/v1/source-records', { headers: headers(id), data: { title, text: '关键词验证素材正文' } }); expect(added.status()).toBe(201);
  await page.goto('/?mode=real#sources');
  await action(page, 'search').click();
  await page.locator('#global-search').fill(title);
  await expect(page.locator('#global-search')).toHaveValue(title);
  await expect(page.locator('#global-search')).toBeFocused();
  await expect(page.locator('#global-results')).toContainText(title);
  await page.locator('#global-results .search-result').filter({ hasText: title }).click();
  await expect(page.locator('article')).toContainText('关键词验证素材正文');
});

test('今日计划真实读取、已有弹窗新建主题、业务未知来源重启保留', async ({ page, request }) => {
  const id=await identity(request),title='今日真实主题 '+randomUUID().slice(0,8);
  await page.goto('/?mode=real#today');
  await expect(page.locator('.hero-budget')).toContainText('120 min');
  await expect(page.locator('.task-copy')).not.toContainText('补上实测依据');
  await action(page,'new-topic').click();await page.locator('#new-title').fill(title);await page.locator('#new-category').selectOption('个人思考');
  const write=page.waitForResponse(r=>r.url().endsWith('/api/v1/topics')&&r.request().method()==='POST');await action(page,'create-topic',true).click();expect((await write).status()).toBe(201);
  const topics=await request.get('/api/v1/topics',{headers:headers(id)}),topic=(await topics.json()).items.find((row:{title:string})=>row.title===title);expect(topic).toBeTruthy();
  const overview=await request.get('/api/v1/overview',{headers:headers(id)}),before=await overview.json();
  const plan=await request.put('/api/v1/daily-plans/'+before.local_date,{headers:headers(id),data:{timezone:before.timezone,expected_version:before.plan?.version??0,budget_min:120,items:[{topic_id:topic.id,effort_min:30,status:'pending'}]}});expect(plan.status()).toBe(200);
  await page.goto('/?mode=real#today');await expect(page.locator('.task-copy')).toContainText(title);await expect(page.locator('.task-copy')).toContainText('30');await expect(page.locator('.current-title')).toContainText(title);
  await page.goto('/?mode=real#retro');await expect(page.locator('#content')).toContainText('数据复盘');await expect(page.locator('#content')).toContainText('暂无复盘建议');await expect(action(page,'adopt-retro')).toBeDisabled();
  await action(page,'business').click();await page.locator('#business-count').fill('3');await page.locator('#business-source').fill('未知');await action(page,'save-business',true).click();
  await expect(page.locator('#content')).toContainText('咨询 / 合作线索：3');await expect(page.locator('#content')).toContainText('关联来源：未知');
  const events=await request.get('/api/v1/business-events',{headers:headers(id)});expect((await events.json()).items.some((row:{count:string;attribution_status:string})=>row.count==='3'&&row.attribution_status==='unknown')).toBe(true);
  const boot=await runtime(request),restarted=await runtime(request,true);expect(restarted.boot_id).not.toBe(boot.boot_id);await page.reload();await expect(page.locator('#content')).toContainText('关联来源：未知');
});

test('真实页面四种视口不溢出，未知快照不显示成示例或固定72h', async({page})=>{
  for(const viewport of [{width:1440,height:1000},{width:1024,height:768},{width:768,height:1024},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    for(const name of ['today','sources','knowledge','retro']){
      await page.goto('/?mode=real#'+name);await expect(page.locator('#content')).not.toContainText('真实模块尚未接入');
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      await expect(page.locator('#content')).not.toContainText('示例条目');
    }
    await page.locator('[data-action="retro-tab"][data-value="single"]').click();await expect(page.locator('.timeline-points')).toContainText('尚无历次观察');await expect(page.locator('.timeline-points')).not.toContainText('72 小时快照');
  }
});

test('资料正文搜索命中仍可见，HTML文字安全显示，快速查询只显示最后结果',async({page,request})=>{
  const id=await identity(request),suffix=randomUUID().slice(0,8),title='<img src=x onerror=alert(1)> 资料 '+suffix;
  const added=await request.post('/api/v1/source-records',{headers:headers(id),data:{title,text:'仅正文关键词'+suffix}});expect(added.status()).toBe(201);
  await page.goto('/?mode=real#sources');await page.locator('#source-query').fill('仅正文关键词'+suffix);await expect(page.locator('#feed-list')).toContainText(title);await expect(page.locator('article')).toContainText(title);await expect(page.locator('article img')).toHaveCount(0);
  await page.locator('#source-query').fill('不存在'+suffix);await expect(page.locator('#feed-list .feed-item')).toHaveCount(0);await expect(page.locator('#source-query')).toHaveValue('不存在'+suffix);
});

test('真实复盘快速切平台：旧账号响应迟到不回退页面，也不提示正常取消为失败', async ({ page }) => {
  await page.goto('/?mode=real#retro');
  await expect(page.locator('.metrics-grid')).toBeVisible();
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  await page.route('**/api/v1/accounts', async route => {
    if (++calls === 1) { started(); await pending; }
    await route.continue();
  });
  const chip = (platform: string) => page.locator('[data-action="retro-platform"][data-value="' + platform + '"]');
  await chip('douyin').click(); await reached;
  const currentResponse = page.waitForResponse(response => response.url().includes('/api/v1/business-events'));
  await chip('xiaohongshu').click(); await currentResponse;
  const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/accounts'));
  release(); await oldResponse;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(chip('xiaohongshu')).toHaveClass(/active/);
  await expect(chip('douyin')).not.toHaveClass(/active/);
  await expect(page.locator('#toast-region')).not.toContainText('读取已被更新');
});
