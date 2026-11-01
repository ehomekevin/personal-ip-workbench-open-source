import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, adapter, identity, signal, QAOnlyNative, root, own, sha } from './repair-fixture.ts';
import { CodexLayoutCheckAdapter, assertLayoutCheckExecutionProof, layoutCheckNativeInputs, layoutVisualManifestHash, layoutBlockStructureHash } from '../../../packages/adapters/src/media/layout-check/index.ts';
import type { LayoutCheckExecution, LayoutCheckJournal, LayoutNativeClient } from '../../../packages/adapters/src/media/layout-check/types.ts';
import { canonical } from '../../../packages/adapters/src/agent/codex/primitives.ts';
const rowKey = (id: string) => 'article-layout-check.v1:qa-fixture-workspace:attempt:' + id;

class ReadOnlyFixtureNative implements LayoutNativeClient {
  version = 'repair-read-only-fixture'; starts = 0; reads = 0; calls: string[] = [];
  readonly execution: LayoutCheckExecution; readonly variant: string;
  constructor(e: LayoutCheckExecution, variant = 'complete') { this.execution = e; this.variant = variant; }
  async initialize() {} async close() {} deny() {} observe() { return () => {}; }
  async request(method: string): Promise<unknown> {
    this.calls.push(method); if (method !== 'thread/read') { this.starts++; throw new Error('repair fixture refuses non-read requests'); } this.reads++;
    const e = this.execution, content = layoutCheckNativeInputs(e.input_manifest), result = { binding: e.attempt.binding, verdict: 'passed', issues: [], uncertainties: [] };
    if (this.variant === 'wrong-image') content[1]!.path = '/not-original.png';
    if (this.variant === 'text-only') content.splice(1);
    if (this.variant === 'wrong-text') content[0]!.text = 'different original text';
    const users = [{ type: 'userMessage', content }]; if (this.variant === 'extra-user') users.push(structuredClone(users[0]!));
    const turn = { id: 'qa-turn', status: 'completed', items: [...users, { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(result) }] };
    const turns = this.variant === 'empty' ? [] : this.variant === 'ambiguous' ? [turn, { ...structuredClone(turn), id: 'another-turn' }] : [turn];
    return { thread: { id: this.variant === 'wrong-thread' ? 'another-thread' : 'qa-thread', modelProvider: this.variant === 'wrong-provider' ? 'other' : 'openai', model: this.variant === 'wrong-model' ? 'other-model' : this.variant === 'model-null' ? null : 'gpt-6.1-sol', turns } };
  }
}
function readAdapter(f: ReturnType<typeof setup>, native: LayoutNativeClient, journal: LayoutCheckJournal = f.journal()) {
  return new CodexLayoutCheckAdapter({ workspace_id: 'qa-fixture-workspace', cwd: f.directory, lock_root: f.directory, schema_directory: f.directory, journal, fixture: true, native_factory: () => native });
}
test('P2-03 actual SQLite load rejects full input proof corruption: SHA, source, image order/list/hash, stale binding and missing inputs', async t => {
  const mutations: Array<(e: LayoutCheckExecution) => void> = [
    e => { e.proof.native_input_sha256 = sha('different native input'); },
    e => { e.proof.native_input_sha256 = ''; },
    e => { e.proof.source = 'codex_app_server'; },
    e => { e.proof.submitted_local_images.reverse(); },
    e => { e.proof.submitted_local_images.pop(); },
    e => { e.proof.submitted_local_images[0]!.sha256 = sha('wrong pixels'); },
    e => { e.input_manifest.render_pngs = []; e.attempt.input_manifest_sha256 = layoutVisualManifestHash(e.input_manifest); },
    e => { e.input_manifest.blocks[0]!.text = 'old content'; e.input_manifest.binding.block_structure_sha256 = layoutBlockStructureHash(e.input_manifest.blocks); e.attempt.binding = e.input_manifest.binding; e.attempt.input_manifest_sha256 = layoutVisualManifestHash(e.input_manifest); },
    e => { e.input_manifest.binding.content_revision_id = 'old content revision'; e.attempt.binding = e.input_manifest.binding; e.attempt.result!.binding = e.attempt.binding; e.proof.output_sha256 = sha(canonical(e.attempt.result)); e.attempt.input_manifest_sha256 = layoutVisualManifestHash(e.input_manifest); },
    e => { (e as any).input_manifest = undefined; },
  ];
  for (const mutate of mutations) {
    const f = setup(); try {
      const native = new QAOnlyNative(), id = identity('corrupt'); const good = await adapter(f, native).execute(f.input, id, signal()); assert.equal(good.execution.attempt.state, 'completed');
      const bad = structuredClone(good.execution); mutate(bad); f.db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(bad), rowKey(id.attempt_id));
      await assert.rejects(f.journal().load(id.attempt_id)); await assert.rejects(adapter(f, native).query(id.attempt_id, signal())); assert.equal(native.starts, 1); assert.equal(native.reads, 1);
    } finally { f.cleanup(); }
  }
});
test('P2-03 cached query validates complete proof even if a custom source bypasses SQLite validation; no client opens', async t => {
  const f = setup(); t.after(f.cleanup); const original = new QAOnlyNative(), id = identity('custom-source'), out = await adapter(f, original).execute(f.input, id, signal());
  const bad = structuredClone(out.execution); bad.proof.native_input_sha256 = sha('wrong'); let opens = 0;
  const journal: LayoutCheckJournal = { reserve: async () => false, save: async () => {}, load: async () => bad };
  const a = new CodexLayoutCheckAdapter({ workspace_id: 'qa-fixture-workspace', cwd: f.directory, lock_root: f.directory, schema_directory: f.directory, journal, fixture: true, native_factory: () => { opens++; return original; } });
  await assert.rejects(a.query(id.attempt_id, signal()), /INPUT_PROOF_INVALID/); assert.equal(opens, 0);
});
test('P2-03 proof-only service boundary refuses boolean claims, missing manifest and production missing candidate; positive exact proof is portable across reopen', async t => {
  const f = setup(); t.after(f.cleanup); const id = identity('portable'), out = await adapter(f, new QAOnlyNative()).execute(f.input, id, signal());
  assertLayoutCheckExecutionProof(out.execution); assert.throws(() => assertLayoutCheckExecutionProof({ attempt: out.execution.attempt, fixture: true, proof: { original_input_verified: true } }), /INPUT_PROOF_INVALID/);
  const bad = structuredClone(out.execution); bad.fixture = false; bad.proof.source = 'codex_app_server'; bad.proof.billing_route = 'chatgpt_subscription'; bad.attempt.native.provider = 'codex';
  assert.throws(() => assertLayoutCheckExecutionProof(bad), /INPUT_PROOF_INVALID/); f.reopen(); assertLayoutCheckExecutionProof(await f.journal().load(id.attempt_id));
});
test('P2-04 actual exit77 after observed event stores turn ID in SQLite; restart queries only original turn and completes', async t => {
  const directory = realpathSync(mkdtempSync(join(own, '.repair-crash-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [join(own, 'repair-crash-child.ts'), directory], { cwd: root, encoding: 'utf8', timeout: 10000 }); assert.equal(child.status, 77, child.stderr);
  const f = setup(directory); t.after(() => f.close()); const id = identity('crash'), stored = (await f.journal().load(id.attempt_id))!;
  assert.equal(stored.attempt.native.turn_id, 'qa-turn'); assert.equal(stored.submit_count, 1);
  const read = new ReadOnlyFixtureNative(stored), out = await readAdapter(f, read).query(id.attempt_id, signal());
  assert.equal(out.execution.attempt.state, 'completed'); assert.deepEqual(read.calls, ['thread/read']); assert.equal(read.starts, 0);
});
test('P2-04 exit77 before delayed async event commit recovers missing ID by original thread+unique full image input; 0 new submit', async t => {
  const directory = realpathSync(mkdtempSync(join(own, '.repair-delayed-crash-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [join(own, 'repair-crash-child.ts'), directory, 'delayed-event'], { cwd: root, encoding: 'utf8', timeout: 10000 }); assert.equal(child.status, 77, child.stderr);
  const f = setup(directory); t.after(() => f.close()); const id = identity('crash'), stored = (await f.journal().load(id.attempt_id))!;
  assert.equal(stored.attempt.native.thread_id, 'qa-thread'); assert.equal(stored.attempt.native.turn_id, null);
  const read = new ReadOnlyFixtureNative(stored), out = await readAdapter(f, read).query(id.attempt_id, signal());
  assert.equal(out.execution.attempt.state, 'completed'); assert.equal(out.execution.attempt.native.turn_id, 'qa-turn'); assert.deepEqual(read.calls, ['thread/read']); assert.equal(read.starts, 0);
  f.reopen(); const cached = await readAdapter(f, read).query(id.attempt_id, signal()); assert.equal(cached.execution.attempt.state, 'completed'); assert.equal(read.reads, 1); assert.equal(cached.execution.submit_count, 1);
});
test('P2-04 missing-ID discovery rejects empty/ambiguous thread, wrong thread/provider/model/text/images/user messages without inventing an ID', async t => {
  for (const variant of ['empty', 'ambiguous', 'wrong-thread', 'wrong-provider', 'wrong-model', 'text-only', 'wrong-image', 'wrong-text', 'extra-user']) {
    const f = setup(); try {
      const native = new QAOnlyNative('stall'), id = identity('discovery'); const out = await adapter(f, native).execute(f.input, id, signal());
      // Reproduce the crash gap in this own SQLite fixture; never alter provider/native records.
      const missing = structuredClone(out.execution); missing.attempt.native.turn_id = null; f.db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(missing), rowKey(id.attempt_id));
      const read = new ReadOnlyFixtureNative(missing, variant), result = await readAdapter(f, read).query(id.attempt_id, signal());
      assert.equal(result.execution.attempt.state, 'unknown', variant); assert.equal(result.execution.attempt.native.turn_id, null, variant); assert.equal(result.result, null); assert.equal(read.starts, 0); assert.deepEqual(read.calls, ['thread/read']);
    } finally { f.cleanup(); }
  }
});

test('P2-04 fixed ThreadRead schema model=null uses actual frozen thread/start receipt, never an inferred model', async t => {
  const f = setup(); t.after(f.cleanup); const id = identity('nullable-model'); const out = await adapter(f, new QAOnlyNative('stall')).execute(f.input, id, signal());
  const missing = structuredClone(out.execution); missing.attempt.native.turn_id = null; f.db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(missing), rowKey(id.attempt_id));
  const read = new ReadOnlyFixtureNative(missing, 'model-null'), result = await readAdapter(f, read).query(id.attempt_id, signal()); assert.equal(result.execution.attempt.state, 'completed'); assert.equal(read.starts, 0);
  const noProof = structuredClone(missing); noProof.proof.thread_start = null; f.db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(noProof), rowKey(id.attempt_id));
  const old = new ReadOnlyFixtureNative(noProof, 'model-null'), rejected = await readAdapter(f, old).query(id.attempt_id, signal()); assert.equal(rejected.execution.attempt.state, 'unknown'); assert.equal(rejected.execution.attempt.native.turn_id, null); assert.equal(old.starts, 0);
});
