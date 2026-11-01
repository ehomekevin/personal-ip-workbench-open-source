import { ImportExistingWorkSchema, objectSchema, PLATFORMS, ContractError, type Platform } from '@workbench/contracts';
import { Works } from '@workbench/domain/works';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';

export function createWorksModule(context: ApplicationContext): ApplicationModule {
  const works = new Works(context);
  return { id: 'works', register(registrar) {
    registrar.register({ method: 'POST', path: '/api/v1/works/import', owner: 'WP-12', mutation: true, idempotent: true, schema: ImportExistingWorkSchema, handle: async request => ({ status: 201, body: await works.importWork(request.context, request.body) }) });
    registrar.register({ method: 'GET', path: '/api/v1/works', owner: 'WP-12', handle: request => {
      const platform = request.query.get('platform'); if (platform !== null && !PLATFORMS.includes(platform as Platform)) throw new ContractError('VALIDATION_ERROR', '平台筛选无效');
      return { body: works.list(request.context, { ...(platform ? { platform: platform as Platform } : {}), ...Object.fromEntries(['account_id', 'identity_status', 'topic_id', 'cursor'].filter(key => request.query.has(key)).map(key => [key, request.query.get(key)!])), ...(request.query.has('limit') ? { limit: Number(request.query.get('limit')) } : {}) }) };
    } });
    registrar.register({ method: 'GET', path: '/api/v1/works/{id}', owner: 'WP-12', handle: request => ({ body: works.get(request.context, request.params.id!) }) });
    registrar.register({ method: 'POST', path: '/api/v1/works/{id}/identity-check', owner: 'WP-12', mutation: true, idempotent: true, schema: objectSchema<{ job_id: string }>(['job_id'], { job_id: { type: 'string' } }), handle: request => ({ body: works.identityCheck(request.context, request.params.id!, request.body.job_id) }) });
  }, health: () => ({ module: 'works', status: 'ready', details: { identity_resolver: 'unverified', import_pending_supported: true } }) };
}
