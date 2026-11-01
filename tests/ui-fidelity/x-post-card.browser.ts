import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium,expect,type Route} from '@playwright/test';

const root=resolve(import.meta.dirname,'../..');
const artifacts=join(root,'.ci-artifacts','x-native-cards-browser');mkdirSync(artifacts,{recursive:true});
const fixture=`
import {createRoot} from 'react-dom/client';
import {Workbench} from './apps/web/src/app/Workbench.tsx';
import {createSourcesReadFeature} from './apps/web/src/features/sources/read/index.ts';
import {renderBenchmarkRecord} from './apps/web/src/components/benchmarkMaterials.ts';
import './apps/web/src/styles/approved.css';
const images=Array.from({length:4},(_,i)=>({type:'photo',url:'https://images.fixture.invalid/paper-'+i+'.svg',alt_text:'设计案例 '+(i+1)}));
const author={id:'123',name:'示例作者',handle:'sample_author',avatar_url:'https://images.fixture.invalid/avatar.svg'};
const original={id:'456',author:{id:'456',name:'产品设计作者',handle:'product_author',avatar_url:'https://images.fixture.invalid/avatar-original.svg'},text:'完整案例：把想法变成读者能照着做的产品界面。\\n'+('这里保留引用作者的完整文字与图片，长文字按自然顺序阅读。'.repeat(14)),published_at:'2026-10-13T02:00:00Z',canonical_url:'https://x.com/product_author/status/456',media:images,links:[],availability:'available',metrics:{likes:'999999'}};
const row={id:'quote',record_kind:'x_post',external_id:'789',title:'文件版解读',summary:'文件版解读: https://t.co/example123',category:'对标内容',author_name:'示例作者',reply_author_name:null,quoted_author_name:'产品设计作者',published_at:'2026-10-13T03:00:00Z',canonical_url:'https://x.com/sample_author/status/789',favorite:false,read:false,source_name:'示例作者 · X',source_locations:[],content_status:'full',format:'text',media_type:'image',preview_url:images[0].url,metrics:{likes:'21',reposts:'7',replies:'3',views:'1024',bookmarks:'0'}};
const record={...row,body:'旧的截断正文',external_links:[row.canonical_url],media:[],parser_warnings:[],benchmark:{platform:'x',collected_at:'2026-10-13T04:00:00Z',metrics:row.metrics,x_post:{id:'789',kind:'quote',author,text:row.summary,published_at:row.published_at,canonical_url:row.canonical_url,links:[{url:'https://t.co/example123',expanded_url:'https://articles.example.invalid/posts/sample-design'}],media:[],quoted_post:original,availability:'available'}}};
const account={id:'a',name:'示例作者',platform:'x',role:'benchmark',identity_status:'confirmed',canonical_url:'https://x.com/sample_author',platform_account_id:'123',work_count:1,profile:{display_name:'示例作者',display_id:'sample_author',avatar_url:author.avatar_url,bio:'产品与 AI 实践',collected_at:'2026-10-13T04:00:00Z'}};
const f=window.fixture={context:null,requests:[],record,original};
const client={identity:async()=>({workspace_id:'x-card-fixture',service_instance_id:'x-card-fixture-service',contract_version:'fixture'}),request:async(method,path)=>{f.requests.push({method,path});if(method!=='GET')throw Error('Fixture accepts read-only requests');if(path.startsWith('/api/v1/source-records?'))return {items:[row],next_cursor:null};if(path==='/api/v1/source-records/quote')return structuredClone(record);if(path.startsWith('/api/v1/accounts?'))return {items:[account],next_cursor:null};if(path==='/api/v1/accounts/a/feed-sync')return {source_id:'s',last_success_at:'2026-10-13T04:00:00Z'};throw Error('Unexpected fixture request: '+path);}};
const feature=createSourcesReadFeature();const load=feature.load;feature.load=async context=>{f.context=context;return load(context);};
const host=createRoot(document.getElementById('root'));host.render(<Workbench injection={{mode:'real',client,initialPage:'sources',features:{sources:feature}}}/>);
f.show=kind=>{const saved=structuredClone(record);if(kind==='repost'){saved.benchmark.x_post.kind='repost';saved.benchmark.x_post.text='';saved.benchmark.x_post.reposted_post=original;delete saved.benchmark.x_post.quoted_post;}if(kind==='missing'){saved.benchmark.x_post.quoted_post={id:'456',author:{name:'原作者'},canonical_url:original.canonical_url,availability:'unavailable'};}if(kind==='no-media'){saved.benchmark.x_post.quoted_post.media=[];}if(kind==='broken'){saved.benchmark.x_post.quoted_post.media=[{type:'photo',url:'https://images.fixture.invalid/broken.svg',alt_text:'失效图片'}];}if(kind==='video'){saved.benchmark.x_post.media=[{type:'video',play_url:'https://images.fixture.invalid/broken-video.mp4',preview_url:images[0].url}];delete saved.benchmark.x_post.quoted_post;}f.context.surface.presentDialog({title:'X 完整素材 · '+kind,body:renderBenchmarkRecord(saved),foot:'<button class="button" data-action="close-dialog">关闭</button>'});};
const show=f.show;f.show=kind=>{if(!kind.startsWith('pending-'))return show(kind);const saved=structuredClone(record);saved.benchmark.x_post.quoted_post.text='受控延迟的图片加载';saved.benchmark.x_post.quoted_post.media=[{type:'photo',url:'https://images.fixture.invalid/'+kind+'.svg',alt_text:'延迟图片'}];if(kind==='pending-switch')saved.benchmark.x_post.quoted_post.media.push(images[0]);f.context.surface.presentDialog({title:'X 完整素材 · '+kind,body:renderBenchmarkRecord(saved),foot:'<button class="button" data-action="close-dialog">关闭</button>'});};
f.unmount=()=>host.unmount();
`;
const built=await build({absWorkingDir:root,stdin:{contents:fixture,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:artifacts,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});
const javascript=built.outputFiles!.find(file=>file.path.endsWith('.js'))!.text,css=built.outputFiles!.find(file=>file.path.endsWith('.css'))!.text;
const html='<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script type="module">'+javascript+'</script></html>';
const server=createServer((request,response)=>{
 if(request.url?.startsWith('/workbench/')){try{const file=join(root,'apps/web/public',request.url);response.writeHead(200,{'Content-Type':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.woff2')?'font/woff2':'image/webp'});response.end(readFileSync(file));}catch{response.writeHead(404).end();}return;}
 response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);
});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
const browser=await chromium.launch({headless:true}),checks:unknown[]=[],errors:string[]=[];
try{
 for(const width of [390,768,1440]){
  const page=await browser.newPage({viewport:{width,height:width===390?844:1000}}),imageRequests:string[]=[],pending=new Map<string,Route>();
  await page.addInitScript(()=>{const counts=new Map<HTMLImageElement,Set<unknown>>();(window as any).__imageListeners=counts;const add=HTMLImageElement.prototype.addEventListener,remove=HTMLImageElement.prototype.removeEventListener;HTMLImageElement.prototype.addEventListener=function(type:string,listener:any,...rest:any[]){if(type==='load'||type==='error'){const active=counts.get(this)??new Set();active.add(listener);counts.set(this,active);}return (add as any).call(this,type,listener,...rest);};HTMLImageElement.prototype.removeEventListener=function(type:string,listener:any,...rest:any[]){if(type==='load'||type==='error')counts.get(this)?.delete(listener);return (remove as any).call(this,type,listener,...rest);};});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://images.fixture.invalid/**',route=>{
   const path=new URL(route.request().url()).pathname;imageRequests.push(path);if(path.includes('broken'))return route.abort('failed');
   if(path.startsWith('/pending-')){pending.set(path,route);return;}
   const number=Number(path.match(/paper-(\d)/)?.[1]??0),colors=['#D9FF43','#dbe7fb','#f5e4c6','#e9e4fa'];
   const svg='<svg xmlns="http://www.w3.org/2000/svg" width="720" height="580"><rect width="720" height="580" fill="'+colors[number%4]+'"/><rect x="70" y="70" width="580" height="440" rx="24" fill="white"/><rect x="110" y="115" width="285" height="35" rx="7" fill="#0B1F52"/><rect x="110" y="180" width="500" height="12" rx="6" fill="#bcc6dd"/><rect x="110" y="215" width="410" height="12" rx="6" fill="#bcc6dd"/><rect x="110" y="285" width="220" height="160" rx="16" fill="#0B1F52"/><circle cx="480" cy="365" r="65" fill="'+colors[number%4]+'"/></svg>';
   return route.fulfill({contentType:'image/svg+xml',body:svg});
  });
  await page.goto(url);await page.locator('.x-post-card').waitFor();
  assert.equal(await page.locator('.source-body').count(),0,'X reader must not duplicate truncated body');
  assert.equal(await page.locator('.x-post-card').getByText('产品设计作者',{exact:true}).count(),1);
  assert.equal(await page.locator('.x-post-card a[href="https://articles.example.invalid/posts/sample-design"]').count(),1);
  assert.ok(!(await page.locator('.x-post-card').innerText()).includes('t.co/'));
  await page.screenshot({path:join(artifacts,'reader-'+width+'.png'),fullPage:true});
  await page.locator('[data-action="source-tab"][data-value="accounts"]').click();await page.locator('[data-action="account-detail"]').click();
  await page.locator('#dialog .x-post-summary').waitFor();
  assert.equal(await page.locator('#dialog .x-summary-cover img').count(),1);
  await page.screenshot({path:join(artifacts,'account-list-'+width+'.png'),fullPage:true});
  await page.locator('[data-action="benchmark-record"]').click();await page.locator('#dialog .x-post-card').waitFor();
  assert.equal(await page.locator('#dialog .x-post-embedded .x-post-text').textContent(),await page.evaluate(()=>(window as any).fixture.original.text));
  const gallery=page.locator('#dialog [data-x-gallery]');await gallery.scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('#dialog [data-x-gallery] img')).every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0));
  const images=await gallery.locator('img').evaluateAll(items=>items.map(image=>{(image as any).__xNodeIdentity=true;return (image as HTMLImageElement).currentSrc;}));
  const requestsBefore=imageRequests.length;await gallery.locator('[data-x-image]').first().click();await page.locator('.x-image-viewer[open]').waitFor();
  assert.equal(await page.locator('.x-viewer-stage img').evaluate(image=>(image as any).__xNodeIdentity),true);
  await page.keyboard.press('ArrowRight');assert.equal(await page.locator('.x-viewer-counter').innerText(),'图片 2 / 4');
  await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');assert.equal(await page.locator('[data-x-next]').isDisabled(),true);
  await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('.x-viewer-counter').innerText(),'图片 3 / 4');
  await page.locator('.x-viewer-close').focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('.x-image-viewer')),true);
  await page.screenshot({path:join(artifacts,'image-viewer-'+width+'.png'),fullPage:true});
  await page.keyboard.press('Escape');assert.equal(await page.locator('.x-image-viewer').evaluate(viewer=>(viewer as HTMLDialogElement).open),false);
  assert.equal(await page.locator('#dialog').evaluate(dialog=>(dialog as HTMLDialogElement).open),true);
  assert.equal(await gallery.locator('[data-x-image]').first().evaluate(button=>button===document.activeElement),true);
  assert.deepEqual(await gallery.locator('img').evaluateAll(items=>items.map(image=>(image as HTMLImageElement).currentSrc)),images);
  assert.equal(imageRequests.length,requestsBefore,'Viewer navigation must issue zero media requests');
  const layout=await page.evaluate(()=>{const d=document.querySelector('#dialog')!.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,dialogFits:d.left>=0&&d.right<=innerWidth,dialogHeight:d.height<=innerHeight};});
  assert.equal(layout.overflow,false);assert.equal(layout.dialogFits,true);assert.equal(layout.dialogHeight,true);
  for(const kind of ['repost','missing','no-media','broken','video']){
   await page.evaluate(kind=>(window as any).fixture.show(kind),kind);
   if(kind==='repost'){assert.equal(await page.locator('#dialog .x-post-relation').getByText('转发的原作品',{exact:true}).count(),1);assert.ok((await page.locator('#dialog').innerText()).includes('不与原作品合计'));assert.ok(!(await page.locator('#dialog').innerText()).includes('999999'));}
   if(kind==='missing'){assert.ok((await page.locator('#dialog').innerText()).includes('原作品当前不可用'));assert.equal(await page.locator('#dialog [data-x-gallery]').count(),0);}
   if(kind==='no-media'){assert.equal(await page.locator('#dialog [data-x-gallery]').count(),0);assert.equal(await page.locator('#dialog .x-post-embedded .x-post-text').textContent(),await page.evaluate(()=>(window as any).fixture.original.text));assert.equal(await page.locator('#dialog .x-post-embedded a[href="https://x.com/product_author/status/456"]').count(),1);}
   if(kind==='broken'){await page.locator('#dialog [data-x-image]').scrollIntoViewIfNeeded();await page.waitForFunction(()=>!!document.querySelector<HTMLImageElement>('#dialog [data-x-image] img')?.hidden);await page.locator('#dialog [data-x-image]').click();assert.equal(await page.locator('.x-viewer-error').isVisible(),true);await page.keyboard.press('Escape');}
   if(kind==='video'){assert.equal(await page.locator('#dialog video').getAttribute('controls'),'');assert.equal(await page.locator('#dialog video').getAttribute('preload'),'none');await page.locator('#dialog video').evaluate(video=>(video as HTMLVideoElement).load());await page.locator('#dialog .benchmark-media-error:not([hidden])').waitFor();assert.equal(await page.locator('#dialog a').getByText('在X查看 ↗',{exact:true}).count(),1);}
   await page.screenshot({path:join(artifacts,kind+'-'+width+'.png'),fullPage:true});
  }
  for(const kind of ['pending-ready','pending-switch','pending-close','pending-rerender','pending-error','pending-dispose']){
   await page.evaluate(kind=>(window as any).fixture.show(kind),kind);const path='/'+kind+'.svg',first=page.locator('#dialog [data-x-image]').first();await first.scrollIntoViewIfNeeded();await expect.poll(()=>pending.has(path)).toBe(true);
   await first.locator('img').evaluate(image=>{(window as any).fixture.pendingImage=image;(image as any).__xNodeIdentity=true;});
   if(kind==='pending-switch')await page.waitForFunction(()=>{const image=document.querySelector<HTMLImageElement>('#dialog [data-x-image]:nth-child(2) img');return !!image?.complete&&image.naturalWidth>0;});
   const before=imageRequests.length;await first.click();await page.locator('.x-image-viewer[open] .x-viewer-status:not([hidden])').waitFor();assert.equal(await page.locator('.x-viewer-error').isVisible(),false);assert.equal(await page.locator('.x-viewer-stage img').evaluate(image=>(image as any).__xNodeIdentity),true);
   assert.equal(await page.evaluate(()=>(window as any).__imageListeners.get((window as any).fixture.pendingImage)?.size),2);
   if(kind==='pending-switch'){await page.keyboard.press('ArrowRight');await page.locator('.x-viewer-stage[data-state="ready"]').waitFor();assert.equal(await page.evaluate(()=>(window as any).__imageListeners.get((window as any).fixture.pendingImage)?.size),0);}
   if(kind==='pending-close')await page.keyboard.press('Escape');
   if(kind==='pending-rerender'){await page.evaluate(()=>(window as any).fixture.show('missing'));await page.waitForFunction(()=>!(document.querySelector('.x-image-viewer') as HTMLDialogElement).open);}
   if(kind==='pending-dispose'){await page.evaluate(()=>(window as any).fixture.unmount());assert.equal(await page.locator('.x-image-viewer').count(),0);}
   const delayed=pending.get(path)!;pending.delete(path);if(kind==='pending-error')await delayed.abort('failed');else await delayed.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#D9FF43"/><circle cx="320" cy="240" r="100" fill="#0B1F52"/></svg>'});
   if(kind==='pending-ready'){await page.locator('.x-viewer-stage[data-state="ready"]').waitFor();assert.equal(await page.locator('.x-viewer-stage img').evaluate(image=>image===(window as any).fixture.pendingImage&&(image as HTMLImageElement).naturalWidth>0),true);await page.screenshot({path:join(artifacts,'delayed-loaded-'+width+'.png'),fullPage:true});await page.keyboard.press('Escape');}
   if(kind==='pending-switch'){await page.waitForFunction(()=>(window as any).fixture.pendingImage.complete&&(window as any).fixture.pendingImage.naturalWidth>0);assert.equal(await page.locator('.x-viewer-counter').innerText(),'图片 2 / 2');assert.ok((await page.locator('.x-viewer-stage img').getAttribute('src'))?.endsWith('paper-0.svg'));assert.equal(await page.locator('.x-viewer-stage').getAttribute('data-state'),'ready');await page.keyboard.press('Escape');}
   if(kind==='pending-close'){await page.waitForFunction(()=>(window as any).fixture.pendingImage.complete&&(window as any).fixture.pendingImage.naturalWidth>0);assert.equal(await page.locator('.x-image-viewer').evaluate(viewer=>(viewer as HTMLDialogElement).open),false);assert.equal(await page.evaluate(()=>(window as any).fixture.pendingImage.hidden),false);}
   if(kind==='pending-rerender'){await page.evaluate(()=>(window as any).fixture.pendingImage.dispatchEvent(new Event('load')));assert.equal(await page.locator('.x-image-viewer').evaluate(viewer=>(viewer as HTMLDialogElement).open),false);assert.ok((await page.locator('#dialog').innerText()).includes('原作品当前不可用'));}
   if(kind==='pending-error'){await page.locator('.x-viewer-stage[data-state="error"] .x-viewer-error:not([hidden])').waitFor();assert.equal(await page.locator('.x-viewer-status').isVisible(),false);await page.keyboard.press('Escape');}
   if(kind==='pending-dispose'){await page.evaluate(()=>(window as any).fixture.pendingImage.dispatchEvent(new Event('load')));assert.equal(await page.locator('.x-image-viewer').count(),0);}
   assert.equal(imageRequests.length,before,'Pending viewer must reuse its original request');assert.equal(await page.evaluate(()=>(window as any).__imageListeners.get((window as any).fixture.pendingImage)?.size),0);
  }
  checks.push({width,reading_no_duplicate_body:true,quote_full_text:true,quote_images:4,author_attribution:true,saved_expanded_link:true,viewer_zero_requests:true,same_image_node:true,arrow_keys:true,escape_keeps_outer_dialog:true,focus_returns:true,focus_trap:true,...layout,repost:true,missing_original:true,missing_media:true,image_failure:true,video_controls_and_failure:true,pending_same_request_and_node:true,pending_release_without_reopen:true,late_load_after_switch_ignored:true,late_load_after_close_ignored:true,rerender_clears_pending_listener:true,dispose_clears_pending_listener:true,pending_error_separate:true,per_image_listeners_removed:true});
  assert.equal(await page.evaluate(()=>(window as any).fixture.requests.every((request:any)=>request.method==='GET')),true);
  assert.equal(await page.locator('.x-image-viewer').count(),0);await page.close();
 }
 const reduced=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});await reduced.route('https://images.fixture.invalid/**',route=>route.abort());await reduced.goto(url);await reduced.locator('.x-post-card').waitFor();assert.equal(await reduced.locator('canvas').count(),0);await reduced.screenshot({path:join(artifacts,'reduced-motion-390.png'),fullPage:true});await reduced.close();
 assert.deepEqual(errors,[]);writeFileSync(join(artifacts,'checks.json'),JSON.stringify({checks,reduced_motion_no_canvas:true,page_errors:errors,fixture_only:true,network:'Only local test server and intercepted media fixture responses'},null,2));
 console.log(JSON.stringify({passed:true,artifacts,checks:checks.length,reduced_motion:true}));
}finally{await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
