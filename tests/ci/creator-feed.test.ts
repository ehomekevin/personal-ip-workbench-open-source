import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../documents/harness.ts';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { Topics } from '../../packages/domain/src/topics/index.ts';
import { parseCreatorFeed as configuredFeed,parseCreatorDetail as configuredDetail } from '../../packages/adapters/src/personal-site/creator-feed.ts';
const parseCreatorFeed = (value: Parameters<typeof configuredFeed>[0]) => configuredFeed(value, 'https://site.example.invalid');
const parseCreatorDetail = (value: Parameters<typeof configuredDetail>[0], id: string, version?: string) => configuredDetail(value, id, version, 'https://site.example.invalid');
const at='2026-10-13T00:00:00Z',v1='a'.repeat(12),v2='b'.repeat(12),v3='c'.repeat(12);
function event(id='a',rank=1,version=v1,aliases:string[]=[]){return {id:'event_'+id,type:'event',rank,ids:{eventId:id,aliases,reportIds:['report-'+id],practiceKey:null,sourceId:null},title:'事件 '+id,summary:'可核对的摘要',quality:{eventScore:{value:80,scale:'0-100',scope:'event'},bestReport:{id:'report-'+id,score:75,dims:{utility:8},dimsScope:'report'},assessmentMethod:'unknown'},signals:{sourceNames:['来源']},times:{firstReportAt:at,lastActivityAt:at},selection:{lane:'hot',laneRank:rank,reasons:[{code:'hot',text:'热榜信号'}]},evidence:{selfTested:'unknown'},contentVersion:version,links:{detail:'https://site.example.invalid/api/v1/creator-feed/event_'+id+'.json',site:'https://site.example.invalid/hot/event/'+id+'/',original:'https://source.example/'+id}};}
function practice(rank=2){return {id:'practice_r-test',type:'practice',rank,ids:{eventId:null,aliases:[],reportIds:[],practiceKey:'r-test',sourceId:'test'},title:'实践材料',summary:'尚未复现的步骤',quality:{eventScore:null,bestReport:{score:65,dims:{utility:8},dimsScope:'report'},assessmentMethod:'ai_curated'},signals:{sourceNames:['原帖作者']},times:{firstReportAt:at,lastActivityAt:at},practice:{from:'reddit_post',confidence:'high',stepCount:3,promptCount:1},selection:{lane:'practice',laneRank:1,reasons:[{text:'有三步的玩法卡'}]},evidence:{selfTested:'unknown'},contentVersion:v1,links:{detail:'https://site.example.invalid/api/v1/creator-feed/practice_r-test.json',site:'https://site.example.invalid/tips/r-test/',original:'https://source.example/a'}};}
function feed(candidates:any[],snapshot='cfs_aaaaaaaaaa'){return {schemaVersion:1,kind:'creator-feed',snapshotId:snapshot,generatedAt:at,sourceDataUpdatedAt:at,staleAfter:'2026-10-13T12:00:00Z',ruleVersion:'cf-rules-1',contentVersion:v1,complete:true,count:candidates.length,limit:30,sort:'lane_then_lane_rank',candidates};}
function detail(c:any,content:any,snapshot='cfs_aaaaaaaaaa'){return {schemaVersion:1,kind:'creator-feed-detail',snapshotId:snapshot,generatedAt:at,sourceDataUpdatedAt:at,ruleVersion:'cf-rules-1',candidate:{...c,content,reports:[]}};}
const response=(v:any)=>new Response(JSON.stringify(v));
test('完整有限候选准入；版本、数量、重复、类型与详情路径不符均拒绝',()=>{
 assert.equal(parseCreatorFeed(feed([event(),practice()])).length,2);assert.equal(parseCreatorFeed(feed([])).length,0);
 for(const bad of [{...feed([event()]),complete:false},{...feed([event()]),count:2},{...feed([event()]),limit:31},feed([event(),{...event(),rank:2}]),feed([{...event(),links:{...event().links,detail:'https://other.example/a.json'}}]),feed([{...practice(1),practice:{confidence:'low',stepCount:3}}])])assert.throws(()=>parseCreatorFeed(bad),{code:'CAPABILITY_UNVERIFIED'});
 assert.throws(()=>parseCreatorDetail(detail(event(),{}),'event_b'),{code:'CAPABILITY_UNVERIFIED'});assert.throws(()=>parseCreatorDetail(detail(event('a',1,v2),{}),'event_a',v1),{code:'INPUT_STALE'});
});
test('优先候选快照；旧事件复用、收藏/主题不丢；详情按需、版本变化、失败和空快照不清历史',async()=>{
 const f=fixture();try{const s=new Sources(f.context());s.ensurePublicSources('https://site.example.invalid');const all=s.list(f.request()).items,hot=all.find(r=>r.external_id==='hot-topics')!,creator=all.find(r=>r.external_id==='creator-feed')!;
 await s.ingest(String(hot.id),{fetcher:async()=>response({schemaVersion:1,generatedAt:at,events:[{id:'a',rank:1,title:'旧事件',summary:'旧摘要',firstAt:at,reason:'旧理由',links:{original:'https://source.example/a'}}]})});
 const old=s.records(f.request(),{curated:true}).items[0]!;s.marks(f.request(),old.id,{favorite:true,read:true});const topic=await new Topics(f.context()).create(f.request(),{title:'保留关联',category:'热点资讯',audience:'创作者',angle:'测试关联',source_ids:[old.id]});
 let list=feed([event(),practice()]),detailCalls=0,fail=false,contentVersion=v1;const fetcher=(async(u:any)=>{if(String(u).endsWith('/creator-feed.json'))return response(list);detailCalls++;if(fail)return new Response('',{status:404});return response(detail(event('a',1,contentVersion),{brief:{tldr:'正文 '+contentVersion}}));}) as typeof fetch;
 await s.ingest(String(creator.id),{fetcher});let rows=s.records(f.request(),{curated:true}).items;assert.equal(rows.length,2);assert.equal(rows[0]!.id,old.id);assert.equal(rows[0]!.favorite,true);assert.equal(detailCalls,0);assert.equal(rows[1]!.category,'AI 实测');assert.equal(rows[0]!.curation?.type,'event');
 assert.ok((await s.readDetail(f.request(),old.id,undefined,fetcher)).body?.includes(v1));assert.equal(detailCalls,1);await s.readDetail(f.request(),old.id,undefined,fetcher);assert.equal(detailCalls,1);
 list=feed([event(),practice()],'cfs_bbbbbbbbbb');await s.ingest(String(creator.id),{fetcher});await s.readDetail(f.request(),old.id,undefined,fetcher);assert.equal(detailCalls,1);
 list=feed([event('a',1,v2),practice()],'cfs_cccccccccc');await s.ingest(String(creator.id),{fetcher});fail=true;let kept=await s.readDetail(f.request(),old.id,undefined,fetcher);assert.ok(kept.body?.includes(v1));assert.ok(kept.parser_warnings.some(w=>w.includes('当前内容版本')));assert.equal(kept.favorite,true);
 fail=false;contentVersion=v2;kept=await s.readDetail(f.request(),old.id,undefined,fetcher);assert.ok(kept.body?.includes(v2));assert.ok(!kept.parser_warnings.some(w=>w.includes('当前内容版本')));
 list=feed([],'cfs_dddddddddd');await s.ingest(String(creator.id),{fetcher});assert.equal(s.records(f.request(),{curated:true}).items.length,0);assert.ok(s.records(f.request(),{favorite:true}).items.some(r=>r.id===old.id&&r.curation?.current===false));assert.equal(f.context().db.prepare('SELECT source_record_id FROM topic_sources WHERE topic_id=?').get(topic.id)!.source_record_id,old.id);
 list={...feed([event()]),complete:false};await assert.rejects(s.ingest(String(creator.id),{fetcher}),{code:'CAPABILITY_UNVERIFIED'});assert.equal(s.records(f.request(),{curated:true}).items.length,0);
 }finally{f.cleanup();}
});
test('玩法与同出处事件不误合并；步骤、提示词原文及出处保留，分数归属不混淆',async()=>{
 const f=fixture();try{const s=new Sources(f.context());s.ensurePublicSources('https://site.example.invalid');const source=s.list(f.request()).items.find(r=>r.external_id==='creator-feed')!;const p=practice(),prompt='第一行\nLiteral $ARGUMENTS\nsecond line';const pd=detail(p,{needs:['软件'],steps:['准备','执行','核对'],prompts:[{original:prompt,noteZh:'说明',source:{author:'原帖作者',url:'https://source.example/prompt'}}],pitfalls:['尚未实测'],sources:[{url:'https://source.example/post'}]});
 const fetcher=(async(u:any)=>response(String(u).endsWith('/creator-feed.json')?feed([event(),p]):pd)) as typeof fetch;await s.ingest(String(source.id),{fetcher});const rows=s.records(f.request(),{curated:true}).items;assert.equal(rows.length,2);const r=rows.find(r=>r.category==='AI 实测')!,d=await s.readDetail(f.request(),r.id,undefined,fetcher);assert.ok(d.body?.includes(prompt));assert.ok(d.external_links.includes('https://source.example/post'));assert.equal(r.curation?.score,null);assert.ok(d.parser_warnings.some(w=>w.includes('尚未本人实测')));assert.equal(d.work_id,null);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM works').get()!.n,0);
 }finally{f.cleanup();}
});
test('事件合并保留原引用与映射；拆分后恢复各自 ID；读取中更新不能覆盖新版本',async()=>{
 const f=fixture();try{const s=new Sources(f.context());s.ensurePublicSources('https://site.example.invalid');const source=s.list(f.request()).items.find(r=>r.external_id==='creator-feed')!;await s.ingest(String(source.id),{fetcher:async()=>response(feed([event('old',1),event('keep',2)]))});const old=s.records(f.request(),{curated:true}).items.find(r=>r.title==='事件 old')!,keep=s.records(f.request(),{curated:true}).items.find(r=>r.title==='事件 keep')!;s.marks(f.request(),old.id,{favorite:true});
 await s.ingest(String(source.id),{fetcher:async()=>response(feed([event('keep',1,v2,['old'])],'cfs_bbbbbbbbbb'))});assert.equal(s.records(f.request(),{curated:true}).items[0]!.id,keep.id);assert.equal(s.detail(f.request(),old.id).favorite,true);assert.ok(s.detail(f.request(),old.id).parser_warnings.some(w=>w.includes('已并入')));
 await assert.rejects(s.readDetail(f.request(),keep.id,undefined,async()=>{await s.ingest(String(source.id),{fetcher:async()=>response(feed([event('keep',1,v3)],'cfs_cccccccccc'))});return response(detail(event('keep',1,v2),{brief:{tldr:'旧响应'}}));}),{code:'INPUT_STALE'});assert.equal(s.detail(f.request(),keep.id).body,null);
 await s.ingest(String(source.id),{fetcher:async()=>response(feed([event('old',1,v3),event('keep',2,v3)],'cfs_dddddddddd'))});const rows=s.records(f.request(),{curated:true}).items;assert.equal(rows.length,2);assert.ok(rows.some(r=>r.id===old.id));assert.ok(rows.some(r=>r.id===keep.id));
 }finally{f.cleanup();}
});

test('手动保留过期 creator-feed 不沿用当前候选排序或标签，历史依据仍可回看',async()=>{
 const f=fixture();try{
  const s=new Sources(f.context());s.ensurePublicSources('https://site.example.invalid');const stream=s.list(f.request()).items.find(r=>r.external_id==='creator-feed')!;
  await s.ingest(String(stream.id),{fetcher:async()=>response(feed([event('old',1)]))});const old=s.records(f.request(),{curated:true}).items[0]!;
  await s.ingest(String(stream.id),{fetcher:async()=>response(feed([event('fresh',1),event('new',2)],'cfs_bbbbbbbbbb'))});
  assert.equal(s.create(f.request(),{url:old.canonical_url!,title:old.title,text:'本人保存历史事件'}).record_id,old.id);
  const rows=s.records(f.request(),{curated:true}).items;assert.deepEqual(rows.map(r=>r.title),['事件 fresh','事件 new','事件 old']);assert.equal(rows[0]!.curation?.current,true);assert.equal(rows[1]!.curation?.current,true);assert.equal(rows[2]!.curation?.current,false);assert.equal(rows[2]!.curation?.reason,'热榜信号');
 }finally{f.cleanup();}
});

test('个人站无配置不自动注册或请求，显式站点可注册且拒绝凭据/跨站详情',async()=>{
 const {PersonalSiteAdapter}=await import('../../packages/adapters/src/personal-site/index.ts');
 const f=fixture();try{
  const sources=new Sources(f.context());sources.ensurePublicSources();assert.equal(sources.list(f.request()).items.length,0);
  let requests=0;const fetcher=(async()=>{requests++;return response({schemaVersion:1,items:[]});}) as typeof fetch;
  const adapter=new PersonalSiteAdapter({stream:'items',rawRoot:f.config.paths.state_root,fetcher});
  assert.equal((await adapter.describe())[0]!.status,'unconfigured');
  await assert.rejects(adapter.fetchBatch(null),{code:'CAPABILITY_UNVERIFIED'});
  await assert.rejects(adapter.fetchDetail('sample-event'),{code:'CAPABILITY_UNVERIFIED'});
  assert.equal(requests,0);
  assert.throws(()=>sources.ensurePublicSources('https://user:secret@site.example.invalid'),{code:'VALIDATION_ERROR'});
  assert.throws(()=>sources.ensurePublicSources('file:///tmp/site'),{code:'VALIDATION_ERROR'});
  sources.ensurePublicSources('https://site.example.invalid');sources.ensurePublicSources('https://site.example.invalid');
  assert.equal(sources.list(f.request()).items.length,5);
  const source=sources.list(f.request()).items.find(s=>s.external_id==='items')!;
  let requested='';await sources.ingest(String(source.id),{fetcher:(async(url:any)=>{requested=String(url);return response({schemaVersion:1,items:[]});}) as typeof fetch});
  assert.equal(requested,'https://site.example.invalid/api/v1/items.json');
  const mismatch={...event(),links:{...event().links,site:'https://other.example.invalid/event/a'}};
  assert.throws(()=>parseCreatorFeed(feed([mismatch])),{code:'CAPABILITY_UNVERIFIED'});
 }finally{f.cleanup();}
});
