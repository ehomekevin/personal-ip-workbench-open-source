import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,sep} from 'node:path';
import type {AccountPlatformProfile,Platform,JsonValue} from '@workbench/contracts';
import {sha256,canonicalJson} from '@workbench/storage/connection';
import {parseAccountProfile} from '../../../adapters/src/tikhub/profile.ts';
import type {ApplicationContext} from '../ports/index.ts';
export const profileKey=(workspace:string,id:string)=>`account-profile.v1:${workspace}:${id}`;
export function saveAccountProfile(context:ApplicationContext,id:string,profile:AccountPlatformProfile):void{
 if(!context.db.isTransaction)throw new Error('保存账号资料需要领域事务');
 const key=profileKey(context.identity.workspace_id,id),value=canonicalJson(profile as unknown as JsonValue);
 context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
 context.db.prepare('INSERT OR IGNORE INTO application_metadata(key,value) VALUES(?,?)').run(key+':'+profile.collected_at,value);
}
export function readAccountProfile(context:ApplicationContext,row:{id:unknown;platform:unknown;platform_account_id:unknown;canonical_url:unknown}):AccountPlatformProfile|null{
 const w=context.identity.workspace_id;
 const saved=context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(profileKey(w,String(row.id)));
 if(saved){try{const p=JSON.parse(String(saved.value)) as AccountPlatformProfile;if(p.platform===row.platform&&p.platform_account_id===row.platform_account_id)return p;}catch{/* 保留损坏记录，从可核对的历史回执读取。 */}}
 // 旧身份核对回执已经含有完整平台资料；只读复用，不额外调用 API。
 for(const link of context.db.prepare("SELECT locator FROM evidence_links WHERE workspace_id=? AND owner_type='account' AND owner_id=? ORDER BY rowid DESC LIMIT 10").all(w,String(row.id))){
  try{
   const locator=JSON.parse(String(link.locator)),sameUrl=row.platform==='x'?String(locator.canonical_url).toLowerCase()===String(row.canonical_url).toLowerCase():locator.canonical_url===row.canonical_url;if(locator.platform_account_id!==row.platform_account_id||!sameUrl||!['real_platform','internal_rule'].includes(locator.evidence_kind))continue;
   const ref=locator.raw_response_ref,root=realpathSync(join(context.paths.state_root,'raw-responses')),file=realpathSync(ref.path),stat=lstatSync(ref.path);
   if(!file.startsWith(root+sep)||!stat.isFile()||stat.isSymbolicLink()||stat.size>262144)continue;
   const bytes=readFileSync(file);if(sha256(bytes)!==ref.sha256)continue;
   const profile=parseAccountProfile(row.platform as Platform,String(row.platform_account_id),String(row.canonical_url),JSON.parse(bytes.toString('utf8')),locator.checked_at,locator.evidence_kind);
   if(profile)return {...profile,raw_response_ref:{...ref,adapter_version:'account-profile/1'}};
  }catch{/* 不用错误身份、缺失文件或不完整资料替换已保存的账号。 */}
 }
 return null;
}
