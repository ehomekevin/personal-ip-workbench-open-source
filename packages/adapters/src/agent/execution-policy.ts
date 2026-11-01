import {TextExecutionPolicySchema,TextObservationPolicySchema,type TextExecutionPolicy,type TextObservationPolicy,type AgentRunInput} from '@workbench/contracts';
export function frozenTextExecution(input:AgentRunInput):TextExecutionPolicy|undefined {
 const frozen=input.input_manifest.frozen,agent=frozen&&typeof frozen==='object'&&!Array.isArray(frozen)?frozen.service_agent:undefined;
 if(!agent||typeof agent!=='object'||Array.isArray(agent)||agent.execution_policy===undefined)return undefined;
 return TextExecutionPolicySchema.parse(agent.execution_policy);
}
// 观察时限与模型/推理选择分开冻结；已有写作策略继续优先，不改其选择。
export function frozenObservation(input:AgentRunInput):TextObservationPolicy|undefined {
 const execution=frozenTextExecution(input);
 if(execution)return {idle_timeout_ms:execution.idle_timeout_ms,max_duration_ms:execution.max_duration_ms};
 const frozen=input.input_manifest.frozen;
 if(!frozen||typeof frozen!=='object'||Array.isArray(frozen)||frozen.observation_policy===undefined)return undefined;
 return TextObservationPolicySchema.parse(frozen.observation_policy);
}
