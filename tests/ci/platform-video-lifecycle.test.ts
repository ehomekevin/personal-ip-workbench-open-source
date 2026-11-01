import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {SourceRecordDetail} from '../../packages/contracts/src/index.ts';
import {parseBenchmarkFeed} from '../../packages/adapters/src/tikhub/benchmark-feed.ts';
import {projectSavedBenchmarkMaterials} from '../../packages/domain/src/sources/material-reprojection.ts';
import {sha256,transaction} from '../../packages/storage/src/connection/index.ts';
import {ensureSource,upsertSourceRecord,readSourcePayload} from '../../packages/storage/src/sources/index.ts';
import {fixture} from '../documents/harness.ts';
import {renderBenchmarkRecord,renderBenchmarkExtras} from '../../apps/web/src/components/benchmarkMaterials.ts';
import {renderXPostCard} from '../../apps/web/src/components/x-post-card.ts';
import {originalPlatformLink,platformVideoExpired,renderPlatformVideo} from '../../apps/web/src/components/platform-video.ts';
import {sourceView} from '../../apps/web/src/features/sources/read/index.ts';

const sec='MS4w'+'a'.repeat(20),account='https://www.douyin.com/user/'+sec,original='https://www.douyin.com/video/201';
const raw=(expiry:unknown=1791889731)=>({data:{aweme_list:[{aweme_id:'201',desc:'保存的完整说明',create_time:1720000000,author:{uid:'123',sec_uid:sec,nickname:'作者'},statistics:{play_count:0,digg_count:0},video:{duration:3000,cdn_url_expired:expiry,cover:{url_list:['https://images.fixture.invalid/cover.jpg']},play_addr_h264:{url_list:['javascript:bad','https://media.fixture.invalid/a.mp4?signature=original','https://media.fixture.invalid/b.mp4?signature=backup']},play_addr:{url_list:['https://media.fixture.invalid/c.mp4?signature=third','https://user:secret@media.fixture.invalid/private.mp4']}}}]}});
const parse=(expiry?:unknown)=>parseBenchmarkFeed('douyin',account,'123',raw(expiry)).records[0]!;

test('raw期限和所有合法候选保持原值、原顺序与来源；签名不被改写',()=>{
 const record=parse(),video=record.payload.media.find(item=>item.type==='video')!;
 assert.equal(video.cdn_url_expired,1791889731);assert.equal(video.expires_at,'2026-10-13T11:08:51.000Z');assert.equal(video.expiry_source_field,'video.cdn_url_expired');
 assert.equal(video.play_source_field,'video.play_addr_h264.url_list[1]');
 assert.deepEqual(video.play_candidates,[{url:'https://media.fixture.invalid/a.mp4?signature=original',source_field:'video.play_addr_h264.url_list[1]'},{url:'https://media.fixture.invalid/b.mp4?signature=backup',source_field:'video.play_addr_h264.url_list[2]'},{url:'https://media.fixture.invalid/c.mp4?signature=third',source_field:'video.play_addr.url_list[0]'}]);
 assert.equal(record.payload.provider_metadata.play_count_raw,'0');assert.equal((record.payload.provider_metadata.metrics as any).plays,null);
 assert.equal(parse('1791889731').payload.media.find(item=>item.type==='video')!.cdn_url_expired,'1791889731');
});

test('缺失、占位及非法到期值保留未知，不能从签名query推断到期',()=>{
 for(const value of [null,0,'0','invalid',-1,1.5,'9007199254740992']){
  const video=parse(value).payload.media.find(item=>item.type==='video')!;
  assert.equal(video.expires_at,null);assert.equal(video.cdn_url_expired,value);assert.equal(platformVideoExpired(video),false);
 }
 const input=raw();delete (input.data.aweme_list[0]!.video as any).cdn_url_expired;
 const video=parseBenchmarkFeed('douyin',account,'123',input).records[0]!.payload.media.find(item=>item.type==='video')!;
 assert.equal(video.expires_at,null);assert.equal(video.expiry_source_field,null);
 assert.equal(platformVideoExpired({play_url:'https://media.fixture.invalid/a.mp4?expires=1'}),false);
});

test('raw JSON指数溢出到期值保留原字节，入库及离线重解析整批成功',()=>{
 const body=raw(),second=structuredClone(body.data.aweme_list[0]!);second.aweme_id='202';body.data.aweme_list.push(second);
 const rawBody=JSON.stringify(body).replace('"cdn_url_expired":1791889731','"cdn_url_expired":1e309'),hash=sha256(rawBody);
 const parsedBody=JSON.parse(rawBody);assert.equal(parsedBody.data.aweme_list[0].video.cdn_url_expired,Infinity);
 const parsed=parseBenchmarkFeed('douyin',account,'123',parsedBody),normal=parseBenchmarkFeed('douyin',account,'123',body);
 const f=fixture();try{
  const rawPath=join(f.root,'response.json');writeFileSync(rawPath,rawBody);
  assert.doesNotThrow(()=>transaction(f.context().db,()=>{
   const source=ensureSource(f.context().db,f.config.workspace_id,'tikhub_benchmark',account,'fixture');
   for(const record of parsed.records)upsertSourceRecord(f.context().db,f.config.workspace_id,source,record,{external_id:record.external_id,kind:'fixture',relative_path:null,source_url:record.canonical_url,capture_time:null,sha256:hash,parser_version:'benchmark-feed/6',availability:'available',raw_response_ref:{path:rawPath,sha256:hash,adapter_version:'benchmark-feed/6'}});
  }));
  const stored=f.context().db.prepare('SELECT payload FROM source_records ORDER BY external_id').all();assert.equal(stored.length,2);
  assert.equal(readSourcePayload(stored[0]!).media.find(item=>item.type==='video')!.cdn_url_expired,null);
  const projected=projectSavedBenchmarkMaterials({platform:'douyin',account_url:account,platform_account_id:'123',raw_body:rawBody,raw_sha256:hash,evidence_kind:'real_platform',existing:normal.records.map(record=>({external_id:record.external_id!,canonical_url:record.canonical_url!,payload:{...record.payload,body:'人工全文 '+record.external_id}}))});
  assert.equal(projected.length,2);const abnormalRecord=projected.find(record=>record.external_id==='201')!,normalRecord=projected.find(record=>record.external_id==='202')!;
  assert.equal(abnormalRecord.payload.body,'人工全文 201');assert.equal(normalRecord.payload.body,'人工全文 202');
  const abnormal=abnormalRecord.payload.media.find(item=>item.type==='video')!;assert.equal(abnormal.cdn_url_expired,null);assert.equal(abnormal.expires_at,null);
  assert.equal(normalRecord.payload.media.find(item=>item.type==='video')!.cdn_url_expired,1791889731);
  assert.equal(readFileSync(rawPath,'utf8'),rawBody);assert.equal(sha256(readFileSync(rawPath)),hash);
 }finally{f.cleanup();}
 for(const value of [Infinity,-Infinity,NaN])assert.equal(parse(value).payload.media.find(item=>item.type==='video')!.cdn_url_expired,null);
});

test('离线重解析保留期限和候选，不取网络，保留人工正文、本地媒体及统计来源',()=>{
 const record=parse(),payload={...record.payload,body:'人工全文',media:[{type:'image',asset_id:'local',path:'/saved/image.jpg'}],provider_metadata:{...record.payload.provider_metadata,metric_sources:{plays:{status:'available',source_kind:'tikhub_douyin_video_statistics'}},human_note:'原样保留'}};
 const input=JSON.stringify(raw()),projected=projectSavedBenchmarkMaterials({platform:'douyin',account_url:account,platform_account_id:'123',raw_body:input,raw_sha256:sha256(input),evidence_kind:'real_platform',existing:[{external_id:'201',canonical_url:original,payload}]})[0]!;
 assert.equal(projected.payload.body,'人工全文');assert.deepEqual(projected.payload.provider_metadata.metric_sources,payload.provider_metadata.metric_sources);assert.equal(projected.payload.provider_metadata.human_note,'原样保留');
 assert.equal(projected.payload.media.find(item=>item.type==='video')!.cdn_url_expired,1791889731);assert.equal((projected.payload.media.find(item=>item.type==='video')!.play_candidates as any[]).length,3);assert.ok(projected.payload.media.some(item=>item.asset_id==='local'));
 assert.equal(projectSavedBenchmarkMaterials({platform:'douyin',account_url:account,platform_account_id:'123',raw_body:input,raw_sha256:sha256(input),evidence_kind:'real_platform',existing:[{external_id:'201',canonical_url:original,payload:projected.payload}]})[0]!.changed,false);
});

test('确知expired没有视频src，详情与资料阅读器都给原平台入口并保留正文',()=>{
 const parsed=parse(),detail={id:'201',...parsed,title:parsed.payload.title,summary:parsed.payload.summary,source_name:'作者',category:'对标内容',source_locations:[],body:parsed.payload.body,media:parsed.payload.media,benchmark:parsed.payload.provider_metadata} as unknown as SourceRecordDetail;
 const view=sourceView(detail,detail);assert.equal(view.canonical_url,original);
 for(const html of [renderBenchmarkRecord(detail),renderBenchmarkExtras(view)]){
  assert.ok(html.includes('视频地址已过期'));assert.ok(html.includes('在抖音查看'));assert.ok(html.includes('href="'+original+'"'));assert.ok(!html.includes('<video'));assert.ok(!html.includes('media.fixture.invalid'));
 }
 assert.ok(renderBenchmarkRecord(detail).includes('保存的完整说明'));
});

test('未知或未来期限正常按需播放；不增加autoplay/refresh，平台URL需HTTPS作品页',()=>{
 for(const expires_at of [null,'invalid','2099-01-01T00:00:00Z']){
  const html=renderPlatformVideo({type:'video',play_url:'https://media.fixture.invalid/valid.mp4',expires_at},{platform:'douyin',originalUrl:original});
  assert.ok(html.includes('<video'));assert.ok(html.includes('preload="none"'));assert.ok(html.includes('controls'));assert.ok(html.includes('在抖音查看'));assert.ok(!html.includes('autoplay'));assert.ok(!html.includes('data-action'));
 }
 for(const unsafe of ['http://www.douyin.com/video/201','https://user:secret@www.douyin.com/video/201','https://www.douyin.com.evil.invalid/video/201','https://www.douyin.com:444/video/201','https://media.fixture.invalid/a.mp4','https://x.com/a/status/201','javascript:bad'])assert.equal(originalPlatformLink(unsafe,'douyin'),null);
 assert.equal(originalPlatformLink(original,'douyin')?.url,original);
});

test('X引用视频降级使用原作者作品页，引用文字和图片仍保留',()=>{
 const html=renderXPostCard({benchmark:{platform:'x',x_post:{kind:'quote',author:{name:'外层作者'},text:'外层正文',canonical_url:'https://x.com/outer/status/201',quoted_post:{author:{name:'原作者'},text:'原文正文',availability:'available',canonical_url:'https://x.com/original/status/202',media:[{type:'photo',url:'https://images.fixture.invalid/photo.jpg'},{type:'video',play_url:'https://media.fixture.invalid/expired.mp4',expires_at:'2000-01-01T00:00:00Z'}]}}}});
 assert.ok(html.includes('原文正文'));assert.ok(html.includes('data-x-gallery'));assert.ok(html.includes('href="https://x.com/original/status/202"'));assert.ok(html.includes('在X查看'));assert.ok(!html.includes('<video'));assert.ok(!html.includes('media.fixture.invalid'));
});
