import { BusinessOutcomes,CreateBusinessEventSchema,type BusinessEventQuery } from '@workbench/domain/business-outcomes';
import type { ApplicationContext,ApplicationModule } from '@workbench/domain/ports';
export function createBusinessOutcomesModule(context:ApplicationContext):ApplicationModule {
  const business=new BusinessOutcomes(context);
  return {id:'business-outcomes',register(registrar) {
    registrar.register({method:'POST',path:'/api/v1/business-events',owner:'WP-14',mutation:true,idempotent:true,schema:CreateBusinessEventSchema,handle:request=>({status:201,body:business.create(request.context,request.body)})});
    registrar.register({method:'GET',path:'/api/v1/business-events',owner:'WP-14',handle:request=>{const query:BusinessEventQuery={};for(const key of ['topic_id','work_id','cursor'] as const)if(request.query.has(key))query[key]=request.query.get(key)!;if(request.query.has('limit'))query.limit=Number(request.query.get('limit'));return {body:business.list(request.context,query)};}});
  },health:()=>({module:'business-outcomes',status:'ready',details:{capability_scope:'internal_rule',causal_attribution:'not_inferred'}})};
}
