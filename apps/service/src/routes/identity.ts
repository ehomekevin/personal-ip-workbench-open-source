import { objectSchema, type ImportWorkRequest, PLATFORMS, FORMATS } from '@workbench/contracts';
import { Identities } from '@workbench/domain/identity';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';

export function createIdentityModule(context: ApplicationContext): ApplicationModule {
  const identities = new Identities(context);
  return { id: 'identity', register(registrar) {
    registrar.register({ method: 'POST', path: '/api/v1/works/import', owner: 'WP-08', mutation: true, idempotent: true,
      schema: objectSchema<ImportWorkRequest>(['platform', 'url'], { platform: { type: 'string', enum: [...PLATFORMS] }, url: { type: 'string' }, topic_id: { type: 'string', nullable: true }, format: { type: 'string', nullable: true, enum: [...FORMATS] } }),
      handle: async request => ({ status: 201, body: await identities.importWork(request.context, request.body) }) });
    registrar.register({ method: 'GET', path: '/api/v1/works', owner: 'WP-08', handle: request => ({ body: identities.list(request.context) }) });
    registrar.register({ method: 'GET', path: '/api/v1/works/{id}', owner: 'WP-08', handle: request => ({ body: identities.get(request.context, request.params.id!) }) });
  }, health: () => ({ module: 'identity', status: 'ready', details: { external_identity_check: 'unverified' } }) };
}
