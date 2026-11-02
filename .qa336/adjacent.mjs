import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium,expect} from '@playwright/test';
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
const [exe,old,out]=process.argv.slice(2).map(p=>resolve(p));mkdirSync(out,{recursive:true});
const install=join(process.env.LOCALAPPDATA,'Programs','Chuangzuoyoushu'),program=join(install,'Chuangzuoyoushu.exe');
assert(!existsSync(program));
const env={...process.env,TEST_INSTALL:install,TEST_REPORT:out,WORKBENCH_API_PORT:'47231',WORKBENCH_WEB_PORT:'47232',TEST_CDP:'47233'};
const ps=(script)=>execFileSync('pwsh',['-STA','-NoProfile','-NonInteractive','-Command',script],{env,encoding:'utf8',timeout:60000}).trim();
const native=(action,extra={})=>JSON.parse(execFileSync('pwsh',['-STA','-NoProfile','-NonInteractive','-File',join(import.meta.dirname,'native.ps1'),action],{env:{...env,...extra},encoding:'utf8',timeout:60000}));
const report={};let browser;
const record=(phase)=>{report.phase=phase;writeFileSync(join(out,'adjacent.json'),JSON.stringify(report,null,2));console.log(phase);};
const watchdog=setTimeout(()=>{report.timeout=true;record('driver_timeout_at_'+report.phase);process.exit(2)},150000);
record('install');
try {
 execFileSync(exe,['/VERYSILENT','/CURRENTUSER','/NORESTART'],{timeout:100000});assert(existsSync(program));
 record('installed');report.exe=ps('(Get-AuthenticodeSignature $env:TEST_INSTALL/Chuangzuoyoushu.exe).Status');
 report.node=ps('(Get-FileHash $env:TEST_INSTALL/resources/core/runtime/node.exe).Hash');
 assert.equal(report.node.toLowerCase(),'8490398f5e0082772dfb0ae5a6ebdff98a97696a20cb9778b4f82eec79b6d0a1');
 report.licenseMedia=ps('Get-ChildItem $env:TEST_INSTALL,*invalid -ErrorAction SilentlyContinue | Where-Object Name -match "LICENSE" | Select-Object -ExpandProperty Name; Get-ChildItem $env:TEST_INSTALL/resources/core/licenses | Select-Object -ExpandProperty Name');
 record('launch');env.TEST_LINK=native('shortcut').link;native('launch');
 for(let i=0;i<60&&!browser;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:47233',{timeout:1500})}catch{await sleep(400)}}
 record('connected');let page;for(let i=0;i<60&&!page;i++){page=browser.contexts()[0]?.pages().find(p=>p.url().startsWith('http://127.0.0.1:47232/'));if(!page)await sleep(400)}assert(page,'No ready workbench page');page.setDefaultTimeout(8000);
 await expect(page).toHaveTitle('创作有数');
 const origin=new URL(page.url()).origin;assert.equal(origin,'http://127.0.0.1:47232');
 assert.deepEqual(await page.evaluate(()=>[typeof require,typeof process,typeof electron,typeof ipcRenderer]),Array(4).fill('undefined'));
 await page.evaluate(()=>{window.open('ms-settings:','_blank');location.href='/api/v1/identity';});
 await sleep(1000);assert.equal(new URL(page.url()).pathname,'/');assert.equal(page.context().pages().length,1);
 report.blockedNavigation=true;record('navigation-blocked');
 for(const [tag,n] of [['v0.1.2',0],['v0.1.3',1]]){
 let calls=0;await page.route('https://api.github.com/repos/ehomekevin/personal-ip-workbench-open-source/releases/latest',r=>{calls++;return r.fulfill({json:{tag_name:tag,draft:false,prerelease:false}})});
 await page.evaluate(()=>localStorage.clear());await page.reload();await expect.poll(()=>calls).toBe(1);
 await sleep(300);await expect(page.locator('.release-notice')).toHaveCount(n);
 report[tag]={calls,text:await page.locator('.release-notice').allTextContents()};await page.unrouteAll({behavior:'wait'});
 }
 record('notices');const click=page.getByText('查看更新说明').click({noWaitAfter:true,timeout:8000}).catch(e=>{report.clickError=String(e)});await sleep(900);
 const result=ps(`Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms; $ui=[Windows.Automation.AutomationElement]; $root=$ui::RootElement;$p=@(Get-Process Chuangzuoyoushu | Where-Object MainWindowHandle -ne 0); $ws=$root.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition);foreach($w in $ws){if($w.Current.ProcessId -notin $p.Id){continue}; $nodes=$w.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition);if (($nodes|ForEach-Object {$_.Current.Name}) -contains '在浏览器打开外部链接？') { $button=$nodes|Where-Object {$_.Current.Name -eq '打开' -and $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Button'}|Select-Object -First 1;if($button){$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke();'confirmed'}}}`);
 await click;assert.equal(result,'confirmed');report.openedExternal=result;
 await sleep(1500);assert.equal(new URL(page.url()).origin,origin);
 report.pass=true;
} catch(e){report.failure=String(e);record('failed_at_'+report.phase);process.exitCode=1;}finally{
 try{if(existsSync(program)){if(native('processes').length){native('close');await sleep(2500)};if(browser)await browser.close();native('uninstall');report.remaining=native('processes');}}catch(e){report.cleanupError=String(e)}
 clearTimeout(watchdog);writeFileSync(join(out,'adjacent.json'),JSON.stringify(report,null,2));console.log(report);process.exit(process.exitCode||0);
}
