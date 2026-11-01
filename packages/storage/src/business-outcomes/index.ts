import { ContractError,type BusinessEventsRow,type Page,type ListQuery } from '@workbench/contracts';
import { type DatabaseSync } from '../connection/index.ts';
import { decodePageCursor,encodePageCursor } from '../revisions/page.ts';
export interface BusinessEventQuery extends ListQuery { work_id?:string;topic_id?:string }
export function listBusinessEvents(db:DatabaseSync,workspaceId:string,query:BusinessEventQuery={}):Page<BusinessEventsRow> {
  const [created,id]=decodePageCursor(query.cursor),limit=query.limit ?? 50;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ContractError('VALIDATION_ERROR','业务记录分页大小无效');
  const rows=db.prepare('SELECT * FROM business_events WHERE workspace_id=? AND (created_at>? OR (created_at=? AND id>?)) AND (? IS NULL OR work_id=?) AND (? IS NULL OR topic_id=?) ORDER BY created_at,id LIMIT ?').all(workspaceId,created,created,id,query.work_id ?? null,query.work_id ?? null,query.topic_id ?? null,query.topic_id ?? null,limit+1) as unknown as BusinessEventsRow[];
  const items=rows.slice(0,limit);return {items,has_more:rows.length>limit,next_cursor:rows.length>limit?encodePageCursor(items.at(-1)!):null,last_success_at:new Date().toISOString()};
}
export function insertBusinessEvent(db:DatabaseSync,row:BusinessEventsRow):void {
  if(!db.isTransaction)throw new Error('业务记录写入需要最终领域事务');
  db.prepare('INSERT INTO business_events(id,workspace_id,kind,occurred_at,work_id,topic_id,count,amount,note,attribution_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.workspace_id,row.kind,row.occurred_at,row.work_id,row.topic_id,row.count,row.amount,row.note,row.attribution_status,row.created_at,row.updated_at);
}
