import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject } from '../../packages/contracts/src/index.ts';
import { CONTENT_SCHEMA_VERSION, validateContentOutput } from '../../packages/domain/src/content-agents/index.ts';
import type { TypedOutput } from '../../packages/domain/src/result-commit/index.ts';

const key = 'source:11111111-1111-4111-8111-111111111111', url = 'https://example.org/fixed';
const evidence = [{ key, kind: 'source', id: key.slice(7), url, sha256: 'frozen-hash', data: { title: '固定资料', summary: '外部案例' } }];
const manifest = (purpose = 'core', policy: string | undefined = 'public_copy_v1'): JsonObject => ({ schema_version: CONTENT_SCHEMA_VERSION, content_purpose: purpose, ...(policy === undefined ? {} : { citation_policy: policy }), input_evidence: evidence });
const output = (text: string): TypedOutput => ({ documents: [{ document_id: 'document', text }], recommendations: [] });

test('读者正文无需内联引用，保留原文和冻结资料；拒绝内部标识和虚构链接', () => {
  const fixed = manifest(), before = JSON.stringify(fixed), natural = output('Standard Bots 展示了一种通过演示适配任务的方法。我更关注它在具体业务中的稳定性。');
  assert.equal(validateContentOutput(fixed, natural), natural); assert.equal(JSON.stringify(fixed), before);
  for (const text of [`正文 [${key}](${url})`, `正文 ${key}`, '正文 [snapshot:unknown]', '正文 [资料](https://unfixed.example/)']) assert.throws(() => validateContentOutput(fixed, output(text)), { code: 'VALIDATION_ERROR' });
  assert.equal(validateContentOutput(fixed, output(`读者需要时查看[资料](${url})`)).documents[0]!.text, `读者需要时查看[资料](${url})`);
});

test('内部资料继续要求固定引用，不能切成发布规则；未知规则被拒绝', () => {
  for (const purpose of ['wiki', 'report', 'research']) {
    assert.throws(() => validateContentOutput(manifest(purpose, 'internal_citations_v1'), output('无出处的结论')), { code: 'VALIDATION_ERROR' });
    assert.throws(() => validateContentOutput(manifest(purpose), output('自然正文')), { code: 'VALIDATION_ERROR' });
    validateContentOutput(manifest(purpose, 'internal_citations_v1'), output(`## 事实\n- 外部案例 [${key}](${url})\n## 分析\n- 业务判断\n## 假设\n- 有待进一步测试`));
  }
  assert.throws(() => validateContentOutput(manifest('core', 'unknown'), output('正文')), { code: 'VALIDATION_ERROR' });
});

test('旧冻结任务保留原引用校验，规则更新不改写历史输出', () => {
  const legacy = manifest('core'); delete legacy.citation_policy;
  assert.throws(() => validateContentOutput(legacy, output('旧任务无引用')), { code: 'VALIDATION_ERROR' });
  const old = output(`原有正文 [${key}](${url})`); assert.equal(validateContentOutput(legacy, old), old);
});
