// Imported only by the new bounded runner after its frozen dispatch admission.
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createServer,type Server} from 'node:http';
import {build} from 'esbuild';
import {chromium,type Browser,type Page} from '@playwright/test';
import {startApplication,type RunningApplication} from '../../apps/service/src/bootstrap/application.ts';
import {DEFAULT_MODULE_FACTORIES} from '../../apps/service/src/bootstrap/modules.ts';
import {createExecutionModule} from '../../apps/service/src/bootstrap/execution.ts';
import {createImageStudioModule} from '../../apps/service/src/routes/image-studio.ts';
import {ImageGenerationWorkflow,readImageReceipt} from '../../packages/domain/src/artifact-execution/image.ts';
import {createMediaHandlers} from '../../apps/service/src/worker/handlers/media/index.ts';
import {DurableWorker} from '../../apps/service/src/worker/core/index.ts';
import {Topics} from '../../packages/domain/src/topics/index.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import {ContentGeneration} from '../../packages/domain/src/content-agents/index.ts';
import {ImageProviderSettings} from '../../packages/domain/src/settings/image-providers.ts';
import type {ServiceConfiguration,RequestContext,StudioSnapshot,StudioBrief,StudioGenerationRequest,JobDetailResponse} from '../../packages/contracts/src/index.ts';
import {STUDIO_RUN_PLAN,type StudioRunPort} from './bounded-runner.ts';
import {managedFiniteSetup} from './runtime-setup.ts';
import {managedFiniteCapture} from './runtime-capture.ts';
import {readNativeReadAudit,aggregateNativeReadAudits} from './runtime-native-audit.ts';
export function finiteRealPort(project:string,out:string):StudioRunPort{
 let app:RunningApplication|undefined,topicId='',closed=false,closeRequested=false,configuration:ServiceConfiguration|undefined,closePromise:Promise<void>|undefined,timer:ReturnType<typeof setInterval>|undefined,inFlight:Promise<unknown>|null=null;
 const workerAbort=new AbortController();
 const check=(signal:AbortSignal)=>{signal.throwIfAborted();if(closeRequested)throw new Error('Own finite run resources are closing');};
 const jobs=new Map<string,{provider:string;input_hash:string;version_id:string}>(),known:Record<string,unknown>={};
 const base=()=>`http://127.0.0.1:${app!.address.port}`,headers=()=>({'content-type':'application/json','x-workspace-id':app!.identity.workspace_id,'x-service-instance-id':app!.identity.service_instance_id}),request=():RequestContext=>({...app!.identity,request_id:randomUUID(),idempotency_key:randomUUID(),request_identity_ref:'wechat-studio-bounded-validation'});
 async function api<T>(path:string,signal:AbortSignal,body?:unknown,key?:string):Promise<T>{const r=await fetch(base()+path,{method:body===undefined?'GET':'POST',signal,headers:{...headers(),...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw new Error(JSON.stringify({status:r.status,...data}));return data;}
 const current=(signal:AbortSignal)=>api<StudioSnapshot>('/api/v1/image-studio?topic_id='+topicId,signal);
 const snapshot=()=>{
  // Recover only this new topic's existing SQL intent after a lost POST response; never issue another POST.
  if(app&&!closeRequested){for(const row of app.context.db.prepare("SELECT id,input_hash,input_manifest FROM jobs WHERE workspace_id=? AND target_id=? AND kind='media_generate'").all(app.identity.workspace_id,topicId)){const frozen=JSON.parse(String(row.input_manifest)).image;if(frozen?.studio_binding)jobs.set(String(row.id),{provider:frozen.provider,input_hash:String(row.input_hash),version_id:frozen.studio_binding.version_id});}}
  const records=[...jobs.entries()].map(([job_id,value])=>{const path=join(out,'workspace/state/image-provider-jobs',job_id,'provider-receipt.json');if(!existsSync(path))return{job_id,...value,native_submit_count:null as number|null,image_tool_count:null as number|null};const receipt=JSON.parse(readFileSync(path,'utf8')),native=receipt.result?.native??receipt.checkpoint;
   const submitted=native?.provider==='codex'&&native.thread_id&&native.turn_id?1:native?.provider==='agy'&&native.tool_call_id&&native.native_state==='completed'?1:null;
   return{job_id,...value,original_binding:receipt.original_binding,state:receipt.state,native,native_submit_count:submitted,image_tool_count:typeof native?.observed_image_calls==='number'?native.observed_image_calls:null};});
  const audits=records.filter(row=>row.provider==='codex').map(row=>readNativeReadAudit(join(out,'workspace/state/image-provider-jobs',row.job_id,'workspace/.workbench-image-rpc.ndjson')));
  const total=(key:'native_submit_count'|'image_tool_count')=>records.length&&records.every(r=>typeof r[key]==='number')?records.reduce((n,r)=>n+Number(r[key]),0):null;
  return{...known,jobs:records,native_image_submit_count:total('native_submit_count'),native_image_tool_count:total('image_tool_count'),native_reads:aggregateNativeReadAudits(audits),native_read_audits:audits,fees:null,local_closed:closed,local_close_requested:closeRequested,capture:capture.snapshot(),setup:setup.snapshot()};
 };

 const capture=managedFiniteCapture<{js:string;css:string},Server,Browser,Page>({
  async build(signal){check(signal);const source=`import {createRoot} from 'react-dom/client';import {Workbench} from './apps/web/src/app/Workbench.tsx';import {createHttpClient} from './apps/web/src/transport/workbench-client.ts';import {createDataFeaturePorts} from './apps/web/src/transport/data-features.ts';import './apps/web/src/styles/approved.css';createRoot(document.querySelector('#root')).render(<Workbench injection={{mode:'real',client:createHttpClient(),initialLocation:{page:'create',topic_id:${JSON.stringify(topicId)}},features:createDataFeaturePorts()}}/>);`;
   const bundle=await build({absWorkingDir:project,stdin:{contents:source,resolveDir:project,loader:'tsx'},bundle:true,write:false,outdir:out,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});check(signal);
   const js=bundle.outputFiles!.find(file=>file.path.endsWith('.js'))!.text,css=bundle.outputFiles!.find(file=>file.path.endsWith('.css'))!.text;
   writeFileSync(join(out,'view-binding.json'),JSON.stringify({code_bundle_sha256:createHash('sha256').update(js+css).digest('hex'),workspace_id:app!.identity.workspace_id,topic_id:topicId,mode:'production_workbench_read_only_capture',time:new Date().toISOString()},null,2)+'\n');return{js,css};
  },
  createServer({js,css}){return createServer(async(req,res)=>{try{const path=req.url??'/';if(path.startsWith('/api/')||path==='/health'){if(!['GET','HEAD'].includes(req.method??'GET')){res.writeHead(422);res.end('Read-only validation capture');return;}const response=await fetch(base()+path,{headers:headers(),signal:AbortSignal.timeout(5000)});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;}if(path.startsWith('/workbench/')){const name=path.slice(7).split('?')[0]!;if(name.includes('..'))throw new Error('Invalid brand path');res.writeHead(200);res.end(readFileSync(join(project,'apps/web/public/workbench',name)));return;}res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<!doctype html><meta charset="UTF-8"><style>'+css+'</style><div id="root"></div><script type="module">'+js+'</script>');}catch(error){res.writeHead(500);res.end(String(error));}});},
  listen:server=>new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});}),
  launch:()=>chromium.launch({headless:true,timeout:15000}),
  async newPage(browser){const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(5000);return page;},
  async capture(server,page,index,signal,checkCapture){check(signal);checkCapture();await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`,{timeout:5000});checkCapture();await page.locator('[data-action="edit-tab"][data-value="assets"]').click();checkCapture();await page.locator('.image-studio-panel').waitFor();checkCapture();await page.screenshot({path:join(out,'step-'+index+'-workbench.png'),animations:'disabled',timeout:5000});checkCapture();},
  closePage:page=>page.close(),closeBrowser:browser=>browser.close(),
  closeServer:server=>new Promise<void>((resolve,reject)=>{if(server.listening){server.closeAllConnections();server.close(error=>error?reject(error):resolve());}else resolve();})
 });

 const setup=managedFiniteSetup<RunningApplication>({
  async start(signal){check(signal);const root=join(out,'workspace'),paths={source_vault_root:null,managed_notes_root:join(root,'notes'),state_root:join(root,'state'),media_root:join(root,'media')};for(const path of Object.values(paths))if(path)mkdirSync(path,{recursive:true});
   configuration={workspace_id:randomUUID(),service_instance_id:randomUUID(),title:'公众号配图有限实测',mode:'real',timezone:'America/Los_Angeles',paths,listen:{host:'127.0.0.1',port:43957},default_executor:'codex',api_fallback_enabled:false};
   return startApplication(configuration,{port:0,executorHealth:async()=>[],moduleFactories:[...DEFAULT_MODULE_FACTORIES.filter(factory=>![createExecutionModule,createImageStudioModule].includes(factory)),context=>createImageStudioModule(context,{record_root:paths.managed_notes_root})]});
  },
  async initialize(ownedApp,signal,checkSetup){app=ownedApp;checkSetup();
   Object.assign(known,{workspace_id:ownedApp.identity.workspace_id,service_instance_id:ownedApp.identity.service_instance_id,isolated_paths:ownedApp.context.paths});writeFileSync(join(out,'service-configuration.json'),JSON.stringify(configuration,null,2)+'\n');
   const topic=await new Topics(ownedApp.context).create(request(),{title:'公众号配图：从生成到采用',category:'AI实践',audience:'AI使用者',source_ids:[]});checkSetup();topicId=topic.id;known.topic_id=topicId;
   const docs=new Documents(ownedApp.context),core=await docs.save(request(),topic.core_document_id,{expected_revision_id:null,text:STUDIO_RUN_PLAN.article,origin:'human'});checkSetup();await docs.approveCore(request(),topicId,core.revision_id);checkSetup();
   const variant=new ContentGeneration(ownedApp.context).createVariant(request(),topicId,{platform:'wechat',format:'article'}),article=await docs.save(request(),String(variant.document_id),{expected_revision_id:null,text:STUDIO_RUN_PLAN.article,origin:'human'});checkSetup();known.document_revision_id=article.revision_id;
   new ImageProviderSettings(ownedApp.context).save(request(),{expected_version:1,default_provider:'codex',enabled:{codex:true,agy:true}});
   const image=new ImageGenerationWorkflow(ownedApp.context),worker=new DurableWorker(ownedApp.context,createMediaHandlers(ownedApp.context,{image}),{owner:'wechat-studio-bounded-native'});
   timer=setInterval(()=>{if(!closeRequested&&!inFlight&&app!.context.db.prepare("SELECT id FROM jobs WHERE kind='media_generate' AND state='queued' LIMIT 1").get())inFlight=worker.runOnce({signal:workerAbort.signal}).finally(()=>{inFlight=null;});},100);timer.unref();
  
  },
  beforeClose:async()=>{await inFlight;},close:ownedApp=>ownedApp.close()
 });

 return{
  setup:setup.setup,

  async prepare(provider,kind,parent,signal){const s=await current(signal),slot=parent?s.slots.find(slot=>slot.versions.some(v=>v.id===parent.id)):undefined;
   if(kind==='manual'&&(!slot||!parent?.asset_id))throw new Error('Manual adjustment requires a saved original version');
   const input={topic_id:topicId,document_revision_id:s.document_revision_id,paragraph_id:s.paragraphs[0]!.id,placement_paragraph_id:s.paragraphs[0]!.id,position:'after' as const,provider,title:'说明、生成、核对、采用',description:kind==='auto'?STUDIO_RUN_PLAN.auto_description:STUDIO_RUN_PLAN.manual_description,references:kind==='manual'&&provider==='agy'?[{asset_id:parent!.asset_id!,purpose:'content' as const}]:[]};
   const brief=kind==='auto'?await api<StudioBrief>('/api/v1/image-studio/brief',signal,input,randomUUID()):null;
   return{...input,expected_version:s.version,slot_id:slot?.id??null,parent_version_id:parent?.id??null,operation:kind==='manual'&&provider==='agy'?'reference_edit':'generate',size_mode:kind,size:brief?.suggested_size??STUDIO_RUN_PLAN.manual_size,brief_id:brief?.id??null};
  },
  async submit(input,key,signal){const q=await api<{job_id:string;version_id:string;input_hash:string}>('/api/v1/image-studio/generations',signal,input,key);jobs.set(q.job_id,{provider:input.provider,input_hash:q.input_hash,version_id:q.version_id});return q;},
  async observe(job,signal){const d=await api<JobDetailResponse>('/api/v1/jobs/'+job,signal),s=await current(signal),version=s.slots.flatMap(slot=>slot.versions).find(v=>v.job_id===job)??null;let native:unknown=null;
   if(d.job.state==='succeeded'){const receipt=readImageReceipt(app!.context,job,d.job.input_hash);native=receipt.result?.native;if(!version?.asset_id||!version.actual_size)throw new Error('Committed native result has no verified studio asset');const content=await fetch(base()+'/api/v1/assets/'+version.asset_id+'/content',{headers:headers(),signal});if(!content.ok)throw new Error('Saved image is unreadable');const bytes=Buffer.from(await content.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==receipt.result!.sha256)throw new Error('HTTP bytes differ from the native result');}
   return{state:version?.state??d.job.state,version,native};
  },
  capture:capture.capture,snapshot,
  close(){
   if(closePromise)return closePromise;closeRequested=true;if(timer)clearInterval(timer);workerAbort.abort(new Error('Own finite observation stopped'));
   return closePromise=(async()=>{
    const errors:unknown[]=[];
    for(const result of await Promise.allSettled([capture.close(),setup.close()]))if(result.status==='rejected')errors.push(result.reason);
    if(errors.length)throw new AggregateError(errors,'Own finite run resources did not all close');closed=true;
   })();
  }
 };
}
