import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,cpSync,chmodSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AgentRunHandle,AgentRunInput,JsonObject} from '../../packages/contracts/src/index.ts';
import {hash,canonical,nativeBindingHash} from '../../packages/adapters/src/agent/codex/primitives.ts';
export const project=resolve(fileURLToPath(new URL('../../',import.meta.url)));
export const schemaDirectory=join(project,'.ci-artifacts/evidence/wp-03/local-inventory/codex-schema-0.161.0');
export const executable=join(project,'tests/platform-original-recovery/native-fixture.mjs');
export function nativeFixture(){
 const base=join(project,'runtime/platform-original-recovery-r2/native');mkdirSync(base,{recursive:true});
 const root=mkdtempSync(join(base,'case-'));mkdirSync(join(root,'locks'));
 const settings=join(root,'settings.json'),trace=join(root,'wire.jsonl');writeFileSync(settings,'{}',{mode:0o600});
 process.env.WB_RECOVERY_FIXTURE=settings;process.env.WB_RECOVERY_TRACE=trace;
 return {root,settings,trace,options:{workspace_id:randomUUID(),cwd:root,lock_root:join(root,'locks'),schema_directory:schemaDirectory,executable,timeout_ms:1000},set(value:unknown){writeFileSync(settings,JSON.stringify(value),{mode:0o600});},calls(){try{return readFileSync(trace,'utf8').trim().split('\n').map(l=>JSON.parse(l));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}},cleanup(){
  const evidence=process.env.PLATFORM_RECOVERY_EVIDENCE;
  if(evidence){
   const archive=join(evidence,'native','control-cases',basename(root));mkdirSync(archive,{recursive:true});
   for(const name of ['settings.json','wire.jsonl']){try{cpSync(join(root,name),join(archive,name));chmodSync(join(archive,name),0o600);}catch{/* query may be rejected before a process exists. */}}
  }
  delete process.env.WB_RECOVERY_FIXTURE;delete process.env.WB_RECOVERY_TRACE;rmSync(root,{recursive:true,force:true});}};
}
export function fixedInput():AgentRunInput{return {job_id:randomUUID(),kind:'variant_generate',target_document_id:null,base_revision_id:null,task_instruction:'Controlled synthetic recovery only.',input_manifest:{frozen:{source_ids:[]}},allowed_tools:[],output_schema:{type:'object',required:['answer'],additionalProperties:false,properties:{answer:{type:'string'}}}};}
export function originalHandle(input:AgentRunInput,cwd:string,workspace:string):AgentRunHandle{
 const thread=randomUUID(),turn=randomUUID();const checkpoint:JsonObject={executor_id:'codex',runtime_version:'codex-cli 0.161.0',workspace_id:workspace,cwd,allowed_tools:[],runtime_session_id:thread,runtime_turn_id:turn,input_hash:hash(canonical(input.input_manifest)),run_input:input as unknown as JsonObject,run_input_hash:hash(canonical(input)),model_provider:'openai',billing_route:'chatgpt_subscription'};checkpoint.native_binding_hash=nativeBindingHash(checkpoint);
 return {runtime_session_id:thread,runtime_turn_id:turn,supports_resume:true,checkpoint};
}
export function threadResponse(handle:AgentRunHandle,status='completed',output:unknown={answer:'42'}){
 const base=JSON.parse(readFileSync(join(project,'tests/service-agent/native-fixture.json'),'utf8'));
 return {...base['thread/start'].thread,id:handle.runtime_session_id,cwd:handle.checkpoint.cwd,turns:[{...base['turn/completed'].turn,id:handle.runtime_turn_id,status,items:output===undefined?[]:[{...base['item/completed'].item,phase:'final_answer',text:JSON.stringify(output)}]}]};
}
