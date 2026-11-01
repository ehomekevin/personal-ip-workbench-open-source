import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startApplication } from '../../../../apps/service/src/bootstrap/application.ts';
import type { HostCapabilitiesResponse, ServiceConfiguration } from '../../../../packages/contracts/src/index.ts';
import { assertExternalVolume } from '../../../../scripts/probes/runtime/mount-guard.ts';

async function fixture() {
  const project = resolve(import.meta.dirname, '../../../..'); assertExternalVolume(project);
  const artifacts = join(project, '.ci-artifacts/D07-009'); mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, '.host-capabilities-'));
  const config: ServiceConfiguration = { workspace_id: randomUUID(), service_instance_id: randomUUID(), title: '构造宿主能力接口测试', mode: 'demo', timezone: 'America/Los_Angeles',
    paths: { source_vault_root: null, managed_notes_root: join(root, 'notes'), state_root: join(root, 'state'), media_root: join(root, 'media') }, listen: { host: '127.0.0.1', port: 4318 } };
  try {
    const app = await startApplication(config, { port: 0, executorHealth: async () => [] });
    const base = 'http://127.0.0.1:' + app.address.port;
    const headers = { 'X-Workspace-Id': config.workspace_id, 'X-Service-Instance-Id': config.service_instance_id };
    return { app, headers, get: (query = '', extra: Record<string, string> = {}) => fetch(base + '/api/v1/host-capabilities' + query, { headers: { ...headers, ...extra } }),
      async cleanup() { await app.close(); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

test('未接入宿主时返回空真实记录，不创建连接或虚构 supported', async () => {
  const f = await fixture(); try {
    const response = await f.get(); assert.equal(response.status, 200);
    const value = await response.json() as HostCapabilitiesResponse;
    assert.deepEqual(value, { identity: f.app.identity, connections: [], capabilities: [] });
    assert.equal(f.app.context.db.prepare('SELECT COUNT(*) AS n FROM host_connections').get()!.n, 0);
    assert.equal(f.app.context.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n, 0);
  } finally { await f.cleanup(); }
});

test('同入口不同版本及 Cowork 证据分别过滤，连接 owner 不返回', async () => {
  const f = await fixture(); try {
    const db = f.app.context.db, workspace = f.app.identity.workspace_id;
    for (const [surface, runtime, operation, status] of [
      ['claude_desktop_chat', 'test-runtime-old', 'ui_resource', 'supported'],
      ['claude_desktop_chat', 'test-runtime-new', 'ui_resource', 'unverified'],
      ['claude_cowork', 'test-runtime-new', 'ui_resource', 'unverified'],
    ]) {
      db.prepare('INSERT INTO host_capability_records(id,workspace_id,host_surface,runtime_version,connection_mode,operation,plugin_version,status,limitations,verified_at,evidence_ref,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), workspace, surface!, runtime!, 'local_stdio', operation!, '0.1.0', status!, JSON.stringify(['internal_rule 构造记录，非真实宿主证据']), null, 'internal-rule-fixture', 1);
      db.prepare('INSERT INTO host_connections(id,workspace_id,service_instance_id,host_surface,plugin_id,plugin_version,runtime_version,connection_mode,request_identity_ref,status) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), workspace, f.app.identity.service_instance_id, surface!, 'personal-ip-workbench', '0.1.0', runtime!, 'local_stdio', 'private-owner-not-for-model', 'connected');
    }
    const response = await f.get('?host_surface=claude_desktop_chat&runtime_version=test-runtime-new&connection_mode=local_stdio&plugin_version=0.1.0');
    assert.equal(response.status, 200); const body = await response.json() as HostCapabilitiesResponse;
    assert.equal(body.connections.length, 1); assert.equal(body.capabilities.length, 1);
    assert.equal(body.capabilities[0]!.status, 'unverified'); assert.equal(body.capabilities[0]!.host_surface, 'claude_desktop_chat');
    assert.deepEqual(body.capabilities[0]!.limitations, ['internal_rule 构造记录，非真实宿主证据']);
    assert.equal(JSON.stringify(body).includes('private-owner-not-for-model'), false);
    assert.deepEqual((await (await f.get('?runtime_version=%27%20OR%201%3D1--')).json() as HostCapabilitiesResponse).capabilities, []);
  } finally { await f.cleanup(); }
});

test('错误工作区和服务被拒绝，未知或重复过滤条件不扩大查询', async () => {
  const f = await fixture(); try {
    for (const extra of [{ 'X-Workspace-Id': randomUUID() }, { 'X-Service-Instance-Id': randomUUID() }] as Record<string,string>[]) {
      const response = await f.get('', extra); assert.equal(response.status, 409);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'WORKSPACE_INSTANCE_MISMATCH');
    }
    for (const query of ['?unknown=1', '?host_surface=claude_code&host_surface=claude_cowork', '?host_surface=made_up_surface', '?runtime_version=']) {
      const response = await f.get(query); assert.equal(response.status, 400);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
    }
  } finally { await f.cleanup(); }
});
