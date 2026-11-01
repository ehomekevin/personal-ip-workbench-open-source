import type { CapabilityStatus, ContentFormat, EntityId, ExpectedVersion, Platform, Rfc3339, ServiceIdentity } from './common.ts';

export const PUBLISHING_ROUTES = ['x_v2', 'wechat_official', 'douyin_open'] as const;
export type PublishingRoute = typeof PUBLISHING_ROUTES[number];
export const PUBLISHING_ROUTE_PLATFORMS = { x_v2: 'x', wechat_official: 'wechat', douyin_open: 'douyin' } as const;
export const PUBLISHING_FORMATS_BY_PLATFORM = {
  xiaohongshu: ['image_post', 'short_video'], wechat: ['article'], x: ['text', 'thread'],
  douyin: ['short_video'], bilibili: ['long_video'],
} as const;
// 仅允许显式命名的环境引用；值由服务私有 resolver 读取，不经此契约传递。
export interface PublishingCredentialReference { kind: 'environment'; name: string }
export interface CreatePublishingConnectionRequest extends ExpectedVersion {
  account_id: EntityId;
  platform: Platform;
  route: PublishingRoute;
  credential_ref: PublishingCredentialReference | null;
}
export interface PatchPublishingConnectionRequest extends ExpectedVersion { credential_ref: PublishingCredentialReference | null }
export interface ApplyPublishingConnectionRequest extends ExpectedVersion {}
export interface CheckPublishingConnectionRequest extends ExpectedVersion {}
export interface SetPublishingConnectionEnabledRequest extends ExpectedVersion { enabled: boolean }
export interface SetDefaultPublishingAccountRequest extends ExpectedVersion { platform: Platform; format: ContentFormat; account_id: EntityId | null }
export interface PublishingDefaultAccount { platform: Platform; format: ContentFormat; account_id: EntityId }

export interface PublishingAccountView {
  account_id: EntityId; platform: Platform; name: string; platform_account_id: string | null;
  role: 'owner'; identity_status: string; publish_target_eligible: boolean;
}
export interface PublishingOperationCapability {
  format: ContentFormat; operation: 'prepareDraft' | 'submit' | 'queryResult'; status: CapabilityStatus;
  host_id: string; adapter_version: string; evidence_kind: 'real_platform' | 'internal_rule' | 'none';
  evidence_ref: string | null; verified_at: Rfc3339 | null; limitations: string[];
}
export interface PublishingConnectionCheck {
  check_id: EntityId; sequence: number; config_revision: number; checked_at: Rfc3339;
  readonly: true;
  identity: 'passed' | 'failed' | 'unavailable'; permissions: 'passed' | 'failed' | 'unavailable';
  reachability: 'passed' | 'failed' | 'unavailable'; limitations: string[];
}
export interface PublishingConnectionRuntime {
  state: 'not_applied' | 'active' | 'pending' | 'apply_failed';
  active_config_revision: number | null; adapter_version: string | null; host_id: string | null;
  applied_at: Rfc3339 | null; credentials_ready: boolean;
  error_code: 'AUTH_REQUIRED' | 'CAPABILITY_UNSUPPORTED' | 'CAPABILITY_UNVERIFIED' | 'STORAGE_UNAVAILABLE' | null;
}
export interface PublishingConnectionView {
  id: EntityId; account_id: EntityId; platform: Platform; route: PublishingRoute;
  version: number; config_revision: number; credential_ref: PublishingCredentialReference | null;
  enabled: boolean; runtime: PublishingConnectionRuntime;
  capabilities: PublishingOperationCapability[]; last_check: PublishingConnectionCheck | null;
}
export interface PublishingSettingsResponse {
  identity: ServiceIdentity; version: number; config_source: 'sqlite';
  credential_references: PublishingCredentialReference[];
  accounts: PublishingAccountView[]; connections: PublishingConnectionView[]; defaults: PublishingDefaultAccount[];
}
export interface PublishingConnectionResponse { identity: ServiceIdentity; settings_version: number; connection: PublishingConnectionView }
export interface PublishingCheckResponse { identity: ServiceIdentity; connection_id: EntityId; connection_version: number; check: PublishingConnectionCheck; applied_to_current: boolean }
// PSET-03 将该定位加入实际 Web/MCP 解析器；本 DTO 不代表宿主入口已经接线。
export interface PublishingSettingsLocation { page: 'settings'; settings_view: 'publishing'; platform: Platform; account_id?: EntityId }
