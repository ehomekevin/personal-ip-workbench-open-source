import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import type { ApplicationContext } from '../../../packages/domain/src/ports/index.ts';
import type { ArticleLayoutVisualContext, ArticleImageBlock } from '../../../packages/contracts/src/article-layout.ts';
import { createArticleLayout, canonicalJson, captionDisplayText } from '../../../packages/domain/src/article-layout/index.ts';
import { ArticleLayoutRenderer, ARTICLE_LAYOUT_RENDERER_VERSION } from '../../../apps/service/src/bootstrap/article-layout-renderer.ts';
import { validateLayoutVisualInput } from '../../../packages/adapters/src/media/layout-check/input.ts';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

test('owned Chrome renders actual C1 Reader, complete long 390px article, canonical captions, fallback title and immutable inputs', async () => {
  const beforeProfiles = (await readdir(tmpdir())).filter(name => name.startsWith('workbench-layout-chrome-')).sort();
  const root = resolve(import.meta.dirname, '../../..'), base = join(root, 'runtime/main-r5-renderer'); await mkdir(base, { recursive: true });
  const out = await mkdtemp(join(base, 'run-')), media = join(out, 'media'); await mkdir(media);
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE assets(id TEXT,workspace_id TEXT,file_path TEXT,sha256 TEXT,size_bytes INTEGER,mime TEXT,status TEXT)');
  const bytes = await readFile(join(root, 'tests/article-layout/visual/fixtures/original-standard.png')), assetPath = join(media, 'actual.png'); await writeFile(assetPath, bytes);
  db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?)').run('image-one','renderer-workspace',assetPath,sha(bytes),bytes.length,'image/png','ready');
  const snapshot = createArticleLayout({ article_id: 'renderer-article', document_id: 'doc', document_revision_id: 'source-v1', text: '> 保留完整导读。\n\n一、中文序号小节\n\n' + Array.from({ length: 65 }, (_, n) => '第' + n + '段：' + '这段中文用于核对连续自然高度，保留每一行文字与末段，不裁切内容。'.repeat(4)).join('\n\n') + '\n\n末段标记：完整保留到这里。' });
  const image: ArticleImageBlock = { id: 'image-caption', kind: 'image', image: { asset_id: 'image-one', version_id: 'adopted-v1', sha256: sha(bytes), url: 'https://example.invalid/should-never-be-fetched', pixel_width: bytes.readUInt32BE(16), pixel_height: bytes.readUInt32BE(20), source_sha256: sha('source'), credit: { label: '示例来源', url: 'https://www.example.com/original/page' } }, caption: '解释图片 · 图源：示例来源（https://www.example.com/original/page）', original_caption: '原图注', display_width_percent: 100 };
  const only = structuredClone(image); only.id = 'image-credit-only'; only.caption = '   · 图源：示例来源（example.com）';
  const legacy = structuredClone(image); legacy.id = 'image-legacy'; delete legacy.image.credit; legacy.caption = '旧图注 · 图源：旧来源（https://www.example.org/source）';
  snapshot.blocks.push(image, only, legacy); snapshot.order.splice(2, 0, image.id, only.id, legacy.id);
  const context = { identity: { workspace_id: 'renderer-workspace' }, db, paths: { media_root: media } } as ApplicationContext;
  const visual: ArticleLayoutVisualContext = { schema_version: 'article-layout-visual-context.v2', workspace_id: 'renderer-workspace', topic_id: 'topic', topic_title: '正文外的主题标题', snapshot_version: snapshot.version, content_revision_id: snapshot.content_revision_id, layout_revision_id: snapshot.layout_revision_id, text_hash: snapshot.text_hash, images_hash: snapshot.images_hash, source: { topic_id: 'topic', document_id: 'doc', document_revision_id: 'source-v1', final_id: 'final-v1', paragraph_blocks: {}, synced_at: new Date().toISOString() }, rules_version: 'fixture-rules', renderer_version: ARTICLE_LAYOUT_RENDERER_VERSION, snapshot_sha256: sha(canonicalJson(snapshot)) };
  const requests: string[] = [], server = createServer(async (request, response) => {
    requests.push(request.url ?? ''); try { const pathname = new URL(request.url ?? '/', 'http://local').pathname, path = join(root, 'apps/web/dist', pathname === '/' ? 'index.html' : pathname.slice(1)), content = await readFile(path); response.setHeader('content-type', ({ '.html':'text/html','.css':'text/css','.js':'text/javascript','.woff2':'font/woff2','.png':'image/png' } as Record<string,string>)[extname(path)] ?? 'application/octet-stream'); response.end(content); } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const renderer = new ArticleLayoutRenderer(context, { web_url: 'http://127.0.0.1:' + address.port, standard_png: join(root,'tests/article-layout/visual/fixtures/original-standard.png'), standard_html: join(root,'tests/article-layout/visual/fixtures/original-standard.html') });
  try {
    const input = await renderer.render(snapshot, visual, join(out, 'normal'), new AbortController().signal); validateLayoutVisualInput(input);
    assert.equal(input.render_pngs[0]!.width, 390); assert.ok(input.render_pngs.length > 1); assert.ok(input.render_pngs.at(-1)!.height > 0);
    assert.equal(input.blocks[0]!.id, '__topic_title__'); assert.equal(input.blocks[0]!.text, visual.topic_title);
    assert.equal(input.blocks.find(b => b.id === snapshot.order.at(-1))!.text, '末段标记：完整保留到这里。');
    assert.equal(input.blocks.find(b => b.id === image.id)!.image!.caption_display, captionDisplayText(image));
    assert.equal(input.blocks.find(b => b.id === only.id)!.image!.caption_display, captionDisplayText(only));
    assert.equal(input.blocks.find(b => b.id === legacy.id)!.image!.caption_display, captionDisplayText(legacy));
    assert.ok(input.blocks.every(b => b.bounds.x === 16 && b.bounds.width === 358));
    assert.equal(input.blocks.find(b => b.text === '一、中文序号小节')!.kind, 'heading');
    const standardStyles = input.blocks.filter(b => ['lead','heading','paragraph','image'].includes(b.kind)).map(b => ({kind:b.kind,id:b.id,style:b.computed_style}));
    await writeFile(join(out,'standard-computed-styles.json'),JSON.stringify({renderer:ARTICLE_LAYOUT_RENDERER_VERSION,styles:standardStyles},null,2));
    const lead = input.blocks.find(b => b.kind === 'lead')!.computed_style, heading = input.blocks.find(b => b.kind === 'heading')!.computed_style;
    assert.equal(lead.background_color,'rgb(244, 245, 252)');assert.equal(lead.color,'rgb(75, 87, 131)');assert.equal(lead.font_weight,'500');assert.equal(heading.font_weight,'900');
    assert.equal(input.blocks.find(b => b.kind === 'image')!.computed_style.color,'rgb(75, 87, 131)');
    assert.equal(input.blocks.find(b => b.kind === 'paragraph')!.computed_style.color,'rgb(11, 31, 82)');
    const custom = structuredClone(snapshot);custom.style.panel_color='#e0f0df';custom.style.muted_color='#334466';custom.style.body_size=17;custom.style.body_line_height=2;
    const customInput = await renderer.render(custom,{...visual,snapshot_sha256:sha(canonicalJson(custom))},join(out,'custom-local-colors'),new AbortController().signal);
    const customLead=customInput.blocks.find(b=>b.kind==='lead')!.computed_style;
    assert.equal(customLead.background_color,'rgb(224, 240, 223)');assert.equal(customLead.color,'rgb(51, 68, 102)');assert.equal(customLead.font_size,'17px');assert.equal(customLead.line_height,'34px');
    assert.equal(customInput.blocks.find(b=>b.kind==='image')!.computed_style.color,'rgb(51, 68, 102)');
    assert.equal(custom.text_hash,snapshot.text_hash);assert.equal(custom.images_hash,snapshot.images_hash);assert.deepEqual(custom.order,snapshot.order);assert.deepEqual(custom.blocks,snapshot.blocks);
    await writeFile(join(out,'custom-computed-styles.json'),JSON.stringify(customInput.blocks.map(b=>({kind:b.kind,id:b.id,style:b.computed_style})),null,2));
    assert.ok(!requests.some(url => url.startsWith('/api/') || url.includes('example.')));
    const corrupt = { ...visual, snapshot_sha256: 'f'.repeat(64) };
    await assert.rejects(renderer.render(snapshot, corrupt, join(out,'bad-context'), new AbortController().signal), /上下文/);
    const wrongPixel = structuredClone(snapshot); const wrongImage = wrongPixel.blocks.find(b => b.id === image.id)! as ArticleImageBlock; wrongImage.image.pixel_height++;
    await assert.rejects(renderer.render(wrongPixel, { ...visual, snapshot_sha256: sha(canonicalJson(wrongPixel)) }, join(out,'bad-pixels'), new AbortController().signal), /图片.*(?:像素|尺寸)/);
    const cancelled = new AbortController(); cancelled.abort(new Error('fixture cancel'));
    await assert.rejects(renderer.render(snapshot, visual, join(out,'aborted'), cancelled.signal), /fixture cancel/);
    const midRender = new AbortController(), abortTimer = setTimeout(() => midRender.abort(new Error('fixture active cancel')), 150);
    try { await assert.rejects(renderer.render(snapshot, visual, join(out,'cancelled-active'), midRender.signal)); } finally { clearTimeout(abortTimer); }
    await writeFile(join(base,'latest-result.json'), JSON.stringify({ passed: true, output: out, slices: input.render_pngs.map(s => ({ width:s.width,height:s.height,offset_y:s.offset_y })), block_count: input.blocks.length, full_height: input.render_pngs.reduce((n,s)=>n+s.height,0), fallback_title:true, canonical_captions:true, network_requests:requests, native_calls:0 }, null,2));
  } finally { await renderer.close(); await new Promise<void>((done,reject) => server.close(error => error ? reject(error) : done())); db.close(); }
  await assert.rejects(renderer.render(snapshot, visual, join(out,'closed'), new AbortController().signal), /已关闭/);
  await new Promise(done => setTimeout(done, 200));
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('workbench-layout-chrome-')).sort(), beforeProfiles, 'owned profiles must be fully removed after Chrome exits');
});
