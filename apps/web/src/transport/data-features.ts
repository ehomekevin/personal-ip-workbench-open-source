import type { FeaturePorts,FeatureContext,PageFeaturePort } from './feature-ports.ts';
import type { Platform,ContentFormat,Page,AccountSummary,OverviewResponse,CreateComparisonRequest,ComparisonRun } from '@workbench/contracts';
import { createSourcesReadFeature,emptyIngestView } from '../features/sources/read/index.ts';
import { withSourcesResearchFeature } from '../features/sources/research/index.ts';
import { createContentDocumentsFeaturePort } from '../features/create/documents/index.ts';
import { withExistingMediaActions } from '../features/media/existing-actions/index.ts';
import { withPreparationFeaturePort } from '../features/media/preparation/index.ts';
import { createScheduleFeaturePort,withExistingPublicationActions } from '../features/schedule/existing-actions/index.ts';
import { createKnowledgeReadFeature } from '../features/knowledge/read/index.ts';
import { createTodayFeaturePort } from '../features/today/index.ts';
import { createComparisonsFeaturePort } from '../features/retro/comparisons/index.ts';
import { createRetroActionsFeaturePort } from '../features/retro/actions/index.ts';
import { createBusinessOutcomesFeaturePort } from '../features/retro/business-outcomes/index.ts';
import { withWorksFeaturePort,loadWorks } from '../features/works/index.ts';
import { loadWorkSnapshots } from '../features/retro/snapshots/index.ts';
import { periodWindows } from './time-windows.ts';
import type { ViewContext } from '../app/view-model.ts';
import type { WorkbenchClient } from './workbench-client.ts';
import { withAccountOperationsFeature } from '../features/operations/index.ts';
import {withReadScope} from './read-scope.ts';
import {executorChoices,preferredExecutor} from '../components/executors.ts';

// D10-003：真实入口共用原型页面。所有数据由同一个服务读取，空数据保持为空。
export function createDataFeaturePorts():FeaturePorts {
  const sources=withSourcesResearchFeature(createSourcesReadFeature()),knowledge=createKnowledgeReadFeature();
  const owners=new WeakMap<ViewContext,string|undefined>();
  async function loadBase(context:FeatureContext){
    const platform=context.ui.retroPlatform;
    const [settings,accountPage]=await Promise.all([context.client.getSettings(context.signal),context.client.request<Page<AccountSummary>>('GET','/api/v1/accounts',undefined,{signal:context.signal})]);
    const accounts=[...accountPage.items];let cursor=accountPage.next_cursor;
    while(cursor){const page:Page<AccountSummary>=await context.client.request('GET','/api/v1/accounts?cursor='+encodeURIComponent(cursor),undefined,{signal:context.signal});accounts.push(...page.items);cursor=page.next_cursor;}
    const base=emptyIngestView(context,context.ui);const executors=executorChoices(settings);base.state.executors=executors;base.state.agent=preferredExecutor(executors,settings.default_executor);base.state.api=settings.api_fallback_enabled;
    owners.set(base,accounts.find(account=>account.role==='owner'&&account.platform===platform&&account.identity_status==='confirmed')?.id);
    base.state.accounts=accounts.filter(account=>account.role==='benchmark').map(account=>({id:account.id,name:account.name,platform:account.platform,focus:account.identity_status==='pending'?'身份待核对':'已核对身份',count:null,previous:null,reason:'已收录 '+account.work_count+' 篇 · 周期数据以保存比较为准',url:account.canonical_url}));
    return base;
  }
  async function resolveQuery(context:FeatureContext):Promise<CreateComparisonRequest|null>{
    // 同类匹配组需要明确选题依据，既有界面仅显示已保存匹配组。
    if(context.ui.retroTab==='peer')return null;
    const platform=context.ui.retroPlatform as Platform,works=await loadWorks(context.client,platform,context.signal),role=context.ui.retroTab==='benchmark'?'benchmark':'owner';
    const eligible=works.filter(work=>work.identity_status==='confirmed'&&work.account_role===role&&work.account_id&&work.format&&(context.ui.retroTab==='single'||work.published_at)).sort((a,b)=>(b.published_at??'').localeCompare(a.published_at??'')||b.id.localeCompare(a.id));
    const selected=eligible[0];if(!selected)return null;
    const snapshots=await loadWorkSnapshots(context.client,selected.id,context.signal);
    const preferred=['read_count','read_num','view_count','views','impression_count','impressions','play_count','play'];
    const readings=snapshots.flatMap(snapshot=>snapshot.metrics).filter(metric=>metric.definition.scope==='work'&&metric.definition.platform===platform&&metric.availability==='available');
    const metric=readings.sort((a,b)=>{const ai=preferred.indexOf(a.key),bi=preferred.indexOf(b.key);return (ai<0?100:ai)-(bi<0?100:bi)||a.definition.id.localeCompare(b.definition.id);})[0];if(!metric)return null;
    const overview=await context.client.request<OverviewResponse>('GET','/api/v1/overview',undefined,{signal:context.signal});
    const windows=periodWindows(overview.local_date,overview.timezone,context.ui.period);
    return {kind:context.ui.retroTab==='single'?'work_evolution':role==='benchmark'?'benchmark_period':'self_period',platform,account_ids:[...new Set(eligible.filter(work=>work.format===selected.format).map(work=>work.account_id!))],format:selected.format as ContentFormat,metric_definition_id:metric.definition.id,timezone:overview.timezone,cohort_windows:windows,as_of:overview.updated_at,...(context.ui.retroTab==='single'?{account_ids:[selected.account_id!],work_ids:[selected.id]}:{})};
  }
  const comparisons=createComparisonsFeaturePort({loadBase,resolveQuery,selectAccount:(_context,run,base)=>{const ownerId=owners.get(base);return {ownerAccountId:ownerId,...(run.query_spec.kind==='self_period'&&ownerId?{accountId:ownerId}:{})};}});
  const actions=createRetroActionsFeaturePort({loadBase:context=>comparisons.load(context),dispatchRelated:(action,context)=>comparisons.dispatch(action,context)});
  const business=createBusinessOutcomesFeaturePort({loadBase:context=>actions.load(context),dispatchRelated:(action,context)=>actions.dispatch(action,context)});
  const works=withWorksFeaturePort(business);
  let retroGeneration=0;
  async function executeRetro<T>(context:FeatureContext,operation:(scoped:FeatureContext,checked:<R>(read:()=>Promise<R>)=>Promise<R>)=>Promise<T>):Promise<T>{
    const generation=++retroGeneration;
    const check=()=>{context.signal.throwIfAborted();if(generation!==retroGeneration)throw new DOMException('复盘读取已被更新','AbortError');};
    async function checked<R>(read:()=>Promise<R>):Promise<R>{check();const result=await read();check();return result;}
    // 组合链每个响应都先核对代次，迟到读取不能改内部选择或启动第二轮旧页面读取。
    const client:WorkbenchClient={...context.client,request<R>(...args:Parameters<WorkbenchClient['request']>){return checked(()=>context.client.request<R>(...args));},getSettings(signal){return checked(()=>context.client.getSettings(signal));}};
    const scoped={...context,ui:{...context.ui},client};
    return checked(()=>operation(scoped,checked));
  }
  const retro:PageFeaturePort<'retro'>={page:'retro',load:context=>executeRetro(context,scoped=>works.load(scoped)),dispatch:(action,context)=>executeRetro(context,async(scoped,checked)=>{const data=await checked(()=>works.dispatch(action,scoped));return data?checked(()=>works.load({...scoped,ui:{...data.ui}})):data;})};
  const today=createTodayFeaturePort({loadBase,dispatchRelated:(action,context)=>sources.dispatch(action,context)});
  const documents=createContentDocumentsFeaturePort({loadBase,dispatchRelated:(action,context)=>['new-topic','create-topic'].includes(action.action)?today.dispatch(action,context):sources.dispatch(action,context)});
  const create=withExistingPublicationActions(withExistingMediaActions(withPreparationFeaturePort(documents)));
  const schedule=createScheduleFeaturePort({loadBase:context=>create.load(context)});
  return {sources,knowledge,today:withReadScope(withAccountOperationsFeature(today)),retro:withReadScope(withAccountOperationsFeature(retro)),create:withReadScope(withAccountOperationsFeature(create)),schedule:withReadScope(withAccountOperationsFeature(schedule))};
}
