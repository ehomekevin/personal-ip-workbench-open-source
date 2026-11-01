import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,readFileSync,cpSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {RequestContext,ServiceConfiguration,ImageGenerationRequest,JsonObject,ExecutorHealth} from '../../packages/contracts/src/index.ts';
import {createConfigurationModule} from '../../apps/service/src/routes/configuration.ts';
import type {ImageProviderSettingsOptions} from '../../packages/domain/src/settings/image-providers.ts';
import {startApplication} from '../../apps/service/src/bootstrap/application.ts';
import {DEFAULT_MODULE_FACTORIES} from '../../apps/service/src/bootstrap/modules.ts';
import {createExecutionModule} from '../../apps/service/src/bootstrap/execution.ts';
import {createArtifactsModule} from '../../apps/service/src/routes/artifacts.ts';
import {createImageStudioModule} from '../../apps/service/src/routes/image-studio.ts';
import {createMediaHandlers} from '../../apps/service/src/worker/handlers/media/index.ts';
import {DurableWorker} from '../../apps/service/src/worker/core/index.ts';
import {ImageGenerationWorkflow} from '../../packages/domain/src/artifact-execution/image.ts';
import {ImageProviderSettings} from '../../packages/domain/src/settings/image-providers.ts';
import {Topics} from '../../packages/domain/src/topics/index.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import {ContentGeneration} from '../../packages/domain/src/content-agents/index.ts';
import {baseCheckpoint} from '../../packages/adapters/src/media/image/common.ts';
import type {ImageProviderPort,ImageProviderInput,ImageProviderResult,ImageBriefAnalysisPort} from '../../packages/adapters/src/media/image/index.ts';
import {writeSolidPng} from '../helpers/png.ts';
import type {WebImageOptions} from '../../packages/domain/src/artifact-execution/image-studio/web-images.ts';

export const STUDIO_ARTICLE='先把一条内容的核心观点讲清楚，再为这条内容选择合适的配图。配图帮助读者理解，不代替文章里的事实。\n\n一个任务从说明、生成到采用，都保留实际结果和原始文件。新的画幅版本可以比较，旧版仍然可以回退。\n\n最终阅读时一起检查正文和图片。只有本人逐图采用并确认终稿，才保存这一版文章的 Wiki 记录。';
export class StudioFixtureProvider implements ImageProviderPort {
 readonly id='agy' as const;submits=0;queries=0;hold:Promise<void>|null=null;disconnect=false;noId=false;last:ImageProviderInput|null=null;
 actual_size:{width:number;height:number}|null=null;
 describe(){return Promise.resolve({configured:true,fixture:true});}
 async execute(input:ImageProviderInput,options:{signal:AbortSignal;checkpoint:(value:JsonObject)=>void}):Promise<ImageProviderResult>{
  this.submits++;this.last=input;const cp={...baseCheckpoint(input),conversation_id:'fixture-'+input.binding.job_id};if(!this.noId)options.checkpoint(cp);
  if(this.hold)await Promise.race([this.hold,new Promise<never>((_,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});})]);
  options.signal.throwIfAborted();if(this.disconnect||this.noId)throw new Error('fixture submit result unknown');return this.output(input,cp);
 }
 async query(input:ImageProviderInput,checkpoint:JsonObject):Promise<ImageProviderResult>{this.queries++;if(!checkpoint.conversation_id||checkpoint.input_hash!==input.binding.input_hash)throw new Error('fixture no original identity');return this.output(input,checkpoint);}
 output(input:ImageProviderInput,checkpoint:JsonObject):ImageProviderResult{
  const size=this.actual_size??input.size_request??{width:640,height:640};mkdirSync(input.output_directory,{recursive:true});const path=join(input.output_directory,'studio-fixture.png');
  writeSolidPng(path,size.width,size.height);const bytes=readFileSync(path);
  return{file_path:path,mime:'image/png',width:size.width,height:size.height,sha256:createHash('sha256').update(bytes).digest('hex'),size_bytes:bytes.length,model:input.provider==='agy'?'gemini-3.1-flash-image':null,
   native:{...structuredClone(checkpoint),accepted_image_parameters:{source:'local_fixture_only',structured_size_parameter:null,structured_aspect_parameter:null}},usage:null};
 }
}
export async function startStudioFixture(options:{out?:string;auto_worker?:boolean;records?:boolean;admit_codex?:boolean;image_generation_limits?:ServiceConfiguration['image_generation_limits'];analysis_timeout_ms?:number;web?:WebImageOptions;executor_health?:ExecutorHealth[];image_providers?:ImageProviderSettingsOptions}={}){
 const root=mkdtempSync(join(resolve(import.meta.dirname),'.studio-fixture-')),paths={source_vault_root:null,managed_notes_root:join(root,'notes'),state_root:join(root,'state'),media_root:join(root,'media')};for(const p of Object.values(paths))if(p)mkdirSync(p,{recursive:true});
 const config:ServiceConfiguration={workspace_id:randomUUID(),service_instance_id:randomUUID(),title:'公众号配图隔离验收',mode:'real',timezone:'America/Los_Angeles',paths,listen:{host:'127.0.0.1',port:43957},default_executor:'codex',api_fallback_enabled:false,...(options.image_generation_limits?{image_generation_limits:options.image_generation_limits}:{})};
 const provider=new StudioFixtureProvider();let briefCalls=0,analysisOutput:unknown=null,analysisFailure=false;let image:ImageGenerationWorkflow;
 const analysis:ImageBriefAnalysisPort={async analyze(request){briefCalls++;if(analysisFailure)throw new Error('fixture analysis result unknown');const source=JSON.parse(request.prompt.slice(request.prompt.indexOf('\n')+1)).source;
  return{output:analysisOutput??{analysis:{communication_goal:'说明实际任务从生成到采用的过程',layout_relationship:'sequence',text_density:'low',elements:[{label:'文章观点',source_quote:source.paragraph.slice(0,20)}],rationale:'以横向顺序表达当前原文的任务关系'},recommendation:{width:1600,height:900,aspect_ratio:'16:9',reason:'原文描述任务关系，横向顺序便于阅读'}},provenance:{provider:'codex',input_hash:request.input_hash,native_thread_id:'fixture-brief-thread',native_turn_id:'fixture-brief-'+briefCalls,model:null,usage:null}};}};
 let app:Awaited<ReturnType<typeof startApplication>>|undefined,timer:ReturnType<typeof setInterval>|undefined,inFlight:Promise<unknown>|null=null;
 try{
  app=await startApplication(config,{port:0,executorHealth:async()=>structuredClone(options.executor_health??[]),moduleFactories:[...DEFAULT_MODULE_FACTORIES.filter(f=>![createExecutionModule,createArtifactsModule,createImageStudioModule,...(options.image_providers?[createConfigurationModule]:[])].includes(f)),...(options.image_providers?[(c:Parameters<typeof createConfigurationModule>[0])=>createConfigurationModule(c,{imageProviders:options.image_providers})]:[]),c=>{image=new ImageGenerationWorkflow(c,{provider:()=>provider});return createArtifactsModule(c,{image});},c=>createImageStudioModule(c,{image,analysis,...(options.analysis_timeout_ms?{analysis_timeout_ms:options.analysis_timeout_ms}:{}),...(options.web?{web:options.web}:{}),...(options.records===false?{}:{record_root:paths.managed_notes_root})})]});
  const request=(key:string=randomUUID()):RequestContext=>({...app!.identity,request_id:randomUUID(),idempotency_key:key,request_identity_ref:'studio-fixture-human'}),context=app.context;
  const topic=await new Topics(context).create(request(),{title:'一条内容如何完成配图',category:'AI实践',audience:'AI使用者',source_ids:[]}),documents=new Documents(context);
  const core=await documents.save(request(),topic.core_document_id,{expected_revision_id:null,text:STUDIO_ARTICLE,origin:'human'});await documents.approveCore(request(),topic.id,core.revision_id);
  const variant=new ContentGeneration(context).createVariant(request(),topic.id,{platform:'wechat',format:'article'}),wechat=await documents.save(request(),String(variant.document_id),{expected_revision_id:null,text:STUDIO_ARTICLE,origin:'human'});
  new ImageProviderSettings(context).save(request(),{expected_version:1,default_provider:'agy',enabled:{agy:true,codex:true}});
  const worker=new DurableWorker(context,createMediaHandlers(context,{image:image!}),{owner:'studio-local-fixture',heartbeat_ms:100});
  let admissionFixtureCalls=0;
  if(options.admit_codex){image!.enqueue(request(),{generator:'image',provider:'codex',operation:'generate',topic_id:topic.id,purpose:'fixture-only Codex consumer admission',prompt:'Local deterministic fixture admission; no native model call.',input_asset_ids:[],parent_asset_id:null,document_revision_id:wechat.revision_id,plan_revision_id:null});await worker.runOnce();admissionFixtureCalls=provider.submits;}
  const runOnce=()=>worker.runOnce();if(options.auto_worker!==false){timer=setInterval(()=>{if(!inFlight&&context.db.prepare("SELECT id FROM jobs WHERE state='queued' AND kind='media_generate' LIMIT 1").get()){inFlight=runOnce().finally(()=>{inFlight=null;});}},40);timer.unref();}
  const base='http://127.0.0.1:'+app.address.port,headers={'content-type':'application/json','x-workspace-id':app.identity.workspace_id,'x-service-instance-id':app.identity.service_instance_id};
  const call=(method:string,path:string,body?:unknown,key:string=randomUUID())=>fetch(base+path,{method,headers:{...headers,'idempotency-key':key},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const input:ImageGenerationRequest={generator:'image',provider:'agy',operation:'generate',topic_id:topic.id,purpose:'fixture',prompt:'fixture',input_asset_ids:[],parent_asset_id:null,document_revision_id:wechat.revision_id,plan_revision_id:null};
  return{app,root,topic,input,variant_id:String(variant.id),document_id:String(variant.document_id),document_revision_id:wechat.revision_id,provider,request,call,runOnce,analysis,
   setAnalysisOutput(value:unknown){analysisOutput=value;},setAnalysisFailure(value:boolean){analysisFailure=value;},get brief_calls(){return briefCalls;},get image_calls(){return provider.submits;},get admission_fixture_image_calls(){return admissionFixtureCalls;},
   async close(){if(timer)clearInterval(timer);provider.hold=null;await inFlight;await app!.close();if(options.out){const evidence=resolve(options.out);mkdirSync(evidence,{recursive:true});cpSync(root,join(evidence,'fixture-workspace'),{recursive:true,errorOnExist:true,force:false});}rmSync(root,{recursive:true,force:true});}};
 }catch(error){if(timer)clearInterval(timer);await app?.close();rmSync(root,{recursive:true,force:true});throw error;}
}
