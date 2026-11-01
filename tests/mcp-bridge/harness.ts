import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CONTRACT_VERSION, type JsonObject, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { assertStorageRoot } from '../../packages/storage/src/connection/index.ts';
import { startApplication, type RunningApplication } from '../../apps/service/src/bootstrap/application.ts';
import type { ModuleFactory } from '../../packages/domain/src/ports/index.ts';
import type { WorkbenchConnectionDescriptor } from '../../plugins/shared/connection.ts';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const results: Array<Record<string, unknown>> = [];
export function evidence(name: string, value: unknown) {
  const directory = process.env.WORKBENCH_TEST_EVIDENCE_DIR ? join(resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR), 'wp23') : join(projectRoot, '.ci-artifacts/evidence/wp-23');
  mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n');
}
export async function checked(name: string, operation: () => Promise<void>) {
  const actual_operation_at = new Date().toISOString();
  try { await operation(); results.push({ name, scope: 'internal_rule', result: 'passed', actual_operation_at }); }
  catch (error) { results.push({ name, scope: 'internal_rule', result: 'failed', actual_operation_at, error: error instanceof Error ? error.stack : String(error) }); throw error; }
  finally { evidence('integration-results.json', results); }
}
export async function fixture(moduleFactories?: ModuleFactory[]) {
  assertStorageRoot(projectRoot);
  const root = mkdtempSync(join(projectRoot, 'tests/mcp-bridge/.wp23-'));
  const paths = { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') };
  for (const path of Object.values(paths)) if (path) mkdirSync(path);
  const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: 'WP23 isolated real HTTP/MCP integration', mode: 'demo', timezone: 'America/Los_Angeles', paths, listen: { host: '127.0.0.1', port: 4318 } };
  let app: RunningApplication;
  try { app = await startApplication(config, { moduleFactories, port: 0, executorHealth: async () => [] }); } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  const uiPath = join(root, 'workbench.html'); writeFileSync(uiPath, '<!doctype html><html lang="zh-CN"><body>WP23 isolated MCP protocol fixture; shared production UI is separately bundled.</body></html>');
  function descriptor(extra: Partial<WorkbenchConnectionDescriptor> = {}): WorkbenchConnectionDescriptor { return { descriptor_version: 1, plugin_id: 'personal-ip-workbench', base_url: `http://127.0.0.1:${app.address.port}`, identity: { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION }, host: { surface: 'codex_desktop', runtime_version: 'fixture', connection_mode: 'local_stdio', plugin_version: '0.1.0' }, ...extra }; }
  const clients: Array<{ client: Client; transport: StdioClientTransport }> = [];
  async function connect(extra: Partial<WorkbenchConnectionDescriptor> = {}) {
    const path = join(root, 'connection-' + randomUUID() + '.json'); writeFileSync(path, JSON.stringify(descriptor(extra)));
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, 'apps/mcp/src/main.ts')], env: { ...process.env as Record<string, string>, WORKBENCH_CONNECTION_PATH: path, WORKBENCH_UI_PATH: uiPath, WORKBENCH_EXPECTED_HOST_SURFACE: 'codex_desktop' }, stderr: 'pipe' });
    const client = new Client({ name: 'WP23 internal MCP integration', version: '0.1.0' });
    clients.push({ client, transport });
    let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    await client.connect(transport); return { client, transport, get stderr() { return stderr; } };
  }
  async function http(method: string, path: string, body: unknown = undefined, headers: Record<string, string> = {}) {
    const response = await fetch(descriptor().base_url + path, { method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': config.workspace_id, 'X-Service-Instance-Id': config.service_instance_id, 'Idempotency-Key': randomUUID(), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as JsonObject };
  }
  async function restart() { const port = app.address.port; await app.close(); app = await startApplication(config, { moduleFactories, port, executorHealth: async () => [] }); }
  async function cleanup() { for (const connection of clients) { try { await connection.client.close(); } catch {} try { await connection.transport.close(); } catch {} } await app.close(); rmSync(root, { recursive: true, force: true }); }
  return { root, config, descriptor, connect, http, restart, cleanup, get app(): RunningApplication { return app; } };
}
export async function call(connection: { client: Client }, name: string, input: JsonObject = {}) {
  const result = await connection.client.callTool({ name, arguments: input });
  const envelope = result.structuredContent as { identity: { workspace_id: string; service_instance_id: string; contract_version: string }; data: JsonObject; error?: { code: string; request_id: string }; status?: number; request_id: string | null };
  return { result, ...envelope };
}
