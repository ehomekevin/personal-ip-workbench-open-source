import { CreateAccountSchema, AccountIdentityCheckSchema,BenchmarkSyncSchema,BenchmarkMaterialReprojectionSchema,BenchmarkStatisticsRefreshSchema } from '@workbench/contracts';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
import { Sources } from '@workbench/domain/sources';
import { AccountChecks } from '../../../../packages/domain/src/sources/account-checks.ts';
import { TikHubAdapter } from '@workbench/adapters/tikhub';
import type { ResolvedAccount } from '@workbench/adapters/tikhub';
import { BenchmarkSync } from '../../../../packages/domain/src/sources/benchmark-sync.ts';
import { BenchmarkMaterialReprojection } from '../../../../packages/domain/src/sources/material-reprojection.ts';
import { BenchmarkStatistics,type BenchmarkStatisticsClient } from '../../../../packages/domain/src/sources/benchmark-statistics.ts';
import { BenchmarkStatisticsAdapter } from '../../../../packages/adapters/src/tikhub/benchmark-statistics.ts';
import { readTikHubCredential } from '../bootstrap/tikhub-credentials.ts';
import { DurableWorker } from '../worker/core/index.ts';
export function createBenchmarkAccountsModule(context: ApplicationContext, options: { statistics?:BenchmarkStatisticsClient; adapter?: TikHubAdapter; wechat?: { resolveAccount(accountId: string, url: string): Promise<ResolvedAccount> } } = {}): ApplicationModule {
  const sources = new Sources(context);
  const checks = new AccountChecks(context, options.adapter ?? new TikHubAdapter(), options.wechat);
  const sync = new BenchmarkSync(context, options.adapter ?? new TikHubAdapter());
  const statistics=new BenchmarkStatistics(context,options.statistics??new BenchmarkStatisticsAdapter({token_provider:()=>process.env.WORKBENCH_TIKHUB_LOCAL_CREDENTIAL==='1'?readTikHubCredential(context.paths.state_root):process.env.TIKHUB_API_KEY?.trim()||null}));
  const materials = new BenchmarkMaterialReprojection(context);
  const worker = new DurableWorker(context, [{registration:{kind:'benchmark_sync',execution_mode:'programmatic',recovery:'read_only'},async execute(e){
    const input=JSON.parse(e.claim.job.input_manifest);if(e.claim.job.target_id!==input.account_id)throw new Error('Benchmark target mismatch');
    await sync.execute(e.claim.job.id,input,{fence:e.claim.fence,signal:e.signal,checkpoint:e.checkpoint});return {documents:[],recommendations:[]};
  }}]);let timer:ReturnType<typeof setInterval>|undefined,active:Promise<unknown>|null=null,closed=false;
  const tick=()=>{if(active||closed)return;active=worker.runOnce().catch(()=>undefined).finally(()=>{active=null;});};
  return { id: 'benchmark-accounts', async initialize(){await statistics.initialize();tick();timer=setInterval(tick,500);timer.unref();},async close(){closed=true;if(timer)clearInterval(timer);await active;await statistics.close();},register(registrar) {
    registrar.register({method:'GET',path:'/api/v1/accounts/material-statistics-refresh',owner:'CONFIG-04',handle:r=>({body:{current:statistics.status(r.context)}})});
    registrar.register({method:'POST',path:'/api/v1/accounts/material-statistics-refresh',owner:'CONFIG-04',mutation:true,idempotent:true,schema:BenchmarkStatisticsRefreshSchema,handle:r=>({status:202,body:statistics.start(r.context,r.body)})});
    registrar.register({ method:'GET',path:'/api/v1/accounts/{id}/feed-sync',owner:'CONFIG-02',handle:r=>({body:sync.status(r.context,r.params.id!)}) });
    registrar.register({ method:'POST',path:'/api/v1/accounts/{id}/feed-sync',owner:'CONFIG-04',mutation:true,idempotent:true,schema:BenchmarkSyncSchema,handle:r=>({status:202,body:sync.enqueue(r.context,r.params.id!,r.body)}) });
    registrar.register({method:'POST',path:'/api/v1/accounts/{id}/material-reprojection',owner:'CONFIG-04',mutation:true,idempotent:true,schema:BenchmarkMaterialReprojectionSchema,handle:r=>({body:materials.refresh(r.context,r.params.id!,r.body)})});
    registrar.register({ method: 'POST', path: '/api/v1/accounts/{id}/identity-check', owner: 'TEXT-LOOP-01', mutation: true, idempotent: true, schema: AccountIdentityCheckSchema, handle: async request => ({ body: await checks.check(request.context, request.params.id!) }) });
    registrar.register({ method: 'GET', path: '/api/v1/accounts', owner: 'WP-11', handle: request => ({ body: sources.accounts(request.context, { ...(request.query.has('role') ? { role: request.query.get('role')! } : {}), ...(request.query.has('platform') ? { platform: request.query.get('platform')! } : {}), ...(request.query.has('identity_status') ? { identity_status: request.query.get('identity_status')! } : {}), ...(request.query.has('cursor') ? { cursor: request.query.get('cursor')! } : {}) }) }) });
    registrar.register({ method: 'POST', path: '/api/v1/accounts', owner: 'WP-11', mutation: true, idempotent: true, schema: CreateAccountSchema, handle: request => ({ status: 201, body: sources.createAccount(request.context, request.body) }) });
  }, health: () => ({ module: 'benchmark-accounts', status: 'ready', details: { latest_works:['x','douyin'], trigger:'manual', identity_check: 'unverified', ai_research: 'WP-16' } }) };
}
