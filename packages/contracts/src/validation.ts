import { ContractError } from './errors.ts';
export interface RuntimeSchema<T> { parse(value: unknown): T; jsonSchema: Record<string, unknown> }
// D07-007：数组项与范围同样在 HTTP 边界校验，不能只检查外层类型。
function validateField(value: unknown, schema: Record<string, unknown>, field: string): void {
  const invalid = (message: string): never => { throw new ContractError('VALIDATION_ERROR', message, { field }); };
  if (value === null && (schema.nullable || (Array.isArray(schema.type) && schema.type.includes('null')))) return;
  const type = Array.isArray(schema.type) ? schema.type.find(item => item !== 'null') : schema.type;
  if (type === 'string') {
    if (typeof value !== 'string') invalid('字段必须是字符串');
    const text = value as string;
    if (schema.minLength !== undefined && text.length < Number(schema.minLength)) invalid('字符串过短');
    if (schema.maxLength !== undefined && text.length > Number(schema.maxLength)) invalid('字符串过长');
  }
  if (type === 'boolean' && typeof value !== 'boolean') invalid('字段必须是布尔值');
  if (type === 'integer' && !Number.isSafeInteger(value)) invalid('字段必须是有效整数');
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) invalid('字段必须是有限数值');
  if (type === 'integer' || type === 'number') {
    if (schema.minimum !== undefined && Number(value) < Number(schema.minimum)) invalid('数值低于下限');
    if (schema.maximum !== undefined && Number(value) > Number(schema.maximum)) invalid('数值超过上限');
  }
  if (type === 'array') {
    if (!Array.isArray(value)) invalid('字段必须是数组');
    const items = value as unknown[];
    if (schema.minItems !== undefined && items.length < Number(schema.minItems)) invalid('数组项不足');
    if (schema.maxItems !== undefined && items.length > Number(schema.maxItems)) invalid('数组项过多');
    if (schema.items) items.forEach((item, index) => validateField(item, schema.items as Record<string, unknown>, `${field}[${index}]`));
  }
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('字段必须是对象');
    const object = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    for (const key of (schema.required ?? []) as string[]) if (!(key in object)) invalid('缺少必填字段');
    if (properties) for (const [key, item] of Object.entries(object)) {
      if (properties[key]) validateField(item, properties[key]!, `${field}.${key}`);
      else if (schema.additionalProperties === false) invalid('未知字段');
    }
  }
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) invalid('字段值不在允许范围');
}
export function objectSchema<T>(required: string[], properties: Record<string, Record<string, unknown>>, refinement?: (value: Record<string, unknown>) => void): RuntimeSchema<T> {
  return { jsonSchema: { type: 'object', required, properties, additionalProperties: false }, parse(value: unknown): T {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('VALIDATION_ERROR', '需要 JSON 对象');
    const obj = value as Record<string, unknown>;
    for (const key of required) if (!(key in obj)) throw new ContractError('VALIDATION_ERROR', '缺少必填字段', { field: key });
    for (const [key, v] of Object.entries(obj)) {
      const p = properties[key];
      if (!p) throw new ContractError('VALIDATION_ERROR', '未知字段', { field: key });
      validateField(v, p, key);
    }
    refinement?.(obj); return obj as T;
  } };
}
import type { SaveRevisionRequest, PatchSettingsRequest, CreateTopicRequest, CancelJobRequest, ResumeJobRequest } from './requests.ts';
export const CancelJobSchema = objectSchema<CancelJobRequest>(['expected_version'], { expected_version: { type: 'integer', minimum: 1 } });
export const ResumeJobSchema = objectSchema<ResumeJobRequest>(['expected_version'], {
  expected_version: { type: 'integer', minimum: 1 }, input: { type: 'object' }, executor: { type: 'string' }, native_task_binding_id: { type: 'string' }, recovery_action: { type: 'string', enum: ['query_original'] },
}, value => {
  if (value.recovery_action === 'query_original' && ['input','executor','native_task_binding_id'].some(key => key in value))
    throw new ContractError('VALIDATION_ERROR', '核对原结果不能改变输入或执行路线');
  for (const key of ['executor', 'native_task_binding_id']) if (key in value && !(value[key] as string).trim())
    throw new ContractError('VALIDATION_ERROR', '恢复身份不能为空', { field: key });
});
export const SaveRevisionSchema = objectSchema<SaveRevisionRequest>(['expected_revision_id', 'text', 'origin'], { expected_revision_id: { type: ['string', 'null'] }, text: { type: 'string' }, origin: { type: 'string', enum: ['human'] } });
export const CreateTopicSchema = objectSchema<CreateTopicRequest>(['title', 'category', 'audience', 'source_ids'], { title: { type: 'string' }, category: { type: 'string' }, audience: { type: 'string' }, source_ids: { type: 'array', items: { type: 'string' } }, angle: { type: 'string' }, expected_effort_min: { type: 'integer', minimum: 0 } }, value => {
  if (!(value.source_ids as unknown[]).every(v => typeof v === 'string')) throw new ContractError('VALIDATION_ERROR', '来源 ID 必须是字符串', { field: 'source_ids' });
});
export const PatchSettingsSchema = objectSchema<PatchSettingsRequest>(['expected_version'], { expected_version: { type: 'integer', minimum: 1 }, timezone: { type: 'string' }, paths: { type: 'object' }, default_executor: { type: 'string', enum: ['codex', 'claude'] }, api_fallback_enabled: { type: 'boolean' } }, value => {
  if (value.paths) for (const [key, path] of Object.entries(value.paths as Record<string, unknown>)) {
    if (!['source_vault_root', 'managed_notes_root', 'state_root', 'media_root'].includes(key) || (typeof path !== 'string' && !(key === 'source_vault_root' && path === null))) throw new ContractError('VALIDATION_ERROR', '路径配置字段无效', { field: `paths.${key}` });
  }
  if (value.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: value.timezone as string }); } catch { throw new ContractError('VALIDATION_ERROR', 'IANA 时区无效', { field: 'timezone' }); } }
});
