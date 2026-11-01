import { DailyPlans, PutDailyPlanSchema } from '@workbench/domain/daily-plans';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
export function createDailyPlansModule(context: ApplicationContext): ApplicationModule {
  const daily=new DailyPlans(context);
  return {id:'daily-plans',register(registrar) { registrar.register({method:'PUT',path:'/api/v1/daily-plans/{local_date}',owner:'WP-14',mutation:true,idempotent:true,schema:PutDailyPlanSchema,handle:request => ({body:daily.put(request.context,request.params.local_date!,request.body)})}); },health:()=>({module:'daily-plans',status:'ready',details:{capability_scope:'internal_rule'}})};
}
