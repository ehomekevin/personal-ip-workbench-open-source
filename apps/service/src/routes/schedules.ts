import { Schedules } from '@workbench/domain/schedules';
import { Publications, type PublicationOptions } from '@workbench/domain/publications';
import { CreateScheduleSchema, PatchScheduleSchema, PublicationExpectedVersionSchema } from '@workbench/contracts';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
export function createSchedulesModule(context:ApplicationContext,options:PublicationOptions & {publications?:Publications}={}):ApplicationModule {const schedules=new Schedules(context,options.publications??new Publications(context,options));return {id:'schedules',register(registrar){
 registrar.register({method:'GET',path:'/api/v1/schedules',owner:'WP-20',handle:r=>({body:schedules.list(r.context,Object.fromEntries(['start','end','timezone','view','cursor','limit'].filter(k=>r.query.has(k)).map(k=>[k,k==='limit'?Number(r.query.get(k)):r.query.get(k)])))})});
 registrar.register({method:'POST',path:'/api/v1/schedules',owner:'WP-20',mutation:true,idempotent:true,schema:CreateScheduleSchema,handle:async r=>({status:201,body:await schedules.create(r.context,r.body)})});
 registrar.register({method:'PATCH',path:'/api/v1/schedules/{id}',owner:'WP-20',mutation:true,idempotent:true,schema:PatchScheduleSchema,handle:async r=>({body:await schedules.patch(r.context,r.params.id!,r.body)})});
 registrar.register({method:'POST',path:'/api/v1/schedules/{id}/cancel',owner:'WP-20',mutation:true,idempotent:true,schema:PublicationExpectedVersionSchema,handle:r=>({body:schedules.cancel(r.context,r.params.id!,r.body)})});
 },health:()=>({module:'schedules',status:'ready'})};}
