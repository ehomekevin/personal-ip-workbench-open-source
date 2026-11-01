import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { ProxyAgent, Pool, buildConnector, fetch as undiciFetch } from 'undici';
import { ContractError } from '@workbench/contracts';
import type { ApplicationContext } from '@workbench/domain/ports';
import type { ResolvedAccount } from '@workbench/adapters/tikhub';
import type { PublisherTransport, PublisherRequest, PublisherResponse } from '@workbench/adapters/publishers/x';
import { assertPublicProxyHost, checkedProxyLookup, type ProxyNetworkOptions } from './proxy-network.ts';
import { wechatImageMultipart } from './multipart.ts';
import { WechatMpError } from './errors.ts';
import { startSshRelay, relayConnector, validateRelay, type SshRelay } from './ssh-relay.ts';

export const WECHAT_LOCAL_REFERENCE = 'WORKBENCH_WECHAT_CREDENTIALS';
export const WECHAT_AUTH_LIMITS = {
  connected: '公众号 AppID 认证与代理已连通；草稿、上传和公开发布权限仍需分别验证。',
  mismatch: '公众号凭据绑定与所选账号不符，请核对同账号配置。',
  auth: '公众号 AppID 或 AppSecret 认证失败，请核对同账号配置。',
  whitelist: '公众号出口 IP 未获允许，请核对固定代理与平台白名单。',
  rate: '公众号认证请求受限，请稍后重试。',
  network: '公众号认证未完成，请核对代理网络和凭据后重试。',
} as const;
interface PrivateConfig {
  schema_version: 1; workspace_id: string; account_id: string; canonical_url: string;
  app_id: string; app_secret: string; proxy: { address: string; username: string; password: string };
  relay?: SshRelay;
}
interface Loaded { config: PrivateConfig; revision: string }
interface Token { access_token: string; expires_at: number; revision: string }
export interface WechatChannelOptions extends ProxyNetworkOptions { fetcher?: typeof fetch; clock?: () => number; requestCa?: string; proxyCa?: string }
const channels = new WeakMap<ApplicationContext, { path: string; channel: WechatChannel }>();
const authEndpoint = 'https://api.weixin.qq.com/cgi-bin/stable_token';

export function configuredWechatChannel(context: ApplicationContext, env: NodeJS.ProcessEnv = process.env, options?: WechatChannelOptions): WechatChannel | undefined {
  let names: unknown; try { names = JSON.parse(env.WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON ?? '[]'); } catch { return undefined; }
  if (!Array.isArray(names) || !names.includes(WECHAT_LOCAL_REFERENCE)) return undefined;
  const path = env[WECHAT_LOCAL_REFERENCE]; if (!path) return undefined;
  if (options) return new WechatChannel(context, path, options);
  const cached = channels.get(context); if (cached?.path === path) return cached.channel;
  const channel = new WechatChannel(context, path); channels.set(context, { path, channel }); return channel;
}

// 文件引用由服务启动时的允许名单提供；请求不接收路径或秘密值。
export class WechatChannel {
  readonly context: Pick<ApplicationContext, 'identity' | 'paths'>;
  readonly path: string;
  readonly options: WechatChannelOptions;
  private cached?: Token;
  private pending?: { revision: string; task: Promise<Token> };
  constructor(context: Pick<ApplicationContext, 'identity' | 'paths'>, path: string, options: WechatChannelOptions = {}) { this.context = context; this.path = path; this.options = options; }
  private load(): Loaded {
    const directory = join(realpathSync(this.context.paths.state_root), 'private-credentials');
    if (resolve(this.path) !== join(directory, 'wechat.json')) throw new ContractError('AUTH_REQUIRED', '公众号私有配置路径无效');
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync(directory) !== directory || (dir.mode & 0o077) !== 0) throw new ContractError('AUTH_REQUIRED', '公众号私有目录权限无效');
    let fd: number | undefined;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size < 1 || info.size > 16384) throw new Error();
      const raw = readFileSync(fd), c = JSON.parse(raw.toString('utf8')) as PrivateConfig;
      if (c.schema_version !== 1 || c.workspace_id !== this.context.identity.workspace_id || typeof c.account_id !== 'string' || !c.account_id
        || typeof c.canonical_url !== 'string' || !c.canonical_url || !/^wx[a-f0-9]{16}$/.test(c.app_id) || !/^[A-Za-z0-9]{16,128}$/.test(c.app_secret)
        || !c.proxy || typeof c.proxy.address !== 'string' || typeof c.proxy.username !== 'string' || !c.proxy.username || c.proxy.username.includes(':')
        || typeof c.proxy.password !== 'string' || !c.proxy.password || /[\r\n\x00]/.test(c.proxy.username + c.proxy.password)) throw new Error();
      const url = new URL(c.proxy.address);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      assertPublicProxyHost(url.hostname, this.options.testOnlyAllowLoopback);
      if (c.relay) validateRelay(c.relay, url);
      return { config: c, revision: createHash('sha256').update(raw).digest('hex') };
    } catch { throw new ContractError('AUTH_REQUIRED', '公众号私有配置不可用，请核对文件权限与同账号配置'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  ready(): boolean { try { this.load(); return true; } catch { return false; } }
  private bound(accountId: string, appId?: string, url?: string): Loaded {
    const loaded = this.load(), c = loaded.config;
    if (c.account_id !== accountId || appId !== undefined && c.app_id !== appId || url !== undefined && c.canonical_url !== url) throw new ContractError('CAPABILITY_UNVERIFIED', WECHAT_AUTH_LIMITS.mismatch);
    return loaded;
  }
  assertBinding(accountId: string, appId: string): void { this.bound(accountId, appId); }
  private async send(loaded: Loaded, url: string, init: RequestInit): Promise<PublisherResponse> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'api.weixin.qq.com' || target.port || target.username || target.password) throw new WechatMpError('network');
    const proxy = loaded.config.proxy, proxyHost = new URL(proxy.address).hostname;
    const relay = loaded.config.relay ? await startSshRelay(join(realpathSync(this.context.paths.state_root), 'private-credentials'), loaded.config.relay, new URL(proxy.address)) : undefined;
    const proxyTls = { rejectUnauthorized: true, ...(this.options.proxyCa ? { ca: this.options.proxyCa } : {}) };
    const connector = buildConnector({ ...proxyTls, lookup: checkedProxyLookup(this.options) });
    const agent = new ProxyAgent({ uri: proxy.address, token: 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64'),
      requestTls: { rejectUnauthorized: true, ...(this.options.requestCa ? { ca: this.options.requestCa } : {}) }, proxyTls,
      clientFactory: origin => new Pool(origin, { connect: (opts, done) => relay ? relayConnector(relay.path, done) : connector(isIP(opts.hostname) ? { ...opts, servername: undefined, host: opts.hostname } : opts, done) }) });
    try {
      const request = { ...init, redirect: 'error' as const, dispatcher: agent };
      const response = await (this.options.fetcher ?? undiciFetch as unknown as typeof fetch)(url, request);
      const reader = response.body?.getReader(); if (!reader) throw new WechatMpError('invalid_response');
      const chunks: Uint8Array[] = []; let length = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 1024 * 1024) throw new WechatMpError('invalid_response'); chunks.push(part.value); } }
      finally { await reader.cancel(); }
      let payload: unknown; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new WechatMpError('invalid_response'); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new WechatMpError('invalid_response');
      const retry = response.headers.get('retry-after');
      return { status: response.status, payload, headers: retry && /^\d{1,8}$/.test(retry) ? { 'retry-after': retry } : {} };
    } catch (error) { throw error instanceof WechatMpError ? error : new WechatMpError('network'); }
    finally { try { await agent.close(); } finally { await relay?.close(); } }
  }
  private async issue(loaded: Loaded): Promise<Token> {
    const started = (this.options.clock ?? Date.now)(), c = loaded.config;
    const response = await this.send(loaded, authEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credential', appid: c.app_id, secret: c.app_secret, force_refresh: false }), signal: AbortSignal.timeout(15000) });
    const payload = response.payload as Record<string, unknown>, code = payload.errcode;
    if (code === 40164 || code === 61004) throw new WechatMpError('ip_whitelist');
    if (code === 45009 || code === 45011 || response.status === 429) throw new WechatMpError('rate_limited');
    if ([40001, 40013, 40125, 48001].includes(Number(code)) || [401, 403].includes(response.status)) throw new WechatMpError('authentication');
    if (response.status !== 200 || code !== undefined && code !== 0 || typeof payload.access_token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(payload.access_token)
      || !Number.isSafeInteger(payload.expires_in) || Number(payload.expires_in) <= 0 || Number(payload.expires_in) > 86400) throw new WechatMpError('invalid_response');
    if (this.load().revision !== loaded.revision) throw new ContractError('CAPABILITY_UNVERIFIED', '公众号认证期间配置已变化，请重新核对');
    const token = { access_token: payload.access_token, expires_at: started + Number(payload.expires_in) * 1000, revision: loaded.revision };
    this.cached = token; return token;
  }
  private async token(loaded: Loaded): Promise<Token> {
    if (this.cached?.revision === loaded.revision && this.cached.expires_at > (this.options.clock ?? Date.now)() + 300000) return this.cached;
    if (this.pending?.revision === loaded.revision) return this.pending.task;
    this.cached = undefined; const task = this.issue(loaded); this.pending = { revision: loaded.revision, task };
    try { return await task; } finally { if (this.pending?.task === task) this.pending = undefined; }
  }
  async credentials(accountId: string, appId: string): Promise<{ access_token: string }> {
    const loaded = this.bound(accountId, appId), token = await this.token(loaded); return { access_token: token.access_token };
  }
  async resolveAccount(accountId: string, url: string): Promise<ResolvedAccount> {
    const loaded = this.bound(accountId, undefined, url); await this.token(loaded);
    const checked_at = new Date((this.options.clock ?? Date.now)()).toISOString();
    return { platform: 'wechat', platform_account_id: loaded.config.app_id, canonical_url: url, checked_at, evidence_kind: 'real_platform',
      raw_body: JSON.stringify({ endpoint: authEndpoint, app_id: loaded.config.app_id, credential_binding: 'matched', authentication: 'passed', checked_at }) };
  }
  async check(accountId: string, appId: string) {
    try {
      const loaded = this.bound(accountId, appId); await this.issue(loaded);
      return { identity: 'passed' as const, permissions: 'unavailable' as const, reachability: 'passed' as const, limitations: [WECHAT_AUTH_LIMITS.connected] };
    } catch (error) {
      const kind = error instanceof WechatMpError ? error.kind : 'binding';
      return { identity: kind === 'authentication' || kind === 'binding' ? 'failed' as const : 'unavailable' as const, permissions: 'unavailable' as const,
        reachability: kind === 'authentication' ? 'passed' as const : 'failed' as const,
        limitations: [kind === 'ip_whitelist' ? WECHAT_AUTH_LIMITS.whitelist : kind === 'rate_limited' ? WECHAT_AUTH_LIMITS.rate : kind === 'authentication' ? WECHAT_AUTH_LIMITS.auth : kind === 'binding' ? WECHAT_AUTH_LIMITS.mismatch : WECHAT_AUTH_LIMITS.network] };
    }
  }
  transport(accountId: string, appId: string): PublisherTransport {
    return { evidence_kind: 'real_platform', request: async (request: PublisherRequest) => {
      const operations = ['material/add_material?type=image', 'media/uploadimg', 'draft/add', 'freepublish/submit', 'draft/get', 'freepublish/get'];
      const target = new URL(request.url), endpoint = new URL('https://api.weixin.qq.com/cgi-bin/' + request.operation);
      if (!operations.includes(request.operation) || request.method !== 'POST' || target.origin !== endpoint.origin || target.pathname !== endpoint.pathname || (endpoint.searchParams.has('type') && target.searchParams.get('type') !== 'image')) throw new ContractError('CAPABILITY_UNSUPPORTED', '公众号请求不符合固定操作路线');
      const loaded = this.bound(accountId, appId), c = loaded.config;
      let body: BodyInit | undefined, headers = { ...request.headers };
      if (request.upload) {
        if (request.upload.field !== 'media' || !['image/png', 'image/jpeg'].includes(request.upload.mime) || request.upload.bytes.length > 1024 * 1024) throw new ContractError('VALIDATION_ERROR', '公众号图片只支持不超过 1 MiB 的 PNG/JPEG');
        const form = wechatImageMultipart(Buffer.from(request.upload.bytes), request.upload.filename, request.upload.mime as 'image/png' | 'image/jpeg');
        body = form.body; headers['Content-Type'] = form.contentType;
      } else if (request.json) body = JSON.stringify(request.json);
      const response = await this.send(loaded, request.url, { method: request.method, headers, body, signal: request.signal });
      const text = JSON.stringify(response.payload);
      const token = new URL(request.url).searchParams.get('access_token');
      if ([c.app_secret, c.proxy.password, token].some(secret => !!secret && (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))))) throw new WechatMpError('invalid_response');
      return response;
    } };
  }
}
