import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const artifacts = join(root, '.ci-artifacts', 'generation-progress-' + new Date().toISOString().replaceAll(':', '-'));
mkdirSync(artifacts, { recursive: true });
const feedback = join(root, '.ci-artifacts', 'generation-feedback'); mkdirSync(feedback, { recursive: true });
const fixture = `
import { createRoot } from 'react-dom/client';
import { Workbench } from './apps/web/src/app/Workbench.tsx';
import { emptyIngestView } from './apps/web/src/features/sources/read/index.ts';
import { waitForegroundGeneration, readForegroundResult } from './apps/web/src/features/create/ai-actions/index.ts';
import { WritingFlowController } from './apps/web/src/features/create/writing-flow/index.ts';
import { DEFAULT_WRITING_EXECUTION } from './packages/contracts/src/index.ts';
import './apps/web/src/styles/approved.css';
import './apps/web/src/styles/today-continuation.css';
const identity={workspace_id:'orb-fixture',service_instance_id:'orb-fixture-service',contract_version:'fixture'};
// 球体只在 running 播放：前台任务先以 queued 静态态出现，首次轮询读到 running 后切换为动效。
const f=window.fixture={context:null,detail:{job:{state:'running',version:1}},cancelled:[],result:null,error:null};
const client={identity:async()=>identity,request:async(_method,path)=>{if(path==='/api/v1/settings')return {executors:[{executor_id:'codex',status:'unverified',auth_state:'QUOTA_EXHAUSTED'},{executor_id:'claude',status:'supported',auth_state:'subscription_authenticated'}]};if(f.pollFailure)throw new Error('fixture poll failure');if(!path.startsWith('/api/v1/jobs/'))throw new Error('Unregistered fixture request');return structuredClone(f.detail);},cancelJob:async(id,version)=>{f.cancelled.push({id,version});return {};}};
const host=createRoot(document.getElementById('root'));
host.render(<Workbench injection={{mode:'real',client,initialPage:'today',features:{today:{page:'today',load:async context=>{f.context=context;return emptyIngestView(context);},dispatch:async()=>{}}}}}/>);
f.start=(id='orb-fixture-job')=>{f.result=null;f.error=null;f.wait=waitForegroundGeneration(f.context,{job_id:id},'制作平台版本',()=>true,true).then(value=>f.result=value).catch(error=>f.error=error.name);};
f.finish=()=>readForegroundResult(f.context,{job_id:'orb-fixture-job'},async()=>({candidate:'fixture only'}));
f.unmount=()=>host.unmount();
f.writingRun=(state,o={})=>{const now=Date.now();return {schema_version:'writing-flow/1',id:'run-fixture-7f3a',version:1,topic_id:'topic',document_id:'core',input_revision_id:'rev-base',input_text_sha256:'h',instruction:'写清判断',executor:'codex',execution_policy:DEFAULT_WRITING_EXECUTION,source_ids:[],rule_snapshot:{id:'r',created_at:'now',files:[],skill:{name:'personal-ip-writing',version:'0.1.0',sha256:'h',content:'r'},scope:'本人'},export_target:null,created_at:'now',parent_run_id:null,phase:['queued','running'].includes(state)?'writing':'needs_attention',...(o.pending?{switch_pending:{executor:'claude',idempotency_key:'k',requested_at:'now'}}:{}),stages:[{stage:'writing',job_id:'job-w',document_id:'core',input_revision_id:'rev-base'}],decisions:[],adopted_revision_id:null,exports:[],candidate:null,review:null,input_draft:'',core_head:'rev-base',current_job:{id:'job-w',state,version:3,error:state==='waiting_quota'?{code:'QUOTA_EXHAUSTED',message:'Codex included usage 当前不可用'}:null,created_at:new Date(now-130000).toISOString(),started_at:new Date(now-(o.elapsed??95)*1000).toISOString(),last_output_at:o.output===undefined?null:new Date(now-o.output*1000).toISOString(),checkpoint:{agent_handle:{checkpoint:{writing_skills:[{name:'workbench-platform-adapt',version:'1.0.0',invocation:'codex_native_skill_input'},{name:'personal-ip-writing',version:'0.1.0',invocation:'codex_native_skill_input'}]}}}}};};
f.showWriting=(state,o)=>{f.writing??=new WritingFlowController({root:document.body,context:()=>f.context,render:()=>{},active:()=>true});f.writing.topicId='topic';f.writing.showRun(f.writingRun(state,o));};
`;
const built = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, outdir: artifacts, jsx: 'automatic', platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' }, external: ['/workbench/*'] });
const javascript = built.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
const css = built.outputFiles!.find(file => file.path.endsWith('.css'))!.text;
const html = '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style><div id="root"></div><script type="module">' + javascript + '</script></html>';
const server = createServer((request, response) => {
  if (request.url?.startsWith('/workbench/')) {
    const file = request.url.slice('/workbench/'.length);
    if (!['icon.svg','avatar.svg'].includes(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.woff2') ? 'font/woff2' : 'image/webp' });
    response.end(readFileSync(join(root, 'apps/web/public/workbench', file))); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html);
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({ headless: true });
const checks: Record<string, unknown>[] = [], errors: string[] = [];
try {
  for (const width of [1440, 768, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 }, reducedMotion: 'no-preference' });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForFunction(() => !!(window as any).fixture.context);
    await page.evaluate(() => { const f=(window as any).fixture;f.start(); });
    await page.locator('.generation-orb-canvas').waitFor();
    await page.waitForFunction(() => (window as any).fixture.context.surface.isForegroundJobActive('orb-fixture-job'));
    await page.evaluate(() => { const f=(window as any).fixture; f.canvas=document.querySelector('.generation-orb-canvas'); f.container=document.querySelector('.generation-progress'); f.cancel=document.querySelector('[data-action="cancel-task"]'); f.detail={job:{state:'running',version:7},checkpoint:{agent_handle:{checkpoint:{writing_skills:[{name:'workbench-platform-adapt',version:'1.0.0',invocation:'codex_native_skill_input'},{name:'personal-ip-writing',version:'0.1.0',invocation:'codex_native_skill_input'}]}}}}; });
    await page.getByText('处理中', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => { const f=(window as any).fixture;return f.canvas===document.querySelector('.generation-orb-canvas')&&f.container===document.querySelector('.generation-progress')&&f.cancel===document.querySelector('[data-action="cancel-task"]'); }), true);
    const first = await page.locator('.generation-progress-visual').screenshot();
    await page.waitForTimeout(1500);
    const later = await page.locator('.generation-progress-visual').screenshot();
    assert.notDeepEqual(first, later, 'Internal swirl should animate');
    const layout = await page.evaluate(() => { const d=document.querySelector('#dialog')!.getBoundingClientRect(); return { overflow:document.documentElement.scrollWidth>innerWidth,dialogFits:d.left>=0&&d.right<=innerWidth }; });
    assert.equal(layout.overflow, false); assert.equal(layout.dialogFits, true);
    await page.screenshot({ path: join(artifacts, 'running-' + width + '.png'), fullPage: true });
    assert.equal(await page.getByText(/workbench-platform-adapt/).isVisible(), false, 'skill 链只在详情');assert.equal(await page.locator('.generation-progress-details').evaluate(d => (d as HTMLDetailsElement).open), false);
    await page.screenshot({ path: join(feedback, 'platform-running-' + width + '.png'), fullPage: true });
    await page.locator('[data-action="cancel-task"]').focus();
    await page.evaluate(() => { (window as any).fixture.detail={job:{state:'running',version:9}}; });
    await page.waitForTimeout(400);
    assert.equal(await page.locator('[data-action="cancel-task"]').evaluate(button => button === document.activeElement), true);
    await page.locator('[data-action="cancel-task"]').click();
    await page.waitForFunction(() => !(document.querySelector('#dialog') as HTMLDialogElement).open);
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.cancelled), [{ id: 'orb-fixture-job', version: 9 }]);
    assert.equal(await page.locator('.generation-orb-canvas').count(), 0);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#dialog').evaluate(dialog => (dialog as HTMLDialogElement).open), false);
    checks.push({ viewport:width,same_canvas:true,same_react_container:true,cancel_focus_preserved:true,cancel_version:9,animated:true,overflow:false });
    await page.close();
  }
  // 写作面板复用同一球体：queued 静态、running 动效 + 已用时间 + 最近输出、90 秒无输出提示、等待执行器与改用按钮；内部信息在默认收起的详情里。
  for (const width of [390, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 }, reducedMotion: 'no-preference' });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForFunction(() => !!(window as any).fixture.context);
    const dialog = page.locator('#dialog'), fits = async () => { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); const box = await dialog.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width); };
    await page.evaluate(() => (window as any).fixture.showWriting('queued'));
    await page.locator('.generation-progress[data-state="queued"] .generation-orb-static').waitFor(); assert.equal(await page.locator('canvas').count(), 0);
    await dialog.locator('.generation-progress-state').getByText('排队中', { exact: true }).waitFor(); await fits(); await page.screenshot({ path: join(feedback, 'writing-queued-' + width + '.png'), fullPage: true });
    await page.evaluate(() => (window as any).fixture.showWriting('running', { output: 12 }));
    await page.locator('.generation-orb-canvas').waitFor(); await dialog.getByText('写作中', { exact: true }).waitFor(); await dialog.getByText(/最近一次有输出 1\d 秒前/).waitFor(); await dialog.getByText(/已用时 01:3\d/).waitFor();
    for (const hidden of ['run-fixture-7f3a', 'gpt-6.1-sol', '最长 15 分钟', 'workbench-platform-adapt · v1.0.0 → personal-ip-writing · v0.1.0']) assert.equal(await dialog.getByText(hidden).isVisible(), false, hidden + ' 只在详情');
    assert.equal(await page.locator('.generation-progress-details').evaluate(d => (d as HTMLDetailsElement).open), false);
    await fits(); await page.screenshot({ path: join(feedback, 'writing-running-' + width + '.png'), fullPage: true });
    await page.evaluate(() => { (window as any).fixture.canvas = document.querySelector('.generation-orb-canvas'); (window as any).fixture.showWriting('running', { output: 3 }); });
    await dialog.getByText(/最近一次有输出 [3-5] 秒前/).waitFor();
    assert.equal(await page.evaluate(() => (window as any).fixture.canvas === document.querySelector('.generation-orb-canvas')), true, '输出时间刷新不重建 Canvas');
    await page.evaluate(() => (window as any).fixture.showWriting('running', { output: 120, elapsed: 400 }));
    await dialog.getByText('执行器较长时间无输出，可继续等待或取消', { exact: true }).waitFor(); assert.equal(await page.locator('.generation-orb-canvas').count(), 1);
    await fits(); await page.screenshot({ path: join(feedback, 'writing-stale-' + width + '.png'), fullPage: true });
    await dialog.locator('.generation-progress-details summary').click(); await dialog.getByText('workbench-platform-adapt · v1.0.0 → personal-ip-writing · v0.1.0').waitFor();
    await fits(); await page.screenshot({ path: join(feedback, 'writing-details-open-' + width + '.png'), fullPage: true });
    await page.evaluate(() => (window as any).fixture.showWriting('waiting_quota'));
    await dialog.locator('[data-action="wf-switch"][data-executor="claude"]').waitFor(); assert.equal((await dialog.locator('[data-action="wf-switch"]').textContent())?.trim(), '改用 Claude 重跑');
    await dialog.getByText('Codex 额度暂不可用，可改用 Claude 或稍后恢复', { exact: true }).waitFor(); await page.locator('.generation-progress[data-state="waiting"] .generation-orb-static').waitFor();
    assert.equal(await page.locator('canvas').count(), 0); assert.equal(await dialog.getByText('Codex included usage 当前不可用').isVisible(), false);
    await fits(); await page.screenshot({ path: join(feedback, 'writing-waiting-quota-' + width + '.png'), fullPage: true });
    await page.evaluate(() => (window as any).fixture.showWriting('cancelled', { pending: true }));
    await dialog.locator('[data-action="wf-switch"]').getByText('重试改用 Claude 重跑', { exact: true }).waitFor(); await dialog.getByText('原任务已取消，改用 Claude 重跑还没完成，可以重试', { exact: true }).waitFor();
    await fits(); await page.screenshot({ path: join(feedback, 'writing-switch-pending-' + width + '.png'), fullPage: true });
    await page.evaluate(() => { const f = (window as any).fixture; f.context.surface.closeDialog('completed'); f.context.ui.topic = 'topic'; return f.writing.dispatch('wf-new', { dataset: {} }); });
    const executor = dialog.locator('#wf-executor'); await executor.waitFor();
    assert.equal(await executor.inputValue(), 'claude'); assert.equal(await executor.locator('option[value="codex"]').isDisabled(), true); assert.equal((await executor.locator('option[value="codex"]').textContent())?.trim(), 'Codex · 额度暂不可用');
    await dialog.getByText('只对本次任务生效，不改设置里的默认执行器。', { exact: true }).waitFor();
    await fits(); await page.screenshot({ path: join(feedback, 'writing-executor-choice-' + width + '.png'), fullPage: true });
    await page.evaluate(() => (window as any).fixture.context.surface.closeDialog('completed'));
    checks.push({ viewport: width, executor_choice: true, writing_panel: true, queued_static: true, running_canvas: true, canvas_reused_on_output: true, stale_hint: true, details_collapsed: true, waiting_quota_switch: true, overflow: false });
    await page.close();
  }
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForFunction(() => !!(window as any).fixture.context);
    await page.evaluate(() => (window as any).fixture.showWriting('running', { output: 12 }));
    await page.locator('.generation-progress[data-state="running"] .generation-orb-static').waitFor(); assert.equal(await page.locator('canvas').count(), 0);
    await page.screenshot({ path: join(feedback, 'writing-running-reduced-motion-390.png'), fullPage: true });
    checks.push({ writing_panel: true, reduced_motion_static: true }); await page.close();
  }
  for (const mode of ['close', 'escape', 'success', 'failed', 'waiting_input', 'poll-error', 'replacement', 'host-unmount', 'context-lost', 'reduced-motion', 'no-webgl'] as const) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: mode==='reduced-motion'?'reduce':'no-preference' });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ block }) => {
      const f:{contexts:WebGLRenderingContext[];pendingFrames:Set<number>;deletedBuffers:number;deletedPrograms:number;deletedShaders:number;observers:number}=(window as any).__orbResources={contexts:[],pendingFrames:new Set<number>(),deletedBuffers:0,deletedPrograms:0,deletedShaders:0,observers:0};
      const context=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(this:HTMLCanvasElement,kind:string,...args:any[]){if(block&&kind==='webgl')return null;const result=(context as any).call(this,kind,...args);if(kind==='webgl'&&result&&!f.contexts.includes(result)){f.contexts.push(result);for(const [method,key] of [['deleteBuffer','deletedBuffers'],['deleteProgram','deletedPrograms'],['deleteShader','deletedShaders']] as const){const original=result[method].bind(result);result[method]=(...values:any[])=>{f[key]++;return original(...values);};}}return result; } as any;
      const request=requestAnimationFrame,cancel=cancelAnimationFrame;
      window.requestAnimationFrame=callback=>{const id=request(time=>{f.pendingFrames.delete(id);callback(time);});f.pendingFrames.add(id);return id;};
      window.cancelAnimationFrame=id=>{f.pendingFrames.delete(id);cancel(id);};
      const Original=ResizeObserver;window.ResizeObserver=class extends Original{constructor(callback:ResizeObserverCallback){super(callback);f.observers++;}disconnect(){f.observers--;super.disconnect();}};
    }, { block: mode==='no-webgl' });
    await page.goto(url); await page.waitForFunction(() => !!(window as any).fixture.context);
    await page.evaluate(() => (window as any).fixture.start());
    await page.locator('.generation-progress').waitFor();
    if (mode==='reduced-motion'||mode==='no-webgl') {
      await page.locator('.generation-orb-static').waitFor();
      assert.equal(await page.locator('canvas').count(),0);
      assert.equal(await page.evaluate(() => (window as any).__orbResources.pendingFrames.size),0);
      await page.screenshot({path:join(artifacts,mode+'.png'),fullPage:true});
    } else {
      await page.locator('.generation-orb-canvas').waitFor();
      await page.waitForFunction(() => (window as any).__orbResources.contexts.length===1);
      if(mode==='close')await page.locator('[data-action="close-dialog"]').click();
      if(mode==='escape')await page.keyboard.press('Escape');
      if(mode==='success'){
        await page.evaluate(() => { (window as any).fixture.detail={job:{state:'succeeded',version:8}}; });
        await page.getByText('候选已生成',{exact:true}).waitFor();
        await page.locator('.generation-orb-static').waitFor();
        await page.evaluate(() => (window as any).fixture.finish());
      }
      if(mode==='failed'||mode==='waiting_input'){
        await page.evaluate(state => { (window as any).fixture.detail={job:{state,version:8},error:{message:'fixture 原始处理提示'}}; },mode);
        await page.getByText(mode==='failed'?'这次生成没有完成，可以重试；原稿已保留':'执行器需要登录，请在设置与连接登录后恢复',{exact:true}).waitFor();
        assert.equal(await page.getByText('fixture 原始处理提示').isVisible(),false,'原始报错只在详情');await page.screenshot({path:join(feedback,'platform-'+mode+'-390.png'),fullPage:true});
        await page.locator('.dialog-foot [data-action="close-dialog"]').click();
      }
      if(mode==='poll-error'){
        await page.evaluate(() => { (window as any).fixture.pollFailure=true; });
        await page.waitForFunction(() => (window as any).fixture.error==='Error');
        assert.equal(await page.locator('#dialog').evaluate(dialog=>(dialog as HTMLDialogElement).open),false);
      }
      if(mode==='replacement'){
        await page.evaluate(() => { const f=(window as any).fixture;f.context.surface.closeDialog('completed');f.start('orb-fixture-job-2'); });
        await page.waitForTimeout(400);
        assert.equal(await page.locator('#dialog').evaluate(dialog=>(dialog as HTMLDialogElement).open),true);
        assert.deepEqual(await page.evaluate(()=>(window as any).fixture.cancelled),[]);
        assert.equal(await page.locator('.generation-orb-canvas').count(),1);
        await page.evaluate(()=>(window as any).fixture.context.surface.closeDialog('completed'));
      }
      if(mode==='host-unmount')await page.evaluate(() => (window as any).fixture.unmount());
      if(mode==='context-lost'){
        await page.evaluate(() => (window as any).__orbResources.contexts[0].getExtension('WEBGL_lose_context').loseContext());
        await page.locator('.generation-orb-static').waitFor();
        await page.screenshot({path:join(artifacts,mode+'.png'),fullPage:true});
        assert.equal(await page.locator('[data-action="cancel-task"]').isEnabled(),true);
      }
      await page.waitForFunction(() => (window as any).__orbResources.pendingFrames.size===0);
      const resources=await page.evaluate(() => {const f=(window as any).__orbResources;return {deletedBuffers:f.deletedBuffers,deletedPrograms:f.deletedPrograms,deletedShaders:f.deletedShaders,observers:f.observers,lost:f.contexts.every((gl:WebGLRenderingContext)=>gl.isContextLost())};});
      assert.equal(resources.deletedBuffers,mode==='replacement'?2:1);assert.equal(resources.deletedPrograms,mode==='replacement'?2:1);assert.equal(resources.deletedShaders,mode==='replacement'?4:2);assert.equal(resources.observers,0);assert.equal(resources.lost,true);
      assert.equal(await page.locator('.generation-orb-canvas').count(),0);
      if(['success','host-unmount','failed','waiting_input','poll-error','replacement'].includes(mode))assert.deepEqual(await page.evaluate(() => (window as any).fixture.cancelled),[]);
      if(mode==='close'||mode==='escape')assert.equal(await page.evaluate(() => (window as any).fixture.cancelled.length),1);
      checks.push({mode,...resources,pendingFrames:0});
    }
    if(mode==='reduced-motion'||mode==='no-webgl')checks.push({mode,static:true,canvas_count:0,pendingFrames:0});
    await page.close();
  }
  assert.deepEqual(errors,[]);
  writeFileSync(join(artifacts,'result.json'),JSON.stringify({result:'passed',implementation:'independent visual interpretation; not licensed React Bits Pro source',real_service_started:false,real_model_requests:0,real_platform_generation:0,checks,errors},null,2)+'\n');
  console.log('Generation progress browser checks passed: '+artifacts);
} finally { await browser.close(); await new Promise<void>(done=>server.close(()=>done())); }
