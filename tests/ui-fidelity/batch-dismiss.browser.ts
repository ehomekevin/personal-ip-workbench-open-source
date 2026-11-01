// 真实 Workbench 控制器：批量平台生成的进度弹窗打开后导航/关闭/Esc 只停止跟随不取消；显式“取消任务”才取消。
// 对照：单任务进度（未声明保留）导航仍取消。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const fixture = `
import { createRoot } from 'react-dom/client';
import { Workbench } from './apps/web/src/app/Workbench.tsx';
import { emptyIngestView } from './apps/web/src/features/sources/read/index.ts';
import { waitForegroundGeneration } from './apps/web/src/features/create/ai-actions/index.ts';
const identity={workspace_id:'batch-fixture',service_instance_id:'batch-fixture-service',contract_version:'fixture'};
const f=window.fixture={context:null,cancelled:[],reasons:[]};
const feature=page=>({page,load:async context=>{if(page==='today')f.context=context;return emptyIngestView(context);},dispatch:async()=>{}});
const client={identity:async()=>identity,request:async(_method,path)=>{if(path.startsWith('/api/v1/jobs?'))return {items:[]};if(!path.startsWith('/api/v1/jobs/'))throw new Error('Unregistered fixture request '+path);return {job:{state:'running',version:3}};},cancelJob:async(id,version)=>{f.cancelled.push({id,version});return {};}};
createRoot(document.getElementById('root')).render(<Workbench injection={{mode:'real',client,initialPage:'today',features:{today:feature('today'),sources:feature('sources')}}}/>);
f.start=(id,batch)=>{f.done=waitForegroundGeneration(f.context,{job_id:id},'制作平台版本 · 小红书（1/3）',()=>true,true,undefined,{keepWhenIrrelevant:batch,onDismiss:reason=>f.reasons.push(id+':'+reason)}).catch(()=>null);};
`;
const built = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, outdir: '/tmp/unused', jsx: 'automatic', platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' }, external: ['/workbench/*'], loader: { '.css': 'empty' } });
const javascript = built.outputFiles!.find(file => file.path.endsWith('.js'))!.text;
const html = '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="root"></div><script type="module">' + javascript + '</script></html>';
const server = createServer((request, response) => { if (request.url?.startsWith('/workbench/')) { response.writeHead(404).end(); return; } response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); });
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({ headless: true });
const results: Record<string, unknown> = {};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const open = async (id: string, batch: boolean) => { await page.evaluate(([job, keep]) => (window as any).fixture.start(job, keep), [id, batch] as const); await page.waitForFunction(job => (window as any).fixture.context.surface.isForegroundJobActive(job), id); await page.locator('[data-action="cancel-task"]').waitFor(); };
  const cancelled = () => page.evaluate(() => (window as any).fixture.cancelled.map((c: { id: string }) => c.id));
  // 模态弹窗打开时，导航来自地址栏/前进后退（hashchange）。
  const goto = async (route: string) => { await page.evaluate(hash => { location.hash = hash; }, route); await page.waitForTimeout(300); };
  await page.goto(url); await page.waitForFunction(() => !!(window as any).fixture.context);
  // 批量：导航离开不取消
  await open('batch-nav', true); await goto('sources');
  assert.deepEqual(await cancelled(), [], '批量进度导航不取消'); results.batch_navigate = 'not_cancelled'; await goto('today');
  // 批量：关闭按钮与 Esc 不取消
  await open('batch-escape', true); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  assert.deepEqual(await cancelled(), [], '批量进度 Esc 不取消'); results.batch_escape = 'not_cancelled';
  // 批量：显式取消按钮才取消
  await open('batch-cancel', true); await page.locator('[data-action="cancel-task"]').click(); await page.waitForTimeout(300);
  assert.deepEqual(await cancelled(), ['batch-cancel'], '显式取消才取消'); results.batch_cancel_button = 'cancelled';
  // 对照：单任务导航仍取消（原行为）
  await open('single-nav', false); await goto('sources');
  assert.deepEqual(await cancelled(), ['batch-cancel', 'single-nav'], '单任务导航保持原取消行为'); results.single_navigate = 'cancelled';
  // pagehide（离开/进入 bfcache）：批次任务不取消，原因记为 navigate，弹窗关闭不再续跟。
  await goto('today'); await page.waitForFunction(() => (window as any).fixture.context?.ui?.page === 'today' && !(window as any).fixture.context.signal.aborted);
  await open('batch-pagehide', true); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))); await page.waitForTimeout(300);
  assert.deepEqual(await cancelled(), ['batch-cancel', 'single-nav'], 'pagehide 不取消批次任务'); assert.equal(await page.locator('#dialog').evaluate(d => (d as HTMLDialogElement).open), false);
  results.batch_pagehide = 'not_cancelled';
  // 批次停止原因：取消按钮为 cancel（只取消当前任务、批次继续）；导航与 Esc 为停止跟随。
  const reasons = await page.evaluate(() => (window as any).fixture.reasons as string[]);
  assert(reasons.includes('batch-cancel:cancel'), reasons.join(',')); assert(reasons.includes('batch-pagehide:navigate'), reasons.join(',')); assert(reasons.includes('batch-escape:escape'), reasons.join(','));
  assert(reasons.some(reason => reason.startsWith('batch-nav:') && !reason.endsWith(':cancel')), reasons.join(','));
  results.dismiss_reasons = reasons;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, results }));
} finally { await browser.close(); server.close(); }
