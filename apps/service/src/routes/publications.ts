import { ContractError } from '@workbench/contracts';
import { Publications, type PublicationOptions, type PublicationFilter } from '@workbench/domain/publications';
import { CreatePublicationBatchSchema, PublicationExpectedVersionSchema, PublicationReconcileSchema } from '@workbench/contracts';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
import { Schedules } from '@workbench/domain/schedules';
import { PublicationWorker } from '../worker/handlers/publication/index.ts';
export interface PublicationsModuleOptions extends PublicationOptions {poll_ms?:number;run_worker?:boolean;publications?:Publications}
export function createPublicationsModule(context:ApplicationContext,options:PublicationsModuleOptions={}):ApplicationModule {
 const publications=options.publications??new Publications(context,options),schedules=new Schedules(context,publications),worker=new PublicationWorker(publications);let timer:ReturnType<typeof setInterval>|undefined,active:Promise<void>|null=null,closing=false,lastError:string|null=null;
 const tick=()=>{if(active||closing)return;active=worker.runOnce().then(()=>{lastError=null;}).catch(e=>{lastError=e instanceof ContractError?e.code:'internal_tick_failed';}).finally(()=>{active=null;});};
 return {id:'publications',initialize(){schedules.recoverStartup();publications.sweepRecovery();if(options.run_worker!==false){timer=setInterval(tick,options.poll_ms??1000);timer.unref();tick();}},async close(){closing=true;if(timer)clearInterval(timer);await active;},register(registrar){
  const filter=(query:URLSearchParams):PublicationFilter=>Object.fromEntries(['platform','account_id','state','topic_id','cursor','limit'].filter(k=>query.has(k)).map(k=>[k,k==='limit'?Number(query.get(k)):query.get(k)]));
  registrar.register({method:'POST',path:'/api/v1/publication-batches',owner:'WP-20',mutation:true,idempotent:true,schema:CreatePublicationBatchSchema,handle:async r=>({status:202,body:await publications.createBatch(r.context,r.body)})});
  registrar.register({method:'GET',path:'/api/v1/publication-batches',owner:'WP-20',handle:r=>({body:publications.listBatches(r.context,filter(r.query))})});
  registrar.register({method:'GET',path:'/api/v1/publication-batches/{id}',owner:'WP-20',handle:r=>({body:publications.getBatch(r.context,r.params.id!)})});
  registrar.register({method:'GET',path:'/api/v1/publication-intents',owner:'WP-20',handle:r=>({body:publications.list(r.context,filter(r.query))})});
  registrar.register({method:'GET',path:'/api/v1/publication-intents/{id}',owner:'WP-20',handle:r=>({body:publications.get(r.context,r.params.id!)})});
  for(const operation of ['retry','continue'] as const)registrar.register({method:'POST',path:`/api/v1/publication-intents/{id}/${operation}`,owner:'WP-20',mutation:true,idempotent:true,schema:PublicationExpectedVersionSchema,handle:r=>({status:202,body:publications.queueAction(r.context,r.params.id!,operation,r.body)})});
  registrar.register({method:'POST',path:'/api/v1/publication-intents/{id}/reconcile',owner:'WP-20',mutation:true,idempotent:true,schema:PublicationReconcileSchema,handle:r=>({status:202,body:publications.queueAction(r.context,r.params.id!,'reconcile',r.body)})});
 },health:()=>({module:'publications',status:lastError?'degraded':publications.bindings.length?'ready':'blocked',details:{real_platform:'unverified',last_tick_error:lastError,selected_bindings:publications.bindings.length}})};
}
