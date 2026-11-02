const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn,spawnSync,execFileSync} = require('node:child_process');
const {once} = require('node:events');
const {createHash,randomUUID} = require('node:crypto');
const {setTimeout:delay} = require('node:timers/promises');
const {chromium} = require(path.join(process.env.RUNNER_TEMP,'driver/node_modules/playwright-core'));
const root = path.join(process.env.RUNNER_TEMP,'native-review');
const out = path.join(root,'evidence');
const data = path.join(root,'资料 保存');
const a = path.join(root,'程序 A'), b = path.join(root,'程序 B');
const system = path.join(process.env.SystemRoot,'System32'), cmd = path.join(system,'cmd.exe');
const ps = path.join(system,'WindowsPowerShell/v1.0/powershell.exe');
const origin = 'http://127.0.0.1:28341';
const latest = 'https://api.github.com/repos/ehomekevin/personal-ip-workbench-open-source/releases/latest';
const title = 'Windows 独立验收主题', body = '合成手工稿，保存后应在原修订中逐字读回。';
const env = {SystemRoot:process.env.SystemRoot,WINDIR:process.env.SystemRoot,ComSpec:cmd,PATH:system+';'+process.env.SystemRoot,PATHEXT:'.EXE;.CMD;.BAT;.COM',TEMP:root,TMP:root,USERPROFILE:path.join(root,'user'),APPDATA:path.join(root,'roam'),LOCALAPPDATA:path.join(root,'local'),WORKBENCH_DATA_DIR:data,WORKBENCH_WEB_PORT:'28341',WORKBENCH_API_PORT:'28342',WORKBENCH_NO_BROWSER:'1'};
for(const d of [env.USERPROFILE,env.APPDATA,env.LOCALAPPDATA]) fs.mkdirSync(d,{recursive:true});
const hash = f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const report={product:'79210c9ed5ab6f4660e77fd3152172ca7996172d',tree:'4711fb30af3e2f64039c613be5e2b6ab325237af',driver:process.env.GITHUB_SHA,run:process.env.GITHUB_RUN_ID,os:os.version(),release:os.release(),arch:process.arch,image:process.env.ImageVersion,scenarios:[],stops:[],reads:[]};
let child,closed,program,browser,id,topic,revision,stage;
function checkpoint(label){stage=label;report.stage=label;fs.writeFileSync(path.join(out,'checkpoint.json'),JSON.stringify(report,null,2));console.log('QA stage: '+label);}
process.on('exit',code=>{fs.writeFileSync(path.join(out,'driver-exit.json'),JSON.stringify({stage,code}));});
async function api(s) {const r=await fetch(origin+'/api/v1/'+s,{headers:id?{'X-Workspace-Id':id.workspace_id,'X-Service-Instance-Id':id.service_instance_id,'X-Request-Id':randomUUID()}: {}});assert.equal(r.status,200,s);return r.json();}
async function start(dir){program=dir;child=spawn(cmd,['/d','/c','Start.cmd'],{cwd:dir,env,detached:true,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.resume();closed=once(child,'exit');for(let i=0;i<200;i++){assert.equal(child.exitCode,null,'launcher exited');try{if((await(await fetch(origin+'/health')).json()).status==='ready')return;}catch{}await delay(300);}throw Error('health timeout');}
async function stop(){if(!child)return;checkpoint('stop-command-'+report.stops.length);const r=spawnSync(cmd,['/d','/c','Stop.cmd'],{cwd:program,env,stdio:'ignore',timeout:35000});assert.equal(r.status,0,'Stop.cmd');checkpoint('wait-exit-'+report.stops.length);const [code]=await closed;assert.equal(code,0);report.stops.push(code);child=null;assert(!fs.existsSync(path.join(data,'.portable-control')));}
async function readOriginal(label){assert.deepEqual(await api('identity'),id);const d=await api('topics/'+topic.id);assert.equal(d.core.text,body);assert.equal(d.core.head_revision_id,revision);report.reads.push({label,topic:topic.id,revision,verified:true});}
async function ui(scenario,width){const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',reducedMotion:'reduce'});const page=await context.newPage();page.setDefaultTimeout(15000);const issues=[],http=[];let grant;const gate=new Promise(r=>grant=r);let lookups=0;
page.on('download',()=>issues.push('download'));page.on('pageerror',()=>issues.push('page error'));page.on('response',r=>{if(r.url()===latest)http.push(r.status())});
await context.addCookies([{name:'qa_synthetic',value:'exclude',domain:'api.github.com',path:'/',secure:true,sameSite:'None'}]);
await context.route('**/*',async route=>{const req=route.request(),u=req.url();if(u.startsWith(origin+'/'))return route.continue();if(u!==latest){issues.push('extra external request');return route.abort();}lookups++;const h=await req.allHeaders();if(req.method()!=='GET'||req.postData()!==null||Object.keys(h).some(k=>/authorization|cookie|referer|workspace|service-instance|user-id/i.test(k)))issues.push('nonanonymous lookup');
if(scenario==='live')return route.continue();if(scenario==='offline')return route.abort('internetdisconnected');if(scenario==='timeout')return;
if(scenario==='future')await gate;await route.fulfill({status:scenario==='rate'?429:200,headers:{'access-control-allow-origin':'*'},json:{tag_name:scenario==='future'?'v0.2.0':'v0.1.0',draft:false,prerelease:false}});});
try{await page.goto(origin+'/?mode=real#create',{waitUntil:'domcontentloaded'});const editor=page.locator('#core-editor');
if(scenario==='live'){await page.locator('[data-action="new-topic"]:visible').first().click();await page.locator('#new-title').fill(title);await page.locator('#new-angle').fill('独立验收');await page.locator('#dialog [data-action="create-topic"]').click();}else{await page.locator('[data-action="select-topic"]').filter({hasText:title}).first().click();}
await editor.waitFor();assert.equal((await page.locator('.editor-top h2').innerText()).trim(),title);const notice=page.getByRole('complementary',{name:'版本更新'});
if(scenario==='future'){await editor.fill(body);grant();await notice.waitFor();assert.equal(await editor.inputValue(),body);assert((await notice.innerText()).includes('v0.2.0 已发布（当前 v0.1.0）'));assert.equal(await notice.locator('a').getAttribute('href'),'https://github.com/ehomekevin/personal-ip-workbench-open-source/releases/tag/v0.2.0');await editor.blur();await page.waitForFunction(()=>document.querySelector('#save-state')?.textContent==='已保存');await notice.scrollIntoViewIfNeeded();await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,'loaded-future-'+width+'.png'),animations:'disabled'});assert(await notice.evaluate(n=>n.clientWidth>0&&n.getBoundingClientRect().right<=innerWidth+1));await notice.getByRole('button').click();}
else {await page.waitForFunction(()=>!!localStorage.getItem('workbench:stable-release:v1'));assert.equal(await notice.count(),0);await editor.fill('合成场景 '+scenario);await editor.blur();await page.waitForFunction(()=>document.querySelector('#save-state')?.textContent==='已保存');}
await page.reload({waitUntil:'domcontentloaded'});await page.locator('[data-action="select-topic"]').filter({hasText:title}).first().click();await page.waitForFunction(expected=>document.querySelector('#core-editor')?.value===expected,scenario==='future'?body:'合成场景 '+scenario);assert.equal(await notice.count(),0);assert.equal(lookups,1);
if(scenario==='equal'){await page.evaluate(()=>{const k='workbench:stable-release:v1';const c=JSON.parse(localStorage.getItem(k));localStorage.setItem(k,JSON.stringify({...c,until:Date.now()-1000}));});await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>JSON.parse(localStorage.getItem('workbench:stable-release:v1')).until>Date.now());assert.equal(lookups,2);}
assert.deepEqual(issues,[]);report.scenarios.push({scenario,width,lookups,http,saved:true});}
finally{grant();await context.close();}}
async function main(){assert.equal(process.platform,'win32');assert.equal(process.arch,'x64');report.zipSha256=hash(path.join(process.env.RUNNER_TEMP,'input/personal-ip-workbench-0.1.0-windows-x64.zip'));assert.equal(report.zipSha256,'cb17c7678f3bd5cac4ffd245991b269d7d1f8e7887630868232c952bc0dabc02');
const manifest=JSON.parse(fs.readFileSync(path.join(a,'release.json')));assert.equal(manifest.commit,report.product);assert.equal(manifest.tree,report.tree);assert.equal(manifest.version,'0.1.0');report.node=execFileSync(path.join(a,'runtime/node.exe'),['-p','process.arch+" "+process.version'],{env,encoding:'utf8'}).trim();assert.equal(report.node,'x64 v26.9.0');checkpoint('guard');const unsafe=path.join(a,'bad-data');const negative=spawnSync(cmd,['/d','/c','Start.cmd'],{cwd:a,env:{...env,WORKBENCH_DATA_DIR:unsafe},stdio:'ignore',timeout:15000});assert.equal(negative.status,1);assert(!fs.existsSync(unsafe));report.guard=true;
checkpoint('first-start');await start(a);id=await api('identity');assert(id.workspace_id);const listen=JSON.parse(execFileSync(ps,['-NoProfile','-Command','ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen -LocalPort 28341,28342 | ForEach-Object { @{ addr=$_.LocalAddress; port=$_.LocalPort; exe=(Get-Process -Id $_.OwningProcess).Path } })'],{encoding:'utf8'}));assert.equal(listen.length,2);for(const l of listen){assert.equal(l.addr,'127.0.0.1');assert.equal(l.exe.toLowerCase(),path.join(a,'runtime/node.exe').toLowerCase());}report.loopback_bundled_listeners=2;
browser=await chromium.launch({channel:'msedge',headless:true,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false});for(const pair of [['live',1440],['offline',390],['rate',1440],['timeout',1440],['equal',1440],['future',1440],['future',390]]){checkpoint(pair.join('-'));await ui(...pair);checkpoint('completed-'+pair.join('-'));}
await browser.close();browser=null;checkpoint('read-revision');topic=(await api('topics')).items.find(t=>t.title===title);assert(topic);revision=(await api('topics/'+topic.id)).core.head_revision_id;assert(revision);await readOriginal('before-stop');await stop();checkpoint('backup');fs.cpSync(data,path.join(root,'saved-backup'),{recursive:true});assert(fs.existsSync(path.join(root,'saved-backup/state/workbench.sqlite')));
for(const [dir,label] of [[a,'restart'],[b,'second-extraction']]){checkpoint(label);await start(dir);await readOriginal(label);await stop();assert(!fs.existsSync(path.join(dir,'state/workbench.sqlite')));}
report.backup=true;report.status='passed';}
main().catch(e=>{report.status='failed';report.stage=stage;console.error('QA failure in '+stage, String(e.message).slice(0,500));process.exitCode=1;}).finally(async()=>{try{await browser?.close();await stop();}finally{fs.writeFileSync(path.join(out,'independent-result.json'),JSON.stringify(report,null,2));}});
