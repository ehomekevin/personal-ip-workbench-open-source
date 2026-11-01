import test from 'node:test';
import assert from 'node:assert/strict';
import type {SourceRecordDetail,SourceRecordSummary,JsonObject} from '../../packages/contracts/src/index.ts';
import {renderBenchmarkAccounts,formatBenchmarkDuration,renderBenchmarkMaterialList,renderBenchmarkRecord,renderBenchmarkExtras,renderPlatformMetrics} from '../../apps/web/src/components/benchmarkMaterials.ts';

const row=(extra:Partial<SourceRecordSummary>={}):SourceRecordSummary=>({id:'record-1',record_kind:'douyin_video',title:'封面判断兴趣',summary:'封面判断兴趣',published_at:'2026-10-13T02:35:09.000Z',format:'short_video',media_type:'video',duration_ms:'129967',preview_url:'https://p3-sign.douyinpic.com/cover.jpeg?signature=original',metrics:{likes:'9377',comments:'64',saves:'504',shares:'690',plays:null},...extra} as SourceRecordSummary);

test('素材卡片直接展示封面、可靠时长和已提供指标；同文摘要不重复标题',()=>{
 const html=renderBenchmarkMaterialList([row()],{action:'cfg-benchmark-record',platform:'douyin'});
 assert.ok(html.includes('cover.jpeg?signature=original'));
 assert.ok(html.includes('视频 · 2:09'));
 assert.ok(html.includes('<b>9377</b> 点赞'));
 assert.ok(html.includes('<b>64</b> 评论'));
 assert.ok(html.includes('<b>504</b> 收藏'));
 assert.ok(html.includes('<b>690</b> 分享'));
 assert.ok(html.includes('<b>—</b> 播放'));
 assert.ok(!html.includes('benchmark-work-summary'));
 assert.ok(html.includes('发布 · '));
});

test('真实零值保留，抖音公开播放占位零不冒充表现；缺失、负数和非法数明确未知',()=>{
 const html=renderPlatformMetrics({likes:'0',comments:'-1',saves:'NaN',shares:null,plays:'0'},'douyin');
 assert.ok(html.includes('<b>0</b> 点赞'));
 assert.equal((html.match(/<b>—<\/b>/g)??[]).length,4);
 assert.ok(renderPlatformMetrics({likes:'0',views:'0'},'x').includes('<b>0</b> 浏览'));
 assert.equal((renderPlatformMetrics({},'douyin').match(/<b>—<\/b>/g)??[]).length,5);
});

test('抖音未知播放项在卡片、详情和阅读器保留未知及补采提示；有效播放与X浏览零值保留',()=>{
 for(const plays of [undefined,null,'0','00','-1','NaN',0]){
  const metrics:JsonObject={likes:'0',comments:'2'};if(plays!==undefined)metrics.plays=plays;
  const r=row({metrics}),html=renderBenchmarkMaterialList([r],{action:'cfg-benchmark-record',platform:'douyin'});
  assert.ok(html.includes('<b>—</b> 播放'));assert.ok(html.includes('尚未取得真实播放数'));assert.ok(html.includes('<b>0</b> 点赞'));assert.ok(!html.includes('<b>0</b> 播放'));
  const record:SourceRecordDetail={...r,body:'正文',media:[],external_links:[],parser_warnings:[],benchmark:{platform:'douyin',metrics:r.metrics!}};
  assert.ok(renderBenchmarkRecord(record).includes('<b>—</b> 播放'));
  assert.ok(renderBenchmarkExtras({media:[],benchmark:record.benchmark}).includes('<b>—</b> 播放'));
 }
 const valid=renderPlatformMetrics({likes:'0',plays:'215879'},'douyin');assert.ok(valid.includes('播放 215879'));assert.ok(valid.includes(' 播放'));
 assert.ok(renderPlatformMetrics({views:'0'},'x').includes('<b>0</b> 浏览'));
 assert.ok(renderPlatformMetrics({views:'215879'},'x').includes('浏览 215879'));
});

test('时长只接受安全正整数毫秒，图文不显示视频时长，缺图和坏日期有占位',()=>{
 for(const value of [undefined,null,'0','-100','1.5','Infinity','9007199254740992',129967])assert.equal(formatBenchmarkDuration(value),null);
 assert.equal(formatBenchmarkDuration('100'),'0:01');
 assert.equal(formatBenchmarkDuration('3601000'),'1:00:01');
 const html=renderBenchmarkMaterialList([row({media_type:'image',duration_ms:'129967',preview_url:null,published_at:'bad'})],{action:'benchmark-record'});
 assert.ok(html.includes('图文'));assert.ok(html.includes('暂无封面'));assert.ok(!html.includes('2:09'));assert.ok(!html.includes('Invalid Date'));
});

test('不安全媒体地址、账号凭据和HTML不会成为可执行标记',()=>{
 for(const preview of ['javascript:alert(1)','http://example.com/cover.jpg','https://user:secret@example.com/cover.jpg']){
  const html=renderBenchmarkMaterialList([row({preview_url:preview,title:'<script>标题</script>',summary:'<img onerror=bad>'})],{action:'cfg-benchmark-record'});
  assert.ok(!html.includes('<img data-platform-image'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
 }
});

test('完整素材把媒体与原文入口放在长正文前，保留完整正文，指标只出现一次',()=>{
 const record:SourceRecordDetail={...row(),author_name:'作者',body:'长正文\n'.repeat(300)+'<script>正文</script>',canonical_url:'https://www.douyin.com/video/123',external_links:[],parser_warnings:[],media:[{type:'video',play_url:'https://video.example.com/123.mp4',preview_url:'https://image.example.com/123.jpeg',duration_ms:'129967'}],benchmark:{metrics:{likes:'9377'},collected_at:'2026-10-13T03:00:00Z'}};
 const html=renderBenchmarkRecord(record);
 assert.ok(html.indexOf('<video')<html.indexOf('configuration-material-body'));
 assert.ok(html.indexOf('打开平台原文')<html.indexOf('configuration-material-body'));
 assert.ok(html.includes(record.body!.replace('<script>正文</script>','&lt;script&gt;正文&lt;/script&gt;')));
 assert.equal((html.match(/class="benchmark-work-metrics"/g)??[]).length,1);
});


test('对标卡片使用原生平台图标并保留独立账号头像',()=>{
 for(const [platform,file,name] of [['x','x.svg','X'],['douyin','douyin.svg','抖音'],['xiaohongshu','xiaohongshu.svg','小红书'],['wechat','wechat.svg','公众号'],['bilibili','bilibili.svg','B 站']]){
  const html=renderBenchmarkAccounts([{id:'a',name:'账号',platform,url:'https://example.com',focus:'方向',reason:'说明',workCount:1,profile:{avatar_url:'https://example.com/avatar.jpg'}}] as Parameters<typeof renderBenchmarkAccounts>[0]);
  assert.ok(html.includes('/workbench/platforms/'+file));assert.ok(html.includes('role="img" aria-label="'+name+'"'));
  assert.ok(html.includes('src="https://example.com/avatar.jpg" alt="账号的平台头像"'));
 }
});


test('专用统计已核对的真实零播放可显示且注明口径，普通feed零值与伪来源保持未知',()=>{
 const source={status:'available',source_kind:'tikhub_douyin_video_statistics',collected_at:'2026-10-13T12:00:00Z',observed_time_basis:'unknown'};
 const html=renderPlatformMetrics({plays:'0'},'douyin',{plays:source});assert.ok(html.includes('<b>0</b> 播放'));assert.ok(html.includes('观察时点未知'));assert.ok(html.includes('不含 Dou+ 推广流量'));
 for(const plays of [{...source,status:'unverified'},{...source,source_kind:'ordinary_feed'},null]){const untrusted=renderPlatformMetrics({plays:'0'},'douyin',{plays});assert.ok(untrusted.includes('<b>—</b> 播放'));assert.ok(!untrusted.includes('<b>0</b> 播放'));}
 const summary=row({metrics:{plays:'0'},metric_sources:{plays:source}});assert.ok(renderBenchmarkMaterialList([summary],{action:'benchmark-record'}).includes('<b>0</b> 播放'));
 const detail:SourceRecordDetail={...summary,body:'原有正文',external_links:[],media:[],parser_warnings:[],benchmark:{platform:'douyin',metrics:summary.metrics!,metric_sources:summary.metric_sources!}};
 assert.ok(renderBenchmarkRecord(detail).includes('<b>0</b> 播放'));assert.ok(renderBenchmarkExtras({media:[],benchmark:detail.benchmark}).includes('<b>0</b> 播放'));
});
