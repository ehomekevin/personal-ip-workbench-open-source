import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageGenerationController,canUseImageOperation,isUnknownImageJob,verifiedImageUrl,imageMetadata} from '../../apps/web/src/features/media/image-generation.ts';
import {renderSettings} from '../../apps/web/src/features/settings/settings.ts';
import {ConfigurationController} from '../../apps/web/src/features/settings/configuration.ts';
import type {ImageProviderSettingsResponse,JobDetailResponse,SettingsResponse} from '../../packages/contracts/src/index.ts';
import type {FeatureContext} from '../../apps/web/src/transport/feature-ports.ts';
const channels:ImageProviderSettingsResponse={version:2,default_provider:'agy',channels:[{provider:'agy',label:'AGY · Nano Banana',enabled:true,configured:true,identity:'unknown',connection:'connected',permission:'observed_submit',model:'gemini-3.1-flash-image',operations:{generation:'supported',reference_edit:'supported',mask:'unverified',writing:'unverified'},last_job_id:null,last_asset_id:null,limitations:['身份尚未独立核对']},{provider:'codex',label:'Codex 图像',enabled:true,configured:true,identity:'authenticated',connection:'unverified',permission:'unknown',model:null,operations:{generation:'supported',reference_edit:'unverified',mask:'unverified',writing:'unverified'},last_job_id:null,last_asset_id:null,limitations:['模型以原生回执为准']}]};
const job=(state='queued'):JobDetailResponse=>({job:{id:'image-job',target_id:'topic',kind:'media_generate',state,version:2,input_hash:'fixed-input',input_manifest:JSON.stringify({operation:'image_provider',provider:'agy'})},attempts:[],checkpoint:null,artifacts:[],error:null,receipts:[]} as unknown as JobDetailResponse);
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
const action=(name:string,dataset:Record<string,string>={})=>({dataset:{action:name,...dataset}} as unknown as HTMLElement);
function fixture(){
 const fields=new Map<string,{value:string;checked?:boolean}>(),dialogs:any[]=[],calls:{method:string;url:string;body:unknown}[]=[],cancelled:string[]=[],toasts:string[]=[],busyEvents:boolean[]=[],dialogErrors:string[]=[];const panel={innerHTML:''},body={querySelector:()=>({remove:()=>{dialogErrors.length=0;}}),insertAdjacentHTML:(_position:string,html:string)=>dialogErrors.push(html)};let active=true,reader:(_method:string,url:string,body:unknown)=>Promise<any>=async(_m,url)=>url.endsWith('image-providers')?structuredClone(channels):url.includes('/assets?')||url.includes('/jobs?')?{items:[],next_cursor:null}:url==='/api/v1/topics/topic'?{core_document_id:'core',core:{head_revision_id:'core-r1'},preparation_head_revision_id:'plan-r1'}:url.includes('/jobs/')?job():{job_id:'image-job',input_hash:'fixed-input',state:'queued'},leave=async()=>{};
 const defaultReader=reader;
 const root={querySelector:(selector:string)=>selector==='#dialog .dialog-body'?body:selector==='.image-generation-panel'?panel:selector.startsWith('#')?fields.get(selector.slice(1)):null} as unknown as HTMLElement;
 const c={identity:{workspace_id:'ui-unit-workspace',service_instance_id:'ui-unit-service'},ui:{topic:'topic'},signal:new AbortController().signal,client:{request:async(method:string,url:string,body:unknown)=>{calls.push({method,url,body});return reader(method,url,body);},cancelJob:async(id:string)=>{cancelled.push(id);}},drafts:{leave:()=>leave(),status:()=>undefined},surface:{presentDialog:(d:unknown)=>{dialogs.push(d);dialogErrors.length=0;},dialogBusy:(busy:boolean)=>busyEvents.push(busy),toast:(m:string)=>toasts.push(m)}} as unknown as FeatureContext;
 const controller=new ImageGenerationController({root,context:()=>c,active:()=>active,signal:c.signal,toast:m=>toasts.push(m)}),internal=controller as any;internal.topic='topic';
 return {controller,internal,c,fields,dialogs,calls,cancelled,toasts,busyEvents,dialogErrors,panel,defaultReader,setReader:(value:typeof reader)=>{reader=value;},setLeave:(value:typeof leave)=>{leave=value;},deactivate:()=>{active=false;controller.deactivate();}};
}
function form(f:ReturnType<typeof fixture>){for(const [id,value] of Object.entries({'image-provider':'agy','image-operation':'generate','image-prompt':'本轮固定要求','image-purpose':'内容配图','image-reference':''}))f.fields.set(id,{value});}

test('图像 capability 不从渠道名或模型列表推定编辑/mask/文字',()=>{
 assert.equal(canUseImageOperation(channels,'agy','generate'),true);assert.equal(canUseImageOperation(channels,'agy','reference_edit'),true);assert.equal(canUseImageOperation(channels,'codex','reference_edit'),false);assert.equal(canUseImageOperation({...channels,channels:channels.channels.map(c=>({...c,enabled:false}))},'agy','generate'),false);assert.equal(isUnknownImageJob({...job('failed'),error:{code:'RESULT_UNKNOWN'}}),true);
 const settings={default_executor:'claude',version:8,title:'隔离设置',timezone:'Asia/Shanghai',paths:{managed_notes_root:'/notes',state_root:'/state',media_root:'/media'},capabilities:[],executors:[{executor_id:'codex',auth_state:'unknown'},{executor_id:'claude',auth_state:'unknown'}]} as unknown as SettingsResponse;
 const html=renderSettings(settings,{image_providers:channels});assert.match(html,/AI 图像渠道/);assert.match(html,/AGY · Nano Banana/);assert.match(html,/Codex 图像/);assert.match(html,/区域控制/);assert.match(html,/尚未验证/);assert.match(html,/name="default-agent" value="claude" checked/);assert.doesNotMatch(html,/name="default-agent" value="agy"/);
});
test('关闭/离页后的迟到设置或稿件回执不能重新打开图像表单',async()=>{
 const f=fixture(),wait=deferred<void>();try{f.setLeave(()=>wait.promise);const opening=f.controller.dispatch('image-task',{} as HTMLElement);await new Promise(resolve=>setTimeout(resolve,0));f.controller.close('escape');wait.resolve();await opening;assert.equal(f.dialogs.length,1);assert.equal(f.dialogs[0].title,'准备图像任务');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);}finally{f.controller.dispose();}
 const g=fixture(),gate=deferred<any>();try{g.setReader(async()=>gate.promise);const opening=g.controller.dispatch('image-task',{} as HTMLElement);g.deactivate();gate.resolve({items:[],next_cursor:null});await opening;assert.equal(g.dialogs.length,1);}finally{g.controller.dispose();}
});
test('等待保存期间关闭不创建图像任务；请求字段和文稿 revision 与无计划引用冻结',async()=>{
 const f=fixture();try{await f.controller.dispatch('image-task',{} as HTMLElement);form(f);const wait=deferred<void>();f.setLeave(()=>wait.promise);const submit=f.controller.dispatch('image-confirm',{} as HTMLElement).then(()=>f.controller.dispatch('do-image',{} as HTMLElement));f.fields.get('image-prompt')!.value='等待期间后来改的输入';wait.resolve();await submit;const posts=f.calls.filter(c=>c.method==='POST');assert.equal(posts.length,1);assert.deepEqual(posts[0]!.body,{generator:'image',provider:'agy',operation:'generate',topic_id:'topic',purpose:'内容配图',prompt:'本轮固定要求',input_asset_ids:[],parent_asset_id:null,document_revision_id:'core-r1',plan_revision_id:null});assert.match(f.controller.panel(),/image-task[^>]*disabled/);}finally{f.controller.dispose();}
 const g=fixture();try{await g.controller.dispatch('image-task',{} as HTMLElement);form(g);const wait=deferred<void>();g.setLeave(()=>wait.promise);const submit=g.controller.dispatch('image-confirm',{} as HTMLElement).then(()=>g.controller.dispatch('do-image',{} as HTMLElement));g.controller.close();wait.resolve();await submit;assert.equal(g.calls.filter(c=>c.method==='POST').length,0);}finally{g.controller.dispose();}
});
test('稿件或计划变化阻止过时请求；未知任务只查原 ID，0 新 submit',async()=>{
 const f=fixture();try{await f.controller.dispatch('image-task',{} as HTMLElement);form(f);f.setReader(async()=>({core_document_id:'core',core:{head_revision_id:'human-r2'},preparation_head_revision_id:'plan-r1'}));await assert.rejects(f.controller.dispatch('image-confirm',{} as HTMLElement).then(()=>f.controller.dispatch('do-image',{} as HTMLElement)),/稿件或素材计划已变化/);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);}finally{f.controller.dispose();}
 const g=fixture();try{g.internal.current={...job('reconciling'),error:{code:'RESULT_UNKNOWN',message:'原结果待核对'}};g.internal.dialogOpen=true;g.setReader(async()=>job('reconciling'));await g.controller.dispatch('image-query',{dataset:{job:'image-job'}} as unknown as HTMLElement);const posts=g.calls.filter(c=>c.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0]!.url,'/api/v1/jobs/image-job/image-query');assert.deepEqual(posts[0]!.body,{expected_version:2});assert.equal(g.calls.some(c=>c.url==='/api/v1/asset-generations'),false);}finally{g.controller.dispose();}
});
test('创建回执迟到于关闭时撤销原 job，不重开弹窗、不重复提交',async()=>{
 const f=fixture();try{await f.controller.dispatch('image-task',{} as HTMLElement);form(f);const wait=deferred<any>();f.setReader(async(method,url)=>method==='POST'&&url==='/api/v1/asset-generations'?wait.promise:url==='/api/v1/topics/topic'?{core_document_id:'core',core:{head_revision_id:'core-r1'},preparation_head_revision_id:'plan-r1'}:url.endsWith('image-providers')?channels:url.includes('/assets?')||url.includes('/jobs?')?{items:[],next_cursor:null}:job());const submit=f.controller.dispatch('image-confirm',{} as HTMLElement).then(()=>f.controller.dispatch('do-image',{} as HTMLElement));await new Promise(resolve=>setTimeout(resolve,0));const presentations=f.dialogs.length;f.controller.close('escape');wait.resolve({job_id:'image-job',input_hash:'fixed-input',state:'queued'});await submit;assert.equal(f.dialogs.length,presentations);assert.deepEqual(f.cancelled,['image-job']);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);}finally{f.controller.dispose();}
});
test('图片查看拒绝不同 MIME、尺寸或 hash；无正文回执不能伪装图片',async()=>{
 const blob=new Blob(['not an image'],{type:'image/png'}),asset={id:'a',kind:'image',mime:'image/png',size_bytes:blob.size,sha256:'0'.repeat(64),status:'ready'} as const;
 await assert.rejects(verifiedImageUrl(blob,asset),/hash/);await assert.rejects(verifiedImageUrl(new Blob(['x'],{type:'text/plain'}),asset),/格式/);await assert.rejects(verifiedImageUrl(blob,{...asset,size_bytes:999}),/大小/);assert.deepEqual(imageMetadata({...asset,generation_metadata:'invalid'}),{});
});
test('图像配置保存只 PUT 独立版本，不改 writing 默认设置',async()=>{
 const calls:{method:string;path:string;body:any}[]=[],options={root:{querySelector:()=>null},client:{request:async(method:string,path:string,body:any)=>{calls.push({method,path,body});return {...channels,version:3,default_provider:'codex'};}},signal:new AbortController().signal,settings:()=>({default_executor:'claude'}),setSettings:()=>{throw new Error('writing settings must not change');},context:()=>({}),render:()=>{},toast:()=>{},navigate:()=>{}};
 const c=new ConfigurationController(options as any),internal=c as any;c.state.image_providers=channels;c.state.image_draft={default_provider:'codex',enabled:{agy:true,codex:true}};internal.imageVersion=2;await internal.perform('image-providers',{dataset:{}});assert.deepEqual(calls,[{method:'PUT',path:'/api/v1/settings/image-providers',body:{expected_version:2,default_provider:'codex',enabled:{agy:true,codex:true}}}]);assert.equal(c.state.image_providers?.version,3);
});

 test('创建请求断连且没有 job ID 时保留输入并禁止再次 submit',async()=>{
 const f=fixture();try{await f.controller.dispatch('image-task',{} as HTMLElement);form(f);f.setReader(async(method,url)=>method==='POST'&&url==='/api/v1/asset-generations'?Promise.reject(new Error('transport connection lost')):{core_document_id:'core',core:{head_revision_id:'core-r1'},preparation_head_revision_id:'plan-r1'});await assert.rejects(f.controller.dispatch('image-confirm',{} as HTMLElement).then(()=>f.controller.dispatch('do-image',{} as HTMLElement)),/connection lost/);assert.equal(f.internal.pending.job_id,null);assert.equal(f.internal.pending.input.prompt,'本轮固定要求');assert.match(f.controller.panel(),/本轮固定要求/);await assert.rejects(f.controller.dispatch('image-confirm',{} as HTMLElement).then(()=>f.controller.dispatch('do-image',{} as HTMLElement)),/不能重发/);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);}finally{f.controller.dispose();}
 });


test('真实 handle 链丢弃旧 reject，当前请求错误仍显示在原 dialog/panel/toast',async()=>{
 const f=fixture(),old=deferred<any>();let reads=0;
 try{
  f.setReader(async(method,url,body)=>url==='/api/v1/topics/topic'&&++reads===1?old.promise:f.defaultReader(method,url,body));
  assert.equal(f.controller.handle(action('image-task')),true);await settle();assert.equal(reads,1);
  f.controller.close('escape');assert.equal(f.internal.loading,false);f.controller.handle(action('image-task'));await settle();form(f);f.fields.get('image-prompt')!.value='新表单输入与焦点归新请求';f.controller.handleInput({id:'image-prompt'} as HTMLInputElement);
  const presented=f.dialogs.length;old.reject(new Error('OLD 500'));await settle();
  assert.equal(f.dialogs.length,presented);assert.equal(f.fields.get('image-prompt')!.value,'新表单输入与焦点归新请求');assert.equal(f.internal.draft.prompt,'新表单输入与焦点归新请求');assert.deepEqual(f.toasts,[]);assert.deepEqual(f.dialogErrors,[]);assert.doesNotMatch(f.panel.innerHTML,/OLD 500/);
  f.controller.close();f.setReader(async(method,url,body)=>url==='/api/v1/topics/topic'?Promise.reject(new Error('CURRENT 500')):f.defaultReader(method,url,body));f.controller.handle(action('image-task'));await settle();
  assert.deepEqual(f.toasts,['CURRENT 500']);assert.match(f.dialogErrors.join(''),/CURRENT 500/);assert.match(f.panel.innerHTML,/CURRENT 500/);
 }finally{f.controller.dispose();}
});

test('旧 topic 成功回执不能覆盖新表单的 topicDetail 或输入',async()=>{
 const f=fixture(),old=deferred<any>();let reads=0;
 try{
  f.setReader(async(method,url,body)=>url==='/api/v1/topics/topic'?(++reads===1?old.promise:{core_document_id:'core',core:{head_revision_id:'new-core'},preparation_head_revision_id:'new-plan'}):f.defaultReader(method,url,body));
  f.controller.handle(action('image-task'));await settle();f.controller.close('escape');f.controller.handle(action('image-task'));await settle();form(f);f.fields.get('image-prompt')!.value='新稿要求';const presented=f.dialogs.length;
  old.resolve({core_document_id:'core',core:{head_revision_id:'old-core'},preparation_head_revision_id:'old-plan'});await settle();assert.equal(f.internal.topicDetail.core.head_revision_id,'new-core');assert.equal(f.internal.topicDetail.preparation_head_revision_id,'new-plan');assert.equal(f.dialogs.length,presented);assert.equal(f.fields.get('image-prompt')!.value,'新稿要求');assert.deepEqual(f.toasts,[]);
 }finally{f.controller.dispose();}
});

test('same-topic 离页重入与 load 代次阻止旧 activation 错误和成功污染',async()=>{
 const f=fixture(),old=deferred<any>();let reads=0;
 try{
  f.setReader(async(method,url,body)=>url.endsWith('image-providers')&&++reads===1?old.promise:f.defaultReader(method,url,body));f.controller.activate('reentered-topic');await settle();f.controller.deactivate();f.controller.activate('reentered-topic');await settle();assert.equal(f.internal.settings.version,2);old.reject(new Error('OLD ACTIVATION'));await settle();assert.equal(f.internal.error,'');assert.doesNotMatch(f.panel.innerHTML,/OLD ACTIVATION/);assert.equal(f.internal.loading,false);
  const earlier=deferred<any>();f.setReader(async(method,url,body)=>url.endsWith('image-providers')?earlier.promise:f.defaultReader(method,url,body));const first=f.controller.load();f.setReader(async(method,url,body)=>url.endsWith('image-providers')?{...channels,version:19}:f.defaultReader(method,url,body));await f.controller.load();earlier.resolve({...channels,version:3});await first;assert.equal(f.internal.settings.version,19);assert.equal(f.internal.loading,false);
 }finally{f.controller.dispose();}
});

test('handle busy 关闭重开：旧 catch/finally 不能清新 busy，当前 finally 正常释放且只提交一次',async()=>{
 const f=fixture(),old=deferred<void>(),current=deferred<void>();let leaves=0;
 try{
  await f.controller.dispatch('image-task',action('image-task'));form(f);f.setLeave(()=>++leaves===1?old.promise:leaves===3?current.promise:Promise.resolve());
  await f.controller.dispatch('image-confirm',action('image-confirm'));f.controller.handle(action('do-image'));assert.equal(f.internal.busy,true);f.controller.close('escape');assert.equal(f.internal.busy,false);f.controller.handle(action('image-task'));await settle();form(f);f.fields.get('image-prompt')!.value='新版 busy 输入';await f.controller.dispatch('image-confirm',action('image-confirm'));f.controller.handle(action('do-image'));assert.equal(f.internal.busy,true);
  old.reject(new Error('OLD SAVE ERROR'));await settle();assert.equal(f.internal.busy,true);assert.deepEqual(f.busyEvents,[true,true]);assert.deepEqual(f.toasts,[]);assert.deepEqual(f.dialogErrors,[]);assert.equal(f.fields.get('image-prompt')!.value,'新版 busy 输入');f.controller.handle(action('do-image'));assert.equal(leaves,3);
  current.resolve();await settle();assert.equal(f.internal.busy,false);assert.deepEqual(f.busyEvents,[true,true,false]);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url==='/api/v1/asset-generations').length,1);
 }finally{f.controller.dispose();}
});

test('非图像 dialog 替换同样撤销旧请求 UI 所有权',async()=>{
 const f=fixture(),old=deferred<any>();try{f.setReader(async(method,url,body)=>url==='/api/v1/topics/topic'?old.promise:f.defaultReader(method,url,body));f.controller.handle(action('image-task'));await settle();f.controller.replace('存储接入说明');old.reject(new Error('REPLACED OLD ERROR'));await settle();assert.equal(f.internal.dialogOpen,false);assert.deepEqual(f.toasts,[]);assert.deepEqual(f.dialogErrors,[]);assert.doesNotMatch(f.panel.innerHTML,/REPLACED OLD ERROR/);}finally{f.controller.dispose();}
});

test('迟到 accepted 保存原 key/输入/job，跨主题新 locator 不被覆盖且只取消原 job',async()=>{
 const f=fixture(),accepted=deferred<any>(),memory=new Map<string,string>(),descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>memory.set(key,value),removeItem:(key:string)=>memory.delete(key)}});
 try{
  await f.controller.dispatch('image-task',action('image-task'));form(f);const originalKey=f.internal.submitKey;f.setReader(async(method,url,body)=>url==='/api/v1/asset-generations'?accepted.promise:f.defaultReader(method,url,body));const submit=f.controller.dispatch('image-confirm',action('do-image')).then(()=>f.controller.dispatch('do-image',action('do-image')));await settle();f.controller.close('escape');f.controller.activate('other-topic');await settle();const next={topic_id:'other-topic',key:'next-key',job_id:null,input_hash:null};f.internal.pending=next;f.internal.store();f.internal.submitKey='next-key';const presented=f.dialogs.length;
  accepted.resolve({job_id:'image-job',input_hash:'fixed-input',state:'queued'});await submit;assert.equal(f.internal.pending,next);assert.deepEqual(f.cancelled,['image-job']);assert.equal(f.dialogs.length,presented);const stored=JSON.parse(memory.get(f.internal.storageKey()+':topic:topic')!);assert.equal(stored.key,originalKey);assert.equal(stored.job_id,'image-job');assert.equal(stored.input.prompt,'本轮固定要求');assert.equal(JSON.parse(memory.get(f.internal.storageKey())!).key,'next-key');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 }finally{f.controller.dispose();if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else Reflect.deleteProperty(globalThis,'localStorage');}
});

test('通用图像面板：创建图像任务先进统一「确认生成」（渠道、模型、张数、额度说明，确认按钮冷却）；未确认的提交动作不发请求；返回修改回到表单',async()=>{
 const f=fixture();try{await f.controller.dispatch('image-task',action('image-task'));form(f);
  await f.controller.dispatch('do-image',action('do-image'));assert.equal(f.calls.filter(c=>c.method==='POST').length,0,'没有确认时不提交');
  await f.controller.dispatch('image-confirm',action('image-confirm'));const d=f.dialogs.at(-1);assert.equal(d.title,'确认生成图像');assert.match(d.body,/<dt>生成渠道<\/dt><dd>AGY · Nano Banana<\/dd>/);assert.match(d.body,/<dt>生图模型<\/dt><dd>gemini-3.1-flash-image<\/dd>/);assert.match(d.body,/<dt>张数<\/dt><dd>1 张<\/dd>/);assert.match(d.body,/<dt>剩余次数<\/dt>/);assert.match(d.foot,/data-action="do-image"[^>]*disabled data-arming="arm-\d+"/);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0,'确认框出现时还没提交');
  await f.controller.dispatch('image-back',action('image-back'));assert.equal(f.dialogs.at(-1).title,'生成图像新版','返回表单');await f.controller.dispatch('do-image',action('do-image'));assert.equal(f.calls.filter(c=>c.method==='POST').length,0,'返回后旧确认作废');
  await f.controller.dispatch('image-confirm',action('image-confirm'));await f.controller.dispatch('do-image',action('do-image'));assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url==='/api/v1/asset-generations').length,1,'确认后才提交');
 }finally{f.controller.dispose();}
});
