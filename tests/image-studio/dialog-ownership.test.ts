// 配图弹窗归属与操作锁（#38 修法推广）：面板失活（导航/刷新/切主题）时，屏幕上属于配图的弹窗一律关掉并说明，busy 复位；
// 工作台里迟到的结果不能关掉或解锁用户之后打开的别的弹窗；找图窗口在后台补图期间自动并入新候选、失败可重试。
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {ImageStudioController,orphanDialogCopy} from '../../apps/web/src/features/media/image-studio/index.ts';
import type {ImageStudioPort} from '../../apps/web/src/features/media/image-studio/index.ts';
import type {StudioSnapshot,StudioWebCandidateView,StudioWebCandidateList,StudioWebCaptureView} from '../../apps/web/src/features/media/image-studio/model.ts';
import {WORKBENCH_TITLES} from '../../apps/web/src/features/media/image-studio/workbench.ts';
import {workbench,loadValue,capability,deferred,el,settle} from './workbench-harness.ts';
const snapshot:StudioSnapshot={topic_id:'topic',document_revision_id:'revision',version:1,title:'文章',article:'正文',paragraphs:[{id:'p1',label:'第1段',text:'正文'}],slots:[],references:[],capabilities:[]};
const item=(id:string,group:'article'|'posts'='article'):StudioWebCandidateView=>({id,image_url:'https://news.example/'+id+'.png',thumb_url:'https://news.example/'+id+'.png',credit:'图源：Example',page_url:'https://news.example/a',page_label:'Example',group,selectable:true,note:''});
const FRESH:StudioWebCaptureView={refreshing:false,note:'',retry:false,tone:'none'};
const REFRESHING:StudioWebCaptureView={refreshing:true,note:'正在从资讯原文补充更多图片，读到后会自动出现在这里',retry:false,tone:'info'};
const FAILED:StudioWebCaptureView={refreshing:false,note:'资讯原文暂时读不到，原文里的图片可能没列全',retry:true,tone:'warn'};
const flush=async()=>{for(let i=0;i<10;i++)await new Promise<void>(r=>setImmediate(r));};
// 宿主替身：#dialog 带标题节点，presentDialog 记录并更新标题；close() 模拟原生 <dialog> 关闭。
function fixture(lists:Array<()=>Promise<StudioWebCandidateList>>=[async()=>({items:[],capture:FRESH})]){
 const toasts:string[]=[],presented:Array<{title:string;body:string;foot?:string}>=[],requests:Array<{refresh?:boolean}|undefined>=[];let calls=0;
 const title={textContent:''},body={scrollTop:0,querySelector:()=>null,insertAdjacentHTML(){}},capture={innerHTML:''};
 const dialog={open:false,closed:0,querySelector:(s:string)=>s==='#dialog-title'?title:s==='.studio-web'?(title.textContent==='公众号配图 · 从网络找图'?{}:null):null,close(){this.open=false;this.closed++;}};
 const root={querySelector:(s:string)=>s==='#dialog'?dialog:s==='#dialog .dialog-body'?body:s==='#dialog #studio-web-capture'?capture:s==='.image-studio-panel'?{innerHTML:''}:null,querySelectorAll:()=>[]} as unknown as HTMLElement;
 const port={load:async()=>structuredClone(snapshot),webCandidates:async(_t:string,_c:unknown,o?:{refresh?:boolean})=>{requests.push(o);const next=lists[Math.min(calls,lists.length-1)]!;calls++;return next();},webImport:async()=>{throw new Error('unused');}} as unknown as ImageStudioPort;
 const c:any={identity:{workspace_id:'ws',service_instance_id:'svc'},ui:{topic:'topic'},signal:new AbortController().signal,drafts:{leave:async()=>{}},surface:{presentDialog:(d:{title:string;body:string;foot?:string})=>{presented.push(d);title.textContent=d.title;dialog.open=true;},dialogBusy(){},closeDialog:()=>{controller.close();dialog.open=false;}}};
 const controller=new ImageStudioController({root,context:()=>c,active:()=>true,signal:c.signal,toast:m=>toasts.push(m),port}),internal=controller as any;internal.topic='topic';internal.snapshot=structuredClone(snapshot);
 const show=(t:string)=>{title.textContent=t;dialog.open=true;};
 return {controller,internal,toasts,presented,requests,dialog,capture,show,get calls(){return calls;}};
}

test('deactivate closes every orphaned image-studio dialog (form, preview, compare, job, workbench dialogs) with a reason, and resets the busy lock',()=>{
 const titles=['新增正文配图','修改配图','调整这张图的画幅与尺寸','公众号配图 · 阅读预览','公众号配图 · 版本比较','公众号配图 · 任务','公众号配图 · 从网络找图',...WORKBENCH_TITLES];
 for(const title of titles){const f=fixture();f.internal.dialogOpen=title.startsWith('公众号配图 · 批量')?false:true;f.internal.dialogTitle=title;f.internal.busy=true;f.show(title);
  f.controller.deactivate();assert.equal(f.dialog.closed,1,title+' 应被关闭');assert.equal(f.internal.busy,false,title+' busy 复位');assert.equal(f.toasts.length,1);assert.match(f.toasts[0]!,/页面已刷新/);assert.ok(f.toasts[0]!.includes('窗口已关闭'),title);}
 assert.match(orphanDialogCopy('新增正文配图'),/未提交的内容没有保存/);assert.match(orphanDialogCopy('公众号配图 · 任务'),/图片仍在生成/);assert.match(orphanDialogCopy('公众号配图 · 批量生成'),/已入队的图片不受影响/);
 assert.equal(orphanDialogCopy('公众号配图 · 从网络找图'),'页面已刷新，找图窗口已关闭，请重新打开「从网络找图」并勾选','与 #38 文案一致');
});
test('deactivate leaves dialogs of other features alone and stays silent when nothing is open',()=>{
 const f=fixture();f.show('选择发布账号');f.controller.deactivate();assert.equal(f.dialog.closed,0);assert.deepEqual(f.toasts,[]);
 const g=fixture();g.controller.deactivate();assert.equal(g.dialog.closed,0);assert.deepEqual(g.toasts,[]);
});
test('a submit stuck after deactivate does not keep the panel locked: after reactivation actions are handled again',async()=>{
 const f=fixture();f.internal.dialogOpen=true;f.internal.dialogTitle='新增正文配图';f.show('新增正文配图');f.internal.busy=true;
 assert.equal(f.controller.handle({dataset:{action:'studio-preview'}} as unknown as HTMLElement),true);assert.equal(f.presented.length,0,'busy 时点击被吞');
 f.controller.deactivate();f.internal.topic='topic';f.internal.snapshot=structuredClone(snapshot);
 f.controller.handle({dataset:{action:'studio-preview'}} as unknown as HTMLElement);await flush();assert.equal(f.presented.at(-1)?.title,'公众号配图 · 阅读预览','失活复位后不再被旧锁挡住');
});
test('find-images dialog: cached candidates show at once with a light "补充更多图片" hint; background results merge without losing picks; polling stops when fresh',async()=>{
 mock.timers.enable({apis:['setTimeout']});
 try{const f=fixture([async()=>({items:[item('x','posts')],capture:REFRESHING}),async()=>({items:[item('x','posts')],capture:REFRESHING}),async()=>({items:[item('a'),item('b'),item('x','posts')],capture:FRESH})]);
  f.controller.handle({dataset:{action:'studio-web'}} as unknown as HTMLElement);await flush();
  const shown=f.presented.length,first=f.presented.at(-1)!;assert.equal(first.title,'公众号配图 · 从网络找图');assert.match(first.body,/正在从资讯原文补充更多图片/);assert.match(first.body,/同题帖子配图/);assert.doesNotMatch(first.body,/还没有可用的网络配图/);
  f.controller.handleChange({id:'studio-web-pick-x',checked:true,closest:()=>null} as unknown as HTMLInputElement);
  mock.timers.tick(1000);await flush();assert.equal(f.calls,2);assert.equal(f.presented.length,shown,'候选没变化时不重绘整窗');
  mock.timers.tick(1500);await flush();assert.equal(f.calls,3);const merged=f.presented.at(-1)!;assert.match(merged.body,/资讯原文配图/);assert.match(merged.body,/studio-web-pick-a/);assert.doesNotMatch(merged.body,/正在从资讯原文补充/);
  assert.ok(f.internal.web.picked.has('x'),'已勾选的保留');assert.match(merged.body,/id="studio-web-pick-x" checked/);
  mock.timers.tick(10000);await flush();assert.equal(f.calls,3,'读完后停止轮询');
 }finally{mock.timers.reset();}
});
test('find-images dialog: a failed capture is visible with a retry that asks the service to re-read now; closing the dialog stops polling',async()=>{
 mock.timers.enable({apis:['setTimeout']});
 try{const f=fixture([async()=>({items:[item('x','posts')],capture:FAILED}),async()=>({items:[item('x','posts')],capture:REFRESHING}),async()=>({items:[item('a'),item('x','posts')],capture:FRESH})]);
  f.controller.handle({dataset:{action:'studio-web'}} as unknown as HTMLElement);await flush();const body=f.presented.at(-1)!.body;assert.match(body,/资讯原文暂时读不到/);assert.match(body,/data-action="studio-web-retry"/);
  f.controller.handle({dataset:{action:'studio-web-retry'}} as unknown as HTMLElement);await flush();assert.deepEqual(f.requests.at(-1),{refresh:true});assert.match(f.capture.innerHTML,/正在从资讯原文补充更多图片/,'重试后状态行变成补图中');
  mock.timers.tick(1000);await flush();assert.equal(f.calls,3);assert.match(f.presented.at(-1)!.body,/studio-web-pick-a/,'重试读到的新图并入');
  // 关闭窗口后不再轮询。
  const g=fixture([async()=>({items:[],capture:REFRESHING})]);g.controller.handle({dataset:{action:'studio-web'}} as unknown as HTMLElement);await flush();g.controller.close();mock.timers.tick(20000);await flush();assert.equal(g.calls,1);
 }finally{mock.timers.reset();}
});
test('find-images dialog: still refreshing after ~2 minutes of polls turns into a "读取较慢，可重试" note instead of spinning forever',async()=>{
 mock.timers.enable({apis:['setTimeout']});
 try{const f=fixture([async()=>({items:[],capture:REFRESHING})]);f.controller.handle({dataset:{action:'studio-web'}} as unknown as HTMLElement);await flush();
  for(let i=0;i<40;i++){mock.timers.tick(5000);await flush();}assert.ok(f.calls<=31,'轮询有上限');assert.match(f.capture.innerHTML,/读取得比较慢/);assert.match(f.capture.innerHTML,/studio-web-retry/);
 }finally{mock.timers.reset();}
});

// 工作台（A2-2）：替换宿主的弹窗关闭/锁记录。
function recorder(t:ReturnType<typeof workbench>){const ctx=(t.w as any).host.context(),log:string[]=[];ctx.surface.closeDialog=(r:string)=>{log.push('close:'+r);t.w.dialogClosed();};/* 宿主关闭弹窗时会通知工作台 */ctx.surface.dialogBusy=(b:boolean)=>log.push('busy:'+b);return log;}
const agy=capability('agy',{selectable:true,block:null,message:'',detail:null,unverified:false,remaining:3,limit:5}),codex=capability('codex',{selectable:true,block:null,message:'',detail:null,unverified:false,remaining:3,limit:5});
function filled(){const v=loadValue('ready',[agy,codex]) as any;v.plan.items[0]={...v.plan.items[0],status:'filled',current_version:{id:'v1',index:1,auto_selected:false,credit_label:null,operation:'generate'}};v.studio.slots=[{id:'slot-a',title:'图注 a',versions:[{id:'v1',slot_id:'slot-a',asset_id:'asset-v1',state:'succeeded',provider:'agy',operation:'generate',source:null,description:'d',actual:{width:1600,height:900},requested:{width:1600,height:900},marks:[]}]}];return v;}
test('workbench resize: a late result after the user closed the resize dialog and opened another one does not close or unlock the newer dialog',async()=>{
 const v=filled(),t=workbench([async()=>v],{update:async()=>v.plan} as never);t.w.open('topic');await settle();await settle();const log=recorder(t),w=t.w as any,gate=deferred<{job_id:string;input_hash:string}>();
 w.host.submit=()=>gate.promise;
 await t.w.handle('studio-wb-resize',el({item:'a'}));w.handleChange({id:'studio-wb-resize-ratio',value:'3:4'});await t.w.handle('studio-wb-resize-next',el());assert.equal(log.length,0,'选好尺寸后先确认，不直接提交');const running=t.w.handle('studio-wb-resize-confirm',el());await settle();assert.deepEqual(log,['busy:true']);
 t.w.dialogClosed();await t.w.handle('studio-wb-resize',el({item:'a'}));const newer=w.resizeDraft;assert.ok(newer);
 gate.resolve({job_id:'job',input_hash:'h'});await running;
 assert.deepEqual(log,['busy:true'],'迟到的结果没有关掉或解锁新打开的窗口');assert.equal(w.resizeDraft,newer);assert.match(t.toasts.at(-1)!,/新尺寸版本已入队/,'已提交的结果照常提示');
 // 对照：窗口一直开着时，完成后照常解锁并关闭。
 const gate2=deferred<{job_id:string;input_hash:string}>();w.host.submit=()=>gate2.promise;log.length=0;await t.w.handle('studio-wb-resize-next',el());const again=t.w.handle('studio-wb-resize-confirm',el());await settle();gate2.resolve({job_id:'job2',input_hash:'h'});await again;assert.deepEqual(log,['busy:true','busy:false','close:completed']);
});
test('workbench batch generate: an old batch that stopped because its confirmation closed does not release the lock of a newer dialog',async()=>{
 const hold=deferred<ReturnType<typeof loadValue>>(),t=workbench([async()=>loadValue(),()=>hold.promise,async()=>loadValue()]);t.w.open('topic');await settle();await settle();const log=recorder(t);
 await t.w.handle('studio-wb-generate-all',el());const old=t.w.handle('studio-wb-generate-all-confirm',el());await settle();assert.deepEqual(log,['busy:true']);
 t.w.dialogClosed();(t.w as any).host.context().surface.dialogBusy(true);/* 另一个弹窗进入忙碌 */hold.resolve(loadValue());await old;
 assert.deepEqual(log,['busy:true','busy:true'],'旧批次结束时不解锁新弹窗');assert.equal(t.submits.length,0);
});
test('workbench sources tab: refreshing shows a light hint and polls; new candidates appear without user refresh; failure offers retry with refresh=1; closing stops polling',async()=>{
 mock.timers.enable({apis:['setTimeout']});
 try{const seen:Array<{refresh?:boolean}|undefined>=[];const answers=[{items:[item('x','posts')],capture:REFRESHING},{items:[item('a'),item('x','posts')],capture:FRESH},{items:[item('a')],capture:FAILED},{items:[item('a'),item('b')],capture:FRESH}];let n=0;
  const t=workbench([async()=>loadValue()],{candidates:async(_t:string,_c:unknown,o?:{refresh?:boolean})=>{seen.push(o);return answers[Math.min(n++,answers.length-1)]!;}} as never);t.w.open('topic');await flush();const w=t.w as any;
  assert.equal(w.candidates.length,1);assert.match(w.captureLine(),/正在从资讯原文补充更多图片/);assert.doesNotMatch(w.captureLine(),/studio-wb-candidates-retry/);
  mock.timers.tick(1000);await flush();assert.equal(n,2);assert.deepEqual(w.candidates.map((c:StudioWebCandidateView)=>c.id),['a','x'],'后台读到的新图自动出现');assert.equal(w.captureLine(),'');
  mock.timers.tick(20000);await flush();assert.equal(n,2,'读完后停止轮询');
  // 再次进入：失败可见，可重试（带 refresh）。
  w.close();w.open('topic');await flush();assert.equal(n,3);assert.match(w.captureLine(),/资讯原文暂时读不到/);assert.match(w.captureLine(),/studio-wb-candidates-retry/);
  await t.w.handle('studio-wb-candidates-retry',el());assert.deepEqual(seen.at(-1),{refresh:true});assert.deepEqual(w.candidates.map((c:StudioWebCandidateView)=>c.id),['a','b']);
  const u=workbench([async()=>loadValue()],{candidates:async()=>{n++;return {items:[],capture:REFRESHING};}} as never);u.w.open('topic');await flush();const before=n;u.w.close();mock.timers.tick(30000);await flush();assert.equal(n,before,'关闭工作台后不再轮询');
 }finally{mock.timers.reset();}
});

// 旧版提交一直没有任务编号的本机锁：未超时不显示放弃入口；超过 3 分钟在面板与工作台加图处显示；只有点击才清锁，清后可新增。
test('pending without job id: no abandon offer before 3 minutes, shown after, never auto-cleared, a click clears it and adding works again',async()=>{
 mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-10-15T00:00:00Z')});
 const store=new Map<string,string>();(globalThis as any).localStorage={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}};
 try{const {PENDING_ABANDON_MS}=await import('../../apps/web/src/features/media/image-studio/index.ts');const f=fixture();
  const pending={topic_id:'topic',key:'k1',job_id:null,input_hash:null,input:{description:'一张图'},created_at:Date.now()};f.internal.pending=pending;f.internal.savePending(pending);f.internal.watchPending();
  const panel=()=>String(f.internal.legacyPanel()),add=async()=>{f.controller.handle({dataset:{action:'studio-add'}} as unknown as HTMLElement);await flush();};
  assert.equal(f.controller.pendingStale(),false);assert.doesNotMatch(panel(),/放弃这次请求/);await add();assert.match(f.toasts.at(-1)!,/本轮任务结果待核对/,'未超时仍按原规则挡住');
  assert.equal(f.controller.abandonPending(),false,'未超时调用放弃也不清');assert.ok(f.internal.pending);
  mock.timers.tick(PENDING_ABANDON_MS+100);assert.equal(f.controller.pendingStale(),true);assert.match(panel(),/这次请求没有回应，可以放弃后重新发起/);assert.match(panel(),/data-action="studio-abandon-pending"/);
  await add();assert.match(f.toasts.at(-1)!,/这次请求没有回应/);assert.ok(f.internal.pending,'超时也不自动清锁');assert.equal(store.size,1,'本机记录仍在');
  assert.equal((f.controller.workbench as any).host.pendingStale(),true,'工作台加图处拿到同一判断');
  f.controller.handle({dataset:{action:'studio-abandon-pending'}} as unknown as HTMLElement);assert.equal(f.internal.pending,undefined);assert.equal(store.size,0);assert.match(f.toasts.at(-1)!,/已放弃这次请求/);
  await add();assert.equal(f.presented.at(-1)?.title,'新增正文配图','清锁后可以新增');
  const g=fixture();g.internal.pending={...pending,created_at:undefined};assert.equal(g.controller.pendingStale(),true,'没有登记时间的旧记录按已超时处理');assert.ok(g.internal.pending);
  const h=fixture();h.internal.pending={...pending,job_id:'job-1',created_at:0};assert.equal(h.controller.pendingStale(),false,'已有任务编号的不提供放弃');
 }finally{mock.timers.reset();delete (globalThis as any).localStorage;}
});
test('workbench add row shows the abandon offer only when the host reports a stale pending; the button calls the host',async()=>{
 const t=workbench([async()=>loadValue()]);let stale=false,abandoned=0;const host=(t.w as any).host;host.pendingStale=()=>stale;host.abandonPending=()=>{abandoned++;stale=false;};t.w.open('topic');await settle();await settle();
 const markup=()=>String((t.w as any).markup());assert.doesNotMatch(markup(),/放弃这次请求/);stale=true;assert.match(markup(),/这次请求没有回应，可以放弃后重新发起/);assert.match(markup(),/studio-wb-abandon-pending/);
 await t.w.handle('studio-wb-abandon-pending',el());assert.equal(abandoned,1);assert.doesNotMatch(markup(),/放弃这次请求/);
});
