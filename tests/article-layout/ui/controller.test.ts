import assert from 'node:assert/strict';
import test from 'node:test';
import { createArticleLayout, adoptArticleImage, updateArticleStyle, serializeArticleText, assertArticleSnapshot } from '../../../packages/domain/src/article-layout/index.ts';
import { ArticleLayoutController, rebaseLocalEdits, prepareLayoutSave, type ArticleLayoutPort, type ArticleDraftStorage } from '../../../apps/web/src/features/media/article-layout/controller.ts';

class BufferStore implements ArticleDraftStorage { values = new Map<string, string>(); getItem(k: string) { return this.values.get(k) ?? null; } setItem(k: string, v: string) { this.values.set(k, v); } removeItem(k: string) { this.values.delete(k); } }
const identity = { workspace_id: 'fixture-workspace', service_instance_id: 'fixture-service' };
function fixture() {
  let server = createArticleLayout({ article_id: 'fixture-article', document_id: 'fixture-document', document_revision_id: 'r0', text: '# 标题\n\n第一段\n\n第二段' }); server.version = 1;
  const calls: unknown[] = [], cache = new BufferStore();
  const port: ArticleLayoutPort = { async load() { return structuredClone(server); }, async save(input) { calls.push(input); if (input.expected_version !== server.version) return { state: 'conflict', current: server, local: input.snapshot, reason: 'layout_version_changed' }; server = structuredClone(input.snapshot); server.version++; return { state: 'saved', snapshot: server }; } };
  const controller = new ArticleLayoutController(server, port, cache, identity);
  return { controller, port, cache, calls, get server() { return server; }, set server(value) { server = value; } };
}
test('正文保存与样式保存分别变版本，原文/人工标签不依赖旧审读状态', async () => {
  const f = fixture(), block = f.server.blocks.find(b => 'text' in b && b.text === '第一段')!;
  const content = f.server.content_revision_id, layout = f.server.layout_revision_id;
  f.controller.editText(block.id, '本人修改\n第二行'); await f.controller.flush();
  assert.match(serializeArticleText(f.server), /本人修改\n第二行/); assert.notEqual(f.server.content_revision_id, content); assert.equal(f.server.layout_revision_id, layout);
  const textHash = f.server.text_hash, revision = f.server.content_revision_id;
  f.controller.edit(s => { s.style.body_size = 17; }); await f.controller.flush(); assert.equal(f.server.text_hash, textHash); assert.equal(f.server.content_revision_id, revision); assert.notEqual(f.server.layout_revision_id, layout); f.controller.dispose();
});
test('保存过程中继续输入，晚到回执不覆盖新文字且下一保存串行', async () => {
  const f = fixture(), id = f.server.blocks.find(b => 'text' in b && b.text === '第一段')!.id;
  let release!: () => void; const hold = new Promise<void>(done => { release = done; }), original = f.port.save; let first = true;
  f.port.save = async input => { if (first) { first = false; await hold; } return original(input); };
  f.controller.editText(id, '第一轮'); const saving = f.controller.flush(); await Promise.resolve(); f.controller.editText(id, '第二轮\n完整文字'); release(); await saving;
  assert.equal(f.controller.state().status, 'saved'); assert.match(serializeArticleText(f.server), /第二轮\n完整文字/); assert.equal(f.calls.length, 2); f.controller.dispose();
});
test('断线后保留原命令key；刷新重放同命令，更新本机修改不丢', async () => {
  const f = fixture(), id = f.server.blocks.find(b => 'text' in b && b.text === '第一段')!.id, original = f.port.save;
  let pending: Parameters<ArticleLayoutPort['save']>[0] | null = null, fails = true;
  f.port.save = async input => { if (fails) { pending = input; throw new Error('fixture offline'); } if (pending && pending.idempotency_key === input.idempotency_key) { assert.deepEqual(input, pending); pending = null; } return original(input); };
  f.controller.editText(id, '断线前'); await f.controller.flush(); assert.equal(f.controller.state().status, 'offline'); f.controller.editText(id, '断线后本机新稿'); f.controller.dispose(); fails = false;
  const restored = new ArticleLayoutController(f.server, f.port, f.cache, identity); await restored.flush(); assert.match(serializeArticleText(f.server), /断线后本机新稿/); assert.equal(f.calls.length, 2); restored.dispose();
});
test('服务已有新版本时保留本机输入，只有对照后才允许新CAS', async () => {
  const f = fixture(), id = f.server.blocks.find(b => 'text' in b && b.text === '第一段')!.id;
  f.controller.editText(id, '本机稿'); f.server = updateArticleStyle(f.server, { body_size: 17 }); f.server.version++;
  await f.controller.flush(); assert.equal(f.controller.state().status, 'conflict'); assert.equal(f.controller.state().snapshot.blocks.find(b => b.id === id && 'text' in b)?.kind, 'paragraph');
  assert.match(serializeArticleText(f.controller.state().snapshot), /本机稿/); assert.doesNotMatch(serializeArticleText(f.server), /本机稿/);
  f.controller.resolveConflict(await f.controller.compareCurrent()); await f.controller.flush(); assert.match(serializeArticleText(f.server), /本机稿/); f.controller.dispose();
});
test('恢复文字与恢复排版保留互不相关的手动稿和历史', async () => {
  const f = fixture(), first = f.server.content_revision_id, originalLayout = f.server.layout_revision_id, id = f.server.blocks.find(b => 'text' in b && b.text === '第一段')!.id;
  f.controller.editText(id, '人工稿'); await f.controller.flush(); f.controller.edit(s => { s.style.body_size = 17; }); await f.controller.flush();
  await f.controller.restore('layout', originalLayout); assert.match(serializeArticleText(f.server), /人工稿/); assert.equal(f.server.style.body_size, 15); assert.equal(f.server.events.at(-1)?.kind, 'layout_restore');
  await f.controller.restore('content', first); assert.doesNotMatch(serializeArticleText(f.server), /人工稿/); assert.equal(f.server.style.body_size, 15); assert.ok(f.server.content_history.some(r => r.source_text.includes('人工稿'))); f.controller.dispose();
});
test('对照冲突后保存旧本机重排仍保留服务新采用图和新图来源', () => {
  const f = fixture(), local = structuredClone(f.server); local.order.reverse();
  const server = adoptArticleImage(f.server, { id: 'new-image', image: { asset_id: 'server-asset', version_id: 'adopted-v2', sha256: 'a'.repeat(64), source_sha256: 'b'.repeat(64), url: '/saved.png', pixel_width: 900, pixel_height: 383 }, after_block_id: f.server.order[0] });
  const rebased = rebaseLocalEdits(server, server, local), prepared = prepareLayoutSave(server, rebased);
  assert.ok(prepared.order.includes('new-image')); assert.equal(prepared.blocks.find(b => b.id === 'new-image' && b.kind === 'image')?.kind, 'image'); assertArticleSnapshot(prepared); f.controller.dispose();
});
for (const additionalEdit of [false, true]) test(`刷新重放旧回执保留已知较新head与采用图${additionalEdit ? '，并保存后续本机输入' : ''}`, async () => {
  const f = fixture(), id = f.server.blocks.find(b => 'text' in b && b.text === '第一段')!.id, original = f.port.save;
  let originalInput: Parameters<ArticleLayoutPort['save']>[0] | undefined, receipt: Awaited<ReturnType<ArticleLayoutPort['save']>> | undefined;
  f.port.save = async input => { if (!receipt) { originalInput = structuredClone(input); receipt = structuredClone(await original(input)); throw new Error('fixture committed receipt lost'); } if (input.idempotency_key === originalInput!.idempotency_key) return structuredClone(receipt); return original(input); };
  f.controller.editText(id, '已提交但回执丢失'); await f.controller.flush(); assert.equal(f.controller.state().status, 'offline');
  if (additionalEdit) f.controller.editText(id, '回执丢失后本机继续输入'); f.controller.dispose();
  f.server = adoptArticleImage(f.server, { id: 'new-image-after-receipt', image: { asset_id: 'latest-asset', version_id: 'latest-image-v3', sha256: 'a'.repeat(64), source_sha256: 'b'.repeat(64), url: '/latest.png', pixel_width: 900, pixel_height: 383 } }); f.server.version++;
  const knownHead = f.server.version, recovered = new ArticleLayoutController(f.server, f.port, f.cache, identity); await recovered.flush(); const final = recovered.state();
  assert.equal(final.status, 'saved'); assert.ok(final.snapshot.version >= knownHead); assert.ok(final.snapshot.order.includes('new-image-after-receipt')); assert.ok(f.server.order.includes('new-image-after-receipt'));
  if (additionalEdit) assert.match(serializeArticleText(f.server), /回执丢失后本机继续输入/); else assert.equal(final.snapshot.version, knownHead);
  recovered.dispose();
});
