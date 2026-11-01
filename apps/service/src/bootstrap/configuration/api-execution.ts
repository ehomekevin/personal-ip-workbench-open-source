import {join} from 'node:path';
import {ContractError,type AgentRunInput,type AgentRunHandle,type JsonObject} from '@workbench/contracts';
import type {AgentPort} from '@workbench/domain/ports';
import type {ServiceAgentPlan} from '@workbench/domain/service-agent';
import {ApiTextAdapter} from '../../../../../packages/adapters/src/agent/api.ts';
import {readLocalCredential} from './credentials.ts';
export class RoutedTextAdapter implements AgentPort {
 private selected?:AgentPort;
 readonly native:AgentPort & {close?():Promise<void>};readonly api?:ApiTextAdapter;
 constructor(native:AgentPort & {close?():Promise<void>},api?:ApiTextAdapter){this.native=native;this.api=api;}
 describe(){return this.native.describe();}checkReadiness(){return this.native.checkReadiness();}
 async start(input:AgentRunInput){
  // readiness 只读，不提交推理；这段失败与 start 后的未知结果必须分开保存。
  try{try{await this.native.checkReadiness();this.selected=this.native;}catch(error){if(!this.api||!(error instanceof ContractError)||!['AUTH_REQUIRED','QUOTA_EXHAUSTED'].includes(error.code))throw error;await this.api.checkReadiness();this.selected=this.api;}}
  catch(error){if(error instanceof ContractError)throw new ContractError(error.code,error.message,{...error.details,pre_submit_failure:true},error.retryable);throw new ContractError('CAPABILITY_UNVERIFIED','执行前只读检查未完成，尚未提交生成',{pre_submit_failure:true});}
  return this.selected.start(input);
 }
 private forHandle(handle:AgentRunHandle){if(handle.runtime_session_id.startsWith('api:')){if(!this.api)throw new ContractError('INPUT_STALE','恢复任务没有原 API 路线');return this.api;}return this.native;}
 streamEvents(handle:AgentRunHandle){return this.forHandle(handle).streamEvents(handle);}
 requestInput(handle:AgentRunHandle,input:JsonObject){return this.forHandle(handle).requestInput(handle,input);}
 cancel(handle:AgentRunHandle){return this.forHandle(handle).cancel(handle);}
 resume(handle:AgentRunHandle,input:JsonObject){this.selected=this.forHandle(handle);return this.selected.resume(handle,input);}
 async close(){await this.native.close?.();await this.api?.close();}
}
export function routedTextAdapter(plan:ServiceAgentPlan,workspace:string,root:string,native:AgentPort & {close?():Promise<void>}){const route=plan.api_fallback;if(!route?.enabled)return new RoutedTextAdapter(native);return new RoutedTextAdapter(native,new ApiTextAdapter({workspace_id:workspace,root:join(root,'api-receipts'),route,key:()=>readLocalCredential(root,route.provider,undefined,workspace)}));}
