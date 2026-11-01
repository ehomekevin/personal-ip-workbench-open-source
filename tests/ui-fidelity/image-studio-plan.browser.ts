// 配图工作台（A2）浏览器用例：生产 Workbench + 真实服务路由 + 注入式网络 + 假内容执行器/假生图（不发真实调用），三视口截图。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium,type Page} from '@playwright/test';
import {startPlanFixture} from '../image-studio/plan-fixture.ts';
import {solidPng} from '../helpers/png.ts';
import type {ImagePlanSnapshot} from '../../packages/contracts/src/index.ts';

const root=resolve(import.meta.dirname,'../..'),out=resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR??join(root,'.ci-artifacts/image-studio-a2'));mkdirSync(out,{recursive:true});
const selectorsOut=resolve(process.env.WORKBENCH_SELECTOR_EVIDENCE_DIR??join(root,'.ci-artifacts/image-studio-selectors'));mkdirSync(selectorsOut,{recursive:true});
const errors:string[]=[],screens:string[]=[],checks:unknown[]=[];
// 选择控件截图：按区域裁切（左栏顶部规划控件 + 生成全部、右栏生成渠道、确认框），先滚到可见再截。
async function region(page:Page,name:string,width:number,from:string,to:string){const box=await page.evaluate(([a,b])=>{const x=document.querySelector(a)!,y=document.querySelector(b)!;x.scrollIntoView({block:'center'});const r1=x.getBoundingClientRect(),r2=y.getBoundingClientRect(),left=Math.min(r1.left,r2.left),right=Math.max(r1.right,r2.right),top=Math.min(r1.top,r2.top),bottom=Math.max(r1.bottom,r2.bottom);return {x:Math.max(0,left-8),y:Math.max(0,top-8),width:Math.min(innerWidth,right+8)-Math.max(0,left-8),height:Math.min(innerHeight,bottom+8)-Math.max(0,top-8)};},[from,to] as const);
 await page.waitForTimeout(200);const file=join(selectorsOut,name+'-'+width+'.png');await page.screenshot({path:file,clip:box});screens.push(file);}
const LEAK=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|[0-9a-f]{32}|VALIDATION_ERROR|QUOTA_EXHAUSTED|idempotency|job_id|input_hash/i;
// 视口截图（不用 fullPage，避免固定导航叠在内容上）：1440 一屏看全；768/390 再按画布、右栏分段各截一张。
async function capture(page:Page,file:string){await page.waitForTimeout(350);await page.screenshot({path:file});screens.push(file);}
async function shot(page:Page,name:string,width:number,segments=true){await page.evaluate(()=>scrollTo(0,0));await capture(page,join(out,name+'-'+width+'.png'));
 if(!segments||width>1180)return;for(const [part,selector] of [['canvas','.iwb-canvas-col'],['edit','.iwb-edit']] as const){if(!await page.locator(selector).count())continue;await page.evaluate(sel=>{const el=document.querySelector(sel)!;const top=el.getBoundingClientRect().top+scrollY-(document.querySelector('.topbar')?.getBoundingClientRect().height??0)-8;scrollTo(0,top);},selector);await capture(page,join(out,name+'-'+width+'-'+part+'.png'));}}
async function noOverflow(page:Page,label:string){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,label+' 横向溢出');}
async function visibleText(page:Page,selector:string){return page.locator(selector).evaluate((el:HTMLElement)=>el.innerText);}
const browser=await chromium.launch({headless:true});
try{
 for(const [width,height] of [[1440,1000],[768,1024],[390,844]] as const){
  const f=await startPlanFixture({image_generation_limits:{codex:0,agy:1}}),app=f.app;
  // 生产现状：设置默认生图渠道是 Codex，但 Codex 生图剩 0、AGY 剩 1 → 工作台默认应退到 AGY。
  const {ImageProviderSettings}=await import('../../packages/domain/src/settings/image-providers.ts');const saved=await new ImageProviderSettings(app.context).read(f.request());await new ImageProviderSettings(app.context).save(f.request(),{expected_version:saved.version,default_provider:'codex',enabled:{agy:true,codex:true}});
  const service='http://127.0.0.1:'+app.address.port,calls:Array<{method:string;url:string;key:unknown}>=[];
  let holdRuns:(()=>void)|null=null;const runsGate=new Promise<void>(r=>{holdRuns=r;});
  const source=`import {createRoot} from 'react-dom/client';import {Workbench} from './apps/web/src/app/Workbench.tsx';
import {createHttpClient} from './apps/web/src/transport/workbench-client.ts';import {createDataFeaturePorts} from './apps/web/src/transport/data-features.ts';
import './apps/web/src/styles/approved.css';import './apps/web/src/styles/configuration.css';import './apps/web/src/styles/skills.css';import './apps/web/src/features/operations/operations.css';import './apps/web/src/styles/generation-progress.css';
const client=createHttpClient(),host=createRoot(document.querySelector('#root'));window.fixture={unmount:()=>host.unmount()};
host.render(<Workbench injection={{mode:'real',client,features:createDataFeaturePorts(),initialLocation:{page:'create',topic_id:${JSON.stringify(f.topic.id)},variant_id:${JSON.stringify(f.variant_id)}}}}/>);`;
  const bundle=await build({absWorkingDir:root,stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:out,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});
  const js=bundle.outputFiles!.find(o=>o.path.endsWith('.js'))!.text,css=bundle.outputFiles!.find(o=>o.path.endsWith('.css'))!.text;
  const proxy=createServer(async(req,res)=>{try{const url=req.url??'/';if(url.startsWith('/api/')){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks),forward=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length'].includes(name))forward.set(name,Array.isArray(value)?value.join(','):value);calls.push({method:req.method??'',url,key:req.headers['idempotency-key']??null});
     if(url==='/api/v1/image-studio/plan/runs')await runsGate;
     const response=await fetch(service+url,{method:req.method,headers:forward,body:bytes.length?bytes:undefined});res.statusCode=response.status;for(const [name,value] of response.headers)if(!['transfer-encoding','connection','content-encoding'].includes(name))res.setHeader(name,value);res.end(Buffer.from(await response.arrayBuffer()));return;}
    if(url.startsWith('/workbench/')){const leaf=url.slice(7);if(!/^[\w./-]+$/.test(leaf)||leaf.includes('..'))throw new Error('bad brand path');res.end(readFileSync(join(root,'apps/web/public/workbench',leaf)));return;}
    res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script type="module">'+js+'</script></html>');}catch(e){res.statusCode=500;res.end(String(e));}});
  await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));
  const page=await browser.newPage({viewport:{width,height}});page.on('pageerror',e=>errors.push(width+':'+e.message));
  await page.route(/^https:\/\/(news|pbs|douyin)\.example\//,route=>route.fulfill({status:200,contentType:'image/png',body:solidPng(160,120,[196,202,231])}));
  const planNow=async()=>(await (await fetch(service+'/api/v1/image-studio/plan?topic_id='+f.topic.id,{headers:{'x-workspace-id':app.identity.workspace_id,'x-service-instance-id':app.identity.service_instance_id}})).json()) as ImagePlanSnapshot;
  try{
   await page.goto('http://127.0.0.1:'+(proxy.address() as {port:number}).port);
   await page.locator('[data-action="edit-tab"][data-value="versions"]').click();const wechat=page.locator('[data-action="platform-tab"][data-value="wechat"]');await wechat.waitFor();if(!(await wechat.getAttribute('class'))?.includes('active'))await wechat.click();
   await page.locator('.studio-workbench-entry [data-action="studio-wb-open"]').waitFor();assert.equal(await page.locator('.studio-legacy-toggle').getAttribute('aria-expanded'),'false','旧版逐张面板默认折叠');assert.equal(await page.locator('.image-studio-panel .image-panel-heading').count(),0);await page.locator('.studio-workbench-entry [data-action="studio-wb-open"]').click();
   // 空方案：自动规划请求被拦住时，工作台显示「还没有配图方案」与步骤条。
   await page.locator('.image-workbench .iwb-note').filter({hasText:'还没有配图方案'}).waitFor();
   assert.equal(await page.locator('.page > :not(.image-workbench-host)').evaluateAll(list=>list.filter(n=>(n as HTMLElement).offsetParent!==null).length),0,'工作台全宽，其余页面内容收起');
   const steps=await visibleText(page,'.iwb-steps');for(const label of ['文案定稿','配图','排版','AI 审核','确认并提交草稿'])assert.ok(steps.includes(label),label);assert.equal(await page.locator('.iwb-step.is-next[aria-disabled="true"]').count(),3);
   assert.equal(await page.locator('.iwb-tool:not([disabled])').count(),0,'标注工具禁用');await noOverflow(page,'empty');assert.match(await visibleText(page,'.iwb-head'),/方案出来后才能预览完整文章/);await shot(page,'empty',width);
   holdRuns!();
   // 规划中：任务排队时显示进度球体与骨架，不露任务 ID。
   await page.locator('.iwb-progress-slot .generation-progress').waitFor();assert.equal(f.planJobs().length,1,'进入工作台自动规划一次');await noOverflow(page,'planning');
   assert.equal(LEAK.test(await visibleText(page,'.image-workbench')),false,'规划中不露内部标识');await shot(page,'planning',width);
   assert.equal((await f.complete())!.state,'committed');
   // 方案就绪：四项，原文/帖子图已自动选好（AI 选中，可换），AI 项待生成。
   await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===4&&document.querySelectorAll('.iwb-card img.iwb-thumb').length>=2,undefined,{timeout:20000});
   const chips=await page.locator('.iwb-card .iwb-chip').allInnerTexts();assert.deepEqual(chips,['待生成','AI 选中，可换','AI 选中，可换','待生成']);
   const stageHead=await visibleText(page,'.iwb-editor-head');assert.match(stageHead,/文章封面/,'中栏是单图舞台：当前选中图');assert.equal(await page.locator('.iwb-stage-col .iwb-article').count(),0,'整篇文章收进预览弹窗');
   assert.equal(LEAK.test(await visibleText(page,'.image-workbench')),false,'主路径不露 ID/哈希/幂等键');assert.equal(await page.locator('#studio-wb-request').isDisabled(),true,'没有图时修改要求可见但禁用并说明原因');assert.match(await visibleText(page,'.iwb-edit'),/先生成第一版/);assert.match(await visibleText(page,'.iwb-stage-col'),/还没有版本/);
   assert.equal(await page.locator('.iwb-next-tag').count(),0,'标注工具、只改标注区域与上传不再标下一版');assert.equal(await page.locator('.iwb-tool[data-tool="rect"]').isDisabled(),true,'没有图时标注工具不可用');
   if(width>1180){const fit=await page.evaluate(()=>{const g=document.querySelector('.iwb-grid')!.getBoundingClientRect();return g.bottom<=innerHeight+1&&[...document.querySelectorAll('.iwb-plan,.iwb-canvas-col,.iwb-edit')].every(c=>Math.abs(c.getBoundingClientRect().height-g.height)<2);});assert.ok(fit,'1440 三栏等高、一屏可见');}
   await noOverflow(page,'ready');await shot(page,'ready',width);
   // 选择控件：规划执行器带标签、与「重新规划」同一行且不重叠；生图渠道默认退到有余量的 AGY；工作台任何选项都不写「未经真实验收」。
   const layout=await page.evaluate(()=>{const p=document.querySelector('.iwb-planner')!.getBoundingClientRect(),b=document.querySelector('.iwb-plan-tools [data-action="studio-wb-replan"]')!.getBoundingClientRect(),g=document.querySelector('.iwb-generate-all')!.getBoundingClientRect();return {label:document.querySelector('.iwb-planner-label')?.textContent,overlap:!(p.right<=b.left||b.right<=p.left||p.bottom<=b.top||b.bottom<=p.top),sameRow:p.bottom>b.top&&b.bottom>p.top&&p.right<=b.left+1,aboveAll:p.bottom<=g.top&&b.bottom<=g.top};});
   assert.deepEqual(layout,{label:'AI 规划用',overlap:false,sameRow:true,aboveAll:true},'规划控件有标签、在按钮左侧同一行、不压住「生成全部」');
   assert.equal(await page.locator('.iwb-planner input[type="radio"]').count(),2);assert.equal(await page.locator('#studio-wb-executor').count(),0,'不再是原生下拉');
   assert.equal(/未经真实验收/.test(await page.locator('.image-workbench').innerHTML()),false,'工作台选项文案不含「未经真实验收」');
   assert.match(await visibleText(page,'.iwb-generate-all'),/^批量生成（已选 2 张）$/);assert.equal(await visibleText(page,'.iwb-budget-line'),'生图剩余：AGY 1 次 · Codex 生图 0 次（已用完，可在设置放开）');
   assert.equal(await page.locator('#studio-wb-provider').inputValue(),'agy','默认 Codex 生图已用完 → 右栏默认 AGY 生图');assert.deepEqual(await page.locator('#studio-wb-provider option').allInnerTexts(),['Codex 生图 · 次数已用完','AGY 生图 · 剩余 1 次']);
   assert.equal(await page.locator('.iwb-edit [data-action="studio-wb-generate"]').isDisabled(),false,'AGY 有余量，生成按钮可用');
   await region(page,'ready-left-top',width,'.iwb-plan .iwb-col-head','.iwb-budget-line');await region(page,'right-channel',width,'.iwb-edit .iwb-focus-title','label[for="studio-wb-aspect"]');await page.evaluate(()=>scrollTo(0,0));
   // 改图注即时反映到画布。
   const caption=page.locator('.iwb-card.is-focused input[id^="studio-wb-caption-"]');await caption.fill('封面：一篇文章在工作台里从资讯走到成稿');await caption.press('Tab');
   await page.locator('.iwb-focus-title').filter({hasText:'封面：一篇文章在工作台里从资讯走到成稿'}).waitFor();
   // 生成全部：确认框写清剩余额度；AGY 只剩 1 次，第 2 张标额度不足不入队。
   await page.locator('[data-action="studio-wb-generate-all"]').click();await page.locator('.iwb-confirm').waitFor();const confirm=await visibleText(page,'#dialog');
   assert.match(confirm,/生图剩余：AGY 1 次 · Codex 生图 0 次/);assert.equal(await page.locator('#studio-wb-all-provider').inputValue(),'agy','确认框默认 AGY 生图');assert.equal(/未经真实验收/.test(confirm),false);assert.match(confirm,/1 张超出本渠道剩余额度/);assert.equal(await page.locator('.iwb-confirm-list li.is-blocked').count(),1);assert.equal(LEAK.test(confirm),false);
   await noOverflow(page,'confirm');await shot(page,'confirm',width,false);{const file=join(selectorsOut,'confirm-'+width+'.png');await page.locator('#dialog').screenshot({path:file});screens.push(file);}
   const before=calls.filter(c=>c.method==='POST'&&c.url==='/api/v1/image-studio/generations').length;await page.locator('[data-action="studio-wb-generate-all-confirm"]').click();
   await page.waitForFunction(()=>!(document.querySelector('#dialog') as HTMLDialogElement).open);assert.equal(calls.filter(c=>c.method==='POST'&&c.url==='/api/v1/image-studio/generations').length-before,1,'超额项不入队');
   await page.locator('.iwb-card .iwb-chip').filter({hasText:'额度不足'}).waitFor();
   await f.runOnce();await page.waitForFunction(()=>document.querySelector('.iwb-card img.iwb-thumb')&&document.querySelectorAll('.iwb-card img.iwb-thumb').length>=3,undefined,{timeout:20000});
   const partial=await page.locator('.iwb-card .iwb-chip').allInnerTexts();assert.equal(partial.filter(t=>t==='已配'||t==='AI 选中，可换').length,3);assert.ok(partial.includes('额度不足'));
   await noOverflow(page,'partial');await shot(page,'partial',width);
   // 右栏：聚焦原文配图，换来源后版本 +1，旧版可回退；修改要求快捷短语。
   await page.locator('.iwb-card-hit').nth(1).click();await page.locator('[data-action="studio-wb-tab"][data-tab="sources"]').click();await page.locator('.iwb-edit .iwb-candidate').first().waitFor();
   assert.equal(await page.locator('.iwb-version').count(),1);await page.locator('.iwb-candidate').filter({hasText:'图源：Example News'}).locator('[data-action="studio-wb-swap"]:not([disabled])').first().click();
   await page.waitForFunction(()=>document.querySelectorAll('.iwb-version').length===2,undefined,{timeout:20000});assert.match(await visibleText(page,'.iwb-version.is-selected'),/v2/);
   await page.locator('[data-action="studio-wb-tab"][data-tab="modify"]').click();await page.locator('[data-action="studio-wb-chip"][data-chip="space"]').click();assert.match(await page.locator('#studio-wb-request').inputValue(),/增加留白/);assert.equal(await page.locator('.iwb-chip-btn[disabled]').filter({hasText:'只改标注区域'}).count(),1);
   await page.locator('[data-action="studio-wb-tab"][data-tab="sources"]').click();const strip=await page.locator('.iwb-candidates').evaluate((e:HTMLElement)=>getComputedStyle(e).display==='flex'&&getComputedStyle(e).overflowX==='auto');assert.ok(strip,'换来源为横向缩略条');await noOverflow(page,'edit');await shot(page,'edit',width);
   await page.locator('.iwb-version').first().click();await page.locator('[data-action="studio-wb-adopt"]').click();await page.waitForFunction(()=>/v1/.test(document.querySelector('.iwb-version.is-selected')?.textContent??'')&&!document.querySelector('[data-action="studio-wb-adopt"]'),undefined,{timeout:20000});
   const state=await planNow(),article=state.items[1]!;assert.equal(article.current_version!.index,1);assert.equal(state.studio.slots.find(s=>s.id===article.slot_id)!.versions.length,2);
   // 跳过后不排进文章（完整预览里不再出现）；完整预览可打开。
   const skippedCaption=await page.locator('.iwb-card.is-focused input[id^="studio-wb-caption-"]').inputValue();await page.locator('.iwb-card.is-focused [data-action="studio-wb-skip"]').click();await page.locator('.iwb-card.is-skipped').waitFor({timeout:20000});
   await page.locator('[data-action="studio-wb-preview"]').click();await page.locator('#dialog .iwb-preview').waitFor();assert.equal((await visibleText(page,'#dialog .iwb-preview')).includes(skippedCaption),false,'跳过的图不在完整文章里');await page.locator('#dialog [data-action="close-dialog"]').last().click();
   assert.deepEqual(await (async()=>{const b=await planNow();return b.budget.agy;})(),{used:1,limit:1,remaining:0});assert.equal(f.planJobs().length,1);
   checks.push({width,height,result:'passed',plan_jobs:1,auto_selected:2,generate_all_queued:1,quota_blocked:1,swap_versions:2,rollback:true});
  }catch(error){await shot(page,'failure',width).catch(()=>{});writeFileSync(join(out,'failure-'+width+'.json'),JSON.stringify({message:String(error),stack:(error as Error).stack,calls,errors},null,2));throw error;}
  finally{holdRuns?.();await page.evaluate(()=>(window as any).fixture?.unmount()).catch(()=>{});await page.close();await new Promise<void>(done=>proxy.close(()=>done()));await f.close();}
 }
 assert.deepEqual(errors,[]);writeFileSync(join(out,'checks.json'),JSON.stringify({task:'WECHAT-IMAGE-STUDIO-A2',checked_at:new Date().toISOString(),checks,screens,errors,scope:'developer browser integration with injected network, fake content executor and fixture image provider; no real model or image calls'},null,2)+'\n');console.log(JSON.stringify({out,checks:checks.length,screens:screens.length}));
}finally{await browser.close();}
