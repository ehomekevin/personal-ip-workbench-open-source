import type { ApplicationContext } from '@workbench/domain/ports';
import { validateContentOutput } from '@workbench/domain/content-agents';
import { validateRecommendationOutput } from '@workbench/domain/recommendations';
import { createServiceAgentHandlers, type ServiceAgentHandlersOptions } from '../agent/index.ts';
import type { WorkerHandler } from '../../core/index.ts';
export function createContentAgentHandlers(context: ApplicationContext, options: ServiceAgentHandlersOptions): WorkerHandler[] {
  return createServiceAgentHandlers(context, options).map(handler => ({ registration: handler.registration, async execute(execution) {
    const output = await handler.execute(execution), manifest = JSON.parse(execution.claim.job.input_manifest);
    return validateRecommendationOutput(manifest, validateContentOutput(manifest, output));
  } }));
}
