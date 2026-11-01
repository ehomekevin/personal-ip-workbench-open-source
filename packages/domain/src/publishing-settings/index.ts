import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
 ContractError, CreatePublishingConnectionSchema, PatchPublishingConnectionSchema, ApplyPublishingConnectionSchema,
 CheckPublishingConnectionSchema, SetPublishingConnectionEnabledSchema, SetDefaultPublishingAccountSchema,
 assertPublishingAccountEligibility, PUBLISHING_FORMATS_BY_PLATFORM,
 type RequestContext, type JsonValue, type Platform, type ContentFormat, type AccountsRow,
 type PublishingCredentialReference, type PublishingConnectionView, type PublishingSettingsResponse,
 type PublishingConnectionResponse, type PublishingCheckResponse, type PublishingOperationCapability,
 type CreatePublishingConnectionRequest, type PatchPublishingConnectionRequest, type ApplyPublishingConnectionRequest,
 type CheckPublishingConnectionRequest, type SetPublishingConnectionEnabledRequest, type SetDefaultPublishingAccountRequest,
} from '@workbench/contracts';
import { transaction, canonicalJson, lookupIdempotency, claimIdempotency, commitIdempotency } from '@workbench/storage/connection';
import { ensurePublishingSettings, settingsVersion, connectionRow, connectionRows, revisionRow, lastCheck,
 bindingScope, freezeBindingScope, verifyPublishingCapabilityEvidence, publishingEvidenceLimitations, type TrustedPublishingEvidence, type ConnectionRow, type FrozenBindingScope } from '@workbench/storage/publishing-settings';
import type { ApplicationContext, PublishingSettingsPort } from '../ports/index.ts';
import { assertRequestIdentity } from '../documents/index.ts';
import type { PublisherBinding } from '../publications/index.ts';
import type { PublishingRuntime, PublishingRuntimeSnapshot, PublishingRuntimeCandidate, LegacyPublishingImport, PublishingReadonlyResult } from './runtime.ts';
export type * from './runtime.ts';

type RuntimeError = NonNullable<PublishingConnectionView['runtime']['error_code']>;
const operations=['prepareDraft','submit','queryResult'] as const;
const checkLimits = ['凭据未就绪；请配置已登记引用并重启服务。','当前连接尚未实现身份与权限的只读诊断路线；配置生效不代表发布能力已验证。','平台拒绝身份查询；请核对用户凭据及读取权限。','平台请求额度受限，请稍后重新检查。','平台未返回可核对的身份；请稍后重新检查。','身份查询不验证提交权限。','用户身份已核对；发布、线程和结果查询仍需分别验证。','凭据返回的用户与所选本人账号不符；请核对配置。','只读身份查询无法证明提交权限。','身份检查未完成；请核对网络和凭据后重试。','账号身份未核对','账号权限未核对','连接不可达','凭据未就绪','当前路线未实现只读检查','只读检查未验证发布能力','只读检查失败，请补齐同账号配置后重试'];
checkLimits.push('公众号 AppID 认证与代理已连通；草稿、上传和公开发布权限仍需分别验证。','公众号凭据绑定与所选账号不符，请核对同账号配置。','公众号 AppID 或 AppSecret 认证失败，请核对同账号配置。','公众号出口 IP 未获允许，请核对固定代理与平台白名单。','公众号认证请求受限，请稍后重试。','公众号认证未完成，请核对代理网络和凭据后重试。');
function errorCode(error: unknown): RuntimeError { return error instanceof ContractError && ['AUTH_REQUIRED','CAPABILITY_UNSUPPORTED','CAPABILITY_UNVERIFIED','STORAGE_UNAVAILABLE'].includes(error.code) ? error.code as RuntimeError : 'CAPABILITY_UNVERIFIED'; }
function sameRef(a:PublishingCredentialReference|null,b:PublishingCredentialReference|null):boolean{return a?.name===b?.name;}
export class PublishingSettings implements PublishingSettingsPort {
 readonly context:ApplicationContext; readonly runtime:PublishingRuntime;
 private readonly candidates=new Map<string,PublishingRuntimeCandidate>();
 private readonly inFlight=new Map<string,Promise<unknown>>();
 private readonly externalBoundary=new AsyncLocalStorage<{intent:string;input:{account_id:string;platform:Platform;format:ContentFormat};operation:'prepareDraft'|'submit'|'queryResult';scope:FrozenBindingScope;writes:number;blocked:boolean}>();
 constructor(context:ApplicationContext, options:{runtime:PublishingRuntime;legacyImport?:LegacyPublishingImport|null}) {
  this.context=context;this.runtime=options.runtime;
  transaction(context.db,()=>ensurePublishingSettings(context.db,context.identity.workspace_id));
  if(options.legacyImport)this.importLegacy(options.legacyImport);
  this.hydrate();
 }
 private now():string{return new Date().toISOString();}
 private account(id:string,platform:Platform):AccountsRow {
  const row=this.context.db.prepare('SELECT * FROM accounts WHERE workspace_id=? AND id=?').get(this.context.identity.workspace_id,id) as unknown as AccountsRow|null;
  assertPublishingAccountEligibility(row,this.context.identity.workspace_id,platform);return row!;
 }
 private ref(reference:PublishingCredentialReference|null):void {
  if(reference&&!this.runtime.credentialReferences.some(item=>item.kind==='environment'&&item.name===reference.name))throw new ContractError('VALIDATION_ERROR','凭据引用未登记',{field:'credential_ref'});
 }
 private version(actual:number,expected:number):void{if(actual!==expected)throw new ContractError('VERSION_CONFLICT','发布设置已由另一入口修改',{current_version:actual});}
 private replay<T>(request:RequestContext,op:string,body:unknown):T|null{
  const row=lookupIdempotency(this.context.db,request.workspace_id,op,request.idempotency_key??'',body);return row?.state==='committed'?row.response as unknown as T:null;
 }
 private write<T>(request:RequestContext,op:string,body:unknown,action:()=>T):T {
  return transaction(this.context.db,()=>{const claim=claimIdempotency(this.context.db,request.workspace_id,op,request.idempotency_key??'',body);if(claim.state==='committed')return claim.response as unknown as T;const result=action();commitIdempotency(this.context.db,request.workspace_id,claim.id,result as JsonValue);return result;});
 }
 private async serialized<T>(request:RequestContext,op:string,body:unknown,action:()=>Promise<T>):Promise<T>{
  const done=this.replay<T>(request,op,body);if(done)return done;
  const key=`${request.workspace_id}:${request.idempotency_key??''}`;const old=this.inFlight.get(key);if(old){lookupIdempotency(this.context.db,request.workspace_id,op,request.idempotency_key??'',body);return old as Promise<T>;}
  const pending=action();this.inFlight.set(key,pending);try{return await pending;}finally{this.inFlight.delete(key);}
 }
 private bump():void{this.context.db.prepare('UPDATE publishing_settings SET version=version+1 WHERE workspace_id=?').run(this.context.identity.workspace_id);}
 private capabilities(row:ConnectionRow, revision=row.config_revision, scope=this.runtime.scope(row.route),restrictCurrent=true):PublishingOperationCapability[] {
  const db=this.context.db,w=this.context.identity.workspace_id,ref=revisionRow(db,w,row.id,revision).credential_name;
  const check=lastCheck(db,w,row),failed=check&&check.config_revision===revision&&[check.identity,check.permissions,check.reachability].includes('failed');
  return (PUBLISHING_FORMATS_BY_PLATFORM[row.platform] as readonly ContentFormat[]).flatMap(format=>operations.map(operation=>{
   const evidence=db.prepare('SELECT * FROM publishing_capability_evidence WHERE workspace_id=? AND account_id=? AND platform=? AND format=? AND operation=? AND host_id=? AND adapter_version=? ORDER BY verified_at DESC,id DESC LIMIT 1').get(w,row.account_id,row.platform,format,operation,scope.host_id,scope.adapter_version);
   const trusted=!!evidence&&verifyPublishingCapabilityEvidence(db,evidence as unknown as TrustedPublishingEvidence);
   const unavailable=restrictCurrent&&!this.runtime.credentialReady(ref?{kind:'environment',name:ref}:null,row.account_id),degraded=restrictCurrent&&(failed||(row.runtime_state==='apply_failed'&&row.config_revision===revision));
   const limitations=trusted?publishingEvidenceLimitations(evidence.limitations)??[]:[];
   return {format,operation,...scope,status:unavailable?'unconfigured':degraded?'degraded':trusted?'supported':'unverified',evidence_kind:trusted?'real_platform':'none',evidence_ref:trusted?String(evidence.evidence_ref):null,verified_at:trusted?String(evidence.verified_at):null,limitations:unavailable?['凭据未就绪',...limitations]:degraded?['连接受限，请检查同账号配置',...limitations]:trusted?limitations:['该账号、形式与操作尚无真实发布验证证据']} as PublishingOperationCapability;
  }));
 }
 private snapshot(row:ConnectionRow,revision=row.config_revision,scope=this.runtime.scope(row.route)):PublishingRuntimeSnapshot {
  const account=this.account(row.account_id,row.platform),saved=revisionRow(this.context.db,this.context.identity.workspace_id,row.id,revision);
  if(account.platform_account_id!==saved.platform_account_id)throw new ContractError('CAPABILITY_UNVERIFIED','原发布账号身份需要重新核对');
  const credential_ref=saved.credential_name?Object.freeze({kind:'environment' as const,name:saved.credential_name}):null;this.ref(credential_ref);
  // 固定适配器只消费匹配的可信证据；当前诊断由读取和每次写入门控动态消费。
  return Object.freeze({workspace_id:this.context.identity.workspace_id,connection_id:row.id,connection_version:row.version,config_revision:revision,account_id:row.account_id,platform_account_id:saved.platform_account_id,platform:row.platform,route:row.route,credential_ref,capabilities:Object.freeze(this.capabilities(row,revision,scope,false).map(capability=>Object.freeze({...capability,limitations:Object.freeze([...capability.limitations]) as unknown as string[]}))),beforeExternalWrite:(format:ContentFormat,operation:'prepareDraft'|'submit')=>{
   const boundary=this.externalBoundary.getStore();try{
    if(!boundary||boundary.scope.connection_id!==row.id||boundary.scope.config_revision!==revision||boundary.scope.adapter_version!==scope.adapter_version||boundary.scope.host_id!==scope.host_id||boundary.operation!==operation||boundary.input.format!==format)throw new ContractError('CAPABILITY_UNVERIFIED','外部请求没有当前冻结发送范围');
    this.beforeInvoke(boundary.intent,boundary.input,operation);
    const current=connectionRow(this.context.db,this.context.identity.workspace_id,row.id);
    if(current.active_config_revision!==revision||current.adapter_version!==scope.adapter_version||current.host_id!==scope.host_id||this.account(current.account_id,current.platform).platform_account_id!==saved.platform_account_id)throw new ContractError('CAPABILITY_UNVERIFIED','外部写入前原发布绑定已变化');
    boundary.writes++;
   }catch(error){if(boundary)boundary.blocked=true;throw error;}
  }});
 }
 private key(id:string,revision:number,scope:{adapter_version:string;host_id:string}):string{return `${id}:${revision}:${scope.adapter_version}:${scope.host_id}`;}
 private validateCandidate(snapshot:PublishingRuntimeSnapshot,candidate:PublishingRuntimeCandidate,expected=this.runtime.scope(snapshot.route)):PublishingRuntimeCandidate {
  if(candidate.adapter_version!==expected.adapter_version||candidate.host_id!==expected.host_id||!candidate.bindings.length||candidate.bindings.some(binding=>binding.account_id!==snapshot.account_id||binding.platform!==snapshot.platform||!(PUBLISHING_FORMATS_BY_PLATFORM[snapshot.platform] as readonly string[]).includes(binding.format)))throw new ContractError('CAPABILITY_UNVERIFIED','运行绑定身份或版本不符');
  return Object.freeze({...candidate,bindings:Object.freeze(candidate.bindings.map(binding=>Object.freeze({...binding})))});
 }
 private hydrate():void {
  const db=this.context.db,w=this.context.identity.workspace_id;
  for(const row of connectionRows(db,w))if(row.active_config_revision!==null){
   try{const scope={adapter_version:row.adapter_version!,host_id:row.host_id!};const snapshot=this.snapshot(row,row.active_config_revision,scope);if(!this.runtime.credentialReady(snapshot.credential_ref,snapshot.account_id))throw new ContractError('AUTH_REQUIRED','凭据未就绪');const candidate=this.validateCandidate(snapshot,this.runtime.hydrate(snapshot),scope);this.candidates.set(this.key(row.id,row.active_config_revision,scope),candidate);
    db.prepare('UPDATE publishing_connections SET runtime_state=?,error_code=NULL WHERE workspace_id=? AND id=?').run(row.config_revision===row.active_config_revision?'active':'pending',w,row.id);
   }catch(error){db.prepare("UPDATE publishing_connections SET runtime_state='apply_failed',error_code=? WHERE workspace_id=? AND id=?").run(errorCode(error),w,row.id);}
  }
  // 历史查询继续使用发送时的修订，不能回退到新的默认账号或当前绑定。
  for(const saved of db.prepare('SELECT DISTINCT connection_id,config_revision,adapter_version,host_id FROM publication_binding_scopes WHERE workspace_id=?').all(w)){
   const row=connectionRow(db,w,String(saved.connection_id)),scope={adapter_version:String(saved.adapter_version),host_id:String(saved.host_id)},revision=Number(saved.config_revision),key=this.key(row.id,revision,scope);
   if(this.candidates.has(key))continue;try{const snapshot=this.snapshot(row,revision,scope);if(this.runtime.credentialReady(snapshot.credential_ref,snapshot.account_id))this.candidates.set(key,this.validateCandidate(snapshot,this.runtime.hydrate(snapshot),scope));}catch{/* 历史记录保留；查询时返回固定的补齐原因。 */}
  }
 }
 private view(row:ConnectionRow):PublishingConnectionView {
  const saved=revisionRow(this.context.db,this.context.identity.workspace_id,row.id,row.config_revision),credential_ref=saved.credential_name?{kind:'environment' as const,name:saved.credential_name}:null;
  return {id:row.id,account_id:row.account_id,platform:row.platform,route:row.route,version:row.version,config_revision:row.config_revision,credential_ref,enabled:row.enabled===1,runtime:{state:row.runtime_state,active_config_revision:row.active_config_revision,adapter_version:row.adapter_version,host_id:row.host_id,applied_at:row.applied_at,credentials_ready:this.runtime.credentialReady(credential_ref,row.account_id),error_code:row.error_code},capabilities:this.capabilities(row),last_check:lastCheck(this.context.db,this.context.identity.workspace_id,row)};
 }
 private response(id:string):PublishingConnectionResponse{return {identity:this.context.identity,settings_version:settingsVersion(this.context.db,this.context.identity.workspace_id),connection:this.view(connectionRow(this.context.db,this.context.identity.workspace_id,id))};}
 private read():PublishingSettingsResponse {
  const db=this.context.db,w=this.context.identity.workspace_id;
  const accounts=db.prepare("SELECT * FROM accounts WHERE workspace_id=? AND role='owner' ORDER BY platform,name,id").all(w).map(row=>({account_id:String(row.id),platform:row.platform as Platform,name:String(row.name),platform_account_id:row.platform_account_id as string|null,role:'owner' as const,identity_status:String(row.identity_status),publish_target_eligible:row.identity_status==='confirmed'&&typeof row.platform_account_id==='string'&&!!row.platform_account_id.trim()}));
  return {identity:this.context.identity,version:settingsVersion(db,w),config_source:'sqlite',credential_references:this.runtime.credentialReferences.map(ref=>({...ref})),accounts,connections:connectionRows(db,w).map(row=>this.view(row)),defaults:db.prepare('SELECT platform,format,account_id FROM publishing_defaults WHERE workspace_id=? ORDER BY platform,format').all(w) as unknown as PublishingSettingsResponse['defaults']};
 }
 async get(request:RequestContext):Promise<PublishingSettingsResponse>{assertRequestIdentity(this.context,request);return this.read();}
 private insert(input:Pick<CreatePublishingConnectionRequest,'account_id'|'platform'|'route'|'credential_ref'>):string {
  const db=this.context.db,w=this.context.identity.workspace_id,account=this.account(input.account_id,input.platform);this.ref(input.credential_ref);
  if(db.prepare('SELECT id FROM publishing_connections WHERE workspace_id=? AND account_id=? AND platform=? AND route=?').get(w,input.account_id,input.platform,input.route))throw new ContractError('VALIDATION_ERROR','此账号已经保存相同连接');
  const id=randomUUID(),at=this.now();db.prepare('INSERT INTO publishing_connections(id,workspace_id,account_id,platform,route,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id,w,input.account_id,input.platform,input.route,at,at);
  db.prepare('INSERT INTO publishing_connection_revisions(workspace_id,connection_id,revision,credential_name,route,platform_account_id,created_at) VALUES (?,?,1,?,?,?,?)').run(w,id,input.credential_ref?.name??null,input.route,account.platform_account_id!,at);return id;
 }
 async create(request:RequestContext,input:CreatePublishingConnectionRequest):Promise<PublishingConnectionResponse>{
  assertRequestIdentity(this.context,request);CreatePublishingConnectionSchema.parse(input);return this.write(request,'publishing.create',input,()=>{this.version(settingsVersion(this.context.db,request.workspace_id),input.expected_version);const id=this.insert(input);this.bump();return this.response(id);});
 }
 async patch(request:RequestContext,id:string,input:PatchPublishingConnectionRequest):Promise<PublishingConnectionResponse>{
  assertRequestIdentity(this.context,request);PatchPublishingConnectionSchema.parse(input);return this.write(request,'publishing.patch',{id,input},()=>{const db=this.context.db,row=connectionRow(db,request.workspace_id,id);this.version(row.version,input.expected_version);this.ref(input.credential_ref);const saved=revisionRow(db,request.workspace_id,id,row.config_revision);if(sameRef(input.credential_ref,saved.credential_name?{kind:'environment',name:saved.credential_name}:null))return this.response(id);const account=this.account(row.account_id,row.platform),at=this.now();db.prepare('INSERT INTO publishing_connection_revisions(workspace_id,connection_id,revision,credential_name,route,platform_account_id,created_at) VALUES (?,?,?,?,?,?,?)').run(request.workspace_id,id,row.config_revision+1,input.credential_ref?.name??null,row.route,account.platform_account_id!,at);db.prepare("UPDATE publishing_connections SET version=version+1,config_revision=config_revision+1,runtime_state='pending',error_code=NULL,updated_at=? WHERE workspace_id=? AND id=?").run(at,request.workspace_id,id);this.bump();return this.response(id);});
 }
 async apply(request:RequestContext,id:string,input:ApplyPublishingConnectionRequest):Promise<PublishingConnectionResponse>{
  assertRequestIdentity(this.context,request);ApplyPublishingConnectionSchema.parse(input);const op='publishing.apply',body={id,input};return this.serialized(request,op,body,async()=>{
   const db=this.context.db,w=request.workspace_id;
   const start=transaction(db,()=>{const claim=claimIdempotency(db,w,op,request.idempotency_key??'',body);const row=connectionRow(db,w,id);this.version(row.version,input.expected_version);db.prepare('UPDATE publishing_connections SET apply_generation=apply_generation+1 WHERE workspace_id=? AND id=?').run(w,id);return {claim,row,generation:row.apply_generation+1};});
   let candidate:PublishingRuntimeCandidate|undefined,failure:RuntimeError|null=null;
   try{const snapshot=this.snapshot(start.row);if(!this.runtime.credentialReady(snapshot.credential_ref,snapshot.account_id))throw new ContractError('AUTH_REQUIRED','凭据未就绪');candidate=this.validateCandidate(snapshot,await this.runtime.build(snapshot));}catch(error){failure=errorCode(error);}
   let response:PublishingConnectionResponse;
   try{response=transaction(db,()=>{const latest=connectionRow(db,w,id);if(latest.version!==start.row.version||latest.config_revision!==start.row.config_revision||latest.apply_generation!==start.generation)throw new ContractError('VERSION_CONFLICT','生效期间配置已变化',{current_version:latest.version});
    if(failure||!candidate)db.prepare("UPDATE publishing_connections SET runtime_state='apply_failed',error_code=? WHERE workspace_id=? AND id=?").run(failure??'CAPABILITY_UNVERIFIED',w,id);
    else db.prepare("UPDATE publishing_connections SET active_config_revision=config_revision,runtime_state='active',adapter_version=?,host_id=?,applied_at=?,error_code=NULL WHERE workspace_id=? AND id=?").run(candidate.adapter_version,candidate.host_id,this.now(),w,id);
    const result=this.response(id);commitIdempotency(db,w,start.claim.id,result as unknown as JsonValue);
    // 发布引用只在持久化提交成功后切换；候选不能提前成为 active。
    return result;
   });}catch(error){if(error instanceof ContractError&&error.code==='VERSION_CONFLICT')throw error;
    try{response=transaction(db,()=>{const latest=connectionRow(db,w,id);if(latest.version!==start.row.version||latest.config_revision!==start.row.config_revision||latest.apply_generation!==start.generation)throw new ContractError('VERSION_CONFLICT','生效期间配置已变化',{current_version:latest.version});db.prepare("UPDATE publishing_connections SET runtime_state='apply_failed',error_code='STORAGE_UNAVAILABLE' WHERE workspace_id=? AND id=?").run(w,id);const result=this.response(id);commitIdempotency(db,w,start.claim.id,result as unknown as JsonValue);return result;});}catch(repair){if(repair instanceof ContractError&&repair.code==='VERSION_CONFLICT')throw repair;throw new ContractError('STORAGE_UNAVAILABLE','发布配置未持久化，原生效绑定保留');}
   }
   if(response.connection.runtime.state==='active'&&candidate)this.activate(id,candidate);return response;
  });
 }
 private activate(id:string,candidate:PublishingRuntimeCandidate):PublishingConnectionResponse{const row=connectionRow(this.context.db,this.context.identity.workspace_id,id);this.candidates.set(this.key(id,row.active_config_revision!,candidate),candidate);return this.response(id);}
 async check(request:RequestContext,id:string,input:CheckPublishingConnectionRequest):Promise<PublishingCheckResponse>{
  assertRequestIdentity(this.context,request);CheckPublishingConnectionSchema.parse(input);const op='publishing.check',body={id,input};return this.serialized(request,op,body,async()=>{
   const db=this.context.db,w=request.workspace_id,start=transaction(db,()=>{const claim=claimIdempotency(db,w,op,request.idempotency_key??'',body),row=connectionRow(db,w,id);this.version(row.version,input.expected_version);const sequence=row.next_check_sequence+1;db.prepare('UPDATE publishing_connections SET next_check_sequence=? WHERE workspace_id=? AND id=?').run(sequence,w,id);return {claim,row,sequence};});
   let result:PublishingReadonlyResult;try{const raw=await this.runtime.check(this.snapshot(start.row));result={identity:['passed','failed','unavailable'].includes(raw.identity)?raw.identity:'unavailable',permissions:['passed','failed','unavailable'].includes(raw.permissions)?raw.permissions:'unavailable',reachability:['passed','failed','unavailable'].includes(raw.reachability)?raw.reachability:'unavailable',limitations:raw.limitations.filter(value=>checkLimits.includes(value))};}catch{result={identity:'unavailable',permissions:'unavailable',reachability:'failed',limitations:['只读检查失败，请补齐同账号配置后重试']};}
   return transaction(db,()=>{const latest=connectionRow(db,w,id),applied=latest.version===start.row.version&&latest.config_revision===start.row.config_revision&&(latest.current_check_sequence??0)<start.sequence,check={check_id:randomUUID(),sequence:start.sequence,config_revision:start.row.config_revision,checked_at:this.now(),readonly:true as const,...result};
    db.prepare('INSERT INTO publishing_connection_checks(id,workspace_id,connection_id,sequence,config_revision,connection_version,checked_at,result,applied_to_current) VALUES (?,?,?,?,?,?,?,?,?)').run(check.check_id,w,id,start.sequence,start.row.config_revision,start.row.version,check.checked_at,canonicalJson(check),applied?1:0);
    if(applied)db.prepare('UPDATE publishing_connections SET current_check_sequence=? WHERE workspace_id=? AND id=?').run(start.sequence,w,id);
    const response={identity:this.context.identity,connection_id:id,connection_version:latest.version,check,applied_to_current:applied};commitIdempotency(db,w,start.claim.id,response as unknown as JsonValue);return response;
   });
  });
 }
 private configured(row:ConnectionRow):void{
  this.account(row.account_id,row.platform);const snapshot=this.snapshot(row);if(!this.runtime.credentialReady(snapshot.credential_ref,snapshot.account_id))throw new ContractError('AUTH_REQUIRED','凭据未就绪');const scope=this.runtime.scope(row.route);
  if(row.active_config_revision!==row.config_revision||row.runtime_state!=='active'||row.adapter_version!==scope.adapter_version||row.host_id!==scope.host_id||!this.candidates.has(this.key(row.id,row.config_revision,scope)))throw new ContractError('CAPABILITY_UNVERIFIED','已保存配置尚未成功生效');
 }
 async setEnabled(request:RequestContext,id:string,input:SetPublishingConnectionEnabledRequest):Promise<PublishingConnectionResponse>{
  assertRequestIdentity(this.context,request);SetPublishingConnectionEnabledSchema.parse(input);return this.write(request,'publishing.enabled',{id,input},()=>{const db=this.context.db,w=request.workspace_id,row=connectionRow(db,w,id);this.version(row.version,input.expected_version);if((row.enabled===1)===input.enabled)return this.response(id);if(input.enabled)this.configured(row);db.prepare('UPDATE publishing_connections SET enabled=?,version=version+1,updated_at=? WHERE workspace_id=? AND id=?').run(input.enabled?1:0,this.now(),w,id);this.bump();if(!input.enabled)this.blockUnsent(row);return this.response(id);});
 }
 private blockUnsent(row:ConnectionRow):void {
  const db=this.context.db,w=this.context.identity.workspace_id,at=this.now();
  const intents=db.prepare("SELECT p.id FROM publication_intents p WHERE p.workspace_id=? AND p.account_id=? AND p.state='queued' AND NOT EXISTS (SELECT 1 FROM publication_attempts a WHERE a.workspace_id=p.workspace_id AND a.intent_id=p.id AND a.result_status IN ('sending','unknown','processing','published'))").all(w,row.account_id);
  for(const intent of intents){db.prepare("UPDATE publication_intents SET state='needs_action',progress=json_set(progress,'$.phase','connection_disabled'),version=version+1,updated_at=? WHERE workspace_id=? AND id=?").run(at,w,intent.id!);db.prepare("UPDATE jobs SET state='waiting_input',version=version+1,updated_at=? WHERE workspace_id=? AND target_id=? AND kind='publication' AND state='queued'").run(at,w,intent.id!);db.prepare("UPDATE schedules SET state='needs_attention',version=version+1,updated_at=? WHERE workspace_id=? AND publication_intent_id=? AND state IN ('scheduled','due','executing')").run(at,w,intent.id!);}
 }
 async setDefault(request:RequestContext,input:SetDefaultPublishingAccountRequest):Promise<PublishingSettingsResponse>{
  assertRequestIdentity(this.context,request);SetDefaultPublishingAccountSchema.parse(input);return this.write(request,'publishing.default',input,()=>{const db=this.context.db,w=request.workspace_id;this.version(settingsVersion(db,w),input.expected_version);const old=db.prepare('SELECT account_id FROM publishing_defaults WHERE workspace_id=? AND platform=? AND format=?').get(w,input.platform,input.format);if((old?.account_id??null)===input.account_id)return this.read();if(input.account_id===null)db.prepare('DELETE FROM publishing_defaults WHERE workspace_id=? AND platform=? AND format=?').run(w,input.platform,input.format);else {this.account(input.account_id,input.platform);const row=db.prepare('SELECT id FROM publishing_connections WHERE workspace_id=? AND account_id=? AND platform=?').get(w,input.account_id,input.platform);if(!row)throw new ContractError('CAPABILITY_UNVERIFIED','默认账号尚无兼容发布连接');db.prepare('INSERT INTO publishing_defaults(workspace_id,platform,format,account_id,connection_id) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,platform,format) DO UPDATE SET account_id=excluded.account_id,connection_id=excluded.connection_id').run(w,input.platform,input.format,input.account_id,row.id!);}this.bump();return this.read();});
 }
 private importLegacy(input:LegacyPublishingImport):void {
  transaction(this.context.db,()=>{const db=this.context.db,w=this.context.identity.workspace_id,row=db.prepare('SELECT * FROM publishing_settings WHERE workspace_id=?').get(w)!;
   if(row.legacy_import_sha256){if(row.legacy_import_sha256!==input.sha256)throw new ContractError('VALIDATION_ERROR','旧发布配置已导入，文件内容随后变化');return;}
   if(row.version!==1||connectionRows(db,w).length||db.prepare('SELECT workspace_id FROM publishing_defaults WHERE workspace_id=?').get(w))throw new ContractError('VALIDATION_ERROR','已有发布设置不能导入旧配置');
   if(!/^[a-f0-9]{64}$/.test(input.sha256))throw new ContractError('VALIDATION_ERROR','旧配置 hash 无效');
   for(const item of input.connections){CreatePublishingConnectionSchema.parse({...item,expected_version:1});this.insert(item);}
   db.prepare('UPDATE publishing_settings SET version=version+?,legacy_import_sha256=?,imported_at=?,diagnostic_claims=? WHERE workspace_id=?').run(input.connections.length?1:0,input.sha256,this.now(),canonicalJson(input.diagnosticClaims??null),w);
  });
 }
 private selected(input:{account_id:string;platform:Platform;format:ContentFormat}):ConnectionRow {
  const row=connectionRows(this.context.db,this.context.identity.workspace_id).find(row=>row.account_id===input.account_id&&row.platform===input.platform&&(PUBLISHING_FORMATS_BY_PLATFORM[row.platform] as readonly string[]).includes(input.format));if(!row)throw new ContractError('CAPABILITY_UNVERIFIED','该账号尚无发布连接');return row;
 }
 bindingForNew(input:{account_id:string;platform:Platform;format:ContentFormat}):PublisherBinding {
  const row=this.selected(input);this.assertWrite(row,input.format,'submit');const candidate=this.candidates.get(this.key(row.id,row.config_revision,this.runtime.scope(row.route)))!;const binding=candidate.bindings.find(binding=>binding.format===input.format);if(!binding)throw new ContractError('CAPABILITY_UNVERIFIED','该形式尚无发布绑定');return binding;
 }
 freezeIntentBinding(intent:string,input:{account_id:string;platform:Platform;format:ContentFormat}):void {
  const row=this.selected(input);this.assertWrite(row,input.format,'submit');const saved=revisionRow(this.context.db,this.context.identity.workspace_id,row.id,row.active_config_revision!);freezeBindingScope(this.context.db,this.context.identity.workspace_id,intent,{connection_id:row.id,config_revision:row.active_config_revision!,account_id:row.account_id,platform:row.platform,format:input.format,platform_account_id:saved.platform_account_id,adapter_version:row.adapter_version!,host_id:row.host_id!},this.now());
 }
 private assertWrite(row:ConnectionRow,format:ContentFormat,operation:'prepareDraft'|'submit'):void{
  if(row.enabled!==1)throw new ContractError('CAPABILITY_UNVERIFIED','发布连接已停用');this.configured(row);const capability=this.capabilities(row).find(capability=>capability.format===format&&capability.operation===operation);if(capability?.status!=='supported')throw new ContractError('CAPABILITY_UNVERIFIED','当前发布操作尚无匹配的真实验证证据');
 }
 private historical(intent:string,input:{account_id:string;platform:Platform;format:ContentFormat}):{scope:FrozenBindingScope;row:ConnectionRow;binding:PublisherBinding}{
  const scope=bindingScope(this.context.db,this.context.identity.workspace_id,intent);if(!scope||scope.account_id!==input.account_id||scope.platform!==input.platform||scope.format!==input.format)throw new ContractError('CAPABILITY_UNVERIFIED','历史发送绑定缺失，请补齐原账号配置后核对');const row=connectionRow(this.context.db,this.context.identity.workspace_id,scope.connection_id);let snapshot:PublishingRuntimeSnapshot;
  try{snapshot=this.snapshot(row,scope.config_revision,scope);}catch(error){if(error instanceof ContractError&&error.code==='VALIDATION_ERROR')throw new ContractError('AUTH_REQUIRED','请重新登记原账号凭据引用并重启后核对');throw error;}
  if(snapshot.platform_account_id!==scope.platform_account_id||!this.runtime.credentialReady(snapshot.credential_ref,snapshot.account_id))throw new ContractError('AUTH_REQUIRED','请补齐原账号凭据后核对');const candidate=this.candidates.get(this.key(row.id,scope.config_revision,scope)),binding=candidate?.bindings.find(binding=>binding.format===scope.format);if(!binding)throw new ContractError('CAPABILITY_UNVERIFIED','原适配器版本或宿主绑定不可恢复');return {scope,row,binding};
 }
 bindingForIntent(intent:string,input:{account_id:string;platform:Platform;format:ContentFormat}):PublisherBinding{return this.historical(intent,input).binding;}
 beforeInvoke(intent:string,input:{account_id:string;platform:Platform;format:ContentFormat},operation:'prepareDraft'|'submit'|'queryResult'):FrozenBindingScope{
  const {scope,row}=this.historical(intent,input);if(operation!=='queryResult'){this.assertWrite(row,input.format,operation);if(row.active_config_revision!==scope.config_revision||row.adapter_version!==scope.adapter_version||row.host_id!==scope.host_id)throw new ContractError('CAPABILITY_UNVERIFIED','历史继续发送需要原配置修订重新核对');}
  else {const capability=this.capabilities(row,scope.config_revision,scope,false).find(capability=>capability.format===input.format&&capability.operation==='queryResult');if(capability?.status!=='supported')throw new ContractError('CAPABILITY_UNVERIFIED','原账号查询能力尚无匹配证据');}return scope;
 }
 async invokeExternal<T>(intent:string,input:{account_id:string;platform:Platform;format:ContentFormat},operation:'prepareDraft'|'submit'|'queryResult',action:()=>Promise<T>):Promise<{result?:T;error?:unknown;writes:number;blocked:boolean}>{
  const boundary={intent,input,operation,scope:this.beforeInvoke(intent,input,operation),writes:0,blocked:false};
  return this.externalBoundary.run(boundary,async()=>{try{return {result:await action(),writes:boundary.writes,blocked:boundary.blocked};}catch(error){return {error,writes:boundary.writes,blocked:boundary.blocked};}});
 }
}
