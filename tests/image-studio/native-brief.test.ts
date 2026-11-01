import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeImageBriefPort} from '../../packages/domain/src/artifact-execution/image-studio/native-brief.ts';
import type {AgentPort} from '../../packages/domain/src/ports/index.ts';
import type {AgentResult,JsonObject} from '../../packages/contracts/src/index.ts';
import {ImageAnalysisCleanupError,ImageAnalysisLifecycle} from '../../packages/domain/src/artifact-execution/image-studio/analysis-lifecycle.ts';
function adapter(mode:'complete'|'no_result'|'hold'){let starts=0,closes=0,release!:()=>void;const held=new Promise<void>(done=>{release=done;}),handle={runtime_session_id:'fixture-native-thread',runtime_turn_id:'fixture-native-turn',supports_resume:false,checkpoint:{fixture:true}},port:AgentPort&{close():Promise<void>}={describe:async()=>[],checkReadiness:async()=>({}) as any,start:async input=>{starts++;assert.deepEqual(input.allowed_tools,[]);return handle;},async *streamEvents(){if(mode==='hold')await held;if(mode==='complete')yield{status:'completed',candidate_documents:[],evidence_links:[],asset_candidates:[],actual_usage:{tokens:17},resume_info:{output:{analysis:'fixture-output'}}} satisfies AgentResult;},requestInput:async()=>{},cancel:async()=>({}),resume:async()=>handle,close:async()=>{closes++;release();}};return{port,get starts(){return starts;},get closes(){return closes;}};}
const input={input_hash:'fixture-hash',prompt:'fixture paragraph',output_schema:{type:'object'} as JsonObject};
test('subscription brief keeps actual original native ids, usage and unknown model; closes own adapter',async()=>{const a=adapter('complete'),proof:unknown[]=[];const result=await nativeImageBriefPort(()=>a.port,(hash,native)=>proof.push({hash,native})).analyze(input,{signal:new AbortController().signal});assert.equal(a.starts,1);assert.equal(a.closes,1);assert.equal(proof.length,1);assert.equal(result.provenance.native_thread_id,'fixture-native-thread');assert.equal(result.provenance.model,null);assert.deepEqual(result.provenance.usage,{tokens:17});});
test('missing or timed-out native text result has no replacement start and promptly closes local adapter',async()=>{for(const mode of ['no_result','hold'] as const){const a=adapter(mode),abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;if(mode==='hold')timer=setTimeout(()=>abort.abort(new Error('fixture local stop')),20);try{await assert.rejects(()=>nativeImageBriefPort(()=>a.port,()=>{}).analyze(input,{signal:abort.signal}));assert.equal(a.starts,1);assert.equal(a.closes,1);}finally{if(timer)clearTimeout(timer);}}});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
test('aborted subscription brief drains its late start and confirms adapter close before settling',async()=>{
 const a=adapter('complete'),entered=deferred(),release=deferred(),closeRelease=deferred(),abort=new AbortController();let started=0,closed=0,checkpoints=0;
 const base=a.port.start.bind(a.port);a.port.start=async value=>{started++;entered.resolve();await release.promise;return base(value);};a.port.close=async()=>{closed++;await closeRelease.promise;};
 const pending=nativeImageBriefPort(()=>a.port,()=>{checkpoints++;}).analyze(input,{signal:abort.signal});let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});await entered.promise;abort.abort(new Error('own request stopped'));await new Promise<void>(done=>setImmediate(done));assert.equal(closed,1);assert.equal(settled,false);
 closeRelease.resolve();await new Promise<void>(done=>setImmediate(done));assert.equal(settled,false);release.resolve();await assert.rejects(pending);assert.equal(started,1);assert.equal(checkpoints,0);
});
test('subscription brief retains observed native identity and waits for delayed stream cleanup on cancel',async()=>{
 const a=adapter('complete'),entered=deferred(),release=deferred(),closeRelease=deferred(),abort=new AbortController();let streamClosed=0,closeCalls=0;const proof:JsonObject[]=[];
 a.port.streamEvents=async function*(){try{entered.resolve();await release.promise;}finally{streamClosed++;}};a.port.close=async()=>{closeCalls++;await closeRelease.promise;release.resolve();};
 const pending=nativeImageBriefPort(()=>a.port,(_hash,native)=>proof.push(native)).analyze(input,{signal:abort.signal});let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});await entered.promise;abort.abort(new Error('own request stopped'));await new Promise<void>(done=>setImmediate(done));assert.equal(closeCalls,1);assert.equal(streamClosed,0);assert.equal(settled,false);assert.equal(proof[0]?.native_thread_id,'fixture-native-thread');
 closeRelease.resolve();await assert.rejects(pending);assert.equal(streamClosed,1);assert.equal(a.starts,1);assert.equal(proof.length,1);
});
test('adapter cleanup failure remains unconfirmed on the owning image module',async()=>{
 const a=adapter('complete'),owner=new ImageAnalysisLifecycle();a.port.close=async()=>{throw new Error('fixture own close failed');};
 await assert.rejects(owner.run(signal=>nativeImageBriefPort(()=>a.port,()=>{}).analyze(input,{signal})),ImageAnalysisCleanupError);
 await assert.rejects(owner.close(),/cleanup is unconfirmed/);assert.equal(owner.snapshot().fully_closed,false);assert.equal(owner.snapshot().cleanup_failures,1);
});
