import { Comparisons, CreateComparisonsSchema } from '@workbench/domain/comparisons';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
import type { ComparisonListQuery } from '@workbench/contracts';
export function createComparisonsModule(context: ApplicationContext): ApplicationModule {
  const comparisons = new Comparisons(context);
  return { id: 'comparisons', register(registrar) {
    registrar.register({ method: 'POST', path: '/api/v1/comparisons', owner: 'WP-13', mutation: true, idempotent: true, schema: CreateComparisonsSchema, handle: request => ({ status: 201, body: comparisons.create(request.context, request.body) }) });
    registrar.register({ method: 'GET', path: '/api/v1/comparisons', owner: 'WP-13', handle: request => { const query: ComparisonListQuery = {}; for (const key of ['platform','account_id','created_start','created_end','cursor'] as const) if (request.query.has(key)) (query as Record<string, unknown>)[key] = request.query.get(key); if (request.query.has('limit')) query.limit = Number(request.query.get('limit')); return { body: comparisons.list(request.context, query) }; } });
    registrar.register({ method: 'GET', path: '/api/v1/comparisons/{id}', owner: 'WP-13', handle: request => ({ body: comparisons.get(request.context, request.params.id!) }) });
  }, health: () => ({ module: 'comparisons', status: 'ready', details: { capability_scope: 'internal_rule', real_provider: 'unverified' } }) };
}
