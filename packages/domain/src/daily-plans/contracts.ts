import { ContractError, PutDailyPlanSchema as PublicPutDailyPlanSchema, type DailyPlanItemInput, type PutDailyPlanRequest, type RuntimeSchema } from '@workbench/contracts';
export type { DailyPlanItemInput, PutDailyPlanRequest, DailyPlan } from '@workbench/contracts';
export const DAILY_ITEM_STATUSES = ['pending','in_progress','done','skipped'] as const;
export function validTimezone(value: string): void { try { if (!value) throw new Error(); new Intl.DateTimeFormat('en', { timeZone: value }); } catch { throw new ContractError('VALIDATION_ERROR','IANA 时区无效'); } }
export function validLocalDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value+'T00:00:00Z')) || new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value) throw new ContractError('VALIDATION_ERROR','本地日历日期无效');
}
export function localDateAt(at: number, timezone: string): string {
  validTimezone(timezone); const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const part = (name: string) => parts.find(item => item.type===name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function itemReference(item: DailyPlanItemInput): { kind: 'topic_id'|'job_id'|'action_id'; id: string } {
  const references = (['topic_id','job_id','action_id'] as const).filter(key => item[key] != null);
  if (references.length !== 1 || !item[references[0]!]!.trim()) throw new ContractError('VALIDATION_ERROR','计划项必须恰好关联一个主题、任务或建议');
  return { kind: references[0]!, id: item[references[0]!]! };
}
export const PutDailyPlanSchema: RuntimeSchema<PutDailyPlanRequest> = {jsonSchema:PublicPutDailyPlanSchema.jsonSchema,parse(value) {
  const parsed=PublicPutDailyPlanSchema.parse(value); validTimezone(parsed.timezone); const items = parsed.items, references = items.map(item => { const ref=itemReference(item); return `${ref.kind}:${ref.id}`; });
  if (new Set(references).size !== references.length || new Set(items.flatMap(item => item.id ? [item.id] : [])).size !== items.filter(item => item.id).length) throw new ContractError('VALIDATION_ERROR','计划项关联或 ID 重复');
  return parsed;
}};
