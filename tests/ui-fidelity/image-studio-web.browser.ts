// 网络找图浏览器用例：生产 Workbench + 真实服务路由 + 注入式网络（不发真实请求），三视口截图。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium,type Page} from '@playwright/test';
import {startStudioFixture} from '../image-studio/harness.ts';
import {FakeWeb,ARTICLE_URL,seedWebSources} from '../image-studio/web-fixture.ts';
import {solidPng} from '../helpers/png.ts';

const root=resolve(import.meta.dirname,'../..'),out=resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR??join(root,'.ci-artifacts/image-studio-b'));mkdirSync(out,{recursive:true});
const errors:string[]=[],screens:string[]=[],checks:unknown[]=[];
const LONG_TITLE='一个非常长的原文页面标题，用来检查卡片在窄屏下的换行与截断是否依然清楚可读，'.repeat(3);
const html='<html><head><title>'+LONG_TITLE+'</title><meta property="og:site_name" content="Example News 科技频道"><meta property="og:image" content="/og.png"><meta name="twitter:image" content="https://news.example/tw.png"></head><body><img data-src="in2.png"></body></html>';
async function shot(page:Page,name:string,width:number){await page.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'||a.effect?.getTiming().iterations===Infinity),undefined,{timeout:5000}).catch(()=>{});await page.waitForTimeout(300);const file=join(out,name+'-'+width+'.png');await page.screenshot({path:file,fullPage:true});screens.push(file);}
async function openStudio(page:Page){await page.locator('[data-action="edit-tab"][data-value="versions"]').click();const wechat=page.locator('[data-action="platform-tab"][data-value="wechat"]');await wechat.waitFor();if(!(await wechat.getAttribute('class'))?.includes('active'))await wechat.click();await page.locator('.publish-steps .image-studio-panel').waitFor();const legacy=page.locator('[data-action="studio-legacy-toggle"]');await legacy.waitFor();if(await legacy.getAttribute('aria-expanded')==='false')await legacy.click();await page.waitForFunction(()=>{const b=document.querySelector('[data-action="studio-web"]') as HTMLButtonElement|null;return !!b&&!b.disabled;});}
const browser=await chromium.launch({headless:true});
try{
 for(const [width,height] of [[1440,1000],[768,1024],[390,844]] as const){
  const web=new FakeWeb();web.html(ARTICLE_URL,html);web.png('https://news.example/og.png',64,40,[11,31,82]);web.png('https://news.example/tw.png',40,40,[204,248,102]);
  const shared=web.png('https://pbs.example/x1.png',48,32,[91,95,214]);web.routes.set('https://pbs.example/q1.png',()=>new Response(new Uint8Array(shared),{headers:{'content-type':'image/png'}}));web.png('https://douyin.example/cover.png?x-expires=4102444800',30,40,[226,227,251]);
  const fixture=await startStudioFixture({auto_worker:false,web:{fetcher:web.fetcher,lookup:web.lookup}}),app=fixture.app,service='http://127.0.0.1:'+app.address.port,calls:any[]=[];
  const source=`import {createRoot} from 'react-dom/client';import {Workbench} from './apps/web/src/app/Workbench.tsx';
import {createHttpClient} from './apps/web/src/transport/workbench-client.ts';import {createDataFeaturePorts} from './apps/web/src/transport/data-features.ts';
import './apps/web/src/styles/approved.css';import './apps/web/src/styles/configuration.css';import './apps/web/src/styles/skills.css';import './apps/web/src/features/operations/operations.css';
const client=createHttpClient(),host=createRoot(document.querySelector('#root'));window.fixture={unmount:()=>host.unmount()};
host.render(<Workbench injection={{mode:'real',client,features:createDataFeaturePorts(),initialLocation:{page:'create',topic_id:${JSON.stringify(fixture.topic.id)},variant_id:${JSON.stringify(fixture.variant_id)}}}}/>);`;
  const bundle=await build({absWorkingDir:root,stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:out,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});
  const js=bundle.outputFiles!.find(f=>f.path.endsWith('.js'))!.text,css=bundle.outputFiles!.find(f=>f.path.endsWith('.css'))!.text;
  const proxy=createServer(async(req,res)=>{try{const url=req.url??'/';if(url.startsWith('/api/')){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks),forward=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length'].includes(name))forward.set(name,Array.isArray(value)?value.join(','):value);calls.push({method:req.method,url,key:req.headers['idempotency-key']??null});const response=await fetch(service+url,{method:req.method,headers:forward,body:bytes.length?bytes:undefined});res.statusCode=response.status;for(const [name,value] of response.headers)if(!['transfer-encoding','connection','content-encoding'].includes(name))res.setHeader(name,value);res.end(Buffer.from(await response.arrayBuffer()));return;}if(url.startsWith('/workbench/')){const leaf=url.slice(7);if(!/^[\w./-]+$/.test(leaf)||leaf.includes('..'))throw new Error('bad brand path');res.end(readFileSync(join(root,'apps/web/public/workbench',leaf)));return;}res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script type="module">'+js+'</script></html>');}catch(e){res.statusCode=500;res.end(String(e));}});
  await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));
  const page=await browser.newPage({viewport:{width,height}});page.on('pageerror',e=>errors.push(width+':'+e.message));
  // 浏览器里的候选缩略图同样不走真实网络：外部图片地址由测试回放固定 PNG。
  await page.route(/^https:\/\/(news|pbs)\.example\//,route=>route.fulfill({status:200,contentType:'image/png',body:solidPng(160,120,[196,202,231])}));
  // 抖音缩略图模拟来源站防盗链：浏览器取不到，卡片改显示说明文字，仍可导入。
  await page.route(/^https:\/\/douyin\.example\//,route=>route.abort());
  try{
   await page.goto('http://127.0.0.1:'+(proxy.address() as {port:number}).port);await openStudio(page);
   await page.locator('[data-action="studio-web"]').click();await page.locator('.studio-web .studio-empty').waitFor();assert.match(await page.locator('.studio-web .studio-empty').textContent()??'',/还没有可用的网络配图/);assert.equal(await page.locator('#studio-web-import').count(),0);await shot(page,'empty',width);
   await page.locator('#dialog [data-action="close-dialog"]').last().click();
   seedWebSources(app.context,fixture.request(),fixture.topic.id,{searchText:'同题：'+fixture.topic.title});
   await page.locator('[data-action="studio-web"]').click();await page.locator('.studio-web-grid').first().waitFor();
   // #46 起网络候选缓存优先：资讯原文图在后台读完后并入窗口，等并入完成再核对。
   await page.waitForFunction(()=>document.querySelectorAll('.studio-web-card').length===7&&!document.querySelector('.studio-web-capture-dot'),undefined,{timeout:20000});const cards=page.locator('.studio-web-card');assert.equal(await cards.count(),7);assert.equal(await page.locator('.studio-web-group').count(),2);
   const expired=page.locator('.studio-web-card.is-disabled');assert.equal(await expired.count(),1);assert.equal(await expired.locator('input').isDisabled(),true);assert.match(await expired.textContent()??'',/过期/);
   const text=await page.locator('#dialog').textContent()??'';for(const label of ['图源：Example News 科技频道','图源：X @alice','图源：X @bob','图源：抖音 @抖音作者'])assert.ok(text.includes(label),label);assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-|[0-9a-f]{32}/.test(text),false,'主路径不露记录 ID 或指纹');
   assert.equal(await page.locator('.studio-web-link').first().getAttribute('href'),ARTICLE_URL);assert.equal(await page.locator('#studio-web-import').isDisabled(),true);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const dialogFit=await page.locator('#dialog').evaluate((d:HTMLElement)=>d.scrollWidth<=d.clientWidth+1);assert.ok(dialogFit);
   await page.waitForFunction(()=>document.querySelectorAll('.studio-web-thumb.is-broken').length===2);assert.match(await page.locator('.studio-web-thumb.is-broken').first().textContent()??'',/缩略图无法显示（来源站限制），不影响导入/);assert.equal(await page.locator('.studio-web-card').filter({hasText:'图源：抖音'}).last().locator('input').isDisabled(),false);
   await shot(page,'candidates',width);
   // 勾选：X 两张（同一张图，复用资产）+ 原文正文图（来源 404，只这张失败）
   const pick=(label:string,nth=0)=>page.locator('.studio-web-card').filter({hasText:label}).nth(nth).locator('input');
   await pick('图源：X @alice').check();await pick('图源：X @bob').check();await page.locator('.studio-web-card').filter({hasText:'图源：Example News'}).nth(2).locator('input').check();
   assert.match(await page.locator('#studio-web-import').textContent()??'',/3 张/);await shot(page,'picked',width);
   const before=calls.filter(c=>c.method==='POST'&&c.url==='/api/v1/image-studio/web-imports').length;await page.locator('#studio-web-import').click();
   await page.locator('.studio-web-note.is-error').waitFor();assert.equal(await page.locator('.studio-web-note.is-error').textContent(),'这张没有导入：来源页面已打不开，未取得图片');assert.equal(/\d{3}|NOT_FOUND|VALIDATION/.test(await page.locator('#dialog').textContent()??''),false,'失败原因不露状态码/错误码');assert.equal(await page.locator('.studio-web-note.is-error').count(),1);assert.equal(await page.locator('.studio-web-note.is-done').count(),2);
   const posts=calls.filter(c=>c.method==='POST'&&c.url==='/api/v1/image-studio/web-imports').slice(before);assert.equal(posts.length,3);assert.equal(new Set(posts.map(c=>c.key)).size,3);await shot(page,'partial-failure',width);
   await page.locator('#dialog [data-action="close-dialog"]').last().click();await page.waitForFunction(()=>!(document.querySelector('#dialog') as HTMLDialogElement).open);
   await page.waitForFunction(()=>document.querySelectorAll('.studio-version').length===2);await page.locator('.studio-canvas img').waitFor();
   const versionText=await page.locator('.studio-versions').textContent()??'';assert.ok(versionText.includes('图源：X @alice')&&versionText.includes('图源：X @bob'));assert.match(await page.locator('.studio-credit').textContent()??'',/图源：X @bob/);
   const state=await (await fetch(service+'/api/v1/image-studio?topic_id='+fixture.topic.id,{headers:{'x-workspace-id':app.identity.workspace_id,'x-service-instance-id':app.identity.service_instance_id}})).json();assert.equal(state.slots[0].versions[0].asset_id,state.slots[0].versions[1].asset_id);assert.equal(state.slots[0].versions[0].job_id,null);
   await shot(page,'imported',width);
   await page.locator('[data-action="studio-adopt"]').click();await page.locator('.studio-adopted').filter({hasText:'文章当前采用'}).waitFor();await shot(page,'adopted',width);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(fixture.image_calls,0);assert.equal(web.calls.some(u=>u.includes('tikhub')),false);
   checks.push({width,height,result:'passed',candidates:7,expired_disabled:1,imported:2,failed_only_one:true,same_asset_reused:true,real_network_calls:0});
  }catch(error){await shot(page,'failure',width).catch(()=>{});writeFileSync(join(out,'failure-'+width+'.json'),JSON.stringify({message:String(error),calls,errors},null,2));throw error;}
  finally{await page.evaluate(()=>(window as any).fixture?.unmount()).catch(()=>{});await page.close();await new Promise<void>(done=>proxy.close(()=>done()));await fixture.close();}
 }
 assert.deepEqual(errors,[]);writeFileSync(join(out,'checks.json'),JSON.stringify({task:'WECHAT-IMAGE-STUDIO-B',checked_at:new Date().toISOString(),checks,screens,errors,scope:'developer browser integration with injected network; real CDN/page fetch not exercised'},null,2)+'\n');console.log(JSON.stringify({out,checks:checks.length,screens:screens.length}));
}finally{await browser.close();}
