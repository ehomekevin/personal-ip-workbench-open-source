import type { Platform, PublishingRoute, PublishingCredentialReference, PublishingOperationCapability, PublishingConnectionCheck } from '@workbench/contracts';
import type { PublisherBinding } from '../publications/index.ts';

// 快照只携带身份、引用和可信证据；秘密与候选适配器只留在服务进程。
export interface PublishingRuntimeSnapshot {
  workspace_id: string; connection_id: string; connection_version: number; config_revision: number;
  account_id: string; platform_account_id: string; platform: Platform; route: PublishingRoute;
  credential_ref: PublishingCredentialReference | null;
  capabilities: readonly PublishingOperationCapability[];
  beforeExternalWrite?(format: import('@workbench/contracts').ContentFormat, operation: 'prepareDraft'|'submit'): void;
}
export interface PublishingRuntimeCandidate {
  readonly adapter_version: string; readonly host_id: string; readonly bindings: readonly PublisherBinding[];
}
export type PublishingReadonlyResult = Pick<PublishingConnectionCheck, 'identity' | 'permissions' | 'reachability' | 'limitations'>;
export interface PublishingRuntime {
  readonly credentialReferences: readonly PublishingCredentialReference[];
  credentialReady(reference: PublishingCredentialReference | null,accountId?:string): boolean;
  scope(route: PublishingRoute): { adapter_version: string; host_id: string };
  hydrate(snapshot: PublishingRuntimeSnapshot): PublishingRuntimeCandidate;
  build(snapshot: PublishingRuntimeSnapshot): PublishingRuntimeCandidate | Promise<PublishingRuntimeCandidate>;
  check(snapshot: PublishingRuntimeSnapshot): Promise<PublishingReadonlyResult>;
}
export interface LegacyPublishingImport {
  sha256: string;
  connections: { account_id: string; platform: Platform; route: PublishingRoute; credential_ref: PublishingCredentialReference | null }[];
  diagnosticClaims?: unknown;
}
