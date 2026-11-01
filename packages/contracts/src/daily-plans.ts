import type { DailyPlanItemsRow, DailyPlansRow } from './entities.ts';
import { objectSchema } from './validation.ts';
import { ContractError } from './errors.ts';
export type DailyItemStatus='pending'|'in_progress'|'done'|'skipped';
export interface DailyPlanItemInput { id?:string; topic_id?:string|null; job_id?:string|null; action_id?:string|null; effort_min:number; status:DailyItemStatus }
export interface PutDailyPlanRequest { timezone:string; expected_version:number; budget_min?:number; items:DailyPlanItemInput[] }
export interface DailyPlanItem extends Omit<DailyPlanItemsRow,'status'> { status:DailyItemStatus }
export interface DailyPlan extends DailyPlansRow { items:DailyPlanItem[]; effort_min:number }
const itemProperties={id:{type:'string',minLength:1},topic_id:{type:['string','null'],minLength:1},job_id:{type:['string','null'],minLength:1},action_id:{type:['string','null'],minLength:1},effort_min:{type:'integer',minimum:0,maximum:1440},status:{type:'string',enum:['pending','in_progress','done','skipped']}};
export const PutDailyPlanSchema=objectSchema<PutDailyPlanRequest>(['timezone','expected_version','items'],{timezone:{type:'string'},expected_version:{type:'integer',minimum:0},budget_min:{type:'integer',minimum:0,maximum:1440},items:{type:'array',maxItems:100,items:{type:'object',additionalProperties:false,required:['effort_min','status'],properties:itemProperties}}},value=>{
  try {new Intl.DateTimeFormat('en',{timeZone:value.timezone as string});}catch{throw new ContractError('VALIDATION_ERROR','IANA 时区无效');}
  const items=value.items as DailyPlanItemInput[];
  for(const item of items)if(['topic_id','job_id','action_id'].filter(key=>typeof item[key as keyof DailyPlanItemInput]==='string'&&String(item[key as keyof DailyPlanItemInput]).trim()).length!==1)throw new ContractError('VALIDATION_ERROR','计划项必须关联一个主题、任务或行动');
  if(items.filter(item=>item.status!=='skipped').reduce((sum,item)=>sum+item.effort_min,0)>Number(value.budget_min??120))throw new ContractError('VALIDATION_ERROR','人工计划投入超过预算');
});
