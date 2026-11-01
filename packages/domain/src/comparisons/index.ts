import { randomUUID } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ContractError, PLATFORMS, COMPARISON_JSON_SCHEMA, type CreateComparisonRequest, type QuerySpec, type ComparisonRun, type ComparisonListQuery, type FrozenComparisonBaseline, type EvaluationComparisonInput, type ComparisonPort, type RequestContext, type RuntimeSchema, type FrozenComparisonCohort } from '@workbench/contracts';
import { transaction, sha256 } from '@workbench/storage/connection';
import { readIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import { readComparisonData, insertComparison, getComparison, listComparisons } from '@workbench/storage/comparisons';
import type { ApplicationContext } from '../ports/index.ts';
import { assertRequestIdentity } from '../documents/index.ts';
import { computeComparison, computeResult, parameters, cohortHash, comparisonHash, normalizeQuery, utcTime, type ComparisonDataset } from './rules.ts';
export * from './rules.ts';

export function parseComparisonRequest(value: unknown, now?: string): CreateComparisonRequest { return normalizeQuery(value as CreateComparisonRequest, now); }
export const CreateComparisonsSchema: RuntimeSchema<CreateComparisonRequest> = {
  jsonSchema: COMPARISON_JSON_SCHEMA,
  // 保留缺省 as_of；领域事务先重放幂等结果，再由服务冻结当前时间。
  parse(value) { normalizeQuery(value as CreateComparisonRequest); return structuredClone(value as CreateComparisonRequest); },
};
function runFrom(query: QuerySpec, dataset: ComparisonDataset, workspaceId: string, at: string, override?: FrozenComparisonCohort[]): ComparisonRun {
  const calculated = override ? { cohorts: override, result: computeResult(query, override) } : computeComparison(query, dataset);
  const exclusions = calculated.cohorts.flatMap(cohort => cohort.exclusions), selectedWorks = new Set(calculated.cohorts.flatMap(cohort => cohort.selected_inputs.map(input => input.canonical_work_id)));
  return { id: randomUUID(), workspace_id: workspaceId, created_at: at, query_spec: query, selected_snapshot_ids: [...new Set(calculated.cohorts.flatMap(cohort => cohort.selected_inputs.map(input => input.snapshot_id)))].sort(), selected_inputs_by_cohort: calculated.cohorts, excluded_work_ids: [...new Set(exclusions.filter(exclusion => !selectedWorks.has(exclusion.canonical_work_id)).map(exclusion => exclusion.canonical_work_id))].sort(), excluded_reasons: exclusions, definition_versions: [structuredClone(dataset.definition)], result: calculated.result };
}
function verifyRun(run: ComparisonRun): void {
  for (const cohort of run.selected_inputs_by_cohort) { const { input_hash, ...payload } = cohort; if (cohort.source_run_id !== null) continue; if (cohortHash(parameters(run.query_spec), payload) !== input_hash) throw new ContractError('EVALUATION_INPUT_MISMATCH', '冻结 cohort hash 不匹配'); }
  if (computeResult(run.query_spec, run.selected_inputs_by_cohort).input_hash !== run.result.input_hash) throw new ContractError('EVALUATION_INPUT_MISMATCH', '冻结运行输入 hash 不匹配');
}
export class Comparisons implements ComparisonPort {
  readonly context: ApplicationContext; readonly clock: () => number;
  constructor(context: ApplicationContext, options: { clock?: () => number } = {}) { this.context = context; this.clock = options.clock ?? Date.now; }
  private data(request: RequestContext, query: QuerySpec): ComparisonDataset {
    const data = readComparisonData(this.context.db, request.workspace_id, query.metric_definition_id) as unknown as ComparisonDataset;
    for (const id of query.account_ids) { const account = this.context.db.prepare('SELECT * FROM accounts WHERE workspace_id=? AND id=?').get(request.workspace_id, id); if (!account || account.platform !== query.platform || account.identity_status !== 'confirmed' || account.platform_account_id === null) throw new ContractError('VALIDATION_ERROR', '比较账号尚未确认或平台不同'); if (query.kind === 'self_period' && account.role !== 'owner' || query.kind === 'benchmark_period' && account.role !== 'benchmark') throw new ContractError('VALIDATION_ERROR', '比较账号角色不匹配'); }
    if (query.kind === 'work_evolution') {
      const requested = new Set(query.work_ids), canonicalIds = new Set(data.works.filter(work => requested.has(work.id) || requested.has(work.canonical_work_id)).map(work => work.canonical_work_id));
      for (const snapshot of data.snapshots.filter(snapshot => canonicalIds.has(snapshot.canonical_work_id))) {
        try { const path = isAbsolute(snapshot.raw_path) ? snapshot.raw_path : resolve(this.context.paths.state_root, snapshot.raw_path); snapshot.raw_integrity = path.startsWith(resolve(this.context.paths.state_root, 'raw-responses') + '/') && !lstatSync(path).isSymbolicLink() && realpathSync(path) === path && sha256(readFileSync(path)) === snapshot.raw_sha256 ? 'verified' : 'unavailable'; } catch { snapshot.raw_integrity = 'unavailable'; }
      }
    }
    return data;
  }
  create(request: RequestContext, input: CreateComparisonRequest): ComparisonRun {
    assertRequestIdentity(this.context, request);
    return transaction(this.context.db, () => {
      const replay = readIdempotent<ComparisonRun>(this.context.db, request, 'comparisons.create', input); if (replay) return replay;
      const at = new Date(this.clock()).toISOString(), query = normalizeQuery(input, at), data = this.data(request, query), run = runFrom(query, data, request.workspace_id, at);
      insertComparison(this.context.db, run); storeIdempotent(this.context.db, request, 'comparisons.create', input, run); return run;
    });
  }
  get(request: RequestContext, id: string): ComparisonRun { assertRequestIdentity(this.context, request); const run = getComparison(this.context.db, request.workspace_id, id); verifyRun(run); return run; }
  list(request: RequestContext, query: ComparisonListQuery = {}) { assertRequestIdentity(this.context, request); if (query.platform !== undefined && !PLATFORMS.includes(query.platform) || query.created_start !== undefined && utcTime(query.created_start) === null || query.created_end !== undefined && utcTime(query.created_end) === null || query.created_start && query.created_end && Date.parse(query.created_start) >= Date.parse(query.created_end)) throw new ContractError('VALIDATION_ERROR', '比较列表筛选无效'); return listComparisons(this.context.db, request.workspace_id, { ...query, ...(query.created_start ? { created_start: new Date(query.created_start).toISOString() } : {}), ...(query.created_end ? { created_end: new Date(query.created_end).toISOString() } : {}) }); }
  freezeCohort(request: RequestContext, runId: string, key: string): FrozenComparisonBaseline {
    const run = this.get(request, runId), cohort = run.selected_inputs_by_cohort.find(cohort => cohort.key === key);
    if (!cohort || run.query_spec.mode !== 'standard' || run.query_spec.kind === 'work_evolution') throw new ContractError('EVALUATION_INPUT_MISMATCH', '冻结基线必须来自已有 standard cohort');
    return structuredClone({ schema_version: 'comparison-baseline-v1', source_run_id: runId, source_cohort_key: key, parameters: parameters(run.query_spec), cohort, input_hash: cohort.input_hash });
  }
  createEvaluation(request: RequestContext, input: EvaluationComparisonInput): ComparisonRun {
    assertRequestIdentity(this.context, request);
    return transaction(this.context.db, () => {
      const replay = readIdempotent<ComparisonRun>(this.context.db, request, 'comparisons.evaluation', input); if (replay) return replay;
      const at = new Date(this.clock()).toISOString();
      if (!input.adoption_id || !/^[a-f0-9]{64}$/.test(input.plan_hash) || !Array.isArray(input.target_work_ids) || !input.target_work_ids.length) throw new ContractError('EVALUATION_INPUT_MISMATCH', '评价缺少冻结计划或目标作品');
      const target = normalizeQuery({ ...input.parameters, kind: 'self_period', as_of: input.target_as_of, work_ids: input.target_work_ids }, at, true);
      const query: QuerySpec = { ...target, kind: 'self_period', mode: 'adoption_evaluation', target_as_of: input.target_as_of, adoption_id: input.adoption_id, plan_hash: input.plan_hash, baseline_run_id: input.baseline?.source_run_id ?? null, baseline_cohort_key: input.baseline?.source_cohort_key ?? null, baseline_input_hash: input.baseline?.input_hash ?? null };
      const data = this.data(request, query), calculated = computeComparison(query, data), cohorts = calculated.cohorts.filter(cohort => cohort.role === 'target');
      let unavailable = false;
      if (input.baseline) {
        const baseline = input.baseline, source = getComparison(this.context.db, request.workspace_id, baseline.source_run_id); verifyRun(source);
        const original = source.selected_inputs_by_cohort.find(cohort => cohort.key === baseline.source_cohort_key);
        if (!original || source.query_spec.mode !== 'standard' || baseline.schema_version !== 'comparison-baseline-v1' || baseline.input_hash !== original.input_hash || comparisonHash(original) !== comparisonHash(baseline.cohort) || comparisonHash(parameters(source.query_spec)) !== comparisonHash(baseline.parameters)) throw new ContractError('EVALUATION_INPUT_MISMATCH', '冻结基线不是来源运行的精确输入');
        for (const key of ['platform','account_ids','format','metric_definition_id','timezone','observation_window_h','tolerance_h','aggregation','missing_policy','data_version'] as const) if (comparisonHash(baseline.parameters[key]) !== comparisonHash(input.parameters[key])) throw new ContractError('EVALUATION_INPUT_MISMATCH', '评价参数不匹配冻结基线', { field: key });
        if (query.account_ids.length !== 1 || original.account_id !== query.account_ids[0]) throw new ContractError('EVALUATION_INPUT_MISMATCH', '评价必须消费同账号基线 cohort');
        if (comparisonHash(data.definition) !== comparisonHash(original.definition)) throw new ContractError('EVALUATION_INPUT_MISMATCH', '评价指标定义版本或单位不同于冻结基线');
        const copied = structuredClone(original); copied.role = 'baseline'; copied.key = `baseline:${original.account_id}`; copied.source_run_id = baseline.source_run_id; copied.source_cohort_key = baseline.source_cohort_key;
        // 保存原 input_hash；来源、角色标签另记，不改变 frozen selected_inputs 或原统计口径。
        cohorts.push(copied);
        for (const selected of original.selected_inputs) {
          const row = this.context.db.prepare('SELECT id,raw_sha256,work_id FROM snapshots WHERE workspace_id=? AND id=?').get(request.workspace_id, selected.snapshot_id);
          try { const path = isAbsolute(selected.raw_path) ? selected.raw_path : resolve(this.context.paths.state_root, selected.raw_path); if (!path.startsWith(resolve(this.context.paths.state_root, 'raw-responses') + '/') || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path || !row || row.raw_sha256 !== selected.raw_sha256 || row.work_id !== selected.source_work_id || sha256(readFileSync(path)) !== selected.raw_sha256) unavailable = true; } catch { unavailable = true; }
        }
      }
      const run = runFrom(query, data, request.workspace_id, at, cohorts);
      if (!input.baseline || unavailable) { run.result.status = 'insufficient'; run.result.limitations.push(!input.baseline ? 'frozen_baseline_missing' : 'frozen_baseline_input_unavailable'); }
      insertComparison(this.context.db, run); storeIdempotent(this.context.db, request, 'comparisons.evaluation', input, run); return run;
    });
  }
}
