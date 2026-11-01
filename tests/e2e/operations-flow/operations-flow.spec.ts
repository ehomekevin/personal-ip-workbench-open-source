import {test,expect,type Page} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const evidence=resolve('.ci-artifacts/flow-motion-e2e');mkdirSync(evidence,{recursive:true});
const flow=(page:Page)=>page.locator('[data-operations-flow]');
async function positions(page:Page){return page.evaluate(()=>{const slot=document.querySelector<HTMLElement>('[data-operations-slot]')!,surface=document.querySelector<HTMLElement>('[data-operations-flow]')!,body=document.querySelector<HTMLElement>('.operations-panel>.panel-body')!,topbar=document.querySelector<HTMLElement>('.topbar')!;return {width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,slot:slot.getBoundingClientRect().toJSON(),surface:surface.getBoundingClientRect().toJSON(),bodyDocumentTop:body.getBoundingClientRect().top+scrollY,topbar:topbar.getBoundingClientRect().toJSON(),playing:surface.getAnimations({subtree:true}).filter(animation=>animation.playState==='running').length};});}
async function dock(page:Page){await page.evaluate(()=>window.scrollTo(0,350));await expect(flow(page)).toHaveClass(/is-docked/);await expect.poll(async()=>(await positions(page)).surface.top).toBeCloseTo(80,0);await expect.poll(async()=>(await positions(page)).playing).toBe(0);}
async function open(page:Page){await page.goto('/');await expect(flow(page)).toBeVisible();await page.evaluate(()=>document.fonts.ready);await expect.poll(()=>page.locator('.page').evaluate(element=>getComputedStyle(element).transform)).toBe('none');}
test.beforeEach(async({page,baseURL})=>{const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==new URL(baseURL!).origin)errors.push('非隔离网络请求 '+request.url());if(request.url().includes('/api/'))errors.push('fixture 不应请求服务API '+request.url());});(page as any).flowErrors=errors;});
test.afterEach(async({page})=>expect((page as any).flowErrors).toEqual([]));

test('390/768/1275 流程滚动缩略保留占位、按钮与焦点，跨断点重新计算完整高度',async({page})=>{
 const records=[];
 for(const width of [1275,768,390]){
  await page.setViewportSize({width,height:width===390?844:900});await open(page);const full=await positions(page);expect(full.overflow).toBe(0);
  await page.screenshot({path:resolve(evidence,'full-'+width+'.png')});await dock(page);const compact=await positions(page);expect(compact.overflow).toBe(0);expect(compact.bodyDocumentTop).toBeCloseTo(full.bodyDocumentTop,0);expect(compact.slot.height).toBeCloseTo(full.slot.height,0);expect(compact.surface.width).toBeCloseTo(compact.slot.width-16,0);expect(compact.surface.height).toBeLessThan(full.surface.height);
  await expect(flow(page).locator('[data-flow-step]')).toHaveCount(6);await page.screenshot({path:resolve(evidence,'docked-'+width+'.png')});
  await flow(page).locator('.operations-flow-dock-action button').click();await expect(page.locator('#dialog')).toBeVisible();expect(await page.locator('#dialog').evaluate(dialog=>{const rect=dialog.getBoundingClientRect();return document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)?.closest('dialog')===dialog;})).toBe(true);await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'展开并返回账号运营流程'}).click();await expect(flow(page)).not.toHaveClass(/is-docked/);await expect(flow(page).locator('h2')).toBeFocused();records.push({width,full,compact});
 }
 await page.setViewportSize({width:1275,height:900});await open(page);await dock(page);await page.setViewportSize({width:390,height:844});// 吸附状态下跨断点：占位按新宽度重新计算完整高度，等于 390 下未吸附时量到的完整高度（原先写死 >300，依赖侧栏占宽和字体换行）。
 await expect.poll(async()=>(await positions(page)).slot.height).toBeCloseTo(records.find(r=>r.width===390)!.full.slot.height,0);expect((await positions(page)).slot.height).toBeGreaterThan(records.find(r=>r.width===1275)!.full.slot.height);const resized=await positions(page);await page.getByRole('button',{name:'展开并返回账号运营流程'}).click();await expect(flow(page)).not.toHaveClass(/is-docked/);expect((await positions(page)).slot.height).toBeCloseTo(resized.slot.height,0);writeFileSync(resolve(evidence,'positions.json'),JSON.stringify({records,resized},null,2));
});

test('减少动态效果时没有 CSS/WAAPI 到达动画，滚动与展开仍可用',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await open(page);expect(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);expect((await positions(page)).playing).toBe(0);await expect(flow(page).locator('.operations-line-light')).toHaveCount(0);await dock(page);expect((await positions(page)).playing).toBe(0);
 await page.getByRole('button',{name:'展开并返回账号运营流程'}).click();await expect(flow(page)).not.toHaveClass(/is-docked/);expect((await positions(page)).playing).toBe(0);await page.screenshot({path:resolve(evidence,'reduced-motion.png')});
});

test('候选和已有稿不伪造完成，已确认反馈可继续刷新，长标题与主题切换只保留一个流程',async({page})=>{
 await open(page);await page.getByLabel('夹具状态').selectOption('candidate');await expect(flow(page).locator('.operations-step-check')).toHaveCount(0);await expect(flow(page).locator('[data-flow-state="candidate"]')).toHaveCount(1);
 await page.getByLabel('夹具状态').selectOption('core-unconfirmed');await expect(flow(page).locator('.operations-step-check')).toHaveCount(1);await expect(flow(page).locator('[data-flow-step="1"]')).toHaveAttribute('data-flow-state','pending');
 await page.getByLabel('夹具状态').selectOption('complete');await expect(flow(page).locator('.operations-step-check')).toHaveCount(4);await expect(page.locator('[data-refresh-feedback="true"]')).toHaveText('刷新真实读者反馈');await page.getByRole('button',{name:'切换主题',exact:true}).click();await expect(flow(page)).toHaveAttribute('data-flow-topic','fixture-second');
 for(const width of [390,768,1275]){await page.setViewportSize({width,height:900});expect((await positions(page)).overflow).toBe(0);await expect(flow(page)).toHaveCount(1);}await page.screenshot({path:resolve(evidence,'confirmed-long-title.png')});
 await dock(page);await page.getByRole('button',{name:'卸载 / 挂载',exact:true}).click();await expect(flow(page)).toHaveCount(0);await page.getByRole('button',{name:'卸载 / 挂载',exact:true}).click();await expect(flow(page)).toHaveCount(1);await page.getByRole('button',{name:'信息与对标',exact:true}).click();await expect(flow(page)).toHaveCount(0);await page.getByRole('button',{name:'今日工作台',exact:true}).click();await expect(flow(page)).toHaveCount(1);await dock(page);await page.getByRole('button',{name:'搜索资料、主题和页面'}).click();await expect(page.locator('#dialog')).toBeVisible();await expect(page.getByLabel('全局搜索')).toBeVisible();await page.keyboard.press('Escape');
});

test('BFCache 往返后同一控制器继续吸附和返回',async({page})=>{
 await page.addInitScript(()=>{(window as any).__flowPageShows=[];addEventListener('pageshow',event=>(window as any).__flowPageShows.push({persisted:event.persisted,at:Date.now()}));});await open(page);await dock(page);await page.goto('/away.html');await page.goBack({waitUntil:'commit'});await expect(flow(page)).toHaveCount(1);
 await expect.poll(()=>page.evaluate(()=>(window as any).__flowPageShows.some((event:any)=>event.persisted))).toBe(true);const shown=await page.evaluate(()=>(window as any).__flowPageShows);await page.getByRole('button',{name:'展开并返回账号运营流程'}).click();await expect(flow(page)).not.toHaveClass(/is-docked/);await dock(page);writeFileSync(resolve(evidence,'bfcache.json'),JSON.stringify(shown,null,2));
});
