import test from 'node:test';
import assert from 'node:assert/strict';
import {startStudioFixture} from './harness.ts';
import {ContractError,type StudioSnapshot} from '../../packages/contracts/src/index.ts';
// 执行器确认未提交（槽位占满）时同输入可再次分析；提交结果不明时仍禁止重发。
type Fixture=Awaited<ReturnType<typeof startStudioFixture>>;
async function body(f:Fixture){const s=await(await f.call('GET','/api/v1/image-studio?topic_id='+f.topic.id)).json() as StudioSnapshot;return{topic_id:s.topic_id,document_revision_id:s.document_revision_id,paragraph_id:s.paragraphs[0]!.id,placement_paragraph_id:s.paragraphs[1]!.id,description:'槽位占满后重试同一说明',title:'重试',position:'after',provider:'codex',references:[]};}
const invocation=(f:Fixture)=>Object.values(JSON.parse(String(f.app.context.db.prepare('SELECT value FROM application_metadata WHERE key LIKE ?').get('wechat-image-studio.v1:'+f.app.identity.workspace_id+':%')!.value)).brief_invocations)[0] as {state:string};
test('executor capacity busy before submit stays retryable and the same input can be analysed again',async()=>{
 const f=await startStudioFixture({auto_worker:false}),original=f.analysis.analyze.bind(f.analysis);let calls=0;
 f.analysis.analyze=async(request,options)=>{calls++;if(calls===1)throw new ContractError('CAPABILITY_UNVERIFIED','执行器槽位占用，任务继续排队',{executor_id:'codex',executor_capacity_busy:true,pre_submit_failure:true});return original(request,options);};
 try{const input=await body(f),busy=await f.call('POST','/api/v1/image-studio/brief',input);assert.equal(busy.status,422);assert.equal(invocation(f).state,'retryable','确认未提交不写 unknown');
  const retry=await f.call('POST','/api/v1/image-studio/brief',input);assert.equal(retry.status,200,await retry.clone().text());assert.equal(calls,2);assert.equal(invocation(f).state,'completed');
 }finally{await f.close();}
});
test('an unknown submission result still blocks resubmitting the same input',async()=>{
 const f=await startStudioFixture({auto_worker:false});f.setAnalysisFailure(true);
 try{const input=await body(f);assert.notEqual((await f.call('POST','/api/v1/image-studio/brief',input)).status,200);assert.equal(invocation(f).state,'unknown');f.setAnalysisFailure(false);
  const again=await f.call('POST','/api/v1/image-studio/brief',input),error=await again.json() as {error:{code:string}};assert.equal(again.status,409);assert.equal(error.error.code,'RESULT_UNKNOWN');assert.equal(f.brief_calls,1);
 }finally{await f.close();}
});
