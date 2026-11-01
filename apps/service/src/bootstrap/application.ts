import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CONTRACT_VERSION, ERROR_HTTP, ContractError, type ApiError, type ServiceConfiguration, type ServiceIdentity, type RequestContext, type ExecutorHealth, type WorkspacePaths } from '@workbench/contracts';
import type { ApplicationContext, ApplicationModule, ModuleFactory } from '@workbench/domain/ports';
import { openWorkspaceStorage, transaction, assertStorageRoot, type WorkspaceStorage } from '@workbench/storage/connection';
import { createConfiguredDirectories, validateConfiguration } from './config.ts';
import { acquireServiceLock } from './lock.ts';
import { createRouteRegistry } from '../routes/index.ts';
import { executorHealth } from './execution.ts';
import { DEFAULT_MODULE_FACTORIES } from './modules.ts';
export interface RunningApplication { identity: ServiceIdentity; boot_id: string; context: ApplicationContext; server: Server; address: { host: string; port: number }; close(): Promise<void> }
async function closeApplicationResources(server: Server | undefined, modules: ApplicationModule[], storage: WorkspaceStorage | undefined, releaseLock: () => void): Promise<void> {
  const errors: unknown[] = [];
  // Signal owned work before waiting for active HTTP connections to finish.
  for (const module of modules) try { module.beginClose?.(); } catch (error) { errors.push(error); }
  if (server?.listening) try { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); } catch (error) { errors.push(error); }
  for (const module of modules) try { await module.close?.(); } catch (error) { errors.push(error); }
  try { storage?.close(); } catch (error) { errors.push(error); }
  try { releaseLock(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, '主服务资源清理未全部成功');
}
const DEFAULT_JSON_LIMIT = 8 * 1024 * 1024;
async function readJson(request: IncomingMessage, limit = DEFAULT_JSON_LIMIT): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > limit) throw new ContractError('VALIDATION_ERROR', 'JSON 请求超过大小限制'); chunks.push(buffer); }
  if (!size) return {};
  const type = request.headers['content-type']; if (!type?.startsWith('application/json')) throw new ContractError('VALIDATION_ERROR', '请求必须使用 application/json');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ContractError('VALIDATION_ERROR', 'JSON 请求无法解析'); }
}
function initializeIdentity(storage: WorkspaceStorage, config: ServiceConfiguration): ServiceConfiguration {
  return transaction(storage.db, () => {
    const saved = storage.db.prepare('SELECT value FROM application_metadata WHERE key=?').get('service_instance_id');
    if (saved && saved.value !== config.service_instance_id) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '配置与数据库主服务身份不符');
    const workspaceIds = storage.db.prepare('SELECT id FROM workspaces').all();
    if (workspaceIds.some(row => row.id !== config.workspace_id)) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '当前数据库已绑定另一工作区');
    const row = storage.db.prepare('SELECT * FROM workspaces WHERE id=?').get(config.workspace_id);
    if (!row) storage.db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version,default_executor,api_fallback_enabled) VALUES (?,?,?,?,?,?,?,?,?)').run(config.workspace_id, config.workspace_id, config.title, config.timezone, JSON.stringify(config.paths), config.mode, 1, config.default_executor ?? 'codex', Number(config.api_fallback_enabled ?? false));
    if (!saved) storage.db.prepare('INSERT INTO application_metadata VALUES (?,?)').run('service_instance_id', config.service_instance_id);
    const persisted = storage.db.prepare('SELECT * FROM workspaces WHERE id=?').get(config.workspace_id)!;
    const paths = JSON.parse(String(persisted.paths)) as WorkspacePaths;
    if (paths.state_root !== config.paths.state_root || persisted.mode !== config.mode) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '配置与持久主存路径或模式不符');
    return { ...config, title: String(persisted.title), timezone: String(persisted.timezone), paths, default_executor: persisted.default_executor as 'codex' | 'claude', api_fallback_enabled: Boolean(persisted.api_fallback_enabled) };
  });
}
export async function startApplication(input: ServiceConfiguration, options: { moduleFactories?: ModuleFactory[]; port?: number; executorHealth?: () => Promise<ExecutorHealth[]> } = {}): Promise<RunningApplication> {
  let config = validateConfiguration(input); createConfiguredDirectories(config);
  const identity: ServiceIdentity = { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION }; const bootId = randomUUID();
  const releaseLock = acquireServiceLock(config.paths.state_root, identity, bootId);
  let storage: WorkspaceStorage | undefined; let server: Server | undefined; let modules: ApplicationModule[] = [];
  try {
    storage = openWorkspaceStorage(join(config.paths.state_root, 'workbench.sqlite')); config = validateConfiguration(initializeIdentity(storage, config)); createConfiguredDirectories(config);
    const context: ApplicationContext = { db: storage.db, identity, config, paths: config.paths, getExecutorHealth: options.executorHealth ?? executorHealth(identity.workspace_id,config.paths.state_root) };
    modules = (options.moduleFactories ?? DEFAULT_MODULE_FACTORIES).map(factory => factory(context));
    for (const module of modules) await module.initialize?.();
    const registry = createRouteRegistry(modules);
    server = createServer(async (request, response) => {
      const cancellation = new AbortController();
      const disconnected = () => { if (!response.writableFinished) cancellation.abort(new Error('Own HTTP request disconnected; original result unknown')); };
      request.once('aborted', disconnected); response.once('close', disconnected);
      if (request.aborted || response.destroyed) disconnected();
      const requestId = randomUUID(); response.setHeader('x-request-id', requestId); response.setHeader('content-type', 'application/json; charset=utf-8');
      const send = (status: number, body: unknown): void => { response.statusCode = status; response.end(JSON.stringify(body)); };
      try {
        const origin = request.headers.origin;
        if (origin) { let parsed: URL; try { parsed = new URL(origin); } catch { throw new ContractError('VALIDATION_ERROR', 'Origin 无效'); } if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !['http:', 'https:'].includes(parsed.protocol)) throw new ContractError('VALIDATION_ERROR', '只允许本机工作台 Origin'); response.setHeader('access-control-allow-origin', origin); response.setHeader('vary', 'Origin'); }
        if (request.method === 'OPTIONS') { response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS'); response.setHeader('access-control-allow-headers', 'content-type,x-workspace-id,x-service-instance-id,x-request-id,idempotency-key'); send(204, null); return; }
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (request.method === 'GET' && url.pathname === '/health') { send(200, { identity, boot_id: bootId, schema_version: storage!.migration.to_version, status: 'ready', modules: await Promise.all(modules.map(module => module.health())) }); return; }
        if (request.method === 'GET' && url.pathname === '/api/v1/identity') { send(200, identity); return; }
        const route = registry.routes.find(route => route.definition.method === request.method && route.pattern.test(url.pathname));
        if (!route) throw new ContractError('NOT_FOUND', '资源不存在');
        const mutates = route.definition.method !== 'GET' || route.definition.mutation === true;
        const workspace = request.headers['x-workspace-id']; const service = request.headers['x-service-instance-id'];
        if (workspace !== identity.workspace_id || (mutates && service !== identity.service_instance_id) || (service !== undefined && service !== identity.service_instance_id)) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '请求工作区或主服务身份不符');
        if (mutates) assertStorageRoot(config.paths.state_root);
        const idempotency = request.headers['idempotency-key']; if (Array.isArray(idempotency)) throw new ContractError('VALIDATION_ERROR', 'Idempotency-Key 必须是单一值');
        if (route.definition.idempotent && (!idempotency || idempotency.length > 200)) throw new ContractError('VALIDATION_ERROR', '缺少有效 Idempotency-Key', { field: 'Idempotency-Key' });
        const match = route.pattern.exec(url.pathname)!; const params: Record<string, string> = {}; route.params.forEach((key, index) => { params[key] = decodeURIComponent(match[index + 1]!); });
        const format = route.definition.bodyFormat ?? (route.definition.method === 'GET' ? 'none' : 'json');
        const body = format === 'json' ? await readJson(request, route.definition.maxJsonBytes) : undefined;
        const headers: Record<string, string | undefined> = {}; for (const [key, value] of Object.entries(request.headers)) headers[key] = Array.isArray(value) ? value.join(',') : value;
        const requestContext: RequestContext = { ...identity, request_id: requestId, idempotency_key: idempotency ?? null, request_identity_ref: null };
        const result = await route.definition.handle({ signal: cancellation.signal, context: requestContext, params, query: url.searchParams, body: route.definition.schema ? route.definition.schema.parse(body) : body, headers, ...(format === 'stream' ? { stream: request } : {}) });
        if (result.headers) for (const [key, value] of Object.entries(result.headers)) response.setHeader(key, value);
        if (result.stream) { response.statusCode = result.status ?? 200; for await (const chunk of result.stream) { if (!response.write(chunk)) await new Promise<void>(resolve => response.once('drain', resolve)); } response.end(); }
        else send(result.status ?? 200, result.body);
      } catch (error) {
        const contract = error instanceof ContractError ? error : new ContractError('STORAGE_UNAVAILABLE', '服务操作未完成，请查看本机日志', {}, true);
        if (response.headersSent) { response.destroy(); return; }
        const body: ApiError = { error: { code: contract.code, message: contract.message, retryable: contract.retryable, details: contract.details, request_id: requestId } }; send(ERROR_HTTP[contract.code], body);
      } finally { request.removeListener('aborted', disconnected); response.removeListener('close', disconnected); }
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(options.port ?? config.listen.port, config.listen.host, resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const appServer = server; const appStorage = storage;
    let closing: Promise<void> | undefined;
    return { identity, boot_id: bootId, context, server: appServer, address: { host: address.address, port: address.port }, close() { return closing ??= closeApplicationResources(appServer, modules, appStorage, releaseLock); } };
  } catch (error) {
    try { await closeApplicationResources(server, modules, storage, releaseLock); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], '主服务启动失败，清理包含错误'); }
    throw error;
  }
}
