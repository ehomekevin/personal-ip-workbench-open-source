// 实际 Node24 / bundled JS 的隔离协议验证；没有真实宿主或模型，不提升可视/原生追踪。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CONTRACT_VERSION } from '../../../packages/contracts/src/index.ts';

const runtime = resolve(process.argv[2] ?? '.ci-artifacts/plugins/claude/desktop');
const resultPath = process.argv[3];
const locate = spawnSync('npm', ['exec', '--yes', '--package=node@24.21.0', '--', 'node', '-p', 'JSON.stringify({version:process.version,executable:process.execPath})'], { encoding: 'utf8' });
assert.equal(locate.status, 0, 'Node24 npm runtime unavailable');
const node = JSON.parse(locate.stdout); assert.equal(node.version, 'v24.21.0');
const serverPath = join(runtime, 'server/server.mjs'), uiPath = join(runtime, 'ui/workbench.html');
const serverBytes = await readFile(serverPath), uiBytes = await readFile(uiPath);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = { service_instance_id: 'packaging-fixture-service', workspace_id: 'packaging-fixture-workspace', contract_version: CONTRACT_VERSION };
let serviceRequests = 0;
const fixture = createServer((request, response) => {
  serviceRequests++; response.setHeader('Content-Type', 'application/json');
  if (request.url === '/api/v1/identity') response.end(JSON.stringify(identity));
  else if (request.url.startsWith('/api/v1/host-capabilities?')) response.end(JSON.stringify({ capabilities: [] }));
  else { response.statusCode = 404; response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Only isolated identity/capability endpoints', details: {}, retryable: false, request_id: 'fixture' } })); }
});
await new Promise((done, fail) => { fixture.once('error', fail); fixture.listen(0, '127.0.0.1', done); });
const root = await mkdtemp(join(tmpdir(), 'workbench-node24-smoke-'));
const surfaces = ['codex_desktop', 'claude_desktop_chat', 'claude_cowork', 'claude_code'];
const records = [];

async function clientFor(surface, expected = surface) {
  const descriptorPath = join(root, surface + '.json');
  await writeFile(descriptorPath, JSON.stringify({ descriptor_version: 1, plugin_id: 'personal-ip-workbench', base_url: `http://127.0.0.1:${fixture.address().port}`, identity, host: { surface, runtime_version: 'isolated-node24-fixture', connection_mode: 'local_stdio', plugin_version: '0.1.0' } }));
  const child = spawn(node.executable, [serverPath], { env: { ...process.env, WORKBENCH_CONNECTION_PATH: descriptorPath, WORKBENCH_EXPECTED_HOST_SURFACES: expected }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let buffer = '', nextId = 0, stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  child.stdout.on('data', bytes => {
    buffer += bytes.toString();
    for (;;) {
      const at = buffer.indexOf('\n'); if (at < 0) break;
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line) continue;
      const response = JSON.parse(line), item = pending.get(response.id);
      if (item) { clearTimeout(item.timer); pending.delete(response.id); response.error ? item.reject(new Error(response.error.message)) : item.resolve(response.result); }
    }
  });
  child.on('exit', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('MCP child exited before reply')); } pending.clear(); });
  return {
    child, stderr: () => stderr,
    notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); },
    request(method, params = {}) { return new Promise((resolve, reject) => { const id = ++nextId; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request timeout: ${method}`)); }, 10_000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); },
    async close() { if (child.exitCode !== null) return; child.stdin.end(); child.kill('SIGTERM'); await new Promise(done => { const timer = setTimeout(() => child.kill('SIGKILL'), 2_000); child.once('exit', () => { clearTimeout(timer); done(); }); }); },
  };
}

try {
  for (const surface of surfaces) {
    const client = await clientFor(surface);
    try {
      const initialized = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'packaging-node24-smoke', version: '0.1.0' } });
      assert.equal(initialized.serverInfo.name, 'personal-ip-workbench'); client.notify('notifications/initialized');
      const tools = await client.request('tools/list'); assert.ok(tools.tools.some(tool => tool.name === 'open_workbench'));
      const context = await client.request('tools/call', { name: 'get_context', arguments: {} });
      assert.equal(context.isError, undefined); assert.deepEqual(context.structuredContent.identity, identity);
      assert.equal(context.structuredContent.data.host.surface, surface);
      assert.equal(context.structuredContent.data.capabilities.find(item => item.operation === 'native_task_tracking').status, 'unverified');
      const opened = await client.request('tools/call', { name: 'open_workbench', arguments: { page: 'today' } });
      const resource = await client.request('resources/read', { uri: opened.structuredContent.data.resource_uri });
      assert.equal(sha256(Buffer.from(resource.contents[0].text)), sha256(uiBytes));
      assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
      assert.deepEqual(resource.contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
      records.push({ host_surface: surface, result: 'passed', scope: 'isolated_fixture', grade: 'internal_rule', protocol: initialized.protocolVersion, tools: tools.tools.length, ui_bytes: uiBytes.length, ui_sha256: sha256(uiBytes), native_task_tracking: 'unverified', real_host: 'not_run', real_visual: 'not_run' });
    } finally { await client.close(); }
  }
  const before = serviceRequests;
  const wrong = await clientFor('claude_desktop_chat', 'claude_code');
  await new Promise(done => wrong.child.once('exit', done));
  assert.notEqual(wrong.child.exitCode, 0); assert.match(wrong.stderr(), /插件入口与固定宿主 surface 不一致/); assert.equal(serviceRequests, before);
  const result = { recorded_at: new Date().toISOString(), result: 'passed', grade: 'internal_rule', runtime: node.version, server_bytes: serverBytes.length, server_sha256: sha256(serverBytes), ui_bytes: uiBytes.length, ui_sha256: sha256(uiBytes), wrong_surface_rejected_before_service_call: true, service_started: 'isolated_identity_fixture_only', real_host_installation: 'not_run', real_provider_calls: 0, records };
  if (resultPath) await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally { await new Promise(done => fixture.close(done)); await rm(root, { recursive: true, force: true }); }
