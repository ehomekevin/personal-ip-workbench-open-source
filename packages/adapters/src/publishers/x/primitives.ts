import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { ContractError, type CapabilityDescription, type ContentFormat, type JsonObject, type Platform, type PublishInput, type PublishResult, type RawResponseRef, type Sha256 } from '@workbench/contracts';

export type PublisherOperation = 'prepareDraft' | 'submit' | 'queryResult';
export interface AccountCapability {
  account_id: string; platform: Platform; format: ContentFormat; host_id: string; adapter_version: string;
  operation: PublisherOperation; status: 'supported' | 'unverified' | 'unsupported' | 'unconfigured';
  evidence_kind: 'internal_rule' | 'real_platform'; evidence_ref: string | null; verified_at: string | null;
}
export interface PublisherAccount { account_id: string; platform_account_id: string; format: ContentFormat; host_id: string; identity_evidence_ref: string }
export interface PublisherRequest {
  operation: string; method: 'GET' | 'POST'; url: string; headers: Record<string, string>;
  json?: JsonObject; upload?: { field: string; filename: string; mime: string; bytes: Uint8Array }; signal: AbortSignal;
}
export interface PublisherResponse { status: number; payload: unknown; headers?: Record<string, string> }
export interface PublisherTransport { readonly evidence_kind: 'internal_rule' | 'real_platform'; request(request: PublisherRequest): Promise<PublisherResponse> }
export interface PublisherOptions {
  account: PublisherAccount; capabilities?: AccountCapability[]; evidence_kind?: 'internal_rule' | 'real_platform';
  paths: { managed_notes_root: string; media_root: string; state_root: string };
  credentials?: () => Promise<{ access_token: string } | null> | { access_token: string } | null;
  transport?: PublisherTransport; timeout_ms?: number; clock?: () => number;
}
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const str = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  throw new ContractError('VALIDATION_ERROR', '冻结数据不是规范 JSON');
}
export const digest = (value: string | Uint8Array): Sha256 => createHash('sha256').update(value).digest('hex') as Sha256;
export function environmentCredentials(variable: string): NonNullable<PublisherOptions['credentials']> {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(variable)) throw new ContractError('VALIDATION_ERROR', '凭据须引用明确环境变量');
  return () => process.env[variable]?.trim() ? { access_token: process.env[variable]!.trim() } : null;
}
// 只有显式装配此 transport 才允许真实网络；账号能力准入仍在每次操作前核对。
export function fetchPublisherTransport(fetcher: typeof fetch = fetch): PublisherTransport {
  return { evidence_kind: 'real_platform', async request(request) {
    let body: BodyInit | undefined;
    if (request.upload) { const form = new FormData(); form.append(request.upload.field, new Blob([Uint8Array.from(request.upload.bytes)], { type: request.upload.mime }), request.upload.filename); body = form; }
    else if (request.json) body = JSON.stringify(request.json);
    const response = await fetcher(request.url, { method: request.method, headers: request.headers, ...(body === undefined ? {} : { body }), signal: request.signal, redirect: 'error' });
    const text = await response.text(); if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('response_too_large');
    let payload: unknown; try { payload = JSON.parse(text); } catch { payload = { invalid_json: true }; }
    return { status: response.status, payload, headers: Object.fromEntries(response.headers) };
  } };
}
export function safeFile(path: string, expectedHash: string, root: string): Uint8Array {
  let actual: string, base: string;
  try { actual = realpathSync(path); base = realpathSync(root); } catch { throw new ContractError('INPUT_STALE', '冻结文件失联'); }
  if (!actual.startsWith(base + sep)) throw new ContractError('INPUT_STALE', '冻结文件越出受控根');
  const bytes = readFileSync(actual); if (!/^[a-f0-9]{64}$/.test(expectedHash) || digest(bytes) !== expectedHash) throw new ContractError('INPUT_STALE', '冻结文件实际 hash 不符');
  return bytes;
}
export function revisionText(ref: unknown, paths: PublisherOptions['paths'], workspaceId: unknown): string {
  const r = object(ref), bytes = Buffer.from(safeFile(String(r.file_path), String(r.sha256), paths.managed_notes_root)).toString('utf8');
  if (!bytes.startsWith('---\n')) throw new ContractError('INPUT_STALE', '冻结修订缺少身份');
  const end = bytes.indexOf('\n---\n', 4); if (end < 0) throw new ContractError('INPUT_STALE', '冻结修订身份不完整');
  const metadata: Record<string, unknown> = {};
  try { for (const line of bytes.slice(4, end).split('\n')) { const colon = line.indexOf(': '); const key = line.slice(0, colon); if (colon < 1 || Object.hasOwn(metadata, key) || ['__proto__','constructor','prototype'].includes(key)) throw new Error('identity'); metadata[key] = JSON.parse(line.slice(colon + 2)); } } catch { throw new ContractError('INPUT_STALE', '冻结修订身份无效'); }
  if (metadata.revision_id !== r.revision_id || metadata.document_id !== r.document_id || metadata.workspace_id !== workspaceId) throw new ContractError('INPUT_STALE', '冻结修订归属不符');
  return bytes.slice(end + 5);
}
export interface FrozenFile { path: string; relative_path: string; mime: string; bytes: Uint8Array; sha256: string; metadata: Record<string, unknown> }
export interface FrozenPayload { text: string; plan: Record<string, unknown>; texts: Map<string, string>; files: FrozenFile[]; assets: Map<string, FrozenFile> }
export function frozenPayload(input: PublishInput, paths: PublisherOptions['paths']): FrozenPayload {
  const frozen = object(input.artifact_manifest);
  if (String(digest(canonical(frozen))) !== String(input.input_hash) || frozen.account_id !== input.account_id || frozen.platform !== input.platform || frozen.format !== input.format || frozen.variant_revision_id !== input.variant_revision_id || frozen.core_approval_id !== input.core_approval_id) throw new ContractError('INPUT_STALE', '冻结输入 hash 或身份不符');
  const text = revisionText(frozen.text, paths, frozen.workspace_id), plan = object(frozen.plan), texts = new Map<string, string>(), assets = new Map<string, FrozenFile>(), files: FrozenFile[] = [];
  for (const ref of Array.isArray(plan.texts) ? plan.texts : []) { const r = object(ref); texts.set(String(r.revision_id), revisionText(r, paths, frozen.workspace_id)); }
  for (const ref of Array.isArray(plan.resolved_texts) ? plan.resolved_texts : []) { const r = object(ref); if (texts.get(String(r.revision_id)) !== r.text) throw new ContractError('INPUT_STALE', '计划解析正文与实际修订不符'); }
  for (const ref of Array.isArray(plan.assets) ? plan.assets : []) { const r = object(ref), path = String(r.file_path), bytes = safeFile(path, String(r.sha256), paths.media_root); assets.set(String(r.asset_id), { path, relative_path: basename(path), mime: String(r.mime), bytes, sha256: String(r.sha256), metadata: object(r.metadata) }); }
  const artifact = object(frozen.artifact), manifest = object(artifact.manifest);
  if (Object.keys(artifact).length) {
    if (manifest.mode !== 'export' || manifest.status !== 'export_ready' || manifest.publishable !== true || manifest.variant_revision_id !== input.variant_revision_id || manifest.core_approval_id !== input.core_approval_id || manifest.platform !== input.platform || manifest.format !== input.format || manifest.artifact_id !== artifact.artifact_id) throw new ContractError('INPUT_STALE', '冻结成品 readiness 或归属不符');
    const root = join(paths.media_root, 'artifacts', String(artifact.artifact_id));
    const bytes = safeFile(join(root, 'manifest.json'), String(artifact.manifest_sha256), paths.media_root);
    if (canonical(JSON.parse(Buffer.from(bytes).toString('utf8'))) !== canonical(manifest)) throw new ContractError('INPUT_STALE', '实际成品清单与冻结清单不符');
    if (!Array.isArray(manifest.files) || !manifest.files.length) throw new ContractError('INPUT_STALE', '冻结成品缺少文件');
    for (const ref of manifest.files) { const r = object(ref), path = resolve(root, String(r.relative_path)), rel = relative(root, path); if (!rel || rel.startsWith('..') || resolve(root, rel) !== path) throw new ContractError('INPUT_STALE', '成品文件越界'); const bytes = safeFile(path, String(r.sha256), root); if (statSync(path).size !== r.size_bytes) throw new ContractError('INPUT_STALE', '成品文件大小不符'); files.push({ path, relative_path: String(r.relative_path), mime: String(r.mime), bytes, sha256: String(r.sha256), metadata: object(r.metadata) }); }
  }
  return { text, plan, texts, files, assets };
}
export function unitText(payload: FrozenPayload, unit: Record<string, unknown>): string {
  const text = payload.texts.get(String(unit.text_revision_id)); if (text === undefined) throw new ContractError('INPUT_STALE', '成员缺少冻结文字');
  const segment = object(unit.text_segment); if (!Object.keys(segment).length) return text;
  if (!Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) || Number(segment.start) < 0 || Number(segment.end) > text.length || Number(segment.end) <= Number(segment.start)) throw new ContractError('INPUT_STALE', '成员文字区段无效');
  return text.slice(Number(segment.start), Number(segment.end));
}
export const contextOf = (input: PublishInput): Record<string, unknown> => object(input.scheduled_context);
export const continuationOf = (input: PublishInput): Record<string, unknown> => object(contextOf(input).continuation);
export function unknownAttempt(input: PublishInput, phases: string[]): boolean {
  const attempts = contextOf(input).previous_attempts;
  // 公共领域会把 attempt.phase 更新为响应phase；不能只查初始 submit_sending。
  // 没有可靠查询确认未公开的路线时，任何尚不明确的旧发送都会封锁新副作用。
  return Array.isArray(attempts) && attempts.some(a => ['sending','unknown'].includes(String(object(a).result_status)) && (phases.includes(String(object(a).phase)) || !['query','reconciling'].includes(String(object(a).phase))));
}
function redact(value: unknown, secrets: string[]): unknown {
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /(?:token|authorization|secret|password|cookie|signature)/i.test(k) ? '[REDACTED]' : redact(v,secrets)]));
  if (typeof value === 'string') { let s = value; for (const secret of secrets) if (secret) s = s.split(secret).join('[REDACTED]'); return s.replace(/([?&](?:access_token|token|signature|upload_token)=)[^&\s]+/gi,'$1[REDACTED]'); }
  return value;
}
export interface Exchange { response: PublisherResponse | null; raw: RawResponseRef; failure: string | null }
export abstract class PublisherBase {
  readonly options: PublisherOptions; readonly version: string; readonly platform: Platform; readonly formats: readonly ContentFormat[];
  constructor(options: PublisherOptions, platform: Platform, formats: readonly ContentFormat[], version: string) {
    this.options = options; this.platform = platform; this.formats = formats; this.version = version;
    if (!options.account?.account_id || !options.account.platform_account_id || !options.account.host_id || !options.account.identity_evidence_ref || !formats.includes(options.account.format)) throw new ContractError('VALIDATION_ERROR', '发布工厂缺少明确账号、宿主、形式或身份依据');
    if (!Number.isSafeInteger(options.timeout_ms ?? 30000) || (options.timeout_ms ?? 30000) < 1 || (options.timeout_ms ?? 30000) > 60000) throw new ContractError('VALIDATION_ERROR', '请求超时范围无效');
  }
  get evidenceKind() { return this.options.evidence_kind ?? 'real_platform'; }
  async describe(): Promise<CapabilityDescription[]> { return ['prepareDraft','submit','queryResult'].map(operation => { const c = this.capability(operation as PublisherOperation); return { operation, status: c?.status === 'supported' && this.evidenceKind === 'real_platform' && this.validCapability(c) ? 'supported' : c?.status === 'unsupported' ? 'unsupported' : 'unverified', limitations: ['须按账号、形式、宿主和操作核对实际能力；内部规则不证明真实发布'], verified_at: c?.verified_at ?? null, evidence_ref: c?.evidence_ref ?? null }; }); }
  private capability(operation: PublisherOperation) { return this.options.capabilities?.find(c => c.operation === operation && c.account_id === this.options.account.account_id && c.platform === this.platform && c.format === this.options.account.format && c.host_id === this.options.account.host_id && c.adapter_version === this.version); }
  private validCapability(c: AccountCapability) { return c.evidence_kind === this.evidenceKind && !!c.evidence_ref && !!c.verified_at && Number.isFinite(Date.parse(c.verified_at)); }
  protected gate(input: PublishInput, operation: PublisherOperation, verifyFiles = operation !== 'queryResult'): FrozenPayload | null {
    if (input.platform !== this.platform || !this.formats.includes(input.format)) throw new ContractError('CAPABILITY_UNSUPPORTED', '此平台形式没有实现自动路线');
    if (input.account_id !== this.options.account.account_id || input.format !== this.options.account.format || input.artifact_manifest.platform_account_id !== this.options.account.platform_account_id) throw new ContractError('CAPABILITY_UNVERIFIED', '发布账号与工厂能力范围不符');
    const c = this.capability(operation); if (c?.status === 'unsupported') throw new ContractError('CAPABILITY_UNSUPPORTED', '此账号操作被明确标记为不支持');
    if (!c || c.status !== 'supported' || !this.validCapability(c) || !this.options.transport || this.options.transport.evidence_kind !== this.evidenceKind) throw new ContractError('CAPABILITY_UNVERIFIED', '此账号形式操作缺少当前能力与 transport 证据');
    if (String(digest(canonical(input.artifact_manifest))) !== String(input.input_hash)) throw new ContractError('INPUT_STALE', '冻结输入 hash 不符');
    return verifyFiles ? frozenPayload(input,this.options.paths) : null;
  }
  async validateInput(input: PublishInput): Promise<JsonObject> { this.gate(input,'submit'); return { valid: true, adapter_version: this.version, evidence_kind: this.evidenceKind }; }
  protected record(input: PublishInput, value: unknown, secrets: string[] = []): RawResponseRef {
    const root = resolve(this.options.paths.state_root); mkdirSync(root,{recursive:true}); const path = join(root,`publisher-${this.platform}-${randomUUID()}.json`), body = canonical(redact({ adapter_version:this.version, evidence_kind:this.evidenceKind, account_id:input.account_id, intent_id:input.intent_id, input_hash:input.input_hash, recorded_at:new Date((this.options.clock??Date.now)()).toISOString(), response:value },secrets))+'\n';
    writeFileSync(path,body,{flag:'wx',mode:0o600}); chmodSync(path,0o444); if (digest(readFileSync(path)) !== digest(body)) throw new ContractError('STORAGE_UNAVAILABLE','响应证据实际 hash 不符');
    return { path, sha256:digest(body), adapter_version:this.version };
  }
  protected async exchange(input: PublishInput, operation: PublisherOperation, request: Omit<PublisherRequest,'headers'|'signal'>, auth: 'bearer'|'wechat'|'douyin'): Promise<Exchange> {
    this.gate(input,operation, false); const credential = await this.options.credentials?.(); if (!credential?.access_token) throw new ContractError('AUTH_REQUIRED','显式凭据 provider 未提供凭据');
    const token = credential.access_token, url = new URL(request.url); if (url.protocol !== 'https:' || url.username || url.password || !({x:['api.x.com'],wechat:['api.weixin.qq.com'],douyin:['open.douyin.com'],xiaohongshu:[],bilibili:[]} as Record<string,string[]>)[this.platform]!.includes(url.hostname)) throw new ContractError('VALIDATION_ERROR','发布请求不是固定官方 endpoint');
    const headers: Record<string,string> = request.json ? {'Content-Type':'application/json'} : {}; if (auth === 'wechat') url.searchParams.set('access_token',token); else headers[auth === 'bearer'?'Authorization':'access-token'] = auth === 'bearer'?'Bearer '+token:token;
    const signal = AbortSignal.timeout(this.options.timeout_ms??30000); let response: PublisherResponse|null = null, failure: string|null = null;
    try { response = await Promise.race([this.options.transport!.request({...request,url:url.toString(),headers,signal}),new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('request_timeout')),{once:true}))]); } catch { failure = signal.aborted ? 'request_timeout' : 'response_lost'; }
    const cleanRequest = { operation:request.operation,method:request.method,url:request.url,json:request.json??null,upload:request.upload?{field:request.upload.field,filename:request.upload.filename,mime:request.upload.mime,sha256:digest(request.upload.bytes),size_bytes:request.upload.bytes.length}:null };
    return { response, failure, raw:this.record(input,{ request:cleanRequest, request_fingerprint:digest(canonical(cleanRequest)), response, failure },[token]) };
  }
  protected result(input: PublishInput, state: string, phase: string, raw: RawResponseRef, extra: Partial<PublishResult> = {}): PublishResult { return { state,phase,progress:{stage:phase},work_ids:[],retryability:{retryable:false},raw_response_ref:raw,...extra }; }
  protected unknown(input: PublishInput, phase: string, raw?: RawResponseRef, extra: Partial<PublishResult> = {}): PublishResult { return this.result(input,'unknown',phase,raw??this.record(input,{operation:phase,network_calls:0}),{continuation:{kind:'reconcile_only'},...extra}); }
  protected httpFailure(input: PublishInput, exchange: Exchange, writing: boolean): PublishResult | null {
    const r=exchange.response; if (!r || exchange.failure) return this.unknown(input,writing?'send_response_lost':'query_inconclusive',exchange.raw);
    if (r.status>=200&&r.status<300) return null;
    const phase=[401,403].includes(r.status)?'permission_denied':r.status===429?'rate_limited':'http_error';
    const retryAfter = r.headers?.['retry-after']??null;
    return writing && [400,401,403,422,429].includes(r.status) ? this.result(input,'failed',phase,exchange.raw,{retryability:{retryable:false,confirmed_no_publication:true,retry_after:retryAfter}}) : this.unknown(input,phase,exchange.raw,{retryability:{retryable:false,retry_after:retryAfter}});
  }
  abstract prepareDraft(input: PublishInput): Promise<PublishResult>;
  abstract submit(input: PublishInput): Promise<PublishResult>;
  abstract queryResult(input: PublishInput): Promise<PublishResult>;
}
