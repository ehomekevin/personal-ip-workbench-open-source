import fs from 'node:fs';
import cp from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {join,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const project=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const runtime=join(project,'runtime/platform-layout-integration-r1/consumer');
const legacy=join(project,'runtime');
const taskRuntime=join(project,'runtime/platform-layout-integration-r1');
const evidence=process.env.PLATFORM_LAYOUT_EVIDENCE||runtime;
const mkdir=fs.mkdirSync;mkdir(runtime,{recursive:true});mkdir(evidence,{recursive:true});
const translate=p=>String(p).startsWith(legacy)&&!String(p).startsWith(taskRuntime)?join(runtime,'legacy',String(p).slice(legacy.length)):p;
fs.mkdirSync=(p,...args)=>mkdir(translate(p),...args);
const mk=fs.mkdtempSync;fs.mkdtempSync=(prefix,...args)=>{const p=String(translate(prefix));return mk(p.startsWith(taskRuntime)?p:join(runtime,basename(p)),...args);};
// 只重定位旧测试的本clone runtime名字；原候选源码与原输入地址不匹配此prefix。
for(const name of ['writeFileSync','readFileSync','existsSync','statSync','lstatSync','realpathSync','rmSync','readdirSync','unlinkSync','chmodSync']){const original=fs[name];fs[name]=(path,...args)=>original(translate(path),...args);}
for(const name of ['copyFileSync','cpSync']){const original=fs[name];fs[name]=(from,to,...args)=>original(translate(from),translate(to),...args);}
const log=(kind,data={})=>fs.appendFileSync(join(evidence,'resource-events.jsonl'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,kind,...data})+'\n',{mode:0o600});
const allowed=new Set(['/opt/homebrew/bin/ffprobe','/opt/homebrew/bin/ffmpeg','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',process.execPath,'node','python3','ps','/usr/sbin/diskutil','/usr/bin/plutil',join(project,'tests/platform-original-recovery/native-fixture.mjs'),join(project,'tests/service-agent/fake-codex.mjs'),join(project,'tests/service-agent/fake-claude.mjs')]);
for(const name of ['spawn','spawnSync','execFile','execFileSync']){const original=cp[name];cp[name]=function(file,...args){if(!allowed.has(String(file)))throw Error('Integration refuses non-fixture executable: '+String(file));if(String(file)==='python3'&&Array.isArray(args[0])&&String(args[0][1]).startsWith('import json,tomllib,sys,pathlib;'))args[0]=[...args[0].slice(0,-1),join(runtime,'absent.toml')];const child=original.call(this,file,...args);log('child-'+name,{file:String(file),child_pid:child?.pid??null,profile_args:Array.isArray(args[0])?args[0].filter(x=>String(x).startsWith('--user-data-dir=')):[]});if(name==='spawn')child.once('exit',(code,signal)=>log('child-exit',{child_pid:child.pid??null,code,signal}));return child;};}
const local=target=>{const u=target instanceof URL?target:new URL(String(target));if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('Integration refuses outbound HTTP '+u.origin);};
const fetch=globalThis.fetch;globalThis.fetch=(input,init)=>{local(input instanceof Request?input.url:input);return fetch(input,init);};
for(const module of [http,https])for(const name of ['get','request']){const original=module[name];module[name]=function(target,...args){if(typeof target==='string'||target instanceof URL)local(target);else if(target?.hostname&&!['127.0.0.1','localhost','::1'].includes(target.hostname))throw Error('Integration refuses outbound HTTP');return original.call(this,target,...args);};}
const listen=http.Server.prototype.listen;http.Server.prototype.listen=function(...args){this.once('listening',()=>{const a=this.address();if(a&&typeof a==='object'&&[4319,5180,5181,5173,8768,4327,5183].includes(a.port))throw Error('Protected port allocated');log('http-listening',{address:a});});this.once('close',()=>log('http-closed'));return listen.apply(this,args);};
const close=http.Server.prototype.close;http.Server.prototype.close=function(...args){log('http-close-request',{address:this.address()});return close.apply(this,args);};
syncBuiltinESMExports();log('guard-installed',{project,runtime,evidence});process.on('exit',code=>log('process-exit',{code}));
