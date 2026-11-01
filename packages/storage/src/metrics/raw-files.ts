import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContractError } from '@workbench/contracts';
import { assertStorageRoot, sha256 } from '../connection/index.ts';

export class MetricsRawFiles {
  readonly root: string;
  constructor(stateRoot: string) {
    assertStorageRoot(stateRoot); this.root = join(stateRoot, 'raw-responses', 'tikhub');
    for (const path of [join(stateRoot, 'raw-responses'), this.root]) {
      if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw new ContractError('STORAGE_UNAVAILABLE', 'raw 目录不可为符号链接');
      mkdirSync(path, { recursive: true }); assertStorageRoot(path);
    }
  }
  path(requestId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new ContractError('VALIDATION_ERROR', '采集请求 ID 须为 UUID');
    return join(this.root, requestId + '.json');
  }
  write(requestId: string, body: string): { path: string; sha256: string } {
    assertStorageRoot(this.root); const path = this.path(requestId), hash = sha256(body);
    if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new ContractError('VALIDATION_ERROR', '指标响应超过限制');
    try { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); } const directory = openSync(this.root, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; this.read(path, hash); }
    return { path, sha256: hash };
  }
  read(path: string, hash: string): string {
    assertStorageRoot(this.root);
    if (!path.startsWith(this.root + '/') || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path || !lstatSync(path).isFile()) throw new ContractError('STORAGE_UNAVAILABLE', 'raw 引用路径不符');
    const body = readFileSync(path, 'utf8'); if (sha256(body) !== hash) throw new ContractError('STORAGE_UNAVAILABLE', 'raw 响应 hash 不符'); return body;
  }
}
