import {getArticleLayoutRuntime,type ArticleLayoutRuntimeOptions} from '../bootstrap/article-layout-runtime.ts';
import {ArticleLayoutOpenSchema,ArticleLayoutSaveSchema,ArticleLayoutImageSyncSchema,ArticleLayoutConfirmSchema,ArticleLayoutVisualRenderSchema,ArticleLayoutVisualCheckSchema,ArticleLayoutVisualQuerySchema} from '@workbench/contracts';
import type {ApplicationContext,ApplicationModule} from '@workbench/domain/ports';
import {ImageStudio} from '../../../../packages/domain/src/artifact-execution/image-studio/index.ts';
import {ImagePlans} from '../../../../packages/domain/src/artifact-execution/image-studio/plan.ts';
import {ArticleLayoutStudio} from '../../../../packages/domain/src/article-layout/studio.ts';
// 公众号排版（C1/C2）：进入排版（按配图终稿初始化）、读取、保存块版本、重新同步配图、确认排版。只写排版自己的记录，不回写平台稿、不写 Wiki、不提交草稿。
export function createArticleLayoutModule(context:ApplicationContext,options?:ArticleLayoutRuntimeOptions):ApplicationModule {
 // 只用于读平台稿当前文本与配图确认摘要；生成、导入与自动选源仍由配图模块负责。
 const runtime=getArticleLayoutRuntime(context,options),layout=runtime.studio,visual=runtime.workflow;
 return{id:'article-layout',register(registrar){
  registrar.register({method:'GET',path:'/api/v1/article-layout',owner:'WECHAT-LAYOUT-STUDIO-C1',handle:async request=>({body:await layout.view(request.context,request.query.get('topic_id')??'')})});
  registrar.register({method:'POST',path:'/api/v1/article-layout',owner:'WECHAT-LAYOUT-STUDIO-C1',mutation:true,idempotent:true,schema:ArticleLayoutOpenSchema,handle:async request=>({body:await layout.open(request.context,request.body)})});
  registrar.register({method:'POST',path:'/api/v1/article-layout/saves',owner:'WECHAT-LAYOUT-STUDIO-C1',mutation:true,idempotent:true,schema:ArticleLayoutSaveSchema,handle:async request=>{const saved=await layout.save(request.context,request.body);if(saved.state==='saved')visual.recordSaved(request.context,request.body.topic_id,saved.snapshot);return{body:saved};}});
  registrar.register({method:'POST',path:'/api/v1/article-layout/image-syncs',owner:'WECHAT-LAYOUT-STUDIO-C1',mutation:true,idempotent:true,schema:ArticleLayoutImageSyncSchema,handle:async request=>({body:await layout.syncImages(request.context,request.body)})});
  // C2：本机 15 条排版检查无阻断项时确认排版，冻结为排版终稿（只写排版记录，不回写平台稿、不提交草稿）。
  registrar.register({method:'POST',path:'/api/v1/article-layout/confirmations',owner:'WECHAT-LAYOUT-STUDIO-C2',mutation:true,idempotent:true,schema:ArticleLayoutConfirmSchema,handle:async request=>{const view=await layout.confirm(request.context,request.body);visual.recordSaved(request.context,request.body.topic_id,view.snapshot,true);return{body:view};}});
  registrar.register({method:'POST',path:'/api/v1/article-layout/visual-renders',owner:'WECHAT-LAYOUT-MAIN-R5',mutation:true,idempotent:true,schema:ArticleLayoutVisualRenderSchema,handle:async r=>({body:await visual.render(r.context,r.body,r.signal)})});
  registrar.register({method:'POST',path:'/api/v1/article-layout/visual-checks',owner:'WECHAT-LAYOUT-MAIN-R5',mutation:true,idempotent:true,schema:ArticleLayoutVisualCheckSchema,handle:async r=>({body:await visual.enqueue(r.context,r.body)})});
  registrar.register({method:'POST',path:'/api/v1/article-layout/visual-queries',owner:'WECHAT-LAYOUT-MAIN-R5',mutation:true,idempotent:true,schema:ArticleLayoutVisualQuerySchema,handle:async r=>({body:await visual.query(r.context,r.body)})});
  registrar.register({method:'POST',path:'/api/v1/article-layout/visual-cancellations',owner:'WECHAT-LAYOUT-MAIN-R5',mutation:true,idempotent:true,schema:ArticleLayoutVisualQuerySchema,handle:async r=>({body:await visual.cancel(r.context,r.body)})});
  registrar.register({method:'GET',path:'/api/v1/article-layout/visual-status',owner:'WECHAT-LAYOUT-MAIN-R5',handle:async r=>({body:await visual.status(r.context,r.query.get('topic_id')??'')})});
 },beginClose:()=>runtime.beginClose(),close:()=>runtime.close(),health:()=>({module:'article-layout',status:'ready',details:{document_writeback:false,wiki:false,publishing:false}})};
}
