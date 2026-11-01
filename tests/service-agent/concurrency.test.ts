import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAdapter } from '../../packages/adapters/src/agent/codex/index.ts';
import { ClaudeAdapter } from '../../packages/adapters/src/agent/claude/index.ts';
import { acquire, hash, canonical, poolMutexPath, poolAvailable, poolMutexTestHooks, onPoolDiagnostic, seedProcessStartCacheForTest } from '../../packages/adapters/src/agent/codex/primitives.ts';
import { freezeCoreWritingSkill } from '../../packages/domain/src/content-agents/skill.ts';
import type { AgentRunInput, AgentRunHandle, JsonObject } from '../../packages/contracts/src/index.ts';
import { projectRoot, schemaDirectory } from './harness.ts';
const platformStartSource=process.platform==='linux'?'proc_stat':'ps';
async function until(check:()=>boolean){const end=Date.now()+10_000;while(!check()){if(Date.now()>end)throw new Error('fixture timed out');await delay(10);}}
function fixture(){const root=mkdtempSync(join(projectRoot,'tests/service-agent/.c05-')),locks=join(root,'locks'),workspace=randomUUID();mkdirSync(locks);return {root,locks,workspace,options:{workspace_id:workspace,cwd:root,lock_root:locks,schema_directory:schemaDirectory,executable:join(projectRoot,'tests/service-agent/fake-codex.mjs'),concurrency_slots:5 as const,timeout_ms:3000},cleanup(){rmSync(root,{recursive:true,force:true});}};}
function input():AgentRunInput{return {job_id:randomUUID(),kind:'document_modify',task_instruction:'Return 42',target_document_id:null,base_revision_id:null,input_manifest:{frozen:{content_purpose:'core',writing_skill:freezeCoreWritingSkill()}},allowed_tools:[],output_schema:{type:'object',required:['answer'],additionalProperties:false,properties:{answer:{type:'string'}}}};}
async function collect(adapter:CodexAdapter|ClaudeAdapter,handle:AgentRunHandle){for await(const _ of adapter.streamEvents(handle)){} }
test('共享五槽跨进程；第六等待、释放补位、旧客户端看到 sentinel 而不能插入',async()=>{
 const f=fixture(),acquired=new Set<string>(),children=Array.from({length:6},(_,index)=>spawn(process.execPath,[join(projectRoot,'tests/service-agent/concurrency-fixture-slot.mjs'),JSON.stringify({root:f.locks,workspace:f.workspace,executor:index%2?'claude':'codex',label:String(index)})],{stdio:['ignore','ignore','pipe','ipc']}));
 children.forEach(child=>child.on('message',(message:unknown)=>{if(message&&typeof message==='object'&&'label' in message)acquired.add(String(message.label));}));
 try{await until(()=>acquired.size===5);await delay(50);assert.equal(acquired.size,5);assert.equal(readdirSync(f.locks).filter(path=>/\.slot-\d\.lock$/.test(path)).length,5);assert.throws(()=>acquire(f.locks,f.workspace,'codex'),{code:'CAPABILITY_UNVERIFIED'});
  const first=Number([...acquired][0]);children[first].send('release');await until(()=>acquired.size===6);assert.equal(readdirSync(f.locks).filter(path=>/\.slot-\d\.lock$/.test(path)).length,5);
 }finally{await Promise.all(children.map(child=>new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',()=>resolve());if(child.connected)try{child.send('release',error=>{if(error)child.kill('SIGTERM');});}catch{child.kill('SIGTERM');}else child.kill('SIGTERM');})));f.cleanup();}
});
// 裁决（r3 P1）：starting 一律 fail closed，owner 已死也不回收（child 可能存活且未登记）。
test('死owner/死child可回收；活动child、starting、损坏child记录占槽；同资源不能抢占',()=>{
 const f=fixture(),prefix=hash(f.workspace),path=join(f.locks,`${prefix}.slot-0.lock`);try{
  for(const record of [{pid:2147483647,child_pid:process.pid,child_state:'spawned'},{pid:2147483647,child_pid:null,child_state:'starting'},{pid:2147483647,child_pid:null,child_state:'spawned'},{pid:2147483647,child_pid:null,child_state:'unknown'}]){writeFileSync(path,JSON.stringify({...record,token:'old',resources:['document:d']}));const other=acquire(f.locks,f.workspace,'claude',{capacity:5,resources:['document:other']});assert(existsSync(path));assert.throws(()=>acquire(f.locks,f.workspace,'codex',{capacity:5,resources:['document:d']}),{code:'CAPABILITY_UNVERIFIED'});other();}
  writeFileSync(path,JSON.stringify({pid:2147483647,child_pid:2147483647,child_state:'spawned',token:'dead',resources:[]}));const recovered=acquire(f.locks,f.workspace,'codex',{capacity:5});assert.notEqual(JSON.parse(readFileSync(path,'utf8')).token,'dead');recovered();
  for(const executor of ['codex','claude']){const legacy=join(f.locks,`${prefix}-${executor}.lock`);writeFileSync(legacy,JSON.stringify({pid:process.pid,child_pid:null,child_state:'none',token:'live-legacy'}));assert.throws(()=>acquire(f.locks,f.workspace,'codex',{capacity:5}),{code:'CAPABILITY_UNVERIFIED'});rmSync(legacy);}
  writeFileSync(join(f.locks,`${prefix}-codex.lock`),JSON.stringify({pid:2147483647,child_pid:null,child_state:'none',token:'dead-legacy'}));const legacyRecovered=acquire(f.locks,f.workspace,'claude',{capacity:5});legacyRecovered();assert.equal(readdirSync(f.locks).length,0);
 }finally{f.cleanup();}
});
test('Codex普通平台恢复：不存在/身份不匹配/未完成均不发turn；completed只返回原turn',async()=>{
 const f=fixture(),trace=join(f.root,'trace.jsonl'),record=join(f.root,'thread.json'),a=new CodexAdapter(f.options);process.env.WP15_FAKE_TRACE=trace;
 try{const fixed=input();delete (fixed.input_manifest.frozen as JsonObject).writing_skill;const handle=await a.start(fixed);await collect(a,handle);await a.close();const native=JSON.parse(readFileSync(join(projectRoot,'tests/service-agent/native-fixture.json'),'utf8'));writeFileSync(record,JSON.stringify({...native['thread/start'].thread,id:handle.runtime_session_id,turns:[{...native['turn/completed'].turn,id:handle.runtime_turn_id}]}));process.env.WP15_FAKE_THREAD_FILE=record;
  for(const mode of ['absent','mismatch','turn_mismatch','unfinished']){process.env.WP15_FAKE_THREAD_MODE=mode;const recovered=new CodexAdapter(f.options);try{await assert.rejects(recovered.resume(structuredClone(handle),{}),{code:'RESULT_UNKNOWN'});}finally{await recovered.close();}}
  delete process.env.WP15_FAKE_THREAD_MODE;const recovered=new CodexAdapter(f.options);try{const next=await recovered.resume(structuredClone(handle),{});assert.equal(next.runtime_turn_id,handle.runtime_turn_id);await collect(recovered,next);}finally{await recovered.close();}
  assert.equal(readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(message=>message.method==='turn/start').length,1);
 }finally{await a.close();delete process.env.WP15_FAKE_TRACE;delete process.env.WP15_FAKE_THREAD_FILE;delete process.env.WP15_FAKE_THREAD_MODE;f.cleanup();}
});
test('Claude未知checkpoint跨实例不提交 --resume；readiness等待期间关闭不启动child',async()=>{
 const f=fixture(),a=new ClaudeAdapter({...f.options,executable:join(projectRoot,'tests/service-agent/fake-claude.mjs')}),fixed=input(),handle:AgentRunHandle={runtime_session_id:'unknown-old-session',runtime_turn_id:'unknown-old-turn',supports_resume:true,checkpoint:{executor_id:'claude',cwd:f.root,input_hash:hash(canonical(fixed.input_manifest)),run_input:fixed as unknown as JsonObject}};
 try{await assert.rejects(a.resume(handle,{}),{code:'RESULT_UNKNOWN'});let proceed!:()=>void;const gate=new Promise<void>(resolve=>{proceed=resolve;});a.checkReadiness=async()=>{await gate;return {executor_id:'claude',runtime_version:'fixture',auth_state:'fixture',billing_route:null,capabilities:[],limitations:[]};};const starting=a.start(fixed);await a.close();proceed();await assert.rejects(starting,{code:'RESULT_UNKNOWN'});assert.equal(readdirSync(f.locks).length,0);}finally{await a.close();f.cleanup();}
});
test('恢复turn提交后普通解析异常也保留未知提交标记，不能当执行前失败',async()=>{
 const f=fixture(),a=new CodexAdapter(f.options),b=new CodexAdapter(f.options);process.env.WP15_FAKE_MODE='slow';try{const handle=await a.start(input());await a.cancel(handle);await assert.rejects(collect(a,handle),{code:'HOST_INTERRUPTED'});await a.close();process.env.WP15_FAKE_MODE='malformed_resume';await assert.rejects(b.resume(structuredClone(handle),{}),(error:unknown)=>!!error&&typeof error==='object'&&'details'in error&&(error.details as JsonObject).resume_submission_unknown===true&&(error.details as JsonObject).pre_submit_failure!==true);}finally{await a.close();await b.close();delete process.env.WP15_FAKE_MODE;f.cleanup();}
});
test('五路同名Skill不同冻结正文拥有独立目录；schema并发首次准备不相互覆盖',async()=>{
 const f=fixture(),adapters=Array.from({length:5},()=>new CodexAdapter({...f.options,schema_directory:join(f.root,'new-schemas')}));process.env.WP15_FAKE_MODE='slow';
 try{const handles=await Promise.all(adapters.map((adapter,index)=>{const fixed=input(),skill=(fixed.input_manifest.frozen as JsonObject).writing_skill as JsonObject;skill.content=String(skill.content)+'\n并发快照 '+index;skill.sha256=hash(String(skill.content));return adapter.start(fixed);}));const paths=handles.map(handle=>(handle.checkpoint.writing_skill as JsonObject).path as string);assert.equal(new Set(paths).size,5);paths.forEach((path,index)=>assert.equal(hash(readFileSync(path)),((handles[index].checkpoint.writing_skill as JsonObject).sha256)));
  await Promise.all(adapters.map((adapter,index)=>adapter.cancel(handles[index])));await Promise.all(adapters.map((adapter,index)=>assert.rejects(collect(adapter,handles[index]),{code:'HOST_INTERRUPTED'})));await Promise.all(adapters.map(adapter=>adapter.close()));assert.equal(readdirSync(f.locks).length,0);assert.equal(readdirSync(join(f.root,'.workbench-runs')).length,0);
 }finally{await Promise.all(adapters.map(adapter=>adapter.close()));delete process.env.WP15_FAKE_MODE;f.cleanup();}
});
test('Claude五路同名Skill不同正文编译为独立plugin，不相互覆盖，child退出后清理',async()=>{
 const f=fixture(),adapters=Array.from({length:5},()=>new ClaudeAdapter({...f.options,executable:join(projectRoot,'tests/service-agent/fake-claude.mjs')}));process.env.WP15_FAKE_CLAUDE_MODE='slow';
 try{const handles=await Promise.all(adapters.map((adapter,index)=>{const fixed=input(),skill=(fixed.input_manifest.frozen as JsonObject).writing_skill as JsonObject;skill.content=String(skill.content)+'\n不同冻结正文 '+index;skill.sha256=hash(String(skill.content));return adapter.start(fixed);})),recipes=handles.map(handle=>handle.checkpoint.skill_execution as JsonObject);assert.equal(new Set(recipes.map(recipe=>recipe.plugin_dir)).size,5);assert.equal(new Set(recipes.map(recipe=>recipe.compiled_sha256)).size,5);for(const recipe of recipes)assert.equal(hash(readFileSync(join(String(recipe.plugin_dir),'skills/workbench-route/SKILL.md'))),recipe.compiled_sha256);
  await Promise.all(adapters.map((adapter,index)=>adapter.cancel(handles[index])));await Promise.all(adapters.map((adapter,index)=>assert.rejects(collect(adapter,handles[index]),{code:'HOST_INTERRUPTED'})));await Promise.all(adapters.map(adapter=>adapter.close()));assert.equal(readdirSync(f.locks).length,0);assert.equal(readdirSync(join(f.root,'.workbench-runs')).length,0);
 }finally{await Promise.all(adapters.map(adapter=>adapter.close()));delete process.env.WP15_FAKE_CLAUDE_MODE;f.cleanup();}
});
// r3：跨进程互斥改为 SQLite BEGIN IMMEDIATE；旧 guard/recovery 文件不再参与互斥，进入互斥时清理。
test('F2 旧guard/recovery残留（含活pid）不阻塞领取，首次进入互斥即清理',async()=>{
 const f=fixture(),prefix=hash(f.workspace),guard=join(f.locks,`${prefix}.pool-guard`);
 try{writeFileSync(guard,JSON.stringify({pid:2147483647,token:'crashed-guard'}));writeFileSync(guard+'.recovery',JSON.stringify({pid:process.pid,token:'live-recoverer'}));writeFileSync(guard+'.recovery.reclaim-0123456789abcdef',JSON.stringify({pid:process.pid,token:'x'}));
  const slot=acquire(f.locks,f.workspace,'codex',{pool:1});assert.deepEqual(readdirSync(f.locks).filter(name=>name.includes('pool-guard')),[]);assert.equal(readdirSync(f.locks).filter(name=>/\.slot-\d\.lock$/.test(name)).length,1);
  assert.throws(()=>acquire(f.locks,f.workspace,'claude',{pool:1}),{code:'CAPABILITY_UNVERIFIED'});slot();assert.equal(readdirSync(f.locks).length,0);
 }finally{f.cleanup();}
});
test('F2 Codex交错复现：容量1、死owner残留，4进程争抢40轮，任何时刻持有≤1且无残留锁文件',async()=>{
 const f=fixture(),prefix=hash(f.workspace),pool=1;
 const exited=spawn(process.execPath,['-e','']);await new Promise(resolve=>exited.once('exit',resolve));const dead=exited.pid!;
 const children=Array.from({length:4},(_,index)=>spawn(process.execPath,[join(projectRoot,'tests/service-agent/concurrency-fixture-guard.mjs'),JSON.stringify({root:f.locks,workspace:f.workspace,label:String(index),pool,hold:60})],{stdio:['ignore','ignore','pipe','ipc']}));
 const inbox:Array<{slot?:string;start?:number;end?:number;ready?:boolean}>=[];children.forEach(child=>child.on('message',message=>inbox.push(message as never)));
 try{await until(()=>inbox.filter(m=>m.ready).length===children.length);inbox.length=0;
  for(let round=0;round<40;round++){
   writeFileSync(join(f.locks,`${prefix}.slot-0.lock`),JSON.stringify({pid:dead,token:'dead-owner-'+round,child_pid:null,child_state:'none',resources:[]}));writeFileSync(join(f.locks,`${prefix}.pool-guard`),JSON.stringify({pid:dead,token:'dead-guard'}));writeFileSync(join(f.locks,`${prefix}.pool-guard.recovery`),JSON.stringify({pid:dead,token:'dead-recovery'}));
   children.forEach(child=>child.send('go'));const end=Date.now()+20_000;while(inbox.length<children.length){if(Date.now()>end)throw new Error('round '+round+' timed out');await delay(5);}
   const holds=inbox.splice(0) as Array<{slot:string;start:number;end:number}>;
   for(const a of holds)for(const b of holds)if(a!==b)assert(a.end<=b.start||b.end<=a.start,`第${round}轮同时持有 ${a.slot}/${b.slot}`);
   for(let n=0;n<100&&readdirSync(f.locks).length;n++)await delay(5);
   assert.deepEqual(readdirSync(f.locks),[],`第${round}轮残留 ${readdirSync(f.locks).join(',')}`);
  }
 }finally{await Promise.all(children.map(child=>new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',()=>resolve());if(child.connected)try{child.send('exit',error=>{if(error)child.kill('SIGTERM');});}catch{child.kill('SIGTERM');}else child.kill('SIGTERM');})));f.cleanup();}
});
test('F2 持互斥且占槽的进程被SIGKILL后，另一进程在busy_timeout内进入互斥并回收其槽位',async()=>{
 const f=fixture(),prefix=hash(f.workspace),slotPath=join(f.locks,`${prefix}.slot-0.lock`);
 const script=`import {DatabaseSync} from 'node:sqlite';import {writeFileSync} from 'node:fs';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=2000');db.exec('BEGIN IMMEDIATE');writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,token:'killed-holder',child_pid:null,child_state:'none',resources:[]}));process.send('held');setInterval(()=>{},1000);`;
 const holder=spawn(process.execPath,['--input-type=module','-e',script,poolMutexPath(f.locks),slotPath],{stdio:['ignore','ignore','pipe','ipc']});
 try{await new Promise(resolve=>holder.once('message',resolve));
  const blocked=Date.now();assert.throws(()=>acquire(f.locks,f.workspace,'codex',{pool:1}),{code:'CAPABILITY_UNVERIFIED'});assert(Date.now()-blocked>=1500,'互斥被持有时等待 busy_timeout');
  const gone=new Promise(resolve=>holder.once('exit',resolve));holder.kill('SIGKILL');await gone;
  const started=Date.now(),slot=acquire(f.locks,f.workspace,'codex',{pool:1});assert(Date.now()-started<2000);assert.notEqual(JSON.parse(readFileSync(slotPath,'utf8')).token,'killed-holder');slot();assert.equal(readdirSync(f.locks).length,0);
 }finally{if(holder.exitCode===null&&holder.signalCode===null)holder.kill('SIGKILL');f.cleanup();}
});
test('r3 owner在spawn后、bindChild前被SIGKILL：starting槽位不被领取，未登记child仍存活',async()=>{
 const f=fixture(),script=`import {acquire} from ${JSON.stringify(join(projectRoot,'packages/adapters/src/agent/codex/primitives.ts'))};import {spawn} from 'node:child_process';
const slot=acquire(process.argv[1],process.argv[2],'claude',{pool:1,task_id:'killed-owner',resources:[]});slot.starting();const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();process.send(child.pid,()=>process.kill(process.pid,'SIGKILL'));`;
 const owner=spawn(process.execPath,['--input-type=module','-e',script,f.locks,f.workspace],{stdio:['ignore','ignore','pipe','ipc']});let orphan:number|undefined;
 try{orphan=await new Promise<number>(resolve=>owner.once('message',value=>resolve(Number(value))));await new Promise(resolve=>owner.once('exit',resolve));
  assert.throws(()=>process.kill(owner.pid!,0),{code:'ESRCH'});assert.doesNotThrow(()=>process.kill(orphan!,0),'未登记的child仍存活');
  const record=JSON.parse(readFileSync(join(f.locks,`${hash(f.workspace)}.slot-0.lock`),'utf8'));assert.equal(record.child_state,'starting');assert.equal(record.child_pid,null);
  assert.throws(()=>acquire(f.locks,f.workspace,'codex',{pool:1}),{code:'CAPABILITY_UNVERIFIED'});assert.equal(poolAvailable(f.locks,f.workspace,{pool:1}),false);
 }finally{if(orphan)try{process.kill(orphan,'SIGKILL');}catch{}f.cleanup();}
});
test('r3 pid复用：ps同源记录启动时间不符视为原owner已死、相符仍占槽；time_origin记录只看pid存活',async()=>{
 const f=fixture(),prefix=hash(f.workspace),path=join(f.locks,`${prefix}.slot-0.lock`),script=`import {processStartRecord} from ${JSON.stringify(join(projectRoot,'packages/adapters/src/agent/codex/primitives.ts'))};process.send(processStartRecord());setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','ignore','ignore','ipc']});
 try{const start=await new Promise<{started_at:number;started_at_source:string}>(resolve=>child.once('message',value=>resolve(value as never)));assert.equal(start.started_at_source,platformStartSource);
  const write=(extra:JsonObject)=>writeFileSync(path,JSON.stringify({pid:child.pid,token:'t',child_pid:null,child_state:'none',resources:[],...extra}));
  write({started_at:start.started_at,started_at_source:start.started_at_source});assert.throws(()=>acquire(f.locks,f.workspace,'codex',{pool:1}),{code:'CAPABILITY_UNVERIFIED'});
  write({started_at:start.started_at-3_600_000,started_at_source:'time_origin'});assert.throws(()=>acquire(f.locks,f.workspace,'codex',{pool:1}),{code:'CAPABILITY_UNVERIFIED'},'time_origin 不以时间差判死');
  write({started_at:start.started_at-3_600_000});assert.throws(()=>acquire(f.locks,f.workspace,'codex',{pool:1}),{code:'CAPABILITY_UNVERIFIED'},'无来源旧记录同样保守');
  write({started_at:start.started_at-3_600_000,started_at_source:start.started_at_source,token:'reused-pid'});const slot=acquire(f.locks,f.workspace,'codex',{pool:1});assert.notEqual(JSON.parse(readFileSync(path,'utf8')).token,'reused-pid');slot();
 }finally{child.kill('SIGKILL');f.cleanup();}
});
// 回归（CI run 38731544273，WSL2 runner）：墙钟每 ~30s 前跳约 2s，btime 随之变化，ps lstart 对同一活进程漂移，
// 活 owner 被判死、槽位被抢，"F2 Codex交错" 第35轮双持有。Linux 上启动时间必须取 /proc starttime，不经 ps/墙钟。
test('Linux 活owner启动时间不随墙钟漂移：ps报告的lstart偏离数小时，活owner仍占槽不被回收',{skip:process.platform!=='linux'&&'仅Linux：macOS的ps lstart记录绝对启动时间，不受btime漂移影响'},async()=>{
 const f=fixture(),bin=join(f.root,'drift-bin'),marker=join(f.root,'acquired'),path=process.env.PATH,script=`import {acquire} from ${JSON.stringify(join(projectRoot,'packages/adapters/src/agent/codex/primitives.ts'))};import {writeFileSync} from 'node:fs';acquire(process.argv[1],process.argv[2],'codex',{pool:1,task_id:'live-owner',resources:[]});writeFileSync(process.argv[3],'');setInterval(()=>{},1000);`;
 const owner=spawn(process.execPath,['--input-type=module','-e',script,f.locks,f.workspace,marker],{stdio:'ignore'});
 try{await until(()=>existsSync(marker));const record=JSON.parse(readFileSync(join(f.locks,`${hash(f.workspace)}.slot-0.lock`),'utf8'));assert.equal(record.started_at_source,'proc_stat');
  mkdirSync(bin);writeFileSync(join(bin,'ps'),'#!/bin/sh\necho "Sat Jan  1 00:00:00 2000"\n',{mode:0o755});process.env.PATH=`${bin}:${path}`;
  assert.throws(()=>acquire(f.locks,f.workspace,'claude',{pool:1,task_id:'other'}),{code:'CAPABILITY_UNVERIFIED'},'活 owner 不因 ps/墙钟漂移被判死');assert.equal(poolAvailable(f.locks,f.workspace,{pool:1}),false);
  assert.equal(JSON.parse(readFileSync(join(f.locks,`${hash(f.workspace)}.slot-0.lock`),'utf8')).token,record.token);
 }finally{process.env.PATH=path;owner.kill('SIGKILL');f.cleanup();}
});
// 回归（PR #45 复核 P1）：启动时间按 pid 缓存 1 秒；pid 在缓存期内被新进程复用时，旧缓存值与新记录不符，不得据此把新的活 owner 判死。
test('pid在启动时间缓存期内被复用：缓存旧值与记录不符时重读，新的活owner仍占槽',async()=>{
 const f=fixture(),marker=join(f.root,'acquired'),script=`import {acquire} from ${JSON.stringify(join(projectRoot,'packages/adapters/src/agent/codex/primitives.ts'))};import {writeFileSync} from 'node:fs';acquire(process.argv[1],process.argv[2],'codex',{pool:1,task_id:'reused-pid-owner',resources:[]});writeFileSync(process.argv[3],'');setInterval(()=>{},1000);`;
 const owner=spawn(process.execPath,['--input-type=module','-e',script,f.locks,f.workspace,marker],{stdio:'ignore'});
 try{await until(()=>existsSync(marker));const record=JSON.parse(readFileSync(join(f.locks,`${hash(f.workspace)}.slot-0.lock`),'utf8'));assert.equal(record.started_at_source,platformStartSource);
  seedProcessStartCacheForTest(owner.pid!,record.started_at-3_600_000);
  assert.throws(()=>acquire(f.locks,f.workspace,'claude',{pool:1,task_id:'other'}),{code:'CAPABILITY_UNVERIFIED'},'缓存旧值不能判死新的活 owner');
  seedProcessStartCacheForTest(owner.pid!,record.started_at-3_600_000);assert.equal(poolAvailable(f.locks,f.workspace,{pool:1}),false);
  assert.equal(JSON.parse(readFileSync(join(f.locks,`${hash(f.workspace)}.slot-0.lock`),'utf8')).token,record.token);
 }finally{owner.kill('SIGKILL');f.cleanup();}
});
test('r3 运行中互斥文件被删除并由他人重建：持旧连接的进程进入互斥时报错并停止领取，不静默成功',async()=>{
 const f=fixture(),mutex=poolMutexPath(f.locks);try{
  const slot=acquire(f.locks,f.workspace,'codex',{pool:2,task_id:'before'});slot();
  rmSync(mutex,{force:true});rmSync(mutex+'-journal',{force:true});
  const other=spawn(process.execPath,['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');db.exec('COMMIT');",mutex]);await new Promise(resolve=>other.once('exit',resolve));assert(existsSync(mutex),'另一进程已新建互斥文件');
  assert.throws(()=>acquire(f.locks,f.workspace,'codex',{pool:2,task_id:'after'}),(error:{code:string;details:JsonObject})=>error.code==='STORAGE_UNAVAILABLE'&&error.details.pool_mutex_broken===true);
  assert.equal(poolAvailable(f.locks,f.workspace,{pool:2}),false,'停止领取');
  assert.throws(()=>acquire(f.locks,f.workspace,'claude',{pool:2,task_id:'again'}),{code:'STORAGE_UNAVAILABLE'},'不自动重建');
  assert.deepEqual(readdirSync(f.locks).filter(name=>/\.slot-\d\.lock$/.test(name)),[]);
 }finally{f.cleanup();}
});
test('r3 领取时COMMIT失败：补偿删除本次写入的槽位与哨兵，报容量忙，之后可正常领取',()=>{
 const f=fixture();try{
  poolMutexTestHooks.beforeCommit=()=>{throw new Error('injected commit failure');};
  assert.throws(()=>acquire(f.locks,f.workspace,'codex',{pool:2,task_id:'commit-fail'}),{code:'CAPABILITY_UNVERIFIED'});
  delete poolMutexTestHooks.beforeCommit;assert.deepEqual(readdirSync(f.locks),[],'无残留槽位或哨兵');
  const other=acquire(f.locks,f.workspace,'codex',{pool:2,task_id:'held'});
  poolMutexTestHooks.beforeCommit=()=>{throw new Error('injected commit failure');};
  assert.throws(()=>acquire(f.locks,f.workspace,'claude',{pool:2,task_id:'commit-fail-2'}),{code:'CAPABILITY_UNVERIFIED'});delete poolMutexTestHooks.beforeCommit;
  assert.equal(readdirSync(f.locks).filter(name=>/\.slot-\d\.lock$/.test(name)).length,1,'只删本 token 的槽位，他人槽位保留');
  other();assert.deepEqual(readdirSync(f.locks),[]);
 }finally{delete poolMutexTestHooks.beforeCommit;f.cleanup();}
});
test('r4 首次打开互斥文件时在open与stat之间被替换：识别为损坏，不缓存错误身份',()=>{
 const f=fixture();try{
  poolMutexTestHooks.afterOpen=file=>{writeFileSync(file+'.swap','');renameSync(file+'.swap',file);};
  assert.throws(()=>acquire(f.locks,f.workspace,'codex',{pool:1}),(error:{code:string;details:JsonObject})=>error.code==='STORAGE_UNAVAILABLE'&&error.details.pool_mutex_broken===true);
  delete poolMutexTestHooks.afterOpen;
  assert.throws(()=>acquire(f.locks,f.workspace,'codex',{pool:1}),{code:'STORAGE_UNAVAILABLE'},'损坏后不重建');assert.equal(poolAvailable(f.locks,f.workspace,{pool:1}),false);
  assert.deepEqual(readdirSync(f.locks).filter(name=>/\.slot-\d\.lock$/.test(name)),[]);
 }finally{delete poolMutexTestHooks.afterOpen;f.cleanup();}
});
test('r4 COMMIT失败后先重新取锁再补偿：其间他人领取，哨兵与他人槽位保留，只删本次槽位',()=>{
 const f=fixture(),prefix=hash(f.workspace);let other:ReturnType<typeof acquire>|undefined;try{
  let failed=false;poolMutexTestHooks.beforeCommit=()=>{if(!failed){failed=true;throw new Error('injected commit failure');}};
  poolMutexTestHooks.afterCommitFailure=()=>{delete poolMutexTestHooks.afterCommitFailure;other=acquire(f.locks,f.workspace,'claude',{pool:2,task_id:'interleaved'});};
  assert.throws(()=>acquire(f.locks,f.workspace,'codex',{pool:2,task_id:'commit-fail'}),{code:'CAPABILITY_UNVERIFIED'});
  const slots=readdirSync(f.locks).filter(name=>/\.slot-\d\.lock$/.test(name));assert.equal(slots.length,1);assert.equal(JSON.parse(readFileSync(join(f.locks,slots[0]!),'utf8')).task_id,'interleaved');
  for(const executor of ['codex','claude'])assert(existsSync(join(f.locks,`${prefix}-${executor}.lock`)),'他人仍在用的哨兵保留');
 }finally{delete poolMutexTestHooks.beforeCommit;delete poolMutexTestHooks.afterCommitFailure;other?.();f.cleanup();}
});
test('r4 COMMIT失败后重新取锁超时：不删任何文件（fail closed），记诊断并报容量忙',()=>{
 const f=fixture(),events:JsonObject[]=[],stop=onPoolDiagnostic(entry=>events.push(entry.message as JsonObject));let holder:number|undefined;try{
  poolMutexTestHooks.beforeCommit=()=>{throw new Error('injected commit failure');};
  poolMutexTestHooks.afterCommitFailure=()=>{const marker=join(f.root,'held');
   holder=Number(execFileSync(process.execPath,['--input-type=module','-e',`import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';const child=spawn(process.execPath,['--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite';import {writeFileSync} from 'node:fs';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');writeFileSync(process.argv[2],'');setInterval(()=>{},1000);",process.argv[1],process.argv[2]],{detached:true,stdio:'ignore'});child.unref();const wait=()=>existsSync(process.argv[2])?(console.log(child.pid),process.exit(0)):setTimeout(wait,5);wait();`,poolMutexPath(f.locks),marker],{encoding:'utf8'}).trim());};
  assert.throws(()=>acquire(f.locks,f.workspace,'codex',{pool:2,task_id:'commit-fail'}),{code:'CAPABILITY_UNVERIFIED'});
  const slots=readdirSync(f.locks).filter(name=>/\.slot-\d\.lock$/.test(name));assert.equal(slots.length,1,'取锁失败时不删本次槽位');assert.equal(JSON.parse(readFileSync(join(f.locks,slots[0]!),'utf8')).pid,process.pid);
  assert(events.some(event=>event.step==='commit_compensation'&&event.outcome==='relock_failed'&&event.files_kept===true&&event.slot===slots[0]&&String(event.recovery).includes(slots[0]!)&&/重启本服务进程/.test(String(event.recovery))));
 }finally{stop();delete poolMutexTestHooks.beforeCommit;delete poolMutexTestHooks.afterCommitFailure;if(holder)try{process.kill(holder,'SIGKILL');}catch{}f.cleanup();}
});
test('r4 损坏的槽位JSON在互斥内隔离为.corrupt-<时间戳>并记日志，该槽位视为空闲',()=>{
 const f=fixture(),prefix=hash(f.workspace),path=join(f.locks,`${prefix}.slot-0.lock`),events:JsonObject[]=[],stop=onPoolDiagnostic(entry=>events.push(entry.message as JsonObject));try{
  writeFileSync(path,'{"pid":12');assert.equal(poolAvailable(f.locks,f.workspace,{pool:1}),true);
  const quarantined=readdirSync(f.locks).filter(name=>name.startsWith(`${prefix}.slot-0.lock.corrupt-`));assert.equal(quarantined.length,1);assert.equal(readFileSync(join(f.locks,quarantined[0]!),'utf8'),'{"pid":12','保留现场');
  assert(events.some(event=>event.step==='corrupt_slot'&&event.slot===`${prefix}.slot-0.lock`&&event.quarantined_as===quarantined[0]));
  writeFileSync(path,'not json');const slot=acquire(f.locks,f.workspace,'codex',{pool:1});assert.equal(readdirSync(f.locks).filter(name=>name.includes('.corrupt-')).length>=1,true);slot();
 }finally{stop();f.cleanup();}
});
test('r4 启动器在exec前停留3秒：owner启动时间按ps同源记录，活owner不被误判为死',async()=>{
 const f=fixture(),marker=join(f.root,'acquired'),script=`import {acquire} from ${JSON.stringify(join(projectRoot,'packages/adapters/src/agent/codex/primitives.ts'))};import {writeFileSync} from 'node:fs';acquire(process.argv[1],process.argv[2],'codex',{pool:1,task_id:'delayed-owner',resources:[]});writeFileSync(process.argv[3],'');setInterval(()=>{},1000);`;
 const owner=spawn('/bin/sh',['-c','sleep 3; exec "$0" --input-type=module -e "$1" "$2" "$3" "$4"',process.execPath,script,f.locks,f.workspace,marker],{stdio:'ignore'});
 try{await until(()=>existsSync(marker));const record=JSON.parse(readFileSync(join(f.locks,`${hash(f.workspace)}.slot-0.lock`),'utf8'));
  assert.equal(record.pid,owner.pid,'exec 保留 pid');assert.equal(record.started_at_source,platformStartSource);
  assert.throws(()=>acquire(f.locks,f.workspace,'claude',{pool:1,task_id:'other'}),{code:'CAPABILITY_UNVERIFIED'},'活 owner 仍占槽');assert.equal(poolAvailable(f.locks,f.workspace,{pool:1}),false);
 }finally{owner.kill('SIGKILL');f.cleanup();}
});
