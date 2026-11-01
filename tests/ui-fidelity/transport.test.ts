import test from 'node:test';
import assert from 'node:assert/strict';
import {DocumentDraft} from '../../apps/web/src/transport/drafts.ts';
import {TaskDialogSession} from '../../apps/web/src/transport/task-dialog.ts';
import {createHttpClient} from '../../apps/web/src/transport/workbench-client.ts';
import type {WorkbenchClient} from '../../apps/web/src/transport/workbench-client.ts';
import type {DocumentSnapshot,SaveRevisionRequest,SaveRevisionResponse,ServiceIdentity,Sha256} from '../../packages/contracts/src/index.ts';

const identity:ServiceIdentity={service_instance_id:'isolated-service',workspace_id:'isolated-workspace',contract_version:'0.1.1'};
const snapshot:DocumentSnapshot={document_id:'doc1',head_revision_id:'r1',version:1,text:'原稿',hash:null,save_state:'committed'};
function memory(){const map=new Map<string,string>();return {map,getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);},removeItem:(k:string)=>{map.delete(k);}};}
const saved=(revision:string):SaveRevisionResponse=>({document_id:'doc1',revision_id:revision,write_intent_id:'intent-'+revision,version:Number(revision.slice(1)),hash:'0'.repeat(64) as Sha256,save_state:'committed'});
function client(save:WorkbenchClient['saveDocument']):WorkbenchClient {return {identity:async()=>identity,getDocument:async()=>snapshot,saveDocument:save,getSettings:async()=>{throw new Error('not used');},patchSettings:async()=>{throw new Error('not used');},cancelJob:async()=>null,request:async()=>{throw new Error('not used');}};}

test('采用或恢复后接受新服务head；脏稿和ACK未确认命令保持原文与base',async()=>{
 const requests:SaveRevisionRequest[]=[],storage=memory();const draft=new DocumentDraft(client(async(_id,input)=>{requests.push(input);return saved('r3');}),identity,snapshot,storage);
 draft.syncSnapshot({...snapshot,head_revision_id:'adopted-r2',text:'已采用的候选'});assert.equal(draft.value(),'已采用的候选');
 draft.edit('人工继续编辑');draft.syncSnapshot({...snapshot,head_revision_id:'remote-r4',text:'其他入口正文'});assert.equal(draft.value(),'人工继续编辑');await draft.flush();assert.equal(requests[0]!.expected_revision_id,'adopted-r2');draft.dispose();
 const pending=new DocumentDraft(client(async()=>{throw new Error('ACK丢失');}),identity,snapshot,memory());pending.edit('尚未确认的输入');await pending.flush();pending.syncSnapshot({...snapshot,head_revision_id:'r5',text:'远端正文'});assert.equal(pending.value(),'尚未确认的输入');assert.equal(pending.status,'offline');pending.dispose();
});

test('同稿慢保存串行；服务确认旧输入时最新输入不显示已保存',async()=>{
  const storage=memory(),calls:SaveRevisionRequest[]=[],states:string[]=[];
  let release:((response:SaveRevisionResponse)=>void)|undefined;
  const draft=new DocumentDraft(client(async(_id,input)=>{calls.push(input);if(calls.length===1)return await new Promise<SaveRevisionResponse>(resolve=>{release=resolve;});return saved('r3');}),identity,snapshot,storage,status=>states.push(status));
  draft.edit('人工 r2');const pending=draft.flush();draft.edit('人工 r3');
  assert.equal(calls.length,1);assert.equal(draft.value(),'人工 r3');assert.equal(draft.status,'dirty');
  release!(saved('r2'));await pending;
  assert.deepEqual(calls.map(c=>[c.text,c.expected_revision_id]),[['人工 r2','r1'],['人工 r3','r2']]);
  assert.equal(draft.status,'committed');assert.equal(storage.map.size,0);assert.equal(states.filter(s=>s==='committed').length,2);draft.dispose();
});

test('约一秒自动提交；断线和刷新保留未提交输入与固定base',async()=>{
  const storage=memory(),calls:SaveRevisionRequest[]=[];
  const offline=client(async(_id,input)=>{calls.push(input);throw new Error('network unavailable');});
  const draft=new DocumentDraft(offline,identity,snapshot,storage);
  draft.edit('断线时继续写');await new Promise(resolve=>setTimeout(resolve,1100));
  assert.equal(calls.length,1);assert.equal(draft.status,'offline');assert.equal(draft.value(),'断线时继续写');draft.dispose();
  const restored=new DocumentDraft(offline,identity,snapshot,storage);assert.equal(restored.value(),'断线时继续写');assert.equal(restored.status,'dirty');restored.dispose();
  // 未发请求的本地副本遇到不同head时禁止覆盖；已发送pending先重放原command。
  const unsentStorage=memory(),unsent=new DocumentDraft(offline,identity,snapshot,unsentStorage);unsent.edit('尚未发送的输入');unsent.dispose();
  const conflict=new DocumentDraft(offline,identity,{...snapshot,head_revision_id:'remote-r2',text:'另一个入口已提交'},unsentStorage);
  assert.equal(conflict.value(),'尚未发送的输入');assert.equal(conflict.status,'conflict');await conflict.flush();assert.equal(calls.length,1);conflict.dispose();
});

test('服务已提交但ACK丢失：刷新保留原command/key，取回r2后串行保存继续输入',async()=>{
  const storage=memory(),receipts=new Map<string,{body:string;response:SaveRevisionResponse}>(),calls:{input:SaveRevisionRequest;key:string}[]=[];
  let head='r1',loseFirstResponse=true;
  const service=client(async(_id,input,options)=>{
    const key=options!.idempotencyKey!,body=JSON.stringify(input);calls.push({input:{...input},key});
    const existing=receipts.get(key);if(existing){assert.equal(existing.body,body);return existing.response;}
    if(input.expected_revision_id!==head)throw new Error('REVISION_CONFLICT: wrong new key');
    head='r'+(Number(head.slice(1))+1);const response=saved(head);receipts.set(key,{body,response});
    if(loseFirstResponse){loseFirstResponse=false;throw new Error('connection lost after commit');}
    return response;
  });
  const original=new DocumentDraft(service,identity,snapshot,storage);original.edit('已在服务提交的人工r2');await original.flush();
  assert.equal(head,'r2');assert.equal(original.status,'offline');const firstKey=calls[0]!.key;
  original.edit('响应丢失后继续写人工r3');original.dispose();
  const cached=JSON.parse([...storage.map.values()][0]!);assert.equal(cached.pending_command.idempotency_key,firstKey);assert.equal(cached.pending_command.text,'已在服务提交的人工r2');assert.equal(cached.text,'响应丢失后继续写人工r3');
  await assert.rejects(()=>service.saveDocument('doc1',calls[0]!.input,{idempotencyKey:'wrong-new-key'}),/REVISION_CONFLICT/);
  const restored=new DocumentDraft(service,identity,{...snapshot,head_revision_id:'r2',text:'已在服务提交的人工r2'},storage);
  assert.equal(restored.value(),'响应丢失后继续写人工r3');assert.equal(restored.status,'dirty');await restored.leave();
  assert.equal(calls[2]!.key,firstKey);assert.deepEqual(calls[2]!.input,calls[0]!.input);
  assert.notEqual(calls[3]!.key,firstKey);assert.equal(calls[3]!.input.expected_revision_id,'r2');assert.equal(calls[3]!.input.text,'响应丢失后继续写人工r3');
  assert.equal(head,'r3');assert.equal(restored.status,'committed');assert.equal(receipts.size,2);assert.equal(storage.map.size,0);restored.dispose();
});

test('user_close/cancel/escape各请求一次取消；completed和重复close不取消',async()=>{
  for(const reason of ['user_close','cancel','escape'] as const){const requests:string[]=[];const session=new TaskDialogSession(async r=>{requests.push(r);});session.begin();await session.close(reason);await session.close('user_close');assert.deepEqual(requests,[reason]);}
  let requests=0;const completed=new TaskDialogSession(async()=>{requests++;});completed.begin();await completed.close('completed');await completed.close('user_close');assert.equal(requests,0);
});

test('HTTP transport固定主服务身份、expected revision与幂等key；错误身份拒绝写',async()=>{
  const requests:{url:string;headers:Headers;body:unknown}[]=[];
  const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);requests.push({url,headers:new Headers(init?.headers),body:init?.body?JSON.parse(String(init.body)):null});return new Response(JSON.stringify(url.endsWith('/identity')?identity:saved('r2')),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
  const http=createHttpClient('http://fixture.invalid',identity,fetcher);await http.saveDocument('doc1',{expected_revision_id:'r1',text:'人工',origin:'human'},{idempotencyKey:'fixed-key'});
  assert.equal(requests[1]!.headers.get('X-Workspace-Id'),identity.workspace_id);assert.equal(requests[1]!.headers.get('X-Service-Instance-Id'),identity.service_instance_id);assert.equal(requests[1]!.headers.get('Idempotency-Key'),'fixed-key');assert.deepEqual(requests[1]!.body,{expected_revision_id:'r1',text:'人工',origin:'human'});
  const wrong=createHttpClient('',{...identity,workspace_id:'other'},fetcher);await assert.rejects(()=>wrong.saveDocument('doc1',{expected_revision_id:'r1',text:'拒绝',origin:'human'}),/WORKSPACE_INSTANCE_MISMATCH/);assert.equal(requests.length,3);
});
