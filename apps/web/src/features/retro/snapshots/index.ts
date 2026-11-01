import type { Page } from '@workbench/contracts';
import type { SnapshotView } from '../../works/types.ts';
import type { WorkbenchClient } from '../../../transport/workbench-client.ts';

export interface SnapshotPoint { snapshot_id: string; collection_request_id: string; definition_id: string; definition_version: string; planned_age_h: number | null; actual_age_h: number | null; observed_at: string | null; collected_at: string; published_at: string | null; value: string | null; availability: string; reason: string | null; raw_sha256: string }
export async function loadWorkSnapshots(client: WorkbenchClient, id: string, signal?: AbortSignal): Promise<SnapshotView[]> {
  const rows: SnapshotView[] = []; let cursor: string | null = null; const seen = new Set<string>();
  do {
    const page: Page<SnapshotView> = await client.request('GET', `/api/v1/works/${encodeURIComponent(id)}/snapshots?limit=200${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, undefined, { signal }); rows.push(...page.items);
    cursor = page.next_cursor; if (cursor && seen.has(cursor)) throw new Error('快照游标重复'); if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}
export function snapshotPoints(rows: readonly SnapshotView[], metricKey: string): SnapshotPoint[] {
  return rows.flatMap(snapshot => snapshot.metrics.filter(metric => metric.key === metricKey).map(metric => ({ snapshot_id: snapshot.id, collection_request_id: snapshot.collection_request_id, definition_id: metric.definition.id, definition_version: metric.definition.definition_version,
    planned_age_h: snapshot.target_window === null ? null : snapshot.target_window / 3600, actual_age_h: snapshot.observed_age_s === null ? null : snapshot.observed_age_s / 3600, observed_at: snapshot.observed_at, collected_at: snapshot.collected_at, published_at: snapshot.published_at,
    value: metric.value, availability: metric.availability, reason: metric.reason, raw_sha256: snapshot.raw_sha256 })));
}
// 只有实际取得的观察才是点；不补24h/72h/7d，不用采集时间替代未知观察时间。
export function observedTimeline(points: readonly SnapshotPoint[]): Array<{ age_h: number; value: string; snapshot_id: string }> {
  return points.filter((point): point is SnapshotPoint & { actual_age_h: number; value: string } => point.actual_age_h !== null && point.observed_at !== null && point.value !== null && point.availability === 'available')
    .map(point => ({ age_h: point.actual_age_h, value: point.value, snapshot_id: point.snapshot_id })).sort((a, b) => a.age_h - b.age_h || a.snapshot_id.localeCompare(b.snapshot_id));
}
