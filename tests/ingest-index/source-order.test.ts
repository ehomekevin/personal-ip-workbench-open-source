// 资料列表排序与分页：手动资料（没有当前精选排名）新建的排前面；同一创建时间按插入顺序兜底；翻页不重复不遗漏；旧格式和认不出的游标从第一页重新开始。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApplication, type RunningApplication } from '../../apps/service/src/bootstrap/application.ts';
import { createSourcesModule } from '../../apps/service/src/routes/sources.ts';
import { createDocumentsModule } from '../../apps/service/src/routes/documents.ts';
import { createHttpClient } from '../../apps/web/src/transport/workbench-client.ts';
import { fixture } from './harness.ts';
import type { Page, SourceRecordSummary } from '../../packages/contracts/src/index.ts';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string, string];

test('手动资料排序：新建在前、同一创建时间按插入顺序、分页完整；旧游标与坏游标从第一页重新开始，合并后不漏不重', async () => {
  const f = fixture(); let app: RunningApplication | undefined;
  try {
    app = await startApplication(f.config, { port: 0, moduleFactories: [createDocumentsModule, createSourcesModule] });
    const client = createHttpClient(`http://127.0.0.1:${app.address.port}`, app.identity); await client.identity();
    const created: string[] = [];
    for (let i = 0; i < 60; i++) created.push((await client.request<{ record_id: string }>('POST', '/api/v1/source-records', { title: `排序资料 ${i}`, text: `# 排序资料 ${i}\n\n正文 ${i}`, category: '个人思考' }, { idempotencyKey: 'order-' + i })).record_id);
    // 前 30 条压成同一创建时间（毫秒级平局），后 30 条各自递增的时间：平局只能靠插入顺序区分。
    const db = app.context.db, set = db.prepare('UPDATE source_records SET created_at=? WHERE id=?');
    created.forEach((id, i) => set.run(i < 30 ? '2026-10-01T00:00:00.000Z' : '2026-10-02T00:00:' + String(i - 30).padStart(2, '0') + '.000Z', id));
    const expected = [...created].reverse();
    for (const curated of [false, true]) {
      const q = (cursor?: string) => '/api/v1/source-records?' + new URLSearchParams({ limit: '25', ...(curated ? { curated: 'true' } : {}), ...(cursor ? { cursor } : {}) });
      const seen: string[] = []; let cursor: string | undefined; const pages: Page<SourceRecordSummary>[] = [];
      do { const page = await client.request<Page<SourceRecordSummary>>('GET', q(cursor)); pages.push(page); seen.push(...page.items.map(r => r.id)); cursor = page.next_cursor ?? undefined; } while (cursor);
      assert.deepEqual(seen, expected, (curated ? '精选视图' : '默认视图') + '：新建在前，同一创建时间后插入的在前，翻页不重复不遗漏');
      // 旧格式游标：按旧排序（排序键平局时按 id）真实生成的第一页与游标。续页从第一页重新开始，按 id 去重合并后与全集一致、无遗漏无重复。
      const first = pages[0]!, [scope] = decode(first.next_cursor!);
      const oldRows = db.prepare(curated ? "SELECT id,'999999' AS k FROM source_records ORDER BY k ASC,id ASC" : 'SELECT id,created_at AS k FROM source_records ORDER BY created_at DESC,id DESC').all() as Array<{ id: string; k: string }>;
      const oldFirst = oldRows.slice(0, 25), oldLast = oldFirst.at(-1)!;
      const merged = oldFirst.map(r => r.id), ids = new Set(merged); let next: string | undefined = encode([scope, oldLast.k, oldLast.id]), restarted = false;
      do { const page: Page<SourceRecordSummary> = await client.request<Page<SourceRecordSummary>>('GET', q(next)); if (!restarted) { assert.deepEqual(page.items.map(r => r.id), first.items.map(r => r.id), '旧游标从第一页重新开始'); restarted = true; }
        for (const r of page.items) if (!ids.has(r.id)) { ids.add(r.id); merged.push(r.id); } next = page.next_cursor ?? undefined; } while (next);
      assert.equal(merged.length, created.length, '无重复'); assert.deepEqual([...ids].sort(), [...created].sort(), '无遗漏');
      const oldKey = oldLast.k;
      // 认不出的游标、指向已不存在记录的旧游标：不报错，从第一页开始。
      for (const bad of ['not-base64-json', encode({ x: 1 }), encode([scope, oldKey, '00000000-0000-4000-8000-000000000000'])]) {
        const page = await client.request<Page<SourceRecordSummary>>('GET', q(bad)); assert.deepEqual(page.items.map(r => r.id), first.items.map(r => r.id), '回到第一页');
      }
      // 别的筛选下的游标仍拒绝。
      await assert.rejects(client.request('GET', '/api/v1/source-records?' + new URLSearchParams({ limit: '25', category: '热点资讯', ...(curated ? { curated: 'true' } : {}), cursor: first.next_cursor! })));
    }
  } finally { await app?.close(); f.cleanup(); }
});
