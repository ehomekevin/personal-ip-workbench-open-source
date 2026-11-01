// 配图工作台日用走查修复浏览器用例：生产 Workbench + 真实服务路由 + 注入式网络 + 假内容执行器/假生图（不发真实调用，不碰日用服务数据）。三视口截图。
// 卡片按钮新布局（生成不在卡片上）→ 上移后左栏不跳顶 → 生成先确认（确认按钮不与触发按钮重叠，确认前不发请求）→ 每张图「从网络找图」与补图中提示
// → 确认配图进行中（转圈 + 禁用 + 文案）→ 失败可见可重试 → 排版确认后回到配图：步骤条写已确认、确认配图先提示后果 → 步骤条三视口不截断。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {chromium,type Page} from '@playwright/test';
import {startPlanFixture} from '../image-studio/plan-fixture.ts';
import {solidPng} from '../helpers/png.ts';
import type {ArticleLayoutView,ImagePlanSnapshot} from '../../packages/contracts/src/index.ts';

const root=resolve(import.meta.dirname,'../..'),out=resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR??join(root,'.ci-artifacts/image-studio-walkthrough'));mkdirSync(out,{recursive:true});
const errors:string[]=[],screens:string[]=[],checks:unknown[]=[];
const LEAK=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|[0-9a-f]{32}|VALIDATION_ERROR|QUOTA_EXHAUSTED|INTERNAL_ERROR|idempotency|job_id|input_hash/i;
async function capture(page:Page,name:string,width:number){await page.waitForTimeout(350);const file=join(out,name+'-'+width+'.png');await page.screenshot({path:file});screens.push(file);}
async function noOverflow(page:Page,label:string){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,label+' 横向溢出');}
async function visibleText(page:Page,selector:string){return page.locator(selector).evaluate((el:HTMLElement)=>el.innerText);}
const apart=(a:{x:number;y:number;width:number;height:number},b:{x:number;y:number;width:number;height:number})=>a.x>=b.x+b.width||a.x+a.width<=b.x||a.y>=b.y+b.height||a.y+a.height<=b.y;
const browser=await chromium.launch({headless:true});
try{
 for(const [width,height] of [[1440,1000],[768,1024],[390,844]] as const){
  const f=await startPlanFixture({image_generation_limits:{codex:0,agy:5}}),app=f.app,service='http://127.0.0.1:'+app.address.port,calls:Array<{method:string;url:string}>=[];
  const headers={'content-type':'application/json','x-workspace-id':app.identity.workspace_id,'x-service-instance-id':app.identity.service_instance_id};
  const api=async<T>(method:string,path:string,body?:unknown)=>{const r=await fetch(service+path,{method,headers:{...headers,'idempotency-key':randomUUID()},...(body!==undefined?{body:JSON.stringify(body)}:{})});const v=await r.json();if(!r.ok)throw new Error(path+' '+r.status+' '+JSON.stringify(v));return v as T;};
  // 代理闸门：确认配图可被拦住（看进行中）或返回一次失败（看重试）；网络候选可强制成「后台补图中」。
  let confirmMode:'pass'|'hold'|'fail'='pass',releaseConfirm:(()=>void)|null=null,forceRefreshing=false;
  const source=`import {createRoot} from 'react-dom/client';import {Workbench} from './apps/web/src/app/Workbench.tsx';
import {createHttpClient} from './apps/web/src/transport/workbench-client.ts';import {createDataFeaturePorts} from './apps/web/src/transport/data-features.ts';
import './apps/web/src/styles/approved.css';import './apps/web/src/styles/configuration.css';import './apps/web/src/styles/skills.css';import './apps/web/src/features/operations/operations.css';import './apps/web/src/styles/generation-progress.css';
const client=createHttpClient(),host=createRoot(document.querySelector('#root'));window.fixture={unmount:()=>host.unmount()};
host.render(<Workbench injection={{mode:'real',client,features:createDataFeaturePorts(),initialLocation:{page:'create',topic_id:${JSON.stringify(f.topic.id)},variant_id:${JSON.stringify(f.variant_id)}}}}/>);`;
  const bundle=await build({absWorkingDir:root,stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:out,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});
  const js=bundle.outputFiles!.find(o=>o.path.endsWith('.js'))!.text,css=bundle.outputFiles!.find(o=>o.path.endsWith('.css'))!.text;
  const proxy=createServer(async(req,res)=>{try{const url=req.url??'/';if(url.startsWith('/api/')){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks),forward=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length'].includes(name))forward.set(name,Array.isArray(value)?value.join(','):value);calls.push({method:req.method??'',url});
     if(url==='/api/v1/image-studio/plan/confirm'&&confirmMode!=='pass'){const mode=confirmMode;await new Promise<void>(r=>{releaseConfirm=r;});if(mode==='fail'||confirmMode==='fail'){res.statusCode=500;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{code:'INTERNAL_ERROR',message:'配图服务暂时忙，请稍后再试',details:{}}}));return;}}
     const response=await fetch(service+url,{method:req.method,headers:forward,body:bytes.length?bytes:undefined});res.statusCode=response.status;for(const [name,value] of response.headers)if(!['transfer-encoding','connection','content-encoding','content-length'].includes(name))res.setHeader(name,value);
     let body=Buffer.from(await response.arrayBuffer());if(forceRefreshing&&url.includes('/web-image-candidates')&&response.ok){const v=JSON.parse(body.toString('utf8'));v.capture={...(v.capture??{}),state:'refreshing'};body=Buffer.from(JSON.stringify(v));}
     res.end(body);return;}
    if(url.startsWith('/workbench/')){const leaf=url.slice(7);if(!/^[\w./-]+$/.test(leaf)||leaf.includes('..'))throw new Error('bad brand path');res.end(readFileSync(join(root,'apps/web/public/workbench',leaf)));return;}
    res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script type="module">'+js+'</script></html>');}catch(e){res.statusCode=500;res.end(String(e));}});
  await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));
  const page=await browser.newPage({viewport:{width,height}});page.on('pageerror',e=>errors.push(width+':'+e.message));
  await page.route(/^https:\/\/(news|pbs|douyin)\.example\//,route=>route.fulfill({status:200,contentType:'image/png',body:solidPng(160,120,[196,202,231])}));
  const posts=(url:string)=>calls.filter(c=>c.method==='POST'&&c.url===url).length;
  const wait=async(fn:()=>boolean|Promise<boolean>,label:string)=>{for(let i=0;i<200;i++){if(await fn())return;await page.waitForTimeout(100);}throw new Error('等待超时：'+label);};
  const openWorkbench=async()=>{await page.locator('[data-action="edit-tab"][data-value="versions"]').click();const wechat=page.locator('[data-action="platform-tab"][data-value="wechat"]');await wechat.waitFor();if(!(await wechat.getAttribute('class'))?.includes('active'))await wechat.click();await page.locator('.studio-workbench-entry [data-action="studio-wb-open"]').click();};
  try{
   // 服务端准备：方案就绪（原文图、帖子图自动选好；封面与流程图待生成）。
   await f.json(await f.run({replan:false}));await f.complete();let plan:ImagePlanSnapshot=await f.plan();const [cover,,,flow]=plan.items;
   await page.goto('http://127.0.0.1:'+(proxy.address() as {port:number}).port);await openWorkbench();
   await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===4,undefined,{timeout:20000});
   // 手动再加 3 张，让左栏够长（1440 下左栏自己滚动）。
   for(let n=5;n<=7;n++){await page.locator('[data-action="studio-wb-add-item"]').click();await page.waitForFunction(c=>document.querySelectorAll('.iwb-card').length===c,n,{timeout:20000});}
   // 1. 卡片按钮：排序一组、跳过/删除一组，卡片上没有「生成」；每张图都有「从网络找图」。
   await page.locator('.iwb-card[data-item="'+flow!.id+'"] .iwb-card-hit').click();await page.locator('.iwb-card.is-focused[data-item="'+flow!.id+'"] .iwb-card-actions').waitFor();
   assert.equal(await page.locator('.iwb-plan [data-action="studio-wb-generate"]').count(),0,'左栏卡片没有生成按钮');
   assert.equal(await page.locator('.iwb-card.is-focused .iwb-card-group[aria-label="调整顺序"] [data-action="studio-wb-move"]').count(),2);assert.equal(await page.locator('.iwb-card.is-focused .iwb-card-group[aria-label="跳过或删除"] [data-action="studio-wb-remove"]').count(),1);
   assert.equal(await page.locator('.iwb-card [data-action="studio-wb-find"]').count(),7,'每张图都有从网络找图');
   assert.equal(await page.locator('#studio-wb-pick-'+flow!.id).getAttribute('aria-label'),'选择 正文图 · 第 4 段「从收集资料到审核的六步流程」批量生成','勾选框可读');
   const nameBefore=await page.locator('.iwb-card[data-item="'+flow!.id+'"] .iwb-card-text b').innerText();
   await page.locator('.iwb-card.is-focused').scrollIntoViewIfNeeded();await noOverflow(page,'cards');await capture(page,'01-card-actions',width);
   // 2. 上移：左栏滚动位置与选中项保持（不跳回顶部），名称不随位置变化。
   const last=page.locator('.iwb-card').last(),lastId=(await last.getAttribute('data-item'))!;await last.locator('.iwb-card-hit').click();await page.locator('.iwb-card.is-focused[data-item="'+lastId+'"] [data-action="studio-wb-move"][data-dir="up"]').waitFor();
   await page.locator('.iwb-card.is-focused [data-action="studio-wb-move"][data-dir="up"]').scrollIntoViewIfNeeded();
   const scrollState=()=>page.evaluate(()=>{const plan=document.querySelector('.iwb-plan') as HTMLElement,own=plan.scrollHeight>plan.clientHeight+4&&getComputedStyle(plan).overflowY==='auto';return {own,plan:plan.scrollTop,win:scrollY};});
   const before=await scrollState();assert.ok(before.own?before.plan>0:before.win>0,'上移前已向下滚动 '+JSON.stringify(before));
   const order=()=>page.evaluate(()=>[...document.querySelectorAll('.iwb-card')].map(c=>(c as HTMLElement).dataset.item));const at0=(await order()).indexOf(lastId);
   await page.locator('.iwb-card.is-focused [data-action="studio-wb-move"][data-dir="up"]').click();await wait(async()=>(await order()).indexOf(lastId)===at0-1,'上移完成');await page.waitForTimeout(300);
   const after=await scrollState();assert.ok(before.own?after.plan>0&&Math.abs(after.plan-before.plan)<160:after.win>0&&Math.abs(after.win-before.win)<160,'排序后不跳回顶部 '+JSON.stringify({before,after}));
   const inView=await page.evaluate(id=>{const card=document.querySelector('.iwb-card[data-item="'+id+'"]')!.getBoundingClientRect(),plan=document.querySelector('.iwb-plan') as HTMLElement,own=plan.scrollHeight>plan.clientHeight+4&&getComputedStyle(plan).overflowY==='auto',box=own?plan.getBoundingClientRect():{top:0,bottom:innerHeight};return card.bottom>box.top&&card.top<box.bottom;},lastId);assert.ok(inView,'选中的那张仍在视口内');
   assert.equal(await page.locator('.iwb-card[data-item="'+flow!.id+'"] .iwb-card-text b').innerText(),nameBefore,'别的图名称不因排序改变');
   await capture(page,'02-after-move',width);
   // 3. 生成先确认：右栏「生成这张」→ 确认框写明渠道/模型/张数；确认前不发请求；确认按钮与触发按钮不重叠。
   await page.locator('.iwb-card[data-item="'+flow!.id+'"] .iwb-card-hit').click();const trigger=page.locator('.iwb-edit [data-action="studio-wb-generate"]');await trigger.scrollIntoViewIfNeeded();const triggerBox=(await trigger.boundingBox())!;
   const beforeGen=posts('/api/v1/image-studio/generations');await trigger.click();await page.locator('#dialog .iwb-gen-confirm').waitFor();
   const goBtn=page.locator('#dialog [data-action="studio-wb-generate-confirm"]');assert.equal(await goBtn.isDisabled(),true,'确认按钮刚出现时不可点（防双击穿透）');
   const dialogText=await visibleText(page,'#dialog');assert.match(dialogText,/生成渠道\s*AGY 生图/);assert.match(dialogText,/生图模型\s*Gemini 3\.1 Flash Image/);assert.match(dialogText,/张数\s*1 张/);assert.match(dialogText,/本渠道剩余\s*5 次/);
   await page.waitForTimeout(500);assert.equal(posts('/api/v1/image-studio/generations'),beforeGen,'确认前不发生图请求');assert.ok(apart((await goBtn.boundingBox())!,triggerBox),'确认按钮不在「生成这张」同一位置');
   await noOverflow(page,'gen-confirm');await capture(page,'03-generate-confirm',width);
   await goBtn.click();await wait(()=>posts('/api/v1/image-studio/generations')===beforeGen+1,'确认后入队');await f.runOnce();
   // 4. 从网络找图：每张图的入口打开右栏「网络找图」；后台补图时卡片与分页都写「正在补充更多图片」。
   forceRefreshing=true;await page.locator('.iwb-card[data-item="'+plan.items[1]!.id+'"] [data-action="studio-wb-find"]').click();
   await page.locator('.iwb-tab[data-tab="sources"][aria-selected="true"]').waitFor();
   // 用「重新读取」以外的方式触发一次候选读取：重开工作台。
   await page.locator('[data-action="studio-wb-close"]').click();await page.locator('.studio-workbench-entry [data-action="studio-wb-open"]').click();await page.locator('.iwb-card-find-note').first().waitFor({timeout:20000});
   await page.locator('.iwb-card[data-item="'+plan.items[1]!.id+'"] [data-action="studio-wb-find"]').click();await page.locator('.iwb-edit .iwb-capture').waitFor();assert.match(await visibleText(page,'.iwb-edit .iwb-capture'),/正在从资讯原文补充更多图片/);assert.match(await visibleText(page,'.iwb-card.is-focused .iwb-card-find-note'),/正在补充更多图片/);
   await page.locator('.iwb-edit').scrollIntoViewIfNeeded();await noOverflow(page,'find');await capture(page,'04-find-refreshing',width);forceRefreshing=false;
   // 5. 确认配图进行中 → 失败可见可重试 → 成功进入排版。先把手动加的图删掉、封面与流程图已生成，配齐。
   plan=await f.plan();for(const item of plan.items.filter(i=>i.role==='manual'))await f.json(await f.update(item.id,{removed:true}));
   plan=await f.plan();const c0=plan.items.find(i=>i.position==='cover')!;
   await api('POST','/api/v1/image-studio/generations',{topic_id:f.topic.id,document_revision_id:plan.studio.document_revision_id,paragraph_id:c0.paragraph_id,placement_paragraph_id:c0.placement_paragraph_id,description:c0.prompt_draft,title:c0.purpose,position:c0.position,provider:'agy',references:[],expected_version:plan.studio.version,slot_id:c0.slot_id,parent_version_id:null,operation:'generate',size_mode:'manual',size:{width:1600,height:900,aspect_ratio:'16:9'},brief_id:null});await f.runOnce();
   await wait(async()=>{await f.runOnce();return (await f.plan()).final.pending===0;},'配图已配齐 '+JSON.stringify((await f.plan()).items.map(i=>i.status)));
   await page.reload();await openWorkbench();const confirmBtn=page.locator('[data-action="studio-wb-confirm"]').first();await page.waitForFunction(()=>!(document.querySelector('[data-action="studio-wb-confirm"]') as HTMLButtonElement|null)?.disabled,undefined,{timeout:20000});
   confirmMode='hold';await page.evaluate(()=>scrollTo(0,0));await confirmBtn.click();await page.locator('.iwb-confirm-layout.is-busy').waitFor();
   assert.equal(await page.locator('.iwb-confirm-layout.is-busy').isDisabled(),true);assert.match(await page.locator('.iwb-confirm-layout.is-busy').innerText(),/正在冻结配图终稿…/);assert.equal(await page.locator('.iwb-confirm-layout.is-busy').getAttribute('aria-busy'),'true');
   await noOverflow(page,'confirm-busy');await capture(page,'05-confirm-busy',width);
   confirmMode='fail';releaseConfirm!();await page.locator('.iwb-confirm-error').waitFor({timeout:20000});assert.match(await visibleText(page,'.iwb-confirm-error'),/配图终稿没有冻结成功：配图服务暂时忙，请稍后再试/);
   await capture(page,'06-confirm-failed',width);
   confirmMode='pass';await page.locator('.iwb-confirm-error [data-action="studio-wb-confirm"]').click();await page.locator('.article-layout-c1').waitFor({timeout:20000});
   // 6. 排版确认（服务端，无阻断项）→ 返回配图：步骤条写「配图 已确认」「排版 已确认」，后续阶段「待上线」；确认配图先提示后果。
   const view=await api<ArticleLayoutView>('GET','/api/v1/article-layout?topic_id='+f.topic.id);await api('POST','/api/v1/article-layout/confirmations',{topic_id:f.topic.id,expected_version:view.snapshot.version});
   await page.reload();await page.locator('.article-layout-c1 .alc-final').waitFor({timeout:20000});await page.locator('.article-layout-c1 .iwb-head-actions .button').filter({hasText:'返回配图'}).click();await page.waitForFunction(()=>/排版\s*已确认/.test((document.querySelector('.iwb-steps') as HTMLElement|null)?.innerText??''),undefined,{timeout:20000});
   const steps=await visibleText(page,'.iwb-steps');assert.match(steps,/配图\s*已确认/);assert.match(steps,/排版\s*已确认/);assert.equal((steps.match(/待上线/g)??[]).length,2);assert.doesNotMatch(steps,/下一版/);
   assert.match(await visibleText(page,'.iwb-head'),/排版已确认，修改配图会让排版需要重新确认/);
   // 三视口步骤条不截断：最后一步在步骤条内，步骤条不需要横向滚动。
   const fit=await page.evaluate(()=>{const nav=document.querySelector('.iwb-steps') as HTMLElement,lastStep=[...nav.querySelectorAll('.iwb-step')].at(-1)!.getBoundingClientRect(),r=nav.getBoundingClientRect();return {inside:lastStep.right<=r.right+1&&lastStep.left>=r.left-1,scrolls:nav.scrollWidth>nav.clientWidth+1};});assert.deepEqual(fit,{inside:true,scrolls:false},'步骤条不截断');
   await page.evaluate(()=>scrollTo(0,0));await noOverflow(page,'layout-confirmed');await capture(page,'07-layout-confirmed-steps',width);
   const beforeConfirm=posts('/api/v1/image-studio/plan/confirm');await page.locator('[data-action="studio-wb-confirm"]').first().click();await page.locator('#dialog').getByText('仍要确认配图').waitFor();
   assert.match(await visibleText(page,'#dialog'),/排版已确认[^]*修改配图会让排版需要重新确认/);assert.equal(posts('/api/v1/image-studio/plan/confirm'),beforeConfirm,'提示前不确认');
   await capture(page,'08-relock-warning',width);await page.locator('#dialog [data-action="close-dialog"]').last().click();
   assert.equal(LEAK.test(await visibleText(page,'.image-workbench')),false,'主路径不露 ID/哈希/错误码');void cover;
   checks.push({width,height,result:'passed',card_has_no_generate:true,scroll_kept_after_move:{before,after},generate_needs_confirm:true,confirm_button_apart:true,find_entry_per_card:7,confirm_busy_and_retry:true,layout_confirmed_steps:true,relock_warning:true,steps_fit:true});
  }catch(error){await capture(page,'failure',width).catch(()=>{});writeFileSync(join(out,'failure-'+width+'.json'),JSON.stringify({message:String(error),stack:(error as Error).stack,calls:calls.map(c=>c.method+' '+c.url),errors},null,2));throw error;}
  finally{releaseConfirm?.();await page.evaluate(()=>(window as any).fixture?.unmount()).catch(()=>{});await page.close();await new Promise<void>(done=>proxy.close(()=>done()));await f.close();}
 }
 assert.deepEqual(errors,[]);writeFileSync(join(out,'checks.json'),JSON.stringify({task:'image-studio e2e walkthrough fixes',checked_at:new Date().toISOString(),checks,screens,errors,scope:'developer browser integration with injected network, fake content executor and fixture image provider; no real model or image calls'},null,2)+'\n');console.log(JSON.stringify({out,checks:checks.length,screens:screens.length}));
}finally{await browser.close();}
