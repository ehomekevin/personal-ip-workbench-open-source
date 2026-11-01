import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_VERSION, type MetricDefinitionsRow } from '../../packages/contracts/src/index.ts';
import { withWorksFeaturePort, loadWorks } from '../../apps/web/src/features/works/index.ts';
import { observedTimeline, snapshotPoints } from '../../apps/web/src/features/retro/snapshots/index.ts';
import type { SnapshotView, WorkView } from '../../apps/web/src/features/works/types.ts';
import type { FeatureContext, PageFeaturePort } from '../../apps/web/src/transport/feature-ports.ts';
import type { WorkbenchClient } from '../../apps/web/src/transport/workbench-client.ts';
import { evidence } from './harness.ts';

const work = (id: string, role = 'owner', status = 'confirmed'): WorkView => ({ id, workspace_id: 'fixture-workspace', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', platform: 'x', platform_work_id: status === 'confirmed' ? '123' : null, account_id: 'fixture-account', format: null, format_source: null, topic_id: null, variant_id: null, revision_id: null, url: 'https://x.com/owner/status/123?<script>', published_at: null, origin: 'import', identity_status: status, canonical_work_id: null, parent_work_id: null, position: null, source_work_id: id, aliases: [], account_role: role });
const definition: MetricDefinitionsRow = { id: 'def', workspace_id: 'fixture-workspace', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', platform: 'x', key: 'like', raw_field: 'data.like_count', unit: 'count', kind: 'cumulative_count', denominator_key: null, visibility: 'public', definition_version: 'internal_rule.v1', scope: 'work' };
const snapshot = (overrides: Partial<SnapshotView> = {}): SnapshotView => ({ id: 'snap', workspace_id: 'fixture-workspace', created_at: '2026-10-02T05:00:00Z', updated_at: '2026-10-02T05:00:00Z', work_id: 'own', source_id: 'source', collection_request_id: 'request', request_fingerprint: 'a'.repeat(64), observed_at: '2026-10-02T05:00:00Z', observed_time_basis: 'collector_verified', observed_time_reason: null, collected_at: '2026-10-02T05:00:00Z', target_window: 86400, observed_age_s: 104400, raw_path: '/isolated/raw.json', raw_sha256: 'a'.repeat(64), adapter_version: 'internal_rule', supersedes_snapshot_id: null, source_work_id: 'own', canonical_work_id: 'own', published_at: '2026-10-01T00:00:00Z', identity_mapping: {}, evidence_kind: 'internal_rule', metrics: [{ id: 'value', key: 'like', value: '0', availability: 'available', reason: null, definition }], ...overrides });
test('single timeline保留29h真实点、零值、未知及缺失，不造三个窗口', () => {
  const points = snapshotPoints([snapshot(), snapshot({ id: 'unknown', observed_at: null, observed_time_basis: 'unknown', observed_time_reason: 'unverified', observed_age_s: null }), snapshot({ id: 'missing', observed_age_s: 72 * 3600, metrics: [{ id: 'missing-value', key: 'like', value: null, availability: 'unavailable', reason: 'missing_field', definition }] })], 'like');
  assert.equal(points[0]!.planned_age_h, 24); assert.equal(points[0]!.actual_age_h, 29); assert.equal(points[0]!.value, '0'); assert.deepEqual(observedTimeline(points), [{ age_h: 29, value: '0', snapshot_id: 'snap' }]);
});
test('feature port读取service作品/快照，排队仅本人confirmed，并保留默认动作', async () => {
  const dialogs: Array<{ title: string; body: string }> = [], posts: string[] = [], calls: string[] = [], rows = [work('own'), work('benchmark', 'benchmark'), work('pending', 'owner', 'pending')]; let delegated = 0;
  const client = { request: async (method: string, path: string) => { calls.push(path); if (method === 'POST') { posts.push(path); return { job_id: 'persisted-job', state: 'queued' }; } if (path.includes('/snapshots')) return { items: [snapshot()], next_cursor: null, has_more: false, last_success_at: null }; if (path.startsWith('/api/v1/works?')) return { items: rows, next_cursor: null, has_more: false, last_success_at: null }; return rows[0]; } } as unknown as WorkbenchClient;
  const context = { client, identity: { workspace_id: 'fixture-workspace', service_instance_id: 'fixture-service', contract_version: CONTRACT_VERSION }, ui: { retroPlatform: 'x' }, signal: new AbortController().signal, surface: { presentDialog: (dialog: { title: string; body: string }) => dialogs.push(dialog), toast: () => {} } } as unknown as FeatureContext;
  const base = { page: 'retro', load: async () => ({ provenance: 'service' }), dispatch: async () => { delegated++; } } as unknown as PageFeaturePort<'retro'>, port = withWorksFeaturePort(base);
  await port.dispatch({ action: 'work-detail', dataset: { id: 'own' }, fields: {} }, context); assert.match(dialogs[0]!.body, /29\.00h/); assert.match(dialogs[0]!.body, /like：0/); assert.ok(!dialogs[0]!.body.includes('<script>')); assert.match(dialogs[0]!.body, /&lt;script&gt;/);
  await port.dispatch({ action: 'collect-metrics', dataset: {}, fields: {} }, context); assert.deepEqual(posts, ['/api/v1/works/own/collections']); assert.match(dialogs[1]!.body, /queued/); assert.ok(!dialogs[1]!.body.includes('已回收'));
  await port.dispatch({ action: 'retro-tab', dataset: { value: 'single' }, fields: {} }, context); assert.equal(delegated, 1); assert.equal((await port.load(context)).provenance, 'service');
  evidence('feature-port-verification.json', { evidence_kind: 'internal_rule', actual_at: new Date().toISOString(), result: 'passed', actions: ['work-detail', 'collect-metrics', 'retro-tab'], service_mock_reads: calls, posts, timeline: { actual_age_h: 29, planned_age_h: 24, valid_points: 1, zero_preserved: true }, ui_fidelity: 'not_run' });
});
test('服务分页游标重复不无限循环', async () => {
  let calls = 0; const client = { request: async () => { calls++; return { items: [], next_cursor: 'repeating', has_more: true }; } } as unknown as WorkbenchClient;
  await assert.rejects(loadWorks(client, 'x'), /游标重复/); assert.equal(calls, 2);
});
