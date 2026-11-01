import { IndexRunSchema } from '@workbench/contracts';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
import { KnowledgeIndex } from '@workbench/domain/knowledge-index';
export function createKnowledgeModule(context: ApplicationContext): ApplicationModule {
  const index = new KnowledgeIndex(context);
  return { id: 'knowledge', register(registrar) {
    registrar.register({ method: 'GET', path: '/api/v1/knowledge', owner: 'WP-11', handle: request => ({ body: index.list(request.context, { ...(request.query.has('kind') ? { kind: request.query.get('kind')! } : {}), ...(request.query.has('query') ? { query: request.query.get('query')! } : {}), ...(request.query.has('cursor') ? { cursor: request.query.get('cursor')! } : {}) }) }) });
    registrar.register({ method: 'POST', path: '/api/v1/index-runs', owner: 'WP-11', mutation: true, idempotent: true, schema: IndexRunSchema, handle: request => ({ status: 202, body: index.start(request.context, request.body) }) });
    registrar.register({ method: 'GET', path: '/api/v1/search', owner: 'WP-11', handle: async request => ({ body: await index.search(request.context, { query: request.query.get('query') ?? '', ...(request.query.has('types') ? { types: request.query.get('types')!.split(',') } : {}), ...(request.query.has('cursor') ? { cursor: request.query.get('cursor')! } : {}) }) }) });
  }, health: () => ({ module: 'knowledge', status: 'ready', details: { vault: context.paths.source_vault_root ? 'configured_readonly' : 'unconfigured', wiki_generation: 'WP-16' } }) };
}
