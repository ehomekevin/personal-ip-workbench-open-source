import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const root=resolve(import.meta.dirname,'../..'),artifacts=join(root,'.ci-artifacts/generation-resume-r1');mkdirSync(artifacts,{recursive:true});
const fixture=`
import {WritingFlowController} from './apps/web/src/features/create/writing-flow/index.ts';
import {DEFAULT_WRITING_EXECUTION} from './packages/contracts/src/index.ts';
import {createTemplateHelpers} from './apps/web/src/components/templateHelpers.ts';
import './apps/web/src/styles/approved.css';import './apps/web/src/styles/writing-flow.css';
const {esc,iconBtn}=createTemplateHelpers([]),root=document.querySelector('#root'),dialog=document.querySelector('#dialog');
const f=window.fixture={calls:[],presentations:0,active:true,held:null,hold:false,run:null};
const candidate=('这是本人观点整理后的候选，仍需要本人核对事实和说法。\\n').repeat(50).slice(0,1182);
f.run={schema_version:'writing-flow/1',id:'original',version:1,topic_id:'topic',document_id:'core',input_revision_id:null,input_text_sha256:'hash',instruction:'本人观点',executor:'codex',execution_policy:DEFAULT_WRITING_EXECUTION,source_ids:[],rule_snapshot:{id:'rules',created_at:'now',files:[],skill:{name:'configured-writing',version:'1',sha256:'hash',content:'rules'},scope:'本人'},export_target:null,created_at:'now',parent_run_id:null,phase:'writing',stages:[{stage:'writing',job_id:'job-original',document_id:'core',input_revision_id:null}],decisions:[],adopted_revision_id:null,exports:[],candidate:null,review:null,current_job:{id:'job-original',state:'running',version:1,error:null},input_draft:'',core_head:null};
const context={ui:{topic:'topic'},signal:new AbortController().signal,drafts:{leave:async()=>{},status:()=> 'committed'},surface:{presentDialog(data){f.presentations++;f.last=data;dialog.innerHTML='<div class="dialog-head"><h2 id="dialog-title">'+esc(data.title)+'</h2>'+iconBtn('close','close-dialog','关闭弹窗')+'</div><div class="dialog-body">'+data.body+'</div><div class="dialog-foot">'+(data.foot??'')+'</div>';if(!dialog.open)dialog.showModal();},closeDialog(){dialog.close();},toast(message){throw new Error(message);}},client:{request:async(method,url)=>{f.calls.push({method,url});if(method!=='GET')throw new Error('Browser fixture forbids new turns');if(url.includes('?summary=1'))return {items:[{...structuredClone(f.run),skill:'configured-writing'}],targets:[]};if(url==='/api/v1/writing-runs/original'){if(f.hold){f.hold=false;return new Promise(resolve=>f.held=resolve);}return structuredClone(f.run);}throw new Error('Unexpected read '+url);}}};
const controller=f.controller=new WritingFlowController({root,context:()=>context,render:()=>{throw new Error('Editor should not rerender');},active:()=>f.active});controller.activate('topic');
f.complete=()=>{f.run.phase='writing_ready';f.run.version++;f.run.current_job.state='succeeded';f.run.current_job.version++;f.run.candidate={id:'candidate',revision_id:'candidate-revision',text:candidate,status:'pending'};};
f.unknown=()=>{f.run.phase='needs_attention';f.run.current_job.state='failed';f.run.current_job.error={code:'RESULT_UNKNOWN',message:'原任务结果待核对，已有输入保留。'};};
f.generate=()=>controller.generateFromViewpoints({head_revision_id:'viewpoint-ack',text:'我认为先有品牌规范可以减少重复沟通。'});
root.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button)return;if(button.dataset.action==='generate')void f.generate();else if(button.dataset.action==='close-dialog'){controller.close();dialog.close();}else controller.handle(button);});
dialog.addEventListener('cancel',()=>controller.close());
f.dispose=()=>controller.dispose();
`;
const built=await build({absWorkingDir:root,stdin:{contents:fixture,resolveDir:root,loader:'ts'},bundle:true,write:false,outdir:artifacts,platform:'browser',format:'esm',external:['/workbench/*']});
const js=built.outputFiles!.find(file=>file.path.endsWith('.js'))!.text,css=built.outputFiles!.find(file=>file.path.endsWith('.css'))!.text;
const server=createServer((request,response)=>{
 if(request.url?.startsWith('/workbench/')){const leaf=request.url.slice(7);if(!/^[\w.-]+$/.test(leaf)){response.writeHead(404).end();return;}try{response.writeHead(200).end(readFileSync(join(root,'apps/web/public/workbench',leaf)));}catch{response.writeHead(404).end();}return;}
 response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><main id="root" style="max-width:1000px;margin:auto;padding:18px"><section class="panel"><div class="panel-head"><h2>核心稿</h2></div><div class="panel-body"><label class="field-label" for="core-editor">核心稿正文</label><textarea class="field" id="core-editor" rows="5"></textarea><label class="field-label" for="viewpoints">先说说你的想法</label><textarea class="field" id="viewpoints" rows="3">我认为先有品牌规范可以减少重复沟通。</textarea><button class="button primary" data-action="generate">生成核心稿</button></div></section><section class="writing-flow-panel"></section><dialog id="dialog" aria-labelledby="dialog-title"></dialog></main><script type="module">'+js+'</script></html>');
});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
const browser=await chromium.launch({headless:true}),checks:unknown[]=[],errors:string[]=[];
try{
 for(const width of [390,768,1440]){
  const page=await browser.newPage({viewport:{width,height:width===390?844:1000}});page.on('pageerror',error=>errors.push(error.message));await page.goto(url);await page.locator('.writing-flow-state').waitFor();
  await page.getByRole('button',{name:'生成核心稿',exact:true}).click();await page.locator('#dialog').waitFor({state:'visible'});await page.locator('#dialog .generation-progress-host').waitFor({state:'attached'});assert.deepEqual(await page.evaluate(()=>{const p=(window as any).fixture.last.generationProgress;return [p.state,p.label];}),['running','写作中']);
  const cancel=page.locator('[data-action="wf-cancel"]');assert.equal(await cancel.isEnabled(),true);await cancel.focus();await page.waitForTimeout(1950);assert.equal(await cancel.evaluate(el=>el===document.activeElement),true);assert.equal(await page.evaluate(()=>(window as any).fixture.presentations),1);
  await page.screenshot({path:join(artifacts,'running-'+width+'.png'),fullPage:true});
  await page.evaluate(()=>(window as any).fixture.complete());await page.locator('#dialog').getByRole('heading',{name:'本轮候选',exact:true}).waitFor();await page.getByText('候选已生成，打开「查看流程」核对并采用后，会进入核心稿编辑区。',{exact:true}).waitFor();assert.equal(await page.locator('#core-editor').inputValue(),'');assert.equal(await page.locator('#viewpoints').inputValue(),'我认为先有品牌规范可以减少重复沟通。');assert.equal(await page.locator('[data-action="wf-adopt"]').isEnabled(),true);
  const bounds=await page.locator('#dialog').boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const adoptBounds=await page.locator('[data-action="wf-adopt"]').boundingBox();assert.ok(adoptBounds&&adoptBounds.height>=32&&adoptBounds.y+adoptBounds.height<=(width===390?844:1000));
  await page.locator('.dialog-body').evaluate(el=>el.scrollTop=el.scrollHeight);await page.screenshot({path:join(artifacts,'candidate-'+width+'.png'),fullPage:true});await page.keyboard.press('Escape');assert.equal(await page.locator('#dialog').evaluate((el:HTMLDialogElement)=>el.open),false);assert.equal(await page.getByRole('button',{name:'生成核心稿',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.locator('[data-action="wf-open"]').click();await page.locator('#dialog').getByRole('heading',{name:'本轮候选',exact:true}).waitFor();await page.locator('[data-action="wf-close"]').click();await page.waitForTimeout(1950);assert.equal(await page.locator('#dialog').evaluate((el:HTMLDialogElement)=>el.open),false);assert.equal(await page.evaluate(()=>(window as any).fixture.calls.every((call:any)=>call.method==='GET')),true);
  checks.push({width,exact_run:'original',new_posts:0,candidate_chars:1182,stable_poll_focus:true,continuous_running_to_candidate:true,empty_core_note:true,escape_return_focus:true,reopen_existing_candidate:true,close_stays_closed:true,overflow:false});await page.evaluate(()=>(window as any).fixture.dispose());await page.close();
 }
 for(const mode of ['just-completed','unknown','late-close','late-topic'] as const){
  const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',error=>errors.push(error.message));await page.goto(url);await page.locator('.writing-flow-state').waitFor();
  if(mode==='just-completed')await page.evaluate(()=>(window as any).fixture.complete());else if(mode==='unknown')await page.evaluate(()=>(window as any).fixture.unknown());else await page.evaluate(()=>{(window as any).fixture.hold=true;});
  await page.getByRole('button',{name:'生成核心稿',exact:true}).click();
  if(mode==='late-close'||mode==='late-topic'){await page.waitForFunction(()=>!!(window as any).fixture.held);await page.evaluate(kind=>{const f=(window as any).fixture;if(kind==='late-close')f.controller.close();else{f.active=false;f.controller.deactivate();}f.held(structuredClone(f.run));},mode);await page.waitForTimeout(100);assert.equal(await page.locator('#dialog').evaluate((el:HTMLDialogElement)=>el.open),false);}
  else if(mode==='unknown'){await page.getByRole('button',{name:'核对原任务并恢复',exact:true}).waitFor();await page.screenshot({path:join(artifacts,'unknown-390.png'),fullPage:true});}
  else await page.locator('#dialog').getByRole('heading',{name:'本轮候选',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>(window as any).fixture.calls.every((call:any)=>call.method==='GET')),true);checks.push({mode,new_posts:0,passed:true});await page.evaluate(()=>(window as any).fixture.dispose());await page.close();
 }
 assert.deepEqual(errors,[]);writeFileSync(join(artifacts,'checks.json'),JSON.stringify({result:'passed',fixture_only:true,real_provider_turns:0,production_writes:0,checks,errors},null,2)+'\n');console.log(JSON.stringify({artifacts,checks:checks.length,errors}));
}finally{await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
