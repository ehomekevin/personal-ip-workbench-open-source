import test from '../helpers/media-tools.ts';
import assert from 'node:assert/strict';
import {ContentPlans} from '../../packages/domain/src/content-plans/index.ts';
import {ArtifactExecution} from '../../packages/domain/src/artifact-execution/index.ts';
import {Jobs} from '../../packages/domain/src/jobs/index.ts';
import {DurableWorker} from '../../apps/service/src/worker/core/index.ts';
import {createMediaHandlers} from '../../apps/service/src/worker/handlers/media/index.ts';
import {LOCAL_PRESET,RENDERER,runTool,type ToolTrace} from '../../packages/adapters/src/media/render/index.ts';
import {LOCAL_TOOLS} from '../../packages/adapters/src/media/render/tools.ts';
import {fixture,seeded,evidence} from './harness.ts';

test('当前固定preset拒绝未准入layout，正式任务waiting_input不产成品',async()=>{const f=fixture();try{const variant=await seeded(f,'x','text'),plan=new ContentPlans(f.context()).create(f.request(),{variant_id:variant.variantId,variant_revision_id:variant.revisionId,format:'text',units:[{unit_key:'p1',position:0,kind:'post',text_revision_id:variant.revisionId,asset_refs:[],layout:{unsupported_diagnostic:true}}],preset:LOCAL_PRESET,renderer:RENDERER}),queued=await new ArtifactExecution(f.context()).enqueue(f.request(),'content',plan.id,{revision_id:plan.head_content_revision_id,preset:LOCAL_PRESET,mode:'export'}),result=await new DurableWorker(f.context(),createMediaHandlers(f.context())).runOnce();assert.equal(result?.state,'waiting_input');const job=new Jobs(f.context()).get(f.request(),queued.job_id);assert.equal(job.artifacts.length,0);assert.match(String(job.error?.message),/layout\/crop/);evidence(`failure-cancel-traces/unsupported-layout-${Date.now()}.json`,{status:'passed',evidence_grade:'internal_rule',job,unsupported_plan_preserved:true,artifact_count:0});}finally{f.cleanup();}});

test('实际ffmpeg工作进程取消后等待close，无未收割子进程',async()=>{const controller=new AbortController(),traces:ToolTrace[]=[],begin=Date.now(),timer=setTimeout(()=>controller.abort(new Error('actual child cancelled')),500);try{await assert.rejects(runTool(LOCAL_TOOLS.ffmpeg,['-hide_banner','-v','error','-re','-f','lavfi','-i','testsrc=size=64x64:rate=25','-t','60','-f','null','-'],{signal:controller.signal,traces}),/actual child cancelled/);assert.equal(traces.length,1);assert.notEqual(traces[0]!.exit_code,0);assert.ok(Date.now()-begin<4000);evidence(`failure-cancel-traces/actual-child-abort-${Date.now()}.json`,{status:'passed',evidence_grade:'real_provider',actual_tool:LOCAL_TOOLS.ffmpeg,controlled_child_close_observed:true,traces,elapsed_ms:Date.now()-begin,filesystem_outputs:0});}finally{clearTimeout(timer);}});
