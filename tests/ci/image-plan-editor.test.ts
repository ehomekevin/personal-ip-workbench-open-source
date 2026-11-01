// 配图编辑台（A2-2）界面逻辑：标注序列化进修改说明并随请求带上、删除确认、位置下拉、手动加一张、上传为新版本、画幅另存新版本、版本对比回退、待核对与服务端一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import type {StudioMark} from '../../packages/contracts/src/index.ts';
import {composeEditDescription,describeMark,positionOptions,parsePosition,versionTag,brushBounds,MAX_EDIT_DESCRIPTION,adjustMark,translatePath,sanitizeMark,fitPath,BRUSH_PATH_LIMIT} from '../../apps/web/src/features/media/image-studio/plan-model.ts';
import {workbench,loadValue,capability,settle,el} from '../image-studio/workbench-harness.ts';
const agy=capability('agy',{selectable:true,block:null,message:'',detail:null,unverified:false,remaining:3,limit:5}),codex=capability('codex',{selectable:true,block:null,message:'',detail:null,unverified:false,remaining:3,limit:5});
const version=(id:string,extra:Record<string,unknown>={})=>({id,slot_id:'slot-a',asset_id:'asset-'+id,state:'succeeded',provider:'agy',operation:'generate',source:null,description:'描述 '+id,actual:{width:1600,height:900},requested:{width:1600,height:900},marks:[],...extra});
function value(versions=[version('v1')],current='v1'){const v=loadValue('ready',[agy,codex]) as any;v.plan.items[0]={...v.plan.items[0],status:'filled',current_version:{id:current,index:versions.findIndex(x=>x.id===current)+1,auto_selected:false,credit_label:null,operation:'generate'}};v.studio.slots=[{id:'slot-a',title:'图注 a',versions}];v.studio.paragraphs=[{id:'p1',label:'第 1 段',text:'第一段讲资讯怎么进工作台'},{id:'p2',label:'第 2 段',text:'第二段讲配图'}];return v;}
async function bench(v=value(),extra:Record<string,unknown>={}){const calls:Array<[string,unknown]>=[];const t=workbench([async()=>v],{update:async(id:string,input:unknown)=>{calls.push(['update:'+id,input]);return v.plan;},create:async(input:unknown)=>{calls.push(['create',input]);return v.plan;},assetVersion:async(input:unknown)=>{calls.push(['asset',input]);return {slot_id:'slot-a',version_id:'v9',asset_id:'x',version:4};},...extra} as never);t.w.open('topic');await settle();await settle();return {...t,calls,markup:()=>String((t.w as any).markup())};}
const marks:StudioMark[]=[{id:1,type:'rect',x:100,y:56.3,w:250,h:225,ex:350,ey:281.3,path:'',note:'人物缩小'},{id:2,type:'brush',x:500,y:100,w:0,h:0,ex:0,ey:0,path:'M500 100 L600 150 L650 300',note:''},{id:3,type:'arrow',x:900,y:500,w:0,h:0,ex:700,ey:300,path:'',note:'标题往这里移'},{id:4,type:'text',x:300,y:120,w:0,h:0,ex:300,ey:120,path:'',note:'',text:'新标题'}];
test('marks serialize into the edit description with positions as percentages of the real image; empty request still works; 8000-char cap',()=>{
 const text=composeEditDescription('',marks,562.5);
 assert.equal(text,'标注1（框选，x 10–35%，y 10–50%）：人物缩小；标注2（涂抹，x 50–65%，y 18–53%）：按修改要求调整这里；标注3（箭头，从 x 90% y 89% 指向 x 70% y 53%）：标题往这里移；把标注4处（x 30%，y 21%）的文字改为「新标题」；未标注区域保持不变');
 assert.equal(composeEditDescription('人物缩小一点',[],562.5),'人物缩小一点');assert.match(composeEditDescription('整体更亮',marks.slice(0,1),562.5),/^整体更亮\n标注1（框选/);
 assert.throws(()=>composeEditDescription('  ',[],500),/先写修改要求，或在图上标注/);assert.throws(()=>composeEditDescription('长'.repeat(MAX_EDIT_DESCRIPTION),marks,500),/超过 8000 字/);
 assert.deepEqual(brushBounds('M500 100 L600 150 L650 300'),{x:500,y:100,w:150,h:200});assert.equal(describeMark({...marks[3]!,text:''},500).includes('「」'),true);
 assert.equal(composeEditDescription('改',[{...marks[3]!,text:' '}],500),'改','空的改文字标注不进说明');
});
test('position dropdown lists paragraphs before/after plus cover; cover taken is disabled; values round-trip',()=>{
 const o=positionOptions([{id:'p1',text:'第一段讲资讯怎么进工作台，再讲很多很多别的内容'},{id:'p2',text:'第二段'}],true);
 assert.deepEqual(o.map(x=>[x.value,x.label,x.disabled]),[['cover','封面（已有一张）',true],['before:p1','第 1 段之前 · 第一段讲资讯怎么进工作台，再讲很…',false],['after:p1','第 1 段之后 · 第一段讲资讯怎么进工作台，再讲很…',false],['before:p2','第 2 段之前 · 第二段',false],['after:p2','第 2 段之后 · 第二段',false]]);
 assert.deepEqual(parsePosition('after:p2'),{position:'after',paragraph_id:'p2'});assert.deepEqual(parsePosition('cover'),{position:'cover',paragraph_id:null});assert.equal(parsePosition('x'),null);
});
test('edit request: marks go into description and the request body; only AGY; marks clear after queueing',async()=>{
 const t=await bench();const w=t.w as any;
 assert.match(t.markup(),/<option value="agy" selected>AGY 生图 · 剩余 3 次<\/option><option value="codex" disabled>Codex 生图 · 不支持在原图上修改<\/option>/);
 assert.match(t.markup(),/data-chip="marked" disabled/,'没有标注时「只改标注区域」不可用');
 w.marks.set(w.markKey('a'),structuredClone(marks));assert.match(t.markup(),/4 处标注 · 批注不进入成品/);assert.doesNotMatch(t.markup(),/data-chip="marked" disabled/);
 assert.equal((t.markup().match(/class="iwb-annotation"/g)??[]).length,4,'标注清单编号 + 说明 + 删除');
 await t.w.handle('studio-wb-chip',el({chip:'marked',item:'a'}));
 await t.w.handle('studio-wb-edit',el({item:'a'}));assert.equal(t.submits.length,0,'点「生成修改版」只弹确认，不直接提交');const g=t.dialogs.at(-1)!;assert.equal(g.title,'公众号配图 · 确认生成');assert.match(g.body,/AGY 生图/);assert.match(g.body,/4 处，写进修改说明/);assert.match(g.foot!,/data-action="studio-wb-edit-confirm"[^>]*disabled data-arming/,'确认按钮先不可点，防双击穿透');
 await t.w.handle('studio-wb-edit-confirm',el());const body=t.submits.at(-1) as any;
 assert.equal(body.provider,'agy');assert.equal(body.operation,'reference_edit');assert.equal(body.parent_version_id,'v1');assert.deepEqual(body.marks,marks);
 assert.match(body.description,/^只修改标注区域，其他保持不变。\n标注1（框选，x 10–35%，y 10–50%）：人物缩小；/);assert.match(body.description,/把标注4处（x 30%，y 21%）的文字改为「新标题」；未标注区域保持不变$/);
 assert.equal(w.markList('a').length,0,'入队后清空本轮标注');
 w.marks.set(w.markKey('a'),[marks[0]]);await t.w.handle('studio-wb-undo',el());assert.equal(w.markList('a').length,0);w.marks.set(w.markKey('a'),structuredClone(marks));await t.w.handle('studio-wb-mark-remove',el({mark:'2'}));assert.deepEqual(w.markList('a').map((m:StudioMark)=>m.id),[1,3,4]);await t.w.handle('studio-wb-clear-marks',el());assert.equal(w.markList('a').length,0);
 w.handleInput({id:'studio-wb-request',value:''});await t.w.handle('studio-wb-edit',el({item:'a'}));assert.equal(t.submits.length,1);assert.match(t.toasts.at(-1)!,/先写修改要求，或在图上标注/);
});
test('delete asks first (mentions kept versions) then removes; position change, manual add and upload call the new endpoints',async()=>{
 const t=await bench();const w=t.w as any;
 await t.w.handle('studio-wb-remove',el({item:'a'}));const d=t.dialogs.at(-1)!;assert.equal(d.title,'公众号配图 · 删除这张图');assert.match(d.body,/已生成的图片会保留在素材库（共 1 个版本），可从其他图的「网络找图」分页找回/);assert.equal(t.calls.length,0,'确认前不删除');
 await t.w.handle('studio-wb-remove-confirm',el());assert.deepEqual(t.calls.at(-1),['update:a',{topic_id:'topic',expected_version:2,removed:true}]);
 w.handleChange({id:'studio-wb-place-b',value:'after:p2'});await settle();assert.deepEqual((t.calls.at(-1)![1] as any).placement,{position:'after',paragraph_id:'p2'});
 assert.match(t.markup(),/<select class="field" id="studio-wb-place-a"><option value="cover">封面<\/option><option value="before:p1">第 1 段之前 · 第一段讲资讯怎么进工作台<\/option><option value="after:p1" selected>/,'卡片不展开也能改位置');
 assert.match(t.markup(),/id="studio-wb-caption-b"/,'未选中的卡片同样可以直接改图注');
 await t.w.handle('studio-wb-add-item',el({item:'a'}));assert.deepEqual(t.calls.at(-1),['create',{topic_id:'topic',expected_version:2,position:'after',paragraph_id:'p1'}]);
 w.host.upload=async()=>({asset_id:'up-1'});w.uploadPurpose='layout';await w.uploadVersion(w.item('a'),{type:'image/png',size:1000,name:'构图.png'});assert.deepEqual(t.calls.at(-1),['asset',{topic_id:'topic',expected_version:3,slot_id:'slot-a',asset_id:'up-1',purpose:'layout',name:'构图.png'}]);
 await w.uploadVersion(w.item('a'),{type:'image/gif',size:10,name:'x.gif'});assert.match(t.toasts.at(-1)!,/PNG、JPG 或 WebP/);
});
test('resize saves a new version via AGY reference_edit at the new size; compare offers going back to the previous version',async()=>{
 const t=await bench(value([version('v1'),version('v2',{operation:'reference_edit'})],'v2'));const w=t.w as any;
 await t.w.handle('studio-wb-resize',el({item:'a'}));assert.equal(t.dialogs.at(-1)!.title,'公众号配图 · 调整画幅与尺寸');
 w.handleChange({id:'studio-wb-resize-ratio',value:'3:4'});await t.w.handle('studio-wb-resize-confirm',el());assert.equal(t.submits.length,0,'没进确认时调整画幅不提交');await t.w.handle('studio-wb-resize-next',el());const g=t.dialogs.at(-1)!;assert.equal(g.title,'公众号配图 · 确认生成');assert.match(g.body,/<dt>新尺寸<\/dt><dd>1200 × 1600 px/);assert.match(g.body,/<dt>生成渠道<\/dt><dd>AGY 生图<\/dd>/);assert.equal(t.submits.length,0,'确认前不提交');await t.w.handle('studio-wb-resize-confirm',el());const body=t.submits.at(-1) as any;
 assert.deepEqual([body.operation,body.provider,body.parent_version_id,body.requested_size],['reference_edit','agy','v2',{width:1200,height:1600}]);assert.match(body.description,/画幅调整为竖图 · 3:4（1200 × 1600 px）/);
 assert.deepEqual(t.calls.at(-1),['update:a',{topic_id:'topic',expected_version:2,aspect:'3:4'}],'方案画幅同步');
 await t.w.handle('studio-wb-compare',el({item:'a'}));const c=t.dialogs.at(-1)!;assert.equal(c.title,'公众号配图 · 对比修改前后');assert.match(c.body,/v1 · AI 生图/);assert.match(c.body,/v2 · 修改版 · 当前查看/);assert.match(c.foot!,/回到 v1/);assert.match(c.foot!,/保留当前版/);
 await t.w.handle('studio-wb-restore-version',el({item:'a',version:'v1'}));assert.deepEqual(t.calls.at(-1),['update:a',{topic_id:'topic',expected_version:2,current_version_id:'v1'}]);
});
test('a cancelled/unknown version shows 待核对 and blocks edit, matching the server',async()=>{
 assert.equal(versionTag({asset_id:'',state:'cancelled',operation:'reference_edit',source:null,upload:null}),'待核对');assert.equal(versionTag({asset_id:'',state:'unknown',operation:'generate',source:null,upload:null}),'待核对');
 const v=value([version('v1'),version('v2',{asset_id:'',state:'cancelled',operation:'reference_edit'})],'v1');v.plan.items[0].issue='上次生成的结果还在核对，暂时不能再生成或修改这张';
 const t=await bench(v),h=t.markup();
 assert.match(h,/data-action="studio-wb-edit" data-item="a" disabled>生成修改版/);assert.match(h,/上次的任务结果还在核对/);assert.match(h,/<b>v2 · 待核对<\/b>/);assert.match(h,/data-version="v2" aria-pressed="false" disabled/);
 assert.match(h,/data-action="studio-wb-resize" data-item="a" disabled/);
 await t.w.handle('studio-wb-edit',el({item:'a'}));assert.equal(t.submits.length,0);
});
test('batch generation: defaults to all awaiting items, filled items can be picked and get a new candidate version; dialog shows channel, fixed model and first-time/new-version per item',async()=>{
 const t=await bench();const w=t.w as any;
 assert.match(t.markup(),/>批量生成（已选 1 张）<\/button>/);assert.match(t.markup(),/id="studio-wb-pick-b" aria-label="选择 正文图 · 第 1 段（2）「图注 b」批量生成" checked>/);assert.match(t.markup(),/id="studio-wb-pick-a" aria-label="选择 正文图 · 第 1 段「图注 a」批量生成新版本"><span>选入批量（新建版本）/);
 w.handleChange({id:'studio-wb-pick-a',checked:true});assert.match(t.markup(),/>批量生成（已选 2 张）<\/button>/);
 await t.w.handle('studio-wb-generate-all',el());const d=t.dialogs.at(-1)!;
 assert.match(d.body,/<b>正文图 · 第 1 段<\/b><span>图注 a<\/span><em>新建版本<\/em>/);assert.match(d.body,/<b>正文图 · 第 1 段（2）<\/b><span>图注 b<\/span><em>首次生成<\/em>/);assert.match(d.foot!,/data-action="studio-wb-generate-all-confirm"[^>]*disabled data-arming/,'批量确认同样先不可点');
 assert.match(d.body,/生图模型<\/span><p class="iwb-model-fixed" id="studio-wb-all-model">Gemini 3.1 Flash Image（Nano Banana）<small>本渠道只有这一个模型<\/small>/);assert.match(d.body,/生成后设为当前图，旧版保留、可在版本条里切回/);
 w.handleChange({id:'studio-wb-all-provider',value:'codex'});assert.match(t.dialogs.at(-1)!.body,/Codex 内置生图/);w.handleChange({id:'studio-wb-all-provider',value:'agy'});
 await t.w.handle('studio-wb-generate-all-confirm',el());
 assert.deepEqual(t.submits.map((x:any)=>[x.slot_id,x.operation,x.provider,x.candidate_only===true,x.parent_version_id]),[['slot-a','generate','agy',true,null],['slot-b','generate','agy',false,null]]);
 assert.match(t.markup(),/>批量生成（已选 1 张）<\/button>/,'提交后恢复默认选择');
 w.handleChange({id:'studio-wb-pick-b',checked:false});assert.match(t.markup(),/>批量生成（已选 0 张）<\/button>/);assert.match(t.markup(),/data-action="studio-wb-generate-all" disabled/);
});
test('single-item generate and edit show the channel model next to the channel picker',async()=>{
 const t=await bench();assert.match(t.markup(),/id="studio-wb-model">Gemini 3\.1 Flash Image/);await t.w.handle('studio-wb-focus',el({item:'b'}));assert.match(t.markup(),/data-action="studio-wb-generate" data-item="b"/);assert.match(t.markup(),/id="studio-wb-model">/);
});
test('planner executors still unchecked on entry (service health probe pending) are re-read until a real state arrives',async()=>{
 const {executorChoices}=await import('../../apps/web/src/components/executors.ts');
 const v=value();v.executors=executorChoices(null);let reads=0;
 const t=await bench(v,{executors:async()=>{reads++;return {executors:executorChoices({executors:[{executor_id:'codex',status:'supported',auth_state:'subscription_authenticated'},{executor_id:'claude',status:'supported',auth_state:'subscription_authenticated'}]} as never),default_executor:'codex'};}});
 assert.match(t.markup(),/<b>Codex<\/b><small>待检查<\/small>/,'服务刚启动时是后台检查中的占位');
 await new Promise(r=>setTimeout(r,500));assert.equal(reads,0,'重读间隔统一 2 秒');await new Promise(r=>setTimeout(r,1700));assert.equal(reads,1);assert.match(t.markup(),/<b>Codex<\/b><small>可用<\/small>/);assert.doesNotMatch(t.markup(),/待检查/);
 await new Promise(r=>setTimeout(r,2100));assert.equal(reads,1,'读到真实状态后不再重读');
});
// ——— 第 1 轮门禁（前端） ———
test('marks belong to the version on stage: switching versions keeps each set apart; an edit only sends the parent version marks and drops empty text marks',async()=>{
 const t=await bench(value([version('v1'),version('v2',{operation:'reference_edit'})],'v2'));const w=t.w as any;
 w.marks.set(w.markKey('a'),[marks[0],{...marks[3],text:'  '}]);assert.equal(w.markList('a').length,2);
 await t.w.handle('studio-wb-version',el({item:'a',version:'v1'}));assert.equal(w.markList('a').length,0,'切到 v1：v2 的标注不带过来');
 w.marks.set(w.markKey('a'),[{...marks[2],id:1}]);
 await t.w.handle('studio-wb-version',el({item:'a',version:'v2'}));assert.equal(w.markList('a').length,2,'回到 v2：原来的标注还在');
 await t.w.handle('studio-wb-edit',el({item:'a'}));await t.w.handle('studio-wb-edit-confirm',el());const body=t.submits.at(-1) as any;assert.equal(body.parent_version_id,'v2');assert.deepEqual(body.marks.map((m:StudioMark)=>m.type),['rect'],'空文字的改文字标注不进 marks');
 await t.w.handle('studio-wb-version',el({item:'a',version:'v1'}));assert.equal(w.markList('a').length,1,'v1 上的标注保留');
});
test('rendering pauses while drawing / dragging / picking a file and catches up afterwards',async()=>{
 const t=await bench();const w=t.w as any;
 w.drawing={id:1,type:'rect',x:0,y:0,w:0,h:0,ex:0,ey:0,path:'',note:''};w.render();assert.equal(w.renderPending,true);w.drawing=undefined;w.flushRender();assert.equal(w.renderPending,false);
 w.dragging='b';w.render();assert.equal(w.renderPending,true);w.dragging='';w.flushRender();assert.equal(w.renderPending,false);
 w.filePicking=true;w.render();assert.equal(w.renderPending,true);
});
test('loader reveal follows the stage: no reveal when the stage shows another version; reveal completion re-renders',async()=>{
 const t=await bench(value([version('v1'),version('v2',{operation:'reference_edit'})],'v1'));const w=t.w as any;
 w.loaderMount={mount:()=>({update(){},dispose(){}})};w.loaders.set('a',{node:{},handle:{update(){},dispose(){}},done:false,version:'v2',opts:{state:'running',images:[],width:16,height:9}});
 assert.equal(w.loaderFor(w.item('a')),null,'新版只作候选、舞台显示 v1 时不揭示');
 await t.w.handle('studio-wb-version',el({item:'a',version:'v2'}));assert.notEqual(w.loaderFor(w.item('a')),null,'舞台改看 v2 时揭示到 v2');
});
test('switching article resets batch picks; deleting the last item still offers manual add; picked model goes into the request when a channel has several',async()=>{
 const t=await bench();const w=t.w as any;w.picked.add('a');w.pickTouched=true;w.close();w.open('topic');assert.equal(w.picked.size,0);assert.equal(w.pickTouched,false);await settle();await settle();
 const empty=value();empty.plan.items=[];const e=await bench(empty);assert.match(e.markup(),/data-action="studio-wb-add-item"/);assert.match(e.markup(),/这篇的配图都删掉了/);
 const multi=value();multi.studio.capabilities=[{...agy,models:[{id:'m1',label:'模型一'},{id:'m2',label:'模型二'}]},codex];const m=await bench(multi);const mw=m.w as any;
 await m.w.handle('studio-wb-focus',el({item:'b'}));assert.match(m.markup(),/<select class="field" id="studio-wb-model" data-provider="agy"><option value="m1" selected>模型一<\/option><option value="m2">模型二<\/option><\/select>/);
 mw.handleChange({id:'studio-wb-model',value:'m2',dataset:{provider:'agy'}});await m.w.handle('studio-wb-generate',el({item:'b'}));assert.match(m.dialogs.at(-1)!.body,/<dt>生图模型<\/dt><dd>模型二<\/dd>/,'确认框写明所选模型');await m.w.handle('studio-wb-generate-confirm',el());assert.equal((m.submits.at(-1) as any).model,'m2');
 const single=await bench();await single.w.handle('studio-wb-focus',el({item:'b'}));await single.w.handle('studio-wb-generate',el({item:'b'}));await single.w.handle('studio-wb-generate-confirm',el());assert.equal((single.submits.at(-1) as any).model,undefined,'单模型不额外传');
});
// ——— 第 2 轮复核 ———
function fakeStage(h=562.5){const handlers:Record<string,(e:unknown)=>void>={},svg={dataset:{h:String(h)},addEventListener:(k:string,f:(e:unknown)=>void)=>{handlers[k]=f;},getBoundingClientRect:()=>({left:0,top:0,width:1000,height:h}),setPointerCapture(){},querySelector:()=>({innerHTML:''})};return {node:{querySelector:(sel:string)=>sel==='.iwb-marks'?svg:null} as unknown as HTMLElement,fire:(k:string,x:number,y:number)=>handlers[k]!({clientX:x,clientY:y,pointerId:1,preventDefault(){}})};}
test('closing mid-drawing resets every interaction gate so the reopened workbench renders again',async()=>{
 const t=await bench();const w=t.w as any;w.drawing={id:1,type:'rect',x:0,y:0,w:0,h:0,ex:0,ey:0,path:'',note:''};w.drawingKey='a|v1';w.dragging='b';w.filePicking=true;w.render();assert.equal(w.renderPending,true);
 w.close();assert.deepEqual([w.drawing,w.drawingKey,w.dragging,w.filePicking,w.renderPending],[undefined,'','',false,false]);
});
test('a mark drawn while polling switches the current version is saved on the version it was started on',async()=>{
 const t=await bench(value([version('v1'),version('v2',{operation:'reference_edit'})],'v1'));const w=t.w as any,s=fakeStage();w.tool='rect';w.bindMarks(s.node);
 s.fire('pointerdown',100,100);w.preview.set('a','v2');s.fire('pointermove',300,300);s.fire('pointerup',300,300);
 assert.equal((w.marks.get('a|v1')??[]).length,1,'记在按下时的 v1');assert.equal((w.marks.get('a|v2')??[]).length,0);
});
test('cancelled or too-short drawing still flushes the render that was held back',async()=>{
 const t=await bench();const w=t.w as any,s=fakeStage();w.tool='rect';w.bindMarks(s.node);
 s.fire('pointerdown',100,100);w.render();assert.equal(w.renderPending,true);s.fire('pointercancel',100,100);assert.equal(w.renderPending,false,'pointercancel 补重绘');
 s.fire('pointerdown',100,100);w.render();assert.equal(w.renderPending,true);s.fire('pointerup',102,101);assert.equal(w.renderPending,false,'短拖补重绘');assert.equal(w.markList('a').length,0);
});
// ——— 标注可调整、Delete 删除、AI 项删除与任意位置新加（用户实测反馈） ———
test('adjustMark moves inside the image, resizes rect from any handle (min size, flips past the opposite edge) and drags arrow ends',()=>{
 const rect:StudioMark={id:1,type:'rect',x:100,y:100,w:200,h:100,ex:300,ey:200,path:'',note:''};
 assert.deepEqual(adjustMark(rect,'move',50,20,562.5),{...rect,x:150,y:120,ex:350,ey:220});
 assert.deepEqual([adjustMark(rect,'move',-500,-500,562.5).x,adjustMark(rect,'move',-500,-500,562.5).y],[0,0],'不移出左上');
 {const m=adjustMark(rect,'move',2000,2000,562.5);assert.deepEqual([m.x+m.w,m.y+m.h],[1000,562.5],'不移出右下');}
 assert.deepEqual(adjustMark(rect,'se',100,50,562.5),{...rect,w:300,h:150,ex:400,ey:250});
 assert.deepEqual(adjustMark(rect,'nw',-50,-50,562.5),{...rect,x:50,y:50,w:250,h:150,ex:300,ey:200});
 {const m=adjustMark(rect,'e',-198,0,562.5);assert.equal(m.w,8,'最小 8');}
 {const m=adjustMark(rect,'e',-300,0,562.5);assert.deepEqual([m.x,m.w],[0,100],'拖过对边翻转');}
 {const m=adjustMark(rect,'n',0,40,562.5);assert.deepEqual([m.y,m.h,m.x,m.w],[140,60,100,200],'只拖上边');}
 const arrow:StudioMark={id:2,type:'arrow',x:100,y:100,w:100,h:100,ex:200,ey:200,path:'',note:''};
 assert.deepEqual(adjustMark(arrow,'end',50,-50,562.5),{...arrow,ex:250,ey:150,w:150,h:50});
 assert.deepEqual(adjustMark(arrow,'start',-500,0,562.5).x,0);
 const brush:StudioMark={id:3,type:'brush',x:500,y:100,w:0,h:0,ex:0,ey:0,path:'M500 100 L600 150',note:''};
 assert.equal(adjustMark(brush,'move',10,20,562.5).path,'M510 120 L610 170');assert.equal(translatePath('M1 2 L3 4',1,1),'M2 3 L4 5');
 assert.equal(adjustMark(brush,'se',10,10,562.5),brush,'涂抹没有缩放手柄');
 assert.equal(sanitizeMark({id:1,type:'rect',x:NaN,y:0,w:1,h:1,ex:1,ey:1,path:'',note:''}),null);assert.equal(sanitizeMark({id:1,type:'circle'}),null);assert.deepEqual(sanitizeMark(rect),rect);
});
function richStage(h=562.5){
 const handlers:Record<string,(e:unknown)=>void>={},groups=new Map<number,{innerHTML:string;classList:{add():void;remove():void}}>(),handles={innerHTML:''};
 const svg={dataset:{h:String(h)},addEventListener:(k:string,f:(e:unknown)=>void)=>{handlers[k]=f;},getBoundingClientRect:()=>({left:0,top:0,width:1000,height:h}),setPointerCapture(){},focus(){},
  querySelector:(sel:string)=>{if(sel==='.iwb-handles')return handles;const m=/data-mark="(\d+)"/.exec(sel);if(m){const id=Number(m[1]);if(!groups.has(id))groups.set(id,{innerHTML:'',classList:{add(){},remove(){}}});return groups.get(id);}return {innerHTML:''};},querySelectorAll:()=>[]};
 const target=(kind:'mark'|'handle'|'none',value='')=>({closest:(sel:string)=>sel==='[data-handle]'?(kind==='handle'?{getAttribute:()=>value}:null):sel==='[data-mark]'?(kind==='mark'?{getAttribute:()=>value}:null):null});
 return {handles,node:{querySelector:(sel:string)=>sel==='.iwb-marks'?svg:null} as unknown as HTMLElement,fire:(k:string,x:number,y:number,t:unknown=target('none'),pointerId=1)=>handlers[k]!({clientX:x,clientY:y,pointerId,target:t,preventDefault(){}}),target};
}
test('a drawn rect is selected with handles; dragging moves it, a handle resizes it, both are undoable and saved to the local draft',async()=>{
 const t=await bench();const w=t.w as any,mem=new Map<string,string>();w.host.storage=()=>({getItem:(k:string)=>mem.get(k)??null,setItem:(k:string,v:string)=>mem.set(k,v),removeItem:(k:string)=>mem.delete(k)});
 const s=richStage();w.tool='rect';w.bindMarks(s.node);s.fire('pointerdown',100,100);s.fire('pointermove',300,200);s.fire('pointerup',300,200);
 assert.deepEqual(w.markList('a').map((m:StudioMark)=>[m.x,m.y,m.w,m.h]),[[100,100,200,100]]);assert.equal(w.selectedMark,1,'画完自动选中');w.host.imageUrl=()=>'/img.png';
 assert.match(t.markup(),/<g class="iwb-mark-g is-selected" data-mark="1">/);assert.match(t.markup(),/已选中标注 1（框选）：拖动可移动，拖四角或四边改大小；按 Delete 也能删除/);assert.match(t.markup(),/data-action="studio-wb-mark-delete"/,'有可见的删除入口');
 const s2=richStage();w.bindMarks(s2.node);s2.fire('pointerdown',150,150,s2.target('mark','1'));s2.fire('pointermove',250,200);s2.fire('pointerup',250,200);
 assert.deepEqual(w.markList('a').map((m:StudioMark)=>[m.x,m.y,m.w,m.h]),[[200,150,200,100]],'拖动移动（画图工具下也能拖已选中的那处）');
 const s3=richStage();w.bindMarks(s3.node);assert.match(s3.handles.innerHTML,/data-handle="se"/,'选中后画出八个手柄');assert.equal((s3.handles.innerHTML.match(/class="iwb-handle is-/g)??[]).length,8);assert.equal((s3.handles.innerHTML.match(/class="iwb-handle-hit is-/g)??[]).length,8,"每个手柄有透明命中区");
 s3.fire('pointerdown',400,250,s3.target('handle','se'));s3.fire('pointermove',500,300);s3.fire('pointerup',500,300);
 assert.deepEqual(w.markList('a').map((m:StudioMark)=>[m.x,m.y,m.w,m.h]),[[200,150,300,150]],'拖右下角改大小');
 const saved=JSON.parse(mem.get('image-studio-marks:v1:w:topic')!);assert.deepEqual(saved['a|v1'].map((m:StudioMark)=>[m.x,m.y,m.w,m.h]),[[200,150,300,150]],'调整结果写进本机草稿');
 await t.w.handle('studio-wb-undo',el());assert.deepEqual(w.markList('a').map((m:StudioMark)=>[m.w,m.h]),[[200,100]],'撤销缩放');await t.w.handle('studio-wb-undo',el());assert.deepEqual(w.markList('a').map((m:StudioMark)=>[m.x,m.y]),[[100,100]],'撤销移动');
 // 重开工作台（等同刷新）：标注从本机草稿读回。
 w.close();t.w.open('topic');await settle();await settle();assert.deepEqual(w.markList('a').map((m:StudioMark)=>[m.x,m.y,m.w,m.h]),[[100,100,200,100]],'刷新后标注还在');
});
test('Delete / Backspace remove the selected mark (undoable), never while typing in a field or with a dialog open, and do nothing without a selection',async()=>{
 const t=await bench();const w=t.w as any;w.marks.set(w.markKey('a'),structuredClone(marks));
 const key=(k:string,target:unknown={closest:()=>null})=>{let prevented=false;const handled=t.w.handleKey({key:k,target,metaKey:false,ctrlKey:false,altKey:false,isComposing:false,preventDefault(){prevented=true;}} as unknown as KeyboardEvent);return {handled,prevented};};
 assert.deepEqual(key('Delete'),{handled:false,prevented:false},'没选中时不拦截');
 await t.w.handle('studio-wb-mark-select',el({mark:'2'}));assert.equal(w.selectedMark,2);
 assert.deepEqual(key('Backspace',{closest:(sel:string)=>sel.startsWith('input')?{}:null}),{handled:false,prevented:false},'焦点在输入框里不误删');assert.equal(w.markList('a').length,4);
 w.host.root.ownerDocument.querySelector=(sel:string)=>sel==='dialog[open]'?{}:null;assert.equal(key('Delete').handled,false,'弹窗打开时不删');w.host.root.ownerDocument.querySelector=undefined;
 assert.deepEqual(key('Delete'),{handled:true,prevented:true});assert.deepEqual(w.markList('a').map((m:StudioMark)=>m.id),[1,3,4]);assert.match(t.toasts.at(-1)!,/已删除标注 2，点「撤销」可以恢复/);
 await t.w.handle('studio-wb-mark-select',el({mark:'3'}));assert.equal(key('Backspace').handled,true);assert.deepEqual(w.markList('a').map((m:StudioMark)=>m.id),[1,4]);
 await t.w.handle('studio-wb-undo',el());await t.w.handle('studio-wb-undo',el());assert.deepEqual(w.markList('a').map((m:StudioMark)=>m.id),[1,2,3,4],'两次撤销恢复');
 await t.w.handle('studio-wb-mark-select',el({mark:'1'}));await t.w.handle('studio-wb-mark-delete',el());assert.deepEqual(w.markList('a').map((m:StudioMark)=>m.id),[2,3,4],'可见的删除按钮');
});
test('AI-planned items can be deleted from the card or the stage (with the kept-images note); a new image slot can be inserted at any paragraph with a chosen source',async()=>{
 const t=await bench();const w=t.w as any;
 assert.match(t.markup(),/data-action="studio-wb-remove" data-item="a" aria-label="删除图片位：/,'舞台标题旁有删除入口');
 await t.w.handle('studio-wb-remove',el({item:'a'}));assert.match(t.dialogs.at(-1)!.body,/这是 AI 规划的图片位，删除后不会自动加回/);assert.match(t.dialogs.at(-1)!.body,/已生成的图片会保留在素材库/);
 await t.w.handle('studio-wb-remove-confirm',el());assert.deepEqual(t.calls.at(-1),['update:a',{topic_id:'topic',expected_version:2,removed:true}]);
 assert.match(t.markup(),/data-action="studio-wb-insert" data-item="b"[^>]*>＋ 在后面插入/,'每张卡片都有「在后面插入」');
 await t.w.handle('studio-wb-insert',el({item:'b'}));let d=t.dialogs.at(-1)!;assert.equal(d.title,'公众号配图 · 新加图片位');assert.match(d.body,/<option value="before:p1" selected>/,'默认插在这张之后（同一落点）');assert.match(d.body,/AI 生图[^]*原文 \/ 官方图[^]*同题帖子图[^]*上传图片/);
 w.handleChange({id:'studio-wb-insert-place',value:'after:p2'});w.handleChange({id:'studio-wb-insert-src-platform_post',value:'platform_post',checked:true});w.handleInput({id:'studio-wb-insert-caption',value:'第二段的帖子图'});
 await t.w.handle('studio-wb-insert-confirm',el());assert.deepEqual(t.calls.at(-1),['create',{topic_id:'topic',expected_version:2,position:'after',paragraph_id:'p2',source_strategy:'platform_post',purpose:'第二段的帖子图'}]);
 await t.w.handle('studio-wb-insert',el({place:'end'}));w.handleChange({id:'studio-wb-insert-src-upload',value:'upload',checked:true});await t.w.handle('studio-wb-insert-confirm',el());
 assert.deepEqual(t.calls.at(-1),['create',{topic_id:'topic',expected_version:2,position:'after',paragraph_id:'p2',source_strategy:'ai_generate'}],'上传先建 AI 生图占位，再在右栏选文件');assert.match(t.toasts.at(-1)!,/上传图片/);
 await t.w.handle('studio-wb-preview',el());assert.match(t.dialogs.at(-1)!.body,/data-action="studio-wb-insert" data-place="after:p1"[^>]*>＋ 在这里插入图片位/,'完整文章预览里每段后可插入');
});
// ——— 第 1 轮评审 ———
const memStore=()=>{const mem=new Map<string,string>();return {mem,storage:{getItem:(k:string)=>mem.get(k)??null,setItem:(k:string,v:string)=>{mem.set(k,v);},removeItem:(k:string)=>{mem.delete(k);}}};};
test('two tabs on the same article: saving only writes the changed key, another tab\'s keys survive, a changed key is reported, storage events sync the other tab',async()=>{
 const shared=memStore();const a=await bench(),b=await bench();const wa=a.w as any,wb=b.w as any;wa.host.storage=()=>shared.storage;wb.host.storage=()=>shared.storage;
 wa.close();a.w.open('topic');wb.close();b.w.open('topic');await settle();await settle();
 const key='image-studio-marks:v1:w:topic',rect=(id:number,x:number):StudioMark=>({id,type:'rect',x,y:10,w:50,h:50,ex:x+50,ey:60,path:'',note:''});
 wa.setMarks('a|v1',[rect(1,100)]);wb.setMarks('b|v9',[rect(1,300)]);
 const stored=JSON.parse(shared.mem.get(key)!);assert.deepEqual(Object.keys(stored).sort(),['a|v1','b|v9'],'B 写入时保留了 A 的键');
 wb.syncMarksFromStore(shared.mem.get(key)!);assert.deepEqual(wb.markList('a').map((m:StudioMark)=>m.x),[100],'storage 事件把 A 的标注同步到 B');assert.match(b.toasts.at(-1)!,/另一个标签页改了标注，这里已同步/);
 wa.syncMarksFromStore(shared.mem.get(key)!);
 // A 与 B 先后改同一个键：B 写时发现 A 已改过，提示而不是静默覆盖。
 wa.setMarks('a|v1',[rect(1,120)]);wb.setMarks('a|v1',[rect(1,140)]);assert.match(b.toasts.at(-1)!,/另一个标签页也改过这张图的标注，已保存本页的修改/);
 assert.equal(JSON.parse(shared.mem.get(key)!)['b|v9'][0].x,300,'无关的键不受影响');
});
test('long or moved brush strokes stay within the 6000-char limit (rounded, then thinned) and the user is told; oversize drafts are fitted instead of dropped',async()=>{
 const long='M0 0 '+Array.from({length:3000},(_,i)=>'L'+(i%1000+.37)+' '+(i%500+.73)).join(' ');assert.ok(long.length>BRUSH_PATH_LIMIT);
 const fit=fitPath(long);assert.ok(fit.length<=BRUSH_PATH_LIMIT,'压到上限内');assert.match(fit,/^M0 0 L/);assert.ok(fit.endsWith('L999 500'),'保留终点');
 const near='M100.37 100.37 '+Array.from({length:500},(_,i)=>'L'+(100+i%300)+'.4 '+(100+i%200)+'.6').join(' ');const moved=translatePath(near.slice(0,BRUSH_PATH_LIMIT-20),3.33,4.44);assert.ok(moved.length<=BRUSH_PATH_LIMIT,'平移后仍在上限内');
 const restored=sanitizeMark({id:1,type:'brush',x:0,y:0,w:0,h:0,ex:0,ey:0,path:long,note:''});assert.ok(restored&&restored.path.length<=BRUSH_PATH_LIMIT,'超长草稿压缩后保留，不丢');
 const t=await bench();const w=t.w as any,s=richStage();w.tool='brush';w.bindMarks(s.node);s.fire('pointerdown',10,10);for(let i=0;i<1600;i++)s.fire('pointermove',10+(i%900)+.3,10+(i%400)+.3);s.fire('pointerup',500,300);
 const brush=w.markList('a')[0];assert.ok(brush&&brush.path.length<=BRUSH_PATH_LIMIT,'画很长的涂抹也在上限内');assert.match(t.toasts.at(-1)!,/已自动简化路径/);
});
test('multi-touch: only the first pointer drives a drag or a drawing; a second finger cannot move the mark or start another one',async()=>{
 const t=await bench();const w=t.w as any;w.marks.set('a|v1',[{id:1,type:'rect',x:100,y:100,w:100,h:100,ex:200,ey:200,path:'',note:''}]);w.tool='select';
 const s=richStage();w.bindMarks(s.node);s.fire('pointerdown',150,150,s.target('mark','1'),1);s.fire('pointerdown',600,400,s.target('none'),2);s.fire('pointermove',900,500,s.target('none'),2);s.fire('pointermove',170,160,s.target('none'),1);s.fire('pointerup',900,500,s.target('none'),2);
 assert.ok(w.adjusting,'第二根手指抬起不结束第一根的拖动');s.fire('pointerup',170,160,s.target('none'),1);
 assert.deepEqual(w.markList('a').map((m:StudioMark)=>[m.x,m.y]),[[120,110]],'只按第一根手指的位移');
 w.tool='rect';const s2=richStage();w.bindMarks(s2.node);s2.fire('pointerdown',300,300,s2.target('none'),5);s2.fire('pointerdown',700,500,s2.target('none'),6);s2.fire('pointermove',800,520,s2.target('none'),6);s2.fire('pointermove',400,380,s2.target('none'),5);s2.fire('pointerup',800,520,s2.target('none'),6);s2.fire('pointerup',400,380,s2.target('none'),5);
 assert.equal(w.markList('a').length,2);assert.deepEqual([w.markList('a')[1].x,w.markList('a')[1].y,w.markList('a')[1].w,w.markList('a')[1].h],[300,300,100,80],'新框只按第一根手指');
});
test('undo walks back in order: move, then edit the note, undo removes the note edit first, then the move',async()=>{
 const t=await bench();const w=t.w as any;w.marks.set('a|v1',[{id:1,type:'rect',x:100,y:100,w:100,h:100,ex:200,ey:200,path:'',note:'原说明'}]);w.tool='select';
 const s=richStage();w.bindMarks(s.node);s.fire('pointerdown',150,150,s.target('mark','1'));s.fire('pointermove',250,150);s.fire('pointerup',250,150);
 w.handleInput({id:'studio-wb-mark-1',value:'原说明，改'});w.handleInput({id:'studio-wb-mark-1',value:'原说明，改成新的'});
 assert.deepEqual(w.markList('a').map((m:StudioMark)=>[m.x,m.note]),[[200,'原说明，改成新的']]);
 await t.w.handle('studio-wb-undo',el());assert.deepEqual(w.markList('a').map((m:StudioMark)=>[m.x,m.note]),[[200,'原说明']],'先撤销说明（连续输入算一步），移动保留');
 await t.w.handle('studio-wb-undo',el());assert.deepEqual(w.markList('a').map((m:StudioMark)=>[m.x,m.note]),[[100,'原说明']],'再撤销移动');
});
test('the generate confirm button never lands on the trigger: the dialog is pushed to the other end when they would overlap',async()=>{
 // 假弹窗：居中时确认按钮在 y=centerY；贴顶 y=100；贴底 y=780。窗口 resize 回调可手动触发（模拟键盘弹出把居中位置挪到触发按钮上）。
 let centerY=580;const listeners:Record<string,Array<()=>void>>={},style={margin:''};
 const dialog={style,dataset:{} as Record<string,string>,addEventListener(){},querySelector:()=>({getBoundingClientRect:()=>({x:250,y:style.margin.startsWith('12px')?100:style.margin.endsWith('12px')?780:centerY,width:110,height:44})})};
 const t=await bench();const w=t.w as any;w.host.root.ownerDocument={getElementById:(id:string)=>id==='dialog'?dialog:null,defaultView:{innerHeight:844,addEventListener:(k:string,f:()=>void)=>{(listeners[k]??=[]).push(f);}}};
 const trigger=(r:{x:number;y:number;width:number;height:number})=>({dataset:{item:'b'},getBoundingClientRect:()=>r}) as unknown as HTMLElement;
 await t.w.handle('studio-wb-focus',el({item:'b'}));await t.w.handle('studio-wb-generate',trigger({x:240,y:570,width:120,height:44}));assert.equal(style.margin,'12px auto auto','触发按钮在下半屏 → 弹窗贴顶');
 w.dialogClosed();assert.equal(style.margin,'','关闭弹窗清掉位置');
 await t.w.handle('studio-wb-generate',trigger({x:240,y:300,width:120,height:44}));assert.equal(style.margin,'','不重叠时保持居中');
 centerY=300;for(const f of listeners.resize??[])f();assert.equal(style.margin,'auto auto 12px','布局变化（键盘弹出）后复核：变成重叠就挪开');
 w.dialogClosed();
 // 批量生成、调整画幅另存同样避让。
 centerY=580;w.confirmOpen=true;await t.w.handle('studio-wb-generate-all',trigger({x:240,y:570,width:120,height:44}));assert.equal(style.margin,'12px auto auto','批量生成也避让');w.dialogClosed();
 w.resizeDraft={item:'a',width:1200,height:1600};await t.w.handle('studio-wb-resize-next',trigger({x:240,y:570,width:120,height:44}));assert.equal(style.margin,'12px auto auto','调整画幅另存也避让');w.dialogClosed();
});
test('a drag in progress holds back another tab\'s sync; it is merged when the drag ends and a clash on the same mark is reported',async()=>{
 const shared=memStore();const t=await bench();const w=t.w as any;w.host.storage=()=>shared.storage;w.close();t.w.open('topic');await settle();await settle();
 const key='image-studio-marks:v1:w:topic',rect=(id:number,x:number,note=''):StudioMark=>({id,type:'rect',x,y:10,w:50,h:50,ex:x+50,ey:60,path:'',note});
 w.setMarks('a|v1',[rect(1,100,'本页说明')]);
 w.adjusting={key:'a|v1',id:1,mode:'move',start:{x:0,y:0},orig:rect(1,100,'本页说明')};
 const remote={...JSON.parse(shared.mem.get(key)!),'a|v1':[rect(1,100,'远端说明')],'b|v9':[rect(1,300)]};shared.mem.set(key,JSON.stringify(remote));
 w.syncMarksFromStore(shared.mem.get(key));assert.equal(w.markList('a')[0].note,'本页说明','拖动中不套用远端');assert.equal(w.syncDeferred,true);
 w.adjusting=undefined;w.setMarks('a|v1',[rect(1,180,'本页说明')]);assert.match(t.toasts.at(-1)!,/另一个标签页也改过这张图的标注/,'同一项两边都改了提示');
 w.flushSync();assert.equal(w.syncDeferred,false);assert.deepEqual(JSON.parse(shared.mem.get(key)!)['b|v9'][0].x,300,'远端其他项保留');assert.equal(w.marks.get('b|v9')?.[0].x,300,'结束后合并远端其他项');
});
// ——— 第 2 轮：生成成功后默认选中新版本；首次生成可选渠道与模型 ———
async function editOnce(t:Awaited<ReturnType<typeof bench>>){t.w.handleInput({id:'studio-wb-request',value:'整体更亮'} as never);await t.w.handle('studio-wb-edit',el({item:'a'}));await t.w.handle('studio-wb-edit-confirm',el());}
test('a successful edit becomes the current image and the stage follows it; switching away does not steal the stage; failure keeps v1; confirmed images are not auto-switched',async()=>{
 {const v=value();const t=await bench(v);const w=t.w as any;await editOnce(t);assert.equal(t.submits.length,1);
  v.studio.slots[0].versions.push(version('v2',{operation:'reference_edit'}));await w.reload();await settle();
  assert.deepEqual(t.calls.at(-1),['update:a',{topic_id:'topic',expected_version:2,current_version_id:'v2'}],'新版本设为当前图');assert.equal(w.preview.has('a'),false,'舞台跟随当前图');assert.match(t.toasts.join('\n'),/已生成第 2 版，已设为当前图，可在修改版本里切回/);assert.equal(w.fresh.has('a'),false);}
 {const v=value();const t=await bench(v);const w=t.w as any;await editOnce(t);await t.w.handle('studio-wb-focus',el({item:'b'}));
  v.studio.slots[0].versions.push(version('v2',{operation:'reference_edit'}));await w.reload();await settle();
  assert.deepEqual(t.calls.at(-1),['update:a',{topic_id:'topic',expected_version:2,current_version_id:'v2'}],'切走后仍设为当前图');assert.equal(w.focus,'b','不抢舞台');assert.match(t.markup(),/新版本已生成/,'卡片上标出');
  await t.w.handle('studio-wb-focus',el({item:'a'}));assert.doesNotMatch(t.markup(),/新版本已生成/,'看过之后去掉标记');}
 {const v=value();const t=await bench(v);const w=t.w as any;await editOnce(t);w.preview.set('a','v1-old');
  v.studio.slots[0].versions.push(version('v2',{operation:'reference_edit'}));await w.reload();await settle();assert.equal(w.preview.get('a'),'v1-old','手动选了别的版本时不切舞台');assert.equal(w.fresh.has('a'),true);}
 {const v=value();const t=await bench(v);const w=t.w as any;await editOnce(t);const before=t.calls.length;
  v.studio.slots[0].versions.push(version('v2',{operation:'reference_edit',state:'failed',asset_id:null}));await w.reload();await settle();
  assert.equal(t.calls.length,before,'失败不切换');assert.equal(w.expecting.size,0);}
 {const v=value();v.plan.final={pending:0,confirmed:true,current:true,confirmed_at:'2026-10-16T00:00:00Z'};const t=await bench(v);const w=t.w as any;await editOnce(t);const before=t.calls.length;
  v.studio.slots[0].versions.push(version('v2',{operation:'reference_edit'}));await w.reload();await settle();
  assert.equal(t.calls.length,before,'配图已确认后不自动换当前图');assert.match(t.toasts.at(-1)!,/配图已确认，当前图没有自动更换/);}
});
test('first generation: the confirm dialog lets you switch provider and model, the pick goes into the request and is shared with the right column',async()=>{
 const t=await bench();const w=t.w as any;await t.w.handle('studio-wb-focus',el({item:'b'}));
 w.handleChange({id:'studio-wb-provider',value:'agy'});await t.w.handle('studio-wb-generate',el({item:'b'}));let d=t.dialogs.at(-1)!;
 assert.match(d.body,/<select class="field" id="studio-wb-gen-provider"><option value="agy" selected>[^<]*<\/option><option value="codex">/,'右栏选了 AGY，弹窗默认 AGY，可换 Codex');assert.match(d.body,/本渠道只有这一个模型/,'单模型渠道写明');
 w.handleChange({id:'studio-wb-gen-provider',value:'codex'});d=t.dialogs.at(-1)!;assert.match(d.body,/生成渠道<\/dt><dd>Codex/);assert.equal(w.provider,'codex','选择与右栏共用');assert.match(t.markup(),/id="studio-wb-provider"[^>]*>[^]*?<option value="codex" selected/);
 await t.w.handle('studio-wb-generate-confirm',el());assert.equal((t.submits.at(-1) as any).provider,'codex','按所选渠道提交');
 w.studio.capabilities.find((c:any)=>c.provider==='agy').models=[{id:'m1',label:'模型一'},{id:'m2',label:'模型二'}];w.handleChange({id:'studio-wb-provider',value:'agy'});
 await t.w.handle('studio-wb-generate',el({item:'b'}));assert.match(t.dialogs.at(-1)!.body,/id="studio-wb-gen-model"/);w.handleChange({id:'studio-wb-gen-model',value:'m2',dataset:{provider:'agy'}});assert.match(t.dialogs.at(-1)!.body,/生图模型<\/dt><dd>模型二/);
 await t.w.handle('studio-wb-generate-confirm',el());assert.deepEqual([(t.submits.at(-1) as any).provider,(t.submits.at(-1) as any).model],['agy','m2']);
});
