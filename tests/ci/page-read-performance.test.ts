import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadScope,withReadScope} from '../../apps/web/src/transport/read-scope.ts';
import {waitForegroundGeneration} from '../../apps/web/src/features/create/ai-actions/index.ts';
import type {WorkbenchClient} from '../../apps/web/src/transport/workbench-client.ts';
import {fixture} from '../documents/harness.ts';
import {Sources} from '../../packages/domain/src/sources/index.ts';
import {recordSummary,sourcePage} from '../../packages/storage/src/sources/index.ts';
import {Topics} from '../../packages/domain/src/topics/index.ts';
import {createContentDocumentsFeaturePort} from '../../apps/web/src/features/create/documents/index.ts';
import {DraftRegistry} from '../../apps/web/src/transport/drafts.ts';
import {initialUi} from '../../apps/web/src/app/view-model.ts';
import {emptyIngestView} from '../../apps/web/src/features/sources/read/index.ts';
import {createApprovedPageViews} from '../../apps/web/src/pages/approvedViews.ts';
import type {FeatureContext} from '../../apps/web/src/transport/feature-ports.ts';

function client(request:WorkbenchClient['request']):WorkbenchClient{return {request,identity:async()=>({workspace_id:'fixture',service_instance_id:'fixture',contract_version:'0.1.1'}),getSettings:signal=>request('GET','/api/v1/settings',undefined,{signal}),getDocument:(id,signal)=>request('GET','/api/v1/documents/'+id,undefined,{signal}),patchSettings:(input,options)=>request('PATCH','/api/v1/settings',input,options),saveDocument:(id,input,options)=>request('POST','/api/v1/documents/'+id+'/revisions',input,options),cancelJob:(id,version,options)=>request('POST','/api/v1/jobs/'+id+'/cancel',{expected_version:version},options)};}
test('单次加载中并行和串行相同GET只读取一次，返回独立投影',async()=>{
 let calls=0;const base=client(async()=>{calls++;return {items:[{id:'saved'}]} as any;}),scope=createReadScope(base);
 const [a,b]=await Promise.all([scope.client.request<any>('GET','/api/v1/topics?limit=50&cursor=c'),scope.client.request<any>('GET','/api/v1/topics?cursor=c&limit=50')]);a.items[0].id='consumer-edit';assert.equal(b.items[0].id,'saved');await scope.client.request('GET','/api/v1/topics?limit=50&cursor=c');assert.equal(calls,1);scope.close();await scope.client.request('GET','/api/v1/topics?limit=50&cursor=c');assert.equal(calls,2);
});
test('任何mutation以及下一加载清空读取，文稿保存后不得返回旧head',async()=>{
 let head=1,reads=0;const base=client(async(method)=>{if(method==='GET'){reads++;return {head_revision_id:'r'+head} as any;}head++;return {} as any;}),scope=createReadScope(base);
 assert.equal((await scope.client.getDocument('doc')).head_revision_id,'r1');await scope.client.saveDocument('doc',{expected_revision_id:'r1',text:'人工输入',origin:'human'});assert.equal((await scope.client.getDocument('doc')).head_revision_id,'r2');await scope.client.request('POST','/api/v1/topics/topic/operations/ensure',{});assert.equal((await scope.client.getDocument('doc')).head_revision_id,'r3');scope.close();const next=createReadScope(base);await next.client.getDocument('doc');assert.equal(reads,4);next.close();
});
test('失败GET不缓存、工作区client之间不共享响应',async()=>{
 let attempts=0;const a=createReadScope(client(async()=>{if(++attempts===1)throw new Error('temporary');return {workspace:'a'} as any;}));await assert.rejects(a.client.request('GET','/api/v1/topics'),/temporary/);assert.equal((await a.client.request<any>('GET','/api/v1/topics')).workspace,'a');const b=createReadScope(client(async()=>({workspace:'b'} as any)));assert.equal((await b.client.request<any>('GET','/api/v1/topics')).workspace,'b');a.close();b.close();
});
test('写入进行中读取不留cache，收到保存ACK后重新读取最新head',async()=>{
 let head=1,release!:()=>void;const scope=createReadScope(client(async method=>{if(method==='GET')return {head_revision_id:'r'+head} as any;await new Promise<void>(done=>{release=done;});head++;return {} as any;}));
 await scope.client.getDocument('doc');const saving=scope.client.saveDocument('doc',{expected_revision_id:'r1',text:'人工更新',origin:'human'});assert.equal((await scope.client.getDocument('doc')).head_revision_id,'r1');release();await saving;assert.equal((await scope.client.getDocument('doc')).head_revision_id,'r2');scope.close();
});
test('job、候选、运营和指标轮询每次读取，不复用同一action最早状态',async()=>{
 const counts=new Map<string,number>(),scope=createReadScope(client(async(_method,path)=>{const count=(counts.get(path)??0)+1;counts.set(path,count);return {version:count,state:count===1?'running':'succeeded'} as any;}));
 for(const path of ['/api/v1/jobs/job','/api/v1/jobs/job/events','/api/v1/documents/doc/candidates','/api/v1/topics/topic/operations','/api/v1/topics/topic/writing-runs?summary=1','/api/v1/works/work/snapshots']){await scope.client.request('GET',path);assert.equal((await scope.client.request<any>('GET',path)).state,'succeeded');assert.equal(counts.get(path),2);}scope.close();
});
test('草稿由base client提交后，显式失效递归清除嵌套读取scope',async()=>{
 let head=1;const base=client(async method=>{if(method==='GET')return {head_revision_id:'r'+head} as any;head++;return {} as any;}),outer=createReadScope(base),inner=createReadScope(outer.client);
 await inner.client.getDocument('doc');await base.saveDocument('doc',{expected_revision_id:'r1',text:'人工更新',origin:'human'});inner.client.invalidateReads!();assert.equal((await inner.client.getDocument('doc')).head_revision_id,'r2');inner.close();outer.close();
});
test('导航取消仅传给GET，已经授权的保存不会继承导航abort',async()=>{
 const abort=new AbortController(),signals:AbortSignal[]=[];let writes=0;const base=client(async(method,_path,_body,options)=>{if(method!=='GET'){writes++;assert.equal(options?.signal,undefined);return {} as any;}const current=options?.signal!;signals.push(current);return await new Promise((_done,reject)=>current.addEventListener('abort',()=>reject(current.reason),{once:true}));}),scope=createReadScope(base,abort.signal);
 const pending=scope.client.getDocument('old');abort.abort(new DOMException('changed page','AbortError'));await assert.rejects(pending,{name:'AbortError'});assert.ok(signals[0]!.aborted);await scope.client.saveDocument('doc',{expected_revision_id:null,text:'最新人工输入',origin:'human'});assert.equal(writes,1);scope.close();
});
test('任务accepted晚于离页，action仍可读原job并沿原协议取消',async()=>{
 const navigation=new AbortController(),lifetime=new AbortController();navigation.abort();let cancelled=0;
 const base=client(async(method,path,_body,options)=>{assert.ok(!options?.signal?.aborted);if(method==='POST'&&path.endsWith('/cancel')){cancelled++;return {} as any;}return {job:{id:'late-job',state:'running',version:2}} as any;});
 const context={client:base,signal:lifetime.signal,readSignal:navigation.signal,ui:initialUi('create'),surface:{}} as unknown as FeatureContext;
 const feature=withReadScope({page:'create',load:async scoped=>emptyIngestView(scoped),dispatch:async(_action,scoped)=>{assert.equal(await waitForegroundGeneration(scoped,{job_id:'late-job'},'原任务',()=>false,false),null);}});
 await feature.dispatch({action:'ai-suggest',dataset:{},fields:{}},context);assert.equal(cancelled,1);
});
test('资料分页批量投影保持逐项读取语义，SQL数不随50张卡增长',()=>{
 const f=fixture();try{const sources=new Sources(f.context()),db=f.context().db,w=f.context().identity.workspace_id;for(let i=0;i<120;i++){const created=sources.create(f.request(),{title:'性能样本 '+i,text:'正文 '+i,category:'AI 实测'});if(i%3===0)sources.marks(f.request(),created.record_id,{favorite:true,read:true});}
 const prepare=db.prepare.bind(db);let queries=0;db.prepare=((sql:string)=>{queries++;return prepare(sql);}) as typeof db.prepare;
 for(const filters of [{},{favorite:true},{category:'AI 实测',limit:25}]){queries=0;const page=sourcePage(db,w,filters);assert.ok(page.items.length);assert.ok(queries<=5,'page SQL count='+queries);for(const item of page.items){const row=prepare('SELECT * FROM source_records WHERE workspace_id=? AND id=?').get(w,item.id)!;assert.deepEqual(item,recordSummary(db,w,row));assert.ok(!('payload' in item));assert.ok(!('summary_favorite' in item));}if(page.next_cursor){queries=0;const next=sourcePage(db,w,{...filters,cursor:page.next_cursor});assert.ok(queries<=5);assert.ok(!next.items.some(item=>page.items.some(old=>old.id===item.id)));}}
 }finally{f.cleanup();}
});

test('无type的hot-topics在普通、收藏和精选批量读取中保持详情的current语义',async()=>{
 const f=fixture();try{const sources=new Sources(f.context()),db=f.context().db,w=f.context().identity.workspace_id;sources.ensurePublicSources('https://site.example.invalid');const hot=sources.list(f.request()).items.find(source=>source.external_id==='hot-topics')!;
 const entry=(id:string,rank:number)=>({id,rank,title:'事件 '+id,summary:'摘要',selected:true,status:'active',score:80,reason:'保存依据',firstAt:'2026-10-12T00:00:00Z',links:{site:'https://site.example.invalid/hot/event/'+id+'/'}});
 await sources.ingest(String(hot.id),{fetcher:async()=>new Response(JSON.stringify({schemaVersion:1,generatedAt:'2026-10-12T00:00:00Z',topics:[entry('old',1)]}))});const old=sources.records(f.request(),{curated:true}).items[0]!;sources.create(f.request(),{url:old.canonical_url!,title:old.title,text:'本人保存历史资料'});sources.marks(f.request(),old.id,{favorite:true});
 await sources.ingest(String(hot.id),{fetcher:async()=>new Response(JSON.stringify({schemaVersion:1,generatedAt:'2026-10-13T00:00:00Z',topics:Array.from({length:30},(_,i)=>entry('current-'+i,i+1))}))});
 const prepare=db.prepare.bind(db);let queries=0;db.prepare=((sql:string)=>{queries++;return prepare(sql);}) as typeof db.prepare;
 for(const filters of [{},{favorite:true},{curated:true}]){queries=0;const page=sourcePage(db,w,filters);assert.ok(queries<=4,'page SQL count='+queries);for(const item of page.items){const row=prepare('SELECT * FROM source_records WHERE workspace_id=? AND id=?').get(w,item.id)!;assert.deepEqual(item,recordSummary(db,w,row));assert.equal(item.curation?.current,item.id!==old.id);assert.equal(item.curation?.type,undefined);}}
 }finally{f.cleanup();}
});

test('主题概要只有SQL元信息，历史核心审批不能确认新head',async()=>{
 const f=fixture();try{const topics=new Topics(f.context()),topic=await topics.create(f.request(),{title:'元信息主题',category:'AI 实测',audience:'',source_ids:[]}),db=f.context().db,w=f.context().identity.workspace_id;
 const revision=db.prepare("INSERT INTO document_revisions(id,workspace_id,document_id,parent_revision_id,file_path,sha256,origin,change_kind,created_by) VALUES(?,?,?,?,?,?,'human','text','fixture')");revision.run('old',w,topic.core_document_id,null,f.root+'/never-read-old.md','0'.repeat(64));revision.run('new',w,topic.core_document_id,'old',f.root+'/never-read-new.md','1'.repeat(64));db.prepare('UPDATE documents SET head_revision_id=? WHERE workspace_id=? AND id=?').run('old',w,topic.core_document_id);db.prepare("INSERT INTO core_approvals(id,workspace_id,topic_id,revision_id,approved_at,actor) VALUES(?,?,?,?,?,'fixture')").run('approval',w,topic.id,'old','2026-10-13T00:00:00Z');
 assert.equal(topics.list(f.request()).items[0]!.read_state!.core_confirmed,true);db.prepare('UPDATE documents SET head_revision_id=?,version=version+1 WHERE workspace_id=? AND id=?').run('new',w,topic.core_document_id);const row=topics.list(f.request()).items[0]!;assert.equal(row.read_state!.core_confirmed,false);assert.equal(row.read_state!.core_revision_id,'new');assert.ok(!('text' in row));assert.ok(!('has_text' in row.read_state!));
 }finally{f.cleanup();}
});

function documentHarness(){
 const docs=new Map<string,any>(),rows=['first','second'].map(id=>{const core={document_id:'core-'+id,head_revision_id:'core-r-'+id,version:1,text:'真实核心稿 '+id,hash:null,save_state:'committed'},variants=['x','wechat'].map(platform=>{const doc={document_id:platform+'-'+id,head_revision_id:platform+'-r-'+id,version:1,text:'# '+platform+'\n\n真实平台正文 '+id,hash:null,save_state:'committed'};docs.set(doc.document_id,doc);return {id:'variant-'+doc.document_id,platform,format:platform==='x'?'text':'article',document_id:doc.document_id,based_on_core_revision_id:core.head_revision_id};});docs.set(core.document_id,core);return {id,title:'主题 '+id,category:'AI 实测',audience:'',angle:'',core_document_id:core.document_id,status:'active',version:1,expected_effort_min:0,core,core_approval:{approval_id:'approval-'+id},variants,source_ids:['source-'+id],assets:[],shots:[],preparation_plan_id:'plan-'+id,preparation_head_revision_id:'plan-r-'+id,read_state:{core_revision_id:core.head_revision_id,core_version:1,core_confirmed:true,variants:variants.map(v=>({...v,head_revision_id:docs.get(v.document_id).head_revision_id,parent_revision_id:'previous-'+v.document_id,document_version:1}))}};});
 const calls:string[]=[],dialogs:any[]=[],ui={...initialUi('create'),topic:'first',platform:'x'},abort=new AbortController();let hook:((url:string)=>Promise<unknown>|undefined)|undefined;
 const base=client(async(method,url)=>{calls.push(method+' '+url);const delayed=hook?.(url);if(delayed)return await delayed as any;if(url==='/api/v1/topics')return {items:rows.map(({core,variants,assets,shots,...row})=>row),next_cursor:null} as any;if(url.startsWith('/api/v1/topics/'))return structuredClone(rows.find(row=>url.endsWith('/'+row.id))) as any;if(url.includes('/revisions/'))return {revision_id:url.split('/').at(-1),parent_revision_id:'previous',text:'真实上版正文'} as any;if(url.startsWith('/api/v1/documents/'))return structuredClone(docs.get(url.split('/')[4]!)) as any;return {} as any;});
 const drafts=new DraftRegistry(base,{workspace_id:'fixture',service_instance_id:'fixture',contract_version:'0.1.1'},{getItem:()=>null,setItem(){},removeItem(){}});
 const context={client:base,identity:{workspace_id:'fixture',service_instance_id:'fixture',contract_version:'0.1.1'},ui,signal:abort.signal,drafts,surface:{updateUi(patch:object){Object.assign(ui,patch);},editorFeedback(){},presentDialog(value:unknown){dialogs.push(value);},closeDialog(){},toast(){},navigate(){}}} as unknown as FeatureContext;
 const feature=createContentDocumentsFeaturePort({loadBase:async scoped=>emptyIngestView(scoped)});
 return {feature,context,ui,calls,dialogs,set hook(value:typeof hook){hook=value;},cleanup(){abort.abort();drafts.dispose();}};
}
test('核心首屏只读当前主题；切平台才读取对应正文，排期保留所有有head的选项',async()=>{
 const h=documentHarness();try{const first=await h.feature.load(h.context);assert.deepEqual(h.calls,['GET /api/v1/topics','GET /api/v1/topics/first']);assert.equal(first.state.topics[1]!.detailsLoaded,false);assert.equal(first.state.topics[1]!.versions.x!.contentLoaded,false);h.calls.length=0;
 const versions=(await h.feature.dispatch({action:'edit-tab',dataset:{value:'versions'},fields:{}},h.context))!;assert.equal(versions.state.topics[0]!.versions.x!.text,'真实平台正文 first');assert.ok(h.calls.includes('GET /api/v1/documents/x-first'));assert.ok(!h.calls.some(call=>call.includes('wechat-first')||call.includes('/revisions/')));h.calls.length=0;
 await h.feature.dispatch({action:'platform-tab',dataset:{value:'wechat'},fields:{}},h.context);assert.ok(h.calls.includes('GET /api/v1/documents/wechat-first'));assert.ok(!h.calls.includes('GET /api/v1/documents/x-first'));
 h.ui.page='schedule';h.calls.length=0;const schedule=await h.feature.load(h.context);assert.deepEqual(schedule.state.topics.map(topic=>Object.keys(topic.versions)),[['x','wechat'],['x','wechat']]);assert.ok(!h.calls.some(call=>call.startsWith('GET /api/v1/documents/')));
 }finally{h.cleanup();}
});
test('未读取主题或平台稿不呈现可编辑空正文；旧平台历史晚到不能打开弹窗',async()=>{
 const h=documentHarness();try{const view=await h.feature.load(h.context);const html=createApprovedPageViews({...view,ui:{...view.ui,topic:'second'}}).create();assert.ok(!html.includes('id="core-editor"'));assert.match(html,/正在读取已保存的核心稿/);const platform=createApprovedPageViews({...view,ui:{...view.ui,editTab:'versions',platform:'wechat'}}).create();assert.ok(!platform.includes('id="version-text"'));assert.match(platform,/正在读取已保存的平台稿/);
 let release!:(value:unknown)=>void;h.hook=url=>url.includes('/revisions/')?new Promise(done=>{release=done;}):undefined;const pending=h.feature.dispatch({action:'previous-version',dataset:{},fields:{}},h.context);for(let i=0;i<10;i++)await Promise.resolve();assert.ok(release);h.ui.platform='wechat';release({revision_id:'old',parent_revision_id:'older',text:'旧平台迟到正文'});await pending;assert.equal(h.dialogs.length,0);assert.ok(!h.calls.some(call=>call.startsWith('POST')));
 }finally{h.cleanup();}
});
