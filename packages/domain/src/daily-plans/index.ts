import { ContractError, type RequestContext, type OverviewResponse, type TopicSummary, type JsonObject } from '@workbench/contracts';
import { transaction, sha256 } from '@workbench/storage/connection';
import { readIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import { getDailyPlan, replaceDailyPlan } from '@workbench/storage/daily-plans';
import { Sources } from '../sources/index.ts';
import { assertRequestIdentity } from '../documents/index.ts';
import {withTopicReadState} from '../topics/read-state.ts';
import type { ApplicationContext } from '../ports/index.ts';
import { operatingPreferences } from '../settings/configuration.ts';
import { PutDailyPlanSchema, localDateAt, validLocalDate, validTimezone, type PutDailyPlanRequest, type DailyPlan } from './contracts.ts';
export * from './contracts.ts';
export class DailyPlans {
  readonly context: ApplicationContext; readonly clock: () => number;
  constructor(context: ApplicationContext, options: { clock?: () => number } = {}) { this.context=context; this.clock=options.clock ?? Date.now; }
  put(request: RequestContext, date: string, input: PutDailyPlanRequest): DailyPlan {
    assertRequestIdentity(this.context,request); validLocalDate(date); PutDailyPlanSchema.parse(input);
    const body = { local_date: date, ...input }, operation='daily-plans.put';
    return transaction(this.context.db,() => {
      const replay=readIdempotent<DailyPlan>(this.context.db,request,operation,body); if(replay)return replay;
      const semantic={...request,idempotency_key:`daily-plan:${sha256(input.timezone)}:${date}:version:${input.expected_version}`};
      const existing=readIdempotent<DailyPlan>(this.context.db,semantic,operation,body);
      if(existing) { storeIdempotent(this.context.db,request,operation,body,existing); return existing; }
      const result=replaceDailyPlan(this.context.db,request.workspace_id,date,input.timezone,input.expected_version,input.budget_min ?? operatingPreferences(this.context.db,request.workspace_id).daily_budget_min,input.items,new Date(this.clock()).toISOString());
      storeIdempotent(this.context.db,semantic,operation,body,result); storeIdempotent(this.context.db,request,operation,body,result); return result;
    });
  }
  overview(request: RequestContext, query: { date?: string; timezone?: string } = {}): OverviewResponse & { budget_min: number; effort_min: number; recent_news: ReturnType<Sources['records']>['items'] } {
    assertRequestIdentity(this.context,request); const workspace=this.context.db.prepare('SELECT timezone FROM workspaces WHERE id=?').get(request.workspace_id);
    if(!workspace)throw new ContractError('NOT_FOUND','工作区不存在');
    const timezone=query.timezone ?? String(workspace.timezone); validTimezone(timezone); const date=query.date ?? localDateAt(this.clock(),timezone); validLocalDate(date);
    const plan=getDailyPlan(this.context.db,request.workspace_id,date,timezone);
    const topics=withTopicReadState(this.context.db,request.workspace_id,this.context.db.prepare("SELECT * FROM topics WHERE workspace_id=? AND status='active' ORDER BY updated_at DESC,id LIMIT 50").all(request.workspace_id) as unknown as TopicSummary[]);
    const jobs=this.context.db.prepare("SELECT id,kind,target_id,state,presentation,due_at,version,created_at,updated_at FROM jobs WHERE workspace_id=? AND state IN ('queued','running','waiting_input','waiting_quota','cancel_requested','reconciling') ORDER BY updated_at DESC,id LIMIT 50").all(request.workspace_id) as JsonObject[];
    const actions=this.context.db.prepare("SELECT id,report_id,description,hypothesis,status,created_at,updated_at FROM retro_actions WHERE workspace_id=? AND status IN ('proposed','adopted','observing') ORDER BY updated_at DESC,id LIMIT 50").all(request.workspace_id) as JsonObject[];
    const recent_news=new Sources(this.context).records(request,{curated:true,order:'published_desc',limit:5}).items;
    return { local_date:date,timezone,updated_at:new Date(this.clock()).toISOString(),plan:plan as unknown as JsonObject|null,items:(plan?.items ?? []) as unknown as JsonObject[],budget_min:plan?.budget_min ?? operatingPreferences(this.context.db,request.workspace_id).daily_budget_min,effort_min:plan?.effort_min ?? 0,topics,jobs,actions,recent_news };
  }
}
