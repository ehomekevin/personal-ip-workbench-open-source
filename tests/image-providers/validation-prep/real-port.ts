// Loaded only after a separate, new human authorization passes admission in run.ts.
import {randomUUID,createHash} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {build} from 'esbuild';
import {chromium,type Browser,type Page} from '@playwright/test';
import {startApplication,type RunningApplication} from '../../../apps/service/src/bootstrap/application.ts';
import {Topics} from '../../../packages/domain/src/topics/index.ts';
import {ImageProviderSettings} from '../../../packages/domain/src/settings/image-providers.ts';
import type {RequestContext,ServiceConfiguration,JobDetailResponse} from '../../../packages/contracts/src/index.ts';
import {verifyReady} from './verify-ready.ts';
import type {KnownIds,RunPort,Observation} from './runner.ts';
export function createRealPort(project:string,out:string):RunPort{
 let app:RunningApplication|undefined,topicId:string|undefined,jobId:string|undefined,browser:Browser|undefined,page:Page|undefined,ui:Server|undefined,closed=false,viewAttempted=false,known:KnownIds={};
 const request=():RequestContext=>({...app!.identity,request_id:randomUUID(),idempotency_key:randomUUID(),request_identity_ref:'new-human-approved-single-codex-validation'});
 const base=()=>`http://127.0.0.1:${app!.address.port}`;
 const headers=()=>({'content-type':'application/json','x-workspace-id':app!.identity.workspace_id,'x-service-instance-id':app!.identity.service_instance_id});
 const api=async<T>(path:string,signal:AbortSignal,body?:unknown,key?:string):Promise<T>=>{const response=await fetch(base()+path,{method:body?'POST':'GET',signal,headers:{...headers(),...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw new Error('HTTP response '+response.status);return await response.json() as T;};
 const snapshot=()=>{
  if(app&&!closed){
   const rows=app.context.db.prepare("SELECT id,input_hash FROM jobs WHERE workspace_id=? AND target_id=? AND kind='media_generate'").all(app.identity.workspace_id,topicId??'');if(rows.length>1)throw new Error('More than one new validation job');
   if(rows[0]){jobId=String(rows[0].id);known={...known,job_id:jobId,input_hash:String(rows[0].input_hash)};}
  }
  if(jobId){const path=join(out,'workspace/state/image-provider-jobs',jobId,'provider-receipt.json');if(existsSync(path)){const receipt=JSON.parse(readFileSync(path,'utf8')),cp=receipt.result?.native??receipt.checkpoint;
   known={...known,attempt_id:receipt.original_binding.attempt_id,attempt_generation:receipt.original_binding.attempt_generation,input_hash:receipt.input_hash,...(typeof cp.thread_id==='string'?{thread_id:cp.thread_id}:{}),...(typeof cp.turn_id==='string'?{turn_id:cp.turn_id}:{})};
  }}return{...known};
 };
 async function capture(phase:'submitted'|'terminal',signal:AbortSignal){
  const check=()=>{signal.throwIfAborted();if(closed)throw new Error('Own resources closed');};check();
  if(!page){
   if(viewAttempted)throw new Error('Previous browser setup failed; no new view resources');viewAttempted=true;
   const source=`import {createRoot} from 'react-dom/client';import {Workbench} from './apps/web/src/app/Workbench.tsx';import {createHttpClient} from './apps/web/src/transport/workbench-client.ts';import {createDataFeaturePorts} from './apps/web/src/transport/data-features.ts';import './apps/web/src/styles/approved.css';createRoot(document.querySelector('#root')).render(<Workbench injection={{mode:'real',client:createHttpClient(),initialLocation:{page:'create',topic_id:${JSON.stringify(topicId)}},features:createDataFeaturePorts()}}/>);`;
   const bundle=await build({absWorkingDir:project,stdin:{contents:source,resolveDir:project,loader:'tsx'},bundle:true,write:false,outdir:out,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});check();
   const js=bundle.outputFiles!.find(f=>f.path.endsWith('.js'))!.text,css=bundle.outputFiles!.find(f=>f.path.endsWith('.css'))!.text;
   ui=createServer(async(req,res)=>{try{const url=req.url??'/';if(url.startsWith('/api/')||url==='/health'){
    if(!['GET','HEAD'].includes(req.method??'GET')){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'CAPABILITY_UNVERIFIED',message:'验证页面仅可查看',details:{},retryable:false}}));return;}
    const response=await fetch(base()+url,{headers:headers(),signal:AbortSignal.timeout(5000)});res.writeHead(response.status,Object.fromEntries(response.headers.entries()));res.end(Buffer.from(await response.arrayBuffer()));return;
   }if(url.startsWith('/workbench/')){const path=url.slice(7).split('?')[0]!;if(path.includes('..'))throw new Error('Invalid brand path');res.writeHead(200);res.end(readFileSync(join(project,'apps/web/public/workbench',path)));return;}
   res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<!doctype html><meta charset="UTF-8"><style>'+css+'</style><div id="root"></div><script type="module">'+js+'</script>');}catch(error){res.writeHead(500);res.end(String(error));}});
   await new Promise<void>(resolve=>ui!.listen(0,'127.0.0.1',resolve));check();
   const launched=await chromium.launch({headless:true,timeout:15000});if(signal.aborted||closed){await launched.close();check();}browser=launched;
   page=await browser.newPage({viewport:{width:1440,height:1000}});check();page.setDefaultTimeout(5000);
   await page.goto(`http://127.0.0.1:${(ui.address() as {port:number}).port}`,{timeout:5000});check();
   writeFileSync(join(out,'view-binding.json'),JSON.stringify({product_candidate:'sha256:8f8f88a699fe5593339f28fdc2118886192866fb90192a98f366f7ae901d39aa',code_bundle_sha256:createHash('sha256').update(js+css).digest('hex'),viewport:[1440,1000],workspace_id:known.workspace_id,topic_id:topicId,time:new Date().toISOString()},null,2)+'\n');
  }
  await page.reload({timeout:5000});check();await page.locator('[data-action="edit-tab"][data-value="assets"]').click();check();await page.screenshot({path:join(out,'codex-'+phase+'.png'),timeout:5000,animations:'disabled'});check();
 }
 return{
  async setup(signal){const root=join(out,'workspace'),paths={source_vault_root:null,managed_notes_root:join(root,'notes'),state_root:join(root,'state'),media_root:join(root,'media')};
   const config:ServiceConfiguration={workspace_id:randomUUID(),service_instance_id:randomUUID(),title:'单Codex实测隔离工作台',mode:'real',timezone:'America/Los_Angeles',paths,listen:{host:'127.0.0.1',port:0},default_executor:'codex',api_fallback_enabled:false};
   app=await startApplication(config,{port:0,executorHealth:async()=>[]});if(signal.aborted||closed){await app.close();closed=true;signal.throwIfAborted();throw new Error('Setup locally stopped');}known.workspace_id=app.identity.workspace_id;
   const settings=new ImageProviderSettings(app.context);settings.save(request(),{expected_version:settings.stored().version,default_provider:'codex',enabled:{agy:false,codex:true}});
   const topic=await new Topics(app.context).create(request(),{title:'单Codex真实回图验证',category:'AI实践',audience:'AI使用者',source_ids:[]});topicId=topic.id;known.topic_id=topicId;
  },
  async submit(input,key,signal){const q=await api<{job_id:string}>('/api/v1/asset-generations',signal,{generator:'image',...input,topic_id:topicId,purpose:'单Codex真实持久链验证',input_asset_ids:[],parent_asset_id:null,document_revision_id:null,plan_revision_id:null},key);jobId=q.job_id;return q;},
  snapshot,
  async observe(id,signal){const detail=await api<JobDetailResponse>('/api/v1/jobs/'+id,signal),state=detail.job.state;
   const mapped:Observation['state']=state==='succeeded'?'succeeded':state==='failed'?'failed':state==='cancelled'?'cancelled':['reconciling','waiting_input','waiting_quota'].includes(state)?'unknown':'running';return{state:mapped,detail};},
  async verify(id,signal){return verifyReady(app!.context,id,signal,async assetId=>{
   const detail=await api<JobDetailResponse>('/api/v1/jobs/'+id,signal),list=await api<{items:Array<{id:string;status:string;sha256:string}>}>('/api/v1/assets?topic_id='+topicId,signal),asset=list.items.find(a=>a.id===assetId&&a.status==='ready');if(detail.job.state!=='succeeded'||!asset)return false;
   const response=await fetch(base()+'/api/v1/assets/'+assetId+'/content',{headers:headers(),signal});if(!response.ok)return false;const bytes=Buffer.from(await response.arrayBuffer());return ['image/png','image/jpeg'].includes(response.headers.get('content-type')?.split(';')[0]??'')&&createHash('sha256').update(bytes).digest('hex')===asset.sha256;
  });},
  capture,
  async close(){const errors:unknown[]=[];for(const close of [()=>browser?.close(),()=>new Promise<void>(resolve=>{if(ui?.listening){ui.closeAllConnections();ui.close(()=>resolve());}else resolve();}),()=>app?.close()])try{await close();}catch(error){errors.push(error);}closed=true;if(errors.length)throw new AggregateError(errors,'Own resource cleanup incomplete');}
 };
}
