#!/usr/bin/env node
// Deterministic protocol fixture. This never connects to a provider.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CODEX_SCHEMA_HASHES } from '../../packages/adapters/src/agent/codex/schema-hashes.ts';
const trace = value => { if (process.env.IMAGE_FIXTURE_TRACE) appendFileSync(process.env.IMAGE_FIXTURE_TRACE, JSON.stringify(value) + '\n'); };
const mode = process.env.IMAGE_FIXTURE_MODE ?? 'success';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.161.0\n'); process.exit(0); }
if (process.argv.includes('changelog')) { process.stdout.write('Version 1.3.3 fixture\n'); process.exit(0); }
if (process.argv.includes('generate-json-schema')) {
  const dir = process.argv[process.argv.indexOf('--out') + 1]; mkdirSync(join(dir, 'v2'), { recursive: true });
  for (const name of Object.keys(CODEX_SCHEMA_HASHES)) copyFileSync(fileURLToPath(new URL('../service-agent/schemas/v2/' + name + '.json', import.meta.url)), join(dir, 'v2', name + '.json'));
  process.exit(0);
}
if (process.argv.includes('--print')) {
  const prompt = process.argv[process.argv.indexOf('--print') + 1]; trace({ method: 'agy-submit', prompt });
  if (mode === 'noid') process.exit(2);
  const main = randomUUID(), child = randomUUID(), root = process.env.IMAGE_FIXTURE_STATE;
  const dir = id => join(root, 'brain', id, '.system_generated', 'logs');
  mkdirSync(dir(main), { recursive: true }); mkdirSync(dir(child), { recursive: true }); mkdirSync(join(root, 'conversations'), { recursive: true });
  const output = join(root, 'brain', main, 'image.png');
  if (mode === 'corrupt') writeFileSync(output, Buffer.from([137,80,78,71,13,10,26,10, ...new Array(30).fill(0)]));
  else copyFileSync(process.env.IMAGE_FIXTURE_PNG, output);
  const imagePaths = process.env.IMAGE_FIXTURE_REFERENCE ? JSON.stringify([process.env.IMAGE_FIXTURE_REFERENCE]) : undefined;
  const args = { Prompt: JSON.stringify(prompt), ...(imagePaths ? { ImagePaths: imagePaths } : {}) };
  const mainSteps = [{ type: 'USER_INPUT', content: prompt, step_index: 0 }, { type: 'GENERIC', content: JSON.stringify({ conversationId: child }), step_index: 2 }];
  const childSteps = [{ type: 'SYSTEM_MESSAGE', content: 'sender=' + main, step_index: 0 },
    { step_index: 1, tool_calls: [{ name: 'generate_image', args }] },
    { step_index: 2, type: 'GENERIC', status: 'DONE', media: [{ mime_type: 'image/png', uri: 'file://' + output }] }];
  if (mode === 'double') childSteps.push({ step_index: 3, tool_calls: [{ name: 'generate_image', args }] }, { step_index: 4, status: 'DONE', media: [{ mime_type: 'image/png', uri: 'file://' + output }] });
  for (const [id, steps] of [[main, mainSteps], [child, childSteps]]) writeFileSync(join(dir(id), 'transcript.jsonl'), steps.map(row => JSON.stringify(row)).join('\n'));
  const vi = value => { const bytes = []; do { const part = value % 128; value = Math.floor(value / 128); bytes.push(part | (value ? 128 : 0)); } while (value); return Buffer.from(bytes); };
  const field = (id, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([vi(id * 8 + 2), vi(bytes.length), bytes]); };
  const num = (id, value) => Buffer.concat([vi(id * 8), vi(value)]);
  const image = Buffer.concat([field(4, 'file://' + output), num(5, readFileSync(output).length), field(6, 'gemini-3.1-flash-image'), field(8, 'fixture')]);
  const any = Buffer.concat([field(1, 'type.googleapis.com/exa.cortex.core.tools.GenerateImage'), field(2, image)]);
  const payload = Buffer.concat([field(140, field(2, field(6, any))), field(20, 'call_12345')]);
  const db = new DatabaseSync(join(root, 'conversations', child + '.db')); db.exec('CREATE TABLE steps(idx INTEGER,step_payload BLOB)'); db.prepare('INSERT INTO steps VALUES(?,?)').run(2, payload); db.close();
  send({ event: 'init', conversation_id: main });
  send({ event: 'step_update', step_update: { conversation_id: main, subagent_info: { subagents: [{ type_name: 'image-generator', conversation_id: child }] } } });
  if (mode === 'disconnect') process.exit(2);
  send({ event: 'result', result: { conversation_id: main, status: 'SUCCESS', usage: { input_tokens: 10, output_tokens: 3 } } });
  process.exit(0);
}
const template = JSON.parse(readFileSync(fileURLToPath(new URL('../service-agent/native-fixture.json', import.meta.url)), 'utf8'));
trace({ method: 'native-spawn', args: process.argv.slice(2) });
const clone = value => JSON.parse(JSON.stringify(value));
const nativeRecord = join(process.cwd(), 'fixture-thread.json'); let thread = randomUUID(), turn = randomUUID();
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); trace(m); if (!m.id) return;
  if (m.method === 'initialize') { const reply = () => send({ id: m.id, result: { userAgent: 'image fixture' } }); return mode === 'slow_initialize' ? setTimeout(reply, 200) : reply(); }
  if (m.method === 'modelProvider/capabilities/read') { const reply = () => send({ id: m.id, result: { imageGeneration: mode !== 'disabled' } }); return mode === 'slow_caps' ? setTimeout(reply, 200) : reply(); }
  if (m.method === 'account/read') { const reply = () => send({ id: m.id, result: clone(template[m.method]) }); return mode === 'slow_account' ? setTimeout(reply, 200) : reply(); }
  if (m.method === 'thread/start') { const value = clone(template[m.method]); value.thread.id = thread; if (mode === 'provider') value.modelProvider = 'other'; return send({ id: m.id, result: value }); }
  if (m.method === 'thread/read') {
    const value = existsSync(nativeRecord) ? JSON.parse(readFileSync(nativeRecord, 'utf8')) : { ...clone(template['thread/start'].thread), id: thread, turns: [] };
    return send({ id: m.id, result: { thread: value } });
  }
  if (m.method === 'turn/start') {
    const source = join(process.cwd(), 'generated.png'); if (mode === 'nonimage') writeFileSync(source, 'This is an agent message, not image bytes.'); else copyFileSync(process.env.IMAGE_FIXTURE_PNG, source);
    const item = { id: 'image-123', type: 'imageGeneration', result: '', savedPath: source, status: 'completed' };
    const end = clone(template['turn/completed']); end.threadId = thread; end.turn.id = turn; end.turn.items = [{ type: 'userMessage', id: 'input-123', content: m.params.input }, item];
    if (['noimage', 'summarynoimage'].includes(mode)) { end.turn.items = [end.turn.items[0], { ...clone(template['item/completed'].item), text: 'Native image wrapper was disabled.' }]; end.turn.itemsView = mode === 'noimage' ? 'full' : 'summary'; }
    writeFileSync(nativeRecord, JSON.stringify({ ...clone(template['thread/start'].thread), id: thread, turns: [end.turn] }));
    const start = clone(template['turn/started']); start.threadId = thread; start.turn.id = turn; send({ method: 'turn/started', params: start });
    const response = clone(template['turn/start']); response.turn.id = turn; send({ id: m.id, result: response });
    setTimeout(() => {
      if (mode === 'disconnect') process.exit(2);
      const completed = clone(template['item/completed']); completed.threadId = thread; completed.turnId = turn; completed.item = ['noimage', 'summarynoimage'].includes(mode) ? end.turn.items[1] : item; send({ method: 'item/completed', params: completed });
      send({ method: 'turn/completed', params: end });
    }, 20); return;
  }
  if (m.method === 'turn/interrupt') return send({ id: m.id, result: {} });
  send({ id: m.id, result: {} });
});
