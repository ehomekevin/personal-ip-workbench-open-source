// 「导入所选」每个提前返回与中断都要有可见反馈（toast 或弹窗内 role=alert），busy/弹窗锁在 finally 复位；走真实入口 handle()。
import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageStudioController} from '../../apps/web/src/features/media/image-studio/index.ts';
import type {ImageStudioPort} from '../../apps/web/src/features/media/image-studio/index.ts';
import type {StudioSnapshot,StudioWebCandidateView} from '../../apps/web/src/features/media/image-studio/model.ts';
const snapshot:StudioSnapshot={topic_id:'topic',document_revision_id:'revision',version:1,title:'文章',article:'正文',paragraphs:[{id:'p1',label:'第1段',text:'正文'}],slots:[],references:[],capabilities:[]};
const item=(id:string):StudioWebCandidateView=>({id,image_url:'https://news.example/'+id+'.png',thumb_url:'https://news.example/'+id+'.png',credit:'图源：The Verge',page_url:'https://news.example/a',page_label:'The Verge',group:'article',selectable:true,note:''});
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const settle=()=>new Promise<void>(r=>setTimeout(r,0));
function fixture(){
 const toasts:string[]=[],alerts:string[]=[],busy:boolean[]=[],imports:string[]=[],loads:number[]=[];let candidates:StudioWebCandidateView[]=[],assetsChanged:()=>Promise<void>=async()=>{};let load:()=>Promise<StudioSnapshot>=async()=>structuredClone(snapshot),webImport:(id:string)=>Promise<any>=async id=>({slot_id:'s1',version_id:'v-'+id,asset_id:'a-'+id,deduplicated:false,version:2});
 const button={disabled:true,textContent:'',busy:false,toggleAttribute(_:string,on:boolean){this.busy=on;}},status={textContent:''},dialog={open:true,closed:0,querySelector:(s:string)=>s==='.studio-web'?{}:null,close(){this.open=false;this.closed++;}},body={querySelector:()=>null,insertAdjacentHTML:(_:string,html:string)=>alerts.push(html.replace(/<[^>]+>/g,''))};
 const root={querySelector:(s:string)=>s==='#studio-web-import'?button:s==='#studio-web-progress'?status:s==='#dialog'?dialog:s==='#dialog .dialog-body'?body:s==='.image-studio-panel'?{innerHTML:''}:null,querySelectorAll:()=>[]} as unknown as HTMLElement;
 const port={load:()=>{loads.push(1);return load();},webCandidates:async()=>({items:candidates,capture:{refreshing:false,note:'',retry:false,tone:'none' as const}}),webImport:async(input:any)=>{imports.push(input.candidate.candidate_id);return webImport(input.candidate.candidate_id);}} as unknown as ImageStudioPort;
 const c:any={identity:{workspace_id:'ws',service_instance_id:'svc'},ui:{topic:'topic'},signal:new AbortController().signal,drafts:{leave:async()=>{}},surface:{presentDialog:()=>{},dialogBusy:(v:boolean)=>busy.push(v),closeDialog:()=>{controller.close();dialog.open=false;}}};
 const controller=new ImageStudioController({root,context:()=>c,active:()=>true,signal:c.signal,toast:m=>toasts.push(m),port,assetsChanged:()=>assetsChanged()}),internal=controller as any;internal.topic='topic';internal.snapshot=structuredClone(snapshot);
 const openWeb=(ids:string[],picked:string[])=>{internal.dialogOpen=true;internal.dialogTitle='公众号配图 · 从网络找图';internal.dialogEpoch++;internal.web={items:ids.map(item),picked:new Set(picked),target:'new',failures:new Map(),imported:new Set()};dialog.open=true;};
 const click=()=>controller.handle({dataset:{action:'studio-web-import'}} as unknown as HTMLElement);
 const reopen=async(ids:string[])=>{candidates=ids.map(item);dialog.open=true;controller.handle({dataset:{action:'studio-web'}} as unknown as HTMLElement);for(let i=0;i<10;i++)await settle();};
 const check=(id:string)=>controller.handleChange({id:'studio-web-pick-'+id,checked:true,closest:()=>null} as unknown as HTMLInputElement);
 return {reopen,check,loads,setAssets:(f:typeof assetsChanged)=>{assetsChanged=f;},controller,internal,toasts,alerts,busy,imports,button,status,dialog,openWeb,click,setLoad:(f:typeof load)=>{load=f;},setImport:(f:typeof webImport)=>{webImport=f;}};
}
test('没有找图窗口状态、没有勾选、配图记录未读取：都提示原因，不发请求',async()=>{
 const f=fixture();f.internal.dialogOpen=true;f.internal.dialogTitle='公众号配图 · 从网络找图';f.click();await settle();assert.match(f.toasts.at(-1)!,/找图窗口已失效/);assert.match(f.alerts.at(-1)!,/找图窗口已失效/);
 f.openWeb(['a'],[]);f.click();await settle();assert.match(f.toasts.at(-1)!,/没有选中的图片/);assert.match(f.alerts.at(-1)!,/没有选中的图片/);
 f.openWeb(['a'],['a']);f.internal.snapshot=undefined;f.click();await settle();assert.match(f.toasts.at(-1)!,/配图记录还没读取完成/);
 assert.deepEqual(f.imports,[]);assert.equal(f.internal.busy,false);
});
test('点击立即进入「导入中…」并逐张更新进度，完成后复位',async()=>{
 const f=fixture(),gate=deferred<void>();f.setImport(async id=>{if(id==='b')await gate.promise;return {slot_id:'s1',version_id:'v-'+id,asset_id:'a-'+id,deduplicated:false,version:2};});f.openWeb(['a','b'],['a','b']);
 f.click();assert.equal(f.button.textContent,'导入中…（0/2）','同步进入导入中');assert.equal(f.button.disabled,true);assert.equal(f.button.busy,true);assert.match(f.status.textContent,/正在导入第 1 \/ 2 张/);assert.deepEqual(f.busy,[true]);
 for(let i=0;i<10&&(f.button.textContent as string)!=='导入中…（1/2）';i++)await settle();assert.equal(f.button.textContent,'导入中…（1/2）');assert.match(f.status.textContent,/第 2 \/ 2 张/);
 gate.resolve();for(let i=0;i<10&&f.internal.busy;i++)await settle();assert.equal(f.internal.busy,false);assert.deepEqual(f.imports,['a','b']);assert.match(f.toasts.at(-1)!,/已导入 2 张网络配图/);assert.equal(f.busy.at(-1),false);
});
test('导入前读取期间窗口被关闭：停止并提示，不发导入请求，busy 复位',async()=>{
 const f=fixture(),read=deferred<StudioSnapshot>();f.openWeb(['a'],['a']);f.setLoad(()=>read.promise);f.click();f.controller.close();f.dialog.open=false;read.resolve(structuredClone(snapshot));for(let i=0;i<10;i++)await settle();
 assert.match(f.toasts.at(-1)!,/找图窗口已关闭，导入已停止/);assert.deepEqual(f.imports,[]);assert.equal(f.internal.busy,false);
});
test('导入进行中页面刷新（面板失活）：关掉失去归属的找图弹窗，提示重新勾选，不再发后续请求',async()=>{
 const f=fixture(),gate=deferred<void>();f.setImport(async id=>{if(id==='a')await gate.promise;return {slot_id:'s1',version_id:'v-'+id,asset_id:'a-'+id,deduplicated:false,version:2};});f.openWeb(['a','b'],['a','b']);
 f.click();for(let i=0;i<10&&!f.imports.length;i++)await settle();f.controller.deactivate();assert.equal(f.dialog.closed,1,'失活时关掉找图弹窗');assert.match(f.toasts.at(-1)!,/页面已刷新，找图窗口已关闭/);
 gate.resolve();for(let i=0;i<10;i++)await settle();assert.deepEqual(f.imports,['a']);assert.match(f.toasts.at(-1)!,/页面已刷新，导入已停止.*已导入的 1 张/);assert.equal(f.internal.busy,false);
});
test('窗口仍在但本次操作已失去归属：弹窗内 role=alert 提示重新勾选，并复位按钮与弹窗锁',async()=>{
 const f=fixture(),read=deferred<StudioSnapshot>();f.openWeb(['a'],['a']);f.setLoad(()=>read.promise);f.click();f.internal.operationEpoch++;read.resolve(structuredClone(snapshot));for(let i=0;i<10;i++)await settle();
 assert.match(f.alerts.at(-1)!,/页面已刷新，导入已停止，请重新勾选/);assert.deepEqual(f.imports,[]);assert.equal(f.busy.at(-1),false);assert.equal(f.button.textContent,'导入所选（1 张）');
});
test('单张导入失败：其余继续，结束时复位 busy 并提示失败张数',async()=>{
 const f=fixture();f.setImport(async id=>{if(id==='a')throw Object.assign(new Error('来源返回 404，未取得内容'),{status:400,response:{error:{code:'VALIDATION_ERROR',message:'来源返回 404'}}});return {slot_id:'s1',version_id:'v-'+id,asset_id:'a-'+id,deduplicated:false,version:2};});f.openWeb(['a','b'],['a','b']);
 f.click();for(let i=0;i<20&&f.internal.busy;i++)await settle();assert.equal(f.internal.busy,false);assert.deepEqual(f.imports,['a','b']);assert.match(f.toasts.at(-1)!,/已导入 1 张，1 张没有导入/);assert.equal(f.internal.web.failures.get('a'),'来源页面已打不开，未取得图片');
});
test('导入中关窗 → 迟到的成功先对账（补读快照、记为已导入）→ 重开时标「已导入」不可再选，不再发第二次 POST',async()=>{
 const f=fixture(),gate=deferred<void>();f.setImport(async id=>{if(id==='a')await gate.promise;return {slot_id:'s1',version_id:'v-'+id,asset_id:'a-'+id,deduplicated:false,version:2};});f.openWeb(['a','b'],['a','b']);
 f.click();for(let i=0;i<10&&!f.imports.length;i++)await settle();f.controller.close();f.dialog.open=false;const loadsBefore=f.loads.length;gate.resolve();for(let i=0;i<10;i++)await settle();
 assert.deepEqual(f.imports,['a'],'关窗后不发后续请求');assert.ok(f.loads.length>loadsBefore,'迟到成功补读一次快照');
 await f.reopen(['a','b']);assert.equal(f.internal.web.imported.has('a'),true,'重开时 a 已标为已导入');f.check('a');assert.equal(f.internal.web.picked.has('a'),false,'已导入项不可再选');
 f.check('b');f.click();for(let i=0;i<20&&f.internal.busy;i++)await settle();assert.deepEqual(f.imports,['a','b'],'a 没有第二次 POST');
});
test('部分失败后上一轮收尾未完成时重试：旧一轮 finally 不清新一轮的进度、不解锁控件',async()=>{
 const f=fixture(),assets=deferred<void>(),gate=deferred<void>();let round=1;f.setAssets(()=>assets.promise);
 f.setImport(async id=>{if(round===1&&id==='a')throw Object.assign(new Error('来源返回 404'),{status:400,response:{error:{code:'VALIDATION_ERROR',message:'来源返回 404'}}});if(round===2)await gate.promise;return {slot_id:'s1',version_id:'v-'+id+round,asset_id:'a-'+id,deduplicated:false,version:2};});
 f.openWeb(['a','b'],['a','b']);f.click();for(let i=0;i<20&&!/已导入 1 张，1 张没有导入/.test(f.toasts.at(-1)??'');i++)await settle();assert.match(f.toasts.at(-1)!,/1 张没有导入/);assert.equal(f.internal.busy,false,'第一轮已放开按钮，收尾（assetsChanged）未完成');
 round=2;f.click();assert.equal(f.button.textContent,'导入中…（0/1）');for(let i=0;i<10&&f.imports.length<3;i++)await settle();
 const locks=f.busy.length;assets.resolve();for(let i=0;i<10;i++)await settle();
 assert.equal(f.button.textContent,'导入中…（0/1）','旧 finally 没清掉新一轮进度');assert.equal(f.internal.busy,true);assert.deepEqual(f.busy.slice(locks),[],'旧 finally 没有解锁弹窗控件');
 gate.resolve();for(let i=0;i<20&&f.internal.busy;i++)await settle();assert.equal(f.internal.busy,false);assert.equal(f.busy.at(-1),false);
});
