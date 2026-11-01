import test from 'node:test';
import assert from 'node:assert/strict';
import {createNavigationCache,READ_ONLY_NAVIGATION_ACTIONS} from '../../apps/web/src/transport/navigation-cache.ts';
import {initialUi} from '../../apps/web/src/app/view-model.ts';
import {emptyIngestView} from '../../apps/web/src/features/sources/read/index.ts';
import type {FeatureContext} from '../../apps/web/src/transport/feature-ports.ts';
import type {WorkbenchClient} from '../../apps/web/src/transport/workbench-client.ts';
import type {ServiceIdentity} from '../../packages/contracts/src/index.ts';
import {renderPlatformVideo} from '../../apps/web/src/components/platform-video.ts';
const identity:ServiceIdentity={workspace_id:'cache-fixture',service_instance_id:'cache-service',contract_version:'0.1.1'};
function harness(request:WorkbenchClient['request']=async()=>({} as never),limit=12){
  const base:WorkbenchClient={request,identity:async()=>identity,getSettings:signal=>request('GET','/api/v1/settings',undefined,{signal}),getDocument:(id,signal)=>request('GET','/api/v1/documents/'+id,undefined,{signal}),patchSettings:(body,options)=>request('PATCH','/api/v1/settings',body,options),saveDocument:(id,body,options)=>request('POST','/api/v1/documents/'+id+'/revisions',body,options),cancelJob:(id,version,options)=>request('POST','/api/v1/jobs/'+id+'/cancel',{expected_version:version},options),upload:async()=>({} as never)};
  const cache=createNavigationCache(base,limit),ui=initialUi('sources'),view=emptyIngestView({ui} as FeatureContext);cache.bind(identity);
  return {cache,ui,view,remember(){cache.remember(identity,ui,view);}};
}
test('跨导航只复用独立呈现快照，GET与任务读取始终实时访问服务',async()=>{
  let reads=0;const h=harness(async()=>({sequence:++reads} as never));h.remember();const a=h.cache.recall(identity,h.ui)!,b=h.cache.recall(identity,h.ui)!;a.state.notes.changed='caller';assert.equal(b.state.notes.changed,undefined);
  for(const path of ['/api/v1/topics','/api/v1/jobs/job','/api/v1/settings/configuration']){await h.cache.client.request('GET',path);await h.cache.client.request('GET',path);}assert.equal(reads,6);
});
test('身份、主题、平台、筛选和周期分键，设置/凭据不进入页面cache',()=>{
  const h=harness();h.remember();assert.equal(h.cache.recall(identity,{...h.ui,sourceQuery:'new query'}),undefined);assert.equal(h.cache.recall({...identity,workspace_id:'another'},h.ui),undefined);assert.equal(h.cache.recall(identity,h.ui),undefined);
  h.ui.page='create';h.ui.topic='first';h.remember();assert.equal(h.cache.recall(identity,{...h.ui,topic:'second'}),undefined);assert.equal(h.cache.recall(identity,{...h.ui,platform:'wechat'}),undefined);
  h.ui.page='retro';h.remember();assert.equal(h.cache.recall(identity,{...h.ui,period:30}),undefined);
  h.ui.page='settings';h.remember();assert.equal(h.cache.recall(identity,h.ui),undefined);assert.equal(h.cache.recall({...identity,service_instance_id:'replacement'},h.ui),undefined);
});
test('文稿/配置/采用/上传写入从开始到ACK失效所有依赖页，迟到的读取不能重新留cache',async()=>{
  let release!:()=>void;const h=harness(async()=>{await new Promise<void>(done=>release=done);return {} as never;});h.remember();const oldEpoch=h.cache.epoch;
  const saving=h.cache.client.saveDocument('doc',{expected_revision_id:'old',text:'本人输入',origin:'human'});assert.equal(h.cache.recall(identity,h.ui),undefined);h.remember();assert.equal(h.cache.recall(identity,h.ui),undefined);release();await saving;
  h.cache.remember(identity,h.ui,h.view,oldEpoch);assert.equal(h.cache.recall(identity,h.ui),undefined);
  for(const mutation of [()=>h.cache.client.patchSettings({expected_version:1,default_executor:'codex'}),()=>h.cache.client.request('POST','/api/v1/candidates/c/adoption',{}),()=>h.cache.client.cancelJob('job',1)]){h.remember();const pending=mutation();assert.equal(h.cache.recall(identity,h.ui),undefined);release();await pending;assert.equal(h.cache.recall(identity,h.ui),undefined);}
  h.remember();await h.cache.client.upload!('/api/v1/assets',new File(['fixture'],'fixture.txt'),{});assert.equal(h.cache.recall(identity,h.ui),undefined);
});
test('导航ensure仅失效对应主题的运营投影，核心稿与其他主题呈现快照保留',async()=>{
  const h=harness();h.ui.page='create';h.ui.topic='first';h.view.projections.operations={topicId:'first'} as never;h.view.state.notes.saved='本人已保存正文';h.remember();h.ui.topic='second';h.view.projections.operations={topicId:'second'} as never;h.remember();
  await h.cache.client.request('POST','/api/v1/topics/first/operations/ensure',{});
  assert.equal(h.cache.recall(identity,{...h.ui,topic:'first'})!.projections.operations,undefined);assert.equal(h.cache.recall(identity,{...h.ui,topic:'first'})!.state.notes.saved,'本人已保存正文');assert.equal(h.cache.recall(identity,h.ui)!.projections.operations!.topicId,'second');
});
test('观点ensure从不复用回执且不清空未依赖观点的页面，观点保存仍失效',async()=>{
  let calls=0;const h=harness(async()=>({document_id:'viewpoints',sequence:++calls} as never));h.remember();await h.cache.client.request('POST','/api/v1/topics/first/viewpoints',{});await h.cache.client.request('POST','/api/v1/topics/first/viewpoints',{});assert.equal(calls,2);assert.ok(h.cache.recall(identity,h.ui));await h.cache.client.saveDocument('viewpoints',{expected_revision_id:null,text:'本题观点',origin:'human'});assert.equal(h.cache.recall(identity,h.ui),undefined);
});
test('握手发现服务身份切换后，旧草稿和所有后续读写被隔离，不能使用transport的新身份写旧内容',async()=>{
  let current=identity,calls=0;const h=harness(async()=>{calls++;return {} as never;}),cache=createNavigationCache({...h.cache.client,identity:async()=>current});cache.bind(identity);cache.remember(identity,h.ui,h.view);await cache.client.identity();current={...identity,workspace_id:'replacement'};await assert.rejects(cache.client.identity(),/工作区身份已变化/);assert.equal(cache.recall(identity,h.ui),undefined);
  for(const action of [()=>cache.client.saveDocument('old-document',{expected_revision_id:'old',text:'本机旧草稿',origin:'human'}),()=>cache.client.getDocument('old-document'),()=>cache.client.getSettings(),()=>cache.client.request('GET','/api/v1/topics')])await assert.rejects(async()=>action(),/工作区身份已变化/);assert.equal(calls,0);
});
test('cache有界，显式失效可用于草稿ACK；只读交互不开放任何决定',()=>{
  const h=harness(undefined,2);for(const query of ['one','two','three']){h.ui.sourceQuery=query;h.remember();}assert.equal(h.cache.recall(identity,{...h.ui,sourceQuery:'one'}),undefined);h.cache.client.invalidateReads!();assert.equal(h.cache.recall(identity,h.ui),undefined);
  assert.ok(READ_ONLY_NAVIGATION_ACTIONS.has('select-news'));assert.ok(READ_ONLY_NAVIGATION_ACTIONS.has('play-video'));for(const action of ['confirm-core','ai-suggest','apply-suggestion','operations-confirm-candidate','publish','do-publish','publishing-connect','speech-open'])assert.ok(!READ_ONLY_NAVIGATION_ACTIONS.has(action));
});
test('媒体快照保留平台原文和显式expiry，返回呈现时重新判断过期状态',()=>{
  const h=harness(),expires='2026-10-13T09:00:00Z';h.view.NEWS=[{id:'video',title:'已保存作品',category:'AI 实测',time:expires,source:'抖音',summary:'摘要',body:'正文',sources:[],canonical_url:'https://www.douyin.com/video/123',media:[{type:'video',play_url:'https://media.fixture.invalid/video.mp4',expires_at:expires}]}];h.remember();const row=h.cache.recall(identity,h.ui)!.NEWS[0]!,html=renderPlatformVideo(row.media![0]!,{platform:'douyin',originalUrl:row.canonical_url,now:Date.parse(expires)+1});assert.ok(!html.includes('<video'));assert.ok(html.includes('视频地址已过期'));assert.ok(html.includes('https://www.douyin.com/video/123'));
});
