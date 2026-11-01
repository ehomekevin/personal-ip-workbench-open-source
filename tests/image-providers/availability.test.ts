import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {imageProviderAvailability,type ImageProviderChannel,type ImageProviderSettingsResponse,type StudioSnapshot as ServiceStudioSnapshot,type ExecutorHealth} from '../../packages/contracts/src/index.ts';
import {imageCapabilities} from '../../packages/adapters/src/media/image/capabilities.ts';
import {projectStudioSnapshot,studioProviderOption,studioDimensionsError} from '../../apps/web/src/features/media/image-studio/model.ts';
import {ImageStudioController,type ImageStudioPort} from '../../apps/web/src/features/media/image-studio/index.ts';
import {renderSettings} from '../../apps/web/src/features/settings/settings.ts';
import {ConfigurationController} from '../../apps/web/src/features/settings/configuration.ts';
import type {FeatureContext} from '../../apps/web/src/transport/feature-ports.ts';
import {fixture,seeded,FakeImageProvider} from './harness.ts';
import {startApplication} from '../../apps/service/src/bootstrap/application.ts';
import {createConfigurationModule} from '../../apps/service/src/routes/configuration.ts';
import {createArtifactsModule} from '../../apps/service/src/routes/artifacts.ts';
import {ImageGenerationWorkflow} from '../../packages/domain/src/artifact-execution/image.ts';
import {readGenerationBudget} from '../../packages/storage/src/image-studio/index.ts';

// 生产现状（2026-10-15 读到的设置页）：两条都启用、已配置；AGY 生成/参考修改已验证，其余未验证；Codex 执行器额度耗尽。
const agy:ImageProviderChannel={provider:'agy',label:'AGY · Nano Banana 2',enabled:true,configured:true,identity:'unverified',connection:'unverified',permission:'unverified',model:'gemini-3.1-flash-image',operations:{generation:'supported',reference_edit:'supported',mask:'unverified',writing:'unverified'},last_job_id:null,last_asset_id:null,limitations:[],verification:{state:'not_run',reason:null,message:null,checked_at:null},executor:null,budget:{used:0,limit:2,remaining:2}};
const codex:ImageProviderChannel={...agy,provider:'codex',label:'Codex 图像',model:null,operations:{generation:'unverified',reference_edit:'unverified',mask:'unverified',writing:'unverified'},executor:{status:'unverified',auth_state:'QUOTA_EXHAUSTED'}};
const production:ImageProviderSettingsResponse={version:3,default_provider:'codex',channels:[agy,codex]};
const quota:ExecutorHealth={executor_id:'codex',status:'unverified',runtime_version:null,auth_state:'QUOTA_EXHAUSTED',billing_route:null,limitations:[]};
const options=(html:string)=>[...html.matchAll(/<option value="(agy|codex)"([^>]*)>([^<]*)<\/option>/g)].map(m=>({provider:m[1],disabled:/\bdisabled\b/.test(m[2]!),text:m[3]}));

test('生产现状：AGY 多项未验证但无阻塞 → 可选；Codex 执行器额度耗尽 → 禁用并标额度',()=>{
  const a=imageProviderAvailability(agy),c=imageProviderAvailability(codex);
  assert.deepEqual([a.selectable,a.block,a.unverified,a.remaining],[true,null,false,2]);
  assert.deepEqual([c.selectable,c.block,c.message],[false,'quota','额度暂不可用']);
  const ready=imageProviderAvailability({...codex,executor:{status:'unverified',auth_state:'not_checked'}});
  assert.deepEqual([ready.selectable,ready.unverified],[true,true],'unverified 只提示「未经真实验收」，不禁用');
});
test('明确阻塞：探测失败、登录失效、预算用完、未启用、未配置都禁用并给用户语言原因',()=>{
  const failed=imageProviderAvailability({...agy,verification:{state:'failed',reason:'connection',message:'连不上 AGY 服务，请检查网络后重试',checked_at:'2026-10-15T00:00:00.000Z'}});
  assert.deepEqual([failed.selectable,failed.block,failed.message,failed.detail],[false,'probe_failed','连接验证未通过','连不上 AGY 服务，请检查网络后重试']);
  assert.equal(imageProviderAvailability({...agy,verification:{state:'failed',reason:'login',message:'AGY 登录已失效',checked_at:null}}).block,'login');
  assert.equal(imageProviderAvailability({...agy,verification:{state:'inconclusive',reason:'connection',message:'未能确认',checked_at:null}}).selectable,true,'未能确认不算明确失败');
  const spent=imageProviderAvailability({...agy,budget:{used:2,limit:2,remaining:0}});assert.deepEqual([spent.selectable,spent.block,spent.message,spent.remaining],[false,'budget','本渠道真实生图次数已达上限',0]);
  assert.equal(imageProviderAvailability({...agy,enabled:false}).block,'disabled');assert.equal(imageProviderAvailability({...agy,configured:false}).block,'unconfigured');
  assert.equal(imageProviderAvailability({...codex,executor:{status:'unconfigured',auth_state:'AUTH_REQUIRED'}}).block,'login');
  assert.equal(imageProviderAvailability({...codex,executor:{status:'supported',auth_state:'subscription_authenticated'},verification:{state:'failed',reason:'quota',message:'额度暂不可用',checked_at:null}}).selectable,true,'执行器已恢复认证时旧的额度失败不再阻塞');
});

function studio(settings:ImageProviderSettingsResponse){
  const service:ServiceStudioSnapshot={topic_id:'topic',document_id:'doc',document_revision_id:'rev',article_text:'正文',article_source:'core',version:1,paragraphs:[{id:'p1',index:0,text:'第一段'}],
    slots:[{id:'slot',title:'图一',paragraph_id:'p1',placement_paragraph_id:'p1',position:'after',description:'说明',provider:'codex',size_mode:'auto',references:[],active_version_id:null,versions:[{id:'v1',operation:'generate',paragraph_id:'p1',placement_paragraph_id:'p1',position:'after',job_id:'job',asset_id:null,state:'failed',provider:'codex',description:'说明',title:'图一',size_request:{width:1600,height:900,aspect_ratio:'16:9',mode:'auto',policy:'prompt_guided'},accepted_parameters:null,actual_size:null,size_match:null,size_warning:null,references:[],parent_version_id:null,document_revision_id:'rev',created_at:'2026-10-15T00:00:00.000Z',adoption:'pending',error:null}]}],
    references:[],capabilities:[imageCapabilities('codex'),imageCapabilities('agy')],briefs:[],recording:{process_record:'pending_record_root_registration',wiki_confirmation_required:true,wiki_record:null}};
  return projectStudioSnapshot(service,[],settings);
}
function dialogFixture(snapshot:ReturnType<typeof studio>){
  const dialogs:any[]=[],panel={innerHTML:''},fields=new Map<string,any>();
  const port={load:async()=>structuredClone(snapshot)} as unknown as ImageStudioPort;
  const root={querySelector:(selector:string)=>selector==='.image-studio-panel'?panel:selector.startsWith('#')?fields.get(selector.slice(1))??null:null} as unknown as HTMLElement;
  const c={identity:{workspace_id:'avail-'+randomUUID(),service_instance_id:'svc'},ui:{topic:'topic'},signal:new AbortController().signal,drafts:{leave:async()=>{}},surface:{presentDialog:(d:any)=>dialogs.push(d),dialogBusy:()=>{},closeDialog:()=>{}},client:{request:async()=>{throw new Error('not used');}}} as unknown as FeatureContext;
  const controller=new ImageStudioController({root,context:()=>c,active:()=>true,signal:c.signal,toast:()=>{},port});(controller as any).topic='topic';
  return {controller,dialogs,panel};
}
test('新增正文配图弹窗：下拉项文案与 disabled 来自共用判定，选项不挂「未经真实验收」；版本卡仍标注',async()=>{
  const f=dialogFixture(studio(production));
  await f.controller.dispatch('studio-add',{dataset:{action:'studio-add'}} as unknown as HTMLElement);
  const body=String(f.dialogs.at(-1)?.body??'');
  assert.deepEqual(options(body),[{provider:'codex',disabled:true,text:'Codex 生图 · 额度暂不可用'},{provider:'agy',disabled:false,text:'AGY 生图 · 剩余 2 次'}]);
  assert.match(body,/<option value="agy" selected/,'默认选中第一个可选渠道');
  assert.equal(body.includes('暂不可用</option>')&&!body.includes('额度暂不可用'),false);assert.doesNotMatch(body,/未经真实验收/);
  (f.controller as any).legacyOpen=true; // 旧版逐张面板默认折叠（A2），展开后再核对版本卡
  assert.match(String((f.controller as any).panel()),/class="studio-unverified">未经真实验收</);

  const spent=studio({...production,channels:[{...agy,budget:{used:2,limit:2,remaining:0}},{...codex,executor:{status:'unverified',auth_state:'not_checked'}}]});
  const g=dialogFixture(spent);await g.controller.dispatch('studio-add',{dataset:{action:'studio-add'}} as unknown as HTMLElement);
  assert.deepEqual(options(String(g.dialogs.at(-1)?.body)),[{provider:'codex',disabled:false,text:'Codex 生图 · 剩余 2 次'},{provider:'agy',disabled:true,text:'AGY 生图 · 次数已用完'}]);
  assert.equal(studioDimensionsError({width:1600,height:900},spent.capabilities.find(c=>c.provider==='agy')),'本渠道真实生图次数已达上限。');
  const probe=studio({...production,channels:[{...agy,verification:{state:'failed',reason:'connection',message:'连不上 AGY 服务，请检查网络后重试',checked_at:null}},codex]});
  const cap=probe.capabilities.find(c=>c.provider==='agy')!;assert.deepEqual(studioProviderOption(cap),{text:'AGY 生图 · 连接验证未通过',disabled:true});
  assert.equal(studioDimensionsError({width:1600,height:900},cap),'连不上 AGY 服务，请检查网络后重试。');
});
test('设置页：渠道卡显示共用判定与剩余次数；「验证连接」只 POST verify 并渲染结果与时间',async()=>{
  const settings={default_executor:'codex',executors:[],capabilities:[],paths:{source_vault_root:null,managed_notes_root:'/n',state_root:'/s',media_root:'/m'},version:1,timezone:'Asia/Shanghai'} as any;
  let html=renderSettings(settings,{image_providers:production,image_draft:{default_provider:'codex',enabled:{agy:true,codex:true}}});
  const card=(provider:string)=>html.slice(html.indexOf('data-image-provider="'+provider+'"'),html.indexOf('</dl>',html.indexOf('data-image-provider="'+provider+'"')));
  assert.match(card('agy'),/可用于生图/);assert.match(card('agy'),/真实生图次数：剩余 2 \/ 共 2 次/);assert.match(card('agy'),/data-action="cfg-image-verify" data-provider="agy"/);assert.match(card('agy'),/尚未验证连接/);
  assert.match(card('codex'),/tag warn">额度暂不可用/);assert.doesNotMatch(html,/QUOTA_EXHAUSTED|auth_state/);
  html=renderSettings(settings,{image_providers:{...production,channels:[agy,{...codex,executor:{status:'unverified',auth_state:'not_checked'}}]},image_draft:{default_provider:'codex',enabled:{agy:true,codex:true}}});
  assert.match(card('codex'),/<small class="fine image-provider-unverified">尚未完成正式验收，可正常使用<\/small>/,'未正式验收只在设置页渠道卡作小号说明');assert.doesNotMatch(html,/未经真实验收/);assert.doesNotMatch(card('agy'),/尚未完成正式验收/);
  const verified:ImageProviderSettingsResponse={...production,channels:[{...agy,identity:'authenticated',connection:'connected',verification:{state:'failed',reason:'connection',message:'连不上 AGY 服务，请检查网络后重试',checked_at:'2026-10-15T02:00:00.000Z'}},codex]};
  const calls:{method:string;path:string}[]=[],toasts:string[]=[];
  const c=new ConfigurationController({root:{querySelector:()=>null},client:{request:async(method:string,path:string)=>{calls.push({method,path});return verified;}},signal:new AbortController().signal,settings:()=>settings,setSettings:()=>{throw new Error('写作设置不应变化');},context:()=>({}),render:()=>{},toast:(m:string)=>toasts.push(m),navigate:()=>{}} as any);
  c.state.image_providers=production;c.state.image_draft={default_provider:'codex',enabled:{agy:true,codex:true}};
  await (c as any).perform('image-verify',{dataset:{provider:'agy'}});
  assert.deepEqual(calls,[{method:'POST',path:'/api/v1/settings/image-providers/agy/verify'}]);assert.deepEqual(toasts,['连不上 AGY 服务，请检查网络后重试']);
  html=renderSettings(settings,c.state);
  assert.match(card('agy'),/连接验证未通过 · 2026/);assert.match(card('agy'),/<small>连不上 AGY 服务，请检查网络后重试<\/small>/);assert.match(card('agy'),/tag warn">连接验证未通过/);
  assert.match(card('agy'),/<dt>身份<\/dt><dd>已登录<\/dd>/);
});
test('verify 接口只读探测：provider 调用为 0、预算计数不变；结果写回 readiness；Codex 额度耗尽按阻塞返回',async()=>{
  const f=fixture();let app:Awaited<ReturnType<typeof startApplication>>|undefined;let probes=0,next:{ok:true}|{ok:false;reason:'connection'}={ok:true};
  try{
    const {input}=await seeded(f),provider=new FakeImageProvider(),image=new ImageGenerationWorkflow(f.context,{provider:()=>provider});
    app=await startApplication({...f.config,listen:{host:'127.0.0.1',port:43958}},{port:0,executorHealth:async()=>[quota],moduleFactories:[c=>createConfigurationModule(c,{imageProviders:{configured:()=>true,probeAgy:async()=>{probes++;return next;}}}),c=>createArtifactsModule(c,{image})]});
    const base='http://127.0.0.1:'+app.address.port,headers={'content-type':'application/json','x-workspace-id':app.identity.workspace_id,'x-service-instance-id':app.identity.service_instance_id};
    const call=(method:string,path:string,body?:unknown)=>fetch(base+path,{method,headers:{...headers,'idempotency-key':randomUUID()},...(body?{body:JSON.stringify(body)}:{})});
    const before=readGenerationBudget(f.context.db,f.config.workspace_id),initial=await (await call('GET','/api/v1/settings/image-providers')).json() as ImageProviderSettingsResponse;
    assert.deepEqual(initial.channels.map(ch=>[ch.provider,imageProviderAvailability(ch).selectable,ch.budget?.remaining]),[['agy',true,2],['codex',false,2]]);
    let res=await call('POST','/api/v1/settings/image-providers/agy/verify',{});assert.equal(res.status,200);let body=await res.json() as ImageProviderSettingsResponse,ch=body.channels.find(c=>c.provider==='agy')!;
    assert.deepEqual([ch.verification?.state,ch.identity,ch.connection,typeof ch.verification?.checked_at],['passed','authenticated','connected','string']);assert.equal(body.version,initial.version,'验证不改设置版本');
    next={ok:false,reason:'connection'};body=await (await call('POST','/api/v1/settings/image-providers/agy/verify',{})).json();ch=body.channels.find(c=>c.provider==='agy')!;
    assert.deepEqual([ch.verification?.state,ch.connection,imageProviderAvailability(ch).block,ch.verification?.message],['failed','blocked','probe_failed','连不上 AGY 服务，请检查网络后重试']);
    body=await (await call('POST','/api/v1/settings/image-providers/codex/verify',{})).json();ch=body.channels.find(c=>c.provider==='codex')!;
    assert.deepEqual([ch.verification?.state,ch.verification?.reason,ch.permission,imageProviderAvailability(ch).message],['failed','quota','blocked','额度暂不可用']);
    assert.equal((await call('POST','/api/v1/settings/image-providers/other/verify',{})).status,404);
    const after=await (await call('GET','/api/v1/settings/image-providers')).json() as ImageProviderSettingsResponse;assert.equal(after.channels.find(c=>c.provider==='agy')!.verification?.state,'failed','结果持久写回');
    assert.equal(probes,2);assert.equal(provider.submits,0);assert.equal(provider.queries,0);assert.deepEqual(readGenerationBudget(f.context.db,f.config.workspace_id),before);
    assert.equal(f.context.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()!.n,0,'验证不入队任何任务');void input;
  }finally{await app?.close();f.cleanup();}
});
test('AGY 只读探测只运行 models 子命令：读到模型列表算通过，登录/额度/其他失败分别归类',async()=>{
  const {probeAgyAccess}=await import('../../packages/adapters/src/media/image/agy.ts');const {mkdtempSync,writeFileSync,chmodSync,readFileSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
  const dir=mkdtempSync(join(tmpdir(),'agy-probe-')),log=join(dir,'args.log');
  const fake=(name:string,script:string)=>{const p=join(dir,name);writeFileSync(p,'#!/bin/sh\necho "$@" >> '+log+'\n'+script+'\n');chmodSync(p,0o755);return p;};
  try{
    assert.deepEqual(await probeAgyAccess({executable:fake('ok','printf "Fetching available models...\\ngemini-x\\tGemini X\\n"')}),{ok:true});
    assert.deepEqual(await probeAgyAccess({executable:fake('login','echo "Please sign in first" >&2; exit 1')}),{ok:false,reason:'login'});
    assert.deepEqual(await probeAgyAccess({executable:fake('quota','echo "RESOURCE_EXHAUSTED quota" >&2; exit 1')}),{ok:false,reason:'quota'});
    assert.deepEqual(await probeAgyAccess({executable:fake('net','echo "dial tcp: i/o error" >&2; exit 1')}),{ok:false,reason:'connection',inconclusive:false});
    assert.deepEqual(await probeAgyAccess({executable:join(dir,'missing')}),{ok:false,reason:'unconfigured'});
    assert.deepEqual(readFileSync(log,'utf8').trim().split('\n'),['models','models','models','models'],'只调用 models，不发起会话或生图');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('服务端生成入口复用同一判定：未配置/登录失效/额度耗尽/探测失败各自拒绝，不入队、不计预算；恢复后可提交',async()=>{
  const f=fixture();let app:Awaited<ReturnType<typeof startApplication>>|undefined;let configured=false,health:ExecutorHealth[]=[];
  try{
    const {input}=await seeded(f),provider=new FakeImageProvider();
    app=await startApplication({...f.config,listen:{host:'127.0.0.1',port:43959}},{port:0,executorHealth:async()=>structuredClone(health),moduleFactories:[c=>createConfigurationModule(c,{imageProviders:{configured:()=>true,probeAgy:async()=>({ok:false,reason:'connection'})}}),c=>createArtifactsModule(c,{image:new ImageGenerationWorkflow(c,{provider:()=>provider,provider_settings:{configured:()=>configured}})})]});
    const base='http://127.0.0.1:'+app.address.port,headers={'content-type':'application/json','x-workspace-id':app.identity.workspace_id,'x-service-instance-id':app.identity.service_instance_id};
    const call=(method:string,path:string,body?:unknown)=>fetch(base+path,{method,headers:{...headers,'idempotency-key':randomUUID()},...(body?{body:JSON.stringify(body)}:{})});
    const jobs=()=>Number(f.context.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n),before=readGenerationBudget(f.context.db,f.config.workspace_id);
    const rejected=async(body:unknown,status:number,code:string,message:RegExp)=>{const res=await call('POST','/api/v1/asset-generations',body),json=await res.json() as any;assert.equal(res.status,status,JSON.stringify(json));assert.equal(json.error.code,code);assert.match(json.error.message,message);assert.equal(jobs(),0);assert.deepEqual(readGenerationBudget(f.context.db,f.config.workspace_id),before);};
    const codexInput={...input,provider:'codex' as const};
    await rejected(input,422,'CAPABILITY_UNVERIFIED',/本机未找到所选图像渠道的命令行工具/);configured=true;
    health=[{...quota,status:'unconfigured',auth_state:'AUTH_REQUIRED'}];await rejected(codexInput,401,'AUTH_REQUIRED',/需要重新登录/);
    health=[quota];await rejected(codexInput,429,'QUOTA_EXHAUSTED',/额度暂不可用/);
    assert.equal((await call('POST','/api/v1/settings/image-providers/agy/verify',{})).status,200);await rejected(input,422,'CAPABILITY_UNVERIFIED',/连不上 AGY 服务，请检查网络后重试，未提交生图/);
    assert.equal(provider.submits,0);
    health=[{...quota,auth_state:'subscription_authenticated'}];const ok=await call('POST','/api/v1/asset-generations',codexInput);assert.equal(ok.status,202);assert.equal(jobs(),1);assert.equal(readGenerationBudget(f.context.db,f.config.workspace_id).codex,before.codex+1);
  }finally{await app?.close();f.cleanup();}
});
test('验证代次：旧探测晚返回不覆盖新结果；设置版本变化后的探测结果丢弃；租约内多实例只探测一次',async()=>{
  const {ImageProviderSettings}=await import('../../packages/domain/src/settings/image-providers.ts');
  const f=fixture();try{
    await seeded(f);let clock=Date.parse('2026-10-15T00:00:00.000Z');const logs:string[]=[],gates:Array<(v:any)=>void>=[];let probes=0;
    const make=()=>new ImageProviderSettings(f.context,{configured:()=>true,now:()=>clock,verify_lease_ms:30_000,log:l=>logs.push(l),probeAgy:()=>{probes++;return new Promise(r=>gates.push(r));}});
    const a=make(),b=make();
    const slow=a.verify(f.request(),'agy');await new Promise(r=>setImmediate(r));
    const dup=await b.verify(f.request(),'agy');assert.equal(probes,1,'租约内另一实例不再探测');assert.equal(dup.channels.find(c=>c.provider==='agy')!.verification?.state,'not_run');
    clock+=31_000;const fresh=b.verify(f.request(),'agy');await new Promise(r=>setImmediate(r));assert.equal(probes,2,'租约过期后新代次接管');
    gates[1]!({ok:false,reason:'login'});assert.equal((await fresh).channels.find(c=>c.provider==='agy')!.verification?.reason,'login');
    gates[0]!({ok:true});const late=await slow;assert.equal(late.channels.find(c=>c.provider==='agy')!.verification?.reason,'login','旧代次晚返回被丢弃');
    assert.match(logs.at(-1)!,/image_provider_verify_discarded.*"generation":1.*"latest_generation":2/);
    const third=a.verify(f.request(),'agy');await new Promise(r=>setImmediate(r));const saved=a.stored();a.save(f.request(),{expected_version:saved.version,default_provider:'agy',enabled:{agy:true,codex:false}});
    gates[2]!({ok:true});assert.equal((await third).channels.find(c=>c.provider==='agy')!.verification?.reason,'login','设置版本变化后的结果丢弃');assert.equal(logs.length,2);
    assert.equal(a.stored().verify_runs?.agy?.running_until,null,'丢弃后释放租约');
  }finally{f.cleanup();}
});
test('AGY 探测超时：替身进程忽略 SIGTERM，宽限期后对进程组发 SIGKILL，验证记为超时',async()=>{
  const {probeAgyAccess}=await import('../../packages/adapters/src/media/image/agy.ts');const {mkdtempSync,writeFileSync,chmodSync,readFileSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
  const dir=mkdtempSync(join(tmpdir(),'agy-hang-')),pids=join(dir,'pids'),bin=join(dir,'agy');
  writeFileSync(bin,'#!/bin/sh\ntrap "" TERM\nsleep 30 &\necho "$$ $!" > '+pids+'\nwait\n');chmodSync(bin,0o755);
  try{
    const started=Date.now(),result=await probeAgyAccess({executable:bin,timeout_ms:1500,kill_grace_ms:500});
    assert.deepEqual(result,{ok:false,reason:'connection',inconclusive:true,timeout:true});assert.ok(Date.now()-started<5000);
    await new Promise(r=>setTimeout(r,200));
    for(const pid of readFileSync(pids,'utf8').trim().split(' ').map(Number))assert.throws(()=>process.kill(pid,0),/ESRCH/,'进程组已被 SIGKILL 清理');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
