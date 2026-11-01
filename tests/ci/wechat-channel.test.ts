import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, lstatSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createProxy } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { CONTRACT_VERSION } from '../../packages/contracts/src/index.ts';
import { WechatChannel, WECHAT_AUTH_LIMITS } from '../../apps/service/src/bootstrap/wechat/channel.ts';
import { assertPublicProxyHost, checkedProxyLookup } from '../../apps/service/src/bootstrap/wechat/proxy-network.ts';
import { validateRelay, startSshRelay } from '../../apps/service/src/bootstrap/wechat/ssh-relay.ts';

const appId = 'wx1111111111111111', secret = 'PRIVATE_APP_SECRET_012345678901234'.replaceAll('_', 'A'), proxyPassword = 'PRIVATE_PROXY_PASSWORD', token = 'PRIVATE_SHORT_LIVED_TOKEN';
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-wechat-'))), state = join(root, 'state');
  mkdirSync(join(state, 'private-credentials'), { recursive: true, mode: 0o700 });
  const path = join(state, 'private-credentials/wechat.json');
  const config = { schema_version: 1, workspace_id: 'wechat-unit', account_id: 'owner-wechat', canonical_url: 'https://mp.weixin.qq.com/s/owner-fixture', app_id: appId, app_secret: secret, proxy: { address: 'http://proxy.example.invalid:8443', username: 'proxy-user', password: proxyPassword } };
  const save = () => writeFileSync(path, JSON.stringify(config), { mode: 0o600 }); save();
  const context = { identity: { workspace_id: 'wechat-unit', service_instance_id: 'wechat-service', contract_version: CONTRACT_VERSION }, paths: { state_root: state, managed_notes_root: join(root, 'notes'), media_root: join(root, 'media'), source_vault_root: null } };
  return { root, path, config, context, save, close() { rmSync(root, { recursive: true, force: true }); } };
}
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
test('私有配置绑定工作区、账号、URL与AppID，拒绝公开权限、链接和其他路径', async () => {
  const f = fixture(); let calls = 0;
  try {
    const c = new WechatChannel(f.context, f.path, { fetcher: async () => { calls++; return response({ access_token: token, expires_in: 7200 }); } });
    assert.equal(c.ready(), true);
    await assert.rejects(c.credentials('other-owner', appId), { code: 'CAPABILITY_UNVERIFIED' });
    await assert.rejects(c.resolveAccount('owner-wechat', 'https://mp.weixin.qq.com/s/other'), { code: 'CAPABILITY_UNVERIFIED' });
    await assert.rejects(c.credentials('owner-wechat', 'wx0000000000000000'), { code: 'CAPABILITY_UNVERIFIED' });
    assert.equal(calls, 0);
    chmodSync(f.path, 0o644); assert.equal(c.ready(), false); chmodSync(f.path, 0o600);
    symlinkSync(f.path, join(f.root, 'link.json')); assert.equal(new WechatChannel(f.context, join(f.root, 'link.json')).ready(), false);
    f.config.workspace_id = 'other-workspace'; f.save(); assert.equal(c.ready(), false);
  } finally { f.close(); }
});
test('同包代理认证、token合并缓存与提前刷新；配置变化立即淘汰旧凭据', async () => {
  const f = fixture(); let now = 1000000, calls = 0;
  try {
    const c = new WechatChannel(f.context, f.path, { clock: () => now, fetcher: async (url, init) => {
      calls++; assert.equal(String(url), 'https://api.weixin.qq.com/cgi-bin/stable_token'); assert.equal(init!.redirect, 'error'); assert.equal(init!.method, 'POST');
      assert.ok((init as RequestInit & { dispatcher: unknown }).dispatcher);
      assert.deepEqual(JSON.parse(String(init!.body)), { grant_type: 'client_credential', appid: appId, secret: f.config.app_secret, force_refresh: false });
      return response({ access_token: token + calls, expires_in: 7200 });
    } });
    const both = await Promise.all([c.credentials('owner-wechat', appId), c.credentials('owner-wechat', appId)]);
    assert.equal(calls, 1); assert.deepEqual(both[0], both[1]);
    const identity = await c.resolveAccount('owner-wechat', f.config.canonical_url); assert.equal(identity.platform_account_id, appId);
    assert.ok(!identity.raw_body.includes(token)); assert.ok(!identity.raw_body.includes(secret));
    now += 6900001; await c.credentials('owner-wechat', appId); assert.equal(calls, 2);
    f.config.app_secret = 'B'.repeat(32); f.save(); await c.credentials('owner-wechat', appId); assert.equal(calls, 3);
  } finally { f.close(); }
});
test('认证期间换配置不给出旧身份；token失败、白名单与网络结果不含秘密或发布权声明', async () => {
  const f = fixture();
  try {
    const swapped = new WechatChannel(f.context, f.path, { fetcher: async () => { f.config.app_secret = 'C'.repeat(32); f.save(); return response({ access_token: token, expires_in: 7200 }); } });
    await assert.rejects(swapped.resolveAccount('owner-wechat', f.config.canonical_url), { code: 'CAPABILITY_UNVERIFIED' });
    for (const [code, expected] of [[40125, WECHAT_AUTH_LIMITS.auth], [40164, WECHAT_AUTH_LIMITS.whitelist], [45009, WECHAT_AUTH_LIMITS.rate]] as const) {
      const c = new WechatChannel(f.context, f.path, { fetcher: async () => response({ errcode: code, errmsg: secret + proxyPassword + token }) });
      const result = await c.check('owner-wechat', appId); assert.equal(result.permissions, 'unavailable'); assert.deepEqual(result.limitations, [expected]);
      for (const value of [secret, proxyPassword, token]) assert.ok(!JSON.stringify(result).includes(value));
    }
    const c = new WechatChannel(f.context, f.path, { fetcher: async () => response({ access_token: token, expires_in: 7200 }) });
    const check = await c.check('owner-wechat', appId); assert.equal(check.identity, 'passed'); assert.equal(check.reachability, 'passed'); assert.equal(check.permissions, 'unavailable');
  } finally { f.close(); }
});
test('图片上传构造真实multipart字节、中文文件名回退、响应脱敏与固定端点', async () => {
  const f = fixture(); const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]); let calls = 0;
  try {
    const c = new WechatChannel(f.context, f.path, { fetcher: async (_url, init) => {
      calls++; const body = Buffer.from(init!.body as Uint8Array), contentType = (init!.headers as Record<string, string>)['Content-Type']!;
      assert.match(contentType, /^multipart\/form-data; boundary=/);
      assert.ok(body.includes('name="media"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n'));
      assert.ok(body.includes(png)); assert.ok(!body.includes('[object FormData]'));
      return response({ url: 'https://mmbiz.qpic.cn/fixture/image' });
    } });
    const request = { operation: 'media/uploadimg', method: 'POST' as const, url: 'https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=' + token, headers: {}, signal: new AbortController().signal, upload: { field: 'media', filename: '中文图片.png', mime: 'image/png', bytes: png } };
    await c.transport('owner-wechat', appId).request(request); assert.equal(calls, 1);
    await assert.rejects(c.transport('owner-wechat', appId).request({ ...request, url: 'https://evil.invalid/cgi-bin/media/uploadimg' }), { code: 'CAPABILITY_UNSUPPORTED' });
    await assert.rejects(c.transport('owner-wechat', appId).request({ ...request, url: 'https://api.weixin.qq.com/cgi-bin/freepublish/submit' }), { code: 'CAPABILITY_UNSUPPORTED' });
    const echo = new WechatChannel(f.context, f.path, { fetcher: async () => response({ media_id: proxyPassword }) });
    await assert.rejects(echo.transport('owner-wechat', appId).request(request), /invalid_response/);
    assert.equal(calls, 1);
  } finally { f.close(); }
});
test('代理地址与DNS拒绝内网，不提供环境变量直连回退', async () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '192.0.2.50', '::1', '192.168.1.1']) assert.throws(() => assertPublicProxyHost(host), /proxy_invalid/);
  assertPublicProxyHost('8.8.8.8'); // Classification only; no connection is made.
  const lookup = checkedProxyLookup({ resolveProxy: async () => [{ address: '10.0.0.1', family: 4 }] });
  await new Promise<void>(done => lookup('proxy.example', {}, error => { assert.match(String(error), /proxy_invalid/); done(); }));
});
test('NAS中继拒绝动态命令与公开密钥文件；使用私有Unix socket并在关闭后清理', async () => {
  const f = fixture(); try {
    const key = join(f.root, 'fixture-key'); writeFileSync(key, 'TEST_ONLY_NOT_A_KEY', { mode: 0o600 });
    const relay = { kind: 'ssh_nas' as const, host: '10.23.45.6', user: 'admin', port: 32320, identity_file: key }, proxy = new URL('http://192.0.2.50:8443');
    validateRelay(relay, proxy);
    for (const change of [{ host: 'localhost;echo' }, { user: 'admin;echo' }, { port: 0 }, { identity_file: 'relative-key' }]) assert.throws(() => validateRelay({ ...relay, ...change }, proxy), { code: 'AUTH_REQUIRED' });
    chmodSync(key, 0o644); assert.throws(() => validateRelay(relay, proxy), { code: 'AUTH_REQUIRED' }); chmodSync(key, 0o600);
    const socket = await startSshRelay(join(f.context.paths.state_root, 'private-credentials'), relay, proxy);
    assert.equal(lstatSync(socket.path).mode & 0o777, 0o600); assert.equal(lstatSync(socket.path).isSocket(), true);
    await socket.close(); assert.equal(lstatSync(socket.path, { throwIfNoEntry: false }), undefined);
  } finally { f.close(); }
});
test('生产undici经过本地CONNECT与验证TLS，token和图片请求实际到达固定微信端点', async () => {
  const f = fixture(), sockets = new Set<Duplex>();
  let target: ReturnType<typeof createHttpsServer> | undefined, proxy: ReturnType<typeof createProxy> | undefined;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(f.root, 'key.pem'), '-out', join(f.root, 'cert.pem'), '-subj', '/CN=api.weixin.qq.com', '-addext', 'subjectAltName=DNS:api.weixin.qq.com', '-days', '1'], { stdio: 'ignore' });
    const cert = readFileSync(join(f.root, 'cert.pem')), calls: string[] = [];
    target = createHttpsServer({ key: readFileSync(join(f.root, 'key.pem')), cert }, async (req, res) => {
      const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part)); const body = Buffer.concat(parts); calls.push(req.url!);
      assert.equal(req.headers.host, 'api.weixin.qq.com');
      if (req.url === '/cgi-bin/stable_token') { assert.equal(JSON.parse(body.toString()).secret, secret); res.end(JSON.stringify({ access_token: token, expires_in: 7200 })); }
      else { assert.match(String(req.headers['content-type']), /^multipart\/form-data; boundary=/); assert.ok(body.includes('filename="image.png"')); res.end(JSON.stringify({ url: 'https://mmbiz.qpic.cn/native-fixture' })); }
    });
    await new Promise<void>(done => target!.listen(0, '127.0.0.1', done));
    const targetPort = (target.address() as { port: number }).port;
    proxy = createProxy(); proxy.on('connect', (req, client, head) => {
      assert.equal(req.url, 'api.weixin.qq.com:443'); assert.equal(req.headers['proxy-authorization'], 'Basic ' + Buffer.from('proxy-user:' + proxyPassword).toString('base64'));
      const upstream = connect(targetPort, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
      sockets.add(upstream); sockets.add(client); upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    });
    await new Promise<void>(done => proxy!.listen(0, '127.0.0.1', done));
    f.config.proxy.address = 'http://127.0.0.1:' + (proxy.address() as { port: number }).port; f.save();
    const c = new WechatChannel(f.context, f.path, { testOnlyAllowLoopback: true, requestCa: cert.toString() });
    await c.credentials('owner-wechat', appId);
    await c.transport('owner-wechat', appId).request({ operation: 'media/uploadimg', method: 'POST', url: 'https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=' + token, headers: {}, signal: AbortSignal.timeout(5000), upload: { field: 'media', filename: '真实测试.png', mime: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71]) } });
    assert.deepEqual(calls, ['/cgi-bin/stable_token', '/cgi-bin/media/uploadimg?access_token=' + token]);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (proxy) await new Promise<void>(done => proxy!.close(() => done()));
    if (target) await new Promise<void>(done => target!.close(() => done()));
    f.close();
  }
});
