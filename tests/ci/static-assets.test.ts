import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createStaticHandler, negotiateEncoding, IMMUTABLE_CACHE, REVALIDATE_CACHE } from '../../scripts/runtime/static-assets.ts';

const script = 'export const value = ' + JSON.stringify('工作台主包内容 '.repeat(400)) + ';\n';
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'static-assets-')), web = join(root, 'web'); mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<html><head><title>工作台</title></head><body>' + '<p>首屏</p>'.repeat(300) + '</body></html>');
  writeFileSync(join(web, 'assets', 'index-AbC123xy.js'), script);
  writeFileSync(join(web, 'assets', 'pre-XyZ789ab.js'), script); writeFileSync(join(web, 'assets', 'pre-XyZ789ab.js.br'), Buffer.concat([brotliCompressSync(script)]));
  writeFileSync(join(web, 'assets', 'stale-Q1q2q3q4.js'), script); writeFileSync(join(web, 'assets', 'stale-Q1q2q3q4.js.gz'), 'stale sidecar');
  const old = new Date(Date.now() - 3_600_000); utimesSync(join(web, 'assets', 'stale-Q1q2q3q4.js.gz'), old, old);
  writeFileSync(join(web, 'assets', 'wrong-Wr0ngSid.js'), script); writeFileSync(join(web, 'assets', 'wrong-Wr0ngSid.js.br'), brotliCompressSync('旧版本内容 '.repeat(500))); writeFileSync(join(web, 'assets', 'wrong-Wr0ngSid.js.gz'), 'not gzip');
  writeFileSync(join(web, 'assets', 'plain.js'), script); writeFileSync(join(web, 'top-AbCdEfGh.js'), script);
  writeFileSync(join(web, 'assets', 'tiny-T.css'), 'a{}'); writeFileSync(join(root, 'private.txt'), '页面根之外'); symlinkSync(join(root, 'private.txt'), join(web, 'escape.js'));
  const serve = createStaticHandler(web, { transformHtml: html => html.replace('</head>', '<meta name="workbench-mode" content="real"></head>') });
  const server = createServer((req, res) => { const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname; if (!serve(req, res, path)) res.writeHead(404).end(); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const port = (server.address() as { port: number }).port;
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((done, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => { const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => done({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) })); });
    req.once('error', reject); req.end();
  });
  return { web, get, async close() { await new Promise<void>(done => server.close(() => done())); rmSync(root, { recursive: true, force: true }); } };
}

test('Accept-Encoding 协商：br 优先，q=0 视为拒绝，未声明则不压缩', () => {
  assert.equal(negotiateEncoding('gzip, deflate, br, zstd'), 'br'); assert.equal(negotiateEncoding('gzip, br;q=0'), 'gzip'); assert.equal(negotiateEncoding('br;q=0.5, gzip'), 'gzip');
  assert.equal(negotiateEncoding(undefined), 'identity'); assert.equal(negotiateEncoding('identity'), 'identity'); assert.equal(negotiateEncoding('*'), 'br'); assert.equal(negotiateEncoding('*;q=0, gzip;q=0'), null); assert.equal(negotiateEncoding('br;q=0, gzip;q=0, identity;q=0'), null); assert.equal(negotiateEncoding('br;q=0, gzip;q=0'), 'identity');
  assert.equal(negotiateEncoding('*;q=0, identity'), 'identity'); assert.equal(negotiateEncoding('br', false), 'identity'); assert.equal(negotiateEncoding('identity;q=0', false), null);
});

test('带哈希资源强缓存 + br/gzip；二次请求带 ETag 返回 304；不压缩时原样返回', async () => {
  const f = await fixture();
  try {
    const br = await f.get('/assets/index-AbC123xy.js', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(br.status, 200); assert.equal(br.headers['cache-control'], IMMUTABLE_CACHE); assert.equal(br.headers['content-encoding'], 'br'); assert.equal(br.headers.vary, 'Accept-Encoding');
    assert.equal(br.headers['content-type'], 'text/javascript; charset=utf-8'); assert.equal(Number(br.headers['content-length']), br.body.length);
    assert.equal(brotliDecompressSync(br.body).toString('utf8'), script); assert.ok(br.body.length < Buffer.byteLength(script) / 5, '主包传输体积明显变小');
    const again = await f.get('/assets/index-AbC123xy.js', { 'accept-encoding': 'gzip, deflate, br', 'if-none-match': String(br.headers.etag) });
    assert.equal(again.status, 304); assert.equal(again.body.length, 0); assert.equal(again.headers['cache-control'], IMMUTABLE_CACHE);
    const gzip = await f.get('/assets/index-AbC123xy.js', { 'accept-encoding': 'gzip' });
    assert.equal(gzip.headers['content-encoding'], 'gzip'); assert.equal(gunzipSync(gzip.body).toString('utf8'), script); assert.notEqual(gzip.headers.etag, br.headers.etag);
    assert.equal((await f.get('/assets/index-AbC123xy.js', { 'accept-encoding': 'gzip', 'if-none-match': String(br.headers.etag) })).status, 200, '不同编码的 ETag 不互认');
    const plain = await f.get('/assets/index-AbC123xy.js');
    assert.equal(plain.headers['content-encoding'], undefined); assert.equal(plain.body.toString('utf8'), script); assert.equal(plain.headers.vary, 'Accept-Encoding');
    const head = await f.get('/assets/index-AbC123xy.js', { 'accept-encoding': 'br' }, 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), br.body.length);
    const tiny = await f.get('/assets/tiny-T.css', { 'accept-encoding': 'br' });
    assert.equal(tiny.headers['content-encoding'], undefined); assert.equal(tiny.headers.vary, undefined); assert.equal(tiny.body.toString(), 'a{}');
  } finally { await f.close(); }
});

test('优先使用构建时预压缩文件；预压缩文件解压后与源文件不一致（过期、错版、损坏）时改为按需压缩；ETag 按实际响应字节', async () => {
  const f = await fixture();
  try {
    const pre = await f.get('/assets/pre-XyZ789ab.js', { 'accept-encoding': 'br' });
    assert.deepEqual(pre.body, brotliCompressSync(script)); assert.equal(brotliDecompressSync(pre.body).toString('utf8'), script);
    assert.equal(pre.headers.etag, '"' + createHash('sha256').update(pre.body).digest('base64url').slice(0, 27) + '-br"', 'ETag 按实际响应字节计算');
    // 预压缩文件比源文件新但内容不是这一版（或根本解不开）：不用它，改为按需压缩。
    const wrongBr = await f.get('/assets/wrong-Wr0ngSid.js', { 'accept-encoding': 'br' }), wrongGz = await f.get('/assets/wrong-Wr0ngSid.js', { 'accept-encoding': 'gzip' });
    assert.equal(brotliDecompressSync(wrongBr.body).toString('utf8'), script); assert.equal(gunzipSync(wrongGz.body).toString('utf8'), script);
    assert.equal(wrongBr.headers.etag, '"' + createHash('sha256').update(wrongBr.body).digest('base64url').slice(0, 27) + '-br"');
    // 源文件重新构建后（预压缩文件未更新）不能继续用旧的预压缩结果。
    writeFileSync(join(f.web, 'assets', 'pre-XyZ789ab.js'), script + '// v2\n');
    assert.equal(brotliDecompressSync((await f.get('/assets/pre-XyZ789ab.js', { 'accept-encoding': 'br' })).body).toString('utf8'), script + '// v2\n');
    const stale = await f.get('/assets/stale-Q1q2q3q4.js', { 'accept-encoding': 'gzip' });
    assert.equal(stale.headers['content-encoding'], 'gzip'); assert.equal(gunzipSync(stale.body).toString('utf8'), script);
  } finally { await f.close(); }
});

test('index.html 每次协商（no-cache + ETag → 304），注入运行模式后再压缩；越界与链接仍 404', async () => {
  const f = await fixture();
  try {
    const page = await f.get('/', { 'accept-encoding': 'br' });
    assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], REVALIDATE_CACHE); assert.ok(page.headers.etag);
    assert.match(brotliDecompressSync(page.body).toString('utf8'), /<meta name="workbench-mode" content="real"><\/head>/);
    assert.equal((await f.get('/', { 'accept-encoding': 'br', 'if-none-match': String(page.headers.etag) })).status, 304);
    assert.equal((await f.get('/index.html', { 'if-none-match': String(page.headers.etag) })).status, 200, 'identity 表示的 ETag 与 br 不同');
    writeFileSync(join(f.web, 'index.html'), '<html><head></head><body>新版本入口' + 'x'.repeat(2000) + '</body></html>');
    const changed = await f.get('/', { 'accept-encoding': 'br', 'if-none-match': String(page.headers.etag) });
    assert.equal(changed.status, 200, '重新构建后 ETag 失效'); assert.match(brotliDecompressSync(changed.body).toString('utf8'), /新版本入口/);
    assert.equal((await f.get('/escape.js')).status, 404); assert.equal((await f.get('/assets/missing-1.js')).status, 404); assert.equal((await f.get('/assets')).status, 404);
    assert.equal((await f.get('/%2e%2e/private.txt')).status, 404);
    const sneaky = await f.get('/assets/..%2findex.html'); assert.ok(sneaky.status === 404 || sneaky.headers['cache-control'] === REVALIDATE_CACHE, '经 assets/ 前缀绕到 index.html 不能拿到强缓存');
    assert.equal((await f.get('/assets/plain.js')).headers['cache-control'], REVALIDATE_CACHE, 'assets/ 下不带内容哈希的文件不强缓存');
    assert.equal((await f.get('/top-AbCdEfGh.js')).headers['cache-control'], REVALIDATE_CACHE, '根目录文件即使像哈希名也不强缓存');
  } finally { await f.close(); }
});

test('所有编码（含 identity）都被显式排除时返回 406；identity 未被排除时照常 200', async () => {
  const f = await fixture();
  try {
    for (const header of ['br;q=0, gzip;q=0, identity;q=0', '*;q=0']) { const r = await f.get('/assets/index-AbC123xy.js', { 'accept-encoding': header }); assert.equal(r.status, 406, header); assert.equal(r.headers.vary, 'Accept-Encoding'); }
    assert.equal((await f.get('/assets/tiny-T.css', { 'accept-encoding': 'identity;q=0' })).status, 406, '不可压缩资源只有 identity 表示');
    const plain = await f.get('/assets/index-AbC123xy.js', { 'accept-encoding': 'br;q=0, gzip;q=0' });
    assert.equal(plain.status, 200); assert.equal(plain.headers['content-encoding'], undefined); assert.equal(plain.body.toString('utf8'), script);
    assert.equal((await f.get('/assets/index-AbC123xy.js', { 'accept-encoding': '*;q=0, gzip' })).headers['content-encoding'], 'gzip');
  } finally { await f.close(); }
});
