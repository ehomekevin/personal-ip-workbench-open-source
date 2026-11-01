import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import { startApplication, type RunningApplication } from '../../apps/service/src/bootstrap/application.ts';
import { Settings } from '../../packages/domain/src/settings/index.ts';
import { Topics } from '../../packages/domain/src/topics/index.ts';
import { fixture, writeEvidence } from './harness.ts';

test('actual multipart stream, immutable content hash, media path change and reference missing status', async () => {
  const f = fixture(); let app: RunningApplication | undefined;
  try {
    f.closeDb(); app = await startApplication(f.config, { port: 0 });
    const topic = await new Topics(app.context).create(f.request(), { title: '真实文件流测试', category: '', audience: '', source_ids: [] });
    const boundary = 'wp08-fixed-boundary'; const chunk = Buffer.alloc(256 * 1024, 91); const chunkCount = 64;
    const hash = createHash('sha256'); for (let i = 0; i < chunkCount; i++) hash.update(chunk); const expectedHash = hash.digest('hex');
    const body = async function* (different = false) {
      yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="topic_id"\r\n\r\n${topic.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n准备引用\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="actual.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      for (let i = 0; i < chunkCount; i++) yield different && i === 0 ? Buffer.alloc(chunk.length, 90) : chunk;
      yield Buffer.from(`\r\n--${boundary}--\r\n`);
    };
    const upload = async (key: string, different = false): Promise<{ status: number; value: { asset_id?: string; sha256?: string } }> => {
      const req = request({ hostname: '127.0.0.1', port: app!.address.port, path: '/api/v1/assets', method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-workspace-id': f.config.workspace_id,
          'x-service-instance-id': f.config.service_instance_id, 'idempotency-key': key } });
      const response = new Promise<{ status: number; value: { asset_id?: string; sha256?: string } }>((resolve, reject) => {
        req.on('error', reject); req.on('response', async res => { const chunks: Buffer[] = []; for await (const bytes of res) chunks.push(Buffer.from(bytes));
          resolve({ status: res.statusCode!, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); });
      });
      for await (const bytes of body(different)) if (!req.write(bytes)) await once(req, 'drain'); req.end(); return response;
    };
    const key = 'actual-large-upload'; const first = await upload(key); assert.equal(first.status, 201); assert.equal(first.value.sha256, expectedHash);
    const id = first.value.asset_id!; const row = app.context.db.prepare('SELECT file_path,size_bytes,duration_ms,dimensions FROM assets WHERE workspace_id=? AND id=?').get(f.config.workspace_id, id)!;
    assert.equal(row.size_bytes, chunk.length * chunkCount); assert.equal(row.duration_ms, null); assert.equal(row.dimensions, null);
    assert.equal(createHash('sha256').update(readFileSync(String(row.file_path))).digest('hex'), expectedHash);
    assert.deepEqual((await upload(key)).value, first.value); assert.equal((await upload(key, true)).status, 409);
    assert.equal(app.context.db.prepare('SELECT COUNT(*) AS n FROM assets WHERE workspace_id=?').get(f.config.workspace_id)?.n, 1);
    assert.deepEqual(readdirSync(join(f.config.paths.state_root, 'staging')), []);
    const settings = new Settings(app.context); const current = await settings.get(f.request()); const newMedia = join(f.root, 'new-media');
    await settings.patch(f.request(), { expected_version: current.version, paths: { media_root: newMedia } });
    const newer = await upload(randomUUID()); assert.equal(newer.status, 201);
    const newerRow = app.context.db.prepare('SELECT file_path FROM assets WHERE workspace_id=? AND id=?').get(f.config.workspace_id, newer.value.asset_id!);
    assert.ok(String(newerRow?.file_path).startsWith(newMedia)); assert.equal(existsSync(String(row.file_path)), true);
    const headers = { 'x-workspace-id': f.config.workspace_id, 'x-service-instance-id': f.config.service_instance_id };
    const url = () => `http://127.0.0.1:${app!.address.port}`;
    const downloaded = await fetch(`${url()}/api/v1/assets/${id}/content`, { headers }); assert.equal(downloaded.status, 200);
    assert.equal(createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex'), expectedHash);
    const source = join(f.root, 'read-only-source.bin'); writeFileSync(source, '仅引用原文件');
    const referenced = await fetch(`${url()}/api/v1/assets/references`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'reference-file' },
      body: JSON.stringify({ path: source, topic_id: topic.id, purpose: '原地引用' }) }); assert.equal(referenced.status, 201);
    const ref = await referenced.json() as { asset_id: string }; assert.equal(readFileSync(source, 'utf8'), '仅引用原文件'); unlinkSync(source);
    const list = await fetch(`${url()}/api/v1/assets?topic_id=${topic.id}`, { headers }); const result = await list.json() as { items: { id: string; status: string }[] };
    assert.equal(result.items.find(item => item.id === ref.asset_id)?.status, 'missing');
    await app.close(); app = await startApplication(f.config, { port: 0 });
    const restartedContent = await fetch(`${url()}/api/v1/assets/${id}/content`, { headers }); assert.equal(restartedContent.status, 200); await restartedContent.arrayBuffer();
    writeEvidence('assets-storage.json', { evidence_scope: 'internal_rule', result: 'passed', observed_at: new Date().toISOString(),
      actual_http_upload_bytes: chunk.length * chunkCount, file_sha256: expectedHash, persisted_size_matches: true,
      same_key_replay: true, same_key_different_content_rejected: 409, staging_empty_after_replay_conflict: true,
      new_upload_after_patch_uses_new_root: true, old_asset_original_path_preserved: true, actual_restart_content_available: true,
      referenced_file_not_modified: true, missing_reference_visible: true, decoded_media_metadata: 'not_run; duration/dimensions=null', renderer: 'not_run/WP-19' });
  } finally { await app?.close(); f.cleanup(); }
});
