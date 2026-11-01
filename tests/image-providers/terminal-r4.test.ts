import test from '../helpers/media-tools.ts'; // 依赖真实图像解码；缺 ffmpeg/ffprobe 时跳过
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fixture,seeded,FakeImageProvider} from './harness.ts';
import {ImageGenerationWorkflow,imageReceiptPath,compactImageNative,publicImageNative,readImageReceipt} from '../../packages/domain/src/artifact-execution/image.ts';
import {Jobs} from '../../packages/domain/src/jobs/index.ts';
import {ResultCommit} from '../../packages/domain/src/result-commit/index.ts';
import {getJob} from '../../packages/storage/src/jobs/index.ts';
import {createImageProvider} from '../../packages/adapters/src/media/image/index.ts';
import {writeSolidPng} from '../helpers/png.ts';
const project=resolve(import.meta.dirname,'../..');
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
for (const variant of ['control', 'tool_call_id', 'image_child_id', 'native_payload_sha256', 'child_ids', 'bad_child_array', 'all_file_reseal'] as const) {
  test('AGY production adapter/finalizer terminal native identity: ' + variant, async () => {
    const f = fixture(); try {
      const { input } = await seeded(f), nativeState = join(f.root, 'own-native-fixture'), png = join(f.root, 'own-native.png'), trace = join(f.root, 'own-native.jsonl'); mkdirSync(nativeState);
      writeSolidPng(png, 32, 32);
      const adapter = createImageProvider('agy', { executable: join(project, 'tests/image-providers/adapters-fixture.mjs'), state_root: nativeState, timeout_ms: 3000, env: { ...process.env, IMAGE_FIXTURE_MODE: 'success', IMAGE_FIXTURE_PNG: png, IMAGE_FIXTURE_STATE: nativeState, IMAGE_FIXTURE_TRACE: trace } });
      const image = new ImageGenerationWorkflow(f.context, { provider: () => adapter }), q = image.enqueue(f.request(), input), jobs = new Jobs(f.context), claim = jobs.claim('qa-terminal-identity')!, out = await image.execute(claim, new AbortController().signal, value => jobs.checkpoint(claim.fence, value));
      const path = imageReceiptPath(f.context, q.job_id), receipt = JSON.parse(readFileSync(path, 'utf8')), before = structuredClone(receipt.result.native), m = JSON.parse(readFileSync(out.manifest_path, 'utf8')), sql = JSON.parse(String(f.context.db.prepare('SELECT checkpoint FROM job_attempts WHERE id=?').get(claim.attempt.id)!.checkpoint));
      if (variant !== 'control') {
        if(variant==='all_file_reseal'){receipt.result.native.tool_call_id='call_999999';receipt.result.native.image_child_id=randomUUID();receipt.result.native.native_payload_sha256='f'.repeat(64);receipt.result.native.child_ids=[receipt.result.native.image_child_id];receipt.checkpoint=structuredClone(receipt.result.native);} else receipt.result.native[variant === 'bad_child_array' ? 'child_ids' : variant] = variant === 'child_ids' ? [randomUUID()] : variant === 'bad_child_array' ? {wrong:'array'} : variant === 'image_child_id' ? randomUUID() : variant === 'tool_call_id' ? 'call_999999' : 'f'.repeat(64);
        writeFileSync(path, JSON.stringify(receipt)); m.native = compactImageNative(receipt.result.native); m.metadata.native = publicImageNative(m.native); chmodSync(out.manifest_path, 0o600); writeFileSync(out.manifest_path, JSON.stringify(m)); out.sha256 = hash(readFileSync(out.manifest_path));
      }
      const result = new ResultCommit(f.context).submit(f.request(), q.job_id, { attempt_id: claim.attempt.id, attempt_generation: claim.attempt.attempt_generation, expected_version: getJob(f.context.db, f.config.workspace_id, q.job_id).version, input_hash: claim.job.input_hash, typed_output: { documents: [], recommendations: [], generated_assets: [out] } }, claim.fence.lease_owner);
      const calls = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)), ready = Number(f.context.db.prepare("SELECT count(*) n FROM assets WHERE status='ready'").get()!.n);
      if (variant === 'control') { assert.equal(result.state, 'committed'); assert.equal(ready, 1); } else { assert.notEqual(result.state, 'committed', 'validated terminal native identity cannot be changed by resealing only result receipt and asset manifest'); assert.equal(ready, 0); }
    } finally { f.cleanup(); }
  });
}


test('IP08 a legacy unknown without a trusted terminal proof cannot manufacture one from files',async()=>{
  const f=fixture();try{
    const {input}=await seeded(f),provider=new FakeImageProvider(),workflow=new ImageGenerationWorkflow(f.context,{provider:()=>provider}),q=workflow.enqueue(f.request(),input),jobs=new Jobs(f.context),claim=jobs.claim('r4-missing-terminal-proof')!;
    await workflow.execute(claim,new AbortController().signal,v=>jobs.checkpoint(claim.fence,v));
    jobs.fail(claim.fence,{code:'RESULT_UNKNOWN',message:'fixture old unknown result'},'reconciling');
    const row=f.context.db.prepare('SELECT checkpoint FROM job_attempts WHERE id=?').get(claim.attempt.id)!,cp=JSON.parse(String(row.checkpoint));delete cp.image_terminal_proof;f.context.db.prepare('UPDATE job_attempts SET checkpoint=? WHERE id=?').run(JSON.stringify(cp),claim.attempt.id);
    const before=f.context.db.prepare('SELECT count(*) n FROM job_attempts').get()!.n;
    assert.throws(()=>readImageReceipt(f.context,q.job_id,q.input_hash),{code:'RESULT_UNKNOWN'});
    assert.throws(()=>workflow.recover(f.request(),q.job_id,getJob(f.context.db,f.config.workspace_id,q.job_id).version),{code:'RESULT_UNKNOWN'});
    assert.equal(f.context.db.prepare('SELECT count(*) n FROM job_attempts').get()!.n,before);assert.equal(f.context.db.prepare("SELECT count(*) n FROM assets WHERE status='ready'").get()!.n,0);assert.equal(provider.submits,1);assert.equal(provider.queries,0);
    assert.equal(JSON.parse(String(f.context.db.prepare('SELECT checkpoint FROM job_attempts WHERE id=?').get(claim.attempt.id)!.checkpoint)).image_terminal_proof,undefined);
  }finally{f.cleanup();}
});
for(const changed of ['verifier_binding','verifier_lease_owner'] as const)test('IP08 terminal proof cannot claim a different verifier: '+changed,async()=>{
  const f=fixture();try{
    const {input}=await seeded(f),provider=new FakeImageProvider(),workflow=new ImageGenerationWorkflow(f.context,{provider:()=>provider}),q=workflow.enqueue(f.request(),input),jobs=new Jobs(f.context),claim=jobs.claim('r4-proof-fence')!;
    const output=await workflow.execute(claim,new AbortController().signal,v=>jobs.checkpoint(claim.fence,v)),cp=JSON.parse(String(f.context.db.prepare('SELECT checkpoint FROM job_attempts WHERE id=?').get(claim.attempt.id)!.checkpoint));
    if(changed==='verifier_binding')cp.image_terminal_proof.verifier_binding.attempt_generation+=10;else cp.image_terminal_proof.verifier_lease_owner='other-owner';
    f.context.db.prepare('UPDATE job_attempts SET checkpoint=? WHERE id=?').run(JSON.stringify(cp),claim.attempt.id);
    const receipt=new ResultCommit(f.context).submit(f.request(),q.job_id,{attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,expected_version:getJob(f.context.db,f.config.workspace_id,q.job_id).version,input_hash:claim.job.input_hash,typed_output:{documents:[],recommendations:[],generated_assets:[output]}},claim.fence.lease_owner);
    assert.notEqual(receipt.state,'committed');assert.equal(f.context.db.prepare("SELECT count(*) n FROM assets WHERE status='ready'").get()!.n,0);
  }finally{f.cleanup();}
});
