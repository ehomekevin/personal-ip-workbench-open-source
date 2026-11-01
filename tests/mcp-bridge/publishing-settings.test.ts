import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, ContractError, OpenWorkbenchSchema, workbenchLocationHash, type JsonObject, type PublishingConnectionView, type PublishingSettingsResponse } from '../../packages/contracts/src/index.ts';
import { MCP_TOOL_INVENTORY, WORKBENCH_TOOL_ROUTES, resolveWorkbenchRoute, routeRequest, OPEN_WORKBENCH_SCHEMA } from '../../packages/host-bridge/src/core/tools.ts';
import { parseWorkbenchLocation, locationFromToolResult } from '../../apps/web/src/transport/workbench-location.ts';
import { fixture, call } from './harness.ts';

test('七项发布设置经固定 MCP mapper 保留版本和幂等键，拒绝秘密和只读检查写入字段', () => {
  const cases = [
    ['GET', '/api/v1/settings/publishing', undefined, 'get_publishing_settings'],
    ['POST', '/api/v1/settings/publishing/connections', { expected_version: 1, account_id: 'owner-x', platform: 'x', route: 'x_v2', credential_ref: null }, 'create_publishing_connection'],
    ['PATCH', '/api/v1/settings/publishing/connections/connection-x', { expected_version: 2, credential_ref: null }, 'patch_publishing_connection'],
    ['POST', '/api/v1/settings/publishing/connections/connection-x/apply', { expected_version: 2 }, 'apply_publishing_connection'],
    ['POST', '/api/v1/settings/publishing/connections/connection-x/check', { expected_version: 2 }, 'check_publishing_connection'],
    ['PUT', '/api/v1/settings/publishing/connections/connection-x/enabled', { expected_version: 2, enabled: false }, 'set_publishing_connection_enabled'],
    ['PUT', '/api/v1/settings/publishing/defaults', { expected_version: 2, platform: 'x', format: 'thread', account_id: null }, 'set_default_publishing_account'],
  ] as const;
  for (const [method, path, body, name] of cases) {
    const mapped = resolveWorkbenchRoute(method, path, body, { idempotencyKey: 'fixed-key' });
    assert.equal(mapped.name, name);
    const route = WORKBENCH_TOOL_ROUTES.find(route => route.name === name)!;
    const request = routeRequest(route, mapped.input); assert.equal(request.path, path); assert.deepEqual(request.body, body);
    if (method !== 'GET') { assert.equal(request.idempotencyKey, 'fixed-key'); assert.equal(mapped.input.expected_version, body!.expected_version); }
    assert.equal(MCP_TOOL_INVENTORY.find(tool => tool.name === name)!.annotations.readOnlyHint, method === 'GET');
  }
  for (const body of [{ expected_version: 1, token: 'PRIVATE_SENTINEL' }, { expected_version: 1, submit: true }, { expected_version: 1, credential_ref: null }, { expected_version: 1, url: 'https://example.test' }])
    assert.throws(() => resolveWorkbenchRoute('POST', '/api/v1/settings/publishing/connections/c/check', body), e => e instanceof ContractError && e.code === 'VALIDATION_ERROR' && !JSON.stringify(e).includes('PRIVATE_SENTINEL'));
});

test('共享宿主和 Web 定位严格组合校验，五平台、编码账号及既有主题版本路由往返一致', () => {
  assert.equal(OPEN_WORKBENCH_SCHEMA, OpenWorkbenchSchema);
  for (const platform of ['xiaohongshu', 'wechat', 'x', 'douyin', 'bilibili']) {
    const location = OpenWorkbenchSchema.parse({ page: 'settings', settings_view: 'publishing', platform, account_id: 'owner:中文/x' });
    assert.deepEqual(parseWorkbenchLocation(workbenchLocationHash(location)), location);
  }
  const old = { page: 'create' as const, topic_id: 'topic-one', variant_id: 'variant-one' };
  assert.deepEqual(parseWorkbenchLocation(workbenchLocationHash(old)), old);
  for (const input of [{ page: 'settings', platform: 'x' }, { page: 'create', settings_view: 'publishing', platform: 'x' }, { page: 'settings', account_id: 'owner-x' }, { page: 'settings', settings_view: 'publishing' }, { page: 'settings', settings_view: 'publishing', platform: 'x', topic_id: 't' }, { page: 'settings', settings_view: 'publishing', platform: 'x', variant_id: 'v' }, JSON.parse('{"page":"settings","constructor":"private"}'), Object.assign(Object.create({ page: 'settings' }), { settings_view: 'publishing', platform: 'x' })])
    assert.throws(() => OpenWorkbenchSchema.parse(input), e => e instanceof ContractError && e.code === 'VALIDATION_ERROR');
  const identity = { workspace_id: 'w', service_instance_id: 's', contract_version: CONTRACT_VERSION };
  const location = { page: 'settings' as const, settings_view: 'publishing' as const, platform: 'x' as const, account_id: 'a' };
  const result = { structuredContent: { identity, data: { resource_uri: 'ui://personal-ip-workbench/0.1.0.html', location } } };
  assert.deepEqual(locationFromToolResult(result, identity), location);
  assert.equal(locationFromToolResult(result, { ...identity, service_instance_id: 'other' }), null);
  assert.equal(locationFromToolResult({ ...result, isError: true }, identity), null);
  assert.equal(locationFromToolResult({ structuredContent: { ...result.structuredContent, identity: { ...identity, contract_version: 'obsolete' } } }), null);
});

test('两个实际 stdio MCP 入口与唯一 HTTP SQLite 配置共享冲突、重放和原子保存，open_workbench保留发布定位', async () => {
  const previous = process.env.WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON;
  process.env.WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON = '["PSET_MCP_MISSING"]';
  const f = await fixture();
  try {
    const accountId = randomUUID(), second = randomUUID();
    for (const [id, role] of [[accountId, 'owner'], [second, 'benchmark']]) f.app.context.db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'x',?,?,?,?,'confirmed')").run(id!, f.config.workspace_id, 'platform-' + id, role!, 'PSET MCP isolated account', 'https://x.com/' + id);
    const a = await f.connect({ web_url: 'http://127.0.0.1:9999/' }), b = await f.connect();
    const initial = (await call(a, 'get_publishing_settings')).data as unknown as PublishingSettingsResponse;
    assert.equal(initial.version, 1); assert.deepEqual(initial.accounts.map(a => a.account_id), [accountId]); assert.equal(initial.credential_references[0]!.name, 'PSET_MCP_MISSING');
    const create: JsonObject = { expected_version: 1, platform: 'x', account_id: accountId, route: 'x_v2', credential_ref: { kind: 'environment', name: 'PSET_MCP_MISSING' }, idempotency_key: 'pset-create' };
    const created = await call(a, 'create_publishing_connection', create); assert.equal(created.result.isError, undefined);
    const c = created.data.connection as unknown as PublishingConnectionView; assert.equal(c.enabled, false); assert.equal(c.config_revision, 1); assert.equal(c.runtime.credentials_ready, false);
    const replay = await call(b, 'create_publishing_connection', create); assert.deepEqual(replay.data, created.data);
    const changed = await call(b, 'patch_publishing_connection', { id: c.id, expected_version: c.version, credential_ref: null, idempotency_key: 'pset-patch' }); assert.equal(changed.result.isError, undefined);
    const latest = changed.data.connection as unknown as PublishingConnectionView;
    assert.equal((await call(a, 'patch_publishing_connection', { id: c.id, expected_version: c.version, credential_ref: null, idempotency_key: 'pset-conflict' })).error?.code, 'VERSION_CONFLICT');
    assert.deepEqual((await call(a, 'create_publishing_connection', create)).data, created.data, '旧幂等键先重放，不被新aggregate版本阻断');
    const apply = await call(a, 'apply_publishing_connection', { id: c.id, expected_version: latest.version, idempotency_key: 'pset-apply' }); assert.equal(apply.result.isError, undefined); assert.equal((apply.data.connection as unknown as PublishingConnectionView).runtime.error_code, 'AUTH_REQUIRED');
    const checked = await call(b, 'check_publishing_connection', { id: c.id, expected_version: latest.version, idempotency_key: 'pset-check' }); assert.equal(checked.result.isError, undefined); assert.equal((checked.data.check as JsonObject).readonly, true); assert.equal(checked.data.applied_to_current, true);
    const beforeDefault = (await call(a, 'get_publishing_settings')).data as unknown as PublishingSettingsResponse;
    const preferred = await call(a, 'set_default_publishing_account', { expected_version: beforeDefault.version, platform: 'x', format: 'thread', account_id: accountId, idempotency_key: 'pset-default' }); assert.equal(preferred.result.isError, undefined);
    const stopped = await call(b, 'set_publishing_connection_enabled', { id: c.id, expected_version: latest.version, enabled: false, idempotency_key: 'pset-stop' }); assert.equal(stopped.result.isError, undefined);
    const location: JsonObject = { page: 'settings', settings_view: 'publishing', platform: 'x', account_id: accountId };
    const opened = await call(a, 'open_workbench', location); assert.equal(opened.result.isError, undefined); assert.deepEqual(opened.data.location, location); assert.equal(opened.data.account_id, accountId); assert.equal(opened.data.standalone_url, 'http://127.0.0.1:9999/?mode=real#settings/publishing/x/' + accountId);
    assert.equal((await call(a, 'open_workbench', { ...location, platform: 'wechat' })).error?.code, 'NOT_FOUND');
    assert.equal((await call(a, 'open_workbench', { ...location, account_id: second })).error?.code, 'NOT_FOUND');
    assert.equal((await call(a, 'open_workbench', { page: 'settings', account_id: accountId })).error?.code, 'VALIDATION_ERROR');
    const current = (await call(b, 'get_publishing_settings')).data as unknown as PublishingSettingsResponse;
    assert.equal(current.connections[0]!.runtime.state, 'apply_failed'); assert.equal(current.connections[0]!.config_revision, 2); assert.equal(current.connections[0]!.capabilities.some(capability => capability.status === 'supported'), false);
    assert.equal(JSON.stringify(current).includes('PRIVATE_SENTINEL'), false);
    await f.restart(); assert.deepEqual((await call(a, 'get_publishing_settings')).data, current as unknown as JsonObject);
  } finally { await f.cleanup(); if (previous === undefined) delete process.env.WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON; else process.env.WORKBENCH_PUBLISHER_CREDENTIAL_REFS_JSON = previous; }
});
