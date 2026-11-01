import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ContractError, type JsonObject } from '@workbench/contracts';

// 本机（macOS Homebrew）优先固定路径；不存在时（如 Linux CI）按 PATH 查找同名工具，找不到由 runTool 返回工具执行失败。
function localTool(fixed: string, name: string): string { return existsSync(fixed) ? fixed : name; }
export const LOCAL_TOOLS = { ffmpeg: localTool('/opt/homebrew/bin/ffmpeg', 'ffmpeg'), ffprobe: localTool('/opt/homebrew/bin/ffprobe', 'ffprobe'), chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', say: '/usr/bin/say', python: '/usr/bin/python3' };
export interface ToolTrace { tool: string; args: string[]; started_at: string; elapsed_ms: number; exit_code: number | null; stderr: string }
export async function runTool(tool: string, args: string[], options: { signal?: AbortSignal; traces?: ToolTrace[]; cwd?: string; timeout_ms?: number } = {}): Promise<string> {
  options.signal?.throwIfAborted(); const begin = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: options.cwd }); let stdout = '', stderr = '', finished = false; let abortKill:NodeJS.Timeout|undefined;
    const stop = () => { child.kill('SIGTERM'); abortKill??=setTimeout(()=>child.kill('SIGKILL'),3000); }; const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(stop, options.timeout_ms ?? 120_000); const hardTimer = setTimeout(kill, (options.timeout_ms ?? 120_000) + 3000);
    options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 2 * 1024 * 1024) { stop(); } });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-32_768); });
    const done = (error: Error | null, code: number | null) => { if (finished) return; finished = true; clearTimeout(timer); clearTimeout(hardTimer); if(abortKill)clearTimeout(abortKill); options.signal?.removeEventListener('abort', stop);
      options.traces?.push({ tool, args, started_at: new Date(begin).toISOString(), elapsed_ms: Date.now() - begin, exit_code: code, stderr });
      if (options.signal?.aborted) reject(options.signal.reason ?? new Error('CANCELLED'));
      else if (error || code !== 0 || stdout.length > 2 * 1024 * 1024) reject(new ContractError('CAPABILITY_UNVERIFIED', '本机媒体工具执行失败', { tool, exit_code: code, stderr: stderr.slice(-2000) }));
      else resolve(stdout);
    };
    child.once('error', error => done(error, null)); child.once('close', code => done(null, code));
  });
}
export async function fileHash(path: string, signal?: AbortSignal): Promise<string> { const hash = createHash('sha256'); for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) { signal?.throwIfAborted(); hash.update(chunk); } return hash.digest('hex'); }
export async function metadata(path: string, options: { signal?: AbortSignal; traces?: ToolTrace[] } = {}): Promise<JsonObject> {
  const result = JSON.parse(await runTool(LOCAL_TOOLS.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], options)) as JsonObject;
  // 工具绝对路径只留在服务内部日志，资源 read model 不泄露本地文件路径。
  if (result.format && typeof result.format === 'object' && !Array.isArray(result.format)) delete result.format.filename;
  return result;
}
export async function decode(path: string, options: { signal?: AbortSignal; traces?: ToolTrace[] } = {}): Promise<void> { await runTool(LOCAL_TOOLS.ffmpeg, ['-hide_banner', '-v', 'error', '-i', path, '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-'], options); }
