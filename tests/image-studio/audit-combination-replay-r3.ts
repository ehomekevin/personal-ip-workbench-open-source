// Replays the original QA accounting inputs with ordinary local audit fixtures only.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {imageRpcAudit,imageAuditPath} from '../../packages/adapters/src/media/image/audit.ts';
import type {ImageProviderInput} from '../../packages/adapters/src/media/image/types.ts';
import type {StudioGenerationRequest,StudioImageVersion} from '../../packages/contracts/src/index.ts';
import {readNativeReadAudit,aggregateNativeReadAudits} from './runtime-native-audit.ts';
import {runStudioBounded,STUDIO_RUN_PLAN} from './bounded-runner.ts';
export async function replayAuditCombination(out:string){
 mkdirSync(out,{mode:0o700});mkdirSync(join(out,'synthetic-audit'));
 const fakeInput={work_directory:join(out,'synthetic-audit')} as ImageProviderInput,sink=imageRpcAudit(fakeInput,'query');
 sink({at:new Date().toISOString(),direction:'send',message:{id:1,method:'thread/read',params:{threadId:'synthetic-consumer-thread'}}});
 sink({at:new Date().toISOString(),direction:'receive',message:{id:1,result:{thread:{id:'synthetic-consumer-thread'}}}});
 const known=readNativeReadAudit(imageAuditPath(fakeInput)),missing=readNativeReadAudit(join(out,'missing-audit.ndjson')),combined=aggregateNativeReadAudits([known,missing]);
 let submits=0,completed=0,closed=false;const requests=new Map<string,{input:StudioGenerationRequest;version_id:string}>(),providerSubmits={codex:0,agy:0};
 const record=await runStudioBounded({setup:async()=>{},prepare:async(provider,kind,parent)=>({topic_id:'synthetic-topic',document_revision_id:'synthetic-revision',paragraph_id:'synthetic-paragraph',placement_paragraph_id:'synthetic-paragraph',description:'Ordinary audit accounting fixture',title:'Accounting',position:'after',provider,references:[],expected_version:1,slot_id:parent?'synthetic-slot':null,parent_version_id:parent?.id??null,operation:kind==='manual'&&provider==='agy'?'reference_edit':'generate',size_mode:kind,size:kind==='manual'?STUDIO_RUN_PLAN.manual_size:{width:1600,height:900,aspect_ratio:'16:9'},brief_id:kind==='auto'?'synthetic-brief':null}),submit:async input=>{submits++;providerSubmits[input.provider]++;const job_id='synthetic-job-'+submits,version_id=randomUUID();requests.set(job_id,{input,version_id});return{job_id,version_id,input_hash:'synthetic-hash'};},observe:async job=>{
  const request=requests.get(job)!;completed++;return{state:'succeeded',native:{fixture_only:true},version:{id:request.version_id,job_id:job,asset_id:'synthetic-asset-'+completed,actual_size:request.input.size} as StudioImageVersion};
 },capture:async()=>{},snapshot:()=>({jobs:[...requests.keys()].map(job_id=>({job_id,fixture_only:true})),native_reads:completed>=2?combined:completed?aggregateNativeReadAudits([missing]):aggregateNativeReadAudits([])}),close:async()=>{closed=true;}},{mode:'fixture',out:join(out,'bounded-fixture'),max_observations:1,operation_timeout_ms:1000,max_duration_ms:3000});
 const result={tested_requirement_version:'WECHAT-IMAGE-STUDIO-01/r3',candidate_revision:'repair-03',original_failed_candidate:'sha256:31c590c2e0c7d857431871ced8064b54ce8c2898bd5badee3c148dd84e2bf85f',scope:'Accounting fixture data only; no actual recovery read or native submission.',status:submits===2&&completed===2&&providerSubmits.agy===0&&combined.recovery_query.send_attempts===null&&combined.known_lower_bound.recovery_query.send_attempts===1&&record.native_recovery_violation&&record.state==='unknown'&&closed?'passed':'failed',known,missing,combined,fixture_submission_count:submits,fixture_provider_submissions:providerSubmits,fixture_steps_completed:completed,record,closed,real_calls:{image:0,text:0,native_query:0,fallback:0}};
 writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const flag=process.argv.indexOf('--out');if(flag<0||!process.argv[flag+1])throw new Error('New owned --out leaf required');const out=resolve(process.argv[flag+1]!);
 const root=resolve(import.meta.dirname,'../../.ci-artifacts/evidence/wechat-image-studio-01/development/r3/audit');if(dirname(out)!==root)throw new Error('Replay output must be one new r3 audit evidence leaf');
 const result=await replayAuditCombination(out);process.stdout.write(JSON.stringify({status:result.status,fixture_provider_submissions:result.fixture_provider_submissions,combined_recovery_sends:result.combined.recovery_query.send_attempts,known_recovery_lower_bound:result.combined.known_lower_bound.recovery_query.send_attempts,state:result.record.state,local_stop:result.record.local_stop,real_calls:result.real_calls})+'\n');if(result.status!=='passed')process.exitCode=1;
}
