import { CreateTopicSchema,EnsureTopicViewpointsSchema, objectSchema, SaveTopicOperationsSchema, EnsureTopicOperationsSchema, DecideTopicOperationsSchema } from '@workbench/contracts';
import { Topics, TopicOperationsStore } from '@workbench/domain/topics';
import { Documents } from '@workbench/domain/documents';
import type { ApplicationContext, ApplicationModule, ReaderFeedbackPort } from '@workbench/domain/ports';

export function createTopicsModule(context: ApplicationContext,options:{feedback?:ReaderFeedbackPort}={}): ApplicationModule {
  const topics = new Topics(context); const documents = new Documents(context); const operations=new TopicOperationsStore(context,options);
  return { id: 'topics', register(registrar) {
    registrar.register({method:'POST',path:'/api/v1/topics/{id}/viewpoints',owner:'VIEWPOINTS-CORE-01',mutation:true,idempotent:true,schema:EnsureTopicViewpointsSchema,handle:async request=>({body:await topics.ensureViewpoints(request.context,request.params.id!)})});
    registrar.register({method:'GET',path:'/api/v1/topics/{id}/operations',owner:'account-operations',handle:async request=>({body:await operations.get(request.context,request.params.id!)})});
    registrar.register({method:'PUT',path:'/api/v1/topics/{id}/operations',owner:'account-operations',mutation:true,idempotent:true,schema:SaveTopicOperationsSchema,handle:async request=>({body:await operations.save(request.context,request.params.id!,request.body)})});
    registrar.register({method:'POST',path:'/api/v1/topics/{id}/operations/ensure',owner:'account-operations',mutation:true,idempotent:true,schema:EnsureTopicOperationsSchema,handle:async request=>({body:await operations.ensure(request.context,request.params.id!,request.body)})});
    registrar.register({method:'POST',path:'/api/v1/topics/{id}/operations/decision',owner:'account-operations',mutation:true,idempotent:true,schema:DecideTopicOperationsSchema,handle:async request=>({body:await operations.decide(request.context,request.params.id!,request.body)})});
    registrar.register({ method: 'POST', path: '/api/v1/topics', owner: 'WP-08', mutation: true, idempotent: true, schema: CreateTopicSchema,
      handle: async request => ({ status: 201, body: await topics.create(request.context, request.body) }) });
    registrar.register({ method: 'GET', path: '/api/v1/topics', owner: 'WP-08', handle: request => ({ body: topics.list(request.context, request.query.get('cursor') ?? undefined, request.query.get('status') ?? undefined) }) });
    registrar.register({ method: 'GET', path: '/api/v1/topics/{id}', owner: 'WP-08', handle: async request => ({ body: await topics.get(request.context, request.params.id!) }) });
    registrar.register({ method: 'POST', path: '/api/v1/topics/{id}/core-approvals', owner: 'WP-08', mutation: true, idempotent: true,
      schema: objectSchema<{ revision_id: string }>(['revision_id'], { revision_id: { type: 'string' } }),
      handle: async request => ({ body: await documents.approveCore(request.context, request.params.id!, request.body.revision_id) }) });
  }, health: () => ({ module: 'topics', status: 'ready', details: { preparation_only: true, variant_plan_owner: 'WP-18' } }) };
}
