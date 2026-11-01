import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { API_RESOURCES } from '../../packages/contracts/src/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';
import { createDailyPlansModule } from '../../apps/service/src/routes/daily-plans.ts';
import { createComparisonsModule } from '../../apps/service/src/routes/comparisons.ts';
import { createRouteRegistry } from '../../apps/service/src/routes/index.ts';

test('OpenAPI 幂等头必填要求与正式每日计划、比较路由一致', () => {
  // 只注册模块定义，不初始化服务、不执行 handler 或写库。
  const context = {} as ApplicationContext;
  const { routes } = createRouteRegistry([createDailyPlansModule(context), createComparisonsModule(context)]);
  const document = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8')) as {
    paths: Record<string, Record<string, { parameters: { name: string; in: string; required: boolean }[] }>>;
  };
  for (const [method, path] of [['PUT', '/api/v1/daily-plans/{local_date}'], ['POST', '/api/v1/comparisons']]) {
    const runtime = routes.find(route => route.definition.method === method && route.definition.path === path);
    assert.equal(runtime?.definition.idempotent, true);
    const header = document.paths[path!]![method!.toLowerCase()]!.parameters.find(param => param.name === 'Idempotency-Key' && param.in === 'header');
    assert.equal(header?.required, runtime!.definition.idempotent, path);
  }
  for (const resource of API_RESOURCES) if ('idempotent' in resource) {
    const operation = document.paths[resource.path]![resource.method.toLowerCase()]!;
    assert.equal(operation.parameters.find(param => param.name === 'Idempotency-Key')?.required, resource.idempotent, resource.path);
  }
});
