import {syntheticMediaInputs} from '../helpers/media-fixtures.ts';
import test from '../helpers/media-tools.ts'; // 依赖真实图像解码；缺 ffmpeg/ffprobe 时跳过
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {resolve} from 'node:path';
import {fixture,seeded,FakeImageProvider} from './harness.ts';
import {startApplication} from '../../apps/service/src/bootstrap/application.ts';
import {createConfigurationModule} from '../../apps/service/src/routes/configuration.ts';
import {createArtifactsModule} from '../../apps/service/src/routes/artifacts.ts';
import {createAssetsModule} from '../../apps/service/src/routes/assets.ts';
import {createJobsModule} from '../../apps/service/src/routes/jobs.ts';
import {ImageGenerationWorkflow} from '../../packages/domain/src/artifact-execution/image.ts';
import {DurableWorker} from '../../apps/service/src/worker/core/index.ts';
import {createMediaHandlers} from '../../apps/service/src/worker/handlers/media/index.ts';
import {WORKBENCH_TOOL_ROUTES} from '../../packages/host-bridge/src/core/tools.ts';
import {routeRequest} from '../../packages/host-bridge/src/core/tools.ts';
import {MediaImporter} from '../../packages/domain/src/artifact-execution/index.ts';

test('real HTTP routes preserve settings isolation, image idempotency, original-job query and authenticated image bytes (fixture provider)',async()=>{
  const f=fixture();let app:Awaited<ReturnType<typeof startApplication>>|undefined;
  try {
    const {input}=await seeded(f),provider=new FakeImageProvider(),image=new ImageGenerationWorkflow(f.context,{provider:()=>provider});
    app=await startApplication({...f.config,listen:{host:'127.0.0.1',port:43957}},{port:0,executorHealth:async()=>[],moduleFactories:[createConfigurationModule,c=>createArtifactsModule(c,{image}),createAssetsModule,createJobsModule]});
    const base='http://127.0.0.1:'+app.address.port,headers={'content-type':'application/json','x-workspace-id':app.identity.workspace_id,'x-service-instance-id':app.identity.service_instance_id};
    const call=(method:string,path:string,body?:unknown,key=randomUUID())=>fetch(base+path,{method,headers:{...headers,'idempotency-key':key},...(body?{body:JSON.stringify(body)}:{})});
    const before=f.context.db.prepare('SELECT default_executor,version FROM workspaces').get();
    const settings=await (await call('GET','/api/v1/settings/image-providers')).json();
    assert.equal((await call('PUT','/api/v1/settings/image-providers',{expected_version:settings.version-1,default_provider:'agy',enabled:{agy:true,codex:false}})).status,409);
    assert.equal((await call('PUT','/api/v1/settings/image-providers',{expected_version:settings.version,default_provider:'agy',enabled:{agy:true,codex:false}})).status,200);
    assert.deepEqual(f.context.db.prepare('SELECT default_executor,version FROM workspaces').get(),before);
    const denied=await fetch(base+'/api/v1/asset-generations',{method:'POST',headers:{...headers,'x-workspace-id':'other','idempotency-key':'wrong-identity'},body:JSON.stringify(input)});assert.equal(denied.status,409);
    const key=randomUUID(),first=await call('POST','/api/v1/asset-generations',input,key),replay=await call('POST','/api/v1/asset-generations',input,key);assert.equal(first.status,202);assert.equal(replay.status,202);
    const q=await first.json();assert.deepEqual(await replay.json(),q);
    provider.disconnect=true;const worker=new DurableWorker(f.context,createMediaHandlers(f.context,{image}),{owner:'http-image-fixture'});await worker.runOnce();
    let detail=await (await call('GET','/api/v1/jobs/'+q.job_id)).json();assert.equal(detail.job.state,'reconciling');assert.equal(provider.submits,1);
    assert.equal((await call('POST','/api/v1/jobs/'+q.job_id+'/image-query',{expected_version:detail.job.version-1})).status,409);
    const queryKey=randomUUID(),queryBody={expected_version:detail.job.version};assert.equal((await call('POST','/api/v1/jobs/'+q.job_id+'/image-query',queryBody,queryKey)).status,202);
    assert.equal((await call('POST','/api/v1/jobs/'+q.job_id+'/image-query',queryBody,queryKey)).status,202);
    provider.disconnect=false;await worker.runOnce();detail=await (await call('GET','/api/v1/jobs/'+q.job_id)).json();assert.equal(detail.job.state,'succeeded');assert.equal(provider.submits,1);assert.equal(provider.queries,1);
    const page=await (await call('GET','/api/v1/assets?topic_id='+input.topic_id)).json();assert.equal(page.items.length,1);const asset=page.items[0];
    const content=await call('GET','/api/v1/assets/'+asset.id+'/content');assert.equal(content.status,200);assert.equal(createHash('sha256').update(Buffer.from(await content.arrayBuffer())).digest('hex'),asset.sha256);
    assert.equal((await fetch(base+'/api/v1/assets/'+asset.id+'/content')).status,409);
  } finally {await app?.close();f.cleanup();}
});

test('MCP image generation union and image query keep strict typed inputs',()=>{
  const generation=WORKBENCH_TOOL_ROUTES.find(r=>r.name==='generate_asset')!,query=WORKBENCH_TOOL_ROUTES.find(r=>r.name==='query_image_task')!;
  assert.ok(Array.isArray(generation.inputSchema.oneOf));assert.equal(query.path,'/api/v1/jobs/{id}/image-query');assert.equal(query.idempotent,true);
  assert.deepEqual(query.bodySchema!.parse({expected_version:1}),{expected_version:1});assert.throws(()=>query.bodySchema!.parse({expected_version:1,retry:true}));
});

test('IP03 identical H3 boundary inputs pass production HTTP and MCP without H3 execution',async()=>{
  const f=fixture();let app:Awaited<ReturnType<typeof startApplication>>|undefined;
  try{
    const {topic}=await seeded(f),importer=new MediaImporter(f.context),assets:string[]=[];
    for(const name of ['illustration-1.png','illustration-2.png'])assets.push((await importer.importFile(f.request(),createReadStream(resolve(await syntheticMediaInputs(f.root),name)),{kind:'image',mime:'image/png',source_kind:'constructed_illustration',is_user_footage:false,purpose:'isolated H3 schema boundary'})).asset_id);
    app=await startApplication({...f.config,listen:{host:'127.0.0.1',port:43957}},{port:0,executorHealth:async()=>[],moduleFactories:[createArtifactsModule]});
    const route=WORKBENCH_TOOL_ROUTES.find(r=>r.name==='generate_asset')!,headers={'content-type':'application/json','x-workspace-id':app.identity.workspace_id,'x-service-instance-id':app.identity.service_instance_id};
    const post=(body:unknown,key:string)=>fetch('http://127.0.0.1:'+app!.address.port+'/api/v1/asset-generations',{method:'POST',headers:{...headers,'idempotency-key':key},body:JSON.stringify(body)});
    for(const count of [0,1,2,32]){
      const body={generator:'h3',topic_id:topic.id,purpose:'p'.repeat(301),prompt:'q'.repeat(8001),input_asset_ids:Array.from({length:count},(_,i)=>assets[i%2]!)};
      assert.deepEqual(routeRequest(route,{...body,idempotency_key:'h3-'+count}).body,body);assert.equal((await post(body,'h3-'+count)).status,202);
    }
    const invalid={generator:'h3',topic_id:topic.id,purpose:'p',prompt:'q',input_asset_ids:Array(33).fill(assets[0])};
    assert.throws(()=>routeRequest(route,{...invalid,idempotency_key:'h3-too-many'}));assert.equal((await post(invalid,'h3-too-many')).status,400);
    assert.equal(f.context.db.prepare('SELECT count(*) n FROM job_attempts').get()!.n,0);
  }finally{await app?.close();f.cleanup();}
});
