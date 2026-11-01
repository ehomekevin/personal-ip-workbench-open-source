import { ContractError, type CapabilityDescription, type JsonObject } from '@workbench/contracts';
export * from './voice.ts';
export * from './readiness.ts';

// 没有当前 provider 合同/授权时不猜 endpoint，也不尝试计费 fallback。
export class H3Readiness {
  async describe(): Promise<CapabilityDescription[]> { return ['submit', 'query', 'cancel'].map(operation => ({ operation, status: 'unconfigured', limitations: ['当前项目 H3 provider 配置、本人输入与付费调用授权未提供'], verified_at: null, evidence_ref: null })); }
  async submit(_input: JsonObject): Promise<JsonObject> { throw new ContractError('CAPABILITY_UNVERIFIED', 'H3 当前未准入', { paid_api_calls_made: 0 }); }
  async query(_providerTaskId: string): Promise<JsonObject> { throw new ContractError('CAPABILITY_UNVERIFIED', 'H3 当前未准入', { paid_api_calls_made: 0 }); }
  async cancel(_providerTaskId: string): Promise<JsonObject> { throw new ContractError('CAPABILITY_UNVERIFIED', 'H3 当前未准入', { paid_api_calls_made: 0 }); }
}
