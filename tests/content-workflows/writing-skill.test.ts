import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture as contentFixture } from './harness.ts';
import { hash } from '../../packages/adapters/src/agent/codex/primitives.ts';
import { readWritingSkill } from '../../packages/adapters/src/agent/skills.ts';
import { buildServiceAgentPlan } from '../../packages/domain/src/service-agent/index.ts';
import { writingSkillLabel } from '../../apps/web/src/features/create/ai-actions/index.ts';

test('核心稿起草与改稿都冻结技能；资料、平台稿与旧任务不冒充技能调用', async () => {
  const f = contentFixture(); try {
    const topic = await f.topics.create(f.request(), { title: '新核心稿', category: '热点资讯', audience: '关注 AI 的人', source_ids: [f.source] });
    const empty = f.generation.modify(f.request(), topic.core_document_id, { base_revision_id: null, source_ids: [f.source], executor: 'codex', instruction: '起草核心稿' }), first = f.jobs.get(f.request(), empty.job_id); const binding = JSON.parse(first.job.input_manifest).writing_skills[0];
    assert.equal(binding.sha256, hash(binding.content)); assert.equal(binding.name, 'workbench-core-writing');
    assert.equal(writingSkillLabel(first), undefined);
    const claim = f.claim(), plan = buildServiceAgentPlan(f.context, claim, { staging_root: f.staging }); assert.deepEqual(readWritingSkill(plan.input.input_manifest), binding);
    const saved = await f.documents.save(f.request(), topic.core_document_id, { expected_revision_id: null, text: f.text('人工稿'), origin: 'human' });
    const edit = f.generation.modify(f.request(), topic.core_document_id, { base_revision_id: saved.revision_id, source_ids: [f.source], executor: 'codex', instruction: '保留原观点改稿' }); assert.deepEqual(JSON.parse(f.jobs.get(f.request(), edit.job_id).job.input_manifest).writing_skills[0], binding);
    const confirmed = await f.topic(), variant = f.generation.createVariant(f.request(), confirmed.id, { platform: 'x', format: 'text' }); const other = f.generation.variant(f.request(), String(variant.id), { core_revision_id: confirmed.core_revision_id, base_revision_id: null, mode: 'initialize', source_ids: [f.source], executor: 'codex' }); assert.deepEqual(JSON.parse(f.jobs.get(f.request(), other.job_id).job.input_manifest).writing_skills.map((skill: {name:string})=>skill.name), ['workbench-platform-adapt','workbench-reader-polish']);
  } finally { f.cleanup(); }
});


test('AI 制作技能候选幂等并保留待审，非法 SKILL.md 不提交', async () => {
  const f = contentFixture(); try {
    const request=f.request(), input={instruction:'先给业务判断，再解释具体场景',samples:'用一个小任务说明 AI 的业务价值。',purpose:'core' as const};
    const accepted=await f.generation.draftSkill(request,input);assert.deepEqual(await f.generation.draftSkill(request,input),accepted);
    const claim=f.claim(),manifest=JSON.parse(claim.job.input_manifest);assert.equal(manifest.content_purpose,'skill_builder');assert.equal(manifest.writing_skills,undefined);
    assert.throws(()=>f.finish(claim,{documents:[{document_id:accepted.document_id!,text:'普通文章'}],recommendations:[]}),error=>(error as {code:string}).code==='VALIDATION_ERROR');
    const text='---\nname: business-writing\ndescription: 从业务任务解释 AI 的价值\nmetadata:\n  version: 0.1.0\n---\n\n只使用本次固定资料，先给判断再解释一个具体场景。';
    f.finish(claim,{documents:[{document_id:accepted.document_id!,text}],recommendations:[]});
    const candidate=f.generation.candidates(f.request(),accepted.document_id!)[0]!;assert.equal(candidate.adoption_mode,null);assert.equal((await f.documents.get(f.request(),accepted.document_id!)).head_revision_id,null);assert.equal((await f.generation.preview(f.request(),candidate.id)).text,text);
  } finally {f.cleanup();}
});
