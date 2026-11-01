import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, ContractError, type ApiError, type ServiceIdentity } from '@workbench/contracts';
import type { WorkbenchConnectionDescriptor } from '../../../plugins/shared/connection.ts';

export class ServiceRequestError extends Error {
  readonly status: number; readonly response: ApiError;
  constructor(status: number, response: ApiError) { super(response.error.message); this.status = status; this.response = response; }
}
export function assertSameIdentity(actual: ServiceIdentity, expected: ServiceIdentity): void {
  if (actual.contract_version !== CONTRACT_VERSION || actual.contract_version !== expected.contract_version || actual.workspace_id !== expected.workspace_id || actual.service_instance_id !== expected.service_instance_id)
    throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '连接主服务、工作区或契约版本与固定描述不一致');
}
export class BoundServiceClient {
  readonly descriptor: WorkbenchConnectionDescriptor;
  private readonly fetcher: typeof fetch;
  constructor(descriptor: WorkbenchConnectionDescriptor, fetcher: typeof fetch = fetch) { this.descriptor = descriptor; this.fetcher = fetcher; }
  private headers(includeCredential = true): Record<string, string> {
    const { identity, host, connection_credential } = this.descriptor;
    return {
      'X-Workspace-Id': identity.workspace_id, 'X-Service-Instance-Id': identity.service_instance_id, 'X-Request-Id': randomUUID(),
      'X-Host-Surface': host.surface, 'X-Host-Runtime-Version': host.runtime_version,
      'X-Host-Connection-Mode': host.connection_mode, 'X-Host-Plugin-Version': host.plugin_version,
      ...(includeCredential && connection_credential ? { 'X-Host-Connection-Credential': connection_credential } : {}),
    };
  }
  async identity(): Promise<ServiceIdentity> {
    // 端口可能已被别的服务接管；验证固定身份之前绝不发送私有连接凭据。
    const response = await this.fetcher(this.descriptor.base_url + '/api/v1/identity', { headers: this.headers(false), redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new ContractError('STORAGE_UNAVAILABLE', '无法读取已绑定主服务身份', {}, true);
    const identity = await response.json() as ServiceIdentity; assertSameIdentity(identity, this.descriptor.identity); return identity;
  }
  async request(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<{ data: unknown; request_id: string | null }> {
    // 不缓存一次握手；服务重启或端口被另一工作区复用时立即拒绝。
    await this.identity();
    const headers = this.headers();
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (!(body instanceof FormData) && body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.fetcher(this.descriptor.base_url + path, { method, headers, redirect: 'error', body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) { const value = await response.json() as ApiError; throw new ServiceRequestError(response.status, value); }
    return { data: await response.json(), request_id: response.headers.get('x-request-id') };
  }
  async content(path: string): Promise<{ mimeType: string; blob: string; sha256: string }> {
    await this.identity();
    const response = await this.fetcher(this.descriptor.base_url + path, { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new ServiceRequestError(response.status, await response.json() as ApiError);
    const size = Number(response.headers.get('content-length') ?? 0);
    if (size > 8 * 1024 * 1024) throw new ContractError('VALIDATION_ERROR', '媒体资源超过 MCP 内联传输上限');
    const chunks: Uint8Array[] = []; let total = 0;
    for await (const chunk of response.body!) { total += chunk.byteLength; if (total > 8 * 1024 * 1024) throw new ContractError('VALIDATION_ERROR', '媒体资源超过 MCP 内联传输上限'); chunks.push(chunk); }
    const buffer = Buffer.concat(chunks); const { createHash } = await import('node:crypto');
    return { mimeType: response.headers.get('content-type') ?? 'application/octet-stream', blob: buffer.toString('base64'), sha256: createHash('sha256').update(buffer).digest('hex') };
  }
}
