import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute,resolve } from 'node:path';
import { ContractError,CreateRetroActionSchema,AdoptRetroActionSchema,LinkAdoptionWorkSchema,CreateAdoptionComparisonSchema,CreateAdoptionEvaluationSchema,CreateTopicSchema,type RequestContext,type ObservationPlanInput,type ComparisonRun,type ComparisonParameters,type CreateRetroActionRequest,type AdoptRetroActionRequest,type LinkAdoptionWorkRequest,type CreateAdoptionComparisonRequest,type CreateAdoptionEvaluationRequest,type WorksRow,type JsonObject,type DocumentSnapshot } from '@workbench/contracts';
import { transaction,canonicalJson,sha256,requestHash } from '@workbench/storage/connection';
import { readIdempotent,storeIdempotent } from '@workbench/storage/revisions';
import { getAction,getAdoption,getReport,listRetro,insertJson,type RetroAction,type RetroAdoption,type RetroReport,type RetroListQuery,type FrozenAdoptionPlan,type AdoptionWork,type ActionEvaluation } from '@workbench/storage/retro';
import { Comparisons } from '../comparisons/index.ts';
import { Documents,assertRequestIdentity } from '../documents/index.ts';
import { TopicPreparation } from '../topic-preparation/index.ts';
import { validTimezone } from '../daily-plans/contracts.ts';
import type { ApplicationContext } from '../ports/index.ts';
export type { RetroAction,RetroAdoption,RetroReport,RetroListQuery,FrozenAdoptionPlan,AdoptionWork,ActionEvaluation } from '@workbench/storage/retro';
export { CreateRetroActionSchema,AdoptRetroActionSchema,LinkAdoptionWorkSchema,CreateAdoptionComparisonSchema,CreateAdoptionEvaluationSchema } from '@workbench/contracts';
export interface RetroReportDetail extends RetroReport { document:DocumentSnapshot; actions:RetroAction[]; comparison:ComparisonRun }
function mismatch(message:string):never { throw new ContractError('EVALUATION_INPUT_MISMATCH',message); }
function utc(value:string):number { if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,19)!==value.slice(0,19))throw new ContractError('VALIDATION_ERROR','UTC 时刻无效'); return Date.parse(value); }
function equal(a:unknown,b:unknown):boolean { return canonicalJson(a)===canonicalJson(b); }
export class Retro {
  readonly context:ApplicationContext;readonly clock:()=>number;readonly comparisons:Comparisons;
  constructor(context:ApplicationContext,options:{clock?:()=>number}={}) {this.context=context;this.clock=options.clock ?? Date.now;this.comparisons=new Comparisons(context,{clock:this.clock});}
  action(request:RequestContext,id:string):RetroAction {assertRequestIdentity(this.context,request);return getAction(this.context.db,request.workspace_id,id);}
  adoption(request:RequestContext,id:string):RetroAdoption {assertRequestIdentity(this.context,request);const result=getAdoption(this.context.db,request.workspace_id,id);this.assertPlan(result);return result;}
  actions(request:RequestContext,query:RetroListQuery={}) {assertRequestIdentity(this.context,request);return listRetro(this.context.db,request.workspace_id,'actions',query,id=>getAction(this.context.db,request.workspace_id,id));}
  reports(request:RequestContext,query:RetroListQuery={}) {assertRequestIdentity(this.context,request);return listRetro(this.context.db,request.workspace_id,'reports',query,id=>getReport(this.context.db,request.workspace_id,id));}
  async report(request:RequestContext,id:string):Promise<RetroReportDetail> {assertRequestIdentity(this.context,request);const report=getReport(this.context.db,request.workspace_id,id);return {...report,document:await new Documents(this.context).get(request,report.document_id),actions:report.action_ids.map(action=>getAction(this.context.db,request.workspace_id,action)),comparison:this.comparisons.get(request,report.comparison_run_id)};}
  private validatePlan(request:RequestContext,input:ObservationPlanInput,reportId?:string):void {
    validTimezone(input.timezone); if(input.earliest_evaluation_at!==null)utc(input.earliest_evaluation_at);
    const account=this.context.db.prepare('SELECT * FROM accounts WHERE workspace_id=? AND id=?').get(request.workspace_id,input.account_id);
    const definition=this.context.db.prepare('SELECT * FROM metric_definitions WHERE workspace_id=? AND id=?').get(request.workspace_id,input.metric_definition_id);
    if(!account||!definition||account.platform!==input.platform||definition.platform!==input.platform||account.role!=='owner'||account.identity_status!=='confirmed'||account.platform_account_id===null)mismatch('观察账号或指标定义尚未确认');
    if(input.baseline_run_id!==null) {
      if(reportId && getReport(this.context.db,request.workspace_id,reportId).comparison_run_id!==input.baseline_run_id)mismatch('基线必须来自报告固定比较依据');
      const baseline=this.comparisons.freezeCohort(request,input.baseline_run_id,input.baseline_cohort_key!);
      for(const [key,expected] of Object.entries({platform:input.platform,format:input.format,metric_definition_id:input.metric_definition_id,timezone:input.timezone,aggregation:input.aggregation,observation_window_h:input.observation_window_h,tolerance_h:input.tolerance_h}))if(!equal(baseline.parameters[key as keyof ComparisonParameters],expected))mismatch('冻结基线与观察参数不一致');
      if(baseline.cohort.account_id!==input.account_id||!equal(baseline.parameters.account_ids,[input.account_id]))mismatch('冻结基线必须为该观察账号的单账号 cohort');
    }
  }
  createAction(request:RequestContext,reportId:string,input:CreateRetroActionRequest):RetroAction {
    assertRequestIdentity(this.context,request);CreateRetroActionSchema.parse(input);
    return transaction(this.context.db,()=>{
      const body={report_id:reportId,...input},replay=readIdempotent<RetroAction>(this.context.db,request,'retro.actions.create',body);if(replay)return replay;
      const report=getReport(this.context.db,request.workspace_id,reportId),revision=this.context.db.prepare('SELECT document_id FROM document_revisions WHERE workspace_id=? AND id=?').get(request.workspace_id,input.report_revision_id);
      if(!revision||revision.document_id!==report.document_id)throw new ContractError('VALIDATION_ERROR','建议引用的修订不属于报告');
      if(input.metric!==input.observation_plan.metric_definition_id)mismatch('建议指标与观察计划不一致');this.validatePlan(request,input.observation_plan,reportId);
      const at=new Date(this.clock()).toISOString(),id=randomUUID();insertJson(this.context.db,'retro_actions',{id,workspace_id:request.workspace_id,report_id:reportId,report_revision_id:input.report_revision_id,description:input.description,hypothesis:input.hypothesis,target_metric:input.metric,observation_plan:input.observation_plan,status:'proposed',created_at:at,updated_at:at});
      const result=getAction(this.context.db,request.workspace_id,id);storeIdempotent(this.context.db,request,'retro.actions.create',body,result);return result;
    });
  }
  adopt(request:RequestContext,actionId:string,input:AdoptRetroActionRequest):RetroAdoption {
    assertRequestIdentity(this.context,request);AdoptRetroActionSchema.parse(input);
    return transaction(this.context.db,()=>{
      const body={action_id:actionId,...input},operation='retro.adopt',replay=readIdempotent<RetroAdoption>(this.context.db,request,operation,body);if(replay)return replay;
      const key=input.create_topic?'create_topic:main':`topic:${input.target_topic_id}`,existing=this.context.db.prepare('SELECT id FROM action_adoptions WHERE workspace_id=? AND action_id=? AND adoption_key=?').get(request.workspace_id,actionId,key);
      if(existing) {const original=getAdoption(this.context.db,request.workspace_id,String(existing.id));this.assertPlan(original);if(original.observation_plan.adoption_request_hash!==requestHash(body))throw new ContractError('IDEMPOTENCY_CONFLICT','同一采用目标的参数已冻结');storeIdempotent(this.context.db,request,operation,body,original);return original;}
      const action=getAction(this.context.db,request.workspace_id,actionId);if(action.status==='stopped')throw new ContractError('VALIDATION_ERROR','已停止建议不能采用');
      if(input.observation_plan.metric_definition_id!==action.target_metric)mismatch('采用指标与建议不一致');this.validatePlan(request,input.observation_plan,action.report_id);
      const at=new Date(this.clock()).toISOString();let topicId=input.target_topic_id!;
      if(input.create_topic) {
        CreateTopicSchema.parse(input.create_topic);if(!input.create_topic.title.trim())throw new ContractError('VALIDATION_ERROR','主题标题不能为空');
        topicId=randomUUID();const documentId=randomUUID();
        this.context.db.prepare("INSERT INTO documents(id,workspace_id,kind,owner_entity_id,version,created_at,updated_at) VALUES(?,?,'core',?,1,?,?)").run(documentId,request.workspace_id,topicId,at,at);
        this.context.db.prepare("INSERT INTO topics(id,workspace_id,title,category,audience,angle,expected_effort_min,core_document_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'active',1,?,?)").run(topicId,request.workspace_id,input.create_topic.title,input.create_topic.category,input.create_topic.audience,[input.create_topic.angle ?? '',action.description,action.hypothesis].filter(Boolean).join('\n'),input.create_topic.expected_effort_min ?? 0,documentId,at,at);
        for(const source of new Set(input.create_topic.source_ids)) {if(!this.context.db.prepare('SELECT id FROM source_records WHERE workspace_id=? AND id=?').get(request.workspace_id,source))throw new ContractError('NOT_FOUND','主题来源不存在');this.context.db.prepare('INSERT INTO topic_sources(id,workspace_id,topic_id,source_record_id,usage) VALUES(?,?,?,?,?)').run(randomUUID(),request.workspace_id,topicId,source,'retro_adoption');}
        new TopicPreparation(this.context).createInTransaction(request.workspace_id,topicId);
      }
      const topic=this.context.db.prepare('SELECT t.*,d.head_revision_id FROM topics t JOIN documents d ON d.workspace_id=t.workspace_id AND d.id=t.core_document_id WHERE t.workspace_id=? AND t.id=?').get(request.workspace_id,topicId);
      if(!topic)throw new ContractError('NOT_FOUND','目标主题不存在');
      const variant=input.variant_id?this.context.db.prepare('SELECT v.*,d.head_revision_id FROM variants v JOIN documents d ON d.workspace_id=v.workspace_id AND d.id=v.document_id WHERE v.workspace_id=? AND v.id=?').get(request.workspace_id,input.variant_id):null;
      if(input.variant_id && (!variant||variant.topic_id!==topicId||variant.platform!==input.observation_plan.platform||variant.format!==input.observation_plan.format))mismatch('目标版本不属于主题或观察平台形式');
      const frozen=input.observation_plan.baseline_run_id?this.comparisons.freezeCohort(request,input.observation_plan.baseline_run_id,input.observation_plan.baseline_cohort_key!):null;
      const plan:FrozenAdoptionPlan={...structuredClone(input.observation_plan),schema_version:'retro-observation-v1',baseline_input_hash:frozen?.input_hash ?? null,frozen_baseline:frozen,target:{topic_id:topicId,core_revision_id:topic.head_revision_id as string|null,variant_id:input.variant_id ?? null,variant_revision_id:variant?.head_revision_id as string|null ?? null},adoption_request_hash:requestHash(body)};
      const id=randomUUID();insertJson(this.context.db,'action_adoptions',{id,workspace_id:request.workspace_id,action_id:actionId,adoption_key:key,topic_id:topicId,variant_id:input.variant_id ?? null,adopted_at:at,baseline_run_id:plan.baseline_run_id,baseline_cohort_key:plan.baseline_cohort_key,baseline_input_hash:plan.baseline_input_hash,observation_plan:plan,plan_hash:sha256(canonicalJson(plan)),created_at:at,updated_at:at});
      this.context.db.prepare("UPDATE retro_actions SET status='adopted',updated_at=? WHERE workspace_id=? AND id=?").run(at,request.workspace_id,actionId);
      const result=getAdoption(this.context.db,request.workspace_id,id);storeIdempotent(this.context.db,request,operation,body,result);return result;
    });
  }
  private assertPlan(adoption:RetroAdoption):void {
    const plan=adoption.observation_plan;
    if(plan.schema_version!=='retro-observation-v1'||sha256(canonicalJson(plan))!==adoption.plan_hash||plan.baseline_run_id!==adoption.baseline_run_id||plan.baseline_cohort_key!==adoption.baseline_cohort_key||plan.baseline_input_hash!==adoption.baseline_input_hash||plan.target.topic_id!==adoption.topic_id||plan.target.variant_id!==adoption.variant_id)mismatch('采用计划或基线已被篡改');
  }
  private work(request:RequestContext,adoption:RetroAdoption,id:string):WorksRow {
    const row=this.context.db.prepare('SELECT * FROM works WHERE workspace_id=? AND id=?').get(request.workspace_id,id) as unknown as WorksRow|undefined,plan=adoption.observation_plan;
    if(!row||row.canonical_work_id && row.canonical_work_id!==row.id||row.identity_status!=='confirmed'||row.platform_work_id===null||row.account_id!==plan.account_id||row.platform!==plan.platform||row.format!==plan.format||row.topic_id!==adoption.topic_id||adoption.variant_id && row.variant_id!==adoption.variant_id)mismatch('后续作品身份、账号、形式或目标关联不匹配');
    if(row.published_at===null||utc(row.published_at)<utc(adoption.adopted_at)||utc(row.published_at)>this.clock())mismatch('后续作品必须在采用之后实际发布');
    if(row.variant_id) {const variant=this.context.db.prepare('SELECT topic_id,document_id FROM variants WHERE workspace_id=? AND id=?').get(request.workspace_id,row.variant_id);if(!variant||variant.topic_id!==adoption.topic_id)mismatch('作品版本不属于目标主题');if(row.revision_id&&!this.context.db.prepare('SELECT id FROM document_revisions WHERE workspace_id=? AND id=? AND document_id=?').get(request.workspace_id,row.revision_id,String(variant.document_id)))mismatch('作品文稿修订不属于目标版本');}
    if(plan.target.variant_revision_id) {
      let revisionId=row.revision_id;const visited=new Set<string>();
      while(revisionId && revisionId!==plan.target.variant_revision_id && !visited.has(revisionId)) {visited.add(revisionId);const revision=this.context.db.prepare('SELECT parent_revision_id FROM document_revisions WHERE workspace_id=? AND id=?').get(request.workspace_id,revisionId);revisionId=revision?.parent_revision_id as string|null;}
      if(revisionId!==plan.target.variant_revision_id)mismatch('作品文稿不继承采用时冻结版本');
    }
    return row;
  }
  linkWork(request:RequestContext,adoptionId:string,input:LinkAdoptionWorkRequest):AdoptionWork {
    assertRequestIdentity(this.context,request);LinkAdoptionWorkSchema.parse(input);if(!Object.keys(input.link_evidence).length)throw new ContractError('VALIDATION_ERROR','作品关联必须保留依据');
    return transaction(this.context.db,()=>{
      const body={adoption_id:adoptionId,...input},operation='retro.link-work',replay=readIdempotent<AdoptionWork>(this.context.db,request,operation,body);if(replay)return replay;
      const adoption=this.adoption(request,adoptionId),work=this.work(request,adoption,input.work_id),existing=adoption.works.find(item=>item.work_id===input.work_id);
      if(existing) {if(!equal(existing.link_evidence,input.link_evidence))throw new ContractError('IDEMPOTENCY_CONFLICT','作品关联依据已冻结');storeIdempotent(this.context.db,request,operation,body,existing);return existing;}
      for(const [key,value] of Object.entries({topic_id:adoption.topic_id,variant_id:work.variant_id,revision_id:work.revision_id}))if(key in input.link_evidence&&!equal(input.link_evidence[key],value))mismatch('作品关联依据与实际身份不同');
      const at=new Date(this.clock()).toISOString(),id=randomUUID();insertJson(this.context.db,'adoption_works',{id,workspace_id:request.workspace_id,adoption_id:adoptionId,work_id:input.work_id,link_evidence:input.link_evidence,created_at:at,updated_at:at});
      this.context.db.prepare("UPDATE retro_actions SET status='observing',updated_at=? WHERE workspace_id=? AND id=?").run(at,request.workspace_id,adoption.action_id);
      const result=getAdoption(this.context.db,request.workspace_id,adoptionId).works.find(work=>work.id===id)!;storeIdempotent(this.context.db,request,operation,body,result);return result;
    });
  }
  private targets(request:RequestContext,adoption:RetroAdoption,ids:string[],asOf:string):WorksRow[] {
    const at=utc(asOf),plan=adoption.observation_plan;
    if(at>this.clock()||at<utc(adoption.adopted_at)||!ids.length||new Set(ids).size!==ids.length)mismatch('目标截止时间或作品集合无效');
    const works=ids.map(id=>{if(!adoption.works.some(link=>link.work_id===id))mismatch('目标作品未显式关联本次采用');return this.work(request,adoption,id);});
    if(plan.earliest_evaluation_at && at<utc(plan.earliest_evaluation_at)||works.some(work=>at<utc(work.published_at!)+plan.observation_window_h*3600_000))throw new ContractError('OBSERVATION_PENDING','后续作品尚未达到冻结观察窗口');
    return works;
  }
  private evaluationParameters(adoption:RetroAdoption,asOf:string):ComparisonParameters {
    const plan=adoption.observation_plan,original=plan.frozen_baseline?.parameters;
    return {platform:plan.platform,account_ids:[plan.account_id],format:plan.format,metric_definition_id:plan.metric_definition_id,timezone:plan.timezone,topic_ids:[],category:null,work_ids:[],match_reason:null,cohort_windows:{target:{start:adoption.adopted_at,end:new Date(utc(asOf)+1).toISOString()},baseline:null},observation_window_h:plan.observation_window_h,tolerance_h:plan.tolerance_h,baseline_window_days:original?.baseline_window_days ?? 28,min_baseline_samples:original?.min_baseline_samples ?? 5,aggregation:plan.aggregation,missing_policy:'exclude',data_version:'comparison-v1'};
  }
  compare(request:RequestContext,adoptionId:string,input:CreateAdoptionComparisonRequest):ComparisonRun {
    assertRequestIdentity(this.context,request);CreateAdoptionComparisonSchema.parse(input);const adoption=this.adoption(request,adoptionId);this.targets(request,adoption,input.target_work_ids,input.target_as_of);
    return this.comparisons.createEvaluation(request,{adoption_id:adoptionId,plan_hash:adoption.plan_hash,parameters:this.evaluationParameters(adoption,input.target_as_of),target_work_ids:[...input.target_work_ids].sort(),target_as_of:input.target_as_of,baseline:adoption.observation_plan.frozen_baseline});
  }
  private rawAvailable(request:RequestContext,run:ComparisonRun):boolean {
    return run.selected_inputs_by_cohort.every(cohort=>cohort.selected_inputs.every(input=>{
      const row=this.context.db.prepare('SELECT work_id,raw_path,raw_sha256 FROM snapshots WHERE workspace_id=? AND id=?').get(request.workspace_id,input.snapshot_id);
      if(!row||row.work_id!==input.source_work_id||row.raw_path!==input.raw_path||row.raw_sha256!==input.raw_sha256)return false;
      try{return sha256(readFileSync(isAbsolute(input.raw_path)?input.raw_path:resolve(this.context.paths.state_root,input.raw_path)))===input.raw_sha256;}catch{return false;}
    }));
  }
  evaluate(request:RequestContext,adoptionId:string,input:CreateAdoptionEvaluationRequest):ActionEvaluation {
    assertRequestIdentity(this.context,request);CreateAdoptionEvaluationSchema.parse(input);
    return transaction(this.context.db,()=>{
      const body={adoption_id:adoptionId,...input},operation='retro.evaluate',replay=readIdempotent<ActionEvaluation>(this.context.db,request,operation,body);if(replay)return replay;
      const adoption=this.adoption(request,adoptionId),plan=adoption.observation_plan,run=this.comparisons.get(request,input.comparison_run_id),query=run.query_spec;
      if(query.mode!=='adoption_evaluation'||query.kind!=='self_period'||query.adoption_id!==adoptionId||query.plan_hash!==adoption.plan_hash||query.baseline_input_hash!==adoption.baseline_input_hash||query.baseline_run_id!==adoption.baseline_run_id||query.baseline_cohort_key!==adoption.baseline_cohort_key)mismatch('评价必须使用本次采用的专用冻结比较');
      this.targets(request,adoption,query.work_ids,query.target_as_of);
      const expected=this.evaluationParameters(adoption,query.target_as_of);
      for(const key of Object.keys(expected) as (keyof ComparisonParameters)[])if(key!=='work_ids'&&!equal(query[key],expected[key]))mismatch('评价比较参数偏离冻结观察计划');
      if(query.as_of!==query.target_as_of)mismatch('评价不能回拨整体查询时间');
      const targets=run.selected_inputs_by_cohort.filter(cohort=>cohort.role==='target'),baselines=run.selected_inputs_by_cohort.filter(cohort=>cohort.role==='baseline');
      if(targets.length!==1||targets[0]!.account_id!==plan.account_id||targets[0]!.as_of!==query.target_as_of||targets[0]!.selected_inputs.some(selected=>!query.work_ids.includes(selected.canonical_work_id)))mismatch('评价目标集合或 cutoff 不匹配');
      if(plan.frozen_baseline) {
        const original=plan.frozen_baseline.cohort,copied=baselines[0];
        if(baselines.length!==1||!copied||copied.source_run_id!==plan.baseline_run_id||copied.source_cohort_key!==plan.baseline_cohort_key||copied.input_hash!==plan.baseline_input_hash||!equal(copied.selected_inputs,original.selected_inputs)||!equal(copied.exclusions,original.exclusions)||!equal(copied.definition,original.definition)||!equal(copied.window,original.window)||copied.as_of!==original.as_of)mismatch('评价基线不是精确冻结 S1 集合');
      }else if(baselines.length)mismatch('无基线采用不能补入新基线');
      const targetSamples=new Set(targets[0]!.selected_inputs.map(input=>input.canonical_work_id)).size,baselineSamples=new Set(plan.frozen_baseline?.cohort.selected_inputs.map(input=>input.canonical_work_id) ?? []).size;
      const enough=run.result.status==='comparable'&&plan.frozen_baseline!==null&&targetSamples>=plan.min_target_samples&&baselineSamples>=Math.max(5,plan.frozen_baseline.parameters.min_baseline_samples)&&this.rawAvailable(request,run);
      if(!enough&&input.result!=='insufficient')mismatch('缺基线、样本或原始数据时只能记录 insufficient');
      const previous=adoption.evaluations.find(evaluation=>evaluation.comparison_run_id===input.comparison_run_id);
      if(previous) {if(previous.result!==input.result||previous.limitations!==input.limitations)throw new ContractError('IDEMPOTENCY_CONFLICT','同一比较评价已经冻结');storeIdempotent(this.context.db,request,operation,body,previous);return previous;}
      const at=new Date(this.clock()).toISOString(),id=randomUUID();insertJson(this.context.db,'action_evaluations',{id,workspace_id:request.workspace_id,adoption_id:adoptionId,comparison_run_id:input.comparison_run_id,result:input.result,limitations:input.limitations,evaluated_at:at,created_at:at,updated_at:at});
      this.context.db.prepare("UPDATE retro_actions SET status='evaluated',updated_at=? WHERE workspace_id=? AND id=?").run(at,request.workspace_id,adoption.action_id);
      const result=getAdoption(this.context.db,request.workspace_id,adoptionId).evaluations.find(evaluation=>evaluation.id===id)!;storeIdempotent(this.context.db,request,operation,body,result);return result;
    });
  }
}
