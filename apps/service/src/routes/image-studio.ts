import {StudioBriefSchema,StudioGenerationSchema,StudioAdoptSchema,StudioConfirmSchema,StudioWebImportSchema,ImagePlanRunSchema,ImagePlanItemUpdateSchema,ImagePlanItemCreateSchema,StudioAssetVersionSchema,ImagePlanConfirmSchema,maxConcurrentGenerations} from '@workbench/contracts';
import type {ApplicationContext,ApplicationModule} from '@workbench/domain/ports';
import {ImageStudio} from '../../../../packages/domain/src/artifact-execution/image-studio/index.ts';
import {WebDnsGuard} from '../../../../packages/adapters/src/web/public-fetch.ts';
import {ImagePlans} from '../../../../packages/domain/src/artifact-execution/image-studio/plan.ts';
import {nativeImageBriefPort} from '../../../../packages/domain/src/artifact-execution/image-studio/native-brief.ts';
import {readStudio,writeStudio} from '../../../../packages/storage/src/image-studio/index.ts';
import {transaction} from '@workbench/storage/connection';
import {nativeAdapter,executorDiagnostics} from '../bootstrap/execution.ts';
// 文本分析与写作生成共用同一执行器槽位池（同一锁目录、同一 max_concurrent_generations）与诊断 sink。
export function studioAnalysisAdapter(context:ApplicationContext){return nativeAdapter(context.identity.workspace_id,context.paths.state_root,'codex',undefined,maxConcurrentGenerations(context.config),executorDiagnostics('codex'));}
export function createImageStudioModule(context:ApplicationContext,options:ImageStudio['options']={}):ApplicationModule {
 const dns=options.web?.dns??new WebDnsGuard({...(context.config.web_fetch?.doh_resolvers?{doh_resolvers:context.config.web_fetch.doh_resolvers}:{}),...(context.config.web_fetch?.fake_ip_ranges?{fake_ip_ranges:context.config.web_fetch.fake_ip_ranges}:{})});
 const studio=new ImageStudio(context,{...options,web:{...options.web,dns},analysis:options.analysis??nativeImageBriefPort(()=>studioAnalysisAdapter(context),(hash,native)=>{
  transaction(context.db,()=>{const rows=context.db.prepare("SELECT value FROM application_metadata WHERE key LIKE ?").all('wechat-image-studio.v1:'+context.identity.workspace_id+':%');for(const row of rows){const found=JSON.parse(String(row.value));if(found.brief_invocations?.[hash]){const state=readStudio(context.db,context.identity.workspace_id,String(found.topic_id));state.brief_invocations[hash]={...state.brief_invocations[hash]!,state:'running',native};writeStudio(context.db,context.identity.workspace_id,state);break;}}});
 })});
 const plans=new ImagePlans(context,studio);
 return{id:'image-studio',register(registrar){
  registrar.register({method:'GET',path:'/api/v1/image-studio',owner:'WECHAT-IMAGE-STUDIO-01',handle:async request=>({body:await studio.snapshot(request.context,request.query.get('topic_id')??'')})});
  registrar.register({method:'POST',path:'/api/v1/image-studio/brief',owner:'WECHAT-IMAGE-STUDIO-01',mutation:true,idempotent:true,schema:StudioBriefSchema,handle:async request=>({body:await studio.brief(request.context,request.body,{signal:request.signal})})});
  registrar.register({method:'POST',path:'/api/v1/image-studio/generations',owner:'WECHAT-IMAGE-STUDIO-01',mutation:true,idempotent:true,schema:StudioGenerationSchema,handle:async request=>({status:202,body:await studio.generate(request.context,request.body)})});
  registrar.register({method:'POST',path:'/api/v1/image-studio/slots/{id}/adopt',owner:'WECHAT-IMAGE-STUDIO-01',mutation:true,idempotent:true,schema:StudioAdoptSchema,handle:async request=>({body:await studio.adopt(request.context,request.params.id!,request.body)})});
  registrar.register({method:'GET',path:'/api/v1/topics/{id}/web-image-candidates',owner:'WECHAT-IMAGE-STUDIO-B',handle:async request=>({body:await studio.webCandidates(request.context,request.params.id!,{refresh:request.query.get('refresh')==='1'})})});
  registrar.register({method:'POST',path:'/api/v1/image-studio/web-imports',owner:'WECHAT-IMAGE-STUDIO-B',mutation:true,idempotent:true,schema:StudioWebImportSchema,handle:async request=>({status:201,body:await studio.webImport(request.context,request.body)})});
  // 配图方案（A2）：AI 先规划落点与来源，本人再逐张生成与修改。
  registrar.register({method:'GET',path:'/api/v1/image-studio/plan',owner:'WECHAT-IMAGE-STUDIO-A2',handle:async request=>({body:await plans.snapshot(request.context,request.query.get('topic_id')??'')})});
  registrar.register({method:'POST',path:'/api/v1/image-studio/plan/runs',owner:'WECHAT-IMAGE-STUDIO-A2',mutation:true,idempotent:true,schema:ImagePlanRunSchema,handle:async request=>({body:await plans.run(request.context,request.body)})});
  registrar.register({method:'POST',path:'/api/v1/image-studio/plan/items/{id}',owner:'WECHAT-IMAGE-STUDIO-A2',mutation:true,idempotent:true,schema:ImagePlanItemUpdateSchema,handle:async request=>({body:await plans.updateItem(request.context,request.params.id!,request.body)})});
  registrar.register({method:'POST',path:'/api/v1/image-studio/plan/items',owner:'WECHAT-IMAGE-STUDIO-A2',mutation:true,idempotent:true,schema:ImagePlanItemCreateSchema,handle:async request=>({status:201,body:await plans.createItem(request.context,request.body)})});
  // 上传图片 / 找回已删除配图的图片作为槽位新一版（A2-2）。
  registrar.register({method:'POST',path:'/api/v1/image-studio/asset-versions',owner:'WECHAT-IMAGE-STUDIO-A2',mutation:true,idempotent:true,schema:StudioAssetVersionSchema,handle:async request=>({status:201,body:await studio.assetVersion(request.context,request.body)})});
  // 配图确认（A2-2）：冻结配图终稿给排版用；不写 Wiki、不需要记录根目录。
  registrar.register({method:'POST',path:'/api/v1/image-studio/plan/confirm',owner:'WECHAT-IMAGE-STUDIO-A2',mutation:true,idempotent:true,schema:ImagePlanConfirmSchema,handle:async request=>({body:await plans.confirm(request.context,request.body)})});
  registrar.register({method:'POST',path:'/api/v1/image-studio/confirm-final',owner:'WECHAT-IMAGE-STUDIO-01',mutation:true,idempotent:true,schema:StudioConfirmSchema,handle:async request=>({body:await studio.confirm(request.context,request.body)})});
 },beginClose:()=>studio.beginClose(),close:()=>studio.close(),health:()=>({module:'image-studio',status:'ready',details:{size_control:'prompt_guided_unverified',exact_pixels:'unsupported',process_record_root:options.record_root?'registered':'pending_registration',wiki:'explicit_human_confirmation',publishing:false,analysis_lifecycle:studio.analysisSnapshot(),...(dns.mode?{dns_mode:dns.mode}:{})}})};
}
