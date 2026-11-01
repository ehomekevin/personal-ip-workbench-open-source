import { CreatePublishingConnectionSchema, PatchPublishingConnectionSchema, ApplyPublishingConnectionSchema, CheckPublishingConnectionSchema, SetPublishingConnectionEnabledSchema, SetDefaultPublishingAccountSchema } from '@workbench/contracts';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
import type { PublishingSettings } from '@workbench/domain/publishing-settings';
export function createPublishingSettingsModule(_context:ApplicationContext, settings:PublishingSettings):ApplicationModule {
 return {id:'publishing-settings',register(registrar){
  registrar.register({method:'GET',path:'/api/v1/settings/publishing',owner:'WP-08',handle:async request=>({body:await settings.get(request.context)})});
  registrar.register({method:'POST',path:'/api/v1/settings/publishing/connections',owner:'WP-08',mutation:true,idempotent:true,schema:CreatePublishingConnectionSchema,handle:async request=>({body:await settings.create(request.context,request.body)})});
  registrar.register({method:'PATCH',path:'/api/v1/settings/publishing/connections/{id}',owner:'WP-08',mutation:true,idempotent:true,schema:PatchPublishingConnectionSchema,handle:async request=>({body:await settings.patch(request.context,request.params.id!,request.body)})});
  registrar.register({method:'POST',path:'/api/v1/settings/publishing/connections/{id}/apply',owner:'WP-08',mutation:true,idempotent:true,schema:ApplyPublishingConnectionSchema,handle:async request=>({body:await settings.apply(request.context,request.params.id!,request.body)})});
  registrar.register({method:'POST',path:'/api/v1/settings/publishing/connections/{id}/check',owner:'WP-08',mutation:true,idempotent:true,schema:CheckPublishingConnectionSchema,handle:async request=>({body:await settings.check(request.context,request.params.id!,request.body)})});
  registrar.register({method:'PUT',path:'/api/v1/settings/publishing/connections/{id}/enabled',owner:'WP-08',mutation:true,idempotent:true,schema:SetPublishingConnectionEnabledSchema,handle:async request=>({body:await settings.setEnabled(request.context,request.params.id!,request.body)})});
  registrar.register({method:'PUT',path:'/api/v1/settings/publishing/defaults',owner:'WP-08',mutation:true,idempotent:true,schema:SetDefaultPublishingAccountSchema,handle:async request=>({body:await settings.setDefault(request.context,request.body)})});
 },health:()=>({module:'publishing-settings',status:'ready',details:{config_source:'sqlite',real_platform_acceptance:'pending'}})};
}
