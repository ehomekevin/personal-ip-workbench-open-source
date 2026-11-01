import test from '../helpers/media-tools.ts'; // 依赖真实图像解码；缺 ffmpeg/ffprobe 时跳过
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { JsonObject } from '../../packages/contracts/src/index.ts';
import { createImageProvider, type ImageProviderId, type ImageProviderInput } from '../../packages/adapters/src/media/image/index.ts';
import { baseCheckpoint, bindingMarker } from '../../packages/adapters/src/media/image/common.ts';
import { imageMcpNames } from '../../packages/adapters/src/media/image/mcp-configuration.ts';
import { CodexNative } from '../../packages/adapters/src/agent/codex/native.ts';
import {writeSolidPng} from '../helpers/png.ts';
const binary = fileURLToPath(new URL('./adapters-fixture.mjs', import.meta.url));
chmodSync(binary, 0o755);
function fixture(provider: ImageProviderId, mode = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'workbench-image-adapter-')), work = join(root, 'work'), output = join(root, 'output'), state = join(root, 'state');
  mkdirSync(work); mkdirSync(output); mkdirSync(state);
  const png = join(root, 'fixture.png'), trace = join(root, 'calls.jsonl');
  // Fixture media only; never reported as a real-provider image.
  writeSolidPng(png, 32, 32);
  const input: ImageProviderInput = { provider, operation: 'generate', prompt: 'A lime ceramic cube on a navy desk.', references: [],
    binding: { workspace_id: randomUUID(), job_id: randomUUID(), attempt_id: randomUUID(), attempt_generation: 1, input_hash: 'a'.repeat(64) }, work_directory: work, output_directory: output };
  const env: NodeJS.ProcessEnv = { ...process.env, IMAGE_FIXTURE_MODE: mode, IMAGE_FIXTURE_PNG: png, IMAGE_FIXTURE_STATE: state, IMAGE_FIXTURE_TRACE: trace };
  const options = { executable: binary, state_root: state, mcp_config_path: join(state, 'config.toml'), schema_directory: join(root, 'schemas'), timeout_ms: 3000, env };
  const adapter = createImageProvider(provider, options), signal = new AbortController().signal; let cp: JsonObject = {};
  return { root, input, options, adapter, signal, png, trace, checkpoint: (value: JsonObject) => { cp = value; }, cp: () => cp,
    calls: () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as JsonObject) : [], close: () => rmSync(root, { recursive: true, force: true }) };
}
for (const provider of ['agy', 'codex'] as const) {
  test(`${provider}: genuine fixture image decoded; exact input/native binding; duplicate execute performs query only`, async () => {
    const f = fixture(provider);
    try {
      const image = await f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint });
      assert.equal(image.mime, 'image/png'); assert.equal(image.width, 32); assert.equal(image.height, 32); assert.equal(image.native.fully_decoded, true);
      assert.equal(image.sha256, createHash('sha256').update(readFileSync(f.png)).digest('hex'));
      assert.equal(image.model, provider === 'agy' ? 'gemini-3.1-flash-image' : null);
      const repeated = await f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint }); assert.equal(repeated.sha256, image.sha256);
      assert.equal(f.calls().filter(row => row.method === (provider === 'agy' ? 'agy-submit' : 'turn/start')).length, 1);
      if (provider === 'codex') assert.equal(f.calls().filter(row => row.method === 'thread/resume').length, 0);
    } finally { f.close(); }
  });
  test(`${provider}: transport disconnect recovers original IDs into new attempt without submitting`, async () => {
    const f = fixture(provider, 'disconnect');
    try {
      await assert.rejects(f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint }), { code: 'RESULT_UNKNOWN' });
      const next = { ...f.input, binding: { ...f.input.binding, attempt_id: randomUUID(), attempt_generation: 2 }, output_directory: join(f.root, 'next-output') }; mkdirSync(next.output_directory);
      const recovered = await f.adapter.execute(next, { signal: f.signal, checkpoint: f.checkpoint, prior: f.cp() });
      assert.equal(recovered.native.original_binding && (recovered.native.original_binding as JsonObject).attempt_id, f.input.binding.attempt_id);
      assert(recovered.file_path.startsWith(next.output_directory));
      assert.equal(f.calls().filter(row => row.method === (provider === 'agy' ? 'agy-submit' : 'turn/start')).length, 1);
    } finally { f.close(); }
  });
  test(`${provider}: no native ID is unknown, zero query and zero submit; wrong job/hash/prompt are rejected before native`, async () => {
    const f = fixture(provider);
    try {
      const cp = baseCheckpoint(f.input);
      await assert.rejects(f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint, prior: cp }), { code: 'RESULT_UNKNOWN' });
      for (const input of [ { ...f.input, binding: { ...f.input.binding, job_id: randomUUID() } }, { ...f.input, binding: { ...f.input.binding, input_hash: 'b'.repeat(64) } }, { ...f.input, prompt: 'A different prompt' } ])
        await assert.rejects(f.adapter.query(input, cp, f.signal), { code: 'INPUT_STALE' });
      assert.equal(f.calls().length, 0);
    } finally { f.close(); }
  });
  test(`${provider}: cancellation before submit and stale reference never call provider`, async () => {
    const f = fixture(provider);
    try {
      const stopped = new AbortController(); stopped.abort();
      await assert.rejects(f.adapter.execute(f.input, { signal: stopped.signal, checkpoint: f.checkpoint }));
      const input = { ...f.input, operation: 'reference_edit' as const, references: [{ asset_id: 'ref', file_path: f.png, sha256: 'f'.repeat(64) }] };
      await assert.rejects(f.adapter.execute(input, { signal: f.signal, checkpoint: f.checkpoint }), { code: 'INPUT_STALE' });
      assert.equal(f.calls().length, 0);
    } finally { f.close(); }
  });
  test(`${provider}: cancellation after native ID preserves unknown; later recovery only reads original result`, async () => {
    const f = fixture(provider);
    try {
      const controller = new AbortController(); let cp: JsonObject = {};
      await assert.rejects(f.adapter.execute(f.input, { signal: controller.signal, checkpoint: value => { cp = value; if (provider === 'agy' ? Boolean(value.child_ids) : Boolean(value.turn_id)) controller.abort(); } }), { code: 'RESULT_UNKNOWN' });
      const image = await f.adapter.query(f.input, cp, f.signal);
      assert.equal(image.native.remote_cancel_confirmed, false);
      assert.equal(f.calls().filter(row => row.method === (provider === 'agy' ? 'agy-submit' : 'turn/start')).length, 1);
    } finally { f.close(); }
  });
}
test('AGY: malformed image fails decode; multiple tools fail unique-call audit; zero resubmit', async () => {
  for (const mode of ['corrupt', 'double']) {
    const f = fixture('agy', mode);
    try { await assert.rejects(f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint }), { code: 'RESULT_UNKNOWN' }); assert.equal(f.calls().filter(row => row.method === 'agy-submit').length, 1); }
    finally { f.close(); }
  }
});
test('AGY: single-reference uses exact ImagePaths and readonly native evidence; changed native tool ID rejected', async () => {
  const f = fixture('agy');
  try {
    const input = { ...f.input, operation: 'reference_edit' as const, references: [{ asset_id: 'reference', file_path: f.png, sha256: createHash('sha256').update(readFileSync(f.png)).digest('hex') }] };
    f.options.env.IMAGE_FIXTURE_REFERENCE = f.png;
    const image = await f.adapter.execute(input, { signal: f.signal, checkpoint: f.checkpoint });
    assert.equal(image.native.tool_call_id, 'call_12345');
    await assert.rejects(f.adapter.query(input, { ...image.native, tool_call_id: 'call_9999' }, f.signal), { code: 'RESULT_UNKNOWN' });
    await assert.rejects(f.adapter.query(input, { ...image.native, output_sha256: 'e'.repeat(64) }, f.signal), { code: 'RESULT_UNKNOWN' });
    await assert.rejects(f.adapter.query(input, { ...image.native, native_payload_sha256: 'e'.repeat(64) }, f.signal), { code: 'RESULT_UNKNOWN' });
    assert.equal(f.calls().filter(row => row.method === 'agy-submit').length, 1);
  } finally { f.close(); }
});
test('Codex: image-only tool configuration remains isolated from writer defaults', async () => {
  const f = fixture('codex');
  try {
    const sink: Array<JsonObject> = [];
    const native = new CodexNative({ executable: binary, cwd: f.input.work_directory, schemaDirectory: f.options.schema_directory, mcpNames: [], env: f.options.env, sink: entry => sink.push(entry as unknown as JsonObject) });
    await native.initialize(); await native.close();
    const text = JSON.stringify(sink); assert(text.includes('features.image_generation=false')); assert(!text.includes('features.image_generation=true')); assert(text.includes('features.code_mode_host=false')); assert(!text.includes('features.code_mode_host=true'));
    writeFileSync(join(f.options.state_root, 'config.toml'), '[mcp_servers.testing]\ncommand="ignored"\n[mcp_servers.testing.env]\nSECRET="fixture-private-do-not-emit"\n');
    await f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint });
    const args = f.calls().filter(row => row.method === 'native-spawn').at(-1)!.args as string[];
    assert(args.includes('mcp_servers.testing.enabled=false')); assert(args.includes('features.image_generation=true')); assert(args.includes('features.shell_tool=false')); assert(args.includes('features.view_image=false'));
    assert(args.includes('features.code_mode_host=true'));
    for (const feature of ['hooks','memories','multi_agent','apps','plugins','unified_exec','browser_use','computer_use']) assert(args.includes(`features.${feature}=false`));
    assert(!JSON.stringify(f.calls()).includes('fixture-private-do-not-emit'));
    const turns = f.calls().filter(row => row.method === 'turn/start'); assert.equal(turns.length, 1);
    const params = turns[0]!.params as JsonObject; assert.equal(params.approvalPolicy, 'never'); assert.deepEqual(params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  } finally { f.close(); }
});
test('Codex: provider mismatch and disabled image capability never start a turn; agent text cannot count as an image', async () => {
  for (const mode of ['provider', 'disabled', 'nonimage']) {
    const f = fixture('codex', mode);
    try { await assert.rejects(f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint })); assert.equal(f.calls().filter(row => row.method === 'turn/start').length, mode === 'nonimage' ? 1 : 0); }
    finally { f.close(); }
  }
});
test('Codex: mismatched native thread, item, or stored user input returns unknown without new turn', async () => {
  const f = fixture('codex');
  try {
    const image = await f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint });
    await assert.rejects(f.adapter.query(f.input, { ...image.native, thread_id: randomUUID() }, f.signal), { code: 'RESULT_UNKNOWN' });
    await assert.rejects(f.adapter.query(f.input, { ...image.native, image_item_ids: ['image-other'] }, f.signal), { code: 'RESULT_UNKNOWN' });
    const path = join(f.input.work_directory, 'fixture-thread.json'), stored = JSON.parse(readFileSync(path, 'utf8')); stored.turns[0].items[0].content[0].text = 'different'; writeFileSync(path, JSON.stringify(stored));
    await assert.rejects(f.adapter.query(f.input, image.native, f.signal), { code: 'RESULT_UNKNOWN' });
    assert.equal(f.calls().filter(row => row.method === 'turn/start').length, 1);
  } finally { f.close(); }
});
test('Codex: completed full zero-image turn is unavailable, summary zero-image remains unknown; both retain IDs without resubmit', async () => {
  for (const mode of ['noimage', 'summarynoimage']) {
    const f = fixture('codex', mode);
    try {
      const code = mode === 'noimage' ? 'CAPABILITY_UNVERIFIED' : 'RESULT_UNKNOWN';
      await assert.rejects(f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint }), { code });
      assert.equal(typeof f.cp().thread_id, 'string'); assert.equal(typeof f.cp().turn_id, 'string');
      await assert.rejects(f.adapter.query(f.input, f.cp(), f.signal), { code });
      assert.equal(f.calls().filter(row => row.method === 'turn/start').length, 1);
    } finally { f.close(); }
  }
});
test('Codex: original v1 prompt checkpoint remains readonly-queryable after wrapper prompt version changes', async () => {
  const f = fixture('codex');
  try {
    const image = await f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint }), cp = { ...image.native };
    delete cp.native_prompt_version;
    const path = join(f.input.work_directory, 'fixture-thread.json'), stored = JSON.parse(readFileSync(path, 'utf8'));
    stored.turns[0].items[0].content[0].text = bindingMarker(f.input) + '\nGenerate exactly ONE image using only the native image_generation tool. ' +
      'Keep the first result. No automatic correction, retry, alternative provider, shell, code, web, MCP or file reads. ' +
      'Stop on any failure or unknown. Image brief:\n' + f.input.prompt + '\nReturn the image artifact; never fabricate a model ID or result.';
    writeFileSync(path, JSON.stringify(stored));
    const recovered = await f.adapter.query(f.input, cp, f.signal); assert.equal(recovered.sha256, image.sha256);
    assert.equal(f.calls().filter(row => row.method === 'turn/start').length, 1);
  } finally { f.close(); }
});
test('Codex: cancellation during initialization/account/caps prevents thread/start and turn/start; pre-submit stage is preserved', async () => {
  for (const [mode, method, phase] of [['slow_initialize','initialize','initialize'],['slow_account','account/read','account_read'],['slow_caps','modelProvider/capabilities/read','capability_read']]) {
    const f = fixture('codex', mode), controller = new AbortController();
    const timer = setInterval(() => { if (f.calls().some(row => row.method === method)) controller.abort(); }, 10);
    try {
      await assert.rejects(f.adapter.execute(f.input, { signal: controller.signal, checkpoint: f.checkpoint }), (error: any) => {
        assert.equal(error.code, 'HOST_INTERRUPTED'); assert.equal(error.details.pre_submit_failure, true); assert.equal(error.details.pre_submit_phase, phase); assert.equal(error.details.underlying_error_type, 'AbortError'); return true;
      });
      assert.equal(f.calls().filter(row => row.method === 'thread/start').length, 0); assert.equal(f.calls().filter(row => row.method === 'turn/start').length, 0);
      assert.equal(f.cp().submit_count, 0);
    } finally { clearInterval(timer); f.close(); }
  }
});
test('Codex: cancellation while publishing thread checkpoint reports original thread but never submits a turn', async () => {
  const f = fixture('codex'), controller = new AbortController();
  try {
    await assert.rejects(f.adapter.execute(f.input, { signal: controller.signal, checkpoint: value => {
      f.checkpoint(value); if (value.native_state === 'thread_ready') { controller.abort(); controller.signal.throwIfAborted(); }
    } }), (error: any) => { assert.equal(error.code, 'HOST_INTERRUPTED'); assert.equal(error.details.pre_submit_phase, 'thread_checkpoint'); assert.equal(error.details.native_thread_created, true); assert.equal(typeof error.details.native_thread_id, 'string'); return true; });
    assert.equal(f.calls().filter(row => row.method === 'thread/start').length, 1); assert.equal(f.calls().filter(row => row.method === 'turn/start').length, 0);
    const stored = JSON.parse(readFileSync(join(f.input.work_directory, '.workbench-image-native.json'), 'utf8')); assert.equal(stored.native_state, 'thread_ready'); assert.equal(stored.submit_count, 0);
  } finally { f.close(); }
});
test('Codex: fsynced RPC audit binds execute/query sessions and saves metadata only, query has zero new submits', async () => {
  const f = fixture('codex');
  try {
    const image = await f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint });
    await f.adapter.query(f.input, image.native, f.signal);
    const path = join(f.input.work_directory, '.workbench-image-rpc.ndjson'), bytes = readFileSync(path, 'utf8'), rows = bytes.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(rows.filter(row => row.direction === 'send' && row.rpc_method === 'thread/start').length, 1);
    assert.equal(rows.filter(row => row.direction === 'send' && row.rpc_method === 'turn/start').length, 1);
    const query = rows.filter(row => row.purpose === 'query'); assert(query.length > 0);
    assert.equal(query.filter(row => row.direction === 'send' && ['thread/start','turn/start','thread/resume'].includes(row.rpc_method)).length, 0);
    assert.equal(new Set(rows.map(row => row.session_id)).size, 2);
    assert(rows.some(row => row.returned_thread_id === image.native.thread_id)); assert(rows.some(row => row.returned_turn_id === image.native.turn_id));
    assert(!bytes.includes(f.input.prompt)); assert(!bytes.includes('chatgpt')); assert(!bytes.includes('email')); assert(!bytes.includes('SECRET')); assert(!bytes.includes('params')); assert(!bytes.includes('stderr'));
    const allowed = new Set(['schema_version','session_id','purpose','at','direction','rpc_method','request_id','thread_id','turn_id','returned_thread_id','returned_turn_id','native_error_code']);
    assert(rows.every(row => Object.keys(row).every(key => allowed.has(key))));
  } finally { f.close(); }
});
test('Codex: aborted submit-intent publication cannot become turn/start, audit proves zero send despite checkpoint count', async () => {
  const f = fixture('codex'), controller = new AbortController();
  try {
    await assert.rejects(f.adapter.execute(f.input, { signal: controller.signal, checkpoint: value => { f.checkpoint(value); if (value.native_state === 'submitting') controller.abort(); } }), { code: 'HOST_INTERRUPTED' });
    assert.equal(f.cp().submit_count, 1);
    const audit = readFileSync(join(f.input.work_directory, '.workbench-image-rpc.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(audit.filter(row => row.direction === 'send' && row.rpc_method === 'turn/start').length, 0);
    assert.equal(f.calls().filter(row => row.method === 'turn/start').length, 0);
  } finally { f.close(); }
});
test('AGY: malformed/oversize-without-newline/timeout/post-spawn-abort wait for own TERM-resistant child close; unknown is never resubmitted', async () => {
  for (const mode of ['malformed', 'oversize', 'timeout', 'abort']) {
    const f = fixture('agy'), binary = join(f.root, 'term-resistant.mjs'), pidFile = join(f.root, 'pid'), signals = join(f.root, 'signals');
    const controller = new AbortController(); let pid: number | undefined;
    try {
      writeFileSync(binary, '#!/usr/bin/env node\nimport{writeFileSync,appendFileSync}from"node:fs";\n' +
        'writeFileSync(process.env.TEST_OWN_PID,String(process.pid));process.on("SIGTERM",()=>appendFileSync(process.env.TEST_OWN_SIGNALS,"TERM\\n"));\n' +
        'process.stdout.write(JSON.stringify({event:"init",conversation_id:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"})+"\\n");\n' +
        (mode === 'malformed' ? 'process.stdout.write("not-json\\n");\n' : mode === 'oversize' ? 'process.stdout.write(" ".repeat(21*1024*1024));\n' : '') +
        'setInterval(()=>{},1000);\n'); chmodSync(binary, 0o755);
      const adapter = createImageProvider('agy', { ...f.options, executable: binary, timeout_ms: mode === 'timeout' ? 1000 : 4000,
        env: { ...f.options.env, TEST_OWN_PID: pidFile, TEST_OWN_SIGNALS: signals } });
      const begin = Date.now();
      await assert.rejects(adapter.execute(f.input, { signal: controller.signal, checkpoint: value => { f.checkpoint(value); if (mode === 'abort' && value.conversation_id) controller.abort(); } }), { code: 'RESULT_UNKNOWN' });
      pid = Number(readFileSync(pidFile, 'utf8'));
      assert.throws(() => process.kill(pid!, 0), 'own child must already be reaped when execute rejects');
      assert.equal(readFileSync(signals, 'utf8'), 'TERM\n');
      assert(Date.now() - begin >= 1400, 'hard escalation must remain armed until TERM-resistant child closes');
      const cp = f.cp(); assert.equal(cp.local_process_closed, true); assert.equal(cp.process_exit_signal, 'SIGKILL'); assert.equal(cp.remote_cancel_confirmed, false); assert.equal(cp.conversation_id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      await assert.rejects(adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint }), { code: 'RESULT_UNKNOWN' });
      assert.equal(f.cp().submit_count, 1);
    } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } f.close(); }
  }
});
test('AGY: malformed stream waits for natural TERM exit and clears hard-stop/abort listeners; spawn failure is unknown', async () => {
  const f = fixture('agy'), binary = join(f.root, 'term-exit.mjs'), pidFile = join(f.root, 'pid'); let pid: number | undefined;
  try {
    writeFileSync(binary, '#!/usr/bin/env node\nimport{writeFileSync}from"node:fs";writeFileSync(process.env.TEST_OWN_PID,String(process.pid));process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),30));process.stdout.write("malformed\\n");setInterval(()=>{},1000);\n'); chmodSync(binary, 0o755);
    await assert.rejects(createImageProvider('agy', { ...f.options, executable: binary, env: { ...f.options.env, TEST_OWN_PID: pidFile } }).execute(f.input, { signal: f.signal, checkpoint: f.checkpoint }), { code: 'RESULT_UNKNOWN' });
    pid = Number(readFileSync(pidFile, 'utf8')); assert.throws(() => process.kill(pid!, 0)); assert.equal(f.cp().local_process_closed, true); assert.equal(f.cp().process_exit_code, 0); assert.equal(f.cp().remote_cancel_confirmed, false); assert.equal(getEventListeners(f.signal, 'abort').length, 0);
  } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } f.close(); }
  const missing = fixture('agy');
  try { await assert.rejects(createImageProvider('agy', { ...missing.options, executable: join(missing.root, 'missing') }).execute(missing.input, { signal: missing.signal, checkpoint: missing.checkpoint }), { code: 'RESULT_UNKNOWN' }); assert.equal(missing.cp().local_process_closed, true); }
  finally { missing.close(); }
});
test('Codex: full TOML comments/quoted/dotted/inline/nested profile MCP names are all disabled before native execution', async () => {
  for (const [source, expected] of [
    ['[mcp_servers.commented] # valid trailing comment\ncommand="fixture-never-executed"\n', ['commented']],
    ['[mcp_servers."quoted-name"] # comment\ncommand="fixture"\n[mcp_servers."quoted-name".env]\nSECRET="credential-sentinel"\n', ['quoted-name']],
    ['mcp_servers.dotted.command="fixture"\nmcp_servers.dotted.env.SECRET="credential-sentinel"\n', ['dotted']],
    ['mcp_servers={inline={command="fixture",env={SECRET="credential-sentinel"}},other={command="fixture2"}}\n', ['inline','other']],
    ['[mcp_servers.top]\ncommand="fixture"\n[profiles.selected.mcp_servers.profile]\ncommand="fixture"\n', ['profile','top']],
    ["[mcp_servers.'literal-name'] # valid comment\ncommand='fixture'\n", ['literal-name']],
    ['tool_profiles.groups=[{mcp_servers={array-server={command="fixture"}}}]\n', ['array-server']],
  ] as Array<[string, string[]]>) {
    const f = fixture('codex');
    try {
      writeFileSync(f.options.mcp_config_path, source);
      assert.deepEqual(imageMcpNames(f.options), expected);
      await f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint });
      const args = f.calls().find(row => row.method === 'native-spawn')!.args as string[];
      for (const name of expected) assert(args.includes(`mcp_servers.${name}.enabled=false`));
      assert(!JSON.stringify(f.calls()).includes('credential-sentinel')); assert.equal(f.calls().filter(row => row.method === 'turn/start').length, 1);
    } finally { f.close(); }
  }
});
test('Codex: malformed/unsafe/schema-invalid TOML fails closed before native spawn without exposing credential lines', async () => {
  for (const source of [
    '[mcp_servers.fixture] SECRET="credential-sentinel" invalid trailing text\n',
    '[mcp_servers."unsafe.dot"]\ncommand="credential-sentinel"\n',
    '[mcp_servers."unsafe name"]\ncommand="credential-sentinel"\n',
    'mcp_servers="credential-sentinel"\n',
    'mcp_servers={fixture="credential-sentinel"}\n',
    '[mcp_servers.fixture]\ncommand="fixture"\n[mcp_servers.fixture]\nSECRET="credential-sentinel"\n',
  ]) {
    const f = fixture('codex');
    try {
      writeFileSync(f.options.mcp_config_path, source);
      await assert.rejects(f.adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint }), (error: any) => {
        assert.equal(error.code, 'CAPABILITY_UNVERIFIED'); assert.equal(error.details.pre_submit_failure, true); assert.equal(error.details.pre_submit_phase, 'native_setup');
        assert(!JSON.stringify({ message: error.message, details: error.details }).includes('credential-sentinel')); return true;
      });
      assert.equal(f.calls().length, 0);
    } finally { f.close(); }
  }
});
test('AGY: direct-child exit with descendant-owned inherited pipes settles malformed/timeout/abort unknown within bound without resubmit', async () => {
  for (const mode of ['malformed', 'timeout', 'abort']) {
    const f = fixture('agy'), binary = join(f.root, 'descendant.mjs'), pids = join(f.root, 'own-pids.json'), count = join(f.root, 'own-submits');
    const controller = new AbortController(); let ids: { parent: number; descendant: number } | undefined;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      writeFileSync(binary, '#!/usr/bin/env node\nimport{spawn}from"node:child_process";import{writeFileSync,appendFileSync}from"node:fs";\n' +
        'const c=spawn(process.execPath,["-e","process.on(\'SIGTERM\',()=>{});setInterval(()=>{},1000)","--",process.env.TEST_MARKER],{stdio:["ignore","inherit","inherit"]});\n' +
        'writeFileSync(process.env.TEST_PIDS,JSON.stringify({parent:process.pid,descendant:c.pid}));appendFileSync(process.env.TEST_COUNT,"submit\\n");process.on("SIGTERM",()=>{});\n' +
        'process.stdout.write(JSON.stringify({event:"init",conversation_id:"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"})+"\\n");\n' +
        (mode === 'malformed' ? 'process.stdout.write("malformed\\n");\n' : '') + 'setInterval(()=>{},1000);\n'); chmodSync(binary, 0o755);
      const adapter = createImageProvider('agy', { ...f.options, executable: binary, timeout_ms: mode === 'timeout' ? 1000 : 3000,
        env: { ...f.options.env, TEST_PIDS: pids, TEST_COUNT: count, TEST_MARKER: 'IP09-own-' + f.input.binding.job_id } });
      const begin = Date.now();
      await assert.rejects(adapter.execute(f.input, { signal: controller.signal, checkpoint: value => { f.checkpoint(value); if (mode === 'abort' && value.conversation_id) controller.abort(); } }), (error: any) => {
        assert.equal(error.code, 'RESULT_UNKNOWN'); assert.equal(error.details.direct_child_exited, true); assert.equal(error.details.owned_stdio_detached, true);
        assert.equal(error.details.descendant_cleanup, 'not_attempted'); assert.equal(error.details.remote_cancel_confirmed, false); return true;
      });
      ids = JSON.parse(readFileSync(pids, 'utf8'));
      assert.equal(alive(ids!.parent), false, 'direct child is reaped before bounded result');
      assert.equal(alive(ids!.descendant), true, 'adapter does not signal an unverified descendant');
      assert(Date.now() - begin < 5000, 'execute cannot keep waiting for descendant-held pipes');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.equal(f.cp().conversation_id, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'); assert.equal(f.cp().remote_cancel_confirmed, false);
      await assert.rejects(adapter.execute(f.input, { signal: f.signal, checkpoint: f.checkpoint }), { code: 'RESULT_UNKNOWN' });
      assert.equal(readFileSync(count, 'utf8'), 'submit\n');
    } finally {
      if (!ids && existsSync(pids)) ids = JSON.parse(readFileSync(pids, 'utf8'));
      if (ids) {
        // Only this fixture's explicitly recorded surviving descendant is cleaned; no process group.
        if (alive(ids.descendant)) {
          const command = execFileSync('/bin/ps', ['-p', String(ids.descendant), '-o', 'command='], { encoding: 'utf8' });
          assert(command.includes('IP09-own-' + f.input.binding.job_id), 'cleanup must verify own descendant identity'); process.kill(ids.descendant, 'SIGKILL');
        }
        const until = Date.now() + 2000; while (alive(ids.descendant) && Date.now() < until) await delay(20);
        assert.equal(alive(ids.parent), false); assert.equal(alive(ids.descendant), false);
      }
      f.close();
    }
  }
});
