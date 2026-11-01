import { createHash } from 'node:crypto';
import { readdir, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { ContractError, PLATFORMS, type JsonObject, type NormalizedSourceRecord, type SourceLocationInput, type Sha256, type SourceRecordPayload, type Platform } from '@workbench/contracts';

export const VAULT_PARSER_VERSION = 'vault-frontmatter/2';
export interface VaultFile { relative_path: string; path: string; mtime: number; size: number }
export interface VaultParsedFile extends VaultFile { record: NormalizedSourceRecord; location: SourceLocationInput; sha256: Sha256 }
const digest = (value: Uint8Array): Sha256 => createHash('sha256').update(value).digest('hex') as Sha256;
const textValue = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
function safeUrl(value: unknown): string | null { const text = textValue(value); if (!text) return null; try { const url = new URL(text); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : null; } catch { return null; } }
// 仅解析可审计的 scalar frontmatter；复杂 YAML 作为待核对，不执行 tag / alias。
export function parseVaultMarkdown(relativePath: string, bytes: Uint8Array): NormalizedSourceRecord {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  let body = text, bodyStartLine = 1; const metadata: JsonObject = {}, warnings: string[] = [];
  if (text.startsWith('---\n') || text.startsWith('---\r\n')) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) throw new ContractError('VALIDATION_ERROR', 'frontmatter 未闭合', { relative_path: relativePath, line: 1 });
    body = text.slice(match[0].length);
    bodyStartLine = match[0].split('\n').length;
    for (const [index, line] of match[1]!.split(/\r?\n/).entries()) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const pair = /^([\w\u4e00-\u9fff-]+):\s*(.*?)\s*$/.exec(line);
      if (!pair || /^(?:[!&*|>]|\[|\{)/.test(pair[2]!)) { warnings.push(`frontmatter 第 ${index + 2} 行复杂值待核对`); continue; }
      let value = pair[2]!;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      metadata[pair[1]!] = value;
    }
  }
  const title = textValue(metadata.title) ?? /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? basename(relativePath, '.md');
  const url = safeUrl(metadata.url ?? metadata.source_url ?? metadata.original_url), published = textValue(metadata.published_at ?? metadata.publishedAt);
  const platformText = textValue(metadata.platform), platform: Platform | null = PLATFORMS.includes(platformText as Platform) ? platformText as Platform : null;
  const platformId = textValue(metadata.platform_work_id ?? metadata.work_id ?? metadata.tweet_id);
  const payload: SourceRecordPayload = { title, summary: body.replace(/^#.*$/m, '').trim().slice(0, 240), body, category: textValue(metadata.category) ?? '原始资料',
    author_name: textValue(metadata.original_author ?? metadata.author), reply_author_name: textValue(metadata.reply_author ?? metadata.replying_author), quoted_author_name: textValue(metadata.quoted_author ?? metadata.quote_author),
    external_links: [...new Set([url, ...[...body.matchAll(/https?:\/\/[^\s<>\])]+/g)].map(match => safeUrl(match[0]))].filter((value): value is string => value !== null))], media: [...body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => ({ reference: match[1]!, kind: 'markdown_media_reference', availability: 'unverified' })), identity_status: 'pending',
    parser_warnings: [...warnings, '账号与作者候选尚未核对；captured_at 仅是资料捕获时间，observed_at 保持未知。'], provider_metadata: { frontmatter: metadata, relative_path: relativePath, body_start_line: bodyStartLine, observed_at: null, observed_time_basis: 'unknown' } };
  return { external_id: relativePath, canonical_url: url, record_kind: 'vault_note', published_at: published && Number.isFinite(Date.parse(published)) ? new Date(published).toISOString() : null,
    payload, identity: platform && url ? { platform, platform_work_id: platformId, account_id: null, evidence: { kind: 'frontmatter_candidate', relative_path: relativePath, sha256: digest(bytes), parser_version: VAULT_PARSER_VERSION } } : null };
}
export class VaultAdapter {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  async discover(signal?: AbortSignal): Promise<VaultFile[]> {
    let canonical: string; try { canonical = await realpath(this.root); } catch { throw new ContractError('STORAGE_UNAVAILABLE', '已配置 Vault 不存在'); }
    if (canonical !== this.root || (await lstat(this.root)).isSymbolicLink()) throw new ContractError('VALIDATION_ERROR', 'Vault 根不能是符号链接');
    const files: VaultFile[] = [];
    const walk = async (directory: string): Promise<void> => {
      signal?.throwIfAborted();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        signal?.throwIfAborted(); if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { if (!['.obsidian', '.git', '.trash'].includes(entry.name)) await walk(path); }
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) { const stat = await lstat(path); files.push({ relative_path: relative(this.root, path).split(sep).join('/'), path, mtime: Math.floor(stat.mtimeMs), size: stat.size }); }
      }
    };
    await walk(this.root); return files.sort((a, b) => a.relative_path.localeCompare(b.relative_path, 'en'));
  }
  async read(file: VaultFile, signal?: AbortSignal): Promise<{ bytes: Uint8Array; sha256: Sha256 }> {
    signal?.throwIfAborted();
    const candidate = resolve(this.root, file.relative_path);
    if (candidate !== file.path || !candidate.startsWith(this.root + sep) || await realpath(candidate) !== candidate) throw new ContractError('VALIDATION_ERROR', 'Vault 文件离开已配置根或含符号链接');
    const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const before = await handle.stat(); if (!before.isFile() || before.size > 16 * 1024 * 1024) throw new ContractError('VALIDATION_ERROR', 'Vault 文件类型或大小未准入'); const bytes = await handle.readFile(); const after = await handle.stat();
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new ContractError('STORAGE_UNAVAILABLE', 'Vault 文件在读取期间变化，请重试');
      signal?.throwIfAborted(); return { bytes, sha256: digest(bytes) };
    } finally { await handle.close(); }
  }
  parse(file: VaultFile, input: { bytes: Uint8Array; sha256: Sha256 }): VaultParsedFile {
    const record = parseVaultMarkdown(file.relative_path, input.bytes); const metadata = record.payload.provider_metadata.frontmatter as JsonObject;
    const captured = textValue(metadata.captured_at ?? metadata.capture_time);
    return { ...file, record, sha256: input.sha256, location: { external_id: file.relative_path, kind: 'vault', relative_path: file.relative_path, source_url: record.canonical_url,
      capture_time: captured && Number.isFinite(Date.parse(captured)) ? new Date(captured).toISOString() : null, sha256: input.sha256, parser_version: VAULT_PARSER_VERSION, availability: 'available', raw_response_ref: null } };
  }
}
