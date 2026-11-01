import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfiguration } from '../../apps/service/src/bootstrap/config.ts';
import { credentialPresent } from '../../apps/service/src/bootstrap/tikhub-credentials.ts';
import {LOCAL_CREDENTIAL_KINDS,readLocalCredential,saveLocalCredential,credentialAccounts,type LocalCredentialKind} from '../../apps/service/src/bootstrap/configuration/credentials.ts';

const page = (csrf: string, configured: boolean) => `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TikHub 连接 · 个人工作台</title><style>
:root{color-scheme:light;font-family:system-ui,sans-serif;color:#0d2053;background:#eef0fc}*{box-sizing:border-box}body{margin:0;padding:48px 24px}main{max-width:580px;margin:0 auto}header{margin-bottom:28px}.brand{font-size:14px;letter-spacing:.04em}h1{font-size:32px;margin:20px 0 12px}p{line-height:1.75;color:#52618c}form{padding:28px;border:1px solid #bec8ec;background:white;border-radius:24px}label{display:block;font-weight:600;margin-bottom:10px}input{width:100%;border:1px solid #a5b1d6;border-radius:12px;padding:14px;font:inherit;color:inherit;background:#fff}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #526cbd;outline-offset:3px}button{border:0;border-radius:40px;background:#cbfa5c;color:#0d2053;padding:14px 24px;font:inherit;font-weight:700;margin-top:24px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}small{display:block;color:#52618c;line-height:1.7;margin-top:12px}#status{min-height:24px;margin:18px 0 0}a{color:#0d2053}.status{font-size:14px;padding:8px 12px;background:#dde5ff;border-radius:20px;display:inline-block}@media(max-width:480px){body{padding:28px 18px}form{padding:22px}h1{font-size:28px}}
</style></head><body><main><header><div class="brand">个人工作台 · 设置与连接</div><h1>连接 TikHub</h1><p>把数据回流到你的个人工作台。先填写密钥，再核对账号和需要采集的作品。</p><div class="status">${configured ? '已保存本机密钥 · 权限待验证' : '尚未配置密钥'}</div></header><form id="form"><label for="key">TikHub API Key</label><input id="key" name="key" type="password" autocomplete="off" spellcheck="false" required maxlength="4096" placeholder="在此粘贴你的 API Key"><small>只保存到本机私有文件，不写入笔记或内容库。此步骤不会发起采集。${configured ? '重新填写并保存会替换现有密钥。' : ''}</small><button type="submit">保存到本机</button><p id="status" role="status" aria-live="polite"></p></form><p><a href="http://127.0.0.1:5180/#settings">返回个人工作台</a></p></main><script>
const form=document.getElementById('form'),key=document.getElementById('key'),status=document.getElementById('status'),button=form.querySelector('button');form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;status.textContent='正在保存…';try{const result=await fetch('/credential',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-CSRF':${JSON.stringify(csrf)}},body:JSON.stringify({key:key.value})});const data=await result.json();if(!result.ok)throw new Error(data.message);key.value='';status.textContent='密钥已保存。接下来核对账号和采集目标。';document.querySelector('.status').textContent='已保存本机密钥 · 权限待验证';}catch(error){status.textContent=error.message||'保存失败，请重试';}finally{button.disabled=false;}});
</script></body></html>`;

const labels:Record<LocalCredentialKind,string>={tikhub:'TikHub',openai:'OpenAI API',anthropic:'Claude API',x:'X 发布',douyin:'抖音发布',wechat:'公众号 AppSecret',ark_agent_plan:'方舟 Agent Plan'};
function credentialPage(csrf:string,configured:boolean,kind:LocalCredentialKind,stateRoot:string,selectedAccount?:string){
  const escape=(v:unknown)=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const accounts=credentialAccounts(stateRoot,kind),selector=accounts.length?'<label for="account">本人账号</label><select id="account" style="width:100%;padding:12px;margin-bottom:20px">'+accounts.map(a=>'<option value="'+escape(a.id)+'" '+(a.id===selectedAccount?'selected':'')+'>'+escape(a.name)+'</option>').join('')+'</select>':'';
  let html=page(csrf,configured).replaceAll('TikHub',labels[kind]).replace('<label for="key">',selector+'<label for="key">').replace("fetch('/credential'", "fetch('/credential?kind="+kind+"'").replace('JSON.stringify({key:key.value})',"JSON.stringify({key:key.value,...(document.getElementById('account')?{account_id:document.getElementById('account').value}:{})})");
  if(kind!=='tikhub')html=html.replace('把数据回流到你的个人工作台。先填写密钥，再核对账号和需要采集的作品。','填写本机凭据，返回工作台检查连接。保存凭据不会提交内容或调用生成。').replaceAll('权限待验证','连接待检查').replace('密钥已保存。接下来核对账号和采集目标。','密钥已保存。返回工作台检查连接。');
  if(kind==='ark_agent_plan')html=html.replace('方舟 Agent Plan API Key','Agent Plan 专属 API Key').replace('填写本机凭据，返回工作台检查连接。保存凭据不会提交内容或调用生成。','填写 Agent Plan 订阅的专属 API Key。此处不接收旧版语音 App ID / Access Key，也不接收方舟平台普通 API Key。保存只写本机私有文件，不发起转写。').replace('密钥已保存。返回工作台检查连接。','密钥已保存。返回工作台启用语音输入，再由你点击录音核对转写。');
  if(['x','douyin','wechat'].includes(kind)&&!accounts.length)html=html.replace('<button type="submit">','<p>请先在工作台补齐主页并登记本人账号。</p><button type="submit" disabled>');
  return html;
}

export async function startCollectionSetup(stateRoot: string, port = 5190, options:{onlyKind?:LocalCredentialKind}={}): Promise<{ url: string; close(): Promise<void> }> {
  credentialPresent(stateRoot);
  const csrf = randomBytes(32).toString('hex'); let origin = '';
  const server: Server = createServer(async (request, response) => {
    const send = (code: number, payload: object) => { response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(payload)); };
    // 检查 Host 与 Origin，避免任意网页或 DNS rebinding 写入本机凭据。
    if (request.headers.host !== new URL(origin).host) { send(403, { message: '请从本机设置入口访问' }); return; }
    const parsed=new URL(request.url??'/',origin),rawKind=parsed.searchParams.get('kind')??options.onlyKind??'tikhub';
    if(!(LOCAL_CREDENTIAL_KINDS as readonly string[]).includes(rawKind)||options.onlyKind&&rawKind!==options.onlyKind){send(400,{message:'请选择此入口支持的凭据类型'});return;}
    const kind=rawKind as LocalCredentialKind;
    const accountId=parsed.searchParams.get('account_id')??undefined;
    const configured=()=>kind==='tikhub'?credentialPresent(stateRoot):!!readLocalCredential(stateRoot,kind,accountId);
    if (request.method === 'GET' && parsed.pathname === '/') {
      try{const html=credentialPage(csrf, configured(),kind,stateRoot,accountId);response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" }).end(html);}catch{send(503,{message:'本机凭据入口暂不可用，请检查文件权限后重试'});}return;
    }
    if (request.method === 'GET' && parsed.pathname === '/status') {try{send(200, { configured: configured() });}catch{send(503,{message:'本机凭据不可读，请检查文件权限'});}return; }
    if (request.method !== 'POST' || parsed.pathname !== '/credential') { send(404, { message: '入口不存在' }); return; }
    const token = request.headers['x-setup-csrf'];
    if (request.headers.origin !== origin || typeof token !== 'string' || token.length !== csrf.length || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf)) || request.headers['content-type'] !== 'application/json') { send(403, { message: '请刷新本机设置页后保存' }); return; }
    try {
      let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 8192) { send(413, { message: '输入过长' }); return; } }
      const input = JSON.parse(body); if (!input || typeof input !== 'object' || Object.keys(input).some(field => !['key','account_id'].includes(field))) throw new Error('请填写有效的 TikHub API Key');
      saveLocalCredential(stateRoot,kind,input.key,input.account_id); send(200, { configured: true });
    } catch { send(400, { message: '保存失败，请检查密钥格式与本机文件权限' }); }
  });
  server.requestTimeout = 10_000;
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  return { url: origin, close: () => new Promise<void>((done, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : done()); }) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfiguration(); if (config.mode !== 'real') throw new Error('密钥输入须指向 real 工作区');
  const setup = await startCollectionSetup(config.paths.state_root, Number(process.env.WORKBENCH_SETUP_PORT ?? '5190'));
  console.log(JSON.stringify({ event: 'collection_setup_ready', url: setup.url }));
  const stop = () => { void setup.close(); }; process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
