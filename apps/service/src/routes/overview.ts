import { DailyPlans } from '@workbench/domain/daily-plans';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
export function createOverviewModule(context: ApplicationContext): ApplicationModule {
  const daily=new DailyPlans(context);
  return { id:'overview',register(registrar) { registrar.register({method:'GET',path:'/api/v1/overview',owner:'WP-14',handle:request => ({body:daily.overview(request.context,{...(request.query.has('date')?{date:request.query.get('date')!}:{}),...(request.query.has('timezone')?{timezone:request.query.get('timezone')!}:{})})})}); },health:()=>({module:'overview',status:'ready',details:{capability_scope:'internal_rule'}}) };
}
