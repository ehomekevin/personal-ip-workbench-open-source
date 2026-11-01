import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeIndex } from '../../packages/domain/src/knowledge-index/index.ts';
import { Documents } from '../../packages/domain/src/documents/index.ts';
import { Topics } from '../../packages/domain/src/topics/index.ts';
import { Identities } from '../../packages/domain/src/identity/index.ts';
import { transaction, sha256 } from '../../packages/storage/src/connection/index.ts';
import { fixture, evidence } from './harness.ts';

test('重建只更改索引域：非空作品、发布意图、复盘采用及人工修订逐表hash保留', async () => { const f = fixture(); try {
  writeFileSync(join(f.paths.source_vault_root, 'source.md'), '# 来源资料\n\n内部规则'); const index = new KnowledgeIndex(f.context()); await index.scan({ roots: [f.paths.source_vault_root], mode: 'initial' });
  const documents = new Documents(f.context()), topic = await new Topics(f.context()).create(f.request(), { title: '运营保留主题', category: '个人思考', audience: 'fixture', source_ids: [] });
  const core = await documents.save(f.request(), topic.core.document_id, { expected_revision_id: null, text: '# 已保存核心稿\n实际运营行fixture', origin: 'human' }); const approval = await documents.approveCore(f.request(), topic.id, core.revision_id);
  const variantDocument = await documents.create(f.request(), { kind: 'variant', initial_text: '# 独立平台稿\n保留人工修改' }), report = await documents.create(f.request(), { kind: 'retro_report', initial_text: '# 内部复盘报告fixture\n证据不足' });
  const work = await new Identities(f.context()).importWork(f.request(), { platform: 'x', url: 'https://x.com/fixture/status/100', format: 'text', topic_id: topic.id });
  const workspace = f.identity.workspace_id, db = f.context().db, variant = randomUUID(), account = randomUUID(), intent = randomUUID(), comparison = randomUUID(), reportId = randomUUID(), action = randomUUID(), adoption = randomUUID();
  transaction(db, () => {
    db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'x','internal-fixture-account','owner','fixture账号','https://x.com/fixture','confirmed')").run(account, workspace);
    db.prepare("INSERT INTO variants(id,workspace_id,topic_id,platform,format,variant_key,document_id,based_on_core_revision_id,status,version) VALUES (?,?,?,'x','text','fixture',?,?,'ready',1)").run(variant, workspace, topic.id, variantDocument.document_id, core.revision_id);
    db.prepare("INSERT INTO publication_intents(id,workspace_id,variant_id,account_id,revision_id,core_approval_id,input_hash,idempotency_key,state,progress,version,work_id) VALUES (?,?,?,?,?,?,?,'fixture-publication','published','{}',1,?)").run(intent, workspace, variant, account, variantDocument.head_revision_id, approval.approval_id, sha256('fixture-publication'), work.work_id);
    db.prepare("INSERT INTO comparison_runs(id,workspace_id,query_spec,selected_snapshot_ids,selected_inputs_by_cohort,excluded_work_ids,excluded_reasons,definition_versions,result) VALUES (?,?,'{}','[]','{}','[]','{}','{}','{\"status\":\"insufficient\"}')").run(comparison, workspace);
    db.prepare("INSERT INTO retro_reports(id,workspace_id,document_id,comparison_run_id,source_record_ids,status) VALUES (?,?,?,?,'[]','draft')").run(reportId, workspace, report.document_id, comparison);
    db.prepare("INSERT INTO retro_actions(id,workspace_id,report_id,report_revision_id,description,hypothesis,target_metric,observation_plan,status) VALUES (?,?,?,?, 'fixture建议','fixture假设','views','{}','adopted')").run(action, workspace, reportId, report.head_revision_id);
    db.prepare("INSERT INTO action_adoptions(id,workspace_id,action_id,adoption_key,topic_id,adopted_at,observation_plan,plan_hash) VALUES (?,?,?,'fixture-adoption',?,?,'{}',?)").run(adoption, workspace, action, topic.id, new Date().toISOString(), sha256('{}'));
  });
  const tables = ['topics','documents','document_revisions','core_approvals','variants','accounts','works','publication_intents','comparison_runs','retro_reports','retro_actions','action_adoptions'];
  const before = Object.fromEntries(tables.map(table => [table, { count: Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n), hash: sha256(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())) }])); assert.ok(Object.values(before).every(value => value.count > 0));
  await index.scan({ roots: [f.paths.source_vault_root], mode: 'initial' });
  const after = Object.fromEntries(tables.map(table => [table, { count: Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n), hash: sha256(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())) }])); assert.deepEqual(after, before); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  evidence('operating-row-preservation.json', { grade: 'internal_rule', scope: 'isolated SQL fixture publication/adoption; no actual publishing or observation', before, after, preserved: true });
} finally { f.cleanup(); } });
