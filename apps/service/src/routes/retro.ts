import { Retro,CreateRetroActionSchema,AdoptRetroActionSchema,LinkAdoptionWorkSchema,CreateAdoptionComparisonSchema,CreateAdoptionEvaluationSchema,type RetroListQuery } from '@workbench/domain/retro';
import type { ApplicationContext,ApplicationModule } from '@workbench/domain/ports';
export function createRetroModule(context:ApplicationContext):ApplicationModule {
  const retro=new Retro(context);
  return {id:'retro',register(registrar) {
    const query=(params:URLSearchParams):RetroListQuery=>{const input:RetroListQuery={};for(const key of ['platform','status','topic_id','comparison_run_id','cursor'] as const)if(params.has(key))input[key]=params.get(key)!;if(params.has('limit'))input.limit=Number(params.get('limit'));return input;};
    registrar.register({method:'GET',path:'/api/v1/retro-reports',owner:'WP-14',handle:request=>({body:retro.reports(request.context,query(request.query))})});
    registrar.register({method:'GET',path:'/api/v1/retro-reports/{id}',owner:'WP-14',handle:async request=>({body:await retro.report(request.context,request.params.id!)})});
    registrar.register({method:'GET',path:'/api/v1/retro-actions',owner:'WP-14',handle:request=>({body:retro.actions(request.context,query(request.query))})});
    registrar.register({method:'GET',path:'/api/v1/retro-actions/{id}',owner:'WP-14',handle:request=>({body:retro.action(request.context,request.params.id!)})});
    registrar.register({method:'POST',path:'/api/v1/retro-reports/{id}/actions',owner:'WP-14',mutation:true,idempotent:true,schema:CreateRetroActionSchema,handle:request=>({status:201,body:retro.createAction(request.context,request.params.id!,request.body)})});
    registrar.register({method:'POST',path:'/api/v1/retro-actions/{id}/adoptions',owner:'WP-14',mutation:true,idempotent:true,schema:AdoptRetroActionSchema,handle:request=>({status:201,body:retro.adopt(request.context,request.params.id!,request.body)})});
    registrar.register({method:'POST',path:'/api/v1/retro-adoptions/{id}/works',owner:'WP-14',mutation:true,idempotent:true,schema:LinkAdoptionWorkSchema,handle:request=>({status:201,body:retro.linkWork(request.context,request.params.id!,request.body)})});
    registrar.register({method:'POST',path:'/api/v1/retro-adoptions/{id}/comparisons',owner:'WP-14',mutation:true,idempotent:true,schema:CreateAdoptionComparisonSchema,handle:request=>({status:201,body:retro.compare(request.context,request.params.id!,request.body)})});
    registrar.register({method:'POST',path:'/api/v1/retro-adoptions/{id}/evaluations',owner:'WP-14',mutation:true,idempotent:true,schema:CreateAdoptionEvaluationSchema,handle:request=>({status:201,body:retro.evaluate(request.context,request.params.id!,request.body)})});
  },health:()=>({module:'retro',status:'ready',details:{capability_scope:'internal_rule',real_observation:'pending_wp30'}})};
}
