import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter } from '../../packages/adapters/src/agent/codex/index.ts';
import type { AgentRunInput } from '../../packages/contracts/src/index.ts';
import { projectRoot, schemaDirectory } from './harness.ts';
function input(): AgentRunInput { return { job_id: randomUUID(), kind: 'document_modify', task_instruction: 'Return 42', target_document_id: null, base_revision_id: null, input_manifest: {}, allowed_tools: [], output_schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } }; }
test('P1 regression：subscription account + custom thread provider 在start/resume两路线都不得turn/start', async () => { const root = mkdtempSync(join(projectRoot, 'tests/service-agent/.wp15-provider-')); const path = join(root, 'requests.jsonl'); process.env.WP15_FAKE_TRACE = path; const options = { workspace_id: randomUUID(), cwd: root, lock_root: join(root, 'locks'), schema_directory: schemaDirectory, executable: join(projectRoot, 'tests/service-agent/fake-codex.mjs') }; const a = new CodexAdapter(options), b = new CodexAdapter(options);
 try { process.env.WP15_FAKE_MODE = 'wrong_provider'; await assert.rejects(a.start(input()), { code: 'AUTH_REQUIRED' }); let requests = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)); assert.equal(requests.filter(m => m.method === 'turn/start').length, 0); assert.equal(requests.find(m => m.method === 'thread/start').params.modelProvider, 'openai');
  process.env.WP15_FAKE_MODE = 'slow'; const h = await a.start(input()); await a.cancel(h); await assert.rejects(async()=>{for await (const _ of a.streamEvents(h)) {}},{code:'HOST_INTERRUPTED'});await a.close(); process.env.WP15_FAKE_MODE = 'wrong_provider'; await assert.rejects(b.resume(JSON.parse(JSON.stringify(h)), {}), { code: 'AUTH_REQUIRED' }); requests = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)); assert.equal(requests.filter(m => m.method === 'turn/start').length, 1); assert.equal(requests.find(m => m.method === 'thread/resume').params.modelProvider, 'openai');
 } finally { await a.close(); await b.close(); rmSync(root, { recursive: true, force: true }); delete process.env.WP15_FAKE_MODE; delete process.env.WP15_FAKE_TRACE; }
});
