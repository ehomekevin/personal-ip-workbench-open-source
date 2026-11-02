import { createServer, createConnection } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, fstatSync, openSync, closeSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateStorageDirectory } from '../app/packages/storage/src/connection/storage-root.ts';
import { startLocalWorkbench } from '../app/scripts/runtime/local-server.ts';

const program = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const host = '127.0.0.1';
function port(key, fallback) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error(`${key} 必须为 1–65535 的端口号`);
  return value;
}
function dataDirectory() {
  const configured = process.env.WORKBENCH_DATA_DIR || join(homedir(), 'Library/Application Support/PersonalIPWorkbench');
  if (!isAbsolute(configured)) throw new Error('WORKBENCH_DATA_DIR 必须是专用文件夹的绝对路径');
  // macOS exposes /tmp and /var via system symlinks; pass their physical spelling to the storage guard.
  const target = resolve(configured).replace(/^\/(tmp|var)(?=\/|$)/, path => realpathSync(path));
  let ancestor = target;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  validateStorageDirectory(ancestor);
  const physical = resolve(realpathSync(ancestor), relative(ancestor, target));
  const within = (parent, child) => { const delta = relative(parent, child); return delta !== '..' && !delta.startsWith('../') && !isAbsolute(delta); };
  const bundle = dirname(dirname(program));
  if (within(bundle, physical) || within(physical, bundle)) throw new Error('工作区与程序必须位于互不包含的独立文件夹');
  return physical;
}
function controlSettings(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 4096) throw new Error('本机实例控制文件无效');
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[0-9a-f]{64}$/.test(value.token)) throw new Error('本机实例控制信息无效');
    return value;
  } finally { closeSync(fd); }
}
async function stop(dataDir, file) {
  const info = controlSettings(file);
  if (info.directory !== dataDir) throw new Error('退出信息属于其他工作区');
  await new Promise((done, fail) => {
    const peer = createConnection({ host, port: info.port }, () => peer.write(info.token + '\n'));
    let reply = '';
    peer.setTimeout(30000, () => peer.destroy(new Error('等待工作台退出超时')));
    peer.on('data', bytes => { reply += bytes; if (reply.length > 32) peer.destroy(new Error('本机实例响应无效')); });
    peer.on('error', fail);
    peer.on('end', () => reply === 'stopped\n' ? done() : fail(new Error('退出没有得到本工作区确认')));
  });
  console.log('工作台已正常退出。');
}
async function start(dataDir, file) {
  const config = join(dataDir, 'config.json');
  const webPort = port('WORKBENCH_WEB_PORT', 5280);
  if (!existsSync(config)) execFileSync(process.execPath, [join(program, 'app/scripts/runtime/init-workspace.ts'), '--dir', dataDir,
    '--mode', 'real', '--port', String(port('WORKBENCH_API_PORT', 4328))], { stdio: 'inherit' });
  validateStorageDirectory(dataDir);
  const app = await startLocalWorkbench(config, { webRoot: join(program, 'web'), webPort });
  const token = randomBytes(32).toString('hex');
  let closing;
  const close = () => closing ??= (async () => {
    if (server.listening) server.close();
    try { if (existsSync(file) && controlSettings(file).token === token) unlinkSync(file); }
    finally { await app.close(); }
  })();
  const server = createServer(peer => {
    let body = '';
    peer.setTimeout(2000, () => peer.destroy()); peer.on('error', () => {});
    peer.on('data', bytes => {
      body += bytes;
      if (body === token + '\n') { peer.setTimeout(0); close().then(() => peer.end('stopped\n'), () => peer.end('error\n')); }
      else if (body.length >= 65 || body.includes('\n')) peer.destroy();
    });
  });
  try {
    await new Promise((done, fail) => { server.once('error', fail); server.listen(0, host, done); });
    const temp = join(dataDir, `.control-${randomUUID()}`);
    try { writeFileSync(temp, JSON.stringify({ port: server.address().port, token, directory: dataDir }), { flag:'wx', mode:0o600 }); renameSync(temp,file); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  } catch(error) { await close(); throw error; }
  const onSignal = () => { close().catch(error => { console.error(error.message); process.exitCode = 1; }); };
  process.once('SIGINT',onSignal); process.once('SIGTERM',onSignal); process.once('SIGHUP',onSignal);
  console.log(`工作台已启动：${app.url}\n数据目录：${dataDir}\n退出请在创作有数的菜单中选择退出。`);
  if (process.env.WORKBENCH_NO_BROWSER !== '1') {
    const open = spawn('/usr/bin/open', [app.url], { detached:true, stdio:'ignore' });
    open.once('error', () => console.log(`请手动打开 ${app.url}`)); open.unref();
  }
}
try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('此便携包适用于 Apple Silicon Mac');
  const dataDir = dataDirectory(), file = join(dataDir,'.macos-control.json');
  if (process.argv[2] === 'start') await start(dataDir,file);
  else if (process.argv[2] === 'stop') { if (!existsSync(file)) throw new Error('此工作区没有正在运行的便携版实例'); await stop(dataDir,file); }
  else throw new Error('请双击创作有数.app');
} catch(error) {
  console.error(error.message);
  if (error.code === 'EADDRINUSE') console.error('端口已被占用。网页端口可用 WORKBENCH_WEB_PORT 指定，API 端口在工作区 config.json 中设置。');
  process.exitCode = 1;
}
