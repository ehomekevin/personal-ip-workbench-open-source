import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {configureDatabase,migrateDatabase} from '../../../../packages/storage/src/connection/index.ts';
import {DocumentGenerationSchema,BeginHostRunSchema,CreateProductionPlanSchema,PatchScheduleSchema,ReceiveHostOutputSchema,ContractError} from '../../../../packages/contracts/src/index.ts';
test('D07-008 v6→v7 保留旧准备计划与迁移hash，新增字段不可回填旧修订',()=>{
 const db=new DatabaseSync(':memory:');configureDatabase(db);try{
  migrateDatabase(db,{targetVersion:6});const history=db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  db.exec("INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES('w','w','旧库','UTC','{}','demo',1);INSERT INTO documents(id,workspace_id,kind,version) VALUES('d','w','core',1);INSERT INTO topics(id,workspace_id,title,category,audience,angle,expected_effort_min,core_document_id,status,version) VALUES('t','w','主题','AI','','',0,'d','active',1);INSERT INTO production_plans(id,workspace_id,topic_id,scope,version) VALUES('p','w','t','topic_preparation',1)");
  db.prepare('INSERT INTO production_plan_revisions(id,workspace_id,plan_id,revision_no,input_hash) VALUES (?,?,?,?,?)').run('r','w','p',1,'a'.repeat(64));
  const before=db.prepare('SELECT * FROM production_plan_revisions').get()!;
  assert.deepEqual(migrateDatabase(db,{targetVersion:7}).applied,[7]);const after=db.prepare('SELECT * FROM production_plan_revisions').get()!;
  assert.equal(after.input_manifest,null);for(const [k,v] of Object.entries(before))assert.equal(after[k],v);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=6 ORDER BY version').all(),history);
  assert.throws(()=>db.prepare('UPDATE production_plan_revisions SET input_manifest=? WHERE id=?').run('{}','r'),/IMMUTABLE/);
  assert.throws(()=>db.prepare('INSERT INTO production_plan_revisions(id,workspace_id,plan_id,revision_no,input_hash,input_manifest) VALUES (?,?,?,?,?,?)').run('bad','w','p',2,'a'.repeat(64),'not-json'),/CHECK/);
  assert.deepEqual(migrateDatabase(db,{targetVersion:7}).applied,[]);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare("SELECT name FROM pragma_table_info('content_plan_revisions') WHERE name='input_manifest'").get()!.name,'input_manifest');
 }finally{db.close();}
});
test('D07-008 HTTP嵌套边界拒绝未知字段与错用准备计划/排期操作',()=>{
 assert.throws(()=>DocumentGenerationSchema.parse({base_revision_id:null,source_ids:[],instruction:'改稿',executor:'codex',range:{start:0,end:1}}),ContractError);
 assert.throws(()=>BeginHostRunSchema.parse({kind:'document_modify',mode:'candidate',targets:[{document_id:'d',base_revision_id:null,core_revision_id:null,extra:1}],source_ids:[],instruction:'改稿',request_context:'page_action',native_task_binding_id:'b',expected_version:1}),ContractError);
 assert.throws(()=>CreateProductionPlanSchema.parse({scope:'topic_preparation',topic_id:'t',shots:[],preset:'p'}),ContractError);
 assert.throws(()=>PatchScheduleSchema.parse({operation:'replace_content',expected_version:1,expected_intent_version:1,target:{variant_id:'v',variant_revision_id:'r',account_id:'a',core_approval_id:'c'},due_at:'2026-10-10T00:00:00Z'}),ContractError);
 assert.equal(CreateProductionPlanSchema.parse({scope:'topic_preparation',topic_id:'t',shots:[]}).scope,'topic_preparation');
});

test('D07-008 新模块运行时schema与OpenAPI同源；无重复owner或伪登记路由',async()=>{
 const {DEFAULT_MODULE_FACTORIES}=await import('../../../../apps/service/src/bootstrap/modules.ts');
 const {createRouteRegistry}=await import('../../../../apps/service/src/routes/index.ts');
 const {readFileSync,mkdtempSync,mkdirSync,rmSync}=await import('node:fs');
 const {join}=await import('node:path');const {tmpdir}=await import('node:os');const root=mkdtempSync(join(tmpdir(),'wp16-20-contract-'));
 const {CONTRACT_VERSION,API_RESOURCES}=await import('../../../../packages/contracts/src/index.ts');
 const db=new DatabaseSync(':memory:');configureDatabase(db);migrateDatabase(db);
 const paths={source_vault_root:null,managed_notes_root:join(root,'notes'),state_root:join(root,'state'),media_root:join(root,'media')};
 for(const path of Object.values(paths))if(path)mkdirSync(path);
 db.prepare("INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES ('w','w','边界核对','UTC',?,'demo',1)").run(JSON.stringify(paths));
 const context={db,paths,identity:{workspace_id:'w',service_instance_id:'s',contract_version:CONTRACT_VERSION},config:{workspace_id:'w',service_instance_id:'s',title:'边界核对',mode:'demo' as const,timezone:'UTC',paths,listen:{host:'127.0.0.1' as const,port:4318}},getExecutorHealth:async()=>[]};
 try{
  const modules=DEFAULT_MODULE_FACTORIES.map(factory=>factory(context)),registered=createRouteRegistry(modules).routes;
  const api=JSON.parse(readFileSync(new URL('../../../../packages/contracts/openapi.json',import.meta.url),'utf8'));
  const newOwners=['WP-16','WP-17','WP-18','WP-19','WP-20'];let verified=0;
  for(const resource of API_RESOURCES.filter(r=>newOwners.includes(r.implementation_owner)&&r.status==='registered_internal')){
   const route=registered.find(r=>r.definition.method===resource.method&&r.definition.path===resource.path)!.definition;
   assert.equal(route.owner,resource.implementation_owner);assert.equal(registered.filter(r=>r.definition.method===resource.method&&r.definition.path===resource.path).length,1);
   if(route.schema){const operation=api.paths[resource.path][resource.method.toLowerCase()];const ref=operation.requestBody?.content?.['application/json']?.schema?.$ref;
    assert.ok(ref,resource.path);assert.deepEqual(api.components.schemas[ref.split('/').at(-1)],route.schema.jsonSchema,resource.path);verified++;
   }
  }
  assert.ok(verified>=20);
  assert.ok(api.paths['/api/v1/production-plans'].post.responses['200']);assert.ok(api.paths['/api/v1/production-plans'].post.responses['201']);
  assert.ok(api.paths['/api/v1/host-runs/{job_id}/outputs'].post.responses['200']);
  assert.deepEqual(api.paths['/api/v1/host-runs/{job_id}/outputs'].post.security,[{HostConnectionCredential:[]}]);
  for(const [url,method] of [['/api/v1/host-runs/{job_id}/outputs','post'],['/api/v1/host-result-receipts/{id}','get']]){const op=api.paths[url!][method!];assert.equal(op.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/HostResultReceiptView');assert.equal(op['x-response-schema-status'],'dto_exported');}
  assert.deepEqual(api.components.schemas.HostResultReceiptView.required,['receipt_id','job_id','attempt_id','attempt_generation','state','input_hash','output_hash','results','quarantine_reason','files']);
  assert.equal(api.paths['/api/v1/host-runs/{job_id}/receipts'].get.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/HostResultReceiptsPage');
  assert.equal(api.components.schemas.HostResultReceiptsPage.properties.items.items.$ref,'#/components/schemas/HostResultReceiptView');
  for(const url of ['/api/v1/host-task-observers','/api/v1/host-task-observers/{id}/bindings','/api/v1/native-task-bindings/{id}/observations','/api/v1/native-task-bindings/{id}/reattach','/api/v1/host-runs/{job_id}/renewals'])assert.deepEqual(api.paths[url].post.security,[{HostObserverBearer:[]}]);
  assert.equal(api.components.securitySchemes.HostConnectionCredential.name,'X-Host-Connection-Credential');assert.equal(api.components.securitySchemes.HostObserverBearer.scheme,'bearer');
  assert.ok(api.paths['/api/v1/jobs/{id}/resume'].post.parameters.some((p:{name:string;required:boolean})=>p.name==='X-Host-Connection-Credential'&&p.required===false));
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('D07-008 宿主输出结构公开且冻结深验仍保留；排期JSON分支和运行时必填互斥一致',()=>{
 const output={attempt_id:'a',attempt_generation:1,expected_version:2,input_hash:'a'.repeat(64),typed_output:{documents:[{document_id:'d',text:'稿件'}],recommendations:[]}};
 assert.deepEqual(ReceiveHostOutputSchema.parse(output),output);
 assert.throws(()=>ReceiveHostOutputSchema.parse({...output,typed_output:{documents:[{document_id:'d',text:'稿件',owner:'forged'}],recommendations:[]}}),ContractError);
 assert.throws(()=>ReceiveHostOutputSchema.parse({...output,typed_output:{documents:[]}}),ContractError);
 const branches=PatchScheduleSchema.jsonSchema.oneOf as Array<{required:string[];properties:Record<string,{enum?:string[]}>;additionalProperties:boolean}>;
 assert.equal(branches.length,2);
 const change=branches.find(b=>b.properties.operation?.enum?.[0]==='change_time')!,replace=branches.find(b=>b.properties.operation?.enum?.[0]==='replace_content')!;
 assert.deepEqual(change.required,['expected_version','operation','due_at','timezone','local_time']);assert.deepEqual(replace.required,['expected_version','operation','expected_intent_version','target']);
 assert.equal(change.additionalProperties,false);assert.equal(replace.additionalProperties,false);assert.ok(!('target' in change.properties));assert.ok(!('due_at' in replace.properties));
 const time={operation:'change_time',expected_version:1,due_at:'2026-10-10T20:00:00Z',timezone:'UTC',local_time:'2026-10-10T20:00:00+00:00'},replacement={operation:'replace_content',expected_version:1,expected_intent_version:1,target:{variant_id:'v',variant_revision_id:'r',account_id:'a',core_approval_id:'c'}};
 assert.deepEqual(PatchScheduleSchema.parse(time),time);assert.deepEqual(PatchScheduleSchema.parse(replacement),replacement);
 for(const value of [{operation:'change_time',expected_version:1},{...time,target:replacement.target},{...replacement,due_at:time.due_at},{...replacement,expected_intent_version:undefined}])assert.throws(()=>PatchScheduleSchema.parse(value),ContractError);
});
