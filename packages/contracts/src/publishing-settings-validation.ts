import { CAPABILITY_STATUSES, FORMATS, PLATFORMS, type Platform } from './common.ts';
import type { AccountsRow } from './entities.ts';
import { ContractError } from './errors.ts';
import { objectSchema, type RuntimeSchema } from './validation.ts';
import { PUBLISHING_ROUTES, PUBLISHING_ROUTE_PLATFORMS, PUBLISHING_FORMATS_BY_PLATFORM } from './publishing-settings.ts';
import type {
  ApplyPublishingConnectionRequest, CheckPublishingConnectionRequest, CreatePublishingConnectionRequest,
  PatchPublishingConnectionRequest, SetDefaultPublishingAccountRequest, SetPublishingConnectionEnabledRequest,
  PublishingSettingsLocation,
} from './publishing-settings.ts';

const id = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$' };
const version = { type: 'integer', minimum: 1 };
const credentialPattern = '^[A-Z][A-Z0-9_]{0,127}$';
const credentialRef = {
  type: ['object', 'null'], required: ['kind', 'name'], additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['environment'] }, name: { type: 'string', minLength: 1, maxLength: 128, pattern: credentialPattern } },
};
function invalid(field: string): never { throw new ContractError('VALIDATION_ERROR', '发布设置字段无效', { field }); }
function ownFields(value: unknown, schema: Record<string, unknown>, field: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(field);
  for (const key of (schema.required ?? []) as string[]) if (!Object.hasOwn(value, key)) invalid(field);
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(properties, key)) invalid(field);
    ownFields((value as Record<string, unknown>)[key], properties[key]!, `${field}.${key}`);
  }
}
function publishingSchema<T>(required: string[], properties: Record<string, Record<string, unknown>>, refine?: (value: Record<string, unknown>) => void): RuntimeSchema<T> {
  const base = objectSchema<T>(required, properties, refine);
  return { jsonSchema: base.jsonSchema, parse(value) { ownFields(value, base.jsonSchema, 'publishing_settings'); return base.parse(value); } };
}
function validId(value: unknown, field: string): void {
  if (typeof value !== 'string' || !new RegExp(id.pattern).test(value)) invalid(field);
}
function validCredential(value: unknown): void {
  if (value === null) return;
  const reference = value as { name: string };
  if (!new RegExp(credentialPattern).test(reference.name)) invalid('credential_ref.name');
}
// 服务必须先在自己的 SQLite 工作区读取账号；本规则不执行账号查找或平台操作。
export function assertPublishingAccountEligibility(account: Pick<AccountsRow, 'workspace_id' | 'platform' | 'role' | 'identity_status' | 'platform_account_id'> | null, workspaceId: string, platform: Platform): void {
  if (!account || account.workspace_id !== workspaceId) throw new ContractError('NOT_FOUND', '当前工作区没有此发布账号');
  if (account.platform !== platform) throw new ContractError('VALIDATION_ERROR', '账号不属于所选平台');
  if (account.role !== 'owner' || account.identity_status !== 'confirmed' || !account.platform_account_id?.trim())
    throw new ContractError('CAPABILITY_UNVERIFIED', '发布账号尚未确认本人身份');
}
export const CreatePublishingConnectionSchema = publishingSchema<CreatePublishingConnectionRequest>(
  ['expected_version', 'account_id', 'platform', 'route', 'credential_ref'],
  { expected_version: version, account_id: id, platform: { type: 'string', enum: PLATFORMS }, route: { type: 'string', enum: PUBLISHING_ROUTES }, credential_ref: credentialRef },
  value => {
    validId(value.account_id, 'account_id'); validCredential(value.credential_ref);
    if (PUBLISHING_ROUTE_PLATFORMS[value.route as keyof typeof PUBLISHING_ROUTE_PLATFORMS] !== value.platform) invalid('route');
  },
);
CreatePublishingConnectionSchema.jsonSchema.allOf = Object.entries(PUBLISHING_ROUTE_PLATFORMS).map(([route, platform]) => ({
  if: { properties: { route: { const: route } }, required: ['route'] }, then: { properties: { platform: { const: platform } } },
}));
export const PatchPublishingConnectionSchema = publishingSchema<PatchPublishingConnectionRequest>(
  ['expected_version', 'credential_ref'], { expected_version: version, credential_ref: credentialRef }, value => validCredential(value.credential_ref),
);
export const ApplyPublishingConnectionSchema = publishingSchema<ApplyPublishingConnectionRequest>(['expected_version'], { expected_version: version });
// 无 URL、作品输入或写操作参数，不能借连接检查触发上传、草稿或提交。
export const CheckPublishingConnectionSchema = publishingSchema<CheckPublishingConnectionRequest>(['expected_version'], { expected_version: version });
export const SetPublishingConnectionEnabledSchema = publishingSchema<SetPublishingConnectionEnabledRequest>(['expected_version', 'enabled'], { expected_version: version, enabled: { type: 'boolean' } });
export const SetDefaultPublishingAccountSchema = publishingSchema<SetDefaultPublishingAccountRequest>(
  ['expected_version', 'platform', 'format', 'account_id'],
  { expected_version: version, platform: { type: 'string', enum: PLATFORMS }, format: { type: 'string', enum: FORMATS }, account_id: { ...id, type: ['string', 'null'] } },
  value => {
    if (value.account_id !== null) validId(value.account_id, 'account_id');
    const formats: readonly string[] = PUBLISHING_FORMATS_BY_PLATFORM[value.platform as keyof typeof PUBLISHING_FORMATS_BY_PLATFORM];
    if (!formats.includes(String(value.format))) invalid('format');
  },
);
SetDefaultPublishingAccountSchema.jsonSchema.allOf = Object.entries(PUBLISHING_FORMATS_BY_PLATFORM).map(([platform, formats]) => ({
  if: { properties: { platform: { const: platform } }, required: ['platform'] }, then: { properties: { format: { enum: formats } } },
}));
export const PublishingSettingsLocationSchema = publishingSchema<PublishingSettingsLocation>(
  ['page', 'settings_view', 'platform'],
  { page: { type: 'string', enum: ['settings'] }, settings_view: { type: 'string', enum: ['publishing'] }, platform: { type: 'string', enum: PLATFORMS }, account_id: id },
  value => { if (value.account_id !== undefined) validId(value.account_id, 'account_id'); },
);

// DTO 的 JSON Schema 仅描述响应；受信证据与运行时状态由服务产生，不是可写请求。
const text = { type: 'string' }, nullableText = { type: ['string', 'null'] };
const reference = (name: string) => ({ $ref: '#/components/schemas/' + name });
const array = (items: object) => ({ type: 'array', items });
const object = (properties: Record<string, unknown>) => ({ type: 'object', required: Object.keys(properties), additionalProperties: false, properties });
const checkState = { type: 'string', enum: ['passed', 'failed', 'unavailable'] };
export const PUBLISHING_SETTINGS_RESPONSE_SCHEMAS = {
  PublishingAccountView: object({ account_id: id, platform: { enum: PLATFORMS }, name: text, platform_account_id: nullableText, role: { const: 'owner' }, identity_status: text, publish_target_eligible: { type: 'boolean' } }),
  PublishingDefaultAccount: object({ platform: { enum: PLATFORMS }, format: { enum: FORMATS }, account_id: id }),
  PublishingOperationCapability: object({ format: { enum: FORMATS }, operation: { enum: ['prepareDraft', 'submit', 'queryResult'] }, status: { enum: CAPABILITY_STATUSES }, host_id: text, adapter_version: text, evidence_kind: { enum: ['real_platform', 'internal_rule', 'none'] }, evidence_ref: nullableText, verified_at: nullableText, limitations: array(text) }),
  PublishingConnectionCheck: object({ check_id: id, sequence: version, config_revision: version, checked_at: { ...text, format: 'date-time' }, readonly: { const: true }, identity: checkState, permissions: checkState, reachability: checkState, limitations: array(text) }),
  PublishingConnectionRuntime: object({ state: { enum: ['not_applied', 'active', 'pending', 'apply_failed'] }, active_config_revision: { type: ['integer', 'null'], minimum: 1 }, adapter_version: nullableText, host_id: nullableText, applied_at: nullableText, credentials_ready: { type: 'boolean' }, error_code: { enum: ['AUTH_REQUIRED', 'CAPABILITY_UNSUPPORTED', 'CAPABILITY_UNVERIFIED', 'STORAGE_UNAVAILABLE', null] } }),
  PublishingConnectionView: object({ id, account_id: id, platform: { enum: PLATFORMS }, route: { enum: PUBLISHING_ROUTES }, version, config_revision: version, credential_ref: credentialRef, enabled: { type: 'boolean' }, runtime: reference('PublishingConnectionRuntime'), capabilities: array(reference('PublishingOperationCapability')), last_check: { anyOf: [reference('PublishingConnectionCheck'), { type: 'null' }] } }),
  PublishingSettingsResponse: object({ identity: reference('ServiceIdentity'), version, config_source: { const: 'sqlite' }, credential_references: array({ ...credentialRef, type: 'object' }), accounts: array(reference('PublishingAccountView')), connections: array(reference('PublishingConnectionView')), defaults: array(reference('PublishingDefaultAccount')) }),
  PublishingConnectionResponse: object({ identity: reference('ServiceIdentity'), settings_version: version, connection: reference('PublishingConnectionView') }),
  PublishingCheckResponse: object({ identity: reference('ServiceIdentity'), connection_id: id, connection_version: version, check: reference('PublishingConnectionCheck'), applied_to_current: { type: 'boolean' } }),
};
Object.assign(PUBLISHING_SETTINGS_RESPONSE_SCHEMAS.PublishingOperationCapability, { allOf: [{
  if: { properties: { status: { const: 'supported' } }, required: ['status'] },
  then: { properties: { evidence_kind: { const: 'real_platform' }, evidence_ref: { type: 'string', minLength: 1 }, verified_at: { type: 'string', format: 'date-time' } } },
}] });
