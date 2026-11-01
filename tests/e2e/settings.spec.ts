import { test,expect,identity,headers,getSettings,runtime } from './fixtures.ts';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {DEFAULT_OPERATING_PREFERENCES} from '../../packages/contracts/src/index.ts';

async function configuration(request:any,id:any){const response=await request.get('/api/v1/settings/configuration',{headers:headers(id)});expect(response.status()).toBe(200);return response.json();}
test.beforeEach(async({page,request})=>{
 const id=await identity(request),settings=await getSettings(request,id);
 if(settings.default_executor!=='codex'||settings.timezone!=='America/Los_Angeles')expect((await request.patch('/api/v1/settings',{headers:headers(id),data:{expected_version:settings.version,default_executor:'codex',timezone:'America/Los_Angeles'}})).status()).toBe(200);
 const cfg=await configuration(request,id);if(JSON.stringify(cfg.preferences)!==JSON.stringify(DEFAULT_OPERATING_PREFERENCES))expect((await request.put('/api/v1/settings/configuration',{headers:headers(id),data:{expected_version:cfg.version,preferences:DEFAULT_OPERATING_PREFERENCES}})).status()).toBe(200);
 await page.goto('/?mode=real#settings');await expect(page.locator('#cfg-budget')).toBeVisible();
});
test('配置页：默认执行器、工作方式实际保存并在重启后读回',async({page,request})=>{
 const id=await identity(request),before=await getSettings(request,id),boot=await runtime(request),priorOverview=await request.get('/api/v1/overview',{headers:headers(id)}).then(r=>r.json()),radio=page.locator('input[name="default-agent"][value="claude"]');
 await radio.check();await expect(page.locator('.toast')).toContainText('默认执行器已保存');await expect(radio).toBeFocused();expect((await getSettings(request,id)).version).toBe(before.version+1);
 await page.getByLabel('每日人工时间 / 分钟').fill('90');await page.getByLabel('周期复盘 / 天').fill('10');await page.getByRole('button',{name:'保存工作方式',exact:true}).click();await expect(page.locator('.toast')).toContainText('工作方式已保存');
 const saved=await configuration(request,id);expect(saved.preferences.daily_budget_min).toBe(90);expect(saved.preferences.retro_days).toBe(10);
 const overview=await request.get('/api/v1/overview',{headers:headers(id)});expect((await overview.json()).budget_min).toBe(priorOverview.plan?priorOverview.plan.budget_min:90);
 const nextDate=new Date(Date.parse(priorOverview.local_date+'T12:00:00Z')+86400000).toISOString().slice(0,10),future=await request.get('/api/v1/overview?date='+nextDate,{headers:headers(id)});expect((await future.json()).budget_min).toBe(90);
 const restarted=await runtime(request,true);expect(restarted.boot_id).not.toBe(boot.boot_id);await page.reload();await expect(radio).toBeChecked();await expect(page.locator('#cfg-budget')).toHaveValue('90');await expect(page.locator('#cfg-retro-days')).toHaveValue('10');
 await page.locator('.sidebar [data-page="retro"]').click();await expect(page.locator('#retro-period')).toHaveValue('10');
});
test('配置页：版本冲突保留输入，刷新核对后可再次保存',async({page,request})=>{
 const id=await identity(request),before=await getSettings(request,id);await page.locator('#cfg-timezone').fill('Asia/Shanghai');expect((await request.patch('/api/v1/settings',{headers:headers(id),data:{expected_version:before.version,default_executor:'claude'}})).status()).toBe(200);
 await page.getByRole('button',{name:'保存时区',exact:true}).click();await expect(page.locator('.configuration-error')).toContainText(/修改|冲突|版本/);await expect(page.locator('#cfg-timezone')).toHaveValue('Asia/Shanghai');expect((await getSettings(request,id)).timezone).toBe('America/Los_Angeles');
 await page.reload();await expect(page.locator('#cfg-timezone')).toHaveValue('Asia/Shanghai');await page.getByRole('button',{name:'刷新配置',exact:true}).click();await expect(page.locator('.toast')).toContainText('已读取最新配置');await page.getByRole('button',{name:'保存时区',exact:true}).click();await expect(page.locator('.toast')).toContainText('时区已保存');expect((await getSettings(request,id)).timezone).toBe('Asia/Shanghai');
});
test('配置页：断网保留工作方式输入，恢复后保存到真实服务',async({page,request})=>{
 const id=await identity(request),before=await configuration(request,id);await page.route('**/api/v1/settings/configuration',route=>route.request().method()==='PUT'?route.abort('failed'):route.continue());
 await page.locator('#cfg-budget').fill('123');await page.getByRole('button',{name:'保存工作方式',exact:true}).click();await expect(page.locator('.configuration-error')).toContainText('输入已保留');expect((await configuration(request,id)).version).toBe(before.version);
 await page.unroute('**/api/v1/settings/configuration');await page.reload();await expect(page.locator('#cfg-budget')).toHaveValue('123');await page.getByRole('button',{name:'保存工作方式',exact:true}).click();await expect(page.locator('.toast')).toContainText('工作方式已保存');expect((await configuration(request,id)).preferences.daily_budget_min).toBe(123);
});
test('配置页：展示号可先登记，错误主页在弹窗内提示且保留输入',async({page,request})=>{
 const id=await identity(request);await page.locator('[data-action="cfg-account"][data-platform="xiaohongshu"]').click();await page.getByLabel('显示名称').fill('隔离账号登记');await page.getByLabel('展示 ID / 用户名').fill('fixture-xhs');await page.getByLabel('主页或公众号文章链接').fill('https://x.com/wrong');await page.getByRole('button',{name:'保存账号登记',exact:true}).click();await expect(page.locator('#dialog [role="alert"]')).toContainText('所选平台');await expect(page.getByLabel('展示 ID / 用户名')).toHaveValue('fixture-xhs');
 await page.getByLabel('主页或公众号文章链接').fill('');await page.getByRole('button',{name:'保存账号登记',exact:true}).click();await expect(page.locator('#dialog')).not.toBeVisible();await expect(page.locator('.configuration-platform').filter({hasText:'小红书'})).toContainText('fixture-xhs');const saved=await configuration(request,id);expect(saved.accounts.find((a:any)=>a.platform==='xiaohongshu').identity_status).toBe('registration_only');
});
test('配置页：目录实际检查，未配置密钥和声音明确显示缺口',async({page})=>{
 await page.getByRole('button',{name:'检查目录',exact:true}).click();await expect(page.locator('.configuration-result').filter({hasText:'工作台目录可读写'})).toBeVisible();await page.locator('[data-action="cfg-check"][data-tool="tikhub"]').click();await expect(page.locator('.configuration-result').filter({hasText:'先填写 TikHub 密钥'})).toBeVisible();await expect(page.locator('[data-action="cfg-index"]')).toBeDisabled();
 await page.getByRole('button',{name:'检查声音服务',exact:true}).click();await expect(page.locator('.configuration-result').filter({hasText:/声音|输入|配置/}).last()).toBeVisible();await expect(page.locator('#cfg-budget')).toBeEnabled();
});
test('配置页：三个视口可操作，长路径与平台连接没有整页横向溢出',async({page},testInfo)=>{
 for(const width of [390,768,1440]){await page.setViewportSize({width,height:900});const sizes=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:document.documentElement.clientWidth}));expect(sizes.scroll).toBe(sizes.width);await expect(page.locator('#cfg-source-vault')).toBeVisible();await testInfo.attach('settings-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});}
 await page.locator('[data-action="cfg-publishing"][data-platform="bilibili"]').click();await expect(page.locator('#content')).toContainText('发布通道待接入');await page.getByRole('button',{name:'返回设置',exact:true}).click();await expect(page.locator('#cfg-budget')).toBeVisible();
});
test('配置页：保存源库后按已保存路径执行真实只读索引，资料可搜索且原文件不变',async({page,request})=>{
 const root=mkdtempSync(join(process.cwd(),'.ci-artifacts/config01-vault-')),file=join(root,'index-proof.md'),text='# CONFIG01索引验证\n\n原始资料保持只读。',id=await identity(request);writeFileSync(file,text);
 try{
  await page.locator('#cfg-source-vault').fill(root);await page.getByRole('button',{name:'保存路径',exact:true}).click();await expect(page.locator('.toast')).toContainText('资料路径已保存');
  await page.getByRole('button',{name:'更新只读索引',exact:true}).click();await expect(page.locator('.configuration-result').filter({hasText:'资料索引：完成 1 / 1'})).toBeVisible();
  const found=await request.get('/api/v1/search?query='+encodeURIComponent('CONFIG01索引验证'),{headers:headers(id)});expect(found.status()).toBe(200);expect((await found.json()).items.length).toBeGreaterThan(0);expect(readFileSync(file,'utf8')).toBe(text);
 }finally{const current=await getSettings(request,id);expect((await request.patch('/api/v1/settings',{headers:headers(id),data:{expected_version:current.version,paths:{...current.paths,source_vault_root:null}}})).status()).toBe(200);rmSync(root,{recursive:true,force:true});}
});

test('配置页：API 回退关闭时可保存模型偏好，未填 Key 时开启失败并保留选择',async({page,request})=>{
 const id=await identity(request);await page.getByText('API 连接 · 可选',{exact:true}).click();await expect(page.locator('#cfg-api-provider')).toBeVisible();
 await page.locator('#cfg-api-provider').selectOption('anthropic');await page.locator('#cfg-api-tokens').fill('2048');await page.getByRole('button',{name:'保存 API 回退',exact:true}).click();await expect(page.locator('.toast')).toContainText('API 回退已关闭');
 const saved=await configuration(request,id);expect(saved.api_fallback.provider).toBe('anthropic');expect(saved.api_fallback.max_output_tokens).toBe(2048);expect(saved.api_fallback.enabled).toBe(false);
 await page.reload();await page.getByText('API 连接 · 可选',{exact:true}).click();await expect(page.locator('#cfg-api-provider')).toHaveValue('anthropic');await expect(page.locator('#cfg-api-tokens')).toHaveValue('2048');await page.locator('#cfg-api-enabled').check();await page.getByRole('button',{name:'保存 API 回退',exact:true}).click();await expect(page.locator('.configuration-error')).toContainText(/模型|API/);await expect(page.locator('#cfg-api-enabled')).toBeChecked();expect((await configuration(request,id)).api_fallback.enabled).toBe(false);
 await page.locator('#cfg-api-enabled').uncheck();await page.getByRole('button',{name:'保存 API 回退',exact:true}).click();await expect(page.locator('.toast')).toContainText('API 回退已关闭');
});
