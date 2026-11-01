import { DocumentGenerationSchema, VariantGenerationSchema, WikiGenerationSchema, ReportGenerationSchema, ResearchSchema, CreateVariantSchema } from '@workbench/contracts';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
import { ContentGeneration, AccountResearch, type GenerationOptions } from '@workbench/domain/content-agents';
export function createGenerationModule(context: ApplicationContext, options: GenerationOptions = {}): ApplicationModule {
  const generation = new ContentGeneration(context, options);
  return { id: 'generation', register(registrar) {
    registrar.register({ method: 'POST', path: '/api/v1/documents/{id}/ai-edits', owner: 'WP-16', mutation: true, idempotent: true, schema: DocumentGenerationSchema, handle: request => ({ status: 202, body: generation.modify(request.context, request.params.id!, request.body) }) });
    registrar.register({ method: 'POST', path: '/api/v1/topics/{id}/variants', owner: 'WP-16', mutation: true, idempotent: true, schema: CreateVariantSchema, handle: request => ({ status: 201, body: generation.createVariant(request.context, request.params.id!, request.body) }) });
    registrar.register({ method: 'POST', path: '/api/v1/variants/{id}/generation', owner: 'WP-16', mutation: true, idempotent: true, schema: VariantGenerationSchema, handle: request => ({ status: 202, body: generation.variant(request.context, request.params.id!, request.body) }) });
    registrar.register({ method: 'POST', path: '/api/v1/wiki-generations', owner: 'WP-16', mutation: true, idempotent: true, schema: WikiGenerationSchema, handle: request => ({ status: 202, body: generation.wiki(request.context, request.body) }) });
    registrar.register({ method: 'POST', path: '/api/v1/retro-reports', owner: 'WP-16', mutation: true, idempotent: true, schema: ReportGenerationSchema, handle: request => ({ status: 202, body: generation.report(request.context, request.body) }) });
    registrar.register({ method: 'GET', path: '/api/v1/accounts/{id}/research', owner: 'BENCHMARK-RESEARCH-01', handle: async request => ({ body: await new AccountResearch(context,generation.skillLibrary).get(request.context,request.params.id!) }) });
    registrar.register({ method: 'POST', path: '/api/v1/accounts/{id}/research', owner: 'WP-16', mutation: true, idempotent: true, schema: ResearchSchema, handle: async request => ({ status: 202, body: await generation.research(request.context, request.params.id!, request.body) }) });
    registrar.register({ method: 'GET', path: '/api/v1/documents/{id}/candidates', owner: 'WP-16', handle: request => ({ body: { items: generation.candidates(request.context, request.params.id!), next_cursor: null, has_more: false, last_success_at: new Date().toISOString() } }) });
    registrar.register({ method: 'GET', path: '/api/v1/candidates/{id}', owner: 'WP-16', handle: async request => ({ body: await generation.preview(request.context, request.params.id!) }) });
    registrar.register({ method: 'GET', path: '/api/v1/documents/{id}/revisions/{revision_id}', owner: 'WP-16', handle: request => ({ body: generation.revision(request.context, request.params.id!, request.params.revision_id!) }) });
  }, health: () => ({ module: 'generation', status: 'ready', details: { scope: 'whole_text_candidates', real_provider: 'per_executor_readiness', structured_ui: 'blocked_G01_G09' } }) };
}
