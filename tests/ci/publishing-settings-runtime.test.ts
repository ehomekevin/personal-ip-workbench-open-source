import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { configureDatabase, migrateDatabase } from '../../packages/storage/src/connection/index.ts';
import { PublishingSettings, type PublishingRuntime, type PublishingReadonlyResult, type PublishingRuntimeCandidate } from '../../packages/domain/src/publishing-settings/index.ts';
import type { ApplicationContext, PublisherPort } from '../../packages/domain/src/ports/index.ts';
const ref={kind:'environment' as const,name:'TOKEN'};
function fixture(overrides:Partial<PublishingRuntime>={}){
 const db=new DatabaseSync(':memory:');configureDatabase(db);migrateDatabase(db);const w=randomUUID(),s=randomUUID(),paths={managed_notes_root:'/unused/notes',state_root:'/unused/state',media_root:'/unused/media',source_vault_root:null};
 db.prepare("INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,'portable','UTC',?,'demo',1)").run(w,w,JSON.stringify(paths));
 db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES ('owner',?,'x','123','owner','本人','https://example.invalid','confirmed')").run(w);
 const config:ServiceConfiguration={workspace_id:w,service_instance_id:s,title:'portable',mode:'demo',timezone:'UTC',paths,listen:{host:'127.0.0.1',port:4318}},context:ApplicationContext={db,config,paths,identity:{workspace_id:w,service_instance_id:s,contract_version:CONTRACT_VERSION},getExecutorHealth:async()=>[]};
 const forbidden=async()=>{throw new Error('platform_call_forbidden');},adapter:PublisherPort={describe:async()=>[],validateInput:forbidden,prepareDraft:forbidden,submit:forbidden,queryResult:forbidden},candidate:PublishingRuntimeCandidate={adapter_version:'offline-v1',host_id:'offline',bindings:[{account_id:'owner',platform:'x',format:'text',adapter,evidence_kind:'internal_rule',supported:false}]};
 const runtime:PublishingRuntime={credentialReferences:[ref],credentialReady:r=>r?.name===ref.name,scope:()=>({adapter_version:'offline-v1',host_id:'offline'}),hydrate:()=>candidate,build:()=>candidate,check:async()=>({identity:'passed',permissions:'unavailable',reachability:'passed',limitations:[]}),...overrides};
 const settings=new PublishingSettings(context,{runtime});return {db,settings,context,candidate,runtime,request:()=>({...context.identity,request_id:randomUUID(),idempotency_key:randomUUID(),request_identity_ref:'portable-test'}),create:()=>settings.create({...context.identity,request_id:randomUUID(),idempotency_key:randomUUID(),request_identity_ref:'portable-test'},{expected_version:1,account_id:'owner',platform:'x',route:'x_v2',credential_ref:ref})};
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
test('portable真实SQLite配置持久幂等先于版本，same-value不增长，引用及账号受限',async()=>{
 const f=fixture();try{const req=f.request(),body={expected_version:1,account_id:'owner',platform:'x' as const,route:'x_v2' as const,credential_ref:ref},created=await f.settings.create(req,body);await f.settings.patch(f.request(),created.connection.id,{expected_version:1,credential_ref:null});const fresh=new PublishingSettings(f.context,{runtime:f.runtime});assert.deepEqual(await fresh.create(req,body),created);await assert.rejects(()=>fresh.create(req,{...body,credential_ref:null}),{code:'IDEMPOTENCY_CONFLICT'});const noOp=await fresh.patch(f.request(),created.connection.id,{expected_version:2,credential_ref:null});assert.equal(noOp.connection.version,2);assert.equal(noOp.settings_version,3);await assert.rejects(()=>fresh.patch(f.request(),created.connection.id,{expected_version:2,credential_ref:{kind:'environment',name:'NOT_ALLOWED'}}),{code:'VALIDATION_ERROR'});await assert.rejects(()=>fresh.create(f.request(),{...body,expected_version:3,account_id:'unknown'}),{code:'NOT_FOUND'});assert.throws(()=>f.db.prepare('DELETE FROM publishing_connection_revisions').run(),/immutable/);
 }finally{f.db.close();}
});
test('portable异步apply CAS拒绝过期候选，重启不会应用未生效修订',async()=>{
 const d=deferred<PublishingRuntimeCandidate>(),f=fixture({build:()=>d.promise});try{const c=await f.create(),pending=f.settings.apply(f.request(),c.connection.id,{expected_version:1});await f.settings.patch(f.request(),c.connection.id,{expected_version:1,credential_ref:null});d.resolve(f.candidate);await assert.rejects(()=>pending,{code:'VERSION_CONFLICT'});const restarted=new PublishingSettings(f.context,{runtime:f.runtime}),view=(await restarted.get(f.request())).connections[0]!;assert.equal(view.runtime.active_config_revision,null);assert.equal(view.config_revision,2);assert.equal(view.runtime.state,'pending');
 }finally{f.db.close();}
});
test('portable readonly sequence CAS保留历史且不覆盖更晚完成结果',async()=>{
 const a=deferred<PublishingReadonlyResult>(),b=deferred<PublishingReadonlyResult>();let n=0;const f=fixture({check:()=>n++===0?a.promise:b.promise});try{const c=await f.create(),one=f.settings.check(f.request(),c.connection.id,{expected_version:1}),two=f.settings.check(f.request(),c.connection.id,{expected_version:1});b.resolve({identity:'passed',permissions:'unavailable',reachability:'passed',limitations:[]});assert.equal((await two).applied_to_current,true);a.resolve({identity:'failed',permissions:'failed',reachability:'passed',limitations:[]});assert.equal((await one).applied_to_current,false);assert.equal((await f.settings.get(f.request())).connections[0]!.last_check!.sequence,2);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM publishing_connection_checks').get()!.n,2);
 }finally{f.db.close();}
});
test('portable启用只检查配置生效，readonly检查和配置不升级submit证据',async()=>{
 const f=fixture();try{const c=await f.create();await assert.rejects(()=>f.settings.setEnabled(f.request(),c.connection.id,{expected_version:1,enabled:true}),{code:'CAPABILITY_UNVERIFIED'});const applied=await f.settings.apply(f.request(),c.connection.id,{expected_version:1});assert.equal(applied.connection.version,1);const enabled=await f.settings.setEnabled(f.request(),c.connection.id,{expected_version:1,enabled:true});assert.equal(enabled.connection.version,2);await f.settings.check(f.request(),c.connection.id,{expected_version:2});assert.ok((await f.settings.get(f.request())).connections[0]!.capabilities.every(c=>c.status==='unverified'));assert.throws(()=>f.settings.bindingForNew({account_id:'owner',platform:'x',format:'text'}),{code:'CAPABILITY_UNVERIFIED'});
 }finally{f.db.close();}
});
test('portable生效持久化失败保留旧指针及脱敏失败，不激活候选',async()=>{
 const f=fixture();try{const c=await f.create();f.db.exec("CREATE TRIGGER fail_apply BEFORE UPDATE OF active_config_revision ON publishing_connections BEGIN SELECT RAISE(ABORT,'PRIVATE_SENTINEL'); END");const result=await f.settings.apply(f.request(),c.connection.id,{expected_version:1});assert.equal(result.connection.runtime.state,'apply_failed');assert.equal(result.connection.runtime.error_code,'STORAGE_UNAVAILABLE');assert.equal(result.connection.runtime.active_config_revision,null);assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));f.db.exec('DROP TRIGGER fail_apply');const applied=await f.settings.apply(f.request(),c.connection.id,{expected_version:1});assert.equal(applied.connection.runtime.state,'active');assert.equal(applied.connection.config_revision,1);
 }finally{f.db.close();}
});
