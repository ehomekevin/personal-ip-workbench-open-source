import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, rmSync, realpathSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ContractError, type RequestContext } from '@workbench/contracts';
import { type DatabaseSync, transaction } from '../connection/index.ts';
import { ensureManagedDirectory, safeManagedChild } from '../files/index.ts';
import { readIdempotent, storeIdempotent } from '../revisions/idempotency.ts';
export { stageMultipart } from './multipart.ts';

export interface AssetImportMetadata { kind: string; mime: string; topic_id?: string | null; purpose?: string; duration_ms?: number | null; dimensions?: { width: number; height: number } | null }
function flushDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
async function hashFile(path: string): Promise<string> { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
export class Assets {
  readonly db: DatabaseSync; readonly mediaRoot: string; readonly stateRoot: string;
  constructor(db: DatabaseSync, mediaRoot: string, stateRoot: string) { this.db = db; this.mediaRoot = mediaRoot; this.stateRoot = stateRoot; }
  async importFile(context: RequestContext, source: AsyncIterable<Uint8Array>, metadata: AssetImportMetadata) {
    ensureManagedDirectory(this.mediaRoot); ensureManagedDirectory(this.stateRoot);
    if (!metadata.kind || !metadata.mime) throw new ContractError('VALIDATION_ERROR', '素材类型与 MIME 必须提供');
    if (metadata.topic_id && !this.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(context.workspace_id, metadata.topic_id))
      throw new ContractError('NOT_FOUND', '素材关联主题不存在');
    const assetId = randomUUID(); const stagingRoot = safeManagedChild(this.stateRoot, join(this.stateRoot, 'staging')); mkdirSync(stagingRoot, { recursive: true });
    const stagingPath = join(stagingRoot, `${assetId}.asset`); const hash = createHash('sha256'); let size = 0;
    const stream = async function* () { for await (const chunk of source) { hash.update(chunk); size += chunk.byteLength; yield chunk; } };
    let finalRoot: string | null = null; let committed = false;
    try {
    await pipeline(Readable.from(stream()), createWriteStream(stagingPath, { flags: 'wx', mode: 0o600 }));
    const handle = await open(stagingPath, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    const digest = hash.digest('hex');
    const frozen = { kind: metadata.kind, mime: metadata.mime, topic_id: metadata.topic_id ?? null, purpose: metadata.purpose ?? '',
      duration_ms: metadata.duration_ms ?? null, dimensions: metadata.dimensions ?? null, sha256: digest, size_bytes: size };
    const replay = readIdempotent<{ asset_id: string; sha256: string; status: string }>(this.db, context, 'assets.import', frozen);
    if (replay) return replay;
    const root = safeManagedChild(this.mediaRoot, join(this.mediaRoot, assetId)); mkdirSync(root); finalRoot = root;
    const file = join(root, 'original');
    if (statSync(stagingRoot).dev !== statSync(root).dev) throw new ContractError('STORAGE_UNAVAILABLE', '素材 staging 和目标必须同卷');
    renameSync(stagingPath, file); flushDirectory(root); flushDirectory(this.mediaRoot);
    const result = transaction(this.db, () => {
      const repeated = readIdempotent<{ asset_id: string; sha256: string; status: string }>(this.db, context, 'assets.import', frozen); if (repeated) return repeated;
      this.db.prepare("INSERT INTO assets (id,workspace_id,kind,origin,file_path,sha256,size_bytes,mime,duration_ms,dimensions,status) VALUES (?,?,?,'import',?,?,?,?,?,?,'ready')")
        .run(assetId, context.workspace_id, metadata.kind, file, digest, size, metadata.mime, metadata.duration_ms ?? null, metadata.dimensions ? JSON.stringify(metadata.dimensions) : null);
      if (metadata.topic_id) this.db.prepare('INSERT INTO topic_asset_links (id,workspace_id,topic_id,asset_id,purpose,evidence_kind) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), context.workspace_id, metadata.topic_id, assetId, metadata.purpose ?? '', 'user_input');
      const result = { asset_id: assetId, sha256: digest, status: 'ready' }; storeIdempotent(this.db, context, 'assets.import', frozen, result); return result;
    });
    committed = result.asset_id === assetId; return result;
    } finally {
      if (existsSync(stagingPath)) unlinkSync(stagingPath);
      if (finalRoot !== null && !committed) rmSync(finalRoot, { recursive: true, force: true });
    }
  }
  async reference(context: RequestContext, input: { path: string; topic_id: string; purpose: string }) {
    const existing = readIdempotent<{ asset_id: string; status: string }>(this.db, context, 'assets.reference', input); if (existing) return existing;
    if (!this.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(context.workspace_id, input.topic_id)) throw new ContractError('NOT_FOUND', '素材关联主题不存在');
    if (!isAbsolute(input.path) || !existsSync(input.path) || !statSync(input.path).isFile()) throw new ContractError('VALIDATION_ERROR', '引用素材文件不可达');
    const path = realpathSync(input.path); const size = statSync(path).size; const hash = await hashFile(path);
    return transaction(this.db, () => {
      const replay = readIdempotent<{ asset_id: string; status: string }>(this.db, context, 'assets.reference', input); if (replay) return replay;
      const id = randomUUID();
      this.db.prepare("INSERT INTO assets (id,workspace_id,kind,origin,file_path,sha256,size_bytes,mime,status) VALUES (?,?,'file','referenced',?,?,?,'application/octet-stream','referenced')")
        .run(id, context.workspace_id, path, hash, size);
      this.db.prepare('INSERT INTO topic_asset_links (id,workspace_id,topic_id,asset_id,purpose,evidence_kind) VALUES (?,?,?,?,?,?)').run(randomUUID(), context.workspace_id, input.topic_id, id, input.purpose, 'referenced');
      const result = { asset_id: id, status: 'referenced' }; storeIdempotent(this.db, context, 'assets.reference', input, result); return result;
    });
  }
  list(workspaceId: string, topicId?: string) {
    const items = this.db.prepare('SELECT DISTINCT a.* FROM assets a LEFT JOIN topic_asset_links l ON l.asset_id=a.id AND l.workspace_id=a.workspace_id WHERE a.workspace_id=? AND (? IS NULL OR l.topic_id=?) ORDER BY a.id').all(workspaceId, topicId ?? null, topicId ?? null);
    for (const row of items) if (!existsSync(String(row.file_path))) {
      this.db.prepare("UPDATE assets SET status='missing',updated_at=? WHERE workspace_id=? AND id=?").run(new Date().toISOString(), workspaceId, String(row.id)); row.status = 'missing';
    }
    return { items, next_cursor: null, has_more: false, last_success_at: new Date().toISOString() };
  }
  async content(workspaceId: string, assetId: string) {
    const row = this.db.prepare('SELECT file_path,mime,sha256,status FROM assets WHERE workspace_id=? AND id=?').get(workspaceId, assetId);
    if (!row) throw new ContractError('NOT_FOUND', '素材不存在');
    if (!existsSync(String(row.file_path))) throw new ContractError('STORAGE_UNAVAILABLE', '素材文件离线');
    if (await hashFile(String(row.file_path)) !== row.sha256) throw new ContractError('STORAGE_UNAVAILABLE', '素材文件校验已变化，须重新核对出处');
    return { stream: createReadStream(String(row.file_path)), mime: String(row.mime), filename: basename(String(row.file_path)) };
  }
}
