import { mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ContractError, type ServiceIdentity } from '@workbench/contracts';
import { assertStorageRoot } from '@workbench/storage/connection';
interface Owner { pid: number; token: string; boot_id: string; workspace_id: string; service_instance_id: string; state_root: string }
export function acquireServiceLock(stateRoot: string, identity: ServiceIdentity, bootId: string): () => void {
  assertStorageRoot(stateRoot); const lock = join(stateRoot, '.application-service-lock');
  const owner: Owner = { pid: process.pid, token: randomUUID(), boot_id: bootId, workspace_id: identity.workspace_id, service_instance_id: identity.service_instance_id, state_root: stateRoot };
  // 独立连接终身持有 OS 文件锁；进程死亡会释放，旧 owner 的判断和回收因此只有一个执行者。
  // 此文件必须保留：删除后重建会产生不同 inode，破坏竞争者共享的锁。
  let guard: DatabaseSync | undefined;
  try {
    guard = new DatabaseSync(join(stateRoot, '.application-service-lock.sqlite'), { timeout: 0 });
    guard.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch {
    guard?.close();
    throw new ContractError('STORAGE_UNAVAILABLE', '该工作区已有主服务，或服务锁无法取得');
  }
  const heldGuard = guard;
  try {
    try { mkdirSync(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let old: Owner; try { old = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as Owner; } catch { throw new ContractError('STORAGE_UNAVAILABLE', '服务锁缺少可信 owner，拒绝自动删除'); }
    if (!Number.isSafeInteger(old.pid) || old.pid < 1 || !old.token || old.workspace_id !== identity.workspace_id || old.service_instance_id !== identity.service_instance_id || old.state_root !== stateRoot) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '服务锁身份与工作区不符');
    let alive = true; try { process.kill(old.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    if (alive) throw new ContractError('STORAGE_UNAVAILABLE', '该工作区已有主服务或 owner 仍存活');
    assertStorageRoot(stateRoot); const stale = lock + '.stale-' + owner.token;
    // 只有持有 guard 的进程可隔离已核实的旧 owner。
    renameSync(lock, stale); mkdirSync(lock); rmSync(stale, { recursive: true });
    }
    writeFileSync(join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  } catch (error) { heldGuard.close(); throw error; }
  return () => {
    try {
      const current = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as Owner;
      if (current.token !== owner.token || current.boot_id !== owner.boot_id) throw new Error('Service lock ownership changed');
      rmSync(lock, { recursive: true });
    } finally { heldGuard.close(); }
  };
}
