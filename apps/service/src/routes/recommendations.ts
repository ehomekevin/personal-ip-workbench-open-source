import { TopicRecommendationSchema, AccountRecommendationSchema, RecommendationAdoptionSchema } from '@workbench/contracts';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
import { Recommendations } from '@workbench/domain/recommendations';
import type { GenerationOptions } from '@workbench/domain/content-agents';
export function createRecommendationsModule(context: ApplicationContext, options: GenerationOptions = {}): ApplicationModule {
  const recommendations = new Recommendations(context, options);
  return { id: 'recommendations', register(registrar) {
    registrar.register({ method: 'POST', path: '/api/v1/topic-recommendations', owner: 'WP-16', mutation: true, idempotent: true, schema: TopicRecommendationSchema, handle: request => ({ status: 202, body: recommendations.topic(request.context, request.body) }) });
    registrar.register({ method: 'POST', path: '/api/v1/account-recommendations', owner: 'WP-16', mutation: true, idempotent: true, schema: AccountRecommendationSchema, handle: request => ({ status: 202, body: recommendations.account(request.context, request.body) }) });
    registrar.register({ method: 'GET', path: '/api/v1/recommendation-runs', owner: 'WP-16', handle: request => ({ body: recommendations.list(request.context, { ...(request.query.has('kind') ? { kind: request.query.get('kind')! } : {}), ...(request.query.has('state') ? { state: request.query.get('state')! } : {}), ...(request.query.has('cursor') ? { cursor: request.query.get('cursor')! } : {}) }) }) });
    registrar.register({ method: 'GET', path: '/api/v1/recommendation-runs/{id}', owner: 'WP-16', handle: request => ({ body: recommendations.get(request.context, request.params.id!) }) });
    registrar.register({ method: 'POST', path: '/api/v1/recommendation-candidates/{id}/adoption', owner: 'WP-16', mutation: true, idempotent: true, schema: RecommendationAdoptionSchema, handle: request => ({ status: 201, body: recommendations.adopt(request.context, request.params.id!, request.body) }) });
  }, health: () => ({ module: 'recommendations', status: 'ready', details: { default_adoption: 'one_target_per_candidate', account_identity: 'pending_until_verified' } }) };
}
