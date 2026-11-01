import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {openWorkspaceStorage} from '../../../packages/storage/src/connection/index.ts';
import {Documents} from '../../../packages/domain/src/documents/index.ts';
import {SqliteArticleLayoutRepository} from '../../../packages/storage/src/article-layout/index.ts';
import {ArticleLayoutService} from '../../../packages/domain/src/article-layout/service.ts';
import type {ApplicationContext} from '../../../packages/domain/src/ports/index.ts';
import type {RequestContext,ServiceConfiguration} from '../../../packages/contracts/src/index.ts';
export async function layoutFixture(){
 const root=mkdtempSync(join(import.meta.dirname,'.layout-fixture-')),paths={source_vault_root:null,managed_notes_root:join(root,'notes'),state_root:join(root,'state'),media_root:join(root,'media')};for(const p of Object.values(paths))if(p)mkdirSync(p);
 const identity={workspace_id:randomUUID(),service_instance_id:randomUUID(),contract_version:'0.1.1' as const};const config:ServiceConfiguration={...identity,title:'article-layout isolated Documents fixture',timezone:'America/Los_Angeles',mode:'demo',paths,listen:{host:'127.0.0.1',port:43959},api_fallback_enabled:false};
 let storage=openWorkspaceStorage(join(paths.state_root,'workbench.sqlite'));storage.db.prepare('INSERT INTO workspaces (id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,?,?,?,?,1)').run(identity.workspace_id,identity.workspace_id,config.title,config.timezone,JSON.stringify(paths),'demo');
 const context=():ApplicationContext=>({db:storage.db,identity,config,paths,getExecutorHealth:async()=>[]});const request=(key:string=randomUUID()):RequestContext=>({...identity,request_id:randomUUID(),idempotency_key:key,request_identity_ref:'fixture-only-human'});
 let documents=new Documents(context()),repository=new SqliteArticleLayoutRepository(storage.db),service=new ArticleLayoutService(repository,documents);const document=await documents.create(request(),{kind:'article',initial_text:'# 真实文章端口\n\n本人输入的正文。\n\n\n'});const article=await service.initialize(request(),{article_id:'fixture-article',document_id:document.document_id});
 return{root,paths,request,document_id:document.document_id,article,
  get documents(){return documents;},get repository(){return repository;},get service(){return service;},get db(){return storage.db;},
  setService(value:ArticleLayoutService){service=value;},
  reopen(){storage.close();storage=openWorkspaceStorage(join(paths.state_root,'workbench.sqlite'));documents=new Documents(context());repository=new SqliteArticleLayoutRepository(storage.db);service=new ArticleLayoutService(repository,documents);},
  cleanup(){try{storage.close();}catch{}rmSync(root,{recursive:true,force:true});}};
}
