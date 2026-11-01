import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync, renameSync, readdirSync, statSync, openSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join, isAbsolute, basename } from 'node:path';
import { ContractError, type JsonObject, type JsonValue, type AgentRunHandle, type AgentRunInput } from '@workbench/contracts';

export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function redact(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /secret|email|encrypted|credential|authorization|accessToken|refreshToken|accountId|balance|resetCredits/i.test(key) ? '[REDACTED]' : redact(item)]));
  if (typeof value === 'string') return value.replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]').replace(/\b(?:sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]{30,})\b/g, '[SECRET]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  return value === undefined ? null : value as JsonValue;
}
export class Queue<T> implements AsyncIterable<T> {
  private values: T[] = []; private readers: Array<{ resolve(value: IteratorResult<T>): void; reject(error: Error): void }> = []; private end = false; private error?: Error;
  push(value: T): void { if (this.end) return; const reader = this.readers.shift(); if (reader) reader.resolve({ value, done: false }); else this.values.push(value); }
  close(error?: Error): void { if (this.end) return; this.end = true; this.error = error; for (const reader of this.readers.splice(0)) error ? reader.reject(error) : reader.resolve({ value: undefined, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<T> { return { next: async () => { if (this.values.length) return { value: this.values.shift()!, done: false }; if (this.end) { if (this.error) throw this.error; return { value: undefined, done: true }; } return new Promise((resolve, reject) => this.readers.push({ resolve, reject })); } }; }
}
// 固定 generated schema 的 JSON-Schema 验证器；只使用本机协议出现的断言，不执行 schema 中的代码。
export function matches(value: unknown, schema: unknown, root: unknown = schema): boolean {
  if (schema === true) return true; if (schema === false || !object(schema)) return false;
  if (typeof schema.$ref === 'string') { if (!schema.$ref.startsWith('#/')) return false; let ref: unknown = root; for (const key of schema.$ref.slice(2).split('/')) ref = object(ref) ? ref[key.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined; return matches(value, ref, root); }
  if (Array.isArray(schema.allOf) && !schema.allOf.every(s => matches(value, s, root))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(s => matches(value, s, root))) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(s => matches(value, s, root)).length !== 1) return false;
  if (schema.const !== undefined && canonical(value) !== canonical(schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some(item => canonical(item) === canonical(value))) return false;
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(t => t === type || (t === 'integer' && typeof value === 'number' && Number.isInteger(value)))) return false;
  if (typeof value === 'number' && (!Number.isFinite(value) || (typeof schema.minimum === 'number' && value < schema.minimum) || (typeof schema.maximum === 'number' && value > schema.maximum))) return false;
  if (typeof value === 'string' && ((typeof schema.minLength === 'number' && value.length < schema.minLength) || (typeof schema.maxLength === 'number' && value.length > schema.maxLength))) return false;
  if (Array.isArray(value)) { if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false; if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false; if (schema.items !== undefined && !value.every(item => matches(item, schema.items, root))) return false; }
  if (object(value)) { const properties = object(schema.properties) ? schema.properties : {}; if (Array.isArray(schema.required) && schema.required.some(k => typeof k !== 'string' || !(k in value))) return false; for (const [key, item] of Object.entries(value)) { if (key in properties) { if (!matches(item, properties[key], root)) return false; } else if (schema.additionalProperties === false || (object(schema.additionalProperties) && !matches(item, schema.additionalProperties, root))) return false; } }
  return true;
}
const OUTPUT_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', '$ref', '$defs', 'definitions', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'title', 'description', '$schema']);
export function assertOutputSchema(schema: unknown): void {
  if (schema === true || schema === false) return;
  if (!object(schema) || Object.keys(schema).some(key => !OUTPUT_KEYS.has(key))) throw new ContractError('VALIDATION_ERROR', '输出 schema 使用未支持的约束');
  for (const key of ['properties', '$defs', 'definitions']) if (object(schema[key])) for (const child of Object.values(schema[key])) assertOutputSchema(child);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(schema[key])) for (const child of schema[key]) assertOutputSchema(child);
  for (const key of ['items', 'additionalProperties']) if (schema[key] !== undefined) assertOutputSchema(schema[key]);
}
export function fixedCwd(cwd: string): string { if (!isAbsolute(cwd) || realpathSync(cwd) !== cwd) throw new ContractError('VALIDATION_ERROR', 'cwd 必须是现存规范绝对路径'); return cwd; }
export function nativeBindingHash(checkpoint: JsonObject): string {
  return hash(canonical({ executor_id: checkpoint.executor_id, workspace_id: checkpoint.workspace_id, cwd: checkpoint.cwd,
    runtime_session_id: checkpoint.runtime_session_id, runtime_turn_id: checkpoint.runtime_turn_id ?? null, run_input_hash: checkpoint.run_input_hash }));
}
// 恢复只能消费产生句柄时记录的身份，不能从待恢复的外层句柄补写旧证据。
export function assertNativeRunBinding(handle: AgentRunHandle, executor: string, workspace: string, allowMissingTurn = false): AgentRunInput {
  const checkpoint = handle.checkpoint;
  const stale = (message: string): never => { throw new ContractError('INPUT_STALE', message, { pre_submit_failure: true, no_new_turn_started: true }); };
  if (checkpoint.executor_id !== executor || !object(checkpoint.run_input)) stale('恢复执行器或固定输入不符');
  const fixed = checkpoint.run_input as unknown as AgentRunInput;
  if (typeof fixed.job_id !== 'string' || !fixed.job_id || !object(fixed.input_manifest) || hash(canonical(fixed.input_manifest)) !== checkpoint.input_hash) stale('恢复固定任务或输入 hash 不符');
  if (checkpoint.run_input_hash !== undefined && checkpoint.run_input_hash !== hash(canonical(fixed))) stale('恢复完整输入绑定不符');
  if (['workspace_id','run_input_hash','native_binding_hash'].some(key=>typeof checkpoint[key]!=='string'||!checkpoint[key]))
    throw new ContractError('RESULT_UNKNOWN','恢复绑定记录不完整，未查询或提交新任务',{pre_submit_failure:true,no_new_turn_started:true});
  if (typeof checkpoint.runtime_session_id !== 'string' || !checkpoint.runtime_session_id ||
    ((typeof checkpoint.runtime_turn_id !== 'string' || !checkpoint.runtime_turn_id) && !(allowMissingTurn && checkpoint.runtime_turn_id === undefined && handle.runtime_turn_id === undefined)))
    throw new ContractError('RESULT_UNKNOWN', '旧 checkpoint 缺少可核对的原生身份，未查询或提交新任务', { pre_submit_failure: true, no_new_turn_started: true });
  if (handle.runtime_session_id !== checkpoint.runtime_session_id || handle.runtime_turn_id !== checkpoint.runtime_turn_id) stale('恢复句柄内外原生身份不符');
  if (checkpoint.workspace_id !== undefined && checkpoint.workspace_id !== workspace) stale('恢复工作区身份不符');
  if (checkpoint.native_binding_hash !== undefined && checkpoint.native_binding_hash !== nativeBindingHash(checkpoint)) stale('恢复原生身份与完整输入绑定不符');
  const frozen = object(fixed.input_manifest.frozen) ? fixed.input_manifest.frozen : fixed.input_manifest;
  if (Array.isArray(frozen.targets)) {
    const first = frozen.targets[0];
    if (fixed.target_document_id !== (object(first) ? first.document_id : null) ||
      fixed.base_revision_id !== (object(first) ? first.base_revision_id : null) ||
      (fixed.core_revision_id ?? null) !== (object(first) ? first.core_revision_id ?? null : null)) stale('恢复固定目标或修订绑定不符');
  }
  if (object(frozen.service_agent) && typeof frozen.service_agent.task_instruction === 'string' && fixed.task_instruction !== frozen.service_agent.task_instruction) stale('恢复固定指令与计划不符');
  return fixed;
}
export interface WorkspaceSlot { (): void; readonly id: string; starting(): void; bindChild(pid: number): void; childExited(): void; markUnverified(reason: string): void }
export function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return !(object(error) && error.code === 'ESRCH'); } }
// 进程启动时间写入槽位记录，用于识别 pid 复用：pid 存活但启动时间不符视为原 owner 已死。
// Linux 取 /proc/<pid>/stat 的 starttime（开机后的时钟滴答数，started_at_source=proc_stat），精确比较。
// 不能用 ps -o lstart：它等于 btime + starttime，而 btime 随墙钟跳变（WSL2 宿主对时每 ~30s 前跳约 2s），
// 同一个活进程的 lstart 会漂移数秒，被误判为已死、槽位被抢，突破容量互斥。
// 其他平台（macOS）用 ps -o lstart（记录的是进程启动时的绝对时间，不随之后的墙钟调整变化），秒级精度、2s 容差。
// 本进程的值首次使用时取得，与核对他人时同一来源；启动器 exec 前停留再久也一致。
// 取不到时退回 timeOrigin（started_at_source=time_origin），这类记录不以启动时间判死，只看 pid 是否存活。
type StartSource = 'proc_stat' | 'ps';
const startSource: StartSource = process.platform === 'linux' ? 'proc_stat' : 'ps';
let ownStart: { started_at: number; started_at_source: StartSource | 'time_origin' } | undefined;
export function processStartRecord(): { started_at: number; started_at_source: StartSource | 'time_origin' } {
  if (!ownStart) { const value = processStartedAt(process.pid); ownStart = value === null ? { started_at: Math.round(performance.timeOrigin), started_at_source: 'time_origin' } : { started_at: value, started_at_source: startSource }; }
  return ownStart;
}
const startTimes = new Map<number, { value: number | null; at: number }>();
// 仅供测试：向启动时间缓存注入旧值，模拟 pid 在缓存有效期内被新进程复用。生产代码不调用。
export function seedProcessStartCacheForTest(pid: number, value: number | null): void { startTimes.set(pid, { value, at: Date.now() }); }
// fresh=true 时跳过缓存直接重读：缓存值与记录不一致时，可能是 pid 在 1 秒内被复用，旧值不能用来判死。
function processStartedAt(pid: number, fresh = false): number | null {
  const cached = startTimes.get(pid); if (!fresh && cached && Date.now() - cached.at < 1_000) return cached.value;
  let value: number | null = null;
  if (startSource === 'proc_stat') {
    // comm 字段可含空格和括号：从最后一个 ')' 之后切分，第 22 字段 starttime 是其后的第 20 个。
    try { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'); const ticks = Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[19]); value = Number.isSafeInteger(ticks) ? ticks : null; } catch { value = null; }
  } else {
    try { const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 2_000 }).trim(); const parsed = Date.parse(text); value = Number.isFinite(parsed) ? parsed : null; } catch { value = null; }
  }
  startTimes.set(pid, { value, at: Date.now() }); return value;
}
export function ownerAlive(owner: Record<string, unknown>): boolean {
  const pid = owner.pid as number; if (!alive(pid)) return false;
  if (typeof owner.started_at !== 'number') return true;
  if (pid === process.pid) return owner.started_at === processStartRecord().started_at;
  // 只有与本平台同源的记录才按启动时间判死；time_origin、旧版 Linux 上的 ps 记录或其他来源，保守地只看 pid 存活。
  if (owner.started_at_source !== startSource) return true;
  const matches = (actual: number | null): boolean => actual === null || (startSource === 'proc_stat' ? actual === owner.started_at : Math.abs(actual - (owner.started_at as number)) < 2_000);
  // 缓存只在与记录一致时直接采信；不一致必须重读一次再判，重读值一致即判活。
  return matches(processStartedAt(pid)) || matches(processStartedAt(pid, true));
}
// starting 一律 fail closed（池槽位与旧单锁一致）：owner 可能在 spawn 之后、bindChild 落盘之前死亡，
// 此时 child 可能仍存活且未登记 pid，回收会突破容量并让未登记的 child 继续提交。
function recoverable(owner: Record<string, unknown>): boolean { return Number.isSafeInteger(owner.pid) && !ownerAlive(owner) &&
  ((['none', 'unverified'].includes(String(owner.child_state)) && owner.child_pid === null) || (['spawned', 'unverified'].includes(String(owner.child_state)) && Number.isSafeInteger(owner.child_pid) && !alive(owner.child_pid as number))); }
// capacity:5 为旧调用的五槽池；pool 指定服务配置的池大小（1–10）。未指定时保留旧单锁语义。
export interface SlotOptions { capacity?: 1 | 5; pool?: number; task_id?: string; resources?: readonly string[] }
const POOL_FILES = 10;
export function executionResources(input: { target_document_id?: string | null; input_manifest: JsonObject }): string[] {
  const manifest = input.input_manifest, frozen = object(manifest.frozen) ? manifest.frozen : manifest;
  const documents = Array.isArray(frozen.targets) ? frozen.targets.flatMap(target => object(target) && typeof target.document_id === 'string' ? [target.document_id] : []) : [];
  const flow = object(frozen.writing_flow) ? frozen.writing_flow.run_id : undefined;
  return [...new Set([...documents, ...(input.target_document_id ? [input.target_document_id] : [])].map(id => `document:${id}`).concat(typeof flow === 'string' ? [`writing-run:${flow}`] : []))];
}
function admits(occupied: Record<string, unknown>[], size: number, taskId: string | null, resources: readonly string[]): boolean {
  return occupied.length < size && !occupied.some(previous => (taskId && previous.task_id === taskId) || !Array.isArray(previous.resources) || previous.resources.some(resource => resources.includes(String(resource))));
}
// 领取前只读预检：与 acquirePool 相同的占用判定，不回收、不写入。用于避免槽位占满时反复领取再退回。
// 预检与真正领取之间的跨进程竞争仍由 acquirePool 判定，失败走容量退回路径。
export function poolAvailable(root: string, workspace: string, options: { pool: number; task_id?: string; resources?: readonly string[] }): boolean {
  const prefix = hash(workspace); if (!existsSync(root)) return options.pool >= 1;
  const read = (path: string): Record<string, unknown> | null => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
  try { return withPoolMutex(root, prefix, 'pool', () => {
    const occupied: Record<string, unknown>[] = [];
    for (let index = 0; index < POOL_FILES; index++) { const previous = readSlotRecord(root, join(root, `${prefix}.slot-${index}.lock`)); if (previous && !recoverable(previous)) occupied.push(previous); }
    for (const id of ['codex', 'claude']) { const previous = read(join(root, `${prefix}-${id}.lock`)); if (previous && previous.pool !== prefix && !recoverable(previous)) return false; }
    return admits(occupied, options.pool, options.task_id ?? null, options.resources ?? []);
  }); } catch { return false; }
}
function busy(executor: string): ContractError { return new ContractError('CAPABILITY_UNVERIFIED', '执行器槽位占用，任务继续排队', { executor_id: executor, executor_capacity_busy: true, pre_submit_failure: true }); }
// 旧调用保留单锁语义；服务显式开启五槽。共享池横跨 Codex/Claude，旧版本看到 sentinel 仍会阻塞。
export function acquire(root: string, workspace: string, executor: string, options: SlotOptions = {}): WorkspaceSlot {
  if (options.pool !== undefined || options.capacity === 5) return acquirePool(root, workspace, executor, options);
  mkdirSync(root, { recursive: true }); const path = join(root, `${hash(workspace)}-${executor}.lock`), token = randomUUID();
  const owner = { pid: process.pid, token, child_pid: null as number | null, child_state: 'none' };
  let released = false;
  const create = () => writeFileSync(path, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  try { create(); } catch {
    // 恢复 mutex 防止两个重启进程同时清理死 owner；原生 child 仍活着或身份未知时保持 blocked。
    const mutex = `${path}.recovery`; let held = false;
    try { writeFileSync(mutex, token, { flag: 'wx', mode: 0o600 }); held = true; const previous = JSON.parse(readFileSync(path, 'utf8'));
      if (!recoverable(previous)) throw new Error('owner/native child still active or unknown');
      rmSync(path); create();
    } catch { throw busy(executor); }
    finally { if (held) rmSync(mutex); }
  }
  const update = () => { if (JSON.parse(readFileSync(path, 'utf8')).token !== token) throw new ContractError('HOST_RUN_NOT_CURRENT', '执行器锁归属变化'); writeFileSync(path, JSON.stringify(owner), { mode: 0o600 }); };
  let unverified = false;
  const release = (() => { if (released || unverified) return; try { if (JSON.parse(readFileSync(path, 'utf8')).token === token && owner.child_state !== 'starting' && (owner.child_pid === null || !alive(owner.child_pid))) { rmSync(path); released = true; } } catch { /* 锁已清理或仍待核对。 */ } }) as WorkspaceSlot;
  Object.defineProperty(release, 'id', { value: basename(path) });
  release.starting = () => { owner.child_state = 'starting'; update(); };
  release.bindChild = pid => { owner.child_pid = pid; owner.child_state = 'spawned'; update(); };
  release.childExited = () => { if (released) return; owner.child_pid = null; owner.child_state = 'none'; update(); };
  // 清理失败时保留占用并标记待核对；磁盘仍不可写时只保留内存状态，进程重启后按 owner 死亡回收。
  release.markUnverified = reason => { if (released) return; unverified = true; owner.child_state = 'unverified'; Object.assign(owner, { unverified_reason: reason }); try { update(); } catch { /* 保持占用。 */ } };
  return release;
}
// 跨进程互斥：锁目录旁的专用 SQLite 文件，BEGIN IMMEDIATE 取得 OS 级文件锁；持有进程崩溃或被 SIGKILL 时
// 锁由内核释放，不留残留文件。临界区必须是纯同步文件操作。放在锁目录旁边而不是里面，锁目录仍只含槽位文件。
// 每个锁目录一个连接，并记下打开时互斥文件的 dev/ino。运行中互斥文件被删除或替换时，不同进程会锁到不同
// inode 而失去互斥，因此一经发现即标记损坏并拒绝继续进入（不自动重建），停止领取直到重启核对。
const mutexes = new Map<string, { db: DatabaseSync; dev: number; ino: number }>();
const brokenMutexes = new Set<string>();
// 待结算队列：child 已确认退出，但结算（childExited + 释放）因互斥超时没完成的槽位。下一次任何调用成功进入
// 同一锁目录的互斥时，先在锁内补结算，避免槽位静默泄漏。
interface PendingSettlement { root: string; slot: string; job_id: string; settle(): void }
const pendingSettlements: PendingSettlement[] = [];
function settlementRecovery(root: string, slot: string): string { return `槽位文件 ${basename(root)}/${slot} 待结算（child 已退出）。互斥恢复后本进程下一次领取会自动结算；若本进程先退出，重启服务后 owner 死亡即可回收（状态为 starting 时需核对 child 已退出后手动删除该文件）`; }
let exitWatched = false;
// 进程退出时若仍有未结算槽位，留下一行可追查的日志。
function watchUnsettledAtExit(): void {
  if (exitWatched) return; exitWatched = true;
  process.once('exit', () => { if (!pendingSettlements.length) return; poolReport('pending_settlement', { outcome: 'unsettled_at_exit', slots: pendingSettlements.map(item => `${basename(item.root)}/${item.slot}`), recovery: '重启服务后 owner 死亡即可回收这些槽位；状态为 starting 的需核对 child 已退出后手动删除对应文件' }); });
}
export function pendingSettlementCount(root?: string): number { return pendingSettlements.filter(item => !root || item.root === root).length; }
function drainSettlements(root: string): void {
  for (const item of pendingSettlements.filter(entry => entry.root === root)) {
    try { item.settle(); pendingSettlements.splice(pendingSettlements.indexOf(item), 1); poolReport('pending_settlement', { lock_root: basename(root), slot: item.slot, job_id: item.job_id, outcome: 'settled', remaining: pendingSettlementCount() }); }
    catch (error) { poolReport('pending_settlement', { lock_root: basename(root), slot: item.slot, job_id: item.job_id, outcome: 'retry_later', message: error instanceof Error ? error.message : String(error) }); }
  }
}
// 只能在互斥内调用：无法解析的槽位文件改名为 <name>.corrupt-<时间戳> 保留现场、记日志，该槽位视为空闲。
// 否则一个损坏文件会让整个池永久忙且没有诊断。不存在时返回 null。
function readSlotRecord(root: string, path: string): Record<string, unknown> | null {
  let text: string; try { text = readFileSync(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try { const value: unknown = JSON.parse(text); if (object(value)) return value; } catch { /* 下面隔离。 */ }
  let quarantined = `${path}.corrupt-${Date.now()}`; for (let n = 1; existsSync(quarantined); n++) quarantined = `${path}.corrupt-${Date.now()}-${n}`; renameSync(path, quarantined);
  poolReport('corrupt_slot', { lock_root: basename(root), slot: basename(path), quarantined_as: basename(quarantined), bytes: text.length });
  return null;
}
export function poolMutexHealth(root: string): { broken: boolean } { return { broken: brokenMutexes.has(root) }; }
function markBroken(root: string): void { if (!brokenMutexes.has(root)) poolReport('pool_mutex_broken', { lock_root: basename(root), recovery: '执行器互斥文件已被删除或替换，生成任务已停止领取。核对锁目录与旁边的 .pool-mutex.sqlite 后重启服务' }); brokenMutexes.add(root); const entry = mutexes.get(root); if (entry) { try { entry.db.close(); } catch { /* 已关闭。 */ } mutexes.delete(root); } }
function mutexBroken(): ContractError { return new ContractError('STORAGE_UNAVAILABLE', '执行器互斥文件已被删除或替换，已停止领取；请核对后重启服务', { pool_mutex_broken: true }); }
export function poolMutexPath(root: string): string { return `${root.replace(/[\\/]+$/, '')}.pool-mutex.sqlite`; }
// 互斥失败的错误语义由调用阶段决定：只有领取前（acquirePool/预检）可以报容量忙并带 pre_submit_failure；
// 领取后（starting/bindChild/childExited 等状态写入）失败时 child 可能已启动，只能报提交状态未知，不得自动重排队。
export function stateUnknown(executor: string): ContractError { return new ContractError('RESULT_UNKNOWN', '执行器槽位状态写入未完成，提交状态待核对', { executor_id: executor, slot_state_unknown: true }); }
// 仅供测试注入 COMMIT 失败；生产代码不设置。
export const poolMutexTestHooks: { beforeCommit?: () => void; afterOpen?: (file: string) => void; afterCommitFailure?: () => void } = {};
// 槽位池自身的诊断通道（无适配器 sink 可用的场景）：服务启动时订阅并写入同一条 cleanup_error 日志。
const poolListeners = new Set<(entry: Trace) => void>();
export function onPoolDiagnostic(listener: (entry: Trace) => void): () => void { poolListeners.add(listener); return () => { poolListeners.delete(listener); }; }
export function poolReport(step: string, detail: Record<string, unknown>): void {
  const entry: Trace = { at: new Date().toISOString(), direction: 'cleanup_error', message: redact({ scope: 'executor_pool', step, ...detail }) };
  for (const listener of poolListeners) try { listener(entry); } catch { /* 诊断失败不影响执行。 */ }
}
export function withPoolMutex<T>(root: string, prefix: string, executor: string, act: () => T, fail: () => ContractError = () => busy(executor), compensate?: (result: T) => void, ioFailure?: (error: unknown) => unknown): T {
  if (brokenMutexes.has(root)) throw mutexBroken();
  const file = poolMutexPath(root); let entry = mutexes.get(root);
  try {
    if (!entry) {
      // 首次打开：打开前、打开后各 stat 一次（拿锁后还有第三次），三者 dev/ino 一致才缓存，
      // 防止 open 与 stat 之间文件被替换，导致连接打开的是 A 却记下 B 的身份。
      closeSync(openSync(file, 'a', 0o600)); const before = statSync(file);
      const db = new DatabaseSync(file); poolMutexTestHooks.afterOpen?.(file);
      let after: { dev: number; ino: number } | undefined; try { after = statSync(file); } catch { after = undefined; }
      if (!after || after.dev !== before.dev || after.ino !== before.ino) { try { db.close(); } catch { /* 已关闭。 */ } markBroken(root); throw mutexBroken(); }
      db.exec('PRAGMA busy_timeout=2000'); entry = { db, dev: before.dev, ino: before.ino }; mutexes.set(root, entry);
    }
    entry.db.exec('BEGIN IMMEDIATE');
  } catch (error) { if (error instanceof ContractError && error.details.pool_mutex_broken === true) throw error; throw fail(); }
  const db = entry.db;
  // 取得锁之后核对路径上仍是打开时的那个文件；否则本次锁住的是脱离路径的旧 inode，与其他进程不互斥。
  let current: { dev: number; ino: number } | undefined; try { current = statSync(file); } catch { current = undefined; }
  if (!current || current.dev !== entry.dev || current.ino !== entry.ino) { try { db.exec('ROLLBACK'); } catch { /* 已结束。 */ } markBroken(root); throw mutexBroken(); }
  try {
    // 旧 guard/recovery 机制的残留文件直接清理；互斥已由 SQLite 保证。
    for (const name of readdirSync(root)) if (name.startsWith(`${prefix}.pool-guard`)) rmSync(join(root, name), { force: true });
    drainSettlements(root);
    const result = act();
    // ROLLBACK 不会撤销已写的槽位文件。COMMIT 失败时 SQLite 可能已回滚并释放锁，必须重新取得互斥后
    // 才能补偿删除本次写入；重新取锁失败则不删任何文件（fail closed），只记录诊断并报错。
    try { poolMutexTestHooks.beforeCommit?.(); db.exec('COMMIT'); } catch (commitError) {
      try { db.exec('ROLLBACK'); } catch { /* 已自动回滚。 */ }
      if (compensate) {
        let relocked = false;
        try { poolMutexTestHooks.afterCommitFailure?.(); db.exec('BEGIN IMMEDIATE'); relocked = true; } catch { /* 取锁超时。 */ }
        let same = false; if (relocked) { try { const now = statSync(file); same = now.dev === entry.dev && now.ino === entry.ino; } catch { same = false; } }
        if (relocked && same) {
          try { compensate(result); db.exec('COMMIT'); }
          catch (error) { try { db.exec('ROLLBACK'); } catch { /* 已结束。 */ } poolReport('commit_compensation', { lock_root: basename(root), outcome: 'compensation_failed', message: error instanceof Error ? error.message : String(error) }); }
        } else {
          if (relocked) { try { db.exec('ROLLBACK'); } catch { /* 已结束。 */ } markBroken(root); }
          const kept = typeof result === 'string' ? basename(result) : null;
          poolReport('commit_compensation', { lock_root: basename(root), outcome: relocked ? 'mutex_replaced' : 'relock_failed', files_kept: true, slot: kept, recovery: `槽位文件 ${basename(root)}/${kept ?? '(本次写入的槽位)'} 属于本进程且未能撤销；重启本服务进程后 owner 死亡即可被自动回收，或停服核对后手动删除该文件`, message: commitError instanceof Error ? commitError.message : String(commitError) });
        }
      }
      throw fail();
    }
    return result;
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* 已结束。 */ } if (error instanceof ContractError) throw error; if (ioFailure) throw ioFailure(error); throw fail(); }
}
function acquirePool(root: string, workspace: string, executor: string, options: SlotOptions): WorkspaceSlot {
  mkdirSync(root, { recursive: true });
  const prefix = hash(workspace), token = randomUUID();
  const size = options.pool ?? 5; if (!Number.isSafeInteger(size) || size < 1 || size > POOL_FILES) throw new ContractError('VALIDATION_ERROR', '执行器槽位池大小无效');
  // 始终核对全部槽位文件：上限调小后，旧配置下仍在运行的高位槽位继续计入占用。
  const paths = Array.from({ length: POOL_FILES }, (_, index) => join(root, `${prefix}.slot-${index}.lock`));
  const legacy = ['codex', 'claude'].map(id => join(root, `${prefix}-${id}.lock`));
  const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'));
  const dead = recoverable;
  const exclusive = <T>(act: () => T, fail?: () => ContractError, compensate?: (result: T) => void): T => withPoolMutex(root, prefix, executor, act, fail, compensate);
  const owner = { pid: process.pid, ...processStartRecord(), token, executor, task_id: options.task_id ?? null, resources: [...(options.resources ?? [])], child_pid: null as number | null, child_state: 'none' };
  let released = false;
  const path = exclusive(() => {
    const occupied: Record<string, unknown>[] = [];
    for (const candidate of paths) { const previous = readSlotRecord(root, candidate); if (!previous) continue; if (recoverable(previous)) rmSync(candidate); else occupied.push(previous); }
    for (const candidate of legacy) if (existsSync(candidate)) { const previous = read(candidate);
      if (previous.pool === prefix) continue;
      if (!dead(previous)) throw busy(executor); rmSync(candidate);
    }
    const free = admits(occupied, size, owner.task_id, owner.resources) ? paths.find(candidate => !existsSync(candidate)) : undefined; if (!free) throw busy(executor);
    for (const candidate of legacy) {
      try { writeFileSync(candidate, JSON.stringify({ pid: process.pid, token: prefix, pool: prefix, child_pid: null, child_state: 'starting' }), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      // 旧 acquire 不认识 pool guard；wx 竞争后重新核实，不能把刚抢入的旧锁当作 sentinel。
      if (read(candidate).pool !== prefix) throw busy(executor);
    }
    writeFileSync(free, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); return free;
  }, undefined, written => { if (existsSync(written) && read(written).token === token) rmSync(written);
    if (!paths.some(candidate => existsSync(candidate))) for (const candidate of legacy) if (existsSync(candidate) && read(candidate).pool === prefix) rmSync(candidate); });
  const update = () => withPoolMutex(root, prefix, executor, () => {
    if (read(path).token !== token) throw new ContractError('HOST_RUN_NOT_CURRENT', '执行器槽位归属变化');
    const temporary = `${path}.${token}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
  }, () => stateUnknown(executor), undefined,
  // 锁内写盘/IO 失败（ENOSPC、EACCES 等）不是互斥超时：保留原错误码并标 slot_write_failed，由 settleSlot 走 unverified。
  error => Object.assign(error instanceof Error ? error : new Error(String(error)), { slot_write_failed: true }));
  let unverified = false;
  const release = (() => {
    if (released || unverified) return;
    if (owner.child_state === 'starting' || (owner.child_pid !== null && alive(owner.child_pid))) return;
    try { exclusive(() => {
      if (existsSync(path) && read(path).token === token) { rmSync(path); released = true; }
      if (!paths.some(candidate => existsSync(candidate))) for (const candidate of legacy) if (existsSync(candidate) && read(candidate).pool === prefix) rmSync(candidate);
    }); } catch { const retry = setTimeout(() => release(), 10); retry.unref(); }
  }) as WorkspaceSlot;
  Object.defineProperty(release, 'id', { value: basename(path) });
  // 锁内补结算（只由待结算队列在已持有互斥时调用）：等同 childExited + 释放。
  Object.defineProperty(release, 'deferredSettlement', { value: { root, settle: () => {
    if (released) return; owner.child_pid = null; owner.child_state = 'none';
    if (existsSync(path) && read(path).token === token) rmSync(path); released = true;
    if (!paths.some(candidate => existsSync(candidate))) for (const candidate of legacy) if (existsSync(candidate) && read(candidate).pool === prefix) rmSync(candidate);
  } } });
  release.starting = () => { owner.child_state = 'starting'; update(); };
  release.bindChild = pid => { owner.child_pid = pid; owner.child_state = 'spawned'; update(); };
  release.childExited = () => { if (released) return; owner.child_pid = null; owner.child_state = 'none'; update(); };
  release.markUnverified = reason => { if (released) return; unverified = true; owner.child_state = 'unverified'; Object.assign(owner, { unverified_reason: reason }); try { update(); } catch { /* 保持占用。 */ } };
  return release;
}
// 子进程退出后的清理逐步隔离：任何一步失败只记录并把槽位留作待核对，不得抛出影响其他并发任务。
export function settleSlot(slot: WorkspaceSlot, sink: TraceSink | undefined, job_id: string, directory?: string): void {
  const fault = (step: string, error: unknown) => { try { trace(sink, 'cleanup_error', { job_id, slot: slot.id, step, code: object(error) && typeof error.code === 'string' ? error.code : null, message: error instanceof Error ? error.message : String(error) }); } catch { /* 诊断通道失败不影响清理。 */ } };
  let settled = true;
  try { slot.childExited(); } catch (error) {
    settled = false; fault('child_exited', error);
    // 互斥超时（状态未知）不是写盘错误：进待结算队列，下一次进入互斥时补结算，而不是留作永久待核对。
    const deferred = (slot as unknown as { deferredSettlement?: { root: string; settle(): void } }).deferredSettlement;
    if (deferred && object(error) && object(error.details) && error.details.slot_state_unknown === true) {
      if (!pendingSettlements.some(item => item.settle === deferred.settle)) pendingSettlements.push({ root: deferred.root, slot: slot.id, job_id, settle: deferred.settle });
      watchUnsettledAtExit();
      poolReport('pending_settlement', { lock_root: basename(deferred.root), slot: slot.id, job_id, outcome: 'queued', pending: pendingSettlementCount(), recovery: settlementRecovery(deferred.root, slot.id) });
      if (directory) try { rmSync(directory, { recursive: true, force: true }); } catch (cleanup) { fault('private_directory', cleanup); }
      return;
    }
  }
  if (settled) try { slot(); } catch (error) { settled = false; fault('release', error); }
  if (!settled) try { slot.markUnverified('cleanup_failed'); } catch (error) { fault('mark_unverified', error); }
  if (directory) try { rmSync(directory, { recursive: true, force: true }); } catch (error) { fault('private_directory', error); }
}
export function providerError(value: unknown): ContractError {
  const text = canonical(redact(value)), lower = text.toLowerCase();
  const code = /invalid_json_schema|invalid schema|schema validation/i.test(text) ? 'VALIDATION_ERROR' : /quota|usage.?limit|rate.?limit|usageLimitExceeded|429/i.test(text) ? 'QUOTA_EXHAUSTED' : /unauthorized|not.?logged|auth.?required|401|token.?expired/.test(lower) ? 'AUTH_REQUIRED' : 'RESULT_UNKNOWN';
  return new ContractError(code, '原生执行器未完成', { native_error: redact(value) }, code === 'QUOTA_EXHAUSTED');
}
// 本进程收到的原生停止证明。只在有限时间与条数内保留；过期或被淘汰后回到跨重启行为
//（Codex 只读核对原 turn，Claude 保持 RESULT_UNKNOWN），不会把旧凭据当作恢复授权。
export const STOP_PROOF_TTL_MS = 24 * 60 * 60 * 1000, STOP_PROOF_LIMIT = 1000;
export class StopLedger {
  private entries = new Map<string, { value: string; at: number }>();
  now: () => number = Date.now;
  get size(): number { this.prune(); return this.entries.size; }
  get(key: string): string | undefined { this.prune(); return this.entries.get(key)?.value; }
  set(key: string, value: string): void { this.entries.delete(key); this.entries.set(key, { value, at: this.now() }); this.prune(); }
  delete(key: string): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
  private prune(): void {
    const expired = this.now() - STOP_PROOF_TTL_MS;
    for (const [key, entry] of this.entries) if (entry.at <= expired) this.entries.delete(key);
    while (this.entries.size > STOP_PROOF_LIMIT) this.entries.delete(this.entries.keys().next().value!);
  }
}
export interface Trace { at: string; direction: string; message: JsonValue }
export type TraceSink = (entry: Trace) => void;
export function trace(sink: TraceSink | undefined, direction: string, message: unknown): void { sink?.({ at: new Date().toISOString(), direction, message: redact(message) }); }
export function plain(value: unknown): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }
