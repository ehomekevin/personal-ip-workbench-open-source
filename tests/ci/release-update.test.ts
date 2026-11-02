import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

const moduleUrl = new URL('../../apps/web/src/app/release-update.ts', import.meta.url);
let instance = 0;
async function reload(): Promise<typeof import('../../apps/web/src/app/release-update.ts')> {
  return import(`${moduleUrl.href}?instance=${++instance}`);
}
function useStorage(t: TestContext, unavailable = false) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() {
    if (unavailable) throw new Error('Storage blocked');
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (k: string, v: string) => values.set(k, v) };
  } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  return values;
}
const release = (tag_name: string) => ({ tag_name, draft: false, prerelease: false });

test('compares stable SemVer numerically, ignores build metadata and suppresses a dismissed version across reloads', async t => {
  useStorage(t);
  const request = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.github.com/repos/ehomekevin/personal-ip-workbench-open-source/releases/latest');
    assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.redirect, 'error'); assert.equal(init.headers, undefined); assert.equal(init.body, undefined);
    return Response.json({ ...release('v0.10.0'), html_url: 'https://example.com/unsafe' });
  });
  const app = await reload();
  const expected = { version: '0.10.0', url: 'https://github.com/ehomekevin/personal-ip-workbench-open-source/releases/tag/v0.10.0' };
  const checks = await Promise.all(['0.1.0', '0.1.1', '0.2.0', '0.10.0-rc.2', 'v0.10.0+build.5', '1.0.0'].map(app.checkReleaseUpdate));
  assert.deepEqual(checks, [expected, expected, expected, expected, null, null]);
  assert.equal(request.mock.callCount(), 1);
  app.dismissReleaseUpdate('0.10.0');
  assert.equal(await (await reload()).checkReleaseUpdate('0.1.0'), null);
  assert.equal(request.mock.callCount(), 1);
});

test('ignores draft, prerelease, malformed releases and unsafe tags', async t => {
  const storage = useStorage(t);
  let response: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  for (response of [{ ...release('1.0.0'), draft: true }, { ...release('1.0.0'), prerelease: true },
    release('1.0.0-rc.1'), release('01.0.0'), release('1.0'), release('1.0.1/../../'),
    release('1.0.0+x!'), release('1.0.0\n'), release('1.0.0\r\n'), release('1.0.0\u2028'), { tag_name: '1.0.0' }, null]) {
    storage.clear(); assert.equal(await (await reload()).checkReleaseUpdate('0.1.0'), null);
  }
});

test('discards malformed cached data instead of using it as a tag or a URL', async t => {
  const storage = useStorage(t);
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json(release('v1.0.0')));
  const until = Date.now() + 60_000;
  for (const entry of [123, [1], { until, tag: 1 }, { until, tag: {} }, { until, tag: 'https://evil.invalid/' },
    { until, tag: '1.2.3\n' }, { until: String(until), tag: '9.9.9' }]) {
    storage.set('workbench:stable-release:v1', JSON.stringify(entry));
    const previousCalls = request.mock.callCount();
    assert.deepEqual(await (await reload()).checkReleaseUpdate('0.1.0'), {
      version: '1.0.0', url: 'https://github.com/ehomekevin/personal-ip-workbench-open-source/releases/tag/v1.0.0',
    });
    assert.equal(request.mock.callCount(), previousCalls + 1);
  }
});

test('quietly caches missing releases, offline failures and rate limits, then checks again after expiry', async t => {
  const storage = useStorage(t);
  let time = 1_000_000;
  t.mock.method(Date, 'now', () => time);
  let status = 404;
  const request = t.mock.method(globalThis, 'fetch', async () => {
    if (!status) throw new Error('offline');
    return status === 200 ? Response.json(release('v0.2.0')) : new Response(null, { status, headers: { 'Retry-After': '7200' } });
  });
  for (const [failure, hours] of [[404, 24], [403, 2], [429, 2], [0, 1]]) {
    status = failure; storage.clear();
    const oldCount = request.mock.callCount();
    assert.equal(await (await reload()).checkReleaseUpdate('0.1.0'), null);
    status = 200; time += hours * 3_600_000 - 1;
    const app = await reload(); assert.equal(await app.checkReleaseUpdate('0.1.0'), null);
    assert.equal(request.mock.callCount(), oldCount + 1);
    time++; assert.equal((await app.checkReleaseUpdate('0.1.0'))?.version, '0.2.0');
    assert.equal(request.mock.callCount(), oldCount + 2);
  }
});

test('times out without errors and suppresses repeated requests when browser storage is unavailable', async t => {
  useStorage(t, true);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 4000); const controller = new AbortController();
    setTimeout(() => controller.abort(), 5); return controller.signal;
  });
  const request = t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }));
  const app = await reload();
  assert.equal(await app.checkReleaseUpdate('invalid'), null); assert.equal(request.mock.callCount(), 0);
  assert.equal(await app.checkReleaseUpdate('0.1.0'), null);
  assert.equal(await app.checkReleaseUpdate('0.1.0'), null); assert.equal(request.mock.callCount(), 1);
});
