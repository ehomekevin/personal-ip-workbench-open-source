import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ContractError, type ContentFormat, type Platform } from '@workbench/contracts';
import type { ApplicationContext } from '@workbench/domain/ports';
import type { PublisherBinding } from '@workbench/domain/publications';
import { createXPublisher, X_PUBLISHER_VERSION, environmentCredentials, fetchPublisherTransport, type AccountCapability, type PublisherOptions } from '@workbench/adapters/publishers/x';
import { createWechatPublisher, WECHAT_PUBLISHER_VERSION } from '@workbench/adapters/publishers/wechat';
import { createDouyinPublisher, DOUYIN_PUBLISHER_VERSION } from '@workbench/adapters/publishers/douyin';

const factories = {
  x: { version: X_PUBLISHER_VERSION, formats: ['text', 'thread'], create: createXPublisher },
  wechat: { version: WECHAT_PUBLISHER_VERSION, formats: ['article'], create: createWechatPublisher },
  douyin: { version: DOUYIN_PUBLISHER_VERSION, formats: ['short_video'], create: createDouyinPublisher },
} as const;
const fields = (value: unknown, allowed: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ContractError('VALIDATION_ERROR', '发布配置字段无效');
  }
  return value as Record<string, unknown>;
};
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f]/.test(value)) throw new ContractError('VALIDATION_ERROR', '发布配置标识无效');
  return value;
}

// 仅装配用户明确提供的账号配置；不搜索 token、不根据安装包或内部测试推断能力。
export function loadPublisherBindings(context: ApplicationContext, path = process.env.WORKBENCH_PUBLISHERS_CONFIG_PATH): PublisherBinding[] {
  if (!path) return [];
  if (!isAbsolute(path)) throw new ContractError('VALIDATION_ERROR', 'WORKBENCH_PUBLISHERS_CONFIG_PATH 必须是绝对路径');
  let parsed: unknown;
  try {
    if (!statSync(path).isFile() || statSync(path).size > 256 * 1024) throw new Error('size');
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch { throw new ContractError('VALIDATION_ERROR', '无法读取发布配置'); }
  return parseLegacyPublisherBindings(context, parsed);
}

// 导入使用同一份已固定 bytes，避免验证与 hash 对应不同文件快照。
export function parseLegacyPublisherBindings(context: ApplicationContext, parsed: unknown): PublisherBinding[] {
  const config = fields(parsed, ['config_version', 'identity', 'publishers']);
  const identity = fields(config.identity, ['workspace_id', 'service_instance_id', 'contract_version']);
  if (config.config_version !== 1) throw new ContractError('VALIDATION_ERROR', '发布配置版本无效');
  if (Object.entries(context.identity).some(([key, value]) => identity[key] !== value)) throw new ContractError('WORKSPACE_INSTANCE_MISMATCH', '发布配置属于另一主服务或工作区');
  if (!Array.isArray(config.publishers) || config.publishers.length > 50) throw new ContractError('VALIDATION_ERROR', '发布账号配置数量无效');
  const keys = new Set<string>();
  return config.publishers.map(value => {
    const entry = fields(value, ['platform', 'adapter_version', 'account', 'credential_env', 'capabilities']);
    const platform = text(entry.platform);
    if (!Object.hasOwn(factories, platform)) throw new ContractError('CAPABILITY_UNSUPPORTED', '此平台尚无可配置的官方发布路线');
    const factory = factories[platform as keyof typeof factories];
    if (entry.adapter_version !== factory.version) throw new ContractError('CAPABILITY_UNVERIFIED', '发布证据不属于当前适配器版本');
    const account = fields(entry.account, ['account_id', 'platform_account_id', 'format', 'host_id', 'identity_evidence_ref']);
    const normalized = { account_id: text(account.account_id), platform_account_id: text(account.platform_account_id), format: text(account.format) as ContentFormat, host_id: text(account.host_id), identity_evidence_ref: text(account.identity_evidence_ref) };
    if (!(factory.formats as readonly string[]).includes(normalized.format)) throw new ContractError('CAPABILITY_UNSUPPORTED', '账号配置的内容形式不在适配范围');
    const key = `${platform}:${normalized.account_id}:${normalized.format}`;
    if (keys.has(key)) throw new ContractError('VALIDATION_ERROR', '重复的发布账号与形式配置');
    keys.add(key);
    const row = context.db.prepare('SELECT platform,platform_account_id,role,identity_status FROM accounts WHERE workspace_id=? AND id=?').get(context.identity.workspace_id, normalized.account_id);
    if (!row || row.platform !== platform || row.platform_account_id !== normalized.platform_account_id || row.role !== 'owner' || row.identity_status !== 'confirmed') throw new ContractError('CAPABILITY_UNVERIFIED', '发布配置账号尚未与当前工作区确认身份匹配');
    const credentialName = text(entry.credential_env);
    const credentials = environmentCredentials(credentialName);
    if (!Array.isArray(entry.capabilities) || entry.capabilities.length !== 3) throw new ContractError('VALIDATION_ERROR', '须分别登记三个发布操作的能力');
    const operations = new Set<string>();
    const capabilities: AccountCapability[] = entry.capabilities.map(raw => {
      const c = fields(raw, ['operation', 'status', 'evidence_kind', 'evidence_ref', 'verified_at']);
      const operation = text(c.operation);
      if (!['prepareDraft', 'submit', 'queryResult'].includes(operation) || operations.has(operation)) throw new ContractError('VALIDATION_ERROR', '发布能力操作无效或重复');
      operations.add(operation);
      if (!['supported', 'unverified', 'unsupported', 'unconfigured'].includes(String(c.status)) || !['real_platform', 'internal_rule'].includes(String(c.evidence_kind))) throw new ContractError('VALIDATION_ERROR', '发布能力状态或证据类型无效');
      const evidenceRef = c.evidence_ref === null ? null : text(c.evidence_ref);
      const verifiedAt = c.verified_at === null ? null : text(c.verified_at);
      if (verifiedAt !== null && !Number.isFinite(Date.parse(verifiedAt))) throw new ContractError('VALIDATION_ERROR', '能力验证时间无效');
      if (c.status === 'supported' && (!evidenceRef || !verifiedAt || c.evidence_kind !== 'real_platform')) throw new ContractError('CAPABILITY_UNVERIFIED', '内部规则或缺失证据不能启用真实发布');
      return { ...normalized, platform: platform as Platform, adapter_version: factory.version, operation: operation as AccountCapability['operation'], status: c.status as AccountCapability['status'], evidence_kind: c.evidence_kind as AccountCapability['evidence_kind'], evidence_ref: evidenceRef, verified_at: verifiedAt };
    });
    const options: PublisherOptions = { account: normalized, capabilities, evidence_kind: 'real_platform', paths: { managed_notes_root: context.paths.managed_notes_root, media_root: context.paths.media_root, state_root: join(context.paths.state_root, 'raw-responses') }, credentials, transport: fetchPublisherTransport() };
    return { account_id: normalized.account_id, platform: platform as Platform, format: normalized.format, adapter: factory.create(options), evidence_kind: 'real_platform', supported: capabilities.every(c => c.status === 'supported' && c.evidence_kind === 'real_platform') };
  });
}
