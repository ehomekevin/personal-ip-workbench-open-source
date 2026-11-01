// 网络找图缓存优先：接口只读缓存立即返回，资讯原文在后台读取；同主题并发请求只起一次抓取；成功 7 天过期后台重读，失败可见、可立即重试。
// 全部用注入的 FakeWeb，不发真实请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import {startStudioFixture} from './harness.ts';
import {FakeWeb,ARTICLE_URL,ARTICLE_HTML,seedWebSources} from './web-fixture.ts';
import {PAGE_SUCCESS_TTL_MS,PAGE_FAILURE_TTL_MS,WebCaptureRunner,webImageCandidateState,type WebImageOptions} from '../../packages/domain/src/artifact-execution/image-studio/web-images.ts';
import type {StudioWebImageCandidates} from '../../packages/contracts/src/index.ts';
type Fixture=Awaited<ReturnType<typeof startStudioFixture>>;
const read=async(f:Fixture,refresh=false)=>{const r=await f.call('GET','/api/v1/topics/'+f.topic.id+'/web-image-candidates'+(refresh?'?refresh=1':''));const v=await r.json() as StudioWebImageCandidates;assert.equal(r.status,200,JSON.stringify(v));return v;};
const settle=async(f:Fixture)=>{for(let i=0;i<400;i++){const v=await read(f);if(v.capture.state!=='refreshing')return v;await new Promise(r=>setTimeout(r,5));}throw new Error('后台读取原文未结束');};
const articles=(v:StudioWebImageCandidates)=>v.candidates.filter(c=>c.platform==='article');
function network(){const web=new FakeWeb();web.png('https://pbs.example/x1.png');web.png('https://pbs.example/q1.png');web.png('https://douyin.example/cover.png?x-expires=4102444800');return web;}
// 原文路由被闸门挡住：请求必须在原文读取结束前返回，证明接口不再同步等抓取。
function gated(web:FakeWeb,html=ARTICLE_HTML){let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});web.routes.set(ARTICLE_URL,async()=>{await gate;return new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}});});return release;}
async function start(web:FakeWeb,extra:Omit<WebImageOptions,'fetcher'|'lookup'>={}){const f=await startStudioFixture({auto_worker:false,web:{fetcher:web.fetcher,lookup:web.lookup,...extra}});seedWebSources(f.app.context,f.request(),f.topic.id,{searchText:'同题帖子：'+f.topic.title+' 的配图做法'});return f;}

test('no cache: the first read returns at once with refreshing and the already-stored post images; concurrent reads start exactly one capture; new article images appear after it finishes',async()=>{
 const web=network(),release=gated(web),f=await start(web);try{
  const first=await read(f);assert.equal(first.capture.state,'refreshing');assert.equal(articles(first).length,0,'原文还没读到');assert.ok(first.candidates.some(c=>c.platform==='x'),'已入库的帖子图立即可用');
  assert.deepEqual({total:first.capture.pages_total,ready:first.capture.pages_ready,failed:first.capture.pages_failed,at:first.capture.refreshed_at},{total:1,ready:0,failed:0,at:null});
  // 后台抓取在跑时再来 8 个并发请求：都报 refreshing，原文只请求一次。
  const burst=await Promise.all(Array.from({length:8},()=>read(f)));for(const v of burst)assert.equal(v.capture.state,'refreshing');
  await new Promise(r=>setTimeout(r,30));assert.equal(web.count(ARTICLE_URL),1,'同主题并发只起一次抓取');
  release();const done=await settle(f);assert.equal(done.capture.state,'fresh');assert.equal(articles(done).length,3);assert.equal(done.capture.pages_ready,1);assert.ok(done.capture.refreshed_at);
  assert.equal(web.count(ARTICLE_URL),1);
  // 有缓存后：直接 fresh，不再抓。
  const again=await read(f);assert.equal(again.capture.state,'fresh');assert.equal(articles(again).length,3);assert.equal(web.count(ARTICLE_URL),1);
 }finally{await f.close();}
});
test('two topics that cite the same article URL share one fetch while each topic has its own capture task',async()=>{
 const web=network(),release=gated(web),f=await start(web);try{
  const {Topics}=await import('../../packages/domain/src/topics/index.ts');const other=await new Topics(f.app.context).create(f.request(),{title:'另一个引用同一原文的主题',category:'AI实践',audience:'AI使用者',source_ids:[]});seedWebSources(f.app.context,f.request(),other.id,{searchText:'无关'});
  const a=await read(f),b=await (await f.call('GET','/api/v1/topics/'+other.id+'/web-image-candidates')).json() as StudioWebImageCandidates;assert.equal(a.capture.state,'refreshing');assert.equal(b.capture.state,'refreshing');
  await new Promise(r=>setTimeout(r,30));assert.equal(web.count(ARTICLE_URL),1,'同一原文 URL 进程内合并');release();assert.equal(articles(await settle(f)).length,3);
 }finally{await f.close();}
});
test('a failed capture is visible (failed + pages_failed), is not silently refetched within the cooldown, and refresh=1 retries immediately',async()=>{
 const web=network();web.routes.set(ARTICLE_URL,()=>new Response('down',{status:503,headers:{'content-type':'text/plain'}}));let clock=Date.parse('2026-10-14T00:00:00Z');const f=await start(web,{now:()=>clock});try{
  assert.equal((await read(f)).capture.state,'refreshing');const failed=await settle(f);assert.equal(failed.capture.state,'failed');assert.equal(failed.capture.pages_failed,1);assert.equal(articles(failed).length,0);assert.ok(failed.candidates.length>0,'失败时其余候选照常返回，不是空白');
  clock+=10*60*1000;assert.equal((await read(f)).capture.state,'failed');assert.equal(web.count(ARTICLE_URL),1,'冷却期内不自动重抓');
  web.html(ARTICLE_URL,ARTICLE_HTML);const retry=await read(f,true);assert.equal(retry.capture.state,'refreshing','用户重试立即重读');const ok=await settle(f);assert.equal(ok.capture.state,'fresh');assert.equal(articles(ok).length,3);assert.equal(web.count(ARTICLE_URL),2);
  assert.ok(PAGE_FAILURE_TTL_MS>10*60*1000);
 }finally{await f.close();}
});
test('success cache expires after 7 days: the read returns the old images at once and refreshes in the background; a failed refresh keeps the old images as stale and can be retried',async()=>{
 const web=network();web.html(ARTICLE_URL,ARTICLE_HTML);let clock=Date.parse('2026-10-14T00:00:00Z');const f=await start(web,{now:()=>clock});try{
  await read(f);const first=await settle(f);assert.equal(articles(first).length,3);assert.equal(web.count(ARTICLE_URL),1);
  clock+=PAGE_SUCCESS_TTL_MS-60*1000;assert.equal((await read(f)).capture.state,'fresh','7 天内直接复用');assert.equal(web.count(ARTICLE_URL),1);
  // 过期：先返回旧图并后台重读；新原文多了一张图。
  clock+=2*60*1000;const release=gated(web,ARTICLE_HTML.replace('</body>','<img src="https://news.example/new.png"></body>'));
  const expired=await read(f);assert.equal(expired.capture.state,'refreshing');assert.equal(articles(expired).length,3,'过期期间旧图照常可用');
  release();const refreshed=await settle(f);assert.equal(refreshed.capture.state,'fresh');assert.equal(articles(refreshed).length,4,'重读后的新图出现');assert.equal(web.count(ARTICLE_URL),2);
  // 再次过期且重读失败：保留旧图，报 stale；冷却期内不自动重抓；refresh=1 立即重试。
  clock+=PAGE_SUCCESS_TTL_MS+60*1000;web.routes.set(ARTICLE_URL,()=>new Response('down',{status:500,headers:{'content-type':'text/plain'}}));
  await read(f);const stale=await settle(f);assert.equal(stale.capture.state,'stale');assert.equal(articles(stale).length,4,'重读失败不覆盖旧图');assert.equal(web.count(ARTICLE_URL),3);
  assert.equal((await read(f)).capture.state,'stale');assert.equal(web.count(ARTICLE_URL),3);
  web.html(ARTICLE_URL,ARTICLE_HTML);assert.equal((await read(f,true)).capture.state,'refreshing');const back=await settle(f);assert.equal(back.capture.state,'fresh');assert.equal(articles(back).length,3);assert.equal(web.count(ARTICLE_URL),4);
 }finally{await f.close();}
});
test('closing the capture owner aborts an in-flight capture, waits for it and writes no failure cache; a closed owner starts no new capture',async()=>{
 const web=network();let started!:()=>void;const reached=new Promise<void>(r=>{started=r;});
 const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input instanceof Request?input.url:input);if(url!==ARTICLE_URL)return web.fetcher(input,init);web.calls.push(url);started();return await new Promise<Response>((_,reject)=>{init?.signal?.addEventListener('abort',()=>reject(init.signal!.reason),{once:true});});}) as typeof fetch;
 const f=await start(web);try{
  const runner=new WebCaptureRunner(),options={fetcher,lookup:web.lookup,runner},db=f.app.context.db,workspace=f.app.identity.workspace_id;
  const first=await webImageCandidateState(f.app.context,f.request(),f.topic.id,options);assert.equal(first.capture.state,'refreshing');await reached;
  const second=await webImageCandidateState(f.app.context,f.request(),f.topic.id,options);assert.equal(second.capture.state,'refreshing');assert.equal(runner.snapshot().in_flight,1,'同主题只有一个任务');
  await runner.close();assert.equal(runner.snapshot().in_flight,0);
  const payload=JSON.parse(String(db.prepare("SELECT payload FROM source_records WHERE workspace_id=? AND record_kind='site_event'").get(workspace)!.payload));assert.equal(payload.page_images,undefined,'中止不写原文缓存');
  assert.equal(db.prepare('SELECT value FROM application_metadata WHERE key=?').get('web-page-capture-failures.v1:'+workspace),undefined,'中止不记为原文读取失败');
  const after=await webImageCandidateState(f.app.context,f.request(),f.topic.id,options);assert.equal(runner.snapshot().in_flight,0,'关闭后不再起新抓取');assert.notEqual(after.capture.state,'refreshing');assert.equal(web.count(ARTICLE_URL),1);
 }finally{await f.close();}
});
