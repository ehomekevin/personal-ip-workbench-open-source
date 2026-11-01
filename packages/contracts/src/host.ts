import type { CapabilityStatus, JsonObject, OpenWorkbenchRequest, ServiceIdentity } from './index.ts';
import { PLATFORMS, WORKBENCH_PAGES } from './common.ts';
import { objectSchema } from './validation.ts';
import { ContractError } from './errors.ts';
const locationId = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$' };
// 共用 Web 和宿主的定位边界；发布子页字段必须成组出现。
export const OpenWorkbenchSchema = objectSchema<OpenWorkbenchRequest>(['page'], {
  page: { type: 'string', enum: WORKBENCH_PAGES }, topic_id: locationId, variant_id: locationId,
  settings_view: { type: 'string', enum: ['publishing','skills'] }, platform: { type: 'string', enum: PLATFORMS }, account_id: locationId,
}, value => {
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || !Object.hasOwn(value, 'page')) throw new ContractError('VALIDATION_ERROR', '工作台定位必须是明确的对象');
  for (const key of Object.keys(value)) if (!['page','topic_id','variant_id','settings_view','platform','account_id'].includes(key)) throw new ContractError('VALIDATION_ERROR', '定位字段未登记', { field: key });
  for (const key of ['topic_id', 'variant_id', 'account_id']) if (value[key] !== undefined && /[\s\u0000-\u001f\u007f]/.test(String(value[key]))) throw new ContractError('VALIDATION_ERROR', '定位身份无效', { field: key });
  if (value.settings_view === 'skills' && (value.page !== 'settings' || value.topic_id !== undefined || value.variant_id !== undefined)) throw new ContractError('VALIDATION_ERROR', '技能定位字段组合无效');
  const publishing = value.settings_view === 'publishing';
  if (publishing ? value.page !== 'settings' || value.platform === undefined || value.topic_id !== undefined || value.variant_id !== undefined : value.platform !== undefined || value.account_id !== undefined)
    throw new ContractError('VALIDATION_ERROR', '平台发布定位字段组合无效');
});
OpenWorkbenchSchema.jsonSchema.allOf = [
  { if: { required: ['settings_view'], properties: { settings_view: { const: 'publishing' } } }, then: { required: ['platform'], properties: { page: { const: 'settings' } }, not: { anyOf: [{ required: ['topic_id'] }, { required: ['variant_id'] }] } }, else: { not: { anyOf: [{ required: ['platform'] }, { required: ['account_id'] }] } } },
];
(OpenWorkbenchSchema.jsonSchema.allOf as unknown[]).push({ if: { required: ['settings_view'], properties: { settings_view: { const: 'skills' } } }, then: { properties: { page: { const: 'settings' } }, not: { anyOf: [{ required: ['topic_id'] }, { required: ['variant_id'] }] } } });
export function workbenchLocationHash(input: OpenWorkbenchRequest): string {
  const value = OpenWorkbenchSchema.parse(input);
  if (value.settings_view === 'skills') return '#settings/skills';
  if (value.settings_view === 'publishing') return '#settings/publishing/' + value.platform + (value.account_id ? '/' + encodeURIComponent(value.account_id) : '');
  const query = new URLSearchParams();
  if (value.topic_id) query.set('topic_id', value.topic_id);
  if (value.variant_id) query.set('variant_id', value.variant_id);
  return '#' + value.page + (query.size ? '?' + query : '');
}
export interface OpenWorkbenchResult { resource_uri: string | null; identity: ServiceIdentity; capabilities: HostCapability[]; location: OpenWorkbenchRequest }
export interface HostCapability { operation: string; status: CapabilityStatus; limitations: string[]; verified_at: string | null; evidence_ref: string | null }
export interface HostBridge {
  describeCapabilities(): Promise<{ identity: ServiceIdentity; capabilities: HostCapability[] }>;
  openWorkbench(input: OpenWorkbenchRequest): Promise<OpenWorkbenchResult>;
  callTool(name: string, input: JsonObject): Promise<unknown>;
  readResource(uri: string): Promise<unknown>;
  requestDisplayMode?(mode: 'inline' | 'fullscreen'): Promise<void>;
  openExternal?(url: string): Promise<void>;
  uploadFile?(file: Blob): Promise<{ file_id: string; sha256: string }>;
  downloadArtifact?(artifact_id: string): Promise<void>;
}

// D07-009：只返回该工作区已有的能力证据，不把 MCP 在线推导成可视或原生追踪通过。
export interface HostConnectionView {
  id: string;
  host_surface: string;
  runtime_version: string;
  connection_mode: string;
  plugin_version: string;
  status: string;
}
export interface HostCapabilityRecordView extends HostCapability {
  id: string;
  host_surface: string;
  runtime_version: string;
  connection_mode: string;
  plugin_version: string;
  version: number;
}
export interface HostCapabilitiesResponse {
  identity: ServiceIdentity;
  connections: HostConnectionView[];
  capabilities: HostCapabilityRecordView[];
}
