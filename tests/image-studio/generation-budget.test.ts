import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startStudioFixture} from './harness.ts';
import {validateConfiguration} from '../../apps/service/src/bootstrap/config.ts';
import {readGenerationBudget} from '../../packages/storage/src/image-studio/index.ts';
import type {StudioSnapshot,StudioGenerationRequest} from '../../packages/contracts/src/index.ts';
type Fixture=Awaited<ReturnType<typeof startStudioFixture>>;
const snapshot=async(f:Fixture)=>await(await f.call('GET','/api/v1/image-studio?topic_id='+f.topic.id)).json() as StudioSnapshot;
function generation(s:StudioSnapshot,provider:'agy'|'codex',n:number):StudioGenerationRequest{return{topic_id:s.topic_id,document_revision_id:s.document_revision_id,paragraph_id:s.paragraphs[0]!.id,placement_paragraph_id:s.paragraphs[1]!.id,description:'预算闸门第'+n+'张：生成与采用的两个步骤',title:'预算'+n,position:'after',provider,references:[],expected_version:s.version,slot_id:null,parent_version_id:null,operation:'generate',size_mode:'manual',size:{width:640,height:640,aspect_ratio:'1:1'},brief_id:null};}
async function submit(f:Fixture,provider:'agy'|'codex',n:number,key=randomUUID()){const s=await snapshot(f);return f.call('POST','/api/v1/image-studio/generations',generation(s,provider,n),key);}
const jobs=(f:Fixture)=>Number(f.app.context.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='media_generate'").get()!.n);
test('default budget allows two AGY submissions, rejects the third with a user message and enqueues nothing',async()=>{
 const f=await startStudioFixture({auto_worker:false});try{
  const firstKey=randomUUID(),firstBody=generation(await snapshot(f),'agy',1),first=await f.call('POST','/api/v1/image-studio/generations',firstBody,firstKey);assert.equal(first.status,202,await first.clone().text());
  // 同一幂等键、同一请求重放返回原结果，不重复计数。
  const replay=await f.call('POST','/api/v1/image-studio/generations',firstBody,firstKey);assert.equal(replay.status,202);assert.deepEqual(await replay.json(),await first.json());assert.equal(readGenerationBudget(f.app.context.db,f.app.identity.workspace_id).agy,1);
  assert.equal((await submit(f,'agy',2)).status,202);assert.equal(jobs(f),2);
  const third=await submit(f,'agy',3),body=await third.json() as {error:{code:string;message:string;details:Record<string,unknown>}};
  assert.equal(third.status,429);assert.equal(body.error.code,'QUOTA_EXHAUSTED');assert.equal(body.error.message,'本渠道真实生图次数已达上限，需人工放开');assert.deepEqual(body.error.details,{provider:'agy',used:2,limit:2});
  assert.equal(jobs(f),2,'第 3 次未入队');assert.deepEqual(readGenerationBudget(f.app.context.db,f.app.identity.workspace_id),{codex:0,agy:2});assert.equal((await snapshot(f)).slots.length,2,'被拒提交不新增配图');
  // Codex 与 AGY 分开计数。
  assert.equal((await submit(f,'codex',4)).status,202);assert.equal((await submit(f,'codex',5)).status,202);assert.equal((await submit(f,'codex',6)).status,429);
  assert.deepEqual(readGenerationBudget(f.app.context.db,f.app.identity.workspace_id),{codex:2,agy:2});assert.equal(f.image_calls,0,'测试全程不调用生图 provider');
 }finally{await f.close();}
});
test('service configuration overrides the per-channel limit; a request rejected before enqueue does not consume budget',async()=>{
 const f=await startStudioFixture({auto_worker:false,image_generation_limits:{agy:0,codex:3}});try{
  const blocked=await submit(f,'agy',1);assert.equal(blocked.status,429);assert.equal(jobs(f),0);
  for(let n=1;n<=3;n++)assert.equal((await submit(f,'codex',n)).status,202);assert.equal((await submit(f,'codex',4)).status,429);
  assert.deepEqual(readGenerationBudget(f.app.context.db,f.app.identity.workspace_id),{codex:3,agy:0});
 }finally{await f.close();}
 const g=await startStudioFixture({auto_worker:false});try{const s=await snapshot(g),stale=await g.call('POST','/api/v1/image-studio/generations',{...generation(s,'agy',1),expected_version:s.version+5});assert.equal(stale.status,409);assert.equal(readGenerationBudget(g.app.context.db,g.app.identity.workspace_id).agy,0,'版本冲突不计数');}finally{await g.close();}
});
test('a null limit means unlimited: the 3rd and 10th submissions still enqueue, the counter keeps increasing, and budget reports limit/remaining null',async()=>{
 const {imageGenerationLimit}=await import('../../packages/contracts/src/index.ts');
 assert.equal(imageGenerationLimit({image_generation_limits:{agy:null}},'agy'),null);assert.equal(imageGenerationLimit({image_generation_limits:{agy:null}},'codex'),2,'未配置的渠道仍默认 2 次');assert.equal(imageGenerationLimit(undefined,'agy'),2);
 const f=await startStudioFixture({auto_worker:false,image_generation_limits:{agy:null}});try{
  for(let n=1;n<=10;n++){const r=await submit(f,'agy',n);assert.equal(r.status,202,'第 '+n+' 次：'+await r.clone().text());assert.equal(readGenerationBudget(f.app.context.db,f.app.identity.workspace_id).agy,n,'只计数不拦截');}
  assert.equal(jobs(f),10);
  const settings=await(await f.call('GET','/api/v1/settings/image-providers')).json() as {channels:Array<{provider:string;budget:{used:number;limit:number|null;remaining:number|null}}>};
  assert.deepEqual(settings.channels.find(c=>c.provider==='agy')!.budget,{used:10,limit:null,remaining:null});assert.deepEqual(settings.channels.find(c=>c.provider==='codex')!.budget,{used:0,limit:2,remaining:2});
  const {imageProviderAvailability}=await import('../../packages/contracts/src/index.ts');const a=imageProviderAvailability({enabled:true,configured:true,operations:{generation:'supported'} as never,budget:{used:10,limit:null,remaining:null}});assert.deepEqual([a.selectable,a.block,a.remaining,a.limit],[true,null,null,null],'不限次数不阻塞');
  assert.equal((await submit(f,'codex',11)).status,202);assert.equal((await submit(f,'codex',12)).status,202);assert.equal((await submit(f,'codex',13)).status,429,'另一渠道仍按默认 2 次拦截');
 }finally{await f.close();}
});
test('image_generation_limits configuration is bounded to 0-20 or null per known channel',()=>{
 const base={workspace_id:randomUUID(),service_instance_id:randomUUID(),title:'t',mode:'demo',timezone:'UTC',paths:{source_vault_root:null,managed_notes_root:join(tmpdir(),'__a1_notes'),state_root:join(tmpdir(),'__a1_state'),media_root:join(tmpdir(),'__a1_media')},listen:{host:'127.0.0.1',port:1}};
 assert.deepEqual(validateConfiguration({...base,image_generation_limits:{codex:0,agy:20}}).image_generation_limits,{codex:0,agy:20});
 assert.deepEqual(validateConfiguration({...base,image_generation_limits:{codex:null,agy:null}}).image_generation_limits,{codex:null,agy:null},'null 表示不限次数');
 assert.deepEqual(validateConfiguration({...base,image_generation_limits:{agy:null,codex:3}}).image_generation_limits,{agy:null,codex:3});
 for(const bad of [{codex:21},{agy:-1},{agy:null,codex:-1},{agy:null,codex:21},{agy:'unlimited'},{agy:1.5},{midjourney:1},{midjourney:null},[],null])assert.throws(()=>validateConfiguration({...base,image_generation_limits:bad}),{code:'VALIDATION_ERROR'});
});
test('asset-generations (generator=image) shares the studio budget in both directions',async()=>{
 const asset=(f:Fixture,n:number,key=randomUUID())=>f.call('POST','/api/v1/asset-generations',{...f.input,prompt:'通用生图预算 '+n,purpose:'预算 '+n},key);
 const f=await startStudioFixture({auto_worker:false});try{
  assert.equal((await submit(f,'agy',1)).status,202);assert.equal((await submit(f,'agy',2)).status,202);
  const blocked=await asset(f,1),body=await blocked.json() as {error:{code:string;message:string}};assert.equal(blocked.status,429);assert.equal(body.error.code,'QUOTA_EXHAUSTED');assert.equal(body.error.message,'本渠道真实生图次数已达上限，需人工放开');assert.equal(jobs(f),2,'被拒的通用生图不入队');
 }finally{await f.close();}
 const g=await startStudioFixture({auto_worker:false});try{
  const key=randomUUID(),first=await asset(g,1,key);assert.equal(first.status,202,await first.clone().text());
  const replay=await asset(g,1,key);assert.equal(replay.status,202,'幂等重放返回原结果');assert.deepEqual(await replay.json(),await first.json());
  assert.equal((await asset(g,2)).status,202);assert.deepEqual(readGenerationBudget(g.app.context.db,g.app.identity.workspace_id),{codex:0,agy:2});
  assert.equal((await submit(g,'agy',3)).status,429,'通用入口用满后公众号配图第 1 次即被拒');assert.equal(jobs(g),2);
 }finally{await g.close();}
});
test('same image input under two idempotency keys reuses one job and charges the budget once',async()=>{
 const f=await startStudioFixture({auto_worker:false});try{const body={...f.input,prompt:'同输入换幂等键',purpose:'去重'};
  const a=await f.call('POST','/api/v1/asset-generations',body),b=await f.call('POST','/api/v1/asset-generations',body);assert.equal(a.status,202);assert.equal(b.status,202);
  assert.equal((await a.json() as {job_id:string}).job_id,(await b.json() as {job_id:string}).job_id);assert.equal(jobs(f),1);assert.deepEqual(readGenerationBudget(f.app.context.db,f.app.identity.workspace_id),{codex:0,agy:1});
 }finally{await f.close();}
});
test('studio and asset-generations racing for the last unit: one 202, one 429, one job',async()=>{
 const f=await startStudioFixture({auto_worker:false,image_generation_limits:{agy:1}});try{const s=await snapshot(f);
  const [studio,asset]=await Promise.all([f.call('POST','/api/v1/image-studio/generations',generation(s,'agy',1)),f.call('POST','/api/v1/asset-generations',{...f.input,prompt:'并发抢额度',purpose:'并发'})]);
  assert.deepEqual([studio.status,asset.status].sort(),[202,429]);assert.equal(jobs(f),1);assert.deepEqual(readGenerationBudget(f.app.context.db,f.app.identity.workspace_id),{codex:0,agy:1});
 }finally{await f.close();}
});
