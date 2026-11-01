import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {replayAuditCombination} from './audit-combination-replay-r3.ts';
import {aggregateNativeReadAudits} from './runtime-native-audit.ts';
import {runStudioBounded,claimStudioRunAdmission,type StudioRunPort} from './bounded-runner.ts';
import type {StudioGenerationRequest,StudioImageVersion} from '../../packages/contracts/src/index.ts';
test('original known recovery one plus missing stops after two Codex observations and leaves AGY zero',async()=>{
 const root=mkdtempSync(join(import.meta.dirname,'.studio-audit-combination-'));try{
  const result=await replayAuditCombination(join(root,'replay'));assert.equal(result.status,'passed');assert.equal(result.combined.recovery_query.send_attempts,null);assert.equal(result.combined.known_lower_bound.recovery_query.send_attempts,1);assert.equal(result.combined.recovery_violation,true);assert.equal(result.fixture_steps_completed,2);assert.deepEqual(result.fixture_provider_submissions,{codex:2,agy:0});assert.equal(result.record.native_recovery_violation,true);assert.equal(result.record.native_reads_known_lower_bound.recovery_query.send_attempts,1);assert.equal(result.record.state,'unknown');assert.equal(result.record.local_stop,true);assert.deepEqual(result.real_calls,{image:0,text:0,native_query:0,fallback:0});
 }finally{rmSync(root,{recursive:true,force:true});}
});
function fixturePort(snapshot:()=>unknown):{port:StudioRunPort;calls:{codex:number;agy:number}}{
 const calls={codex:0,agy:0};const port:StudioRunPort={setup:async()=>{},prepare:async(provider,kind)=>({provider,size_mode:kind,operation:kind==='manual'&&provider==='agy'?'reference_edit':'generate',size:{width:768,height:1024,aspect_ratio:'3:4'}} as StudioGenerationRequest),submit:async input=>{calls[input.provider]++;return{job_id:'fixture-job-'+input.provider+'-'+calls[input.provider],version_id:'fixture-version',input_hash:'fixture-hash'};},observe:async()=>({state:'succeeded',version:{id:'fixture-version',asset_id:'fixture-asset',actual_size:{width:768,height:1024,aspect_ratio:'3:4'}} as StudioImageVersion,native:{fixture_only:true}}),capture:async()=>{},snapshot,close:async()=>{}};return{port,calls};
}
test('confirmed recovery fact stays latched when the later snapshot becomes entirely missing',async()=>{
 const out=mkdtempSync(join(import.meta.dirname,'.studio-audit-combination-'));let observations=0,delivered=false;
 const known={scope:'codex_image_rpc',audit_status:'present',audit_path:'fixture-only',completion_validation:{send_attempts:0,response_confirmations:0,response_errors:0},recovery_query:{send_attempts:1,response_confirmations:0,response_errors:0},known_lower_bound:{completion_validation:{send_attempts:0,response_confirmations:0,response_errors:0},recovery_query:{send_attempts:1,response_confirmations:0,response_errors:0}}} as const;
 const f=fixturePort(()=>{if(observations===1&&!delivered){delivered=true;return{native_reads:aggregateNativeReadAudits([known])};}return{native_reads:aggregateNativeReadAudits([])};});f.port.observe=async()=>{observations++;return{state:'succeeded',version:{id:'fixture-version',asset_id:'fixture-asset',actual_size:{width:768,height:1024,aspect_ratio:'3:4'}} as StudioImageVersion,native:{fixture_only:true}};};
 try{const record=await runStudioBounded(f.port,{out,mode:'fixture',max_observations:1});assert.deepEqual(f.calls,{codex:1,agy:0});assert.equal(record.state,'unknown');assert.equal(record.native_recovery_violation,true);assert.equal(record.native_reads_known_lower_bound.recovery_query.send_attempts,1);}finally{rmSync(out,{recursive:true,force:true});}
});
test('known completion checks plus missing recovery totals are never mislabeled as a recovery violation',async()=>{
 const out=mkdtempSync(join(import.meta.dirname,'.studio-audit-combination-'));
 const missing={scope:'codex_image_rpc',audit_status:'missing',audit_path:'fixture-only',completion_validation:{send_attempts:null,response_confirmations:null,response_errors:null},recovery_query:{send_attempts:null,response_confirmations:null,response_errors:null},known_lower_bound:{completion_validation:{send_attempts:0,response_confirmations:0,response_errors:0},recovery_query:{send_attempts:0,response_confirmations:0,response_errors:0}}} as const;
 const complete={...missing,audit_status:'present',completion_validation:{send_attempts:1,response_confirmations:1,response_errors:0},recovery_query:{send_attempts:0,response_confirmations:0,response_errors:0},known_lower_bound:{completion_validation:{send_attempts:1,response_confirmations:1,response_errors:0},recovery_query:{send_attempts:0,response_confirmations:0,response_errors:0}}} as const,summary=aggregateNativeReadAudits([complete,missing]),f=fixturePort(()=>({native_reads:summary}));
 try{const record=await runStudioBounded(f.port,{out,mode:'fixture',max_observations:1});assert.deepEqual(f.calls,{codex:2,agy:2});assert.equal(record.state,'observed');assert.equal(record.native_recovery_violation,false);assert.equal(record.native_reads.recovery_query.send_attempts,null);assert.equal(record.native_reads_known_lower_bound.completion_validation.send_attempts,1);assert.equal(record.native_reads_known_lower_bound.recovery_query.send_attempts,0);}finally{rmSync(out,{recursive:true,force:true});}
});
test('r3 admission cannot reset a prior r2 admission',()=>{
 const root=mkdtempSync(join(import.meta.dirname,'.studio-audit-combination-'));try{writeFileSync(join(root,'r2-admission.json'),'old fixture intent');assert.throws(()=>claimStudioRunAdmission(root,{fixture_only:true}),/cannot reset/);}finally{rmSync(root,{recursive:true,force:true});}
});
