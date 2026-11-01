import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../documents/harness.ts';
import {Sources} from '../../packages/domain/src/sources/index.ts';
import {DailyPlans} from '../../packages/domain/src/daily-plans/index.ts';
import {createSourcesReadFeature} from '../../apps/web/src/features/sources/read/index.ts';
const entry=(id:string,rank:number)=>({id,rank,title:'事件 '+id,summary:'摘要',selected:true,status:'active',score:90-rank,reason:'与 AI 业务实践有关：'+id,firstAt:'2026-10-12T00:00:00Z',links:{site:'https://site.example.invalid/hot/event/'+id+'/'}});
test('只呈现最新精选榜单，保留排名理由；更新、失败、跨流去重不丢收藏和历史资料',async()=>{
 const f=fixture();try{const sources=new Sources(f.context());sources.ensurePublicSources('https://site.example.invalid');const all=sources.list(f.request()).items,hot=all.find(s=>s.external_id==='hot-topics')!,items=all.find(s=>s.external_id==='items')!;let topics:any[]=[entry('a',2),entry('b',1),{...entry('off',3),selected:false},{...entry('inactive',4),status:'closed'},entry('b',7)];let time='2026-10-12T01:00:00Z';const fetcher=(async(url:any)=>{const stream=String(url).split('/').at(-1);return new Response(JSON.stringify({schemaVersion:1,generatedAt:time,...(stream==='items.json'?{items:[entry('a',2),entry('raw',1)]}:{topics})}));}) as typeof fetch;
 await sources.ingest(String(items.id),{fetcher});const raw=sources.records(f.request()).items.find(s=>s.title==='事件 raw')!;assert.equal(sources.records(f.request(),{curated:true}).items.length,0);
 await sources.ingest(String(hot.id),{fetcher});const selected=sources.records(f.request(),{curated:true}).items;assert.deepEqual(selected.map(s=>s.title),['事件 b','事件 a']);assert.equal(selected[0]!.curation!.reason,'与 AI 业务实践有关：b');assert.equal(selected[0]!.curation!.score,89);assert.equal(selected[0]!.curation!.generated_at,time);assert.equal(selected.filter(s=>s.title==='事件 a').length,1);const a=selected[1]!;sources.marks(f.request(),a.id,{favorite:true,read:true});const page=sources.records(f.request(),{curated:true,limit:1});assert.ok(page.next_cursor);assert.deepEqual(sources.records(f.request(),{curated:true,limit:1,cursor:page.next_cursor!}).items.map(s=>s.title),['事件 a']);
 topics=[entry('b',2),entry('c',1)];time='2026-10-12T02:00:00Z';await sources.ingest(String(hot.id),{fetcher});assert.deepEqual(sources.records(f.request(),{curated:true}).items.map(s=>s.title),['事件 c','事件 b']);assert.throws(()=>sources.records(f.request(),{curated:true,cursor:page.next_cursor!}),{code:'VALIDATION_ERROR'});assert.ok(sources.records(f.request(),{favorite:true}).items.some(s=>s.id===a.id&&s.read));assert.ok(sources.records(f.request()).items.some(s=>s.id===raw.id));assert.deepEqual(new DailyPlans(f.context()).overview(f.request()).recent_news.map(s=>s.title),['事件 c','事件 b']);
 topics=[{id:'broken'}];await assert.rejects(sources.ingest(String(hot.id),{fetcher}),{code:'VALIDATION_ERROR'});assert.deepEqual(sources.records(f.request(),{curated:true}).items.map(s=>s.title),['事件 c','事件 b']);
 }finally{f.cleanup();}
});
test('资讯页面同步只调用精选流，默认读取 curated=true；主动收藏仍可找回旧资料',async()=>{
 const calls:string[]=[],ui:any={page:'sources',sourceFilter:'全部',sourceTab:'news',news:''},context:any={ui,signal:new AbortController().signal,client:{request:async(method:string,path:string)=>{calls.push(method+' '+path);if(path==='/api/v1/sources')return {items:['items','events','hot-topics','dailies','creator-feed'].map(external_id=>({id:external_id,kind:'personal_site',external_id}))};if(method==='POST')return {job_id:'sync-job'};if(path.startsWith('/api/v1/jobs/'))return {job:{state:'succeeded'}};return {items:[],next_cursor:null};}},surface:{updateUi:()=>{},presentDialog:()=>{},closeDialog:()=>{},isForegroundJobActive:()=>true,toast:()=>{}}};const feature=createSourcesReadFeature();await feature.dispatch({action:'source-sync',dataset:{},fields:{}},context);assert.deepEqual(calls.filter(s=>s.startsWith('POST')),['POST /api/v1/sources/creator-feed/sync']);assert.ok(calls.some(s=>s.includes('/api/v1/source-records?')&&s.includes('curated=true')));calls.length=0;await feature.dispatch({action:'source-filter',dataset:{value:'已收藏'},fields:{}},context);assert.ok(calls.some(s=>s.includes('favorite=true')&&!s.includes('curated=true')));
});

test('精选资讯保留本人主动保存的素材，不把原始采集条目重新全量呈现',async()=>{
 const f=fixture();try{
  const sources=new Sources(f.context());sources.ensurePublicSources('https://site.example.invalid');
  const manual=sources.create(f.request(),{title:'本人明确保存的素材',text:'本人输入的正文',category:'个人思考'});
  const stream=sources.list(f.request()).items.find(source=>source.external_id==='items')!;
  await sources.ingest(String(stream.id),{fetcher:(async()=>new Response(JSON.stringify({schemaVersion:1,items:[entry('raw-only',1)]}))) as typeof fetch});
  const selected=sources.records(f.request(),{curated:true}).items;
  assert.deepEqual(selected.map(record=>record.id),[manual.record_id]);
  assert.equal(sources.detail(f.request(),manual.record_id).body,'本人输入的正文');
  assert.equal(sources.records(f.request()).items.length,2);
 }finally{f.cleanup();}
});

test('手动保存退出本期的 hot-topics 资料不继承旧排名，也不挤占首页当前精选',async()=>{
 const f=fixture();try{
  const sources=new Sources(f.context());sources.ensurePublicSources('https://site.example.invalid');const hot=sources.list(f.request()).items.find(s=>s.external_id==='hot-topics')!;
  await sources.ingest(String(hot.id),{fetcher:async()=>new Response(JSON.stringify({schemaVersion:1,generatedAt:'2026-10-12T00:00:00Z',topics:[entry('historical',1)]}))});
  const old=sources.records(f.request(),{curated:true}).items[0]!;
  await sources.ingest(String(hot.id),{fetcher:async()=>new Response(JSON.stringify({schemaVersion:1,generatedAt:'2026-10-13T00:00:00Z',topics:[entry('current',2)]}))});
  const saved=sources.create(f.request(),{url:old.canonical_url!,title:old.title,text:'本人手动保留历史资料'});assert.equal(saved.record_id,old.id);
  const page=sources.records(f.request(),{curated:true,limit:1});assert.equal(page.items[0]!.title,'事件 current');assert.equal(page.items[0]!.curation?.current,true);
  const second=sources.records(f.request(),{curated:true,limit:1,cursor:page.next_cursor!});assert.equal(second.items[0]!.id,old.id);assert.equal(second.items[0]!.curation?.current,false);assert.equal(sources.detail(f.request(),old.id).curation?.rank,1);
  assert.deepEqual(new DailyPlans(f.context()).overview(f.request()).recent_news.map(r=>r.id),[page.items[0]!.id,old.id]);
 }finally{f.cleanup();}
});
