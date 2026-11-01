import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_VERSION, type RequestContext, type ServiceConfiguration, type JsonObject } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage } from '../../packages/storage/src/connection/index.ts';
import { Topics } from '../../packages/domain/src/topics/index.ts';
import { Documents } from '../../packages/domain/src/documents/index.ts';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { Jobs } from '../../packages/domain/src/jobs/index.ts';
import { ContentGeneration } from '../../packages/domain/src/content-agents/index.ts';
import { buildServiceAgentPlan } from '../../packages/domain/src/service-agent/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';
import { CodexAdapter } from '../../packages/adapters/src/agent/codex/index.ts';
import { RoutedTextAdapter } from '../../apps/service/src/bootstrap/configuration/api-execution.ts';
import { createContentAgentHandlers } from '../../apps/service/src/worker/handlers/content/index.ts';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { originalHandle, threadResponse, project, schemaDirectory, executable } from './native-harness.ts';
export const evidence=process.env.PLATFORM_RECOVERY_EVIDENCE;
export async function integrationFixture(label:string) {
 const base=join(project,'.ci-artifacts/fixtures/platform-original-recovery/consumer');mkdirSync(base,{recursive:true});
 // 原子创建唯一目录；不经组合测试对 mkdtempSync 的旧 runtime 重定位，存储隔离校验仍照常执行。
 const root=join(base,label+'-'+randomUUID());mkdirSync(root,{mode:0o700});
 const paths={source_vault_root:null,managed_notes_root:join(root,'notes'),state_root:join(root,'state'),media_root:join(root,'media')};
 for(const p of [paths.managed_notes_root,paths.state_root,paths.media_root])mkdirSync(p);
 const config:ServiceConfiguration={workspace_id:randomUUID(),service_instance_id:randomUUID(),title:'Original recovery isolated synthetic',mode:'demo',timezone:'America/New_York',paths,listen:{host:'127.0.0.1',port:0}};
 const storage=openWorkspaceStorage(join(paths.state_root,'workbench.sqlite'));storage.db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES(?,?,?,?,?,?,1)').run(config.workspace_id,config.workspace_id,config.title,config.timezone,JSON.stringify(paths),'demo');
 const identity={workspace_id:config.workspace_id,service_instance_id:config.service_instance_id,contract_version:CONTRACT_VERSION};
 const context:ApplicationContext={db:storage.db,config,identity,paths,getExecutorHealth:async()=>[]};
 const request=(key:string=randomUUID()):RequestContext=>({...identity,request_id:randomUUID(),idempotency_key:key,request_identity_ref:'controlled-platform-original-recovery'});
 const jobs=new Jobs(context),topics=new Topics(context),documents=new Documents(context),sources=new Sources(context),generation=new ContentGeneration(context);
 const source=sources.create(request(),{url:'https://example.org/recovery-fixed',title:'受控资料',text:'合成资料，只验证原任务恢复；不是用户原稿。'}).record_id;
 const topic=await topics.create(request(),{title:'隔离恢复验证',category:'个人思考',audience:'测试',source_ids:[source]});
 const core=await documents.save(request(),topic.core_document_id,{expected_revision_id:null,text:'受控核心稿。',origin:'human'});await documents.approveCore(request(),topic.id,core.revision_id);
 const variant=generation.createVariant(request(),topic.id,{platform:'wechat',format:'article'});
 const other=generation.createVariant(request(),topic.id,{platform:'x',format:'text'});
 const accepted=generation.variant(request(),String(variant.id),{core_revision_id:core.revision_id,base_revision_id:null,mode:'initialize',source_ids:[source],executor:'codex'});
 const claim=jobs.claim('controlled-original-seed')!;
 const staging=join(paths.state_root,'generation-staging');
 const plan=buildServiceAgentPlan(context,claim,{staging_root:staging});
 // 显式合成旧 attempt，使用实际计划与绑定算法；不是原用户任务/真实模型结果。
 const handle=originalHandle(plan.input,plan.cwd,identity.workspace_id);
 jobs.checkpoint(claim.fence,{executor_id:'codex',fixed_input_hash:claim.job.input_hash,agent_handle:handle as unknown as JsonObject,pre_submit_failure:false});
 storage.db.prepare('UPDATE job_attempts SET runtime_session_id=?,runtime_turn_id=? WHERE id=?').run(handle.runtime_session_id,handle.runtime_turn_id!,claim.attempt.id);
 jobs.fail(claim.fence,{code:'RESULT_UNKNOWN',message:'controlled old observation ended'},'failed');
 const settings=join(root,'native-settings.json'),trace=join(root,'native-wire.jsonl');
 const output={documents:[{document_id:String(variant.document_id),text:'按原结果核对取得的受控平台稿。'}],recommendations:[]};
 writeFileSync(settings,JSON.stringify({thread:threadResponse(handle,'completed',output)}),{mode:0o600});process.env.WB_RECOVERY_FIXTURE=settings;process.env.WB_RECOVERY_TRACE=trace;
 const adapters:CodexAdapter[]=[];
 const worker=()=>new DurableWorker(context,createContentAgentHandlers(context,{staging_root:staging,createAdapter:p=>{
  const adapter=new CodexAdapter({workspace_id:identity.workspace_id,cwd:p.cwd,lock_root:join(root,'locks'),schema_directory:schemaDirectory,executable,concurrency_slots:1});adapters.push(adapter);return new RoutedTextAdapter(adapter);
 }}));
 const detail=()=>jobs.get(request(),accepted.job_id);
 const query=(key:string=randomUUID())=>jobs.resume(request(key),accepted.job_id,{expected_version:detail().job.version,recovery_action:'query_original'});
 const set=(value:unknown)=>writeFileSync(settings,JSON.stringify(value),{mode:0o600});
 const calls=()=>{try{return readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line));}catch{return [];}};
 const read=()=>documents.get(request(),String(variant.document_id));
 const counts=()=>({receipts:Number(storage.db.prepare('SELECT COUNT(*) n FROM result_receipts WHERE job_id=?').get(accepted.job_id)!.n),candidates:Number(storage.db.prepare('SELECT COUNT(*) n FROM candidates WHERE job_id=?').get(accepted.job_id)!.n),intents:Number(storage.db.prepare('SELECT COUNT(*) n FROM write_intents WHERE job_id=?').get(accepted.job_id)!.n)});
 async function cleanup(){for(const adapter of adapters)await adapter.close();storage.close();if(evidence){const dst=join(evidence,'consumer','cases',root.split('/').at(-1)!);mkdirSync(dst,{recursive:true});cpSync(root,dst,{recursive:true});}delete process.env.WB_RECOVERY_FIXTURE;delete process.env.WB_RECOVERY_TRACE;rmSync(root,{recursive:true,force:true});}
 return {root,context,request,jobs,topics,documents,generation,source,topic,core,variant,other,accepted,claim,handle,plan,staging,settings,trace,output,worker,query,detail,set,calls,read,counts,cleanup};
}
