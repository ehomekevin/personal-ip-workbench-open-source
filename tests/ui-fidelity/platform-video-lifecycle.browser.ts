import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium,expect,type Route} from '@playwright/test';

const root=resolve(import.meta.dirname,'../..'),artifacts=join(root,'.ci-artifacts','platform-video-lifecycle-browser');
mkdirSync(artifacts,{recursive:true});
// Synthetic local media proves that future/unknown expiry does not disable working playback.
const sample=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0x0B1F52:s=320x240:r=20:d=3','-c:v','libvpx-vp9','-an','-f','webm','-']);
const fixture=`
import {createRoot} from 'react-dom/client';
import {Workbench} from './apps/web/src/app/Workbench.tsx';
import {createSourcesReadFeature} from './apps/web/src/features/sources/read/index.ts';
import {renderBenchmarkRecord} from './apps/web/src/components/benchmarkMaterials.ts';
import './apps/web/src/styles/approved.css';
const original='https://www.douyin.com/video/201';
const row={id:'201',record_kind:'douyin_video',external_id:'201',title:'保存的视频说明',summary:'保存的视频说明',category:'对标内容',author_name:'对标作者',published_at:'2026-10-13T03:00:00Z',updated_at:'2026-10-13T04:00:00Z',canonical_url:original,favorite:false,read:false,source_name:'对标作者',source_locations:[],content_status:'available',format:'short_video',media_type:'video',duration_ms:'3000',metrics:{likes:'0',plays:null}};
const record={...row,body:'这段完整说明在视频到期和播放失败后仍然保留。\\n'+('原始资料按自然顺序阅读。'.repeat(18)),external_links:[original],parser_warnings:[],media:[{type:'video',play_url:'https://media.fixture.invalid/expired.webm?signature=synthetic',preview_url:'https://images.fixture.invalid/cover.svg',expires_at:'2000-01-01T00:00:00Z',duration_ms:'3000'}],benchmark:{platform:'douyin',format:'short_video',collected_at:'2026-10-13T04:00:00Z',metrics:row.metrics}};
const f=window.fixture={context:null,requests:[],record};
const client={identity:async()=>({workspace_id:'video-fixture',service_instance_id:'video-fixture-service',contract_version:'fixture'}),request:async(method,path)=>{f.requests.push({method,path});if(method!=='GET')throw Error('Fixture permits only saved read requests');if(path.startsWith('/api/v1/source-records?'))return {items:[row],next_cursor:null};if(path==='/api/v1/source-records/201')return structuredClone(record);if(path.startsWith('/api/v1/accounts?'))return {items:[],next_cursor:null};throw Error('Unexpected fixture request');}};
const feature=createSourcesReadFeature(),load=feature.load;feature.load=async context=>{f.context=context;return load(context);};
const host=createRoot(document.getElementById('root'));host.render(<Workbench injection={{mode:'real',client,initialPage:'sources',features:{sources:feature}}}/>);
f.show=kind=>{const saved=structuredClone(record);if(kind!=='expired'){saved.media[0].play_url='https://media.fixture.invalid/'+kind+'.webm?signature=synthetic';saved.media[0].expires_at=kind==='unknown'?null:'2099-01-01T00:00:00Z';}f.context.surface.presentDialog({title:'保存的视频 · '+kind,body:renderBenchmarkRecord(saved),foot:'<button class="button" data-action="close-dialog">关闭</button>'});};
`;
const built=await build({absWorkingDir:root,stdin:{contents:fixture,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:artifacts,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});
const js=built.outputFiles!.find(file=>file.path.endsWith('.js'))!.text,css=built.outputFiles!.find(file=>file.path.endsWith('.css'))!.text;
const html='<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script type="module">'+js+'</script></html>';
const server=createServer((request,response)=>{
 if(request.url?.startsWith('/workbench/')){try{const file=join(root,'apps/web/public',request.url);response.writeHead(200,{'Content-Type':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.woff2')?'font/woff2':'image/webp'});response.end(readFileSync(file));}catch{response.writeHead(404).end();}return;}
 response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);
});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
const browser=await chromium.launch({headless:true}),checks:unknown[]=[],errors:string[]=[];
const deliver=async(route:Route)=>{
 const range=route.request().headers().range,match=range?.match(/^bytes=(\d+)-(\d*)$/),start=match?Number(match[1]):0,end=match?.[2]?Math.min(Number(match[2]),sample.length-1):sample.length-1;
 const headers={'Content-Type':'video/webm','Accept-Ranges':'bytes',...(match?{'Content-Range':'bytes '+start+'-'+end+'/'+sample.length}:{})};
 await route.fulfill({status:match?206:200,headers,body:sample.subarray(start,end+1)});
};
try{
 for(const width of [390,768,1440]){
  const context=await browser.newContext({viewport:{width,height:width===390?844:1000}}),page=await context.newPage();
  let paid=0,expiredRequests=0,held:Route|undefined;const mediaRequests:string[]=[];
  context.on('request',request=>{const u=new URL(request.url());if(u.hostname.includes('tikhub'))paid++;if(u.hostname==='media.fixture.invalid'){mediaRequests.push(u.pathname);if(u.pathname==='/expired.webm')expiredRequests++;}});
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('https://api.tikhub.io/**',route=>route.abort());
  await context.route('https://www.douyin.com/video/201',route=>route.fulfill({contentType:'text/html',body:'<title>平台原网页 fixture</title><p>原网页入口已打开</p>'}));
  await context.route('https://images.fixture.invalid/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#D9FF43"/><rect x="35" y="35" width="250" height="110" rx="15" fill="#0B1F52"/></svg>'}));
  await context.route('https://media.fixture.invalid/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname==='/blocked.webm')return route.fulfill({status:403,contentType:'text/plain',body:'fixture forbidden'});
   if(pathname==='/loading.webm'){held=route;return;}
   return deliver(route);
  });
  await page.goto(url);await page.locator('.article [data-video-state="expired"]').waitFor();
  assert.equal(await page.locator('.article video').count(),0);await expect(page.locator('.article .benchmark-video-original')).toHaveAttribute('href','https://www.douyin.com/video/201');
  await page.screenshot({path:join(artifacts,'reader-expired-'+width+'.png'),fullPage:true});
  for(let i=0;i<2;i++)await page.evaluate(()=>(window as any).fixture.show('expired'));
  await page.locator('#dialog [data-video-state="expired"]').waitFor();assert.equal(await page.locator('#dialog video').count(),0);
  const fallback=page.locator('#dialog .benchmark-video-original');await fallback.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await expect(fallback).toBeFocused();
  const popupPromise=page.waitForEvent('popup');await page.keyboard.press('Enter');const popup=await popupPromise;await popup.waitForLoadState();assert.equal(popup.url(),'https://www.douyin.com/video/201');await popup.close();
  await page.screenshot({path:join(artifacts,'expired-keyboard-'+width+'.png'),fullPage:true});
  assert.equal(expiredRequests,0);assert.equal(paid,0);
  const box=await page.locator('#dialog figure').boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width+1);
  await page.evaluate(()=>(window as any).fixture.show('loading'));const loading=page.locator('#dialog video');await loading.evaluate(v=>{void (v as HTMLVideoElement).play().catch(()=>{});});
  await expect.poll(()=>!!held).toBe(true);await expect(page.locator('#dialog .benchmark-video-original')).toBeVisible();assert.equal(await page.locator('#dialog .benchmark-media-error').isVisible(),false);
  await page.screenshot({path:join(artifacts,'loading-'+width+'.png'),fullPage:true});await deliver(held!);held=undefined;
  await page.waitForFunction(()=>{const v=document.querySelector<HTMLVideoElement>('#dialog video');return v&&v.currentTime>0.3&&v.readyState>=2;});
  for(const kind of ['unknown','valid']){
   await page.evaluate(kind=>(window as any).fixture.show(kind),kind);const video=page.locator('#dialog video');assert.equal(await video.getAttribute('preload'),'none');assert.equal(await video.getAttribute('controls'),'');
   await video.evaluate(v=>(v as HTMLVideoElement).play());await page.waitForFunction(()=>document.querySelector<HTMLVideoElement>('#dialog video')!.currentTime>0.3);
   await video.evaluate(v=>{(v as HTMLVideoElement).currentTime=1.8;});await page.waitForFunction(()=>document.querySelector<HTMLVideoElement>('#dialog video')!.currentTime>2);
   const frames=await video.evaluate(v=>(v as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames);assert.ok(frames>0);assert.equal(await page.locator('#dialog .benchmark-media-error').isVisible(),false);
   await page.screenshot({path:join(artifacts,kind+'-'+width+'.png'),fullPage:true});
  }
  await page.evaluate(()=>(window as any).fixture.show('blocked'));await page.locator('#dialog video').evaluate(v=>{void (v as HTMLVideoElement).play().catch(()=>{});});
  await page.locator('#dialog .benchmark-media-error:not([hidden])').waitFor();await expect(page.locator('#dialog .benchmark-video-original')).toBeVisible();assert.ok((await page.locator('#dialog .configuration-material-body').textContent())?.includes('仍然保留'));
  await page.screenshot({path:join(artifacts,'blocked-'+width+'.png'),fullPage:true});
  assert.equal(paid,0);assert.equal(expiredRequests,0);assert.equal(context.pages().length,1);assert.equal(await page.evaluate(()=>(window as any).fixture.requests.filter((r:any)=>r.method!=='GET').length),0);
  checks.push({width,expired_cdn_requests:expiredRequests,tikhub_requests:paid,source_reader_fallback:true,keyboard_opens_original:true,no_auto_external_page:true,loading_fallback_visible:true,error_preserves_body:true,synthetic_valid_and_unknown_playback_and_seek:true,media_request_paths:mediaRequests});
  await context.close();
 }
 assert.deepEqual(errors,[]);writeFileSync(join(artifacts,'report.json'),JSON.stringify({fixture:true,real_platform_playback_verified:false,checks,errors},null,2)+'\n');
 process.stdout.write(JSON.stringify({artifacts,viewports:checks.length,passed:true,real_platform_playback_verified:false})+'\n');
}finally{await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
