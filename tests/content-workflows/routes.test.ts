import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentGenerationSchema, WikiGenerationSchema, ResearchSchema, ReportGenerationSchema } from '../../packages/contracts/src/index.ts';
import type { RouteDefinition, RouteRequest } from '../../packages/domain/src/ports/index.ts';
import { createGenerationModule } from '../../apps/service/src/routes/generation.ts';
import { createRecommendationsModule } from '../../apps/service/src/routes/recommendations.ts';
import { fixture } from './harness.ts';
test('公开canonical字段明确拒绝range和私造Wiki/research字段，采用复用WP08而无重复owner', async () => {
  const f = fixture(); try { const topic = await f.topic(), routes: RouteDefinition[] = [], registrar = { register<T>(route: RouteDefinition<T>) { routes.push(route as RouteDefinition); } }; createGenerationModule(f.context, { staging_root: f.staging }).register(registrar); createRecommendationsModule(f.context, { staging_root: f.staging }).register(registrar);
    assert.equal(new Set(routes.map(r => r.method+' '+r.path)).size, routes.length); assert.ok(routes.filter(r => r.mutation).every(r => r.idempotent && r.schema)); assert.ok(routes.every(r => !r.path.endsWith('/core-approvals') && r.path !== '/api/v1/candidates/{id}/adoption'));
    const input = { base_revision_id: topic.core_revision_id, source_ids: [f.source], instruction: '整体改写', executor: 'codex' }; assert.throws(() => DocumentGenerationSchema.parse({ ...input, range: { start: 0, end: 1 } })); assert.throws(() => WikiGenerationSchema.parse({ document_id: topic.core_document_id, source_ids: [f.source], executor: 'codex' })); assert.throws(() => ResearchSchema.parse({ source_ids: [f.source], executor: 'codex' })); assert.throws(() => ReportGenerationSchema.parse({ document_id: topic.core_document_id, executor: 'codex' }));
    const route = routes.find(r => r.path === '/api/v1/documents/{id}/ai-edits')!, request: RouteRequest = { context: f.request('canonical-generation-replay'), params: { id: topic.core_document_id }, query: new URLSearchParams(), headers: {}, body: route.schema!.parse(input) }, first = await route.handle(request), replay = await route.handle(request); assert.equal(first.status, 202); assert.deepEqual(first, replay); assert.equal(f.jobs.list(f.request()).items.length, 1); assert.equal((await f.documents.get(f.request(), topic.core_document_id)).head_revision_id, topic.core_revision_id);
  } finally { f.cleanup(); }
});
