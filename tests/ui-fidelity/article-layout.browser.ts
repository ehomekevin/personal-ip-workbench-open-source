// 公众号排版 C1 浏览器用例：生产 Workbench + 真实服务路由 + 注入式网络 + 假内容执行器/假生图（不发真实调用）。
// 配图工作台「确认配图，进入排版」（未完成时禁用并写明张数）→ 排版页编辑文字/宽度/上移 → 刷新保留 → 返回配图换图再确认 → 重新同步（文字编辑保留）。三视口截图。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {chromium,type Page} from '@playwright/test';
import {startPlanFixture} from '../image-studio/plan-fixture.ts';
import {solidPng} from '../helpers/png.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import type {ArticleLayoutView,StudioWebImageCandidate} from '../../packages/contracts/src/index.ts';

const root=resolve(import.meta.dirname,'../..'),out=resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR??join(root,'.ci-artifacts/article-layout-c1'));mkdirSync(out,{recursive:true});
const errors:string[]=[],screens:string[]=[],checks:unknown[]=[];
// 主路径不露任务/块/资产 ID、哈希、错误码。
const LEAK=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|[0-9a-f]{24}|VALIDATION_ERROR|INPUT_STALE|ARTICLE_LAYOUT|idempotency|job_id|input_hash|text-[0-9a-f]|image-[0-9a-f]|wechat-layout:/i;
async function capture(page:Page,file:string){await page.waitForTimeout(350);await page.screenshot({path:file});screens.push(file);}
async function shot(page:Page,name:string,width:number){await page.evaluate(()=>scrollTo(0,0));await capture(page,join(out,name+'-'+width+'.png'));
 if(width>1180)return;for(const [part,selector] of [['preview','.alc-preview'],['side','.alc-side']] as const){if(!await page.locator(selector).count())continue;await page.evaluate(sel=>{const el=document.querySelector(sel)!;const top=el.getBoundingClientRect().top+scrollY-(document.querySelector('.topbar')?.getBoundingClientRect().height??0)-8;scrollTo(0,top);},selector);await capture(page,join(out,name+'-'+width+'-'+part+'.png'));}}
async function noOverflow(page:Page,label:string){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,label+' 横向溢出');}
async function visibleText(page:Page,selector:string){return page.locator(selector).evaluate((el:HTMLElement)=>el.innerText);}
const browser=await chromium.launch({headless:true});
try{
 for(const [width,height] of [[1440,1000],[768,1024],[390,844]] as const){
  const f=await startPlanFixture(),app=f.app,service='http://127.0.0.1:'+app.address.port,calls:Array<{method:string;url:string}>=[];
  const headers={'content-type':'application/json','x-workspace-id':app.identity.workspace_id,'x-service-instance-id':app.identity.service_instance_id};
  const api=async<T>(method:string,path:string,body?:unknown)=>{const r=await fetch(service+path,{method,headers:{...headers,'idempotency-key':randomUUID()},...(body!==undefined?{body:JSON.stringify(body)}:{})});const v=await r.json();if(!r.ok)throw new Error(path+' '+r.status+' '+JSON.stringify(v));return v as T;};
  // 服务端准备：方案就绪（原文/帖子图自动选好）→ 生成封面 → 只剩流程图没配。
  await f.json(await f.run({replan:false}));await f.complete();let plan=await f.plan();const cover=plan.items[0]!,flow=plan.items[3]!;
  await api('POST','/api/v1/image-studio/generations',{topic_id:f.topic.id,document_revision_id:plan.studio.document_revision_id,paragraph_id:cover.paragraph_id,placement_paragraph_id:cover.placement_paragraph_id,description:cover.prompt_draft,title:cover.purpose,position:cover.position,provider:'agy',references:[],expected_version:plan.studio.version,slot_id:cover.slot_id,parent_version_id:null,operation:'generate',size_mode:'manual',size:{width:1600,height:900,aspect_ratio:'16:9'},brief_id:null});
  await f.runOnce();plan=await f.plan();assert.equal(plan.final.pending,1);
  const documents=new Documents(app.context),docBefore=await documents.get(f.request(),f.document_id);
  const source=`import {createRoot} from 'react-dom/client';import {Workbench} from './apps/web/src/app/Workbench.tsx';
import {createHttpClient} from './apps/web/src/transport/workbench-client.ts';import {createDataFeaturePorts} from './apps/web/src/transport/data-features.ts';
import './apps/web/src/styles/approved.css';import './apps/web/src/styles/configuration.css';import './apps/web/src/styles/skills.css';import './apps/web/src/features/operations/operations.css';import './apps/web/src/styles/generation-progress.css';
const client=createHttpClient(),host=createRoot(document.querySelector('#root'));window.fixture={unmount:()=>host.unmount()};
host.render(<Workbench injection={{mode:'real',client,features:createDataFeaturePorts(),initialLocation:{page:'create',topic_id:${JSON.stringify(f.topic.id)},variant_id:${JSON.stringify(f.variant_id)}}}}/>);`;
  const bundle=await build({absWorkingDir:root,stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:out,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});
  const js=bundle.outputFiles!.find(o=>o.path.endsWith('.js'))!.text,css=bundle.outputFiles!.find(o=>o.path.endsWith('.css'))!.text;
  const proxy=createServer(async(req,res)=>{try{const url=req.url??'/';if(url.startsWith('/api/')){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks),forward=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length'].includes(name))forward.set(name,Array.isArray(value)?value.join(','):value);calls.push({method:req.method??'',url});
     const response=await fetch(service+url,{method:req.method,headers:forward,body:bytes.length?bytes:undefined});res.statusCode=response.status;for(const [name,value] of response.headers)if(!['transfer-encoding','connection','content-encoding'].includes(name))res.setHeader(name,value);res.end(Buffer.from(await response.arrayBuffer()));return;}
    if(url.startsWith('/workbench/')){const leaf=url.slice(7);if(!/^[\w./-]+$/.test(leaf)||leaf.includes('..'))throw new Error('bad brand path');res.end(readFileSync(join(root,'apps/web/public/workbench',leaf)));return;}
    res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script type="module">'+js+'</script></html>');}catch(e){res.statusCode=500;res.end(String(e));}});
  await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));
  const page=await browser.newPage({viewport:{width,height}});page.on('pageerror',e=>errors.push(width+':'+e.message));
  await page.route(/^https:\/\/(news|pbs|douyin)\.example\//,route=>route.fulfill({status:200,contentType:'image/png',body:solidPng(160,120,[196,202,231])}));
  const toCreate=async()=>{await page.locator('[data-action="edit-tab"][data-value="versions"]').click();const wechat=page.locator('[data-action="platform-tab"][data-value="wechat"]');await wechat.waitFor();if(!(await wechat.getAttribute('class'))?.includes('active'))await wechat.click();};
  const layoutNow=()=>api<ArticleLayoutView>('GET','/api/v1/article-layout?topic_id='+f.topic.id);
  const saved=()=>page.waitForFunction(()=>document.querySelector('.alc-save')?.textContent==='已保存',undefined,{timeout:20000});
  try{
   await page.goto('http://127.0.0.1:'+(proxy.address() as {port:number}).port);await toCreate();
   await page.locator('.studio-workbench-entry [data-action="studio-wb-open"]').click();await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===4,undefined,{timeout:20000});
   // 还有 1 张没配：按钮禁用并写明张数。
   const confirmBtn=page.locator('[data-action="studio-wb-confirm"]');assert.equal(await confirmBtn.isDisabled(),true);assert.match(await visibleText(page,'.iwb-head'),/还有 1 张待处理/);
   assert.equal(await page.locator('[data-action="studio-wb-layout"]').count(),0,'没确认过时排版步骤不可点');await noOverflow(page,'pending');await shot(page,'workbench-pending',width);
   // 跳过流程图 → 可以确认 → 进入排版。
   await page.locator('.iwb-card-hit').nth(3).click();await page.locator('.iwb-card.is-focused [data-action="studio-wb-skip"]').click();await page.waitForFunction(()=>!(document.querySelector('[data-action="studio-wb-confirm"]') as HTMLButtonElement)?.disabled,undefined,{timeout:20000});
   await confirmBtn.click();await page.locator('.article-layout-c1 .alc-reader').waitFor({timeout:20000});await page.waitForFunction(()=>document.querySelectorAll('.alc-reader figure img').length===3,undefined,{timeout:20000});
   assert.equal(await page.locator('.image-workbench-host').count(),0,'排版与配图工作台互斥');assert.equal((await page.locator('#toast-region').innerText()).trim(),'','进入排版时清掉配图页的提示');
   assert.equal(await page.locator('.page > :not(.article-layout-host)').evaluateAll(list=>list.filter(n=>(n as HTMLElement).offsetParent!==null).length),0,'排版全宽，其余页面内容收起');
   assert.equal(await page.locator('.alc-steps').evaluate((e:HTMLElement)=>e.scrollWidth<=e.clientWidth+1),true,'步骤条不截断');
   const steps=await visibleText(page,'.alc-steps');for(const label of ['文案定稿','配图','排版','AI 审核','确认提交'])assert.ok(steps.includes(label),label);assert.equal(await page.locator('.alc-steps .iwb-step.is-current').innerText().then(t=>t.includes('排版')),true);
   const main=await visibleText(page,'.article-layout-c1');assert.equal(LEAK.test(main),false,'主路径不露 ID/哈希/块内部 ID：'+main.match(LEAK)?.[0]);
   assert.match(main,/官方配图：发布会现场与关键参数对比 · 图源：Example News/,'网络图图注带图源');assert.ok((await page.locator('.alc-next').count())>=1,'还没开放的能力标出（C2 起版式、图注、检查、完整阅读与确认已开放）');
   const outline=await page.locator('.alc-outline-item b').allInnerTexts();assert.equal(outline[0],'封面');assert.ok(outline.includes('配图 1')&&outline.includes('配图 2'));
   await noOverflow(page,'layout');await shot(page,'layout',width);
   // 编辑：右栏改正文（与预览同步）→ 自动保存。
   await page.locator('.alc-outline-item').filter({hasText:'正文 · 2'}).click();const typed='（排版时补的一句，刷新后还在）';
   const textarea=page.locator('#alc-block-text');const original=await textarea.inputValue();await textarea.fill(original+typed);
   await page.waitForFunction(t=>[...document.querySelectorAll('.alc-reader .al-editable')].some(e=>(e as HTMLElement).innerText.endsWith(t)),typed,{timeout:20000});await textarea.blur();await saved();
   // 预览里直接编辑正文。
   const third=page.locator('.alc-reader .alc-paragraph .al-editable').nth(2);await third.click();await page.keyboard.press('End');await page.keyboard.type('预览里直接补字。');await page.locator('.alc-outline-item').first().click();await saved();
   // 图片宽度 75%、上移一块。
   await page.locator('.alc-outline-item').filter({hasText:'配图 1'}).click();await page.locator('.alc-segment button').filter({hasText:'75%'}).click();await saved();
   await page.locator('.alc-move .button').filter({hasText:'上移'}).click();await saved();
   const afterEdit=(await layoutNow()).snapshot;const fig1=afterEdit.order.map(id=>afterEdit.blocks.find(b=>b.id===id)!).filter(b=>b.kind==='image')[1]!;assert.equal((fig1 as {display_width_percent:number}).display_width_percent,75);
   assert.ok(afterEdit.blocks.some(b=>'text' in b&&b.text.endsWith(typed)),'右栏修改已保存');assert.ok(afterEdit.blocks.some(b=>'text' in b&&b.text.includes('预览里直接补字。')),'预览直接编辑已保存');
   await shot(page,'edited',width);
   // 刷新：回到排版，修改都在。
   // 刷新后若仍停在平台版本页，排版直接回来；否则先回到平台版本页（同一会话记得上次打开的是排版）。
   await page.reload();await page.waitForFunction(()=>!!document.querySelector('.alc-reader')||!!(document.querySelector('[data-action="edit-tab"][data-value="versions"]') as HTMLElement|null)?.offsetParent,undefined,{timeout:20000});
   if(!await page.locator('.alc-reader').count())await page.locator('.alc-reader').waitFor({timeout:3000}).catch(()=>toCreate());await page.locator('.article-layout-c1 .alc-reader').waitFor({timeout:20000});
   await page.waitForFunction(t=>[...document.querySelectorAll('.alc-reader .al-editable')].some(e=>(e as HTMLElement).innerText.endsWith(t)),typed,{timeout:20000});
   assert.equal(await page.locator('.alc-reader figure').nth(1).evaluate((e:HTMLElement)=>e.style.width),'75%','刷新后图片宽度保留');assert.equal(await page.locator('.alc-save').innerText(),'已保存');
   await noOverflow(page,'reloaded');await shot(page,'reloaded',width);
   const docAfter=await documents.get(f.request(),f.document_id);assert.equal(docAfter.head_revision_id,docBefore.head_revision_id,'平台稿修订不变');assert.equal(docAfter.text,docBefore.text);
   // 版本记录（最多 40 个）。
   await page.locator('.article-layout-c1 .button').filter({hasText:'版本记录'}).click();await page.locator('.alc-dialog[open] .alc-versions li').first().waitFor();const rows=await page.locator('.alc-versions li').count();assert.ok(rows>=4&&rows<=40);assert.equal(LEAK.test(await visibleText(page,'.alc-dialog[open]')),false);
   await shot(page,'versions',width);await page.locator('.alc-dialog[open] .button').filter({hasText:'关闭'}).click();
   // 返回配图 → 换原文图 → 再确认 → 排版提示重新同步 → 同步后图片更新、文字编辑保留。
   await page.locator('.article-layout-c1 .iwb-head-actions .button').filter({hasText:'返回配图'}).click();await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===4,undefined,{timeout:20000});
   assert.equal(await page.locator('[data-action="studio-wb-layout"]').count(),1,'确认过后步骤条「排版」可点');
   plan=await f.plan();const article=plan.items[1]!;const candidates=(await api<{candidates:StudioWebImageCandidate[]}>('GET','/api/v1/topics/'+f.topic.id+'/web-image-candidates')).candidates,other=candidates.find(c=>c.image_url.endsWith('/tw.png'))!;
   const swapped=await api<{version_id:string}>('POST','/api/v1/image-studio/web-imports',{topic_id:f.topic.id,expected_version:plan.studio.version,slot_id:article.slot_id,candidate:{candidate_id:other.candidate_id,image_url:other.image_url}});
   await page.evaluate(()=>(document.querySelector('[data-action="studio-wb-layout"]') as HTMLElement).click());
   await page.locator('.article-layout-c1 .iwb-banner').filter({hasText:'配图在确认后又改过'}).waitFor({timeout:20000});await shot(page,'plan-changed',width);
   await page.locator('.article-layout-c1 .iwb-banner .button').filter({hasText:'返回配图'}).click();await page.waitForFunction(()=>!(document.querySelector('[data-action="studio-wb-confirm"]') as HTMLButtonElement)?.disabled,undefined,{timeout:20000});
   await page.locator('[data-action="studio-wb-confirm"]').click();await page.locator('.article-layout-c1 .iwb-banner').filter({hasText:'配图已更新'}).waitFor({timeout:20000});
   await noOverflow(page,'resync');await shot(page,'resync-needed',width);
   await page.locator('.article-layout-c1 .iwb-banner .button').filter({hasText:'重新同步配图'}).click();await page.waitForFunction(()=>!document.querySelector('.article-layout-c1 .iwb-banner'),undefined,{timeout:20000});
   const synced=(await layoutNow()).snapshot;assert.ok(synced.blocks.some(b=>b.kind==='image'&&b.image.version_id===swapped.version_id),'图片块换成新确认的那版');assert.ok(synced.blocks.some(b=>'text' in b&&b.text.endsWith(typed)),'文字编辑保留');assert.ok(synced.blocks.some(b=>b.kind==='image'&&b.display_width_percent===75),'图片宽度 75% 保留');assert.deepEqual(synced.order,(await layoutNow()).snapshot.order);
   await page.waitForFunction(t=>[...document.querySelectorAll('.alc-reader .al-editable')].some(e=>(e as HTMLElement).innerText.endsWith(t)),typed,{timeout:20000});await page.waitForFunction(()=>document.querySelectorAll('.alc-reader figure img').length===3,undefined,{timeout:20000});
   await shot(page,'resynced',width);
   checks.push({width,height,result:'passed',confirm_disabled_with_count:true,layout_images:3,edits_saved:['sidebar_text','preview_text','width_75','move_up'],reload_kept:true,platform_revision_unchanged:true,versions_listed:rows,resync_kept_text:true});
  }catch(error){await shot(page,'failure',width).catch(()=>{});writeFileSync(join(out,'failure-'+width+'.json'),JSON.stringify({message:String(error),stack:(error as Error).stack,calls,errors},null,2));throw error;}
  finally{await page.evaluate(()=>(window as any).fixture?.unmount()).catch(()=>{});await page.close();await new Promise<void>(done=>proxy.close(()=>done()));await f.close();}
 }
 assert.deepEqual(errors,[]);writeFileSync(join(out,'checks.json'),JSON.stringify({task:'WECHAT-LAYOUT-STUDIO-C1',checked_at:new Date().toISOString(),checks,screens,errors,scope:'developer browser integration with injected network, fake content executor and fixture image provider; no real model or image calls'},null,2)+'\n');console.log(JSON.stringify({out,checks:checks.length,screens:screens.length}));
}finally{await browser.close();}
