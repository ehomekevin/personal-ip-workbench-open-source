import { createHash } from 'node:crypto';
import { ContractError, PLATFORMS, FORMATS } from '@workbench/contracts';
import type { QuerySpec, CreateComparisonRequest, ComparisonParameters, FrozenComparisonCohort, FrozenMetricDefinition, ComparisonExclusion, SelectedComparisonInput, ComparisonAggregate, ComparisonDelta, ComparisonResult, PublicationWindow, StandardComparisonQuery } from '@workbench/contracts';
import { decimal, total, median, divide, subtract, renderPrecise, renderExact, type Rational } from './decimal.ts';

export interface ComparisonWork {
  id: string; canonical_work_id: string; platform: string; platform_work_id: string | null; account_id: string | null;
  account_identity_status: string; account_role: string; format: string | null; format_source: string | null;
  identity_status: string; canonical_identity_status: string; published_at: string | null; topic_id: string | null; category: string | null; url: string;
}
export interface ComparisonSnapshot {
  id: string; work_id: string; canonical_work_id: string; source_id: string; collection_request_id: string; request_fingerprint: string;
  observed_at: string | null; observed_time_basis: string; observed_age_s: number | null; collected_at: string;
  raw_path: string; raw_sha256: string; adapter_version: string; definition_id: string; availability: string; reason: string | null; value: string | null;
  raw_integrity?: 'verified' | 'unavailable';
}
export interface ComparisonDataset { works: ComparisonWork[]; snapshots: ComparisonSnapshot[]; definition: FrozenMetricDefinition }
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson((value as Record<string, unknown>)[key])).join(',') + '}';
}
export function comparisonHash(value: unknown): string { return createHash('sha256').update(stableJson(value)).digest('hex'); }
export function parameters(query: QuerySpec): ComparisonParameters {
  const { platform, account_ids, format, metric_definition_id, timezone, topic_ids, category, work_ids, match_reason, cohort_windows, observation_window_h, tolerance_h, baseline_window_days, min_baseline_samples, aggregation, missing_policy, data_version } = query;
  return structuredClone({ platform, account_ids, format, metric_definition_id, timezone, topic_ids, category, work_ids, match_reason, cohort_windows, observation_window_h, tolerance_h, baseline_window_days, min_baseline_samples, aggregation, missing_policy, data_version });
}
export function cohortHash(query: ComparisonParameters, cohort: Omit<FrozenComparisonCohort, 'input_hash'>): string { return comparisonHash({ schema_version: 'comparison-cohort-v1', query, cohort }); }
const utcPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
export function utcTime(value: unknown): number | null { if (typeof value !== 'string' || !utcPattern.test(value)) return null; const time = Date.parse(value); if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return null; return time; }
export function validateWindow(window: unknown): asserts window is PublicationWindow { const value = window as PublicationWindow | undefined; if (!value || Object.keys(value).some(key => !['start', 'end'].includes(key)) || utcTime(value.start) === null || utcTime(value.end) === null || Date.parse(value.start) >= Date.parse(value.end)) throw new ContractError('VALIDATION_ERROR', '发布时间区间必须为有效 UTC [start,end)'); }
export function normalizeQuery(raw: CreateComparisonRequest, now = new Date().toISOString(), evaluation = false): StandardComparisonQuery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ContractError('VALIDATION_ERROR', '比较查询必须为对象');
  const allowed = ['mode','kind','platform','account_ids','format','metric_definition_id','timezone','topic_ids','category','work_ids','match_reason','cohort_windows','as_of','observation_window_h','tolerance_h','baseline_window_days','min_baseline_samples','aggregation','missing_policy','data_version'];
  if (Object.keys(raw).some(key => !allowed.includes(key)) || (raw.mode !== undefined && raw.mode !== 'standard')) throw new ContractError('VALIDATION_ERROR', '公共比较接口只接受 standard 查询');
  const query: StandardComparisonQuery = { mode: 'standard', kind: raw.kind, platform: raw.platform, account_ids: raw.account_ids, format: raw.format, metric_definition_id: raw.metric_definition_id, timezone: raw.timezone,
    topic_ids: raw.topic_ids ?? [], category: raw.category ?? null, work_ids: raw.work_ids ?? [], match_reason: raw.match_reason ?? null, cohort_windows: raw.cohort_windows,
    as_of: raw.as_of ?? now, observation_window_h: raw.observation_window_h ?? 72, tolerance_h: raw.tolerance_h ?? 6, baseline_window_days: raw.baseline_window_days ?? 28, min_baseline_samples: raw.min_baseline_samples ?? 5,
    aggregation: raw.aggregation ?? 'sum', missing_policy: raw.missing_policy ?? 'exclude', data_version: raw.data_version ?? 'comparison-v1' };
  if (!['self_period','benchmark_period','peers','work_evolution'].includes(query.kind) || !PLATFORMS.includes(query.platform) || !FORMATS.includes(query.format) || !query.metric_definition_id || typeof query.metric_definition_id !== 'string') throw new ContractError('VALIDATION_ERROR', '比较类型、平台、形式或指标定义无效');
  for (const key of ['account_ids','topic_ids','work_ids'] as const) { const values = query[key]; if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim()) || values.length > 5000) throw new ContractError('VALIDATION_ERROR', '比较身份集合无效', { field: key }); query[key] = [...new Set(values)].sort(); }
  if (!query.account_ids.length || ((query.kind === 'self_period' || query.kind === 'work_evolution') && query.account_ids.length !== 1) || (query.kind === 'work_evolution' && query.work_ids.length !== 1) || (query.kind === 'peers' && (!query.work_ids.length || typeof query.match_reason !== 'string' || !query.match_reason.trim()))) throw new ContractError('VALIDATION_ERROR', '比较缺少明确账号、作品或匹配理由');
  if (query.category !== null && (typeof query.category !== 'string' || !query.category.trim())) throw new ContractError('VALIDATION_ERROR', '类别筛选无效');
  if (query.match_reason !== null && typeof query.match_reason !== 'string') throw new ContractError('VALIDATION_ERROR', '匹配理由无效');
  try { new Intl.DateTimeFormat('en', { timeZone: query.timezone }); } catch { throw new ContractError('VALIDATION_ERROR', 'IANA 时区无效'); }
  if (typeof query.timezone !== 'string' || utcTime(query.as_of) === null || utcTime(now) === null || Date.parse(query.as_of) > Date.parse(now)) throw new ContractError('VALIDATION_ERROR', 'as_of 必须是当前时间之前的有效 UTC 时间');
  for (const key of ['observation_window_h','tolerance_h','baseline_window_days','min_baseline_samples'] as const) if (!Number.isSafeInteger(query[key]) || query[key] < (key === 'tolerance_h' ? 0 : 1) || query[key] > 10000) throw new ContractError('VALIDATION_ERROR', '观察或基线参数无效', { field: key });
  if (query.tolerance_h > query.observation_window_h || query.min_baseline_samples < 5 || !['sum','mean','median'].includes(query.aggregation) || query.missing_policy !== 'exclude' || query.data_version !== 'comparison-v1') throw new ContractError('VALIDATION_ERROR', '统计与缺失策略无效');
  if (!query.cohort_windows || Object.keys(query.cohort_windows).some(key => !['target','baseline'].includes(key))) throw new ContractError('VALIDATION_ERROR', 'cohort windows 无效');
  validateWindow(query.cohort_windows.target); if (query.cohort_windows.baseline !== null) validateWindow(query.cohort_windows.baseline);
  if (!evaluation && ['self_period','benchmark_period'].includes(query.kind) && (!query.cohort_windows.baseline || query.cohort_windows.baseline.end !== query.cohort_windows.target.start)) throw new ContractError('VALIDATION_ERROR', '周期环比必须是相邻且不重叠的发布时间区间');
  return structuredClone(query);
}
// 按 IANA 当地日历减天；保留当时时分秒，跨 DST 不是固定 24h 相减。
export function shiftCalendarDays(utc: string, timezone: string, days: number): string {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utc)).map(part => [part.type, part.value]));
  const civil = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + days, Number(parts.hour), Number(parts.minute), Number(parts.second)));
  let candidate = civil.getTime(); for (let step = 0; step < 4; step++) { const got = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(part => [part.type, part.value])); const asCivil = Date.UTC(Number(got.year), Number(got.month) - 1, Number(got.day), Number(got.hour), Number(got.minute), Number(got.second)); const adjustment = civil.getTime() - asCivil; candidate += adjustment; if (!adjustment) return new Date(candidate).toISOString(); }
  throw new ContractError('VALIDATION_ERROR', '当地发布时间边界不存在或存在歧义');
}
function inWindow(time: string, window: PublicationWindow): boolean { return Date.parse(time) >= Date.parse(window.start) && Date.parse(time) < Date.parse(window.end); }
export function aggregate(inputs: SelectedComparisonInput[], exclusions: ComparisonExclusion[], aggregation: ComparisonParameters['aggregation']): ComparisonAggregate {
  const sampleCount = new Set(inputs.map(input => input.canonical_work_id)).size, excluded = new Set(exclusions.filter(exclusion => !inputs.some(input => input.canonical_work_id === exclusion.canonical_work_id)).map(exclusion => exclusion.canonical_work_id)).size;
  if (!inputs.length) return { sample_count: 0, eligible_work_count: excluded, excluded_work_count: excluded, total: null, mean: null, median: null, value: null };
  const values = inputs.map(input => input.value), sum = total(values), average = divide(sum, { numerator: BigInt(values.length), denominator: 1n }), middle = median(values)!;
  return { sample_count: sampleCount, eligible_work_count: sampleCount + excluded, excluded_work_count: excluded, total: renderExact(sum), mean: renderExact(average), median: renderExact(middle), value: aggregation === 'sum' ? renderExact(sum) : aggregation === 'mean' ? renderExact(average) : renderExact(middle) };
}
function exactAggregate(inputs: SelectedComparisonInput[], aggregation: ComparisonParameters['aggregation']): Rational | null { if (!inputs.length) return null; const values = inputs.map(input => input.value); return aggregation === 'sum' ? total(values) : aggregation === 'mean' ? divide(total(values), { numerator: BigInt(values.length), denominator: 1n }) : median(values); }
function exactChange(target: Rational | null, baseline: Rational | null): ComparisonDelta {
  if (target === null || baseline === null) return { difference: null, percent: null, status: 'unavailable', reason: 'no_qualified_samples' };
  const difference = subtract(target, baseline);
  if (baseline.numerator === 0n) return { difference: renderExact(difference), percent: null, status: 'undefined', reason: target.numerator === 0n ? 'both_zero' : 'zero_baseline_new' };
  const rate = divide(difference, baseline); return { difference: renderExact(difference), percent: renderPrecise({ ...rate, numerator: rate.numerator * 100n }), status: 'available', reason: null };
}
export function change(target: string | null, baseline: string | null): ComparisonDelta { return exactChange(target === null ? null : decimal(target), baseline === null ? null : decimal(baseline)); }
function makeCohort(query: QuerySpec, data: ComparisonDataset, accountId: string, role: 'target' | 'baseline', window: PublicationWindow, evolution = false): FrozenComparisonCohort {
  const key = `${role}:${accountId}`, exclusions: ComparisonExclusion[] = [], selected: SelectedComparisonInput[] = [];
  function exclude(work: ComparisonWork, reason: string, snapshot: ComparisonSnapshot | null = null, detail: string | null = null) { exclusions.push({ cohort_key: key, canonical_work_id: work.canonical_work_id, source_work_id: work.id, snapshot_id: snapshot?.id ?? null, reason, availability: snapshot ? snapshot.availability as ComparisonExclusion['availability'] : null, detail }); }
  const requested = new Set(query.work_ids), explicitlyFiltered = role === 'target' && requested.size > 0;
  const groups = new Map<string, ComparisonWork[]>();
  for (const work of [...data.works].sort((a, b) => a.id.localeCompare(b.id))) {
    if (explicitlyFiltered && !requested.has(work.id) && !requested.has(work.canonical_work_id)) continue;
    if (work.account_id !== accountId) { if (explicitlyFiltered) exclude(work, 'account_mismatch'); continue; }
    if (work.published_at !== null && utcTime(work.published_at) !== null && !inWindow(work.published_at, window)) continue;
    if (work.platform !== query.platform) { exclude(work, 'platform_mismatch'); continue; }
    if (work.identity_status !== 'confirmed' && work.identity_status !== 'alias' || work.canonical_identity_status !== 'confirmed' || work.account_identity_status !== 'confirmed' || !work.platform_work_id) { exclude(work, 'identity_unconfirmed'); continue; }
    if (work.format !== query.format || !work.format_source) { exclude(work, work.format === null ? 'format_unknown' : 'format_mismatch'); continue; }
    if (utcTime(work.published_at) === null && !evolution) { exclude(work, 'publication_time_unknown'); continue; }
    if (!(role === 'baseline' && query.kind === 'peers') && (query.topic_ids.length && (work.topic_id === null || !query.topic_ids.includes(work.topic_id)) || query.category !== null && query.category !== work.category)) { exclude(work, 'topic_or_category_mismatch'); continue; }
    if (work.published_at !== null && Date.parse(work.published_at) > Date.parse(query.as_of)) { exclude(work, 'publication_after_as_of'); continue; }
    const group = groups.get(work.canonical_work_id) ?? []; group.push(work); groups.set(work.canonical_work_id, group);
  }
  for (const [canonicalId, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const canonical = group.find(work => work.id === canonicalId) ?? group[0]!;
    const eligible: { work: ComparisonWork; snapshot: ComparisonSnapshot; age: number | null }[] = [];
    for (const snapshot of data.snapshots.filter(snapshot => snapshot.canonical_work_id === canonicalId).sort((a, b) => a.id.localeCompare(b.id))) {
      const source = group.find(work => work.id === snapshot.work_id) ?? data.works.find(work => work.id === snapshot.work_id);
      if (!source || source.canonical_work_id !== canonicalId) { exclude(canonical, 'source_identity_unavailable', snapshot); continue; }
      if (evolution && ([snapshot.source_id, snapshot.collection_request_id, snapshot.raw_path, snapshot.adapter_version].some(value => typeof value !== 'string' || !value.trim()) || !/^[a-f0-9]{64}$/.test(snapshot.request_fingerprint) || !/^[a-f0-9]{64}$/.test(snapshot.raw_sha256))) { exclude(source, 'raw_provenance_missing', snapshot); continue; }
      if (evolution && snapshot.raw_integrity === 'unavailable') { exclude(source, 'raw_input_unavailable', snapshot); continue; }
      if (utcTime(snapshot.collected_at) === null || Date.parse(snapshot.collected_at) > Date.parse(query.as_of)) { exclude(source, 'collected_after_as_of', snapshot); continue; }
      if (utcTime(snapshot.observed_at) === null || snapshot.observed_time_basis === 'unknown' || !['provider','collector_verified'].includes(snapshot.observed_time_basis)) { exclude(source, 'observation_time_unknown', snapshot); continue; }
      const observed = Date.parse(snapshot.observed_at!), published = utcTime(canonical.published_at);
      if (observed > Date.parse(query.as_of) || observed > Date.parse(snapshot.collected_at) || published !== null && observed < published) { exclude(source, 'observation_time_invalid', snapshot); continue; }
      const age = published === null ? null : Math.floor((observed - published) / 1000);
      if (age !== null && (snapshot.observed_age_s === null || snapshot.observed_age_s !== age)) { exclude(source, 'observation_age_invalid', snapshot); continue; }
      if (snapshot.definition_id !== query.metric_definition_id) { exclude(source, 'metric_definition_mismatch', snapshot); continue; }
      if (snapshot.availability !== 'available' || snapshot.value === null || decimal(snapshot.value) === null) { exclude(source, snapshot.availability === 'available' ? 'metric_invalid' : 'metric_' + snapshot.availability, snapshot, snapshot.reason); continue; }
      if (!evolution && (age === null || Math.abs(age - query.observation_window_h * 3600) > query.tolerance_h * 3600)) { exclude(source, 'observation_outside_tolerance', snapshot); continue; }
      eligible.push({ work: source, snapshot, age });
    }
    eligible.sort((a, b) => evolution ? Date.parse(a.snapshot.observed_at!) - Date.parse(b.snapshot.observed_at!) || Date.parse(a.snapshot.collected_at) - Date.parse(b.snapshot.collected_at) || a.snapshot.id.localeCompare(b.snapshot.id) : Math.abs(a.age! - query.observation_window_h * 3600) - Math.abs(b.age! - query.observation_window_h * 3600) || Date.parse(b.snapshot.collected_at) - Date.parse(a.snapshot.collected_at) || a.snapshot.id.localeCompare(b.snapshot.id));
    const winners = evolution ? eligible : eligible.slice(0, 1);
    for (const { work, snapshot, age } of winners) selected.push({ canonical_work_id: canonicalId, source_work_id: work.id, account_id: accountId, platform: query.platform, format: query.format,
      platform_work_id: canonical.platform_work_id!, published_at: utcTime(canonical.published_at) === null ? null : canonical.published_at, topic_id: canonical.topic_id, category: canonical.category, url: canonical.url,
      identity_mapping: { source_work_id: work.id, canonical_work_id: canonicalId, source_identity_status: work.identity_status, canonical_identity_status: work.canonical_identity_status },
      snapshot_id: snapshot.id, source_id: snapshot.source_id, collection_request_id: snapshot.collection_request_id, request_fingerprint: snapshot.request_fingerprint, raw_path: snapshot.raw_path, raw_sha256: snapshot.raw_sha256, adapter_version: snapshot.adapter_version,
      observed_at: snapshot.observed_at!, observed_time_basis: snapshot.observed_time_basis as 'provider' | 'collector_verified', observed_age_s: age, collected_at: snapshot.collected_at, metric_definition_id: data.definition.id, definition_version: data.definition.definition_version, unit: data.definition.unit, value: snapshot.value! });
    if (!eligible.length) exclude(canonical, data.snapshots.some(snapshot => snapshot.canonical_work_id === canonicalId) ? 'no_qualified_snapshot' : 'no_snapshots');
    if (!evolution) for (const { work, snapshot } of eligible.slice(1)) exclude(work, 'non_selected_snapshot', snapshot);
    for (const work of group.filter(work => work.id !== canonical.id)) exclude(work, 'duplicate_canonical');
  }
  const cohort = { key, role, account_id: accountId, window, as_of: query.as_of, source_run_id: null, source_cohort_key: null, selected_inputs: selected, exclusions, definition: structuredClone(data.definition) };
  return { ...cohort, input_hash: cohortHash(parameters(query), cohort) };
}
export function computeResult(query: QuerySpec, cohorts: FrozenComparisonCohort[]): ComparisonResult {
  const periods: ComparisonResult['periods'] = [], peers: ComparisonResult['peers'] = [], evolution: ComparisonResult['evolution'] = [], limitations: string[] = [];
  if (query.kind === 'work_evolution') {
    const inputs = cohorts.filter(cohort => cohort.role === 'target').flatMap(cohort => cohort.selected_inputs).sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || Date.parse(a.collected_at) - Date.parse(b.collected_at) || a.snapshot_id.localeCompare(b.snapshot_id));
    for (let index = 0; index < inputs.length; index++) { const input = inputs[index]!, previous = inputs[index - 1]; const valid = previous && previous.metric_definition_id === input.metric_definition_id && Date.parse(previous.observed_at) < Date.parse(input.observed_at);
      evolution.push({ snapshot_id: input.snapshot_id, canonical_work_id: input.canonical_work_id, source_work_id: input.source_work_id, observed_at: input.observed_at, collected_at: input.collected_at, value: input.value,
        difference: valid ? renderExact(subtract(decimal(input.value)!, decimal(previous.value)!)) : null, reason: !previous ? 'first_observation' : valid ? null : 'non_increasing_observation_time' }); }
    if (evolution.length < 2) limitations.push('insufficient_evolution_observations');
  } else for (const accountId of query.account_ids) {
    const target = cohorts.find(cohort => cohort.key === `target:${accountId}`)!, baseline = cohorts.find(cohort => cohort.key === `baseline:${accountId}`);
    if (query.kind === 'peers') {
      const baselineInputs = baseline?.selected_inputs ?? [], middle = baselineInputs.length ? renderExact(median(baselineInputs.map(input => input.value))!) : null;
      const reason = baselineInputs.length < query.min_baseline_samples ? 'baseline_sample_insufficient' : middle === null || decimal(middle)!.numerator === 0n ? 'zero_baseline' : null;
      for (const input of target.selected_inputs) peers.push({ account_id: accountId, canonical_work_id: input.canonical_work_id, snapshot_id: input.snapshot_id, value: input.value, baseline_cohort_key: `baseline:${accountId}`, baseline_sample_count: baselineInputs.length, baseline_median: middle, ratio: reason ? null : renderPrecise(divide(decimal(input.value)!, decimal(middle!)!)), reason });
      if (!target.selected_inputs.length) limitations.push(`no_qualified_target:${accountId}`); if (reason) limitations.push(`${reason}:${accountId}`);
    } else {
      const current = aggregate(target.selected_inputs, target.exclusions, query.aggregation), previous = aggregate(baseline?.selected_inputs ?? [], baseline?.exclusions ?? [], query.aggregation);
      const delta = exactChange(exactAggregate(target.selected_inputs, query.aggregation), exactAggregate(baseline?.selected_inputs ?? [], query.aggregation)); periods.push({ account_id: accountId, target_cohort_key: target.key, baseline_cohort_key: `baseline:${accountId}`, target: current, baseline: previous, change: delta });
      if (delta.status === 'unavailable') limitations.push(`no_qualified_samples:${accountId}`);
    }
  }
  const inputHash = comparisonHash({ schema_version: 'comparison-run-input-v1', query_spec: query, cohorts });
  return { status: limitations.length ? 'insufficient' : 'comparable', periods, peers, evolution, limitations, input_hash: inputHash };
}
export function computeComparison(query: QuerySpec, data: ComparisonDataset): { cohorts: FrozenComparisonCohort[]; result: ComparisonResult } {
  if (data.definition.id !== query.metric_definition_id || data.definition.platform !== query.platform || data.definition.scope !== 'work') throw new ContractError('VALIDATION_ERROR', '作品比较指标定义的平台或 scope 不匹配');
  const cohorts: FrozenComparisonCohort[] = [];
  for (const accountId of query.account_ids) {
    cohorts.push(makeCohort(query, data, accountId, 'target', query.cohort_windows.target, query.kind === 'work_evolution'));
    if (query.kind !== 'work_evolution' && query.mode !== 'adoption_evaluation') {
      const baseline = query.kind === 'peers' ? { start: shiftCalendarDays(query.cohort_windows.target.start, query.timezone, -query.baseline_window_days), end: query.cohort_windows.target.start } : query.cohort_windows.baseline!;
      cohorts.push(makeCohort(query, data, accountId, 'baseline', baseline));
    }
  }
  return { cohorts, result: computeResult(query, cohorts) };
}
