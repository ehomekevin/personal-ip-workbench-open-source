import type { CreateBusinessEventRequest,BusinessEventsRow,Page } from '@workbench/contracts';
import type { PageFeaturePort,FeatureContext,FeatureAction } from '../../../transport/feature-ports.ts';
import type { ViewContext } from '../../../app/view-model.ts';
import { createTemplateHelpers } from '../../../components/templateHelpers.ts';
export interface BusinessOutcomesFeatureOptions {loadBase(context:FeatureContext):Promise<ViewContext>;dispatchRelated?(action:FeatureAction,context:FeatureContext):Promise<ViewContext|void>}
export async function createBusinessEvent(context:FeatureContext,input:CreateBusinessEventRequest,idempotencyKey=crypto.randomUUID()):Promise<BusinessEventsRow> {return context.client.request('POST','/api/v1/business-events',input,{signal:context.signal,idempotencyKey});}
export function createBusinessOutcomesFeaturePort(options:BusinessOutcomesFeatureOptions):PageFeaturePort<'retro'> {
  let current:BusinessEventsRow|undefined;
  async function load(context:FeatureContext):Promise<ViewContext> {
    const base=await options.loadBase(context);if(base.provenance!=='service')throw new Error('业务结果正式投影只接受 service 数据');
    let cursor:string|null=null;const records:BusinessEventsRow[]=[];
    do{const page:Page<BusinessEventsRow>=await context.client.request('GET','/api/v1/business-events?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''),undefined,{signal:context.signal});records.push(...page.items);cursor=page.next_cursor;}while(cursor);
    current=records.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id)).at(-1);
    return {...base,state:{...base.state,business:{count:current?.count ?? null,source:current?.attribution_status==='unknown'?'未知':current?.note ?? '尚无记录'}}};
  }
  async function dispatch(action:FeatureAction,context:FeatureContext):Promise<ViewContext|void> {
    if(action.action==='business') {const {esc,btn}=createTemplateHelpers([]);context.surface.presentDialog({title:'补充业务结果',body:'<label class="field-label" for="business-count">咨询 / 合作线索数</label><input class="field" id="business-count" type="number" min="0" value="'+esc(current?.count ?? '0')+'"><label class="field-label" for="business-source">关联作品 / 来源</label><input class="field" id="business-source" value="'+esc(current?.note ?? '')+'" placeholder="不明确可填“未知”">',foot:btn('取消','close-dialog')+btn('保存记录','save-business',true)});return;}
    if(action.action==='save-business') {const count=String(action.fields['business-count'] ?? ''),source=String(action.fields['business-source'] ?? '').trim()||'未知';if(!/^(?:0|[1-9]\d*)$/.test(count))throw new Error('请输入不小于零的整数');await createBusinessEvent(context,{kind:'consultation',time:new Date().toISOString(),count,note:source,attribution:source==='未知'?'unknown':'user_reported'});context.surface.closeDialog('completed');context.surface.toast('业务结果已保存');return load(context);}
    return options.dispatchRelated?.(action,context);
  }
  return {page:'retro',load,dispatch};
}
