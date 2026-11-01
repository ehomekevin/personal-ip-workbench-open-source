// 配图工作台日用走查修复：真实生图先确认（单张 / 修改版 / 批量），卡片不放「生成」，确认配图进行中与失败重试，
// 排版已确认时步骤条与「确认配图」说明后果，每张图的「从网络找图」与补图提示，方案项名称不随上下移变化。
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {workbench,loadValue,el,settle} from '../image-studio/workbench-harness.ts';
import {ConfirmArm} from '../../apps/web/src/features/media/image-studio/generate-confirm.ts';
import {projectWorkbench,itemName,stableNames} from '../../apps/web/src/features/media/image-studio/plan-model.ts';
import type {WorkbenchLayoutStatus} from '../../apps/web/src/features/media/image-studio/workbench.ts';
const withLayout=(w:unknown)=>{(w as {host:{openLayout(topic:string):void}}).host.openLayout=()=>{};};
const markupOf=(w:unknown)=>String((w as {markup():string}).markup());
const confirmed=(pending=0,isFinal=true,current=true)=>{const v=loadValue();Object.assign(v.plan,{final:{pending,confirmed:isFinal,current,confirmed_at:isFinal?'2026-10-15T00:00:00Z':null}});return v;};

test('single generate: clicking 生成这张 only opens a confirmation with channel, model and count; nothing is submitted until confirmed',async()=>{
 const t=workbench([async()=>loadValue()]);t.w.open('topic');await settle();await settle();
 await t.w.handle('studio-wb-focus',el({item:'a'}));await t.w.handle('studio-wb-generate',el({item:'a'}));
 assert.equal(t.submits.length,0,'点击生成不直接发请求');const d=t.dialogs.at(-1)!;
 assert.equal(d.title,'公众号配图 · 确认生成');assert.match(d.body,/<dt>生成渠道<\/dt><dd>AGY 生图<\/dd>/);assert.match(d.body,/<dt>生图模型<\/dt><dd>[^<]+<\/dd>/);assert.match(d.body,/<dt>张数<\/dt><dd>1 张<\/dd>/);assert.match(d.body,/<dt>本渠道剩余<\/dt><dd>2 次<\/dd>/);
 assert.match(d.foot!,/data-action="close-dialog"/);assert.match(d.foot!,/data-action="studio-wb-generate-confirm"[^>]*disabled data-arming/,'确认按钮先不可点，防双击穿透');
 await t.w.handle('studio-wb-generate',el({item:'a'}));assert.equal(t.submits.length,0,'再点一次仍只是确认框');
 await t.w.handle('studio-wb-generate-confirm',el());assert.equal(t.submits.length,1,'确认后才提交');assert.equal((t.submits[0] as {operation:string}).operation,'generate');
 await t.w.handle('studio-wb-generate-confirm',el());assert.equal(t.submits.length,1,'同一次确认不会重复提交');
});
test('closing the confirmation voids it: a late confirm click submits nothing',async()=>{
 const t=workbench([async()=>loadValue()]);t.w.open('topic');await settle();await settle();
 await t.w.handle('studio-wb-generate',el({item:'a'}));t.w.dialogClosed();await t.w.handle('studio-wb-generate-confirm',el());assert.equal(t.submits.length,0);
 // 修改版的确认不能被单张生成的确认动作消费，反之亦然。
 await t.w.handle('studio-wb-generate',el({item:'a'}));await t.w.handle('studio-wb-edit-confirm',el());assert.equal(t.submits.length,0);
});
test('cards carry no 生成 button: move buttons sit in their own 调整顺序 group, skip/delete in another; each card has 从网络找图',async()=>{
 const t=workbench([async()=>loadValue()]);t.w.open('topic');await settle();await settle();const h=markupOf(t.w);
 const plan=h.slice(h.indexOf('<aside class="iwb-plan"'),h.indexOf('</aside>'));
 assert.doesNotMatch(plan,/data-action="studio-wb-generate"/,'左栏卡片里没有生成按钮');
 assert.match(plan,/<span class="iwb-card-group" role="group" aria-label="调整顺序"><button[^>]*data-dir="up"[^>]*>上移<\/button><button[^>]*data-dir="down"[^>]*>下移<\/button><\/span>/);
 assert.match(plan,/<span class="iwb-card-group is-end" role="group" aria-label="跳过或删除">/);
 assert.equal((plan.match(/data-action="studio-wb-find"/g)??[]).length,2,'每张图都有从网络找图');
 assert.match(h,/data-action="studio-wb-generate" data-item="a"/,'生成在右栏');
 await t.w.handle('studio-wb-find',el({item:'b'}));const after=markupOf(t.w);assert.match(after,/class="iwb-tab is-active" data-action="studio-wb-tab" data-tab="sources" aria-selected="true">网络找图/);assert.match(after,/class="iwb-card is-focused[^"]*" data-item="b"/);
});
test('background capture shows 正在补充更多图片 on the cards and in the 网络找图 tab',async()=>{
 const t=workbench([async()=>loadValue()],{candidates:async()=>({items:[],capture:{refreshing:true,note:'正在从资讯原文补充更多图片，读到后会自动出现在这里',retry:false,tone:'info'}})});
 t.w.open('topic');await settle();await settle();assert.match(markupOf(t.w),/<small class="iwb-card-find-note">[^]*?正在补充更多图片<\/small>/);
 (t.w as unknown as {tab:string}).tab='sources';assert.match(markupOf(t.w),/正在从资讯原文补充更多图片/);(t.w as unknown as {close():void}).close();
});
test('confirm images: in-flight shows a disabled spinner with 正在冻结配图终稿…; a failure stays visible with 重试 that confirms again',async()=>{
 let gate!:()=>void,fail=true;const calls:unknown[]=[];const opened:string[]=[];
 const t=workbench([async()=>confirmed(0,false,false)],{confirm:async input=>{calls.push(input);await new Promise<void>(r=>{gate=r;});if(fail)throw Object.assign(new Error('图片文件暂时读不到'),{response:{error:{code:'INPUT_STALE'}}});return confirmed().plan;}});
 (t.w as unknown as {host:{openLayout(topic:string):void}}).host.openLayout=topic=>{opened.push(topic);};
 t.w.open('topic');await settle();await settle();
 const running=t.w.handle('studio-wb-confirm',el());await settle();const busy=markupOf(t.w);
 assert.match(busy,/<button type="button" class="button primary iwb-confirm-layout is-busy" data-action="studio-wb-confirm" disabled aria-busy="true"><span class="iwb-spinner" aria-hidden="true"><\/span>正在冻结配图终稿…<\/button>/);
 await t.w.handle('studio-wb-confirm',el());assert.equal(calls.length,1,'进行中不会重复提交');
 gate();await running;const failed=markupOf(t.w);assert.match(failed,/<p class="iwb-confirm-error" role="alert"><span>配图终稿没有冻结成功：文章已修改，请重新规划后再生成<\/span><button class="button" data-action="studio-wb-confirm" >重试<\/button><\/p>/);assert.deepEqual(opened,[]);
 fail=false;const retry=t.w.handle('studio-wb-confirm',el());await settle();assert.doesNotMatch(markupOf(t.w),/iwb-confirm-error/,'重试时清掉旧错误');gate();await retry;assert.equal(calls.length,2);assert.deepEqual(opened,['topic']);
});
test('layout confirmed: steps say 配图 已确认 / 排版 已确认, later stages say 待上线, and 确认配图 warns before continuing',async()=>{
 const status:WorkbenchLayoutStatus={started:true,confirmed:true,synced:true};const calls:unknown[]=[],opened:string[]=[];let layoutReads=0;
 const t=workbench([async()=>confirmed()],{confirm:async input=>{calls.push(input);return confirmed().plan;},layout:async()=>{layoutReads++;return status;}});
 (t.w as unknown as {host:{openLayout(topic:string):void}}).host.openLayout=topic=>{opened.push(topic);};
 t.w.open('topic');await settle();await settle();await settle();assert.equal(layoutReads,1,'打开时读一次排版进度');const h=markupOf(t.w);
 assert.match(h,/<li class="iwb-step is-current" aria-current="step"><span class="iwb-step-dot" aria-hidden="true">✓<\/span><span>配图<\/span><small>已确认<\/small><\/li>/);
 assert.match(h,/<li class="iwb-step is-open is-done"><button type="button" class="publish-step-open iwb-step-link" data-action="studio-wb-layout"><span class="iwb-step-dot" aria-hidden="true">✓<\/span><span>排版<\/span><small>已确认<\/small><\/button><\/li>/);
 assert.equal((h.match(/<small>待上线<\/small>/g)??[]).length,2);assert.doesNotMatch(h,/下一版/,'不再混用「下一版」');
 assert.match(h,/id="iwb-confirm-why">排版已确认，修改配图会让排版需要重新确认<\/small>/);
 await t.w.handle('studio-wb-confirm',el());assert.equal(calls.length,0,'先提示后果，不直接确认');const d=t.dialogs.at(-1)!;assert.equal(d.title,'公众号配图 · 重新确认配图');assert.match(d.body,/排版已确认/);assert.match(d.body,/修改配图会让排版需要重新确认/);assert.match(d.foot!,/data-action="studio-wb-confirm-anyway"[^>]*disabled data-arming/);
 await t.w.handle('studio-wb-confirm-anyway',el());assert.equal(calls.length,1);assert.deepEqual(opened,['topic']);
});
test('layout confirmed but images changed afterwards: steps say 有改动待确认 / 需重新确认; layout not started yet; layout read failure is silent',async()=>{
 const t=workbench([async()=>confirmed(0,true,false)],{layout:async()=>({started:true,confirmed:true,synced:false}),confirm:async()=>confirmed().plan});withLayout(t.w);t.w.open('topic');await settle();await settle();await settle();const h=markupOf(t.w);
 assert.match(h,/<span>配图<\/span><small>有改动待确认<\/small>/);assert.match(h,/<span>排版<\/span><small>需重新确认<\/small>/);
 await t.w.handle('studio-wb-confirm',el());assert.match(t.dialogs.at(-1)!.body,/排版需要同步新配图，并重新确认排版/);
 const n=workbench([async()=>confirmed()],{layout:async()=>({started:false,confirmed:false,synced:false}),confirm:async()=>confirmed().plan});withLayout(n.w);n.w.open('topic');await settle();await settle();await settle();assert.doesNotMatch(markupOf(n.w),/排版已确认/);
 const e=workbench([async()=>confirmed()],{layout:async()=>{throw new Error('offline');},confirm:async()=>confirmed().plan});withLayout(e.w);e.w.open('topic');await settle();await settle();await settle();assert.match(markupOf(e.w),/<span>排版<\/span><\/button>/,'读不到时不推断排版状态');
 const u=workbench([async()=>loadValue()]);u.w.open('topic');await settle();await settle();assert.match(markupOf(u.w),/<span>排版<\/span><small>确认配图后进入<\/small>/);
});
test('item names follow the paragraph they illustrate, so moving up/down does not renumber them; checkboxes have readable labels',()=>{
 const base=loadValue(),items=[{...base.plan.items[0]!,id:'x',paragraph_id:'p2',paragraph_index:1,placement_paragraph_id:'p1',seq:10},{...base.plan.items[0]!,id:'y',paragraph_id:'p3',paragraph_index:2,placement_paragraph_id:'p3',seq:20}];
 const names=(list:typeof items)=>projectWorkbench({...base.plan,items:list},base.studio).items.map(i=>[i.id,i.roleLabel] as [string,string]);
 const before=names(items);
 // 下移 x：服务端只交换插入点与次序，说明的段落不变。
 const moved=[{...items[1]!,placement_paragraph_id:'p1',seq:10},{...items[0]!,placement_paragraph_id:'p3',seq:20}];
 assert.deepEqual(new Map(names(moved)),new Map(before));assert.deepEqual(before,[['x','正文图 · 第 2 段'],['y','正文图 · 第 3 段']]);
 assert.equal(itemName({position:'cover',role:'cover',paragraph_index:0}),'文章封面');assert.equal(itemName({position:'after',role:'manual',paragraph_index:4}),'手动加图 · 第 5 段');assert.equal(itemName({position:'after',role:'body',paragraph_index:null}),'正文图 · 原段落已变化');
});

test('confirm cooldown is bound to one dialog: an old timer never unlocks a newer dialog; re-rendering inside the cooldown keeps it locked',()=>{
 mock.timers.enable({apis:['setTimeout','Date']});
 try{const buttons:Array<{token:string;disabled:boolean;removeAttribute():void}>=[];const doc={querySelectorAll:(sel:string)=>buttons.filter(b=>b.disabled&&sel.includes('"'+b.token+'"'))} as never;
  const arm=new ConfirmArm(()=>doc,350),token=(attrs:string)=>/data-arming="([^"]+)"/.exec(attrs)?.[1]??'';const add=(attrs:string)=>{const b={token:token(attrs),disabled:attrs.includes('disabled'),removeAttribute(){}};buttons.push(b);return b;};
  const first=add(arm.open());mock.timers.tick(200);arm.reset();const second=add(arm.open());assert.notEqual(second.token,first.token);
  mock.timers.tick(160);assert.equal(second.disabled,true,'旧弹窗的计时器到点也解不开新弹窗');assert.equal(first.disabled,true,'作废的旧弹窗不再解锁');
  const again=add(arm.attrs());assert.equal(again.token,second.token,'冷却期内重绘沿用同一冷却');mock.timers.tick(200);assert.equal(second.disabled,false);assert.equal(again.disabled,false);assert.equal(arm.attrs(),'','冷却过后重绘直接可点');
 }finally{mock.timers.reset();}
});
test('batch dialog: switching the channel inside the cooldown keeps the confirm locked instead of re-enabling it',async()=>{
 const t=workbench([async()=>loadValue()]);t.w.open('topic');await settle();await settle();
 mock.timers.enable({apis:['setTimeout','Date']});
 try{await t.w.handle('studio-wb-generate-all',el());const tok=/data-action="studio-wb-generate-all-confirm"[^>]*disabled data-arming="([^"]+)"/.exec(t.dialogs.at(-1)!.foot!)?.[1];assert.ok(tok);
  mock.timers.tick(100);(t.w as any).handleChange({id:'studio-wb-all-provider',value:'agy'});assert.match(t.dialogs.at(-1)!.foot!,new RegExp('studio-wb-generate-all-confirm"[^>]*disabled data-arming="'+tok+'"'),'切换渠道重绘后仍在同一冷却里');
  mock.timers.tick(300);(t.w as any).handleChange({id:'studio-wb-all-provider',value:'agy'});assert.doesNotMatch(t.dialogs.at(-1)!.foot!,/data-arming/,'冷却结束后重绘可点');
 }finally{mock.timers.reset();}
});
test('confirm images re-reads the layout status at click time: a slow/failed first read does not let it through silently',async()=>{
 const reads:string[]=[],confirms:unknown[]=[];let mode:'fail'|'confirmed'|'open'='fail';
 const t=workbench([async()=>confirmed(0,true,false)],{confirm:async input=>{confirms.push(input);return confirmed().plan;},layout:async()=>{reads.push(mode);if(mode==='fail')throw new Error('offline');return {started:true,confirmed:mode==='confirmed',synced:false};}});
 withLayout(t.w);t.w.open('topic');await settle();await settle();await settle();assert.equal(reads.length,1);
 await t.w.handle('studio-wb-confirm',el());assert.equal(reads.length,2,'点击时再读一次');assert.equal(confirms.length,0,'读不到不放行');const d=t.dialogs.at(-1)!;assert.equal(d.title,'公众号配图 · 重新确认配图');assert.match(d.body,/无法确认排版状态/);
 t.w.dialogClosed();mode='confirmed';await t.w.handle('studio-wb-confirm',el());assert.equal(confirms.length,0);assert.match(t.dialogs.at(-1)!.body,/这篇的<b>排版已确认<\/b>/,'刚读到排版已确认：先提示后果');
 t.w.dialogClosed();mode='open';await t.w.handle('studio-wb-confirm',el());assert.equal(reads.length,4);assert.equal(confirms.length,1,'排版没确认：直接确认配图');
});
test('same-named items get （2）（3） by a stable key, so moving them up/down never swaps the suffix',()=>{
 const it=(id:string)=>({id,position:'after' as const,role:'manual' as const,paragraph_index:7});
 const a=stableNames([it('m1'),it('m2'),it('m3')]),b=stableNames([it('m3'),it('m1'),it('m2')]);
 assert.deepEqual([...a.entries()].sort(),[...b.entries()].sort());assert.deepEqual([a.get('m1'),a.get('m2'),a.get('m3')],['手动加图 · 第 8 段','手动加图 · 第 8 段（2）','手动加图 · 第 8 段（3）']);
});

test('layout reads carry a sequence: an older read that lands late never overwrites a newer one, and 确认配图 decides from its own live read',async()=>{
 const {deferred}=await import('../image-studio/workbench-harness.ts');
 const first=deferred<WorkbenchLayoutStatus>(),answers:Array<Promise<WorkbenchLayoutStatus>>=[first.promise,Promise.resolve({started:true,confirmed:true,synced:true})],confirms:unknown[]=[];let n=0;
 const t=workbench([async()=>confirmed()],{confirm:async input=>{confirms.push(input);return confirmed().plan;},layout:()=>answers[Math.min(n++,answers.length-1)]!});
 withLayout(t.w);t.w.open('topic');await settle();await settle();
 await t.w.handle('studio-wb-confirm',el());assert.equal(confirms.length,0);assert.match(t.dialogs.at(-1)!.body,/这篇的<b>排版已确认<\/b>/,'点击时读到已确认：先提示');
 first.resolve({started:true,confirmed:false,synced:false});await settle();await settle();
 assert.match(markupOf(t.w),/排版已确认，修改配图会让排版需要重新确认/,'较早发出的读取晚到，不覆盖较新的「已确认」');
 // 反过来：缓存里是「已确认」，但这次点击实时读到「未确认」→ 以实时结果为准，直接确认。
 const u=workbench([async()=>confirmed()],{confirm:async input=>{confirms.push(input);return confirmed().plan;},layout:(()=>{let k=0;return async()=>({started:true,confirmed:k++===0,synced:true});})()});
 withLayout(u.w);u.w.open('topic');await settle();await settle();await settle();assert.match(markupOf(u.w),/排版已确认，修改配图/);
 await u.w.handle('studio-wb-confirm',el());assert.equal(confirms.length,1,'不读共享缓存，按本次实时结果放行');
});
