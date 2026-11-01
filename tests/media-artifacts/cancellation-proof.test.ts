import {renderTest as test} from '../helpers/media-tools.ts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmodSync,existsSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ArtifactOutput} from '../../packages/contracts/src/index.ts';
import {canonicalJson,sha256} from '../../packages/storage/src/connection/index.ts';
import {ContentPlans} from '../../packages/domain/src/content-plans/index.ts';
import {ArtifactExecution} from '../../packages/domain/src/artifact-execution/index.ts';
import {verifyIsolation} from '../../packages/domain/src/artifact-execution/cancellation-proof.ts';
import {ResultCommit} from '../../packages/domain/src/result-commit/index.ts';
import {Jobs} from '../../packages/domain/src/jobs/index.ts';
import {DurableWorker} from '../../apps/service/src/worker/core/index.ts';
import {createMediaHandlers} from '../../apps/service/src/worker/handlers/media/index.ts';
import {LOCAL_PRESET,RENDERER} from '../../packages/adapters/src/media/render/index.ts';
import {evidence,fixture,seeded,type Fixture} from './harness.ts';

async function prepared() {
  const f=fixture(),variant=await seeded(f,'x','text'),plan=new ContentPlans(f.context()).create(f.request(),{
    variant_id:variant.variantId,variant_revision_id:variant.revisionId,format:'text',
    units:[{unit_key:'post',position:0,kind:'post',text_revision_id:variant.revisionId,asset_refs:[],layout:{}}],
    preset:LOCAL_PRESET,renderer:RENDERER
  });
  const media=new ArtifactExecution(f.context()),jobs=new Jobs(f.context()),results=new ResultCommit(f.context());
  const queued=await media.enqueue(f.request(),'content',plan.id,{revision_id:plan.head_content_revision_id,preset:LOCAL_PRESET,mode:'export'});
  const claim=jobs.claim('worker:r1-proof')!;
  return {f,variant,plan,media,jobs,results,queued,claim};
}
function events(f:Fixture,jobId:string) {
  return f.context().db.prepare('SELECT type,payload FROM job_events WHERE workspace_id=? AND job_id=? ORDER BY seq')
    .all(f.config.workspace_id,jobId).map(row=>({type:String(row.type),payload:JSON.parse(String(row.payload))}));
}
function receiveAndCancel(p:Awaited<ReturnType<typeof prepared>>,output:ArtifactOutput[]) {
  const {f,queued,claim,jobs,results}=p,receipt=results.receive(f.request(),queued.job_id,{
    attempt_id:claim.attempt.id,attempt_generation:claim.attempt.attempt_generation,
    expected_version:jobs.get(f.request(),queued.job_id).job.version,input_hash:claim.job.input_hash,
    typed_output:{documents:[],recommendations:[],artifacts:output}
  },claim.fence.lease_owner);
  assert.equal(receipt.state,'pending');
  jobs.cancel(f.request(),queued.job_id,{expected_version:jobs.get(f.request(),queued.job_id).job.version});
  results.recover();
  assert.equal(results.read(f.request(),receipt.receipt_id).state,'quarantined');
  return receipt;
}

test('R1：正常DurableWorker渲染继续经统一ResultCommit提交，证明事件不改变终态',async()=>{
  const f=fixture();
  try {
    const variant=await seeded(f,'x','text'),plan=new ContentPlans(f.context()).create(f.request(),{
      variant_id:variant.variantId,variant_revision_id:variant.revisionId,format:'text',
      units:[{unit_key:'post',position:0,kind:'post',text_revision_id:variant.revisionId,asset_refs:[],layout:{}}],preset:LOCAL_PRESET,renderer:RENDERER
    }),media=new ArtifactExecution(f.context()),queued=await media.enqueue(f.request(),'content',plan.id,
      {revision_id:plan.head_content_revision_id,preset:LOCAL_PRESET,mode:'export'}),result=await new DurableWorker(f.context(),createMediaHandlers(f.context())).runOnce(),
      detail=new Jobs(f.context()).get(f.request(),queued.job_id);
    assert.equal(result?.state,'committed',JSON.stringify(detail));assert.equal(detail.job.state,'succeeded');
    assert.equal(detail.receipts[0]!.state,'committed');assert.equal(detail.artifacts.length,1);
    const artifactId=String(detail.artifacts[0]!.id),read=await media.read(f.request(),artifactId),observed=events(f,queued.job_id);
    assert.equal(observed.filter(event=>event.type==='progress'&&event.payload.phase==='media_verified_output').length,1);
    assert.equal(observed.filter(event=>event.type==='cancelled'||event.payload.phase==='media_output_isolated').length,0);
    assert.equal(existsSync(join(f.paths.state_root,'media-quarantine',artifactId)),false);
    evidence('review-fixes/R1-normal-worker.json',{status:'passed',evidence_grade:'internal_rule',actual_local_files:true,
      result,job:detail,manifest_hash:read.artifact.sha256,events:observed,platform_api_calls:0});
  } finally {f.cleanup();}
});

test('R1：shape-valid收据缺原输出且缺隔离文件，重复复核保留reconciling',async()=>{
  const p=await prepared(),{f,variant,plan,media,jobs,queued}=p;
  try {
    const artifactId=randomUUID(),source=join(f.paths.media_root,'artifacts',artifactId),quarantine=join(f.paths.state_root,'media-quarantine',artifactId);
    const output:ArtifactOutput={artifact_id:artifactId,variant_id:variant.variantId,variant_revision_id:variant.revisionId,
      content_plan_revision_id:plan.head_content_revision_id,production_plan_revision_id:null,manifest_path:join(source,'manifest.json'),
      sha256:'0'.repeat(64),kind:'text_package',producer_version:'wp19-local-render/1'};
    const receipt=receiveAndCancel(p,[output]),before=jobs.get(f.request(),queued.job_id).job;
    assert.equal(before.state,'reconciling');
    for(let i=0;i<2;i++)assert.deepEqual(await media.reconcileCancelled(f.request(),queued.job_id),{state:'reconciling',isolated_artifact_ids:[]});
    assert.equal(existsSync(source),false);assert.equal(existsSync(quarantine),false);
    const after=jobs.get(f.request(),queued.job_id),observed=events(f,queued.job_id);
    assert.equal(after.job.version,before.version);assert.equal(after.artifacts.length,0);
    assert.equal(observed.filter(event=>event.type==='cancelled').length,0);
    evidence('review-fixes/R1-missing-output.json',{status:'passed',evidence_grade:'internal_rule',external_calls:0,
      output_physical_files_ever_created:false,receipt:receipt.receipt_id,before,after,source_exists:false,quarantine_exists:false,events:observed});

    // 普通文件和自称已结束的标记不构成由本地执行层持久记录的隔离证明。
    mkdirSync(quarantine,{recursive:true});const bytes='forged physical output\n';writeFileSync(join(quarantine,'sample.txt'),bytes);
    writeFileSync(join(quarantine,'quarantine.json'),canonicalJson({schema_version:'wp19-isolation/1',workspace_id:f.config.workspace_id,
      job_id:queued.job_id,attempt_id:p.claim.attempt.id,attempt_generation:p.claim.attempt.attempt_generation,lease_owner:p.claim.fence.lease_owner,
      artifact_id:artifactId,renderer_settled:true,manifest_sha256:output.sha256,
      files:[{relative_path:'sample.txt',sha256:sha256(bytes),size_bytes:Buffer.byteLength(bytes)}],reason:'FORGED',nonce:randomUUID()})+'\n');
    await assert.rejects(media.reconcileCancelled(f.request(),queued.job_id),/缺少可信记录/);
    assert.equal(jobs.get(f.request(),queued.job_id).job.state,'reconciling');
    assert.equal(events(f,queued.job_id).filter(event=>event.type==='cancelled').length,0);
    evidence('review-fixes/R1-forged-isolation.json',{status:'passed',evidence_grade:'internal_rule',ordinary_files_present:true,
      server_isolation_event_present:false,actual:jobs.get(f.request(),queued.job_id),rejected_reason:'隔离证明缺少可信记录'});
  } finally {f.cleanup();}
});

test('R1：可信隔离恢复幂等；跨任务标记、manifest hash、实际文件和链接篡改均拒绝',async()=>{
  const p=await prepared(),{f,media,jobs,queued,claim}=p;
  try {
    const output=await media.execute(claim,new AbortController().signal,value=>jobs.checkpoint(claim.fence,value));
    receiveAndCancel(p,output);const artifact=output[0]!,source=join(f.paths.media_root,'artifacts',artifact.artifact_id),
      quarantine=join(f.paths.state_root,'media-quarantine',artifact.artifact_id),markerPath=join(quarantine,'quarantine.json');
    // 中断发生在真实rename和可信证明落盘后、jobs终态提交前，避免构造假隔离成功。
    f.context().db.exec("CREATE TEMP TRIGGER diagnostic_stop_cancel BEFORE UPDATE OF state ON jobs WHEN NEW.state='cancelled' BEGIN SELECT RAISE(FAIL,'DIAGNOSTIC_STOP_AFTER_PROOF'); END");
    await assert.rejects(media.reconcileCancelled(f.request(),queued.job_id),/DIAGNOSTIC_STOP_AFTER_PROOF/);
    assert.equal(existsSync(source),false);assert.equal(existsSync(markerPath),true);
    assert.equal(jobs.get(f.request(),queued.job_id).job.state,'reconciling');
    f.context().db.exec('DROP TRIGGER diagnostic_stop_cancel');
    const marker=readFileSync(markerPath),proof=JSON.parse(marker.toString()) as {files:Array<{relative_path:string;sha256:string;size_bytes:number}>};
    const rejected:Array<{case:string;message:string}>=[];
    const reject=async(name:string,pattern:RegExp)=>{
      await assert.rejects(media.reconcileCancelled(f.request(),queued.job_id),(error:Error)=>{assert.match(error.message,pattern);rejected.push({case:name,message:error.message});return true;});
      assert.equal(jobs.get(f.request(),queued.job_id).job.state,'reconciling');
      assert.equal(events(f,queued.job_id).filter(event=>event.type==='cancelled').length,0);
    };
    for(const [key,value] of [['job_id',randomUUID()],['attempt_generation',claim.attempt.attempt_generation+1],['manifest_sha256','f'.repeat(64)]] as const){
      chmodSync(markerPath,0o600);writeFileSync(markerPath,canonicalJson({...JSON.parse(marker.toString()),[key]:value})+'\n');
      await reject('mismatched_'+key,/缺少可信记录或已篡改/);writeFileSync(markerPath,marker);chmodSync(markerPath,0o444);
    }
    assert.throws(()=>verifyIsolation(f.context(),claim,artifact.artifact_id,quarantine,'f'.repeat(64)),/任务\/代次\/manifest hash不符/);
    rejected.push({case:'expected_manifest_hash_mismatch',message:'可信标记和文件未改变，错误manifest hash仍被拒绝'});
    // 同一工作区的另一任务可收到shape-valid收据，但不能借用前一任务的真实隔离目录。
    const other=await media.enqueue(f.request(),'content',p.plan.id,{revision_id:p.plan.head_content_revision_id,preset:LOCAL_PRESET,mode:'export'}),otherClaim=jobs.claim('worker:r1-other-job')!;
    receiveAndCancel({...p,queued:other,claim:otherClaim},output);
    await assert.rejects(media.reconcileCancelled(f.request(),other.job_id),/缺少可信记录/);
    assert.equal(jobs.get(f.request(),other.job_id).job.state,'reconciling');
    assert.equal(events(f,other.job_id).filter(event=>event.type==='cancelled').length,0);
    rejected.push({case:'other_job_borrows_real_quarantine',message:'另一任务没有同job/attempt/gen可信记录，保留reconciling'});
    const actual=proof.files.find(file=>file.relative_path!=='manifest.json')!,filePath=join(quarantine,actual.relative_path),original=readFileSync(filePath);
    chmodSync(filePath,0o600);writeFileSync(filePath,Buffer.concat([original,Buffer.from('\ntampered\n')]));
    await reject('tampered_actual_file',/实际文件集合或hash已变化/);writeFileSync(filePath,original);chmodSync(filePath,0o444);
    rmSync(filePath);const outside=join(f.root,'outside-media.txt');writeFileSync(outside,'must not be treated as an isolated output');symlinkSync(outside,filePath);
    await reject('symlink_actual_file',/链接|特殊文件/);rmSync(filePath);writeFileSync(filePath,original,{mode:0o444});

    const settled=await media.reconcileCancelled(f.request(),queued.job_id),beforeReplay=jobs.get(f.request(),queued.job_id).job;
    assert.deepEqual(settled,{state:'cancelled',isolated_artifact_ids:[artifact.artifact_id]});
    assert.deepEqual(await media.reconcileCancelled(f.request(),queued.job_id),settled);
    assert.equal(jobs.get(f.request(),queued.job_id).job.version,beforeReplay.version);
    const observed=events(f,queued.job_id),cancelled=observed.filter(event=>event.type==='cancelled');
    assert.equal(cancelled.length,1);assert.equal(observed.filter(event=>event.payload.phase==='media_output_isolated').length,1);
    assert.equal(typeof cancelled[0]!.payload.actual_proof,'object');
    assert.equal(cancelled[0]!.payload.actual_proof.verified_isolation[0].files_verified,proof.files.length);
    assert.equal(f.context().db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()!.n,0);
    evidence('review-fixes/R1-verified-isolation.json',{status:'passed',evidence_grade:'internal_rule',actual_local_files:true,
      interruption:'after physical rename and persisted proof, before cancelled transaction',rejected,proof,
      source_exists:false,quarantine_exists:true,settled,replay:await media.reconcileCancelled(f.request(),queued.job_id),events:observed});
  } finally {f.cleanup();}
});
