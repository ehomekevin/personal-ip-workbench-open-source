import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

test('existing C1 panel at 390/768/1440 saves before render, separates 15 local checks, shows unknown original query and locates visual issues', async () => {
  const root = resolve(import.meta.dirname, '../../..'), base = join(root, 'runtime/main-r5-renderer-ui'); await mkdir(base, { recursive: true }); const out = await mkdtemp(join(base,'run-'));
  await build({ stdin: { resolveDir: root, sourcefile: 'renderer-ui-fixture.tsx', loader: 'tsx', contents: `
import './apps/web/src/styles/approved.css';
import './apps/web/src/features/media/image-studio/styles.css';
import { ArticleLayoutPanel } from './apps/web/src/features/media/article-layout/c1-panel.tsx';
import { createArticleLayout, currentArticleBinding } from './packages/domain/src/article-layout/index.ts';
const signal=new AbortController().signal, calls=[]; let job=null;
let saved=createArticleLayout({article_id:'ui-article',document_id:'doc',document_revision_id:'doc-v1',text:'# 当前文章标题\\n\\n> 先看当前图文效果。\\n\\n## 第一节\\n\\n这段正文用于检查保存、刷新和视觉问题定位。\\n\\n'+ '长段落需要在手机阅读时保持完整。'.repeat(25)});
const view=()=>({topic_id:'topic',topic_title:'当前文章标题',snapshot:structuredClone(saved),images:{state:'synced',count:0,final_confirmed_at:null,credit_missing:[],credit_pending:[]}});
const status=()=>({available:true,reason:null,latest:job});
const port={open:async()=>view(),load:async()=>view(),save:async(_topic,input)=>{calls.push('save'); saved=structuredClone(input.snapshot);saved.version=input.expected_version+1;return{state:'saved',snapshot:structuredClone(saved)}},syncImages:async()=>view(),confirm:async()=>view(),image:async()=>'',visualStatus:async()=>{calls.push('status');return status()},visualRender:async(_topic,version)=>{calls.push('render:'+version);return{render_id:'render-1',topic_id:'topic',snapshot_version:version,context_sha256:'a'.repeat(64),created_at:new Date().toISOString()}},visualCheck:async(_topic,version)=>{calls.push('check:'+version);job={topic_id:'topic',job_id:'job-original',attempt_id:'attempt-original',render_id:'render-1',snapshot_version:version,context_sha256:'a'.repeat(64),state:'unknown',phase:'unknown',result:null,current:true,can_query:true,error:null};return structuredClone(job)},visualQuery:async(_topic,id)=>{calls.push('query:'+id);const b=saved.blocks.find(b=>b.kind==='paragraph');saved.active_render={snapshot_sha256:'b'.repeat(64),block_structure_sha256:'c'.repeat(64)};job={...job,state:'completed',phase:'completed',can_query:false,result:{binding:{...currentArticleBinding(saved),render_snapshot_sha256:'b'.repeat(64),block_structure_sha256:'c'.repeat(64)},verdict:'issues',issues:[{id:'issue-1',block_id:b.id,location:'正文第1段',category:'spacing',problem:'段距需要核对',standard_ref:'示例用户标准 · 段距20px',suggestion:'核对正文段落的下边距',uncertainty:null}],uncertainties:[]}};return structuredClone(job)},visualCancel:async()=>{calls.push('cancel');job={...job,state:'cancelled',can_query:false};return job}};
const panel=new ArticleLayoutPanel({root:document.getElementById('root'),context:()=>({identity:{workspace_id:'ui-workspace',service_instance_id:'ui-service'},signal,client:{}}),active:()=>true,signal,toast:()=>{},backToImages:()=>{}},port);
window.fixture={calls,panel,saved:()=>saved,close:()=>panel.close()};panel.open('topic');
` }, bundle: true, external: ['/workbench/*'], format: 'esm', outfile: join(out,'fixture.js'), sourcemap: false, define: { 'process.env.NODE_ENV': '"production"' } });
  await writeFile(join(out,'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><main id="root"><div id="content"><div class="page"></div></div></main><script type="module" src="/fixture.js"></script></body></html>');
  const server = createServer(async (req,res) => { try { const path = new URL(req.url ?? '/', 'http://fixture').pathname, file = path.startsWith('/workbench/') ? join(root,'apps/web/public',path.slice(1)) : join(out,path === '/' ? 'index.html' : path.slice(1)); const body=await readFile(file);res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'} as Record<string,string>)[extname(file)] ?? 'application/octet-stream');res.end(body); } catch { res.statusCode=404;res.end(); } });
  await new Promise<void>(done => server.listen(0,'127.0.0.1',done)); const addr=server.address();assert.ok(addr && typeof addr !== 'string');
  const browser = await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true }); const results: unknown[]=[];
  try { for (const width of [390,768,1440]) {
    const page=await browser.newPage({ viewport:{width,height:1000} }); const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    try {
      await page.goto('http://127.0.0.1:'+addr.port); await page.getByRole('tab',{name:'排版检查'}).click(); await page.getByRole('button',{name:'保存并检查当前排版'}).waitFor();
      assert.equal(await page.locator('[data-rule]').count(),15);
      const editable=page.locator('.alc-reader [data-text-block]').nth(3);await editable.fill('本次修改必须先保存再进入视觉检查。');
      await page.getByRole('button',{name:'保存并检查当前排版'}).click(); await page.getByText('原任务结果待查询',{exact:true}).waitFor();
      const calls=await page.evaluate(()=> (window as any).fixture.calls as string[]), renderIndex=calls.findIndex(x=>x.startsWith('render:'));
      assert.ok(renderIndex>0 && calls.slice(0,renderIndex).includes('save')); assert.ok(calls[renderIndex+1]!.startsWith('check:'));
      await page.waitForTimeout(1700); assert.equal((await page.evaluate(()=> (window as any).fixture.calls as string[])).filter(x=>x.startsWith('query:')).length,0);
      await page.screenshot({path:join(out,'unknown-'+width+'.png'),fullPage:true});
      await page.getByRole('button',{name:'查询原任务'}).click();await page.getByText('段距需要核对',{exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('.alc-visual .button.primary')?.disabled);
      await page.locator('.alc-visual').getByRole('button',{name:/定位到/}).click(); assert.ok(await page.locator('.alc-reader .alc-block.is-selected').count());
      assert.equal(await page.locator('[data-rule]').count(),15);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:join(out,'issues-'+width+'.png'),fullPage:true});
      await editable.fill('继续修改之后，旧视觉结果不能当作当前排版。');await page.getByText('这份结果对应之前的排版；保存后可检查当前版本。',{exact:true}).waitFor();
      const finalCalls=await page.evaluate(()=> (window as any).fixture.calls as string[]); assert.equal(finalCalls.filter(x=>x==='query:job-original').length,1); assert.equal(finalCalls.filter(x=>x.startsWith('check:')).length,1); assert.deepEqual(errors,[]);
      results.push({width,passed:true,save_before_render:true,local_checks:15,explicit_original_query:true,issue_location:true,stale_after_edit:true,errors});
    } finally {await page.evaluate(()=> (window as any).fixture.close()).catch(()=>{});await page.close();}
  } } finally {await browser.close();await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));}
  await writeFile(join(base,'latest-result.json'),JSON.stringify({out,results,model_calls:0,scope:'controlled existing C1 panel, no provider or full service integration, OS IME not_run'},null,2));
});
