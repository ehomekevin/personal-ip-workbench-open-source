import { ContractError, objectSchema, SaveRevisionSchema, type CreateDocumentRequest, type ExpectedRevision,
  type SaveRevisionRequest } from '@workbench/contracts';
import { Documents } from '@workbench/domain/documents';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';

export function createDocumentsModule(context: ApplicationContext): ApplicationModule {
  const documents = new Documents(context);
  return { id: 'documents', initialize: () => { documents.recover(); },
    register(registrar) {
      registrar.register({ method: 'POST', path: '/api/v1/documents', owner: 'WP-08', mutation: true, idempotent: true,
        schema: objectSchema<CreateDocumentRequest>(['kind', 'initial_text'], { kind: { type: 'string' }, initial_text: { type: 'string' }, owner_entity_id: { type: 'string', nullable: true } }),
        handle: async request => ({ status: 201, body: await documents.create(request.context, request.body) }) });
      registrar.register({ method: 'GET', path: '/api/v1/documents/{id}', owner: 'WP-08', handle: async request => ({ body: await documents.get(request.context, request.params.id!) }) });
      registrar.register({ method: 'POST', path: '/api/v1/documents/{id}/revisions', owner: 'WP-08', mutation: true, idempotent: true, schema: SaveRevisionSchema,
        handle: async request => ({ status: 201, body: await documents.save(request.context, request.params.id!, request.body as SaveRevisionRequest) }) });
      registrar.register({ method: 'GET', path: '/api/v1/documents/{id}/revisions', owner: 'WP-08', handle: request => ({ body: documents.history(request.context, request.params.id!, request.query.get('cursor') ?? undefined) }) });
      registrar.register({ method: 'POST', path: '/api/v1/documents/{id}/restores', owner: 'WP-08', mutation: true, idempotent: true,
        schema: objectSchema<ExpectedRevision & { revision_id: string }>(['expected_revision_id', 'revision_id'], { expected_revision_id: { type: 'string', nullable: true }, revision_id: { type: 'string' } }),
        handle: async request => ({ status: 201, body: await documents.restore(request.context, request.params.id!, request.body) }) });
      registrar.register({ method: 'POST', path: '/api/v1/documents/{id}/merges', owner: 'WP-08', mutation: true, idempotent: true,
        schema: objectSchema<ExpectedRevision & { candidate_id: string; merged_text: string }>(['expected_revision_id', 'candidate_id', 'merged_text'], { expected_revision_id: { type: 'string', nullable: true }, candidate_id: { type: 'string' }, merged_text: { type: 'string' } }),
        handle: async request => ({ status: 201, body: await documents.merge(request.context, request.params.id!, request.body) }) });
      registrar.register({ method: 'POST', path: '/api/v1/candidates/{id}/adoption', owner: 'WP-08', mutation: true, idempotent: true,
        schema: objectSchema<ExpectedRevision>(['expected_revision_id'], { expected_revision_id: { type: 'string', nullable: true } }),
        handle: async request => ({ body: await documents.adoptCandidate(request.context, request.params.id!, request.body) }) });
      registrar.register({ method: 'POST', path: '/api/v1/variants/{id}/core-alignment', owner: 'WP-08', mutation: true, idempotent: true,
        schema: objectSchema<ExpectedRevision & { confirmed_core_revision_id: string }>(['expected_revision_id', 'confirmed_core_revision_id'], { expected_revision_id: { type: 'string', nullable: true }, confirmed_core_revision_id: { type: 'string' } }),
        handle: async request => ({ status: 201, body: await documents.alignCore(request.context, request.params.id!, request.body) }) });
    },
    health() { const rows = context.db.prepare("SELECT COUNT(*) AS count FROM write_intents WHERE workspace_id=? AND commit_purpose='human_revision' AND state='pending'").get(context.identity.workspace_id);
      return { module: 'documents', status: Number(rows?.count ?? 0) > 0 ? 'degraded' : 'ready', details: { pending_human_intents: Number(rows?.count ?? 0), agent_finalizer: 'WP-09' } }; },
  };
}
