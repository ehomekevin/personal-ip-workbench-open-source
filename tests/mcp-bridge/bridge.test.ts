import test from 'node:test';
import assert from 'node:assert/strict';
import type { App } from '@modelcontextprotocol/ext-apps';
import { CONTRACT_VERSION, ContractError, type ServiceIdentity } from '../../packages/contracts/src/index.ts';
import { createMcpHostBridge, HostBridgeError, WORKBENCH_RESOURCE_URI } from '../../packages/host-bridge/src/core/index.ts';
import { parseConnectionDescriptor } from '../../plugins/shared/connection.ts';

const identity: ServiceIdentity = { workspace_id: 'fixture-workspace', service_instance_id: 'fixture-service', contract_version: CONTRACT_VERSION };
function appWith(call: (name: string) => unknown): App {
  return { callServerTool: async ({ name }: { name: string }) => ({ content: [], structuredContent: call(name) }), getHostContext: () => ({ availableDisplayModes: ['inline', 'fullscreen'] }), getHostCapabilities: () => ({ openLinks: {}, downloadFile: {} }) } as unknown as App;
}
const envelope = (data: unknown) => ({ identity, data, request_id: null });
const context = { identity, host: { surface: 'codex_desktop', runtime_version: 'fixture', connection_mode: 'local_stdio', plugin_version: '0.1.0' }, capabilities: ['fullscreen', 'file_upload', 'download', 'external_link'].map(operation => ({ operation, status: 'unverified', limitations: [], verified_at: null, evidence_ref: null })), standalone_url: null };

test('未验证能力不安装伪 optional HostBridge 方法，身份和 payload schema 严格校验', async () => {
  const bridge = await createMcpHostBridge({ app: appWith(() => envelope(context)), expectedIdentity: identity, hostSurface: 'codex_desktop', connectionMode: 'local_stdio' });
  for (const method of ['requestDisplayMode', 'openExternal', 'uploadFile', 'uploadAsset', 'downloadArtifact'] as const) assert.equal(bridge[method], undefined);
  await assert.rejects(createMcpHostBridge({ app: appWith(() => ({ ...envelope(context), identity: { ...identity, workspace_id: 'another' } })), expectedIdentity: identity }), e => e instanceof ContractError && e.code === 'WORKSPACE_INSTANCE_MISMATCH');
  await assert.rejects(createMcpHostBridge({ app: appWith(() => envelope({ ...context, host: { ...context.host, credential: 'forbidden' } })) }), e => e instanceof ContractError && e.code === 'VALIDATION_ERROR');
  await assert.rejects(createMcpHostBridge({ app: appWith(() => envelope({ ...context, capabilities: [{ operation: 'fullscreen', status: 'fake', limitations: [], verified_at: null, evidence_ref: null }] })) }), e => e instanceof ContractError && e.code === 'VALIDATION_ERROR');
  await assert.rejects(bridge.callTool('renew_host_run', {}), e => e instanceof ContractError && e.code === 'CAPABILITY_UNVERIFIED');
});
test('服务错误码、HTTP 状态和 request_id 穿过 HostBridge 保持原值', async () => {
  const error = { code: 'REVISION_CONFLICT', message: '当前 head 已改变', retryable: false, details: { current_revision: 'revision-new' }, request_id: 'request-fixture' };
  const app = appWith(name => name === 'get_context' ? envelope(context) : { ...envelope(null), error, status: 409 });
  // 使用标准 MCP isError；不可只凭 error 字段推断成功。
  const call = app.callServerTool.bind(app); app.callServerTool = async (input, options) => { const result = await call(input, options); return { ...result, ...(input.name === 'save_document' ? { isError: true } : {}) }; };
  const bridge = await createMcpHostBridge({ app });
  await assert.rejects(bridge.callTool('save_document', { id: 'document', expected_revision_id: 'old', text: '保留未提交文字', origin: 'human', idempotency_key: 'fixture' }), e => e instanceof HostBridgeError && e.status === 409 && e.response.error.code === 'REVISION_CONFLICT' && e.response.error.request_id === 'request-fixture');
  assert.equal(WORKBENCH_RESOURCE_URI, 'ui://personal-ip-workbench/0.1.0.html');
});
test('描述仅接受已绑定回环服务、宿主和明确字段', () => {
  const descriptor = { descriptor_version: 1, plugin_id: 'personal-ip-workbench', base_url: 'http://127.0.0.1:4318', identity, host: context.host };
  assert.equal(parseConnectionDescriptor(descriptor).base_url, descriptor.base_url);
  for (const value of [{ ...descriptor, base_url: 'https://example.com' }, { ...descriptor, base_url: 'http://user:secret@127.0.0.1:4318' }, { ...descriptor, host: { ...context.host, observer_credential: 'forbidden' } }, { ...descriptor, observer_credential: 'forbidden' }, { ...descriptor, host: 2 }, { ...descriptor, identity: [] }, { ...descriptor, web_url: false }]) assert.throws(() => parseConnectionDescriptor(value), e => e instanceof ContractError && e.code === 'VALIDATION_ERROR');
});
