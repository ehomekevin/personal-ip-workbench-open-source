import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync, gzipSync } from 'node:zlib';

// 日用页面的静态资源：/assets/ 下是 vite 带内容哈希的文件，可长期强缓存；index.html 每次协商（ETag → 304）。
// 强缓存只给规范化后真实路径位于 assets/ 下、文件名带内容哈希的文件。可压缩类型按 Accept-Encoding 选 br/gzip：
// 优先构建时预压缩的 .br/.gz（首次使用时解压与源文件逐字节比对，结果随源文件版本缓存），否则按需压缩并缓存在内存。ETag 按实际响应字节计算。
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg']), MIN_COMPRESS_BYTES = 1024, MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable', REVALIDATE_CACHE = 'no-cache';
type Encoding = 'br' | 'gzip' | 'identity';
interface Representation { body: Buffer; etag: string }
/** 解析 Accept-Encoding：q=0 视为拒绝；同权重时 br 优先于 gzip。identity 未被显式排除（identity;q=0 或 *;q=0 且未单列）时总是可接受；都不可接受返回 null。 */
export function negotiateEncoding(header: string | string[] | undefined, compressible = true): Encoding | null {
  const weights = new Map<string, number>();
  for (const part of (Array.isArray(header) ? header.join(',') : header ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';'); if (!name) continue;
    const q = params.map(p => p.trim()).find(p => p.startsWith('q=')); const weight = q ? Number(q.slice(2)) : 1;
    weights.set(name, Number.isFinite(weight) ? weight : 0);
  }
  const of = (name: string) => weights.get(name) ?? weights.get('*') ?? 0;
  if (compressible) { const br = of('br'), gzip = of('gzip'); if (br > 0 && br >= gzip) return 'br'; if (gzip > 0) return 'gzip'; }
  const identity = weights.has('identity') ? weights.get('identity')! > 0 : weights.has('*') ? weights.get('*')! > 0 : true;
  return identity ? 'identity' : null;
}
const etagOf = (body: Buffer, encoding: Encoding) => '"' + createHash('sha256').update(body).digest('base64url').slice(0, 27) + (encoding === 'identity' ? '' : '-' + encoding) + '"';
function matches(header: string | undefined, etag: string) { return !!header && header.split(',').some(tag => { const value = tag.trim().replace(/^W\//, ''); return value === etag || value === '*'; }); }

export function createStaticHandler(webRootInput: string, options: { transformHtml?: (html: string) => string } = {}) {
  const webRoot = realpathSync(webRootInput), cache = new Map<string, Representation>(); let cachedBytes = 0;
  const inside = (path: string) => path.startsWith(webRoot + sep);
  function remember(key: string, value: Representation) {
    if (value.body.length > MEMORY_LIMIT_BYTES) return value;
    if (cachedBytes + value.body.length > MEMORY_LIMIT_BYTES) { cache.clear(); cachedBytes = 0; }
    cache.set(key, value); cachedBytes += value.body.length; return value;
  }
  // 原文件（html 先注入运行模式）作为 identity 表示；mtime+size 变化即视为新文件。
  function identity(actual: string, version: string): Representation {
    const key = 'identity\n' + actual + '\n' + version, hit = cache.get(key); if (hit) return hit;
    const raw = readFileSync(actual), body = extname(actual) === '.html' && options.transformHtml ? Buffer.from(options.transformHtml(raw.toString('utf8'))) : raw;
    return remember(key, { body, etag: etagOf(body, 'identity') });
  }
  function encoded(actual: string, version: string, encoding: Exclude<Encoding, 'identity'>, source: Representation): Representation {
    const key = encoding + '\n' + actual + '\n' + version, hit = cache.get(key); if (hit) return hit;
    // 预压缩文件只用于未经改写的资源（html 注入了运行模式，内容已不同于构建产物），且必须解压后与当前源文件逐字节一致。
    const sidecar = actual + (encoding === 'br' ? '.br' : '.gz');
    if (!(extname(actual) === '.html' && options.transformHtml) && existsSync(sidecar)) {
      const real = realpathSync(sidecar), info = statSync(real);
      if (inside(real) && info.isFile()) {
        const body = readFileSync(real); let same = false;
        try { same = (encoding === 'br' ? brotliDecompressSync(body) : gunzipSync(body)).equals(source.body); } catch { same = false; }
        if (same) return remember(key, { body, etag: etagOf(body, encoding) });
      }
    }
    const body = encoding === 'br' ? brotliCompressSync(source.body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: source.body.length } }) : gzipSync(source.body, { level: 9 });
    return remember(key, { body, etag: etagOf(body, encoding) });
  }
  /** 返回 false 表示路径不在页面根内或不是文件（调用方回 404）。 */
  return function serve(request: IncomingMessage, response: ServerResponse, pathname: string): boolean {
    const target = resolve(webRoot, pathname === '/' ? 'index.html' : '.' + decodeURIComponent(pathname));
    if (!inside(target) || !existsSync(target)) return false;
    const actual = realpathSync(target); if (!inside(actual)) return false;
    const info = statSync(actual); if (!info.isFile()) return false;
    const ext = extname(actual), version = info.mtimeMs + ':' + info.size, source = identity(actual, version);
    const rel = relative(webRoot, actual).split(sep), hashed = rel.length === 2 && rel[0] === 'assets' && HASHED_ASSET.test(basename(actual));
    const compressible = COMPRESSIBLE.has(ext) && source.body.length >= MIN_COMPRESS_BYTES, encoding = negotiateEncoding(request.headers['accept-encoding'], compressible);
    if (!encoding) { response.writeHead(406, { 'content-type': 'text/plain; charset=utf-8', vary: 'Accept-Encoding' }).end('没有可接受的内容编码'); return true; }
    const chosen = encoding === 'identity' ? source : encoded(actual, version, encoding, source);
    const headers: Record<string, string | number> = { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': hashed ? IMMUTABLE_CACHE : REVALIDATE_CACHE, etag: chosen.etag };
    if (compressible) headers.vary = 'Accept-Encoding'; if (encoding !== 'identity') headers['content-encoding'] = encoding;
    if (matches(request.headers['if-none-match'], chosen.etag)) { response.writeHead(304, headers).end(); return true; }
    headers['content-length'] = chosen.body.length; response.writeHead(200, headers);
    if (request.method === 'HEAD') response.end(); else response.end(chosen.body);
    return true;
  };
}
