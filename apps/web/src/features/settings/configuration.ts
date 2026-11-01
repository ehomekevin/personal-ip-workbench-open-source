import type { ApiFallbackConfiguration,ConfigurationSnapshot,SettingsResponse,OperatingPreferences,WorkspacePaths,Platform,ConfigurationCheck,JobDetailResponse,Page,JsonObject,SourceRecordSummary,SourceRecordDetail,TopicDetail,BenchmarkStatisticsRefreshResponse,BenchmarkStatisticsRefreshStatusResponse,ImageProviderSettingsResponse } from '@workbench/contracts';
import type { WorkbenchClient } from '../../transport/workbench-client.ts';
import type { FeatureContext } from '../../transport/feature-ports.ts';
import type { SettingsPageState } from './settings.ts';
import { P } from '../../components/metadata.ts';
import { createTemplateHelpers } from '../../components/templateHelpers.ts';
import {renderBenchmarkMaterialList,renderBenchmarkRecord} from '../../components/benchmarkMaterials.ts';
const {esc,btn}=createTemplateHelpers([]);
interface Options {root:HTMLElement;client:WorkbenchClient;signal:AbortSignal;settings():SettingsResponse|undefined;setSettings(value:SettingsResponse):void;context():FeatureContext;render():void;toast(message:string):void;navigate(platform:Platform):void;preferencesChanged?(value:OperatingPreferences):void;}
export class ConfigurationController {
  readonly options:Options;
  state:SettingsPageState={};
  private pathsVersion=0;
  private timezoneVersion=0;
  private preferencesVersion=0;
  private apiVersion=0;
  private imageVersion=0;
  private account?:JsonObject;
  private accountKey='';
  private benchmarkDialog=false;
  private statisticsKey='';
  private statisticsWatch=0;
  private benchmarkMaterials?:{account:JsonObject;rows:SourceRecordSummary[];next:string|null};
  private benchmarkRecord?:SourceRecordDetail;
  private benchmarkDetails=new Map<string,SourceRecordDetail>();
  private benchmarkListScroll=0;
  private benchmarkSelectedId='';
  private generation=0;
  private cacheKey='';
  private restored=false;
  private dirty={preferences:false,paths:false,timezone:false,voice:false,api:false,image:false};
  private cache(){
    const settings=this.options.settings(),saved=this.state.configuration;if(!this.cacheKey||!settings||!saved)return;
    const voice={endpoint:saved.tools.h3.endpoint,reference_path:saved.tools.h3.reference_path,reference_filename:saved.tools.h3.reference_filename};
    this.dirty={preferences:JSON.stringify(this.state.preferences)!==JSON.stringify(saved.preferences),paths:JSON.stringify(this.state.paths)!==JSON.stringify(settings.paths),timezone:this.state.timezone!==settings.timezone,voice:JSON.stringify(this.state.voice)!==JSON.stringify(voice),api:JSON.stringify(this.state.api_fallback)!==JSON.stringify(saved.api_fallback),image:!!this.state.image_draft&&JSON.stringify(this.state.image_draft)!==JSON.stringify(this.state.image_providers?{default_provider:this.state.image_providers.default_provider,enabled:{agy:this.state.image_providers.channels.find(c=>c.provider==='agy')?.enabled??false,codex:this.state.image_providers.channels.find(c=>c.provider==='codex')?.enabled??false}}:undefined)};
    try{if(!Object.values(this.dirty).some(Boolean)){localStorage.removeItem(this.cacheKey);return;}localStorage.setItem(this.cacheKey,JSON.stringify({...(this.dirty.image?{image_draft:this.state.image_draft,imageVersion:this.imageVersion}:{}),...(this.dirty.api?{api_fallback:this.state.api_fallback,apiVersion:this.apiVersion}:{}),...(this.dirty.preferences?{preferences:this.state.preferences}:{}),...(this.dirty.paths?{paths:this.state.paths}:{}),...(this.dirty.timezone?{timezone:this.state.timezone}:{}),...(this.dirty.voice?{voice:this.state.voice}:{}),pathsVersion:this.pathsVersion,timezoneVersion:this.timezoneVersion,preferencesVersion:this.preferencesVersion}));}catch{/* in-memory input remains available */}
  }
  constructor(options:Options){this.options=options;}
  async load(review=false){
    const n=++this.generation,data=await this.options.client.request<ConfigurationSnapshot>('GET','/api/v1/settings/configuration',undefined,{signal:this.options.signal});if(n!==this.generation)return;
    const settings=this.options.settings();this.state.configuration=data;
    try{const status=await this.options.client.request<BenchmarkStatisticsRefreshStatusResponse>('GET','/api/v1/accounts/material-statistics-refresh',undefined,{signal:this.options.signal});if(n===this.generation)this.state.benchmark_statistics=status.current;}catch{/* saved settings remain available when statistics status is temporarily unreadable */}
    this.cacheKey='workbench-configuration-draft:'+data.identity.workspace_id+':'+data.identity.service_instance_id;
    if(!this.restored){this.restored=true;try{const raw=localStorage.getItem(this.cacheKey);if(raw&&raw.length<16384){const draft=JSON.parse(raw);if(draft.image_draft&&['agy','codex'].includes(draft.image_draft.default_provider)&&typeof draft.image_draft.enabled?.agy==='boolean'&&typeof draft.image_draft.enabled?.codex==='boolean'){this.state.image_draft=draft.image_draft;this.imageVersion=Number(draft.imageVersion)||0;this.dirty.image=true;}if(draft.api_fallback&&['openai','anthropic'].includes(draft.api_fallback.provider)){this.state.api_fallback=draft.api_fallback;this.dirty.api=true;this.apiVersion=Number(draft.apiVersion)||0;}if(draft.preferences&&Array.isArray(draft.preferences.observation_hours)&&typeof draft.preferences.daily_budget_min==='number'){this.state.preferences=draft.preferences;this.dirty.preferences=true;}if(draft.paths&&typeof draft.paths.managed_notes_root==='string'&&typeof draft.paths.media_root==='string'){this.state.paths=draft.paths;this.dirty.paths=true;}if(typeof draft.timezone==='string'){this.state.timezone=draft.timezone;this.dirty.timezone=true;}if(draft.voice&&typeof draft.voice.endpoint==='string'){this.state.voice=draft.voice;this.dirty.voice=true;}this.pathsVersion=Number(draft.pathsVersion)||0;this.timezoneVersion=Number(draft.timezoneVersion)||0;this.preferencesVersion=Number(draft.preferencesVersion)||0;}}catch{/* discard malformed drafts */}}

    try{const image=await this.options.client.request<ImageProviderSettingsResponse>('GET','/api/v1/settings/image-providers',undefined,{signal:this.options.signal});if(n!==this.generation)return;this.state.image_providers=image;this.state.image_error='';if(!this.dirty.image)this.state.image_draft={default_provider:image.default_provider,enabled:{agy:image.channels.find(c=>c.provider==='agy')?.enabled??false,codex:image.channels.find(c=>c.provider==='codex')?.enabled??false}};if(!this.imageVersion||review||!this.dirty.image)this.imageVersion=image.version;}catch(e){if(n===this.generation)this.state.image_error=e instanceof Error?e.message:'图像渠道暂不可读';}
    if(!this.dirty.api)this.state.api_fallback=data.api_fallback?structuredClone(data.api_fallback):undefined;if(!this.apiVersion||review||!this.dirty.api)this.apiVersion=data.api_fallback?.settings_version??settings?.version??1;
    if(!this.dirty.preferences)this.state.preferences=structuredClone(data.preferences);if(!this.dirty.voice)this.state.voice={endpoint:data.tools.h3.endpoint,reference_path:data.tools.h3.reference_path,reference_filename:data.tools.h3.reference_filename};
    if(settings){if(!this.dirty.paths)this.state.paths={...settings.paths};if(!this.dirty.timezone)this.state.timezone=settings.timezone;if(!this.pathsVersion||review||!this.dirty.paths)this.pathsVersion=settings.version;if(!this.timezoneVersion||review||!this.dirty.timezone)this.timezoneVersion=settings.version;}
    if(!this.preferencesVersion||review||!this.dirty.preferences)this.preferencesVersion=data.version;
  }
  private capture(){
    this.state.benchmarks_open=this.options.root.querySelector<HTMLDetailsElement>('.configuration-benchmarks')?.open??this.state.benchmarks_open;
    this.state.api_open=this.options.root.querySelector<HTMLDetailsElement>('.configuration-details')?.open??this.state.api_open;
    const get=(id:string)=>this.options.root.querySelector<HTMLInputElement>('#'+id);
    if(get('cfg-timezone'))this.state.timezone=get('cfg-timezone')!.value;
    const settings=this.options.settings();if(settings&&get('cfg-source-vault'))this.state.paths={...settings.paths,source_vault_root:get('cfg-source-vault')!.value.trim()||null,managed_notes_root:get('cfg-notes-root')!.value.trim(),media_root:get('cfg-media-root')!.value.trim()};
    if(this.state.preferences&&get('cfg-budget'))this.state.preferences={daily_budget_min:Number(get('cfg-budget')!.value),retro_days:Number(get('cfg-retro-days')!.value),observation_hours:[24,72,168].filter(h=>get('cfg-hour-'+h)?.checked),auto_observation:get('cfg-auto-observation')!.checked,personal_site_auto_sync:get('cfg-auto-sync')!.checked,personal_site_sync_min:Number(get('cfg-sync-min')!.value)};
    if(this.state.api_fallback&&get('cfg-api-provider'))this.state.api_fallback={...this.state.api_fallback,provider:get('cfg-api-provider')!.value as 'openai'|'anthropic',model:get('cfg-api-model')!.value,enabled:get('cfg-api-enabled')!.checked,max_output_tokens:Number(get('cfg-api-tokens')!.value)};
    if(this.state.image_draft&&get('cfg-image-default'))this.state.image_draft={default_provider:get('cfg-image-default')!.value as 'agy'|'codex',enabled:{agy:get('cfg-image-enabled-agy')!.checked,codex:get('cfg-image-enabled-codex')!.checked}};
    if(get('cfg-h3-endpoint'))this.state.voice={endpoint:get('cfg-h3-endpoint')!.value.trim(),reference_path:get('cfg-h3-reference')!.value.trim(),reference_filename:get('cfg-h3-filename')!.value.trim()};
  }
  handleInput(input:HTMLInputElement){if(!input.id.startsWith('cfg-'))return false;if(input.id==='cfg-topic-title'&&input.value.trim()){input.removeAttribute('aria-invalid');input.removeAttribute('aria-describedby');}this.capture();this.cache();return true;}
  handleChange(input:HTMLInputElement){const provider=this.state.api_fallback?.provider,handled=this.handleInput(input);if(handled&&input.id==='cfg-api-provider'&&this.state.api_fallback?.provider!==provider){this.state.api_fallback!.model='';this.cache();this.options.render();}return handled;}
  handleClick(el:HTMLElement){const action=el.dataset.action;if(!action?.startsWith('cfg-'))return false;this.capture();if(action==='cfg-benchmark-add'){this.showBenchmark();return true;}if(action==='cfg-account'){this.showAccount(el.dataset.platform as Platform,el.dataset.id);return true;}if(action==='cfg-publishing'){this.options.navigate(el.dataset.platform as Platform);return true;}void this.perform(action.slice(4),el);return true;}
  private async perform(action:string,el:HTMLElement){
    if(this.state.busy)return;
    if(action==='system-timezone'){this.state.timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;this.options.render();return;}
    const task=action==='check'?el.dataset.tool!:action==='image-verify'?'image-verify:'+(el.dataset.provider??''):action;this.state.busy=task;this.state.error='';this.options.render();
    try{
      const request=<T>(method:'GET'|'POST'|'PUT'|'PATCH',path:string,body?:unknown)=>this.options.client.request<T>(method,path,body,{signal:this.options.signal,idempotencyKey:crypto.randomUUID()});
      if(action==='refresh'){this.options.setSettings(await this.options.client.getSettings(this.options.signal));await this.load(true);this.options.toast('已读取最新配置，未保存的输入保留；请核对后再保存。');}
      if(action==='check'){
        const result=await request<ConfigurationCheck>('POST','/api/v1/settings/configuration/checks',{tool:task});if(this.state.configuration)this.state.configuration.checks[task]=result;
        if(task==='executors')this.options.setSettings(await this.options.client.getSettings(this.options.signal));this.options.toast(result.message);
      }
      if(action==='login'){const data=await request<{message:string}>('POST','/api/v1/settings/configuration/login',{executor:el.dataset.executor});this.options.toast(data.message);}
      if(action==='benchmark-identity'){await request('POST','/api/v1/accounts/'+encodeURIComponent(el.dataset.id!)+'/identity-check',{});await this.load();this.options.toast('对标账号身份已核对，可以手动采集。');}
      if(action==='benchmark-sync'){const data=await request<{job_id:string}>('POST','/api/v1/accounts/'+encodeURIComponent(el.dataset.id!)+'/feed-sync',{});this.state.jobs='对标最新作品采集已提交';await this.load();void this.watch([data.job_id],'对标采集');}
      if(action==='benchmark-statistics-status'){await this.readStatistics();this.options.toast('已读取播放数刷新状态。');}
      if(action==='benchmark-statistics'){
        this.statisticsKey||=crypto.randomUUID();
        const data=await this.options.client.request<BenchmarkStatisticsRefreshResponse>('POST','/api/v1/accounts/material-statistics-refresh',{}, {signal:this.options.signal,idempotencyKey:this.statisticsKey});
        await this.readStatistics();this.options.toast('播放数刷新已提交，进度和回执保存在本机。');void this.watchStatistics(data.refresh_id);
      }
      if(action==='benchmark-materials'){
        const account=this.state.configuration?.benchmarks?.find(a=>a.id===el.dataset.id),source=(account?.sync as JsonObject)?.source_id;if(!account||typeof source!=='string')throw new Error('该账号尚无已采集素材');
        const page=await request<Page<SourceRecordSummary>>('GET','/api/v1/source-records?'+new URLSearchParams({source,order:'published_desc',limit:'50'}));this.benchmarkMaterials={account,rows:page.items,next:page.next_cursor};this.benchmarkDetails.clear();this.benchmarkListScroll=0;this.benchmarkSelectedId='';this.showBenchmarkMaterials();
      }
      if(action==='benchmark-more'){
        const materials=this.benchmarkMaterials,source=(materials?.account.sync as JsonObject)?.source_id;if(!materials?.next||typeof source!=='string')return;
        this.captureBenchmarkList();const page=await request<Page<SourceRecordSummary>>('GET','/api/v1/source-records?'+new URLSearchParams({source,order:'published_desc',limit:'50',cursor:materials.next}));const ids=new Set(materials.rows.map(r=>r.id));materials.rows.push(...page.items.filter(r=>!ids.has(r.id)));materials.next=page.next_cursor;this.showBenchmarkMaterials(true,false);
      }
      if(action==='benchmark-list')this.showBenchmarkMaterials(true);
      if(action==='benchmark-record'){
        const materials=this.benchmarkMaterials;if(!materials?.rows.some(r=>r.id===el.dataset.id))throw new Error('请重新打开该账号的素材列表');
        this.captureBenchmarkList();this.benchmarkSelectedId=el.dataset.id!;this.benchmarkRecord=this.benchmarkDetails.get(el.dataset.id!)??await request<SourceRecordDetail>('GET','/api/v1/source-records/'+encodeURIComponent(el.dataset.id!));this.benchmarkDetails.set(this.benchmarkRecord.id,this.benchmarkRecord);
        await request('PUT','/api/v1/source-records/'+encodeURIComponent(el.dataset.id!)+'/marks',{read:true});this.showBenchmarkRecord();
      }
      if(action==='benchmark-topic'){
        const record=this.benchmarkRecord;if(!record)throw new Error('先选择一篇素材');this.accountKey=crypto.randomUUID();
        this.options.context().surface.presentDialog({title:'从对标素材建立主题',body:'<p class="fine">关联资料：'+esc(record.title)+'</p><label class="configuration-field">你的主题<input class="field" id="cfg-topic-title" value="'+esc(record.title)+'"></label><label class="configuration-field">内容方向<select class="field" id="cfg-topic-category">'+['AI 实测','热点资讯','个人思考'].map(c=>'<option>'+c+'</option>').join('')+'</select></label><label class="configuration-field">你的角度 / 目标读者<textarea class="field" id="cfg-topic-angle" rows="4" placeholder="你想验证什么？能带来什么新的判断？"></textarea></label>',foot:btn('返回素材','cfg-benchmark-record',false,'data-id="'+esc(record.id)+'"')+btn('建立主题','cfg-benchmark-create',true)});
      }
      if(action==='benchmark-create'){
        const record=this.benchmarkRecord;if(!record)throw new Error('先选择一篇素材');const field=(id:string)=>this.options.root.querySelector<HTMLInputElement>('#'+id)?.value.trim()??'',title=field('cfg-topic-title'),angle=field('cfg-topic-angle');if(!title)throw new Error('填写自己的主题后再继续');
        const topic=await this.options.client.request<TopicDetail>('POST','/api/v1/topics',{title,category:field('cfg-topic-category'),audience:angle,angle,source_ids:[record.id]},{signal:this.options.signal,idempotencyKey:this.accountKey});const surface=this.options.context().surface;surface.updateUi({topic:topic.id,editTab:'core'});surface.closeDialog('completed');surface.navigate('create');this.options.toast('主题已建立，已关联对标素材。');
      }
      // 只读连接验证：不改启用状态与未保存的草稿，只刷新渠道的验证结果、可用判定与剩余次数。
      if(action==='image-verify'){const provider=el.dataset.provider;if(provider!=='agy'&&provider!=='codex')throw new Error('先重新读取图像渠道');const image=await request<ImageProviderSettingsResponse>('POST','/api/v1/settings/image-providers/'+provider+'/verify',{});this.state.image_providers=image;this.state.image_error='';const v=image.channels.find(c=>c.provider===provider)?.verification;this.options.toast(v?.state==='passed'?'连接验证通过，未发生真实生图。':v?.message??'连接验证未完成，请稍后重试。');}
      if(action==='image-providers'){if(!this.state.image_draft||!this.state.image_providers)throw new Error('先重新读取图像渠道');const image=await request<ImageProviderSettingsResponse>('PUT','/api/v1/settings/image-providers',{expected_version:this.imageVersion,...this.state.image_draft});this.state.image_providers=image;this.state.image_draft={default_provider:image.default_provider,enabled:{agy:image.channels.find(c=>c.provider==='agy')?.enabled??false,codex:image.channels.find(c=>c.provider==='codex')?.enabled??false}};this.imageVersion=image.version;this.options.toast('图像渠道已保存，后续图像任务使用新的设置。');}
      if(action==='api-fallback'){const api=this.state.api_fallback;if(!api)throw new Error('请刷新 API 配置');const {settings_version,...body}=api;const data=await request<ConfigurationSnapshot>('PUT','/api/v1/settings/configuration/api-fallback',{...body,expected_version:this.apiVersion});this.state.configuration=data;this.state.api_fallback=structuredClone(data.api_fallback!);this.apiVersion=data.api_fallback!.settings_version;this.options.setSettings(await this.options.client.getSettings(this.options.signal));await this.load();this.options.toast(api.enabled?'API 回退已启用，仅用于后续任务启动前确认的认证或额度不足。':'API 回退已关闭；已有任务沿用冻结路线。');}
      if(action==='preferences'){
        const data=await request<ConfigurationSnapshot>('PUT','/api/v1/settings/configuration',{expected_version:this.preferencesVersion,preferences:this.state.preferences});this.state.configuration=data;this.preferencesVersion=data.version;this.state.preferences=structuredClone(data.preferences);this.options.preferencesChanged?.(data.preferences);this.options.toast('工作方式已保存，后续计划使用新的设置。');
      }
      if(action==='paths'||action==='timezone'){
        const settings=await request<SettingsResponse>('PATCH','/api/v1/settings',{expected_version:action==='paths'?this.pathsVersion:this.timezoneVersion,...(action==='paths'?{paths:this.state.paths}:{timezone:this.state.timezone})});this.options.setSettings(settings);if(action==='paths'){this.state.paths={...settings.paths};this.pathsVersion=settings.version;}else{this.state.timezone=settings.timezone;this.timezoneVersion=settings.version;}this.options.toast(action==='paths'?'资料路径已保存，历史文件保留原位置。':'工作区时区已保存。');
      }
      if(action==='voice'){
        const data=await request<ConfigurationSnapshot>('PUT','/api/v1/settings/configuration/voice',this.state.voice);this.state.configuration=data;this.state.voice={endpoint:data.tools.h3.endpoint,reference_path:data.tools.h3.reference_path,reference_filename:data.tools.h3.reference_filename};this.options.toast('声音配置已保存，本人参考已缓存；接下来检查服务。');
      }
      if(action==='save-account'){
        const field=(id:string)=>this.options.root.querySelector<HTMLInputElement>('#'+id)!.value.trim();
        if(this.benchmarkDialog){await this.options.client.request('POST','/api/v1/accounts',{role:'benchmark',platform:field('cfg-account-platform'),name:field('cfg-account-name'),url:field('cfg-account-url')},{signal:this.options.signal,idempotencyKey:this.accountKey});this.options.context().surface.closeDialog('completed');await this.load();this.state.benchmarks_open=true;this.options.toast('对标账号已登记，核对身份后可采集。');return;}
        await this.options.client.request('POST','/api/v1/settings/configuration/accounts',{platform:field('cfg-account-platform'),name:field('cfg-account-name'),display_id:field('cfg-account-display'),url:field('cfg-account-url')||null,...(this.account?{account_id:this.account.id,expected_updated_at:this.account.updated_at}:{})},{signal:this.options.signal,idempotencyKey:this.accountKey});
        this.options.context().surface.closeDialog('completed');await this.load();this.options.toast('本人账号登记已保存；平台身份和授权仍单独核对。');
      }
      if(action==='identity'){
        const account=this.state.configuration?.accounts.find(a=>a.id===el.dataset.id);if(!account)throw new Error('先保存本人账号');
        if(account.record_type==='intake')await request('POST','/api/v1/settings/configuration/accounts/discover',{platform:account.platform,expected_updated_at:account.updated_at});else await request('POST','/api/v1/accounts/'+encodeURIComponent(String(account.id))+'/identity-check',{});
        await this.load();this.options.toast('平台身份已核对，发布权限仍单独检查。');
      }
      if(action==='sync'){
        const sources=await request<Page<JsonObject>>('GET','/api/v1/sources'),jobs:string[]=[];
        for(const source of sources.items.filter(s=>s.kind==='personal_site'&&s.external_id==='creator-feed')){const data=await request<{job_id:string}>('POST','/api/v1/sources/'+encodeURIComponent(String(source.id))+'/sync',{});jobs.push(data.job_id);}
        this.state.jobs='资讯同步已提交 '+jobs.length+' 个任务';this.options.render();void this.watch(jobs,'资讯同步');
      }
      if(action==='index'){
        const root=this.options.settings()?.paths.source_vault_root;if(!root)throw new Error('请先保存 Obsidian 源库路径');
        const result=await request<{job_id:string}>('POST','/api/v1/index-runs',{roots:[root],mode:'incremental'});this.state.jobs='只读索引任务已提交';void this.watch([result.job_id],'资料索引');
      }
    }catch(error){
      this.state.error=(error instanceof Error?error.message:'操作未完成')+(action.startsWith('benchmark-')?'。输入已保留。':'。输入已保留；配置冲突时先刷新并核对最新版本。');this.options.toast(this.state.error);
      const dialog=this.options.root.querySelector<HTMLDialogElement>('#dialog');
      if(dialog?.open&&(action==='save-account'||action.startsWith('benchmark-'))){
        const body=dialog.querySelector('.dialog-body');body?.querySelector('.configuration-dialog-error,.configuration-account-error')?.remove();
        body?.insertAdjacentHTML('afterbegin','<p id="cfg-dialog-error" class="configuration-dialog-error configuration-error'+(action==='save-account'?' configuration-account-error':'')+'" role="alert">'+esc(this.state.error)+'</p>');
        const title=dialog.querySelector<HTMLInputElement>('#cfg-topic-title');if(action==='benchmark-create'&&title&&!title.value.trim()){title.setAttribute('aria-invalid','true');title.setAttribute('aria-describedby','cfg-dialog-error');}
      }
    }
    finally{this.state.busy='';this.cache();this.options.render();this.options.root.querySelector<HTMLElement>('[data-action="cfg-'+action+'"]'+(el.dataset.tool?'[data-tool="'+el.dataset.tool+'"]':''))?.focus({preventScroll:true});}
  }
  private showAccount(platform:Platform,id?:string){
    this.benchmarkDialog=false;
    this.account=this.state.configuration?.accounts.find(a=>a.id===id);this.accountKey=crypto.randomUUID();const a=this.account;
    this.options.context().surface.presentDialog({title:P[platform]!.name+' · 本人账号',body:'<label class="configuration-field">平台<select class="field" id="cfg-account-platform" '+(a?'disabled':'')+'>'+Object.keys(P).map(p=>'<option value="'+p+'" '+(p===platform?'selected':'')+'>'+P[p]!.name+'</option>').join('')+'</select></label><label class="configuration-field">显示名称<input class="field" id="cfg-account-name" value="'+esc(a?.name??'我的账号')+'"></label><label class="configuration-field">展示 ID / 用户名<input class="field" id="cfg-account-display" value="'+esc(a?.display_id??'')+'"></label><label class="configuration-field">主页或公众号文章链接<input class="field" id="cfg-account-url" type="url" value="'+esc(a?.canonical_url??'')+'"></label><p class="fine">展示 ID 不作为平台内部身份。可以先保存登记，补充主页后再核对；已核对账号的身份链接需要保留。</p>',foot:btn('返回','close-dialog')+btn('保存账号登记','cfg-save-account',true)});
  }
  private showBenchmark(){
    this.benchmarkDialog=true;this.account=undefined;this.accountKey=crypto.randomUUID();
    this.options.context().surface.presentDialog({title:'添加对标账号',body:'<label class="configuration-field">平台<select class="field" id="cfg-account-platform">'+Object.keys(P).map(p=>'<option value="'+p+'">'+P[p]!.name+'</option>').join('')+'</select></label><label class="configuration-field">账号名称<input class="field" id="cfg-account-name" placeholder="填写对标账号名称"></label><label class="configuration-field">唯一账号主页<input class="field" id="cfg-account-url" type="url" placeholder="https://..."></label><p class="fine">采集由工作台直接使用 TikHub；目前最新作品支持 X 和抖音。登记不会发起采集。</p>',foot:btn('返回','close-dialog')+btn('登记对标账号','cfg-save-account',true)});
  }
  private captureBenchmarkList(){
    const body=this.options.root.querySelector<HTMLElement>('#dialog .dialog-body');if(body?.querySelector('.benchmark-works'))this.benchmarkListScroll=body.scrollTop;
  }
  private showBenchmarkMaterials(restore=false,restoreFocus=true){
    const materials=this.benchmarkMaterials;if(!materials)return;
    const body='<p class="fine benchmark-material-intro">'+esc(P[materials.account.platform as Platform]?.name??materials.account.platform)+' · 已载入 '+materials.rows.length+' 篇 · 按发布时间排序</p>'+renderBenchmarkMaterialList(materials.rows,{action:'cfg-benchmark-record',platform:String(materials.account.platform)})+'<p class="fine benchmark-scope">互动数据来自已保存的平台回执；— 表示平台未提供。封面地址失效时，可打开完整素材中的平台原文。</p>';
    this.options.context().surface.presentDialog({title:String(materials.account.name)+' · 已采集素材',body,foot:btn('关闭','close-dialog')+(materials.next?btn('加载更多','cfg-benchmark-more'): '')});
    const dialogBody=this.options.root.querySelector<HTMLElement>('#dialog .dialog-body');if(dialogBody)dialogBody.scrollTop=restore?this.benchmarkListScroll:0;
    if(restore&&restoreFocus&&this.benchmarkSelectedId)this.options.root.querySelector<HTMLElement>('#dialog [data-action="cfg-benchmark-record"][data-id="'+CSS.escape(this.benchmarkSelectedId)+'"]')?.focus({preventScroll:true});
  }
  private showBenchmarkRecord(){
    const record=this.benchmarkRecord;if(!record)return;
    this.options.context().surface.presentDialog({title:record.title,body:renderBenchmarkRecord(record),foot:btn('返回列表','cfg-benchmark-list')+btn('以此建立主题','cfg-benchmark-topic',true)});
    const body=this.options.root.querySelector<HTMLElement>('#dialog .dialog-body');if(body)body.scrollTop=0;
    this.options.root.querySelector<HTMLElement>('#dialog [data-action="cfg-benchmark-list"]')?.focus({preventScroll:true});
  }
  private async readStatistics(){
    const data=await this.options.client.request<BenchmarkStatisticsRefreshStatusResponse>('GET','/api/v1/accounts/material-statistics-refresh',undefined,{signal:this.options.signal});this.state.benchmark_statistics=data.current;
    if(data.current&&!['queued','running','unknown'].includes(data.current.state))this.statisticsKey='';
  }
  private async watchStatistics(id:string){
    const generation=++this.statisticsWatch;
    for(let round=0;round<120&&!this.options.signal.aborted&&generation===this.statisticsWatch;round++){
      try{await this.readStatistics();this.options.render();const status=this.state.benchmark_statistics;if(!status||status.refresh_id!==id||!['queued','running'].includes(status.state)){if(status?.updated_count){this.benchmarkDetails.clear();this.benchmarkMaterials=undefined;}return;}}
      catch{this.options.toast('播放数刷新状态暂不可读，可用“查看播放数刷新状态”继续核对。');return;}
      await new Promise<void>(resolve=>{const timer=setTimeout(resolve,1000);this.options.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
    }
  }
  private async watch(ids:string[],label:string){
    for(let round=0;round<120&&!this.options.signal.aborted;round++){
      try{const jobs=await Promise.all(ids.map(id=>this.options.client.request<JobDetailResponse>('GET','/api/v1/jobs/'+encodeURIComponent(id),undefined,{signal:this.options.signal}))),success=jobs.filter(j=>j.job.state==='succeeded').length,failed=jobs.filter(j=>['failed','cancelled','waiting_input','waiting_quota'].includes(j.job.state)).length;
        this.state.jobs=label+'：完成 '+success+' / '+jobs.length+(failed?'，'+failed+' 个任务需要处理':'');this.options.render();if(success+failed===jobs.length){if(label==='对标采集'){await this.load();this.options.render();}return;}
      }catch{this.state.jobs=label+'状态暂不可读，任务记录已保留，可刷新继续查看';this.options.render();return;}
      await new Promise<void>(resolve=>{const timer=setTimeout(resolve,1000);this.options.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
    }
  }
}
