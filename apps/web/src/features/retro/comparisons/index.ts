import type { ComparisonRun, ComparisonKind, Page, CreateComparisonRequest, SelectedComparisonInput, FrozenComparisonCohort } from '@workbench/contracts';
import type { RetroProjection, RetroWorkProjection, ViewContext } from '../../../app/view-model.ts';
import type { PageFeaturePort, FeatureContext, FeatureAction } from '../../../transport/feature-ports.ts';

export interface ComparisonProjection extends RetroProjection {
  peerEvidence?: { account_id: string; canonical_work_id: string; snapshot_id: string; url: string | null; value: string; ratio: string | null; baseline_median: string | null; baseline_sample_count: number; reason: string | null; match_reason: string | null }[];
}
export interface ComparisonFeatureOptions {
  loadBase(context: FeatureContext): Promise<ViewContext>;
  resolveQuery?(context: FeatureContext): Promise<CreateComparisonRequest | null>;
  selectAccount?(context: FeatureContext, run: ComparisonRun, base: ViewContext): { accountId?: string; ownerAccountId?: string };
}
function displayNumber(value: string | null | undefined): number | null { if (value == null) return null; const number = Number(value); return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER && (number !== 0 || /^-?0(?:\.0+)?$/.test(value)) ? number : null; }
function dateOrdinal(at: string, timezone: string): number { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at)).map(part => [part.type, part.value])); return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000; }
function publicationSeries(cohort: FrozenComparisonCohort | undefined, timezone: string, period: number, aggregation: ComparisonRun['query_spec']['aggregation']): (number | null)[] {
  if (!cohort) return Array.from({ length: 7 }, () => null);
  const first = dateOrdinal(cohort.window.start, timezone), end = dateOrdinal(cohort.window.end, timezone), days = end - first;
  if (days !== period) return Array.from({ length: 7 }, () => null);
  const bins: SelectedComparisonInput[][] = Array.from({ length: 7 }, () => []);
  for (const input of cohort.selected_inputs) { if (input.published_at === null) continue; const index = Math.floor((dateOrdinal(input.published_at, timezone) - first) / (period / 7)); if (index >= 0 && index < bins.length) bins[index]!.push(input); }
  return bins.map(bin => {
    if (!bin.length || bin.some(input => displayNumber(input.value) === null)) return null;
    // 先聚合十进制整数，再转成图表数值，避免小数加法或抵消改变零值判断。
    const scale = Math.max(...bin.map(input => input.value.split('.')[1]?.length ?? 0)), values = bin.map(input => BigInt(input.value.replace('.', '') + '0'.repeat(scale - (input.value.split('.')[1]?.length ?? 0))));
    let numerator = values.reduce((sum, value) => sum + value, 0n), divisor = aggregation === 'mean' ? values.length : 1;
    if (aggregation === 'median') { values.sort((a, b) => a < b ? -1 : a > b ? 1 : 0); const middle = Math.floor(values.length / 2); numerator = values.length % 2 ? values[middle]! : values[middle - 1]! + values[middle]!; divisor = values.length % 2 ? 1 : 2; }
    const value = Number(numerator.toString() + 'e-' + scale) / divisor;
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER && (value !== 0 || numerator === 0n) ? value : null;
  });
}
export function projectComparisonRun(run: ComparisonRun | null, period = 7, selection: { accountId?: string; ownerAccountId?: string } = {}): ComparisonProjection {
  const empty: ComparisonProjection = { current: Array.from({ length: 7 }, () => null), previous: Array.from({ length: 7 }, () => null), total: null, deltaPercent: null, currentWorks: null, previousWorks: null, snapshots: { at24h: null, at72h: null }, peer: { ownRatio: null, benchmarkRatio: null }, works: [], comparisonEvidence: null };
  if (!run) return empty;
  const accountId = selection.accountId ?? run.query_spec.account_ids[0] ?? null, current = run.selected_inputs_by_cohort.find(cohort => cohort.role === 'target' && cohort.account_id === accountId), baseline = run.selected_inputs_by_cohort.find(cohort => cohort.role === 'baseline' && cohort.account_id === accountId), periodResult = run.result.periods.find(result => result.account_id === accountId);
  const selected = run.query_spec.kind === 'peers' ? run.selected_inputs_by_cohort.filter(cohort => cohort.role === 'target').flatMap(cohort => cohort.selected_inputs).sort((a, b) => Number(b.account_id === selection.ownerAccountId) - Number(a.account_id === selection.ownerAccountId) || a.account_id.localeCompare(b.account_id) || a.canonical_work_id.localeCompare(b.canonical_work_id)) : current?.selected_inputs ?? [], selectedIds = new Set(selected.map(input => input.canonical_work_id));
  const ageHours = (input: SelectedComparisonInput | undefined): number | null => input?.observed_age_s == null ? null : input.observed_age_s / 3600;
  const works: RetroWorkProjection[] = selected.map(input => ({ id: input.canonical_work_id, title: input.url, metric: displayNumber(input.value), interactionRate: null, observedAgeH: ageHours(input), observedAt: input.observed_at, publishedAt: input.published_at }));
  for (const exclusion of current?.exclusions ?? []) if (!selectedIds.has(exclusion.canonical_work_id)) { selectedIds.add(exclusion.canonical_work_id); works.push({ id: exclusion.canonical_work_id, title: `作品 ${exclusion.canonical_work_id}`, metric: null, interactionRate: null, observedAgeH: null, observedAt: null, publishedAt: null }); }
  const ownPeer = selection.ownerAccountId ? run.result.peers.find(peer => peer.account_id === selection.ownerAccountId) : undefined, benchmarkPeer = selection.ownerAccountId ? run.result.peers.find(peer => peer.account_id !== selection.ownerAccountId) : undefined;
  const peerWork = (peer: typeof ownPeer): RetroWorkProjection | null => peer ? works.find(work => work.id === peer.canonical_work_id) ?? null : null;
  const atAge = (hours: number) => { const candidates = selected.filter(input => input.observed_age_s === hours * 3600).sort((a, b) => a.collected_at.localeCompare(b.collected_at) || a.snapshot_id.localeCompare(b.snapshot_id)); return displayNumber(candidates.at(-1)?.value); };
  return { ...empty, current: publicationSeries(current, run.query_spec.timezone, period, run.query_spec.aggregation), previous: publicationSeries(baseline, run.query_spec.timezone, period, run.query_spec.aggregation),
    total: displayNumber(periodResult?.target.value), deltaPercent: displayNumber(periodResult?.change.percent), currentWorks: periodResult?.target.sample_count ?? (current ? new Set(selected.map(input => input.canonical_work_id)).size : null), previousWorks: periodResult?.baseline.sample_count ?? null,
    snapshots: run.query_spec.kind === 'work_evolution' ? { at24h: atAge(24), at72h: atAge(72), points: run.result.evolution.slice(0, 3).map(point => ({ ageH: ageHours(selected.find(input => input.snapshot_id === point.snapshot_id)), value: displayNumber(point.value), observedAt: point.observed_at, reason: point.reason })) } : empty.snapshots,
    peerEvidence: run.result.peers.map(peer => ({ ...peer, url: run.selected_inputs_by_cohort.flatMap(cohort => cohort.selected_inputs).find(input => input.snapshot_id === peer.snapshot_id)?.url ?? null, match_reason: run.query_spec.match_reason })),
    peer: { ownRatio: displayNumber(ownPeer?.ratio), benchmarkRatio: displayNumber(benchmarkPeer?.ratio), ownWork: peerWork(ownPeer), benchmarkWork: peerWork(benchmarkPeer), ownAccountId: ownPeer?.account_id ?? null, benchmarkAccountId: benchmarkPeer?.account_id ?? null, matchReason: run.query_spec.match_reason }, works,
    comparisonEvidence: { run_id: run.id, input_hash: run.result.input_hash, metric_definition_id: run.query_spec.metric_definition_id, metric_key: run.definition_versions[0]?.key ?? 'unknown', aggregation: run.query_spec.aggregation, definition_version: run.definition_versions[0]?.definition_version ?? 'unknown', unit: run.definition_versions[0]?.unit ?? 'unknown', timezone: run.query_spec.timezone, format: run.query_spec.format, observation_window_h: run.query_spec.observation_window_h, tolerance_h: run.query_spec.tolerance_h, as_of: run.query_spec.as_of, target_window: structuredClone(run.query_spec.cohort_windows.target), baseline_window: structuredClone(run.query_spec.cohort_windows.baseline), account_id: accountId, status: run.result.status, exclusions: run.excluded_reasons } };
}
const kinds: Record<string, ComparisonKind> = { mine: 'self_period', benchmark: 'benchmark_period', peer: 'peers', single: 'work_evolution' };
export function createComparisonsFeaturePort(options: ComparisonFeatureOptions): PageFeaturePort<'retro'> {
  let latest: ViewContext | undefined, generation = 0;
  async function load(context: FeatureContext): Promise<ViewContext> {
    const ownGeneration = ++generation, base = await options.loadBase(context); if (base.provenance !== 'service') throw new Error('比较正式投影只接受 service 数据');
    try {
      const runs: ComparisonRun[] = []; let cursor: string | null = null;
      do { const page: Page<ComparisonRun> = await context.client.request('GET', '/api/v1/comparisons?platform=' + encodeURIComponent(context.ui.retroPlatform) + '&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), undefined, { signal: context.signal }); runs.push(...page.items); cursor = page.next_cursor; } while (cursor);
      const candidates = runs.filter(run => run.query_spec.mode === 'standard' && run.query_spec.kind === kinds[context.ui.retroTab] && (run.query_spec.kind === 'work_evolution' || dateOrdinal(run.query_spec.cohort_windows.target.end, run.query_spec.timezone) - dateOrdinal(run.query_spec.cohort_windows.target.start, run.query_spec.timezone) === context.ui.period));
      const run = candidates.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).at(-1) ?? null;
      if (ownGeneration !== generation || context.signal.aborted) throw new DOMException('比较读取已被更新', 'AbortError');
      const accounts = base.state.accounts.map(account => { const period = run?.result.periods.find(result => result.account_id === account.id); return { ...account, count: period?.target.sample_count ?? null, previous: period?.baseline.sample_count ?? null }; });
      const view = { ...base, state: { ...base.state, accounts }, ui: { ...context.ui }, projections: { ...base.projections, retro: projectComparisonRun(run, context.ui.period, run ? options.selectAccount?.(context, run, base) : undefined) } }; if (ownGeneration === generation && !context.signal.aborted) latest = view; return view;
    } catch (error) { if (ownGeneration !== generation || context.signal.aborted) throw error; context.surface.toast(error instanceof Error ? error.message : '比较读取失败'); if (latest && latest.ui.retroPlatform === context.ui.retroPlatform && latest.ui.retroTab === context.ui.retroTab && latest.ui.period === context.ui.period) return latest; throw error; }
  }
  async function dispatch(action: FeatureAction, context: FeatureContext): Promise<ViewContext | void> {
    if (action.action === 'retro-period') {
      const period = Number(action.fields['retro-period']); if (!Number.isInteger(period)||period<1||period>90) return;
      const updated = { ...context, ui: { ...context.ui, period } };
      const query = await options.resolveQuery?.(updated);
      if (query) await context.client.request<ComparisonRun>('POST', '/api/v1/comparisons', query, { signal: context.signal, idempotencyKey: crypto.randomUUID() });
      return load(updated);
    }
    if (action.action === 'retro-platform' || action.action === 'retro-tab' || action.action === 'benchmark-retro') {
      const patch = action.action === 'retro-platform' ? { retroPlatform: action.dataset.value ?? context.ui.retroPlatform } : { retroTab: action.action === 'benchmark-retro' ? 'benchmark' : action.dataset.value ?? context.ui.retroTab };
      return load({ ...context, ui: { ...context.ui, ...patch } });
    }
  }
  return { page: 'retro', load, dispatch };
}
