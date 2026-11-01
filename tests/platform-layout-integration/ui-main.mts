import assert from 'node:assert/strict';
import {createServer}from'node:http';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync}from'node:fs';
import{resolve,join}from'node:path';
import{createHash}from'node:crypto';
import{createRequire}from'node:module';
import{integrationFixture}from'./ui-fixture.ts';
const mirror=resolve(import.meta.dirname,'../..'),own=join(resolve(process.env.PLATFORM_LAYOUT_EVIDENCE??join(mirror,'runtime/platform-layout-integration-r1/ui-combined/evidence')),'ui-combined','p1',process.env.UI_STAGE??'all'),req=createRequire(join(mirror,'package.json'));
const{chromium}=req('@playwright/test');
const{startApplication}=await import(join(mirror,'apps/service/src/bootstrap/application.ts'));
const{createJobsModule}=await import(join(mirror,'apps/service/src/routes/jobs.ts'));
const{createDocumentsModule}=await import(join(mirror,'apps/service/src/routes/documents.ts'));
const{createTopicsModule}=await import(join(mirror,'apps/service/src/routes/topics.ts'));
const{createSettingsModule}=await import(join(mirror,'apps/service/src/routes/settings.ts'));
const{createSkillsModule}=await import(join(mirror,'apps/service/src/routes/skills.ts'));
const{createSchedulesModule}=await import(join(mirror,'apps/service/src/routes/schedules.ts'));
const{createPublicationsModule}=await import(join(mirror,'apps/service/src/routes/publications.ts'));
const{createOverviewModule}=await import(join(mirror,'apps/service/src/routes/overview.ts'));
const{createGenerationModule}=await import(join(mirror,'apps/service/src/routes/generation.ts'));
const{Sources}=await import(join(mirror,'packages/domain/src/sources/index.ts'));
const{threadResponse}=await import(join(mirror,'tests/platform-original-recovery/native-harness.ts'));
const sha=(b:any)=>createHash('sha256').update(b).digest('hex');
const runtime=join(mirror,'runtime/platform-layout-integration-r1/ui-combined/p1',process.env.UI_STAGE??'all'),evidence=own;mkdirSync(runtime,{recursive:true});mkdirSync(join(own,'screenshots'),{recursive:true});process.env.PLATFORM_UI_CASE_EVIDENCE=own;
const binding=JSON.parse(readFileSync(join(own,'../../build-binding.json'),'utf8')),dist=join(mirror,'apps/web/dist');
const js={contents:readFileSync(join(dist,binding.files.find((f:any)=>f.path.match(/^assets\/index-.*\.js$/)).path))},css={contents:readFileSync(join(dist,binding.files.find((f:any)=>f.path.match(/^assets\/index-.*\.css$/)).path))};
const servedAssets:any[]=[];
let backend:any,fixture:any,workerPromise:Promise<any>|undefined,worker:any,scenario='';
const httpEvents:any[]=[],checks:any[]=[],errors:any[]=[],blocked:any[]=[],closures:any[]=[],consoleEvents:any[]=[];
const proxy=createServer(async(request,response)=>{try{
 const u=new URL(request.url??'/','http://127.0.0.1');
 if(!u.pathname.startsWith('/api/')){const relative=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname).replace(/^\//,'');assert(!relative.includes('..'));const entry=binding.files.find((f:any)=>f.path===relative);if(!entry){response.writeHead(404).end();return;}const data=readFileSync(join(dist,relative));assert.equal(sha(data),entry.sha256);servedAssets.push({scenario,path:relative,bytes:data.length,sha256:sha(data)});response.writeHead(200,{'content-type':relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.html')?'text/html; charset=utf-8':relative.endsWith('.png')?'image/png':relative.endsWith('.woff2')?'font/woff2':'application/octet-stream'}).end(data);return;}
 assert(backend,'no active own backend');const parts=[];for await(const part of request)parts.push(Buffer.from(part));const body=Buffer.concat(parts);const mutation=request.method!=='GET';
 if(scenario==='dirty-390'&&request.method==='POST'&&u.pathname.endsWith('/revisions')){httpEvents.push({at:new Date().toISOString(),scenario,method:'POST',path:request.url,status:503,injected:'owned save transport unavailable'});response.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:{code:'STORAGE_UNAVAILABLE',message:'QA自有保存路径离线，输入必须保留'}}));return;}
 const permitted=!mutation||/^\/api\/v1\/jobs\/[^/]+\/resume$/.test(u.pathname)||/^\/api\/v1\/documents\/[^/]+\/(revisions|restores)$/.test(u.pathname);
 assert(permitted,'QA refuses unrelated mutation '+u.pathname);
 if(mutation&&u.pathname.endsWith('/resume')){const parsed=JSON.parse(body.toString());assert.deepEqual(Object.keys(parsed).sort(),['expected_version','recovery_action']);assert.equal(parsed.recovery_action,'query_original');}
 const headers={...request.headers};delete headers.host;delete headers.connection;delete headers['content-length'];
 const res=await fetch('http://127.0.0.1:'+backend.address.port+request.url,{method:request.method,headers:headers as any,...(body.length?{body}:{} )});const data=Buffer.from(await res.arrayBuffer());
 const event={at:new Date().toISOString(),scenario,method:request.method,path:request.url,status:res.status,...(body.length?{body:JSON.parse(body.toString())}:{}),response_sha256:sha(data)};httpEvents.push(event);writeFileSync(join(own,'http-events.json'),JSON.stringify(httpEvents,null,2));
 response.writeHead(res.status,{'content-type':res.headers.get('content-type')??'application/json'}).end(data);
 if(request.method==='POST'&&u.pathname.endsWith('/resume')&&res.ok){worker=fixture.worker();workerPromise=worker.runOnce();(workerPromise as Promise<any>).catch(error=>errors.push({kind:'worker',scenario,message:error.message}));}
 }catch(error:any){errors.push({kind:'proxy',scenario,message:error.message});response.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:{code:'QA_PROXY',message:error.message}}));}});
await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));const address='http://127.0.0.1:'+(proxy.address()as any).port;
assert(![4319,5180,5181,5173,8768,4327,5183].includes((proxy.address()as any).port));
const profile=mkdtempSync(join(runtime,'profile-')),tmp=join(runtime,'tmp');mkdirSync(tmp,{recursive:true});process.env.TMPDIR=tmp;
let browser:any;let initialProcesses:any;let preclose:any;const started=new Date().toISOString();writeFileSync(join(own,'resources-before-launch.json'),JSON.stringify({node_pid:process.pid,profile,TMPDIR:tmp,proxy_port:(proxy.address()as any).port,downloads:join(runtime,'downloads'),traces:join(runtime,'traces'),at:started},null,2));
try{
 browser=await chromium.launchPersistentContext(profile,{headless:true,executablePath:chromium.executablePath(),downloadsPath:join(runtime,'downloads'),tracesDir:join(runtime,'traces')});
 await browser.route('**/*',async(route:any)=>{if(new URL(route.request().url()).origin!==address){blocked.push(route.request().url());await route.abort('blockedbyclient');}else await route.continue();});
 const cdp=await browser.browser().newBrowserCDPSession();initialProcesses=await cdp.send('SystemInfo.getProcessInfo');await cdp.detach();
 writeFileSync(join(own,'resources-start.json'),JSON.stringify({at:started,pid:process.pid,proxy_port:(proxy.address()as any).port,profile,TMPDIR:tmp,processes:initialProcesses},null,2));
 const cases=process.env.QA_UI_CASES?JSON.parse(process.env.QA_UI_CASES):[{name:'completed',width:390},{name:'interrupted',width:390},{name:'interrupted',width:768},{name:'interrupted',width:1440},{name:'no-final',width:390},{name:'unknown',width:390},{name:'manual',width:390},{name:'core-stale',width:390},{name:'running',width:390},{name:'stop-view',width:390},{name:'history',width:390},{name:'empty',width:390},{name:'unloaded',width:390},{name:'dirty',width:390}];
 for(const item of cases){scenario=item.name+'-'+item.width;fixture=await integrationFixture('ui-'+scenario);workerPromise=undefined;worker=undefined;
  let page:any;const firstEvent=httpEvents.length;try{
   await fixture.documents.save(fixture.request(),String(fixture.other.document_id),{expected_revision_id:null,text:'# 另平台人工稿\n\n其他平台内容保持。',origin:'human'});if(item.name==='unloaded'){const d=await fixture.documents.get(fixture.request(),String(fixture.other.document_id));await fixture.documents.save(fixture.request(),String(fixture.other.document_id),{expected_revision_id:d.head_revision_id,text:'# 另平台人工稿\n\n第二版X稿保留元数据和历史。',origin:'human'});}const otherBefore=await fixture.documents.get(fixture.request(),String(fixture.other.document_id));
   if(item.name==='interrupted')fixture.set({thread:threadResponse(fixture.handle,'interrupted',undefined)});
   if(item.name==='no-final'){const t=threadResponse(fixture.handle,'completed',undefined);t.turns[0].items=[];fixture.set({thread:t});}
   if(['unknown','stop-view'].includes(item.name))fixture.set({thread:threadResponse(fixture.handle,'inProgress',undefined),...(item.name==='stop-view'?{readDelay:900}:{})});
   if(['manual','history'].includes(item.name)){const first=await fixture.documents.save(fixture.request(),String(fixture.variant.document_id),{expected_revision_id:null,text:'# 人工平台稿\n\n第一版人工正文。',origin:'human'});if(item.name==='history')await fixture.documents.save(fixture.request(),String(fixture.variant.document_id),{expected_revision_id:first.revision_id,text:'# 人工平台稿\n\n第二版人工正文。',origin:'human'});}
   if(item.name==='core-stale')await fixture.documents.save(fixture.request(),fixture.topic.core_document_id,{expected_revision_id:fixture.core.revision_id,text:'后来的人工核心稿，不改变旧输入。',origin:'human'});
   if(item.name==='running')fixture.context.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(fixture.accepted.job_id);
   let variant=fixture.variant;
   if(item.name==='empty')variant=fixture.generation.createVariant(fixture.request(),fixture.topic.id,{platform:'douyin',format:'short_video'});
   const documentBefore=await fixture.documents.get(fixture.request(),String(variant.document_id));
   backend=await startApplication({...fixture.context.config,listen:{host:'127.0.0.1',port:4355}},{port:0,executorHealth:async()=>[],moduleFactories:[createDocumentsModule,createTopicsModule,createGenerationModule,createSettingsModule,createJobsModule,createSkillsModule,createSchedulesModule,(ctx:any)=>createPublicationsModule(ctx,{run_worker:false}),createOverviewModule,(ctx:any)=>({id:'qa-account-read-only',register(reg:any){const sources=new Sources(ctx);reg.register({method:'GET',path:'/api/v1/accounts',owner:'QA read-only accounts only',handle:(r:any)=>({body:sources.accounts(r.context,{})})});},health:()=>({module:'qa-accounts',status:'ready'})})]});
   assert(![4319,5180,5181,5173,8768,4327,5183].includes(backend.address.port));
   page=await browser.newPage();page.setDefaultTimeout(10000);await page.setViewportSize({width:item.width,height:item.width===390?844:1024});page.on('console',(m:any)=>consoleEvents.push({scenario,type:m.type(),text:m.text()}));page.on('pageerror',(error:any)=>errors.push({scenario,kind:'pageerror',message:error.message}));
   const url=address+'/?mode=real#create?topic_id='+fixture.topic.id+'&variant_id='+variant.id;
   await page.goto(url);await page.locator('#version-text').waitFor();await page.reload();await page.locator('#version-text').waitFor();
   const query=page.locator('[data-original-job="'+fixture.accepted.job_id+'"]');const postBefore=httpEvents.filter(e=>e.method==='POST'&&e.path.endsWith('/resume')).length;
   if(item.name==='empty'){assert.equal(await query.count(),0);assert.equal(await page.locator('#version-text').inputValue(),'');}
   else if(item.name==='running'){assert.equal(await query.isDisabled(),true);}
   else if(item.name==='dirty'){
    await page.locator('#version-text').fill('未提交的合成平台输入必须保留。');await query.click();await page.waitForFunction(()=>document.querySelector('#dialog')?.textContent?.includes('尚未保存'));assert.equal(httpEvents.slice(firstEvent).filter(e=>e.method==='POST'&&e.path.endsWith('/resume')).length,0);await page.screenshot({path:join(own,'screenshots','dirty-before-refresh-390.png'),fullPage:true});await page.reload();await page.locator('#version-text').waitFor();assert.match(await page.locator('#version-text').inputValue(),/未提交的合成平台输入必须保留/);
   }else if(item.name==='unloaded'){
    assert.equal(httpEvents.slice(firstEvent).some(e=>e.method==='GET'&&e.path==='/api/v1/documents/'+fixture.other.document_id),false);await page.getByRole('button',{name:'X',exact:true}).click();await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('#version-text')?.value.includes('第二版X稿'));const previous=page.locator('[data-action=previous-version]');assert.equal(await previous.isEnabled(),true);await previous.click();await page.getByRole('button',{name:'恢复这一版',exact:true}).waitFor();await page.getByRole('button',{name:'保留当前版',exact:true}).click();
   }else if(item.name==='history'){
    const history=page.locator('[data-action="previous-version"]');await history.click();await page.getByRole('button',{name:'恢复这一版',exact:true}).click();await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('#version-text')?.value.includes('第一版人工正文'));assert.equal((await fixture.documents.get(fixture.request(),String(variant.document_id))).text.includes('第一版人工正文'),true);
   }else{
    assert.equal(await query.isEnabled(),true);await query.focus();await page.keyboard.press('Enter');
    if(item.name==='stop-view'){await page.waitForFunction(()=>document.querySelector<HTMLDialogElement>('#dialog')?.open);while(httpEvents.filter(e=>e.method==='POST'&&e.path.endsWith('/resume')).length===postBefore)await new Promise(r=>setTimeout(r,15));await page.getByRole('button',{name:'停止查看',exact:true}).click();await workerPromise;await page.waitForTimeout(150);assert.equal(await page.locator('#dialog').evaluate((d:any)=>d.open),false);assert.notEqual(fixture.detail().job.state,'cancelled');await page.reload();await page.locator('#version-text').waitFor();assert.equal(await page.locator('[data-original-job="'+fixture.accepted.job_id+'"]').isEnabled(),true);
    }else{
     await page.waitForFunction(()=>document.querySelector('#dialog')?.textContent?.includes('知道了'));if(workerPromise)await workerPromise;
     const text=await page.locator('#dialog').innerText();if(item.name==='unknown'){const again=page.locator('#dialog [data-original-job=\"'+fixture.accepted.job_id+'\"]');assert.equal(await again.isEnabled(),true);assert.equal(await again.getAttribute('data-original-variant'),String(variant.id));await page.screenshot({path:join(own,'screenshots','unknown-failed-popup-390.png'),fullPage:true});}
     if(item.name==='completed'){assert.match(text,/已恢复到这个平台/);assert.equal(fixture.detail().receipts.length,1);assert.equal(fixture.counts().receipts,1);assert.equal((await fixture.read()).head_revision_id,fixture.detail().receipts[0].result_ids.documents[0].revision_id);}
     if(item.name==='interrupted')assert.match(text,/已中断/);
     if(item.name==='no-final'){assert.match(text,/没有可回收的完整最终结果/);assert.doesNotMatch(text,/原任务已中断/);}
     if(item.name==='unknown'){assert.match(text,/未完成|暂未能确认|仍待核|未知/);assert.doesNotMatch(text,/已中断|已恢复|已保存到这个平台/);assert.equal(fixture.counts().receipts,0);assert.equal(fixture.calls().some((c:any)=>c.method==='thread/read'),true);}
     if(['manual','core-stale'].includes(item.name))assert.doesNotMatch(text,/原结果已恢复/);
    }
   }
   await page.screenshot({path:join(own,'screenshots',scenario+'.png'),fullPage:true});
   const current=await fixture.documents.get(fixture.request(),String(variant.document_id)),otherAfter=await fixture.documents.get(fixture.request(),String(fixture.other.document_id));
   assert.equal(otherAfter.hash,otherBefore.hash);
   if(!['completed','history'].includes(item.name))assert.equal(current.head_revision_id,documentBefore.head_revision_id);
   const calls=fixture.calls();for(const method of['thread/start','thread/resume','turn/start','model/list','turn/interrupt'])assert.equal(calls.filter((x:any)=>x.method===method).length,0,method);
   const events=httpEvents.slice(firstEvent);assert.equal(events.filter(e=>e.method==='POST'&&/generation|cancel/.test(e.path)).length,0);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
   checks.push({scenario,at:new Date().toISOString(),status:'passed',actual_main_mountReal:true,refresh:true,dist_canonical_sha256:binding.dist_canonical_sha256,source_js_sha256:sha(js.contents),api_port:backend.address.port,requests:events.length,query_posts:events.filter(e=>e.method==='POST'&&e.path.endsWith('/resume')).length,native_new_turns:0,producer_interrupts:0,receipts:fixture.counts().receipts,head_before:documentBefore.head_revision_id,head_after:current.head_revision_id,other_hash_preserved:true,job_state:fixture.detail().job.state,overflow,screenshot:'screenshots/'+scenario+'.png'});
  }catch(error:any){errors.push({scenario,kind:'case-failure',message:error.message,stack:error.stack});checks.push({scenario,status:'failed',message:error.message});if(page)await page.screenshot({path:join(own,'screenshots',scenario+'-failure.png'),fullPage:true}).catch(()=>{});}
  finally{if(page)await page.close();if(workerPromise)await (workerPromise as Promise<any>).catch(()=>{});if(backend){closures.push({scenario,backend_port:backend.address.port,closed_at:new Date().toISOString()});await backend.close();backend=undefined;}await fixture.cleanup();fixture=undefined;writeFileSync(join(own,'checks.json'),JSON.stringify({checks,errors,blocked,closures,consoleEvents,servedAssets,dist_canonical_sha256:binding.dist_canonical_sha256},null,2));}
 }
}finally{
 if(browser){const cdp=await browser.browser().newBrowserCDPSession();preclose=await cdp.send('SystemInfo.getProcessInfo');await cdp.detach();writeFileSync(join(own,'resources-preclose.json'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,profile,proxy_address:proxy.address(),processes:preclose},null,2));await browser.close();}
 await new Promise<void>((done,reject)=>proxy.close(error=>error?reject(error):done()));rmSync(profile,{recursive:true,force:true});rmSync(tmp,{recursive:true,force:true});
 const stillAlive=(preclose?.processInfo??[]).filter((p:any)=>{try{process.kill(p.id,0);return true;}catch{return false;}});
 writeFileSync(join(own,'resources-closed.json'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,browser_closed:true,proxy_closed:!proxy.listening,profile_removed:profile,temp_removed:tmp,still_alive_observed_browser_pids:stillAlive,dist_canonical_sha256:binding.dist_canonical_sha256,closures},null,2));
}
console.log(JSON.stringify({groups:checks.length,passed:checks.filter(c=>c.status==='passed').length,failed:checks.filter(c=>c.status==='failed').length,errors,blocked}));
if(errors.length||checks.some(c=>c.status!=='passed'))process.exitCode=1;
