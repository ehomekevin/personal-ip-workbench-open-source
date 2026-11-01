import { createReadStream, unlinkSync } from 'node:fs';
import { ContractError, objectSchema } from '@workbench/contracts';
import { Assets, stageMultipart } from '@workbench/storage/assets';
import { workspaceSettings } from '@workbench/storage/settings';
import { MediaImporter } from '@workbench/domain/artifact-execution';
import { assertRequestIdentity } from '@workbench/domain/documents';
import type { ApplicationContext, ApplicationModule } from '@workbench/domain/ports';

export function createAssetsModule(context: ApplicationContext): ApplicationModule {
  const assets = () => { const paths = workspaceSettings(context.db, context.identity.workspace_id).paths; return new Assets(context.db, paths.media_root, paths.state_root); };
  return { id: 'assets', register(registrar) {
    registrar.register({ method: 'POST', path: '/api/v1/assets', owner: 'WP-08', mutation: true, idempotent: true, bodyFormat: 'stream',
      handle: async request => {
        assertRequestIdentity(context, request.context); if (!request.stream) throw new ContractError('VALIDATION_ERROR', '文件流缺失');
        const multipart = await stageMultipart(request.stream, request.headers['content-type'] ?? '', context.paths.state_root);
        try { return { status: 201, body: await new MediaImporter(context).importFile(request.context, createReadStream(multipart.path), {
          kind: multipart.mime.startsWith('image/') ? 'image' : multipart.mime.startsWith('video/') ? 'video' : multipart.mime.startsWith('audio/') ? 'audio' : 'file',
          mime: multipart.mime, topic_id: multipart.fields.topic_id ?? null, purpose: multipart.fields.purpose ?? '',
        }) }; } finally { unlinkSync(multipart.path); }
      } });
    registrar.register({ method: 'POST', path: '/api/v1/assets/references', owner: 'WP-08', mutation: true, idempotent: true,
      schema: objectSchema<{ path: string; topic_id: string; purpose: string }>(['path', 'topic_id', 'purpose'], { path: { type: 'string' }, topic_id: { type: 'string' }, purpose: { type: 'string' } }),
      handle: async request => { assertRequestIdentity(context, request.context); return { status: 201, body: await assets().reference(request.context, request.body) }; } });
    registrar.register({ method: 'GET', path: '/api/v1/assets', owner: 'WP-08', handle: request => { assertRequestIdentity(context, request.context); return { body: assets().list(request.context.workspace_id, request.query.get('topic_id') ?? undefined) }; } });
    registrar.register({ method: 'GET', path: '/api/v1/assets/{id}/content', owner: 'WP-08', handle: async request => {
      assertRequestIdentity(context, request.context); const content = await assets().content(request.context.workspace_id, request.params.id!);
      return { body: null, stream: content.stream, headers: { 'content-type': content.mime, 'content-disposition': 'inline' } };
    } });
  }, health: () => ({ module: 'assets', status: 'ready', details: { file_storage: 'local', renderer: 'WP-19' } }) };
}
