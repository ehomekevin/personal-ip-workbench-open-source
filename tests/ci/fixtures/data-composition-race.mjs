import assert from 'node:assert/strict';
import { createDataFeaturePorts } from '../../../apps/web/src/transport/data-features.ts';
import { initialUi } from '../../../apps/web/src/app/view-model.ts';

// 回归输入来自 Astra 的 R17 实际 public dispatch 复现；纯内存，无网络或数据库写入。
const page = items => ({ items, next_cursor: null, has_more: false, last_success_at: null });
const accounts = [
  { id: 'owner-A', role: 'owner', platform: 'douyin', identity_status: 'confirmed' },
  { id: 'owner-B', role: 'owner', platform: 'xiaohongshu', identity_status: 'confirmed' },
];
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function makeRun(platform) {
  const accountId = accounts.find(account => account.platform === platform).id;
  const targetWindow = { start: '2026-10-03T00:00:00Z', end: '2026-10-10T00:00:00Z' };
  const baselineWindow = { start: '2026-09-26T00:00:00Z', end: '2026-10-03T00:00:00Z' };
  const input = (key, published) => ({ canonical_work_id: key, source_work_id: key, account_id: accountId,
    platform, format: 'video', platform_work_id: key, published_at: published, topic_id: null,
    category: null, url: 'https://fixture.invalid/' + key, snapshot_id: 'snapshot-' + key,
    observed_at: new Date(Date.parse(published) + 72 * 3600_000).toISOString(), observed_age_s: 259200,
    collected_at: new Date(Date.parse(published) + 72 * 3600_000).toISOString(), value: '100' });
  const target = input('target-' + platform, '2026-10-04T00:00:00Z');
  const baseline = input('baseline-' + platform, '2026-09-27T00:00:00Z');
  const aggregate = { value: '100', total: '100', mean: '100', median: '100', sample_count: 1, eligible_work_count: 1, excluded_work_count: 0 };
  return { id: 'run-' + platform, created_at: '2026-10-10T00:00:00Z',
    query_spec: { mode: 'standard', kind: 'self_period', platform, account_ids: [accountId], timezone: 'UTC',
      format: 'video', metric_definition_id: 'def', observation_window_h: 72, tolerance_h: 6,
      as_of: '2026-10-10T00:00:00Z', aggregation: 'sum', cohort_windows: { target: targetWindow, baseline: baselineWindow } },
    selected_inputs_by_cohort: [
      { role: 'target', account_id: accountId, selected_inputs: [target], exclusions: [], window: targetWindow },
      { role: 'baseline', account_id: accountId, selected_inputs: [baseline], exclusions: [], window: baselineWindow },
    ], result: { periods: [{ account_id: accountId, target: aggregate, baseline: aggregate, change: { percent: '0' } }],
      peers: [], evolution: [], status: 'comparable', input_hash: 'fixture-input-hash' },
    definition_versions: [{ key: 'views', definition_version: 'v1', unit: 'count' }], excluded_reasons: [] };
}
const settings = async () => ({ default_executor: 'codex', api_fallback_enabled: false });
const context = client => ({ client, ui: { ...initialUi('retro'), retroPlatform: 'xiaohongshu' },
  signal: new AbortController().signal, surface: { toast() {}, updateUi() {} } });
const action = platform => ({ action: 'retro-platform', dataset: { value: platform }, fields: {} });

async function ownerRace() {
  const oldAccounts = deferred(), oldAccountsStarted = deferred(), finalComparison = deferred(), finalStarted = deferred();
  let accountsCalls = 0, bComparisons = 0;
  const client = { getSettings: settings, async request(_method, path) {
    if (path === '/api/v1/accounts') { if (++accountsCalls === 1) { oldAccountsStarted.resolve(); return oldAccounts.promise; } return page(accounts); }
    if (path.startsWith('/api/v1/comparisons?platform=xiaohongshu')) {
      if (++bComparisons === 2) { finalStarted.resolve(); return finalComparison.promise; }
      return page([makeRun('xiaohongshu')]);
    }
    return page([]);
  } };
  const port = createDataFeaturePorts().retro, ctx = context(client);
  const older = port.dispatch(action('douyin'), ctx).then(() => 'returned', error => error.name);
  await oldAccountsStarted.promise;
  const newer = port.dispatch(action('xiaohongshu'), ctx);
  await finalStarted.promise;
  oldAccounts.resolve(page(accounts));
  const oldStatus = await older;
  finalComparison.resolve(page([makeRun('xiaohongshu')]));
  const result = await newer;
  const observed = { case: 'late base must not overwrite new owner', oldStatus, accountsCalls, bComparisons,
    platform: result.ui.retroPlatform, selected_account: result.projections.retro.comparisonEvidence.account_id,
    total: result.projections.retro.total };
  console.log(JSON.stringify(observed));
  assert.equal(observed.platform, 'xiaohongshu');
  assert.equal(observed.selected_account, 'owner-B');
  assert.equal(observed.total, 100);
}

async function outerRace() {
  const oldBusiness = deferred(), oldStarted = deferred();
  let businessCalls = 0;
  const rendered = [];
  const client = { getSettings: settings, async request(_method, path) {
    if (path === '/api/v1/accounts') return page(accounts);
    if (path.startsWith('/api/v1/comparisons?')) return page([makeRun(new URL('http://fixture.invalid' + path).searchParams.get('platform'))]);
    if (path.startsWith('/api/v1/business-events') && ++businessCalls === 1) { oldStarted.resolve(); return oldBusiness.promise; }
    return page([]);
  } };
  const port = createDataFeaturePorts().retro, ctx = context(client);
  const older = port.dispatch(action('douyin'), ctx).then(view => { if (view) rendered.push(view.ui.retroPlatform); }, error => {
    if (error.name !== 'AbortError') throw error;
  });
  await oldStarted.promise;
  const current = await port.dispatch(action('xiaohongshu'), ctx);
  if (current) rendered.push(current.ui.retroPlatform);
  oldBusiness.resolve(page([]));
  await older;
  console.log(JSON.stringify({ case: 'late outer response must not reload old platform', rendered }));
  assert.deepEqual(rendered, ['xiaohongshu']);
}

let failures = 0;
for (const [name, run] of [['owner selection', ownerRace], ['outer generation', outerRace]]) {
  try { await run(); console.log(name + ': passed'); }
  catch (error) { failures++; console.log(name + ': failed: ' + error.message); }
}
console.log(JSON.stringify({ total: 2, passed: 2 - failures, failed: failures, grade: 'internal_rule' }));
process.exitCode = failures ? 1 : 0;
