import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {fixture} from '../documents/harness.ts';
import {Sources} from '../../packages/domain/src/sources/index.ts';
import {AccountChecks} from '../../packages/domain/src/sources/account-checks.ts';
import {BenchmarkSync} from '../../packages/domain/src/sources/benchmark-sync.ts';
import {TikHubAdapter} from '../../packages/adapters/src/tikhub/index.ts';
import {parseAccountProfile} from '../../packages/adapters/src/tikhub/profile.ts';
import {parseBenchmarkFeed} from '../../packages/adapters/src/tikhub/benchmark-feed.ts';
import {readAccountProfile} from '../../packages/domain/src/sources/account-profiles.ts';
import {DurableWorker} from '../../apps/service/src/worker/core/index.ts';
import {renderBenchmarkAccounts,renderBenchmarkRecord,renderBenchmarkExtras} from '../../apps/web/src/components/benchmarkMaterials.ts';
const at='2026-10-13T00:00:00Z',url='https://x.com/bench';
const profile={status:'active',profile:'bench',rest_id:'123',name:'平台昵称',desc:'完整简介\n第二行',avatar:'https://pbs.twimg.com/avatar.jpg',sub_count:0,friends:4,statuses_count:120,blue_verified:true};
const tweet=(id:string)=>({tweet_id:id,text:'平台作品 '+id,created_at:at,author:{id_str:'123',screen_name:'bench',name:'平台昵称'},favorites:0});
function setup(){const f=fixture(),sources=new Sources(f.context()),id=sources.createAccount(f.request(),{role:'benchmark',platform:'x',url,name:'登记名'}).account_id;f.context().db.prepare("UPDATE accounts SET platform_account_id='123',identity_status='confirmed' WHERE id=?").run(id);return {...f,id,sources};}
const worker=(f:ReturnType<typeof setup>,sync:BenchmarkSync)=>new DurableWorker(f.context(),[{registration:{kind:'benchmark_sync',execution_mode:'programmatic',recovery:'read_only'},async execute(e){await sync.execute(e.claim.job.id,JSON.parse(e.claim.job.input_manifest),{fence:e.claim.fence,signal:e.signal,checkpoint:e.checkpoint});return {documents:[],recommendations:[]};}}]);
test('平台资料保留完整简介与真实零值；错误身份和危险头像地址不能采用',()=>{
 const p=parseAccountProfile('x','123',url,{data:profile},at,'real_platform')!;assert.equal(p.display_name,'平台昵称');assert.equal(p.bio,'完整简介\n第二行');assert.equal(p.followers,'0');assert.equal(p.works,'120');assert.equal(p.likes,null);assert.equal(p.verification_label,'X 蓝标');
 assert.throws(()=>parseAccountProfile('x','999',url,{data:profile},at,'real_platform'),{code:'CAPABILITY_UNVERIFIED'});
 const unsafe=parseAccountProfile('x','123',url,{data:{...profile,avatar:'https://user:secret@example.com/a',website:'javascript:alert(1)',sub_count:Number.MAX_SAFE_INTEGER+1}},at,'real_platform')!;assert.equal(unsafe.avatar_url,null);assert.equal(unsafe.website,null);assert.equal(unsafe.followers,null);
 const sec='MS4w'+'a'.repeat(20),dy=parseAccountProfile('douyin','123','https://www.douyin.com/user/'+sec,{data:{user:{uid:'123',sec_uid:sec,nickname:'昵称',signature:'平台简介',follower_count:9,aweme_count:11,total_favorited:0,avatar_thumb:{url_list:['https://p3-pc.douyinpic.com/avatar.jpeg']}}}},at,'real_platform')!;assert.equal(dy.likes,'0');assert.equal(dy.following,null);assert.equal(dy.avatar_url,'https://p3-pc.douyinpic.com/avatar.jpeg');
});
test('真实身份核对后的资料从账号 API 回读，重启保留；旧回执也能读取且 hash 变化后拒绝',async()=>{
 const f=setup();try{
  const adapter=new TikHubAdapter({fixture:true,token_provider:()=> 'token',fetcher:async()=>new Response(JSON.stringify({code:200,data:profile}))});
  await new AccountChecks(f.context(),adapter).check(f.request(),f.id);assert.equal(f.sources.accounts(f.request()).items[0]!.profile?.display_name,'平台昵称');f.reopen();assert.equal(new Sources(f.context()).accounts(f.request()).items[0]!.profile?.works,'120');
  f.context().db.prepare("DELETE FROM application_metadata WHERE key LIKE 'account-profile.v1:%'").run();const row=f.context().db.prepare('SELECT * FROM accounts WHERE id=?').get(f.id)!;assert.equal(readAccountProfile(f.context(),row as any)?.bio,profile.desc);
  const loc=JSON.parse(String(f.context().db.prepare("SELECT locator FROM evidence_links WHERE owner_type='account' AND owner_id=? LIMIT 1").get(f.id)!.locator));writeFileSync(loc.raw_response_ref.path,'{}');assert.equal(readAccountProfile(f.context(),row as any),null);
 }finally{f.cleanup();}
});
test('作品保留平台视频/图片、引用和字幕；抖音占位播放零值不冒充已观察播放数',()=>{
 const x=parseBenchmarkFeed('x',url,'123',{data:{timeline:[{...tweet('101'),quotes:0,bookmarks:2,views:0,quoted:{text:'引用原话',tweet_id:'999',author:{name:'引用作者'}},media:{photo:[{media_url_https:'https://pbs.twimg.com/p.jpg'}],video:[{media_url_https:'https://pbs.twimg.com/v.jpg',duration:4000,variants:[{content_type:'video/mp4',bitrate:100,url:'https://video.twimg.com/v.mp4'}]}]}}],next_cursor:'opaque-page-2'}});
 assert.equal(x.next_cursor,'opaque-page-2');assert.equal(x.records[0]!.payload.provider_metadata.quoted_text,'引用原话');assert.equal(x.records[0]!.payload.media.length,2);assert.equal(x.records[0]!.payload.media[1]!.play_url,'https://video.twimg.com/v.mp4');assert.equal((x.records[0]!.payload.provider_metadata.metrics as any).views,'0');
 const sec='MS4w'+'a'.repeat(20),d=parseBenchmarkFeed('douyin','https://www.douyin.com/user/'+sec,'123',{data:{has_more:1,max_cursor:12345,aweme_list:[{aweme_id:'201',desc:'平台视频说明',create_time:1720000000,author:{uid:'123',sec_uid:sec},statistics:{digg_count:0,play_count:0},video_text:[{text:'字幕原文'}],video:{duration:5000,cover:{url_list:['https://p3-pc.douyinpic.com/c.jpg']},play_addr:{url_list:['https://v5-dy.zjcdn.com/v.mp4']}}}]}});
 assert.equal(d.next_cursor,'12345');assert.equal((d.records[0]!.payload.provider_metadata.metrics as any).likes,'0');assert.equal((d.records[0]!.payload.provider_metadata.metrics as any).plays,null);assert.equal(d.records[0]!.payload.provider_metadata.platform_caption,'字幕原文');assert.equal(d.records[0]!.payload.media[1]!.play_url,'https://v5-dy.zjcdn.com/v.mp4');
 const r=d.records[0]!.payload,html=renderBenchmarkExtras({body:r.body,media:r.media,benchmark:r.provider_metadata});assert.ok(r.body?.includes('字幕原文'));assert.ok(!html.includes('平台未提供口播字幕'));assert.ok(!html.includes('<h3>平台字幕</h3>'));
});
test('手动历史分页只读一页；最新刷新保留历史进度、旧作品和快照；游标停滞后不重复补采',async()=>{
 const f=setup();try{const cursors:(string|null)[]=[];let cursor='older-1',post='101';const adapter=new TikHubAdapter({fixture:true,token_provider:()=> 'token',fetcher:async(raw)=>{const c=new URL(String(raw)).searchParams.get('cursor');cursors.push(c);return new Response(JSON.stringify({code:200,data:{timeline:[tweet(post)],next_cursor:cursor}}));}}),sync=new BenchmarkSync(f.context(),adapter),w=worker(f,sync);
  assert.throws(()=>sync.enqueue(f.request(),f.id,{scope:'older_page'}),{code:'CAPABILITY_UNVERIFIED'});
  sync.enqueue(f.request(),f.id);await w.runOnce();cursor='older-2';post='102';const req=f.request(),job=sync.enqueue(req,f.id,{scope:'older_page'});assert.deepEqual(sync.enqueue(req,f.id,{scope:'older_page'}),job);await w.runOnce();assert.deepEqual(cursors,[null,'older-1']);assert.equal(sync.status(f.request(),f.id).history_cursor,'older-2');
  cursor='new-first-page-cursor';post='103';sync.enqueue(f.request(),f.id);await w.runOnce();assert.equal(sync.status(f.request(),f.id).history_cursor,'older-2');
  cursor='older-2';post='102';sync.enqueue(f.request(),f.id,{scope:'older_page'});await w.runOnce();assert.equal(sync.status(f.request(),f.id).history_stop_reason,'cursor_stalled');assert.equal(sync.status(f.request(),f.id).history_cursor,null);assert.equal(f.sources.accounts(f.request()).items[0]!.work_count,3);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM snapshots').get()!.n,4);assert.throws(()=>sync.enqueue(f.request(),f.id,{scope:'older_page'}),{code:'CAPABILITY_UNVERIFIED'});
 }finally{f.cleanup();}
});
test('平台资料和作品内容中的 HTML、脚本链接不变成可执行界面；正文媒体都进入资料详情',async()=>{
 const f=setup();try{const adapter=new TikHubAdapter({fixture:true,token_provider:()=> 'token',fetcher:async()=>new Response(JSON.stringify({code:200,data:{timeline:[{...tweet('101'),text:'<script>不要执行</script>',media:{photo:[{media_url_https:'https://pbs.twimg.com/p.jpg'}]}}]}}))}),sync=new BenchmarkSync(f.context(),adapter);sync.enqueue(f.request(),f.id);await worker(f,sync).runOnce();const r=f.sources.detail(f.request(),f.sources.records(f.request()).items[0]!.id);assert.equal(r.media.length,1);assert.equal(r.benchmark?.platform_work_id,'101');const html=renderBenchmarkRecord(r);assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('pbs.twimg.com/p.jpg'));
  const card=renderBenchmarkAccounts([{id:f.id,name:'<img onerror=bad>',platform:'x',focus:'平台身份',count:null,previous:null,reason:'<script>',url:'javascript:alert(1)',workCount:1}]);assert.ok(!card.includes('javascript:'));assert.ok(card.includes('&lt;img'));
 }finally{f.cleanup();}
});
test('从账号研究进入资料阅读器，保留选定平台作品与媒体，不重新导航到精选榜',async()=>{
 const {createSourcesReadFeature}=await import('../../apps/web/src/features/sources/read/index.ts'),{initialUi}=await import('../../apps/web/src/app/view-model.ts');
 const f=setup();try{const adapter=new TikHubAdapter({fixture:true,token_provider:()=> 'token',fetcher:async()=>new Response(JSON.stringify({code:200,data:{timeline:[{...tweet('101'),media:{photo:[{media_url_https:'https://pbs.twimg.com/p.jpg'}]}}]}}))}),sync=new BenchmarkSync(f.context(),adapter);sync.enqueue(f.request(),f.id);await worker(f,sync).runOnce();const record=f.sources.records(f.request()).items[0]!;let navigations=0;const context:any={ui:{...initialUi('sources'),sourceTab:'accounts'},signal:new AbortController().signal,client:{async request(method:string,path:string,body:any){if(path.startsWith('/api/v1/accounts?'))return f.sources.accounts(f.request());if(path.endsWith('/marks'))return f.sources.marks(f.request(),record.id,body);if(path==='/api/v1/source-records/'+record.id)return f.sources.detail(f.request(),record.id);return {items:[],next_cursor:null};}},surface:{closeDialog(){},navigate(){navigations++;},updateUi(){}}};
 const feature=createSourcesReadFeature();await feature.load(context);const view=await feature.dispatch({action:'read-news',dataset:{id:record.id},fields:{}},context);assert.equal(navigations,0);assert.equal(view?.ui.news,record.id);assert.equal(view?.ui.sourceTab,'news');assert.equal(view?.NEWS[0]?.body,'平台作品 101');assert.equal(view?.NEWS[0]?.media?.length,1);
 }finally{f.cleanup();}
});
