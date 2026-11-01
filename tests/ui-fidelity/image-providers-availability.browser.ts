// 图像渠道可用判定浏览器用例：生产 Workbench + 真实服务路由；Codex 执行器注入为额度耗尽，AGY 只读探测注入（不跑真实命令、不生图），三视口截图。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium,type Page} from '@playwright/test';
import {startStudioFixture} from '../image-studio/harness.ts';
import {readGenerationBudget} from '../../packages/storage/src/image-studio/index.ts';
import type {ExecutorHealth} from '../../packages/contracts/src/index.ts';

const root=resolve(import.meta.dirname,'../..'),out=resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR??join(root,'.ci-artifacts/image-providers-availability'));mkdirSync(out,{recursive:true});
const errors:string[]=[],screens:string[]=[],checks:unknown[]=[];
const quota:ExecutorHealth={executor_id:'codex',status:'unverified',runtime_version:'codex-cli 0.161.0',auth_state:'QUOTA_EXHAUSTED',billing_route:'chatgpt_subscription',limitations:[]};
async function shot(page:Page,name:string,width:number){await page.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'||a.effect?.getTiming().iterations===Infinity),undefined,{timeout:5000}).catch(()=>{});await page.waitForTimeout(300);const file=join(out,name+'-'+width+'.png');await page.screenshot({path:file,fullPage:true});screens.push(file);}
async function openStudio(page:Page){await page.locator('[data-action="edit-tab"][data-value="versions"]').click();const wechat=page.locator('[data-action="platform-tab"][data-value="wechat"]');await wechat.waitFor();if(!(await wechat.getAttribute('class'))?.includes('active'))await wechat.click();await page.locator('.publish-steps .image-studio-panel').waitFor();const legacy=page.locator('[data-action="studio-legacy-toggle"]');await legacy.waitFor();if(await legacy.getAttribute('aria-expanded')==='false')await legacy.click();await page.waitForFunction(()=>{const b=document.querySelector('[data-action="studio-add"]') as HTMLButtonElement|null;return !!b&&!b.disabled;});}
const providerOptions=(page:Page)=>page.locator('#studio-provider option').evaluateAll(list=>list.map(o=>({value:(o as HTMLOptionElement).value,disabled:(o as HTMLOptionElement).disabled,text:o.textContent})));
const noOverflow=async(page:Page)=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'页面无横向溢出');};
const browser=await chromium.launch({headless:true});
try{
 for(const [width,height] of [[1440,1000],[768,1024],[390,844]] as const){
  let probes=0,probe:{ok:true}|{ok:false;reason:'connection'}={ok:true};
  const fixture=await startStudioFixture({auto_worker:false,executor_health:[quota],image_providers:{configured:()=>true,probeAgy:async()=>{probes++;return probe;}}}),app=fixture.app,service='http://127.0.0.1:'+app.address.port,calls:any[]=[];
  const source=`import {createRoot} from 'react-dom/client';import {Workbench} from './apps/web/src/app/Workbench.tsx';
import {createHttpClient} from './apps/web/src/transport/workbench-client.ts';import {createDataFeaturePorts} from './apps/web/src/transport/data-features.ts';
import './apps/web/src/styles/approved.css';import './apps/web/src/styles/configuration.css';import './apps/web/src/styles/skills.css';import './apps/web/src/features/operations/operations.css';
const client=createHttpClient(),host=createRoot(document.querySelector('#root'));window.fixture={unmount:()=>host.unmount()};
host.render(<Workbench injection={{mode:'real',client,features:createDataFeaturePorts(),initialLocation:{page:'create',topic_id:${JSON.stringify(fixture.topic.id)},variant_id:${JSON.stringify(fixture.variant_id)}}}}/>);`;
  const bundle=await build({absWorkingDir:root,stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:out,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});
  const js=bundle.outputFiles!.find(f=>f.path.endsWith('.js'))!.text,css=bundle.outputFiles!.find(f=>f.path.endsWith('.css'))!.text;
  const proxy=createServer(async(req,res)=>{try{const url=req.url??'/';if(url.startsWith('/api/')){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks),forward=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length'].includes(name))forward.set(name,Array.isArray(value)?value.join(','):value);calls.push({method:req.method,url});const response=await fetch(service+url,{method:req.method,headers:forward,body:bytes.length?bytes:undefined});res.statusCode=response.status;for(const [name,value] of response.headers)if(!['transfer-encoding','connection','content-encoding'].includes(name))res.setHeader(name,value);res.end(Buffer.from(await response.arrayBuffer()));return;}if(url.startsWith('/workbench/')){const leaf=url.slice(7);if(!/^[\w./-]+$/.test(leaf)||leaf.includes('..'))throw new Error('bad brand path');res.end(readFileSync(join(root,'apps/web/public/workbench',leaf)));return;}res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script type="module">'+js+'</script></html>');}catch(e){res.statusCode=500;res.end(String(e));}});
  await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));
  const page=await browser.newPage({viewport:{width,height}});page.on('pageerror',e=>errors.push(width+':'+e.message));
  const budgetBefore=readGenerationBudget(app.context.db,app.identity.workspace_id);
  try{
   await page.goto('http://127.0.0.1:'+(proxy.address() as {port:number}).port);await openStudio(page);
   // 1) 生产现状：AGY 可选并显示剩余次数；Codex 额度耗尽禁用
   await page.locator('[data-action="studio-add"]').click();await page.locator('#studio-provider').waitFor();
   assert.deepEqual(await providerOptions(page),[{value:'codex',disabled:true,text:'Codex 生图 · 额度暂不可用'},{value:'agy',disabled:false,text:'AGY 生图 · 剩余 2 次'}]);
   assert.equal(await page.locator('#studio-provider').inputValue(),'agy');assert.equal(/QUOTA_EXHAUSTED|auth_state|executor/.test(await page.locator('#dialog').textContent()??''),false,'主路径不露内部状态码');
   await noOverflow(page);await page.locator('#studio-provider').scrollIntoViewIfNeeded();await shot(page,'dialog-production',width);
   await page.locator('#dialog [data-action="close-dialog"]').last().click();await page.waitForFunction(()=>!(document.querySelector('#dialog') as HTMLDialogElement).open);
   // 2) 设置页：渠道卡、验证连接（AGY 通过 / Codex 额度阻塞），不生图、不动预算
   await page.locator('#settings-nav').dispatchEvent('click');
   const agyCard=page.locator('[data-image-provider="agy"]'),codexCard=page.locator('[data-image-provider="codex"]');await agyCard.waitFor();
   assert.match(await agyCard.textContent()??'',/可用于生图/);assert.match(await agyCard.textContent()??'',/真实生图次数：剩余 2 \/ 共 2 次/);assert.match(await codexCard.textContent()??'',/额度暂不可用/);
   await agyCard.locator('[data-action="cfg-image-verify"]').click();await agyCard.getByText(/连接验证通过 · /).waitFor();
   await codexCard.locator('[data-action="cfg-image-verify"]').click();await codexCard.getByText(/连接验证未通过 · /).waitFor();assert.match(await codexCard.textContent()??'',/Codex 额度暂不可用，额度恢复后再验证/);
   assert.match(await agyCard.locator('.image-provider-states').textContent()??'',/身份已登录连接已连通/);
   await noOverflow(page);await agyCard.scrollIntoViewIfNeeded();await shot(page,'settings-verified',width);
   // 3) AGY 探测明确失败 → 显示原因并在弹窗里禁用
   probe={ok:false,reason:'connection'};await agyCard.locator('[data-action="cfg-image-verify"]').click();await agyCard.getByText(/连接验证未通过 · /).waitFor();
   assert.match(await agyCard.textContent()??'',/连不上 AGY 服务，请检查网络后重试/);assert.match(await agyCard.locator('.image-provider-tags').textContent()??'',/连接验证未通过/);
   await noOverflow(page);await shot(page,'settings-probe-failed',width);
   await page.locator('[data-action="nav"][data-page="create"]').dispatchEvent('click');await openStudio(page);
   await page.locator('[data-action="studio-add"]').click();await page.locator('#studio-provider').waitFor();
   assert.deepEqual(await providerOptions(page),[{value:'codex',disabled:true,text:'Codex 生图 · 额度暂不可用'},{value:'agy',disabled:true,text:'AGY 生图 · 连接验证未通过'}]);
   assert.equal(await page.locator('#studio-submit').isDisabled(),true);await noOverflow(page);await page.locator('#studio-provider').scrollIntoViewIfNeeded();await shot(page,'dialog-blocked',width);
   await page.locator('#dialog [data-action="close-dialog"]').last().click();
   const verifyPosts=calls.filter(c=>c.method==='POST'&&/\/settings\/image-providers\/(agy|codex)\/verify$/.test(c.url)).length;assert.equal(verifyPosts,3);
   assert.equal(probes,2);assert.equal(fixture.image_calls,0,'验证连接不发生真实生图');assert.deepEqual(readGenerationBudget(app.context.db,app.identity.workspace_id),budgetBefore,'预算计数不变');
   assert.equal(calls.some(c=>c.method==='POST'&&/asset-generations|image-studio\/generations/.test(c.url)),false);
   checks.push({width,height,result:'passed',production_dialog:{agy:'selectable · 剩余 2 次',codex:'disabled · 额度暂不可用'},verify_posts:verifyPosts,agy_probes:probes,image_calls:0,budget_unchanged:true});
  }catch(error){await shot(page,'failure',width).catch(()=>{});writeFileSync(join(out,'failure-'+width+'.json'),JSON.stringify({message:String(error),calls,errors},null,2));throw error;}
  finally{await page.evaluate(()=>(window as any).fixture?.unmount()).catch(()=>{});await page.close();await new Promise<void>(done=>proxy.close(()=>done()));await fixture.close();}
 }
 assert.deepEqual(errors,[]);writeFileSync(join(out,'checks.json'),JSON.stringify({task:'IMAGE-PROVIDER-AVAILABILITY',checked_at:new Date().toISOString(),checks,screens,errors,scope:'developer browser integration; Codex executor health and AGY read-only probe injected; no real CLI or image generation'},null,2)+'\n');console.log(JSON.stringify({out,checks:checks.length,screens:screens.length}));
}finally{await browser.close();}
