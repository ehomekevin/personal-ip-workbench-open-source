import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { configureDatabase } from '../../packages/storage/src/connection/index.ts';
import { createReadStream, existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer, request as proxyRequest, type Server } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { assertExternalVolume } from '../probes/runtime/mount-guard.ts';
import { artifactDirectory, projectRoot, runCommand, saveJson } from './common.ts';

const scope = process.argv[process.argv.indexOf('--scope') + 1];
const grepIndex=process.argv.indexOf('--grep');
const testFilter=grepIndex<0?[]:['--grep',process.argv[grepIndex+1]!];
if(grepIndex>=0&&!testFilter[1])throw new Error('--grep 需要用例筛选表达式');
if (!['local', 'portable'].includes(scope!)) throw new Error('E2E scope 必须为 local 或 portable');
if (scope === 'local' || process.platform === 'darwin') assertExternalVolume(projectRoot);
const root = artifactDirectory('e2e-' + scope);
const controlToken = randomUUID();
const steps: unknown[] = [];
let runtime: string | undefined, main: ChildProcess | undefined, server: Server | undefined;
let backendPort = 0, bootId = '', configPath = '', result = 'failed', fixture: Record<string, unknown> | undefined;
const publishingAccountId = randomUUID(), publishingSecondAccountId = randomUUID();
let interrupted = false;
const interrupt = () => { interrupted = true; main?.kill('SIGTERM'); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', done); });
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
  return port;
}
async function startMain(): Promise<void> {
  const child = spawn(process.execPath, [join(projectRoot, 'apps/service/src/main.ts')], { cwd: projectRoot, env: { ...process.env, WORKBENCH_CONFIG_PATH: configPath, WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON: '["PSET_UI_X_A","PSET_UI_X_B"]', PSET_UI_X_A: '', PSET_UI_X_B: '', WORKBENCH_PUBLISHERS_IMPORT_LEGACY: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  main = child;
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => appendFileSync(join(root, 'main-service.log'), bytes));
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('隔离主服务启动超时')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('隔离主服务启动退出：' + code)); });
    child.once('message', message => {
      clearTimeout(timer);
      const ready = message as { boot_id: string; identity: { workspace_id: string; service_instance_id: string }; listen: { port: number } };
      if (ready.listen.port !== backendPort || ready.identity.workspace_id !== fixture?.workspace_id || ready.identity.service_instance_id !== fixture?.service_instance_id) { child.kill('SIGTERM'); reject(new Error('主服务身份不匹配')); return; }
      bootId = ready.boot_id; done();
    });
  });
}
async function stopMain(): Promise<void> {
  const child = main;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done, reject) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 8000);
    const fail = setTimeout(() => reject(new Error('隔离主服务无法停止，保留隔离根以便检查')), 14000);
    child.once('exit', () => { clearTimeout(kill); clearTimeout(fail); done(); });
    child.kill('SIGTERM');
  });
}
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
function staticPath(urlPath: string): string | undefined {
  const base = join(projectRoot, 'apps/web/dist');
  const file = resolve(base, urlPath === '/' ? 'index.html' : '.' + decodeURIComponent(urlPath));
  if (!file.startsWith(base + sep) || !existsSync(file)) return;
  const actual = realpathSync(file);
  if (!actual.startsWith(realpathSync(base) + sep) || !statSync(actual).isFile()) return;
  return actual;
}

try {
  steps.push(await runCommand('pnpm', ['build:web'], { root, label: 'production-build' }));
  if (interrupted) throw new Error('E2E 已中断');
  if (scope === 'local') {
    runtime = mkdtempSync(join(root, '.runtime-')); backendPort = await freePort();
    fixture = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: 'E2E 隔离设置工作区', mode: 'demo', timezone: 'America/Los_Angeles', default_executor: 'codex', api_fallback_enabled: false,
      paths: { source_vault_root: null, managed_notes_root: join(runtime, 'notes'), state_root: join(runtime, 'state'), media_root: join(runtime, 'media') }, listen: { host: '127.0.0.1', port: backendPort } };
    configPath = join(runtime, 'config.json'); writeFileSync(configPath, JSON.stringify(fixture)); await startMain();
    // 仅在本次分配的隔离 demo 主存中登记内部身份fixture；没有真实平台凭据。
    if (fixture.mode !== 'demo' || fixture.paths === undefined) throw new Error('发布UI fixture必须使用隔离demo');
    const testDb = new DatabaseSync(join(runtime, 'state', 'workbench.sqlite')); configureDatabase(testDb);
    try {
      const statement = testDb.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'x',?,'owner',?,'https://x.com/internal-ui-fixture','confirmed')");
      statement.run(publishingAccountId, String(fixture.workspace_id), 'internal-ui-first', '隔离本人账号');
      statement.run(publishingSecondAccountId, String(fixture.workspace_id), 'internal-ui-second', '隔离第二账号');
    } finally { testDb.close(); }
  }
  server = createServer((request, response) => { void (async () => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/__test/')) {
      if (scope !== 'local' || request.headers['x-e2e-control'] !== controlToken) { response.writeHead(404).end(); return; }
      if (pathname === '/__test/restart' && request.method === 'POST') { await stopMain(); await startMain(); }
      else if (pathname !== '/__test/runtime' || request.method !== 'GET') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ workspace_id: fixture!.workspace_id, service_instance_id: fixture!.service_instance_id, boot_id: bootId, scope: 'isolated_demo_workspace', source_vault_root: null })); return;
    }
    if (pathname.startsWith('/api/') || pathname === '/health') {
      if (scope !== 'local') { response.writeHead(503).end('此 CI 范围没有启动后端'); return; }
      const upstream = proxyRequest({ hostname: '127.0.0.1', port: backendPort, path: request.url, method: request.method, headers: { ...request.headers, host: '127.0.0.1:' + backendPort, connection: 'close' } }, incoming => { response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response); });
      upstream.once('error', () => { if (!response.headersSent) response.writeHead(502); response.end('隔离主服务不可用'); }); request.pipe(upstream); return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const path = staticPath(pathname);
    if (!path) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    if (request.method === 'HEAD') response.end(); else createReadStream(path).pipe(response);
  })().catch(error => { appendFileSync(join(root, 'server-errors.log'), String(error) + '\n'); if (!response.headersSent) response.writeHead(500); response.end('测试服务异常'); }); });
  await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done); });
  const baseURL = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  console.log(`E2E ${scope}: ${baseURL}；报告 ${root}`);
  steps.push(await runCommand(process.execPath, [join(projectRoot, 'node_modules/@playwright/test/cli.js'), 'test', '--config=playwright.config.ts',...testFilter], { root, label: 'browser-tests', env: {
    WORKBENCH_E2E_PUBLISHING_ACCOUNT_ID: publishingAccountId, WORKBENCH_E2E_PUBLISHING_SECOND_ACCOUNT_ID: publishingSecondAccountId,
    WORKBENCH_E2E_URL: baseURL, WORKBENCH_E2E_SCOPE: scope, WORKBENCH_E2E_CONTROL: controlToken, WORKBENCH_E2E_REPORT: root,
    WORKBENCH_E2E_BACKEND_URL: scope === 'local' ? 'http://127.0.0.1:' + backendPort : '',
    PLAYWRIGHT_CHANNEL: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'darwin' ? 'chrome' : ''),
  } }));
  result = 'passed';
} finally {
  let cleanupError: string | null = null;
  try {
    if (server) { server.closeAllConnections(); await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done())); }
    await stopMain();
    if (runtime) rmSync(runtime, { recursive: true, force: true });
  } catch (error) { cleanupError = String(error); result = 'failed'; }
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  saveJson(join(root, 'summary.json'), { result, scope, test_filter:testFilter[1]??null, steps, actual_backend: scope === 'local', workspace_mode: scope === 'local' ? 'demo' : null, fixture_removed: runtime ? !existsSync(runtime) : null, main_stopped: !main || main.exitCode !== null || main.signalCode !== null, cleanup_error: cleanupError, real_provider_platform_host_and_full_business_acceptance: 'not_run', pixel_sampling_stability: 'not_evaluated; public layout uses functional and overflow checks' });
  if (cleanupError) throw new Error(cleanupError);
}
