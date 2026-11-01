import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './harness.ts';
import { parseRevision } from '../../packages/storage/src/files/index.ts';
import { buildServiceAgentPlan } from '../../packages/domain/src/service-agent/index.ts';

test('核心、五平台初始化和平台改稿使用读者正文规则，修订仍保存出处', async () => {
  const f = fixture(); try {
    const topic = await f.topic();
    f.generation.modify(f.request(), topic.core_document_id, { base_revision_id: topic.core_revision_id, source_ids: [f.source], executor: 'codex', instruction: '自然改写' });
    const coreClaim = f.claim(), coreManifest = JSON.parse(coreClaim.job.input_manifest), corePlan = buildServiceAgentPlan(f.context, coreClaim, { staging_root: f.staging });
    assert.equal(coreManifest.citation_policy, 'public_copy_v1'); assert.equal(coreManifest.writing_skills[0].version, '1.1.0'); assert.deepEqual(coreManifest.source_ids, [f.source]); assert.equal(coreManifest.input_evidence[0].id, f.source);
    const materials = corePlan.input.input_manifest.materials; assert.ok(Array.isArray(materials));
    assert.ok(materials.some(material => material && typeof material === 'object' && !Array.isArray(material) && typeof material.text === 'string' && material.text.includes(`[source:${f.source}]`)));
    f.finish(coreClaim, { documents: [{ document_id: topic.core_document_id, text: '新核心候选' }], recommendations: [] });
    assert.equal((await f.documents.get(f.request(), topic.core_document_id)).head_revision_id, topic.core_revision_id);
    const coreCandidate = f.generation.candidates(f.request(), topic.core_document_id)[0]!, row = f.context.db.prepare('SELECT file_path FROM document_revisions WHERE id=?').get(coreCandidate.revision_id)!;
    assert.deepEqual(parseRevision(readFileSync(String(row.file_path), 'utf8')).metadata.source_ids, [f.source]);
    for (const [platform, format] of [['xiaohongshu', 'image_post'], ['wechat', 'article'], ['x', 'text'], ['douyin', 'short_video'], ['bilibili', 'long_video']] as const) {
      const variant = f.generation.createVariant(f.request(), topic.id, { platform, format }), documentId = String(variant.document_id);
      f.generation.variant(f.request(), String(variant.id), { core_revision_id: topic.core_revision_id, base_revision_id: null, mode: 'initialize', source_ids: [f.source], executor: 'codex' });
      const claim = f.claim(); assert.equal(JSON.parse(claim.job.input_manifest).citation_policy, 'public_copy_v1');
      f.finish(claim, { documents: [{ document_id: documentId, text: `${platform} 的读者正文` }], recommendations: [] });
      const initial = await f.documents.get(f.request(), documentId); assert.equal(initial.text, `${platform} 的读者正文`);
      f.generation.modify(f.request(), documentId, { base_revision_id: initial.head_revision_id, source_ids: [f.source], executor: 'codex', instruction: '调整开头' });
      const edit = f.claim(), manifest = JSON.parse(edit.job.input_manifest); assert.equal(manifest.content_purpose, 'variant'); assert.equal(manifest.citation_policy, 'public_copy_v1');
      f.finish(edit, { documents: [{ document_id: documentId, text: `${platform} 的修改候选` }], recommendations: [] });
      assert.equal((await f.documents.get(f.request(), documentId)).head_revision_id, initial.head_revision_id);
    }
    const wiki = await f.documents.create(f.request(), { kind: 'wiki', initial_text: '旧笔记' });
    const modified = f.generation.modify(f.request(), wiki.document_id, { base_revision_id: wiki.head_revision_id, source_ids: [f.source], executor: 'codex', instruction: '补充笔记' });
    assert.equal(JSON.parse(f.jobs.get(f.request(), modified.job_id).job.input_manifest).citation_policy, 'internal_citations_v1');
  } finally { f.cleanup(); }
});
