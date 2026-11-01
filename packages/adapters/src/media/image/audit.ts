import { randomUUID } from 'node:crypto';
import { fchmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, writeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { ContractError } from '@workbench/contracts';
import { object, type TraceSink } from '../../agent/codex/primitives.ts';
import type { ImageProviderInput } from './types.ts';

export const imageAuditPath = (input: ImageProviderInput): string => join(input.work_directory, '.workbench-image-rpc.ndjson');
const nativeId = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
export function imageRpcAudit(input: ImageProviderInput, purpose: 'execute' | 'query'): TraceSink {
  const sessionId = randomUUID(), pending = new Map<number, string>(), path = imageAuditPath(input);
  return entry => {
    if (!['send', 'receive'].includes(entry.direction) || !object(entry.message)) return;
    const message = entry.message, params = object(message.params) ? message.params : {}, result = object(message.result) ? message.result : {};
    const requestId = typeof message.id === 'number' ? message.id : null;
    let method = typeof message.method === 'string' ? message.method : requestId !== null ? pending.get(requestId) ?? null : null;
    if (!method) return;
    if (entry.direction === 'send' && requestId !== null) pending.set(requestId, method);
    if (entry.direction === 'receive' && requestId !== null && !message.method) pending.delete(requestId);
    // Only protocol metadata is persisted. No params/body/account, settings, usage or stderr.
    const row = { schema_version: 'image-native-rpc.v1', session_id: sessionId, purpose, at: entry.at, direction: entry.direction,
      rpc_method: method, request_id: requestId, thread_id: nativeId(params.threadId), turn_id: nativeId(params.turnId),
      returned_thread_id: object(result.thread) ? nativeId(result.thread.id) : null,
      returned_turn_id: object(result.turn) ? nativeId(result.turn.id) : object(params.turn) ? nativeId(params.turn.id) : null,
      native_error_code: object(message.error) && typeof message.error.code === 'number' ? message.error.code : null };
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new ContractError('STORAGE_UNAVAILABLE', '图像 RPC 审计路径不是受控文件');
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600); const bytes = Buffer.from(JSON.stringify(row) + '\n');
      for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    }
    finally { closeSync(fd); }
  };
}
