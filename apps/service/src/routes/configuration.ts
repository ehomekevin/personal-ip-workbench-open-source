import {ImageProviderSettings,type ImageProviderSettingsOptions} from '@workbench/domain/settings';
import {SaveImageProviderSettingsSchema} from '@workbench/contracts';
import { readFileSync,existsSync,lstatSync,renameSync,unlinkSync,copyFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { spawn,type ChildProcess } from 'node:child_process';
import { ConfigurationCheckSchema,SaveOperatingPreferencesSchema,SaveVoiceConfigurationSchema,ExecutorLoginSchema,SaveOwnerAccountConfigurationSchema,DiscoverOwnerAccountSchema,SaveApiFallbackSchema,ContractError,type ConfigurationSnapshot,type ConfigurationCheck,type JsonObject,type RequestContext } from '@workbench/contracts';
import type { ApplicationContext,ApplicationModule } from '@workbench/domain/ports';
import { ConfigurationSettings,operatingPreferences } from '../../../../packages/domain/src/settings/configuration.ts';
import { runConfigurationProbe } from '../../../../packages/domain/src/settings/process-probe.ts';
import { workspaceSettings } from '@workbench/storage/settings';
import { readCommittedIdempotent,storeIdempotent } from '@workbench/storage/revisions';
import { transaction,claimIdempotency } from '@workbench/storage/connection';
import { Sources } from '@workbench/domain/sources';
import { PERSONAL_SITE_STREAMS,PersonalSiteAdapter } from '@workbench/adapters/personal-site';
import { H3VoiceWorkflow } from '@workbench/domain/artifact-execution';
import { createCollectionRuntime } from '../bootstrap/collection-runtime.ts';
import { safeExecutor } from '@workbench/domain/settings';
import { readLocalCredential } from '../bootstrap/configuration/credentials.ts';
import {AccountChecks} from '../../../../packages/domain/src/sources/account-checks.ts';
import type {TikHubAdapter} from '@workbench/adapters/tikhub';
import {apiModels} from '../../../../packages/adapters/src/agent/api.ts';
import {readApiFallback,apiFallbackKey} from '../../../../packages/domain/src/settings/api-fallback.ts';
import {BenchmarkSync} from '../../../../packages/domain/src/sources/benchmark-sync.ts';

export function createConfigurationModule(context:ApplicationContext,options:{apiFetch?:typeof fetch;collectionAdapter?:TikHubAdapter;imageProviders?:ImageProviderSettingsOptions}={}):ApplicationModule {
  const configuration=new ConfigurationSettings(context),sources=new Sources(context),voice=new H3VoiceWorkflow(context),logins=new Map<string,ChildProcess>();
  const checksInFlight=new Map<string,Promise<ConfigurationCheck>>();
  let timer:ReturnType<typeof setInterval>|undefined,closed=false,savingVoice=false;
  const request=(key:string)=>({...context.identity,request_id:randomUUID(),idempotency_key:key,request_identity_ref:null});
  const profilePath=process.env.WORKBENCH_H3_VOICE_PROFILE??join(context.paths.state_root,'h3-voice-profile.json');
  function h3(){try{const info=lstatSync(profilePath);if(!info.isFile()||info.isSymbolicLink()||info.size>65536)throw new Error();const c=JSON.parse(readFileSync(profilePath,'utf8'));return {endpoint:String(c.endpoint??''),reference_path:String(c.reference_path??''),reference_filename:String(c.reference_filename??''),configured:true};}catch{return {endpoint:'',reference_path:'',reference_filename:'',configured:false};}}
  function present(kind:'tikhub'|'openai'|'anthropic'){try{return !!readLocalCredential(context.paths.state_root,kind,undefined,context.identity.workspace_id);}catch{return false;}}
  function snapshot(r:RequestContext):ConfigurationSnapshot{
    const accounts:JsonObject[]=context.db.prepare("SELECT id,platform,name,canonical_url,platform_account_id,identity_status,updated_at FROM accounts WHERE workspace_id=? AND role='owner' ORDER BY platform,created_at,id").all(r.workspace_id).map(a=>{const intake=context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get('account-intake.v1:'+r.workspace_id+':'+a.id);return {...a,record_type:'account',display_id:intake?JSON.parse(String(intake.value)).display_id:''};});
    for(const row of context.db.prepare('SELECT value FROM application_metadata WHERE key LIKE ?').all('account-registration.v1:'+r.workspace_id+':%')){const registration=JSON.parse(String(row.value));if(!accounts.some(a=>a.platform===registration.platform))accounts.push(registration);}
    const benchmarkSync=new BenchmarkSync(context,options.collectionAdapter??createCollectionRuntime(context));
    const benchmarks=sources.accounts(r,{role:'benchmark'}).items.map(a=>({...a,sync:benchmarkSync.status(r,a.id)}));
    return {identity:context.identity,...configuration.get(r),api_fallback:readApiFallback(context.db,r.workspace_id),tools:{tikhub_configured:present('tikhub'),credential_entry_url:process.env.WORKBENCH_COLLECTION_SETUP_ENABLED==='1'?'http://127.0.0.1:5190/':null,api_credentials:{openai:present('openai'),anthropic:present('anthropic')},h3:h3()},accounts:accounts as JsonObject[],benchmarks:benchmarks as unknown as JsonObject[]};
  }
  const automaticSync=()=>{
    if(closed)return;const preferences=operatingPreferences(context.db,context.identity.workspace_id);if(!preferences.personal_site_auto_sync)return;
    for(const source of context.db.prepare("SELECT id,last_sync_at FROM sources WHERE workspace_id=? AND kind='personal_site' AND external_id='creator-feed'").all(context.identity.workspace_id)){
      if(source.last_sync_at&&Date.now()-Date.parse(String(source.last_sync_at))<preferences.personal_site_sync_min*60000)continue;
      const latest=context.db.prepare("SELECT state,created_at FROM jobs WHERE workspace_id=? AND kind='source_sync' AND target_id=? ORDER BY created_at DESC LIMIT 1").get(context.identity.workspace_id,source.id);
      if(latest&&(['queued','running','reconciling'].includes(String(latest.state))||Date.now()-Date.parse(String(latest.created_at))<preferences.personal_site_sync_min*60000))continue;
      const interval=Math.floor(Date.now()/(preferences.personal_site_sync_min*60000));sources.sync(request('auto-site:'+source.id+':'+preferences.personal_site_sync_min+':'+interval),String(source.id),{});
    }
  };
  async function check(tool:string):Promise<ConfigurationCheck>{
    const checked_at=new Date().toISOString(),base={tool,checked_at,details:{settings_version:workspaceSettings(context.db,context.identity.workspace_id).version} as JsonObject};
    try{
      if(tool==='executors'){const executors=(await context.getExecutorHealth(true)).map(safeExecutor);const usable=executors.filter(e=>e.auth_state==='subscription_authenticated');const label=(state:string)=>state==='subscription_authenticated'?'订阅登录已核对':state==='AUTH_REQUIRED'?'需要登录或核对订阅路线':state==='QUOTA_EXHAUSTED'?'订阅额度受限':'连接尚未确认，请核对工具安装与登录';return {...base,status:usable.length===2?'passed':usable.length?'partial':'failed',message:executors.map(e=>(e.executor_id==='codex'?'Codex':'Claude')+'：'+label(e.auth_state)).join('；'),details:{...base.details,executors:executors as unknown as JsonObject[]}};}
      if(tool==='storage'){const paths=workspaceSettings(context.db,context.identity.workspace_id).paths,details=await runConfigurationProbe<JsonObject>(new URL('../../../../packages/domain/src/settings/path-probe.ts',import.meta.url),{paths,check:true});return {...base,status:paths.source_vault_root?'passed':'partial',message:paths.source_vault_root?'源库可读，工作台目录可读写':'工作台目录可读写；Obsidian 源库尚未连接',details:{...base.details,...details}};}
      if(tool==='h3'){const status=await voice.readiness(request('check-voice'));return {...base,status:status.status==='ready'?'passed':status.status==='unconfigured'?'unconfigured':'failed',message:status.message,details:{...base.details,status:status.status,running:status.running,pending:status.pending}};}
      if(tool==='personal_site'){const results=await Promise.all((['creator-feed'] as const).map(async stream=>{const batch=await new PersonalSiteAdapter({stream,rawRoot:join(context.paths.state_root,'configuration-checks')}).fetchBatch(null,AbortSignal.timeout(8000));return {stream,count:batch.records.length};}));return {...base,status:'passed',message:'个人站创作候选可读取；对标采集由工作台直接使用 TikHub',details:{...base.details,streams:results,benchmark_collection:'local_tikhub'}};}
      if(tool==='tikhub'){const adapter=createCollectionRuntime(context);if(!adapter.credentialPresent())return {...base,status:'unconfigured',message:'先填写 TikHub 密钥'};const account=context.db.prepare("SELECT canonical_url,platform_account_id FROM accounts WHERE workspace_id=? AND role='owner' AND platform='x' AND identity_status='confirmed' ORDER BY created_at,id LIMIT 1").get(context.identity.workspace_id);if(!account)return {...base,status:'partial',message:'密钥已保存；先登记并核对一个本人 X 账号'};const result=await adapter.resolveAccount(String(account.canonical_url));if(result.platform_account_id!==account.platform_account_id)throw new Error();return {...base,status:'passed',message:'TikHub 已通过本人 X 账号读取检查；其他平台分别核对'};}
      const kind=tool as 'openai'|'anthropic',key=readLocalCredential(context.paths.state_root,kind,undefined,context.identity.workspace_id);if(!key)return {...base,status:'unconfigured',message:'先填写独立 API Key'};
      const models=await apiModels(kind,key,options.apiFetch);return {...base,status:'passed',message:'API 认证和模型列表读取通过；生成能力将在实际任务中核对',details:{...base.details,models,model_count:models.length}};
    }catch{return {...base,status:'failed',message:'检查未完成，请核对网络、文件或认证后重试；已有配置保留'};}
  }
  return {id:'configuration',initialize(){timer=setInterval(()=>{try{automaticSync();}catch{/* next scheduled check can retry */}},30000);timer.unref();},close(){closed=true;if(timer)clearInterval(timer);for(const child of logins.values())child.kill('SIGTERM');},register(registrar){
    const images=new ImageProviderSettings(context,options.imageProviders),verifying=new Map<string,Promise<unknown>>();
    registrar.register({method:'GET',path:'/api/v1/settings/image-providers',owner:'IMAGE-PROVIDER-AGY-INTEGRATION',handle:async r=>({body:await images.read(r.context)})});
    registrar.register({method:'PUT',path:'/api/v1/settings/image-providers',owner:'IMAGE-PROVIDER-AGY-INTEGRATION',mutation:true,idempotent:true,schema:SaveImageProviderSettingsSchema,handle:async r=>{images.save(r.context,r.body);return {body:await images.read(r.context)};}});
    // 只读连接验证：同一渠道同时只跑一次探测，重复点击复用进行中的结果；不生图、不计预算。
    registrar.register({method:'POST',path:'/api/v1/settings/image-providers/{id}/verify',owner:'IMAGE-PROVIDER-AGY-INTEGRATION',mutation:true,handle:async r=>{const provider=r.params.id!;if(provider!=='agy'&&provider!=='codex')throw new ContractError('NOT_FOUND','图像渠道不存在');
      let running=verifying.get(provider);if(!running){running=images.verify(r.context,provider).finally(()=>verifying.delete(provider));verifying.set(provider,running);}await running;return {body:await images.read(r.context)};}});
    registrar.register({method:'GET',path:'/api/v1/settings/configuration',owner:'CONFIG-01',handle:r=>({body:snapshot(r.context)})});
    registrar.register({method:'PUT',path:'/api/v1/settings/configuration',owner:'CONFIG-01',mutation:true,idempotent:true,schema:SaveOperatingPreferencesSchema,handle:r=>{configuration.save(r.context,r.body);return {body:snapshot(r.context)};}});
    registrar.register({method:'PUT',path:'/api/v1/settings/configuration/api-fallback',owner:'CONFIG-02',mutation:true,idempotent:true,schema:SaveApiFallbackSchema,handle:async r=>{
      const op='configuration.api-fallback',replay=readCommittedIdempotent<ConfigurationSnapshot>(context.db,r.context,op,r.body);if(replay)return {body:replay};
      if(r.body.enabled){const key=readLocalCredential(context.paths.state_root,r.body.provider,undefined,r.context.workspace_id);if(!key)throw new ContractError('AUTH_REQUIRED','先填写独立 API Key');const models=await apiModels(r.body.provider,key,options.apiFetch);if(!models.includes(r.body.model))throw new ContractError('CAPABILITY_UNVERIFIED','此 Key 的模型列表中没有所选模型');}
      return transaction(context.db,()=>{const done=readCommittedIdempotent<ConfigurationSnapshot>(context.db,r.context,op,r.body);if(done)return {body:done};const settings=workspaceSettings(context.db,r.context.workspace_id);if(settings.version!==r.body.expected_version)throw new ContractError('VERSION_CONFLICT','设置已变化，请刷新核对');const {expected_version,enabled,...route}=r.body;
       context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(apiFallbackKey(r.context.workspace_id),JSON.stringify(route));context.db.prepare('UPDATE workspaces SET api_fallback_enabled=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(enabled?1:0,new Date().toISOString(),r.context.workspace_id,expected_version);const result=snapshot(r.context);storeIdempotent(context.db,r.context,op,r.body,result);return {body:result};});
    }});
    registrar.register({method:'POST',path:'/api/v1/settings/configuration/accounts/discover',owner:'CONFIG-02',mutation:true,idempotent:true,schema:DiscoverOwnerAccountSchema,handle:async r=>{
      const operation='configuration.account.discover',replay=readCommittedIdempotent<JsonObject>(context.db,r.context,operation,r.body);if(replay)return {body:replay};
      const key='account-registration.v1:'+r.context.workspace_id+':'+r.body.platform,read=()=>{const row=context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key);if(!row)throw new ContractError('NOT_FOUND','先保存账号展示号');return JSON.parse(String(row.value));},registered=read();
      if(registered.updated_at!==r.body.expected_updated_at)throw new ContractError('VERSION_CONFLICT','账号登记已变化，请刷新核对');
      const profile=await (options.collectionAdapter??createCollectionRuntime(context)).discoverAccount(r.body.platform,registered.display_id);
      if(read().updated_at!==registered.updated_at)throw new ContractError('VERSION_CONFLICT','查询期间账号登记已变化，未采用旧展示号');
      const derive=(suffix:string)=>({...r.context,idempotency_key:'configuration-discover:'+suffix+':'+createHash('sha256').update(r.context.workspace_id+':'+r.context.idempotency_key).digest('hex')});
      const created=sources.createAccount(derive('register'),{platform:r.body.platform,role:'owner',name:registered.name,url:profile.canonical_url});
      const verified=await new AccountChecks(context,{resolveAccount:async url=>{if(url!==profile.canonical_url)throw new ContractError('INPUT_STALE','账号主页已变化');return profile;}}).check(derive('verify'),created.account_id);
      transaction(context.db,()=>{context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('account-intake.v1:'+r.context.workspace_id+':'+created.account_id,JSON.stringify({display_id:profile.display_id}));storeIdempotent(context.db,r.context,operation,r.body,verified);});return {body:verified};
    }});
    registrar.register({method:'POST',path:'/api/v1/settings/configuration/accounts',owner:'CONFIG-01',mutation:true,idempotent:true,schema:SaveOwnerAccountConfigurationSchema,handle:r=>{
      const replay=readCommittedIdempotent<JsonObject>(context.db,r.context,'configuration.account',r.body);if(replay)return {body:replay};
      const input=r.body,hosts:Record<string,string[]>={x:['x.com','twitter.com'],wechat:['mp.weixin.qq.com'],douyin:['douyin.com','www.douyin.com','v.douyin.com'],bilibili:['space.bilibili.com'],xiaohongshu:['xiaohongshu.com','www.xiaohongshu.com','xhslink.com']};let url:string|null=null;
      if(!input.name.trim())throw new ContractError('VALIDATION_ERROR','请填写账号名称');
      if(input.account_id?.startsWith('registration:')&&input.account_id!=='registration:'+input.platform)throw new ContractError('VALIDATION_ERROR','登记账号的平台不符');
      if(input.url){try{const parsed=new URL(input.url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||!hosts[input.platform]!.includes(parsed.hostname))throw new Error();parsed.hash='';url=parsed.toString();}catch{throw new ContractError('VALIDATION_ERROR','请输入所选平台的 HTTPS 主页或公众号文章链接');}}
      const registrationKey='account-registration.v1:'+r.context.workspace_id+':'+input.platform;
      if(!url){
        const result=transaction(context.db,()=>{
          if(input.account_id&&!input.account_id.startsWith('registration:'))throw new ContractError('VALIDATION_ERROR','已有账号的主页链接不能清空，请保留原链接');
          const existing=context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(registrationKey),old=existing?JSON.parse(String(existing.value)):null;
          if(input.account_id&&(!old||old.updated_at!==input.expected_updated_at))throw new ContractError('VERSION_CONFLICT','账号登记已改变，请刷新后核对');
          const id='registration:'+input.platform,data={id,platform:input.platform,name:input.name.trim(),display_id:input.display_id.trim(),canonical_url:null,platform_account_id:null,identity_status:'registration_only',record_type:'intake',updated_at:new Date().toISOString()};
          context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(registrationKey,JSON.stringify(data));const output={account_id:id,identity_status:'registration_only'};storeIdempotent(context.db,r.context,'configuration.account',r.body,output);return output;
        });return {body:result};
      }
      const accountId=input.account_id?.startsWith('registration:')?undefined:input.account_id;
      const result=transaction(context.db,()=>{const existing=accountId?context.db.prepare("SELECT * FROM accounts WHERE workspace_id=? AND id=? AND role='owner'").get(r.context.workspace_id,accountId):url?context.db.prepare("SELECT * FROM accounts WHERE workspace_id=? AND platform=? AND canonical_url=? AND role='owner'").get(r.context.workspace_id,input.platform,url):null;
        if(accountId&&!existing)throw new ContractError('NOT_FOUND','本人账号不属于当前工作区');if(existing&&existing.platform!==input.platform)throw new ContractError('VALIDATION_ERROR','账号的平台不能改动');
        if(existing&&accountId&&input.expected_updated_at!==existing.updated_at)throw new ContractError('VERSION_CONFLICT','账号登记已被修改，请刷新并核对');
        if(existing&&existing.identity_status==='confirmed'&&url!==existing.canonical_url)throw new ContractError('VALIDATION_ERROR','已核对账号的身份链接不能直接替换，请登记新的账号');
        const id=existing?String(existing.id):randomUUID();if(existing)context.db.prepare('UPDATE accounts SET name=?,canonical_url=?,updated_at=? WHERE workspace_id=? AND id=?').run(input.name.trim(),url,new Date().toISOString(),r.context.workspace_id,id);else context.db.prepare("INSERT INTO accounts(id,workspace_id,platform,role,name,canonical_url,identity_status) VALUES(?,?,?,'owner',?,?,'pending')").run(id,r.context.workspace_id,input.platform,input.name.trim(),url);
        context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('account-intake.v1:'+r.context.workspace_id+':'+id,JSON.stringify({display_id:input.display_id.trim()}));const out={account_id:id,identity_status:existing?String(existing.identity_status):'pending'};storeIdempotent(context.db,r.context,'configuration.account',r.body,out);return out;
      });return {body:result};
    }});
    registrar.register({method:'POST',path:'/api/v1/settings/configuration/checks',owner:'CONFIG-01',mutation:true,idempotent:true,schema:ConfigurationCheckSchema,handle:async r=>{
      const replay=readCommittedIdempotent<ConfigurationCheck>(context.db,r.context,'configuration.check',r.body);if(replay)return {body:replay};
      const key=r.context.workspace_id+':'+r.context.idempotency_key;
      const running=checksInFlight.get(key);if(running)return {body:await running};
      transaction(context.db,()=>claimIdempotency(context.db,r.context.workspace_id,'configuration.check',r.context.idempotency_key!,r.body));
      const pending=Promise.resolve().then(async()=>{const result=await check(r.body.tool);configuration.record(r.context,result,()=>storeIdempotent(context.db,r.context,'configuration.check',r.body,result));return result;});
      checksInFlight.set(key,pending);try{return {body:await pending};}finally{checksInFlight.delete(key);}
    }});
    registrar.register({method:'PUT',path:'/api/v1/settings/configuration/voice',owner:'CONFIG-01',mutation:true,idempotent:true,schema:SaveVoiceConfigurationSchema,handle:async r=>{
      const replay=readCommittedIdempotent<ConfigurationSnapshot>(context.db,r.context,'configuration.voice',r.body);if(replay)return {body:replay};if(savingVoice)throw new ContractError('VERSION_CONFLICT','声音配置正在保存，请稍后重试');savingVoice=true;
      const staging=join(context.paths.state_root,'.voice-profile-'+randomUUID()+'.json');
      try{await runConfigurationProbe(new URL('../bootstrap/configuration/voice-profile-worker.ts',import.meta.url),{...r.body,staging,cache:join(context.paths.state_root,'h3-inputs')});mkdirSync(join(context.paths.state_root,'backups'),{recursive:true,mode:0o700});if(existsSync(profilePath))copyFileSync(profilePath,join(context.paths.state_root,'backups','h3-profile-'+Date.now()+'.json'));renameSync(staging,profilePath);const result=snapshot(r.context);transaction(context.db,()=>storeIdempotent(context.db,r.context,'configuration.voice',r.body,result));return {body:result};}finally{savingVoice=false;if(existsSync(staging))unlinkSync(staging);}
    }});
    registrar.register({method:'POST',path:'/api/v1/settings/configuration/login',owner:'CONFIG-01',mutation:true,idempotent:true,schema:ExecutorLoginSchema,handle:async r=>{const replay=readCommittedIdempotent<JsonObject>(context.db,r.context,'configuration.login',r.body);if(replay)return {body:replay};const name=r.body.executor;if(!logins.has(name)){const child=spawn(name,name==='codex'?['login']:['auth','login'],{stdio:['ignore','ignore','ignore']});await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new ContractError('CAPABILITY_UNVERIFIED','登录工具无法启动，请检查本机安装')));});logins.set(name,child);const timeout=setTimeout(()=>{child.kill('SIGTERM');logins.delete(name);},300000);child.once('error',()=>{clearTimeout(timeout);logins.delete(name);});child.once('close',()=>{clearTimeout(timeout);logins.delete(name);});}const result={started:true,executor:name,message:'已启动本机登录，请在浏览器完成后检查执行器'};transaction(context.db,()=>storeIdempotent(context.db,r.context,'configuration.login',r.body,result));return {body:result};}});
  },health:()=>({module:'configuration',status:'ready',details:{bounded_checks:true,secret_values_exposed:false}})};
}
