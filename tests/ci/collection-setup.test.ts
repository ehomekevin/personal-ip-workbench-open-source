import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCollectionSetup } from '../../scripts/runtime/collection-setup.ts';
import { credentialPresent, readTikHubCredential } from '../../apps/service/src/bootstrap/tikhub-credentials.ts';

test('本机密钥入口拒绝跨站写入、原始Token不回显；显式保存0600并支持替换', { skip: process.platform !== 'darwin' }, async () => {
  const parent = fileURLToPath(new URL('../../.ci-artifacts/', import.meta.url)); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'credential-')), setup = await startCollectionSetup(root, 0);
  try {
    const html = await (await fetch(setup.url)).text(), csrf = html.match(/'X-Setup-CSRF':"([a-f0-9]+)"/)![1]!;
    assert.equal(credentialPresent(root), false); assert.match(html, /type="password"/);
    const post = (origin: string, token = csrf, key = 'PRIVATE_SENTINEL') => fetch(setup.url + '/credential', { method: 'POST', headers: { Origin: origin, 'X-Setup-CSRF': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    assert.equal((await post('https://wrong.invalid')).status, 403); assert.equal((await post(setup.url, 'bad')).status, 403); assert.equal(credentialPresent(root), false);
    assert.equal((await post(setup.url)).status, 200); assert.equal(readTikHubCredential(root), 'PRIVATE_SENTINEL'); assert.equal(lstatSync(join(root, 'private-credentials/tikhub-api-key')).mode & 0o777, 0o600);
    assert.ok(!(await (await fetch(setup.url)).text()).includes('PRIVATE_SENTINEL')); assert.deepEqual(await (await fetch(setup.url + '/status')).json(), { configured: true });
    assert.equal((await post(setup.url, csrf, 'REPLACED_SENTINEL')).status, 200); assert.equal(readTikHubCredential(root), 'REPLACED_SENTINEL');
  } finally { await setup.close(); rmSync(root, { recursive: true, force: true }); }
});
