import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {startApplication} from '../../apps/service/src/bootstrap/application.ts';
import {createAssetsModule} from '../../apps/service/src/routes/assets.ts';
import {startStudioFixture} from './harness.ts';
import type {ServiceConfiguration} from '../../packages/contracts/src/index.ts';
import type {ApplicationModule,ModuleFactory} from '../../packages/domain/src/ports/index.ts';
import type {StudioSnapshot} from '../../packages/contracts/src/index.ts';
// 应用层关闭顺序与兼容：先通知模块停止在途工作，再等 HTTP 连接关闭，最后逐个 close；任一步失败不阻断其余清理。
function workspace(){const root=mkdtempSync(join(resolve(import.meta.dirname),'.app-close-')),paths={source_vault_root:null,managed_notes_root:join(root,'notes'),state_root:join(root,'state'),media_root:join(root,'media')};for(const p of [paths.managed_notes_root,paths.state_root,paths.media_root])mkdirSync(p);
 const config:ServiceConfiguration={workspace_id:randomUUID(),service_instance_id:randomUUID(),title:'应用关闭回归',mode:'demo',timezone:'UTC',paths,listen:{host:'127.0.0.1',port:1}};return{root,config,cleanup:()=>rmSync(root,{recursive:true,force:true})};}
function recorder(log:string[],id:string,faults:{beginClose?:boolean;close?:boolean;initialize?:boolean}={},legacy=false):ModuleFactory{return ()=>{const m:ApplicationModule={id,register(){},health:()=>({module:id,status:'ready'}),initialize(){log.push(id+':initialize');if(faults.initialize)throw new Error(id+' initialize failed');},close(){log.push(id+':close');if(faults.close)throw new Error(id+' close failed');}};if(!legacy)m.beginClose=()=>{log.push(id+':beginClose');if(faults.beginClose)throw new Error(id+' beginClose failed');};return m;};}
test('beginClose reaches every module before server.close, then module close; duplicate close shares one promise',async()=>{
 const w=workspace(),log:string[]=[];try{const app=await startApplication(w.config,{port:0,executorHealth:async()=>[],moduleFactories:[recorder(log,'a'),recorder(log,'legacy',{},true),recorder(log,'b')]});
  const close=app.server.close.bind(app.server);app.server.close=((callback?:(error?:Error)=>void)=>{log.push('server.close');return close(callback);}) as typeof app.server.close;
  const first=app.close(),second=app.close();assert.strictEqual(first,second);await first;
  assert.deepEqual(log.filter(item=>!item.endsWith(':initialize')),['a:beginClose','b:beginClose','server.close','a:close','legacy:close','b:close']);
  const again=await startApplication(w.config,{port:0,executorHealth:async()=>[],moduleFactories:[]});await again.close();
 }finally{w.cleanup();}
});
test('a throwing beginClose or close does not stop the other modules, storage close or lock release',async()=>{
 const w=workspace(),log:string[]=[];try{const app=await startApplication(w.config,{port:0,executorHealth:async()=>[],moduleFactories:[recorder(log,'a',{beginClose:true,close:true}),recorder(log,'b')]});
  await assert.rejects(app.close(),(error:unknown)=>error instanceof AggregateError&&error.errors.map(e=>(e as Error).message).join('|')==='a beginClose failed|a close failed');
  assert.deepEqual(log.filter(item=>!item.endsWith(':initialize')),['a:beginClose','b:beginClose','a:close','b:close']);
  const again=await startApplication(w.config,{port:0,executorHealth:async()=>[],moduleFactories:[]});await again.close();
 }finally{w.cleanup();}
});
test('a startup failure runs the same cleanup for already-built modules and releases the service lock',async()=>{
 const w=workspace(),log:string[]=[];try{
  await assert.rejects(startApplication(w.config,{port:0,executorHealth:async()=>[],moduleFactories:[recorder(log,'a'),recorder(log,'broken',{initialize:true}),recorder(log,'legacy',{},true)]}),/broken initialize failed/);
  assert.deepEqual(log,['a:initialize','broken:initialize','a:beginClose','broken:beginClose','a:close','broken:close','legacy:close']);
  const again=await startApplication(w.config,{port:0,executorHealth:async()=>[],moduleFactories:[]});await again.close();
 }finally{w.cleanup();}
});
test('stream upload/download and health still work with request cancellation wired; finished requests are not aborted',async()=>{
 const w=workspace(),log:string[]=[];let seen:AbortSignal|undefined;try{
  const app=await startApplication(w.config,{port:0,executorHealth:async()=>[],moduleFactories:[c=>{const m=createAssetsModule(c);return{...m,register(registrar){m.register({register(route){registrar.register({...route,handle:request=>{seen=request.signal;return route.handle(request);}});}});}};},recorder(log,'legacy',{},true)]});
  try{const base='http://127.0.0.1:'+app.address.port,headers={'x-workspace-id':app.identity.workspace_id,'x-service-instance-id':app.identity.service_instance_id};
   const health=await fetch(base+'/health');assert.equal(health.status,200);const body=await health.json() as {modules:Array<{module:string}>};assert.deepEqual(body.modules.map(m=>m.module),['assets','legacy']);
   const bytes=Buffer.from('studio stream regression '+randomUUID()),form=new FormData();form.set('purpose','回归');form.set('file',new Blob([bytes],{type:'text/plain'}),'a.txt');
   const upload=await fetch(base+'/api/v1/assets',{method:'POST',headers:{...headers,'idempotency-key':randomUUID()},body:form});assert.equal(upload.status,201,await upload.clone().text());const asset=await upload.json() as {asset_id:string};
   const download=await fetch(base+'/api/v1/assets/'+asset.asset_id+'/content',{headers});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
   await new Promise(done=>setTimeout(done,20));assert.ok(seen);assert.equal(seen!.aborted,false,'正常完成的请求不触发取消');
  }finally{await app.close();}
 }finally{w.cleanup();}
});
test('bounded analysis timeout reaches the downstream port through HTTP; the module still closes cleanly',async()=>{
 const f=await startStudioFixture({auto_worker:false,analysis_timeout_ms:80});let signal:AbortSignal|undefined;let settled=false;
 f.analysis.analyze=async(_request,options)=>{signal=options.signal;try{await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));throw new Error('unreachable');}finally{settled=true;}};
 try{const s=await(await f.call('GET','/api/v1/image-studio?topic_id='+f.topic.id)).json() as StudioSnapshot;
  const response=await f.call('POST','/api/v1/image-studio/brief',{topic_id:s.topic_id,document_revision_id:s.document_revision_id,paragraph_id:s.paragraphs[0]!.id,placement_paragraph_id:s.paragraphs[1]!.id,description:'有界超时：分析一直不返回',title:'超时',position:'after',provider:'codex',references:[]});
  assert.notEqual(response.status,200);assert.ok(signal?.aborted);assert.match(String((signal!.reason as Error).message),/timed out/);assert.equal(settled,true);assert.equal(f.provider.submits,0);
  const raw=f.app.context.db.prepare('SELECT value FROM application_metadata WHERE key LIKE ?').get('wechat-image-studio.v1:'+f.app.identity.workspace_id+':%')!;assert.equal((Object.values(JSON.parse(String(raw.value)).brief_invocations)[0] as {state:string}).state,'unknown','超时保留为结果未知，不重发');
 }finally{await f.close();}
});
test('a brief arriving after beginClose gets a retryable 503 contract error and never reaches the analysis port',async()=>{
 const {createImageStudioModule}=await import('../../apps/service/src/routes/image-studio.ts');
 const w=workspace();let studio:ApplicationModule|undefined,analyzed=0;
 try{const app=await startApplication(w.config,{port:0,executorHealth:async()=>[],moduleFactories:[c=>{studio=createImageStudioModule(c,{analysis:{async analyze(){analyzed++;throw new Error('unreachable');}}});return studio;}]});
  try{studio!.beginClose!();
   const response=await fetch('http://127.0.0.1:'+app.address.port+'/api/v1/image-studio/brief',{method:'POST',headers:{'content-type':'application/json','x-workspace-id':app.identity.workspace_id,'x-service-instance-id':app.identity.service_instance_id,'idempotency-key':randomUUID()},body:JSON.stringify({topic_id:randomUUID(),document_revision_id:randomUUID(),paragraph_id:'p'.repeat(32),placement_paragraph_id:'q'.repeat(32),description:'关闭期间到达',title:'关闭',position:'after',provider:'codex',references:[]})});
   const body=await response.json() as {error:{code:string;retryable:boolean;details:Record<string,unknown>}};
   assert.equal(response.status,503,JSON.stringify(body));assert.equal(body.error.code,'STORAGE_UNAVAILABLE');assert.equal(body.error.retryable,true);assert.equal(body.error.details.service_closing,true);assert.equal(analyzed,0);
  }finally{await app.close();}
 }finally{w.cleanup();}
});
