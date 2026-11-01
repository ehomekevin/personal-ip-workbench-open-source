/** MAIN-INTEGRATION-R5/r5: controlled native protocol + owned real local child. Never a model/provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {acquire,type WorkspaceSlot} from '../../../packages/adapters/src/agent/codex/primitives.ts';
import {newLayoutCheckExecution} from '../../../packages/adapters/src/media/layout-check/check.ts';
import {CodexNative} from '../../../packages/adapters/src/agent/codex/native.ts';
import {CodexLayoutCheckAdapter} from '../../../packages/adapters/src/media/layout-check/check.ts';
import {LayoutCheckSessions} from '../../../packages/adapters/src/media/layout-check/sessions.ts';
import type {LayoutCheckOptions,LayoutCheckExecution,LayoutCheckJournal} from '../../../packages/adapters/src/media/layout-check/types.ts';
import {QAOnlyNative,setup,identity,signal} from '../visual/repair-fixture.ts';
import {workflowFixture} from './workflow-fixture.ts';
import {getJob} from '../../../packages/storage/src/jobs/index.ts';

const base=resolve(import.meta.dirname,'../../../runtime/main-layout-r6');mkdirSync(base,{recursive:true});
const results:Array<{name:string;directory:string;passed:boolean}>=[];
class HeldNative extends QAOnlyNative {
 initializations=0;
 override async initialize(){this.initializations++;assert.equal(this.initializations,1,'a transport initializes only once');}
 done=false;readGate:Promise<void>|null=null;onRead?:()=>void;readonly child;readonly transport:any;
 private constructor(child:ReturnType<typeof spawn>){super('stall');this.child=child;this.transport=Object.assign(Object.create(CodexNative.prototype),{process:child,pending:new Map(),closing:false});}
 static async create(){const child=spawn(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdout.write('ready\\n')"],{stdio:'pipe'});await once(child.stdout!,'data');return new HeldNative(child);}
 override async close(){this.closes++;await this.transport.close();}
 override async request(method:string,params:any){const result:any=await super.request(method,params);if(method==='thread/read'){this.onRead?.();if(this.readGate)await this.readGate;result.thread.cwd=params.fixtureCwd;result.thread.turns[0].itemsView='full';result.thread.turns[0].status=this.done?'completed':'inProgress';}return result;}
}
async function fixture(name:string,body:(f:ReturnType<typeof setup>,n:HeldNative,owner:LayoutCheckSessions,opts:LayoutCheckOptions,factoryCount:()=>number)=>Promise<void>){
 const directory=mkdtempSync(join(base,'lifecycle-')),f=setup(directory),n=await HeldNative.create(),owner=new LayoutCheckSessions();let factories=0;
 const opts:LayoutCheckOptions={workspace_id:'qa-fixture-workspace',cwd:f.directory,lock_root:f.directory,schema_directory:f.directory,journal:f.journal(),fixture:true,native_factory:()=>{factories++;return n;},timeout_ms:15,session_owner:owner};
 try{await body(f,n,owner,opts,()=>factories);results.push({name,directory,passed:true});}catch(e){results.push({name,directory,passed:false});throw e;}finally{await owner.close();assert.notEqual(n.child.exitCode,null,'owned child must actually exit');assert.equal(owner.size,0);assert.equal(n.listeners.size,0);f.close();writeFileSync(join(directory,'closed.json'),JSON.stringify({child_exit_code:n.child.exitCode,native_closes:n.closes,owner_size:owner.size,listeners:n.listeners.size,real_model_calls:0}));}
}

test('r5 timeout retains the in-progress child; fresh fence queries the same transport/IDs without new native factory/thread/turn',async()=>fixture('timeout-held-fresh-fence',async(f,n,owner,opts,count)=>{
 let oldCurrent=true;const first=new CodexLayoutCheckAdapter({...opts,is_current:()=>oldCurrent});const pending=await first.execute(f.input,identity('r5-held'),signal());
 assert.equal(pending.execution.attempt.state,'unknown');assert.equal(n.closes,0);assert.equal(n.child.exitCode,null);assert.equal(owner.size,1);assert.equal(n.listeners.size,1);
 oldCurrent=false;n.done=true;const recovered=await new CodexLayoutCheckAdapter({...opts,is_current:()=>true}).query(pending.execution.attempt.attempt_id,signal());
 assert.equal(recovered.execution.attempt.state,'completed');assert.equal(recovered.execution.proof.original_input_verified,true);assert.deepEqual(recovered.execution.attempt.native,pending.execution.attempt.native);
 assert.equal(count(),1);assert.equal(n.starts,1);assert.equal(n.threads,1);assert.equal(n.closes,1);assert.equal(owner.size,0);assert.equal(n.child.exitCode,0);
}));

test('r5 concurrent original-ID queries serialize full load/read/save; completed survives late events and cached re-query',async()=>fixture('concurrent-query',async(f,n,owner,opts,count)=>{
 const adapter=new CodexLayoutCheckAdapter(opts),pending=await adapter.execute(f.input,identity('r5-concurrent'),signal());n.done=true;
 let release!:()=>void,entered!:()=>void;n.readGate=new Promise<void>(r=>{release=r;});const reading=new Promise<void>(r=>{entered=r;});n.onRead=entered;
 const a=adapter.query(pending.execution.attempt.attempt_id,signal());await reading;const b=adapter.query(pending.execution.attempt.attempt_id,signal());release();
 assert.equal((await a).execution.attempt.state,'completed');assert.equal((await b).execution.attempt.state,'completed');assert.equal(n.reads,1);assert.equal(count(),1);
 const before=await f.journal().load(pending.execution.attempt.attempt_id);n.emit({method:'turn/started',params:{threadId:'qa-thread',turn:{id:'late-old-turn'}}});
 assert.deepEqual(await f.journal().load(pending.execution.attempt.attempt_id),before);assert.equal((await adapter.query(pending.execution.attempt.attempt_id,signal())).execution.attempt.state,'completed');assert.equal(n.starts,1);
}));

test('r5 held session rejects different workspace/cwd/candidate/job/intent/attempt/native IDs before any native request',async()=>fixture('wrong-session',async(f,n,owner,opts,count)=>{
 const adapter=new CodexLayoutCheckAdapter(opts),pending=await adapter.execute(f.input,identity('r5-identity'),signal()),before=n.calls.length;
 for(const patch of [{workspace_id:'other-workspace'},{cwd:f.directory+'/other'}])await assert.rejects(new CodexLayoutCheckAdapter({...opts,...patch}).query(pending.execution.attempt.attempt_id,signal()),/会话/);
 const mutations:Array<(e:LayoutCheckExecution)=>void>=[e=>e.candidate_sha256='f'.repeat(64),e=>e.attempt.job_id='other-job',e=>e.attempt.id='other-intent',e=>e.attempt.attempt_id='other-attempt',e=>e.attempt.native.turn_id='other-turn',e=>{e.attempt.native.thread_id='other-thread';e.proof.thread_start!.thread_id='other-thread';}];
 for(const change of mutations){const bad=structuredClone(pending.execution);change(bad);const journal:LayoutCheckJournal={reserve:async()=>false,save:async()=>{throw new Error('must not save mismatched session');},load:async()=>bad};await assert.rejects(new CodexLayoutCheckAdapter({...opts,journal}).query(pending.execution.attempt.attempt_id,signal()));}
 assert.equal(n.calls.length,before);assert.equal(count(),1);assert.equal(n.starts,1);assert.equal(n.closes,0);assert.equal(owner.size,1);
}));

test('r5 tool/approval denial stays installed after observation timeout and reclaims the poisoned child',async()=>fixture('held-tool-denial',async(f,n,owner,opts)=>{
 const pending=await new CodexLayoutCheckAdapter(opts).execute(f.input,identity('r5-tool'),signal());assert.equal(pending.execution.attempt.state,'unknown');
 n.emit({id:42,method:'item/tool/requestUserInput',params:{}});await owner.close();assert.equal(n.denied,1);assert.equal(n.closes,1);assert.equal(n.child.exitCode,0);assert.equal((await f.journal().load(pending.execution.attempt.attempt_id))!.attempt.state,'unknown');
}));

test('r5 transport death and terminal notification are cleanup hints only, never journal completion proof',async()=>{
 for(const terminal of [false,true])await fixture('idle-cleanup-'+terminal,async(f,n,owner,opts)=>{
 const p=await new CodexLayoutCheckAdapter(opts).execute(f.input,identity('r5-idle-'+terminal),signal());
 n.emit(terminal?{method:'turn/completed',params:{threadId:'qa-thread',turn:{id:'qa-turn',status:'completed'}}}:{method:'$transport/error'});await owner.close();
 assert.equal(n.closes,1);assert.equal((await f.journal().load(p.execution.attempt.attempt_id))!.attempt.state,'unknown');assert.equal(n.reads,0);
 });
});

test('r5 abort and owner shutdown reclaim active transport without timer/listener leaks or new submission',async()=>{
 for(const mode of ['abort','close'])await fixture('active-'+mode,async(f,n,owner,opts)=>{
 const abort=new AbortController(),adapter=new CodexLayoutCheckAdapter({...opts,timeout_ms:120000});const work=adapter.execute(f.input,identity('r5-'+mode),abort.signal);
 while(!n.starts)await new Promise<void>(r=>setImmediate(r));if(mode==='abort')abort.abort();else owner.beginClose();
 const result=await work;assert.equal(result.execution.attempt.state,'unknown');await owner.close();assert.equal(n.closes,1);assert.equal(n.listeners.size,0);assert.equal(n.starts,1);
 });
});

test('r5 process restart keeps unknown; original-ID recovery uses only thread/read with no start/resume/turn',async()=>fixture('restart-unknown',async(f,n,owner,opts)=>{
 const p=await new CodexLayoutCheckAdapter(opts).execute(f.input,identity('r5-restart'),signal());await owner.close();f.reopen();
 const reader=new QAOnlyNative('complete');reader.input=n.input;reader.binding=n.binding;const restarted=new LayoutCheckSessions();
 try{const query=new CodexLayoutCheckAdapter({...opts,journal:f.journal(),session_owner:restarted,native_factory:()=>reader});const done=await query.query(p.execution.attempt.attempt_id,signal());assert.equal(done.execution.attempt.state,'completed');assert.equal(reader.threads,0);assert.equal(reader.starts,0);assert.equal(reader.reads,1);assert.equal(n.starts,1);}finally{await restarted.close();}
}));

test('r5 actual HTTP/worker recovery consumes one strict receipt/current CAS and keeps article/images/record history idempotent',async()=>{
 const f=await workflowFixture('stall');try{
 const saved=await f.save(),beforeDoc=await f.documents.get(f.request(),f.documentId),job=await f.enqueue();await f.worker.runOnce();assert.equal((await f.status()).latest?.state,'unknown');assert.equal(f.native.closes,0);assert.equal(f.native.starts,1);
 f.native.mode='complete';await f.call('POST','/api/v1/article-layout/visual-queries',{topic_id:f.topic.id,job_id:job.job_id});assert.equal((await f.worker.runOnce())?.state,'committed');
 assert.equal((await f.status()).latest?.state,'completed');const snapshot=(await f.load()).snapshot;assert.equal(snapshot.checks.length,1);assert.equal(snapshot.text_hash,saved.snapshot.text_hash);assert.equal(snapshot.images_hash,saved.snapshot.images_hash);assert.equal((await f.documents.get(f.request(),f.documentId)).head_revision_id,beforeDoc.head_revision_id);
 const record=f.jobRecord(job.job_id);assert.ok(record.consume_expected_version);assert.ok(record.consumed_receipt_id);const v=snapshot.version;await f.status();assert.equal((await f.load()).snapshot.version,v);assert.equal(getJob(f.context.db,f.app.identity.workspace_id,job.job_id).state,'succeeded');assert.equal(f.context.db.prepare("SELECT count(*) n FROM result_receipts WHERE job_id=? AND state='committed'").get(job.job_id)!.n,1);assert.equal(f.native.starts,1);assert.equal(f.native.threads,1);assert.equal(f.native.closes,1);
 }finally{await f.close();}
});

test('r5 actual workspace slot remains occupied until owned child exit and can then be acquired again',async()=>fixture('slot-exit-order',async(f,n,owner,opts)=>{
 const execution=newLayoutCheckExecution(f.input,identity('r5-slot'),true),slot=acquire(join(f.directory,'locks'),opts.workspace_id,'codex');slot.starting();slot.bindChild(n.child.pid!);
 const session=owner.take(execution,opts,()=>({native:n,slot}));assert.throws(()=>acquire(join(f.directory,'locks'),opts.workspace_id,'codex'),/槽位占用/);
 let allow!:()=>void;const exitGate=new Promise<void>(r=>{allow=r;});const realClose=n.close.bind(n);n.close=async()=>{await exitGate;await realClose();};
 const closing=owner.release(session,false);await Promise.resolve();assert.equal(n.child.exitCode,null);assert.throws(()=>acquire(join(f.directory,'locks'),opts.workspace_id,'codex'),/槽位占用/);
 allow();await closing;assert.equal(n.child.exitCode,0);const next=acquire(join(f.directory,'locks'),opts.workspace_id,'codex');next();assert.equal(owner.size,0);
}));

test('r5 HTTP cancellation after timeout closes the held transport; cancellation stays visible after article edits and late native events',async()=>{
 const f=await workflowFixture('stall');try{
 const job=await f.enqueue();await f.worker.runOnce();assert.equal(f.native.closes,0);assert.equal((await f.status()).latest?.state,'unknown');await f.save();
 const cancelled=await f.call<{state:string}>('POST','/api/v1/article-layout/visual-cancellations',{topic_id:f.topic.id,job_id:job.job_id});assert.equal(cancelled.state,'cancelled');assert.equal(f.native.closes,1);
 f.native.emit({method:'turn/completed',params:{threadId:'qa-thread',turn:{id:'qa-turn',status:'completed'}}});assert.equal((await f.status()).latest?.state,'cancelled');assert.equal((await f.load()).snapshot.checks.length,0);
 const r=await f.response('POST','/api/v1/article-layout/visual-queries',{topic_id:f.topic.id,job_id:job.job_id});await r.json();assert.notEqual(r.status,200);assert.equal(f.native.starts,1);assert.equal(f.native.threads,1);assert.equal(f.context.db.prepare("SELECT count(*) n FROM result_receipts WHERE job_id=? AND state='committed'").get(job.job_id)!.n,0);
 }finally{await f.close();}
});

test('r5 workflow close drains active execution and preserves unknown before its SQL owner shuts down',async()=>{
 const f=await workflowFixture('stall');try{
 f.runtime.workflow.options.timeout_ms=120000;let started!:()=>void;const entered=new Promise<void>(done=>{started=done;});f.native.turnStarted=started;
 const job=await f.enqueue(),work=f.worker.runOnce();await entered;f.runtime.workflow.beginClose();await Promise.all([f.runtime.workflow.close(),work]);
 const record=f.jobRecord(job.job_id),execution=f.runtime.workflow.journal.read(record.execution_attempt_id!)!;assert.equal(execution.submit_count,1);assert.equal(execution.attempt.state,'unknown');assert.equal(execution.attempt.result,null);assert.equal(f.native.closes,1);assert.equal(f.native.listeners.size,0);assert.equal(f.context.db.prepare('SELECT count(*) n FROM result_receipts WHERE job_id=?').get(job.job_id)!.n,0);
 }finally{await f.close();}
});

test('r5 fresh original-ID reader that returns running or errors never retains a slot without carrying the original submission',async()=>{
 for(const kind of ['running','read-error'])await fixture('fresh-reader-'+kind,async(f,n,owner,opts)=>{
 const pending=await new CodexLayoutCheckAdapter(opts).execute(f.input,identity('r5-reader-'+kind),signal());await owner.close();
 const freshOwner=new LayoutCheckSessions(),reader=new QAOnlyNative('complete');reader.input=n.input;reader.binding=n.binding;const request=reader.request.bind(reader);
 reader.request=async(method,params)=>{if(method==='thread/read'&&kind==='read-error')throw Error('controlled original thread not found');const r:any=await request(method,params);if(method==='thread/read')r.thread.turns[0].status='inProgress';return r;};
 try{const result=await new CodexLayoutCheckAdapter({...opts,session_owner:freshOwner,native_factory:()=>reader}).query(pending.execution.attempt.attempt_id,signal());assert.equal(result.execution.attempt.state,'unknown');assert.equal(reader.starts,0);assert.equal(reader.threads,0);assert.equal(reader.closes,1);assert.equal(freshOwner.size,0);assert.equal((await f.journal().load(pending.execution.attempt.attempt_id))!.attempt.state,'unknown');}finally{await freshOwner.close();}
 });
});

test('r5 close rejection remains visible and cannot release the slot or claim a live child exited',async()=>fixture('close-rejection',async(f,n,owner,opts)=>{
 const execution=newLayoutCheckExecution(f.input,identity('r5-rejected-close'),true),slot=acquire(join(f.directory,'locks'),opts.workspace_id,'codex');slot.starting();slot.bindChild(n.child.pid!);
 owner.take(execution,opts,()=>({native:n,slot}));const actualClose=n.close.bind(n);n.close=async()=>{throw Error('controlled close failed; child is still alive');};
 try{await assert.rejects(owner.close(),/controlled close failed/);assert.equal(n.child.exitCode,null);assert.equal(owner.size,1);assert.throws(()=>acquire(join(f.directory,'locks'),opts.workspace_id,'codex'),/槽位占用/);}finally{n.close=actualClose;await owner.close();}
 assert.equal(n.child.exitCode,0);assert.equal(owner.size,0);const next=acquire(join(f.directory,'locks'),opts.workspace_id,'codex');next();
}));

test('r5 terminal cleanup also reclaims an original submitting transport whose turn ID acknowledgement was lost; it does not invent that ID in the journal',async()=>fixture('late-terminal-missing-ID',async(f,n,owner,opts)=>{
 const emit=n.emit.bind(n),request=n.request.bind(n);n.emit=message=>{if(message.method!=='turn/started')emit(message);};
 n.request=async(method,params)=>{const result=await request(method,params);if(method==='turn/start')throw Error('controlled reply lost before turn ID observation');return result;};
 const p=await new CodexLayoutCheckAdapter(opts).execute(f.input,identity('r5-lost-id'),signal());assert.equal(p.execution.attempt.state,'unknown');assert.equal(p.execution.attempt.native.turn_id,null);assert.equal(n.closes,0);
 let timer:NodeJS.Timeout|undefined;const exited=once(n.child,'exit');
 try{emit({method:'turn/completed',params:{threadId:'qa-thread',turn:{id:'qa-turn',status:'completed'}}});await Promise.race([exited,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('late terminal did not reclaim the unacknowledged original child')),2000);})]);await new Promise<void>(done=>setImmediate(done));assert.equal(owner.size,0,'terminal hint must reclaim before explicit owner.close');assert.equal(n.closes,1);assert.equal(n.child.exitCode,0);}finally{if(timer)clearTimeout(timer);await owner.close();}
 const original=(await f.journal().load(p.execution.attempt.attempt_id))!;assert.equal(original.attempt.native.turn_id,null);assert.equal(original.attempt.state,'unknown');assert.equal(original.attempt.result,null);
}));

/** R6 controlled close gate: only a real owned node child, never the Codex executable. */
function actualSlot(f:ReturnType<typeof setup>,n:HeldNative,owner:LayoutCheckSessions,opts:LayoutCheckOptions){
 const counts={release:0,childExited:0,lifetimeDetached:0,listenersAtExit:-1},events:Array<{event:string;exit:number|null}>=[],take=owner.take.bind(owner),observe=n.observe.bind(n);let observer=0;
 n.child.once('exit',()=>{counts.listenersAtExit=n.listeners.size;events.push({event:'child_exit',exit:n.child.exitCode});});
 n.observe=listener=>{const first=++observer===1,detach=observe(listener);return()=>{if(first){counts.lifetimeDetached++;events.push({event:'lifetime_detach',exit:n.child.exitCode});}return detach();};};
 owner.take=(execution,options,open)=>take(execution,options,()=>{const client=open(),real=acquire(join(f.directory,'actual-slots'),opts.workspace_id,'codex');real.starting();real.bindChild(n.child.pid!);const slot=(()=>{counts.release++;events.push({event:'slot_release',exit:n.child.exitCode});real();}) as WorkspaceSlot;Object.defineProperty(slot,'id',{value:real.id});slot.starting=()=>real.starting();slot.bindChild=pid=>real.bindChild(pid);slot.childExited=()=>{counts.childExited++;events.push({event:'slot_childExited',exit:n.child.exitCode});real.childExited();};slot.markUnverified=reason=>real.markUnverified(reason);return{...client,slot};});
 const occupied=()=>assert.throws(()=>acquire(join(f.directory,'actual-slots'),opts.workspace_id,'codex'),/槽位占用/);
 const released=()=>{const probe=acquire(join(f.directory,'actual-slots'),opts.workspace_id,'codex');probe();assert.equal(counts.release,1);assert.equal(counts.childExited,1);assert.equal(counts.lifetimeDetached,1);assert.equal(counts.listenersAtExit,1,'mandatory observer must remain through actual exit');assert.ok(events.findIndex(e=>e.event==='child_exit')<events.findIndex(e=>e.event==='lifetime_detach'));assert.ok(events.filter(e=>e.event!=='child_exit').every(e=>e.exit===0));writeFileSync(join(f.directory,'close-order.json'),JSON.stringify({counts,events},null,2));};
 return{counts,events,occupied,released};
}

test('r6 mandatory denial remains through pending close while the original child and slot are live',async()=>fixture('r6-pending-close',async(f,n,owner,opts)=>{
 const slot=actualSlot(f,n,owner,opts),p=await new CodexLayoutCheckAdapter(opts).execute(f.input,identity('r6-pending'),signal());let allow!:()=>void,attempts=0;const gate=new Promise<void>(done=>{allow=done;}),actual=n.close.bind(n);n.close=async()=>{attempts++;await gate;await actual();};const closing=owner.cancel(opts.workspace_id,p.execution.attempt.job_id);
 try{await new Promise<void>(done=>setImmediate(done));slot.occupied();assert.equal(n.child.exitCode,null);assert.equal(n.child.stdin!.writable,true);n.emit({id:801,method:'item/tool/requestUserInput'});n.emit({id:802,method:'item/commandExecution/requestApproval'});await new Promise<void>(done=>setImmediate(done));writeFileSync(join(f.directory,'pending-observation.json'),JSON.stringify({denied:n.denied,listeners:n.listeners.size,attempts,child_exit:n.child.exitCode,slot_releases:slot.counts.release}));assert.equal(n.denied,2);assert.equal(n.listeners.size,1);assert.equal(attempts,1);assert.equal(slot.counts.release,0);}
 finally{allow();await closing;n.close=actual;}
 slot.released();assert.equal(owner.size,0);assert.equal(n.closes,1);assert.equal(n.starts,1);assert.equal(n.threads,1);assert.equal((await f.journal().load(p.execution.attempt.attempt_id))!.attempt.state,'unknown');
}));

test('r6 mandatory denial survives close rejection until explicit successful retry and actual child exit',async()=>fixture('r6-rejected-close',async(f,n,owner,opts)=>{
 const slot=actualSlot(f,n,owner,opts),p=await new CodexLayoutCheckAdapter(opts).execute(f.input,identity('r6-rejected'),signal()),actual=n.close.bind(n);let attempts=0;n.close=async()=>{attempts++;throw Error('r6 controlled first close rejection; child remains live');};
 try{await assert.rejects(owner.close(),/controlled first close rejection/);slot.occupied();assert.equal(n.child.exitCode,null);assert.equal(n.child.stdin!.writable,true);assert.equal(owner.size,1);n.emit({id:803,method:'item/tool/requestUserInput'});n.emit({id:804,method:'item/commandExecution/requestApproval'});n.emit({method:'$transport/error'});n.emit({method:'turn/completed',params:{threadId:'qa-thread',turn:{id:'qa-turn',status:'completed'}}});await new Promise<void>(done=>setImmediate(done));writeFileSync(join(f.directory,'rejection-observation.json'),JSON.stringify({denied:n.denied,listeners:n.listeners.size,attempts,child_exit:n.child.exitCode,slot_releases:slot.counts.release}));assert.equal(n.denied,2);assert.equal(n.listeners.size,1);assert.equal(attempts,1,'late requests must deny without automatic close-retry recursion');assert.equal(slot.counts.release,0);}
 finally{n.close=actual;await owner.close();}
 slot.released();assert.equal(n.closes,1);assert.equal(owner.size,0);assert.equal((await f.journal().load(p.execution.attempt.attempt_id))!.attempt.state,'unknown');
}));

test('r6 concurrent repeated cancel and close share one pending shutdown and keep denial until single exit cleanup',async()=>fixture('r6-concurrent-close',async(f,n,owner,opts)=>{
 const slot=actualSlot(f,n,owner,opts),p=await new CodexLayoutCheckAdapter(opts).execute(f.input,identity('r6-concurrent'),signal()),actual=n.close.bind(n);let allow!:()=>void,attempts=0;const gate=new Promise<void>(done=>{allow=done;});n.close=async()=>{attempts++;await gate;await actual();};
 const closes=[owner.cancel(opts.workspace_id,p.execution.attempt.job_id),owner.cancel(opts.workspace_id,p.execution.attempt.job_id),owner.close(),owner.close()];owner.beginClose();
 try{await new Promise<void>(done=>setImmediate(done));slot.occupied();n.emit({id:805,method:'item/tool/requestUserInput'});n.emit({id:806,method:'item/commandExecution/requestApproval'});n.emit({method:'$transport/error'});await new Promise<void>(done=>setImmediate(done));assert.equal(n.denied,2);assert.equal(n.listeners.size,1);assert.equal(attempts,1);assert.equal(n.child.exitCode,null);assert.equal(slot.counts.release,0);}
 finally{allow();await Promise.all(closes);n.close=actual;}
 slot.released();await owner.close();assert.equal(n.closes,1);assert.equal(owner.size,0);assert.equal(n.starts,1);assert.equal(n.threads,1);
}));

process.on('beforeExit',()=>writeFileSync(join(base,'native-lifecycle-results.json'),JSON.stringify({task:'MAIN-INTEGRATION-R5/r5',fixture:true,real_model_calls:0,results},null,2)));
