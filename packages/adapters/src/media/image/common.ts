import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, constants } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ContractError, type JsonObject, type JsonValue } from '@workbench/contracts';
import { canonical, object } from '../../agent/codex/primitives.ts';
import { decode, metadata, fileHash } from '../render/tools.ts';
import type { ImageProviderInput, ImageProviderResult } from './types.ts';
import { decodedSizeVerification, validateSizeRequest } from './capabilities.ts';

export const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const unknown = (message: string, details: JsonObject = {}): ContractError => new ContractError('RESULT_UNKNOWN', message, { no_new_submit: true, ...details });
export function fingerprint(input: ImageProviderInput): string { return sha(canonical({ provider: input.provider, operation: input.operation,
  prompt: input.prompt, references: input.references.map(ref => ({ asset_id: ref.asset_id, sha256: ref.sha256 })),
  ...(input.size_request ? { size_request: input.size_request } : {}),
  workspace_id: input.binding.workspace_id, job_id: input.binding.job_id, input_hash: input.binding.input_hash })); }
export function bindingMarker(input: ImageProviderInput): string { return 'WORKBENCH_IMAGE_BINDING:' + canonical({ provider: input.provider, operation: input.operation, ...input.binding, request_hash: fingerprint(input) }); }
export function baseCheckpoint(input: ImageProviderInput): JsonObject {
  return { schema_version: 'image-native.v1', provider: input.provider, operation: input.operation,
    input_hash: input.binding.input_hash, original_binding: { ...input.binding }, original_input: asJson(input), request_hash: fingerprint(input),
    native_state: 'submit_intent', submit_count: 0, usage: null };
}
export function assertCheckpoint(input: ImageProviderInput, cp: JsonObject): void {
  if (cp.schema_version !== 'image-native.v1' || !object(cp.original_binding) || !object(cp.original_input)) throw unknown('图像恢复记录缺少原始输入绑定');
  const original = cp.original_input as unknown as ImageProviderInput;
  if (cp.provider !== input.provider || cp.operation !== input.operation || cp.input_hash !== input.binding.input_hash ||
    canonical(cp.original_binding as JsonObject) !== canonical(original.binding) || cp.request_hash !== fingerprint(input) || cp.request_hash !== fingerprint(original) ||
    cp.original_binding.workspace_id !== input.binding.workspace_id || cp.original_binding.job_id !== input.binding.job_id || cp.original_binding.input_hash !== input.binding.input_hash)
    throw new ContractError('INPUT_STALE', '图像恢复记录与原任务、尝试或完整输入不符', { pre_submit_failure: true, no_new_submit: true });
}
export function recordPath(input: ImageProviderInput): string { return join(input.work_directory, '.workbench-image-native.json'); }
export function startCheckpoint(input: ImageProviderInput, publish: (cp: JsonObject) => void): JsonObject | null {
  if (existsSync(recordPath(input))) {
    const cp = JSON.parse(readFileSync(recordPath(input), 'utf8')) as JsonObject; assertCheckpoint(input, cp); return cp;
  }
  mkdirSync(input.work_directory, { recursive: true, mode: 0o700 });
  mkdirSync(input.output_directory, { recursive: true, mode: 0o700 });
  const cp = baseCheckpoint(input);
  try { writeFileSync(recordPath(input), JSON.stringify(cp), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const current = JSON.parse(readFileSync(recordPath(input), 'utf8')) as JsonObject; assertCheckpoint(input, current); return current; }
  publish(structuredClone(cp)); return null;
}
export function saveCheckpoint(input: ImageProviderInput, cp: JsonObject, publish?: (cp: JsonObject) => void): void {
  assertCheckpoint(input, cp);
  // A torn local copy is deliberately unknown; durable service checkpoints remain authoritative.
  writeFileSync(recordPath(input), JSON.stringify(cp), { mode: 0o600 });
  publish?.(structuredClone(cp));
}
export async function validateInput(input: ImageProviderInput, id: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (input.size_request !== undefined) validateSizeRequest(input.size_request);
  if (input.provider !== id || !['generate', 'reference_edit'].includes(input.operation) || !input.prompt.trim() || input.prompt.length > 30_000 ||
    !isAbsolute(input.work_directory) || !isAbsolute(input.output_directory) ||
    !/^[a-f0-9]{64}$/.test(input.binding.input_hash) || !Number.isSafeInteger(input.binding.attempt_generation) || input.binding.attempt_generation < 1 ||
    ['workspace_id', 'job_id', 'attempt_id'].some(key => !input.binding[key as keyof typeof input.binding]))
    throw new ContractError('VALIDATION_ERROR', '图像任务输入或绑定无效', { pre_submit_failure: true });
  if ((input.operation === 'generate' && input.references.length !== 0) || (input.operation === 'reference_edit' && input.references.length !== 1))
    throw new ContractError('CAPABILITY_UNSUPPORTED', '当前仅支持生成或单参考编辑', { pre_submit_failure: true });
  for (const ref of input.references) {
    if (ref.purpose !== undefined && !['style', 'identity', 'content'].includes(ref.purpose))
      throw new ContractError('VALIDATION_ERROR', '图像参考用途无效', { pre_submit_failure: true });
    if (!isAbsolute(ref.file_path) || await fileHash(ref.file_path, signal) !== ref.sha256)
      throw new ContractError('INPUT_STALE', '图像参考文件 hash 已改变', { pre_submit_failure: true });
  }
}
export function containedFile(path: string, root: string): string {
  if (!isAbsolute(path)) throw unknown('原生图像路径不是绝对路径');
  const actual = realpathSync(path), actualRoot = realpathSync(root), rel = relative(actualRoot, actual);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !lstatSync(path).isFile()) throw unknown('原生图像路径越过本次产物目录');
  return actual;
}
export async function imageResult(source: string, input: ImageProviderInput, cp: JsonObject, model: string | null, signal: AbortSignal, declaredBytes?: number): Promise<ImageProviderResult> {
  signal.throwIfAborted(); const before = lstatSync(source);
  if (!before.isFile() || before.size < 20 || before.size > 30 * 1024 * 1024 || (declaredBytes !== undefined && before.size !== declaredBytes))
    throw unknown('原生图像字节数与记录不符');
  const bytes = readFileSync(source), mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' :
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' :
    bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'image/webp' : null;
  if (!mime) throw unknown('原生结果不是支持的真实图像格式');
  const expected = sha(bytes), extension = mime === 'image/jpeg' ? '.jpg' : mime === 'image/png' ? '.png' : '.webp';
  if (typeof cp.output_sha256 === 'string' && cp.output_sha256 !== expected) throw unknown('原生图像已保存 hash 与当前结果不符');
  mkdirSync(input.output_directory, { recursive: true, mode: 0o700 });
  const destination = resolve(input.output_directory, 'native-image-' + expected + extension);
  try { copyFileSync(source, destination, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!lstatSync(destination).isFile() || await fileHash(destination, signal) !== expected) throw unknown('图像复制或既有产物 hash 不符');
  try { await decode(destination, { signal }); }
  catch { throw unknown('原生图像无法完整解码'); }
  const info = await metadata(destination, { signal }), streams = Array.isArray(info.streams) ? info.streams : [];
  const video = streams.find(stream => object(stream) && stream.codec_type === 'video') as JsonObject | undefined;
  if (!video || typeof video.width !== 'number' || typeof video.height !== 'number' || video.width < 1 || video.height < 1 || streams.length !== 1)
    throw unknown('原生图像尺寸或流结构无效');
  if (await fileHash(destination, signal) !== expected) throw unknown('图像校验期间 hash 改变');
  const sizeVerification = decodedSizeVerification(input, video.width, video.height);
  return { file_path: destination, mime, width: video.width, height: video.height, sha256: expected,
    size_bytes: bytes.length, model, native: { ...cp, output_sha256: expected, image_bytes: bytes.length, fully_decoded: true,
      ...(sizeVerification ? { size_verification: sizeVerification } : {}) },
    usage: object(cp.usage) ? cp.usage as JsonObject : null };
}
export function numericUsage(value: unknown): JsonObject | null {
  if (!object(value)) return null;
  const result: JsonObject = {};
  for (const [key, number] of Object.entries(value)) if (typeof number === 'number' && Number.isFinite(number)) result[key] = number;
  return Object.keys(result).length ? result : null;
}
export function asJson(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
