import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, ContractError } from '../../packages/contracts/src/index.ts';
import { BoundServiceClient } from '../../apps/mcp/src/service-client.ts';
import type { WorkbenchConnectionDescriptor } from '../../plugins/shared/connection.ts';
import { evidence } from './harness.ts';

test('握手只发送公开身份；错误服务不接收连接凭据且不发业务/媒体请求', async () => {
  const actual_operation_at = new Date().toISOString();
  const descriptor: WorkbenchConnectionDescriptor = {
    descriptor_version: 1, plugin_id: 'personal-ip-workbench', base_url: 'http://127.0.0.1:4318',
    identity: { workspace_id: randomUUID(), service_instance_id: randomUUID(), contract_version: CONTRACT_VERSION },
    host: { surface: 'codex_desktop', runtime_version: 'fixture', connection_mode: 'local_stdio', plugin_version: '0.1.0' },
    connection_credential: randomUUID() + randomUUID(),
  };
  type FetchRecord = { path: string; has_credential: boolean; has_host_metadata: boolean };
  function record(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): FetchRecord {
    const headers = new Headers(init?.headers);
    return { path: new URL(String(input)).pathname, has_credential: headers.has('X-Host-Connection-Credential'), has_host_metadata: ['X-Host-Surface', 'X-Host-Runtime-Version', 'X-Host-Connection-Mode', 'X-Host-Plugin-Version'].every(name => headers.has(name)) };
  }
  const rejected: Array<{ mismatch: string; requests: FetchRecord[] }> = [];
  for (const field of ['workspace_id', 'service_instance_id', 'contract_version'] as const) {
    const requests: FetchRecord[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(record(input, init));
      return Response.json({ ...descriptor.identity, [field]: 'different-identity' });
    };
    const client = new BoundServiceClient(descriptor, fetcher);
    const isMismatch = (error: unknown) => error instanceof ContractError && error.code === 'WORKSPACE_INSTANCE_MISMATCH';
    await assert.rejects(client.request('POST', '/api/v1/host-runs', {}, 'fixture-key'), isMismatch);
    await assert.rejects(client.content('/api/v1/assets/fixture/content'), isMismatch);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.path === '/api/v1/identity' && !request.has_credential && request.has_host_metadata));
    rejected.push({ mismatch: field, requests });
  }
  const matched: FetchRecord[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = record(input, init); matched.push(request);
    const headers = new Headers(init?.headers);
    if (request.path === '/api/v1/identity') {
      assert.equal(headers.has('X-Host-Connection-Credential'), false);
      return Response.json(descriptor.identity);
    }
    // 只比较真假；失败输出与证据中均不打印凭据值。
    assert.ok(headers.get('X-Host-Connection-Credential') === descriptor.connection_credential);
    return request.path.endsWith('/content') ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'application/octet-stream' } }) : Response.json({ state: 'accepted' });
  };
  const client = new BoundServiceClient(descriptor, fetcher);
  await client.request('POST', '/api/v1/host-runs', {}, 'fixture-key');
  await client.content('/api/v1/assets/fixture/content');
  assert.deepEqual(matched.map(request => [request.path, request.has_credential]), [['/api/v1/identity', false], ['/api/v1/host-runs', true], ['/api/v1/identity', false], ['/api/v1/assets/fixture/content', true]]);
  evidence('credential-handshake-rejection.json', { scope: 'internal_rule', form: 'injected fetch with original BoundServiceClient', result: 'passed', actual_operation_at, rejected, matched, actual_secret_values_recorded: false });
});
