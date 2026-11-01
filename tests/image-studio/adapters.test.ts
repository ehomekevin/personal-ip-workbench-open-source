import test from '../helpers/media-tools.ts'; // 依赖真实图像解码；缺 ffmpeg/ffprobe 时跳过
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { JsonObject } from '../../packages/contracts/src/index.ts';
import { analyzeImageBrief, createImageProvider, decodedSizeVerification, imageCapabilities, imageBriefInputHash, imageBriefRequest,
  validateSizeRequest, type ImageBriefAnalysisPort, type ImageBriefInput, type ImageProviderId, type ImageProviderInput } from '../../packages/adapters/src/media/image/index.ts';
import { baseCheckpoint, fingerprint } from '../../packages/adapters/src/media/image/common.ts';
import {writeSolidPng} from '../helpers/png.ts';

const binary = fileURLToPath(new URL('../image-providers/adapters-fixture.mjs', import.meta.url));
const size = { mode: 'manual' as const, width: 1600, height: 900, aspect_ratio: '16:9', policy: 'prompt_guided' as const };
function fixture(provider: ImageProviderId, reference = false) {
  const root = mkdtempSync(join(tmpdir(), 'studio-image-adapter-'));
  const work = join(root, 'work'), output = join(root, 'output'), state = join(root, 'state'), trace = join(root, 'calls.jsonl'), png = join(root, 'fixture.png');
  for (const path of [work, output, state]) mkdirSync(path);
  writeSolidPng(png, 32, 32);
  const refHash = createHash('sha256').update(readFileSync(png)).digest('hex');
  const input: ImageProviderInput = { provider, operation: reference ? 'reference_edit' : 'generate', prompt: '对照两张工作流，保留所有说明。',
    size_request: size, references: reference ? [{ asset_id: 'identity-ref', file_path: png, sha256: refHash, purpose: 'identity' }] : [],
    binding: { workspace_id: randomUUID(), job_id: randomUUID(), attempt_id: randomUUID(), attempt_generation: 1, input_hash: 'a'.repeat(64) },
    work_directory: work, output_directory: output };
  const adapter = createImageProvider(provider, { executable: binary, state_root: state, mcp_config_path: join(state, 'config.toml'),
    schema_directory: join(root, 'schema'), timeout_ms: 3000,
    env: { ...process.env, IMAGE_FIXTURE_MODE: 'success', IMAGE_FIXTURE_PNG: png, IMAGE_FIXTURE_STATE: state, IMAGE_FIXTURE_TRACE: trace,
      ...(reference ? { IMAGE_FIXTURE_REFERENCE: png } : {}) } });
  let cp: JsonObject = {};
  return { root, input, adapter, signal: new AbortController().signal, checkpoint: (value: JsonObject) => { cp = value; }, cp: () => cp,
    calls: () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as JsonObject) : [],
    close: () => rmSync(root, { recursive: true, force: true }) };
}
test('native capability reports separate prompt targets, known output and unsupported exact pixels', () => {
  for (const provider of ['agy', 'codex'] as const) {
    const caps = imageCapabilities(provider);
    assert.equal(caps.exact_pixels, 'unsupported'); assert.equal(caps.aspect_output, 'unverified');
    assert.equal(caps.accepted_size_parameter, null);
    assert((caps.composition_targets as JsonObject[]).every(target => target.verified_native_size === false));
    assert.equal((caps.manual_range as JsonObject).constraint_source, 'workbench_request_validation');
    assert.equal((caps.references as JsonObject).mask, 'unverified');
  }
});
test('legacy no-size request hash is unchanged; new width/height are recovery-bound', () => {
  const input: ImageProviderInput = { provider: 'agy', operation: 'generate', prompt: 'A lime ceramic cube on a navy desk.', references: [],
    binding: { workspace_id: 'workspace', job_id: 'job', attempt_id: 'attempt', attempt_generation: 1, input_hash: 'a'.repeat(64) },
    work_directory: '/tmp/a', output_directory: '/tmp/b' };
  // Captured from the unchanged legacy field set before adding image-studio requests.
  assert.equal(fingerprint(input), '4cb94bb1aa6229e3cf63397c3119e2e0aa0dad15c4183e372176d8003a966af5');
  assert.notEqual(fingerprint(input), fingerprint({ ...input, size_request: size }));
  assert.notEqual(fingerprint({ ...input, size_request: size }), fingerprint({ ...input, size_request: { ...size, width: 1920, height: 1080 } }));
});
test('invalid or exact-pixel size requests reject before provider; valid custom targets remain prompt-guided', () => {
  for (const bad of [{ ...size, width: 319 }, { ...size, width: 4097 }, { ...size, height: 1000 }, { ...size, width: 1600.1 },
    { ...size, aspect_ratio: '16/9' }, { ...size, policy: 'exact_pixels' }, { ...size, extra: true }]) assert.throws(() => validateSizeRequest(bad));
  assert.doesNotThrow(() => validateSizeRequest({ ...size, width: 900, height: 383, aspect_ratio: '900:383' }));
  assert.equal(decodedSizeVerification({ size_request: size } as ImageProviderInput, 1600, 900)?.status, 'exact');
  assert.equal(decodedSizeVerification({ size_request: size } as ImageProviderInput, 1920, 1080)?.status, 'aspect_match_pixels_differ');
});
for (const provider of ['agy', 'codex'] as const) {
  test(`${provider}: real fixture protocol retains requested/accepted/decoded dimensions and keeps first mismatch`, async () => {
    const f = fixture(provider);
    try {
      const result = await f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint });
      assert.equal(result.width, 32); assert.equal(result.height, 32);
      const verification = result.native.size_verification as JsonObject;
      assert.equal(verification.status, 'mismatch'); assert.equal(verification.transformed, false);
      assert.deepEqual(verification.requested, size); assert.equal(verification.accepted_size_parameter, null);
      const accepted = result.native.accepted_image_parameters as JsonObject;
      assert.equal(accepted.structured_size_parameter, null); assert.equal(accepted.structured_aspect_parameter, null);
      assert(JSON.stringify(accepted).includes('1600 x 900')); assert(JSON.stringify(accepted).includes('16:9'));
      const repeated = await f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint });
      assert.equal(repeated.sha256, result.sha256); assert.equal(repeated.width, 32);
      await assert.rejects(f.adapter.query({ ...f.input, size_request: { ...size, width: 1920, height: 1080 } }, f.cp(), f.signal), { code: 'INPUT_STALE' });
      assert.equal(f.calls().filter(row => row.method === (provider === 'agy' ? 'agy-submit' : 'turn/start')).length, 1);
    } finally { f.close(); }
  });
  test(`${provider}: identity reference actual path/hash/purpose survives typed result`, async () => {
    const f = fixture(provider, true);
    try {
      const result = await f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint });
      const accepted = JSON.stringify(result.native.accepted_image_parameters);
      assert(accepted.includes('Preserve the depicted person identity.'));
      assert(accepted.includes(f.input.references[0]!.file_path));
      assert(accepted.includes(f.input.references[0]!.sha256));
    } finally { f.close(); }
  });
  test(`${provider}: unsupported size and no native IDs cause zero new fixture submit`, async () => {
    const f = fixture(provider);
    try {
      await assert.rejects(f.adapter.execute({ ...f.input, size_request: { ...size, policy: 'exact_pixels' } } as unknown as ImageProviderInput,
        { signal: f.signal, checkpoint: f.checkpoint }), { code: 'CAPABILITY_UNSUPPORTED' });
      await assert.rejects(f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint, prior: baseCheckpoint(f.input) }), { code: 'RESULT_UNKNOWN' });
      assert.equal(f.calls().length, 0);
    } finally { f.close(); }
  });
}

const briefInput: ImageBriefInput = { provider: 'agy', paragraph: '先确认内容，再生成配图。最后人工采用。', description: '展示三个步骤的先后关系。',
  insertion_point: 'after:paragraph-1', references: [], brand_version: 'xiaoliu-original' };
const analysis = { communication_goal: '说明从内容确认到人工采用的顺序', layout_relationship: 'sequence', text_density: 'low',
  elements: [{ label: '内容确认', source_quote: '先确认内容' }, { label: '生图', source_quote: '再生成配图' },
    { label: '本人采用', source_quote: '最后人工采用' }], rationale: '三个步骤需要清楚的先后关系与留白。' };
const briefOutput = { analysis, recommendation: { width: 1600, height: 900, aspect_ratio: '16:9', reason: '横向空间能放下三个步骤及连接关系。' } };
function briefPort(output: unknown = briefOutput): ImageBriefAnalysisPort {
  return { analyze: async request => ({ output, provenance: { provider: 'codex', input_hash: request.input_hash, native_thread_id: 'fixture-thread',
    native_turn_id: 'fixture-turn', model: 'fixture-text-only', usage: null } }) };
}
test('brief uses injected structured content analysis and binds native evidence/source quotes', async () => {
  let calls = 0; const inner = briefPort(), port: ImageBriefAnalysisPort = { analyze: async (request, options) => {
    calls++; assert(request.prompt.includes(briefInput.paragraph)); assert.equal(request.output_schema.additionalProperties, false);
    return inner.analyze(request, options);
  } };
  const result = await analyzeImageBrief(briefInput, port, { signal: new AbortController().signal });
  assert.equal(calls, 1); assert.equal(result.recommendation.mode, 'auto'); assert.equal(result.recommendation.policy, 'prompt_guided');
  assert.equal(result.provenance.input_hash, imageBriefInputHash(briefInput)); assert.match(result.provenance.output_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.provenance.source, 'subscription_structured_analysis');
  // Same input, a different model analysis result drives a different target; there is no local keyword-to-ratio mapping.
  const vertical = await analyzeImageBrief(briefInput, briefPort({ analysis, recommendation: {
    width: 1200, height: 3000, aspect_ratio: '2:5', reason: '纵向逐步说明保留更多文字空间。' } }), { signal: new AbortController().signal });
  assert.equal(vertical.recommendation.aspect_ratio, '2:5');
});
test('brief rejects invented source facts, missing fields, unsupported dimensions and mismatched native binding', async () => {
  const invalid = [
    { ...briefOutput, analysis: { ...analysis, elements: [{ label: '销量', source_quote: '销量翻倍' }] } },
    { ...briefOutput, analysis: { ...analysis, rationale: '' } },
    { ...briefOutput, recommendation: { ...briefOutput.recommendation, width: 2048 } },
    { ...briefOutput, extra: 'hidden' },
  ];
  for (const output of invalid) await assert.rejects(analyzeImageBrief(briefInput, briefPort(output), { signal: new AbortController().signal }), { code: 'VALIDATION_ERROR' });
  const port: ImageBriefAnalysisPort = { analyze: async () => ({ output: briefOutput, provenance: { provider: 'codex', input_hash: 'b'.repeat(64),
    native_thread_id: 'fixture-thread', native_turn_id: 'fixture-turn', model: null, usage: null } }) };
  await assert.rejects(analyzeImageBrief(briefInput, port, { signal: new AbortController().signal }), { code: 'VALIDATION_ERROR' });
});
test('brief cancelled before analysis makes no text model request; request hash changes with content and reference purpose', async () => {
  const stopped = new AbortController(); stopped.abort(); let calls = 0;
  await assert.rejects(analyzeImageBrief(briefInput, { analyze: async () => { calls++; throw new Error('not allowed'); } }, { signal: stopped.signal }));
  assert.equal(calls, 0);
  assert.notEqual(imageBriefRequest(briefInput).input_hash, imageBriefRequest({ ...briefInput, description: '保留三个步骤的全部文字。' }).input_hash);
  const reference = { asset_id: 'public-reference', sha256: 'a'.repeat(64), purpose: 'style' as const };
  assert.notEqual(imageBriefInputHash({ ...briefInput, references: [reference] }),
    imageBriefInputHash({ ...briefInput, references: [{ ...reference, purpose: 'identity' }] }));
});
