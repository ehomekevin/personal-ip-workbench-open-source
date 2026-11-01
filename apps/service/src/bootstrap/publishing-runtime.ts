import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ContractError, PUBLISHING_ROUTE_PLATFORMS, type ContentFormat, type PublishingCredentialReference, type PublishingRoute } from '@workbench/contracts';
import { sha256 } from '@workbench/storage/connection';
import type { ApplicationContext } from '@workbench/domain/ports';
import type { LegacyPublishingImport, PublishingRuntime, PublishingRuntimeSnapshot, PublishingRuntimeCandidate, PublishingReadonlyResult } from '@workbench/domain/publishing-settings';
import { createXPublisher, X_PUBLISHER_VERSION, fetchPublisherTransport, type AccountCapability, type PublisherOptions, type PublisherTransport } from '@workbench/adapters/publishers/x';
import { createWechatPublisher, WECHAT_PUBLISHER_VERSION } from '@workbench/adapters/publishers/wechat';
import { createDouyinPublisher, DOUYIN_PUBLISHER_VERSION } from '@workbench/adapters/publishers/douyin';
import { parseLegacyPublisherBindings } from './publishers.ts';
import { configuredWechatChannel, WECHAT_LOCAL_REFERENCE, WECHAT_AUTH_LIMITS } from './wechat/channel.ts';
import {readLocalCredential} from './configuration/credentials.ts';

const routes = {
  x_v2: { platform: 'x', version: X_PUBLISHER_VERSION, formats: ['text', 'thread'], create: createXPublisher },
  wechat_official: { platform: 'wechat', version: WECHAT_PUBLISHER_VERSION, formats: ['article'], create: createWechatPublisher },
  douyin_open: { platform: 'douyin', version: DOUYIN_PUBLISHER_VERSION, formats: ['short_video'], create: createDouyinPublisher },
} as const;
const envName = /^[A-Z][A-Z0-9_]{0,127}$/;
export interface PublishingRuntimeOptions { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch }

// POST 中也有平台只读查询；按固定操作分类，在每一次实际网络写入前核对连接。
export function guardPublishingTransport(base: PublisherTransport, snapshot: PublishingRuntimeSnapshot, format: ContentFormat): PublisherTransport {
  const writeOperations: Record<string, 'prepareDraft' | 'submit'> = snapshot.route === 'x_v2' ? { create_post: 'submit' }
    : snapshot.route === 'wechat_official' ? { 'material/add_material?type=image': 'prepareDraft', 'media/uploadimg': 'prepareDraft', 'draft/add': 'prepareDraft', 'freepublish/submit': 'submit' }
    : { upload_video: 'prepareDraft', create_video: 'submit' };
  const reads = snapshot.route === 'x_v2' ? ['lookup_post'] : snapshot.route === 'wechat_official' ? ['draft/get', 'freepublish/get'] : ['video_basic_info'];
  return { evidence_kind: base.evidence_kind, request(request) {
    const writing = Object.hasOwn(writeOperations, request.operation) ? writeOperations[request.operation] : undefined;
    if (writing) {
      if (request.method !== 'POST' || !snapshot.beforeExternalWrite) throw new ContractError('CAPABILITY_UNVERIFIED', '发布请求缺少当前连接门控');
      snapshot.beforeExternalWrite(format, writing);
    } else if (!reads.includes(request.operation) || request.method !== (snapshot.route === 'x_v2' ? 'GET' : 'POST')) {
      throw new ContractError('CAPABILITY_UNSUPPORTED', '平台请求操作尚未登记');
    }
    return base.request(request);
  } };
}

// 固定允许集合及私有值快照。GET 不访问环境，apply 也不能扩大允许集合。
export function createPublishingRuntime(context: ApplicationContext, options: PublishingRuntimeOptions = {}): PublishingRuntime {
  const env = options.env ?? process.env, raw = env.WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON;
  let names: unknown = [];
  if (raw !== undefined) { try { names = JSON.parse(raw); } catch { throw new ContractError('VALIDATION_ERROR', '发布凭据引用名单不是有效 JSON'); } }
  if (!Array.isArray(names) || names.length > 50 || names.some(n => typeof n !== 'string' || !envName.test(n)) || new Set(names).size !== names.length) {
    throw new ContractError('VALIDATION_ERROR', '发布凭据引用名单须为不重复的环境名称数组');
  }
  const localReferences:Record<string,'x'|'douyin'>=env.WORKBENCH_LOCAL_SETTINGS_ENABLED==='1'?{WORKBENCH_X_CREDENTIALS:'x',WORKBENCH_DOUYIN_CREDENTIALS:'douyin'}:{};
  names=[...new Set([...(names as string[]),...Object.keys(localReferences)])];
  const values = new Map<string, string | null>();
  for (const name of names as string[]) { const value = localReferences[name]?undefined:env[name]?.trim(); values.set(name, value && value.length <= 16384 && !/[\r\n\x00]/.test(value) ? value : null); }
  const references = Object.freeze((names as string[]).map(name => Object.freeze({ kind: 'environment' as const, name })));
  const wechat = values.has(WECHAT_LOCAL_REFERENCE) ? configuredWechatChannel(context, env, options.fetcher ? { fetcher: options.fetcher } : undefined) : undefined;
  const token = (ref: PublishingCredentialReference | null,accountId?:string): string | null => {
    if(ref?.kind!=='environment'||ref.name===WECHAT_LOCAL_REFERENCE)return null;
    const kind=localReferences[ref.name];if(kind){try{return readLocalCredential(context.paths.state_root,kind,accountId,context.identity.workspace_id);}catch{return null;}}
    return values.get(ref.name)??null;
  };
  const hostId = 'application-service:' + context.identity.service_instance_id;
  const scope = (route: PublishingRoute) => ({ adapter_version: routes[route].version, host_id: hostId });
  const build = (snapshot: PublishingRuntimeSnapshot): PublishingRuntimeCandidate => {
    const factory = routes[snapshot.route], current = scope(snapshot.route);
    if (snapshot.workspace_id !== context.identity.workspace_id || snapshot.platform !== PUBLISHING_ROUTE_PLATFORMS[snapshot.route]) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '发布候选范围与当前服务不符');
    const row = context.db.prepare('SELECT platform,platform_account_id,role,identity_status FROM accounts WHERE workspace_id=? AND id=?').get(snapshot.workspace_id, snapshot.account_id);
    if (!row || row.platform !== snapshot.platform || row.platform_account_id !== snapshot.platform_account_id || row.role !== 'owner' || row.identity_status !== 'confirmed') throw new ContractError('CAPABILITY_UNVERIFIED', '发布账号身份需要重新核对');
    if (!snapshot.credential_ref || !values.has(snapshot.credential_ref.name)) throw new ContractError('AUTH_REQUIRED', '请先选择已登记的发布凭据引用');
    const localWechat = snapshot.credential_ref.name === WECHAT_LOCAL_REFERENCE;
    if (localWechat && snapshot.route !== 'wechat_official') throw new ContractError('CAPABILITY_UNSUPPORTED', '公众号凭据引用不能用于其他平台');
    if (localWechat) wechat?.assertBinding(snapshot.account_id, snapshot.platform_account_id);
    const localKind=localReferences[snapshot.credential_ref.name];if(localKind&&localKind!==snapshot.platform)throw new ContractError('CAPABILITY_UNSUPPORTED','发布凭据类型与平台不符');
    const accessToken = localWechat ? null : token(snapshot.credential_ref,snapshot.account_id);
    if (localWechat ? !wechat?.ready() : !accessToken) throw new ContractError('AUTH_REQUIRED', '所选发布凭据尚未就绪，请核对同账号配置');
    const bindings = factory.formats.map(format => {
      const capabilities: AccountCapability[] = ['prepareDraft', 'submit', 'queryResult'].map(operation => {
        const c = snapshot.capabilities.find(c => c.format === format && c.operation === operation && c.host_id === current.host_id && c.adapter_version === current.adapter_version);
        const supported = c?.status === 'supported' && c.evidence_kind === 'real_platform' && !!c.evidence_ref && !!c.verified_at;
        return { account_id: snapshot.account_id, platform: snapshot.platform, format, ...current, operation: operation as AccountCapability['operation'], status: supported ? 'supported' : c?.status === 'unsupported' ? 'unsupported' : 'unverified', evidence_kind: 'real_platform', evidence_ref: supported ? c!.evidence_ref : null, verified_at: supported ? c!.verified_at : null };
      });
      const credentials: NonNullable<PublisherOptions['credentials']> = localWechat ? () => wechat!.credentials(snapshot.account_id, snapshot.platform_account_id) : () => {const currentToken=token(snapshot.credential_ref,snapshot.account_id);return currentToken?{access_token:currentToken}:null;};
      const transport = localWechat ? wechat!.transport(snapshot.account_id, snapshot.platform_account_id) : fetchPublisherTransport(optionsFetch);
      const options: PublisherOptions = { account: { account_id: snapshot.account_id, platform_account_id: snapshot.platform_account_id, format, host_id: current.host_id, identity_evidence_ref: 'sqlite-account:' + snapshot.account_id }, capabilities, evidence_kind: 'real_platform', credentials, transport: guardPublishingTransport(transport, snapshot, format), paths: { managed_notes_root: context.paths.managed_notes_root, media_root: context.paths.media_root, state_root: join(context.paths.state_root, 'raw-responses') } };
      return { account_id: snapshot.account_id, platform: snapshot.platform, format, adapter: factory.create(options), evidence_kind: 'real_platform' as const, supported: capabilities.every(c => c.status === 'supported') };
    });
    return { ...current, bindings };
  };
  const optionsFetch = options.fetcher ?? fetch;
  return {
    credentialReferences: references, credentialReady: (ref,accountId) => ref?.name === WECHAT_LOCAL_REFERENCE ? !!wechat?.ready() : token(ref,accountId) !== null, scope, hydrate: build, build,
    async check(snapshot): Promise<PublishingReadonlyResult> {
      if (snapshot.credential_ref?.name === WECHAT_LOCAL_REFERENCE) return snapshot.route === 'wechat_official' && wechat ? wechat.check(snapshot.account_id, snapshot.platform_account_id) : { identity: 'failed', permissions: 'unavailable', reachability: 'unavailable', limitations: [WECHAT_AUTH_LIMITS.mismatch] };
      const accessToken = token(snapshot.credential_ref,snapshot.account_id);
      if (!accessToken) return { identity: 'unavailable', permissions: 'unavailable', reachability: 'unavailable', limitations: ['凭据未就绪；请配置已登记引用并重启服务。'] };
      if (snapshot.route !== 'x_v2') return { identity: 'unavailable', permissions: 'unavailable', reachability: 'unavailable', limitations: ['当前连接尚未实现身份与权限的只读诊断路线；配置生效不代表发布能力已验证。'] };
      // 官方用户上下文身份查询；禁止重定向、token refresh、草稿、媒体及提交。
      try {
        const response = await optionsFetch('https://api.x.com/2/users/me', { method: 'GET', headers: { Authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(10000), redirect: 'error' });
        // 实际诊断已受额度或服务错误阻断；未实现路线的 unavailable 不走此分支。
        if (!response.ok) return { identity: [401, 403].includes(response.status) ? 'failed' : 'unavailable', permissions: [401, 403].includes(response.status) ? 'failed' : 'unavailable', reachability: [401, 403].includes(response.status) ? 'passed' : 'failed', limitations: [[401, 403].includes(response.status) ? '平台拒绝身份查询；请核对用户凭据及读取权限。' : response.status === 429 ? '平台请求额度受限，请稍后重新检查。' : '平台未返回可核对的身份；请稍后重新检查。', '身份查询不验证提交权限。'] };
        const reader = response.body?.getReader(); let body = '', size = 0;
        if (!reader) throw new Error('empty_response');
        try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) throw new Error('response_too_large'); body += Buffer.from(part.value).toString('utf8'); } } finally { await reader.cancel(); }
        const payload = JSON.parse(body) as { data?: { id?: unknown } }, matched = payload?.data?.id === snapshot.platform_account_id;
        return { identity: matched ? 'passed' : 'failed', permissions: 'unavailable', reachability: 'passed', limitations: [matched ? '用户身份已核对；发布、线程和结果查询仍需分别验证。' : '凭据返回的用户与所选本人账号不符；请核对配置。', '只读身份查询无法证明提交权限。'] };
      } catch { return { identity: 'unavailable', permissions: 'unavailable', reachability: 'failed', limitations: ['身份检查未完成；请核对网络和凭据后重试。'] }; }
    },
  };
}

export function readLegacyPublishingImport(context: ApplicationContext, runtime: PublishingRuntime, env: NodeJS.ProcessEnv = process.env): LegacyPublishingImport | undefined {
  if (env.WORKBENCH_PUBLISHERS_IMPORT_LEGACY !== '1') return undefined;
  const path = env.WORKBENCH_PUBLISHERS_CONFIG_PATH;
  if (!path || !isAbsolute(path)) throw new ContractError('VALIDATION_ERROR', '显式导入需要绝对发布配置路径');
  let bytes: Buffer;
  try { const info = statSync(path); if (!info.isFile() || info.size > 256 * 1024) throw new Error('invalid_file'); bytes = readFileSync(path); if (bytes.length > 256 * 1024) throw new Error('invalid_size'); }
  catch { throw new ContractError('VALIDATION_ERROR', '无法读取旧发布配置'); }
  // 沿用旧字段/身份/版本/格式校验，仅构造未激活对象，不调用平台或读取 token。
  let legacy: unknown;
  try { legacy = JSON.parse(bytes.toString('utf8')); } catch { throw new ContractError('VALIDATION_ERROR', '旧发布配置不是有效 JSON'); }
  parseLegacyPublisherBindings(context, legacy);
  const parsed = legacy as { publishers: { platform: 'x' | 'wechat' | 'douyin'; credential_env: string; account: { account_id: string; format: string }; capabilities: { operation: string; status: string; evidence_kind: string }[] }[] };
  const byAccount = new Map<string, LegacyPublishingImport['connections'][number]>();
  const allowed = new Set(runtime.credentialReferences.map(ref => ref.name));
  const platformRoutes = { x: 'x_v2', wechat: 'wechat_official', douyin: 'douyin_open' } as const;
  for (const entry of parsed.publishers) {
    if (!envName.test(entry.credential_env) || !allowed.has(entry.credential_env)) throw new ContractError('VALIDATION_ERROR', '旧配置引用未登记，请先配置发布引用名单');
    const route = platformRoutes[entry.platform], key = entry.platform + ':' + entry.account.account_id, old = byAccount.get(key);
    if (old && (old.route !== route || old.credential_ref?.name !== entry.credential_env)) throw new ContractError('VALIDATION_ERROR', '同账号的旧格式配置引用不一致');
    byAccount.set(key, { account_id: entry.account.account_id, platform: entry.platform, route, credential_ref: { kind: 'environment', name: entry.credential_env } });
  }
  return { sha256: sha256(bytes), connections: [...byAccount.values()], diagnosticClaims: parsed.publishers.map(entry => ({ platform: entry.platform, account_id: entry.account.account_id, format: entry.account.format, capabilities: entry.capabilities.map(c => ({ operation: c.operation, status: c.status, evidence_kind: c.evidence_kind })) })) };
}
