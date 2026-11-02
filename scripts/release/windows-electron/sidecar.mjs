// Runs under the original bundled Node, not the Electron renderer/runtime.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workspace } from './policy.cjs';

const core = resolve(import.meta.dirname, '../core');
function port(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw Error('Invalid port');
  return value;
}
async function start() {
  const dir = workspace(process.env, resolve(core, '../..'));
  const config = join(dir, 'config.json'), scripts = join(core, 'app/scripts/runtime');
  if (!existsSync(config)) execFileSync(process.execPath, [join(scripts, 'init-workspace.ts'), '--dir', dir,
    '--mode', 'real', '--port', String(port('WORKBENCH_API_PORT', 4318))], { stdio: 'ignore', windowsHide: true });
  const { startLocalWorkbench } = await import(pathToFileURL(join(scripts, 'local-server.ts')).href);
  return startLocalWorkbench(config, { webRoot: join(core, 'web'), webPort: port('WORKBENCH_WEB_PORT', 5180) });
}
const started = start();
let closing;
function close() {
  closing ??= (async () => {
    try { await (await started).close(); }
    catch { process.exitCode = 1; }
    finally { if (process.connected) process.disconnect(); }
  })();
}
process.on('message', message => { if (message === 'stop') close(); });
process.on('disconnect', close);
try {
  const service = await started;
  if (!closing && process.connected) process.send({ ready: service.url });
} catch (error) {
  if (process.connected) process.send({ failure: error.code === 'EADDRINUSE' ? 'port' :
    /锁|占用|already running|SQLITE_BUSY/i.test(error.message) ? 'busy' : 'startup' });
  close();
}
