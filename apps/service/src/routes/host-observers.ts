import { RegisterObserverSchema, BindNativeTaskSchema, ObserveNativeTaskSchema, ReattachNativeTaskSchema } from '@workbench/contracts';
import { HostRuns } from '@workbench/domain/host-runs';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';

export function createHostObserversModule(_context: ApplicationContext, runs: HostRuns): ApplicationModule {
  return { id: 'host-observers', register(registrar) {
    registrar.register({ method: 'POST', path: '/api/v1/host-task-observers', owner: 'WP-17', mutation: true, idempotent: true,
      schema: RegisterObserverSchema,
      handle: request => ({ status: 201, body: runs.register(request.context, runs.authority.authenticate(request.headers, 'observer'), request.body) }) });
    registrar.register({ method: 'POST', path: '/api/v1/host-task-observers/{id}/bindings', owner: 'WP-17', mutation: true, idempotent: true,
      schema: BindNativeTaskSchema,
      handle: request => ({ status: 201, body: runs.bind(request.context, runs.authority.authenticate(request.headers, 'observer'), request.params.id!, request.body) }) });
    registrar.register({ method: 'POST', path: '/api/v1/native-task-bindings/{id}/observations', owner: 'WP-17', mutation: true,
      schema: ObserveNativeTaskSchema,
      handle: request => ({ status: 201, body: runs.observe(request.context, runs.authority.authenticate(request.headers, 'observer'), request.params.id!, request.body) }) });
    registrar.register({ method: 'POST', path: '/api/v1/native-task-bindings/{id}/reattach', owner: 'WP-17', mutation: true,
      schema: ReattachNativeTaskSchema,
      handle: request => ({ body: runs.reattach(request.context, runs.authority.authenticate(request.headers, 'observer'), request.params.id!, request.body) }) });
  }, health: () => ({ module: 'host-observers', status: 'blocked', details: { native_task_tracking: 'unverified', actual_host_observers: 'not_installed', protocol: 'available' } }) };
}
