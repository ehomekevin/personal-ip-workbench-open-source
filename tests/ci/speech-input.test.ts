import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { gzipSync,gunzipSync } from 'node:zlib';
import { lstatSync,existsSync,realpathSync,writeFileSync,chmodSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../documents/harness.ts';
import { ArkAgentPlanAsr,asrFrame,parseAsrFrame,ARK_ASR_ENDPOINTS,type AsrProvider,type AsrEvent,type AsrSocket } from '../../packages/adapters/src/media/asr/ark.ts';
import { SpeechInputs,wavPcm } from '../../packages/domain/src/speech-input/index.ts';
import { SpeechInputChunkSchema,SpeechInputBatchSchema,CancelSpeechInputSchema,TranscribeRecordingSchema,SPEECH_INPUT_LIMITS,SPEECH_INPUT_DERIVED_LIMITS } from '../../packages/contracts/src/index.ts';
import { SpeechInputController } from '../../apps/web/src/features/speech-input/index.ts';
import { createHttpClient } from '../../apps/web/src/transport/workbench-client.ts';
import type { FeatureContext } from '../../apps/web/src/transport/feature-ports.ts';
import { saveLocalCredential,readLocalCredential,localCredentialPath } from '../../apps/service/src/bootstrap/configuration/credentials.ts';
import { startCollectionSetup } from '../../scripts/runtime/collection-setup.ts';
import { resolveWorkbenchRoute } from '../../packages/host-bridge/src/core/tools.ts';
import { Topics } from '../../packages/domain/src/topics/index.ts';
import { Documents } from '../../packages/domain/src/documents/index.ts';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { startApplication } from '../../apps/service/src/bootstrap/application.ts';
import { createSpeechInputModule } from '../../apps/service/src/routes/speech-input.ts';
import { claimAsrProbeIntent } from '../helpers/asr-probe-intent.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { Jobs } from '../../packages/domain/src/jobs/index.ts';
import { ContentGeneration } from '../../packages/domain/src/content-agents/index.ts';
import { createContentAgentHandlers } from '../../apps/service/src/worker/handlers/content/index.ts';
import { cleanupDeviation } from '../../packages/domain/src/speech-input/cleanup.ts';
import { canonical,hash } from '../../packages/adapters/src/agent/codex/primitives.ts';
import { ContractError } from '../../packages/contracts/src/index.ts';
import type { AgentReadiness,AgentRunInput,AgentRunHandle,AgentResult,JsonObject } from '../../packages/contracts/src/index.ts';
function response(text='',final=false){const payload=gzipSync(Buffer.from(JSON.stringify({result:{text}}))),frame=Buffer.alloc(12+payload.length);frame.set([0x11,0x90|(final?3:1),0x11,0]);frame.writeInt32BE(final?-2:1,4);frame.writeUInt32BE(payload.length,8);frame.set(payload,12);return frame;}
function provider(){let opens=0,sends=0,closed=0,event!:(event:AsrEvent)=>void,failed!:()=>void,throwSend=false;const fake:AsrProvider={async open(_mode,onEvent,onError){opens++;event=onEvent;failed=onError;return {requestId:randomUUID(),logId:()=> 'fixture-log-id',send(_bytes,final){sends++;if(throwSend)throw new Error('PRIVATE_UPSTREAM_SENTINEL');if(final)queueMicrotask(()=>event({text:'内部协议测试文字',final:true,log_id:'fixture-log-id'}));},close(){closed++;}};}};return {fake,emit:(text:string,final=false)=>event({text,final,log_id:'fixture-log-id'}),fail:()=>failed(),unknown:()=>{throwSend=true;},counts:()=>({opens,sends,closed})};}
test('唯一实测固定intent journal先持久化；更换证据路径不能取得第二次外发意图',()=>{
  const f=fixture(),fixed=join(f.config.paths.state_root,'fixed-intent'),evidence=join(f.config.paths.state_root,'evidence-one'),other=join(f.config.paths.state_root,'evidence-two'),journal:Record<string,unknown>={intent:'fixture',state:'intent_saved',upstream_connections:0};
  try{const save=claimAsrProbeIntent(fixed,evidence,journal);assert.equal(lstatSync(join(fixed,'attempt.json')).mode&0o777,0o600);assert.equal(JSON.parse(readFileSync(join(fixed,'attempt.json'),'utf8')).upstream_connections,0);journal.state='unknown';save();assert.equal(JSON.parse(readFileSync(join(evidence,'attempt.json'),'utf8')).state,'unknown');assert.throws(()=>claimAsrProbeIntent(fixed,other,{intent:'fixture',upstream_connections:0}),/已有 journal/);assert.equal(existsSync(join(other,'attempt.json')),false);}
  finally{f.cleanup();}
});
test('Agent Plan 专用协议、二进制序号/结束包；ACK后才允许录音，响应文本可分partial/final',async()=>{
  let callback!:Parameters<AsrSocket['listen']>[0],url='',headers:Record<string,string>={},closed=false;const sent:Uint8Array[]=[];
  const adapter=new ArkAgentPlanAsr(()=> 'PRIVATE_FIXTURE_KEY',(target,auth)=>{url=target;headers=auth;return {ready:Promise.resolve(),logId:()=> 'fixture-log',send(bytes){sent.push(bytes);if(sent.length===1)queueMicrotask(()=>callback({type:'data',data:response()}));},close(){closed=true;},listen(handler){callback=handler;return()=>{};}};});
  const events:AsrEvent[]=[],stream=await adapter.open('live',event=>events.push(event),()=>assert.fail());assert.equal(url,ARK_ASR_ENDPOINTS.live);assert.equal(headers['X-Api-Key'],'PRIVATE_FIXTURE_KEY');assert.equal(headers['X-Api-Resource-Id'],'volc.seedasr.sauc.duration');assert.ok(!('X-Api-App-Key' in headers));assert.equal(Buffer.from(sent[0]!).readInt32BE(4),1);
  const payload=JSON.parse(gunzipSync(Buffer.from(sent[0]!).subarray(12)).toString());assert.deepEqual(payload.audio,{format:'pcm',codec:'raw',rate:16000,bits:16,channel:1});assert.equal(payload.request.enable_ddc,true);assert.equal(payload.request.enable_itn,true);stream.send(new Uint8Array([0,0]),true);assert.equal(sent[1]![1],0x23);assert.equal(sent[1]![2],0x11,'Agent Plan official sample serialization retained');assert.equal(Buffer.from(sent[1]!).readInt32BE(4),-2);callback({type:'data',data:response('临时文字')});callback({type:'data',data:response('完整文字',true)});assert.deepEqual(events.map(e=>[e.text,e.final]),[['临时文字',false],['完整文字',true]]);stream.close();assert.equal(closed,true);
  assert.throws(()=>parseAsrFrame(asrFrame(2,1,new Uint8Array([0,0]))));assert.throws(()=>parseAsrFrame(new Uint8Array([0x11,0x93,0x11,0])));
});
test('ASR配置包在实时与录音两种模式都开启语义顺滑enable_ddc，与ITN同级，录音模式另开nonstream',async()=>{
  for(const mode of ['live','recording'] as const){let callback!:Parameters<AsrSocket['listen']>[0];const sent:Uint8Array[]=[];
    const adapter=new ArkAgentPlanAsr(()=> 'FIXTURE_ONLY',()=>({ready:Promise.resolve(),logId:()=>null,send(bytes){sent.push(bytes);if(sent.length===1)queueMicrotask(()=>callback({type:'data',data:response()}));},close(){},listen(handler){callback=handler;return()=>{};}}));
    const stream=await adapter.open(mode,()=>{},()=>assert.fail());const request=JSON.parse(gunzipSync(Buffer.from(sent[0]!).subarray(12)).toString()).request;stream.close();
    assert.deepEqual(request,{model_name:'bigmodel',enable_itn:true,enable_ddc:true,enable_punc:true,show_utterances:true,enable_nonstream:mode==='recording'});}
});
test('CONNECTING阶段取消立即关闭socket，晚到ready不能发配置或音频帧',async()=>{
  let ready!:()=>void,sent=0,closed=0;const gate=new Promise<void>(resolve=>{ready=resolve;}),abort=new AbortController(),adapter=new ArkAgentPlanAsr(()=> 'FIXTURE_ONLY',()=>({ready:gate,logId:()=>null,send(){sent++;},close(){closed++;},listen(){return()=>{};}}));const pending=adapter.open('live',()=>assert.fail(),()=>assert.fail(),abort.signal);abort.abort();await assert.rejects(pending,{code:'HOST_INTERRUPTED'});ready();await Promise.resolve();assert.equal(sent,0);assert.equal(closed,1);
});
test('worklet跨128帧输入保持采样相位，16k/44.1k/48k一秒均恰好产生16000样本',()=>{
  const source=readFileSync(new URL('../../apps/web/public/speech-pcm-worklet.js',import.meta.url),'utf8');for(const rate of [16000,44100,48000]){let Constructor:any;const chunks:ArrayBuffer[]=[];class Processor {port={onmessage:null as any,postMessage(value:unknown){if(value instanceof ArrayBuffer)chunks.push(value);}};}
    runInNewContext(source,{AudioWorkletProcessor:Processor,sampleRate:rate,ArrayBuffer,Int16Array,Math,registerProcessor(_name:string,ctor:any){Constructor=ctor;}});const instance=new Constructor();for(let at=0;at<rate;at+=128)instance.process([[new Float32Array(Math.min(128,rate-at)).fill(0.25)]]);instance.port.onmessage({data:'stop'});assert.equal(chunks.reduce((sum,c)=>sum+c.byteLength/2,0),16000,'rate '+rate);assert.ok(chunks.every(c=>c.byteLength<=6400));}
});
test('HTTP请求幂等键独立绑定片段输入；同录音unknown在新capture/key下仍受workspace+digest fence阻断',async()=>{
  const f=fixture(),p=provider(),speech=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true});try{speech.configure(f.request(),true);const req=f.request(),session=await speech.start(req,{mode:'recording',capture_id:randomUUID()},{audio:'fixture'},'same-pcm-digest');const chunkRequest=f.request(),chunk={sequence:1,audio_base64:'AAA=',final:false};speech.chunk(chunkRequest,session.id,chunk);assert.throws(()=>speech.chunk(chunkRequest,session.id,{...chunk,sequence:2}),{code:'IDEMPOTENCY_CONFLICT'});p.fail();assert.equal(speech.get(f.request(),session.id).state,'unknown');await assert.rejects(speech.start(f.request(),{mode:'recording',capture_id:randomUUID()},{audio:'same-fixture-new-header'},'same-pcm-digest'),{code:'RESULT_UNKNOWN'});assert.equal(p.counts().opens,1);assert.equal(p.counts().sends,1);
    const reconstructed=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true});await assert.rejects(reconstructed.start(f.request(),{mode:'recording',capture_id:randomUUID()},{audio:'same-after-restart'},'same-pcm-digest'),{code:'RESULT_UNKNOWN'});assert.equal(p.counts().opens,1);reconstructed.close();
  }finally{speech.close();f.cleanup();}
});
test('正式隔离HTTP拒绝错工作区；WAV未知回执在新上传/capture/key下仍只有一次provider open',async()=>{
  const f=fixture();f.closeDb();let opens=0,sends=0;const fake:AsrProvider={async open(_mode,_event,onError){opens++;return {requestId:randomUUID(),logId:()=>null,send(){sends++;onError();},close(){}};}};
  const app=await startApplication(f.config,{port:0,moduleFactories:[context=>createSpeechInputModule(context,{provider:fake,credentialPresent:()=>true})],executorHealth:async()=>[]}),base='http://127.0.0.1:'+app.address.port;
  const request=(path:string,body:unknown,workspace=app.identity.workspace_id)=>fetch(base+path,{method:path.includes('/settings/')?'PUT':'POST',headers:{'Content-Type':'application/json','X-Workspace-Id':workspace,'X-Service-Instance-Id':app.identity.service_instance_id,'Idempotency-Key':randomUUID()},body:JSON.stringify(body)});
  try{assert.equal((await request('/api/v1/settings/speech-input',{enabled:true},'wrong-workspace')).status,409);assert.equal((await request('/api/v1/settings/speech-input',{enabled:true})).status,200);
    const wav=Buffer.alloc(44+12800);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(12800,40);const body={format:'wav',audio_base64:wav.toString('base64')};const first=await request('/api/v1/speech-recordings',{...body,capture_id:randomUUID()});assert.equal(first.status,202);const id=(await first.json()).id;
    const stored=await fetch(base+'/api/v1/speech-inputs/'+id,{headers:{'X-Workspace-Id':app.identity.workspace_id,'X-Service-Instance-Id':app.identity.service_instance_id}});assert.equal((await stored.json()).state,'unknown');const second=await request('/api/v1/speech-recordings',{...body,capture_id:randomUUID()});assert.equal(second.status,409);assert.equal((await second.json()).error.code,'RESULT_UNKNOWN');assert.equal(opens,1);assert.equal(sends,1);
  }finally{await app.close();f.cleanup();}
});
test('候选和人工采用分开；分片幂等与重建不会再次付费，保留原文出处且不改核心稿',async()=>{
  const f=fixture(),p=provider(),speech=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true});try{const topic=await new Topics(f.context()).create(f.request(),{title:'已有人工主题',category:'个人思考',audience:'本人',source_ids:[]});await new Documents(f.context()).save(f.request(),topic.core_document_id,{expected_revision_id:topic.core.head_revision_id,text:'已有人工核心稿，不能被语音候选覆盖。',origin:'human'});speech.configure(f.request(),true);const req=f.request(),session=await speech.start(req,{mode:'live'});assert.equal(session.state,'recording');assert.equal((await speech.start(req,{mode:'live'})).id,session.id);assert.equal(p.counts().opens,1);
    const chunk={sequence:1,audio_base64:Buffer.alloc(6400).toString('base64'),final:false};speech.chunk(f.request(),session.id,chunk);speech.chunk(f.request(),session.id,chunk);assert.equal(p.counts().sends,1);assert.throws(()=>speech.chunk(f.request(),session.id,{...chunk,final:true}),{code:'IDEMPOTENCY_CONFLICT'});p.emit('临时字');assert.equal(speech.get(f.request(),session.id).partial_text,'临时字');assert.throws(()=>speech.adopt(f.request(),session.id,{title:'title',text:'临时字'}),{code:'CAPABILITY_UNVERIFIED'});assert.equal(f.context().db.prepare('SELECT count(*) n FROM source_records').get()!.n,0);
    speech.chunk(f.request(),session.id,{sequence:2,audio_base64:'',final:true});await Promise.resolve();const result=speech.get(f.request(),session.id);assert.equal(result.state,'final');assert.equal(result.duration_ms,200);assert.equal(result.estimated_afp,0.025);
    const core=f.context().db.prepare('SELECT * FROM documents').all(),input={title:'人工核对素材',text:'人工编辑后的文字',topic_id:topic.id},adopted=speech.adopt(f.request(),session.id,input);assert.ok(adopted.source_record_id);assert.equal(speech.adopt(f.request(),session.id,input).source_record_id,adopted.source_record_id);assert.deepEqual(f.context().db.prepare('SELECT * FROM documents').all(),core);assert.equal(f.context().db.prepare('SELECT count(*) n FROM core_approvals').get()!.n,0);assert.equal(f.context().db.prepare('SELECT source_record_id FROM topic_sources WHERE topic_id=?').get(topic.id)!.source_record_id,adopted.source_record_id);
    const receipt=f.context().db.prepare('SELECT value FROM application_metadata WHERE key LIKE ?').get('speech-input.v1:%:source:'+adopted.source_record_id)!;assert.match(String(receipt.value),/内部协议测试文字/);assert.match(String(receipt.value),/人工编辑后的文字/);assert.match(String(receipt.value),/fixture-log-id/);assert.ok(!String(receipt.value).includes('PRIVATE_'));
  }finally{speech.close();f.cleanup();}
});
test('连接建立中取消有稳定capture_id；晚到ACK关闭旧socket，不发送录音',async()=>{
  const f=fixture();let release!:()=>void,closed=0,sent=0,opens=0;const gate=new Promise<void>(resolve=>{release=resolve;}),fake:AsrProvider={async open(){opens++;await gate;return {requestId:randomUUID(),logId:()=>null,send(){sent++;},close(){closed++;}};}},speech=new SpeechInputs(f.context(),{provider:fake,credentialPresent:()=>true});try{speech.configure(f.request(),true);const req=f.request(),id=randomUUID(),input={mode:'live' as const,capture_id:id},pending=speech.start(req,input);assert.equal((await speech.start(req,input)).state,'starting');speech.cancel(f.request(),id);release();assert.equal((await pending).state,'cancelled');assert.equal(closed,1);assert.equal(opens,1);assert.equal(sent,0);assert.equal((await speech.start(req,input)).state,'cancelled');}finally{speech.close();f.cleanup();}
});
test('发送回执未知、断线、重建和取消不自动重连或重发；旧回调不能恢复候选',async()=>{
  const f=fixture(),p=provider(),speech=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true});try{speech.configure(f.request(),true);const req=f.request(),session=await speech.start(req,{mode:'live'});p.emit('已有文字');p.unknown();speech.chunk(f.request(),session.id,{sequence:1,audio_base64:'AAA=',final:false});assert.equal(speech.get(f.request(),session.id).state,'unknown');p.emit('晚到完整结果',true);assert.equal(speech.get(f.request(),session.id).final_text,null);assert.equal((await speech.start(req,{mode:'live'})).state,'unknown');assert.equal(p.counts().opens,1);assert.equal(p.counts().sends,1);assert.ok(!JSON.stringify(speech.get(f.request(),session.id)).includes('PRIVATE_UPSTREAM_SENTINEL'));
    const cancelled=await speech.start(f.request(),{mode:'live'});speech.cancel(f.request(),cancelled.id);p.emit('取消后结果',true);assert.equal(speech.get(f.request(),cancelled.id).state,'cancelled');assert.throws(()=>speech.chunk(f.request(),cancelled.id,{sequence:1,audio_base64:'AAA=',final:false}),{code:'RESULT_UNKNOWN'});
    const interrupted=await speech.start(f.request(),{mode:'live'});const recovered=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true});assert.equal(recovered.get(f.request(),interrupted.id).state,'unknown');assert.equal(p.counts().opens,3);recovered.close();
  }finally{speech.close();f.cleanup();}
});
test('WAV真实采样与大小/时长校验在上游前；schema不允许外部音频URL',()=>{
  const pcm=Buffer.alloc(6400),wav=Buffer.alloc(44+pcm.length);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);assert.deepEqual(wavPcm(wav),pcm);wav.writeUInt32LE(48000,24);assert.throws(()=>wavPcm(wav),{code:'VALIDATION_ERROR'});assert.throws(()=>wavPcm(Buffer.from('audio pretending to be wav')));
  assert.throws(()=>TranscribeRecordingSchema.parse({format:'wav',audio_base64:'A'.repeat(60),url:'http://127.0.0.1/private'}));assert.throws(()=>SpeechInputChunkSchema.parse({sequence:1,audio_base64:'A'.repeat(8537),final:false}));
});
function wavOf(seconds:number){const pcm=Buffer.alloc(seconds*32000),wav=Buffer.alloc(44+pcm.length);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);return wav;}
test('时长上限10分钟：派生上限一致，9分59秒WAV与实时分片通过，10分01秒拒绝且文案含10分钟',async()=>{
  assert.equal(SPEECH_INPUT_LIMITS.max_seconds,600);assert.equal(SPEECH_INPUT_LIMITS.max_bytes,19_200_000);assert.deepEqual({...SPEECH_INPUT_DERIVED_LIMITS},{max_minutes:10,max_duration_ms:600_000,max_estimated_afp:75,max_sequence:3001,chunk_base64:8536,max_wav_bytes:19_265_536,max_wav_base64:25_687_384});
  assert.equal(wavPcm(wavOf(599)).length,599*32000);assert.throws(()=>wavPcm(wavOf(601)),(error:Error&{code?:string})=>error.code==='VALIDATION_ERROR'&&error.message.includes('10 分钟'));
  assert.doesNotThrow(()=>SpeechInputChunkSchema.parse({sequence:3001,audio_base64:'',final:true}));assert.throws(()=>SpeechInputChunkSchema.parse({sequence:3002,audio_base64:'',final:true}));
  const openapi=JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json',import.meta.url),'utf8')).components.schemas.SpeechInputSnapshot.properties;assert.equal(openapi.duration_ms.maximum,600_000);assert.equal(openapi.estimated_afp.maximum,75);assert.equal(openapi.accepted_sequence.maximum,3001);
  const f=fixture(),fake:AsrProvider={async open(){return {requestId:randomUUID(),logId:()=>null,send(){},close(){}};}},speech=new SpeechInputs(f.context(),{provider:fake,credentialPresent:()=>true});
  try{speech.configure(f.request(),true);const session=await speech.start(f.request(),{mode:'live'}),audio=Buffer.alloc(SPEECH_INPUT_LIMITS.chunk_bytes).toString('base64'),total=599*32000/SPEECH_INPUT_LIMITS.chunk_bytes;let last=session;
    for(let sequence=1;sequence<=total;sequence+=10){const chunks=Array.from({length:Math.min(10,total-sequence+1)},(_,index)=>({sequence:sequence+index,audio_base64:audio,final:false}));last=speech.batch(f.request(),session.id,{chunks});}
    assert.equal(last.state,'recording');assert.equal(last.duration_ms,599_000);assert.equal(last.estimated_afp,599_000/3_600_000*450);assert.equal(last.accepted_sequence,total);
    const over=Array.from({length:Math.ceil(2000*32/SPEECH_INPUT_LIMITS.chunk_bytes)},(_,index)=>({sequence:total+1+index,audio_base64:audio,final:false}));assert.throws(()=>speech.batch(f.request(),session.id,{chunks:over}),{code:'VALIDATION_ERROR'});assert.equal(speech.get(f.request(),session.id).duration_ms,599_000);
  }finally{speech.close();f.cleanup();}
});
test('10分钟WAV的JSON只在录音转写路由放宽请求体上限；同体积发到其他路由仍按8MB拒绝',async()=>{
  const f=fixture();f.closeDb();let opens=0;const fake:AsrProvider={async open(_mode,_event,onError){opens++;return {requestId:randomUUID(),logId:()=>null,send(){onError();},close(){}};}};
  const app=await startApplication(f.config,{port:0,moduleFactories:[context=>createSpeechInputModule(context,{provider:fake,credentialPresent:()=>true})],executorHealth:async()=>[]}),base='http://127.0.0.1:'+app.address.port;
  const request=(path:string,body:string)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Workspace-Id':app.identity.workspace_id,'X-Service-Instance-Id':app.identity.service_instance_id,'Idempotency-Key':randomUUID()},body});
  try{assert.equal((await fetch(base+'/api/v1/settings/speech-input',{method:'PUT',headers:{'Content-Type':'application/json','X-Workspace-Id':app.identity.workspace_id,'X-Service-Instance-Id':app.identity.service_instance_id,'Idempotency-Key':randomUUID()},body:JSON.stringify({enabled:true})})).status,200);
    const body=JSON.stringify({audio_base64:wavOf(600).toString('base64'),format:'wav',capture_id:randomUUID()});assert.ok(body.length>8*1024*1024);assert.ok(body.length<=SPEECH_INPUT_DERIVED_LIMITS.max_wav_base64+4096);
    const accepted=await request('/api/v1/speech-recordings',body);assert.equal(accepted.status,202);assert.equal(opens,1);
    const rejected=await request('/api/v1/speech-inputs',body);assert.equal(rejected.status,400);const error=(await rejected.json()).error;assert.equal(error.code,'VALIDATION_ERROR');assert.match(error.message,/JSON 请求超过大小限制/);assert.equal(opens,1);
  }finally{await app.close();f.cleanup();}
});
test('本机填写页kind明确专属Key；0600、工作区隔离、跨站拒绝、响应不泄密；MCP映射正式schema',async()=>{
  const f=fixture(),setup=await startCollectionSetup(f.config.paths.state_root,0);try{const html=await(await fetch(setup.url+'/?kind=ark_agent_plan')).text(),csrf=html.match(/'X-Setup-CSRF':"([a-f0-9]+)"/)![1]!;assert.match(html,/Agent Plan 专属 API Key/);assert.match(html,/不接收旧版语音 App ID/);const post=(origin:string)=>fetch(setup.url+'/credential?kind=ark_agent_plan',{method:'POST',headers:{Origin:origin,'X-Setup-CSRF':csrf,'Content-Type':'application/json'},body:JSON.stringify({key:'PRIVATE_ARK_KEY'})});assert.equal((await post('https://untrusted.invalid')).status,403);assert.equal((await post(setup.url)).status,200);assert.equal(readLocalCredential(f.config.paths.state_root,'ark_agent_plan',undefined,f.config.workspace_id),'PRIVATE_ARK_KEY');assert.equal(readLocalCredential(f.config.paths.state_root,'ark_agent_plan',undefined,'other-workspace'),null);assert.equal(lstatSync(localCredentialPath(f.config.paths.state_root,'ark_agent_plan')).mode&0o777,0o600);assert.ok(!(await(await fetch(setup.url+'/?kind=ark_agent_plan')).text()).includes('PRIVATE_ARK_KEY'));
    const mapped=resolveWorkbenchRoute('POST','/api/v1/speech-inputs',{mode:'live'},{idempotencyKey:randomUUID()});assert.equal(mapped.name,'start_speech_input');assert.throws(()=>resolveWorkbenchRoute('POST','/api/v1/speech-inputs',{mode:'live',key:'PRIVATE_ARK_KEY'},{idempotencyKey:randomUUID()}));
  }finally{await setup.close();f.cleanup();}
});

test('批次先校验完整输入；中途provider unknown仅发送已收片段，原请求重放不重连或重复上游',async()=>{
  const f=fixture();let opens=0,sends=0,closed=0;const delivered:number[]=[];
  const fake:AsrProvider={async open(_mode,event,onError){opens++;return {requestId:randomUUID(),logId:()=>null,send(bytes){sends++;delivered.push(bytes[0]!);event({text:'已保留的片段文字',final:false,log_id:null});if(sends===3)onError();},close(){closed++;}};}},speech=new SpeechInputs(f.context(),{provider:fake,credentialPresent:()=>true});
  try{
    speech.configure(f.request(),true);const session=await speech.start(f.request(),{mode:'live'}),request=f.request(),chunks=Array.from({length:6},(_,index)=>({sequence:index+1,audio_base64:Buffer.alloc(6400,index+1).toString('base64'),final:false}));
    assert.throws(()=>speech.batch(f.request(),session.id,{chunks:[chunks[0]!,{...chunks[1]!,sequence:99}]}),{code:'VALIDATION_ERROR'});assert.equal(sends,0);
    const result=speech.batch(request,session.id,{chunks});assert.equal(result.state,'unknown');assert.equal(result.accepted_sequence,3);assert.equal(result.duration_ms,600);assert.equal(result.partial_text,'已保留的片段文字');assert.deepEqual(delivered,[1,2,3]);
    assert.equal(speech.batch(request,session.id,{chunks}).state,'unknown');assert.equal(sends,3);assert.equal(opens,1);assert.equal(closed,1);
    assert.throws(()=>speech.batch(request,session.id,{chunks:chunks.slice(0,3)}),{code:'IDEMPOTENCY_CONFLICT'});assert.throws(()=>speech.batch(f.request(),session.id,{chunks:[{...chunks[0]!,audio_base64:'AAA='}]}),{code:'IDEMPOTENCY_CONFLICT'});assert.equal(sends,3);
    assert.throws(()=>SpeechInputBatchSchema.parse({chunks:Array(11).fill(chunks[0])}));assert.throws(()=>SpeechInputBatchSchema.parse({chunks:[{...chunks[0]!,final:true},chunks[1]!]}));
  }finally{speech.close();f.cleanup();}
});

test('取消持久化安全client原因，旧空body仍兼容，晚到取消不覆盖先前诊断',async()=>{
  const f=fixture(),p=provider(),speech=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true});
  try{speech.configure(f.request(),true);const first=await speech.start(f.request(),{mode:'live'});p.emit('保留的文字');const input={reason:'state_unavailable' as const,transport_code:'STORAGE_UNAVAILABLE',http_status:503},cancelled=speech.cancel(f.request(),first.id,input);assert.deepEqual(cancelled.cancellation,input);assert.match(cancelled.error!,/持续不可读/);assert.equal(cancelled.partial_text,'保留的文字');assert.deepEqual(speech.cancel(f.request(),first.id,{reason:'closed'}).cancellation,input);
    const second=await speech.start(f.request(),{mode:'live'});assert.equal(speech.cancel(f.request(),second.id).error,null);assert.throws(()=>CancelSpeechInputSchema.parse({reason:'user',transport_code:'PRIVATE API key'}));
  }finally{speech.close();f.cleanup();}
});

test('正式隔离HTTP批次丢ACK加暂时503后同key回读/重放：每原chunk上游只一次，宿主映射与OpenAPI一致',async()=>{
  const f=fixture(),p=provider();f.closeDb();const app=await startApplication(f.config,{port:0,moduleFactories:[context=>createSpeechInputModule(context,{provider:p.fake,credentialPresent:()=>true})],executorHealth:async()=>[]}),base='http://127.0.0.1:'+app.address.port,posts:{key:string;body:string}[]=[];let lost=false,readFailed=false;
  const fetcher:typeof fetch=async(input,init)=>{const path=new URL(String(input)).pathname;if(path.endsWith('/chunk-batches')){posts.push({key:(init?.headers as Record<string,string>)['Idempotency-Key']!,body:String(init?.body)});const response=await fetch(input,init);if(!lost){lost=true;await response.arrayBuffer();throw new TypeError('fixture dropped ACK after durable provider send');}return response;}
    if(lost&&!readFailed&&init?.method==='GET'&&path.includes('/speech-inputs/')){readFailed=true;return new Response(JSON.stringify({error:{code:'STORAGE_UNAVAILABLE',message:'fixture temporary503',retryable:true,details:{},request_id:'fixture'}}),{status:503});}return fetch(input,init);};
  const client=createHttpClient(base,app.identity,fetcher),abort=new AbortController(),controller=new SpeechInputController({root:{querySelector:()=>null} as unknown as HTMLElement,client,signal:abort.signal,context:()=>({}) as FeatureContext,render:()=>{},toast:()=>{}}),internal=controller as any;
  try{await client.request('PUT','/api/v1/settings/speech-input',{enabled:true},{idempotencyKey:randomUUID()});const session=await client.request('POST','/api/v1/speech-inputs',{mode:'live'},{idempotencyKey:randomUUID()});internal.accept(session);internal.enqueue(new Uint8Array(6400));internal.enqueue(new Uint8Array(6400));internal.enqueue(new Uint8Array(6400));internal.enqueue(new Uint8Array(),true);await internal.queue;internal.poll();await new Promise(resolve=>setTimeout(resolve,600));assert.equal(posts.length,3);assert.deepEqual(posts[1],posts[0]);assert.equal(p.counts().opens,1);assert.equal(p.counts().sends,4);assert.equal(internal.session.state,'final');assert.equal(internal.session.duration_ms,600);assert.equal(internal.session.accepted_sequence,4);
    const mapped=resolveWorkbenchRoute('POST','/api/v1/speech-inputs/'+internal.session.id+'/chunk-batches',{chunks:[{sequence:1,audio_base64:'AAA=',final:false}]},{idempotencyKey:randomUUID()});assert.equal(mapped.name,'send_speech_input_batch');const api=JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json',import.meta.url),'utf8'));assert.equal(api.paths['/api/v1/speech-inputs/{id}/chunk-batches'].post.requestBody.content['application/json'].schema.$ref,'#/components/schemas/SpeechInputBatchRequest');assert.deepEqual(api.components.schemas.SpeechInputBatchRequest,SpeechInputBatchSchema.jsonSchema);assert.deepEqual(api.components.schemas.CancelSpeechInputRequest,CancelSpeechInputSchema.jsonSchema);
  }finally{controller.dispose();await new Promise(resolve=>setImmediate(resolve));await app.close();f.cleanup();}
});
// Speech cleanup (phase 2): one executor job per final transcript, length guard in the worker, both versions kept on adoption.
class CleanupAdapter { text='内部协议的测试文字';starts=0;
  async describe(){return [];} async checkReadiness():Promise<AgentReadiness>{return {executor_id:'codex',runtime_version:'internal_rule',auth_state:'fixture',billing_route:null,capabilities:[],limitations:['internal_rule only']};}
  async start(input:AgentRunInput):Promise<AgentRunHandle>{this.starts++;return {runtime_session_id:randomUUID(),runtime_turn_id:randomUUID(),supports_resume:true,checkpoint:{run_input:input as unknown as JsonObject,input_hash:hash(canonical(input.input_manifest))}};}
  async resume(handle:AgentRunHandle){return this.start(handle.checkpoint.run_input as unknown as AgentRunInput);}
  async *streamEvents(handle:AgentRunHandle):AsyncIterable<AgentResult>{const input=handle.checkpoint.run_input as unknown as AgentRunInput,frozen=input.input_manifest.frozen as JsonObject,output={documents:(frozen.targets as JsonObject[]).map(target=>({document_id:target.document_id,text:this.text})),recommendations:[]};yield {status:'completed',candidate_documents:output.documents as JsonObject[],evidence_links:[],asset_candidates:[],actual_usage:{},resume_info:{output:output as JsonObject,output_sha256:hash(canonical(output)),native_status:'completed'}} as unknown as AgentResult;}
  async requestInput(){} async cancel(){return {native_interrupt:'internal_rule'};} async close(){}
}
async function finalSpeech(speech:SpeechInputs,f:ReturnType<typeof fixture>){const session=await speech.start(f.request(),{mode:'live'});speech.chunk(f.request(),session.id,{sequence:1,audio_base64:'',final:true});await Promise.resolve();return speech.get(f.request(),session.id);}
const cleanupWorker=(f:ReturnType<typeof fixture>,adapter:CleanupAdapter)=>new DurableWorker(f.context(),createContentAgentHandlers(f.context(),{staging_root:realpathSync(join(f.config.paths.state_root,'generation-staging')),createAdapter:()=>adapter as never}));
test('转写final后自动入队一次整理任务：默认执行器、固定skill与原文、禁用API回退；重复读取与重放不重复入队',async()=>{
  const f=fixture(),p=provider(),speech=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true});
  try{speech.configure(f.request(),true);const result=await finalSpeech(speech,f);assert.equal(result.state,'final');assert.equal(result.cleanup_state,'queued');assert.equal(result.cleaned_text,null);
    const jobs=()=>f.context().db.prepare("SELECT * FROM jobs WHERE kind='speech_cleanup'").all();assert.equal(jobs().length,1);const job=jobs()[0]!,manifest=JSON.parse(String(job.input_manifest));
    assert.equal(job.executor_id,'codex');assert.equal(job.execution_mode,'service_adapter');assert.equal(manifest.content_purpose,'speech_cleanup');assert.equal(manifest.speech_cleanup.raw_text,'内部协议测试文字');assert.equal(manifest.speech_cleanup.speech_input_id,result.id);assert.equal(manifest.service_agent.api_fallback.enabled,false);
    const skill=readFileSync(new URL('../../packages/domain/src/speech-input/skills/speech-cleanup/SKILL.md',import.meta.url),'utf8');assert.equal(manifest.speech_cleanup.skill.sha256,createHash('sha256').update(skill).digest('hex'));assert.ok(manifest.service_agent.task_instruction.includes(skill));assert.equal(f.context().db.prepare('SELECT kind FROM documents WHERE id=?').get(manifest.targets[0].document_id)!.kind,'speech_cleanup');
    for(let i=0;i<3;i++){speech.get(f.request(),result.id);(speech as unknown as {enqueueCleanup(id:string):void}).enqueueCleanup(result.id);}assert.equal(jobs().length,1);
    f.context().db.exec("UPDATE workspaces SET default_executor='claude'");const second=await finalSpeech(speech,f);assert.equal(second.cleanup_state,'queued');assert.equal(jobs().length,2);assert.equal(f.context().db.prepare("SELECT executor_id FROM jobs WHERE kind='speech_cleanup' AND json_extract(input_manifest,'$.speech_cleanup.speech_input_id')=?").get(second.id)!.executor_id,'claude');
  }finally{speech.close();f.cleanup();}
});
test('整理稿长度护栏：偏离原文超过40%在worker判失败并记原因，原文仍可采用；整理稿不可冒用',async()=>{
  assert.equal(cleanupDeviation('一二三四五六七八九十','一二三四五六'),0.4);assert.ok(cleanupDeviation('一二三四五六七八九十','一二三四五')>0.4);assert.equal(cleanupDeviation('一二 三\n四','一二三四'),0);
  const f=fixture(),p=provider(),speech=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true}),adapter=new CleanupAdapter();
  try{speech.configure(f.request(),true);const result=await finalSpeech(speech,f);adapter.text='测试';assert.equal((await cleanupWorker(f,adapter).runOnce())!.state,'failed');
    const job=f.context().db.prepare("SELECT id,state FROM jobs WHERE kind='speech_cleanup'").get()!,error=JSON.parse(String(f.context().db.prepare('SELECT error FROM job_attempts WHERE job_id=?').get(job.id)!.error));assert.equal(error.code,'VALIDATION_ERROR');assert.equal(error.details.reason,'length_guard');assert.equal(error.details.raw_chars,8);assert.equal(error.details.cleaned_chars,2);
    const view=speech.get(f.request(),result.id);assert.equal(view.cleanup_state,'failed');assert.equal(view.cleaned_text,null);assert.match(view.cleanup_error!,/长度相差过大/);assert.equal(f.context().db.prepare('SELECT count(*) n FROM candidates').get()!.n,0);
    assert.throws(()=>speech.adopt(f.request(),result.id,{title:'t',text:'测试',adopted_from:'cleaned'}),{code:'CAPABILITY_UNVERIFIED'});
    const adopted=speech.adopt(f.request(),result.id,{title:'t',text:'内部协议测试文字'});assert.ok(adopted.source_record_id);const meta=JSON.parse(String(f.context().db.prepare('SELECT value FROM application_metadata WHERE key LIKE ?').get('speech-input.v1:%:source:'+adopted.source_record_id)!.value));assert.equal(meta.adopted_from,'raw');assert.equal(meta.cleaned_text,null);assert.equal(meta.raw_text,'内部协议测试文字');
  }finally{speech.close();f.cleanup();}
});
test('整理完成：running→succeeded投影整理稿；采用记录选用版本，原文与整理稿两版都存',async()=>{
  const f=fixture(),p=provider(),speech=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true}),adapter=new CleanupAdapter();
  try{speech.configure(f.request(),true);const result=await finalSpeech(speech,f);let running='';const original=adapter.streamEvents.bind(adapter);adapter.streamEvents=async function*(handle){running=speech.get(f.request(),result.id).cleanup_state??'';yield* original(handle);};
    assert.equal((await cleanupWorker(f,adapter).runOnce())!.state,'committed');assert.equal(running,'running');assert.equal(adapter.starts,1);
    const view=speech.get(f.request(),result.id);assert.equal(view.cleanup_state,'succeeded');assert.equal(view.cleaned_text,'内部协议的测试文字');assert.equal(view.final_text,'内部协议测试文字');assert.equal(view.cleanup_error,null);
    const input={title:'整理后采用',text:'内部协议的测试文字，本人又改了一句',adopted_from:'cleaned' as const},adopted=speech.adopt(f.request(),result.id,input);assert.equal(speech.adopt(f.request(),result.id,input).source_record_id,adopted.source_record_id);assert.equal(adopted.cleanup_state,'succeeded');
    const meta=JSON.parse(String(f.context().db.prepare('SELECT value FROM application_metadata WHERE key LIKE ?').get('speech-input.v1:%:source:'+adopted.source_record_id)!.value));assert.deepEqual([meta.adopted_from,meta.raw_text,meta.cleaned_text,meta.adopted_text],['cleaned','内部协议测试文字','内部协议的测试文字','内部协议的测试文字，本人又改了一句']);
    assert.equal(f.context().db.prepare("SELECT count(*) n FROM jobs WHERE kind='speech_cleanup'").get()!.n,1);
  }finally{speech.close();f.cleanup();}
});
test('素材已采用后关联当前主题：不重复创建素材或adoption，重复关联幂等，未采用时拒绝',async()=>{
  const f=fixture(),p=provider(),speech=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true});
  try{speech.configure(f.request(),true);const topic=await new Topics(f.context()).create(f.request(),{title:'后关联主题',category:'个人思考',audience:'本人',source_ids:[]}),result=await finalSpeech(speech,f);
    assert.throws(()=>speech.linkTopic(f.request(),result.id,{topic_id:topic.id}),{code:'CAPABILITY_UNVERIFIED'});
    const adopted=speech.adopt(f.request(),result.id,{title:'素材',text:'内部协议测试文字'});assert.equal(adopted.linked_topic_ids,undefined);const sources=()=>f.context().db.prepare('SELECT count(*) n FROM source_records').get()!.n,links=()=>f.context().db.prepare('SELECT source_record_id FROM topic_sources WHERE topic_id=?').all(topic.id);const before=sources();
    const linked=speech.linkTopic(f.request(),result.id,{topic_id:topic.id});assert.deepEqual(linked.linked_topic_ids,[topic.id]);assert.equal(linked.source_record_id,adopted.source_record_id);
    const again=speech.linkTopic(f.request(),result.id,{topic_id:topic.id});assert.deepEqual(again.linked_topic_ids,[topic.id]);assert.equal(sources(),before);assert.deepEqual(links().map(row=>row.source_record_id),[adopted.source_record_id]);
    assert.throws(()=>speech.linkTopic(f.request(),result.id,{topic_id:'missing-topic'}),{code:'NOT_FOUND'});assert.equal(speech.get(f.request(),result.id).source_record_id,adopted.source_record_id);
  }finally{speech.close();f.cleanup();}
});
test('整理任务已成功但整理稿读取失败：投影为失败并写用户原因，GET照常返回原文，原文采用不受阻',async()=>{
  const f=fixture(),p=provider(),speech=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true}),adapter=new CleanupAdapter();
  try{speech.configure(f.request(),true);const result=await finalSpeech(speech,f);assert.equal((await cleanupWorker(f,adapter).runOnce())!.state,'committed');
    const revision=f.context().db.prepare('SELECT r.file_path,r.sha256 FROM candidates c JOIN document_revisions r ON r.workspace_id=c.workspace_id AND r.id=c.revision_id').get()!;chmodSync(String(revision.file_path),0o600);writeFileSync(String(revision.file_path),'被外部改坏的整理稿文件');rmSync(join(f.config.paths.state_root,'backups/revisions',revision.sha256+'.md'),{force:true});
    const view=speech.get(f.request(),result.id);assert.equal(view.final_text,'内部协议测试文字');assert.equal(view.cleanup_state,'failed');assert.equal(view.cleaned_text,null);assert.equal(view.cleanup_error,'整理结果读取失败，可直接采用原文');
    const adopted=speech.adopt(f.request(),result.id,{title:'原文',text:'内部协议测试文字'});assert.ok(adopted.source_record_id);assert.throws(()=>speech.adopt(f.request(),result.id,{title:'原文',text:'x',adopted_from:'cleaned'}),{code:'IDEMPOTENCY_CONFLICT'});
  }finally{speech.close();f.cleanup();}
});
test('执行器待登录：整理投影为waiting而非失败；同一任务恢复（新代次）成功后回写整理稿',async()=>{
  const f=fixture(),p=provider(),speech=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true}),adapter=new CleanupAdapter();
  try{speech.configure(f.request(),true);const result=await finalSpeech(speech,f);const start=adapter.start.bind(adapter);let auth=true;adapter.start=async input=>{if(auth)throw new ContractError('AUTH_REQUIRED','fixture login required',{pre_submit_failure:true});return start(input);};
    assert.equal((await cleanupWorker(f,adapter).runOnce())!.state,'waiting_input');let view=speech.get(f.request(),result.id);assert.equal(view.cleanup_state,'waiting');assert.equal(view.cleanup_error,null);assert.equal(speech.get(f.request(),result.id).cleanup_state,'waiting');
    const jobs=new Jobs(f.context()),job=f.context().db.prepare("SELECT id,version FROM jobs WHERE kind='speech_cleanup'").get()!;jobs.resume(f.request(),String(job.id),{expected_version:Number(job.version)});assert.equal(speech.get(f.request(),result.id).cleanup_state,'queued');
    auth=false;assert.equal((await cleanupWorker(f,adapter).runOnce())!.state,'committed');view=speech.get(f.request(),result.id);assert.equal(view.cleanup_state,'succeeded');assert.equal(view.cleaned_text,'内部协议的测试文字');
    assert.equal(f.context().db.prepare('SELECT count(*) n FROM job_attempts WHERE job_id=?').get(job.id)!.n,2);
  }finally{speech.close();f.cleanup();}
});
test('入队异常：整理记为失败并写原因，事务回滚不留任务或文档，原文照常采用',async()=>{
  const f=fixture(),p=provider(),speech=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true}),original=ContentGeneration.prototype.enqueueInTransaction;
  ContentGeneration.prototype.enqueueInTransaction=function(){throw new Error('fixture staging unavailable');};
  try{speech.configure(f.request(),true);const result=await finalSpeech(speech,f);assert.equal(result.state,'final');assert.equal(result.final_text,'内部协议测试文字');assert.equal(result.cleanup_state,'failed');assert.equal(result.cleanup_error,'整理任务未能开始');
    assert.equal(f.context().db.prepare("SELECT count(*) n FROM jobs WHERE kind='speech_cleanup'").get()!.n,0);assert.equal(f.context().db.prepare("SELECT count(*) n FROM documents WHERE kind='speech_cleanup'").get()!.n,0);
    ContentGeneration.prototype.enqueueInTransaction=original;(speech as unknown as {enqueueCleanup(id:string):void}).enqueueCleanup(result.id);assert.equal(f.context().db.prepare("SELECT count(*) n FROM jobs WHERE kind='speech_cleanup'").get()!.n,0,'a recorded failure is not re-queued');
    assert.ok(speech.adopt(f.request(),result.id,{title:'原文',text:'内部协议测试文字'}).source_record_id);
  }finally{ContentGeneration.prototype.enqueueInTransaction=original;speech.close();f.cleanup();}
});
test('关联主题写回失败后重试幂等：关联只落一次，重试补齐记录且不新建素材',async()=>{
  const f=fixture(),p=provider(),speech=new SpeechInputs(f.context(),{provider:p.fake,credentialPresent:()=>true});
  try{speech.configure(f.request(),true);const topic=await new Topics(f.context()).create(f.request(),{title:'重试关联主题',category:'个人思考',audience:'本人',source_ids:[]}),result=await finalSpeech(speech,f),adopted=speech.adopt(f.request(),result.id,{title:'素材',text:'内部协议测试文字'});
    const internal=speech as unknown as {save(receipt:unknown):void},save=internal.save.bind(speech);let fail=true;internal.save=receipt=>{if(fail){fail=false;throw new Error('fixture receipt write failed');}save(receipt);};
    const links=()=>f.context().db.prepare('SELECT source_record_id FROM topic_sources WHERE topic_id=?').all(topic.id).map(row=>row.source_record_id),sources=f.context().db.prepare('SELECT count(*) n FROM source_records').get()!.n;
    assert.throws(()=>speech.linkTopic(f.request(),result.id,{topic_id:topic.id}),/fixture receipt write failed/);assert.deepEqual(links(),[adopted.source_record_id]);assert.equal(speech.get(f.request(),result.id).linked_topic_ids,undefined);
    const retried=speech.linkTopic(f.request(),result.id,{topic_id:topic.id});assert.deepEqual(retried.linked_topic_ids,[topic.id]);assert.deepEqual(speech.linkTopic(f.request(),result.id,{topic_id:topic.id}).linked_topic_ids,[topic.id]);
    assert.deepEqual(links(),[adopted.source_record_id]);assert.equal(f.context().db.prepare('SELECT count(*) n FROM source_records').get()!.n,sources);
  }finally{speech.close();f.cleanup();}
});
