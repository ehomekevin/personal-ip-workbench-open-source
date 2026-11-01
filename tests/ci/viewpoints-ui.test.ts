import test from 'node:test';
import assert from 'node:assert/strict';
import type {DocumentSnapshot,SaveRevisionRequest,SaveRevisionResponse,ServiceIdentity,Sha256,SpeechInputSnapshot} from '../../packages/contracts/src/index.ts';
import {ViewpointsController} from '../../apps/web/src/features/create/viewpoints/index.ts';
import {DraftRegistry,type DraftStorage,type UnsubmittedDraft} from '../../apps/web/src/transport/drafts.ts';
import {WorkbenchTransportError,type WorkbenchClient,type RequestOptions} from '../../apps/web/src/transport/workbench-client.ts';
import type {FeatureContext,DialogView} from '../../apps/web/src/transport/feature-ports.ts';
import {initialUi} from '../../apps/web/src/app/view-model.ts';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const identity:ServiceIdentity={workspace_id:'viewpoints-fixture',service_instance_id:'viewpoints-service',contract_version:'0.1.1'};
function memory(){const map=new Map<string,string>();return {map,getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value);},removeItem:(key:string)=>{map.delete(key);}};}
function snapshot(topic:string,text='已保存观点 '+topic):DocumentSnapshot{return {document_id:'viewpoints-'+topic,head_revision_id:'revision-'+topic+'-1',version:1,text,hash:null,save_state:'committed'};}
function voice(id='voice-1',source='source-1'):SpeechInputSnapshot{return {id,state:'final',provider:'ark_agent_plan',model:'doubao-seed-asr-2.0',partial_text:'语音观点',final_text:'语音观点',duration_ms:200,estimated_afp:0.025,request_id:'request-'+id,log_id:'log',error:null,source_record_id:source,created_at:'now'};}
const conflict=()=>new WorkbenchTransportError(409,{error:{code:'REVISION_CONFLICT',message:'远端版本已变化',retryable:false,details:{},request_id:'fixture-conflict'}});

function fixture(options:{storage?:DraftStorage;documents?:Map<string,DocumentSnapshot>}={}){
  const storage=options.storage??memory(),documents=options.documents??new Map(['A','B'].map(topic=>{const value=snapshot(topic);return [value.document_id,value];})),history=new Map([...documents].map(([id,value])=>[id,[structuredClone(value)]])),ui=initialUi('create'),abort=new AbortController(),dialogs:DialogView[]=[],toasts:string[]=[],generated:DocumentSnapshot[]=[],spoken:{topic:string;adopt:(text:string,session:SpeechInputSnapshot)=>Promise<void>}[]=[],saves:{id:string;input:SaveRevisionRequest;key:string|undefined}[]=[],gets:string[]=[],requests:{method:string;path:string}[]=[];
  ui.topic='A';let active=true,closed=0;
  const field={id:'viewpoints-text',value:'',disabled:false},status={textContent:''},generateButton={disabled:true},recovery={innerHTML:''};let html='';
  const unescape=(value:string)=>value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
  const slot={get innerHTML(){return html;},set innerHTML(value:string){html=value;field.value=unescape(value.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1]??'');field.disabled=/<textarea[^>]* disabled/.test(value);generateButton.disabled=/data-action="vp-generate" disabled/.test(value);status.textContent=unescape(value.match(/id="viewpoints-save-state">([^<]*)/)?.[1]??'');}};
  const nodes=new Map<string,object>([['.viewpoints-slot',slot],['#viewpoints-text',field],['#viewpoints-save-state',status],['[data-action="vp-generate"]',generateButton],['#viewpoints-recovery',recovery]]),root={querySelector:(selector:string)=>nodes.get(selector)??null} as unknown as HTMLElement;
  let ensure=async(topic:string)=>structuredClone(documents.get('viewpoints-'+topic)!),get=async(id:string)=>structuredClone(documents.get(id)!),historyReader:((url:string)=>Promise<unknown>)|undefined;
  const receipts=new Map<string,{input:SaveRevisionRequest;response:SaveRevisionResponse}>();
  const commit:WorkbenchClient['saveDocument']=async(id,input,requestOptions)=>{
    const key=requestOptions?.idempotencyKey??'',previous=receipts.get(key);if(previous){assert.deepEqual(previous.input,input);return previous.response;}
    const current=documents.get(id)!;if(current.head_revision_id!==input.expected_revision_id)throw conflict();
    const next:DocumentSnapshot={...current,head_revision_id:'revision-'+id+'-'+(current.version+1),version:current.version+1,text:input.text};documents.set(id,next);history.get(id)!.push(structuredClone(next));const response:SaveRevisionResponse={document_id:id,revision_id:next.head_revision_id!,write_intent_id:'intent-'+next.head_revision_id,version:next.version,hash:'0'.repeat(64) as Sha256,save_state:'committed'};receipts.set(key,{input:structuredClone(input),response});return response;
  };
  let save:WorkbenchClient['saveDocument']=commit;
  const client:WorkbenchClient={identity:async()=>identity,getSettings:async()=>{throw new Error('Unused settings');},patchSettings:async()=>{throw new Error('Unused settings mutation');},cancelJob:async()=>{throw new Error('Unused cancellation');},getDocument:async(id)=>{gets.push(id);return get(id);},saveDocument:async(id,input,requestOptions)=>{saves.push({id,input:structuredClone(input),key:requestOptions?.idempotencyKey});return save(id,input,requestOptions);},request:async<T>(method:'GET'|'POST'|'PATCH'|'PUT',url:string,_body?:unknown,_requestOptions?:RequestOptions):Promise<T>=>{
    requests.push({method,path:url});const ensuring=url.match(/^\/api\/v1\/topics\/([^/]+)\/viewpoints$/);if(method==='POST'&&ensuring)return await ensure(decodeURIComponent(ensuring[1])) as T;
    if(method==='GET'&&url.includes('/revisions')&&historyReader)return await historyReader(url) as T;
    const revisions=url.match(/^\/api\/v1\/documents\/([^/]+)\/revisions(?:\/([^/]+))?$/);if(method==='GET'&&revisions){const rows=history.get(decodeURIComponent(revisions[1]))!;return (revisions[2]?{text:rows.find(row=>row.head_revision_id===decodeURIComponent(revisions[2]))!.text}:{items:rows.map(row=>({id:row.head_revision_id,created_at:'now',origin:'human'}))}) as T;}
    throw new Error('Unexpected fixture request '+method+' '+url);
  }};
  const drafts=new DraftRegistry(client,identity,storage),context:FeatureContext={identity,client,ui,signal:abort.signal,drafts,surface:{updateUi:patch=>Object.assign(ui,patch),editorFeedback:()=>{},presentDialog:dialog=>dialogs.push(dialog),closeDialog:()=>{closed++;},toast:message=>toasts.push(message),navigate:page=>{ui.page=page;}}};
  const previousStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');Object.defineProperty(globalThis,'localStorage',{configurable:true,value:storage});
  const controller=new ViewpointsController({root,context:()=>context,active:()=>active,generate:async value=>{generated.push(structuredClone(value));},speak:(topic,adopt)=>spoken.push({topic,adopt})}),internal=controller as any;
  return {controller,internal,storage,documents,history,ui,field,status,recovery,generateButton,dialogs,toasts,generated,spoken,saves,gets,requests,commit,context,
    async activate(topic:string){active=true;ui.topic=topic;controller.activate(topic);slot.innerHTML=controller.panel();await flush();},edit(value:string){field.value=value;controller.input(field as HTMLInputElement);},perform:(action:string)=>internal.perform(action) as Promise<void>,setEnsure(reader:typeof ensure){ensure=reader;},setGet(reader:typeof get){get=reader;},setHistoryReader(reader:NonNullable<typeof historyReader>){historyReader=reader;},setSave(reader:WorkbenchClient['saveDocument']){save=reader;},leave(){active=false;controller.deactivate();},counts:()=>({closed}),
    dispose(){controller.dispose();drafts.dispose();if(previousStorage)Object.defineProperty(globalThis,'localStorage',previousStorage);else Reflect.deleteProperty(globalThis,'localStorage');}};
}

test('ensure A迟到不能替换B主题草稿或触发额外生成',async()=>{
  const f=fixture(),late=deferred<DocumentSnapshot>();
  try{f.setEnsure(async topic=>topic==='A'?late.promise:snapshot(topic));await f.activate('A');assert.equal(f.field.disabled,true);await f.activate('B');assert.equal(f.field.value,'已保存观点 B');late.resolve(snapshot('A','A 迟到旧观点'));await flush();assert.equal(f.internal.snapshot.document_id,'viewpoints-B');assert.equal(f.field.value,'已保存观点 B');assert.equal(f.context.drafts.status('viewpoints-A'),undefined);assert.deepEqual(f.generated,[]);}
  finally{f.dispose();}
});

test('输入立即保留本机草稿，刷新恢复后按原base保存，再生成已确认版本',async()=>{
  const storage=memory(),documents=new Map(['A','B'].map(topic=>{const value=snapshot(topic);return [value.document_id,value];}));let f=fixture({storage,documents});
  try{
    await f.activate('A');f.edit('我实际做过的判断，尚未提交');assert.equal(f.context.drafts.status('viewpoints-A'),'dirty');assert.equal(f.status.textContent,'观点待保存');assert.equal(f.saves.length,0);assert.equal([...storage.map.keys()].filter(key=>key.startsWith('flowo-unsubmitted-v1:')).length,1);
    f.dispose();f=fixture({storage,documents});await f.activate('A');assert.equal(f.field.value,'我实际做过的判断，尚未提交');assert.equal(f.context.drafts.status('viewpoints-A'),'dirty');await f.perform('vp-generate');
    assert.equal(f.saves.length,1);assert.deepEqual(f.saves[0].input,{text:'我实际做过的判断，尚未提交',origin:'human',expected_revision_id:'revision-A-1'});assert.equal(f.generated.length,1);assert.equal(f.generated[0].text,'我实际做过的判断，尚未提交');assert.equal(f.generated[0].head_revision_id,documents.get('viewpoints-A')!.head_revision_id);assert.equal(f.context.drafts.status('viewpoints-A'),'committed');assert.equal([...storage.map.keys()].filter(key=>key.startsWith('flowo-unsubmitted-v1:')).length,0);
  }finally{f.dispose();}
});

test('保存失败或冲突保留输入并阻止generate，恢复保存后才放行',async()=>{
  for(const problem of ['offline','conflict'] as const){const f=fixture();try{
    await f.activate('A');f.edit('本题未成功保存的观点');f.setSave(async()=>{throw problem==='conflict'?conflict():new Error('Fixture offline');});await assert.rejects(f.perform('vp-generate'),/观点尚未保存/);
    assert.equal(f.context.drafts.status('viewpoints-A'),problem);assert.equal(f.field.value,'本题未成功保存的观点');assert.equal(f.generated.length,0);assert.equal(f.gets.length,0);assert.match(f.recovery.innerHTML,problem==='conflict'?/vp-conflict/:/vp-save/);
    if(problem==='offline'){f.setSave(f.commit);await f.perform('vp-generate');assert.equal(f.generated.length,1);assert.equal(f.saves[1].key,f.saves[0].key);}
  }finally{f.dispose();}}
});

test('跨入口ACK r2后读到外部r3正文，不生成外部观点；本机A与已确认base保留为冲突',async()=>{
  const storage=memory(),f=fixture({storage});let acknowledged:SaveRevisionResponse|undefined;
  try{
    await f.activate('A');f.edit('本人观点 A');f.setSave(async(id,input,options)=>{acknowledged=await f.commit(id,input,options);return acknowledged;});f.setGet(async id=>{assert.equal(acknowledged?.revision_id,f.documents.get(id)!.head_revision_id);const external={...f.documents.get(id)!,head_revision_id:'external-r3',version:3,text:'另一入口的观点 B'};f.documents.set(id,external);f.history.get(id)!.push(structuredClone(external));return external;});
    await f.perform('vp-generate').catch(()=>{});assert.equal(f.generated.length,0);assert.equal(f.field.value,'本人观点 A');assert.equal(f.context.drafts.status('viewpoints-A'),'conflict');assert.match(f.recovery.innerHTML,/vp-conflict/);
    const cache=[...storage.map.values()].map(value=>JSON.parse(value) as UnsubmittedDraft).find(value=>value.document_id==='viewpoints-A');assert.ok(cache);assert.equal(cache.text,'本人观点 A');assert.equal(cache.base_revision_id,acknowledged!.revision_id);assert.equal(cache.pending_command,null);assert.equal(f.saves.length,1);
  }finally{f.dispose();}
});

test('等待读回已确认A期间又输入C，旧prepare不生成；缓存C继续以ACK r2为base',async()=>{
  const storage=memory(),f=fixture({storage}),late=deferred<DocumentSnapshot>(),reached=deferred<void>();let acknowledged:SaveRevisionResponse|undefined;
  try{
    await f.activate('A');f.edit('本人观点 A');f.setSave(async(id,input,options)=>{acknowledged=await f.commit(id,input,options);return acknowledged;});f.setGet(async()=>{reached.resolve();return late.promise;});const preparing=f.perform('vp-generate').catch(()=>{});await reached.promise;const confirmed=structuredClone(f.documents.get('viewpoints-A')!);assert.equal(confirmed.head_revision_id,acknowledged!.revision_id);f.edit('本人继续输入的观点 C');late.resolve(confirmed);await preparing;
    assert.equal(f.generated.length,0);assert.equal(f.field.value,'本人继续输入的观点 C');assert.equal(f.context.drafts.status('viewpoints-A'),'dirty');const cache=[...storage.map.values()].map(value=>JSON.parse(value) as UnsubmittedDraft).find(value=>value.document_id==='viewpoints-A');assert.ok(cache);assert.equal(cache.text,'本人继续输入的观点 C');assert.equal(cache.base_revision_id,acknowledged!.revision_id);assert.equal(f.saves.length,1);
  }finally{f.dispose();}
});

test('A生成读取回执迟到不能污染B snapshot、错误提示或下一次生成',async()=>{
  const f=fixture(),late=deferred<DocumentSnapshot>(),reached=deferred<void>();
  try{
    await f.activate('A');f.setGet(async id=>{if(id==='viewpoints-A'){reached.resolve();return late.promise;}return structuredClone(f.documents.get(id)!);});
    assert.equal(f.controller.handle({dataset:{action:'vp-generate'}} as unknown as HTMLElement),true);await reached.promise;await f.activate('B');f.edit('B 当前本人观点');late.resolve(snapshot('A','A 旧读取回执'));await flush();
    assert.equal(f.internal.snapshot.document_id,'viewpoints-B');assert.equal(f.field.value,'B 当前本人观点');assert.deepEqual(f.toasts,[]);assert.equal(f.generated.length,0);await f.perform('vp-generate');assert.equal(f.generated.length,1);assert.equal(f.generated[0].document_id,'viewpoints-B');assert.equal(f.generated[0].text,'B 当前本人观点');
  }finally{f.dispose();}
});

test('语音同source保存重试和重开不重复append，第二session正常append；刷新也保留去重',async()=>{
  const storage=memory(),documents=new Map(['A','B'].map(topic=>{const value=snapshot(topic);return [value.document_id,value];}));let f=fixture({storage,documents});
  try{
    await f.activate('A');await f.perform('vp-speech');const first=f.spoken[0].adopt;f.setSave(async()=>{throw new Error('Fixture offline');});await assert.rejects(first('第一段语音观点',voice()),/观点尚未保存/);assert.equal(f.field.value,'已保存观点 A\n\n第一段语音观点');
    f.setSave(f.commit);await first('第一段语音观点',voice());assert.equal(f.field.value,'已保存观点 A\n\n第一段语音观点');assert.equal(f.saves[1].key,f.saves[0].key);
    await f.perform('vp-speech');await f.spoken[1].adopt('第一段语音观点',voice());assert.equal(f.field.value,'已保存观点 A\n\n第一段语音观点');await f.spoken[1].adopt('第二段语音观点',voice('voice-2','source-2'));assert.equal(f.field.value,'已保存观点 A\n\n第一段语音观点\n\n第二段语音观点');assert.equal(f.saves.length,3);
    f.dispose();f=fixture({storage,documents});await f.activate('A');await f.perform('vp-speech');await f.spoken[0].adopt('第一段语音观点',voice('new-capture-same-source','source-1'));assert.equal(f.field.value,'已保存观点 A\n\n第一段语音观点\n\n第二段语音观点');assert.equal(f.saves.length,0);
  }finally{f.dispose();}
});

test('大草稿缓存quota失败而小marker可写时，不记录虚假merged；刷新可重新采用素材',async()=>{
  const storage=memory(),write=storage.setItem,documents=new Map(['A','B'].map(topic=>{const value=snapshot(topic);return [value.document_id,value];}));let cacheAllowed=false;
  storage.setItem=(key,value)=>{if(!cacheAllowed&&key.startsWith('flowo-unsubmitted-v1:'))throw new Error('Fixture quota exceeded');write(key,value);};let f=fixture({storage,documents});
  try{
    await f.activate('A');f.setSave(async()=>{throw new Error('Fixture offline');});await f.perform('vp-speech');await assert.rejects(f.spoken[0].adopt('不能丢的口述观点',voice()),/观点尚未保存/);assert.equal(f.field.value,'已保存观点 A\n\n不能丢的口述观点');assert.equal([...storage.map.keys()].filter(key=>key.startsWith('viewpoints-speech:')).length,0);
    f.dispose();cacheAllowed=true;f=fixture({storage,documents});await f.activate('A');assert.equal(f.field.value,'已保存观点 A');await f.perform('vp-speech');await f.spoken[0].adopt('不能丢的口述观点',voice());assert.equal(f.field.value,'已保存观点 A\n\n不能丢的口述观点');assert.equal(documents.get('viewpoints-A')!.text,f.field.value);assert.equal([...storage.map.keys()].filter(key=>key.startsWith('viewpoints-speech:')).length,1);
  }finally{f.dispose();}
});

test('离页或换题后的旧语音callback不append，也不保存新题',async()=>{
  const f=fixture();
  try{await f.activate('A');await f.perform('vp-speech');const old=f.spoken[0].adopt;f.leave();await assert.rejects(old('离页才到的语音',voice()),/已离开录音对应主题/);assert.equal(f.saves.length,0);await f.activate('B');await assert.rejects(old('A 迟到候选',voice()),/已离开录音对应主题/);assert.equal(f.field.value,'已保存观点 B');assert.equal(f.saves.length,0);assert.equal(f.context.drafts.attach(snapshot('A')).value(),'已保存观点 A');}
  finally{f.dispose();}
});

test('冲突必须显式对照并resolve：保留本机输入，最新已读head仍经CAS，历史版本不丢',async()=>{
  const f=fixture(),id='viewpoints-A';
  try{
    await f.activate('A');f.edit('本人保留的本机观点');const remote2={...snapshot('A','其他入口提交的观点'),head_revision_id:'remote-2',version:2};f.documents.set(id,remote2);f.history.get(id)!.push(structuredClone(remote2));await assert.rejects(f.perform('vp-generate'),/观点尚未保存/);
    assert.equal(f.context.drafts.status(id),'conflict');await f.perform('vp-resolve');assert.equal(f.saves.length,1);assert.equal(f.generated.length,0);await f.perform('vp-conflict');assert.equal(f.dialogs.at(-1)!.title,'对照本题观点');assert.match(f.dialogs.at(-1)!.body,/其他入口提交的观点/);assert.match(f.dialogs.at(-1)!.body,/本人保留的本机观点/);assert.match(f.dialogs.at(-1)!.foot!,/vp-resolve/);assert.equal(f.saves.length,1);
    const remote3={...remote2,head_revision_id:'remote-3',version:3,text:'对照后又提交的新观点'};f.documents.set(id,remote3);f.history.get(id)!.push(structuredClone(remote3));await assert.rejects(f.perform('vp-resolve'),/观点尚未保存/);assert.equal(f.saves[1].input.expected_revision_id,'remote-2');assert.equal(f.context.drafts.status(id),'conflict');assert.equal(f.counts().closed,0);
    await f.perform('vp-conflict');await f.perform('vp-resolve');assert.equal(f.saves[2].input.expected_revision_id,'remote-3');assert.equal(f.saves[2].input.text,'本人保留的本机观点');assert.equal(f.counts().closed,1);assert.equal(f.context.drafts.status(id),'committed');assert.deepEqual(f.history.get(id)!.map(row=>row.text),['已保存观点 A','其他入口提交的观点','对照后又提交的新观点','本人保留的本机观点']);assert.equal(f.generated.length,0);
  }finally{f.dispose();}
});

test('离题的冲突对照回执不能替换B comparison或打开旧弹窗',async()=>{
  const f=fixture(),late=deferred<DocumentSnapshot>(),reached=deferred<void>();
  try{await f.activate('A');f.setGet(async id=>{if(id==='viewpoints-A'){reached.resolve();return late.promise;}return structuredClone(f.documents.get(id)!);});const comparing=f.perform('vp-conflict');await reached.promise;await f.activate('B');late.resolve({...snapshot('A'),head_revision_id:'late-A'});await comparing;assert.equal(f.internal.comparison,undefined);assert.equal(f.dialogs.length,0);assert.equal(f.internal.snapshot.document_id,'viewpoints-B');}
  finally{f.dispose();}
});

test('观点历史按真实升序分页读取65条，显示最新末10条而非首50条中的末10条',async()=>{
  const f=fixture(),rows=Array.from({length:65},(_,index)=>({id:'history-'+(index+1),created_at:'time-'+(index+1),origin:'human'}));
  try{
    await f.activate('A');f.setHistoryReader(async url=>{const parsed=new URL(url,'http://fixture.invalid');if(parsed.pathname.endsWith('/revisions')){const second=parsed.searchParams.get('cursor')==='page-2';return {items:rows.slice(second?50:0,second?65:50),next_cursor:second?null:'page-2',has_more:!second};}const id=parsed.pathname.split('/').at(-1)!;assert.ok(rows.some(row=>row.id===id));return {text:'版本正文 '+id};});await f.perform('vp-history');
    const pages=f.requests.filter(request=>new URL(request.path,'http://fixture.invalid').pathname.endsWith('/revisions'));assert.equal(pages.length,2);assert.equal(new URL(pages[1].path,'http://fixture.invalid').searchParams.get('cursor'),'page-2');const dialog=f.dialogs.at(-1)!;assert.equal(dialog.title,'本题观点版本');assert.equal((dialog.body.match(/<details>/g)??[]).length,10);assert.match(dialog.body,/版本正文 history-65/);assert.match(dialog.body,/版本正文 history-56/);assert.doesNotMatch(dialog.body,/版本正文 history-55/);assert.doesNotMatch(dialog.body,/版本正文 history-50/);assert.ok(dialog.body.indexOf('版本正文 history-65')<dialog.body.indexOf('版本正文 history-56'));
  }finally{f.dispose();}
});

test('A历史分页首包迟到时，B主题不展示A历史或用B文档读A修订',async()=>{
  const f=fixture(),late=deferred<unknown>(),reached=deferred<void>();
  try{
    await f.activate('A');f.setHistoryReader(async url=>{if(url==='/api/v1/documents/viewpoints-A/revisions'){reached.resolve();return late.promise;}return {text:'A 旧版本'};});const listing=f.perform('vp-history');await reached.promise;await f.activate('B');late.resolve({items:[{id:'old-A',created_at:'now',origin:'human'}],next_cursor:null,has_more:false});await listing;
    assert.equal(f.dialogs.length,0);assert.equal(f.internal.snapshot.document_id,'viewpoints-B');assert.equal(f.field.value,'已保存观点 B');assert.equal(f.requests.filter(request=>request.path.includes('/documents/viewpoints-B/revisions')).length,0);
  }finally{f.dispose();}
});
