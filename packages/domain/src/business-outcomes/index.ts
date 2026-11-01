import { randomUUID } from 'node:crypto';
import { ContractError,CreateBusinessEventSchema,type CreateBusinessEventRequest,type BusinessEventsRow,type RequestContext } from '@workbench/contracts';
import { transaction } from '@workbench/storage/connection';
import { readIdempotent,storeIdempotent } from '@workbench/storage/revisions';
import { insertBusinessEvent,listBusinessEvents,type BusinessEventQuery } from '@workbench/storage/business-outcomes';
import { assertRequestIdentity } from '../documents/index.ts';
import type { ApplicationContext } from '../ports/index.ts';
export { CreateBusinessEventSchema } from '@workbench/contracts';
export type { BusinessEventQuery } from '@workbench/storage/business-outcomes';
export class BusinessOutcomes {
  readonly context:ApplicationContext;readonly clock:()=>number;
  constructor(context:ApplicationContext,options:{clock?:()=>number}={}) {this.context=context;this.clock=options.clock ?? Date.now;}
  list(request:RequestContext,query:BusinessEventQuery={}) {assertRequestIdentity(this.context,request);return listBusinessEvents(this.context.db,request.workspace_id,query);}
  create(request:RequestContext,input:CreateBusinessEventRequest):BusinessEventsRow {
    assertRequestIdentity(this.context,request);CreateBusinessEventSchema.parse(input);
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.time)||!Number.isFinite(Date.parse(input.time))||Date.parse(input.time)>this.clock()||new Date(input.time).toISOString().slice(0,19)!==input.time.slice(0,19))throw new ContractError('VALIDATION_ERROR','业务记录时刻无效');
    for(const key of ['count','amount'] as const)if(input[key]!=null&&!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input[key]!))throw new ContractError('VALIDATION_ERROR','业务数量或金额必须为非负 decimal');
    if(input.attribution==='source_verified'&&(!(input.work_id||input.topic_id)||!input.note.trim()))throw new ContractError('VALIDATION_ERROR','已核对来源必须保留实体和出处');
    return transaction(this.context.db,()=>{
      const operation='business-events.create',replay=readIdempotent<BusinessEventsRow>(this.context.db,request,operation,input);if(replay)return replay;
      for(const [key,table] of [['work_id','works'],['topic_id','topics']] as const)if(input[key]&&!this.context.db.prepare(`SELECT id FROM ${table} WHERE workspace_id=? AND id=?`).get(request.workspace_id,input[key]!))throw new ContractError('NOT_FOUND','业务记录关联实体不存在');
      if(input.work_id&&input.topic_id){const work=this.context.db.prepare('SELECT topic_id FROM works WHERE workspace_id=? AND id=?').get(request.workspace_id,input.work_id);if(work?.topic_id!==input.topic_id)throw new ContractError('VALIDATION_ERROR','业务记录作品与主题关联不同');}
      const at=new Date(this.clock()).toISOString(),row:BusinessEventsRow={id:randomUUID(),workspace_id:request.workspace_id,kind:input.kind,occurred_at:input.time,work_id:input.work_id ?? null,topic_id:input.topic_id ?? null,count:input.count ?? null,amount:input.amount ?? null,note:input.note,attribution_status:input.attribution,created_at:at,updated_at:at};
      insertBusinessEvent(this.context.db,row);storeIdempotent(this.context.db,request,operation,input,row);return row;
    });
  }
}
