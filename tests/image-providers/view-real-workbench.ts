// Read existing real acceptance data only. No scheduler and no provider submission.
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {startApplication} from '../../apps/service/src/bootstrap/application.ts';
import {DEFAULT_MODULE_FACTORIES} from '../../apps/service/src/bootstrap/modules.ts';
import {createExecutionModule} from '../../apps/service/src/bootstrap/execution.ts';
import type {ServiceConfiguration} from '../../packages/contracts/src/index.ts';
const project=resolve(import.meta.dirname,'../..'),original=join(project,'.ci-artifacts/evidence/image-provider-agy-01/integration-r1/real-workbench');
const prior=JSON.parse(readFileSync(join(original,'result.json'),'utf8'));
const out=join(original,'readonly-final-view');mkdirSync(out,{recursive:true});
const root=join(original,'workspace'),paths={source_vault_root:null,managed_notes_root:join(root,'notes'),state_root:join(root,'state'),media_root:join(root,'media')};
const config:ServiceConfiguration={workspace_id:prior.workspace.workspace_id,service_instance_id:prior.workspace.service_instance_id,title:'图像渠道接入验收 · 隔离工作台',mode:'real',timezone:'America/Los_Angeles',paths,listen:{host:'127.0.0.1',port:43957},default_executor:'codex',api_fallback_enabled:false};
const app=await startApplication(config,{port:0,moduleFactories:DEFAULT_MODULE_FACTORIES.filter(f=>f!==createExecutionModule),executorHealth:async()=>[]}),base='http://127.0.0.1:'+app.address.port;
const topic={id:prior.topic_id};
const counts=()=>({jobs:app.context.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n,assets:app.context.db.prepare('SELECT count(*) AS n FROM assets').get()!.n,attempts:app.context.db.prepare('SELECT count(*) AS n FROM job_attempts').get()!.n});
const before=counts(),blocked:string[]=[];
const source=`import {createRoot} from 'react-dom/client';import {Workbench} from './apps/web/src/app/Workbench.tsx';import {createHttpClient} from './apps/web/src/transport/workbench-client.ts';import {createDataFeaturePorts} from './apps/web/src/transport/data-features.ts';import './apps/web/src/styles/approved.css';const client=createHttpClient();createRoot(document.querySelector('#root')).render(<Workbench injection={{mode:'real',client,initialLocation:{page:'create',topic_id:${JSON.stringify(topic.id)}},features:createDataFeaturePorts()}}/>);`;
const bundle=await build({absWorkingDir:project,stdin:{contents:source,resolveDir:project,loader:'tsx'},bundle:true,write:false,outdir:out,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});
const js=bundle.outputFiles!.find(f=>f.path.endsWith('.js'))!.text,css=bundle.outputFiles!.find(f=>f.path.endsWith('.css'))!.text;
const ui=createServer(async(req,res)=>{try{const url=req.url??'/';if(url.startsWith('/api/')||url==='/health'){if(!['GET','HEAD','OPTIONS'].includes(req.method??'GET')){blocked.push((req.method??'')+' '+url);res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'CAPABILITY_UNVERIFIED',message:'仅查看原真实任务；本轮不创建任务',details:{},retryable:false}}));return;}const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const method=req.method??'GET',response=await fetch(base+url,{method,headers:Object.fromEntries(Object.entries(req.headers).filter(([k])=>!['host','connection','content-length'].includes(k)).map(([k,v])=>[k,Array.isArray(v)?v.join(','):String(v)])),...(chunks.length?{body:Buffer.concat(chunks)}:{})});res.writeHead(response.status,Object.fromEntries(response.headers.entries()));res.end(Buffer.from(await response.arrayBuffer()));return;}if(url.startsWith('/workbench/')){const part=url.slice(7).split('?')[0]!;if(part.includes('..'))throw new Error('Invalid asset');res.writeHead(200);res.end(readFileSync(join(project,'apps/web/public/workbench',part)));return;}res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script type="module">'+js+'</script></html>');}catch(error){res.writeHead(500);res.end(String(error));}});
await new Promise<void>(done=>ui.listen(0,'127.0.0.1',done));const uiURL='http://127.0.0.1:'+(ui.address() as {port:number}).port;
const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
const screenshots:{path:string;at:string;workspace_id:string;topic_id:string;code_bundle_sha256:string}[]=[];const capture=async(name:string)=>{const path=join(out,name+'.png');await page.screenshot({path,fullPage:false,animations:'disabled'});screenshots.push({path,at:new Date().toISOString(),workspace_id:app.identity.workspace_id,topic_id:topic.id,code_bundle_sha256:createHash('sha256').update(js+css).digest('hex')});writeFileSync(join(out,'screenshots.json'),JSON.stringify(screenshots,null,2)+'\n');};
try {
  await page.goto(uiURL);await page.locator('[data-action="edit-tab"][data-value="assets"]').click();await page.locator('.image-preview-button img').waitFor();
  await page.locator('.image-preview-button').scrollIntoViewIfNeeded();await page.evaluate(()=>document.fonts.ready);await capture('actual-assets-and-original-tasks');
  await page.locator('[data-action="image-view"]').first().click();await page.locator('.image-full-preview').waitFor();await capture('actual-image');
  await page.locator('.image-source-details summary').click();await page.locator('.image-source-fields').scrollIntoViewIfNeeded();await capture('actual-image-provenance');await page.keyboard.press('Escape');
  await page.locator('[data-page="settings"]').first().click();await page.locator('#cfg-image-default').waitFor();await page.locator('#cfg-image-default').scrollIntoViewIfNeeded();await capture('actual-channel-settings');
  const after=counts();if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Read-only view changed task/asset counts');
  writeFileSync(join(out,'result.json'),JSON.stringify({workspace:app.identity,topic_id:topic.id,before,after,blocked_mutations:blocked,page_errors:errors,new_provider_submits:0,execution_scheduler:false,screenshots,source:'production Workbench / original real SQLite+assets; HTTP writes blocked'},null,2)+'\n');
  console.log(JSON.stringify({out,before,after,page_errors:errors,blocked_mutations:blocked,new_provider_submits:0}));
} finally {await browser.close();await new Promise<void>(done=>ui.close(()=>done()));await app.close();}
