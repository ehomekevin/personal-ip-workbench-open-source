import { ArtifactExecution, H3VoiceWorkflow, ImageGenerationWorkflow } from '@workbench/domain/artifact-execution';
import { VoiceSampleSchema, VoiceRecoverSchema } from '@workbench/contracts';
import { ContentRenderSchema, ProductionRenderSchema, AssetGenerationSchema, type ContentRenderRequest, type ProductionRenderRequest } from '@workbench/contracts';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';

export function createArtifactsModule(context:ApplicationContext,options:{image?:ImageGenerationWorkflow}={}):ApplicationModule {
  const media=new ArtifactExecution(context),voice=new H3VoiceWorkflow(context),image=options.image??new ImageGenerationWorkflow(context);
  return {id:'artifacts',register(registrar){
    registrar.register({method:'GET',path:'/api/v1/media/voice',owner:'H3-VOICE-01',handle:async request=>({body:await voice.readiness(request.context)})});
    registrar.register({method:'POST',path:'/api/v1/media/voice',owner:'H3-VOICE-01',mutation:true,idempotent:true,schema:VoiceSampleSchema,handle:request=>({status:202,body:voice.enqueue(request.context,request.body)})});
    registrar.register({method:'POST',path:'/api/v1/media/voice/{id}/recover',owner:'H3-VOICE-01',mutation:true,idempotent:true,schema:VoiceRecoverSchema,handle:async request=>({status:202,body:await voice.recover(request.context,request.params.id!)})});
    for(const kind of ['content','production'] as const)registrar.register<ContentRenderRequest|ProductionRenderRequest>({
      method:'POST',path:`/api/v1/${kind}-plans/{id}/renders`,owner:'WP-19',mutation:true,idempotent:true,
      schema:kind==='content'?ContentRenderSchema:ProductionRenderSchema,
      handle:async request=>({status:202,body:await media.enqueue(request.context,kind,request.params.id!,{
        revision_id:kind==='content'?(request.body as ContentRenderRequest).content_plan_revision_id:(request.body as ProductionRenderRequest).production_plan_revision_id,
        preset:request.body.preset,mode:request.body.mode,
      })}),
    });
    registrar.register({method:'POST',path:'/api/v1/asset-generations',owner:'WP-19',mutation:true,idempotent:true,schema:AssetGenerationSchema,handle:async request=>({status:202,body:request.body.generator==='image'?await image.enqueueBudgeted(request.context,request.body):media.enqueueGeneration(request.context,request.body)})});
    registrar.register({method:'GET',path:'/api/v1/artifacts/{id}',owner:'WP-19',handle:async request=>{const result=await media.read(request.context,request.params.id!);return {body:{artifact_id:result.artifact.id,sha256:result.artifact.sha256,manifest:result.manifest}};}});
    registrar.register({method:'GET',path:'/api/v1/artifacts/{id}/files/{file_ref}',owner:'WP-19',handle:async request=>{const file=await media.content(request.context,request.params.id!,request.params.file_ref!);return {body:null,stream:file.stream,headers:{'content-type':file.mime,'content-length':String(file.size_bytes),'content-disposition':`attachment; filename="${file.filename.replaceAll('"','')}"`,'x-content-type-options':'nosniff'}};}});
  },health:()=>({module:'artifacts',status:'ready',details:{renderer:'wp19-local-render/1',preset:'wp05-local/1',h3:'unconfigured',publishable:false}})};
}
