import { Metrics } from '@workbench/domain/metrics';
import type { WorkerHandler } from '../../core/index.ts';

export function metricsHandler(metrics: Metrics): WorkerHandler {
  return { registration: { kind: 'metrics_collect', execution_mode: 'programmatic', recovery: 'read_only', claimable: (job, checkpoint) => metrics.automaticReadiness(job, checkpoint).ready }, execute: execution => metrics.executeCollection(execution) };
}
