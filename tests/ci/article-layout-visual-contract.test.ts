/** MAIN-INTEGRATION-R5/r1 internal contract checks. No server, renderer, SQL connection or provider execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {API_RESOURCES,CONTRACT_VERSION,ContractError} from '../../packages/contracts/src/index.ts';
import {ArticleLayoutOpenSchema,ArticleLayoutSaveSchema,ArticleLayoutImageSyncSchema,ArticleLayoutConfirmSchema,ArticleLayoutVisualRenderSchema,ArticleLayoutVisualCheckSchema,ArticleLayoutVisualQuerySchema,ARTICLE_LAYOUT_RESPONSE_SCHEMAS,type ArticleLayoutVisualContext} from '../../packages/contracts/src/article-layout.ts';
import type {ApplicationContext} from '../../packages/domain/src/ports/index.ts';
import {createArticleLayoutModule} from '../../apps/service/src/routes/article-layout.ts';
import {createRouteRegistry} from '../../apps/service/src/routes/index.ts';
import {getArticleLayoutRuntime} from '../../apps/service/src/bootstrap/article-layout-runtime.ts';
import {ARTICLE_LAYOUT_RENDERER_VERSION} from '../../apps/service/src/bootstrap/article-layout-renderer.ts';
import {createArticleLayout,createLayoutCheckBinding,digest,LAYOUT_RULES_VERSION,sha256} from '../../packages/domain/src/article-layout/index.ts';
import {layoutArticleId} from '../../packages/domain/src/article-layout/plan-final-source.ts';
import {layoutVisualManifestHash} from '../../packages/adapters/src/media/layout-check/input.ts';
import {matches} from '../../packages/adapters/src/agent/codex/primitives.ts';

type Schema=Record<string,any>;
const document=JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json',import.meta.url),'utf8')) as {paths:Record<string,Record<string,any>>;components:{schemas:Record<string,Schema>}};
const visual=[
 {method:'POST',path:'/api/v1/article-layout/visual-renders',request:'ArticleLayoutVisualRenderRequest',schema:ArticleLayoutVisualRenderSchema,response:'ArticleLayoutVisualRenderView',valid:{topic_id:'topic-fixture',expected_version:2}},
 {method:'POST',path:'/api/v1/article-layout/visual-checks',request:'ArticleLayoutVisualCheckRequest',schema:ArticleLayoutVisualCheckSchema,response:'ArticleLayoutVisualJobView',valid:{topic_id:'topic-fixture',expected_version:2,render_id:'opaque-render-fixture'}},
 {method:'POST',path:'/api/v1/article-layout/visual-queries',request:'ArticleLayoutVisualQueryRequest',schema:ArticleLayoutVisualQuerySchema,response:'ArticleLayoutVisualJobView',valid:{topic_id:'topic-fixture',job_id:'opaque-job-fixture'}},
 {method:'POST',path:'/api/v1/article-layout/visual-cancellations',request:'ArticleLayoutVisualQueryRequest',schema:ArticleLayoutVisualQuerySchema,response:'ArticleLayoutVisualJobView',valid:{topic_id:'topic-fixture',job_id:'opaque-job-fixture'}},
 {method:'GET',path:'/api/v1/article-layout/visual-status',request:null,schema:null,response:'ArticleLayoutVisualStatus',valid:null},
] as const;
const legacy=[
 {method:'GET',path:'/api/v1/article-layout',owner:'WECHAT-LAYOUT-STUDIO-C1',request:null,schema:null,response:'ArticleLayoutView'},
 {method:'POST',path:'/api/v1/article-layout',owner:'WECHAT-LAYOUT-STUDIO-C1',request:'ArticleLayoutOpenRequest',schema:ArticleLayoutOpenSchema,response:'ArticleLayoutView'},
 {method:'POST',path:'/api/v1/article-layout/saves',owner:'WECHAT-LAYOUT-STUDIO-C1',request:'ArticleLayoutSaveRequest',schema:ArticleLayoutSaveSchema,response:'ArticleLayoutSaveResult'},
 {method:'POST',path:'/api/v1/article-layout/image-syncs',owner:'WECHAT-LAYOUT-STUDIO-C1',request:'ArticleLayoutImageSyncRequest',schema:ArticleLayoutImageSyncSchema,response:'ArticleLayoutView'},
 {method:'POST',path:'/api/v1/article-layout/confirmations',owner:'WECHAT-LAYOUT-STUDIO-C2',request:'ArticleLayoutConfirmRequest',schema:ArticleLayoutConfirmSchema,response:'ArticleLayoutView'},
] as const;
function fixture(t:{after(fn:()=>void|Promise<void>):void},metadata=new Map<string,string>(),job?:Record<string,unknown>){
 const parent=resolve(import.meta.dirname,'../../runtime/main-r5-contract');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'.route-fixture-'));
 let reads=0,rendererCalls=0;
 const db={prepare(sql:string){assert.match(sql,/^SELECT /,'contract checks must never mutate SQL');return{get(...args:unknown[]){reads++;if(sql.includes('FROM application_metadata')){const value=metadata.get(String(args[0]));return value===undefined?undefined:{value};}if(sql.includes('FROM topics'))return{title:'synthetic topic title'};if(sql.includes('FROM jobs'))return job;throw new Error('Unexpected read in contract projection: '+sql);}};}} as unknown as DatabaseSync;
 const identity={workspace_id:'contract-workspace',service_instance_id:'contract-service',contract_version:CONTRACT_VERSION};
 const paths={source_vault_root:null,state_root:root,managed_notes_root:join(root,'managed-notes'),media_root:join(root,'media')};
 const context:ApplicationContext={db,identity,paths,config:{workspace_id:identity.workspace_id,service_instance_id:identity.service_instance_id,title:'synthetic contract fixture',mode:'real',timezone:'UTC',paths,listen:{host:'127.0.0.1',port:0}},async getExecutorHealth(){throw new Error('contract must not probe executors');}};
 const module=createArticleLayoutModule(context,{fixture:true,renderer_version:ARTICLE_LAYOUT_RENDERER_VERSION,renderer:{async render(){rendererCalls++;throw new Error('contract must not render');},async close(){}}});
 t.after(async()=>{await module.close?.();assert.equal(rendererCalls,0);rmSync(root,{recursive:true,force:true});});
 return{context,module,routes:createRouteRegistry([module]).routes,get reads(){return reads;}};
}
function operation(method:string,path:string){const value=document.paths[path]?.[method.toLowerCase()];assert.ok(value,method+' '+path+' must exist in checked-in OpenAPI');return value;}
function responseSchema(name:string){const schema=document.components.schemas[name];assert.ok(schema,'Missing response '+name);return schema;}

test('all five opaque visual APIs are real module registrations with matching owner, idempotency and checked-in OpenAPI DTOs',t=>{
 const f=fixture(t);assert.equal(f.reads,0,'registration must not access SQL or provider state');
 for(const route of visual){
  const resource=API_RESOURCES.find(r=>r.method===route.method&&r.path===route.path),runtime=f.routes.find(r=>r.definition.method===route.method&&r.definition.path===route.path)?.definition,api=operation(route.method,route.path);
  assert.ok(resource);assert.ok(runtime);assert.equal(resource.status,'registered_internal');assert.equal(resource.implementation_owner,'WECHAT-LAYOUT-MAIN-R5');assert.equal(resource.implementation_path,'apps/service/src/routes/article-layout.ts');assert.equal(runtime.owner,resource.implementation_owner);assert.equal(api['x-module-owner'],runtime.owner);assert.equal(api['x-resource-status'],resource.status);assert.equal(api['x-contract-source'],resource.source);
  assert.equal(runtime.mutation===true,route.method==='POST');assert.equal(runtime.idempotent===true,route.method==='POST');assert.equal(api.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/'+route.response);assert.equal(api['x-response-schema-status'],'dto_exported');assert.deepEqual(responseSchema(route.response),ARTICLE_LAYOUT_RESPONSE_SCHEMAS[route.response]);
  if(route.schema){assert.equal(runtime.schema,route.schema);assert.equal(api.requestBody.required,true);assert.equal(api.requestBody.content['application/json'].schema.$ref,'#/components/schemas/'+route.request);assert.deepEqual(document.components.schemas[route.request!],route.schema.jsonSchema);assert.equal(api['x-request-schema-status'],'runtime_schema_exported');assert.equal(api.parameters.find((p:any)=>p.in==='header'&&p.name==='Idempotency-Key')?.required,true);}
  else{assert.equal(api.requestBody,undefined);assert.equal(runtime.schema,undefined);assert.equal(api.parameters.some((p:any)=>p.name==='Idempotency-Key'),false);assert.deepEqual(api.parameters.filter((p:any)=>p.in==='query').map((p:any)=>({name:p.name,required:p.required})),[{name:'topic_id',required:true}]);}
 }
 assert.equal(f.routes.filter(r=>r.definition.path.startsWith('/api/v1/article-layout')).length,10,'five legacy routes plus five visual routes, with no second family');
});
test('visual mutation schemas reject caller-supplied native IDs, paths, context/proof booleans, missing identity and extra fields',()=>{
 const forbidden={thread_id:'native-thread',turn_id:'native-turn',native_task_binding_id:'native-binding',attempt_id:'caller-attempt',execution:{trusted:true},path:'/private/contract-canary',work_directory:'/private/contract-canary',render_pngs:[],input_manifest:{},context:{rules_version:'caller-rules'},context_sha256:sha256('caller context'),trusted:true,verified:true,original_input_verified:true,unexpected:'extra'};
 for(const route of visual){if(!route.schema)continue;const parse=(value:unknown)=>route.schema!.parse(value),schema=document.components.schemas[route.request!];assert.deepEqual(parse(route.valid),route.valid);assert.equal(matches(route.valid,schema),true);
  for(const [field,value] of Object.entries(forbidden)){const input:Record<string,unknown>={...route.valid,[field]:value};assert.throws(()=>parse(input),(error:unknown)=>error instanceof ContractError&&error.code==='VALIDATION_ERROR',route.path+' rejects '+field);assert.equal(matches(input,schema),false,route.path+' OpenAPI rejects '+field);}
  for(const field of Object.keys(route.valid!)){const input:Record<string,unknown>={...route.valid};delete input[field];assert.throws(()=>parse(input),route.path+' requires '+field);assert.equal(matches(input,schema),false);}
  for(const input of [null,[],{...route.valid,topic_id:''},{...route.valid,topic_id:9}]){assert.throws(()=>parse(input));assert.equal(matches(input,schema),false);}
  if('expected_version' in route.valid!){for(const expected_version of [0,-1,1.5,'2',null]){const input:Record<string,unknown>={...route.valid,expected_version};assert.throws(()=>parse(input));assert.equal(matches(input,schema),false);}}
 }
});
const forbiddenResponseFields=new Set(['execution','input_manifest','work_directory','path','native','nativeproof','proof','thread_id','turn_id','trusted','verified','original_input_verified','render_pngs','standard_png','standard_html']);
function opaqueSchema(schema:Schema,at:string):void{
 if(schema.type==='object'){assert.equal(schema.additionalProperties,false,at+' must be closed');assert.deepEqual([...schema.required].sort(),Object.keys(schema.properties).sort(),at+' exports only explicit required fields');for(const [name,child] of Object.entries(schema.properties)){assert.equal(forbiddenResponseFields.has(name),false,at+'.'+name+' must remain private');opaqueSchema(child as Schema,at+'.'+name);}}
 if(schema.items)opaqueSchema(schema.items,at+'[]');for(const alternative of schema.oneOf??[])opaqueSchema(alternative,at+'|');
}
const binding=Object.fromEntries(['article_id','content_revision_id','layout_revision_id','text_hash','images_hash','standard_version','standard_png_sha256','standard_html_sha256','render_snapshot_sha256','block_structure_sha256'].map(k=>[k,'synthetic-'+k]));
const publicJob={topic_id:'topic-fixture',job_id:'opaque-job-fixture',attempt_id:null,render_id:'opaque-render-fixture',snapshot_version:2,context_sha256:sha256('synthetic current context'),state:'queued',phase:'等待排版检查',result:null,current:true,can_query:false,error:null};
test('visual responses are closed opaque DTOs including nested results; context digest/version are required and no execution/path/proof can be returned',()=>{
 const samples={ArticleLayoutVisualRenderView:{render_id:'opaque-render-fixture',topic_id:'topic-fixture',snapshot_version:2,context_sha256:sha256('synthetic current context'),created_at:'2026-10-26T00:00:00Z'},ArticleLayoutVisualJobView:publicJob,ArticleLayoutVisualStatus:{available:false,reason:'未配置',latest:publicJob}};
 for(const [name,sample] of Object.entries(samples)){const schema=responseSchema(name);opaqueSchema(schema,name);assert.equal(matches(sample,schema),true);for(const field of forbiddenResponseFields)assert.equal(matches({...sample,[field]:field==='path'?'/private/canary':{}},schema),false,name+' rejects '+field);}
 const job=responseSchema('ArticleLayoutVisualJobView');for(const state of ['queued','running','unknown','completed','cancelled','failed','stale'])assert.equal(matches({...publicJob,state},job),true);assert.equal(matches({...publicJob,state:'trusted'},job),false);
 for(const field of ['context_sha256','snapshot_version']){const incomplete:Record<string,unknown>={...publicJob};delete incomplete[field];assert.equal(matches(incomplete,job),false);}
 const result={binding,verdict:'issues',issues:[{id:'synthetic-issue',block_id:'block',location:'正文第一段',category:'spacing',problem:'段距偏小',standard_ref:'固定排版标准',suggestion:'按标准核对段距',uncertainty:null}],uncertainties:[]};
 assert.equal(matches({...publicJob,state:'completed',result},job),true);assert.equal(matches({...publicJob,result:{...result,execution:{}}},job),false);assert.equal(matches({...publicJob,result:{...result,binding:{...binding,path:'/private/canary'}}},job),false);assert.equal(matches({...publicJob,result:{...result,issues:[{...result.issues[0],nativeproof:true}]}},job),false);
});
test('real queued status handler projects private context/render records into the opaque DTO without rendering or opening SQL',async t=>{
 const topic='topic-fixture',article=layoutArticleId(topic),snapshot=createArticleLayout({article_id:article,document_id:'document-fixture',document_revision_id:'revision-fixture',text:'synthetic contract fixture'});snapshot.version=2;
 const source={topic_id:topic,document_id:snapshot.document_id,document_revision_id:'revision-fixture',final_id:'final-fixture',paragraph_blocks:{},synced_at:'2026-10-26T00:00:00Z'};
 const context:ArticleLayoutVisualContext={schema_version:'article-layout-visual-context.v2',workspace_id:'contract-workspace',topic_id:topic,topic_title:'synthetic topic title',snapshot_version:snapshot.version,content_revision_id:snapshot.content_revision_id,layout_revision_id:snapshot.layout_revision_id,text_hash:snapshot.text_hash,images_hash:snapshot.images_hash,source,rules_version:LAYOUT_RULES_VERSION,renderer_version:ARTICLE_LAYOUT_RENDERER_VERSION,snapshot_sha256:digest(snapshot)};
 const input={binding:createLayoutCheckBinding(snapshot,{snapshot_sha256:sha256('synthetic render'),block_structure_sha256:sha256('synthetic blocks')}),work_directory:'/private/contract-canary',render_pngs:[],standard_png:{path:'/private/contract-canary/standard.png',sha256:snapshot.standard.png_sha256},standard_html:{path:'/private/contract-canary/standard.html',sha256:snapshot.standard.html_sha256},blocks:[]};
 const render={schema_version:'article-layout-render.v2',render_id:'opaque-render-fixture',context,context_sha256:digest(context),snapshot,input,manifest_sha256:layoutVisualManifestHash(input),created_at:'2026-10-26T00:00:00Z'};
 const record={schema_version:'article-layout-job.v2',job_id:'opaque-job-fixture',render_id:render.render_id,topic_id:topic,intent_id:'private-intent',execution_attempt_id:null,execution_generation:null,consumed_receipt_id:null,created_at:render.created_at,record_error:null,execution:{nativeproof:'private-canary'}};
 const metadata=new Map<string,string>([['article-layout.v1:contract-workspace:'+article,JSON.stringify({snapshot,source,pending:null,operations:{},conflicts:[]})],['article-layout-visual.v2:contract-workspace:job:'+record.job_id,JSON.stringify(record)],['article-layout-visual.v2:contract-workspace:render:'+render.render_id,JSON.stringify(render)],['article-layout-visual.v2:contract-workspace:latest:'+topic,JSON.stringify(record.job_id)]]);
 const f=fixture(t,metadata,{id:record.job_id,state:'queued',cancel_requested_at:null,current_attempt_id:null,attempt_generation:0}),handler=f.routes.find(r=>r.definition.path==='/api/v1/article-layout/visual-status')!.definition;
 assert.equal(getArticleLayoutRuntime(f.context).workflow.journal.version,'v2');
 const response=await handler.handle({context:{...f.context.identity,request_id:'synthetic-contract-request',idempotency_key:null,request_identity_ref:null},params:{},query:new URLSearchParams({topic_id:topic}),body:null,headers:{}});
 assert.equal(matches(response.body,responseSchema('ArticleLayoutVisualStatus')),true);const body=response.body as {latest:typeof publicJob};assert.equal(body.latest.state,'queued');assert.equal(body.latest.context_sha256,digest(context));assert.equal(body.latest.current,true);assert.doesNotMatch(JSON.stringify(response.body),/contract-canary|private-canary|nativeproof|work_directory|execution_attempt_id/);assert.ok(f.reads>0,'uses actual read-only queued projection');
});
test('v2 private context keeps every required provenance field while the existing five public routes retain their owners and schemas',t=>{
 // Compile-time assertion rejects making any of these server-owned context fields optional.
 const required:{[K in keyof ArticleLayoutVisualContext]-?:undefined extends ArticleLayoutVisualContext[K]?never:true}={schema_version:true,workspace_id:true,topic_id:true,topic_title:true,snapshot_version:true,content_revision_id:true,layout_revision_id:true,text_hash:true,images_hash:true,source:true,rules_version:true,renderer_version:true,snapshot_sha256:true};assert.equal(Object.keys(required).length,13);
 const f=fixture(t);for(const route of legacy){const resource=API_RESOURCES.find(r=>r.method===route.method&&r.path===route.path),runtime=f.routes.find(r=>r.definition.method===route.method&&r.definition.path===route.path)?.definition,api=operation(route.method,route.path);assert.ok(resource);assert.ok(runtime);assert.equal(resource.implementation_owner,route.owner);assert.equal(runtime.owner,route.owner);assert.equal(api['x-module-owner'],route.owner);assert.equal(api.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/'+route.response);assert.deepEqual(responseSchema(route.response),ARTICLE_LAYOUT_RESPONSE_SCHEMAS[route.response]);if(route.schema){assert.equal(runtime.schema,route.schema);assert.equal(api.requestBody.content['application/json'].schema.$ref,'#/components/schemas/'+route.request);assert.deepEqual(document.components.schemas[route.request!],route.schema.jsonSchema);assert.equal(runtime.idempotent,true);}}
 assert.equal(document.components.schemas.ArticleLayoutVisualContext,undefined,'full disk context is private, never an HTTP request/proof DTO');
});
