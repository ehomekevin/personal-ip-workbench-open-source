import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { CodexLayoutCheckAdapter, layoutRenderSnapshotHash, layoutBlockStructureHash, validateLayoutVisualInput, newLayoutCheckExecution, WECHAT_LAYOUT_STANDARD } from '../../../packages/adapters/src/media/layout-check/index.ts';
import type { LayoutCheckJournal, LayoutCheckExecution, LayoutNativeClient, LayoutVisualInput, LayoutCheckOptions } from '../../../packages/adapters/src/media/layout-check/index.ts';

const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const root = fileURLToPath(new URL('./fixtures/', import.meta.url));
function crc(b: Buffer): number { let c = 0xffffffff; for (const byte of b) { c ^= byte; for (let n = 0; n < 8; n++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer): Buffer { const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), sum = Buffer.alloc(4); size.writeUInt32BE(data.length); sum.writeUInt32BE(crc(body)); return Buffer.concat([size, body, sum]); }
function png(width: number, height: number): Buffer { const hdr = Buffer.alloc(13); hdr.writeUInt32BE(width); hdr.writeUInt32BE(height, 4); hdr[8] = 8; hdr[9] = 2; return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', hdr), chunk('IDAT', deflateSync(Buffer.from(Array.from({ length: (width * 3 + 1) * height }, (_, i) => i % (width * 3 + 1) === 0 ? 0 : 255)))), chunk('IEND', Buffer.alloc(0))]); }
function fixture(t: { after(fn: () => void): void }): LayoutVisualInput {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'layout-visual-fixture-'))); t.after(() => rmSync(work, { recursive: true, force: true }));
  const image = png(390, 100); writeFileSync(join(work, 'slice.png'), image);
  const slices = [{ path: join(work, 'slice.png'), sha256: sha(image), width: 390, height: 100, offset_y: 0, block_ids: ['p1'] }];
  const blocks = [{ id: 'p1', kind: 'paragraph', text: '人工稿保持。', computed_style: { font_size: 15, line_height: 27, color: '#333333', margin_bottom: 20 }, bounds: { x: 16, y: 10, width: 358, height: 50 } }];
  return { work_directory: work, render_pngs: slices, blocks, standard_png: { path: join(root, 'original-standard.png'), sha256: WECHAT_LAYOUT_STANDARD.png_sha256 },
    standard_html: { path: join(root, 'original-standard.html'), sha256: WECHAT_LAYOUT_STANDARD.html_sha256 },
    binding: { article_id: 'fixture-article', content_revision_id: 'c1', layout_revision_id: 'l1', text_hash: sha('人工稿保持。'), images_hash: sha('fixture adopted images'),
      standard_version: WECHAT_LAYOUT_STANDARD.version, standard_png_sha256: WECHAT_LAYOUT_STANDARD.png_sha256, standard_html_sha256: WECHAT_LAYOUT_STANDARD.html_sha256,
      render_snapshot_sha256: layoutRenderSnapshotHash(slices), block_structure_sha256: layoutBlockStructureHash(blocks) } };
}
class FixtureJournal implements LayoutCheckJournal {
  data = new Map<string, LayoutCheckExecution>(); writes: LayoutCheckExecution[] = [];
  async reserve(e: LayoutCheckExecution): Promise<boolean> { if (this.data.has(e.attempt.attempt_id) || [...this.data.values()].some(v => v.attempt.job_id === e.attempt.job_id)) return false; this.data.set(e.attempt.attempt_id, structuredClone(e)); this.writes.push(structuredClone(e)); return true; }
  async load(id: string): Promise<LayoutCheckExecution | null> { return structuredClone(this.data.get(id) ?? null); }
  async save(e: LayoutCheckExecution): Promise<void> { this.data.set(e.attempt.attempt_id, structuredClone(e)); this.writes.push(structuredClone(e)); }
}
type Mode = 'complete' | 'timeout' | 'missing_images' | 'bad_schema' | 'stale_binding' | 'no_vision' | 'bad_provider' | 'submit_unknown' | 'wrong_turn' | 'tool_request' | 'issues' | 'uncertain' | 'unknown_block';
class FixtureNative implements LayoutNativeClient {
  version = 'fixture-codex-not-real'; starts = 0; threads = 0; reads = 0; closes = 0; denied = 0;
  calls: Array<{ method: string; params: Record<string, unknown> }> = []; input: Array<Record<string, unknown>> = []; schema: any;
  listeners = new Set<(m: any) => void>(); mode: Mode; journal: FixtureJournal;
  constructor(mode: Mode, journal: FixtureJournal) { this.mode = mode; this.journal = journal; }
  async initialize(): Promise<void> {}
  observe(fn: (m: any) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  deny(): void { this.denied++; }
  emit(m: any): void { for (const fn of this.listeners) fn(m); }
  async close(): Promise<void> { this.closes++; }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'account/rateLimits/read') return { ordinaryUsageAllowed: true };
    if (method === 'model/list') return { data: [{ id: 'gpt-6.1-sol', inputModalities: this.mode === 'no_vision' ? ['text'] : ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] }] };
    if (method === 'thread/start') { this.threads++; return { thread: { id: 'fixture-thread' }, modelProvider: this.mode === 'bad_provider' ? 'other' : 'openai', model: 'gpt-6.1-sol' }; }
    if (method === 'turn/start') {
      assert.ok([...this.journal.data.values()].some(v => v.submit_count === 1 && v.attempt.state === 'running'), 'intent must be durable before turn/start');
      this.starts++; this.input = structuredClone(params.input) as any; this.schema = params.outputSchema;
      assert.ok(this.input.filter(i => i.type === 'localImage').length >= 2); assert.ok(this.input.some(i => typeof i.text === 'string' && i.text.includes('Do not review wording')));
      this.emit({ method: 'turn/started', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn' } } });
      if (this.mode === 'submit_unknown') throw new Error('fixture RPC reply lost');
      if (this.mode === 'tool_request') this.emit({ id: 19, method: 'fixture/forbidden/tool' });
      else if (this.mode !== 'timeout') this.emit({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } } });
      return { turn: { id: this.mode === 'wrong_turn' ? 'wrong-fixture-turn' : 'fixture-turn' } };
    }
    if (method === 'thread/read') {
      this.reads++;
      const binding = Object.fromEntries(Object.entries(this.schema.properties.binding.properties).map(([k, v]: [string, any]) => [k, v.const]));
      const result: any = { binding, verdict: 'passed', issues: [], uncertainties: [] };
      if (this.mode === 'issues' || this.mode === 'unknown_block') { result.verdict = 'issues'; result.issues = [{ id: 'fixture-font', block_id: this.mode === 'unknown_block' ? 'not-an-article-block' : 'p1', location: '正文第一段', category: 'font', problem: '字号过大', standard_ref: 'WX-Spec.dc.html:31 正文15', suggestion: '正文设为15px', uncertainty: null }]; }
      if (this.mode === 'uncertain') { result.verdict = 'uncertain'; result.uncertainties = ['字体最终字形无法确认']; }
      if (this.mode === 'bad_schema') result.copyReview = { score: 100, rewrite: '不允许的改稿' };
      if (this.mode === 'stale_binding') result.binding.content_revision_id = 'old';
      return { thread: { id: 'fixture-thread', modelProvider: 'openai', model: 'gpt-6.1-sol', turns: [{ id: 'fixture-turn', status: this.mode === 'timeout' ? 'inProgress' : 'completed', items: [
        { type: 'userMessage', content: this.mode === 'missing_images' ? this.input.filter(i => i.type === 'text') : this.input },
        { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(result) },
      ] }] } };
    }
    throw new Error('unexpected fixture RPC ' + method);
  }
}
function setup(input: LayoutVisualInput, mode: Mode = 'complete') {
  const journal = new FixtureJournal(), native = new FixtureNative(mode, journal);
  const options: LayoutCheckOptions = { workspace_id: 'fixture', cwd: input.work_directory, lock_root: input.work_directory, schema_directory: input.work_directory, journal, fixture: true, native_factory: () => native, timeout_ms: 10 };
  return { journal, native, adapter: new CodexLayoutCheckAdapter(options), options };
}
const identity = { id: 'fixture-check', job_id: 'fixture-job', attempt_id: 'fixture-attempt' };
const signal = (): AbortSignal => new AbortController().signal;

test('fixture=true: rendered PNG + original standard image enter localImage and results retain bound IDs/null cost', async t => {
  const input = fixture(t), { adapter, native, journal } = setup(input), old = structuredClone(input);
  const result = await adapter.execute(input, identity, signal());
  assert.equal(result.execution.fixture, true); assert.equal(result.execution.proof.source, 'fixture');
  assert.equal(result.execution.attempt.state, 'completed'); assert.equal(result.execution.proof.original_input_verified, true);
  assert.deepEqual(result.execution.attempt.native, { provider: 'fixture', thread_id: 'fixture-thread', turn_id: 'fixture-turn' });
  assert.equal(result.execution.attempt.cost, null); assert.equal(result.execution.proof.billing_amount, null); assert.equal(result.execution.submit_count, 1);
  assert.equal(native.starts, 1); assert.equal(native.closes, 1); assert.ok(journal.writes.length >= 4); assert.deepEqual(input, old);
});
test('fixture=true: missing/corrupt PNG, old render hash, cropped long article and source standard mismatch fail before native submit', async t => {
  for (const mutate of [
    (i: LayoutVisualInput) => { i.render_pngs = []; },
    (i: LayoutVisualInput) => { i.render_pngs[0]!.sha256 = sha('wrong'); },
    (i: LayoutVisualInput) => { i.binding.render_snapshot_sha256 = sha('old'); },
    (i: LayoutVisualInput) => { i.blocks[0]!.bounds.height = 300; i.binding.block_structure_sha256 = layoutBlockStructureHash(i.blocks); },
    (i: LayoutVisualInput) => { i.binding.standard_png_sha256 = sha('other standard'); },
  ]) { const input = fixture(t); mutate(input); const { adapter, native } = setup(input); await assert.rejects(adapter.execute(input, identity, signal())); assert.equal(native.starts, 0); assert.equal(native.threads, 0); }
});
test('fixture=true: model declaring only text fails without turn or silent fallback', async t => {
  const input = fixture(t), { adapter, native } = setup(input, 'no_vision'); const result = await adapter.execute(input, identity, signal());
  assert.equal(result.execution.attempt.state, 'failed'); assert.equal(native.starts, 0); assert.equal(native.threads, 0);
});
test('fixture=true: missing original native images, content review fields, stale result binding and mismatched turn never pass', async t => {
  for (const mode of ['missing_images', 'bad_schema', 'stale_binding', 'wrong_turn'] as const) {
    const input = fixture(t), { adapter, native } = setup(input, mode); const result = await adapter.execute(input, identity, signal());
    assert.equal(result.execution.attempt.state, 'unknown'); assert.equal(result.result, null); assert.equal(native.starts, 1); assert.equal(result.execution.proof.original_input_verified, false);
  }
});
test('fixture=true: timeout persists known IDs and intent; same job/attempt cannot be submitted again', async t => {
  const input = fixture(t), { adapter, native, journal } = setup(input, 'timeout'); const result = await adapter.execute(input, identity, signal());
  assert.equal(result.execution.attempt.state, 'unknown'); assert.equal(result.execution.attempt.native.turn_id, 'fixture-turn');
  await assert.rejects(adapter.execute(input, identity, signal()));
  await assert.rejects(adapter.execute(input, { ...identity, attempt_id: 'replacement' }, signal()));
  assert.equal(native.starts, 1); assert.equal(journal.data.size, 1);
});
test('fixture=true: lost turn response preserves event known IDs, late query reads exact old turn with zero retry', async t => {
  const input = fixture(t), { adapter, native } = setup(input, 'submit_unknown'); const result = await adapter.execute(input, identity, signal());
  assert.equal(result.execution.attempt.state, 'unknown'); assert.equal(result.execution.attempt.native.turn_id, 'fixture-turn');
  native.mode = 'complete'; const recovered = await adapter.query(identity.attempt_id, signal());
  assert.equal(recovered.execution.attempt.state, 'completed'); assert.equal(native.starts, 1); assert.equal(native.threads, 1); assert.equal(native.reads, 1);
});
test('fixture=true: query cannot invent IDs or infer a new current binding', async t => {
  const input = fixture(t), { adapter, native, journal } = setup(input);
  const execution = newLayoutCheckExecution(input, identity, true); execution.attempt.state = 'unknown'; await journal.reserve(execution);
  await assert.rejects(adapter.query(identity.attempt_id, signal())); assert.equal(native.starts, 0);
  await assert.rejects(adapter.query('missing', signal()));
});
test('fixture=true: denied tool request is unknown and never switches provider', async t => {
  const input = fixture(t), { adapter, native } = setup(input, 'tool_request'), result = await adapter.execute(input, identity, signal());
  assert.equal(result.execution.attempt.state, 'unknown'); assert.equal(native.denied, 1); assert.equal(native.starts, 1);
});
test('production execution without exact candidate permit never constructs native client', async t => {
  const input = fixture(t), { options } = setup(input); const { native_factory: _fixtureOnly, ...rest } = options;
  const adapter = new CodexLayoutCheckAdapter({ ...rest, fixture: false });
  await assert.rejects(adapter.execute(input, identity, signal()), /有界执行授权/);
});
test('production mode rejects mocked native factory; fixtures cannot be reported as native evidence', t => {
  const input = fixture(t), { options } = setup(input); assert.throws(() => new CodexLayoutCheckAdapter({ ...options, fixture: false }), /不能替换原生客户端/);
});
test('fixture=true: fragment hash ignores paths but structure and per-image metadata changes remain fenced', t => {
  const input = fixture(t); const moved = input.render_pngs.map(s => ({ ...s, path: '/new-location.png' }));
  assert.equal(layoutRenderSnapshotHash(moved), input.binding.render_snapshot_sha256);
  moved[0]!.offset_y = 1; assert.notEqual(layoutRenderSnapshotHash(moved), input.binding.render_snapshot_sha256);
  input.blocks[0]!.computed_style.font_size = 25; assert.notEqual(layoutBlockStructureHash(input.blocks), input.binding.block_structure_sha256);
  assert.throws(() => validateLayoutVisualInput(input));
});

test('fixture=true: known layout issue binds block and source reference without copy grading; uncertainty remains uncertain', async t => {
  for (const mode of ['issues', 'uncertain'] as const) {
    const input = fixture(t), { adapter } = setup(input, mode); const result = await adapter.execute(input, identity, signal());
    assert.equal(result.execution.attempt.state, 'completed'); assert.equal(result.result!.verdict, mode);
    if (mode === 'issues') { assert.equal(result.result!.issues[0]!.block_id, 'p1'); assert.match(result.result!.issues[0]!.standard_ref, /正文15/); }
  }
  const input = fixture(t), { adapter } = setup(input, 'unknown_block'); const invalid = await adapter.execute(input, identity, signal()); assert.equal(invalid.execution.attempt.state, 'unknown');
});
test('fixture=true: complete natural-height article is consumed as all contiguous slices and source standard image', async t => {
  const input = fixture(t), second = png(390, 100), path = join(input.work_directory, 'slice-2.png'); writeFileSync(path, second);
  input.render_pngs.push({ path, sha256: sha(second), width: 390, height: 100, offset_y: 100, block_ids: ['p2'] });
  input.blocks.push({ ...input.blocks[0]!, id: 'p2', bounds: { x: 16, y: 120, width: 358, height: 50 } });
  input.binding.render_snapshot_sha256 = layoutRenderSnapshotHash(input.render_pngs); input.binding.block_structure_sha256 = layoutBlockStructureHash(input.blocks);
  const { adapter, native } = setup(input); const result = await adapter.execute(input, identity, signal()); assert.equal(result.execution.attempt.state, 'completed');
  assert.equal(native.input.filter(i => i.type === 'localImage').length, 3);
  input.render_pngs[1]!.offset_y = 110; input.binding.render_snapshot_sha256 = layoutRenderSnapshotHash(input.render_pngs); assert.throws(() => validateLayoutVisualInput(input), /连续位置/);
});
test('fixture=true: PNG with valid signature but corrupt raster cannot enter a vision request', t => {
  const input = fixture(t), file = input.render_pngs[0]!.path, corrupt = readFileSync(file); corrupt[40] ^= 255; writeFileSync(file, corrupt);
  input.render_pngs[0]!.sha256 = sha(corrupt); input.binding.render_snapshot_sha256 = layoutRenderSnapshotHash(input.render_pngs);
  assert.throws(() => validateLayoutVisualInput(input), /PNG/);
});

test('fixture=true: persisted cached result cannot swap binding, output or fixture/native source', async t => {
  for (const mutate of [
    (e: LayoutCheckExecution) => { e.attempt.result!.binding.content_revision_id = 'tampered'; },
    (e: LayoutCheckExecution) => { e.proof.output_sha256 = sha('other output'); },
    (e: LayoutCheckExecution) => { e.proof.source = 'codex_app_server'; },
  ]) {
    const input = fixture(t), { adapter, native, journal } = setup(input); await adapter.execute(input, identity, signal());
    const old = (await journal.load(identity.attempt_id))!; mutate(old); await journal.save(old);
    await assert.rejects(adapter.query(identity.attempt_id, signal())); assert.equal(native.starts, 1);
  }
});

test('fixture=true: failure persisting completed result stays unknown with null result and no second submit', async t => {
  const input = fixture(t), { adapter, native, journal } = setup(input);
  const save = journal.save.bind(journal); let failed = false;
  journal.save = async execution => { if (!failed && execution.attempt.state === 'completed') { failed = true; throw new Error('fixture storage unavailable'); } await save(execution); };
  const result = await adapter.execute(input, identity, signal()); assert.equal(result.execution.attempt.state, 'unknown'); assert.equal(result.result, null);
  assert.equal(result.execution.attempt.native.turn_id, 'fixture-turn'); assert.equal(native.starts, 1);
  const recovered = await adapter.query(identity.attempt_id, signal()); assert.equal(recovered.execution.attempt.state, 'completed'); assert.equal(native.starts, 1);
});
