import { PatchSettingsSchema } from '@workbench/contracts';
import { Settings } from '@workbench/domain/settings';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';

export function createSettingsModule(context: ApplicationContext): ApplicationModule {
  const settings = new Settings(context);
  return { id: 'settings', register(registrar) {
    registrar.register({ method: 'GET', path: '/api/v1/settings', owner: 'WP-08', handle: async request => ({ body: await settings.get(request.context) }) });
    registrar.register({ method: 'PATCH', path: '/api/v1/settings', owner: 'WP-08', mutation: true, idempotent: true, schema: PatchSettingsSchema,
      handle: async request => ({ body: await settings.patch(request.context, request.body) }) });
  }, health: () => ({ module: 'settings', status: 'ready', details: { schema: 'contracts@0.1.1', automatic_paid_fallback: false } }) };
}
