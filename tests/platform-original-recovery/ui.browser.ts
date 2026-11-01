import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const runtime = join(root, 'runtime/platform-original-recovery-r2/ui');
const evidence = process.env.PLATFORM_RECOVERY_EVIDENCE ? join(resolve(process.env.PLATFORM_RECOVERY_EVIDENCE), 'ui') : join(runtime, 'evidence');
mkdirSync(runtime, { recursive: true }); mkdirSync(evidence, { recursive: true });
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fixture = `
import {createContentDocumentsFeaturePort} from './apps/web/src/features/create/documents/index.ts';
import {waitForegroundGeneration} from './apps/web/src/features/create/ai-actions/index.ts';
import {createApprovedPageViews} from './apps/web/src/pages/approvedViews.ts';
import {createHttpClient} from './apps/web/src/transport/workbench-client.ts';
import {DraftRegistry} from './apps/web/src/transport/drafts.ts';
import {GenerationProgressMount} from './apps/web/src/components/generation-progress-mount.tsx';
import {createTemplateHelpers} from './apps/web/src/components/templateHelpers.ts';
import {initialUi} from './apps/web/src/app/view-model.ts';
import './apps/web/src/styles/approved.css';
import './apps/web/src/styles/generation-progress.css';
const settings=new URLSearchParams(location.search),sid=settings.get('sid'),scenario=settings.get('scenario')||'interrupted';
const root=document.querySelector('#root'),page=document.querySelector('#page'),dialog=document.querySelector('#dialog'),mount=new GenerationProgressMount();
const {esc,iconBtn}=createTemplateHelpers([]),abort=new AbortController();
const f=window.fixture={errors:[],last:null,active:false,foreground:null,view:null};
const client=createHttpClient('',undefined,(url,options)=>fetch(url,{...options,headers:{...options?.headers,'X-Fixture-Session':sid,'X-Fixture-Scenario':scenario}}));
const identity=await client.identity();const drafts=new DraftRegistry(client,identity,{getItem:()=>null,setItem(){},removeItem(){}});
const ui={...initialUi('create'),topic:'topic',editTab:'versions',platform:'wechat'};
function close(){f.active=false;f.foreground=null;mount.dispose();dialog.close();}
const surface={editorFeedback(){},toast(message){f.errors.push(message);},navigate(){},updateUi(patch){Object.assign(ui,patch);},isForegroundJobActive(id){return f.active&&f.foreground?.id===id&&dialog.open;},foregroundCloseReason(){return 'user_close';},closeDialog:close,presentDialog(data){
 const key=data.foregroundJob?.id??data.progressKey;
 const same=key&&data.generationProgress&&dialog.open&&mount.isMountedFor(key)&&f.last?.body===data.body&&f.last?.foot===data.foot;
 f.foreground=data.foregroundJob;f.active=!!data.foregroundJob;
 if(same){mount.update(data.generationProgress);f.last=data;return;}
 mount.dispose();f.last=data;dialog.innerHTML='<div class="dialog-head"><h2 id="dialog-title">'+esc(data.title)+'</h2>'+iconBtn('close','close-dialog','关闭弹窗')+'</div><div class="dialog-body">'+data.body+'</div><div class="dialog-foot">'+(data.foot??'')+'</div>';
 if(data.generationProgress&&key)mount.mount(dialog.querySelector('.dialog-body'),key,data.generationProgress);
 if(!dialog.open)dialog.showModal();
}};
const context={identity,client,drafts,ui,signal:abort.signal,surface};
const port=createContentDocumentsFeaturePort({loadBase:async()=>({provenance:'service',ui,projections:{},state:{topics:[],agent:'codex'},NEWS:[],KNOWLEDGE:[],files:new Map()})});
function render(view){f.view=view;page.innerHTML=createApprovedPageViews(view).create();}
async function load(){render(await port.load(context));}
root.addEventListener('click',async event=>{const button=event.target.closest('[data-action]');if(!button||button.disabled)return;const action=button.dataset.action;if(action==='close-dialog'){close();return;}if(!['regenerate-version','platform-tab','edit-tab'].includes(action))return;try{const result=await port.dispatch({action,dataset:{...button.dataset},fields:{}},context);if(result)render(result);}catch(error){f.errors.push(error.message);}});
dialog.addEventListener('cancel',()=>{f.active=false;f.foreground=null;mount.dispose();});
f.showFailure=()=>waitForegroundGeneration(context,{job_id:'job'},'制作平台版本');
f.dispose=()=>{abort.abort();close();drafts.dispose();};
await load();f.ready=true;
`;
const built = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'ts' }, bundle: true, write: false, outdir: runtime, platform: 'browser', format: 'esm', external: ['/workbench/*'], metafile: true, define: { 'process.env.NODE_ENV': '"production"' } });
const js = built.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
const css = built.outputFiles!.find(file => file.path.endsWith('.css'))!.text;
writeFileSync(join(runtime, 'fixture.js'), js); writeFileSync(join(runtime, 'fixture.css'), css);
writeFileSync(join(evidence, 'ui-build.json'), JSON.stringify({ source_root: root, js_sha256: sha(js), css_sha256: sha(css), inputs: Object.keys(built.metafile!.inputs).map(path => ({ path, sha256: sha(path === '<stdin>' ? fixture : readFileSync(join(root, path))) })), outputs: built.metafile!.outputs }, null, 2));
type Session = ReturnType<typeof state>;
function state(scenario: string) {
  const core = { document_id: 'core', head_revision_id: 'core-r1', version: 1, text: '受控核心稿：原稿和事实已经确认。', hash: 'core-hash', save_state: 'committed' };
  const doc = { document_id: 'document', head_revision_id: null as string | null, version: 1, text: '', hash: null as string | null, save_state: 'empty' };
  const other = { document_id: 'other-document', head_revision_id: 'other-r1', version: 1, text: '另一个平台的人工稿保持不变。', hash: 'other-hash', save_state: 'committed' };
  const variant = { id: 'variant', document_id: 'document', topic_id: 'topic', platform: 'wechat', format: 'article', status: 'empty', based_on_core_revision_id: 'core-r1', version: 1 };
  const topic = { id: 'topic', title: '受控长标题：原任务结果核对与稿件保留的实际入口', category: '个人思考', audience: '受控验证', angle: '', expected_effort_min: 10, status: 'active', version: 1, core_document_id: 'core', core, core_approval: { revision_id: 'core-r1' }, source_ids: [], variants: [variant, { id: 'other-variant', document_id: 'other-document', topic_id: 'topic', platform: 'x', format: 'text', status: 'ready', based_on_core_revision_id: 'core-r1', version: 1 }], shots: [], assets: [], preparation_plan_id: null };
  const job = { id: 'job', state: 'failed', version: 3, target_id: 'variant', kind: 'variant_generate', execution_mode: 'service_adapter', executor_id: 'codex', cancel_requested_at: null, input_manifest: JSON.stringify({ mode: 'initialize', targets: [{ document_id: 'document', base_revision_id: null, core_revision_id: 'core-r1' }] }) };
  const detail = { job, checkpoint: { agent_handle: { runtime_session_id: 'fixture-thread', runtime_turn_id: 'fixture-turn' } }, error: { code: 'RESULT_UNKNOWN', message: '受控原任务结果未确认', details: {} as Record<string, unknown> } as Record<string, unknown> | null, attempts: [], artifacts: [], receipts: [] as unknown[] };
  return { scenario, core, doc, other, variant, topic, job, detail, calls: [] as { method: string; url: string; body?: unknown }[] };
}
const sessions = new Map<string, Session>();
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname.startsWith('/workbench/')) { try { response.writeHead(200).end(readFileSync(join(root, 'apps/web/public', pathname))); } catch { response.writeHead(404).end(); } return; }
  if (pathname === '/fixture.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(js); return; }
  if (pathname === '/fixture.css') { response.writeHead(200, { 'Content-Type': 'text/css' }).end(css); return; }
  if (!pathname.startsWith('/api/')) { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" class="workbench-real" style="max-width:1320px;margin:auto;padding:16px"><p class="fine" style="margin-bottom:16px">隔离验证 · 仅使用自有合成任务，未更新日用工作台</p><div id="page"></div><dialog id="dialog" aria-labelledby="dialog-title"></dialog></main><script type="module" src="/fixture.js"></script></body></html>'); return; }
  const sid = String(request.headers['x-fixture-session'] ?? 'default'), scenario = String(request.headers['x-fixture-scenario'] ?? 'interrupted');
  let s = sessions.get(sid); if (!s) { s = state(scenario); sessions.set(sid, s); }
  let body: unknown; if (request.method !== 'GET') { const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part)); body = JSON.parse(Buffer.concat(parts).toString()); }
  s.calls.push({ method: request.method!, url: request.url!, ...(body ? { body } : {}) });
  const send = (value: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  if (pathname === '/api/v1/identity') { send({ workspace_id: 'fixture-workspace-' + sid, service_instance_id: 'fixture-service-' + sid }); return; }
  if (request.method === 'GET') {
    if (pathname === '/api/v1/topics') { send({ items: [{ ...s.topic, read_state: { core_revision_id: s.core.head_revision_id, core_version: s.core.version, core_confirmed: true, variants: s.topic.variants.map(v => ({ ...v, head_revision_id: v.id === 'variant' ? s.doc.head_revision_id : s.other.head_revision_id, document_version: 1 })) } }], next_cursor: null }); return; }
    if (pathname === '/api/v1/topics/topic') { send(s.topic); return; }
    if (pathname === '/api/v1/documents/core') { send(s.core); return; }
    if (pathname === '/api/v1/documents/document') { send(s.doc); return; }
    if (pathname === '/api/v1/documents/other-document') { send(s.other); return; }
    if (pathname === '/api/v1/jobs') { send({ items: [s.job], next_cursor: null }); return; }
    if (pathname === '/api/v1/jobs/job') { send(s.detail); return; }
  }
  if (request.method === 'POST' && pathname === '/api/v1/jobs/job/resume') {
    try { assert.deepEqual(body, { expected_version: s.job.version, recovery_action: 'query_original' }); } catch { send({ error: { code: 'VALIDATION_ERROR', message: 'fixture requires strict original query' } }, 400); return; }
    s.job.version++;
    if (s.scenario === 'interrupted') s.detail.error = { code: 'HOST_INTERRUPTED', message: '受控任务已中断', details: { original_result_unavailable: true } };
    else if (s.scenario === 'no-final') s.detail.error = { code: 'RESULT_UNKNOWN', message: '受控已结束任务缺完整结果', details: { original_result_unavailable: true, native_status: 'completed' } };
    else if (s.scenario === 'unknown') s.detail.error = { code: 'RESULT_UNKNOWN', message: '受控结果仍待核', details: { native_status: 'inProgress' } };
    else if (s.scenario === 'running') s.job.state = 'running';
    else {
      s.job.state = 'succeeded'; s.detail.error = null;
      const adopted = s.scenario === 'completed';
      s.detail.receipts = [{ state: 'committed', receipt_id: 'fixture-receipt', result_ids: { documents: [{ document_id: 'document', revision_id: 'result-r1', adopted, adoption_mode: adopted ? 'auto_initial' : null }] } }];
      s.doc.head_revision_id = adopted ? 'result-r1' : 'manual-r1'; s.doc.text = adopted ? '原结果的受控平台稿，已经通过原任务核对保存。' : '人工稿保留：这段内容不能被核对操作替换。'; s.doc.hash = 'saved-doc-hash'; s.doc.save_state = 'committed'; s.variant.status = adopted ? 'ready' : 'empty';
    }
    send(s.job); return;
  }
  send({ error: { code: 'NOT_FOUND', message: 'fixture forbids other operations' } }, 404);
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browserScope = process.env.UI_BROWSER_SCOPE ?? 'all', tailOnly = browserScope === 'tail';
const profile = mkdtempSync(join(runtime, 'browser-profile-')), browserTempDirectory = join(runtime, 'browser-temp');
mkdirSync(browserTempDirectory, { recursive: true }); process.env.TMPDIR = browserTempDirectory;
const browser = await chromium.launchPersistentContext(profile, { headless: true, downloadsPath: join(runtime, 'downloads'), tracesDir: join(runtime, 'traces') });
const browserConnection = browser.browser(), cdp = await browserConnection!.newBrowserCDPSession();
const processInfo = await cdp.send('SystemInfo.getProcessInfo'); await cdp.detach();
writeFileSync(join(evidence, 'browser-resources.json'), JSON.stringify({ fixture_pid: process.pid, http_port: (server.address() as { port: number }).port, profile, temp: browserTempDirectory, browser_processes: processInfo.processInfo, scope: browserScope }, null, 2));
const checks: unknown[] = [], errors: string[] = [];
try {
  for (const width of (tailOnly || browserScope === 'no-final' ? [] : browserScope === 'viewport390' ? [390] : [390, 768, 1440])) {
    const sid = 'viewport-' + width, page = await browser.newPage(); await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(address + '/?sid=' + sid + '&scenario=interrupted'); await page.waitForFunction(() => (window as any).fixture?.ready);
    const button = page.locator('#page').getByRole('button', { name: '核对原结果', exact: true }); await button.waitFor();
    await page.reload(); await page.waitForFunction(() => (window as any).fixture?.ready); await button.waitFor();
    assert.equal(await button.isEnabled(), true); assert.equal(await page.locator('#version-text').inputValue(), ''); assert.equal(await page.getByRole('button', { name: '安排发布', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'X', exact: true }).click(); await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('#version-text')?.value.includes('另一个平台')); await page.getByRole('button', { name: '公众号', exact: true }).click(); await button.waitFor(); assert.equal(await button.isEnabled(), true);
    await page.screenshot({ path: join(evidence, 'persistent-' + width + '.png'), fullPage: true });
    await page.evaluate(() => (window as any).fixture.showFailure());
    const query = page.locator('#dialog').getByRole('button', { name: '核对原结果', exact: true }); await query.waitFor(); await query.focus(); await page.keyboard.press('Enter');
    await page.locator('#dialog').getByText(/没有可回收的最终结果/).waitFor();
    const bounds = await page.locator('#dialog').boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(evidence, 'no-final-' + width + '.png'), fullPage: true });
    await page.keyboard.press('Escape'); await page.reload(); await page.waitForFunction(() => (window as any).fixture?.ready);
    assert.equal(await button.isDisabled(), true); await page.locator('#page').getByText(/没有可回收的最终结果/).waitFor();
    const s = sessions.get(sid)!; assert.deepEqual(s.calls.filter(call => call.method === 'POST').map(call => call.body), [{ expected_version: 3, recovery_action: 'query_original' }]);
    assert.equal(s.doc.text, ''); assert.equal(s.other.text, '另一个平台的人工稿保持不变。');
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.errors), []);
    checks.push({ group: 'persistent-popup-no-final', width, refresh_entry: true, other_platform_tab_return: true, empty_publish_disabled: true, keyboard_query: true, disabled_after_confirmed_no_final: true, no_overflow: true, strict_query_posts: 1, new_generation: 0, cancellations: 0 });
    await page.evaluate(() => (window as any).fixture.dispose()); await page.close();
  }
  for (const scenario of (browserScope === 'viewport390' ? [] : browserScope === 'no-final' ? ['no-final'] : browserScope === 'regression' ? ['manual', 'unknown', 'no-final'] : tailOnly ? ['running', 'no-final'] : ['completed', 'manual', 'unknown', 'running', 'no-final'])) {
    const sid = scenario, page = await browser.newPage(); await page.setViewportSize({ width: 390, height: 844 });
    page.on('pageerror', error => errors.push(error.message)); await page.goto(address + '/?sid=' + sid + '&scenario=' + scenario); await page.waitForFunction(() => (window as any).fixture?.ready);
    const posted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/v1/jobs/job/resume'));
    await page.locator('#page').getByRole('button', { name: '核对原结果', exact: true }).click(); await posted;
    if (scenario === 'completed') { await page.locator('#dialog').getByText('原结果已恢复到这个平台，稿件已保存。', { exact: true }).waitFor(); assert.match(await page.locator('#version-text').inputValue(), /受控平台稿/); }
    else if (scenario === 'manual') { await page.locator('#dialog').getByText(/没有替换当前稿/).waitFor(); assert.match(await page.locator('#version-text').inputValue(), /人工稿保留/); }
    else if (scenario === 'unknown') { await page.locator('#dialog').getByRole('button', { name: '核对原结果', exact: true }).waitFor(); assert.equal(await page.locator('#dialog').getByRole('button', { name: '核对原结果', exact: true }).isEnabled(), true); assert.equal(await page.locator('#version-text').inputValue(), ''); }
    else if (scenario === 'no-final') { await page.locator('#dialog').getByText(/没有可回收的完整最终结果/).waitFor(); assert.ok(!(await page.locator('#dialog').innerText()).includes('已中断')); assert.equal(await page.locator('#dialog').getByRole('button', { name: '核对原结果', exact: true }).isDisabled(), true); }
    else { const close = page.locator('#dialog').getByRole('button', { name: '停止查看', exact: true }); await close.waitFor(); await close.click(); await page.waitForTimeout(450); assert.equal(await page.locator('#dialog').evaluate((el: HTMLDialogElement) => el.open), false); }
    await page.screenshot({ path: join(evidence, (scenario === 'no-final' ? 'completed-no-final' : scenario) + '-390.png'), fullPage: true });
    const s = sessions.get(sid)!; assert.equal(s.calls.filter(call => call.method === 'POST').length, 1); assert.ok(s.calls.filter(call => call.method === 'POST').every(call => call.url.endsWith('/resume'))); assert.equal(s.other.text, '另一个平台的人工稿保持不变。');
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.errors), []);
    checks.push({ group: scenario, width: 390, strict_query_posts: 1, new_generation: 0, cancellations: 0 });
    await page.evaluate(() => (window as any).fixture.dispose()); await page.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, browserScope === 'all' ? 'browser-checks.json' : 'browser-' + browserScope + '-checks.json'), JSON.stringify({ result: 'passed', scope: 'isolated HTTP fixture + actual feature/template/progress UI bundle', checks, errors, sessions: [...sessions.entries()].map(([sid, s]) => ({ sid, scenario: s.scenario, calls: s.calls, document_bytes: Buffer.byteLength(s.doc.text), other_document_sha256: sha(s.other.text) })), real_native: 0, daily_api: 0, original_sql: 0 }, null, 2));
  console.log(JSON.stringify({ result: 'passed', groups: checks.length, screenshots: browserScope === 'all' ? 11 : browserScope === 'viewport390' ? 2 : browserScope === 'no-final' ? 1 : browserScope === 'regression' ? 9 : 2, errors }));
} catch (error) { writeFileSync(join(evidence, 'browser-failure.json'), JSON.stringify({ message: (error as Error).message, checks, errors }, null, 2)); throw error; }
finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  const stillAlive = processInfo.processInfo.filter(info => { try { process.kill(Number(info.id), 0); return true; } catch { return false; } });
  rmSync(profile, { recursive: true, force: true }); rmSync(browserTempDirectory, { recursive: true, force: true });
  writeFileSync(join(evidence, 'browser-closed.json'), JSON.stringify({ fixture_pid: process.pid, http_port: (server.address() as null), server_closed: !server.listening, browser_closed: true, still_alive_observed_processes: stillAlive, own_profile_removed: profile, own_temp_removed: browserTempDirectory }, null, 2));
}
