import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const root=resolve(import.meta.dirname,'../..'),artifacts=process.env.WORKBENCH_TEST_EVIDENCE_DIR?resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR):join(root,'.ci-artifacts','account-research-browser');mkdirSync(artifacts,{recursive:true});
const fixture=`
import {createRoot} from 'react-dom/client';
import {Workbench} from './apps/web/src/app/Workbench.tsx';
import {emptyIngestView,accountView} from './apps/web/src/features/sources/read/index.ts';
import {dispatchManualAccount} from './apps/web/src/features/sources/accounts-manual/index.ts';
import './apps/web/src/styles/approved.css';
import './apps/web/src/styles/benchmark-research.css';
const identity={workspace_id:'research-fixture',service_instance_id:'research-service-fixture',contract_version:'0.1.1'};
const samples=[1,2].map(n=>({source_id:'source-'+n,work_id:'work-'+n,title:'AI 工作流：从任务障碍到具体操作与可核对结果 '+n,url:'https://www.douyin.com/video/'+(100+n),published_at:'2026-10-0'+n+'T00:00:00Z',format:'short_video',selection:'recent',content_basis:'description_only',evidence_keys:['source:source-'+n,'work:work-'+n],comparison_group:null,snapshot_id:null,metric_key:null,metric_value:null}));
const plan={account_id:'account-fixture',strategy_version:'account-research/1',input_version:'a'.repeat(64),source_record_ids:samples.map(s=>s.source_id),samples,coverage:{eligible_count:6,sample_count:2,excluded_count:0,full_text_count:0,video_count:2,transcribed_video_count:0,transcription_rate:0,window_start:samples[0].published_at,window_end:samples[1].published_at,window_days:30},comparisons:{status:'insufficient',groups:0,reason:'缺少同形式、同指标定义和真实发布后观察窗口的足量样本，不按互动值判定好坏。'},trends:{account:'insufficient',works:'captures_only',profile_capture_count:1,account_snapshot_count:0,repeated_work_count:2,reason:'采集时点不替代平台观察时点，当前不能判断增粉。'},skill:{id:'skill-fixture',name:'personal-ip-operations',sha256:'b'.repeat(64)},limitations:['部分视频只有说明，不能据此拆完整口播、表演、镜头与节奏；需先补转写。','当前收录不是完整账号历史；频率只能描述已收录时间窗。','缺少本人发布结果及真实业务询问，商业建议仍需验证。'],blocked:null};
const account={id:plan.account_id,platform:'douyin',platform_account_id:'123',canonical_url:'https://www.douyin.com/user/fixture',role:'benchmark',identity_status:'confirmed',name:'测试对标账号',work_count:6,collection_status:'available',profile:{display_name:'测试对标账号 · AI 实操与长名称在手机上也要完整可读',display_id:'123',bio:'这些内容围绕 AI 工具和真实工作障碍；账号简介本身不能证明转化表现。',followers:'20000',following:'100',works:'250',likes:null,avatar_url:null,collected_at:'2026-10-13T00:00:00Z'}};
const otherAccount={...account,id:'other-account-fixture',name:'另一个测试账号',profile:{...account.profile,display_name:'另一个测试账号'}};
const records=samples.map(s=>({id:s.source_id,title:s.title,summary:'平台作品说明，未包含口播正文。',record_kind:'douyin_video',body:'平台提供的视频说明。<script>此文字应保持原文，不能执行。</script>',published_at:s.published_at,source_locations:[],source_name:account.name,media:[],metrics:{likes:'10000',plays:null},format:'short_video',media_type:'video',duration_ms:'30000',parser_warnings:['没有平台字幕，口播正文尚未转写。'],benchmark:{transcript_status:'not_provided'},external_links:[s.url]}));
const report={schema_version:1,summary:'对标可以借鉴把任务障碍讲清楚的方式；本次只有视频说明，因此先从选题和 CTA 的可见文字入手。',facts:[{text:'两份平台说明都先给出工作任务。',evidence_keys:['source:source-1']}],analyses:['structure','expression','operations','audience','trends'].map(dimension=>({dimension,status:dimension==='trends'?'insufficient':'supported',text:dimension==='trends'?'缺少真实观察时点，不能判断增长或写法效果。':'可以对照可见说明中的任务承诺、操作线索与结果描述。保留本人项目证据，下一篇只尝试一个表达改动。'.repeat(3),evidence_keys:['source:source-1']})),samples:samples.map(s=>({source_id:s.source_id,polarity:'contrast',aspect:'说明开头与结果承诺',analysis_scope:'video_description',performance_claim:'not_comparable',text:'说明先给任务再写可完成的结果；没有转写，暂不分析口播节奏。',evidence_keys:['source:'+s.source_id]})),hypotheses:[{text:'更具体的任务描述可能减少理解成本。',evidence_keys:['source:source-1'],missing_evidence:'本人下一篇的实际操作反馈和读者提问。'}],recommendations:['professional_influence','consistent_quality','followers','consulting'].map(goal=>({goal,text:'把方法写成本人可完成的一次试验，保留事实来源。',evidence_keys:['source:source-1'],action:'下一篇展示本人一个真实任务、一次关键取舍和实际结果。',prerequisite:'需要本人已完成项目的可公开材料，改稿约十分钟；咨询承接仍待本人确定。',measurement:'记录具体问题、重复参与和可追溯咨询；阅读量与涨粉分别看。',adoption_status:'proposed'})),limitations:plan.limitations};
const candidate={id:'candidate-fixture',target_document_id:'document-fixture',job_id:'job-fixture',base_revision_id:null,status:'pending',revision_id:'revision-fixture',text:JSON.stringify(report)};
const item={document_id:'document-fixture',job_id:'job-fixture',created_at:'2026-10-13T00:00:00Z',state:'queued',version:1,executor:'codex',input_version:plan.input_version,source_ids:plan.source_record_ids,candidate_id:null,candidate_status:null,revision_id:null,adopted_revision_id:null,skill_name:'personal-ip-operations',skill_sha256:'b'.repeat(64),model:'gpt-6.1-sol',reasoning_effort:'xhigh',error:null,coverage:plan.coverage};
const f=window.fixture={context:null,history:[],posts:[],cancelled:[],detail:{job:{id:'job-fixture',state:'queued',version:1,input_manifest:JSON.stringify({research_context:{plan},input_evidence:samples.map(s=>({key:'source:'+s.source_id,url:s.url,data:{title:s.title}}))})},attempts:[],checkpoint:null,artifacts:[],error:null,receipts:[]}};
f.seed=(adopted=false)=>{f.finish();f.history=[item];candidate.status=adopted?'adopted':'pending';item.candidate_status=candidate.status;item.adopted_revision_id=adopted?candidate.revision_id:null;};
f.finish=()=>{f.detail.job.state='succeeded';f.detail.job.version=4;Object.assign(item,{state:'succeeded',candidate_id:candidate.id,candidate_status:'pending',revision_id:candidate.revision_id});};
const client={identity:async()=>identity,getSettings:async()=>({default_executor:'codex'}),cancelJob:async(id,version)=>{f.cancelled.push({id,version});f.detail.job.state='cancelled';item.state='cancelled';},request:async(method,path,body)=>{
 if(path.startsWith('/api/v1/search?'))return {items:[],next_cursor:null};
 if(path.startsWith('/api/v1/accounts?'))return {items:[account,otherAccount],next_cursor:null};
 if(path.endsWith('/feed-sync'))return method==='POST'?{job_id:'sync-fixture'}:{source_id:'source-fixture',history_cursor:null};
 if(path.startsWith('/api/v1/source-records?'))return {items:records.slice(0,1),next_cursor:null};
 if(path.startsWith('/api/v1/source-records/'))return records.find(r=>r.id===path.split('/').at(-1));
 if(path.endsWith('/research')&&method==='GET')return structuredClone(path.includes(otherAccount.id)?{plan:{...plan,account_id:otherAccount.id},history:[]}:{plan,history:f.history});
 if(path.endsWith('/research')&&method==='POST'){f.posts.push(body);f.history=[item];return {job_id:item.job_id,document_id:item.document_id};}
 if(path.startsWith('/api/v1/jobs/'))return path.endsWith('/sync-fixture')?{...structuredClone(f.detail),job:{...structuredClone(f.detail.job),id:'sync-fixture',state:'succeeded'}}:structuredClone(f.detail);
 if(path.endsWith('/candidates'))return {items:item.candidate_id?[candidate]:[]};
 if(path==='/api/v1/candidates/'+candidate.id)return structuredClone(candidate);
 if(path.endsWith('/adoption')){candidate.status='adopted';item.candidate_status='adopted';item.adopted_revision_id=candidate.revision_id;return {adopted:true};}
 if(path.includes('/revisions/'))return {text:candidate.text};
 throw new Error('Unknown fixture request '+method+' '+path);
}};
const originalRequest=client.request;
f.requests=[];f.delay=null;f.pending=null;
f.block=stage=>{f.delay=stage;};
f.release=(fail=false)=>{const pending=f.pending;f.pending=null;if(fail)pending.reject(new Error('迟到的读取失败'));else pending.resolve();};
f.replaceSummary=text=>{const next=JSON.parse(candidate.text);next.summary=text;candidate.text=JSON.stringify(next);};
client.request=async(...args)=>{
 const response=await originalRequest(...args),path=args[1];
 const stage=path.includes('/revisions/')?'revision':path.startsWith('/api/v1/candidates/')&&!path.endsWith('/adoption')?'candidate':path.endsWith('/candidates')?'candidates':path.startsWith('/api/v1/jobs/')?'job':path.endsWith('/research')&&args[0]==='GET'?'research':'other';
 f.requests.push({stage,path});
 if(f.delay===stage){f.delay=null;await new Promise((resolve,reject)=>{f.pending={stage,resolve,reject};});}
 return response;
};
createRoot(document.getElementById('root')).render(<Workbench injection={{mode:'real',client,initialPage:'sources',features:{sources:{page:'sources',load:async context=>{f.context=context;const view=emptyIngestView(context,{...context.ui,sourceTab:'accounts'});view.state.accounts=[accountView(account),accountView(otherAccount)];return view;},dispatch:async(action,context)=>{await dispatchManualAccount(action,context);}}}}}/>);
`;
const built=await build({absWorkingDir:root,stdin:{contents:fixture,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:artifacts,jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'},external:['/workbench/*']});
const javascript=built.outputFiles!.find(f=>f.path.endsWith('.js'))!.text,css=built.outputFiles!.find(f=>f.path.endsWith('.css'))!.text;
const html='<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script type="module">'+javascript+'</script></html>';
const server=createServer((req,res)=>{if(req.url?.startsWith('/workbench/')){const file=req.url.slice('/workbench/'.length);if(!['icon.svg','avatar.svg','platforms/douyin.svg'].includes(file)){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.woff2')?'font/woff2':file.endsWith('.ico')?'image/x-icon':'image/webp'});res.end(readFileSync(join(root,'apps/web/public/workbench',file)));return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const url='http://127.0.0.1:'+(server.address() as {port:number}).port,browser=await chromium.launch({headless:true}),checks:JsonObject[]=[];type JsonObject=Record<string,unknown>;
try{
 for(const width of [390,768,1275]){
  const page=await browser.newPage({viewport:{width,height:width===390?844:1000},reducedMotion:'reduce'}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.waitForFunction(()=>{const img=document.querySelector<HTMLImageElement>('.benchmark-platform-icon img');return !!img?.naturalWidth;});await page.locator('[data-action="account-detail"]').first().click();await page.getByRole('button',{name:'资料',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'资料',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await page.getByText('已采集作品',{exact:true}).count(),1);assert.equal(await page.locator('#dialog').evaluate(d=>d.classList.contains('drawer')),true);
  await page.screenshot({path:join(artifacts,'materials-'+width+'.png'),fullPage:true});await page.getByRole('button',{name:'研究报告',exact:true}).click();await page.getByText('把对标经验变成下一篇可试的方法',{exact:true}).waitFor();assert.equal(await page.getByText('0%',{exact:true}).count(),1);assert.equal(await page.getByText('开始账号研究',{exact:true}).count(),1);await page.screenshot({path:join(artifacts,'plan-'+width+'.png'),fullPage:true});
  await page.locator('.account-research-strategy summary').click();await page.locator('[data-action="benchmark-record"][data-id="source-2"]').click();await page.locator('.benchmark-record-detail').waitFor();await page.locator('[data-action="benchmark-research"]').click();await page.getByText('把对标经验变成下一篇可试的方法',{exact:true}).waitFor();
  await page.locator('[data-action="benchmark-research-run"]').click();await page.locator('.generation-progress').waitFor();await page.evaluate(()=>{const f=(window as any).fixture;f.detail.job.state='running';f.detail.job.version=3;});await page.getByText('正在对照固定作品，拆解内容与运营方法…',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>(window as any).fixture.posts[0].input_version),'a'.repeat(64));await page.screenshot({path:join(artifacts,'running-'+width+'.png'),fullPage:true});await page.evaluate(()=>(window as any).fixture.finish());await page.getByText('AI 研究候选 · 待人工采用',{exact:true}).waitFor();
  assert.equal(await page.locator('.account-research-analysis').count(),8);assert.equal(await page.locator('.account-research-recommendation').count(),4);assert.equal(await page.locator('[data-action="benchmark-research-adopt"]').count(),1);assert.equal(await page.locator('script').count(),1);await page.screenshot({path:join(artifacts,'candidate-'+width+'.png'),fullPage:true});
  const layout=await page.evaluate(()=>{const d=document.querySelector('#dialog')!.getBoundingClientRect(),body=document.querySelector('#dialog .dialog-body')!,foot=document.querySelector('#dialog .dialog-foot')!.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,dialogFits:d.left>=0&&d.right<=innerWidth,scrollable:body.scrollHeight>body.clientHeight,drawer:document.querySelector('#dialog')!.classList.contains('drawer'),footerFits:foot.bottom<=innerHeight};});assert.equal(layout.overflow,false);assert.equal(layout.dialogFits,true);assert.equal(layout.scrollable,true);assert.equal(layout.drawer,true);assert.equal(layout.footerFits,true);
  await page.locator('[data-action="benchmark-research-adopt"]').click();await page.getByText('已人工采用的研究记录',{exact:true}).waitFor();assert.equal(await page.locator('[data-action="benchmark-research-adopt"]').count(),0);await page.screenshot({path:join(artifacts,'adopted-'+width+'.png'),fullPage:true});await page.locator('[data-action="benchmark-research"]').last().click();await page.getByText('已采用报告',{exact:true}).waitFor();await page.locator('[data-action="benchmark-report"]').last().click();await page.getByText('已人工采用的研究记录',{exact:true}).waitFor();await page.getByRole('button',{name:'资料',exact:true}).click();await page.locator('[data-action="benchmark-sync"]').click();await page.getByText('平台作品已保存。',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'资料',exact:true}).getAttribute('aria-pressed'),'true');assert.deepEqual(errors,[]);checks.push({width,sync_completion_refreshes_materials:true,default_materials:true,coverage_unknown_preserved:true,frozen_input:true,report_adopted:true,history_reopened:true,...layout,console_errors:errors});await page.close();
 }
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});await page.goto(url);await page.locator('[data-action="account-detail"]').first().click();await page.getByRole('button',{name:'研究报告',exact:true}).click();await page.locator('[data-action="benchmark-research-run"]').click();await page.locator('.generation-progress').waitFor();await page.evaluate(()=>{const f=(window as any).fixture;f.detail.job.state='running';f.detail.job.version=9;});await page.getByText('正在对照固定作品，拆解内容与运营方法…',{exact:true}).waitFor();await page.locator('[data-action="cancel-task"]').click();await page.waitForFunction(()=>!(document.querySelector('#dialog') as HTMLDialogElement).open);assert.deepEqual(await page.evaluate(()=>(window as any).fixture.cancelled),[{id:'job-fixture',version:9}]);await page.waitForTimeout(400);assert.equal(await page.locator('#dialog').evaluate(d=>(d as HTMLDialogElement).open),false);checks.push({cancel_uses_current_version:true,no_late_reopen:true});await page.close();

 // Workbench mounts the production real-controller. Delay each actual report read,
 // then exercise its real close button / native Escape before releasing the response.
 for(const width of [390,768,1275]){
  const page=await browser.newPage({viewport:{width,height:width===390?844:1000},reducedMotion:'reduce'}),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(url);
  const openHistory=async(adopted=false)=>{
   await page.evaluate(adopted=>(window as any).fixture.seed(adopted),adopted);
   await page.locator('[data-action="account-detail"][data-id="account-fixture"]').click();
   await page.getByRole('button',{name:'研究报告',exact:true}).click();await page.locator('[data-action="benchmark-report"]').last().waitFor();
  };
  const block=async(stage:string)=>{await page.evaluate(stage=>(window as any).fixture.block(stage),stage);await page.locator('[data-action="benchmark-report"]').last().click();await page.waitForFunction(stage=>(window as any).fixture.pending?.stage===stage,stage);};
  const release=async(fail=false)=>{await page.evaluate(fail=>(window as any).fixture.release(fail),fail);await page.waitForTimeout(120);};
  for(const stage of ['research','job','candidates','candidate','revision'])for(const closing of ['close','escape']){
   await openHistory(stage==='revision');await block(stage);
   const before=await page.evaluate(()=>(window as any).fixture.requests.length);
   if(closing==='close')await page.locator('#dialog .dialog-head [data-action="close-dialog"]').click();else await page.keyboard.press('Escape');
   await page.waitForFunction(()=>!(document.querySelector('#dialog') as HTMLDialogElement).open);await release();
   assert.equal(await page.locator('#dialog').evaluate(d=>(d as HTMLDialogElement).open),false);
   assert.equal(await page.evaluate(()=>(window as any).fixture.requests.length),before);
   // A new open owns a fresh display generation and can read the same report normally.
   await openHistory(stage==='revision');await page.locator('[data-action="benchmark-report"]').last().click();await page.getByText(stage==='revision'?'已人工采用的研究记录':'AI 研究候选 · 待人工采用',{exact:true}).waitFor();
   await page.locator('#dialog .dialog-head [data-action="close-dialog"]').click();
   checks.push({width,late_stage:stage,closing,no_late_reopen:true,no_followup_read:true,reopen_works:true,production_controller:true});
  }
  await openHistory();await block('candidate');await page.keyboard.press('Control+k');await page.locator('#global-search').waitFor();await release();assert.equal(await page.locator('#dialog-title').innerText(),'搜索');assert.equal(await page.locator('.account-research-analysis').count(),0);checks.push({width,other_dialog_identity_invalidates:true,real_search_keyboard:true});await page.keyboard.press('Escape');
  await openHistory();await block('job');await page.keyboard.press('Escape');await release(true);assert.equal(await page.locator('#dialog').evaluate(d=>(d as HTMLDialogElement).open),false);checks.push({width,late_error_does_not_reopen:true});
  await openHistory();await block('candidate');await page.getByRole('button',{name:'资料',exact:true}).click();await release();assert.equal(await page.getByRole('button',{name:'资料',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.account-research-analysis').count(),0);checks.push({width,study_tab_change_invalidates:true});await page.keyboard.press('Escape');
  await openHistory();await block('candidate');await page.evaluate(()=>(window as any).fixture.replaceSummary('更新后的当前报告，保留新的展示身份。'));await page.locator('[data-action="benchmark-report"]').last().click();await page.getByText('更新后的当前报告，保留新的展示身份。',{exact:true}).waitFor();await release();assert.equal(await page.getByText('更新后的当前报告，保留新的展示身份。',{exact:true}).count(),1);checks.push({width,new_report_not_overwritten:true});await page.keyboard.press('Escape');
  await openHistory(true);await block('revision');await page.locator('#dialog .dialog-head [data-action="close-dialog"]').click();
  await page.locator('[data-action="account-detail"][data-id="other-account-fixture"]').click();await page.getByRole('button',{name:'研究报告',exact:true}).click();await page.getByText('把对标经验变成下一篇可试的方法',{exact:true}).waitFor();await release();assert.match(await page.locator('#dialog-title').innerText(),/另一个测试账号/);assert.equal(await page.locator('.account-research-analysis').count(),0);checks.push({width,account_switch_invalidates:true});await page.keyboard.press('Escape');
  await openHistory();await block('job');await page.evaluate(()=>{location.hash='#create';});await page.waitForFunction(()=>(window as any).fixture.context.ui.page==='create');await page.evaluate(()=>{location.hash='#sources';});await page.waitForFunction(()=>(window as any).fixture.context.ui.page==='sources');const htmlBefore=await page.locator('#dialog').innerHTML();await release();assert.equal(await page.locator('#dialog').innerHTML(),htmlBefore);assert.equal(await page.locator('.account-research-analysis').count(),0);await page.keyboard.press('Escape');checks.push({width,page_navigation_invalidates:true,returned_page_does_not_revive_request:true});
  assert.deepEqual(errors,[]);await page.screenshot({path:join(artifacts,'late-safe-'+width+'.png'),fullPage:true});await page.close();
 }
 writeFileSync(join(artifacts,'checks.json'),JSON.stringify({fixture_only:true,live_provider:false,checks},null,2)+'\n');console.log(JSON.stringify({artifacts,checks}));
}finally{await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
