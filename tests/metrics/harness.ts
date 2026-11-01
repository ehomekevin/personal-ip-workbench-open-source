import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { CONTRACT_VERSION, type RequestContext, type ServiceConfiguration } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage, assertStorageRoot } from '../../packages/storage/src/connection/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';
import { Works } from '../../packages/domain/src/works/index.ts';
import { TikHubAdapter, type VerifiedTarget, type MetricMapping } from '../../packages/adapters/src/tikhub/index.ts';

export const projectRoot = resolve(import.meta.dirname, '../..');
export function fixture() {
  assertStorageRoot(projectRoot); const root = mkdtempSync(join(projectRoot, 'tests/metrics/.wp12-'));
  const paths = { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') };
  for (const path of [paths.managed_notes_root, paths.state_root, paths.media_root]) mkdirSync(path);
  const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: 'WP-12 isolated fixture', mode: 'demo', timezone: 'UTC', paths, listen: { host: '127.0.0.1', port: 4329 }, default_executor: 'codex', api_fallback_enabled: false };
  let storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite'));
  storage.db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,?,?,?,?,1)').run(config.workspace_id, config.workspace_id, config.title, config.timezone, JSON.stringify(paths), config.mode);
  const identity = { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION };
  const context = (): ApplicationContext => ({ db: storage.db, identity, config, paths, getExecutorHealth: async () => [] });
  return { root, config, context, request: (key: string = randomUUID()): RequestContext => ({ ...identity, request_id: randomUUID(), idempotency_key: key, request_identity_ref: 'wp12-fixture' }),
    reopen() { try { storage.close(); } catch { /* 子进程验收前已关闭连接。 */ } storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite')); },
    closeDb() { storage.close(); },
    cleanup() { try { storage.close(); } catch { /* 测试连接可能已经关闭。 */ } rmSync(root, { recursive: true, force: true }); } };
}
export const mapping = (key = 'like', path: string | null = 'data.like_count'): MetricMapping => ({ key, path, unit: 'count', kind: 'cumulative_count', visibility: 'public', definition_version: 'fixture.x.v1', mapping_evidence_ref: 'internal_rule:fixture' });
export async function ownWork(f: ReturnType<typeof fixture>, options: { id?: string; published_at?: string | null; url_suffix?: string } = {}) {
  const db = f.context().db, account = randomUUID(), platformId = options.id ?? '123', url = `https://x.com/owner/status/${platformId}${options.url_suffix ?? ''}`;
  db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'x','owner-id','owner','fixture owner','https://x.com/owner','confirmed')").run(account, f.config.workspace_id);
  const works = new Works(f.context()), imported = await works.importWork(f.request(), { platform: 'x', url });
  works.resolveVerified(f.request(), imported.work_id, { platform_work_id: platformId, account_id: account, evidence: { evidence_kind: 'internal_rule', verified: 'fixture-only' } });
  works.registerPlatformMetadata(f.request(), imported.work_id, { published_at: options.published_at ?? null, format: 'text', evidence: { evidence_kind: 'internal_rule', fixture: true } });
  return { work_id: imported.work_id, account_id: account, platform_id: platformId, url };
}
export function target(work: { work_id: string; account_id: string; platform_id: string; url: string }, options: { metrics?: MetricMapping[]; observation?: VerifiedTarget['observation']; scope?: 'work' | 'account' } = {}): VerifiedTarget {
  const account = options.scope === 'account'; return { target_id: account ? work.account_id : work.work_id, platform: 'x', scope: account ? 'account' : 'work', platform_work_id: account ? null : work.platform_id, platform_account_id: 'owner-id', url: account ? null : work.url, identity_evidence_ref: 'internal_rule:fixture-identity', endpoint_key: account ? 'x_account' : 'x_post', params: account ? { rest_id: 'owner-id' } : { tweet_id: work.platform_id }, metrics: options.metrics ?? [mapping()], observation: options.observation ?? { basis: 'unknown', evidence_ref: null } };
}
export function adapter(targets: VerifiedTarget[], fetcher: typeof fetch, clock: () => number = Date.now) {
  process.env.WP12_FIXTURE_TOKEN = 'isolated-fixture'; return new TikHubAdapter({ targets, token_env: 'WP12_FIXTURE_TOKEN', fetcher, clock, fixture: true });
}
const evidenceRoot = process.env.WORKBENCH_TEST_EVIDENCE_DIR ? join(resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR), 'wp12') : join(projectRoot, '.ci-artifacts/evidence/wp-12');
export function evidence(name: string, payload: unknown) { mkdirSync(evidenceRoot, { recursive: true }); writeFileSync(join(evidenceRoot, name), JSON.stringify(payload, null, 2) + '\n'); }
export function preserveRaw(snapshot: { collection_request_id: string; raw_path: string }) {
  const absolute = join(evidenceRoot, 'raw-responses', `internal-rule-${snapshot.collection_request_id}.json`); mkdirSync(join(evidenceRoot, 'raw-responses'), { recursive: true }); writeFileSync(absolute, readFileSync(snapshot.raw_path)); return relative(projectRoot, absolute);
}
