import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startApplication, type RunningApplication } from '../../apps/service/src/bootstrap/application.ts';
import type { ModuleFactory } from '../../packages/domain/src/ports/index.ts';
import { CONTRACT_VERSION, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { assertExternalVolume } from '../../scripts/probes/runtime/mount-guard.ts';

function fixture() {
  const evidence = resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR ?? '.ci-artifacts/runtime-regressions');
  assertExternalVolume(resolve('.')); mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, '.bootstrap-'));
  const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: '隔离启动回归', mode: 'demo', timezone: 'America/Los_Angeles',
    paths: { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') }, listen: { host: '127.0.0.1', port: 4318 } };
  for (const path of [config.paths.state_root, config.paths.managed_notes_root, config.paths.media_root]) mkdirSync(path);
  const path = join(root, 'config.json'); writeFileSync(path, JSON.stringify(config));
  return { root, config, path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
type Message = { kind: string; code?: string; message?: string; boot_id?: string; address?: { port: number }; identity?: unknown };
function child(path: string, barrier?: string) {
  const processChild = spawn(process.execPath, [resolve('tests/bootstrap/service-child.ts')], { env: { ...process.env, WORKBENCH_CONFIG_PATH: path, WORKBENCH_TEST_RECLAIM_RELEASE: barrier ?? '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages: Message[] = []; let stderr = '';
  processChild.on('message', message => messages.push(message as Message)); processChild.stderr!.on('data', data => { stderr += String(data); });
  return { process: processChild, async message() {
    const deadline = Date.now() + 15000;
    while (!messages.length) {
      if (processChild.exitCode !== null || processChild.signalCode !== null || Date.now() > deadline) throw new Error('child did not produce message: ' + stderr.slice(0, 400));
      await new Promise(done => setTimeout(done, 10));
    }
    return messages.shift()!;
  } };
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once('exit', (code, signal) => done({ code, signal })));
  const kill = setTimeout(() => child.kill('SIGKILL'), 8000);
  child.kill(signal); try { return await result; } finally { clearTimeout(kill); }
}

test('暂停旧锁回收期间第二个真实服务被拒绝，赢家保有 owner；SIGKILL 后可恢复', async () => {
  const f = fixture(); const children: ChildProcess[] = [];
  try {
    // 先取得真实 dead PID，避免用猜测的大 PID 作为存活判断。
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']); await new Promise(done => dead.once('exit', done));
    const lock = join(f.config.paths.state_root, '.application-service-lock'); mkdirSync(lock);
    const old = { pid: dead.pid, token: randomUUID(), boot_id: randomUUID(), workspace_id: f.config.workspace_id, service_instance_id: f.config.service_instance_id, state_root: f.config.paths.state_root };
    writeFileSync(join(lock, 'owner.json'), JSON.stringify(old));
    const release = join(f.root, 'release-reclaim'); const first = child(f.path, release); children.push(first.process);
    assert.equal((await first.message()).kind, 'before_reclaim');
    const second = child(f.path); children.push(second.process);
    const rejected = await second.message(); assert.equal(rejected.kind, 'rejected'); assert.equal(rejected.code, 'STORAGE_UNAVAILABLE');
    assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token, old.token);
    writeFileSync(release, 'go'); const ready = await first.message(); assert.equal(ready.kind, 'ready');
    assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).boot_id, ready.boot_id);
    const health = await fetch(`http://127.0.0.1:${ready.address!.port}/health`).then(response => response.json()) as { boot_id: string; identity: unknown };
    assert.equal(health.boot_id, ready.boot_id); assert.deepEqual(health.identity, { workspace_id: f.config.workspace_id, service_instance_id: f.config.service_instance_id, contract_version: CONTRACT_VERSION });
    assert.equal((await stop(first.process, 'SIGKILL')).signal, 'SIGKILL');
    const recovered = child(f.path); children.push(recovered.process); const after = await recovered.message();
    assert.equal(after.kind, 'ready'); assert.notEqual(after.boot_id, ready.boot_id);
    assert.deepEqual(await stop(recovered.process), { code: 0, signal: null });
    assert.equal(existsSync(lock), false); assert.equal(existsSync(join(f.config.paths.state_root, '.application-service-lock.sqlite')), true);
  } finally { for (const running of children) await stop(running); f.cleanup(); }
});

test('首次启动拒绝源库符号链接和不存在尾部的物理重叠，不向源库写文件', async () => {
  const f = fixture(); try {
    const alias = join(f.root, 'source-alias'); symlinkSync(f.config.paths.managed_notes_root, alias);
    await assert.rejects(startApplication({ ...f.config, paths: { ...f.config.paths, source_vault_root: alias } }, { port: 0 }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(startApplication({ ...f.config, paths: { ...f.config.paths, source_vault_root: f.config.paths.managed_notes_root, managed_notes_root: join(alias, 'not-created') } }, { port: 0 }), { code: 'VALIDATION_ERROR' });
    assert.deepEqual(readdirSync(f.config.paths.managed_notes_root), []);
    assert.equal(existsSync(join(f.config.paths.state_root, 'workbench.sqlite')), false);
    assert.equal(existsSync(join(alias, 'not-created')), false);
  } finally { f.cleanup(); }
});

test('重启后读取的持久配置也拒绝源库物理重叠，并释放启动锁', async () => {
  const f = fixture(); let app: RunningApplication | undefined;
  try {
    app = await startApplication(f.config, { port: 0 });
    const alias = join(f.root, 'source-alias'); symlinkSync(f.config.paths.managed_notes_root, alias);
    app.context.db.prepare('UPDATE workspaces SET paths=? WHERE id=?').run(JSON.stringify({ ...f.config.paths, source_vault_root: alias }), f.config.workspace_id);
    await app.close(); app = undefined;
    await assert.rejects(startApplication(f.config, { port: 0 }), { code: 'VALIDATION_ERROR' });
    assert.deepEqual(readdirSync(f.config.paths.managed_notes_root), []);
    assert.equal(existsSync(join(f.config.paths.state_root, '.application-service-lock')), false);
  } finally { await app?.close(); f.cleanup(); }
});

test('悬空源库或写根链接在创建目录和数据库之前被拒绝，包括不存在的子尾部', async () => {
  const f = fixture(); try {
    const futureState = join(f.root, 'not-created-state'); const alias = join(f.root, 'dangling-source'); symlinkSync(futureState, alias);
    await assert.rejects(startApplication({ ...f.config, paths: { ...f.config.paths, state_root: futureState, source_vault_root: alias } }, { port: 0 }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(startApplication({ ...f.config, paths: { ...f.config.paths, state_root: futureState, source_vault_root: join(alias, 'child') } }, { port: 0 }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(startApplication({ ...f.config, paths: { ...f.config.paths, managed_notes_root: alias } }, { port: 0 }), { code: 'VALIDATION_ERROR' });
    assert.equal(existsSync(futureState), false); assert.equal(existsSync(join(alias, 'workbench.sqlite')), false);
    assert.deepEqual(readdirSync(f.config.paths.state_root), []); assert.deepEqual(readdirSync(f.config.paths.managed_notes_root), []);
  } finally { f.cleanup(); }
});

for (const duringStartup of [false, true]) test(`模块${duringStartup ? '启动与' : ''}关闭报错仍释放主存和独占锁`, async () => {
  const f = fixture(); let app: RunningApplication | undefined; let laterClosed = false;
  const factories: ModuleFactory[] = [() => ({ id: 'failing-module', register() {}, health: () => ({ module: 'failing-module', status: 'ready' }),
    initialize() { if (duringStartup) throw new Error('fixed initialization failure'); }, close() { throw new Error('fixed close failure'); } }),
  () => ({ id: 'later-module', register() {}, health: () => ({ module: 'later-module', status: 'ready' }), close() { laterClosed = true; } })];
  try {
    if (duringStartup) await assert.rejects(startApplication(f.config, { port: 0, moduleFactories: factories }), AggregateError);
    else { app = await startApplication(f.config, { port: 0, moduleFactories: factories }); await assert.rejects(app.close(), AggregateError); app = undefined; }
    assert.equal(laterClosed, true);
    app = await startApplication(f.config, { port: 0 }); await app.close(); app = undefined;
    assert.equal(existsSync(join(f.config.paths.state_root, '.application-service-lock')), false);
  } finally { await app?.close(); f.cleanup(); }
});
