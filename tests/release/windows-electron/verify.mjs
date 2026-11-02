// Disposable GitHub Windows runner only. Inputs are the actual installer, the released ZIP, and a report directory.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { release, tmpdir, version } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use a disposable runner, never a daily workstation');
assert.equal(process.argv.length, 5, 'SETUP_EXE V011_ZIP REPORT_DIR');
const [installer, oldZip, output] = process.argv.slice(2).map(p => resolve(p));
const hash = data => createHash('sha256').update(data).digest('hex');
const oldHash = hash(readFileSync(oldZip));
assert.equal(oldHash, 'a1b9c48a2ea48496be3ede3ebae4e6c839d2124a93a202cec4f66947f74822cb');
mkdirSync(output, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'desktop-check-'));
const legacy = join(tmp, 'old');
const localData = process.env.LOCALAPPDATA;
const install = join(localData, 'Programs', 'Chuangzuoyoushu');
const dataDir = join(localData, 'PersonalIPWorkbench');
const idFile = join(dataDir, 'config.json');
const passed = [];
const report = { os: version(), build: release(), commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
  oldZipSha256:oldHash, installerSha256: hash(readFileSync(installer)), bytes: statSync(installer).size, passed };
const mark = msg => { passed.push(msg); console.log('PASS', msg); };
const image = readFileSync(new URL('../../article-layout/visual/fixtures/original-standard.png', import.meta.url));
const imageId = randomUUID(), imageHash = hash(image), original = join(dataDir,'media',imageId,'original');
const originalText = '旧工作台里的草稿：今天想写一篇关于手工整理书架的文章。';
const changedText = originalText + ' 我保留了最常翻的三本书。';
const oldVariant = '第一次整理，先把常读的书放到桌边。', newerVariant = '第二次整理，把每层的书留一点空隙。';
let phase = 'allocate loopback ports', env, oldProcess, browser, id, topic, variant, lastRevision, origin, oldExit;
async function until(action, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do { const value = await action(); if (value) return value; await delay(300); } while (Date.now() < deadline);
  throw Error('Timed out: ' + label);
}
const ports = [], reservations = [];
for (let i=0; i<3; i++) {
  const s=createServer();
  await new Promise((ok,fail)=>s.once('error',fail).listen(0,'127.0.0.1',ok));
  ports.push(s.address().port); reservations.push(s);
}
await Promise.all(reservations.map(s=>new Promise(done=>s.close(done))));
const [web, apiPort, debug] = ports;
assert(ports.every(p=>![5180,4318,4319].includes(p)));
origin = 'http://127.0.0.1:' + web;
const cdp = 'http://127.0.0.1:' + debug;
env = { ...process.env, LOCALAPPDATA:localData, WORKBENCH_API_PORT:String(apiPort), WORKBENCH_WEB_PORT:String(web),
  WORKBENCH_NO_BROWSER:'1', TEST_SETUP:installer, TEST_INSTALL:install, TEST_REPORT:output, TEST_CDP:String(debug) };
delete env.WORKBENCH_DATA_DIR;
delete env.NODE_OPTIONS;
assert(!existsSync(install) && !existsSync(dataDir), 'Disposable account must have no existing installation or user workspace');
const native = (action, extra={}) => JSON.parse(execFileSync('pwsh',['-STA','-NoLogo','-NoProfile','-NonInteractive','-File',
  join(import.meta.dirname,'native.ps1'),action],{env:{...env,...extra},encoding:'utf8',timeout:150_000}).trim());
async function req(path, body) {
  const r=await fetch(origin+'/api/v1/'+path,{method:body?'POST':'GET',signal:AbortSignal.timeout(8000),
    headers:{'X-Workspace-Id':id.workspace_id,'X-Service-Instance-Id':id.service_instance_id,'X-Request-Id':randomUUID(),
      ...(body?{'Idempotency-Key':randomUUID(),'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  assert(r.ok, path + ' HTTP ' + r.status); return r;
}
const json = async (p,b) => (await req(p,b)).json();
async function oldStart() {
  oldProcess=spawn(join(legacy,'runtime/node.exe'),[join(legacy,'runtime/launcher.mjs'),'start'],{env,stdio:'ignore',windowsHide:true});
  oldExit = new Promise((ok,fail)=>oldProcess.once('error',fail).once('exit',ok));
  await until(async()=>{
    assert.equal(oldProcess.exitCode,null,'old launcher exited during startup');
    try{return (await fetch(origin+'/health',{signal:AbortSignal.timeout(600)})).ok;}catch{return false;}
  },'old workbench');
}
async function oldStop() {
  execFileSync(join(legacy,'runtime/node.exe'),[join(legacy,'runtime/launcher.mjs'),'stop'],{env,stdio:'pipe',timeout:30_000});
  assert.equal(await oldExit,0);oldProcess=undefined;
}
function imageFixture() {
  // Make an existing, schema-valid image in this disposable v0.1.1 workspace. Image import is a separate workflow.
  mkdirSync(join(dataDir,'media',imageId),{recursive:true});writeFileSync(original,image,{flag:'wx'});
  const db=new DatabaseSync(join(dataDir,'state','workbench.sqlite'));
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN');
    db.prepare("INSERT INTO assets(id,workspace_id,kind,origin,file_path,sha256,size_bytes,mime,status) VALUES (?,?,'image','import',?,?,?,'image/png','ready')")
        .run(imageId,id.workspace_id,original,imageHash,image.length);
    db.prepare("INSERT INTO topic_asset_links(id,workspace_id,topic_id,asset_id,purpose,evidence_kind) VALUES (?,?,?,?,'原图','user_input')")
        .run(randomUUID(),id.workspace_id,topic.id,imageId);
    db.exec('COMMIT');
  } finally {db.close();}
}
async function saveDoc(doc, parent, text) {
  return (await json('documents/'+doc+'/revisions',{expected_revision_id:parent,text,origin:'human'})).revision_id;
}
async function application() {
  native('launch');
  await until(async()=>{try{return (await fetch(cdp+'/json/version',{signal:AbortSignal.timeout(600)})).ok;}catch{return false;}},'installed Electron CDP');
  browser=await chromium.connectOverCDP(cdp);
  const page=await until(()=>browser.contexts()[0]?.pages().find(p=>p.url().startsWith(origin+'/')),'workbench main window');
  assert.match(await page.evaluate(()=>navigator.userAgent),/Electron\//);
  await expect(page).toHaveTitle('创作有数');
  assert.deepEqual(await page.evaluate(()=>[typeof window.require,typeof window.process,typeof window.electron]),['undefined','undefined','undefined']);
  const current=await (await fetch(origin+'/api/v1/identity')).json();
  assert.equal(current.workspace_id,id.workspace_id);assert.equal(current.service_instance_id,id.service_instance_id);
  return page;
}
const clickTab=(page,value)=>page.locator('[data-action="edit-tab"][data-value="'+value+'"]').click();
async function inspect(page,text,label) {
  await page.locator('#nav [data-page="create"]').click();
  await clickTab(page,'core');
  await expect(page.locator('#core-editor')).toHaveValue(text);
  await page.locator('#core-editor').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(output,label+'-editor-renderer.png')});
  report[label+'Desktop']=native('capture',{TEST_SCREEN:label+'-editor-desktop.png'});
  await clickTab(page,'versions');
  await expect(page.locator('#version-text')).toHaveValue(newerVariant);
  await page.locator('[data-action="previous-version"]').click();
  await expect(page.locator('#dialog .social-preview')).toContainText(oldVariant);
  await page.screenshot({path:join(output,label+'-history-renderer.png')});
  await page.locator('#dialog [data-action="close-dialog"]').last().click();
  await clickTab(page,'assets');
  await page.locator('[data-action="image-view"][data-asset="'+imageId+'"]').click();
  const viewed=page.locator('#dialog .image-full-preview');
  await expect(viewed).toBeVisible();
  const digest=await viewed.evaluate(async img=>{
    await img.decode(); if(img.naturalWidth!==1200 || img.naturalHeight!==960)throw Error('Wrong decoded dimensions');
    const bytes=await (await fetch(img.src)).arrayBuffer();
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  });
  assert.equal(digest,imageHash);
  await page.screenshot({path:join(output,label+'-image-renderer.png')});
  await page.locator('#dialog [data-action="close-dialog"]').last().click();
}
function listening(port) {
  return new Promise(done=>{const socket=connect(port,'127.0.0.1');socket.setTimeout(800);socket.once('connect',()=>{socket.destroy();done(true);});
    socket.on('error',()=>done(false));socket.once('timeout',()=>{socket.destroy();done(false);});});
}
async function closeAndCheck() {
  native('close');
  await until(async()=>!(await Promise.all(ports.map(listening))).some(Boolean),'release web, API and CDP ports');
  await until(()=>native('processes').length===0,'installed app and sidecar exit');
  assert.equal(browser.isConnected(),false);browser=undefined;
}
try {
  phase='create upgraded workspace using actual v0.1.1';
  mkdirSync(legacy);execFileSync('python',['-m','zipfile','-e',oldZip,legacy]);
  await oldStart();
  id=JSON.parse(readFileSync(idFile));
  assert.equal(id.listen.port,apiPort);
  topic=await json('topics',{title:'书架整理手记',category:'个人思考',audience:'',source_ids:[]});
  const first=await saveDoc(topic.core_document_id,null,'整理书架的第一稿。');
  const second=await saveDoc(topic.core_document_id,first,originalText);
  await json('topics/'+topic.id+'/core-approvals',{revision_id:second});
  variant=await json('topics/'+topic.id+'/variants',{platform:'x',format:'text'});
  const prev=await saveDoc(variant.document_id,null,oldVariant);
  const head=await saveDoc(variant.document_id,prev,newerVariant);
  await oldStop();imageFixture();await oldStart();
  assert.equal(hash(Buffer.from(await (await req('assets/'+imageId+'/content')).arrayBuffer())),imageHash);
  assert.equal((await json('documents/'+variant.document_id+'/revisions/'+head)).parent_revision_id,prev);
  await oldStop();
  report.fixture={imageSource:'schema fixture in isolated old workspace; read and hash checked by released v0.1.1',imageSha256:imageHash,
    oldCoreHistory:[first,second],oldPlatformHistory:[prev,head]};
  mark('v0.1.1 read synthetic prior image and retained linked manual revisions');
  phase='Windows installer and shortcut';
  report.install=native('install');
  const shortcut=native('shortcut');env.TEST_LINK=shortcut.link;
  if (shortcut.target) assert.equal(shortcut.target.toLowerCase(),join(install,'Chuangzuoyoushu.exe').toLowerCase());
  mark('Installed real EXE and found its branded Start Menu shortcut');
  phase='first Electron start';
  let page=await application();
  await page.bringToFront();
  const firstTree=native('processes');
  const main=firstTree.filter(p=>p.main),sidecar=firstTree.filter(p=>p.name.toLowerCase()==='node.exe');
  assert.equal(main.length,1);assert.equal(sidecar.length,1);assert.equal(sidecar[0].parent,main[0].id);
  native('launch');await delay(1800);
  const same=native('processes');
  assert.deepEqual(same.filter(p=>p.main),main);assert.deepEqual(same.filter(p=>p.name.toLowerCase()==='node.exe'),sidecar);
  assert.equal(browser.contexts()[0].pages().length,1);
  mark('Second installed shortcut launch kept one native window and one owned sidecar');
  phase='open old draft, image and history inside installed window';
  await inspect(page,originalText,'old');
  mark('Old text, previous platform revision and original PNG opened in the installed main window');
  phase='edit and normal exit';
  await clickTab(page,'core');
  const saving=page.waitForResponse(r=>r.url()===origin+'/api/v1/documents/'+topic.core_document_id+'/revisions' && r.request().method()==='POST');
  await page.locator('#core-editor').fill(changedText);
  const saved=await saving;assert.equal(saved.status(),201);lastRevision=(await saved.json()).revision_id;
  assert(lastRevision);await closeAndCheck();
  phase='cold start from Windows Search';
  report.search=native('search');
  if(report.search.clicked) {
    const testOrigin=origin;
    try {
      // Explorer starts the app with its normal environment. Verify only the synthetic workspace's known API port.
      origin='http://127.0.0.1:'+apiPort;
      const identity=await json('identity');
      assert.equal(identity.workspace_id,id.workspace_id);assert.equal(identity.service_instance_id,id.service_instance_id);
      const document=await json('documents/'+topic.core_document_id);
      assert.equal(document.head_revision_id,lastRevision);assert.equal(document.text,changedText);
      report.search.window=native('capture',{TEST_SCREEN:'start-menu-cold-launch-desktop.png'});
      assert.equal(report.search.window.pid,report.search.pid);
      mark('Clicked named Windows Search result from cold state and read the saved draft from its installed sidecar');
    } finally {
      origin=testOrigin;native('close');
      await until(()=>native('processes').length===0,'Search-launched application and sidecar exited');
      assert.equal(await listening(apiPort),false);
    }
  }
  phase='restart and verify';
  page=await application();await inspect(page,changedText,'reopened');
  const persisted=await json('documents/'+topic.core_document_id);
  assert.equal(persisted.head_revision_id,lastRevision);assert.equal(persisted.text,changedText);
  await closeAndCheck();
  mark('Saved in renderer, closed normally, released all three ports, reopened via installed shortcut, read same revision, image and history');
  phase='occupied port and safe startup failure';
  const sentinel=createServer(socket=>socket.end('owned by the test'));
  await new Promise((ok,fail)=>sentinel.once('error',fail).listen(web,'127.0.0.1',ok));
  try {
    native('launch');
    report.occupiedPort=native('errorbox');
    await until(()=>native('processes').length===0,'failed launch cleaned up its own processes');
    assert(await listening(web));assert.equal(await listening(apiPort),false);
    assert.equal(await listening(debug),false);
    mark('Occupied port showed actionable native error and left the other listener running');
  } finally {await new Promise(done=>sentinel.close(done));}
  phase='uninstall data retention';
  native('uninstall');
  assert(!existsSync(shortcut.link));assert.equal(JSON.parse(readFileSync(idFile)).workspace_id,id.workspace_id);
  assert.equal(hash(readFileSync(original)),imageHash);
  const db=new DatabaseSync(join(dataDir,'state','workbench.sqlite'),{readOnly:true});
  try {assert.equal(db.prepare('SELECT head_revision_id FROM documents WHERE id=?').get(topic.core_document_id).head_revision_id,lastRevision);}finally{db.close();}
  mark('Uninstaller removed its shortcut while preserving the upgraded draft database and original image');
  report.status='passed';
} catch (e) {
  report.status='failed';report.phase=phase;report.failure=e.message.slice(0,1200);
  console.error(phase,e);process.exitCode=1;
} finally {
  writeFileSync(join(output,'verification.json'),JSON.stringify(report,null,2)+'\n');
  if(oldProcess && oldProcess.exitCode===null)await oldStop();
  if(browser?.isConnected()){try{await closeAndCheck();}catch{/* Never kill unidentified processes. */}}
  if(report.status==='passed')rmSync(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:300});
}
