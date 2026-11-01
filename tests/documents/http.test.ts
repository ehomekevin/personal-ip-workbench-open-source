import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { startApplication, type RunningApplication } from '../../apps/service/src/bootstrap/application.ts';
import type { DocumentSnapshot, SaveRevisionResponse, TopicDetail } from '../../packages/contracts/src/index.ts';
import { fixture, writeEvidence } from './harness.ts';

test('real service document response loss, guarded retry and preparation HTTP persist across restart', async () => {
  const f = fixture(); let app: RunningApplication | undefined;
  try {
    f.closeDb(); app = await startApplication(f.config, { port: 0 });
    const headers = { 'x-workspace-id': f.config.workspace_id, 'x-service-instance-id': f.config.service_instance_id, 'content-type': 'application/json' };
    const url = () => `http://127.0.0.1:${app!.address.port}`;
    const call = async (path: string, method = 'GET', body?: unknown, key: string = randomUUID()) => {
      const response = await fetch(`${url()}${path}`, { method, headers: { ...headers, 'idempotency-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const created = await call('/api/v1/documents', 'POST', { kind: 'wiki', initial_text: '' }); assert.equal(created.status, 201);
    const document = created.value as DocumentSnapshot; const path = `/api/v1/documents/${document.document_id}/revisions`;
    const original = { expected_revision_id: document.head_revision_id, text: '实际HTTP保存正文', origin: 'human' }; const key = 'lost-save-body';
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${url()}${path}`, { method: 'POST', headers: { ...headers, 'idempotency-key': key } });
      request.once('error', reject); request.once('response', response => { assert.equal(response.statusCode, 201); response.destroy(); resolve(); });
      request.end(JSON.stringify(original));
    });
    const persisted = (await call(`/api/v1/documents/${document.document_id}`)).value as DocumentSnapshot; assert.equal(persisted.text, original.text);
    const receipt = JSON.parse(String(app.context.db.prepare('SELECT response FROM idempotency_requests WHERE workspace_id=? AND key=?').get(f.config.workspace_id, key)?.response)) as SaveRevisionResponse;
    assert.equal(receipt.revision_id, persisted.head_revision_id);
    const later = await call(path, 'POST', { expected_revision_id: receipt.revision_id, text: '后续HTTP人工修改', origin: 'human' }); assert.equal(later.status, 201);
    assert.deepEqual((await call(path, 'POST', original, key)).value, receipt);
    assert.equal((await call(path, 'POST', { ...original, text: '不应复用key' }, key)).status, 409);
    assert.equal((await call(path, 'POST', original)).status, 409);
    const wrong = await fetch(`${url()}/api/v1/documents/${document.document_id}`, { headers: { ...headers, 'x-workspace-id': randomUUID() } }); assert.equal(wrong.status, 409); await wrong.json();
    const topicInput = { title: 'HTTP无平台主题', category: 'AI实测', audience: '', source_ids: [] }; const topicKey = 'topic-original-response';
    const topicCreated = await call('/api/v1/topics', 'POST', topicInput, topicKey); assert.equal(topicCreated.status, 201); const topic = topicCreated.value as TopicDetail;
    const preparation = (await call(`/api/v1/production-plans/${topic.preparation_plan_id}`)).value as { version: number; head_plan_revision_id: string };
    const ensureInput = { scope: 'topic_preparation', topic_id: topic.id, shots: [] }; const ensureKey = 'ensure-existing';
    const ensured = await call('/api/v1/production-plans', 'POST', ensureInput, ensureKey); assert.equal(ensured.status, 200);
    const shots = [{ shot_key: 'actual', position: 0, title: '可刷新镜头', kind: 'live_action', duration_ms: 1234, source_requirement: { status: 'pending' } }];
    const revised = await call(`/api/v1/production-plans/${topic.preparation_plan_id}`, 'PATCH', { expected_version: preparation.version, base_plan_revision_id: preparation.head_plan_revision_id, shots }); assert.equal(revised.status, 200);
    assert.deepEqual((await call('/api/v1/topics', 'POST', topicInput, topicKey)).value, topicCreated.value);
    assert.deepEqual((await call('/api/v1/production-plans', 'POST', ensureInput, ensureKey)).value, ensured.value);
    assert.equal((await call('/api/v1/production-plans', 'POST', { ...ensureInput, shots }, ensureKey)).status, 409);
    assert.equal((await call(`/api/v1/production-plans/${topic.preparation_plan_id}`, 'PATCH', { expected_version: 2, base_plan_revision_id: revised.value.plan_revision_id, shots: [null] })).status, 400);
    assert.equal((await call(`/api/v1/production-plans/${topic.preparation_plan_id}/renders`, 'POST', {})).status, 400);
    const boot = app.boot_id; await app.close(); app = await startApplication(f.config, { port: 0 }); assert.notEqual(app.boot_id, boot);
    const recoveredTopic = (await call(`/api/v1/topics/${topic.id}`)).value as TopicDetail;
    assert.equal(recoveredTopic.variants.length, 0); assert.equal(recoveredTopic.core_approval, null); assert.equal(recoveredTopic.shots[0]?.duration_ms, 1234);
    assert.deepEqual((await call(path, 'POST', original, key)).value, receipt);
    writeEvidence('http-storage.json', { evidence_scope: 'internal_rule', result: 'passed', observed_at: new Date().toISOString(),
      actual_http_service: true, transport_response_body_discarded: true, original_save_receipt_replayed_after_later_edit_and_restart: true,
      changed_input_key_conflict: 409, stale_new_request_conflict: 409, wrong_workspace_rejected: 409,
      topic_original_response_replayed_after_plan_edit: true, preparation_unique_ensure_idempotent: true, invalid_shot: 400, preparation_render_refused: 400,
      persisted_preparation_duration_ms: 1234, source_vault_root: null, ui_fidelity: 'not_run', real_executor: 'not_run' });
  } finally { await app?.close(); f.cleanup(); }
});
