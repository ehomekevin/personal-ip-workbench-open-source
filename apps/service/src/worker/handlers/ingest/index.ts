import type { JsonObject, IndexRunRequest } from '@workbench/contracts';
import { ContractError } from '@workbench/contracts';
import type { ApplicationContext } from '@workbench/domain/ports';
import { Sources } from '@workbench/domain/sources';
import { KnowledgeIndex } from '@workbench/domain/knowledge-index';
import type { WorkerHandler } from '../../core/index.ts';

export function createIngestHandlers(context: ApplicationContext): WorkerHandler[] {
  return [
    { registration: { kind: 'source_sync', execution_mode: 'programmatic', recovery: 'read_only' }, async execute(execution) {
      const input = JSON.parse(execution.claim.job.input_manifest) as JsonObject;
      if (input.schema_version !== 'wp11-ingest/1' || typeof input.source_id !== 'string' || execution.claim.job.target_id !== input.source_id) throw new ContractError('VALIDATION_ERROR', '固定来源同步输入无效');
      await new Sources(context).ingest(input.source_id, { fence: execution.claim.fence, signal: execution.signal, checkpoint: execution.checkpoint });
      return { documents: [], recommendations: [] };
    } },
    { registration: { kind: 'source_index', execution_mode: 'programmatic', recovery: 'read_only' }, async execute(execution) {
      const input = JSON.parse(execution.claim.job.input_manifest) as JsonObject;
      if (input.schema_version !== 'wp11-ingest/1' || execution.claim.job.target_id !== context.identity.workspace_id) throw new ContractError('VALIDATION_ERROR', '固定索引输入无效');
      await new KnowledgeIndex(context).scan({ roots: input.roots as string[], mode: input.index_mode as IndexRunRequest['mode'], batch_size: Number(input.batch_size) }, { fence: execution.claim.fence, signal: execution.signal, checkpoint: execution.checkpoint });
      return { documents: [], recommendations: [] };
    } },
  ];
}
