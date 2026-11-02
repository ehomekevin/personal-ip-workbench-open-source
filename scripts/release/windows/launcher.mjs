import { createServer, createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const program = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = process.env.WORKBENCH_DATA_DIR || (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'PersonalIPWorkbench'));
const pipePrefix = '\\\\.\\pipe\\personal-ip-workbench-';

function port(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error(`${name} 必须在 1–65535 之间`);
  return value;
}

async function start(dataDir, controlFile) {
  const config = join(dataDir, 'config.json');
  if (!existsSync(config)) {
    execFileSync(process.execPath, [join(program, 'app/scripts/runtime/init-workspace.ts'), '--dir', dataDir,
      '--mode', 'real', '--port', String(port('WORKBENCH_API_PORT', 4318))], { stdio: 'inherit' });
  }
  const { startLocalWorkbench } = await import('../app/scripts/runtime/local-server.ts');
  const workbench = await startLocalWorkbench(config, { webRoot: join(program, 'web'), webPort: port('WORKBENCH_WEB_PORT', 5180) });
  const pipe = pipePrefix + randomUUID();
  let closing;
  const close = () => closing ??= (async () => {
    control.close();
    try { await workbench.close(); } finally {
      if (existsSync(controlFile) && readFileSync(controlFile, 'utf8') === pipe) unlinkSync(controlFile);
    }
  })();
  const control = createServer(socket => {
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on('error', () => {});
    // The pipe name is a fresh unguessable capability saved only inside this user's workspace.
    socket.once('data', data => {
      if (data.toString() !== 'stop\n') { socket.destroy(); return; }
      close().then(() => socket.end('stopped\n'), error => { console.error(error.message); socket.end('failed\n'); process.exitCode = 1; });
    });
  });
  try {
    await new Promise((ok, fail) => { control.once('error', fail); control.listen(pipe, ok); });
    writeFileSync(controlFile, pipe, { mode: 0o600 });
  } catch (error) { if (control.listening) control.close(); await workbench.close(); throw error; }
  const stopOnSignal = () => { close().catch(error => { console.error(error.message); process.exitCode = 1; }); };
  process.once('SIGINT', stopOnSignal); process.once('SIGTERM', stopOnSignal);
  console.log(`工作台已启动：${workbench.url}\n数据目录：${dataDir}\n退出请双击 Stop.cmd，或在本窗口按 Ctrl+C。`);
  if (process.env.WORKBENCH_NO_BROWSER !== '1') {
    const open = spawn(join(process.env.SystemRoot, 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', workbench.url], { detached: true, stdio: 'ignore' });
    open.once('error', () => console.log(`请手动打开 ${workbench.url}`)); open.unref();
  }
}

async function stop(controlFile) {
  if (!existsSync(controlFile)) throw new Error('此数据目录没有正在运行的便携版工作台。');
  const pipe = readFileSync(controlFile, 'utf8');
  if (!pipe.startsWith(pipePrefix) || !/^[a-f0-9-]{36}$/.test(pipe.slice(pipePrefix.length))) throw new Error('退出指令的位置无效。');
  await new Promise((ok, fail) => {
    const socket = createConnection(pipe, () => socket.write('stop\n'));
    const chunks = [];
    socket.setTimeout(30_000, () => socket.destroy(new Error('等待工作台正常退出超时')));
    socket.on('data', data => chunks.push(data)); socket.once('error', fail);
    socket.once('end', () => Buffer.concat(chunks).toString() === 'stopped\n' ? ok() : fail(new Error('工作台未确认正常退出')));
  });
  console.log('工作台已正常退出。');
}

try {
  if (!workspace || !isAbsolute(workspace)) throw new Error('需要绝对路径 WORKBENCH_DATA_DIR 或本机 LOCALAPPDATA。');
  const action = process.argv[2];
  if (action !== 'start' && action !== 'stop') throw new Error('请通过 Start.cmd 或 Stop.cmd 使用。');
  const target = resolve(workspace);
  const physicalProgram = realpathSync.native(program);
  const requireOutsideProgram = path => {
    const rel = relative(physicalProgram, path);
    if (!isAbsolute(rel) && !/^\.\.(?:[\\/]|$)/.test(rel)) throw new Error('数据目录必须位于程序目录之外，方便升级和备份。');
  };
  let ancestor = target;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const physicalAncestor = realpathSync.native(ancestor);
  if (relative(physicalAncestor, ancestor)) throw new Error('数据目录不能经过符号链接或目录联接。');
  requireOutsideProgram(resolve(physicalAncestor, relative(ancestor, target)));
  if (action === 'start') mkdirSync(target, { recursive: true });
  const dataDir = realpathSync.native(target);
  requireOutsideProgram(dataDir);
  if (relative(dataDir, target)) throw new Error('数据目录不能经过符号链接或目录联接。');
  const controlFile = join(dataDir, '.portable-control');
  if (action === 'start') await start(dataDir, controlFile); else await stop(controlFile);
} catch (error) {
  console.error(error.message);
  if (error.code === 'EADDRINUSE') console.error('端口已被占用。请设置 WORKBENCH_WEB_PORT，或在工作台停止后调整 config.json 的 listen.port。');
  process.exitCode = 1;
}
