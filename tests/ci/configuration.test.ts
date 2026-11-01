import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,lstatSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fixture as documentFixture} from '../documents/harness.ts';
import {fixture as metricFixture,ownWork,adapter,target} from '../metrics/harness.ts';
import {ConfigurationSettings,operatingPreferences} from '../../packages/domain/src/settings/configuration.ts';
import {DailyPlans} from '../../packages/domain/src/daily-plans/index.ts';
import {Metrics} from '../../packages/domain/src/metrics/index.ts';
import {DEFAULT_OPERATING_PREFERENCES,SaveOperatingPreferencesSchema} from '../../packages/contracts/src/index.ts';
import {createConfigurationModule} from '../../apps/service/src/routes/configuration.ts';
import {saveLocalCredential,readLocalCredential,localCredentialPath} from '../../apps/service/src/bootstrap/configuration/credentials.ts';
import {runConfigurationProbe} from '../../packages/domain/src/settings/process-probe.ts';
import {startCollectionSetup} from '../../scripts/runtime/collection-setup.ts';
import {resolveWorkbenchRoute} from '../../packages/host-bridge/src/core/tools.ts';
import {createPublishingRuntime} from '../../apps/service/src/bootstrap/publishing-runtime.ts';

function handlers(context:ReturnType<typeof documentFixture>['context'],options:Parameters<typeof createConfigurationModule>[1]={}){
 const routes=new Map<string,any>();const module=createConfigurationModule(context(),options);module.register({register:r=>routes.set(r.method+' '+r.path,r)});
 return {module,call:(method:string,path:string,request:ReturnType<ReturnType<typeof documentFixture>['request']>,body?:unknown)=>{const r=routes.get(method+' '+path);assert.ok(r);return r.handle({context:request,params:{},query:new URLSearchParams(),headers:{},body:r.schema?r.schema.parse(body):body});}};
}
test('配置持久化、幂等与冲突；每日预算和观察任务实际读取所选设置',async()=>{
 const f=metricFixture();try{
  const configuration=new ConfigurationSettings(f.context()),request=f.request(),input={expected_version:1,preferences:{...DEFAULT_OPERATING_PREFERENCES,daily_budget_min:90,retro_days:14,observation_hours:[72]}};
  const saved=configuration.save(request,input);assert.equal(saved.version,2);assert.deepEqual(configuration.save(request,input),saved);assert.throws(()=>configuration.save(f.request(),input),{code:'VERSION_CONFLICT'});
  assert.equal(new DailyPlans(f.context()).overview(f.request()).budget_min,90);
  const work=await ownWork(f,{published_at:'2026-10-12T00:00:00Z'}),metrics=new Metrics(f.context(),{adapter:adapter([target(work)],async()=>{throw new Error('must_not_fetch');})});const jobs=metrics.scheduleWindows();assert.equal(jobs.length,1);assert.equal(jobs[0]!.target_window,72*3600);assert.equal(jobs[0]!.work_id,work.work_id);
  configuration.save(f.request(),{expected_version:2,preferences:{...input.preferences,auto_observation:false}});assert.deepEqual(metrics.scheduleWindows(),[]);assert.equal(f.context().db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='metrics_collect'").get()!.n,1);
  f.reopen();assert.equal(operatingPreferences(f.context().db,f.config.workspace_id).retro_days,14);assert.equal(operatingPreferences(f.context().db,f.config.workspace_id).daily_budget_min,90);
  assert.throws(()=>SaveOperatingPreferencesSchema.parse({expected_version:3,preferences:{...input.preferences,observation_hours:[72,72]}}),{code:'VALIDATION_ERROR'});
 }finally{f.cleanup();}
});
test('只有展示号时保存登记资料；补主页后登记 pending 账号，不伪造内部身份',async()=>{
 const f=documentFixture();try{const h=handlers(f.context),path='/api/v1/settings/configuration/accounts',body={platform:'douyin',name:'本人',display_id:'68551128952',url:null},req=f.request();
  const saved=await h.call('POST',path,req,body);assert.equal(saved.body.identity_status,'registration_only');assert.equal(f.context().db.prepare('SELECT COUNT(*) n FROM accounts').get()!.n,0);assert.deepEqual(await h.call('POST',path,req,body),saved);
  const snapshot=(await h.call('GET','/api/v1/settings/configuration',f.request())).body;assert.equal(snapshot.accounts[0].display_id,'68551128952');assert.equal(snapshot.accounts[0].platform_account_id,null);
  const registered=await h.call('POST',path,f.request(),{...body,url:'https://www.douyin.com/user/fixture-sec-uid',account_id:saved.body.account_id,expected_updated_at:snapshot.accounts[0].updated_at});assert.equal(registered.body.identity_status,'pending');const account=f.context().db.prepare('SELECT * FROM accounts').get()!;assert.equal(account.platform_account_id,null);assert.equal(account.identity_status,'pending');
  assert.throws(()=>h.call('POST',path,f.request(),{...body,url:'https://x.com/wrong-platform'}),{code:'VALIDATION_ERROR'});
 }finally{f.cleanup();}
});
test('账号登记保护已核对身份、工作区归属与并发修改',async()=>{
 const f=documentFixture();try{const db=f.context().db,id=randomUUID();db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'x','123','owner','本人','https://x.com/owner','confirmed')").run(id,f.config.workspace_id);const row=db.prepare('SELECT updated_at FROM accounts WHERE id=?').get(id)!,h=handlers(f.context),path='/api/v1/settings/configuration/accounts',body={platform:'x',name:'本人',display_id:'owner',url:'https://x.com/owner',account_id:id,expected_updated_at:String(row.updated_at)};
  assert.throws(()=>h.call('POST',path,f.request(),{...body,expected_updated_at:'old'}),{code:'VERSION_CONFLICT'});assert.throws(()=>h.call('POST',path,f.request(),{...body,url:'https://x.com/other'}),{code:'VALIDATION_ERROR'});assert.throws(()=>h.call('POST',path,f.request(),{...body,account_id:'foreign'}),{code:'NOT_FOUND'});assert.equal(db.prepare('SELECT platform_account_id FROM accounts WHERE id=?').get(id)!.platform_account_id,'123');
 }finally{f.cleanup();}
});
test('模型列表检查验证认证，不暴露 API Key，不调用生成或自动回退',async()=>{
 const f=documentFixture();try{saveLocalCredential(f.config.paths.state_root,'openai','TEST_PRIVATE_SENTINEL');let calls=0;const apiFetch=(async(url:any,init:any)=>{calls++;assert.equal(url,'https://api.openai.com/v1/models');assert.equal(init.method??'GET','GET');assert.equal(init.headers.Authorization,'Bearer TEST_PRIVATE_SENTINEL');assert.equal(init.redirect,'error');return new Response(JSON.stringify({data:[{id:'fixture-model'}],reflected_secret:'TEST_PRIVATE_SENTINEL'}));}) as typeof fetch,h=handlers(f.context,{apiFetch}),path='/api/v1/settings/configuration/checks',req=f.request();const result=await h.call('POST',path,req,{tool:'openai'});assert.equal(result.body.status,'passed');assert.equal(result.body.details.model_count,1);assert.deepEqual(await h.call('POST',path,req,{tool:'openai'}),result);assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('TEST_PRIVATE_SENTINEL'));const snapshot=(await h.call('GET','/api/v1/settings/configuration',f.request())).body;assert.ok(!JSON.stringify(snapshot).includes('TEST_PRIVATE_SENTINEL'));assert.equal(snapshot.tools.api_credentials.openai,true);assert.equal(f.context().db.prepare('SELECT api_fallback_enabled FROM workspaces').get()!.api_fallback_enabled,0);
 }finally{f.cleanup();}
});
test('执行器检查过滤不可信诊断，不把登录或检查当作 Skill 执行',async()=>{
 const f=documentFixture();try{const base=f.context(),h=handlers(()=>({...base,getExecutorHealth:async()=>[{executor_id:'codex',status:'degraded',runtime_version:'secret-canary-version',auth_state:'secret-canary-auth',billing_route:'secret-canary-route',limitations:['secret-canary-error']}]}));const result=await h.call('POST','/api/v1/settings/configuration/checks',f.request(),{tool:'executors'});assert.equal(result.body.status,'failed');assert.ok(!JSON.stringify(result).includes('secret-canary'));}finally{f.cleanup();}
});
test('相同检查请求并发只读取一次；不同输入不能复用检查 key',async()=>{
 const f=documentFixture();try{
  saveLocalCredential(f.config.paths.state_root,'openai','TEST_PRIVATE_SENTINEL');let calls=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),apiFetch=(async()=>{calls++;await gate;return new Response('{"data":[]}');}) as typeof fetch,h=handlers(f.context,{apiFetch}),req=f.request(),path='/api/v1/settings/configuration/checks';
  const first=h.call('POST',path,req,{tool:'openai'}),second=h.call('POST',path,req,{tool:'openai'});
  await Promise.resolve();assert.equal(calls,1);await assert.rejects(h.call('POST',path,req,{tool:'anthropic'}),{code:'IDEMPOTENCY_CONFLICT'});release();assert.deepEqual(await first,await second);
 }finally{f.cleanup();}
});
test('各本人账号分别保存发布凭据，更新另一账号不会覆盖或冒充已就绪',()=>{
 const f=documentFixture();try{
  const db=f.context().db,ids=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];for(const [i,id] of ids.entries())db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'x',?,'owner',? ,?,'confirmed')").run(id,f.config.workspace_id,String(i+1),'本人'+i,'https://x.com/owner'+i);
  saveLocalCredential(f.config.paths.state_root,'x','FIRST_TOKEN',ids[0]);const runtime=createPublishingRuntime(f.context(),{env:{WORKBENCH_LOCAL_SETTINGS_ENABLED:'1'}}),ref={kind:'environment' as const,name:'WORKBENCH_X_CREDENTIALS'};
  assert.equal(runtime.credentialReady(ref,ids[0]),true);assert.equal(runtime.credentialReady(ref,ids[1]),false);
  saveLocalCredential(f.config.paths.state_root,'x','SECOND_TOKEN',ids[1]);assert.equal(readLocalCredential(f.config.paths.state_root,'x',ids[0],f.config.workspace_id),'FIRST_TOKEN');assert.equal(readLocalCredential(f.config.paths.state_root,'x',ids[1],f.config.workspace_id),'SECOND_TOKEN');assert.equal(runtime.credentialReady(ref,ids[2]),false);assert.equal(readLocalCredential(f.config.paths.state_root,'x',ids[0],'foreign-workspace'),null);
  for(const id of ids.slice(0,3))saveLocalCredential(f.config.paths.state_root,'x','A'.repeat(4096),id);assert.throws(()=>saveLocalCredential(f.config.paths.state_root,'x','B'.repeat(4096),ids[3]),/配置过大/);assert.equal(readLocalCredential(f.config.paths.state_root,'x',ids[0],f.config.workspace_id),'A'.repeat(4096));assert.equal(readLocalCredential(f.config.paths.state_root,'x',ids[3],f.config.workspace_id),null);
 }finally{f.cleanup();}
});
test('阻塞文件检查有期限，父进程仍响应且无悬挂检查进程', {skip:process.platform==='win32'},async()=>{
 const f=documentFixture();try{const fifo=join(f.root,'unavailable-nas');execFileSync('mkfifo',[fifo]);const script=join(f.root,'read.mjs');writeFileSync(script,"import {readFileSync} from 'node:fs';readFileSync("+JSON.stringify(fifo)+");process.stdout.write('{}');");let responsive=false;const probe=runConfigurationProbe(new URL('file://'+script),{},350);await new Promise<void>(r=>setTimeout(()=>{responsive=true;r();},30));assert.equal(responsive,true);await assert.rejects(probe,{code:'CAPABILITY_UNVERIFIED'});}finally{f.cleanup();}
});
test('OpenAI/Claude/X 本机凭据入口支持安全填写、替换和账号绑定', {skip:process.platform!=='darwin'},async()=>{
 const f=documentFixture(),setup=await startCollectionSetup(f.config.paths.state_root,0);try{
  const id=randomUUID();f.context().db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'x','123','owner','fixture owner','https://x.com/owner','confirmed')").run(id,f.config.workspace_id);
  for(const kind of ['openai','anthropic','x'] as const){const html=await(await fetch(setup.url+'/?kind='+kind)).text(),csrf=html.match(/'X-Setup-CSRF':"([a-f0-9]+)"/)![1]!;const input={key:'PRIVATE_'+kind,...(kind==='x'?{account_id:id}:{})};const post=(origin:string)=>fetch(setup.url+'/credential?kind='+kind,{method:'POST',headers:{Origin:origin,'X-Setup-CSRF':csrf,'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal((await post('https://other.invalid')).status,403);assert.equal((await post(setup.url)).status,200);assert.equal(readLocalCredential(f.config.paths.state_root,kind,kind==='x'?id:undefined,f.config.workspace_id),'PRIVATE_'+kind);assert.equal(lstatSync(localCredentialPath(f.config.paths.state_root,kind)).mode&0o777,0o600);assert.ok(!(await(await fetch(setup.url+'/?kind='+kind)).text()).includes('PRIVATE_'+kind));}
  assert.equal(readLocalCredential(f.config.paths.state_root,'x','another-owner',f.config.workspace_id),null);assert.equal(readLocalCredential(f.config.paths.state_root,'x',id,'another-workspace'),null);
 }finally{await setup.close();f.cleanup();}
});
test('共用 MCP 桥接映射配置、检查、账号和声音的同一正式接口',()=>{
 for(const [method,path,body] of [['GET','/api/v1/settings/configuration',undefined],['PUT','/api/v1/settings/configuration',{expected_version:1,preferences:DEFAULT_OPERATING_PREFERENCES}],['POST','/api/v1/settings/configuration/checks',{tool:'storage'}],['POST','/api/v1/settings/configuration/accounts',{platform:'x',name:'owner',display_id:'owner',url:'https://x.com/owner'}]] as const){const mapped=resolveWorkbenchRoute(method,path,body,{idempotencyKey:randomUUID()});assert.ok(mapped.name);}
});
