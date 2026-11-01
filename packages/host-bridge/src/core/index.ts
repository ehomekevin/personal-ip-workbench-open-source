import type { App } from '@modelcontextprotocol/ext-apps';
import { CONTRACT_VERSION, CAPABILITY_STATUSES, WORKBENCH_PAGES, PLATFORMS, OpenWorkbenchSchema, workbenchLocationHash, objectSchema, ContractError, type OpenWorkbenchResult, type HostBridge, type HostCapability, type ServiceIdentity, type JsonObject, type ApiError, type ArtifactManifest } from '@workbench/contracts';
import { MCP_TOOL_INVENTORY, MCP_RESULT_JSON_SCHEMA, WORKBENCH_RESOURCE_URI, BUSINESS_RESOURCE_PREFIX } from './tools.ts';
export * from './tools.ts';

export class HostBridgeError extends Error {
  readonly status: number; readonly response: ApiError;
  constructor(status: number, response: ApiError) { super(response.error.message); this.status = status; this.response = response; }
}
interface Envelope { identity: ServiceIdentity; data: unknown; request_id: string | null; error?: ApiError['error']; status?: number }
const contextSchema = objectSchema(['identity', 'capabilities', 'host', 'standalone_url'], {
  identity: MCP_RESULT_JSON_SCHEMA.properties.identity,
  capabilities: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['operation', 'status', 'limitations', 'verified_at', 'evidence_ref'], properties: { operation: { type: 'string', minLength: 1 }, status: { type: 'string', enum: CAPABILITY_STATUSES }, limitations: { type: 'array', items: { type: 'string' } }, verified_at: { type: ['string', 'null'] }, evidence_ref: { type: ['string', 'null'] } } } },
  host: { type: 'object', additionalProperties: false, required: ['surface', 'runtime_version', 'connection_mode', 'plugin_version'], properties: { surface: { type: 'string' }, runtime_version: { type: 'string' }, connection_mode: { type: 'string', enum: ['local_stdio'] }, plugin_version: { type: 'string' } } },
  standalone_url: { type: ['string', 'null'] }, page: { type: 'string', enum: WORKBENCH_PAGES }, resource_uri: { type: 'string', enum: [WORKBENCH_RESOURCE_URI] }, topic_id: { type: 'string' }, variant_id: { type: 'string' }, settings_view: { type: 'string', enum: ['publishing','skills'] }, platform: { type: 'string', enum: PLATFORMS }, account_id: { type: 'string' }, location: { type: 'object' }, topic: { type: 'object' }, variant: { type: 'object' }, document: { type: 'object' }, job: { type: 'object' }, sources: { type: 'array', items: { type: 'object' } },
});
export interface McpHostBridgeOptions { app: App; expectedIdentity?: ServiceIdentity; hostSurface?: string; connectionMode?: string }
export interface McpHostBridge extends HostBridge {
  describeHostContext(): ReturnType<App['getHostContext']>;
  uploadAsset?(file: File, fields: Readonly<Record<string, string>>, options?: { signal?: AbortSignal; idempotencyKey?: string }): Promise<unknown>;
}
export async function createMcpHostBridge(options: McpHostBridgeOptions): Promise<McpHostBridge> {
  let expected = options.expectedIdentity;
  function unwrap(result: Awaited<ReturnType<App['callServerTool']>>): unknown {
    objectSchema(MCP_RESULT_JSON_SCHEMA.required, MCP_RESULT_JSON_SCHEMA.properties).parse(result.structuredContent);
    const value = result.structuredContent as Envelope | undefined;
    if (!value?.identity || value.identity.contract_version !== CONTRACT_VERSION || (expected &&
        (value.identity.workspace_id !== expected.workspace_id || value.identity.service_instance_id !== expected.service_instance_id || value.identity.contract_version !== expected.contract_version)))
      throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '宿主工具结果与固定工作区身份不一致');
    expected ??= value.identity;
    if (result.isError) {
      if (!value.error) throw new ContractError('STORAGE_UNAVAILABLE', '宿主工具未返回结构化错误');
      throw new HostBridgeError(value.status ?? 500, { error: value.error });
    }
    return value.data;
  }
  async function callTool(name: string, input: JsonObject): Promise<unknown> {
    if (!MCP_TOOL_INVENTORY.some(tool => tool.name === name)) throw new ContractError('CAPABILITY_UNVERIFIED', '宿主工具未登记', { tool: name });
    const value = unwrap(await options.app.callServerTool({ name, arguments: input }));
    if (name === 'get_context' || name === 'open_workbench') contextSchema.parse(value);
    if (name === 'open_workbench') OpenWorkbenchSchema.parse((value as OpenWorkbenchResult).location);
    return value;
  }
  async function describeCapabilities() {
    const data = await callTool('get_context', {}) as { identity: ServiceIdentity; capabilities: HostCapability[]; host: { surface: string; connection_mode: string } };
    if (options.hostSurface && data.host.surface !== options.hostSurface || options.connectionMode && data.host.connection_mode !== options.connectionMode)
      throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '宿主桥接入口与连接描述不一致');
    return { identity: data.identity, capabilities: data.capabilities };
  }
  const first = await describeCapabilities();
  const supported = (operation: string) => first.capabilities.some(item => item.operation === operation && item.status === 'supported');
  const bridge: McpHostBridge = {
    describeCapabilities, describeHostContext: () => options.app.getHostContext(), callTool,
    async openWorkbench(input) { OpenWorkbenchSchema.parse(input); const data = await callTool('open_workbench', input as unknown as JsonObject) as OpenWorkbenchResult; if(workbenchLocationHash(data.location)!==workbenchLocationHash(input))throw new ContractError('VALIDATION_ERROR','宿主返回定位与请求不符'); return { resource_uri: data.resource_uri, identity: data.identity, capabilities: data.capabilities, location: data.location }; },
    async readResource(uri) {
      if (uri !== WORKBENCH_RESOURCE_URI && !uri.startsWith(BUSINESS_RESOURCE_PREFIX)) throw new ContractError('VALIDATION_ERROR', '宿主资源未登记');
      const result = await options.app.readServerResource({ uri });
      for (const content of result.contents) if ('text' in content && content.mimeType === 'application/json') {
        const value = JSON.parse(content.text) as Envelope;
        if (!value.identity || !expected || value.identity.workspace_id !== expected.workspace_id || value.identity.service_instance_id !== expected.service_instance_id || value.identity.contract_version !== expected.contract_version)
          throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '宿主资源与固定工作区身份不一致');
      }
      return result;
    },
  };
  if (supported('fullscreen') && options.app.getHostContext()?.availableDisplayModes?.includes('fullscreen')) bridge.requestDisplayMode = async mode => {
    const latest = await describeCapabilities(); if (!latest.capabilities.some(c => c.operation === 'fullscreen' && c.status === 'supported')) throw new ContractError('CAPABILITY_UNVERIFIED', '此宿主显示模式能力尚未验证');
    const result = await options.app.requestDisplayMode({ mode }); if (result.mode !== mode) throw new ContractError('CAPABILITY_UNSUPPORTED', '宿主未切换到请求的显示模式');
  };
  if (supported('external_link') && options.app.getHostCapabilities()?.openLinks) bridge.openExternal = async url => {
    const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new ContractError('VALIDATION_ERROR', '外链协议无效');
    const latest = await describeCapabilities(); if (!latest.capabilities.some(c => c.operation === 'external_link' && c.status === 'supported')) throw new ContractError('CAPABILITY_UNVERIFIED', '此宿主外链能力尚未验证');
    const result = await options.app.openLink({ url: parsed.href }); if (result.isError) throw new ContractError('CAPABILITY_UNSUPPORTED', '宿主拒绝打开外链');
  };
  if (supported('file_upload')) {
    bridge.uploadAsset = async (file, fields, requestOptions = {}) => {
      requestOptions.signal?.throwIfAborted();
      if (file.size > 4 * 1024 * 1024 || Object.keys(fields).some(key => !['topic_id', 'purpose'].includes(key))) throw new ContractError('VALIDATION_ERROR', '上传文件超过内联上限或含未登记字段');
      const current = await describeCapabilities(); if (!current.capabilities.some(c => c.operation === 'file_upload' && c.status === 'supported')) throw new ContractError('CAPABILITY_UNVERIFIED', '当前宿主素材上传尚未验证');
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      requestOptions.signal?.throwIfAborted();
      return callTool('upload_asset', { filename: file.name, mime_type: file.type || 'application/octet-stream', base64: btoa(binary), sha256, ...fields, purpose: fields.purpose ?? '', idempotency_key: requestOptions.idempotencyKey ?? crypto.randomUUID() });
    };
    bridge.uploadFile = async file => {
      const result = await bridge.uploadAsset!(new File([file], 'upload', { type: file.type }), {}) as { asset_id: string; sha256: string };
      return { file_id: result.asset_id, sha256: result.sha256 };
    };
  }
  if (supported('download') && options.app.getHostCapabilities()?.downloadFile) bridge.downloadArtifact = async artifactId => {
    const current = await describeCapabilities(); if (!current.capabilities.some(c => c.operation === 'download' && c.status === 'supported')) throw new ContractError('CAPABILITY_UNVERIFIED', '当前宿主成品下载尚未验证');
    const data = await callTool('get_artifact', { id: artifactId }) as { manifest: ArtifactManifest };
    for (const file of data.manifest.files) {
      const uri = BUSINESS_RESOURCE_PREFIX + 'artifacts/' + encodeURIComponent(artifactId) + '/files/' + encodeURIComponent(file.file_ref);
      const resource = await options.app.readServerResource({ uri });
      const content = resource.contents[0]; if (!content || !('blob' in content)) throw new ContractError('STORAGE_UNAVAILABLE', '成品文件未返回二进制资源');
      const binary = atob(content.blob), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      if (Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') !== file.sha256) throw new ContractError('STORAGE_UNAVAILABLE', '成品文件 hash 与清单不符');
      const result = await options.app.downloadFile({ contents: [{ type: 'resource', resource: { uri, mimeType: content.mimeType, blob: content.blob } }] });
      if (result.isError) throw new ContractError('CAPABILITY_UNSUPPORTED', '宿主未完成文件下载');
    }
  };
  return bridge;
}
