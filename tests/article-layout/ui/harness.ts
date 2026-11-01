import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import type { RequestContext, ServiceConfiguration } from '../../../packages/contracts/src/index.ts';
import { startApplication } from '../../../apps/service/src/bootstrap/application.ts';
import { createDocumentsModule } from '../../../apps/service/src/routes/documents.ts';
import { Documents } from '../../../packages/domain/src/documents/index.ts';
import { ArticleLayoutService } from '../../../packages/domain/src/article-layout/service.ts';
import { SqliteArticleLayoutRepository } from '../../../packages/storage/src/article-layout/index.ts';
import { reorderArticleBlocks, addArticleBrandBlock, updateArticleStyle, editArticleText } from '../../../packages/domain/src/article-layout/index.ts';

export const ARTICLE = '# 我把 AI 资讯接进工作台\n\n> 把资料、文案、配图和修改记录放在同一个工作台里。\n\n## 先把文章写清楚\n\n先确认文章要讲什么，再围绕定稿安排封面和正文图。图片需要帮助读者理解对应的内容。\n\n'+ '这是一段用于检查长文阅读和中文换行的真实隔离输入，文字完整保留，保存之后可以逐段修改。'.repeat(12) + '\n\n## 在同一处修改成品\n\n每次修改都保留内容与版式版本，不把旧结果放到新文章上。\n\n## 我的看法\n\n让读者理解文章，而不是让文字为模板让路。\n';
export async function startLayoutUiFixture(out: string) {
  out = resolve(out);
  const root = resolve(import.meta.dirname, '../../..'), workspace = join(out, 'workspace');
  const paths = { source_vault_root: null, managed_notes_root: join(workspace, 'notes'), state_root: join(workspace, 'state'), media_root: join(workspace, 'media') };
  for (const p of Object.values(paths)) if (p) mkdirSync(p, { recursive: true });
  const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: '正式排版叶子隔离验证', mode: 'real', timezone: 'America/Los_Angeles', paths, listen: { host: '127.0.0.1', port: 43958 }, default_executor: 'codex', api_fallback_enabled: false };
  const app = await startApplication(config, { port: 0, moduleFactories: [createDocumentsModule], executorHealth: async () => [] });
  const request = (key: string = randomUUID()): RequestContext => ({ ...app.identity, request_id: randomUUID(), idempotency_key: key, request_identity_ref: 'fixture-human-only' });
  const documents = new Documents(app.context), doc = await documents.create(request(), { kind: 'wechat-article', initial_text: ARTICLE });
  const image = readFileSync(join(root, 'tests/article-layout/visual/fixtures/original-standard.png')), imageHash = createHash('sha256').update(image).digest('hex');
  let fixtureImageVersion = 'fixture-adopted-v1';
  const service = new ArticleLayoutService(new SqliteArticleLayoutRepository(app.context.db), documents, { image_source: { async load(request, documentId) { const current = await documents.get(request, documentId); return { document_revision_id: current.head_revision_id, producer_version: 'explicit-fixture-r1', source_sha256: imageHash, images: [{ id: 'fixture-image-1', image: { asset_id: 'fixture-image-asset', version_id: fixtureImageVersion, sha256: imageHash, source_sha256: imageHash, url: '/fixture-image.png', pixel_width: 1200, pixel_height: 960 }, caption: '公众号标准 · 原版规范图' }] }; } } }), articleId = 'fixture-layout-article';
  let snapshot = await service.initialize(request(), { article_id: articleId, document_id: doc.document_id, upstream_review: { document_revision_id: doc.head_revision_id!, text_hash: createHash('sha256').update(ARTICLE).digest('hex'), review_id: 'fixture-upstream-review', status: 'passed' } });
  const adopted = await service.adoptImages(request(), articleId, { expected_version: snapshot.version }); if (adopted.state !== 'saved') throw new Error('fixture image adoption failed'); snapshot = adopted.snapshot;
  const imageOrder = [snapshot.order[0]!, 'fixture-image-1', ...snapshot.order.slice(1).filter(id => id !== 'fixture-image-1')];
  // Reorder through the domain so layout history stays bound to the current list.
  snapshot = reorderArticleBlocks(adopted.snapshot, imageOrder);
  snapshot = addArticleBrandBlock(snapshot, { id: 'fixture-brand-divider', kind: 'divider' }); snapshot = addArticleBrandBlock(snapshot, { id: 'fixture-brand-follow', kind: 'follow' });
  const seeded = await service.save(request(), articleId, { expected_version: adopted.snapshot.version, snapshot }); if (seeded.state !== 'saved') throw new Error('fixture initialization failed');
  let offline = false, hold = false, dropReceiptOnce = false, release: (() => void) | null = null; let delay: Promise<void> | null = null; const calls: Array<{ method: string; path: string; key: string | null }> = [];
  const source = `import {createRoot} from 'react-dom/client';import {ArticleLayoutStudio,ArticleReader} from './apps/web/src/features/media/article-layout/index.tsx';import {ArticleLayoutController} from './apps/web/src/features/media/article-layout/controller.ts';import {readArticleRenderStructure} from './apps/web/src/features/media/article-layout/render.ts';
const get=async()=>{const r=await fetch('/fixture/snapshot');if(!r.ok)throw Error('读取失败');return r.json()};const initial=await get();const port={load:get,save:async(input)=>{const r=await fetch('/fixture/save',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':input.idempotency_key},body:JSON.stringify(input)});if(!r.ok)throw Error('保存失败，当前修改已保留');return r.json()},check_unavailable_reason:'真实排版检查等待固定候选与两次运行派工。',confirm_unavailable_reason:'正式草稿交接等待公共接线；当前不会外写微信或 Wiki。'};const controller=new ArticleLayoutController(initial,port,localStorage,${JSON.stringify(app.identity)});const view=createRoot(document.querySelector('#root'));const reading=new URL(location.href).searchParams.get('reading');view.render(reading?<ArticleReader snapshot={initial}/>:<ArticleLayoutStudio controller={controller} standardUrl='/standard.png'/>);window.fixture={controller,structure:()=>readArticleRenderStructure(document.querySelector('.al-reader'),reading?initial:controller.state().snapshot),snapshot:()=>controller.state().snapshot,unmount:()=>{controller.dispose();view.unmount()}};`;
  const bundle = await build({ absWorkingDir: root, stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, outdir: out, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, external: ['/workbench/*'] });
  const js = bundle.outputFiles!.find(f => f.path.endsWith('.js'))!.text, css = bundle.outputFiles!.find(f => f.path.endsWith('.css'))!.text;
  writeFileSync(join(out, 'fixture-entry.tsx'), source); writeFileSync(join(out, 'fixture-bundle.js'), js); writeFileSync(join(out, 'fixture-bundle.css'), css);
  const server = createServer(async (req, res) => {
    const path = req.url?.split('?')[0] ?? '/';
    try {
      const chunks: Uint8Array[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      if (path.startsWith('/fixture/')) calls.push({ method: req.method!, path, key: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null });
      if (path === '/fixture/snapshot') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await service.load(request(), articleId))); return; }
      if (path === '/fixture/save') { if (offline) { res.statusCode = 503; res.end('{}'); return; } if (hold && delay) await delay; const result = await service.save(request(String(req.headers['idempotency-key'])), articleId, { expected_version: body.expected_version, snapshot: body.snapshot }); if (dropReceiptOnce) { dropReceiptOnce = false; res.statusCode = 503; res.end('{}'); return; } res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return; }
      if (path === '/fixture/control') {
        if ('offline' in body) offline = body.offline;
        if (body.drop_receipt_once) dropReceiptOnce = true;
        if (body.hold) { hold = true; delay = new Promise<void>(done => { release = done; }); }
        if (body.release) { hold = false; release?.(); }
        if (body.remote_style || body.deviation) { const current = await service.load(request(), articleId); const next = updateArticleStyle(current, body.deviation ? { body_size: 9, body_line_height: 1.1, text_color: '#ccf866', paragraph_gap: 2 } : { body_size: 17 }); await service.save(request(), articleId, { expected_version: current.version, snapshot: next }); }
        if (body.remote_text) { const current = await service.load(request(), articleId), id = current.blocks.find(b => 'text' in b && b.kind === 'paragraph' && b.text.length > 20)!.id; await service.save(request(), articleId, { expected_version: current.version, snapshot: editArticleText(current, id, body.remote_text) }); }
        if (body.remote_adopted) { fixtureImageVersion = 'fixture-adopted-v2'; const current = await service.load(request(), articleId); await service.adoptImages(request(), articleId, { expected_version: current.version }); }
        res.end('{}'); return;
      }
      if (path.startsWith('/workbench/')) { const leaf = path.slice(7); if (!/^[\w.-]+$/.test(leaf)) throw new Error('invalid brand path'); res.setHeader('Content-Type', leaf.endsWith('.svg') ? 'image/svg+xml' : leaf.endsWith('.webp') ? 'image/webp' : leaf.endsWith('.woff2') ? 'font/woff2' : 'image/png'); res.end(readFileSync(join(root, 'apps/web/public/workbench', leaf))); return; }
      if (path === '/fixture-image.png' || path === '/standard.png') { res.setHeader('Content-Type', 'image/png'); res.end(image); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#eef0fa}#root{max-width:1800px;margin:auto}' + css + '</style><div id="root"></div><script type="module">' + js + '</script></html>');
    } catch (error) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return { url: 'http://127.0.0.1:' + (server.address() as { port: number }).port, service, documents, request, articleId, calls, workspace, async close() { release?.(); await new Promise<void>(done => server.close(() => done())); await app.close(); } };
}
