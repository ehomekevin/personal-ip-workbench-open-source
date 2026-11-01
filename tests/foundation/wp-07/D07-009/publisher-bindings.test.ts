import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startApplication } from '../../../../apps/service/src/bootstrap/application.ts';
import { loadPublisherBindings } from '../../../../apps/service/src/bootstrap/publishers.ts';
import { X_PUBLISHER_VERSION } from '../../../../packages/adapters/src/publishers/x/index.ts';
import type { ServiceConfiguration } from '../../../../packages/contracts/src/index.ts';
import { assertExternalVolume } from '../../../../scripts/probes/runtime/mount-guard.ts';

async function fixture() {
  const project = resolve(import.meta.dirname, '../../../..'); assertExternalVolume(project);
  const artifacts = join(project, '.ci-artifacts/D07-009'); mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, '.publisher-bindings-'));
  const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: '发布配置准入内部测试', mode: 'demo', timezone: 'America/Los_Angeles',
    paths: { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') }, listen: { host: '127.0.0.1', port: 4318 } };
  const app = await startApplication(config, { port: 0, executorHealth: async () => [] });
  const id = randomUUID(), file = join(root, 'publishers.json');
  app.context.db.prepare("INSERT INTO accounts(id,workspace_id,platform,platform_account_id,role,name,canonical_url,identity_status) VALUES (?,?,'x','internal-fixture-account','owner','内部账号','https://x.com/internal-fixture-account','confirmed')").run(id, config.workspace_id);
  const entry = { platform: 'x', adapter_version: X_PUBLISHER_VERSION, credential_env: 'WORKBENCH_INTERNAL_TEST_TOKEN',
    account: { account_id: id, platform_account_id: 'internal-fixture-account', format: 'text', host_id: 'internal-fixture-host', identity_evidence_ref: 'internal-rule-account-fixture' },
    capabilities: ['prepareDraft', 'submit', 'queryResult'].map(operation => ({ operation, status: 'unverified', evidence_kind: 'internal_rule', evidence_ref: null, verified_at: null })) };
  const value = { config_version: 1, identity: { ...app.identity }, publishers: [entry] };
  const save = () => writeFileSync(file, JSON.stringify(value));
  return { app, entry, value, file, save, async cleanup() { await app.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('默认不装配发布绑定；未验证配置不读取凭据且没有网络调用', async () => {
  const f = await fixture(); try {
    assert.deepEqual(loadPublisherBindings(f.app.context, ''), []);
    f.save(); const bindings = loadPublisherBindings(f.app.context, f.file);
    assert.equal(bindings.length, 1); assert.equal(bindings[0]!.supported, false);
    assert.deepEqual((await bindings[0]!.adapter.describe()).map(c => c.status), ['unverified', 'unverified', 'unverified']);
    assert.equal(f.app.context.db.prepare('SELECT COUNT(*) AS n FROM publication_intents').get()!.n, 0);
    assert.equal(f.app.context.db.prepare('SELECT COUNT(*) AS n FROM works').get()!.n, 0);
  } finally { await f.cleanup(); }
});

test('拒绝错服务、旧版本、重复配置、未知平台和未确认账号', async () => {
  const f = await fixture(); try {
    const original = structuredClone(f.value);
    for (const mutate of [
      () => { f.value.identity.service_instance_id = randomUUID() as typeof f.value.identity.service_instance_id; },
      () => { f.entry.adapter_version = 'outdated'; },
      () => { f.value.publishers.push(f.entry); },
      () => { f.entry.platform = 'bilibili'; },
      () => { f.entry.account.platform_account_id = 'different-account'; },
    ]) {
      mutate(); f.save(); assert.throws(() => loadPublisherBindings(f.app.context, f.file));
      Object.assign(f.entry, structuredClone(original.publishers[0])); Object.assign(f.value, structuredClone(original)); f.value.publishers = [f.entry];
    }
    f.app.context.db.prepare("UPDATE accounts SET identity_status='unconfirmed' WHERE id=?").run(f.entry.account.account_id);
    f.save(); assert.throws(() => loadPublisherBindings(f.app.context, f.file), { code: 'CAPABILITY_UNVERIFIED' });
  } finally { await f.cleanup(); }
});

test('内部模拟的 supported、明文 token、缺少操作和未知字段不能启用真实发布', async () => {
  const f = await fixture(); try {
    const original = structuredClone(f.value);
    for (const mutate of [
      () => { f.entry.capabilities[0]!.status = 'supported'; },
      () => { Object.assign(f.entry, { access_token: 'never-a-user-token' }); },
      () => { f.entry.capabilities.pop(); },
      () => { f.entry.credential_env = 'not-valid-env'; },
      () => { Object.assign(f.value.identity, { arbitrary: 'ignored-identity-is-invalid' }); },
    ]) {
      mutate(); f.save(); assert.throws(() => loadPublisherBindings(f.app.context, f.file));
      for (const key of Object.keys(f.entry)) delete (f.entry as unknown as Record<string, unknown>)[key];
      Object.assign(f.entry, structuredClone(original.publishers[0])); Object.assign(f.value, structuredClone(original)); f.value.publishers = [f.entry];
    }
    assert.throws(() => loadPublisherBindings(f.app.context, './relative-config.json'), { code: 'VALIDATION_ERROR' });
  } finally { await f.cleanup(); }
});
