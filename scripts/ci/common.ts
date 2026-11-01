import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function artifactDirectory(name: string): string {
  const root = process.env.WORKBENCH_CI_ARTIFACT_ROOT
    ? join(resolve(process.env.WORKBENCH_CI_ARTIFACT_ROOT), name)
    : join(projectRoot, '.ci-artifacts', name, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  mkdirSync(root, { recursive: true });
  return root;
}
export function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
export async function runCommand(command: string, args: string[], options: { root: string; label: string; env?: NodeJS.ProcessEnv }) {
  const started_at = new Date().toISOString();
  const log = join(options.root, options.label + '.log');
  const output = createWriteStream(log);
  const child = spawn(command, args, { cwd: projectRoot, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout!.on('data', chunk => { output.write(chunk); process.stdout.write(chunk); });
  child.stderr!.on('data', chunk => { output.write(chunk); process.stderr.write(chunk); });
  const stop = () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* 子进程已经退出。 */ } };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  let result: { exit_code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (exit_code, signal) => done({ exit_code, signal }));
    });
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    output.end(); await once(output, 'finish');
  }
  const record = { command: [command, ...args], started_at, finished_at: new Date().toISOString(), ...result, log };
  saveJson(join(options.root, options.label + '.json'), record);
  if (result.exit_code !== 0) throw new Error(`${options.label} failed (${result.exit_code ?? result.signal}); see ${log}`);
  return record;
}
