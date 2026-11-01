import type { AdoptRetroActionRequest,CreateRetroActionRequest,CreateAdoptionComparisonRequest,CreateAdoptionEvaluationRequest,LinkAdoptionWorkRequest,Page,RetroAction,RetroAdoption,RetroReportDetail,ComparisonRun,AdoptionWork,ActionEvaluation } from '@workbench/contracts';
import type { PageFeaturePort,FeatureContext,FeatureAction } from '../../../transport/feature-ports.ts';
import type { ViewContext,RetroProjection } from '../../../app/view-model.ts';
export interface RetroActionsFeatureOptions {loadBase(context:FeatureContext):Promise<ViewContext>;resolveAdoption?(action:RetroAction,context:FeatureContext):Promise<AdoptRetroActionRequest>;dispatchRelated?(action:FeatureAction,context:FeatureContext):Promise<ViewContext|void>}
export interface RetroActionsApi {
  list(platform?:string):Promise<RetroAction[]>;get(id:string):Promise<RetroAction>;report(id:string):Promise<RetroReportDetail>;
  create(reportId:string,input:CreateRetroActionRequest,key?:string):Promise<RetroAction>;
  adopt(id:string,input:AdoptRetroActionRequest,key?:string):Promise<RetroAdoption>;
  link(adoptionId:string,input:LinkAdoptionWorkRequest,key?:string):Promise<AdoptionWork>;
  compare(adoptionId:string,input:CreateAdoptionComparisonRequest,key?:string):Promise<ComparisonRun>;
  evaluate(adoptionId:string,input:CreateAdoptionEvaluationRequest,key?:string):Promise<ActionEvaluation>;
}
export function createRetroActionsApi(context:FeatureContext):RetroActionsApi {
  const options=(key?:string)=>({signal:context.signal,idempotencyKey:key ?? crypto.randomUUID()}),path=(id:string)=>encodeURIComponent(id);
  return {async list(platform){const items:RetroAction[]=[];let cursor:string|null=null;do{const page:Page<RetroAction>=await context.client.request('GET','/api/v1/retro-actions?limit=100'+(platform?'&platform='+path(platform):'')+(cursor?'&cursor='+path(cursor):''),undefined,{signal:context.signal});items.push(...page.items);cursor=page.next_cursor;}while(cursor);return items;},get:id=>context.client.request('GET','/api/v1/retro-actions/'+path(id),undefined,{signal:context.signal}),report:id=>context.client.request('GET','/api/v1/retro-reports/'+path(id),undefined,{signal:context.signal}),create:(id,input,key)=>context.client.request('POST','/api/v1/retro-reports/'+path(id)+'/actions',input,options(key)),adopt:(id,input,key)=>context.client.request('POST','/api/v1/retro-actions/'+path(id)+'/adoptions',input,options(key)),link:(id,input,key)=>context.client.request('POST','/api/v1/retro-adoptions/'+path(id)+'/works',input,options(key)),compare:(id,input,key)=>context.client.request('POST','/api/v1/retro-adoptions/'+path(id)+'/comparisons',input,options(key)),evaluate:(id,input,key)=>context.client.request('POST','/api/v1/retro-adoptions/'+path(id)+'/evaluations',input,options(key))};
}
export function projectRetroAction(action:RetroAction|undefined,report?:RetroReportDetail):RetroProjection['adoptionAction'] {
  if(!action)return undefined;const adoption=action.adoptions.at(-1),cohort=adoption?.observation_plan.frozen_baseline?.cohort ?? report?.comparison.selected_inputs_by_cohort.find(cohort=>cohort.key===action.observation_plan.baseline_cohort_key);
  return {id:action.id,description:action.description,hypothesis:action.hypothesis,status:action.status,reportId:action.report_id,reportRevisionId:action.report_revision_id,sourceRunId:adoption?.baseline_run_id ?? report?.comparison_run_id ?? action.observation_plan.baseline_run_id ?? '',baselineWorkIds:[...new Set(cohort?.selected_inputs.map(input=>input.canonical_work_id) ?? [])],baselineSnapshotIds:cohort?.selected_inputs.map(input=>input.snapshot_id) ?? [],topicId:adoption?.topic_id ?? null,note:adoption?.evaluations.length?'评价结果已单独记录；不自动证明因果。':adoption?'后续作品表现待观察。':'建议待验证，采用后保存冻结观察计划。'};
}
export function createRetroActionsFeaturePort(options:RetroActionsFeatureOptions):PageFeaturePort<'retro'> {
  let selected:RetroAction|undefined,selectedReport:RetroReportDetail|undefined,generation=0;
  async function load(context:FeatureContext):Promise<ViewContext> {
    const own=++generation,base=await options.loadBase(context);if(base.provenance!=='service')throw new Error('复盘建议正式投影只接受 service 数据');
    const api=createRetroActionsApi(context),actions=await api.list(context.ui.retroPlatform),loaded=actions.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id)).at(-1),report=loaded?await api.report(loaded.report_id):undefined;if(own===generation&&!context.signal.aborted){selected=loaded;selectedReport=report;}
    const projection=base.projections.retro ?? {current:[],previous:[],total:null,deltaPercent:null,currentWorks:null,previousWorks:null,snapshots:{at24h:null,at72h:null},peer:{ownRatio:null,benchmarkRatio:null},works:[]};
    return {...base,state:{...base.state,adopted:loaded?.adoptions.at(-1)?.topic_id ?? false},projections:{...base.projections,retro:{...projection,adoptionAction:projectRetroAction(loaded,report)}}};
  }
  async function dispatch(action:FeatureAction,context:FeatureContext):Promise<ViewContext|void> {
    if(action.action==='adopt-retro') {
      if(!selected){context.surface.toast('当前尚无可采用的建议');return;}
      const input=options.resolveAdoption?await options.resolveAdoption(selected,context):{create_topic:{title:selected.description,category:selectedReport?.comparison.query_spec.category ?? selectedReport?.comparison.selected_inputs_by_cohort.flatMap(cohort=>cohort.selected_inputs).find(input=>input.category!==null)?.category ?? '个人思考',audience:'',source_ids:[],angle:selected.hypothesis},observation_plan:selected.observation_plan};
      const adoption=await createRetroActionsApi(context).adopt(selected.id,input);context.surface.toast('建议已关联后续主题，表现等待观察');context.surface.updateUi({topic:adoption.topic_id});return load(context);
    }
    if(action.action==='open-adopted') {const id=selected?.adoptions.at(-1)?.topic_id;if(id){context.surface.updateUi({topic:id});context.surface.navigate('create');}else context.surface.toast('此建议尚未关联后续主题');return;}
    return options.dispatchRelated?.(action,context);
  }
  return {page:'retro',load,dispatch};
}
