import { createServer, request as proxyRequest, type Server } from 'node:http';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfiguration } from '../../apps/service/src/bootstrap/config.ts';
import { startApplication } from '../../apps/service/src/bootstrap/application.ts';
import type { ModuleFactory } from '../../packages/domain/src/ports/index.ts';
import { startCollectionSetup } from './collection-setup.ts';
import { createStaticHandler } from './static-assets.ts';

export async function startLocalWorkbench(configPath: string, options: { webPort: number; webRoot: string; moduleFactories?: ModuleFactory[]; collectionSetupPort?: number }) {
  if (!isAbsolute(options.webRoot) || !existsSync(resolve(options.webRoot, 'index.html'))) throw new Error('工作台生产页面尚未构建');
  if (!Number.isSafeInteger(options.webPort) || options.webPort < 0 || options.webPort > 65535) throw new Error('工作台页面端口无效');
  const config = loadConfiguration(configPath);
  if (config.mode !== 'real') throw new Error('日用入口必须使用独立 real 工作区');
  const serveStatic = createStaticHandler(realpathSync(options.webRoot), { transformHtml: html => html.replace('</head>', '<meta name="workbench-mode" content="real"></head>') });
  const application = await startApplication(config, options.moduleFactories ? { moduleFactories: options.moduleFactories } : {});
  let web: Server | undefined;
  let setup: Awaited<ReturnType<typeof startCollectionSetup>> | undefined;
  try {
    if (options.collectionSetupPort !== undefined) setup = await startCollectionSetup(config.paths.state_root, options.collectionSetupPort);
    web = createServer((request, response) => {
      try {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        const origin = request.headers.origin;
        if (origin && !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) { response.writeHead(403).end('只接受本机工作台请求'); return; }
        if (path.startsWith('/api/') || path === '/health') {
          const upstream = proxyRequest({ hostname: '127.0.0.1', port: application.address.port, path: request.url, method: request.method,
            headers: { ...request.headers, host: '127.0.0.1:' + application.address.port, connection: 'close' } }, incoming => {
            response.writeHead(incoming.statusCode ?? 502, { ...incoming.headers, 'cache-control': 'no-store' }); incoming.pipe(response);
          });
          upstream.once('error', () => { if (!response.headersSent) response.writeHead(502); response.end('本机主服务暂不可用'); });
          request.pipe(upstream); return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
        if (!serveStatic(request, response, path)) response.writeHead(404).end();
      } catch { if (!response.headersSent) response.writeHead(400); response.end('请求无效'); }
    });
    await new Promise<void>((done, reject) => { web!.once('error', reject); web!.listen(options.webPort, '127.0.0.1', done); });
    const port = (web.address() as { port: number }).port;
    const server = web; let closed = false;
    return { application, url: 'http://127.0.0.1:' + port, ...(setup ? { collectionSetupUrl: setup.url } : {}), async close() {
      if (closed) return; closed = true; server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await setup?.close(); await application.close();
    } };
  } catch (error) { if (web?.listening) { web.closeAllConnections(); web.close(); } await setup?.close(); await application.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = process.env.WORKBENCH_CONFIG_PATH, root = process.env.WORKBENCH_WEB_ROOT;
  if (!config || !root) throw new Error('须显式指定 WORKBENCH_CONFIG_PATH 和 WORKBENCH_WEB_ROOT');
  const workbench = await startLocalWorkbench(config, { webPort: Number(process.env.WORKBENCH_WEB_PORT ?? '5180'), webRoot: root, ...(process.env.WORKBENCH_COLLECTION_SETUP_ENABLED === '1' ? { collectionSetupPort: 5190 } : {}) });
  console.log(JSON.stringify({ event: 'daily_workbench_ready', url: workbench.url, identity: workbench.application.identity, mode: 'real' }));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; try { await workbench.close(); process.exitCode = 0; } catch { process.exitCode = 1; } };
  process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
}
