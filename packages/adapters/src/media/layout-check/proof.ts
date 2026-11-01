import { canonical, hash, matches, object } from '../../agent/codex/primitives.ts';
import { isAbsolute, normalize } from 'node:path';
import { validateLayoutVisualInput, layoutVisualManifestHash, layoutBindingEquals, layoutCheckNativeInputs, layoutCheckSubmittedImages, layoutCheckOutputSchema, validateLayoutCheckSemantics } from './input.ts';
import type { JsonObject } from '@workbench/contracts';
import type { LayoutCheckExecution, LayoutCheckTerminalEvidence } from './types.ts';
const reject = (why: string): never => { throw new Error('LAYOUT_CHECK_INPUT_PROOF_INVALID: ' + why); };
/** Server-only validation of the full frozen input and its exact native image-channel proof. No native process/query/submit. */
function assertLayoutCheckExecutionBase(value: unknown): asserts value is LayoutCheckExecution {
  if (!object(value) || value.schema_version !== 'article-layout-check-execution.v1' || typeof value.fixture !== 'boolean' || value.no_automatic_retry !== true || !object(value.attempt) || !object(value.input_manifest) || !object(value.proof)) reject('完整 execution/manifest/proof 必须保留');
  const execution = value as unknown as LayoutCheckExecution, { attempt, input_manifest: input, proof } = execution;
  if (!object(attempt.native) || [attempt.native.thread_id, attempt.native.turn_id].some(id => id !== null && (typeof id !== 'string' || !id)) || typeof proof.original_input_verified !== 'boolean') reject('原生 IDs 或原始输入核查状态无效');
  if (!attempt.id || !attempt.job_id || !attempt.attempt_id || !['intent', 'running', 'completed', 'unknown', 'cancelled', 'failed'].includes(attempt.state) || ![0, 1].includes(execution.submit_count) || !attempt.native) reject('原 job/attempt 状态不完整');
  if (layoutVisualManifestHash(input) !== attempt.input_manifest_sha256 || !layoutBindingEquals(input.binding, attempt.binding)) reject('manifest/binding 对应关系不符');
  if (attempt.native.provider !== (execution.fixture ? 'fixture' : 'codex') || proof.source !== (execution.fixture ? 'fixture' : 'codex_app_server') || proof.billing_route !== (execution.fixture ? 'fixture' : 'chatgpt_subscription') || proof.input_channel !== 'localImage') reject('图像渠道或原生来源不符');
  if (!execution.fixture && (typeof execution.candidate_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(execution.candidate_sha256))) reject('生产缺少固定候选');
  try { validateLayoutVisualInput(input); } catch { reject('冻结实际 PNG/标准/块结构不完整或已变化'); }
  if (proof.thread_start !== undefined && proof.thread_start !== null && (!object(proof.thread_start) || proof.thread_start.thread_id !== attempt.native.thread_id || proof.thread_start.model !== 'gpt-6.1-sol' || proof.thread_start.model_provider !== 'openai' || !proof.thread_start.cwd)) reject('原 thread/start 回执身份/model 不符');
  const images = layoutCheckSubmittedImages(input);
  if (!Array.isArray(proof.submitted_local_images) || canonical(images) !== canonical(proof.submitted_local_images)) reject('按序文章图像与原标准图像 hash/路径不符');
  if (hash(canonical(layoutCheckNativeInputs(input))) !== proof.native_input_sha256) reject('native_input_sha256 不对应原完整图像输入');
  if (attempt.state === 'completed') {
    if (execution.submit_count !== 1 || !attempt.native.thread_id || !attempt.native.turn_id || proof.original_input_verified !== true || !attempt.result || !matches(attempt.result, layoutCheckOutputSchema(attempt.binding))) throw new Error('LAYOUT_CHECK_OUTPUT_PROOF_INVALID');
    if (hash(canonical(attempt.result)) !== proof.output_sha256) throw new Error('LAYOUT_CHECK_OUTPUT_PROOF_INVALID');
    validateLayoutCheckSemantics(attempt.result, input);
  } else if (attempt.result !== null) throw new Error('LAYOUT_CHECK_OUTPUT_PROOF_INVALID');
}

function terminalInvalid(why: string): never { throw new Error('LAYOUT_CHECK_TERMINAL_PROOF_INVALID: ' + why); }
function assertJson(value: unknown, stack = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || stack.has(value)) terminalInvalid('原始回读必须是完整 JSON');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) terminalInvalid('原始回读不是原始 JSON 对象');
  stack.add(value);
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) assertJson(value[i], stack); }
  else for (const item of Object.values(value)) assertJson(item, stack);
  stack.delete(value);
}
function terminalIdentity(execution: LayoutCheckExecution, rawRead: unknown, expectedCwd: string): { status: 'failed' | 'interrupted'; thread_id: string; turn_id: string } {
  const { attempt, proof } = execution, id = attempt.native;
  if (execution.submit_count !== 1 || !id.thread_id || !id.turn_id || ['intent', 'completed', 'cancelled'].includes(attempt.state) || attempt.result !== null || proof.output_sha256 !== null) terminalInvalid('只接受已提交的原任务未成功终态，不能覆盖完成或取消');
  if (execution.candidate_sha256 !== null && !/^[a-f0-9]{64}$/.test(execution.candidate_sha256)) terminalInvalid('固定候选无效');
  if (typeof expectedCwd !== 'string' || !isAbsolute(expectedCwd) || normalize(expectedCwd) !== expectedCwd || expectedCwd !== execution.input_manifest.work_directory) terminalInvalid('缺少原固定输入绑定的准确规范 cwd');
  assertJson(rawRead);
  if (!object(rawRead) || !object(rawRead.thread)) return terminalInvalid('缺少完整原 thread/read');
  const thread = rawRead.thread;
  if (thread.id !== id.thread_id || thread.modelProvider !== 'openai' || thread.cwd !== expectedCwd || !Array.isArray(thread.turns)) terminalInvalid('原 thread/provider/cwd 不符');
  const started = proof.thread_start;
  if (started && (started.thread_id !== id.thread_id || started.cwd !== expectedCwd || started.model_provider !== 'openai' || started.model !== 'gpt-6.1-sol')) terminalInvalid('原 thread/start 身份不符');
  if (thread.model !== 'gpt-6.1-sol' && !(thread.model === null && started && started.thread_id === id.thread_id && started.model_provider === 'openai' && started.model === 'gpt-6.1-sol' && started.cwd === expectedCwd)) terminalInvalid('原 model 未获核实；null 仅使用既有 thread/start');
  const turns = thread.turns.filter(turn => object(turn) && turn.id === id.turn_id);
  if (turns.length !== 1 || !object(turns[0])) terminalInvalid('缺少唯一原 failed/interrupted turn');
  const turn = turns[0];
  if (turn.status !== 'failed' && turn.status !== 'interrupted' || turn.itemsView !== 'full' || !Array.isArray(turn.items)) terminalInvalid('缺少唯一原 failed/interrupted 完整 turn');
  const users = turn.items.filter(item => object(item) && item.type === 'userMessage');
  if (users.length !== 1 || !object(users[0]) || !Array.isArray(users[0].content) || hash(canonical(users[0].content)) !== proof.native_input_sha256) terminalInvalid('原完整 user input/图像/标准不符');
  return { status: turn.status, thread_id: id.thread_id, turn_id: id.turn_id };
}
/** Pure local verifier. Retains every original read field; never queries native or mutates execution. */
export function createLayoutCheckTerminalEvidence(execution: LayoutCheckExecution, rawRead: unknown, expectedCwd: string): LayoutCheckTerminalEvidence {
  assertLayoutCheckExecutionBase(execution);
  const identity = terminalIdentity(execution, rawRead, expectedCwd);
  return { schema_version: 'article-layout-terminal-read.v1', raw_read: structuredClone(rawRead) as JsonObject,
    raw_read_sha256: hash(canonical(rawRead)), ...identity, expected_cwd: expectedCwd, candidate_sha256: execution.candidate_sha256,
    input_manifest_sha256: execution.attempt.input_manifest_sha256, native_input_sha256: execution.proof.native_input_sha256 };
}
/** Recheck full immutable input and raw terminal evidence at persistence/consumption boundaries. */
export function assertLayoutCheckTerminalEvidence(execution: LayoutCheckExecution): void {
  assertLayoutCheckExecutionBase(execution);
  const evidence = execution.proof.terminal_read;
  if (!object(evidence) || evidence.schema_version !== 'article-layout-terminal-read.v1' || execution.attempt.state !== 'failed' || execution.proof.original_input_verified !== true) terminalInvalid('未成功终态缺少可信完整回读');
  const identity = terminalIdentity(execution, evidence.raw_read, evidence.expected_cwd);
  if (evidence.status !== identity.status || evidence.thread_id !== identity.thread_id || evidence.turn_id !== identity.turn_id || evidence.candidate_sha256 !== execution.candidate_sha256 || evidence.input_manifest_sha256 !== execution.attempt.input_manifest_sha256 || evidence.native_input_sha256 !== execution.proof.native_input_sha256 || evidence.raw_read_sha256 !== hash(canonical(evidence.raw_read))) terminalInvalid('原始终态回读与固定 execution 不符');
}
export function assertLayoutCheckExecutionProof(value: unknown): asserts value is LayoutCheckExecution {
  assertLayoutCheckExecutionBase(value);
  // Historical records without the additive field remain readable; new submitted-failed writes/settle require it at their storage boundary.
  if (value.proof.terminal_read !== undefined) assertLayoutCheckTerminalEvidence(value);
}
