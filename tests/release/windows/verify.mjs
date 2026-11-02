// Run in a native x64 Windows CI checkout: node tests/release/windows/verify.mjs ZIP REPORT_DIR
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import packageInfo from '../../../package.json' with { type: 'json' };
import { checkBrowser, topicTitle } from './browser.mjs';

assert.equal(process.platform, 'win32', 'Native Windows is required');
assert.equal(process.arch, 'x64');
const [, , zipArg, outArg] = process.argv;
assert(zipArg && outArg, 'Expected ZIP and report directory arguments');
const zip = resolve(zipArg);
const output = resolve(outArg);
mkdirSync(output, { recursive: true });
const tmp = mkdtempSync(join(os.tmpdir(), 'workbench-portable-'));
let program = join(tmp, '含空格 安装目录');
const localData = join(tmp, '本地 用户数据');
const dataDir = join(localData, 'PersonalIPWorkbench');
const system = join(process.env.SystemRoot, 'System32');
const cmd = join(system, 'cmd.exe');
const powershell = join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const version = packageInfo.version;

const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const report = {
  platform: 'win32', arch: 'x64', osVersion: os.version(), osRelease: os.release(),
  runnerImage: process.env.ImageOS || null, imageVersion: process.env.ImageVersion || null,
  runId: process.env.GITHUB_RUN_ID || null, attempt: process.env.GITHUB_RUN_ATTEMPT || null,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  version, zipBytes: statSync(zip).size, zipSha256: hash(zip), passed: [],
};
const pass = name => { report.passed.push(name); console.log('PASS ' + name); };
const ps = (script, extraEnv) => execFileSync(powershell,
  ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + script],
  { encoding: 'utf8', env: { ...process.env, ...extraEnv }, timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
let env, app, webPort, apiPort, origin;
let phase = 'extract';

function safeLines(value) {
  let text = String(value ?? '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  // The child receives no credentials; additionally redact host paths, generated IDs and
  // any accidental credential line before writing this diagnostic to public CI.
  const paths = [tmp, process.cwd(), os.homedir(), process.env.RUNNER_TEMP, process.env.RUNNER_TOOL_CACHE,
    process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const path of paths) {
    for (const spelling of [path, path.replaceAll('\\', '/')]) {
      text = text.replace(new RegExp(spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<dir>');
    }
  }
  return text.split(/\r?\n/).map(line => line.trim()).filter(line =>
    line && line.length <= 1500 && !/^[{[]/.test(line) && !/(?:bearer\s|(?:token|password|secret|api[_-]?key)\s*[:=]|gh[pousr]_|sk-[A-Za-z0-9])/.test(line.toLowerCase())
  ).map(line => line.replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi, '<id>').slice(0, 320));
}

async function ports() {
  const servers = [createServer(), createServer()];
  try {
    await Promise.all(servers.map(server => new Promise((ok, fail) => {
      server.once('error', fail).listen(0, '127.0.0.1', ok);
    })));
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => new Promise(done => server.close(done))));
  }
}

async function start(startCommand = '创作有数.cmd', stopCommand = '退出创作有数.cmd') {
  assert(!app);
  // A fixed command and cwd preserve Unicode and spaces without interpolating paths into cmd.exe.
  const child = spawn(cmd, ['/d', '/c', startCommand], { cwd: program, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((ok, fail) => { child.once('error', fail); child.once('close', ok); });
  child.stdout.resume();
  const instance = { child, closed, stopCommand, stderr: '' };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { instance.stderr = (instance.stderr + chunk).slice(-8192); });
  app = instance;
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error(startCommand + ' exited before readiness, code ' + child.exitCode + ', signal ' + child.signalCode);
    try {
      const health = await fetch(origin + '/health', { signal: AbortSignal.timeout(800) });
      if (health.ok && (await health.json()).status === 'ready') return;
    } catch { /* Wait for this instance to bind. */ }
    await delay(500);
  }
  throw Error('Timed out waiting for the packaged application');
}

async function stop() {
  if (!app) return;
  const { child, closed, stopCommand } = app;
  if (child.exitCode === null && child.signalCode === null) {
    execFileSync(cmd, ['/d', '/c', stopCommand], { cwd: program, env, timeout: 30000, stdio: 'pipe' });
  }
  const signal = AbortSignal.timeout(30000);
  const timedOut = new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('Start.cmd still running after Stop.cmd')), { once: true }));
  assert.equal(await Promise.race([closed, timedOut]), 0);
  app = undefined;
}

async function identity() {
  const response = await fetch(origin + '/api/v1/identity', { signal: AbortSignal.timeout(3000) });
  assert(response.ok);
  const result = await response.json();
  assert(result.workspace_id && result.service_instance_id);
  return result;
}

const manualText = '手工核心稿：重启和更换程序目录后，应保留这一版正文。';

async function api(id, path, body) {
  const response = await fetch(origin + '/api/v1/' + path, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
    headers: { 'X-Workspace-Id': id.workspace_id, 'X-Service-Instance-Id': id.service_instance_id,
      'X-Request-Id': randomUUID(), ...(body ? { 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(response.status, body ? 201 : 200, 'local document API response');
  return response.json();
}

async function readTopic(expectedIdentity, title = topicTitle) {
  const id = await identity();
  assert(id.workspace_id === expectedIdentity.workspace_id && id.service_instance_id === expectedIdentity.service_instance_id, 'workspace identity changed');
  const topic = (await api(id, 'topics')).items.find(row => row.title === title);
  assert(topic, 'manually saved topic missing');
  return api(id, 'topics/' + topic.id);
}

async function checkRevision(id, original, revisionId) {
  const topic = await readTopic(id, original.title);
  assert.equal(topic.core_document_id, original.core_document_id);
  assert.equal(topic.core.head_revision_id, revisionId);
  assert.equal(topic.core.text, manualText);
}

try {
  ps('Expand-Archive -LiteralPath $env:TEST_ZIP -DestinationPath $env:TEST_DEST', { TEST_ZIP: zip, TEST_DEST: program });
  const manifest = JSON.parse(readFileSync(join(program, 'release.json'), 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.commit, report.commit);
  assert.equal(manifest.tree, report.tree);
  assert.equal(manifest.platform, 'win32');
  assert.equal(manifest.arch, 'x64');
  const node = join(program, 'runtime', 'node.exe');
  assert.equal(hash(node), manifest.nodeExeSha256);
  const runtime = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify([process.platform, process.arch, process.versions.node])'], { encoding: 'utf8' }));
  assert.deepEqual(runtime, ['win32', 'x64', packageInfo.engines.node]);
  assert.equal(runtime[2], manifest.nodeVersion);
  report.bundledNode = { version: runtime[2], sha256: manifest.nodeExeSha256, archiveSha256: manifest.nodeArchiveSha256, url: manifest.nodeUrl };
  pass('Final ZIP, metadata and bundled x64 runtime');
  [webPort, apiPort] = await ports();
  origin = `http://127.0.0.1:${webPort}`;
  // Only OS programs are on PATH, even though the independent test driver uses Playwright.
  env = {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, ComSpec: cmd,
    PATH: [system, process.env.SystemRoot, dirname(powershell)].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
    TEMP: tmp, TMP: tmp, USERPROFILE: join(tmp, 'profile'), LOCALAPPDATA: localData, APPDATA: join(tmp, 'roaming'),
    WORKBENCH_WEB_PORT: String(webPort), WORKBENCH_API_PORT: String(apiPort), WORKBENCH_NO_BROWSER: '1',
  };
  mkdirSync(env.USERPROFILE); mkdirSync(env.APPDATA); mkdirSync(localData);
  assert(!existsSync(dataDir));
  phase = 'first start';
  await start();
  assert(existsSync(join(dataDir, 'config.json')), 'default workspace must be outside the program directory');
  const settings = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  assert.equal(settings.listen.host, '127.0.0.1');
  assert.equal(settings.listen.port, apiPort);
  const first = await identity();
  assert(first.workspace_id === settings.workspace_id && first.service_instance_id === settings.service_instance_id);
  const listeners = JSON.parse(ps(`
    $rows = @(Get-NetTCPConnection -State Listen -LocalPort @([int]$env:TEST_WEB, [int]$env:TEST_API) | ForEach-Object {
      [PSCustomObject]@{ port = $_.LocalPort; address = $_.LocalAddress; bundled = (Get-Process -Id $_.OwningProcess).Path -eq $env:TEST_NODE }
    }); ConvertTo-Json -InputObject $rows -Compress`,
    { TEST_WEB: String(webPort), TEST_API: String(apiPort), TEST_NODE: node }));
  for (const port of [webPort, apiPort]) {
    const bound = listeners.filter(row => row.port === port);
    assert(bound.length && bound.every(row => row.bundled && row.address === '127.0.0.1'), 'wrong listener or executable');
  }
  pass('创作有数.cmd, loopback web/API, bundled process, isolated default data');
  phase = 'browser';
  report.browser = await checkBrowser(origin, version, output);
  phase = 'manual revision';
  const topic = await readTopic(first);
  const saved = await api(first, 'documents/' + topic.core_document_id + '/revisions', {
    expected_revision_id: topic.core.head_revision_id, text: manualText, origin: 'human',
  });
  assert(saved.revision_id, 'manual revision receipt missing');
  await checkRevision(first, topic, saved.revision_id);
  report.screenshots = ['desktop-future.png', 'narrow-future.png'].map(name => ({ name, sha256: hash(join(output, name)), fixture: true }));
  pass('Real browser, manual save, update notices and network boundaries');
  phase = 'restart';
  await stop(); await start(); await checkRevision(first, topic, saved.revision_id); await stop();
  pass('退出创作有数.cmd and restart preserve workspace, core document, manual revision and text');
  phase = 'program-directory change';
  const next = join(tmp, '新版本 程序目录');
  renameSync(program, next); program = next;
  await start(); await checkRevision(first, topic, saved.revision_id); await stop();
  pass('Move extracted program and read the same manual revision and text');
  phase = 'upgrade from released v0.1.0';
  const previousZip = join(tmp, 'v0.1.0.zip');
  const previousName = 'personal-ip-workbench-0.1.0-windows-x64.zip';
  const response = await fetch('https://github.com/ehomekevin/personal-ip-workbench-open-source/releases/download/v0.1.0/' + previousName, { signal: AbortSignal.timeout(120000) });
  assert.equal(response.status, 200, 'download official previous release');
  writeFileSync(previousZip, Buffer.from(await response.arrayBuffer()));
  report.previousZipSha256 = hash(previousZip);
  assert.equal(report.previousZipSha256, 'cb17c7678f3bd5cac4ffd245991b269d7d1f8e7887630868232c952bc0dabc02');
  program = join(tmp, '原始 0.1.0');
  ps('Expand-Archive -LiteralPath $env:TEST_ZIP -DestinationPath $env:TEST_DEST', { TEST_ZIP: previousZip, TEST_DEST: program });
  env.LOCALAPPDATA = join(tmp, '升级 用户数据');
  mkdirSync(env.LOCALAPPDATA);
  await start('Start.cmd', 'Stop.cmd');
  const oldIdentity = await identity();
  const oldTitle = '0.1.0 保存的手工稿';
  await api(oldIdentity, 'topics', { title: oldTitle, category: '个人思考', audience: '', source_ids: [] });
  const oldTopic = await readTopic(oldIdentity, oldTitle);
  const oldRevision = await api(oldIdentity, 'documents/' + oldTopic.core_document_id + '/revisions', {
    expected_revision_id: oldTopic.core.head_revision_id, text: manualText, origin: 'human',
  });
  assert(oldRevision.revision_id);
  await stop();
  program = next;
  await start();
  await checkRevision(oldIdentity, oldTopic, oldRevision.revision_id);
  await stop();
  pass('Upgrade released v0.1.0 to the final ZIP and retain workspace, old manual revision and text');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failedPhase = phase;
  const stack = safeLines(error.stack);
  const diagnostic = safeLines([app?.stderr, error.stderr].filter(Boolean).join('\n'));
  const causes = diagnostic.filter(line => /error|cannot|failed|not found|无法|失败|不存在|缺少|端口|无效/i.test(line)).slice(0, 3);
  report.failure = {
    kind: error.code || error.name || 'Error', message: safeLines(error.message).slice(0, 5),
    testLine: stack.find(line => line.includes('tests/release/windows/') || line.includes('tests\\release\\windows\\')),
    stderr: [...new Set([...causes, ...diagnostic.slice(-5)])],
  };
  console.error('FAIL ' + phase, JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  if (app) {
    try { await stop(); } catch {
      // On a failed test only, stop the exact cmd.exe process tree created by this driver.
      if (app && app.child.exitCode === null && app.child.pid) {
        try { execFileSync(join(system, 'taskkill.exe'), ['/PID', String(app.child.pid), '/T', '/F'], { stdio: 'ignore' }); report.cleanupRequiredForce = true; } catch { /* Process may have exited. */ }
      }
    }
  }
  writeFileSync(join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
