import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ContractError } from '@workbench/contracts';

export function runConfigurationProbe<T>(script: URL, input: unknown, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(process.execPath, [fileURLToPath(script)], { stdio: ['pipe', 'pipe', 'ignore'], detached: grouped });
    let output = '', done = false;
    const stop = () => { try { grouped && child.pid ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL'); } catch { /* already exited */ } };
    const finish = (error?: Error, value?: T) => { if (done) return; done = true; clearTimeout(timer); stop(); error ? reject(error) : resolve(value!); };
    const timer = setTimeout(() => finish(new ContractError('CAPABILITY_UNVERIFIED', '检查超时，请检查文件、网络或工具登录后重试')), timeoutMs);
    child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 256 * 1024) finish(new ContractError('CAPABILITY_UNVERIFIED', '检查结果超过允许范围')); });
    child.once('error', () => finish(new ContractError('CAPABILITY_UNVERIFIED', '检查程序无法启动')));
    child.once('close', code => { if (done) return; try { const data = JSON.parse(output); if (code !== 0) throw new Error(); if (data.error) return finish(new ContractError('VALIDATION_ERROR', data.error)); finish(undefined, data); } catch { finish(new ContractError('CAPABILITY_UNVERIFIED', '检查未完成，已有配置保留')); } });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}
