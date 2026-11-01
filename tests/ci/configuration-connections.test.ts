import test from 'node:test';
import assert from 'node:assert/strict';
import {TikHubAdapter} from '../../packages/adapters/src/tikhub/index.ts';
import {fixture} from '../documents/harness.ts';
import {AccountChecks} from '../../packages/domain/src/sources/account-checks.ts';
import {createConfigurationModule} from '../../apps/service/src/routes/configuration.ts';
const xhs='a'.repeat(24),sec='MS4w'+('b'.repeat(36));
function adapter(change?:string){const calls:string[]=[];return {calls,adapter:new TikHubAdapter({fixture:true,token_provider:()=> 'PRIVATE_SENTINEL',fetcher:async (url,init)=>{
 assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.equal((init?.headers as any).Authorization,'Bearer PRIVATE_SENTINEL');const u=new URL(String(url));calls.push(u.pathname);
 let data:unknown=u.pathname.endsWith('search_users')?{data:{users:[{id:xhs,red_id:'display-xhs'}]}}:u.pathname.endsWith('get_user_info')?{code:0,success:true,data:{userid:change==='wrong'? 'c'.repeat(24):xhs,red_id:'display-xhs',nickname:'本人'}}:u.pathname.endsWith('handler_user_profile_v2')?{user_info:{unique_id:'display-dy',sec_uid:sec}}:u.pathname.endsWith('handler_user_profile')?{status_code:0,user:{uid:'1234567890123456789',sec_uid:sec,unique_id:'display-dy'}}:{code:0,data:{mid:change==='wrong'?'999':'123',name:'本人'}};
 return new Response(JSON.stringify({code:200,data,reflected:'PRIVATE_SENTINEL'}));
 }})};}
test('三平台核对固定接口与唯一主页，拒绝错 UID 和不支持 URL，秘密不进入证据',async()=>{
 const a=adapter();for(const [url,p,id] of [['https://space.bilibili.com/123','bilibili','123'],['https://www.xiaohongshu.com/user/profile/'+xhs,'xiaohongshu',xhs],['https://www.douyin.com/user/'+sec,'douyin','1234567890123456789']]){const r=await a.adapter.resolveAccount(url!);assert.equal(r.platform,p);assert.equal(r.platform_account_id,id);assert.ok(!r.raw_body.includes('PRIVATE_SENTINEL'));}
 await assert.rejects(adapter('wrong').adapter.resolveAccount('https://space.bilibili.com/123'),{code:'CAPABILITY_UNVERIFIED'});await assert.rejects(adapter('wrong').adapter.resolveAccount('https://www.xiaohongshu.com/user/profile/'+xhs),{code:'CAPABILITY_UNVERIFIED'});await assert.rejects(a.adapter.resolveAccount('https://evil.invalid/user/'+sec),{code:'CAPABILITY_UNSUPPORTED'});await assert.rejects(a.adapter.resolveAccount('https://www.douyin.com/user/name'),{code:'VALIDATION_ERROR'});
});
test('展示号只接受唯一匹配，解析主页后再次核对展示号与内部 ID',async()=>{
 const a=adapter();assert.equal((await a.adapter.discoverAccount('xiaohongshu','display-xhs')).platform_account_id,xhs);assert.equal((await a.adapter.discoverAccount('douyin','display-dy')).platform_account_id,'1234567890123456789');await assert.rejects(a.adapter.discoverAccount('xiaohongshu','another-display'),{code:'CAPABILITY_UNVERIFIED'});await assert.rejects(a.adapter.discoverAccount('douyin','wrong-dy'),{code:'CAPABILITY_UNVERIFIED'});
});
test('登记转正式本人账号经过真实同一接口，幂等复用，其他入口修改阻止旧展示号采用',async()=>{
 const f=fixture();try{
  const a=adapter(),routes=new Map<string,any>();createConfigurationModule(f.context(),{collectionAdapter:a.adapter}).register({register:r=>routes.set(r.method+' '+r.path,r)});
  const invoke=(method:string,path:string,req:any,body?:any)=>{const route=routes.get(method+' '+path);return route.handle({context:req,params:{},query:new URLSearchParams(),headers:{},body:route.schema?route.schema.parse(body):body});};
  await invoke('POST','/api/v1/settings/configuration/accounts',f.request(),{platform:'xiaohongshu',name:'本人',display_id:'display-xhs',url:null});const c=(await invoke('GET','/api/v1/settings/configuration',f.request())).body,body={platform:'xiaohongshu',expected_updated_at:c.accounts[0].updated_at},req=f.request(),path='/api/v1/settings/configuration/accounts/discover';
  await assert.rejects(invoke('POST',path,f.request(),{...body,expected_updated_at:'old'}),{code:'VERSION_CONFLICT'});const result=await invoke('POST',path,req,body);assert.equal(result.body.identity_status,'confirmed');const calls=a.calls.length;assert.deepEqual(await invoke('POST',path,req,body),result);assert.equal(a.calls.length,calls);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM accounts').get()!.n,1);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM evidence_links').get()!.n,1);assert.equal((await invoke('GET','/api/v1/settings/configuration',f.request())).body.accounts[0].display_id,'display-xhs');
  const id=result.body.account_id;await assert.rejects(new AccountChecks(f.context(),adapter('wrong').adapter).check(f.request(),id),{code:'CAPABILITY_UNVERIFIED'});assert.equal(f.context().db.prepare('SELECT platform_account_id FROM accounts WHERE id=?').get(id)!.platform_account_id,xhs);
 }finally{f.cleanup();}
});

test('解析过程中登记变更时不创建账号、不采用旧主页',async()=>{
 const f=fixture();try{
  let release!:()=>void,start!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>start=r),a=adapter(),routes=new Map<string,any>();
  const collection={discoverAccount:async(p:any,id:string)=>{start();await gate;return a.adapter.discoverAccount(p,id);}} as TikHubAdapter;
  createConfigurationModule(f.context(),{collectionAdapter:collection}).register({register:r=>routes.set(r.method+' '+r.path,r)});
  const invoke=(method:string,path:string,body?:any)=>{const route=routes.get(method+' '+path);return route.handle({context:f.request(),params:{},query:new URLSearchParams(),headers:{},body:route.schema?route.schema.parse(body):body});};
  await invoke('POST','/api/v1/settings/configuration/accounts',{platform:'xiaohongshu',name:'本人',display_id:'display-xhs',url:null});const c=(await invoke('GET','/api/v1/settings/configuration')).body;
  const pending=invoke('POST','/api/v1/settings/configuration/accounts/discover',{platform:'xiaohongshu',expected_updated_at:c.accounts[0].updated_at});await started;
  const key='account-registration.v1:'+f.context().identity.workspace_id+':xiaohongshu';const value=JSON.parse(String(f.context().db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key)!.value));value.updated_at='changed-during-lookup';value.display_id='another-account';f.context().db.prepare('UPDATE application_metadata SET value=? WHERE key=?').run(JSON.stringify(value),key);release();
  await assert.rejects(pending,{code:'VERSION_CONFLICT'});assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM accounts').get()!.n,0);assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM evidence_links').get()!.n,0);
 }finally{f.cleanup();}
});
