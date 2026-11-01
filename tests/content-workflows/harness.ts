import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION, type RequestContext, type ServiceConfiguration, type JsonObject } from '../../packages/contracts/src/index.ts';
import { openWorkspaceStorage } from '../../packages/storage/src/connection/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';
import { Topics } from '../../packages/domain/src/topics/index.ts';
import { Documents } from '../../packages/domain/src/documents/index.ts';
import { Jobs } from '../../packages/domain/src/jobs/index.ts';
import { ResultCommit, type TypedOutput } from '../../packages/domain/src/result-commit/index.ts';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { ContentGeneration, validateContentOutput } from '../../packages/domain/src/content-agents/index.ts';
import { Recommendations, validateRecommendationOutput } from '../../packages/domain/src/recommendations/index.ts';
export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const schemaDirectory = resolve(projectRoot, '.ci-artifacts/evidence/wp-03/local-inventory/codex-schema-0.161.0');
export function fixture(options: { max_output_chars?: number } = {}) {
  const root = mkdtempSync(join(projectRoot, 'tests/content-workflows/.wp16-')), paths = { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') }, staging = join(root, 'staging');
  for (const path of [paths.managed_notes_root, paths.state_root, paths.media_root, staging]) mkdirSync(path);
  const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: 'WP16 isolated internal_rule', mode: 'demo', timezone: 'America/Los_Angeles', paths, listen: { host: '127.0.0.1', port: 0 } }, storage = openWorkspaceStorage(join(paths.state_root, 'workbench.sqlite'));
  storage.db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,?,?,?,?,1)').run(config.workspace_id, config.workspace_id, config.title, config.timezone, JSON.stringify(paths), 'demo');
  const identity = { workspace_id: config.workspace_id, service_instance_id: config.service_instance_id, contract_version: CONTRACT_VERSION }, context: ApplicationContext = { db: storage.db, config, identity, paths, getExecutorHealth: async () => [] };
  const request = (key: string = randomUUID()): RequestContext => ({ ...identity, request_id: randomUUID(), idempotency_key: key, request_identity_ref: 'internal_rule' }), topics = new Topics(context), documents = new Documents(context), jobs = new Jobs(context), results = new ResultCommit(context), sources = new Sources(context), generation = new ContentGeneration(context, { staging_root: staging, ...options }), recommendations = new Recommendations(context, { staging_root: staging, ...options });
  const source = sources.create(request(), { url: 'https://example.org/wp16-fixed-source', title: '内部规则固定资料', text: '内部构造资料，仅验证引用与版本保护，不是真实 AI 或平台证据。' }).record_id;
  const text = (body = '内部构造正文') => `${body} [source:${source}](https://example.org/wp16-fixed-source)`;
  function claim() { const result = jobs.claim('wp16-worker'); if (!result) throw new Error('没有可领取任务'); return result; }
  function finish(claimed: ReturnType<typeof claim>, output: TypedOutput, validate = true) {
    const manifest = JSON.parse(claimed.job.input_manifest) as JsonObject; if (validate) validateRecommendationOutput(manifest, validateContentOutput(manifest, output));
    const current = jobs.get(request(), claimed.job.id).job;
    return results.submit(request(), claimed.job.id, { attempt_id: claimed.attempt.id, attempt_generation: claimed.attempt.attempt_generation, expected_version: current.version, input_hash: claimed.job.input_hash, typed_output: output }, 'wp16-worker');
  }
  async function topic() { const result = await topics.create(request(), { title: '内部规则主题', category: '个人思考', audience: '测试', source_ids: [source] }); const saved = await documents.save(request(), result.core_document_id, { expected_revision_id: null, text: text('人工核心 r1'), origin: 'human' }); await documents.approveCore(request(), result.id, saved.revision_id); return { ...result, core_revision_id: saved.revision_id }; }
  function author() { const account = randomUUID(), work = randomUUID(); storage.db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'x','fixture-author','owner','内部构造作者','https://x.com/wp16fixture','confirmed')").run(account, config.workspace_id); storage.db.prepare("INSERT INTO works(id,workspace_id,platform,platform_work_id,account_id,url,format,origin,identity_status) VALUES (?,?,'x','fixture-work',?,'https://x.com/wp16fixture/status/1','text','internal_rule','confirmed')").run(work, config.workspace_id, account); storage.db.prepare('UPDATE source_records SET work_id=? WHERE workspace_id=? AND id=?').run(work, config.workspace_id, source); return { account, work }; }
  return { root, staging, context, request, topics, documents, jobs, results, sources, generation, recommendations, source, text, claim, finish, topic, author, cleanup() { storage.close(); rmSync(root, { recursive: true, force: true }); } };
}
