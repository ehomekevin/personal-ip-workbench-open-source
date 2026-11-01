import { PutSkillSettingsSchema, CreateSkillDraftSchema } from '@workbench/contracts';
import type { ApplicationContext,ApplicationModule } from '@workbench/domain/ports';
import { SkillSettings, SkillLibrary } from '@workbench/domain/skills';
import { ContentGeneration } from '@workbench/domain/content-agents';
export function createSkillsModule(context:ApplicationContext):ApplicationModule {
  const skills=new SkillSettings(context),library=new SkillLibrary(context),generation=new ContentGeneration(context,{skill_library:library});
  return {id:'skills',register(registrar){
    registrar.register({method:'GET',path:'/api/v1/settings/skills/library',owner:'SKILLS-01',handle:request=>({body:library.get(request.context)})});
    registrar.register({method:'GET',path:'/api/v1/settings/skills/library/{id}',owner:'SKILLS-01',handle:request=>({body:library.source(request.context,request.params.id!)})});
    registrar.register({method:'GET',path:'/api/v1/settings/skills/samples',owner:'SKILLS-01',handle:async request=>({body:await library.samples(request.context,request.query.get('query')??'')})});
    registrar.register({method:'GET',path:'/api/v1/settings/skills',owner:'SKILLS-01',handle:request=>({body:skills.get(request.context)})});
    registrar.register({method:'PUT',path:'/api/v1/settings/skills',owner:'SKILLS-01',mutation:true,idempotent:true,schema:PutSkillSettingsSchema,handle:request=>({body:skills.put(request.context,request.body)})});
    registrar.register({method:'POST',path:'/api/v1/settings/skills/drafts',owner:'SKILLS-01',mutation:true,idempotent:true,schema:CreateSkillDraftSchema,handle:async request=>({status:202,body:await generation.draftSkill(request.context,request.body)})});
  },health:()=>({module:'skills',status:'ready',details:{native_codex:'explicit_multiple_skill_inputs',native_claude:'unverified'}})};
}
