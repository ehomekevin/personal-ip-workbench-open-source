import test from '../helpers/media-tools.ts'; // 导入后读取真实图片宽高；缺 ffmpeg/ffprobe 时跳过
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {startStudioFixture} from './harness.ts';
import {FakeWeb,ARTICLE_URL,ARTICLE_HTML,seedWebSources} from './web-fixture.ts';
import {WebDnsGuard,FAKE_IP_UNRESOLVED} from '../../packages/adapters/src/web/public-fetch.ts';
import type {WebImageOptions} from '../../packages/domain/src/artifact-execution/image-studio/web-images.ts';
import {Topics} from '../../packages/domain/src/topics/index.ts';
import type {StudioSnapshot,StudioWebImageCandidate,StudioWebImageCandidates,StudioWebImportResult} from '../../packages/contracts/src/index.ts';
type Fixture=Awaited<ReturnType<typeof startStudioFixture>>;
async function json<T>(response:Response,status=200):Promise<T>{const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;}
const snapshot=(f:Fixture)=>f.call('GET','/api/v1/image-studio?topic_id='+f.topic.id).then(r=>json<StudioSnapshot>(r));
// 找图接口先返回缓存、原文在后台读取（capture.state=refreshing）；这里读到后台读取结束为止，断言的是读取完成后的候选。
const candidates=async(f:Fixture,topic=f.topic.id)=>{for(let i=0;;i++){const v=await f.call('GET','/api/v1/topics/'+topic+'/web-image-candidates').then(r=>json<StudioWebImageCandidates>(r));if(v.capture.state!=='refreshing')return v.candidates;if(i>400)throw new Error('后台读取原文未结束');await new Promise(r=>setTimeout(r,5));}};
const importOne=(f:Fixture,c:StudioWebImageCandidate,expected:number,slot:string|null=null,key=randomUUID(),topic=f.topic.id)=>f.call('POST','/api/v1/image-studio/web-imports',{topic_id:topic,expected_version:expected,slot_id:slot,candidate:{candidate_id:c.candidate_id,image_url:c.image_url}},key);
const assetCount=(f:Fixture)=>Number(f.app.context.db.prepare('SELECT COUNT(*) AS n FROM assets WHERE workspace_id=?').get(f.app.identity.workspace_id)!.n);
function network(){const web=new FakeWeb();web.html(ARTICLE_URL,ARTICLE_HTML);web.png('https://news.example/og.png',64,40);web.png('https://news.example/tw.png',40,40,[200,0,0]);web.png('https://news.example/in2.png');
 const shared=web.png('https://pbs.example/x1.png',48,32,[10,20,30]);web.routes.set('https://pbs.example/q1.png',()=>new Response(new Uint8Array(shared),{headers:{'content-type':'image/png'}}));web.png('https://douyin.example/cover.png?x-expires=4102444800',30,40);web.png('https://douyin.example/old.png?x-expires=1000000000');return web;}
async function start(web=network(),extra:Omit<WebImageOptions,'fetcher'|'lookup'>={}){const f=await startStudioFixture({auto_worker:false,web:{fetcher:web.fetcher,lookup:web.lookup,...extra}});seedWebSources(f.app.context,f.request(),f.topic.id,{searchText:'同题帖子：'+f.topic.title+' 的配图做法'});return{f,web};}

test('candidates come from linked article pages, linked X posts (incl. quoted) and same-topic Douyin works; article capture is cached; no TikHub call',async()=>{
 const {f,web}=await start();try{const list=await candidates(f);
  assert.deepEqual(list.map(c=>c.platform),['article','article','article','x','x','douyin','douyin']);for(const c of list){assert.ok(c.credit_label.startsWith('图源：'));assert.match(c.page_url,/^https:\/\//);}
  assert.equal(list[0]!.credit_label,'图源：Example News');assert.equal(list[0]!.page_url,ARTICLE_URL);assert.equal(list[0]!.page_title,'原文标题 · 新闻');
  const x=list.filter(c=>c.platform==='x');assert.deepEqual(x.map(c=>c.credit_label),['图源：X @alice','图源：X @bob']);assert.equal(x[1]!.page_url,'https://x.com/bob/status/2002');assert.equal(x[0]!.width,48);
  const dy=list.filter(c=>c.platform==='douyin');assert.deepEqual(dy.map(c=>[c.credit_label,c.availability]),[['图源：抖音 @抖音作者','expired'],['图源：抖音 @抖音作者','available']]);assert.ok(dy[0]!.expires_at);
  assert.equal(web.count(ARTICLE_URL),1);assert.equal(web.count('https://x.com'),0);await candidates(f);assert.equal(web.count(ARTICLE_URL),1,'原文只抓一次');assert.equal(web.calls.some(u=>u.includes('tikhub')),false);
  const row=f.app.context.db.prepare("SELECT payload FROM source_records WHERE workspace_id=? AND record_kind='site_event'").get(f.app.identity.workspace_id)!;const cache=JSON.parse(String(row.payload)).page_images[ARTICLE_URL];assert.ok(cache.captured_at);assert.equal(cache.images.length,3);
 }finally{await f.close();}
});
test('failed article capture is cached for one hour, then retried; topic without data returns an empty list',async()=>{
 const web=network();web.routes.delete(ARTICLE_URL);let clock=Date.parse('2026-10-14T00:00:00Z');const {f}=await start(web,{now:()=>clock});try{const list=await candidates(f);assert.equal(list.filter(c=>c.platform==='article').length,0);
  clock+=59*60*1000;await candidates(f);assert.equal(web.count(ARTICLE_URL),1,'1 小时内失败缓存不重抓');
  web.html(ARTICLE_URL,ARTICLE_HTML);clock+=2*60*1000;assert.equal((await candidates(f)).filter(c=>c.platform==='article').length,3,'超过 1 小时重试成功');assert.equal(web.count(ARTICLE_URL),2);
  clock+=48*3600*1000;await candidates(f);assert.equal(web.count(ARTICLE_URL),2,'成功结果长期复用');
  const empty=await new Topics(f.app.context).create(f.request(),{title:'完全无关的主题',category:'AI实践',audience:'AI使用者',source_ids:[]});assert.deepEqual(await candidates(f,empty.id),[]);
  await json(await f.call('GET','/api/v1/topics/'+randomUUID()+'/web-image-candidates'),404);
 }finally{await f.close();}
});
test('import downloads once, saves origin=web asset with source; replay does not re-download; same bytes reuse one asset with per-version source; adopt/rollback/final keep source',async()=>{
 const {f,web}=await start();try{const list=await candidates(f),x=list.find(c=>c.credit_label==='图源：X @alice')!,quoted=list.find(c=>c.credit_label==='图源：X @bob')!;let s=await snapshot(f);
  const key=randomUUID(),first=await json<StudioWebImportResult>(await importOne(f,x,s.version,null,key),201);assert.equal(web.count('https://pbs.example/x1.png'),1);assert.equal(first.deduplicated,false);
  assert.deepEqual(await json(await importOne(f,x,s.version,null,key),201),first);assert.equal(web.count('https://pbs.example/x1.png'),1,'幂等重放不重复下载');
  const asset=f.app.context.db.prepare('SELECT origin,generation_metadata FROM assets WHERE id=?').get(first.asset_id)!;assert.equal(asset.origin,'web');assert.equal(JSON.parse(String(asset.generation_metadata)).source_kind,'web_reference');
  const second=await json<StudioWebImportResult>(await importOne(f,quoted,first.version,first.slot_id),201);assert.equal(second.asset_id,first.asset_id);assert.equal(second.deduplicated,true);assert.equal(assetCount(f),1);
  assert.equal(Number(f.app.context.db.prepare('SELECT COUNT(*) AS n FROM topic_asset_links WHERE topic_id=? AND asset_id=?').get(f.topic.id,first.asset_id)!.n),1);
  s=await snapshot(f);const versions=s.slots[0]!.versions;assert.equal(versions.length,2);for(const v of versions){assert.equal(v.operation,'web_import');assert.equal(v.job_id,null);assert.equal(v.state,'succeeded');assert.deepEqual(v.actual_size,{width:48,height:32,aspect_ratio:'48:32'});}
  assert.deepEqual(versions.map(v=>v.source!.credit_label),['图源：X @alice','图源：X @bob']);assert.deepEqual(versions.map(v=>v.source!.page_url),['https://x.com/alice/status/1001','https://x.com/bob/status/2002']);assert.equal(versions[0]!.source!.platform,'x');assert.ok(versions[0]!.source!.captured_at);
  const adopt=(snap:StudioSnapshot,id:string)=>f.call('POST','/api/v1/image-studio/slots/'+snap.slots[0]!.id+'/adopt',{topic_id:snap.topic_id,expected_version:snap.version,version_id:id});
  s=await json<StudioSnapshot>(await adopt(s,versions[1]!.id));assert.equal(s.slots[0]!.active_version_id,versions[1]!.id);s=await json<StudioSnapshot>(await adopt(s,versions[0]!.id));assert.equal(s.slots[0]!.active_version_id,versions[0]!.id);
  const done=await json<StudioSnapshot>(await f.call('POST','/api/v1/image-studio/confirm-final',{topic_id:s.topic_id,document_revision_id:s.document_revision_id,expected_version:s.version,confirmed:true}));const record=readFileSync(done.recording.wiki_record!,'utf8');assert.match(record,/"operation": "web_import"/);assert.match(record,/图源：X @alice/);assert.match(record,/https:\/\/x\.com\/alice\/status\/1001/);
  const article=list.find(c=>c.platform==='article')!,third=await json<StudioWebImportResult>(await importOne(f,article,done.version),201);assert.notEqual(third.slot_id,first.slot_id);assert.equal((await snapshot(f)).slots[1]!.versions[0]!.source!.credit_label,'图源：Example News');
  assert.equal(f.image_calls,0);
 }finally{await f.close();}
});
test('expired, unknown, stale and cross-workspace candidates are rejected without download',async()=>{
 const {f,web}=await start();const other=await start();try{const list=await candidates(f),s=await snapshot(f),expired=list.find(c=>c.availability==='expired')!;
  await json(await importOne(f,expired,s.version),400);assert.equal(web.count('https://douyin.example/old.png'),0);
  await json(await importOne(f,{...list[3]!,candidate_id:'0'.repeat(32)},s.version),404);await json(await importOne(f,{...list[3]!,image_url:'https://pbs.example/other.png'},s.version),404);
  await json(await importOne(f,list[3]!,s.version+5),409);
  const os=await snapshot(other.f);await json(await importOne(other.f,list[3]!,os.version),404,);await json(await importOne(other.f,list[3]!,1,null,randomUUID(),f.topic.id),404);await json(await other.f.call('GET','/api/v1/topics/'+f.topic.id+'/web-image-candidates'),404);
  assert.equal(web.count('https://pbs.example'),0);assert.equal(assetCount(f),0);assert.equal(assetCount(other.f),0);
 }finally{await f.close();await other.f.close();}
});
test('download guard failures reject at HTTP level and store nothing',async()=>{
 const cases:Array<[string,(web:FakeWeb,url:string)=>void]>=[
  ['https://loop.example/a.png',(w)=>w.hosts.set('loop.example',['127.0.0.1'])],['https://ten.example/a.png',(w)=>w.hosts.set('ten.example',['10.0.0.9'])],['https://meta.example/a.png',(w)=>w.hosts.set('meta.example',['169.254.169.254'])],['https://six.example/a.png',(w)=>w.hosts.set('six.example',['::1'])],['https://10.0.0.1/a.png',()=>{}],
  ['https://redir.example/a.png',(w,u)=>{w.hosts.set('inner.example',['10.1.1.1']);w.png('https://inner.example/a.png');w.routes.set(u,()=>new Response(null,{status:302,headers:{location:'https://inner.example/a.png'}}));}],
  ['https://big.example/a.png',(w,u)=>w.routes.set(u,()=>new Response('x',{headers:{'content-type':'image/png','content-length':String(64*1024*1024)}}))],
  ['https://mime.example/a.png',(w,u)=>w.routes.set(u,()=>new Response('<html></html>',{headers:{'content-type':'text/html'}}))],
  ['https://magic.example/a.png',(w,u)=>w.routes.set(u,()=>new Response('GIF89a-not-png',{headers:{'content-type':'image/png'}}))],
 ];
 const web=new FakeWeb();for(const [url,setup] of cases){if(!url.includes('10.0.0.1'))web.png(url);setup(web,url);}
 const f=await startStudioFixture({auto_worker:false,web:{fetcher:web.fetcher,lookup:web.lookup}});try{seedWebSources(f.app.context,f.request(),f.topic.id,{searchText:f.topic.title,douyinMedia:cases.map(([url])=>({type:'image',url}))});
  const list=(await candidates(f)).filter(c=>c.platform==='douyin');assert.equal(list.length,cases.length);
  for(const c of list){const s=await snapshot(f),body=await json<{error:{code:string;message:string}}>(await importOne(f,c,s.version),400);assert.equal(body.error.code,'VALIDATION_ERROR',c.image_url);}
  assert.equal(assetCount(f),0);assert.equal((await snapshot(f)).slots.length,0);for(const host of ['loop','ten','meta','six','inner'])assert.equal(web.count('https://'+host+'.example'),0,host);
 }finally{await f.close();}
});
test('two different keys racing on one expected_version: the later one gets 409, rolls back and leaves no orphan asset or file',async()=>{
 const web=network();let reached!:()=>void,release!:()=>void;const atFetch=new Promise<void>(r=>{reached=r;}),gate=new Promise<void>(r=>{release=r;});const held=web.routes.get('https://pbs.example/x1.png')!;web.routes.set('https://pbs.example/x1.png',async()=>{reached();await gate;return held();});
 const {f}=await start(web);try{const list=await candidates(f),x=list.find(c=>c.credit_label==='图源：X @alice')!,og=list.find(c=>c.platform==='article')!,s=await snapshot(f);
  const slow=importOne(f,x,s.version);await atFetch;const fast=await json<StudioWebImportResult>(await importOne(f,og,s.version),201);release();const late=await slow;assert.equal(late.status,409,await late.clone().text());
  assert.equal(assetCount(f),1);assert.equal(Number(f.app.context.db.prepare('SELECT COUNT(*) AS n FROM topic_asset_links WHERE workspace_id=?').get(f.app.identity.workspace_id)!.n),1);
  const after=await snapshot(f);assert.equal(after.slots.length,1);assert.equal(after.slots[0]!.versions.length,1);assert.equal(after.version,fast.version);
  const paths=f.app.context.paths;assert.deepEqual(readdirSync(paths.media_root!).filter(n=>!n.startsWith('.')),[fast.asset_id]);const staging=join(paths.state_root,'media-import-staging');assert.deepEqual(existsSync(staging)?readdirSync(staging):[],[]);assert.equal(existsSync(join(paths.state_root,'media-import-quarantine')),false);
 }finally{await f.close();}
});
test('concurrent candidate reads merge into one article fetch; signed article image expiry is honoured; oversized page is truncated and flagged',async()=>{
 const web=network();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const page=ARTICLE_HTML.replace('<img data-src="in2.png"','<img src="https://news.example/old.png?x-expires=1000000000"><img data-src="in2.png"');web.routes.set(ARTICLE_URL,async()=>{await gate;return new Response(page+'<!--'+'x'.repeat(4096)+'-->',{headers:{'content-type':'text/html'}});});
 const {f}=await start(web,{max_page_bytes:Buffer.byteLength(page)});try{const both=Promise.all([candidates(f),candidates(f)]);await new Promise(r=>setTimeout(r,200));release();const [a,b]=await both;assert.equal(web.count(ARTICLE_URL),1,'并发合并为一次抓取');assert.deepEqual(a.map(c=>c.candidate_id),b.map(c=>c.candidate_id));
  const article=a.filter(c=>c.platform==='article');assert.equal(article.length,4);for(const c of article)assert.equal(c.truncated,true,'超过网页上限时截断后继续解析，并在候选上标 truncated');
  const old=article.find(c=>c.image_url.includes('old.png'))!;assert.equal(old.availability,'expired');assert.ok(old.expires_at);assert.equal(article.find(c=>c.image_url.endsWith('/og.png'))!.availability,'unknown');
  await json(await importOne(f,old,(await snapshot(f)).version),400);assert.equal(web.count('https://news.example/old.png'),0);
  assert.equal((await candidates(f)).some(c=>c.truncated),true);assert.equal(web.count(ARTICLE_URL),1);
 }finally{await f.close();}
});
test('a lost response is replayed with the frozen key and body: same result, no new version, no second download; a failed attempt does not poison its key',async()=>{
 const web=network();const ok=web.routes.get('https://pbs.example/x1.png')!;web.routes.set('https://pbs.example/x1.png',()=>new Response('down',{status:503,headers:{'content-type':'text/plain'}}));
 const {f}=await start(web);try{const list=await candidates(f),x=list.find(c=>c.credit_label==='图源：X @alice')!,og=list.find(c=>c.platform==='article')!;let s=await snapshot(f);
  const failedKey=randomUUID();await json(await importOne(f,x,s.version,null,failedKey),400);web.routes.set('https://pbs.example/x1.png',ok);
  const lost=await json<StudioWebImportResult>(await importOne(f,x,s.version,null,failedKey),201);
  await json(await importOne(f,og,lost.version,lost.slot_id),201);const before=await snapshot(f),downloads=web.count('https://pbs.example/x1.png');
  assert.deepEqual(await json(await importOne(f,x,s.version,null,failedKey),201),lost,'原键原请求体重放返回原结果');
  const after=await snapshot(f);assert.equal(after.version,before.version);assert.equal(after.slots.flatMap(x=>x.versions).length,2);assert.equal(web.count('https://pbs.example/x1.png'),downloads);
 }finally{await f.close();}
});
test('a failed article capture is shared per workspace + URL: another topic/record citing the same URL is not refetched within one hour',async()=>{
 const web=network();web.routes.delete(ARTICLE_URL);let clock=Date.parse('2026-10-14T00:00:00Z');const {f}=await start(web,{now:()=>clock});try{
  const other=await new Topics(f.app.context).create(f.request(),{title:'另一个引用同一原文的主题',category:'AI实践',audience:'AI使用者',source_ids:[]});seedWebSources(f.app.context,f.request(),other.id,{searchText:'无关'});
  const rows=f.app.context.db.prepare("SELECT COUNT(DISTINCT r.id) AS n FROM topic_sources ts JOIN source_records r ON r.id=ts.source_record_id WHERE r.record_kind='site_event' AND ts.workspace_id=?").get(f.app.identity.workspace_id)!;assert.equal(Number(rows.n),2,'两条不同资讯记录引用同一原文 URL');
  await candidates(f);assert.equal(web.count(ARTICLE_URL),1);
  clock+=30*60*1000;await candidates(f,other.id);assert.equal(web.count(ARTICLE_URL),1,'另一主题的另一条记录 1 小时内不重抓');
  clock+=31*60*1000;web.html(ARTICLE_URL,ARTICLE_HTML);assert.equal((await candidates(f,other.id)).filter(c=>c.platform==='article').length,3);assert.equal(web.count(ARTICLE_URL),2,'超过 1 小时后重试');
  const shared=JSON.parse(String(f.app.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get('web-page-capture-failures.v1:'+f.app.identity.workspace_id)!.value));assert.equal(shared[ARTICLE_URL],undefined,'成功后清除共享失败记录');
 }finally{await f.close();}
});
test('fake-IP environment with both DoH resolvers down: article capture fails with the fake-IP message, is cached as a shared failure, and /health reports dns_mode',async()=>{
 const web=network();web.lookup=async()=>[{address:'198.18.0.53',family:4}];let doh=0;const dns=new WebDnsGuard({doh:async()=>{doh++;throw new Error('doh down');}});
 const {f}=await start(web,{dns});try{
  const before=await json<{modules:Array<{module:string;details?:Record<string,unknown>}>}>(await f.call('GET','/health'));assert.equal(before.modules.find(m=>m.module==='image-studio')?.details?.dns_mode,undefined,'首次抓取前不报');
  assert.equal((await candidates(f)).filter(c=>c.platform==='article').length,0);assert.equal(web.count(ARTICLE_URL),0,'DoH 失败不发原文请求');assert.ok(doh>=1);
  const shared=JSON.parse(String(f.app.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get('web-page-capture-failures.v1:'+f.app.identity.workspace_id)!.value));assert.equal(shared[ARTICLE_URL].error,FAKE_IP_UNRESOLVED);
  const calls=doh;await candidates(f);assert.equal(doh,calls,'失败缓存期内不再二次解析');
  const health=await json<{modules:Array<{module:string;details?:Record<string,unknown>}>}>(await f.call('GET','/health'));assert.equal(health.modules.find(m=>m.module==='image-studio')?.details?.dns_mode,'fake_ip_doh');
 }finally{await f.close();}
});
