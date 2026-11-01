// 仅控制本项目媒体执行启动的隔离 headless Chrome；不连接用户浏览器或桌面宿主。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, file, widthArg, heightArg, output, pdf] = process.argv.slice(2);
if (!['render', 'inspect', 'playback'].includes(mode) || !output) throw new Error('render|inspect|playback FILE WIDTH HEIGHT OUTPUT [PDF]');
const chrome = process.env.WP19_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runtimeRoot = resolve(dirname(output), '.browser-runtime');
await mkdir(runtimeRoot, { recursive: true });
const profile = await mkdtemp(`${runtimeRoot}/profile-`);
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeLog = '';
proc.stderr.on('data', d => { chromeLog += d.toString(); });
const delay = ms => new Promise(r => setTimeout(r, ms));
let ws;
let interrupted = false;
const interrupt = () => { interrupted = true; proc.kill('SIGTERM'); ws?.close(); };
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
try {
  let port;
  for (let n = 0; n < 100; n++) {
    if (interrupted || proc.exitCode !== null) throw new Error('BROWSER_CANCELLED');
    try { port = Number((await readFile(`${profile}/DevToolsActivePort`, 'utf8')).split('\n')[0]); break; } catch { await delay(100); }
  }
  if (!port) throw new Error(`Chrome did not start: ${chromeLog.slice(-1000)}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(t => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('BROWSER_CLOSED')); } pending.clear(); });
  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (!msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  });
  const call = (method, params = {}) => new Promise((res, rej) => {
    if (interrupted) { rej(new Error('BROWSER_CANCELLED')); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: res, reject: rej, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: Number(widthArg), height: Number(heightArg), deviceScaleFactor: 1, mobile: false });
  const nav = await call('Page.navigate', { url: pathToFileURL(resolve(file)).href });
  if (nav.errorText) throw new Error(nav.errorText);
  for (let n = 0; n < 100; n++) {
    if (await evaluate('document.readyState === "complete"')) break;
    await delay(50);
  }
  await evaluate('document.fonts.ready.then(() => true)');
  const page = await evaluate(`({title:document.title, readyState:document.readyState, text:document.body.innerText, width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight, images:[...document.images].map(i=>({src:i.getAttribute('src'),complete:i.complete,naturalWidth:i.naturalWidth,naturalHeight:i.naturalHeight})),fonts:[...document.fonts].map(f=>({family:f.family,status:f.status})),headingFont:getComputedStyle(document.querySelector('h1')||document.body).fontFamily,bodyFont:getComputedStyle(document.body).fontFamily})`);
  if (page.images.some(i => !i.complete || i.naturalWidth === 0)) throw new Error('MISSING_BROWSER_IMAGE');
  if (mode === 'render') {
    if (await evaluate('getComputedStyle(document.body).backgroundColor === "rgba(0, 0, 0, 0)"')) {
      await call('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    }
    const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(output, Buffer.from(screenshot.data, 'base64'));
    if (pdf) {
      const result = await call('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
      await writeFile(pdf, Buffer.from(result.data, 'base64'));
    }
    await writeFile(`${output}.browser.json`, JSON.stringify(page, null, 2) + '\n');
  } else if (mode === 'inspect') {
    await writeFile(output, JSON.stringify(page, null, 2) + '\n');
  } else {
    const started = Date.now();
    await evaluate(`Promise.all([...document.querySelectorAll('video,audio')].map(el=>new Promise((resolve,reject)=>{el.muted=true;el.addEventListener('error',()=>reject(new Error(el.error?.message||'MEDIA_ERROR')),{once:true}); if(el.readyState>=1) resolve(); else el.addEventListener('loadedmetadata',resolve,{once:true});})))`);
    const before = await evaluate(`Promise.all([...document.querySelectorAll('video,audio')].map(async el=>{await el.play();return {tag:el.tagName,duration:el.duration,currentTime:el.currentTime,readyState:el.readyState,videoWidth:el.videoWidth||null,videoHeight:el.videoHeight||null}}))`);
    await delay(2300); // 实际墙钟等待，不使用虚拟时间推进。
    const after = await evaluate(`([...document.querySelectorAll('video,audio')].map(el=>({tag:el.tagName,duration:el.duration,currentTime:el.currentTime,paused:el.paused,ended:el.ended,readyState:el.readyState,error:el.error?.message||null,decodedFrames:el.getVideoPlaybackQuality?.().totalVideoFrames??null})))`);
    if (after.length === 0 || after.some((a, i) => a.error || a.currentTime <= before[i].currentTime + 1.5)) throw new Error('PLAYBACK_DID_NOT_ADVANCE');
    await writeFile(output, JSON.stringify({ page, before, after, elapsed_wall_ms: Date.now() - started, audible_human_review: 'not_run', limitations: ['headless playback is muted; human listening and continuous full-duration quality review remain not_run'] }, null, 2) + '\n');
  }
} finally {
  ws?.close();
  proc.kill('SIGTERM');
  await new Promise(r => { if (proc.exitCode !== null) r(); else { const timer = setTimeout(() => { proc.kill('SIGKILL'); r(); }, 3000); proc.once('exit', () => { clearTimeout(timer); r(); }); } });
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  await rm(profile, { recursive: true, force: true });
  await rm(runtimeRoot, { recursive: true, force: true });
}
