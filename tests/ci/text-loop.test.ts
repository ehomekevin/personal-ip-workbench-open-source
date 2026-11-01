import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDate, weekStart, defaultScheduleTime } from '../../apps/web/src/features/schedule/calendar.ts';
import { createApprovedPageViews } from '../../apps/web/src/pages/approvedViews.ts';
import { emptyIngestView } from '../../apps/web/src/features/sources/read/index.ts';
import { initialUi } from '../../apps/web/src/app/view-model.ts';
import type { FeatureContext } from '../../apps/web/src/transport/feature-ports.ts';
import { createArticlePreparation, articlePlanInput } from '../../apps/web/src/features/schedule/article-preparation.ts';
import { createHttpClient } from '../../apps/web/src/transport/workbench-client.ts';
import type { TopicDetail } from '../../packages/contracts/src/index.ts';
import { TikHubAdapter } from '../../packages/adapters/src/tikhub/index.ts';

test('工作区周历跨年、周偏移和夏令时使用当地日期，拒绝无效日期', () => {
  assert.equal(weekStart('2027-01-01').toISOString().slice(0, 10), '2026-12-28');
  assert.equal(weekStart('2027-01-01', 1).toISOString().slice(0, 10), '2027-01-04');
  assert.equal(weekStart('2026-11-01').toISOString().slice(0, 10), '2026-10-26');
  assert.throws(() => calendarDate('2026-02-30'));
  // UTC已到次日，当地仍是前一天；跨夏令时的下一小时须从真实瞬时计算。
  assert.equal(defaultScheduleTime('2026-10-12', 'America/Los_Angeles', undefined, Date.parse('2026-10-13T01:00:00Z')), '2026-10-12T20:00');
  assert.equal(defaultScheduleTime('2026-10-12', 'America/Los_Angeles', undefined, Date.parse('2026-10-13T04:30:00Z')), '2026-10-12T22:30');
  assert.equal(defaultScheduleTime('2026-10-12', 'America/Los_Angeles', '2026-10-15'), '2026-10-15T20:00');
});

test('真实周历标记服务日期，记录链接和未知观察；demo继续固定原型日期', () => {
  const context = { ui: { ...initialUi('schedule') } } as FeatureContext, view = emptyIngestView(context);
  view.projections.schedule = { localDate: '2026-12-31', timezone: 'Asia/Shanghai' };
  view.state.publications = [{ id: 'p1', topic: '', platform: 'x', status: '已发布', at: '2026-12-31T12:00:00Z', workId: 'work1', collected: true, url: 'https://x.com/egg_2rich/status/123', snapshotCount: 2, observedSnapshotCount: 0 }];
  const html = createApprovedPageViews(view).schedule();
  assert.match(html, /12月 28 — 1月 3日/); assert.match(html, /day-col today.*?data-date="2026-12-31"/); assert.match(html, /href="https:\/\/x.com\/egg_2rich\/status\/123"/); assert.match(html, /观察时间明确 0 次/); assert.ok(!html.includes('示例快照')); assert.ok(!html.includes('示例记录'));
  view.provenance = 'demo'; assert.match(createApprovedPageViews(view).schedule(), /10月 5 — 11日/);
});

test('公众号先核对输入，拒绝过长标题与变更正文；只保存计划，不创建发布意图', async () => {
  const identity = { workspace_id: 'workspace', service_instance_id: 'service', contract_version: '0.1.1' } as const;
  const topic = { id: 'topic', title: '测试标题', core_approval: { approval_id: 'approval1' }, variants: [{ id: 'variant', platform: 'wechat', format: 'article', document_id: 'doc' }] } as unknown as TopicDetail;
  let revision = 'revision1'; const writes: Array<{path:string;body:unknown}> = [], dialogs: unknown[] = [];
  const client = createHttpClient('', identity, async (input, init) => {
    const path = String(input); let result: unknown;
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      if (path === '/api/v1/documents') result = { document_id: 'title-doc', head_revision_id: 'title-revision' };
      else if (path === '/api/v1/content-plans') result = { id: 'plan1' };
      else throw new Error('Unwanted write ' + path);
    } else if (path === '/api/v1/identity') result = identity;
    else if (path === '/api/v1/topics/topic') result = topic;
    else if (path === '/api/v1/documents/doc') result = { document_id: 'doc', head_revision_id: revision, text: '已保存的正文' };
    else if (path.startsWith('/api/v1/assets?')) result = { items: [{ id: 'cover', mime: 'image/png', status: 'ready', file_path: '/private/cover.png' }] };
    else if (path.includes('/content-plans')) result = { items: [] };
    else throw new Error('Unexpected read ' + path);
    return new Response(JSON.stringify(result));
  });
  const context = { client, identity, ui: { ...initialUi('schedule'), topic: 'topic' }, signal: new AbortController().signal, surface: { presentDialog: (value: unknown) => dialogs.push(value), closeDialog: () => {}, toast: () => {} } } as unknown as FeatureContext;
  const feature = createArticlePreparation(), open = { action: 'prepare-article', dataset: {}, fields: {} } as const;
  await feature.dispatch(open, context); assert.equal(writes.length, 0); assert.equal(dialogs.length, 1);
  const save = { action: 'save-article-plan', dataset: {}, fields: { 'article-title': '我自己的标题', 'article-cover': 'cover' } } as const;
  await assert.rejects(feature.dispatch({ ...save, fields: { ...save.fields, 'article-title': '长'.repeat(33) } }, context), /32 字/); assert.equal(writes.length, 0);
  revision = 'revision2'; await assert.rejects(feature.dispatch(save, context), /正文已变化/); assert.equal(writes.length, 0);
  revision = 'revision1'; await feature.dispatch(save, context);
  assert.deepEqual(writes.map(w => w.path), ['/api/v1/documents', '/api/v1/content-plans']);
  assert.deepEqual(writes[1]!.body, articlePlanInput('variant', 'revision1', 'title-revision', 'cover'));
});

test('TikHub凭据动态读取，响应中的密钥不进入原始记录；不推断观察时间', async () => {
  let key: string | null = null;
  const identity = { target_id: 'work1', platform: 'x', scope: 'work', platform_work_id: '123', account_id: 'account1', platform_account_id: '456', url: 'https://x.com/egg_2rich/status/123', published_at: null, role: 'owner' } as const;
  const adapter = new TikHubAdapter({ token_provider: () => key, targets: [{ ...identity, identity_evidence_ref: 'internal-identity', endpoint_key: 'x_post', params: { tweet_id: '123' }, metrics: [{ key: 'likes', path: 'data.likes', unit: 'count', kind: 'counter', definition_version: 'test/1', visibility: 'public', mapping_evidence_ref: 'internal-mapping' }], observation: { basis: 'unknown', evidence_ref: null } }], fetcher: async (_url, init) => { assert.equal((init!.headers as Record<string,string>).Authorization, 'Bearer PRIVATE_SENTINEL'); return new Response(JSON.stringify({ data: { likes: 9 }, token: key })); } });
  assert.equal(adapter.credentialPresent(), false); key = 'PRIVATE_SENTINEL'; assert.equal(adapter.credentialPresent(), true);
  const result = await adapter.collect(adapter.prepare(identity, 'request1'));
  assert.ok(!result.raw_body.includes('PRIVATE_SENTINEL')); assert.ok(result.raw_body.includes('REDACTED')); assert.equal(result.observation.observed_at, null); assert.equal(result.observation.metrics[0]!.value, '9');
});
