const { app, BrowserWindow, dialog, Menu, session, shell } = require('electron');
const { fork } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const { externalLink, isWorkbench } = require('./policy.cjs');

const name = '创作有数';
app.setName(name);
app.setAppUserModelId('org.chuangzuoyoushu.desktop');
app.enableSandbox();
let win, child, quitting = false, failed = false, origin;
const messages = {
  port: '工作台端口已被占用。请先退出已打开的便携版或检查工作区端口设置，再重新打开应用。',
  busy: '工作区正在使用，或服务锁尚未释放。请正常退出正在使用它的工作台，再重试。',
  startup: '本机服务未能启动。请检查工作区配置、目录权限和端口，再重新打开应用。',
  window: '工作台页面加载失败，请重新打开应用。',
  crash: '本机服务意外停止，请重新打开应用并核对最后保存的内容。',
  shutdown: '本机服务未确认正常退出。请重新打开应用并核对最后保存的内容。'
};
function report(code) {
  if (failed) return;
  failed = true;
  const log = join(app.getPath('userData'), 'desktop.log');
  let message = messages[code];
  try { appendFileSync(log, new Date().toISOString() + ' ' + code + '\n'); message += '\n诊断日志：' + log; } catch {}
  dialog.showErrorBox(name, message);
  app.quit();
}
function show() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
async function open(url) {
  origin = new URL(url).origin;
  if (!isWorkbench(url, origin)) throw Error('Unexpected origin');
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((contents, perm, site, details) => perm === 'media' &&
    site === origin && details.mediaType === 'audio' && contents === win?.webContents);
  ses.setPermissionRequestHandler(async (contents, perm, done, details) => {
    if (!win || contents !== win.webContents || !isWorkbench(details.requestingUrl, origin) ||
      perm !== 'media' || details.mediaTypes?.join() !== 'audio') return done(false);
    const answer = await dialog.showMessageBox(win, { message: '允许录制麦克风声音？', buttons: ['不允许', '允许'], defaultId: 0, cancelId: 0 });
    done(answer.response === 1);
  });
  ses.webRequest.onHeadersReceived({ urls: ['http://127.0.0.1/*'] }, (details, done) => {
    if (new URL(details.url).origin !== origin) return done({});
    done({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [
      "default-src 'self'; connect-src 'self' blob: https://api.github.com/repos/ehomekevin/personal-ip-workbench-open-source/releases/latest; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    ] } });
  });
  win = new BrowserWindow({ title: name, icon: join(__dirname, 'icon.ico'), width: 1280, height: 850, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '应用', submenu: [{ label: '退出创作有数', accelerator: 'Alt+F4', click: () => win.close() }] },
    { label: '编辑', submenu: ['undo','redo','cut','copy','paste','selectAll'].map(role => ({ role })) }]));
  win.on('page-title-updated', e => e.preventDefault());
  win.on('session-end', () => { if (child?.connected) child.send('stop'); });
  const guard = event => { if (!event.isMainFrame || !isWorkbench(event.url, origin)) event.preventDefault(); };
  win.webContents.on('will-frame-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.setWindowOpenHandler(({ url }) => {
    const link = externalLink(url);
    if (link) void dialog.showMessageBox(win, { message: '在浏览器打开外部链接？', detail: link, buttons: ['取消','打开'], cancelId: 0, defaultId: 0 })
      .then(({ response }) => response === 1 && shell.openExternal(link)).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('render-process-gone', () => { if (!quitting) report('window'); });
  await win.loadURL(url);
  if (!quitting) show();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!child) return;
    event.preventDefault();
    if (!quitting) { quitting = true; if (child.connected) child.send('stop', () => {}); }
  });
  app.whenReady().then(() => {
    child = fork(join(__dirname, 'sidecar.mjs'), [], { execPath: join(process.resourcesPath, 'core/runtime/node.exe'),
      execArgv: [], windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'] });
    const timeout = setTimeout(() => report('startup'), 60000);
    child.once('error', () => { clearTimeout(timeout); report('startup'); });
    child.once('message', data => {
      clearTimeout(timeout);
      if (quitting) return;
      if (!data?.ready) return report(Object.hasOwn(messages, data?.failure) ? data.failure : 'startup');
      open(data.ready).catch(() => { if (!quitting) report('window'); });
    });
    child.once('close', code => {
      clearTimeout(timeout); child = null;
      if (!quitting && !failed) report(origin ? 'crash' : 'startup');
      else if (code !== 0 && !failed) report('shutdown');
      else app.quit();
    });
  }).catch(() => report('startup'));
}
