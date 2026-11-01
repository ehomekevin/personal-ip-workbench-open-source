import { test, expect, identity, headers, runtime } from './fixtures.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

test('真实 HTTP 文稿保存、旧 key 重放和主服务重启保护已提交版本', async ({ request }) => {
  const id = await identity(request);
  const created = await request.post('/api/v1/documents', { headers: headers(id), data: { kind: 'wiki', initial_text: '' } }); expect(created.status()).toBe(201);
  const document = await created.json(), path = `/api/v1/documents/${document.document_id}/revisions`, key = randomUUID();
  const input = { expected_revision_id: document.head_revision_id, text: '真实 HTTP 保存的人工稿', origin: 'human' };
  const first = await request.post(path, { headers: headers(id, key), data: input }); expect(first.status()).toBe(201); const receipt = await first.json();
  const second = await request.post(path, { headers: headers(id), data: { ...input, expected_revision_id: receipt.revision_id, text: '下一版人工稿' } }); expect(second.status()).toBe(201); const secondReceipt = await second.json();
  expect((await request.post(path, { headers: headers(id), data: input })).status()).toBe(409);
  const boot = await runtime(request); const restart = await runtime(request, true); expect(restart.boot_id).not.toBe(boot.boot_id);
  const replay = await request.post(path, { headers: headers(id, key), data: input }); expect(replay.status()).toBe(201); expect(await replay.json()).toEqual(receipt);
  const recovered = await request.get(`/api/v1/documents/${document.document_id}`, { headers: headers(id) }); expect(recovered.status()).toBe(200); const snapshot = await recovered.json();
  expect(snapshot.text).toBe('下一版人工稿'); expect(snapshot.head_revision_id).toBe(secondReceipt.revision_id);
  expect((await request.get(`/api/v1/documents/${document.document_id}`, { headers: { ...headers(id), 'X-Workspace-Id': randomUUID() } })).status()).toBe(409);
});

test('跨本机端口由原共享客户端完成握手、读取和幂等 PATCH', async ({ page }) => {
  // 只去除实际客户端的类型标注，将原函数放进真实浏览器；不替换 fetch 或重写请求头。
  const source = readFileSync(new URL('../../apps/web/src/transport/workbench-client.ts', import.meta.url), 'utf8');
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64');
  await page.goto('/?mode=demo&page=settings');
  const result = await page.evaluate(async ({ moduleUrl, backend, key }) => {
    if (new URL(backend).origin === location.origin) throw new Error('此用例必须跨 Origin');
    const { createHttpClient } = await import(moduleUrl);
    const client = createHttpClient(backend);
    const identity = await client.identity(); const before = await client.getSettings();
    const input = { expected_version: before.version, default_executor: before.default_executor === 'codex' ? 'claude' : 'codex' };
    const saved = await client.patchSettings(input, { idempotencyKey: key });
    const replay = await client.patchSettings(input, { idempotencyKey: key });
    const after = await client.getSettings();
    return { identity, before, saved, replay, after, expectedExecutor: input.default_executor };
  }, { moduleUrl, backend: process.env.WORKBENCH_E2E_BACKEND_URL!, key: randomUUID() });
  expect(result.saved.version).toBe(result.before.version + 1);
  expect(result.saved.default_executor).toBe(result.expectedExecutor);
  expect(result.replay).toEqual(result.saved);
  expect(result.after).toEqual(result.saved);
});
