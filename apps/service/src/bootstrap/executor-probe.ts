import { nativeAdapter } from './execution.ts';
import { ContractError } from '@workbench/contracts';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const { workspace, stateRoot, executor } = JSON.parse(input);
const adapter = nativeAdapter(workspace, stateRoot, executor);
try {
  const readiness = await adapter.checkReadiness();
  process.stdout.write(JSON.stringify({ executor_id: executor, status: readiness.capabilities.some(c => c.status === 'supported') ? 'supported' : 'unverified', runtime_version: readiness.runtime_version, auth_state: readiness.auth_state, billing_route: readiness.billing_route, limitations: readiness.limitations }));
} catch (error) {
  const c = error instanceof ContractError ? error : null;
  process.stdout.write(JSON.stringify({ executor_id: executor, status: c?.code === 'AUTH_REQUIRED' ? 'unconfigured' : 'unverified', runtime_version: typeof c?.details.runtime_version === 'string' ? c.details.runtime_version : null, auth_state: c?.code ?? 'READINESS_UNAVAILABLE', billing_route: null, limitations: [c?.message ?? '执行器检查未完成'] }));
} finally { await adapter.close?.(); }
