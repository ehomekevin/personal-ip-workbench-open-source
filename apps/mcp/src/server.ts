import { createHash, randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { CAPABILITY_STATUSES, ContractError, ERROR_HTTP, workbenchLocationHash, type PublishingSettingsResponse, type HostCapability, type HostCapabilitiesResponse, type JsonObject, type TopicDetail, type Page, type TopicSummary, type ApiError } from '@workbench/contracts';
import { MCP_TOOL_INVENTORY, WORKBENCH_TOOL_ROUTES, WORKBENCH_RESOURCE_URI, BUSINESS_RESOURCE_PREFIX, OPEN_WORKBENCH_SCHEMA, CONTEXT_SCHEMA, UPLOAD_ASSET_SCHEMA, routeRequest } from '../../../packages/host-bridge/src/core/tools.ts';
import { BoundServiceClient, ServiceRequestError } from './service-client.ts';
import type { WorkbenchConnectionDescriptor } from '../../../plugins/shared/connection.ts';

export const HOST_OPERATIONS = ['ui_resource', 'fullscreen', 'tool_bridge', 'file_upload', 'media_preview', 'download', 'external_link', 'local_service_access', 'native_session_output', 'native_task_tracking'];
export interface McpServerOptions { descriptor: WorkbenchConnectionDescriptor; uiHtml: string; fetcher?: typeof fetch }
export function createWorkbenchMcpServer(options: McpServerOptions): Server {
  const client = new BoundServiceClient(options.descriptor, options.fetcher);
  const server = new Server({ name: 'personal-ip-workbench', title: '个人 IP 工作台', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} }, instructions: '所有操作连接同一工作区主服务。先读取上下文与当前 revision，再编辑；host_session 只提交固定 attempt 的候选，tracking 未验证时拒绝。service_* 是独立委托执行入口，不自动切换。observer 注册与续期不提供给模型。' });
  const envelope = (data: unknown, request_id: string | null = null) => ({ identity: options.descriptor.identity, data, request_id });
  async function capabilities(): Promise<HostCapability[]> {
    const host = options.descriptor.host;
    const query = new URLSearchParams({ host_surface: host.surface, runtime_version: host.runtime_version, connection_mode: host.connection_mode, plugin_version: host.plugin_version });
    let records: HostCapabilitiesResponse['capabilities'] = [];
    try { records = ((await client.request('GET', '/api/v1/host-capabilities?' + query)).data as HostCapabilitiesResponse).capabilities; }
    catch (error) { if (!(error instanceof ServiceRequestError) || error.response.error.code !== 'CAPABILITY_UNVERIFIED') throw error; }
    return HOST_OPERATIONS.map(operation => {
      const candidates = records.filter(item => item.operation === operation && item.host_surface === host.surface && item.runtime_version === host.runtime_version && item.connection_mode === host.connection_mode && item.plugin_version === host.plugin_version).sort((a, b) => b.version - a.version);
      const record = candidates[0];
      if (record && (record.status === 'supported' && (!record.verified_at || !record.evidence_ref) || candidates.some(item => item.version === record.version && item.status !== record.status))) return { operation, status: 'unverified' as const, limitations: ['能力证据缺失或同版本记录冲突'], verified_at: null, evidence_ref: null };
      return record && CAPABILITY_STATUSES.includes(record.status) ? { operation, status: record.status, limitations: record.limitations, verified_at: record.verified_at, evidence_ref: record.evidence_ref }
        : { operation, status: 'unverified', limitations: ['此宿主、版本、连接方式与操作尚无实际验证记录'], verified_at: null, evidence_ref: null };
    });
  }
  async function selected(input: JsonObject): Promise<JsonObject> {
    const result: JsonObject = {}; let topic: TopicDetail | undefined;
    if (input.topic_id) topic = (await client.request('GET', '/api/v1/topics/' + encodeURIComponent(String(input.topic_id)))).data as TopicDetail;
    if (input.variant_id && !topic) {
      let cursor: string | null = null;
      do {
        const page = (await client.request('GET', '/api/v1/topics' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''))).data as Page<TopicSummary>;
        for (const summary of page.items) { const value = (await client.request('GET', '/api/v1/topics/' + encodeURIComponent(summary.id))).data as TopicDetail; if (value.variants.some(item => item.id === input.variant_id)) { topic = value; break; } }
        cursor = topic ? null : page.next_cursor;
      } while (cursor);
    }
    if (input.variant_id) { const variant = topic?.variants.find(item => item.id === input.variant_id); if (!variant) throw new ContractError('NOT_FOUND', '平台版本不属于当前主题或工作区'); result.variant = variant; }
    if (topic) { result.topic_id = topic.id; result.topic = topic as unknown as JsonObject; }
    for (const [key, resource] of [['document_id', 'documents'], ['job_id', 'jobs']] as const) if (input[key]) result[key.replace('_id', '')] = (await client.request('GET', '/api/v1/' + resource + '/' + encodeURIComponent(String(input[key])))).data as JsonObject;
    if (input.source_ids) result.sources = await Promise.all((input.source_ids as string[]).map(async id => (await client.request('GET', '/api/v1/source-records/' + encodeURIComponent(id))).data as JsonObject));
    return result;
  }
  const resourceRoutes: Record<string, string> = { topics: 'get_topic', documents: 'get_document', candidates: 'get_candidate', sources: 'get_source_record', jobs: 'get_job', receipts: 'get_host_receipt', artifacts: 'get_artifact' };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOL_INVENTORY }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      await client.identity();
      const name = request.params.name, input = request.params.arguments ?? {};
      if (name === 'upload_asset') {
        UPLOAD_ASSET_SCHEMA.parse(input);
        if (/[\/\\\x00-\x1f]/.test(String(input.filename)) || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(String(input.mime_type))) throw new ContractError('VALIDATION_ERROR', '上传文件名或媒体类型无效');
        const bytes = Buffer.from(String(input.base64), 'base64');
        if (bytes.length > 4 * 1024 * 1024 || bytes.toString('base64') !== input.base64 || createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new ContractError('VALIDATION_ERROR', '上传文件编码、长度或 hash 不符');
        const form = new FormData(); form.append('file', new Blob([bytes], { type: String(input.mime_type) }), String(input.filename)); form.append('purpose', String(input.purpose)); if (input.topic_id) form.append('topic_id', String(input.topic_id));
        const response = await client.request('POST', '/api/v1/assets', form, String(input.idempotency_key));
        return { structuredContent: envelope(response.data, response.request_id), content: [{ type: 'text', text: JSON.stringify(response.data) }] };
      }
      if (name === 'open_workbench' || name === 'get_context') {
        const location = name === 'open_workbench' ? OPEN_WORKBENCH_SCHEMA.parse(input) : undefined;
        if (!location) CONTEXT_SCHEMA.parse(input);
        if (location?.settings_view === 'publishing' && location.account_id) {
          const settings = (await client.request('GET', '/api/v1/settings/publishing')).data as PublishingSettingsResponse;
          if (!settings.accounts.some(a => a.account_id === location.account_id && a.platform === location.platform)) throw new ContractError('NOT_FOUND', '当前工作区没有此平台发布账号');
        }
        let standalone = options.descriptor.web_url ?? null;
        if (standalone && location) { const url = new URL(standalone); url.searchParams.set('mode', 'real'); url.hash = workbenchLocationHash(location); standalone = url.href; }
        const data = { ...(await selected(input as JsonObject)), ...(location ? { ...location, location, resource_uri: WORKBENCH_RESOURCE_URI } : {}), identity: options.descriptor.identity, capabilities: await capabilities(), host: options.descriptor.host, standalone_url: standalone };
        return { structuredContent: envelope(data), content: [{ type: 'text', text: name === 'open_workbench' ? '已读取共享工作台入口；宿主内可视状态以能力记录为准。' : '已读取当前工作区与所选固定输入。' }], ...(name === 'open_workbench' ? { _meta: { ui: { resourceUri: WORKBENCH_RESOURCE_URI } } } : {}) };
      }
      const route = WORKBENCH_TOOL_ROUTES.find(item => item.name === name);
      if (!route) throw new ContractError('CAPABILITY_UNVERIFIED', '工具未登记', { tool: name });
      const mapped = routeRequest(route, input as JsonObject);
      if (name === 'begin_host_run' || name === 'resume_host_run') {
        const tracking = (await capabilities()).find(capability => capability.operation === 'native_task_tracking')!;
        if (tracking.status !== 'supported') throw new ContractError(tracking.status === 'unsupported' ? 'CAPABILITY_UNSUPPORTED' : 'CAPABILITY_UNVERIFIED', '当前固定宿主版本的原生任务追踪尚未准入', { host_surface: options.descriptor.host.surface, runtime_version: options.descriptor.host.runtime_version, connection_mode: options.descriptor.host.connection_mode });
      }
      if (name === 'resume_host_run' || name === 'resume_service_job') {
        const job = ((await client.request('GET', '/api/v1/jobs/' + encodeURIComponent(String(input.id)))).data as { job: { execution_mode: string } }).job;
        if (job.execution_mode !== route.execution_mode) throw new ContractError('VALIDATION_ERROR', '恢复入口与原任务执行方式不一致');
      }
      const response = await client.request(mapped.method, mapped.path, mapped.body, mapped.idempotencyKey);
      return { structuredContent: envelope(response.data, response.request_id), content: [{ type: 'text', text: JSON.stringify(response.data) }] };
    } catch (error) {
      const api: ApiError = error instanceof ServiceRequestError ? error.response : { error: { code: error instanceof ContractError ? error.code : 'STORAGE_UNAVAILABLE', message: error instanceof ContractError ? error.message : '已绑定主服务暂不可用', details: error instanceof ContractError ? error.details : {}, retryable: error instanceof ContractError ? error.retryable : true, request_id: randomUUID() } };
      return { isError: true, structuredContent: { ...envelope(null, api.error.request_id), error: api.error, status: error instanceof ServiceRequestError ? error.status : ERROR_HTTP[api.error.code] }, content: [{ type: 'text', text: JSON.stringify(api) }] };
    }
  });
  const resource = { uri: WORKBENCH_RESOURCE_URI, name: '个人 IP 工作台', mimeType: RESOURCE_MIME_TYPE, description: '七页面共享 React 工作台。资源可读取不代表宿主已完成可视验收。' };
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [resource] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [
    ...Object.keys(resourceRoutes).map(kind => ({ uriTemplate: BUSINESS_RESOURCE_PREFIX + kind + '/{id}', name: kind, mimeType: 'application/json' })),
    { uriTemplate: BUSINESS_RESOURCE_PREFIX + 'documents/{id}/revisions/{revision_id}', name: '固定文稿修订', mimeType: 'application/json' },
    { uriTemplate: BUSINESS_RESOURCE_PREFIX + 'assets/{id}/content', name: '已登记媒体素材', mimeType: 'application/octet-stream' },
    { uriTemplate: BUSINESS_RESOURCE_PREFIX + 'artifacts/{id}/files/{file_ref}', name: '成品清单文件', mimeType: 'application/octet-stream' },
  ] }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    try {
    await client.identity(); const uri = request.params.uri;
    if (uri === WORKBENCH_RESOURCE_URI) return { contents: [{ ...resource, text: options.uiHtml, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false }, 'workbench/ui_sha256': createHash('sha256').update(options.uiHtml).digest('hex') } }] };
    if (!uri.startsWith(BUSINESS_RESOURCE_PREFIX)) throw new ContractError('VALIDATION_ERROR', '资源未登记');
    const path = uri.slice(BUSINESS_RESOURCE_PREFIX.length);
    if (/[?#\\]/.test(path)) throw new ContractError('VALIDATION_ERROR', '资源地址不允许额外查询或路径');
    const parts = path.split('/').map(part => decodeURIComponent(part));
    if (parts.some(part => !part || /[\/\\\x00-\x1f]/.test(part) || part === '.' || part === '..')) throw new ContractError('VALIDATION_ERROR', '资源实体身份无效');
    if (parts[0] === 'assets' && parts.length === 3 && parts[2] === 'content' || parts[0] === 'artifacts' && parts.length === 4 && parts[2] === 'files') {
      const value = await client.content('/api/v1/' + parts.map(encodeURIComponent).join('/')); return { contents: [{ uri, mimeType: value.mimeType, blob: value.blob, _meta: { sha256: value.sha256 } }] };
    }
    let name = parts.length === 2 ? resourceRoutes[parts[0]!] : undefined;
    if (parts[0] === 'documents' && parts.length === 4 && parts[2] === 'revisions') name = 'get_revision';
    const route = WORKBENCH_TOOL_ROUTES.find(item => item.name === name); if (!route) throw new ContractError('VALIDATION_ERROR', '资源路径未登记');
    const mapped = routeRequest(route, { id: parts[1]!, ...(name === 'get_revision' ? { revision_id: parts[3]! } : {}) });
    const value = await client.request('GET', mapped.path); return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(envelope(value.data, value.request_id)) }] };
    } catch (error) {
      const api: ApiError = error instanceof ServiceRequestError ? error.response : { error: { code: error instanceof ContractError ? error.code : 'STORAGE_UNAVAILABLE', message: error instanceof ContractError ? error.message : '已绑定资源暂不可用', retryable: error instanceof ContractError ? error.retryable : true, details: error instanceof ContractError ? error.details : {}, request_id: randomUUID() } };
      throw new McpError(ErrorCode.InvalidParams, api.error.message, { ...api, status: error instanceof ServiceRequestError ? error.status : ERROR_HTTP[api.error.code] });
    }
  });
  return server;
}
