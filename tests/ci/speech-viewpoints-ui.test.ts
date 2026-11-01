import test from 'node:test';
import assert from 'node:assert/strict';
import {ContractError,type SpeechInputSnapshot} from '../../packages/contracts/src/index.ts';
import type {FeatureContext} from '../../apps/web/src/transport/feature-ports.ts';
import {SpeechInputController} from '../../apps/web/src/features/speech-input/index.ts';
import {WorkbenchTransportError,type RequestOptions} from '../../apps/web/src/transport/workbench-client.ts';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function snapshot(state:SpeechInputSnapshot['state']='final',id='speech-A'):SpeechInputSnapshot{
  return {id,state,provider:'ark_agent_plan',model:'doubao-seed-asr-2.0',partial_text:'本人讲述的文字',final_text:state==='final'?'本人讲述的文字':null,duration_ms:200,estimated_afp:0.025,request_id:'request',log_id:'log',error:null,source_record_id:null,created_at:'now'};
}
const adoptionConflict=()=>new WorkbenchTransportError(409,{error:{code:'IDEMPOTENCY_CONFLICT',message:'此语音已有不同的采用内容',retryable:false,details:{},request_id:'fixture-adoption-conflict'}});
function fixture(){
  const abort=new AbortController(),ui={page:'create',topic:'topic-A'},dialogs:{title:string;body:string;foot?:string}[]=[],calls:{method:string;path:string;body:unknown;key?:string}[]=[],toasts:string[]=[],events:string[]=[],fields=new Map([['#speech-title',{value:'',readOnly:false}],['#speech-text',{value:'',readOnly:false}]]),sessions=new Map<string,SpeechInputSnapshot>();
  let internal:any,reader:(method:string,path:string,body:unknown)=>Promise<unknown>=async(_method,path)=>{
    if(path==='/api/v1/settings/speech-input')return {enabled:true,credential_present:true,connection:'unverified',setup_url:null,limits:{}};
    const id=path.split('/')[4],current=sessions.get(id)??snapshot('final',id);
    if(path.endsWith('/adoption'))return {...current,source_record_id:'source-'+id};
    if(path.endsWith('/cancel')){const cancelled={...current,state:'cancelled' as const};sessions.set(id,cancelled);return cancelled;}
    if(path.startsWith('/api/v1/speech-inputs/'))return current;
    throw new Error('Unexpected fixture request '+path);
  };
  const root={querySelector:(selector:string)=>fields.get(selector)??null} as unknown as HTMLElement;
  const context={ui,signal:abort.signal,identity:{workspace_id:'fixture',service_instance_id:'fixture-service'},client:{request:async(method:string,path:string,body:unknown,options?:RequestOptions)=>{calls.push({method,path,body,key:options?.idempotencyKey});return reader(method,path,body);}},surface:{presentDialog(value:{title:string;body:string;foot?:string}){dialogs.push(value);fields.get('#speech-title')!.value=internal.title;fields.get('#speech-text')!.value=internal.text;fields.get('#speech-text')!.readOnly=/id="speech-text"[^>]*readonly/.test(value.body);},toast:(text:string)=>{toasts.push(text);events.push('toast:'+text);},closeDialog:(reason:string)=>{events.push('close:'+reason);controller.close();}}} as unknown as FeatureContext;
  const controller=new SpeechInputController({root,client:context.client,signal:abort.signal,context:()=>context,render:()=>{},toast:text=>{toasts.push(text);events.push('toast:'+text);}});internal=controller as any;
  return {controller,internal,ui,dialogs,calls,fields,toasts,events,context,setReader(value:typeof reader){reader=value;},setSession(value:SpeechInputSnapshot){sessions.set(value.id,value);internal.session=undefined;internal.accept(value);},edit(text:string){fields.get('#speech-text')!.value=text;controller.handleInput({id:'speech-text'} as HTMLInputElement);},adopt:()=>internal.perform('speech-adopt-viewpoint') as Promise<void>,last:()=>dialogs.at(-1)!};
}

test('观点语音必须 final 后人工采用：先保存核对素材到固定主题，再交回编辑文字',async()=>{
  const f=fixture(),applied:{text:string;session:SpeechInputSnapshot}[]=[];
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'本题素材',onAdopt:(text,session)=>{applied.push({text,session});}});
    assert.equal(f.last().title,'语音补充观点');assert.match(f.last().foot!,/speech-adopt-viewpoint" disabled/);
    for(const state of ['recording','finalizing','unknown','cancelled','failed'] as const){f.setSession(snapshot(state));assert.match(f.last().foot!,/speech-adopt-viewpoint" disabled/);await f.adopt();}
    assert.equal(f.calls.filter(call=>call.path.endsWith('/adoption')).length,0);assert.equal(applied.length,0);
    f.setSession(snapshot());assert.doesNotMatch(f.last().foot!,/speech-adopt-viewpoint" disabled/);assert.equal(f.fields.get('#speech-text')!.readOnly,false);
    f.edit('本人核对并改过的观点');await f.adopt();
    const adoption=f.calls.find(call=>call.path.endsWith('/adoption'))!;assert.deepEqual(adoption.body,{title:'本题素材',text:'本人核对并改过的观点',topic_id:'topic-A'});assert.equal(applied.length,1);assert.equal(applied[0].text,'本人核对并改过的观点');assert.equal(applied[0].session.source_record_id,'source-speech-A');assert.match(f.last().foot!,/speech-adopt-viewpoint" disabled/);
    await f.adopt();assert.equal(applied.length,1);assert.equal(f.calls.filter(call=>call.path.endsWith('/adoption')).length,1);
    f.setSession(snapshot('final','speech-second'));f.edit('第二段核对观点');await f.adopt();assert.equal(applied.length,2);assert.equal(applied[1].text,'第二段核对观点');assert.equal(applied[1].session.source_record_id,'source-speech-second');assert.equal(f.calls.filter(call=>call.path.endsWith('/adoption')).length,2);
  }finally{f.controller.dispose();await flush();}
});

test('主题切换后的迟到 adoption 不调用旧主题或新主题回调，也不覆盖新候选',async()=>{
  const f=fixture(),saved=deferred<SpeechInputSnapshot>(),oldApplied:string[]=[],newApplied:string[]=[];
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:text=>{oldApplied.push(text);}});f.setSession(snapshot());
    f.setReader(async(_method,path)=>path.endsWith('/adoption')?saved.promise:{enabled:true});const adopting=f.adopt();await flush();
    f.ui.topic='topic-B';f.controller.close();await f.controller.openForTopic({topicId:'topic-B',title:'B',onAdopt:text=>{newApplied.push(text);}});f.setSession(snapshot('final','speech-B'));f.edit('B 正在填写的观点');
    saved.resolve({...snapshot(),source_record_id:'source-A'});await adopting;
    assert.deepEqual(oldApplied,[]);assert.deepEqual(newApplied,[]);assert.equal(f.internal.session.id,'speech-B');assert.equal(f.fields.get('#speech-text')!.value,'B 正在填写的观点');assert.equal(f.internal.busy,false);
    assert.equal((f.calls.find(call=>call.path.endsWith('/adoption'))!.body as {topic_id:string}).topic_id,'topic-A');
  }finally{f.controller.dispose();await flush();}
});

test('当前主题与打开时主题不符时直接采用也被阻止',async()=>{
  const f=fixture();let applied=0;
  try{await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{applied++;}});f.setSession(snapshot());f.ui.topic='topic-B';await f.adopt();assert.equal(applied,0);assert.equal(f.calls.filter(call=>call.path.endsWith('/adoption')).length,0);assert.match(f.last().body,/主题已切换/);assert.match(f.last().foot!,/speech-adopt-viewpoint" disabled/);}
  finally{f.controller.dispose();await flush();}
});

test('素材已保存但观点写入失败时可重试本地 apply，不再调用 adoption 或 provider',async()=>{
  const f=fixture();let attempts=0;
  try{await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{if(++attempts===1)throw new Error('保存失败');}});f.setSession(snapshot());f.edit('已核对的观点');await f.adopt();assert.match(f.last().body,/个人素材已保存，观点草稿尚未写入/);assert.doesNotMatch(f.last().foot!,/speech-adopt-viewpoint" disabled/);assert.equal(f.fields.get('#speech-text')!.readOnly,true);await f.adopt();assert.equal(attempts,2);assert.equal(f.calls.filter(call=>call.path.endsWith('/adoption')).length,1);assert.equal(f.calls.filter(call=>call.path==='/api/v1/speech-inputs'||(call.path.endsWith('/chunks')||call.path.endsWith('/chunk-batches'))||call.path==='/api/v1/speech-recordings').length,0);}
  finally{f.controller.dispose();await flush();}
});

test('采用等待期间取消录音被禁用；交错取消和改字不能让UI second而callback first',async()=>{
  const f=fixture(),late=deferred<SpeechInputSnapshot>(),applied:string[]=[];
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:text=>{applied.push(text);}});f.setSession(snapshot());f.edit('first 已核对文字');f.setReader(async(_method,path)=>path.endsWith('/adoption')?late.promise:{enabled:true});const before=f.internal.generation,adopting=f.adopt();await flush();assert.match(f.last().body,/data-action="speech-cancel" disabled/);
    await f.internal.perform('speech-cancel');assert.equal(f.internal.generation,before);assert.equal(f.internal.busy,true);f.edit('second 尚未采用文字');assert.equal(f.fields.get('#speech-text')!.value,'first 已核对文字');assert.match(f.last().body,/id="speech-title"[^>]*readonly/);assert.equal(f.fields.get('#speech-text')!.readOnly,true);
    late.resolve({...snapshot(),source_record_id:'first-source'});await adopting;assert.deepEqual(applied,['first 已核对文字']);assert.equal(f.fields.get('#speech-text')!.value,'first 已核对文字');assert.equal(f.calls.filter(call=>call.path.endsWith('/adoption')).length,1);assert.equal(f.calls.filter(call=>call.path.endsWith('/cancel')).length,0);
  }finally{f.controller.dispose();await flush();}
});

test('关闭后迟到adopt ACK不先写任何旧target缓存；同题重开先回读固定输入再apply',async()=>{
  const f=fixture(),late=deferred<SpeechInputSnapshot>(),applied:string[]=[],saved={...snapshot(),source_record_id:'first-source'};
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:text=>{applied.push(text);}});f.setSession(snapshot());f.edit('first 已核对文字');f.setReader(async(method,path)=>path==='/api/v1/settings/speech-input'?{enabled:true}:path.endsWith('/adoption')?late.promise:method==='GET'?saved:snapshot('cancelled'));const oldTarget=f.internal.topicTarget,adopting=f.adopt();await flush();f.controller.close();await flush();await f.controller.openForTopic({topicId:'topic-A',title:'重新打开',onAdopt:text=>{applied.push(text);}});late.resolve(saved);await adopting;
    assert.equal(oldTarget.saved,undefined);assert.equal(f.internal.topicTarget.saved,undefined);assert.deepEqual(applied,[]);assert.match(f.last().body,/原采用回执待核对/);f.edit('second 尚未采用文字');assert.equal(f.fields.get('#speech-text')!.value,'first 已核对文字');await f.adopt();assert.deepEqual(applied,['first 已核对文字']);assert.equal(f.internal.session.source_record_id,'first-source');const posts=f.calls.filter(call=>call.path.endsWith('/adoption'));assert.equal(posts.length,2);assert.deepEqual(posts[1].body,posts[0].body);assert.equal(posts[1].key,posts[0].key);assert.equal(f.calls.filter(call=>call.method==='GET'&&call.path==='/api/v1/speech-inputs/speech-A').length,1);
  }finally{f.controller.dispose();await flush();}
});

test('adoption回执未知固定原文字；GET已有source后仍用原输入与key重放本地采用校验',async()=>{
  const f=fixture(),applied:string[]=[],saved={...snapshot(),source_record_id:'already-saved-source'};let posts=0,boundInput:unknown;
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:text=>{applied.push(text);}});f.setSession(snapshot());f.edit('first 已提交文字');f.setReader(async(method,path,body)=>{if(path.endsWith('/adoption')){if(++posts===1){boundInput=structuredClone(body);throw new Error('fixture ACK lost after save');}assert.deepEqual(body,boundInput);return saved;}if(path==='/api/v1/settings/speech-input')return {enabled:true};if(method==='GET')return saved;throw new Error('Unexpected '+path);});await f.adopt();assert.match(f.last().body,/采用保存回执尚未确认/);assert.equal(f.fields.get('#speech-text')!.readOnly,true);f.edit('second 还没采用');assert.equal(f.fields.get('#speech-text')!.value,'first 已提交文字');await f.adopt();assert.deepEqual(applied,['first 已提交文字']);const replay=f.calls.filter(call=>call.path.endsWith('/adoption'));assert.equal(replay.length,2);assert.equal(replay[1].key,replay[0].key);assert.deepEqual(replay[1].body,replay[0].body);assert.equal(f.calls.filter(call=>call.method==='GET'&&call.path==='/api/v1/speech-inputs/speech-A').length,1);assert.equal(f.calls.filter(call=>(call.path.endsWith('/chunks')||call.path.endsWith('/chunk-batches'))||call.path==='/api/v1/speech-inputs'||call.path==='/api/v1/speech-recordings').length,0);
  }finally{f.controller.dispose();await flush();}
});

test('已采用A的录音被B改文复用：unknown GET旧sourceA不能绕过域层校验写入B',async()=>{
  const f=fixture(),appliedA:string[]=[],appliedB:string[]=[],saved={...snapshot(),source_record_id:'source-A'};let bound='',loseConflictReply=true;
  try{
    f.setReader(async(method,path,body)=>{if(path==='/api/v1/settings/speech-input')return {enabled:true};if(path.endsWith('/adoption')){const input=JSON.stringify(body);if(!bound){bound=input;return saved;}if(input===bound)return saved;if(loseConflictReply){loseConflictReply=false;throw new Error('fixture response lost');}throw adoptionConflict();}if(method==='GET')return saved;throw new Error('Unexpected '+path);});
    await f.controller.openForTopic({topicId:'topic-A',title:'A素材',onAdopt:text=>{appliedA.push(text);}});f.setSession(snapshot());f.edit('A 已采用正文');await f.adopt();assert.deepEqual(appliedA,['A 已采用正文']);
    f.ui.topic='topic-B';await f.controller.openForTopic({topicId:'topic-B',title:'B素材',onAdopt:text=>{appliedB.push(text);}});f.setSession(saved);f.edit('B 改过的正文');await f.adopt();assert.equal(f.internal.topicTarget.submission.state,'unknown');await f.adopt();
    assert.deepEqual(appliedB,[]);assert.equal(f.internal.topicTarget.saved,undefined);assert.equal(f.internal.topicTarget.submission.state,'conflict');assert.equal(f.fields.get('#speech-text')!.value,'B 改过的正文');assert.match(f.last().body,/此转写已有不同的采用文字或主题/);assert.doesNotMatch(f.last().body,/采用保存回执尚未确认/);assert.match(f.last().foot!,/speech-adopt-viewpoint" disabled/);assert.doesNotMatch(f.last().body,/data-action="speech-start" disabled/);
    const posts=f.calls.filter(call=>call.path.endsWith('/adoption'));assert.equal(posts.length,3);assert.deepEqual(posts[2].body,posts[1].body);assert.equal(posts[2].key,posts[1].key);assert.equal(f.calls.filter(call=>call.method==='GET'&&call.path==='/api/v1/speech-inputs/speech-A').length,1);await f.adopt();assert.equal(f.calls.filter(call=>call.path.endsWith('/adoption')).length,3);assert.equal(f.calls.filter(call=>(call.path.endsWith('/chunks')||call.path.endsWith('/chunk-batches'))||call.path==='/api/v1/speech-inputs'||call.path==='/api/v1/speech-recordings').length,0);
  }finally{f.controller.dispose();await flush();}
});

test('明确adoption_hash冲突不是unknown；不以GET已有source假成功，重开仍显示冲突',async()=>{
  const f=fixture(),applied:string[]=[],saved={...snapshot(),source_record_id:'old-source'},oldInput={title:'A素材',text:'之前已采用正文',topic_id:'topic-A'};
  try{
    f.setReader(async(method,path,body)=>{if(path==='/api/v1/settings/speech-input')return {enabled:true};if(path.endsWith('/adoption')){assert.notDeepEqual(body,oldInput);throw new ContractError('IDEMPOTENCY_CONFLICT','此语音已采用，后续请在资料中编辑');}if(method==='GET')return saved;throw new Error('Unexpected '+path);});await f.controller.openForTopic({topicId:'topic-A',title:'A素材',onAdopt:text=>{applied.push(text);}});f.setSession(saved);f.edit('本次不同正文');await f.adopt();await f.adopt();
    assert.equal(f.internal.topicTarget.submission.state,'conflict');assert.equal(f.internal.topicTarget.saved,undefined);assert.equal(applied.length,0);assert.equal(f.calls.filter(call=>call.path.endsWith('/adoption')).length,1);assert.equal(f.calls.filter(call=>call.method==='GET'&&call.path==='/api/v1/speech-inputs/speech-A').length,0);f.controller.close();await f.controller.openForTopic({topicId:'topic-A',title:'A素材',onAdopt:text=>{applied.push(text);}});assert.equal(f.internal.topicTarget.submission.state,'conflict');assert.match(f.last().body,/此转写已有不同的采用内容/);assert.doesNotMatch(f.last().body,/原采用回执待核对/);assert.doesNotMatch(f.last().body,/data-action="speech-start" disabled/);
  }finally{f.controller.dispose();await flush();}
});

test('关闭后迟到的 final poll 不重新打开弹窗或调用观点回调',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),late=deferred<SpeechInputSnapshot>();let applied=0;
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{applied++;}});f.setSession(snapshot('recording'));f.setReader(async(method,path)=>method==='GET'?late.promise:{...snapshot('cancelled')});f.internal.poll();t.mock.timers.tick(500);await flush();f.controller.close();await flush();const count=f.dialogs.length;late.resolve(snapshot());await flush();assert.equal(f.dialogs.length,count);assert.equal(f.internal.text,'本人讲述的文字');assert.equal(f.internal.session.state,'cancelled');assert.equal(applied,0);
  }finally{f.controller.dispose();await flush();t.mock.timers.reset();}
});

test('换题后迟到的 start 只取消旧 capture，不覆盖新题候选或开始传音频',async()=>{
  const f=fixture(),late=deferred<SpeechInputSnapshot>(),reached=deferred<void>(),descriptors=new Map<PropertyKey,PropertyDescriptor|undefined>();let captureId='',trackEnded=false,closed=0;
  const replace=(object:object,key:PropertyKey,value:unknown)=>{descriptors.set(key,Object.getOwnPropertyDescriptor(object,key));Object.defineProperty(object,key,{configurable:true,writable:true,value});};
  replace(globalThis,'window',{isSecureContext:true,AudioWorkletNode:class {}});replace(globalThis,'AudioContext',class {state='running';async resume(){}async close(){this.state='closed';closed++;}});
  const mediaDescriptor=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>{trackEnded=true;}}]})}});
  let oldApplied=0,newApplied=0;
  try{
    f.setReader(async(_method,path,body)=>{if(path==='/api/v1/settings/speech-input')return {enabled:true};if(path==='/api/v1/speech-inputs'){captureId=(body as {capture_id:string}).capture_id;reached.resolve();return late.promise;}if(path.endsWith('/cancel'))return snapshot('cancelled',path.split('/')[4]);throw new Error('Unexpected '+path);});
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{oldApplied++;}});const starting=f.internal.start();await reached.promise;
    f.ui.topic='topic-B';f.controller.close();await f.controller.openForTopic({topicId:'topic-B',title:'B',onAdopt:()=>{newApplied++;}});f.setSession(snapshot('final','speech-B'));f.edit('B 保留的候选');late.resolve(snapshot('recording',captureId));await starting;
    assert.equal(trackEnded,true);assert.ok(closed>0);assert.equal(f.internal.session.id,'speech-B');assert.equal(f.fields.get('#speech-text')!.value,'B 保留的候选');assert.equal(oldApplied,0);assert.equal(newApplied,0);assert.equal(f.calls.filter(call=>(call.path.endsWith('/chunks')||call.path.endsWith('/chunk-batches'))).length,0);assert.ok(f.calls.some(call=>call.path==='/api/v1/speech-inputs/'+captureId+'/cancel'));
  }finally{
    f.controller.dispose();await flush();for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}if(mediaDescriptor)Object.defineProperty(navigator,'mediaDevices',mediaDescriptor);else Reflect.deleteProperty(navigator,'mediaDevices');
  }
});

test('取消保留识别文字；观点弹窗自我更新不取消，其他弹窗替换会取消',async()=>{
  const f=fixture();let releases=0;
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{}});f.setSession(snapshot('recording'));f.internal.capture={cancel:async()=>{releases++;},stop:async()=>{}};
    f.controller.replace('语音补充观点');assert.equal(releases,0);await f.internal.perform('speech-cancel');assert.equal(releases,1);assert.equal(f.fields.get('#speech-text')!.value,'本人讲述的文字');assert.match(f.last().body,/已取消录音/);assert.match(f.last().foot!,/speech-adopt-viewpoint" disabled/);
    f.setSession(snapshot('recording','speech-B'));f.internal.capture={cancel:async()=>{releases++;},stop:async()=>{}};f.controller.replace('另一弹窗');await flush();assert.equal(releases,2);assert.equal(f.internal.open,false);
  }finally{f.controller.dispose();await flush();}
});

test('普通语音入口保留个人素材采用文案与功能',async()=>{
  const f=fixture();
  try{await f.internal.perform('speech-open');f.setSession(snapshot());f.edit('普通素材');assert.equal(f.last().title,'语音记想法');assert.match(f.last().foot!,/采用到个人素材/);assert.match(f.last().foot!,/采用并关联当前主题/);assert.doesNotMatch(f.last().foot!,/采用到本题观点/);await f.internal.perform('speech-adopt');assert.equal((f.calls.find(call=>call.path.endsWith('/adoption'))!.body as {text:string}).text,'普通素材');assert.deepEqual(f.events,['close:completed','toast:已保存为个人素材；核心稿仍待人工确认']);assert.equal(f.internal.open,false);}
  finally{f.controller.dispose();await flush();}
});

test('REC清晰区分准备、权限请求、连接与录音；波形由PCM音量驱动，取消清理计时器',async t=>{
  t.mock.timers.enable({apis:['setInterval']});const f=fixture();let cancelled=0;
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{}});assert.match(f.last().body,/speech-recorder" data-state="ready"/);assert.match(f.last().body,/speech-timer[^>]*>00:00/);
    f.internal.busy=true;f.internal.dispatch('start');f.internal.show();assert.match(f.last().body,/data-state="permission"/);assert.match(f.last().body,/正在请求麦克风权限/);
    const permissionEpoch=f.internal.generation;await f.internal.perform('speech-cancel');assert.ok(f.internal.generation>permissionEpoch);assert.equal(f.internal.busy,false);assert.equal(f.internal.state,'idle');f.internal.busy=true;
    f.internal.dispatch('start');f.internal.dispatch('granted');f.internal.show();assert.match(f.last().body,/data-state="connecting"/);assert.match(f.last().body,/正在连接转写服务/);
    f.internal.busy=false;f.setSession(snapshot('recording'));f.internal.capture={cancel:async()=>{cancelled++;},stop:async()=>{}};f.internal.startClock();f.internal.startedAt=performance.now()-1250;t.mock.timers.tick(250);
    const pcm=new Uint8Array(320),samples=new DataView(pcm.buffer);for(let at=0;at<pcm.length;at+=2)samples.setInt16(at,16384,true);f.internal.meter(pcm);f.internal.show();assert.match(f.last().body,/data-state="recording"/);assert.match(f.last().body,/REC · 录音中/);assert.match(f.last().body,/data-action="speech-stop"/);assert.match(f.last().body,/speech-timer[^>]*>00:01/);assert.equal(f.internal.levels.at(-1),1);assert.equal(f.calls.filter(call=>(call.path.endsWith('/chunks')||call.path.endsWith('/chunk-batches'))).length,0);
    await f.internal.perform('speech-cancel');assert.equal(cancelled,1);assert.equal(f.internal.recorderClock,undefined);assert.equal(f.internal.startedAt,undefined);assert.match(f.last().body,/data-state="cancelled"/);assert.equal(f.fields.get('#speech-text')!.value,'本人讲述的文字');
  }finally{f.controller.dispose();await flush();t.mock.timers.reset();}
});

test('点击stop立即显示转写中；关闭后迟到的音频flush不能送final片段',async()=>{
  const f=fixture(),flushed=deferred<void>();
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{}});f.setSession(snapshot('recording'));f.internal.capture={stop:()=>flushed.promise,cancel:async()=>{}};f.internal.show();const stopping=f.internal.stop();assert.match(f.last().body,/data-state="finalizing"/);assert.match(f.last().body,/正在完成转写/);assert.match(f.last().foot!,/speech-adopt-viewpoint" disabled/);f.controller.close();flushed.resolve();await stopping;assert.equal(f.calls.filter(call=>(call.path.endsWith('/chunks')||call.path.endsWith('/chunk-batches'))).length,0);assert.equal(f.internal.recorderClock,undefined);
  }finally{f.controller.dispose();await flush();}
});

test('200ms片段遇400ms HTTP回执：24.4秒录音顺序完整、动态批次追平且不触发取消',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),received:number[]=[];let current=snapshot('recording');
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{}});f.setSession(current);
    f.setReader(async(_method,path,body)=>{
      if(path.endsWith('/cancel'))return {...current,state:'cancelled'};
      if(path.endsWith('/chunks')||path.endsWith('/chunk-batches')){await new Promise(resolve=>setTimeout(resolve,400));const chunks=path.endsWith('/chunks')?[body]:((body as {chunks:unknown[]}).chunks);for(const item of chunks){const chunk=item as {sequence:number;final:boolean};received.push(chunk.sequence);current={...current,accepted_sequence:chunk.sequence,state:chunk.final?'final':'recording'};}return {...current};}
      return current;
    });
    for(let index=0;index<122;index++){f.internal.enqueue(new Uint8Array(6400));t.mock.timers.tick(200);await flush();}
    f.internal.enqueue(new Uint8Array(),true);for(let tick=0;tick<10;tick++){t.mock.timers.tick(200);await flush();}await f.internal.queue;
    assert.equal(f.calls.filter(call=>call.path.endsWith('/cancel')).length,0);assert.deepEqual(received,Array.from({length:123},(_,index)=>index+1));assert.equal(f.internal.session.state,'final');assert.equal(f.internal.queued,0);
    const batches=f.calls.filter(call=>call.path.endsWith('/chunk-batches'));assert.ok(batches.length<80);assert.ok(batches.some(call=>(call.body as {chunks:unknown[]}).chunks.length>1));assert.ok(batches.every(call=>(call.body as {chunks:unknown[]}).chunks.length<=10));
  }finally{f.controller.dispose();await flush();t.mock.timers.reset();}
});

test('状态读取临时503恢复时录音继续；取消设备与文字不被丢弃',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const f=fixture();let failures=0,ended=0;
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{}});f.setSession(snapshot('recording'));f.internal.capture={cancel:async()=>{ended++;},stop:async()=>{ended++;}};
    f.setReader(async(method,path)=>{if(method==='GET'&&++failures<=2)throw new WorkbenchTransportError(503,{error:{code:'STORAGE_UNAVAILABLE',message:'fixture temporary read outage',retryable:true,details:{},request_id:'fixture'}});return snapshot('recording');});
    f.internal.poll();t.mock.timers.tick(500);await flush();assert.equal(f.internal.session.state,'recording');assert.match(f.internal.recorderStatus(),/正在恢复读取/);t.mock.timers.tick(1000);await flush();t.mock.timers.tick(2000);await flush();assert.equal(failures,3);assert.equal(f.internal.transportNotice,'');assert.equal(ended,0);assert.equal(f.calls.filter(call=>call.path.endsWith('/cancel')).length,0);assert.equal(f.internal.text,'本人讲述的文字');
  }finally{f.controller.dispose();await flush();t.mock.timers.reset();}
});

test('连续状态读取失败有界停设备并记录原因；15秒缓冲满也保留候选',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});const f=fixture();let ended=0;
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{}});f.setSession(snapshot('recording'));f.internal.capture={cancel:async()=>{ended++;},stop:async()=>{ended++;}};
    f.setReader(async(method,path,body)=>{if(path.endsWith('/cancel'))return {...snapshot('cancelled'),cancellation:body};if(method==='GET')throw new WorkbenchTransportError(503,{error:{code:'STORAGE_UNAVAILABLE',message:'fixture outage',retryable:true,details:{},request_id:'fixture'}});return new Promise(()=>{});});
    f.internal.poll();for(let index=0;index<8;index++){t.mock.timers.tick(index===0?500:index===1?1000:2000);await flush();}
    assert.equal(ended,1);assert.equal(f.internal.session.state,'cancelled');assert.equal(f.internal.session.cancellation.reason,'state_unavailable');assert.equal(f.internal.session.cancellation.http_status,503);assert.equal(f.internal.text,'本人讲述的文字');
    f.setSession(snapshot('recording','speech-second'));f.internal.capture={cancel:async()=>{ended++;},stop:async()=>{ended++;}};f.internal.sequence=0;f.internal.bytes=0;
    for(let index=0;index<76;index++)f.internal.enqueue(new Uint8Array(6400));await flush();assert.equal(ended,2);assert.equal(f.internal.session.cancellation.reason,'buffer_full');assert.equal(f.internal.bufferedBytes,0);assert.equal(f.internal.chunks.length,0);assert.equal(f.internal.text,'本人讲述的文字');
  }finally{f.controller.dispose();await flush();t.mock.timers.reset();}
});

test('批次ACK丢失先GET核对accepted_sequence；已收音频不重发，unknown不重试',async()=>{
  const f=fixture();let posts=0,reads=0;
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{}});f.setSession(snapshot('recording'));
    f.setReader(async(method,path)=>{if(path.endsWith('/chunk-batches')){posts++;throw new TypeError('fixture ACK lost after persisted send');}if(method==='GET'){reads++;return {...snapshot('recording'),accepted_sequence:1};}throw new Error('Unexpected '+path);});f.internal.enqueue(new Uint8Array(6400));await f.internal.queue;assert.equal(posts,1);assert.equal(reads,1);assert.equal(f.internal.queued,0);assert.equal(f.calls.filter(call=>call.path.endsWith('/cancel')).length,0);
    f.setSession(snapshot('recording','unknown-session'));f.internal.sequence=0;f.setReader(async(method,path)=>{if(path.endsWith('/chunk-batches')){posts++;throw new TypeError('fixture ACK lost');}if(method==='GET')return {...snapshot('unknown','unknown-session'),accepted_sequence:1,partial_text:'已保留的片段文字'};throw new Error('Unexpected '+path);});f.internal.enqueue(new Uint8Array(6400));await f.internal.queue;assert.equal(posts,2);assert.equal(f.internal.session.state,'unknown');assert.equal(f.internal.text,'已保留的片段文字');
  }finally{f.controller.dispose();await flush();}
});

test('final之后旧poll失败不能恢复读取或取消；旧低序号snapshot不回退进度',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();let reject!:(error:Error)=>void;
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{}});f.setSession({...snapshot('recording'),accepted_sequence:5});f.internal.accept({...snapshot('recording'),accepted_sequence:3,partial_text:'较早文字'});assert.equal(f.internal.session.accepted_sequence,5);assert.equal(f.internal.text,'本人讲述的文字');
    f.setReader(async()=>new Promise((_resolve,fail)=>{reject=fail;}));f.internal.poll();t.mock.timers.tick(500);await flush();f.internal.accept({...snapshot(),accepted_sequence:6});f.edit('final 后人工编辑');reject(new TypeError('old poll failed'));await flush();t.mock.timers.tick(3000);await flush();assert.equal(f.internal.session.state,'final');assert.equal(f.internal.readFailures,0);assert.equal(f.internal.error,'');assert.equal(f.internal.text,'final 后人工编辑');assert.equal(f.calls.filter(call=>call.path.endsWith('/cancel')).length,0);
  }finally{f.controller.dispose();await flush();t.mock.timers.reset();}
});

const recorderStatus=(body:string)=>/<div class="speech-status" role="status" aria-live="polite">([^<]*)<\/div>/.exec(body)![1];
const PARTIAL_HINT='核对素材已保存；再次采用只重试写入本题观点。';
const adoptButton=(foot:string)=>/<button class="button primary" data-action="speech-adopt-viewpoint" (disabled)?[^>]*>([^<]*)<\/button>/.exec(foot)!;
test('采用成功：按钮区先显示已采用与写入状态，约800ms后关闭弹窗，关闭后再toast',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),applied:string[]=[];
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'本题素材',onAdopt:text=>{applied.push(text);}});f.setSession(snapshot());f.edit('核对后的观点');
    assert.equal(adoptButton(f.last().foot!)[2],'采用到本题观点');assert.equal(adoptButton(f.last().foot!)[1],undefined);assert.equal(recorderStatus(f.last().body),'转写已完成，请核对后采用');assert.doesNotMatch(f.last().body,new RegExp(PARTIAL_HINT));
    await f.adopt();const foot=f.last().foot!,button=adoptButton(foot);
    assert.deepEqual(applied,['核对后的观点']);assert.equal(button[2],'已采用');assert.equal(button[1],'disabled');assert.match(foot,/<span class="speech-adopt-status" role="status">已写入本题观点草稿<\/span>/);
    assert.doesNotMatch(f.last().body,new RegExp(PARTIAL_HINT));assert.doesNotMatch(f.last().body,/role="alert"/);assert.doesNotMatch(f.last().body,/正在保存已核对文字/);assert.deepEqual(f.events,[]);assert.equal(f.internal.state,'adopted');assert.equal(recorderStatus(f.last().body),'已采用到本题观点');assert.match(f.last().body,/data-action="speech-start" disabled/);assert.match(foot,/data-action="speech-adopt-viewpoint" disabled data-adopted>/);assert.doesNotMatch(f.last().body,/转写已完成，请核对后采用/);
    t.mock.timers.tick(799);assert.deepEqual(f.events,[]);assert.equal(f.internal.open,true);
    t.mock.timers.tick(1);assert.deepEqual(f.events,['close:completed','toast:已保存为本题个人素材，并补入观点草稿；核心稿仍待人工确认']);assert.equal(f.internal.open,false);
    assert.equal(f.calls.filter(call=>call.path.endsWith('/adoption')).length,1);assert.deepEqual(f.internal.illegalTransitions,[]);
  }finally{f.controller.dispose();await flush();t.mock.timers.reset();}
});
test('采用请求失败：按钮恢复为重试采用，alert说明原因且不露技术细节，标题与文字保留，重试只用原key',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),applied:string[]=[];let posts=0;
  try{
    f.setReader(async(method,path)=>{if(path==='/api/v1/settings/speech-input')return {enabled:true};if(path.endsWith('/adoption')){if(++posts===1)throw new TypeError('Failed to fetch');if(posts===2)throw new WorkbenchTransportError(503,{error:{code:'STORAGE_UNAVAILABLE',message:'本机存储暂时不可用',retryable:true,details:{},request_id:'fixture-request-id'}});return {...snapshot(),source_record_id:'source-A'};}if(method==='GET')return snapshot();throw new Error('Unexpected '+path);});
    await f.controller.openForTopic({topicId:'topic-A',title:'保留的标题',onAdopt:text=>{applied.push(text);}});f.setSession(snapshot());f.edit('保留的核对文字');await f.adopt();
    let body=f.last().body,button=adoptButton(f.last().foot!);
    assert.equal(f.internal.state,'adopt_failed');assert.equal(button[2],'重试采用');assert.equal(button[1],undefined);assert.match(body,/<p class="speech-error" role="alert">采用保存回执尚未确认：网络连接中断或服务暂时不可用。转写文字和标题已保留/);assert.doesNotMatch(body,/Failed to fetch/);
    assert.match(body,/id="speech-title"[^>]*value="保留的标题"/);assert.equal(f.fields.get('#speech-text')!.value,'保留的核对文字');assert.doesNotMatch(f.last().foot!,/role="status"/);assert.doesNotMatch(body,new RegExp(PARTIAL_HINT));assert.deepEqual(applied,[]);
    await f.adopt();body=f.last().body;button=adoptButton(f.last().foot!);
    assert.equal(button[2],'重试采用');assert.match(body,/role="alert">采用保存回执尚未确认：本机存储暂时不可用。/);assert.doesNotMatch(body,/STORAGE_UNAVAILABLE|503|fixture-request-id|provider|job/i);assert.equal(f.fields.get('#speech-text')!.value,'保留的核对文字');
    await f.adopt();assert.equal(adoptButton(f.last().foot!)[2],'已采用');assert.deepEqual(applied,['保留的核对文字']);const keys=new Set(f.calls.filter(call=>call.path.endsWith('/adoption')).map(call=>call.key));assert.equal(posts,3);assert.equal(keys.size,1);t.mock.timers.tick(800);assert.deepEqual(f.events,['close:completed','toast:已保存为本题个人素材，并补入观点草稿；核心稿仍待人工确认']);assert.deepEqual(f.internal.illegalTransitions,[]);
  }finally{f.controller.dispose();await flush();t.mock.timers.reset();}
});
test('素材已保存但观点草稿未写入：alert提示中间态、按钮为重试写入观点，只重试写入不重复POST，提示只在此态出现',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),applied:string[]=[];let attempts=0;
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:text=>{attempts++;if(attempts===1)throw new Error('观点尚未保存，请先恢复连接或处理版本冲突');if(attempts===2)throw new Error('quota exceeded at storage layer');applied.push(text);}});f.setSession(snapshot());f.edit('已核对的观点');await f.adopt();
    let body=f.last().body,button=adoptButton(f.last().foot!);
    assert.equal(f.internal.state,'partially_adopted');assert.match(body,/<p class="speech-error" role="alert">个人素材已保存，观点草稿尚未写入：观点尚未保存，请先恢复连接或处理版本冲突。<\/p>/);assert.match(body,new RegExp('<p class="fine">'+PARTIAL_HINT+'</p>'));assert.equal(button[2],'重试写入观点');assert.equal(button[1],undefined);assert.doesNotMatch(f.last().foot!,/role="status"/);assert.equal(recorderStatus(body),'素材已保存，观点待写入');assert.doesNotMatch(body,/转写已完成，请核对后采用/);
    await f.adopt();body=f.last().body;assert.match(body,/role="alert">个人素材已保存，观点草稿尚未写入：观点草稿暂时没有保存成功。/);assert.doesNotMatch(body,/quota exceeded/);assert.equal(adoptButton(f.last().foot!)[2],'重试写入观点');
    await f.adopt();body=f.last().body;assert.equal(attempts,3);assert.deepEqual(applied,['已核对的观点']);assert.equal(f.calls.filter(call=>call.path.endsWith('/adoption')).length,1);assert.equal(adoptButton(f.last().foot!)[2],'已采用');assert.doesNotMatch(body,new RegExp(PARTIAL_HINT));assert.doesNotMatch(body,/role="alert"/);assert.match(f.last().foot!,/已写入本题观点草稿/);
    t.mock.timers.tick(800);assert.deepEqual(f.events,['close:completed','toast:已保存为本题个人素材，并补入观点草稿；核心稿仍待人工确认']);assert.deepEqual(f.internal.illegalTransitions,[]);
  }finally{f.controller.dispose();await flush();t.mock.timers.reset();}
});
test('转写已有录音：超过10分钟的WAV在发送前被拦下，提示超过10分钟，不调用上传',async()=>{
  const f=fixture(),wav=(seconds:number)=>{const bytes=new Uint8Array(44+seconds*32000),view=new DataView(bytes.buffer);bytes.set([...'RIFF'].map(c=>c.charCodeAt(0)),0);view.setUint32(4,bytes.length-8,true);bytes.set([...'WAVEfmt '].map(c=>c.charCodeAt(0)),8);bytes.set([...'data'].map(c=>c.charCodeAt(0)),36);view.setUint32(40,seconds*32000,true);return bytes;};
  try{
    await f.internal.perform('speech-open');const long=wav(601);f.internal.selectedFile={name:'long.wav',size:long.length,arrayBuffer:async()=>long.buffer};await f.internal.perform('speech-upload');
    assert.match(f.last().body,/role="alert">录音超过 10 分钟，请剪短后再转写</);assert.equal(f.calls.filter(call=>call.path==='/api/v1/speech-recordings').length,0);assert.equal(f.internal.state,'idle');assert.equal(f.internal.busy,false);
    f.internal.selectedFile={name:'huge.wav',size:30_000_000,arrayBuffer:async()=>assert.fail('oversized file must not be read')};f.internal.error='';await f.internal.perform('speech-upload');assert.match(f.last().body,/录音超过 10 分钟，请剪短后再转写/);assert.equal(f.calls.filter(call=>call.path==='/api/v1/speech-recordings').length,0);
  }finally{f.controller.dispose();await flush();}
});
test('已知技术文案翻译成用户语言，表外中文消息原样透传',async()=>{
  const f=fixture(),failures=[new WorkbenchTransportError(400,{error:{code:'VALIDATION_ERROR',message:'缺少有效 Idempotency-Key',retryable:false,details:{},request_id:'r1'}}),new WorkbenchTransportError(400,{error:{code:'VALIDATION_ERROR',message:'JSON 请求超过大小限制',retryable:false,details:{},request_id:'r2'}}),new WorkbenchTransportError(409,{error:{code:'VERSION_CONFLICT',message:'记录已被更新',retryable:false,details:{},request_id:'r3'}}),new WorkbenchTransportError(503,{error:{code:'STORAGE_UNAVAILABLE',message:'本机存储暂时不可用',retryable:true,details:{},request_id:'r4'}})];
  const expected=['这次提交缺少必要信息，请关闭后重新打开再试','这段录音太长，请剪短后再试','内容已被其他操作更新，请关闭后重新打开','本机存储暂时不可用'];
  try{
    f.setReader(async(method,path)=>{if(path==='/api/v1/settings/speech-input')return {enabled:true};if(path.endsWith('/adoption'))throw failures.shift();if(method==='GET')return snapshot();throw new Error('Unexpected '+path);});
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{}});f.setSession(snapshot());f.edit('核对文字');
    for(const reason of expected){await f.adopt();const alert=/role="alert">([^<]*)</.exec(f.last().body)![1];assert.ok(alert.includes('采用保存回执尚未确认：'+reason+'。'),alert);assert.doesNotMatch(alert,/Idempotency|JSON|VERSION_CONFLICT|记录已被更新/);}
  }finally{f.controller.dispose();await flush();}
});
test('映射只按错误码：VERSION_CONFLICT转用户文案，无码的版本冲突/离线消息原样保留',async()=>{
  const f=fixture();let attempt=0;const errors=[new WorkbenchTransportError(409,{error:{code:'VERSION_CONFLICT',message:'观点版本冲突',retryable:false,details:{},request_id:'r'}}),new Error('观点尚未保存，请先恢复连接或处理版本冲突'),new Error('当前离线，观点已保存在本机，恢复连接后会自动同步')];
  try{
    await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{const error=errors[attempt++];if(error)throw error;}});f.setSession(snapshot());f.edit('核对文字');
    const alerts:string[]=[];for(let i=0;i<3;i++){await f.adopt();alerts.push(/role="alert">([^<]*)</.exec(f.last().body)![1]);}
    assert.deepEqual(alerts,['个人素材已保存，观点草稿尚未写入：内容已被其他操作更新，请关闭后重新打开。','个人素材已保存，观点草稿尚未写入：观点尚未保存，请先恢复连接或处理版本冲突。','个人素材已保存，观点草稿尚未写入：当前离线，观点已保存在本机，恢复连接后会自动同步。']);assert.equal(new Set(alerts).size,3);
  }finally{f.controller.dispose();await flush();}
});

// Phase 2 cleanup draft: raw transcript is adoptable at once; the cleanup draft arrives later as the default view with the raw text one click away.
const cleanupSession=(cleanup:NonNullable<SpeechInputSnapshot['cleanup_state']>,extra:Partial<SpeechInputSnapshot>={}):SpeechInputSnapshot=>({...snapshot(),cleanup_state:cleanup,cleaned_text:null,cleanup_error:null,...extra});
const statusLine=(body:string)=>/class="speech-status"[^>]*>([^<]*)</.exec(body)?.[1];
const pressed=(body:string)=>/data-action="speech-version-(cleaned|raw)" aria-pressed="true"/.exec(body)?.[1];
test('整理完成后出现原文/整理稿切换并默认显示整理稿；整理中由真实排队/执行状态提示，采用记录整理稿来源',async()=>{
  const f=fixture(),applied:string[]=[];
  try{await f.controller.openForTopic({topicId:'topic-A',title:'本题素材',onAdopt:text=>{applied.push(text);}});
    f.setSession(cleanupSession('queued'));assert.equal(statusLine(f.last().body),'整理稿排队中，可先核对原文');assert.doesNotMatch(f.last().body,/speech-version-toggle/);assert.doesNotMatch(f.last().foot!,/speech-adopt-viewpoint" disabled/);assert.equal(f.fields.get('#speech-text')!.value,'本人讲述的文字');
    f.edit('本人先改了原文');f.internal.accept(cleanupSession('running'));assert.equal(statusLine(f.last().body),'正在整理文字，可先核对原文');assert.equal(f.fields.get('#speech-text')!.value,'本人先改了原文');
    f.internal.accept(cleanupSession('succeeded',{cleaned_text:'整理后的本人观点'}));assert.match(f.last().body,/speech-version-toggle/);assert.equal(pressed(f.last().body),'cleaned');assert.equal(f.fields.get('#speech-text')!.value,'整理后的本人观点');assert.match(f.last().body,/整理稿 · 可编辑，原文保留/);assert.match(statusLine(f.last().body)!,/整理稿已完成/);
    assert.deepEqual(f.internal.illegalTransitions,[]);assert.equal(f.internal.state,'cleaned');
    await f.adopt();const adoption=f.calls.find(call=>call.path.endsWith('/adoption'))!;assert.deepEqual(adoption.body,{title:'本题素材',text:'整理后的本人观点',topic_id:'topic-A',adopted_from:'cleaned'});assert.deepEqual(applied,['整理后的本人观点']);assert.doesNotMatch(f.last().body,/speech-version-toggle/);
  }finally{f.controller.dispose();await flush();}
});
test('切回原文：两版各自保留编辑，原文永远可切回；采用原文不带整理稿来源',async()=>{
  const f=fixture(),applied:string[]=[],click=async(action:string)=>{f.controller.handleClick({dataset:{action}} as unknown as HTMLElement);await flush();};
  try{await f.controller.openForTopic({topicId:'topic-A',title:'本题素材',onAdopt:text=>{applied.push(text);}});
    f.setSession(cleanupSession('queued'));f.edit('本人改过的原文');f.internal.accept(cleanupSession('succeeded',{cleaned_text:'整理稿原样'}));f.edit('整理稿上又改了一句');
    await click('speech-version-raw');assert.equal(pressed(f.last().body),'raw');assert.equal(f.fields.get('#speech-text')!.value,'本人改过的原文');assert.match(f.last().body,/转写原文 · 可编辑/);
    await click('speech-version-cleaned');assert.equal(f.fields.get('#speech-text')!.value,'整理稿上又改了一句');
    await click('speech-version-raw');f.edit('原文最终版');await click('speech-version-cleaned');await click('speech-version-raw');assert.equal(f.fields.get('#speech-text')!.value,'原文最终版');
    assert.match(f.last().body,/原始转写与请求记录/);assert.match(f.last().body,/本人讲述的文字/);
    await f.adopt();const adoption=f.calls.find(call=>call.path.endsWith('/adoption'))!;assert.deepEqual(adoption.body,{title:'本题素材',text:'原文最终版',topic_id:'topic-A'});assert.deepEqual(applied,['原文最终版']);
  }finally{f.controller.dispose();await flush();}
});
test('整理失败只在状态行提示可直接采用原文：无alert、无切换，原文照常采用',async()=>{
  const f=fixture(),applied:string[]=[];
  try{await f.controller.openForTopic({topicId:'topic-A',title:'本题素材',onAdopt:text=>{applied.push(text);}});
    f.setSession(cleanupSession('running'));f.edit('核对过的原文');f.internal.accept(cleanupSession('failed',{cleanup_error:'整理稿与原文长度相差过大，未采用整理稿'}));
    assert.equal(statusLine(f.last().body),'整理未完成，可直接采用原文');assert.doesNotMatch(f.last().body,/role="alert"/);assert.doesNotMatch(f.last().body,/speech-version-toggle|长度相差/);assert.equal(f.internal.state,'clean_failed');assert.equal(f.fields.get('#speech-text')!.value,'核对过的原文');assert.doesNotMatch(f.last().foot!,/speech-adopt-viewpoint" disabled/);
    await f.adopt();assert.deepEqual(f.calls.find(call=>call.path.endsWith('/adoption'))!.body,{title:'本题素材',text:'核对过的原文',topic_id:'topic-A'});assert.deepEqual(applied,['核对过的原文']);assert.equal(f.internal.state,'adopted');
  }finally{f.controller.dispose();await flush();}
});
// Plain entry: material saved first can still be linked to the current topic, without a second material or adoption.
function linkReader(f:ReturnType<typeof fixture>,fail=0){let failures=fail;const linked:string[]=[];f.setReader(async(_method,path,body)=>{if(path==='/api/v1/settings/speech-input')return {enabled:true,credential_present:true,connection:'verified',setup_url:null,limits:{}};const id=path.split('/')[4]!;
  if(path.endsWith('/adoption'))return {...snapshot('final',id),source_record_id:'source-'+id};
  if(path.endsWith('/topic-link')){if(failures-->0)throw new TypeError('Failed to fetch');const topic=(body as {topic_id:string}).topic_id;if(!linked.includes(topic))linked.push(topic);return {...snapshot('final',id),source_record_id:'source-'+id,linked_topic_ids:[...linked]};}
  return snapshot('final',id);});}
const plainFoot=(foot:string)=>({adopt:/data-action="speech-adopt"[^>]*>/.exec(foot)![0],link:/data-action="speech-adopt-topic"[^>]*>/.exec(foot)![0]});
test('普通入口先采用到个人素材，再关联当前主题：只发一次adoption加一次关联，状态行与按钮随之落定',async()=>{
  const f=fixture();linkReader(f);
  try{await f.internal.perform('speech-open');f.setSession(snapshot());f.edit('普通素材');await f.internal.perform('speech-adopt');assert.equal(f.internal.open,false);
    await f.internal.perform('speech-open');assert.equal(f.internal.state,'adopted');let foot=plainFoot(f.last().foot!);assert.match(foot.adopt,/disabled/);assert.doesNotMatch(foot.link,/disabled/);assert.equal(statusLine(f.last().body),'已保存为个人素材');
    await f.internal.perform('speech-adopt-topic');foot=plainFoot(f.last().foot!);assert.match(foot.link,/disabled/);assert.equal(statusLine(f.last().body),'已保存为个人素材，并关联到当前主题');assert.equal(f.internal.state,'adopted_linked');
    const posts=f.calls.filter(call=>call.method==='POST');assert.deepEqual(posts.map(call=>call.path),['/api/v1/speech-inputs/speech-A/adoption','/api/v1/speech-inputs/speech-A/topic-link']);assert.deepEqual(posts[1]!.body,{topic_id:'topic-A'});assert.deepEqual(f.internal.illegalTransitions,[]);
  }finally{f.controller.dispose();await flush();}
});
test('重复点关联幂等：并发点击只发一次，回执丢失重试沿用同一幂等键，已关联后不再发送',async()=>{
  const f=fixture();linkReader(f,1);
  try{await f.internal.perform('speech-open');f.setSession(snapshot());f.edit('普通素材');await f.internal.perform('speech-adopt');await f.internal.perform('speech-open');
    await Promise.all([f.internal.perform('speech-adopt-topic'),f.internal.perform('speech-adopt-topic')]);assert.equal(f.internal.state,'adopted');assert.doesNotMatch(plainFoot(f.last().foot!).link,/disabled/);assert.match(f.last().body,/素材已保存，关联当前主题未完成：网络连接中断或服务暂时不可用/);assert.doesNotMatch(f.last().body,/Failed to fetch/);
    await f.internal.perform('speech-adopt-topic');await f.internal.perform('speech-adopt-topic');f.controller.close();await f.internal.perform('speech-open');await f.internal.perform('speech-adopt-topic');
    const links=f.calls.filter(call=>call.path.endsWith('/topic-link'));assert.equal(links.length,2);assert.equal(new Set(links.map(call=>call.key)).size,1);assert.equal(links[0]!.key,'speech-A:topic-link:topic-A');assert.equal(f.calls.filter(call=>call.path.endsWith('/adoption')).length,1);
    assert.equal(f.internal.state,'adopted_linked');assert.match(plainFoot(f.last().foot!).link,/disabled/);
  }finally{f.controller.dispose();await flush();}
});
test('整理中开新录音被麦克风拒绝：回到整理态并恢复整理读取，不卡在旧状态',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),descriptors=new Map<PropertyKey,PropertyDescriptor|undefined>(),replace=(object:object,key:PropertyKey,value:unknown)=>{descriptors.set(key,Object.getOwnPropertyDescriptor(object,key));Object.defineProperty(object,key,{configurable:true,writable:true,value});};
  replace(globalThis,'window',{isSecureContext:true,AudioWorkletNode:class {}});replace(globalThis,'AudioContext',class {state='running';async resume(){}async close(){this.state='closed';}});
  const mediaDescriptor=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{throw new DOMException('denied','NotAllowedError');}}});
  try{await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{}});f.setSession(cleanupSession('queued'));assert.ok(f.internal.cleanupTimer);f.edit('先改的原文');
    await f.internal.start();assert.equal(f.internal.state,'cleaning');const reads=()=>f.calls.filter(call=>call.method==='GET'&&call.path==='/api/v1/speech-inputs/speech-A').length;for(let i=0;i<4;i++){t.mock.timers.tick(2500);await flush();await flush();}assert.ok(reads()>=2,'cleanup reads keep going after the denied capture: '+reads());assert.equal(statusLine(f.last().body),'整理稿排队中，可先核对原文');assert.match(f.last().body,/麦克风权限未允许/);assert.equal(f.calls.filter(call=>call.path==='/api/v1/speech-inputs').length,0);
    f.internal.accept(cleanupSession('succeeded',{cleaned_text:'整理后的文字'}));assert.equal(f.internal.state,'cleaned');assert.equal(f.fields.get('#speech-text')!.value,'整理后的文字');assert.deepEqual(f.internal.illegalTransitions,[]);
  }finally{f.controller.dispose();await flush();t.mock.timers.reset();for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as Record<PropertyKey,unknown>)[key];}if(mediaDescriptor)Object.defineProperty(navigator,'mediaDevices',mediaDescriptor);else delete (navigator as unknown as Record<string,unknown>).mediaDevices;}
});
test('整理读取间隔逐步拉长：1.5s起每次×1.5、上限10s，读取失败同样拉长；整理状态变化时重置为1.5s',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const mocked=globalThis.setTimeout,delays:number[]=[];
  globalThis.setTimeout=((fn:(...args:unknown[])=>void,ms?:number,...rest:unknown[])=>{if(typeof ms==='number'&&ms!==8000)delays.push(ms);return mocked(fn,ms,...rest);}) as typeof setTimeout;
  const f=fixture();let current=cleanupSession('queued'),failNext=false;
  f.setReader(async(_method,path)=>{if(path==='/api/v1/settings/speech-input')return {enabled:true};if(failNext){failNext=false;throw new TypeError('Failed to fetch');}return current;});
  const step=async(ms:number)=>{t.mock.timers.tick(ms);for(let i=0;i<4;i++)await flush();};
  try{await f.controller.openForTopic({topicId:'topic-A',title:'A',onAdopt:()=>{}});f.setSession(current);
    await step(1500);failNext=true;await step(2250);await step(3375);await step(5062.5);await step(7593.75);await step(10000);
    current=cleanupSession('running');await step(10000);await step(1500);
    current=cleanupSession('succeeded',{cleaned_text:'整理后的文字'});await step(2250);await step(10000);
    assert.deepEqual(delays,[1500,2250,3375,5062.5,7593.75,10000,10000,1500,2250]);assert.equal(f.internal.state,'cleaned');assert.equal(f.internal.cleanupTimer,undefined);
  }finally{f.controller.dispose();await flush();globalThis.setTimeout=mocked;t.mock.timers.reset();}
});
test('重新整理：用编辑框文字和所选执行器新建整理（带原整理任务栅栏），状态回到整理中；整理进行中不可点',async()=>{
  const f=fixture(),posts:{body:unknown;key?:string}[]=[];
  try{
    f.setReader(async(method,path,body)=>{if(path==='/api/v1/settings/speech-input')return {enabled:true,credential_present:true,connection:'unverified',setup_url:null,limits:{}};if(path==='/api/v1/settings')return {default_executor:'codex',executors:[{executor_id:'codex',status:'unverified',auth_state:'QUOTA_EXHAUSTED'},{executor_id:'claude',status:'supported',auth_state:'subscription_authenticated'}]};
      if(method==='POST'&&path.endsWith('/cleanup')){posts.push({body,key:f.calls.at(-1)!.key});return cleanupSession('queued',{cleanup_job_id:'job-2'});}return cleanupSession('queued',{cleanup_job_id:'job-2'});});
    await f.controller.openForTopic({topicId:'topic-A',title:'本题素材',onAdopt:()=>{}});
    f.setSession(cleanupSession('running',{cleanup_job_id:'job-1'}));assert.match(f.last().body,/data-action="speech-recleanup" disabled/);
    f.internal.accept(cleanupSession('failed',{cleanup_job_id:'job-1',cleanup_error:'整理未完成'}));assert.equal(f.internal.state,'clean_failed');
    assert.match(f.last().body,/<select class="field" id="speech-cleanup-executor" ><option value="codex" disabled>Codex · 额度暂不可用<\/option><option value="claude" selected>Claude · 可用<\/option><\/select>/);assert.doesNotMatch(f.last().body,/data-action="speech-recleanup" disabled/);
    f.edit('本人改过、想重新整理的文字');await f.internal.perform('speech-recleanup');
    assert.deepEqual(posts.map(p=>p.body),[{text:'本人改过、想重新整理的文字',expected_cleanup_job_id:'job-1',executor:'claude'}]);assert.ok(posts[0]!.key);
    assert.equal(f.internal.state,'cleaning');assert.equal(statusLine(f.last().body),'整理稿排队中，可先核对原文');assert.equal(f.fields.get('#speech-text')!.value,'本人改过、想重新整理的文字');
    assert.equal(f.calls.filter(c=>c.method!=='GET'&&c.path.startsWith('/api/v1/settings')).length,0,'不改全局设置');
  }finally{f.controller.dispose();}
});
test('重新整理后，迟到的旧整理读取（旧 cleanup_job_id）不覆盖新的整理中状态',async()=>{
  const f=fixture();
  try{
    f.setReader(async(method,path)=>{if(path==='/api/v1/settings/speech-input')return {enabled:true,credential_present:true,connection:'unverified',setup_url:null,limits:{}};if(path==='/api/v1/settings')return {default_executor:'claude',executors:[{executor_id:'claude',status:'unverified',auth_state:'subscription_authenticated'}]};if(method==='POST'&&path.endsWith('/cleanup'))return cleanupSession('queued',{cleanup_job_id:'job-2'});return cleanupSession('queued',{cleanup_job_id:'job-2'});});
    await f.controller.openForTopic({topicId:'topic-A',title:'本题素材',onAdopt:()=>{}});
    f.setSession(cleanupSession('failed',{cleanup_job_id:'job-1',cleanup_error:'整理未完成'}));f.edit('改过的文字');await f.internal.perform('speech-recleanup');assert.equal(f.internal.state,'cleaning');assert.equal(f.internal.session.cleanup_job_id,'job-2');
    f.internal.accept(cleanupSession('failed',{cleanup_job_id:'job-1',cleanup_error:'整理已取消'}));
    assert.equal(f.internal.state,'cleaning');assert.equal(f.internal.session.cleanup_job_id,'job-2');assert.match(f.last().body,/speech-recleanup-status" role="status">整理已排队，完成后会出现整理稿/);
    f.internal.accept(cleanupSession('succeeded',{cleanup_job_id:'job-2',cleaned_text:'新的整理稿'}));assert.equal(f.internal.state,'cleaned');
  }finally{f.controller.dispose();}
});
test('快照缺整理任务编号时先读回服务端投影，不发 null 栅栏；换录音后作废记录清空',async()=>{
  const f=fixture(),posts:unknown[]=[];
  try{
    f.setReader(async(method,path,body)=>{if(path==='/api/v1/settings/speech-input')return {enabled:true,credential_present:true,connection:'unverified',setup_url:null,limits:{}};if(path==='/api/v1/settings')return {default_executor:'claude',executors:[{executor_id:'claude',status:'unverified',auth_state:'subscription_authenticated'}]};if(method==='POST'&&path.endsWith('/cleanup')){posts.push(body);return cleanupSession('queued',{cleanup_job_id:'job-2'});}return cleanupSession('failed',{cleanup_job_id:'job-1',cleanup_error:'整理未完成'});});
    await f.controller.openForTopic({topicId:'topic-A',title:'本题素材',onAdopt:()=>{}});
    f.setSession(cleanupSession('failed',{cleanup_error:'整理未完成'}));f.edit('旧记录改过的文字');await f.internal.perform('speech-recleanup');
    assert.deepEqual(posts,[{text:'旧记录改过的文字',expected_cleanup_job_id:'job-1',executor:'claude'}]);assert.equal(f.internal.supersededCleanup.has('job-1'),true);
    f.setSession({...cleanupSession('queued',{cleanup_job_id:'job-9'}),id:'speech-B'});assert.equal(f.internal.supersededCleanup.size,0,'换到新录音清空作废记录');
  }finally{f.controller.dispose();}
});
