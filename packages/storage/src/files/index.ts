import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError, type Sha256, type WorkspacePaths } from '@workbench/contracts';
import { assertStorageRoot, sha256 } from '../connection/index.ts';

export interface RevisionMetadata {
  workspace_id: string; document_id: string; revision_id: string; parent_revision_id: string | null;
  topic_id: string | null; kind: string; source_ids: string[]; created_at: string;
  origin: 'human' | 'agent' | 'import' | 'restore'; change_kind: 'text' | 'restore' | 'core_alignment' | 'merge';
  created_by: string; based_on_core_revision_id: string | null;
  restore_from_revision_id: string | null; merge_candidate_id: string | null;
  base_revision_id?: string | null;
  job_id?: string; attempt_id?: string; attempt_generation?: number; result_receipt_id?: string;
}
export interface RegisteredRevisionIdentity { workspace_id: string; document_id: string; revision_id: string }
export function serializeRevision(metadata: RevisionMetadata, text: string): string {
  return '---\n' + Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n---\n' + text;
}
export function parseRevision(bytes: string): { metadata: RevisionMetadata; text: string } {
  if (!bytes.startsWith('---\n')) throw new ContractError('STORAGE_UNAVAILABLE', '修订文件缺少可核对的身份信息');
  const end = bytes.indexOf('\n---\n', 4);
  if (end < 0) throw new ContractError('STORAGE_UNAVAILABLE', '修订文件身份信息不完整');
  const metadata: Record<string, unknown> = {};
  try {
    for (const line of bytes.slice(4, end).split('\n')) {
      const colon = line.indexOf(': ');
      if (colon < 1) throw new Error('invalid frontmatter');
      const key = line.slice(0, colon);
      if (key in metadata || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('duplicate metadata');
      metadata[key] = JSON.parse(line.slice(colon + 2));
    }
  } catch { throw new ContractError('STORAGE_UNAVAILABLE', '修订文件身份信息无效'); }
  return { metadata: metadata as unknown as RevisionMetadata, text: bytes.slice(end + 5) };
}
function flushDirectory(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function rejectLinkedPath(path: string): void {
  let cursor = resolve(path);
  while (cursor !== dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new ContractError('STORAGE_UNAVAILABLE', '受管理路径不能经由链接');
    cursor = dirname(cursor);
  }
}
export function ensureManagedDirectory(root: string): void {
  rejectLinkedPath(root); let ancestor = root; while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  assertStorageRoot(ancestor); mkdirSync(root, { recursive: true });
}
export function safeManagedChild(root: string, target: string): string { return safeChild(root, target); }
function safeChild(root: string, target: string): string {
  if (!isAbsolute(root) || !isAbsolute(target)) throw new ContractError('STORAGE_UNAVAILABLE', '受管理文件路径必须是绝对路径');
  const path = resolve(target); const rel = relative(resolve(root), path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new ContractError('STORAGE_UNAVAILABLE', '文件路径不属于受管理根');
  rejectLinkedPath(root); let cursor = resolve(root);
  if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new ContractError('STORAGE_UNAVAILABLE', '受管理根不能是链接');
  for (const segment of rel.split(sep)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new ContractError('STORAGE_UNAVAILABLE', '受管理文件不能经由链接');
  }
  return path;
}
export class ManagedFiles {
  readonly paths: Readonly<WorkspacePaths>;
  constructor(paths: Readonly<WorkspacePaths>) { this.paths = paths; }
  assertAvailable(): void {
    for (const root of [this.paths.managed_notes_root, this.paths.state_root]) ensureManagedDirectory(root);
  }
  revisionPath(documentId: string, revisionId: string): string {
    if (![documentId, revisionId].every(id => /^[A-Za-z0-9-]+$/.test(id))) throw new ContractError('VALIDATION_ERROR', '文稿或修订 ID 无效');
    return join(this.paths.managed_notes_root, 'documents', documentId, `${revisionId}.md`);
  }
  validateRevisionPath(path: string, registered?: RegisteredRevisionIdentity) {
    if (!registered) return safeChild(this.paths.managed_notes_root, path);
    if (![registered.document_id, registered.revision_id].every(id => /^[A-Za-z0-9-]+$/.test(id))) throw new ContractError('STORAGE_UNAVAILABLE', '登记修订身份无效');
    const registeredRoot = dirname(dirname(dirname(path)));
    if (resolve(path) !== join(registeredRoot, 'documents', registered.document_id, `${registered.revision_id}.md`))
      throw new ContractError('STORAGE_UNAVAILABLE', '文件路径与登记修订身份不符');
    let ancestor = registeredRoot; while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    assertStorageRoot(ancestor);
    return safeChild(registeredRoot, path);
  }
  private checkRegisteredContent(content: string, registered?: RegisteredRevisionIdentity): void {
    if (!registered) return;
    const metadata = parseRevision(content).metadata;
    if (metadata.workspace_id !== registered.workspace_id || metadata.document_id !== registered.document_id || metadata.revision_id !== registered.revision_id)
      throw new ContractError('STORAGE_UNAVAILABLE', '正文身份与登记修订不符');
  }
  writeUniqueRevision(path: string, content: string, expectedHash: Sha256, registered?: RegisteredRevisionIdentity): void {
    this.assertAvailable(); this.validateRevisionPath(path, registered); this.checkRegisteredContent(content, registered);
    if (sha256(content) !== expectedHash) throw new ContractError('STORAGE_UNAVAILABLE', '待写正文与登记校验不符');
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      if (sha256(readFileSync(path)) !== expectedHash) throw new ContractError('STORAGE_UNAVAILABLE', 'needs_repair：已存在修订文件校验不符');
      this.ensureRevisionBackup(path, expectedHash); return;
    }
    const stagingRoot = safeChild(this.paths.state_root, join(this.paths.state_root, 'staging')); mkdirSync(stagingRoot, { recursive: true });
    if (statSync(stagingRoot).dev !== statSync(dirname(path)).dev) throw new ContractError('STORAGE_UNAVAILABLE', '修订 staging 与目标不在同一文件系统');
    const staged = join(stagingRoot, `${randomUUID()}.md`); const fd = openSync(staged, 'wx', 0o600);
    try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    if (sha256(readFileSync(staged)) !== expectedHash) throw new ContractError('STORAGE_UNAVAILABLE', 'staging 文件校验失败');
    renameSync(staged, path); chmodSync(path, 0o444); flushDirectory(dirname(path));
    this.ensureRevisionBackup(path, expectedHash);
  }
  ensureRevisionBackup(path: string, expectedHash: Sha256): void {
    const root = safeChild(this.paths.state_root, join(this.paths.state_root, 'backups/revisions')); mkdirSync(root, { recursive: true });
    const backup = safeChild(this.paths.state_root, join(root, `${expectedHash}.md`));
    if (existsSync(backup)) {
      if (sha256(readFileSync(backup)) !== expectedHash) throw new ContractError('STORAGE_UNAVAILABLE', '修订备份校验不符');
      return;
    }
    const fd = openSync(backup, 'wx', 0o444);
    try { writeFileSync(fd, readFileSync(path)); fsyncSync(fd); } finally { closeSync(fd); }
    flushDirectory(root);
  }
  readRevision(path: string, expectedHash: Sha256, registered?: RegisteredRevisionIdentity): { content: string; repaired: boolean; modified_copy: string | null } {
    this.assertAvailable(); this.validateRevisionPath(path, registered);
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf8');
      if (sha256(content) === expectedHash) { this.checkRegisteredContent(content, registered); return { content, repaired: false, modified_copy: null }; }
    }
    let modifiedCopy: string | null = null;
    const conflictRoot = safeChild(this.paths.managed_notes_root, join(this.paths.managed_notes_root, 'conflicts')); mkdirSync(conflictRoot, { recursive: true });
    if (existsSync(path)) {
      modifiedCopy = join(conflictRoot, `${randomUUID()}.md`); writeFileSync(modifiedCopy, readFileSync(path), { flag: 'wx', mode: 0o444 });
    }
    const backup = safeChild(this.paths.state_root, join(this.paths.state_root, 'backups/revisions', `${expectedHash}.md`));
    if (!existsSync(backup) || sha256(readFileSync(backup)) !== expectedHash) {
      throw new ContractError('STORAGE_UNAVAILABLE', 'needs_repair：历史正文不可恢复', { modified_copy: modifiedCopy });
    }
    const content = readFileSync(backup, 'utf8'); this.checkRegisteredContent(content, registered); mkdirSync(dirname(path), { recursive: true });
    const recovery = join(dirname(path), `${randomUUID()}.restore`); const fd = openSync(recovery, 'wx', 0o444);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(recovery, path); flushDirectory(dirname(path));
    return { content, repaired: true, modified_copy: modifiedCopy };
  }
  workingPath(documentId: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(documentId)) throw new ContractError('VALIDATION_ERROR', '文稿 ID 无效');
    return join(this.paths.managed_notes_root, 'working', `${documentId}.md`);
  }
  readWorking(documentId: string): string {
    const path = this.workingPath(documentId); this.validateRevisionPath(path);
    if (!existsSync(path)) throw new ContractError('NOT_FOUND', '工作副本不存在');
    return readFileSync(path, 'utf8');
  }
  preserveWorkingConflict(documentId: string, content: string): string {
    this.assertAvailable(); const root = safeChild(this.paths.managed_notes_root, join(this.paths.managed_notes_root, 'conflicts')); mkdirSync(root, { recursive: true });
    const path = join(root, `${documentId}-${randomUUID()}.working.md`); writeFileSync(path, content, { flag: 'wx', mode: 0o444 }); return path;
  }
  assertReferencedFile(path: string): string {
    if (!isAbsolute(path)) throw new ContractError('VALIDATION_ERROR', '引用路径必须是绝对路径');
    const actual = realpathSync(path); if (!statSync(actual).isFile()) throw new ContractError('VALIDATION_ERROR', '引用目标不是文件'); return actual;
  }
}
