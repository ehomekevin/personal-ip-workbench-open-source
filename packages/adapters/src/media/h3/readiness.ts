import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { VoiceReadinessResponse } from '@workbench/contracts';

export async function checkVoiceReadiness(path: string | undefined, timeoutMs = 8000): Promise<Omit<VoiceReadinessResponse, 'identity'>> {
  if (!path) return { status: 'unconfigured', message: '先配置本地 H3 声音服务与本人参考', profile: null, running: null, pending: null };
  return new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./readiness-probe.ts', import.meta.url)), path], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', finished = false;
    const finish = (value: Omit<VoiceReadinessResponse, 'identity'>) => { if (finished) return; finished = true; clearTimeout(timer); resolve(value); };
    const failed = () => finish({ status: 'offline', message: '声音检查超时或输入不可读，请检查 NAS、参考文件与服务地址', profile: null, running: null, pending: null });
    const timer = setTimeout(() => { child.kill('SIGKILL'); failed(); }, timeoutMs);
    child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 16384) { child.kill('SIGKILL'); failed(); } });
    child.once('error', failed);
    child.once('close', code => { if (finished) return; try { const data = JSON.parse(output); if (code !== 0 || !['ready', 'offline', 'unconfigured', 'input_changed'].includes(data.status)) return failed(); finish(data); } catch { failed(); } });
  });
}
