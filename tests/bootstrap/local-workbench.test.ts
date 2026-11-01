import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startLocalWorkbench } from '../../scripts/runtime/local-server.ts';
import { createTopicsModule } from '../../apps/service/src/routes/topics.ts';
import { createDocumentsModule } from '../../apps/service/src/routes/documents.ts';
async function freePort(){const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));return port;}
async function fixture(){const root=mkdtempSync(resolve('.ci-artifacts/local-workbench-')),webRoot=join(root,'web');mkdirSync(webRoot);writeFileSync(join(webRoot,'index.html'),'<html><head></head><body>真实入口</body></html>');
 const config={workspace_id:randomUUID(),service_instance_id:randomUUID(),title:'日用启动专项隔离库',mode:'real',timezone:'America/Los_Angeles',paths:{source_vault_root:null,managed_notes_root:join(root,'notes'),state_root:join(root,'state'),media_root:join(root,'media')},listen:{host:'127.0.0.1',port:await freePort()}};
 const path=join(root,'config.json');writeFileSync(path,JSON.stringify(config));return {root,path,webRoot,config,cleanup(){rmSync(root,{recursive:true,force:true});}};}
test('日用根入口默认真实服务；来源拒绝与静态文件边界生效；重启保留主题',async()=>{
 const f=await fixture();let app:Awaited<ReturnType<typeof startLocalWorkbench>>|undefined;
 const options={webPort:0,webRoot:f.webRoot,moduleFactories:[createDocumentsModule,createTopicsModule]};
 try{
  app=await startLocalWorkbench(f.path,options);
  assert.match(await fetch(app.url).then(r=>r.text()),/workbench-mode" content="real/);
  const headers={'content-type':'application/json','x-workspace-id':f.config.workspace_id,'x-service-instance-id':f.config.service_instance_id,'idempotency-key':randomUUID()};
  const body=JSON.stringify({title:'重启后读回的主题',category:'个人思考',audience:'AI 使用者',source_ids:[]});
  assert.equal((await fetch(app.url+'/api/v1/topics',{method:'POST',headers:{...headers,origin:'https://untrusted.example'},body})).status,403);
  const created=await fetch(app.url+'/api/v1/topics',{method:'POST',headers,body});assert.equal(created.status,201);const topic=await created.json() as {id:string};
  const outside=join(f.root,'private.txt');writeFileSync(outside,'不可作为静态资源');symlinkSync(outside,join(f.webRoot,'escape.txt'));assert.equal((await fetch(app.url+'/escape.txt')).status,404);
  const identity=app.application.identity;await app.close();app=await startLocalWorkbench(f.path,options);assert.deepEqual(app.application.identity,identity);
  const saved=await fetch(app.url+'/api/v1/topics/'+topic.id,{headers}).then(r=>r.json()) as {title:string};assert.equal(saved.title,'重启后读回的主题');
 }finally{await app?.close();f.cleanup();}
});
test('页面端口冲突时关闭已启动主服务，不留下工作区独占锁',async()=>{
 const f=await fixture(),blocker=createServer();await new Promise<void>(done=>blocker.listen(0,'127.0.0.1',done));
 try{await assert.rejects(startLocalWorkbench(f.path,{webPort:(blocker.address() as {port:number}).port,webRoot:f.webRoot,moduleFactories:[]}),{code:'EADDRINUSE'});assert.equal(existsSync(join(f.config.paths.state_root,'.application-service-lock')),false);}
 finally{await new Promise<void>(done=>blocker.close(()=>done()));f.cleanup();}
});
