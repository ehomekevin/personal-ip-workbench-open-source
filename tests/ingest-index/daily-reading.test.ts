import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePersonalSiteRecord, PERSONAL_SITE_VERSION } from '../../packages/adapters/src/personal-site/index.ts';
import { Sources } from '../../packages/domain/src/sources/index.ts';
import { sourceView } from '../../apps/web/src/features/sources/read/index.ts';
import { fixture } from './harness.ts';
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('日报以本站日期排序，正文按栏目整理；未知发布时间保持未知', async () => {
  const f = fixture();
  try {
    const sources = new Sources(f.context()); sources.ensurePublicSources('https://site.example.invalid');
    const id = String(f.context().db.prepare("SELECT id FROM sources WHERE external_id='dailies'").get()!.id);
    await sources.ingest(id, { fetcher: async () => json({ schemaVersion: 1, dailies: [
      { date: '2026-10-11', headline: '今天的日报', links: { site: 'https://site.example.invalid/hot/daily/2026-10-11/' } },
      { date: '2026-09-27', headline: '历史日报', links: { site: 'https://site.example.invalid/hot/daily/2026-09-27/' } },
    ] }) });
    const page = sources.records(f.request(), { order: 'published_desc' });
    assert.deepEqual(page.items.map(row => row.title), ['今天的日报', '历史日报']);
    assert.equal(sourceView(page.items[0]!).time, '2026-10-11');
    const detail = await sources.readDetail(f.request(), page.items[0]!.id, undefined, async () => json({ schemaVersion: 1, daily: {
      date: '2026-10-11', headline: '今天的日报', lead: '今天关注 AI 业务落地。', sections: [{ label: '行业动态', events: [{ title: '真实资讯标题', summary: '报道中的摘要' }] }],
      flashes: [{ title: '简讯标题', summary: '简讯摘要', source: { name: '出版来源' } }],
    } }));
    assert.match(detail.body!, /行业动态\n\n真实资讯标题\n报道中的摘要/);
    assert.match(detail.body!, /简讯\n\n简讯标题\n简讯摘要\n来源：出版来源/);
    assert.doesNotMatch(detail.body!, /sections:|flashes:|summary:/);
    assert.equal(sourceView(detail, detail).bodyLabel, '个人站日报');
    assert.ok(!detail.parser_warnings.includes('正文尚未读取；列表仅含摘要。'));
    await sources.ingest(id, { fetcher: async () => json({ schemaVersion: 1, dailies: [{ date: '2026-10-11', headline: '今天的日报' }] }) });
    assert.ok(!sources.detail(f.request(), detail.id).parser_warnings.includes('正文尚未读取；列表仅含摘要。'));
    const row = { ...page.items[0]!, record_kind: 'site_item', published_at: null };
    assert.equal(sourceView(row).time, '发布时间未提供');
    const normalized = normalizePersonalSiteRecord('dailies', { date: '2026-10-11', headline: '日报' });
    assert.equal(normalized.payload.provider_metadata.published_time_basis, 'provider_daily_date');
  } finally { f.cleanup(); }
});

test('旧解析正文读回时更新；失败保留正文，成功以后复用当前版本', async () => {
  const f = fixture();
  try {
    const sources = new Sources(f.context()); sources.ensurePublicSources('https://site.example.invalid');
    const id = String(f.context().db.prepare("SELECT id FROM sources WHERE external_id='events'").get()!.id);
    await sources.ingest(id, { fetcher: async () => json({ schemaVersion: 1, events: [{ id: 'actual-event', title: '事件标题', firstAt: '2026-10-10T10:00:00Z' }] }) });
    const recordId = sources.records(f.request()).items[0]!.id;
    const row = f.context().db.prepare('SELECT payload FROM source_records WHERE id=?').get(recordId)!;
    const payload = JSON.parse(String(row.payload));
    f.context().db.prepare('UPDATE source_records SET payload=? WHERE id=?').run(JSON.stringify({ ...payload, body: 'tldr: 已保存的旧解析', provider_metadata: { ...payload.provider_metadata, body_parser_version: 'personal-site/1' } }), recordId);
    const failed = await sources.readDetail(f.request(), recordId, undefined, async () => new Response('unavailable', { status: 503 }));
    assert.equal(failed.body, 'tldr: 已保存的旧解析');
    assert.ok(failed.parser_warnings.includes('详情更新暂不可用；保留已有解读和原文链接。'));
    let reads = 0;
    const fetcher: typeof fetch = async () => { reads++; return json({ schemaVersion: 1, event: { id: 'actual-event', title: '事件标题', brief: {
      tldr: '站点的核心判断', facts: [{ k: '任务', v: '一个明确的动作' }, '未结构化的事实也保留'], quotes: [{ who: '报道中的作者', say: '先做小任务' }],
    } } }); };
    const updated = await sources.readDetail(f.request(), recordId, undefined, fetcher);
    assert.match(updated.body!, /要点\n站点的核心判断/);
    assert.match(updated.body!, /任务：一个明确的动作\n未结构化的事实也保留/);
    assert.match(updated.body!, /站点引用\n报道中的作者：先做小任务/);
    assert.ok(updated.parser_warnings.includes('站点解读不代表每篇外站全文。'));
    assert.ok(!updated.parser_warnings.some(warning => warning.includes('尚未读取') || warning.includes('暂不可用')));
    assert.equal(await sources.readDetail(f.request(), recordId, undefined, fetcher).then(detail => detail.body), updated.body);
    assert.equal(reads, 1);
    const saved = JSON.parse(String(f.context().db.prepare('SELECT payload FROM source_records WHERE id=?').get(recordId)!.payload));
    assert.equal(saved.provider_metadata.body_parser_version, PERSONAL_SITE_VERSION);
  } finally { f.cleanup(); }
});
