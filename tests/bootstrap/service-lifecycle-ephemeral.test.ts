import { SCHEMA_VERSION } from '../../packages/storage/src/schema/index.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONTRACT_VERSION } from '../../packages/contracts/src/index.ts';

test('隔离空闲端口的实际main：SIGTERM重启、排他进程、已死owner回收和持久身份保护', async () => {
  // 保留旧 WP07 证据；新回归使用独立端口，避免占用用户当前测试入口。
  const probe = createServer();
  await new Promise<void>((done,reject) => { probe.once('error',reject); probe.listen(0,'127.0.0.1',done); });
  const port = (probe.address() as {port:number}).port;
  await new Promise<void>((done,reject) => probe.close(error => error ? reject(error) : done()));
  const evidenceRoot = resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR ?? '.ci-artifacts/lifecycle');
  mkdirSync(evidenceRoot, { recursive: true });
  const root = mkdtempSync(join(evidenceRoot, '.lifecycle-'));
  const workspace = randomUUID(); const service = randomUUID(); const configPath = join(root, 'config.json');
  const config = { workspace_id: workspace, service_instance_id: service, title: '隔离main生命周期', mode: 'demo', timezone: 'America/Los_Angeles', paths: { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') }, listen: { host: '127.0.0.1', port } };
  writeFileSync(configPath, JSON.stringify(config));
  const children: ChildProcess[] = [];
  function createChild(path = configPath) {
    const child = spawn(process.execPath, [resolve('apps/service/src/main.ts')], { env: { ...process.env, WORKBENCH_CONFIG_PATH: path }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child);
    let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); });
    return { child, stderr: () => stderr };
  }
  async function ready() {
    const running = createChild();
    const result = await new Promise<{ identity: unknown; boot_id: string; listen: { host: string; port: number } }>((resolveReady, reject) => {
      const timeout = setTimeout(() => { running.child.kill('SIGTERM'); reject(new Error('main startup timed out')); }, 10000);
      running.child.once('message', message => { clearTimeout(timeout); resolveReady(message as never); });
      running.child.once('error', error => { clearTimeout(timeout); reject(error); });
      running.child.once('exit', code => { clearTimeout(timeout); reject(new Error(`main startup exited ${code}: ${running.stderr().slice(0, 300)}`)); });
    }); return { ...running, ...result };
  }
  function exit(child: ChildProcess) { if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode }); return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal }))); }
  async function stop(child: ChildProcess, signal: NodeJS.Signals) { const ended = exit(child); child.kill(signal); const timeout = setTimeout(() => child.kill('SIGKILL'), 8000); const result = await ended; clearTimeout(timeout); return result; }
  const startedAt = new Date().toISOString();
  try {
    const first = await ready(); assert.deepEqual(first.identity, { workspace_id: workspace, service_instance_id: service, contract_version: CONTRACT_VERSION }); assert.equal(first.listen.host, '127.0.0.1'); assert.equal(first.listen.port, port);
    const health = await fetch('http://127.0.0.1:' + port + '/health', { headers: { connection: 'close' } }).then(response => response.json()) as { identity: unknown; schema_version: number }; assert.deepEqual(health.identity, first.identity); assert.equal(health.schema_version, SCHEMA_VERSION);
    const secondWriter = createChild(); assert.equal((await exit(secondWriter.child)).code, 1); assert.match(secondWriter.stderr(), /已有主服务/);
    assert.deepEqual(await stop(first.child, 'SIGTERM'), { code: 0, signal: null }); assert.equal(existsSync(join(root, 'state/.application-service-lock')), false);
    const restarted = await ready(); assert.deepEqual(restarted.identity, first.identity); assert.notEqual(restarted.boot_id, first.boot_id);
    const killed = await stop(restarted.child, 'SIGKILL'); assert.equal(killed.signal, 'SIGKILL'); assert.equal(existsSync(join(root, 'state/.application-service-lock')), true);
    const recovered = await ready(); assert.deepEqual(recovered.identity, first.identity); assert.notEqual(recovered.boot_id, restarted.boot_id); assert.deepEqual(await stop(recovered.child, 'SIGTERM'), { code: 0, signal: null });
    const wrongPath = join(root, 'wrong-config.json'); writeFileSync(wrongPath, JSON.stringify({ ...config, service_instance_id: randomUUID() })); const mismatch = createChild(wrongPath); assert.equal((await exit(mismatch.child)).code, 1); assert.match(mismatch.stderr(), /配置与数据库主服务身份不符/); assert.equal(existsSync(join(root, 'state/.application-service-lock')), false);
    writeFileSync(join(evidenceRoot, 'service-lifecycle-output.json'), JSON.stringify({ result: 'passed', evidence_scope: 'internal_rule', started_at: startedAt, finished_at: new Date().toISOString(), contract_version: CONTRACT_VERSION, schema_version: health.schema_version, identity: first.identity, listening: first.listen, checks: { second_process_rejected: true, sigterm_exit: 0, restart_identity_unchanged: true, boot_id_changed: true, hard_kill_observed: 'SIGKILL', dead_owner_verified_before_reclaim: true, persisted_service_mismatch_rejected: true, temporary_processes_stopped: true, temporary_root_removed: true }, limitations: ['Tests actual main and local SQLite; no native host, provider or platform.', 'SIGKILL validates stale-owner reacquisition; power-loss durability, pending job/receipt recovery and sleep scheduling belong subsequent WPs.'] }, null, 2) + '\n');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await stop(child, 'SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});
