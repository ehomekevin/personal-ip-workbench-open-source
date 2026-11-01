import {mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {ContractError,maxConcurrentGenerations,type ExecutorHealth} from '@workbench/contracts';
import {CodexAdapter,poolAvailable,poolMutexHealth,onPoolDiagnostic,type TraceSink} from '@workbench/adapters/agent/codex';
import {jobResources} from '@workbench/storage/jobs';
import type {JobsRow} from '@workbench/contracts';
import {ClaudeAdapter} from '@workbench/adapters/agent/claude';
import type {ApplicationContext,ApplicationModule,AgentPort} from '@workbench/domain/ports';
import type {ServiceAgentPlan} from '@workbench/domain/service-agent';
import {DurableWorker} from '../worker/core/index.ts';
import {ExecutionScheduler} from './execution-concurrency.ts';
import {createContentAgentHandlers} from '../worker/handlers/content/index.ts';
import {createArticleLayoutHandlers} from '../worker/handlers/article-layout/index.ts';
import {getArticleLayoutRuntime} from './article-layout-runtime.ts';
import {createMediaHandlers} from '../worker/handlers/media/index.ts';
import {routedTextAdapter} from './configuration/api-execution.ts';
import {runConfigurationProbe} from '../../../../packages/domain/src/settings/process-probe.ts';
function directories(stateRoot:string){const staging=join(stateRoot,'generation-staging'),locks=join(stateRoot,'executor-locks'),schemas=join(stateRoot,'executor-schemas');for(const path of [staging,locks,schemas])mkdirSync(path,{recursive:true});return {staging:realpathSync(staging),locks,schemas};}
// 槽位占满（含其他进程或待核对槽位）时不领取 service_adapter 任务，避免为退回新建 attempt。
export function poolAdmission(locks:string,workspace:string,limit:number){return (row:JobsRow)=>row.execution_mode!=='service_adapter'||poolAvailable(locks,workspace,{pool:limit,task_id:row.id,resources:jobResources(row)});}
// 适配器诊断只把清理失败写成一行结构化 stderr（launchd 落到 runtime logs/service-error.log）；普通 trace 不进日志。
export const LOGGED_TRACE_DIRECTIONS=new Set(['cleanup_error']);
export function executorDiagnostics(executor:'codex'|'claude'|'pool',write:(line:string)=>void=line=>{process.stderr.write(line);}):TraceSink{return entry=>{if(!LOGGED_TRACE_DIRECTIONS.has(entry.direction))return;try{write(JSON.stringify({event:'executor_'+entry.direction,executor,at:entry.at,detail:entry.message})+'\n');}catch{/* 日志失败不影响执行清理。 */}};}
export function nativeAdapter(workspace:string,stateRoot:string,executor:'codex'|'claude',cwd?:string,slots=maxConcurrentGenerations(undefined),sink:TraceSink=executorDiagnostics(executor)):AgentPort & {close?():Promise<void>} {const d=directories(stateRoot),options={workspace_id:workspace,cwd:cwd??d.staging,lock_root:d.locks,concurrency_slots:slots,sink};return executor==='codex'?new CodexAdapter({...options,schema_directory:d.schemas}):new ClaudeAdapter(options);}
type ExecutorId='codex'|'claude';
interface HealthCache {last?:ExecutorHealth;at:number;pending?:Promise<ExecutorHealth>}
export function executorHealth(workspace:string,stateRoot:string,options:{probe?:(executor:ExecutorId)=>Promise<ExecutorHealth>;now?:()=>number}={}):ApplicationContext['getExecutorHealth'] {
  const ids=['codex','claude'] as const,cache:Record<ExecutorId,HealthCache>={codex:{at:0},claude:{at:0}},now=options.now??Date.now;
  const placeholder=(executor_id:ExecutorId):ExecutorHealth=>({executor_id,status:'unverified',runtime_version:null,auth_state:'not_checked',billing_route:null,limitations:['正在后台检查，稍后可刷新连接状态']});
  const probe=options.probe??(executor=>runConfigurationProbe<ExecutorHealth>(new URL('./executor-probe.ts',import.meta.url),{workspace,stateRoot,executor},10_000));
  function check(executor:ExecutorId,refresh:boolean):Promise<ExecutorHealth>{
    const entry=cache[executor];if(entry.pending)return entry.pending;
    if(entry.last&&!refresh&&now()-entry.at<30_000)return Promise.resolve(entry.last);
    entry.pending=Promise.resolve().then(()=>probe(executor)).catch(():ExecutorHealth=>({executor_id:executor,status:'unverified',runtime_version:null,auth_state:'not_checked',billing_route:null,limitations:['检查超时或工具暂不可用，请检查登录后重试']})).then(value=>{entry.last=value;entry.at=now();return value;}).finally(()=>{entry.pending=undefined;});
    return entry.pending;
  }
  return async query=>{
    const request=typeof query==='boolean'?{refresh:query}:query??{};
    // 提交决策只等所选执行器，复用同一个有界探针；普通读取仍立即投影。
    if(request.wait_for)await check(request.wait_for,request.refresh===true);
    else {const pending=ids.map(id=>check(id,request.refresh===true));if(request.refresh)await Promise.all(pending);}
    return ids.map(id=>cache[id].last??placeholder(id));
  };
}
export function createExecutionModule(context:ApplicationContext,options:{log?:(line:string)=>void}={}):ApplicationModule {
  // 槽位池诊断（含互斥损坏）走与适配器 cleanup_error 相同的日志通道。
  const unsubscribe=onPoolDiagnostic(executorDiagnostics('pool',options.log));
  const limit=maxConcurrentGenerations(context.config),adapters=new Set<AgentPort & {close?():Promise<void>}>(),d=directories(context.paths.state_root),worker=new DurableWorker(context,[...createContentAgentHandlers(context,{staging_root:d.staging,createAdapter:(plan:ServiceAgentPlan)=>{
    const adapter=routedTextAdapter(plan,context.identity.workspace_id,context.paths.state_root,nativeAdapter(context.identity.workspace_id,context.paths.state_root,plan.executor_id,plan.cwd,limit));adapters.add(adapter);
    const close=adapter.close?.bind(adapter);adapter.close=async()=>{try{await close?.();}finally{adapters.delete(adapter);}};return adapter;
  }}),...createMediaHandlers(context),...createArticleLayoutHandlers(context)]);
  const scheduler=new ExecutionScheduler(worker,{limit,admit:poolAdmission(d.locks,context.identity.workspace_id,limit),closeAdapters:async()=>{await Promise.all([...adapters].map(adapter=>adapter.close?.()));}});
  return{id:'content-media-worker',initialize(){scheduler.initialize();},close:async()=>{try{await scheduler.close();await getArticleLayoutRuntime(context).close();}finally{unsubscribe();}},register(){},health:()=>{const broken=poolMutexHealth(d.locks).broken;return {module:'content-media-worker',status:broken||scheduler.lastError?'degraded':'ready',details:{queued_jobs_only:true,last_error:broken?'pool_mutex_broken':scheduler.lastError,pool_mutex:broken?'broken':'ok',...(broken?{degraded_reason:'pool_mutex_broken',recovery:'核对执行器锁目录与互斥文件后重启服务'}:{}),active_tasks:scheduler.activeCount,generation_concurrency:limit,host_session_claimed:false,paid_fallback:'explicit_frozen_config_only'}};}};
}
