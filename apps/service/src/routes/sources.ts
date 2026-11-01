import { CreateSourceRecordSchema, SourceMarksSchema, LinkTopicSourceSchema, SourceSyncSchema, type SourceSyncRequest } from '@workbench/contracts';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';
import { Sources } from '@workbench/domain/sources';
import { DurableWorker } from '../worker/core/index.ts';
import { createIngestHandlers } from '../worker/handlers/ingest/index.ts';

export function createSourcesModule(context: ApplicationContext): ApplicationModule {
  const sources = new Sources(context), worker = new DurableWorker(context, createIngestHandlers(context)); let timer: ReturnType<typeof setInterval> | undefined, active: Promise<unknown> | null = null, closed = false;
  const tick = (): void => { if (active || closed) return; active = worker.runOnce().catch(() => undefined).finally(() => { active = null; }); };
  return { id: 'sources', initialize() { sources.ensurePublicSources(); tick(); timer = setInterval(tick, 500); timer.unref(); }, async close() { closed = true; if (timer) clearInterval(timer); await active; }, register(registrar) {
    registrar.register({ method: 'GET', path: '/api/v1/sources', owner: 'WP-11', handle: request => ({ body: sources.list(request.context) }) });
    registrar.register({ method: 'GET', path: '/api/v1/source-records', owner: 'WP-11', handle: request => ({ body: sources.records(request.context, {
      ...(request.query.has('curated')?{curated:request.query.get('curated')==='true'}:{}), ...(request.query.has('order') ? { order: request.query.get('order')! as 'captured_desc'|'published_desc' } : {}), ...(request.query.has('source') ? { source: request.query.get('source')! } : {}), ...(request.query.has('category') ? { category: request.query.get('category')! } : {}), ...(request.query.has('date') ? { date: request.query.get('date')! } : {}), ...(request.query.has('query') ? { query: request.query.get('query')! } : {}), ...(request.query.has('cursor') ? { cursor: request.query.get('cursor')! } : {}), ...(request.query.has('favorite') ? { favorite: request.query.get('favorite') === 'true' } : {}) }) }) });
    registrar.register({ method: 'GET', path: '/api/v1/source-records/{id}', owner: 'WP-11', handle: async request => ({ body: await sources.readDetail(request.context, request.params.id!) }) });
    registrar.register({ method: 'POST', path: '/api/v1/source-records', owner: 'WP-11', mutation: true, idempotent: true, schema: CreateSourceRecordSchema, handle: request => ({ status: 201, body: sources.create(request.context, request.body) }) });
    registrar.register({ method: 'PUT', path: '/api/v1/source-records/{id}/marks', owner: 'WP-11', mutation: true, schema: SourceMarksSchema, handle: request => ({ body: sources.marks(request.context, request.params.id!, request.body) }) });
    registrar.register<SourceSyncRequest>({ method: 'POST', path: '/api/v1/sources/{id}/sync', owner: 'WP-11', mutation: true, idempotent: true, schema: SourceSyncSchema, handle: request => ({ status: 202, body: sources.sync(request.context, request.params.id!, request.body) }) });
    registrar.register({ method: 'POST', path: '/api/v1/topics/{id}/sources', owner: 'WP-11', mutation: true, idempotent: true, schema: LinkTopicSourceSchema, handle: request => ({ body: sources.linkTopic(request.context, request.params.id!, request.body) }) });
  }, health: () => ({ module: 'sources', status: 'ready', details: { public_streams: 4, benchmark_increment: 'owned_by_local_benchmark_accounts' } }) };
}
