import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ApplyPublishingConnectionSchema, CheckPublishingConnectionSchema, CreatePublishingConnectionSchema,
  PatchPublishingConnectionSchema, SetDefaultPublishingAccountSchema, SetPublishingConnectionEnabledSchema,
  PublishingSettingsLocationSchema, PUBLISHING_SETTINGS_RESPONSE_SCHEMAS, assertPublishingAccountEligibility,
  API_RESOURCES, ContractError, PatchSettingsSchema, type RuntimeSchema,
} from '../../packages/contracts/src/index.ts';
import { createRouteRegistry } from '../../apps/service/src/routes/index.ts';

const credential = { kind: 'environment', name: 'WORKBENCH_X_TOKEN' };
const create = { expected_version: 1, account_id: 'owner-x', platform: 'x', route: 'x_v2', credential_ref: credential };
const validation = (error: unknown): boolean => error instanceof ContractError && error.code === 'VALIDATION_ERROR';

test('发布配置白名单拒绝原始秘密、任意路径与手动能力证据，错误不回显输入值', () => {
  assert.deepEqual(CreatePublishingConnectionSchema.parse(create), create);
  for (const key of ['token', 'headers', 'url', 'config_path', 'capabilities', 'enabled', 'adapter_version']) {
    const value = { ...create, [key]: 'PRIVATE_SENTINEL' };
    assert.throws(() => CreatePublishingConnectionSchema.parse(value), (error: unknown) => {
      assert.ok(validation(error)); assert.ok(!JSON.stringify(error).includes('PRIVATE_SENTINEL')); return true;
    });
  }
  for (const ref of ['PRIVATE_SENTINEL', { kind: 'environment', name: 'WORKBENCH_X_TOKEN', value: 'PRIVATE_SENTINEL' }, { kind: 'file', name: '/private/token' }])
    assert.throws(() => PatchPublishingConnectionSchema.parse({ expected_version: 1, credential_ref: ref }), validation);
});

test('发布设置边界拒绝原型继承字段和 JSON 特殊键，嵌套引用不能藏未知值', () => {
  for (const key of ['__proto__', 'constructor', 'toString']) {
    const root = JSON.parse(JSON.stringify(Object.fromEntries([...Object.entries(create), [key, 'PRIVATE_SENTINEL']])));
    assert.throws(() => CreatePublishingConnectionSchema.parse(root), validation);
    const nested = JSON.parse(JSON.stringify(create));
    nested.credential_ref = JSON.parse(JSON.stringify(Object.fromEntries([...Object.entries(credential), [key, 'PRIVATE_SENTINEL']])));
    assert.throws(() => CreatePublishingConnectionSchema.parse(nested), validation);
  }
  const inherited = Object.assign(Object.create({ expected_version: 1 }), { account_id: 'owner-x', platform: 'x', route: 'x_v2', credential_ref: null });
  assert.throws(() => CreatePublishingConnectionSchema.parse(inherited), validation);
});

test('连接与默认偏好每项修改均要求有效乐观版本', () => {
  const cases: [RuntimeSchema<unknown>, Record<string, unknown>][] = [
    [CreatePublishingConnectionSchema, create], [PatchPublishingConnectionSchema, { credential_ref: null }],
    [ApplyPublishingConnectionSchema, {}], [CheckPublishingConnectionSchema, {}],
    [SetPublishingConnectionEnabledSchema, { enabled: false }],
    [SetDefaultPublishingAccountSchema, { platform: 'x', format: 'thread', account_id: null }],
  ];
  for (const [schema, input] of cases) {
    for (const version of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])
      assert.throws(() => schema.parse({ ...input, expected_version: version }), validation);
    assert.equal((schema.parse({ ...input, expected_version: 2 }) as { expected_version: number }).expected_version, 2);
  }
});

test('环境引用仅允许名称或显式清空；引用语法不接受 URL、token 及控制字符', () => {
  assert.equal(PatchPublishingConnectionSchema.parse({ expected_version: 1, credential_ref: null }).credential_ref, null);
  for (const name of ['', ' sk-secret', 'sk-secret', 'https://example.test/token', '/private/token', 'TOKEN\n', 'TOKEN\u007f', 'A'.repeat(129)])
    assert.throws(() => PatchPublishingConnectionSchema.parse({ expected_version: 1, credential_ref: { kind: 'environment', name } }), validation);
  for (const account_id of ['', ' ', 'account\n', 'A'.repeat(201)])
    assert.throws(() => CreatePublishingConnectionSchema.parse({ ...create, account_id }), validation);
});

test('三条发布路线的账号平台必须一致；两个未开放平台不能配置占位路线', () => {
  for (const value of [{ ...create, platform: 'wechat' }, { ...create, platform: 'xiaohongshu' }, { ...create, platform: 'bilibili' }, { ...create, route: 'bilibili_stub' }])
    assert.throws(() => CreatePublishingConnectionSchema.parse(value), validation);
  assert.equal(CreatePublishingConnectionSchema.parse({ ...create, platform: 'wechat', route: 'wechat_official' }).route, 'wechat_official');
  assert.equal(CreatePublishingConnectionSchema.parse({ ...create, platform: 'douyin', route: 'douyin_open' }).route, 'douyin_open');
});

test('账号范围规则拒绝对标、未确认、另一工作区及错平台账号，不证明实际 SQL 已接线', () => {
  const account = { workspace_id: 'w', platform: 'x' as const, role: 'owner' as const, identity_status: 'confirmed', platform_account_id: '123' };
  assert.doesNotThrow(() => assertPublishingAccountEligibility(account, 'w', 'x'));
  for (const value of [null, { ...account, workspace_id: 'other' }])
    assert.throws(() => assertPublishingAccountEligibility(value, 'w', 'x'), (error: unknown) => error instanceof ContractError && error.code === 'NOT_FOUND');
  for (const value of [{ ...account, role: 'benchmark' as const }, { ...account, identity_status: 'pending' }, { ...account, platform_account_id: null }, { ...account, platform_account_id: ' ' }])
    assert.throws(() => assertPublishingAccountEligibility(value, 'w', 'x'), (error: unknown) => error instanceof ContractError && error.code === 'CAPABILITY_UNVERIFIED');
  assert.throws(() => assertPublishingAccountEligibility(account, 'w', 'wechat'), validation);
});

test('默认账号按平台和形式约束，并能显式清除；启停只接受独立布尔偏好', () => {
  for (const [platform, format] of [['x', 'thread'], ['wechat', 'article'], ['douyin', 'short_video'], ['xiaohongshu', 'image_post'], ['bilibili', 'long_video']])
    assert.equal(SetDefaultPublishingAccountSchema.parse({ expected_version: 1, platform, format, account_id: null }).account_id, null);
  assert.throws(() => SetDefaultPublishingAccountSchema.parse({ expected_version: 1, platform: 'x', format: 'article', account_id: 'owner-x' }), validation);
  assert.throws(() => SetDefaultPublishingAccountSchema.parse({ expected_version: 1, platform: 'wechat', format: 'short_video', account_id: null }), validation);
  assert.equal(SetPublishingConnectionEnabledSchema.parse({ expected_version: 1, enabled: false }).enabled, false);
  for (const enabled of ['true', 1, null]) assert.throws(() => SetPublishingConnectionEnabledSchema.parse({ expected_version: 1, enabled }), validation);
});

test('只读检查和生效不接受发布动作、任意目标或可写能力', () => {
  for (const schema of [CheckPublishingConnectionSchema, ApplyPublishingConnectionSchema]) {
    assert.deepEqual(schema.parse({ expected_version: 1 }), { expected_version: 1 });
    for (const key of ['submit', 'upload', 'draft', 'url', 'account_id', 'status', 'capabilities', 'credential_ref'])
      assert.throws(() => schema.parse({ expected_version: 1, [key]: 'PRIVATE_SENTINEL' }), validation);
  }
  assert.throws(() => PatchSettingsSchema.parse({ expected_version: 1, publishing_connections: [create] }), validation);
});

test('共用定位只接受设置子页及合法平台，不声明实际宿主工具已接收', () => {
  const location = { page: 'settings', settings_view: 'publishing', platform: 'x', account_id: 'owner-x' };
  assert.deepEqual(PublishingSettingsLocationSchema.parse(location), location);
  for (const patch of [{ page: 'create' }, { settings_view: 'unknown' }, { platform: 'unknown' }, { url: 'https://example.test' }])
    assert.throws(() => PublishingSettingsLocationSchema.parse({ ...location, ...patch }), validation);
});

test('OpenAPI 采用同一输入定义和完整读 DTO，已接线写入的幂等头必填', () => {
  const api = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
  const schemas = {
    CreatePublishingConnectionRequest: CreatePublishingConnectionSchema, PatchPublishingConnectionRequest: PatchPublishingConnectionSchema,
    ApplyPublishingConnectionRequest: ApplyPublishingConnectionSchema, CheckPublishingConnectionRequest: CheckPublishingConnectionSchema,
    SetPublishingConnectionEnabledRequest: SetPublishingConnectionEnabledSchema, SetDefaultPublishingAccountRequest: SetDefaultPublishingAccountSchema,
  };
  for (const [name, schema] of Object.entries(schemas)) assert.deepEqual(api.components.schemas[name], schema.jsonSchema);
  for (const [name, schema] of Object.entries(PUBLISHING_SETTINGS_RESPONSE_SCHEMAS)) assert.deepEqual(api.components.schemas[name], schema);
  const resources = API_RESOURCES.filter(item => item.path.startsWith('/api/v1/settings/publishing'));
  assert.equal(resources.length, 7);
  for (const resource of resources) {
    const operation = api.paths[resource.path][resource.method.toLowerCase()];
    assert.equal(operation['x-resource-status'], 'registered_internal');
    assert.equal(operation['x-response-schema-status'], 'dto_exported');
    assert.ok(operation.responses['200'].content['application/json'].schema.$ref);
    if (resource.method !== 'GET') {
      assert.equal(operation.parameters.find((p: { name: string }) => p.name === 'Idempotency-Key').required, true);
      assert.ok(operation.requestBody.content['application/json'].schema.$ref);
    }
  }
  assert.equal(api.components.schemas.PublishingSettingsResponse.properties.config_source.const, 'sqlite');
  assert.equal(api.components.schemas.PublishingConnectionCheck.properties.readonly.const, true);
  assert.equal(api.components.schemas.PublishingOperationCapability.allOf[0].then.properties.evidence_kind.const, 'real_platform');
  assert.equal(CreatePublishingConnectionSchema.jsonSchema.allOf instanceof Array, true);
  assert.equal(SetDefaultPublishingAccountSchema.jsonSchema.allOf instanceof Array, true);
});

test('缺少模块时保留受阻 handler，不返回假配置或触发平台副作用', async () => {
  const registry = createRouteRegistry([]);
  for (const resource of API_RESOURCES.filter(item => item.path.startsWith('/api/v1/settings/publishing'))) {
    const route = registry.routes.find(item => item.definition.path === resource.path && item.definition.method === resource.method)!.definition;
    await assert.rejects(async () => route.handle({} as never), (error: unknown) => error instanceof ContractError && error.code === 'CAPABILITY_UNVERIFIED');
  }
});
