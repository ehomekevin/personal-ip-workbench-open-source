import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './harness.ts';
import { sha256 } from '../../packages/storage/src/connection/index.ts';
import { Comparisons } from '../../packages/domain/src/comparisons/index.ts';
test('报告固定实际登记的比较/作品/快照字节，仅提交候选；缺基线保留证据不足', async () => {
  const f = fixture(); try { const author = f.author(), workspace = f.context.identity.workspace_id, definition = randomUUID(), snapshot = randomUUID(), raw = JSON.stringify({ grade: 'internal_rule', count: '12' }), rawRoot = join(f.context.paths.state_root, 'raw-responses'); mkdirSync(rawRoot); const rawPath = join(rawRoot, snapshot+'.json'); writeFileSync(rawPath, raw);
    f.context.db.prepare("INSERT INTO metric_definitions(id,workspace_id,platform,key,raw_field,unit,kind,visibility,definition_version,scope) VALUES (?,?,'x','views','views','count','cumulative','public','internal-rule-v1','work')").run(definition, workspace);
    f.context.db.prepare("UPDATE works SET published_at='2026-10-01T00:00:00Z',format_source='human_classification' WHERE id=?").run(author.work);
    const source = f.context.db.prepare('SELECT source_id FROM source_records WHERE id=?').get(f.source)!.source_id;
    f.context.db.prepare('INSERT INTO snapshots(id,workspace_id,work_id,source_id,collection_request_id,request_fingerprint,observed_at,observed_time_basis,collected_at,observed_age_s,raw_path,raw_sha256,adapter_version) VALUES (?,?,?,?,?,?,?,\'provider\',?,?,?,?,?)').run(snapshot, workspace, author.work, String(source), randomUUID(), sha256('internal'), '2026-10-04T00:00:00Z', '2026-10-04T00:01:00Z', 259200, rawPath, sha256(raw), 'internal-rule-v1');
    f.context.db.prepare("INSERT INTO metric_values(id,workspace_id,snapshot_id,definition_id,value,availability) VALUES (?,?,?,?,'12','available')").run(randomUUID(), workspace, snapshot, definition);
    const comparison = new Comparisons(f.context).create(f.request(), { kind: 'self_period', platform: 'x', account_ids: [author.account], format: 'text', metric_definition_id: definition, timezone: 'UTC', cohort_windows: { target: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' }, baseline: { start: '2026-09-24T00:00:00Z', end: '2026-10-01T00:00:00Z' } }, as_of: '2026-10-09T00:00:00Z' });
    const job = f.generation.report(f.request(), { comparison_run_id: comparison.id, source_ids: [f.source], executor: 'codex' }), claim = f.claim(), fixed = JSON.parse(claim.job.input_manifest); assert.equal(fixed.input_evidence.find((item: { kind: string }) => item.kind === 'snapshot').data.metrics[0].value, '12'); assert.ok(fixed.input_evidence.some((item: { key: string }) => item.key === 'work:'+author.work));
    f.finish(claim, { documents: [{ document_id: job.document_id!, text: `## 事实\n- 本次登记值为12 [snapshot:${snapshot}](https://x.com/wp16fixture/status/1)\n- 基线证据不足 [comparison:${comparison.id}]\n## 分析\n- 当前不足以比较倍数\n## 假设\n- 后续样本增加后再验证` }], recommendations: [] }); assert.equal((await f.documents.get(f.request(), job.document_id!)).head_revision_id, null); const candidate = f.generation.candidates(f.request(), job.document_id!)[0]!; assert.equal(candidate.adoption_mode, null); assert.equal(f.context.db.prepare('SELECT comparison_run_id FROM retro_reports WHERE id=?').get(job.report_id!)!.comparison_run_id, comparison.id);
    await f.documents.adoptCandidate(f.request(), candidate.id, { expected_revision_id: null }); assert.ok((await f.documents.get(f.request(), job.document_id!)).text.includes('证据不足')); } finally { f.cleanup(); }
});
