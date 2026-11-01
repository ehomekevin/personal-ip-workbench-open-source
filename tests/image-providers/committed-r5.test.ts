import test from '../helpers/media-tools.ts'; // 依赖真实图像解码；缺 ffmpeg/ffprobe 时跳过
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fixture,seeded,FakeImageProvider} from './harness.ts';
import {createImageProvider} from '../../packages/adapters/src/media/image/index.ts';
import {ImageGenerationWorkflow,imageReceiptPath,readImageReceipt,compactImageNative,publicImageNative} from '../../packages/domain/src/artifact-execution/image.ts';
import {verifyImageAsset,verifyCommittedImageAsset} from '../../packages/domain/src/result-commit/image.ts';
import {ResultCommit} from '../../packages/domain/src/result-commit/index.ts';
import {Jobs} from '../../packages/domain/src/jobs/index.ts';
import {getJob,getAttempt} from '../../packages/storage/src/jobs/index.ts';
import {writeSolidPng} from '../helpers/png.ts';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const variants=['control','pre_r5_control','tool','child','payload','child_ids','multi_file','usage','proof_missing','proof_null','proof_schema','proof_native_digest','proof_result_digest','proof_origin','proof_verifier','proof_lease','proof_missing_fields','origin_binding_missing','policy_false','result_removed','state_downgrade'] as const;
for(const variant of variants)test('IP10 committed image never downgrades an invalid modern proof: '+variant,async()=>{
  const f=fixture();try{
    const {input}=await seeded(f),native=join(f.root,'own-native'),png=join(f.root,'own-native.png'),trace=join(f.root,'own-native.jsonl');mkdirSync(native);
    writeSolidPng(png,32,32);
    const provider=createImageProvider('agy',{executable:resolve('tests/image-providers/adapters-fixture.mjs'),state_root:native,timeout_ms:3000,env:{...process.env,IMAGE_FIXTURE_MODE:'success',IMAGE_FIXTURE_PNG:png,IMAGE_FIXTURE_STATE:native,IMAGE_FIXTURE_TRACE:trace}}),workflow=new ImageGenerationWorkflow(f.context,{provider:()=>provider}),q=workflow.enqueue(f.request(),input),jobs=new Jobs(f.context),claim=jobs.claim('r5-committed-proof')!;
    const out=await workflow.execute(claim,new AbortController().signal,v=>jobs.checkpoint(claim.fence,v));
    assert.equal(new ResultCommit(f.context).submit(f.request(),q.job_id,{attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,expected_version:getJob(f.context.db,f.config.workspace_id,q.job_id).version,input_hash:claim.job.input_hash,typed_output:{documents:[],recommendations:[],generated_assets:[out]}},claim.fence.lease_owner).state,'committed');
    const job=getJob(f.context.db,f.config.workspace_id,q.job_id),attempt=getAttempt(f.context.db,f.config.workspace_id,claim.attempt.id),path=imageReceiptPath(f.context,q.job_id),record=readImageReceipt(f.context,q.job_id,q.input_hash),m=JSON.parse(readFileSync(out.manifest_path,'utf8')),cp=JSON.parse(attempt.checkpoint);
    assert(verifyImageAsset(f.context,job,attempt,out));assert(verifyCommittedImageAsset(f.context,job,attempt,out));const beforeCalls=readFileSync(trace,'utf8');
    // Existing r4 proofs have no r5 policy flag and must still follow the strict proof path.
    if(variant==='pre_r5_control'){delete cp.image_terminal_proof_required;f.context.db.prepare('UPDATE job_attempts SET checkpoint=? WHERE id=?').run(JSON.stringify(cp),attempt.id);}
    if(['tool','child','payload','child_ids','multi_file','usage'].includes(variant)){
      if(variant==='tool'||variant==='multi_file')record.result!.native.tool_call_id='call_999999';
      if(variant==='child'||variant==='multi_file')record.result!.native.image_child_id=randomUUID();
      if(variant==='payload'||variant==='multi_file')record.result!.native.native_payload_sha256='f'.repeat(64);
      if(variant==='child_ids'||variant==='multi_file')record.result!.native.child_ids=[randomUUID()];
      if(variant==='multi_file')record.checkpoint=structuredClone(record.result!.native);
      if(variant==='usage')record.result!.usage={fake_usage:999};
      writeFileSync(path,JSON.stringify(record));m.native=compactImageNative(record.result!.native);m.metadata.native=publicImageNative(m.native);m.metadata.actual_usage=record.result!.usage;chmodSync(out.manifest_path,0o600);writeFileSync(out.manifest_path,JSON.stringify(m));out.sha256=sha(readFileSync(out.manifest_path));
    }else if(variant==='result_removed'||variant==='state_downgrade'){ record.result=null;if(variant==='state_downgrade'){record.state='intent';record.checkpoint={};}writeFileSync(path,JSON.stringify(record));
    }else if(variant!=='control'&&variant!=='pre_r5_control'){
      const proof=cp.image_terminal_proof;
      if(variant==='proof_missing')delete cp.image_terminal_proof;
      if(variant==='proof_null')cp.image_terminal_proof=null;
      if(variant==='proof_schema')proof.schema_version='invalid';
      if(variant==='proof_native_digest')proof.native_sha256='f'.repeat(64);
      if(variant==='proof_result_digest')proof.result_sha256='f'.repeat(64);
      if(variant==='proof_origin')proof.original_binding.attempt_id=randomUUID();
      if(variant==='proof_verifier')proof.verifier_binding.attempt_generation+=10;
      if(variant==='proof_lease')proof.verifier_lease_owner='wrong-owner';
      if(variant==='proof_missing_fields')delete proof.native_sha256;
      if(variant==='origin_binding_missing')delete cp.image_submit_binding;
      if(variant==='policy_false')cp.image_terminal_proof_required=false;
      f.context.db.prepare('UPDATE job_attempts SET checkpoint=? WHERE id=?').run(JSON.stringify(cp),attempt.id);
    }
    if(variant==='control'||variant==='pre_r5_control'){assert(readImageReceipt(f.context,q.job_id,q.input_hash));assert(verifyImageAsset(f.context,job,attempt,out));assert(verifyCommittedImageAsset(f.context,job,attempt,out));}
    else{assert.throws(()=>readImageReceipt(f.context,q.job_id,q.input_hash));assert.throws(()=>verifyImageAsset(f.context,job,attempt,out));assert.throws(()=>verifyCommittedImageAsset(f.context,job,attempt,out));}
    assert.equal(readFileSync(trace,'utf8'),beforeCalls);assert.equal(f.context.db.prepare("SELECT count(*) n FROM assets WHERE status='ready'").get()!.n,1);assert.equal(f.context.db.prepare("SELECT count(*) n FROM result_receipts WHERE state='committed'").get()!.n,1);
  }finally{f.cleanup();}
});

// Simulate the pre-proof shape using an isolated committed fixture and SQL-pinned original output.
test('IP10 genuine pre-proof success remains readonly, and its original SQL manifest pin rejects resealing',async()=>{
  const f=fixture();try{
    const {input}=await seeded(f),provider=new FakeImageProvider(),workflow=new ImageGenerationWorkflow(f.context,{provider:()=>provider}),q=workflow.enqueue(f.request(),input),jobs=new Jobs(f.context),claim=jobs.claim('r5-legacy-fixture')!,out=await workflow.execute(claim,new AbortController().signal,v=>jobs.checkpoint(claim.fence,v));
    assert.equal(new ResultCommit(f.context).submit(f.request(),q.job_id,{attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,expected_version:getJob(f.context.db,f.config.workspace_id,q.job_id).version,input_hash:claim.job.input_hash,typed_output:{documents:[],recommendations:[],generated_assets:[out]}},claim.fence.lease_owner).state,'committed');
    const job=getJob(f.context.db,f.config.workspace_id,q.job_id);f.context.db.prepare('UPDATE job_attempts SET checkpoint=? WHERE id=?').run(JSON.stringify({phase:'image_verified',asset_id:out.asset_id,provider:'agy'}),claim.attempt.id);
    const attempt=getAttempt(f.context.db,f.config.workspace_id,claim.attempt.id);assert(readImageReceipt(f.context,q.job_id,q.input_hash));assert(verifyImageAsset(f.context,job,attempt,out));assert(verifyCommittedImageAsset(f.context,job,attempt,out));
    const record=JSON.parse(readFileSync(imageReceiptPath(f.context,q.job_id),'utf8')),m=JSON.parse(readFileSync(out.manifest_path,'utf8'));record.result.native.tool_call_id='call_999999';writeFileSync(imageReceiptPath(f.context,q.job_id),JSON.stringify(record));m.native=compactImageNative(record.result.native);m.metadata.native=publicImageNative(m.native);chmodSync(out.manifest_path,0o600);writeFileSync(out.manifest_path,JSON.stringify(m));out.sha256=sha(readFileSync(out.manifest_path));
    assert.throws(()=>readImageReceipt(f.context,q.job_id,q.input_hash));assert.throws(()=>verifyImageAsset(f.context,job,attempt,out));assert.throws(()=>verifyCommittedImageAsset(f.context,job,attempt,out));assert.throws(()=>workflow.recover(f.request(),q.job_id,job.version),{code:'HOST_RUN_NOT_CURRENT'});assert.equal(provider.submits,1);assert.equal(provider.queries,0);
  }finally{f.cleanup();}
});
