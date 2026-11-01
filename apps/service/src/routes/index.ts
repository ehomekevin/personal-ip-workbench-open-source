import { API_RESOURCES, ContractError } from '@workbench/contracts';
import type { ApplicationModule, RouteDefinition, RouteRegistrar } from '@workbench/domain/ports';
export interface RegisteredRoute { definition: RouteDefinition; pattern: RegExp; params: string[] }
export function createRouteRegistry(modules: ApplicationModule[]): { routes: RegisteredRoute[]; registrar: RouteRegistrar } {
  const routes: RegisteredRoute[] = [];
  const registrar: RouteRegistrar = { register<T>(definition: RouteDefinition<T>): void {
    if (!API_RESOURCES.some(resource => resource.method === definition.method && resource.path === definition.path)) throw new Error(`Route outside registered contract: ${definition.method} ${definition.path}`);
    if (routes.some(route => route.definition.method === definition.method && route.definition.path === definition.path)) throw new Error('Duplicate route registration');
    const params: string[] = [];
    const pattern = new RegExp('^' + definition.path.split('/').map(part => { if (/^\{[^}]+\}$/.test(part)) { params.push(part.slice(1, -1)); return '([^/]+)'; } return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('/') + '/?$');
    routes.push({ definition: definition as unknown as RouteDefinition, pattern, params });
  } };
  for (const module of modules) module.register(registrar);
  // 未登记模块的资源仍可辨认，不能把未实现接口返回假成功。
  for (const resource of API_RESOURCES) if (resource.path !== '/api/v1/identity' && !routes.some(route => route.definition.method === resource.method && route.definition.path === resource.path)) registrar.register({ method: resource.method, path: resource.path, owner: resource.implementation_owner, mutation: resource.method !== 'GET', handle: () => { throw new ContractError('CAPABILITY_UNVERIFIED', '该领域模块尚未接线', { resource: resource.path, owner: resource.implementation_owner, state: 'not_run' }); } });
  return { routes, registrar };
}
