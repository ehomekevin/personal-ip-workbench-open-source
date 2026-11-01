import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import { ContractError, PUBLISHING_FORMATS_BY_PLATFORM, type Platform, type ContentFormat, type PublishingRoute, type PublishingConnectionCheck } from '@workbench/contracts';
import { canonicalJson, sha256, type DatabaseSync } from '../connection/index.ts';

export interface ConnectionRow {
 id: string; workspace_id: string; account_id: string; platform: Platform; route: PublishingRoute;
 version: number; config_revision: number; enabled: number; active_config_revision: number | null;
 runtime_state: 'not_applied'|'active'|'pending'|'apply_failed'; adapter_version: string|null; host_id: string|null;
 applied_at: string|null; error_code: 'AUTH_REQUIRED'|'CAPABILITY_UNSUPPORTED'|'CAPABILITY_UNVERIFIED'|'STORAGE_UNAVAILABLE'|null;
 apply_generation: number; next_check_sequence: number; current_check_sequence: number|null;
}
export interface RevisionRow { credential_name: string|null; route: PublishingRoute; platform_account_id: string; revision: number }
export interface FrozenBindingScope { connection_id: string; config_revision: number; account_id: string; platform: Platform; format: ContentFormat; platform_account_id: string; adapter_version: string; host_id: string }
export function ensurePublishingSettings(db: DatabaseSync, workspace: string): void { db.prepare('INSERT OR IGNORE INTO publishing_settings(workspace_id) VALUES (?)').run(workspace); }
export function settingsVersion(db: DatabaseSync, workspace: string): number {
 const row=db.prepare('SELECT version FROM publishing_settings WHERE workspace_id=?').get(workspace);
 if(!row)throw new ContractError('NOT_FOUND','发布设置不存在'); return Number(row.version);
}
export function connectionRow(db: DatabaseSync, workspace: string, id: string): ConnectionRow {
 const row=db.prepare('SELECT * FROM publishing_connections WHERE workspace_id=? AND id=?').get(workspace,id);
 if(!row)throw new ContractError('NOT_FOUND','发布连接不存在'); return row as unknown as ConnectionRow;
}
export function connectionRows(db: DatabaseSync, workspace: string): ConnectionRow[] { return db.prepare('SELECT * FROM publishing_connections WHERE workspace_id=? ORDER BY created_at,id').all(workspace) as unknown as ConnectionRow[]; }
export function revisionRow(db: DatabaseSync, workspace: string, id: string, revision: number): RevisionRow {
 const row=db.prepare('SELECT * FROM publishing_connection_revisions WHERE workspace_id=? AND connection_id=? AND revision=?').get(workspace,id,revision);
 if(!row)throw new ContractError('NOT_FOUND','发布配置修订不存在'); return row as unknown as RevisionRow;
}
export function lastCheck(db: DatabaseSync, workspace: string, row: ConnectionRow): PublishingConnectionCheck|null {
 if(row.current_check_sequence===null)return null;
 const check=db.prepare('SELECT result FROM publishing_connection_checks WHERE workspace_id=? AND connection_id=? AND sequence=?').get(workspace,row.id,row.current_check_sequence);
 return check ? JSON.parse(String(check.result)) as PublishingConnectionCheck : null;
}
export function bindingScope(db: DatabaseSync, workspace: string, intent: string): FrozenBindingScope|null {
 return db.prepare('SELECT * FROM publication_binding_scopes WHERE workspace_id=? AND intent_id=?').get(workspace,intent) as unknown as FrozenBindingScope|null ?? null;
}
export function freezeBindingScope(db: DatabaseSync, workspace: string, intent: string, scope: FrozenBindingScope, now: string): void {
 if(!db.isTransaction)throw new Error('冻结发布绑定需要领域事务');
 const old=bindingScope(db,workspace,intent);if(old){for(const key of Object.keys(scope) as (keyof FrozenBindingScope)[])if(old[key]!==scope[key])throw new ContractError('INPUT_STALE','历史发布连接范围不可切换');return;}
 db.prepare('INSERT INTO publication_binding_scopes(workspace_id,intent_id,connection_id,config_revision,account_id,platform,format,platform_account_id,adapter_version,host_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(workspace,intent,scope.connection_id,scope.config_revision,scope.account_id,scope.platform,scope.format,scope.platform_account_id,scope.adapter_version,scope.host_id,now);
}
// 仅供受信真实验证流程调用；HTTP 设置写入不暴露此入口。
export interface TrustedPublishingEvidence {workspace_id:string;account_id:string;platform:Platform;format:ContentFormat;operation:'prepareDraft'|'submit'|'queryResult';host_id:string;adapter_version:string;evidence_ref:string;evidence_sha256:string;verified_at:string;limitations:string[]}
export function publishingEvidenceLimitations(value:unknown):string[]|null {
 try{const items=typeof value==='string'?JSON.parse(value):value;return Array.isArray(items)&&items.length<=20&&items.every(item=>typeof item==='string'&&item.length>0&&item.length<=300&&!/[\u0000-\u001f\u007f]/.test(item))?items:null;}catch{return null;}
}
function evidenceIdentityValid(input:TrustedPublishingEvidence):boolean{
 return /^[a-f0-9]{64}$/.test(input.evidence_sha256)&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.verified_at)&&Number.isFinite(Date.parse(input.verified_at))&&!!input.host_id&&!!input.adapter_version&&Object.hasOwn(PUBLISHING_FORMATS_BY_PLATFORM,input.platform)&&(PUBLISHING_FORMATS_BY_PLATFORM[input.platform] as readonly string[]).includes(input.format)&&['prepareDraft','submit','queryResult'].includes(input.operation)&&publishingEvidenceLimitations(input.limitations)!==null;
}
export function verifyPublishingCapabilityEvidence(db:DatabaseSync,input:TrustedPublishingEvidence):boolean {
 try {
  if(!isAbsolute(input.evidence_ref)||!evidenceIdentityValid(input))return false;
  const file=lstatSync(input.evidence_ref);if(!file.isFile()||file.isSymbolicLink()||file.size>256*1024||(file.mode&0o222)!==0)return false;
  const bytes=readFileSync(input.evidence_ref);if(sha256(bytes)!==input.evidence_sha256)return false;
  const report=JSON.parse(bytes.toString('utf8')) as Record<string,unknown>,scope=report.scope as Record<string,unknown>|undefined;
  if(report.schema_version!=='publishing-capability-evidence.v1'||report.evidence_kind!=='real_platform'||report.verified_at!==input.verified_at||!scope||canonicalJson(report.limitations)!==canonicalJson(publishingEvidenceLimitations(input.limitations)))return false;
  for(const key of ['workspace_id','account_id','platform','format','operation','host_id','adapter_version'] as const)if(scope[key]!==input[key])return false;
  const account=db.prepare('SELECT platform_account_id FROM accounts WHERE workspace_id=? AND id=?').get(input.workspace_id,input.account_id);
  return !!account&&scope.platform_account_id===account.platform_account_id&&Array.isArray(report.observations)&&report.observations.length>0;
 }catch{return false;}
}
export function recordPublishingCapabilityEvidence(db: DatabaseSync, input: TrustedPublishingEvidence & {evidence_root:string}): string {
 if(!evidenceIdentityValid(input)||!input.evidence_ref.trim()||!Array.isArray(input.limitations))throw new ContractError('VALIDATION_ERROR','真实发布证据身份不完整');
 const account=db.prepare('SELECT * FROM accounts WHERE workspace_id=? AND id=?').get(input.workspace_id,input.account_id);
 if(!account||account.platform!==input.platform||account.role!=='owner'||account.identity_status!=='confirmed'||!account.platform_account_id)throw new ContractError('CAPABILITY_UNVERIFIED','发布证据账号未确认');
 let root:string,file:string;try{root=realpathSync(input.evidence_root);file=realpathSync(input.evidence_ref);}catch{throw new ContractError('CAPABILITY_UNVERIFIED','真实发布证据文件不可核对');}
 if(!file.startsWith(root+sep)||!verifyPublishingCapabilityEvidence(db,input))throw new ContractError('CAPABILITY_UNVERIFIED','真实发布证据 hash 或身份范围不符');
 const id=randomUUID();db.prepare("INSERT INTO publishing_capability_evidence(id,workspace_id,account_id,platform,format,operation,host_id,adapter_version,evidence_kind,evidence_ref,evidence_sha256,verified_at,limitations) VALUES (?,?,?,?,?,?,?,?,'real_platform',?,?,?,?)").run(id,input.workspace_id,input.account_id,input.platform,input.format,input.operation,input.host_id,input.adapter_version,input.evidence_ref,input.evidence_sha256,input.verified_at,canonicalJson(input.limitations));return id;
}
