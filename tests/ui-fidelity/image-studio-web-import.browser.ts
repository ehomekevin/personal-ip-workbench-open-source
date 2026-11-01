// 网络找图「导入所选」真实点击路径回归：生产 Workbench + 真实控制器 + fixture 服务（注入式网络，不发真实请求）。
// 覆盖：点击立即进入「导入中…」并逐张报告进度、发出 N 个幂等 POST、成功后版本卡出现；
// 导入中关闭窗口与页面刷新（studio 被重新激活而弹窗仍在）两条中断路径都有可见反馈，不再静默。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium,type Page} from '@playwright/test';
import {startStudioFixture} from '../image-studio/harness.ts';
import {FakeWeb,ARTICLE_URL,seedWebSources} from '../image-studio/web-fixture.ts';
import {solidPng} from '../helpers/png.ts';
import {workbenchViewHash} from '../../apps/web/src/transport/workbench-location.ts';

const root=resolve(import.meta.dirname,'../..'),out=resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR??join(root,'.ci-artifacts/image-studio-import-fix'));mkdirSync(out,{recursive:true});
const errors:string[]=[],screens:string[]=[],checks:unknown[]=[];
// 生产故障形态：同一篇资讯原文里的多张配图，availability=unknown（无签名过期时间）。
const IMAGES=Array.from({length:6},(_,i)=>'https://news.example/p'+i+'.png');
const html='<html><head><title>Google finally releases Gemini 4 Argon</title><meta property="og:site_name" content="The Verge"></head><body>'+IMAGES.map(u=>'<img src="'+u+'" width="1200" height="800">').join('')+'</body></html>';
async function shot(page:Page,name:string,width:number,fullPage=true){await page.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'||a.effect?.getTiming().iterations===Infinity),undefined,{timeout:5000}).catch(()=>{});await page.waitForTimeout(300);const file=join(out,name+'-'+width+'.png');await page.screenshot({path:file,fullPage});screens.push(file);}
async function openStudio(page:Page){await page.locator('[data-action="edit-tab"][data-value="versions"]').click();const wechat=page.locator('[data-action="platform-tab"][data-value="wechat"]');await wechat.waitFor();if(!(await wechat.getAttribute('class'))?.includes('active'))await wechat.click();await page.locator('.publish-steps .image-studio-panel').waitFor();{const legacy=page.locator('[data-action="studio-legacy-toggle"]');await legacy.waitFor();if(await legacy.getAttribute('aria-expanded')==='false')await legacy.click();}await studioReady(page);}
async function studioReady(page:Page){await page.locator('.publish-steps .image-studio-panel').waitFor();{const legacy=page.locator('[data-action="studio-legacy-toggle"]');await legacy.waitFor();if(await legacy.getAttribute('aria-expanded')==='false')await legacy.click();}await page.waitForFunction(()=>{const b=document.querySelector('[data-action="studio-web"]') as HTMLButtonElement|null;return !!b&&!b.disabled;});}
async function openWeb(page:Page){await page.locator('[data-action="studio-web"]').click();await page.locator('.studio-web-grid').first().waitFor();}
async function until(ok:()=>boolean,ms=10000){const end=Date.now()+ms;while(!ok()){if(Date.now()>end)throw new Error('等待超时');await new Promise(r=>setTimeout(r,50));}}
const pick=(page:Page,n:number)=>page.locator('.studio-web-card input:not([disabled])').nth(n);
// POST 闸门：放行前请求停在代理里，用来观察「导入中…」状态与中途关闭。
class Gate{private open=true;private waiters:Array<()=>void>=[];hold(){this.open=false;}release(){this.open=true;for(const w of this.waiters.splice(0))w();}wait(){return this.open?Promise.resolve():new Promise<void>(r=>this.waiters.push(r));}}
const browser=await chromium.launch({headless:true});
try{
 for(const [width,height] of [[1440,900],[768,1024],[390,844]] as const){
  const web=new FakeWeb();web.html(ARTICLE_URL,html);IMAGES.forEach((u,i)=>web.png(u,120,80,[30+i*30,60,140]));
  const fixture=await startStudioFixture({auto_worker:false,web:{fetcher:web.fetcher,lookup:web.lookup}}),app=fixture.app,service='http://127.0.0.1:'+app.address.port,calls:any[]=[],gate=new Gate();
  const source=`import {createRoot} from 'react-dom/client';import {Workbench} from './apps/web/src/app/Workbench.tsx';
import {createHttpClient} from './apps/web/src/transport/workbench-client.ts';import {createDataFeaturePorts} from './apps/web/src/transport/data-features.ts';
import './apps/web/src/styles/approved.css';import './apps/web/src/styles/configuration.css';import './apps/web/src/styles/skills.css';import './apps/web/src/features/operations/operations.css';
const client=createHttpClient(),host=createRoot(document.querySelector('#root'));window.fixture={unmount:()=>host.unmount()};
host.render(<Workbench injection={{mode:'real',client,features:createDataFeaturePorts(),initialLocation:{page:'create',topic_id:${JSON.stringify(fixture.topic.id)},variant_id:${JSON.stringify(fixture.variant_id)}}}}/>);`;
  const bundle=await build({absWorkingDir:root,stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:out,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});
  const js=bundle.outputFiles!.find(f=>f.path.endsWith('.js'))!.text,css=bundle.outputFiles!.find(f=>f.path.endsWith('.css'))!.text;
  const proxy=createServer(async(req,res)=>{try{const url=req.url??'/';if(url.startsWith('/api/')){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks),forward=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length'].includes(name))forward.set(name,Array.isArray(value)?value.join(','):value);calls.push({method:req.method,url,key:req.headers['idempotency-key']??null});if(req.method==='POST'&&url==='/api/v1/image-studio/web-imports')await gate.wait();const response=await fetch(service+url,{method:req.method,headers:forward,body:bytes.length?bytes:undefined});res.statusCode=response.status;for(const [name,value] of response.headers)if(!['transfer-encoding','connection','content-encoding'].includes(name))res.setHeader(name,value);res.end(Buffer.from(await response.arrayBuffer()));return;}if(url.startsWith('/workbench/')){const leaf=url.slice(7);if(!/^[\w./-]+$/.test(leaf)||leaf.includes('..'))throw new Error('bad brand path');res.end(readFileSync(join(root,'apps/web/public/workbench',leaf)));return;}res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script type="module">'+js+'</script></html>');}catch(e){res.statusCode=500;res.end(String(e));}});
  await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));
  const page=await browser.newPage({viewport:{width,height}});page.on('pageerror',e=>errors.push(width+':'+e.message));
  await page.route(/^https:\/\/news\.example\//,route=>route.fulfill({status:200,contentType:'image/png',body:solidPng(1200,800,[196,202,231])}));
  const posts=()=>calls.filter(c=>c.method==='POST'&&c.url==='/api/v1/image-studio/web-imports');
  const toast=()=>page.locator('#toast-region .toast');
  try{
   seedWebSources(app.context,fixture.request(),fixture.topic.id,{searchText:'同题：'+fixture.topic.title,link:true});
   await page.goto('http://127.0.0.1:'+(proxy.address() as {port:number}).port);await openStudio(page);
   // 1) 真实点击路径：直接打开（不先开空窗口）→ 勾选 3 张 → 点「导入所选」。
   await openWeb(page);
   // #46 起网络候选缓存优先：先显示已缓存的同题帖子图，资讯原文图在后台读完后并入窗口；等并入后再勾选。
   await page.waitForFunction(()=>document.querySelectorAll('.studio-web-card').length>=6,undefined,{timeout:20000});assert.ok(await page.locator('.studio-web-card').count()>=6);
   for(const n of [0,1,2])await pick(page,n).check();const button=page.locator('#studio-web-import');assert.equal(await button.textContent(),'导入所选（3 张）');assert.equal(await button.isDisabled(),false);
   gate.hold();await button.click();
   // 点击后立即进入「导入中…」：按钮禁用、页脚状态行说明进度，勾选框锁定。
   await page.waitForFunction(()=>/导入中…（0\/3）/.test(document.querySelector('#studio-web-import')?.textContent??''));assert.equal(await button.isDisabled(),true);assert.equal(await button.getAttribute('aria-busy'),'');
   assert.match(await page.locator('#studio-web-progress').textContent()??'',/正在导入第 1 \/ 3 张/);assert.equal(await pick(page,0).count(),0,'导入中勾选框全部锁定');
   await until(()=>posts().length===1);assert.equal(posts().length,1,'第一张 POST 已发出并停在闸门');
   await shot(page,'importing',width,false);
   const done3=toast().filter({hasText:'已导入 3 张网络配图'}).waitFor();gate.release();await page.waitForFunction(()=>!(document.querySelector('#dialog') as HTMLDialogElement).open);
   await done3;assert.equal(posts().length,3);assert.equal(new Set(posts().map(c=>c.key)).size,3,'每张一个幂等键');
   await page.waitForFunction(()=>document.querySelectorAll('.studio-version').length===3);assert.match(await page.locator('.studio-versions').textContent()??'',/图源：The Verge/);
   await shot(page,'imported',width);
   // 2) 导入中关闭窗口：停止后续请求，toast 说明已停止及已导入张数。
   await openWeb(page);for(const n of [0,1])await pick(page,n).check();const before=posts().length;gate.hold();await page.locator('#studio-web-import').click();
   await page.waitForFunction(()=>/导入中…/.test(document.querySelector('#studio-web-import')?.textContent??''));await until(()=>posts().length===before+1);
   await page.locator('#dialog [data-action="close-dialog"]').last().click();await page.waitForFunction(()=>!(document.querySelector('#dialog') as HTMLDialogElement).open);const stopNotice=toast().filter({hasText:'找图窗口已关闭，导入已停止'}).waitFor();gate.release();
   await stopNotice;await page.waitForTimeout(500);assert.equal(posts().length-before,1,'关闭后不再发后续导入请求');
   await shot(page,'closed-midway',width);
   // 2b) 迟到的成功已对账：重开时这张标「已导入」不可再选（共 4 张：第一轮 3 张 + 关窗前在途的 1 张），不会重复 POST。
   await studioReady(page);await openWeb(page);assert.equal(await page.locator('.studio-web-note.is-done').count(),4);assert.equal(await page.locator('.studio-web-card.is-disabled').filter({hasText:'已导入'}).locator('input:disabled').count(),4,'已导入项不可再选');assert.equal(posts().length-before,1);
   await page.locator('#dialog [data-action="close-dialog"]').last().click();await page.waitForFunction(()=>!(document.querySelector('#dialog') as HTMLDialogElement).open);
   // 3) 页面刷新（hash 导航让配图面板失活再激活）：原来找图弹窗留在屏幕上、控件被锁，点「导入所选」无反应；现在弹窗关闭并提示重新勾选。
   // 注入 initialLocation 的页面不改写地址栏（#49）：开始时 hash 为空，这里按产品的地址格式交替去掉/带上 variant_id，触发同一篇的 hash 导航。
   let withVariant=true;const flip=async()=>{withVariant=!withVariant;const next=workbenchViewHash({page:'create',topic_id:fixture.topic.id,...(withVariant?{variant_id:fixture.variant_id}:{})},{tab:'versions',platform:'wechat'});await page.evaluate(h=>{location.hash=h;},next);};
   await studioReady(page);await openWeb(page);await pick(page,0).check();const closedNotice=toast().filter({hasText:'页面已刷新，找图窗口已关闭'}).waitFor();await flip();
   await page.waitForFunction(()=>!(document.querySelector('#dialog') as HTMLDialogElement).open);await closedNotice;await studioReady(page);await shot(page,'refreshed',width);
   // 3b) 真正按 F5 刷新：页面卸载前关掉的找图窗口，提示在新页面里照样出现（sessionStorage 读后即删，再刷新不重复）。
   await openWeb(page);await page.reload();await openStudio(page);await toast().filter({hasText:'页面已刷新，找图窗口已关闭'}).waitFor();assert.equal(await page.evaluate(()=>sessionStorage.getItem('image-studio-orphan-notice')),null,'读后即删');await studioReady(page);
   // 刷新后重新打开、勾选、导入：照常发出 POST。
   await openWeb(page);await pick(page,0).check();const beforeRetry=posts().length;const retried=toast().filter({hasText:'已导入 1 张网络配图'}).waitFor();await page.locator('#studio-web-import').click();await retried;assert.equal(posts().length-beforeRetry,1);
   // 4) 导入进行中被刷新：停止后续请求，toast 说明导入已停止。
   await studioReady(page);await openWeb(page);for(const n of [0,1])await pick(page,n).check();const beforeMid=posts().length;gate.hold();await page.locator('#studio-web-import').click();await until(()=>posts().length===beforeMid+1);
   await flip();await page.waitForFunction(()=>!(document.querySelector('#dialog') as HTMLDialogElement).open);const midNotice=toast().filter({hasText:'页面已刷新，导入已停止'}).waitFor();gate.release();await midNotice;await page.waitForTimeout(500);assert.equal(posts().length-beforeMid,1,'刷新后不再发后续导入请求');
   await studioReady(page);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(fixture.image_calls,0);
   checks.push({width,height,result:'passed',posts_first:3,closed_midway_posts:1,refreshed_dialog_closed:true,retry_after_refresh_posts:1,refreshed_midway_posts:1});
  }catch(error){await shot(page,'failure',width).catch(()=>{});writeFileSync(join(out,'failure-'+width+'.json'),JSON.stringify({message:String(error),calls,errors},null,2));throw error;}
  finally{gate.release();await page.evaluate(()=>(window as any).fixture?.unmount()).catch(()=>{});await page.close();await new Promise<void>(done=>proxy.close(()=>done()));await fixture.close();}
 }
 assert.deepEqual(errors,[]);writeFileSync(join(out,'checks.json'),JSON.stringify({task:'IMAGE-STUDIO-WEB-IMPORT-FIX',checked_at:new Date().toISOString(),checks,screens,errors,scope:'developer browser integration with injected network; real CDN/page fetch not exercised'},null,2)+'\n');console.log(JSON.stringify({out,checks:checks.length,screens:screens.length}));
}finally{await browser.close();}
