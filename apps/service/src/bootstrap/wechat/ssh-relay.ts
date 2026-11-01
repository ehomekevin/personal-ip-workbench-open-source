import { createServer, connect, isIP, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, lstatSync, unlinkSync, mkdtempSync, rmdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { ContractError } from '@workbench/contracts';

export interface SshRelay { kind: 'ssh_nas'; host: string; user: string; port: number; identity_file: string }
export function validateRelay(relay: SshRelay, proxy: URL): void {
  if (relay.kind !== 'ssh_nas' || !isIP(relay.host) || !/^[a-zA-Z0-9_-]{1,64}$/.test(relay.user) || !Number.isInteger(relay.port) || relay.port < 1 || relay.port > 65535 || !isAbsolute(relay.identity_file) || !isIP(proxy.hostname)) throw new ContractError('AUTH_REQUIRED', '公众号 NAS 中继配置无效');
  const key = lstatSync(relay.identity_file);
  if (!key.isFile() || key.isSymbolicLink() || (key.mode & 0o077) !== 0) throw new ContractError('AUTH_REQUIRED', '公众号 NAS 中继密钥权限无效');
}
// 保留原固定代理地址与微信 TLS 校验。仅经既有 NAS SSH 转发到该公网代理，不打开本机 TCP 端口。
export async function startSshRelay(directory: string, relay: SshRelay, proxy: URL): Promise<{ path: string; close(): Promise<void> }> {
  validateRelay(relay, proxy);
  let path = join(directory, '.w-' + randomUUID().replaceAll('-', '').slice(0, 12)), temporary: string | undefined;
  // macOS Unix socket 路径最多约104字节；长工作区只把临时IPC放进独占0700短目录，不移动凭据。
  if (Buffer.byteLength(path) > 100) { temporary = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'wch-')); chmodSync(temporary, 0o700); path = join(temporary, 's'); }
  const sockets = new Set<Socket>(), children = new Set<ChildProcess>();
  const cleanup = () => { if (lstatSync(path, { throwIfNoEntry: false })) unlinkSync(path); if (temporary) rmdirSync(temporary); };
  const target = (isIP(proxy.hostname) === 6 ? '[' + proxy.hostname + ']' : proxy.hostname) + ':' + (proxy.port || (proxy.protocol === 'https:' ? '443' : '80'));
  const server = createServer(socket => {
    sockets.add(socket);
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-i', relay.identity_file, '-p', String(relay.port), '-W', target, relay.user + '@' + relay.host], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child); child.stderr!.resume(); socket.pipe(child.stdin!); child.stdout!.pipe(socket);
    child.on('error', () => socket.destroy()); child.on('exit', () => { children.delete(child); socket.destroy(); });
    child.stdin!.on('error', () => socket.destroy()); socket.on('error', () => child.kill('SIGTERM'));
    socket.on('close', () => { sockets.delete(socket); child.kill('SIGTERM'); });
  });
  try { await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(path, done); }); chmodSync(path, 0o600); }
  catch (error) { cleanup(); throw error; }
  return { path, async close() {
    for (const socket of sockets) socket.destroy();
    for (const child of children) child.kill('SIGTERM');
    await new Promise<void>(done => server.close(() => done()));
    cleanup();
  } };
}
export function relayConnector(path: string, done: (...args: [Error, null] | [null, Socket]) => void): void {
  const socket = connect(path); let finished = false;
  socket.once('connect', () => { if (!finished) { finished = true; done(null, socket); } });
  socket.once('error', error => { if (!finished) { finished = true; done(error, null); } });
}
