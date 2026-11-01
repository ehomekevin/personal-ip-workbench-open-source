// 公众号排版 C2 浏览器用例：生产 Workbench + 真实服务路由 + 注入式网络 + 假内容执行器/假生图（不发真实调用，不碰日用服务数据）。
// 长文章进入排版 → 版式面板（预览生效、自动保存）→ 图注编辑与图源显式去掉/加回 → 阻断项禁用确认、15 条检查逐条定位 → 版式回退 → 完整阅读 → 确认排版、刷新保持 → 解锁再改确认失效。三视口截图。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {chromium,type Page} from '@playwright/test';
import {startPlanFixture,PLAN_ARTICLE} from '../image-studio/plan-fixture.ts';

import {solidPng} from '../helpers/png.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import type {ArticleLayoutView,StudioWebImageCandidate} from '../../packages/contracts/src/index.ts';

const root=resolve(import.meta.dirname,'../..'),out=resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR??join(root,'.ci-artifacts/article-layout-c2'));mkdirSync(out,{recursive:true});
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
// 长文章：原 8 段之后再加 3 个小节、6 段正文和「我的看法」。
const LONG_ARTICLE=PLAN_ARTICLE+'\n\n'+[
 '## 为什么要把排版也放进工作台','以前排版要把稿子复制到第三方编辑器，再一张张上传图片、调字号和行距，改一处就得重新检查一遍。放进工作台以后，配图确认完直接进入排版，图片、图注和图源都已经就位，人只需要看手机预览里读起来顺不顺。',
 '排版不是装饰，而是决定读者能不能读完的关键一步。字号太小、行距太紧、段落太长，读者在手机上滑两屏就会放弃；图片挤在一起或者和正文对不上，也会打断阅读节奏。所以我给排版定了一套检查，把这些常见问题提前找出来。',
 '## 检查做什么','检查只看排版本身：标题是不是太长、开头有没有封面图、每张图有没有图注、网络图有没有标图源、有没有空段落和超长段落、图片是不是太密、正文里有没有点不开的外链、字数是否合适，以及字号、行距和颜色是否容易阅读。每一条都能定位到具体的段落或图片。',
 '检查不打文案分，也不替我改稿。它只告诉我哪里可能影响阅读，哪些是必须先改的阻断项，哪些只是提醒。阻断项没改完之前不能确认排版，这样交给下一步审核的稿子至少在排版上是完整的。',
 '## 确认之后','确认排版会把当前的文字、版式和图片冻结成排版终稿。之后如果还想改，可以重新打开修改，但改完要再确认一次，避免确认过的版本和实际要发的版本对不上。下一步会接上 AI 审核和提交草稿。',
 '## 我的看法','工具的价值不在于替人做决定，而在于把重复的、容易出错的环节变得可检查、可回退。排版检查和确认这一步看起来很小，但它让我在发文前多了一道可靠的关口，也让每一次修改都有据可查。'
].join('\n\n');
 for(const [width,height] of [[1440,1000],[768,1024],[390,844]] as const){
  const f=await startPlanFixture(),app=f.app,service='http://127.0.0.1:'+app.address.port,calls:Array<{method:string;url:string}>=[];
  const headers={'content-type':'application/json','x-workspace-id':app.identity.workspace_id,'x-service-instance-id':app.identity.service_instance_id};
  const api=async<T>(method:string,path:string,body?:unknown)=>{const r=await fetch(service+path,{method,headers:{...headers,'idempotency-key':randomUUID()},...(body!==undefined?{body:JSON.stringify(body)}:{})});const v=await r.json();if(!r.ok)throw new Error(path+' '+r.status+' '+JSON.stringify(v));return v as T;};
  // 服务端准备：长文章（原 8 段 + 3 个小节、更多正文和「我的看法」）→ 方案就绪 → 生成封面 → 跳过流程图 → 确认配图。
  const documents=new Documents(app.context);await documents.save(f.request(),f.document_id,{expected_revision_id:f.article_revision_id,text:LONG_ARTICLE,origin:'human'});
  await f.json(await f.run({replan:false}));await f.complete();let plan=await f.plan();const cover=plan.items[0]!;
  await api('POST','/api/v1/image-studio/generations',{topic_id:f.topic.id,document_revision_id:plan.studio.document_revision_id,paragraph_id:cover.paragraph_id,placement_paragraph_id:cover.placement_paragraph_id,description:cover.prompt_draft,title:cover.purpose,position:cover.position,provider:'agy',references:[],expected_version:plan.studio.version,slot_id:cover.slot_id,parent_version_id:null,operation:'generate',size_mode:'manual',size:{width:1600,height:900,aspect_ratio:'16:9'},brief_id:null});
  await f.runOnce();plan=await f.json(await f.update(plan.items[3]!.id,{skipped:true}));await api('POST','/api/v1/image-studio/plan/confirm',{topic_id:f.topic.id,expected_version:plan.version});
  const docBefore=await documents.get(f.request(),f.document_id);
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
  const external:string[]=[];page.on('request',r=>{const u=new URL(r.url());if(!['127.0.0.1','localhost'].includes(u.hostname)&&!['data:','blob:'].includes(u.protocol))external.push(r.url());});
  const fontSize=()=>page.locator('.alc-preview .alc-reader .alc-paragraph .al-editable').first().evaluate((e:HTMLElement)=>getComputedStyle(e).fontSize);
  const tab=async(name:string)=>{await page.locator('.alc-tabs [role="tab"]').filter({hasText:name}).click();};
  try{
   await page.goto('http://127.0.0.1:'+(proxy.address() as {port:number}).port);await toCreate();
   await page.locator('.studio-workbench-entry [data-action="studio-wb-open"]').click();await page.locator('[data-action="studio-wb-layout"]').waitFor({timeout:20000});
   await page.evaluate(()=>(document.querySelector('[data-action="studio-wb-layout"]') as HTMLElement).click());
   await page.locator('.article-layout-c1 .alc-reader').waitFor({timeout:20000});await page.waitForFunction(()=>document.querySelectorAll('.alc-preview .alc-reader figure img').length===3,undefined,{timeout:20000});
   const main=await visibleText(page,'.article-layout-c1');assert.equal(LEAK.test(main),false,'主路径不露 ID/哈希/内部码：'+main.match(LEAK)?.[0]);
   assert.match(main,/官方配图：发布会现场与关键参数对比 · 图源：Example News（news\.example）/,'网络图默认图注带来源名与链接');
   assert.equal(await page.locator('.alc-steps').evaluate((e:HTMLElement)=>e.scrollWidth<=e.clientWidth+1),true,'步骤条不截断');
   await noOverflow(page,'layout');await shot(page,'01-layout',width);await page.screenshot({path:join(out,'01-layout-long-'+width+'.png'),fullPage:true});screens.push(join(out,'01-layout-long-'+width+'.png'));
   // 1 版式面板：正文 17px、行距 2.0、主题色暖橙 → 预览立即生效并自动保存为排版版本。
   assert.equal(await fontSize(),'15px');
   await page.selectOption('#alc-style-body_size','17');await page.selectOption('#alc-style-body_line_height','2');await page.locator('.alc-swatch[aria-label="暖橙"]').click();await saved();
   assert.equal(await fontSize(),'17px','版式作用于手机预览');assert.equal(await page.locator('.alc-preview .alc-reader').evaluate((e:HTMLElement)=>e.style.getPropertyValue('--alc-accent')),'#ffd59a');
   let now=(await layoutNow()).snapshot;assert.equal(now.style.body_size,17);assert.equal(now.layout_history.at(-1)!.reason,'style');
   await page.locator('#alc-style-section').scrollIntoViewIfNeeded();await capture(page,join(out,'02-style-panel-'+width+'.png'));
   // 2 图注：改网络图说明，图源保留；去掉图源要两步显式确认；可以加回。
   await page.locator('.alc-outline-item').filter({hasText:'配图 1'}).click();const captionBox=page.locator('#alc-caption');assert.equal(await captionBox.inputValue(),'官方配图：发布会现场与关键参数对比','输入框只放说明，图源单独显示');
   await captionBox.fill('发布会现场与参数对比');await captionBox.blur();await saved();
   await page.waitForFunction(()=>[...document.querySelectorAll('.alc-preview figcaption')].some(e=>(e as HTMLElement).innerText==='发布会现场与参数对比 · 图源：Example News（news.example）'),undefined,{timeout:20000});
   await captionBox.fill('');await captionBox.blur();await saved();now=(await layoutNow()).snapshot;assert.ok(now.blocks.some(b=>b.kind==='image'&&b.caption==='图源：Example News（news.example）'),'清空说明也删不掉图源');
   await captionBox.fill('发布会现场与参数对比');await captionBox.blur();await saved();
   await page.locator('.alc-credit-box .button').filter({hasText:'去掉图源'}).click();await page.locator('.alc-confirm-row').waitFor();await capture(page,join(out,'03-credit-remove-ask-'+width+'.png'));
   await page.locator('.alc-confirm-row .button').filter({hasText:'确定去掉'}).click();await saved();
   now=(await layoutNow()).snapshot;assert.ok(now.blocks.some(b=>b.kind==='image'&&b.caption==='发布会现场与参数对比'&&!!b.image.credit),'显式去掉后只留说明，图源事实仍在');
   await tab('排版检查');assert.match(await visibleText(page,'.alc-check[data-rule="image_credit"]'),/提醒[\s\S]*网络图的图注里没有图源/);await tab('调整排版');
   await page.locator('.alc-credit-box .button').filter({hasText:'加回图源'}).click();await saved();await page.waitForFunction(()=>[...document.querySelectorAll('.alc-preview figcaption')].some(e=>(e as HTMLElement).innerText.endsWith('图源：Example News（news.example）')&&(e as HTMLElement).innerText.startsWith('发布会现场')),undefined,{timeout:20000});
   // 3 阻断项：正文颜色改成浅灰 → 确认按钮禁用并写明原因；检查列表逐条定位。
   await page.selectOption('#alc-style-text_color','#a0a6bd');await saved();
   const confirmButton=page.locator('.alc-foot .button.primary');assert.equal(await confirmButton.isDisabled(),true,'有阻断项不能确认');assert.match(await visibleText(page,'.alc-foot'),/还有 1 项阻断：文字颜色对比度/);
   await tab('排版检查');const checkText=await visibleText(page,'.alc-checks');assert.match(checkText,/1 项阻断/);assert.equal(await page.locator('.alc-check').count(),15,'15 条逐条列出');assert.equal(LEAK.test(checkText),false);
   assert.equal(await page.locator('.alc-check').first().getAttribute('data-rule'),'text_contrast','阻断项排在最前');
   await page.locator('.alc-side').scrollIntoViewIfNeeded();await capture(page,join(out,'04-check-blocked-'+width+'.png'));
   // 有阻断项时整屏：确认按钮置灰，原因写在按钮旁。
   assert.ok(await page.locator('.alc-foot-help').isVisible());assert.doesNotMatch(await page.locator('.alc-check-head b').first().innerText(),/^\d/,'检查条目不带内部序号');
   await page.screenshot({path:join(out,'04b-blocked-fullpage-'+width+'.png'),fullPage:true});screens.push(join(out,'04b-blocked-fullpage-'+width+'.png'));
   await page.locator('.alc-foot').scrollIntoViewIfNeeded();await capture(page,join(out,'04c-blocked-confirm-'+width+'.png'));
   // 定位：图片清晰度（夹具图片像素小）→ 点「定位到 …」→ 预览里选中对应图片并滚到可见。
   const hit=page.locator('.alc-check[data-rule="image_resolution"] .alc-hit').first();const hitText=await hit.innerText();await hit.click();
   const selectedName=await page.locator('.alc-outline-item.is-active b').innerText();assert.ok(hitText.includes(selectedName),'定位到问题所在的图文块：'+hitText+' / '+selectedName);
   await page.waitForFunction(()=>{const el=document.querySelector('.alc-preview .alc-block.is-selected');const box=document.querySelector('.alc-viewport');if(!el||!box)return false;const r=el.getBoundingClientRect(),b=box.getBoundingClientRect();return r.bottom>b.top&&r.top<b.bottom;},undefined,{timeout:5000});
   await page.locator('.alc-preview .alc-block.is-selected').scrollIntoViewIfNeeded();await capture(page,join(out,'05-check-jump-'+width+'.png'));
   await page.locator('.alc-check[data-rule="text_contrast"] .alc-hit').first().click();await page.locator('#alc-style-section').waitFor();assert.equal(await page.locator('.alc-tabs [role="tab"][aria-selected="true"]').innerText(),'调整排版','版式类问题跳到本篇版式');
   // 4 版本回退：回到进入排版时的排版版本 → 字号、颜色、主题色都回到标准，阻断解除。
   await page.locator('.article-layout-c1 .iwb-head-actions .button').filter({hasText:'版本记录'}).click();await page.locator('.alc-dialog[open] .alc-versions li').first().waitFor();
   await capture(page,join(out,'06-versions-'+width+'.png'));
   await page.locator('.alc-versions li').filter({hasText:'同步配图'}).filter({hasText:'排版 ·'}).locator('.button').click();await page.waitForFunction(()=>!document.querySelector('.alc-dialog[open]'),undefined,{timeout:20000});await saved();
   assert.equal(await fontSize(),'15px','回退后版式回到标准');now=(await layoutNow()).snapshot;assert.equal(now.style.text_color,'#0b1f52');assert.equal(now.style.accent_color,'#ccf866');assert.equal(now.layout_history.at(-1)!.reason,'layout_restore');
   assert.ok(now.blocks.some(b=>b.kind==='image'&&b.caption.startsWith('发布会现场与参数对比 · 图源')),'回退排版不动图注');
   await tab('排版检查');assert.match(await visibleText(page,'.alc-checks h3'),/没有阻断项|全部通过/);await page.locator('.alc-side').scrollIntoViewIfNeeded();await capture(page,join(out,'07-check-pass-'+width+'.png'));
   // 5 完整阅读：公众号阅读样式整篇预览，可滚动，不可编辑。
   await page.locator('.alc-read').click();await page.locator('.alc-reading[open] .alc-reader').waitFor();await page.waitForFunction(()=>document.querySelectorAll('.alc-reading .alc-reader figure img').length===3,undefined,{timeout:20000});
   assert.equal(await page.locator('.alc-reading [contenteditable="plaintext-only"], .alc-reading [contenteditable="true"]').count(),0,'完整阅读不可编辑');assert.ok((await visibleText(page,'.alc-reading .alc-reader')).includes(f.topic.title),'正文没有标题时用主题标题作公众号标题');
   const body=page.locator('.alc-reading-body');await page.waitForTimeout(300);const dims=await body.evaluate((e:HTMLElement)=>({sh:e.scrollHeight,ch:e.clientHeight,dialog:e.parentElement!.scrollHeight,dialogClient:e.parentElement!.clientHeight,paper:(e.firstElementChild as HTMLElement|null)?.style.height}));assert.ok(dims.sh>dims.ch+200,'长文章可滚动阅读 '+JSON.stringify(dims));
   await noOverflow(page,'reading');await capture(page,join(out,'08-reading-top-'+width+'.png'));await body.evaluate((e:HTMLElement)=>{e.scrollTop=e.scrollHeight/2;});await capture(page,join(out,'09-reading-middle-'+width+'.png'));await body.evaluate((e:HTMLElement)=>{e.scrollTop=e.scrollHeight;});await capture(page,join(out,'10-reading-end-'+width+'.png'));
   assert.equal(LEAK.test(await visibleText(page,'.alc-reading')),false);await page.locator('.alc-reading .button').filter({hasText:'关闭'}).click();
   // 6 确认排版：无阻断项 → 确认 → 冻结为排版终稿；步骤条前进；下一步 AI 审核为占位。
   await page.waitForFunction(()=>!(document.querySelector('.alc-foot .button.primary') as HTMLButtonElement|null)?.disabled,undefined,{timeout:20000});await page.locator('.alc-foot .button.primary').click();
   await page.locator('.alc-final').waitFor({timeout:20000});const finalText=await visibleText(page,'.alc-final');assert.match(finalText,/排版已确认为终稿/);assert.match(finalText,/下一步：AI 审核（待上线）/);
   assert.equal(await page.locator('.alc-foot .button').filter({hasText:'下一步：AI 审核'}).isDisabled(),true);assert.equal(await page.locator('.alc-preview [contenteditable="plaintext-only"]').count(),0,'确认后冻结，不能直接改');
   await tab('调整排版');assert.equal(await page.locator('#alc-style-body_size').isDisabled(),true,'确认后版式面板锁定');assert.match(await visibleText(page,'.alc-locked-note'),/修改后需要重新确认/);assert.ok((await page.locator('.alc-steps .iwb-step.is-done').allInnerTexts()).some(t=>t.includes('排版')),'步骤条「排版」完成');
   now=(await layoutNow()).snapshot;assert.ok(now.confirmation,'服务端有确认');assert.equal(now.confirmation!.binding.layout_revision_id,now.layout_revision_id);
   await noOverflow(page,'confirmed');await shot(page,'11-confirmed',width);
   // 刷新：确认状态保持。
   await page.reload();await page.waitForFunction(()=>!!document.querySelector('.alc-reader')||!!(document.querySelector('[data-action="edit-tab"][data-value="versions"]') as HTMLElement|null)?.offsetParent,undefined,{timeout:20000});
   if(!await page.locator('.alc-reader').count())await page.locator('.alc-reader').waitFor({timeout:3000}).catch(()=>toCreate());await page.locator('.alc-final').waitFor({timeout:20000});
   await page.locator('.article-layout-c1 .iwb-head-actions .button').filter({hasText:'版本记录'}).click();await page.locator('.alc-dialog[open] .alc-final-tag').first().waitFor();assert.equal(await page.locator('.alc-final-tag').count(),2,'版本记录标出排版终稿');await capture(page,join(out,'12-confirmed-versions-'+width+'.png'));await page.locator('.alc-dialog[open] .button').filter({hasText:'关闭'}).click();
   await shot(page,'13-confirmed-reloaded',width);
   // 「修改排版」解锁：改动保存后确认失效，需要重新确认。
   await page.locator('.alc-final .button').filter({hasText:'修改排版'}).click();await page.locator('.iwb-banner').filter({hasText:'正在修改已确认的排版'}).waitFor();
   await page.selectOption('#alc-style-paragraph_gap','24');await saved();await page.waitForFunction(()=>!document.querySelector('.alc-final-badge'),undefined,{timeout:20000});
   assert.equal((await layoutNow()).snapshot.confirmation,null,'确认后再改，确认失效');assert.equal(await page.locator('.alc-foot .button.primary').isDisabled(),false,'可重新确认');await shot(page,'14-reopened',width);
   const docAfter=await documents.get(f.request(),f.document_id);assert.equal(docAfter.head_revision_id,docBefore.head_revision_id,'平台稿修订不变');assert.equal(docAfter.text,docBefore.text);
   assert.deepEqual(external,[],'浏览器没有访问外部地址');assert.ok(!calls.some(c=>/wechat|weixin|draft|review/i.test(c.url)),'没有调用公众号/审核接口');
   checks.push({width,height,result:'passed',style_applied_and_saved:true,caption_credit_kept_and_explicit_remove:true,blocking_disables_confirm:true,check_rows:15,jump_to_block:true,jump_to_style:true,style_rollback:true,full_reading_scrollable:true,confirmed_and_reloaded:true,edit_after_confirm_invalidates:true,platform_revision_unchanged:true,external_requests:0});
  }catch(error){await shot(page,'failure',width).catch(()=>{});writeFileSync(join(out,'failure-'+width+'.json'),JSON.stringify({message:String(error),stack:(error as Error).stack,calls,errors},null,2));throw error;}
  finally{await page.evaluate(()=>(window as any).fixture?.unmount()).catch(()=>{});await page.close();await new Promise<void>(done=>proxy.close(()=>done()));await f.close();}
 }
 assert.deepEqual(errors,[]);writeFileSync(join(out,'checks.json'),JSON.stringify({task:'WECHAT-LAYOUT-STUDIO-C2',checked_at:new Date().toISOString(),checks,screens,errors,scope:'developer browser integration with injected network, fake content executor and fixture image provider; no real model, image, WeChat or AI review calls'},null,2)+'\n');console.log(JSON.stringify({out,checks:checks.length,screens:screens.length}));
}finally{await browser.close();}
