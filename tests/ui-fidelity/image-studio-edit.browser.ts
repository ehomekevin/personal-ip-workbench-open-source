// 配图编辑台（A2-2）浏览器用例：生产 Workbench + 真实服务路由 + 注入式网络 + 假内容执行器/假生图（不发真实调用）。左栏直接编辑、位置下拉、删除确认、单图舞台标注、版本对比、画幅另存、上传为新版本、批量生成与预览，三视口截图。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium,type Page} from '@playwright/test';
import {startPlanFixture} from '../image-studio/plan-fixture.ts';
import {solidPng} from '../helpers/png.ts';
import type {ImagePlanSnapshot} from '../../packages/contracts/src/index.ts';

const root=resolve(import.meta.dirname,'../..'),out=resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR??join(root,'.ci-artifacts/image-studio-a2-2'));mkdirSync(out,{recursive:true});
const errors:string[]=[],screens:string[]=[],checks:unknown[]=[];
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
  const f=await startPlanFixture({image_generation_limits:{codex:0,agy:null}}),app=f.app;
  // 生产现状：设置默认生图渠道是 Codex，但 Codex 生图剩 0、AGY 剩 1 → 工作台默认应退到 AGY。
  const {ImageProviderSettings}=await import('../../packages/domain/src/settings/image-providers.ts');const saved=await new ImageProviderSettings(app.context).read(f.request());await new ImageProviderSettings(app.context).save(f.request(),{expected_version:saved.version,default_provider:'codex',enabled:{agy:true,codex:true}});
  const service='http://127.0.0.1:'+app.address.port,calls:Array<{method:string;url:string;key:unknown;body:string}>=[];
  let holdRuns:(()=>void)|null=null;const runsGate=new Promise<void>(r=>{holdRuns=r;});
  const source=`import {createRoot} from 'react-dom/client';import {Workbench} from './apps/web/src/app/Workbench.tsx';
import {createHttpClient} from './apps/web/src/transport/workbench-client.ts';import {createDataFeaturePorts} from './apps/web/src/transport/data-features.ts';
import './apps/web/src/styles/approved.css';import './apps/web/src/styles/configuration.css';import './apps/web/src/styles/skills.css';import './apps/web/src/features/operations/operations.css';import './apps/web/src/styles/generation-progress.css';
const client=createHttpClient(),host=createRoot(document.querySelector('#root'));window.fixture={unmount:()=>host.unmount()};
host.render(<Workbench injection={{mode:'real',client,features:createDataFeaturePorts(),initialLocation:{page:'create',topic_id:${JSON.stringify(f.topic.id)},variant_id:${JSON.stringify(f.variant_id)}}}}/>);`;
  const bundle=await build({absWorkingDir:root,stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:out,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});
  const js=bundle.outputFiles!.find(o=>o.path.endsWith('.js'))!.text,css=bundle.outputFiles!.find(o=>o.path.endsWith('.css'))!.text;
  const proxy=createServer(async(req,res)=>{try{const url=req.url??'/';if(url.startsWith('/api/')){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks),forward=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length'].includes(name))forward.set(name,Array.isArray(value)?value.join(','):value);calls.push({method:req.method??'',url,key:req.headers['idempotency-key']??null,body:bytes.toString('utf8')});
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
   holdRuns!();
   for(let i=0;i<200&&!f.planJobs().length;i++)await page.waitForTimeout(100);
   assert.equal((await f.complete())!.state,'committed');
   await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===4&&document.querySelectorAll('.iwb-card img.iwb-thumb').length>=2,undefined,{timeout:20000});
   const posts=(url:string)=>calls.filter(c=>c.method==='POST'&&c.url===url);
   const wait=(fn:()=>boolean|Promise<boolean>,label:string)=>(async()=>{for(let i=0;i<200;i++){if(await fn())return;await page.waitForTimeout(100);}throw new Error('等待超时：'+label);})();
   let plan=await planNow();const [coverItem,article,post,flow]=plan.items;const p=plan.studio.paragraphs;
   // 1. 左栏：不展开即可改别的卡片的图注与插入位置。
   assert.equal(await page.locator('.iwb-card input[id^="studio-wb-caption-"]').count(),4,'每张卡片都有图注输入框');assert.equal(await page.locator('.iwb-card select[id^="studio-wb-place-"]').count(),4);
   const flowCaption=page.locator('#studio-wb-caption-'+flow!.id);await flowCaption.fill('六步流程：从收集资料到审核');await flowCaption.press('Enter');
   await wait(async()=>(await planNow()).items.some(i=>i.id===flow!.id&&i.purpose==='六步流程：从收集资料到审核'),'图注保存');
   await page.locator('#studio-wb-place-'+flow!.id).selectOption('before:'+p[1]!.id);
   await wait(async()=>{const s=await planNow();const it=s.items.find(i=>i.id===flow!.id)!;return it.position==='before'&&it.placement_paragraph_id===p[1]!.id;},'位置保存');
   await page.waitForFunction(id=>{const cards=[...document.querySelectorAll('.iwb-card')].map(c=>(c as HTMLElement).dataset.item);return cards[1]===id;},flow!.id,{timeout:20000});
   await page.evaluate(sel=>document.querySelector(sel)?.scrollIntoView({block:'nearest'}),'#studio-wb-place-'+flow!.id);await noOverflow(page,'left');await capture(page,join(out,'left-edit-'+width+'.png'));
   // 2. 刷新后保留。
   await page.reload();await page.locator('[data-action="edit-tab"][data-value="versions"]').click();const tab=page.locator('[data-action="platform-tab"][data-value="wechat"]');await tab.waitFor();if(!(await tab.getAttribute('class'))?.includes('active'))await tab.click();await page.locator('.studio-workbench-entry [data-action="studio-wb-open"]').click();
   await page.locator('#studio-wb-place-'+flow!.id).waitFor();assert.equal(await page.locator('#studio-wb-place-'+flow!.id).inputValue(),'before:'+p[1]!.id,'刷新后位置保留');assert.equal(await page.locator('#studio-wb-caption-'+flow!.id).inputValue(),'六步流程：从收集资料到审核');
   // 3. 单图舞台 + 标注：聚焦原文配图，框选、改文字、涂抹，清单编号与说明。
   await page.locator('.iwb-card[data-item="'+article!.id+'"] .iwb-card-hit').click();await page.locator('.iwb-art img').waitFor({timeout:20000});
   assert.equal(await page.locator('.iwb-stage-col .iwb-article').count(),0,'中栏是单图舞台，不是整篇文章');
   const drag=async(tool:string,from:[number,number],to:[number,number],steps=6)=>{await page.locator('[data-action="studio-wb-tool"][data-tool="'+tool+'"]').click();await page.locator('.iwb-marks').waitFor();const box=(await page.locator('.iwb-marks').boundingBox())!;await page.mouse.move(box.x+box.width*from[0],box.y+box.height*from[1]);await page.mouse.down();await page.mouse.move(box.x+box.width*to[0],box.y+box.height*to[1],{steps});await page.mouse.up();};
   await page.evaluate(sel=>document.querySelector(sel)?.scrollIntoView({block:'nearest'}),'.iwb-marks');await drag('rect',[.1,.1],[.4,.5]);await page.locator('#studio-wb-mark-1').fill('人物缩小一点');
   await page.locator('[data-action="studio-wb-tool"][data-tool="text"]').click();{const box=(await page.locator('.iwb-marks').boundingBox())!;await page.mouse.click(box.x+box.width*.6,box.y+box.height*.3);}await page.locator('#studio-wb-mark-2').fill('新标题');
   await drag('brush',[.7,.6],[.9,.8],8);await drag('arrow',[.2,.8],[.5,.7]);
   assert.equal(await page.locator('.iwb-annotation').count(),4);assert.match(await visibleText(page,'.iwb-mark-count'),/^4 处标注 · 批注不进入成品$/);
   await page.locator('[data-action="studio-wb-undo"]').click();assert.equal(await page.locator('.iwb-annotation').count(),3,'撤销上一处');
   assert.equal(await page.locator('[data-chip="marked"]').isDisabled(),false,'有标注时「只改标注区域」可用');await page.locator('[data-chip="marked"]').click();
   assert.equal(await page.locator('#studio-wb-provider').inputValue(),'agy');assert.deepEqual(await page.locator('#studio-wb-provider option').allInnerTexts(),['AGY 生图 · 不限次数','Codex 生图 · 不支持在原图上修改']);assert.equal(await page.locator('#studio-wb-provider option[value="codex"]').evaluate(o=>(o as HTMLOptionElement).disabled),true);
   await noOverflow(page,'marks');await page.evaluate(sel=>document.querySelector(sel)?.scrollIntoView({block:'nearest'}),'.iwb-editor');await capture(page,join(out,'stage-marks-'+width+'.png'));
   const beforeEdit=posts('/api/v1/image-studio/generations').length;const trigger=(await page.locator('[data-action="studio-wb-edit"]').boundingBox())!;await page.locator('[data-action="studio-wb-edit"]').click();
   // 生成修改版先确认：弹窗写明渠道、模型、张数；确认前不发请求；确认按钮不与触发按钮重叠。
   await page.locator('#dialog .iwb-gen-confirm').waitFor();assert.match(await visibleText(page,'#dialog'),/AGY 生图[^]*Gemini 3\.1 Flash Image[^]*1 张/);assert.equal(posts('/api/v1/image-studio/generations').length,beforeEdit,'确认前不提交');
   {const go=(await page.locator('#dialog [data-action="studio-wb-edit-confirm"]').boundingBox())!;assert.ok(go.x>=trigger.x+trigger.width||go.x+go.width<=trigger.x||go.y>=trigger.y+trigger.height||go.y+go.height<=trigger.y,'确认按钮与「生成修改版」不重叠');}
   await page.locator('#dialog [data-action="studio-wb-edit-confirm"]').click();
   await wait(()=>posts('/api/v1/image-studio/generations').length===beforeEdit+1,'修改版入队');const editBody=JSON.parse(posts('/api/v1/image-studio/generations').at(-1)!.body);
   assert.equal(editBody.operation,'reference_edit');assert.equal(editBody.provider,'agy');assert.equal(editBody.marks.length,3);assert.deepEqual(editBody.marks.map((m:{type:string})=>m.type),['rect','text','brush']);
   assert.match(editBody.description,/^只修改标注区域，其他保持不变。\n标注1（框选，x \d+–\d+%，y \d+–\d+%）：人物缩小一点；把标注2处（x \d+%，y \d+%）的文字改为「新标题」；标注3（涂抹，/);assert.match(editBody.description,/未标注区域保持不变$/);
   await page.waitForFunction(()=>!document.querySelector('.iwb-annotation'),undefined,{timeout:20000});
   const versionsOf=async()=>(await planNow()).studio.slots.find(x=>x.id===article!.slot_id)!.versions.length;await wait(async()=>await versionsOf()===2,'修改版落库');
   await f.runOnce();await page.waitForFunction(()=>document.querySelectorAll('.iwb-version:not([disabled])').length===2,undefined,{timeout:20000});
   plan=await planNow();{const slot=plan.studio.slots.find(s=>s.id===article!.slot_id)!;assert.equal(slot.versions.at(-1)!.marks!.length,3,'标注存进版本');}
   // 4. 版本对比：回到 v1。
   await page.locator('[data-action="studio-wb-compare"]').click();await page.locator('#dialog .iwb-compare').waitFor();assert.match(await visibleText(page,'#dialog'),/回到 v1/);assert.match(await visibleText(page,'#dialog'),/保留当前版/);
   await page.waitForTimeout(300);await noOverflow(page,'compare');await capture(page,join(out,'compare-'+width+'.png'));
   await page.locator('#dialog [data-action="studio-wb-restore-version"]').click();await wait(async()=>(await planNow()).items.find(i=>i.id===article!.id)!.current_version!.index===1,'回到 v1');
   // 5. 调整画幅另存新版本（AGY reference_edit + 新尺寸）。
   await page.locator('[data-action="studio-wb-resize"]').click();await page.locator('#studio-wb-resize-ratio').waitFor();await page.locator('#studio-wb-resize-ratio').selectOption('3:4');await page.waitForTimeout(200);
   await capture(page,join(out,'resize-'+width+'.png'));const beforeResize=posts('/api/v1/image-studio/generations').length;await page.locator('#dialog [data-action="studio-wb-resize-next"]').click();await page.locator('#dialog .iwb-gen-confirm').waitFor();assert.match(await visibleText(page,'#dialog'),/新尺寸\s*1200 × 1600 px/);assert.equal(posts('/api/v1/image-studio/generations').length,beforeResize,'确认前不提交');await capture(page,join(out,'resize-confirm-'+width+'.png'));await page.locator('#dialog [data-action="studio-wb-resize-confirm"]').click();
   await wait(()=>posts('/api/v1/image-studio/generations').length===beforeResize+1,'画幅版本入队');{const b=JSON.parse(posts('/api/v1/image-studio/generations').at(-1)!.body);assert.deepEqual([b.operation,b.provider,b.size.width,b.size.height],['reference_edit','agy',1200,1600]);}
   await wait(async()=>await versionsOf()===3,'画幅版落库');
   await f.runOnce();await page.waitForFunction(()=>document.querySelectorAll('.iwb-version:not([disabled])').length===3,undefined,{timeout:20000});
   // 6. 上传图片作为新一版（带用途）。
   await page.locator('[data-action="studio-wb-tab"][data-tab="refs"]').click();await page.locator('#studio-wb-upload-purpose').selectOption('layout');
   const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('[data-action="studio-wb-upload"]').click()]);await chooser.setFiles({name:'构图参考.png',mimeType:'image/png',buffer:solidPng(640,480,[30,60,120])});
   await page.waitForFunction(()=>document.querySelectorAll('.iwb-version:not([disabled])').length===4,undefined,{timeout:20000});
   plan=await planNow();{const v=plan.studio.slots.find(s=>s.id===article!.slot_id)!.versions.at(-1)!;assert.equal(v.operation,'upload');assert.deepEqual(v.upload,{purpose:'layout',name:'构图参考.png'});}
   await page.waitForFunction(()=>/v4 · 上传的图/.test((document.querySelector('.iwb-version.is-selected') as HTMLElement|null)?.innerText??''),undefined,{timeout:20000});await page.evaluate(sel=>document.querySelector(sel)?.scrollIntoView({block:'nearest'}),'.iwb-editor');await capture(page,join(out,'upload-'+width+'.png'));
   // 7. 手动加一张 → 删除（无版本）；删除有版本的帖子图 → 确认框说明版本保留。
   await page.locator('[data-action="studio-wb-add-item"]').click();await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===5,undefined,{timeout:20000});
   await page.locator('.iwb-card.is-focused [data-action="studio-wb-remove"]').click();await page.locator('#dialog .iwb-confirm').waitFor();assert.match(await visibleText(page,'#dialog'),/还没有生成过图片/);await page.locator('#dialog [data-action="studio-wb-remove-confirm"]').click();
   await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===4,undefined,{timeout:20000});
   await page.locator('.iwb-card[data-item="'+post!.id+'"] .iwb-card-hit').click();await page.locator('.iwb-card.is-focused[data-item="'+post!.id+'"] [data-action="studio-wb-remove"]').click();await page.locator('#dialog .iwb-confirm').waitFor();assert.match(await visibleText(page,'#dialog'),/已生成的图片会保留在素材库（共 1 个版本），可从其他图的「网络找图」分页找回/);
   await page.waitForTimeout(300);await noOverflow(page,'delete');await capture(page,join(out,'delete-confirm-'+width+'.png'));await page.locator('#dialog [data-action="studio-wb-remove-confirm"]').click();
   await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===3,undefined,{timeout:20000});plan=await planNow();assert.equal(plan.items.some(i=>i.id===post!.id),false);
   // 找回：在原文图的「换来源」里出现已删除帖子图的图片。
   await page.locator('[data-action="studio-wb-tab"][data-tab="sources"]').click();assert.match(await visibleText(page,'.iwb-edit'),/已删除配图的图片/);
   // 8. 批量生成：勾选已配的封面以外的图，确认框写清首次生成/新建版本与模型。
   await page.locator('#studio-wb-pick-'+article!.id).check();await page.locator('[data-action="studio-wb-generate-all"]').click();await page.locator('#dialog .iwb-confirm').waitFor();const batch=await visibleText(page,'#dialog');
   assert.match(batch,/新建版本/);assert.match(batch,/首次生成/);assert.match(batch,/Gemini 3\.1 Flash Image/);assert.doesNotMatch(batch,/额度不足|生图剩余/);
   await page.waitForTimeout(300);await capture(page,join(out,'batch-'+width+'.png'));await page.locator('#dialog [data-action="close-dialog"]').last().click();
   // 9. 预览完整文章弹窗：封面在前，已删除的不出现。
   await page.evaluate(()=>scrollTo(0,0));await page.locator('[data-action="studio-wb-preview"]').click();await page.locator('#dialog .iwb-preview').waitFor();const preview=await visibleText(page,'#dialog .iwb-preview');
   assert.equal(preview.includes(post!.purpose),false,'已删除的图不进文章');assert.ok(preview.includes('六步流程：从收集资料到审核'));
   await page.waitForTimeout(300);await capture(page,join(out,'preview-'+width+'.png'));await page.locator('#dialog [data-action="close-dialog"]').last().click();
   assert.equal(LEAK.test(await visibleText(page,'.image-workbench')),false,'主路径不露 ID/哈希');void coverItem;
   checks.push({width,height,result:'passed',edit_marks:3,versions:4,removed:2,upload:'layout'});
  }catch(error){await capture(page,join(out,'failure-'+width+'.png')).catch(()=>{});writeFileSync(join(out,'failure-'+width+'.json'),JSON.stringify({message:String(error),stack:(error as Error).stack,calls:calls.map(c=>({method:c.method,url:c.url})),errors},null,2));throw error;}
  finally{holdRuns?.();await page.evaluate(()=>(window as any).fixture?.unmount()).catch(()=>{});await page.close();await new Promise<void>(done=>proxy.close(()=>done()));await f.close();}
 }
 assert.deepEqual(errors,[]);writeFileSync(join(out,'checks.json'),JSON.stringify({task:'WECHAT-IMAGE-STUDIO-A2-2',checked_at:new Date().toISOString(),checks,screens,errors,scope:'developer browser integration with injected network, fake content executor and fixture image provider; no real model or image calls'},null,2)+'\n');console.log(JSON.stringify({out,checks:checks.length,screens:screens.length}));
}finally{await browser.close();}
