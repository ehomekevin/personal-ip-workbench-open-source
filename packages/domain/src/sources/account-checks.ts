import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ContractError, type AccountIdentityCheckResponse, type RequestContext } from '@workbench/contracts';
import { sha256, transaction } from '@workbench/storage/connection';
import { readIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import { ensureSource } from '@workbench/storage/sources';
import type { TikHubAdapter, ResolvedAccount } from '@workbench/adapters/tikhub';
import type { ApplicationContext } from '../ports/index.ts';
import { assertRequestIdentity } from '../documents/index.ts';
import {parseAccountProfile} from '../../../adapters/src/tikhub/profile.ts';
import {saveAccountProfile} from './account-profiles.ts';

export class AccountChecks {
  readonly context: ApplicationContext; readonly adapter: Pick<TikHubAdapter, 'resolveAccount'>;
  readonly wechat?: { resolveAccount(accountId: string, url: string): Promise<ResolvedAccount> };
  constructor(context: ApplicationContext, adapter: Pick<TikHubAdapter, 'resolveAccount'>, wechat?: AccountChecks['wechat']) { this.context = context; this.adapter = adapter; this.wechat = wechat; }
  async check(request: RequestContext, id: string): Promise<AccountIdentityCheckResponse> {
    assertRequestIdentity(this.context, request);
    const db = this.context.db, workspace = request.workspace_id, operation = 'accounts.identity-check:' + id;
    const replay = readIdempotent<AccountIdentityCheckResponse>(db, request, operation, {}); if (replay) return replay;
    const row = db.prepare('SELECT * FROM accounts WHERE workspace_id=? AND id=?').get(workspace, id);
    if (!row) throw new ContractError('NOT_FOUND', '账号不存在');
    if (!['x','xiaohongshu','douyin','bilibili'].includes(String(row.platform)) && (row.platform !== 'wechat' || !this.wechat || row.role !== 'owner')) throw new ContractError('CAPABILITY_UNSUPPORTED', '该平台尚未接通身份核对');
    const result = row.platform === 'wechat' ? await this.wechat!.resolveAccount(id, String(row.canonical_url)) : await this.adapter.resolveAccount(String(row.canonical_url));
    if (result.platform !== row.platform || (result.evidence_kind === 'internal_rule' && this.context.config.mode !== 'demo')) throw new ContractError('CAPABILITY_UNVERIFIED', '账号核对必须来自真实平台响应');
    const folder = join(this.context.paths.state_root, 'raw-responses'); mkdirSync(folder, { recursive: true });
    const file = join(folder, 'account-check-' + randomUUID() + '.json');
    writeFileSync(file, result.raw_body, { flag: 'wx', mode: 0o600 });
    try {
      return transaction(db, () => {
        const replay = readIdempotent<AccountIdentityCheckResponse>(db, request, operation, {}); if (replay) { unlinkSync(file); return replay; }
        const current = db.prepare('SELECT * FROM accounts WHERE workspace_id=? AND id=?').get(workspace, id);
        if (!current || current.canonical_url !== row.canonical_url || current.platform !== row.platform || current.role !== row.role || current.identity_status !== row.identity_status || current.platform_account_id !== row.platform_account_id) throw new ContractError('VERSION_CONFLICT', '账号记录已变化，请重新核对');
        if (current.platform_account_id !== null && current.platform_account_id !== result.platform_account_id) throw new ContractError('CAPABILITY_UNVERIFIED', '平台账号 ID 与原有记录不符');
        db.prepare("UPDATE accounts SET platform_account_id=?,canonical_url=?,identity_status='confirmed',updated_at=? WHERE workspace_id=? AND id=?").run(result.platform_account_id, result.canonical_url, result.checked_at, workspace, id);
        const profile=parseAccountProfile(result.platform,result.platform_account_id,result.canonical_url,JSON.parse(result.raw_body),result.checked_at,result.evidence_kind);
        if(profile)saveAccountProfile(this.context,id,{...profile,raw_response_ref:{path:file,sha256:sha256(result.raw_body),adapter_version:'account-profile/1'}});
        const source = row.platform === 'wechat' ? ensureSource(db, workspace, 'wechat_official', 'https://api.weixin.qq.com/cgi-bin/stable_token', 'wechat_account_identity') : ensureSource(db, workspace, 'tikhub', result.endpoint_url??'https://api.tikhub.io/api/v1/twitter/web/fetch_user_profile?screen_name=' + result.canonical_url.split('/').at(-1), row.platform+'_account_identity');
        db.prepare("INSERT INTO evidence_links(id,workspace_id,owner_type,owner_id,source_type,source_id,locator) VALUES (?,?,'account',?,'source',?,?)").run(randomUUID(), workspace, id, source, JSON.stringify({ kind: row.platform === 'wechat' ? 'wechat_appid_authentication' : 'tikhub_account_identity', canonical_url: result.canonical_url, platform_account_id: result.platform_account_id, checked_at: result.checked_at, evidence_kind: result.evidence_kind, raw_response_ref: { path: file, sha256: sha256(result.raw_body) } }));
        const response: AccountIdentityCheckResponse = { account_id: id, identity_status: 'confirmed', platform_account_id: result.platform_account_id, checked_at: result.checked_at, limitations: ['平台身份已核对；发布权限和写入能力仍需单独验证'] };
        storeIdempotent(db, request, operation, {}, response); return response;
      });
    } catch (error) { unlinkSync(file); throw error; }
  }
}
