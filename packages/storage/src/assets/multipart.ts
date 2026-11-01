import { closeSync, mkdirSync, openSync, writeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError } from '@workbench/contracts';
import { assertStorageRoot } from '../connection/index.ts';
import { safeManagedChild } from '../files/index.ts';

// 每次只保留边界重叠和有限header/field，文件正文直接写staging。
export async function stageMultipart(source: AsyncIterable<Uint8Array>, contentType: string, stateRoot: string) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!contentType.startsWith('multipart/form-data') || !boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) throw new ContractError('VALIDATION_ERROR', '需要带有效boundary的multipart文件');
  assertStorageRoot(stateRoot); const staging = safeManagedChild(stateRoot, join(stateRoot, 'staging')); mkdirSync(staging, { recursive: true });
  const path = join(staging, `${randomUUID()}.multipart`); const marker = Buffer.from(`--${boundary}`); const separator = Buffer.from(`\r\n--${boundary}`);
  let buffer = Buffer.alloc(0); let state: 'boundary' | 'headers' | 'body' | 'done' = 'boundary';
  let field = ''; let fieldBytes: Buffer[] = []; let fieldSize = 0; let fileFd: number | null = null; let fileSeen = false; let mime = 'application/octet-stream';
  const fields: Record<string, string> = {};
  function body(bytes: Buffer) {
    if (field === 'file') { if (fileFd === null) throw new Error('file not open'); writeSync(fileFd, bytes); }
    else { fieldSize += bytes.length; if (fieldSize > 8192) throw new ContractError('VALIDATION_ERROR', 'multipart字段超过大小限制'); fieldBytes.push(bytes); }
  }
  function finishPart() {
    if (field === 'file') { if (fileFd !== null) closeSync(fileFd); fileFd = null; }
    else fields[field] = Buffer.concat(fieldBytes).toString('utf8');
    fieldBytes = []; fieldSize = 0;
  }
  try {
    for await (const chunk of source) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (true) {
        if (state === 'done') { if (buffer.length > 2) throw new ContractError('VALIDATION_ERROR', 'multipart尾部无效'); break; }
        if (state === 'boundary') {
          if (buffer.length < marker.length + 2) break;
          if (!buffer.subarray(0, marker.length).equals(marker)) throw new ContractError('VALIDATION_ERROR', 'multipart边界不匹配');
          const tail = buffer.subarray(marker.length, marker.length + 2).toString(); buffer = buffer.subarray(marker.length + 2);
          if (tail === '--') { state = 'done'; continue; }
          if (tail !== '\r\n') throw new ContractError('VALIDATION_ERROR', 'multipart分隔无效'); state = 'headers';
        }
        if (state === 'headers') {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) { if (buffer.length > 65536) throw new ContractError('VALIDATION_ERROR', 'multipart header过长'); break; }
          const headers = buffer.subarray(0, end).toString('utf8'); buffer = buffer.subarray(end + 4);
          field = /content-disposition:[^\r\n]*\bname="([^"]+)"/i.exec(headers)?.[1] ?? '';
          if (!['file', 'topic_id', 'purpose'].includes(field) || field in fields) throw new ContractError('VALIDATION_ERROR', 'multipart字段无效或重复');
          if (field === 'file') {
            if (fileSeen) throw new ContractError('VALIDATION_ERROR', '一次只接受一个file'); fileSeen = true;
            mime = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? 'application/octet-stream';
            if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime)) throw new ContractError('VALIDATION_ERROR', '文件MIME无效');
            fileFd = openSync(path, 'wx', 0o600);
          }
          state = 'body';
        }
        if (state === 'body') {
          const end = buffer.indexOf(separator);
          if (end >= 0) { body(buffer.subarray(0, end)); finishPart(); buffer = buffer.subarray(end + 2); state = 'boundary'; continue; }
          const safeSize = buffer.length - separator.length - 4;
          if (safeSize > 0) { body(buffer.subarray(0, safeSize)); buffer = buffer.subarray(safeSize); }
          break;
        }
      }
    }
    if (state !== 'done' || !fileSeen) throw new ContractError('VALIDATION_ERROR', 'multipart文件不完整');
    return { path, fields, mime };
  } catch (error) { if (fileFd !== null) closeSync(fileFd); try { unlinkSync(path); } catch { /* 仅清除此请求临时文件。 */ } throw error; }
}
