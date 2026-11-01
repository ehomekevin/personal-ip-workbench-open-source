import { constants, lstatSync, fstatSync, statSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertStorageRoot } from '@workbench/storage/connection';
const validatedRoots = new Map<string, number>();

export function credentialPath(stateRoot: string): string {
  const device = statSync(stateRoot).dev;
  if (validatedRoots.get(stateRoot) !== device) { assertStorageRoot(stateRoot); validatedRoots.set(stateRoot, device); }
  const root = realpathSync(stateRoot), directory = resolve(root, 'private-credentials');
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('私有凭据目录无效');
  return resolve(directory, 'tikhub-api-key');
}
export function credentialPresent(stateRoot: string): boolean {
  const path = credentialPath(stateRoot), info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size < 1 || info.size > 4096) throw new Error('私有凭据文件权限或大小无效');
  return true;
}
export function readTikHubCredential(stateRoot: string): string | null {
  if (!credentialPresent(stateRoot)) return null;
  const file = openSync(credentialPath(stateRoot), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(file);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size < 1 || info.size > 4096) throw new Error('私有凭据文件权限或大小无效');
    const value = readFileSync(file, 'utf8');
    if (!/^[\x21-\x7e]{1,4096}$/.test(value)) throw new Error('TikHub 密钥格式无效');
    return value;
  } finally { closeSync(file); }
}
export function saveTikHubCredential(stateRoot: string, value: unknown): void {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.trim())) throw new Error('请填写有效的 TikHub API Key');
  const path = credentialPath(stateRoot), directory = dirname(path);
  if (!lstatSync(directory, { throwIfNoEntry: false })) mkdirSync(directory, { mode: 0o700 });
  if (realpathSync(directory) + sep !== directory + sep) throw new Error('私有凭据目录不能包含链接');
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('私有凭据文件无效');
  const temporary = resolve(directory, '.' + randomUUID());
  const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(file, value.trim(), 'utf8'); } finally { closeSync(file); }
  try { renameSync(temporary, path); } finally { if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary); }
}
