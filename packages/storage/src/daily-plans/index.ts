import { randomUUID } from 'node:crypto';
import { ContractError, type DailyPlansRow, type DailyPlanItem, type DailyPlanItemInput } from '@workbench/contracts';
import type { DatabaseSync } from '../connection/index.ts';
// 类型结构保持 storage 不反向依赖 domain。
export function getDailyPlan(db: DatabaseSync, workspaceId: string, date: string, timezone: string) {
  const row = db.prepare('SELECT * FROM daily_plans WHERE workspace_id=? AND local_date=? AND timezone=?').get(workspaceId,date,timezone) as unknown as DailyPlansRow | undefined;
  if (!row) return null;
  const items = db.prepare('SELECT * FROM daily_plan_items WHERE workspace_id=? AND plan_id=? ORDER BY position,id').all(workspaceId,row.id).map(item=>({...item})) as unknown as DailyPlanItem[];
  return { ...row, items, effort_min: items.reduce((total,item) => total+(item.status==='skipped'?0:item.effort_min),0) };
}
export function replaceDailyPlan(db: DatabaseSync, workspaceId: string, date: string, timezone: string, expected: number, budget: number, input: DailyPlanItemInput[], at: string) {
  if (!db.isTransaction) throw new Error('每日计划写入需要最终领域事务');
  const old = getDailyPlan(db,workspaceId,date,timezone);
  if ((old?.version ?? 0)!==expected) throw new ContractError('VERSION_CONFLICT','计划已被其他操作修改',{ expected_version: expected, current_version: old?.version ?? 0 });
  const planId = old?.id ?? randomUUID();
  const items = input.map((item,position) => {
    for (const [key,table] of [['topic_id','topics'],['job_id','jobs'],['action_id','retro_actions']] as const) if (item[key] && !db.prepare(`SELECT id FROM ${table} WHERE workspace_id=? AND id=?`).get(workspaceId,item[key]!)) throw new ContractError('NOT_FOUND','计划关联不存在',{ field: key });
    const same = old?.items.find(previous => previous.topic_id===(item.topic_id ?? null) && previous.job_id===(item.job_id ?? null) && previous.action_id===(item.action_id ?? null));
    const explicit = item.id ? old?.items.find(previous => previous.id===item.id) : null;
    if (item.id && (!explicit || explicit.id!==same?.id)) throw new ContractError('VALIDATION_ERROR','计划项 ID 不能跨计划或改写关联');
    return { ...item, id: explicit?.id ?? same?.id ?? randomUUID(), created_at: same?.created_at ?? at, position };
  });
  if (!old) db.prepare('INSERT INTO daily_plans(id,workspace_id,local_date,timezone,budget_min,version,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)').run(planId,workspaceId,date,timezone,budget,at,at);
  else db.prepare('UPDATE daily_plans SET budget_min=?,version=version+1,updated_at=? WHERE workspace_id=? AND id=? AND version=?').run(budget,at,workspaceId,planId,expected);
  // 全数组替换避免交换 position 时碰到唯一约束，事务外读者只见完整版本。
  db.prepare('DELETE FROM daily_plan_items WHERE workspace_id=? AND plan_id=?').run(workspaceId,planId);
  for (const item of items) db.prepare('INSERT INTO daily_plan_items(id,workspace_id,plan_id,topic_id,job_id,action_id,position,effort_min,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(item.id,workspaceId,planId,item.topic_id ?? null,item.job_id ?? null,item.action_id ?? null,item.position,item.effort_min,item.status,item.created_at,at);
  return getDailyPlan(db,workspaceId,date,timezone)!;
}
