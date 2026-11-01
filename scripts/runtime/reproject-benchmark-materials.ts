import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError } from '../../packages/contracts/src/index.ts';
import { inspectBenchmarkMaterialCopy, projectionCopyOptions } from '../../packages/domain/src/sources/material-reprojection.ts';

export { inspectBenchmarkMaterialCopy, projectSavedBenchmarkMaterials, projectionCopyOptions } from '../../packages/domain/src/sources/material-reprojection.ts';
export type { ProjectionCopyOptions, SavedBenchmarkProjectionInput } from '../../packages/domain/src/sources/material-reprojection.ts';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = inspectBenchmarkMaterialCopy(projectionCopyOptions(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2)); if (!result.complete) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ mode: 'proposal_only', complete: false, remote_calls: 0, writes: 0, code: error instanceof ContractError ? error.code : 'STORAGE_UNAVAILABLE', message: error instanceof Error ? error.message : '副本不可读' })); process.exitCode = 1;
  }
}
