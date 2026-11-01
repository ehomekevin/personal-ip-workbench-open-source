// 配图工作台用户实测反馈修复浏览器用例：生产 Workbench + 真实服务路由 + 注入式网络 + 假内容执行器（不发真实模型/生图调用，不碰日用服务数据）。三视口截图。
// ① 标注框拖动移动、拖手柄缩放，刷新后保持 → ② 选中后 Delete / Backspace 删除（输入框里不误删）、可见删除按钮、撤销恢复
// → ③ 删除 AI 规划的图片位（有「已生成的图片会保留在素材库」提示），方案与采用一致 → ④ 在完整文章的中间段落插入新图片位、卡片「在后面插入」选上传，刷新后保持。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium,type Page} from '@playwright/test';
import {startPlanFixture} from '../image-studio/plan-fixture.ts';
import {solidPng} from '../helpers/png.ts';
import type {ImagePlanSnapshot} from '../../packages/contracts/src/index.ts';

const root=resolve(import.meta.dirname,'../..'),out=resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR??join(root,'.ci-artifacts/image-studio-adjust'));mkdirSync(out,{recursive:true});
const errors:string[]=[],screens:string[]=[],checks:unknown[]=[];
const LEAK=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|[0-9a-f]{32}|VALIDATION_ERROR|QUOTA_EXHAUSTED|idempotency|job_id|input_hash/i;
async function capture(page:Page,name:string,width:number){await page.waitForTimeout(350);const file=join(out,name+'-'+width+'.png');await page.screenshot({path:file});screens.push(file);}
async function noOverflow(page:Page,label:string){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,label+' 横向溢出');}
async function visibleText(page:Page,selector:string){return page.locator(selector).evaluate((el:HTMLElement)=>el.innerText);}
// 把元素滚到视口中间（小屏下舞台在左栏下面），再按真实像素拖动。
async function center(page:Page,selector:string){await page.evaluate(sel=>document.querySelector(sel)?.scrollIntoView({block:'center'}),selector);await page.waitForTimeout(150);}
async function dragBy(page:Page,from:{x:number;y:number},dx:number,dy:number){await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(from.x+dx,from.y+dy,{steps:8});await page.mouse.up();}
// 重绘会替换舞台节点：取位置时等到节点稳定再量。
async function box(page:Page,selector:string){for(let i=0;i<50;i++){const b=await page.locator(selector).first().boundingBox().catch(()=>null);if(b)return b;await page.waitForTimeout(100);}throw new Error('找不到 '+selector);}
const mid=(b:{x:number;y:number;width:number;height:number})=>({x:b.x+b.width/2,y:b.y+b.height/2});
const rectOf=async(page:Page,id:number)=>page.locator('.iwb-mark-g[data-mark="'+id+'"] .iwb-mark.is-rect').evaluate(r=>['x','y','width','height'].map(k=>Number(r.getAttribute(k))));
const browser=await chromium.launch({headless:true});
try{
 for(const [width,height] of [[1440,1000],[768,1024],[390,844]] as const){
  const f=await startPlanFixture({image_generation_limits:{codex:0,agy:null}}),app=f.app;
  const service='http://127.0.0.1:'+app.address.port,calls:Array<{method:string;url:string;body:string}>=[];
  const source=`import {createRoot} from 'react-dom/client';import {Workbench} from './apps/web/src/app/Workbench.tsx';
import {createHttpClient} from './apps/web/src/transport/workbench-client.ts';import {createDataFeaturePorts} from './apps/web/src/transport/data-features.ts';
import './apps/web/src/styles/approved.css';import './apps/web/src/styles/configuration.css';import './apps/web/src/styles/skills.css';import './apps/web/src/features/operations/operations.css';import './apps/web/src/styles/generation-progress.css';
const client=createHttpClient(),host=createRoot(document.querySelector('#root'));window.fixture={unmount:()=>host.unmount()};
host.render(<Workbench injection={{mode:'real',client,features:createDataFeaturePorts(),initialLocation:{page:'create',topic_id:${JSON.stringify(f.topic.id)},variant_id:${JSON.stringify(f.variant_id)}}}}/>);`;
  const bundle=await build({absWorkingDir:root,stdin:{contents:source,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:out,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});
  const js=bundle.outputFiles!.find(o=>o.path.endsWith('.js'))!.text,css=bundle.outputFiles!.find(o=>o.path.endsWith('.css'))!.text;
  const proxy=createServer(async(req,res)=>{try{const url=req.url??'/';if(url.startsWith('/api/')){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks),forward=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length'].includes(name))forward.set(name,Array.isArray(value)?value.join(','):value);calls.push({method:req.method??'',url,body:bytes.toString('utf8')});
     const response=await fetch(service+url,{method:req.method,headers:forward,body:bytes.length?bytes:undefined});res.statusCode=response.status;for(const [name,value] of response.headers)if(!['transfer-encoding','connection','content-encoding'].includes(name))res.setHeader(name,value);res.end(Buffer.from(await response.arrayBuffer()));return;}
    if(url.startsWith('/workbench/')){const leaf=url.slice(7);if(!/^[\w./-]+$/.test(leaf)||leaf.includes('..'))throw new Error('bad brand path');res.end(readFileSync(join(root,'apps/web/public/workbench',leaf)));return;}
    res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script type="module">'+js+'</script></html>');}catch(e){res.statusCode=500;res.end(String(e));}});
  await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));
  const page=await browser.newPage({viewport:{width,height}});page.on('pageerror',e=>errors.push(width+':'+e.message));
  await page.route(/^https:\/\/(news|pbs|douyin)\.example\//,route=>route.fulfill({status:200,contentType:'image/png',body:solidPng(160,120,[196,202,231])}));
  const planNow=async()=>(await (await fetch(service+'/api/v1/image-studio/plan?topic_id='+f.topic.id,{headers:{'x-workspace-id':app.identity.workspace_id,'x-service-instance-id':app.identity.service_instance_id}})).json()) as ImagePlanSnapshot;
  const wait=(fn:()=>boolean|Promise<boolean>,label:string)=>(async()=>{for(let i=0;i<200;i++){if(await fn())return;await page.waitForTimeout(100);}throw new Error('等待超时：'+label);})();
  const openWorkbench=async()=>{await page.locator('[data-action="edit-tab"][data-value="versions"]').click();const tab=page.locator('[data-action="platform-tab"][data-value="wechat"]');await tab.waitFor();if(!(await tab.getAttribute('class'))?.includes('active'))await tab.click();
   if(!await page.locator('.image-workbench').count())await page.locator('.studio-workbench-entry [data-action="studio-wb-open"]').click();await page.locator('.image-workbench').waitFor({timeout:20000});};
  const focusCard=async(id:string)=>{await page.locator('.iwb-card[data-item="'+id+'"] .iwb-card-hit').click();await page.locator('.iwb-card.is-focused[data-item="'+id+'"]').waitFor();};
  const tool=async(t:string)=>{await page.locator('[data-action="studio-wb-tool"][data-tool="'+t+'"]').click();};
  try{
   await page.goto('http://127.0.0.1:'+(proxy.address() as {port:number}).port);await openWorkbench();
   for(let i=0;i<200&&!f.planJobs().length;i++)await page.waitForTimeout(100);
   assert.equal((await f.complete())!.state,'committed');
   await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===4&&document.querySelectorAll('.iwb-card img.iwb-thumb').length>=2,undefined,{timeout:20000});
   let plan=await planNow();const [cover,article,,flow]=plan.items;const p=plan.studio.paragraphs;
   assert.equal(article!.role,'body');assert.equal(article!.source_strategy,'article_original');assert.ok(article!.current_version,'原文图已自动配好');

   // ① 标注框：框选画一个 → 自动选中带手柄 → 选择工具拖动移动 → 拖右下角手柄缩放 → 刷新后位置与大小保持。
   await focusCard(article!.id);await page.locator('.iwb-art img').waitFor({timeout:20000});await center(page,'.iwb-marks');
   await tool('rect');{const b=(await box(page,'.iwb-marks'));await dragBy(page,{x:b.x+b.width*.15,y:b.y+b.height*.15},b.width*.3,b.height*.35);}
   await page.locator('.iwb-mark-g.is-selected[data-mark="1"]').waitFor();assert.equal(await page.locator('.iwb-handle').count(),8,'选中的框有八个手柄');
   assert.match(await visibleText(page,'.iwb-stage-hint'),/已选中标注 1（框选）：拖动可移动，拖四角或四边改大小/);assert.equal(await page.locator('[data-action="studio-wb-mark-delete"]').isVisible(),true,'选中后有可见的删除按钮');
   await center(page,'.iwb-marks');await noOverflow(page,'marks-selected');await capture(page,'mark-selected',width);
   const drawn=await rectOf(page,1);
   await tool('select');await center(page,'.iwb-marks');
   {const r=(await box(page,'.iwb-mark-g[data-mark="1"] .iwb-mark.is-rect')),b=(await box(page,'.iwb-marks'));await dragBy(page,mid(r),b.width*.2,b.height*.1);}
   const H=Number(await page.locator('.iwb-marks').getAttribute('data-h')),moved=await rectOf(page,1);assert.ok(Math.abs(moved[0]!-drawn[0]!-200)<6&&Math.abs(moved[1]!-drawn[1]!-H*.1)<6,'拖动后位置变化 '+JSON.stringify([drawn,moved,H]));assert.deepEqual(moved.slice(2),drawn.slice(2),'移动不改大小');
   {const h=(await box(page,'.iwb-handle.is-se')),b=(await box(page,'.iwb-marks'));await dragBy(page,mid(h),b.width*.1,b.height*.1);}
   const resized=await rectOf(page,1);assert.ok(resized[2]!>moved[2]!+60&&resized[3]!>moved[3]!+20,'拖右下角变大 '+JSON.stringify([moved,resized]));assert.deepEqual(resized.slice(0,2),moved.slice(0,2),'拖右下角不动左上角');
   {const h=(await box(page,'.iwb-handle.is-w')),b=(await box(page,'.iwb-marks'));await dragBy(page,mid(h),-b.width*.05,0);}
   const final=await rectOf(page,1);assert.ok(final[0]!<resized[0]!-30&&Math.abs(final[0]!+final[2]!-(resized[0]!+resized[2]!))<1,'拖左边只动左边');
   await page.locator('#studio-wb-mark-1').fill('这里换成产品截图');await page.waitForTimeout(200);
   await page.reload();await openWorkbench();await focusCard(article!.id);await page.locator('.iwb-mark-g[data-mark="1"]').waitFor({timeout:20000});
   assert.deepEqual(await rectOf(page,1),final,'刷新后标注框的位置与大小保持');assert.equal(await page.locator('#studio-wb-mark-1').inputValue(),'这里换成产品截图','刷新后标注说明保持');

   // ② 删除：在输入框里按 Backspace 只删字；点选标注后 Delete 删除、撤销恢复；Backspace 同样可删；可见的删除按钮可删。
   await tool('select');await center(page,'.iwb-marks');{const r=(await box(page,'.iwb-mark-g[data-mark="1"] .iwb-mark.is-rect'));await page.mouse.click(mid(r).x,mid(r).y);}
   await page.locator('.iwb-mark-g.is-selected[data-mark="1"]').waitFor();
   await page.locator('#studio-wb-mark-1').click();await page.keyboard.press('End');await page.keyboard.press('Backspace');await page.keyboard.press('Delete');
   assert.equal(await page.locator('.iwb-annotation').count(),1,'焦点在输入框时 Backspace/Delete 不删标注');assert.equal(await page.locator('#studio-wb-mark-1').inputValue(),'这里换成产品截','输入框里正常删字');
   await center(page,'.iwb-marks');{const r=(await box(page,'.iwb-mark-g[data-mark="1"] .iwb-mark.is-rect'));await page.mouse.click(mid(r).x,mid(r).y);}
   await center(page,'.iwb-stage-col');await capture(page,'mark-delete-entry',width);
   await page.keyboard.press('Delete');await page.waitForFunction(()=>!document.querySelector('.iwb-annotation'),undefined,{timeout:5000});assert.equal(await page.locator('.iwb-mark-g').count(),0,'Delete 删除选中的标注框');
   await page.locator('[data-action="studio-wb-undo"]').click();await page.locator('.iwb-mark-g[data-mark="1"]').waitFor();assert.deepEqual(await rectOf(page,1),final,'撤销恢复原位置与大小');
   await tool('arrow');await center(page,'.iwb-marks');{const b=(await box(page,'.iwb-marks'));await dragBy(page,{x:b.x+b.width*.7,y:b.y+b.height*.8},-b.width*.15,-b.height*.2);}
   await page.locator('.iwb-mark-g.is-selected[data-mark="2"]').waitFor();assert.equal(await page.locator('.iwb-handle').count(),2,'箭头两端有手柄');
   await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur());await page.keyboard.press('Backspace');await page.waitForFunction(()=>document.querySelectorAll('.iwb-annotation').length===1,undefined,{timeout:5000});
   await page.locator('[data-action="studio-wb-mark-select"][data-mark="1"]').click();await page.locator('[data-action="studio-wb-mark-delete"]').click();await page.waitForFunction(()=>!document.querySelector('.iwb-annotation'),undefined,{timeout:5000});
   await page.locator('[data-action="studio-wb-undo"]').click();await page.locator('.iwb-mark-g[data-mark="1"]').waitFor();

   // ③ 删除 AI 规划的图片位：舞台标题旁「删除图片位」；已有图的项提示「已生成的图片会保留在素材库」；删除写进方案、采用与终稿待处理一致。
   await focusCard(flow!.id);await page.locator('.iwb-stage-col [data-action="studio-wb-remove"]').click();await page.locator('#dialog .iwb-confirm').waitFor();
   assert.match(await visibleText(page,'#dialog'),/这是 AI 规划的图片位，删除后不会自动加回/);assert.match(await visibleText(page,'#dialog'),/还没有生成过图片/);await page.locator('#dialog [data-action="studio-wb-remove-confirm"]').click();
   await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===3,undefined,{timeout:20000});
   await focusCard(article!.id);await page.locator('.iwb-stage-col [data-action="studio-wb-remove"]').click();await page.locator('#dialog .iwb-confirm').waitFor();
   assert.match(await visibleText(page,'#dialog'),/已生成的图片会保留在素材库（共 1 个版本）/);await page.waitForTimeout(300);await noOverflow(page,'ai-delete');await capture(page,'ai-delete-confirm',width);
   const adoptedBefore=(await planNow()).studio.slots.find(s=>s.id===article!.slot_id)!;assert.ok(adoptedBefore.active_version_id,'删除前原文图已采用');
   await page.locator('#dialog [data-action="studio-wb-remove-confirm"]').click();await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===2,undefined,{timeout:20000});
   plan=await planNow();assert.equal(plan.items.some(i=>i.id===article!.id||i.id===flow!.id),false,'AI 规划项已从方案删除');assert.equal(plan.studio.slots.find(s=>s.id===article!.slot_id)!.versions.length,1,'已生成的版本保留在素材里');
   assert.equal(plan.final.pending,plan.items.filter(i=>!i.skipped&&i.status!=='filled').length,'待处理只算未删除的项');
   assert.equal(await page.locator('.iwb-mark-g').count(),0,'删掉的图不再显示它的标注');

   // ④ 新加图片位：完整文章预览里在第 3 段后插入（AI 生图 + 图注）；卡片「在后面插入」选上传；刷新后都保持。
   await page.evaluate(()=>scrollTo(0,0));await page.locator('[data-action="studio-wb-preview"]').click();await page.locator('#dialog .iwb-preview').waitFor();
   assert.equal(await page.locator('#dialog .iwb-insert-here').count(),p.length,'每一段后面都能插入');
   await page.locator('#dialog .iwb-insert-here[data-place="after:'+p[2]!.id+'"]').click();await page.locator('#dialog .iwb-insert').waitFor();
   assert.equal(await page.locator('#studio-wb-insert-place').inputValue(),'after:'+p[2]!.id);assert.match(await visibleText(page,'#studio-wb-insert-excerpt'),/^插在这一段后面：同题的抖音作品/);
   await page.locator('#studio-wb-insert-caption').fill('中间插入：抖音作品之后的对比图');await page.waitForTimeout(300);await noOverflow(page,'insert');await capture(page,'insert-dialog',width);
   const creates=()=>calls.filter(c=>c.method==='POST'&&c.url==='/api/v1/image-studio/plan/items').length,before=creates();
   await page.locator('#dialog [data-action="studio-wb-insert-confirm"]').click();await wait(()=>creates()===before+1,'新加请求');
   await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===3,undefined,{timeout:20000});
   plan=await planNow();const inserted=plan.items.find(i=>i.purpose==='中间插入：抖音作品之后的对比图')!;assert.ok(inserted,'新图片位写进方案');assert.deepEqual([inserted.position,inserted.placement_paragraph_id,inserted.source_strategy],['after',p[2]!.id,'ai_generate']);
   assert.equal(await page.locator('.iwb-card.is-focused').getAttribute('data-item'),inserted.id,'新加后选中新图片位');
   const order=async()=>page.locator('.iwb-card').evaluateAll(cards=>cards.map(c=>(c as HTMLElement).dataset.item));
   assert.deepEqual(await order(),plan.items.map(i=>i.id),'左栏按文章顺序排入');
   await page.locator('.iwb-card.is-focused').scrollIntoViewIfNeeded();await capture(page,'insert-middle',width);
   // 卡片「在后面插入」：插在封面后面（第 1 段前），来源选上传 → 右栏切到「上传图片」。
   await page.locator('.iwb-card[data-item="'+cover!.id+'"] [data-action="studio-wb-insert"]').click();await page.locator('#dialog .iwb-insert').waitFor();assert.equal(await page.locator('#studio-wb-insert-place').inputValue(),'before:'+p[0]!.id);
   await page.locator('label[for="studio-wb-insert-src-upload"]').click();await page.locator('#dialog [data-action="studio-wb-insert-confirm"]').click();
   await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===4,undefined,{timeout:20000});await page.locator('.iwb-tab.is-active[data-tab="refs"]').waitFor();
   plan=await planNow();const uploaded=plan.items.find(i=>i.position==='before'&&i.placement_paragraph_id===p[0]!.id)!;assert.ok(uploaded,'在封面后、第 1 段前新加');assert.equal(plan.items[1]!.id,uploaded.id,'排在封面之后');
   await page.reload();await openWorkbench();await page.waitForFunction(()=>document.querySelectorAll('.iwb-card').length===4,undefined,{timeout:20000});
   assert.deepEqual(await order(),(await planNow()).items.map(i=>i.id),'刷新后新加的图片位与顺序保持');assert.equal(await page.locator('.iwb-card[data-item="'+inserted.id+'"] #studio-wb-place-'+inserted.id).inputValue(),'after:'+p[2]!.id);
   assert.equal(LEAK.test(await visibleText(page,'.image-workbench')),false,'主路径不露 ID/哈希');
   assert.equal(calls.some(c=>c.method==='POST'&&c.url==='/api/v1/image-studio/generations'),false,'全程没有提交生图');
   checks.push({width,height,result:'passed',mark:{drawn,moved,resized,final},removed_ai:2,inserted:2});
  }catch(error){await capture(page,'failure',width).catch(()=>{});writeFileSync(join(out,'failure-'+width+'.json'),JSON.stringify({message:String(error),stack:(error as Error).stack,calls:calls.map(c=>({method:c.method,url:c.url})),errors},null,2));throw error;}
  finally{await page.evaluate(()=>(window as any).fixture?.unmount()).catch(()=>{});await page.close();await new Promise<void>(done=>proxy.close(()=>done()));await f.close();}
 }
 assert.deepEqual(errors,[]);writeFileSync(join(out,'checks.json'),JSON.stringify({task:'WECHAT-IMAGE-STUDIO-ADJUST',checked_at:new Date().toISOString(),checks,screens,errors,scope:'developer browser integration with injected network and fake content executor; no real model or image calls'},null,2)+'\n');console.log(JSON.stringify({out,checks:checks.length,screens:screens.length}));
}finally{await browser.close();}
