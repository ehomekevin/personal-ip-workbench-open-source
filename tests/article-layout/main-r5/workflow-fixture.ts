/** Controlled MAIN-R5 integration fixture. Real SQLite/Application/HTTP/import/plan-final/Reader/worker/receipt; synthetic upstream plan seed and native protocol only. No provider calls. */
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join,resolve,extname} from 'node:path';
import type {ArticleLayoutSnapshot,ArticleLayoutView,ArticleLayoutVisualRenderView,ArticleLayoutVisualJobView,ArticleLayoutVisualStatus} from '../../../packages/contracts/src/article-layout.ts';
import type {RequestContext,ServiceConfiguration} from '../../../packages/contracts/src/index.ts';
import {startApplication} from '../../../apps/service/src/bootstrap/application.ts';
import {createArticleLayoutModule} from '../../../apps/service/src/routes/article-layout.ts';
import {getArticleLayoutRuntime} from '../../../apps/service/src/bootstrap/article-layout-runtime.ts';
import {ArticleLayoutRenderer,ARTICLE_LAYOUT_RENDERER_VERSION} from '../../../apps/service/src/bootstrap/article-layout-renderer.ts';
import {DurableWorker} from '../../../apps/service/src/worker/core/index.ts';
import {createArticleLayoutHandlers} from '../../../apps/service/src/worker/handlers/article-layout/index.ts';
import {Topics} from '../../../packages/domain/src/topics/index.ts';
import {Documents} from '../../../packages/domain/src/documents/index.ts';
import {ContentGeneration} from '../../../packages/domain/src/content-agents/index.ts';
import {ImagePlans} from '../../../packages/domain/src/artifact-execution/image-studio/plan.ts';
import {MediaImporter} from '../../../packages/domain/src/artifact-execution/import.ts';
import {transaction} from '../../../packages/storage/src/connection/index.ts';
import {writeImagePlan,readImagePlanFinal} from '../../../packages/storage/src/image-studio/index.ts';
import {readVisualRecord,visualKey,type ArticleVisualRenderRecord,type ArticleVisualJobRecord} from '../../../packages/storage/src/article-layout/visual-store.ts';
import {digest,editArticleText} from '../../../packages/domain/src/article-layout/index.ts';
import {QAOnlyNative,type FixtureMode} from '../visual/repair-fixture.ts';

export const root=resolve(import.meta.dirname,'../../..');
export class WorkflowNative extends QAOnlyNative {
 turnStarted?:()=>void;holdTurn:Promise<void>|null=null;
 override async request(method:string,params:Record<string,unknown>):Promise<unknown>{
  const result=await super.request(method,params);
  if(method==='turn/start'){this.turnStarted?.();if(this.holdTurn)await this.holdTurn;}
  return result;
 }
}
export async function workflowFixture(mode:FixtureMode='complete'){
 const base=join(root,'runtime/main-r5-workflow');mkdirSync(base,{recursive:true});const directory=mkdtempSync(join(base,'run-'));
 const paths={source_vault_root:null,managed_notes_root:join(directory,'notes'),state_root:join(directory,'state'),media_root:join(directory,'media')};for(const p of Object.values(paths))if(p)mkdirSync(p,{recursive:true});
 const staticServer=createServer(async(req,res)=>{try{const url=new URL(req.url??'/','http://local'),path=resolve(root,'apps/web/dist',url.pathname==='/'?'index.html':url.pathname.slice(1));if(!path.startsWith(join(root,'apps/web/dist')+'/'))throw new Error('invalid path');const bytes=await readFile(path);res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png'} as Record<string,string>)[extname(path)]??'application/octet-stream');res.end(bytes);}catch{res.statusCode=404;res.end();}});
 await new Promise<void>(done=>staticServer.listen(0,'127.0.0.1',done));const staticAddress=staticServer.address();if(!staticAddress||typeof staticAddress==='string')throw new Error('Missing fixture static port');
 const workspace=randomUUID(),service=randomUUID(),native=new WorkflowNative(mode),config:ServiceConfiguration={workspace_id:workspace,service_instance_id:service,title:'MAIN-R5 synthetic workflow fixture',mode:'real',timezone:'UTC',paths,listen:{host:'127.0.0.1',port:43957},default_executor:'codex',api_fallback_enabled:false};
 let app:Awaited<ReturnType<typeof startApplication>>|undefined;
 try{
  app=await startApplication(config,{port:0,executorHealth:async()=>[],moduleFactories:[context=>createArticleLayoutModule(context,{fixture:true,native_factory:()=>native,timeout_ms:200,renderer:new ArticleLayoutRenderer(context,{web_url:'http://127.0.0.1:'+staticAddress.port,standard_png:join(root,'tests/article-layout/visual/fixtures/original-standard.png'),standard_html:join(root,'tests/article-layout/visual/fixtures/original-standard.html')}),renderer_version:ARTICLE_LAYOUT_RENDERER_VERSION,authority:{schema_version:'article-layout-authority.v2',authority_id:'fixture-authority',workspace_id:workspace,candidate_sha256:digest({task:'MAIN-R5',scope:'synthetic workflow fixture'}),goal_id:'controlled-workflow',parent_sha256:null,scope:'fixture'}})]});
  const context=app.context,request=(key=randomUUID()):RequestContext=>({...app!.identity,request_id:randomUUID(),idempotency_key:key,request_identity_ref:'synthetic-fixture-human'}),documents=new Documents(context);
  const topic=await new Topics(context).create(request(),{title:'MAIN-R5 合成完整链路',category:'fixture',audience:'fixture',source_ids:[]});
  const text='这是一篇合成验收文章，所有素材与确认只用于本机隔离测试。\n\n一、核对完整流程\n\n当前稿件经过实际导入、配图确认和排版保存，不改写平台稿。';
  const core=await documents.save(request(),topic.core_document_id,{expected_revision_id:null,text,origin:'human'});await documents.approveCore(request(),topic.id,core.revision_id);
  const variant=new ContentGeneration(context).createVariant(request(),topic.id,{platform:'wechat',format:'article'}),documentId=String(variant.document_id),draft=await documents.save(request(),documentId,{expected_revision_id:null,text,origin:'human'});
  const runtime=getArticleLayoutRuntime(context),image=runtime.image,plans=new ImagePlans(context,image),snapshot=await image.snapshot(request(),topic.id),paragraph=snapshot.paragraphs[0]!,slotId=randomUUID(),itemId=randomUUID();
  // This is a pre-existing synthetic upstream plan, not a simulated image_plan execution or native proof.
  transaction(context.db,()=>writeImagePlan(context.db,workspace,{schema_version:'image-plan/1',topic_id:topic.id,version:1,run:null,plan:{id:'fixture-plan-'+randomUUID(),article_revision_id:draft.revision_id,created_at:new Date().toISOString(),items:[{id:itemId,role:'cover',slot_id:slotId,paragraph_id:paragraph.id,placement_paragraph_id:paragraph.id,position:'cover',seq:10,purpose:'合成标准图导入用于链路测试',source_strategy:'ai_generate',aspect:'16:9',prompt_draft:'fixture pre-existing plan; no generation',candidate_id:null,skipped:false,auto:{state:'none',candidate_id:null,error:null},current_version_id:null,cleared:false,seen_versions:0}]}}));
  const asset=readFileSync(join(root,'tests/article-layout/visual/fixtures/original-standard.png'));
  const imported=await new MediaImporter(context).importFile(request(),(async function*(){yield new Uint8Array(asset);})(),{kind:'image',mime:'image/png',topic_id:topic.id,purpose:'synthetic MAIN-R5 fixture',source_kind:'reference',origin:'import',total_bytes:asset.length});
  await image.assetVersion(request(),{topic_id:topic.id,expected_version:snapshot.version,slot_id:slotId,asset_id:imported.asset_id,name:'fixture imported actual PNG'});
  const planned=await plans.snapshot(request(),topic.id);await plans.confirm(request(),{topic_id:topic.id,expected_version:planned.version});
  const final=readImagePlanFinal(context.db,workspace,topic.id);if(!final||final.items.length!==1||final.items[0]!.asset_id!==imported.asset_id)throw new Error('Actual import/plan-final fixture preparation failed');
  const url='http://127.0.0.1:'+app.address.port;
  const response=(method:string,path:string,body?:unknown,key=randomUUID())=>fetch(url+path,{method,headers:{'content-type':'application/json','x-workspace-id':workspace,'x-service-instance-id':service,'idempotency-key':key},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const call=async<T>(method:string,path:string,body?:unknown,status=200,key=randomUUID()):Promise<T>=>{const r=await response(method,path,body,key),value=await r.json();if(r.status!==status)throw new Error('HTTP '+r.status+': '+JSON.stringify(value));return value as T;};
  await call<ArticleLayoutView>('POST','/api/v1/article-layout',{topic_id:topic.id});
  const load=()=>call<ArticleLayoutView>('GET','/api/v1/article-layout?topic_id='+topic.id);
  const status=()=>call<ArticleLayoutVisualStatus>('GET','/api/v1/article-layout/visual-status?topic_id='+topic.id);
  const render=async()=>{const s=(await load()).snapshot;return call<ArticleLayoutVisualRenderView>('POST','/api/v1/article-layout/visual-renders',{topic_id:topic.id,expected_version:s.version});};
  const enqueue=async(rendered?:ArticleLayoutVisualRenderView)=>{const s=(await load()).snapshot,r=rendered??await render();return call<ArticleLayoutVisualJobView>('POST','/api/v1/article-layout/visual-checks',{topic_id:topic.id,expected_version:s.version,render_id:r.render_id});};
  const worker=new DurableWorker(context,createArticleLayoutHandlers(context),{owner:'workflow-fixture-worker',heartbeat_ms:25});
  const save=async()=>{const before=(await load()).snapshot,block=before.blocks.find(b=>'text'in b&&b.kind==='paragraph')!;if(!('text'in block))throw new Error('No text');return call<{state:'saved';snapshot:ArticleLayoutSnapshot}>('POST','/api/v1/article-layout/saves',{topic_id:topic.id,expected_version:before.version,snapshot:editArticleText(before,block.id,block.text+'（合成排版人工修改）')});};
  const renderRecord=(id:string)=>readVisualRecord<ArticleVisualRenderRecord>(context.db,workspace,'render',id)!;
  const jobRecord=(id:string)=>readVisualRecord<ArticleVisualJobRecord>(context.db,workspace,'job',id)!;
  let closed=false;
  return{directory,app,context,native,runtime,worker,request,response,call,load,status,render,enqueue,save,topic,documentId,documents,renderRecord,jobRecord,visualKey,
   async close(){if(closed)return;closed=true;await app!.close();await new Promise<void>((done,reject)=>staticServer.close(e=>e?reject(e):done()));writeFileSync(join(directory,'closed.json'),JSON.stringify({application:true,sqlite:true,static_server:true,native_closes:native.closes,real_model_calls:0})+'\n');}};
 }catch(error){await app?.close();await new Promise<void>(done=>staticServer.close(()=>done()));throw error;}
}
