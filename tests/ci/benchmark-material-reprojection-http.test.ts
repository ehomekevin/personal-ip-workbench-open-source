import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {BenchmarkMaterialReprojectionResponse,SourceRecordDetail} from '../../packages/contracts/src/index.ts';
import {BenchmarkMaterialReprojectionSchema,API_RESOURCES} from '../../packages/contracts/src/index.ts';
import {fixture} from '../documents/harness.ts';
import {startApplication,type RunningApplication} from '../../apps/service/src/bootstrap/application.ts';
import {createBenchmarkAccountsModule} from '../../apps/service/src/routes/benchmark-accounts.ts';
import {createSourcesModule} from '../../apps/service/src/routes/sources.ts';
import {Sources} from '../../packages/domain/src/sources/index.ts';
import {BenchmarkSync} from '../../packages/domain/src/sources/benchmark-sync.ts';
import {TikHubAdapter} from '../../packages/adapters/src/tikhub/index.ts';
import {DurableWorker} from '../../apps/service/src/worker/core/index.ts';
import {resolveWorkbenchRoute,routeRequest,WORKBENCH_TOOL_ROUTES,MCP_TOOL_INVENTORY} from '../../packages/host-bridge/src/core/tools.ts';

const resource='/api/v1/accounts/{id}/material-reprojection',sec='MS4w'+'a'.repeat(20),url='https://www.douyin.com/user/'+sec;
const heic='https://p3-sign.douyinpic.com/cover.heic?sig=original',jpeg='https://p3-sign.douyinpic.com/cover.jpeg?sig=original';

test('正式重解析 HTTP 从唯一主存更新封面，响应与回读一致；身份、空body和幂等边界生效',async()=>{
 const f=fixture();let app:RunningApplication|undefined,calls=0;
 const adapter=new TikHubAdapter({fixture:true,token_provider:()=> 'fixture-only',fetcher:async()=>{calls++;return new Response(JSON.stringify({code:200,data:{aweme_list:[{aweme_id:'201',desc:'平台原始说明',create_time:1720000000,author:{uid:'123',sec_uid:sec},statistics:{digg_count:0,comment_count:2,play_count:0},video:{duration:129967,cover:{url_list:[heic,jpeg]},play_addr:{url_list:['https://video.example.com/v.mp4']}}}]}}));}});
 const factories=[(context:Parameters<typeof createBenchmarkAccountsModule>[0])=>({...createBenchmarkAccountsModule(context,{adapter}),initialize:undefined}),(context:Parameters<typeof createSourcesModule>[0])=>({...createSourcesModule(context),initialize:undefined})];
 try{
  f.closeDb();app=await startApplication(f.config,{port:0,moduleFactories:factories,executorHealth:async()=>[]});
  const context=app.context,sources=new Sources(context),id=sources.createAccount(f.request(),{role:'benchmark',platform:'douyin',url,name:'隔离正式入口测试'}).account_id,db=context.db;
  db.prepare("UPDATE accounts SET platform_account_id='123',identity_status='confirmed' WHERE id=?").run(id);
  const sync=new BenchmarkSync(context,adapter);sync.enqueue(f.request(),id);const worker=new DurableWorker(context,[{registration:{kind:'benchmark_sync',execution_mode:'programmatic',recovery:'read_only'},async execute(e){await sync.execute(e.claim.job.id,JSON.parse(e.claim.job.input_manifest),{fence:e.claim.fence,signal:e.signal,checkpoint:e.checkpoint});return {documents:[],recommendations:[]};}}]);assert.equal((await worker.runOnce())?.state,'committed');assert.equal(calls,1);
  const record=sources.records(f.request()).items[0]!,saved=JSON.parse(String(db.prepare('SELECT payload FROM source_records WHERE id=?').get(record.id)!.payload));
  saved.body='人工补充正文';saved.provider_metadata.curation={selected:true,rank:1,reason:'人工选定'};saved.media=saved.media.map((m:Record<string,unknown>)=>m.type==='cover'?{...m,url:heic}:m.type==='video'?{...m,preview_url:heic}:m);
  db.prepare('UPDATE source_records SET payload=? WHERE id=?').run(JSON.stringify(saved),record.id);sources.marks(f.request(),record.id,{favorite:true,read:true});
  const path='/api/v1/accounts/'+id+'/material-reprojection',headers={'Content-Type':'application/json','X-Workspace-Id':f.config.workspace_id,'X-Service-Instance-Id':f.config.service_instance_id};
  const call=async(body:unknown=undefined,extra:Record<string,string>={},key:string|null='formal-reprojection')=>{const response=await fetch('http://127.0.0.1:'+app!.address.port+path,{method:'POST',headers:{...headers,...(key?{'Idempotency-Key':key}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
  const before={snapshots:db.prepare('SELECT COUNT(*) n FROM snapshots').get()!.n,locations:db.prepare('SELECT COUNT(*) n FROM source_locations').get()!.n,jobs:db.prepare('SELECT id,state,input_manifest FROM jobs ORDER BY id').all(),history:sync.status(f.request(),id)};
  assert.equal((await call({}, {},null)).status,400);
  for(const body of [{path:'/tmp/raw.json'},{payload:saved},{raw_body:'{}'},null,[]])assert.equal((await call(body,{},randomUUID())).status,400);
  assert.equal((await call({}, {'X-Workspace-Id':randomUUID()},randomUUID())).status,409);assert.equal((await call({}, {'X-Service-Instance-Id':randomUUID()},randomUUID())).status,409);
  const result=await call();assert.equal(result.status,200);const out=result.body as BenchmarkMaterialReprojectionResponse;
  assert.equal(out.account_id,id);assert.equal(out.matched_count,1);assert.equal(out.updated_count,1);assert.equal(out.unchanged_count,0);assert.equal(out.items.length,1);assert.equal(out.items[0]!.record_id,record.id);assert.equal(out.items[0]!.preview_url,jpeg);assert.equal(out.items[0]!.duration_ms,'129967');assert.equal(out.items[0]!.media_type,'video');assert.notEqual(out.items[0]!.before_payload_sha256,out.items[0]!.after_payload_sha256);
  const detailResponse=await fetch('http://127.0.0.1:'+app.address.port+'/api/v1/source-records/'+record.id,{headers});assert.equal(detailResponse.status,200);const detail=await detailResponse.json() as SourceRecordDetail;assert.equal(detail.preview_url,jpeg);assert.equal(detail.duration_ms,'129967');assert.equal(detail.body,'人工补充正文');assert.equal(detail.favorite,true);assert.equal(detail.read,true);assert.deepEqual(detail.benchmark?.curation,saved.provider_metadata.curation);
  assert.equal(calls,1,'重解析不得调用provider');assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshots').get()!.n,before.snapshots);assert.equal(db.prepare('SELECT COUNT(*) n FROM source_locations').get()!.n,before.locations);assert.deepEqual(db.prepare('SELECT id,state,input_manifest FROM jobs ORDER BY id').all(),before.jobs);assert.deepEqual(sync.status(f.request(),id),before.history);
  assert.deepEqual((await call()).body,out);const second=await call({}, {},'formal-reprojection-again');assert.equal(second.status,200);assert.equal(second.body.updated_count,0);assert.equal(second.body.unchanged_count,1);assert.equal(second.body.items[0].before_payload_sha256,second.body.items[0].after_payload_sha256);assert.equal(calls,1);
  await app.close();app=await startApplication(f.config,{port:0,moduleFactories:factories,executorHealth:async()=>[]});assert.deepEqual((await call()).body,out,'重启后的幂等重放保留正式回执');assert.equal(calls,1);
 }finally{await app?.close();f.cleanup();}
});

test('正式重解析资源、OpenAPI、MCP都只接受账户身份与幂等键，没有路径或输入payload',()=>{
 assert.ok(API_RESOURCES.some(r=>r.method==='POST'&&r.path===resource&&'idempotent' in r&&r.idempotent));
 assert.deepEqual(BenchmarkMaterialReprojectionSchema.parse({}),{});
 const mapped=resolveWorkbenchRoute('POST','/api/v1/accounts/account-1/material-reprojection',{}, {idempotencyKey:'fixed-projection'});assert.equal(mapped.name,'reproject_benchmark_materials');
 const route=WORKBENCH_TOOL_ROUTES.find(r=>r.name===mapped.name)!;assert.deepEqual(routeRequest(route,mapped.input),{method:'POST',path:'/api/v1/accounts/account-1/material-reprojection',body:{},idempotencyKey:'fixed-projection'});
 const inventory=MCP_TOOL_INVENTORY.find(t=>t.name===mapped.name)!;assert.equal(inventory.annotations.openWorldHint,false);assert.equal(inventory.annotations.idempotentHint,true);assert.equal(inventory.annotations.readOnlyHint,false);
 for(const body of [{path:'/tmp/raw'},{payload:{}},{raw_body:'{}'}])assert.throws(()=>resolveWorkbenchRoute('POST','/api/v1/accounts/account-1/material-reprojection',body,{idempotencyKey:'fixed-projection'}),{code:'VALIDATION_ERROR'});
 const openapi=JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json',import.meta.url),'utf8')),operation=openapi.paths[resource].post;assert.equal(operation.requestBody.content['application/json'].schema.$ref,'#/components/schemas/BenchmarkMaterialReprojectionRequest');assert.equal(operation.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/BenchmarkMaterialReprojectionResponse');assert.equal(openapi.components.schemas.BenchmarkMaterialReprojectionRequest.additionalProperties,false);assert.deepEqual(openapi.components.schemas.BenchmarkMaterialReprojectionRequest.properties,{});
});
