import { randomUUID } from 'node:crypto';
import { existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { CONTRACT_VERSION,type RequestContext,type ServiceConfiguration,type ObservationPlanInput } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage,assertStorageRoot,transaction,sha256 } from '../../packages/storage/src/connection/index.ts';
import { MetricsRawFiles,ensureMetricsSourceInTransaction,commitObservationInTransaction } from '../../packages/storage/src/metrics/index.ts';
import { Comparisons } from '../../packages/domain/src/comparisons/index.ts';
import { Retro } from '../../packages/domain/src/retro/index.ts';
import { Documents } from '../../packages/domain/src/documents/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';
export const projectRoot=resolve(import.meta.dirname,'../..');
export const runRoot=join(process.env.WORKBENCH_TEST_EVIDENCE_DIR ?? join(projectRoot,'.ci-artifacts/evidence/wp-14'),`runs/${new Date().toISOString().replaceAll(':','-')}-${randomUUID().slice(0,8)}`);
mkdirSync(runRoot,{recursive:true});
export const records:Record<string,unknown>[]=[];
export function evidence(name:string,value:unknown) {const path=join(runRoot,name+'.json'),body=JSON.stringify(value,null,2)+'\n';writeFileSync(path,body,{flag:'wx'});return {path,sha256:sha256(body)};}
export function fixture(testPath='tests/retro-adoption') {
  assertStorageRoot(projectRoot);const root=mkdtempSync(join(projectRoot,testPath,'/.wp14-'));
  const paths={source_vault_root:null,managed_notes_root:join(root,'notes'),state_root:join(root,'state'),media_root:join(root,'media')};for(const path of Object.values(paths))if(path)mkdirSync(path,{recursive:true});
  const config:ServiceConfiguration={workspace_id:randomUUID(),service_instance_id:randomUUID(),title:'WP14 internal_rule',mode:'real',timezone:'America/Los_Angeles',paths,listen:{host:'127.0.0.1',port:4319}};
  let storage=openWorkspaceStorage(join(paths.state_root,'workbench.sqlite')),now=Date.parse('2026-10-10T00:00:00.000Z');
  const workspace=config.workspace_id,identity={workspace_id:workspace,service_instance_id:config.service_instance_id,contract_version:CONTRACT_VERSION};
  storage.db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES(?,?,?,?,?,?,1)').run(workspace,workspace,config.title,config.timezone,JSON.stringify(paths),'real');
  const account=randomUUID(),definition=randomUUID();storage.db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES(?,?,'x','fixture-owner','owner','fixture','https://fixture.invalid/owner','confirmed')").run(account,workspace);
  storage.db.prepare("INSERT INTO metric_definitions(id,workspace_id,platform,key,raw_field,unit,kind,visibility,definition_version,scope) VALUES(?,?,'x','views','views','count','cumulative','public','v1','work')").run(definition,workspace);
  const context=():ApplicationContext=>({db:storage.db,identity,config,paths,getExecutorHealth:async()=>[]});
  const request=(key=randomUUID()):RequestContext=>({...identity,request_id:randomUUID(),idempotency_key:key,request_identity_ref:'human-test'});
  function work(published='2026-10-02T00:00:00.000Z',topicId:string|null=null,patch:Record<string,unknown>={}) {const id=randomUUID();storage.db.prepare('INSERT INTO works(id,workspace_id,platform,platform_work_id,account_id,format,format_source,topic_id,url,published_at,origin,identity_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,workspace,patch.platform as string ?? 'x',id,patch.account_id as string ?? account,patch.format as string ?? 'text','human_classification',topicId,'https://fixture.invalid/work/'+id,published,'fixture','confirmed');return id;}
  function snapshot(workId:string,value='100',age=70,patch:{unknown?:boolean;collected_at?:string}={}) {
    const workRow=storage.db.prepare('SELECT * FROM works WHERE id=?').get(workId)!,published=String(workRow.published_at),observed=new Date(Date.parse(published)+age*3600_000).toISOString(),collection=randomUUID(),raw=new MetricsRawFiles(paths.state_root).write(collection,JSON.stringify({evidence_scope:'internal_rule',work_id:workId,value,observed_at:patch.unknown?null:observed}));
    const result=transaction(storage.db,()=>commitObservationInTransaction(storage.db,workspace,ensureMetricsSourceInTransaction(storage.db,workspace),{platform:'x',scope:'work',target_id:workId,platform_work_id:workId,account_id:account,collection_request_id:collection,request_fingerprint:sha256(collection),observed_at:patch.unknown?null:observed,observed_time_basis:patch.unknown?'unknown':'collector_verified',observed_time_reason:patch.unknown?'fixture未知时点':null,observation_evidence_ref:patch.unknown?null:'internal_rule:fixture-known-age',collected_at:patch.collected_at ?? new Date(Date.parse(observed)+60000).toISOString(),published_at:published,target_window:72,raw_path:raw.path,raw_sha256:raw.sha256,adapter_version:'wp14-fixture-v1',metrics:[{definition:{id:definition,platform:'x',key:'views',raw_field:'views',unit:'count',kind:'cumulative',visibility:'public',definition_version:'v1',scope:'work'},value,availability:'available',reason:null}],failure:null,retry_after_s:null,evidence_kind:'internal_rule'}));
    return {id:result.snapshot_id,rawPath:raw.path,rawHash:raw.sha256};
  }
  const retro=()=>new Retro(context(),{clock:()=>now}),comparisons=()=>new Comparisons(context(),{clock:()=>now});
  async function report(sampleCount=5,noBaseline=false) {
    const baselineWorks=Array.from({length:sampleCount},()=>work());const snapshots=baselineWorks.map((id,index)=>snapshot(id,String(100+index)));
    const run=comparisons().create(request(),{kind:'self_period',platform:'x',account_ids:[account],format:'text',metric_definition_id:definition,timezone:config.timezone,as_of:new Date(now).toISOString(),cohort_windows:{target:{start:'2026-10-01T07:00:00Z',end:'2026-10-08T07:00:00Z'},baseline:{start:'2026-09-24T07:00:00Z',end:'2026-10-01T07:00:00Z'}}});
    const doc=await new Documents(context()).create(request(),{kind:'retro_report',initial_text:'固定统计依据，假设等待后续真实作品验证。'}),id=randomUUID();
    storage.db.prepare("INSERT INTO retro_reports(id,workspace_id,document_id,comparison_run_id,source_record_ids,status) VALUES(?,?,?,?,?,'ready')").run(id,workspace,doc.document_id,run.id,'[]');
    const plan:ObservationPlanInput={platform:'x',account_id:account,format:'text',metric_definition_id:definition,timezone:config.timezone,aggregation:'sum',observation_window_h:72,tolerance_h:6,min_target_samples:1,earliest_evaluation_at:null,baseline_run_id:noBaseline?null:run.id,baseline_cohort_key:noBaseline?null:`target:${account}`};
    const action=retro().createAction(request(),id,{report_revision_id:doc.head_revision_id!,description:'先展示实际结果',hypothesis:'在相同观察时点比较后续表现',metric:definition,observation_plan:plan});
    return {run,doc,reportId:id,plan,action,baselineWorks,snapshots};
  }
  return {root,paths,config,identity,account,definition,context,request,work,snapshot,retro,comparisons,report,clock:()=>now,setTime:(at:string)=>{now=Date.parse(at);},reopen(){storage.close();storage=openWorkspaceStorage(join(paths.state_root,'workbench.sqlite'));},cleanup(){storage.close();rmSync(root,{recursive:true,force:true});return {root,removed:!existsSync(root)};}};
}
