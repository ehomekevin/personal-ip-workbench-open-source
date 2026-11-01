import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageStudioController,imageStudioHttpPort,verifiedStudioImageUrl} from '../../apps/web/src/features/media/image-studio/index.ts';
import {acceptStudioBrief,defaultStudioDraft,invalidateStudioBrief,studioDimensionsError,studioSubmit,studioGenerationInput,projectStudioSnapshot,studioFinalConfirmationReason,studioDraftPromptBudget} from '../../apps/web/src/features/media/image-studio/model.ts';
import type {StudioSnapshot,StudioBrief,StudioDraft} from '../../apps/web/src/features/media/image-studio/model.ts';
import type {ImageStudioPort} from '../../apps/web/src/features/media/image-studio/index.ts';
import type {FeatureContext} from '../../apps/web/src/transport/feature-ports.ts';
const capability={provider:'agy' as const,label:'AGY · Nano Banana',enabled:true,available:true,sizes:[{id:'16:9',label:'拟生成 16:9',width:1600,height:900},{id:'9:16',label:'拟生成 9:16',width:1080,height:1920}],custom:{min:320,max:4096,step:1,min_ratio:.2,max_ratio:5},reference_limit:1,reference_edit:true,mask:false,text_edit:false,limitations:['画幅提示，像素值不保证']};
const snapshot:StudioSnapshot={topic_id:'topic',document_revision_id:'revision',version:1,title:'本人文章',article:'文章内容',paragraphs:[{id:'p1',label:'第1段',text:'第一段长说明'},{id:'p2',label:'第2段',text:'第二段'}],slots:[],references:[],capabilities:[capability]};
const brief:StudioBrief={id:'brief1',provider:'agy',width:1600,height:900,reason:'内容分析认为需要并列呈现，留出两个说明区。',input_digest:'digest',capability_revision:'v1',analysis_source:'fixture-content-analysis'};
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(e:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function fixture(){
  const fields=new Map<string,any>(),dialogs:any[]=[],toasts:string[]=[],busy:boolean[]=[],submitted:any[]=[],adopted:any[]=[],confirmed:any[]=[],cancelled:string[]=[],panel={innerHTML:''};let stored=structuredClone(snapshot),load=async()=>structuredClone(stored),analyze=async()=>structuredClone(brief),submit=async()=>({job_id:'job',input_hash:'input'}),leave=async()=>{};
  const port:ImageStudioPort={webCandidates:async()=>({items:[],capture:{refreshing:false,note:'',retry:false,tone:'none' as const}}),webImport:async()=>{throw new Error('not used');},load:()=>load(),brief:()=>analyze(),submit:async(input,key)=>{submitted.push({input,key});return submit();},reference:async()=>({asset_id:'reference',name:'uploaded.png',purpose:'style',sha256:'a'.repeat(64),mime:'image/png',size_bytes:10,width:0,height:0,fixed:false}),adopt:async input=>{adopted.push(input);return structuredClone(stored);},confirmFinal:async input=>{confirmed.push(input);return {...structuredClone(stored),recording:{process_record:'/isolated/process.md',wiki_confirmation_required:true,wiki_record:'/isolated/final.md'}};}};
  const root={querySelector:(selector:string)=>selector==='.image-studio-panel'?panel:selector==='[data-action="studio-brief"]'?fields.get('studio-brief'):selector.startsWith('#')?fields.get(selector.slice(1)):null} as unknown as HTMLElement;
  const c={identity:{workspace_id:'ui-studio-unit',service_instance_id:'service'},ui:{topic:'topic'},signal:new AbortController().signal,drafts:{leave:()=>leave()},surface:{presentDialog:(d:any)=>dialogs.push(d),dialogBusy:(value:boolean)=>busy.push(value),closeDialog:()=>controller.close()},client:{request:async()=>({job:{id:'job',target_id:'topic',input_hash:'input',state:'queued',version:1},attempts:[],checkpoint:null,error:null,artifacts:[],receipts:[]}),cancelJob:async(id:string)=>{cancelled.push(id);}}} as unknown as FeatureContext;
  const controller=new ImageStudioController({root,context:()=>c,active:()=>true,signal:c.signal,toast:m=>toasts.push(m),port}),internal=controller as any;internal.topic='topic';
  function form(description='真实说明'){for(const [id,value] of Object.entries({'studio-description':description,'studio-title':'可选标题','studio-placement':'after:p1','studio-paragraph':'p1','studio-provider':'agy','studio-width':'1600','studio-height':'900','studio-reference-select':''}))fields.set(id,{value,focus(){}});for(const id of ['studio-format-summary','studio-format-reason','studio-format-error','studio-prompt-budget','studio-prompt-error'])fields.set(id,{textContent:''});fields.set('studio-format-paper',{style:{}});fields.set('studio-submit',{disabled:false});fields.set('studio-brief',{disabled:false});}
  return {controller,internal,c,fields,dialogs,toasts,busy,submitted,adopted,confirmed,cancelled,panel,form,setLoad:(fn:typeof load)=>{load=fn;},setBrief:(fn:typeof analyze)=>{analyze=fn;},setSubmit:(fn:typeof submit)=>{submit=fn;},setLeave:(fn:typeof leave)=>{leave=fn;},setSnapshot:(value:StudioSnapshot)=>{stored=value;}};
}
const action=(name:string,dataset:Record<string,string>={})=>({dataset:{action:name,...dataset}} as unknown as HTMLElement);

test('自动画幅只消费服务brief；手动覆盖不随内容变化丢失',()=>{
  const draft={...defaultStudioDraft('agy'),description:'六步内容'};
  assert.equal(draft.width,0);assert.equal(draft.brief,null);
  const automatic=acceptStudioBrief(draft,brief);assert.deepEqual([automatic.width,automatic.height],[1600,900]);
  assert.deepEqual([invalidateStudioBrief(automatic).width,invalidateStudioBrief(automatic).height],[0,0]);
  const manual={...automatic,mode:'manual' as const,width:1080,height:1920};const edited=invalidateStudioBrief(manual);
  assert.deepEqual([edited.width,edited.height],[1080,1920]);assert.equal(edited.brief,null);
  assert.deepEqual([acceptStudioBrief(edited,brief).width,acceptStudioBrief(edited,brief).height],[1080,1920]);
  assert.equal(acceptStudioBrief(draft,{...brief,provider:'codex'}),draft);
});
test('请求范围来自能力描述，非法尺寸和缺分析拒绝提交',()=>{
  assert.match(studioDimensionsError({width:0,height:900},capability),/正整数/);
  assert.match(studioDimensionsError({width:5000,height:900},capability),/320–4096/);
  assert.match(studioDimensionsError({width:4096,height:320},capability),/比例/);
  assert.match(studioDimensionsError({width:1350,height:1800},{...capability,custom:null}),/列出的尺寸/);
  const draft={...defaultStudioDraft('agy'),description:'说明',width:1600,height:900};
  assert.throws(()=>studioSubmit(snapshot,draft),/取得画幅建议/);
  assert.doesNotThrow(()=>studioSubmit(snapshot,{...draft,mode:'manual'}));
  assert.throws(()=>studioSubmit(snapshot,{...draft,mode:'manual',operation:'reference_edit',reference_assets:[{asset_id:'a',purpose:'style'},{asset_id:'b',purpose:'layout'}]}),/最多支持 1/);
});
test('正式DTO生成mapper绑定父版本、段落、期望尺寸及用途',()=>{
  const input=studioSubmit(snapshot,{...defaultStudioDraft('agy'),mode:'manual',operation:'reference_edit',description:'修改说明',width:1350,height:1800,slot_id:'slot',parent_version_id:'old-viewed',paragraph_id:'p1',placement:'before:p2',reference_assets:[{asset_id:'person',purpose:'person'}]});
  const request=studioGenerationInput(input);assert.deepEqual(request.size,{width:1350,height:1800,aspect_ratio:'3:4'});assert.equal(request.parent_version_id,'old-viewed');assert.equal(request.position,'before');assert.equal(request.paragraph_id,'p1');assert.equal(request.placement_paragraph_id,'p2');assert.deepEqual(request.references,[{asset_id:'person',purpose:'identity'}]);
});
test('正式snapshot投影没有实际文件时不能把期望尺寸当实际',()=>{
  const version={id:'v',job_id:'job',asset_id:null,state:'queued',provider:'agy',description:'说明',title:'图',size_request:{mode:'auto',width:1600,height:900,aspect_ratio:'16:9',policy:'prompt_guided'},accepted_parameters:null,actual_size:null,size_match:null,size_warning:null,paragraph_id:'p',placement_paragraph_id:'p',position:'after',operation:'generate',references:[],parent_version_id:null,document_revision_id:'r',created_at:'t',adoption:'pending',error:null};
  const value={topic_id:'t',document_id:'d',document_revision_id:'r',article_text:'文章',article_source:'core',version:1,paragraphs:[{id:'p',index:0,text:'真实文章'}],slots:[{id:'s',title:'图',paragraph_id:'p',placement_paragraph_id:'p',position:'after',description:'说明',provider:'agy',size_mode:'auto',references:[],active_version_id:null,versions:[version]}],references:[],capabilities:[{provider:'agy',composition_targets:[{aspect_ratio:'16:9',width:1600,height:900}],manual_range:{min_edge:320,max_edge:4096,min_ratio:.2,max_ratio:5},references:{max_images:1},limitations:['像素不保证']}],briefs:[],recording:{process_record:'record',wiki_confirmation_required:true,wiki_record:null}};
  const settings={version:1,default_provider:'agy',channels:[{provider:'agy',label:'AGY',enabled:true,configured:true,operations:{generation:'supported',reference_edit:'supported'}}]};
  const projected=projectStudioSnapshot(value as any,[],settings as any);assert.equal(projected.slots[0]!.versions[0]!.actual_verified,false);assert.equal(projected.slots[0]!.versions[0]!.mime,'');assert.equal(projected.slots[0]!.placement,'after:p');assert.equal(projected.capabilities[0]!.mask,false);
});
test('新增完整窗口带真实渠道范围和像素限制；初始不允许无brief生成',async()=>{
  const f=fixture();try{await f.controller.dispatch('studio-add',action('studio-add'));f.form();f.internal.updateFormat();const html=f.dialogs.at(-1).body;for(const text of ['这张图要说明什么','关联文章段落','图片标题','插入文章的位置','生成渠道','参考图','自动选择','手动调整','画幅与像素作为画面说明发送','直接改字能力尚未验证'])assert.match(html,new RegExp(text));assert.equal(f.fields.get('studio-submit').disabled,true);assert.equal(f.internal.draft.paragraph_id,'p1');assert.equal(f.submitted.length,0);}finally{f.controller.dispose();}
});
test('关窗或换文章后的迟到load不能打开新增窗口',async()=>{
  const f=fixture(),wait=deferred<void>();try{f.setLeave(()=>wait.promise);const pending=f.controller.dispatch('studio-add',action('studio-add'));f.controller.close('escape');wait.resolve();await pending;assert.equal(f.dialogs.length,0);assert.equal(f.submitted.length,0);}finally{f.controller.dispose();}
  const g=fixture(),read=deferred<StudioSnapshot>();try{g.setLoad(()=>read.promise);const pending=g.controller.load();g.controller.deactivate();read.resolve(snapshot);await pending;assert.equal(g.internal.snapshot,undefined);assert.equal(g.internal.loading,false);}finally{g.controller.dispose();}
});
test('旧brief回执不能复活关闭的窗口或覆盖新说明',async()=>{
  const f=fixture(),wait=deferred<StudioBrief>();try{await f.controller.dispatch('studio-add',action('studio-add'));f.form();f.setBrief(()=>wait.promise);const pending=f.controller.dispatch('studio-brief',action('studio-brief'));f.controller.close('escape');const dialogs=f.dialogs.length;wait.resolve(brief);await pending;assert.equal(f.dialogs.length,dialogs);assert.equal(f.internal.draft.brief,null);assert.equal(f.busy.at(-1),true);}finally{f.controller.dispose();}
  const g=fixture(),late=deferred<StudioBrief>();try{await g.controller.dispatch('studio-add',action('studio-add'));g.form();g.setBrief(()=>late.promise);const pending=g.controller.dispatch('studio-brief',action('studio-brief'));g.fields.get('studio-description').value='新说明';g.controller.handleInput({id:'studio-description'} as HTMLInputElement);late.resolve(brief);await pending;assert.equal(g.internal.draft.description,'新说明');assert.equal(g.internal.draft.brief,null);}finally{g.controller.dispose();}
});
test('手动尺寸修改说明仍保持，切回自动消费新brief',async()=>{
  const f=fixture();try{await f.controller.dispatch('studio-add',action('studio-add'));f.form();await f.controller.dispatch('studio-manual',action('studio-manual'));f.fields.get('studio-width').value='1350';f.fields.get('studio-height').value='1800';f.fields.get('studio-description').value='后来改成长流程';f.controller.handleInput({id:'studio-description'} as HTMLInputElement);assert.deepEqual([f.internal.draft.width,f.internal.draft.height],[1350,1800]);await f.controller.dispatch('studio-auto',action('studio-auto'));assert.equal(f.internal.draft.mode,'auto');assert.deepEqual([f.internal.draft.width,f.internal.draft.height],[1600,900]);}finally{f.controller.dispose();}
});
test('保存等待关窗0submit，文章revision变化拒绝过时任务',async()=>{
  const f=fixture(),wait=deferred<void>();try{await f.controller.dispatch('studio-add',action('studio-add'));f.form();f.internal.draft.mode='manual';f.setLeave(()=>wait.promise);const pending=f.controller.dispatch('studio-submit',action('studio-submit')).then(()=>f.controller.dispatch('studio-submit-confirm',action('studio-submit-confirm')));f.controller.close('escape');wait.resolve();await pending;assert.equal(f.submitted.length,0);}finally{f.controller.dispose();}
  const g=fixture();try{await g.controller.dispatch('studio-add',action('studio-add'));g.form();g.internal.draft.mode='manual';g.setLoad(async()=>({...snapshot,document_revision_id:'new'}));await assert.rejects(g.controller.dispatch('studio-submit',action('studio-submit')).then(()=>g.controller.dispatch('studio-submit-confirm',action('studio-submit-confirm'))),/文章或配图已变化/);assert.equal(g.submitted.length,0);}finally{g.controller.dispose();}
});
test('响应不明保留冻结输入且重复启动0第二submit',async()=>{
  const f=fixture();try{await f.controller.dispatch('studio-add',action('studio-add'));f.form();f.internal.draft.mode='manual';f.setSubmit(async()=>{throw new Error('response unknown');});await assert.rejects(f.controller.dispatch('studio-submit',action('studio-submit')).then(()=>f.controller.dispatch('studio-submit-confirm',action('studio-submit-confirm'))),/response unknown/);assert.equal(f.internal.pending.job_id,null);assert.equal(f.internal.pending.input.description,'真实说明');f.fields.get('studio-description').value='后来编辑';await assert.rejects(f.controller.dispatch('studio-submit',action('studio-submit')),/不能再次提交/);assert.equal(f.submitted.length,1);assert.match(f.controller.panel(),/创建结果待核对/);}finally{f.controller.dispose();}
});
test('迟到accepted保留原job并仅撤销原ID，不重开窗口或重复提交',async()=>{
  const f=fixture(),wait=deferred<{job_id:string;input_hash:string}>();try{await f.controller.dispatch('studio-add',action('studio-add'));f.form();f.internal.draft.mode='manual';f.setSubmit(()=>wait.promise);const pending=f.controller.dispatch('studio-submit',action('studio-submit')).then(()=>f.controller.dispatch('studio-submit-confirm',action('studio-submit-confirm')));await settle();f.controller.close('escape');const before=f.dialogs.length;wait.resolve({job_id:'job',input_hash:'input'});await pending;assert.equal(f.dialogs.length,before);assert.equal(f.internal.pending.job_id,'job');assert.deepEqual(f.cancelled,['job']);assert.equal(f.submitted.length,1);}finally{f.controller.dispose();}
});
test('上传实际reference、已保存reference选择和用途随生成请求保存',async()=>{
  const f=fixture();try{await f.controller.dispatch('studio-add',action('studio-add'));f.form();const file=new File(['fixture'],'uploaded.png',{type:'image/png'});await f.internal.upload(file,f.internal.epoch,f.internal.dialogEpoch,++f.internal.operationEpoch);assert.equal(f.internal.snapshot.references[0].asset_id,'reference');assert.deepEqual(f.internal.draft.reference_assets,[{asset_id:'reference',purpose:'style'}]);f.fields.set('studio-reference-purpose-reference',{value:'person'});f.controller.handleChange({id:'studio-reference-purpose-reference'} as HTMLInputElement);assert.deepEqual(f.internal.draft.reference_assets,[{asset_id:'reference',purpose:'person'}]);assert.match(f.dialogs.at(-1).body,/uploaded.png/);}finally{f.controller.dispose();}
});
test('viewing/compare不自动采用；回退采用调用正式expected_version且保留列表',async()=>{
  const f=fixture();const version={id:'v1',slot_id:'s',asset_id:'asset',provider:'agy' as const,description:'旧说明',title:'旧图',requested:{width:1600,height:900},accepted:null,actual:{width:1024,height:1024},mime:'image/jpeg',sha256:'a'.repeat(64),size_bytes:10,created_at:'t',job_id:'job',parent_version_id:null,reference_assets:[],actual_verified:false,state:'succeeded',warning:'实际画幅与期望不同',error:null,accepted_parameters:null,document_revision_id:'revision',paragraph_id:'p1',placement:'after:p1',operation:'generate' as const};
  try{f.setSnapshot({...snapshot,slots:[{id:'s',title:'图',description:'说明',placement:'after:p1',adopted_version_id:'v1',versions:[version,{...version,id:'v2',parent_version_id:'v1'}]}]});await f.controller.load();await f.controller.dispatch('studio-version',action('studio-version',{version:'v2'}));await f.controller.dispatch('studio-compare',action('studio-compare'));assert.equal(f.adopted.length,0);assert.match(f.dialogs.at(-1).body,/上一版/);await f.controller.dispatch('studio-restore',action('studio-restore',{version:'v1'}));assert.deepEqual(f.adopted,[{topic_id:'topic',slot_id:'s',version_id:'v1',expected_version:1}]);assert.equal(f.internal.snapshot.slots[0].versions.length,2);}finally{f.controller.dispose();}
});
test('图片查看以解码宽高校验实际记录，标签或CSS不会改变验证',async()=>{
  const original=(globalThis as any).Image;(globalThis as any).Image=class{src='';naturalWidth=1024;naturalHeight=1024;async decode(){}};
  try{const blob=new Blob(['fixture-image-bytes'],{type:'image/png'}),sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('');const asset={id:'a',mime:'image/png',size_bytes:blob.size,sha256,width:1600,height:900};await assert.rejects(verifiedStudioImageUrl(blob,asset),/解码尺寸/);const url=await verifiedStudioImageUrl(blob,{...asset,width:1024,height:1024});URL.revokeObjectURL(url);}finally{(globalThis as any).Image=original;}
});
test('默认HTTP port只用正式路由/DTO，adopt不走孤立示意接口',async()=>{
  const calls:any[]=[],port=imageStudioHttpPort(),context={signal:new AbortController().signal,client:{request:async(method:string,url:string,body:any)=>{calls.push({method,url,body});if(url.endsWith('/brief'))return {id:'b',provider:'agy',suggested_size:{width:1600,height:900},reason:'真实brief',input_digest:'h',content_analysis:{fixture:true}};return {job_id:'j',input_hash:'h'};}}} as unknown as FeatureContext;
  await port.brief({topic_id:'topic',document_revision_id:'r',provider:'agy',description:'说明',title:'t',paragraph_id:'p1',placement:'before:p1',reference_assets:[]},context);
  const draft={...defaultStudioDraft('agy'),mode:'manual' as const,description:'说明',width:1600,height:900,paragraph_id:'p1',placement:'after:p1'};await port.submit(studioSubmit(snapshot,draft),'one-key',context);assert.equal(calls[0].url,'/api/v1/image-studio/brief');assert.equal(calls[0].body.position,'before');assert.equal(calls[1].url,'/api/v1/image-studio/generations');assert.equal(calls[1].body.parent_version_id,null);assert.deepEqual(calls[1].body.size,{width:1600,height:900,aspect_ratio:'16:9'});assert.equal(calls.some(c=>c.url.includes('/asset-generations')),false);
});
test('跨会话刷新保留服务unknown的原job且0第二submit',async()=>{
  const f=fixture();const version={id:'unknown-version',slot_id:'s',asset_id:'',provider:'agy' as const,description:'未知旧输入',title:'未知旧图',requested:{width:1600,height:900},accepted:null,actual:{width:1600,height:900},mime:'',sha256:'',size_bytes:0,created_at:'t',job_id:'original-job',parent_version_id:null,reference_assets:[],actual_verified:false,state:'reconciling',warning:null,error:'结果待核对',accepted_parameters:null,document_revision_id:'revision',paragraph_id:'p1',placement:'after:p1',operation:'generate' as const};
  try{f.setSnapshot({...snapshot,slots:[{id:'s',title:'图',description:'说明',placement:'after:p1',adopted_version_id:null,versions:[version]}]});await f.controller.load();assert.match(f.controller.panel(),/data-job="original-job"/);await assert.rejects(f.controller.dispatch('studio-add',action('studio-add')),/不能再次提交/);assert.equal(f.submitted.length,0);assert.equal(f.internal.snapshot.slots[0].versions[0].job_id,'original-job');}finally{f.controller.dispose();}
});
test('Codex调画幅为新generate有旧版lineage；未验证reference_edit仍明确拒绝',()=>{
  const state={...snapshot,capabilities:[{...capability,provider:'codex' as const,reference_edit:false}]};
  const draft={...defaultStudioDraft('codex'),mode:'manual' as const,description:'调整为竖向说明',width:1080,height:1920,slot_id:'slot',parent_version_id:'real-original',paragraph_id:'p1',placement:'after:p2'};
  const input=studioGenerationInput(studioSubmit(state,draft));assert.equal(input.operation,'generate');assert.equal(input.parent_version_id,'real-original');assert.equal(input.placement_paragraph_id,'p2');
  assert.throws(()=>studioSubmit(state,{...draft,operation:'reference_edit'}),/原图修改尚未验证/);
});
test('未登记记录根或未逐图采用时禁止Wiki；模型成功不自动确认',async()=>{
  const f=fixture();try{await f.controller.load();assert.match(studioFinalConfirmationReason(snapshot),/路径待登记/);await f.controller.dispatch('studio-preview',action('studio-preview'));assert.match(f.dialogs.at(-1).foot,/studio-confirm-final[^>]*disabled/);await assert.rejects(f.controller.dispatch('studio-confirm-final',action('studio-confirm-final')),/路径待登记/);assert.equal(f.confirmed.length,0);const registered={...snapshot,recording:{process_record:'/synthetic-fixture/process.md',wiki_confirmation_required:true as const,wiki_record:null}};assert.match(studioFinalConfirmationReason(registered),/逐图采用/);}finally{f.controller.dispose();}
});
test('显式终稿动作冻结当前article/version；变稿不确认旧记录',async()=>{
  const version={id:'v',slot_id:'s',asset_id:'asset',provider:'agy' as const,description:'已采用',title:'图',requested:{width:1600,height:900},accepted:null,actual:{width:1024,height:1024},mime:'image/jpeg',sha256:'a'.repeat(64),size_bytes:10,created_at:'t',job_id:'job',parent_version_id:null,reference_assets:[],actual_verified:true,state:'succeeded',warning:null,error:null,accepted_parameters:null,document_revision_id:'revision',paragraph_id:'p1',placement:'after:p1',operation:'generate' as const};
  const registered={...snapshot,slots:[{id:'s',title:'图',description:'已采用',placement:'after:p1',adopted_version_id:'v',versions:[version]}],recording:{process_record:'/synthetic-fixture/process.md',wiki_confirmation_required:true as const,wiki_record:null}};
  const f=fixture();try{f.setSnapshot(registered);await f.controller.load();await f.controller.dispatch('studio-preview',action('studio-preview'));assert.equal(f.confirmed.length,0);await f.controller.dispatch('studio-confirm-final',action('studio-confirm-final'));assert.deepEqual(f.confirmed,[{topic_id:'topic',document_revision_id:'revision',expected_version:1,confirmed:true}]);assert.equal(f.submitted.length,0);}finally{f.controller.dispose();}
  const g=fixture();try{g.setSnapshot(registered);await g.controller.load();await g.controller.dispatch('studio-preview',action('studio-preview'));g.setLoad(async()=>({...registered,document_revision_id:'human-changed'}));await assert.rejects(g.controller.dispatch('studio-confirm-final',action('studio-confirm-final')),/重新预览后确认/);assert.equal(g.confirmed.length,0);}finally{g.controller.dispose();}
});
test('文字或数字blur不重建下一个控件，非法手动宽高即时禁止提交',async()=>{
  const f=fixture();try{await f.controller.dispatch('studio-add',action('studio-add'));f.form();await f.controller.dispatch('studio-manual',action('studio-manual'));const before=f.dialogs.length;f.fields.get('studio-title').value='真实可选标题';f.controller.handleInput({id:'studio-title'} as HTMLInputElement);f.controller.handleChange({id:'studio-title'} as HTMLInputElement);assert.equal(f.dialogs.length,before);assert.equal(f.internal.draft.title,'真实可选标题');f.fields.get('studio-width').value='0';f.controller.handleInput({id:'studio-width'} as HTMLInputElement);assert.equal(f.fields.get('studio-submit').disabled,true);assert.match(f.fields.get('studio-format-error').textContent,/正整数/);}finally{f.controller.dispose();}
});
test('正式上传回执asset_id与实际Assets行绑定，不能把undefined当参考图',async()=>{
  const port=imageStudioHttpPort(),row={id:'saved-reference',mime:'image/png',sha256:'a'.repeat(64),size_bytes:8,status:'ready'},receipt={asset_id:row.id,sha256:row.sha256,size_bytes:row.size_bytes,status:'ready'},calls:any[]=[];
  const c={signal:new AbortController().signal,client:{upload:async(path:string)=>{calls.push(path);return receipt;},request:async()=>({items:[row],next_cursor:null})}} as unknown as FeatureContext;
  const reference=await port.reference(new File(['fixture'],'original.png',{type:'image/png'}),'person','topic',c);assert.equal(reference.asset_id,'saved-reference');assert.equal(reference.name,'original.png');assert.equal(reference.purpose,'person');assert.deepEqual(calls,['/api/v1/assets']);
  (c.client as any).upload=async()=>({...receipt,asset_id:undefined});await assert.rejects(port.reference(new File(['x'],'bad.png'),'style','topic',c),/实际文件标识/);
});
test('终稿gate检查采用版本的文章head及未核对取消结果',()=>{
  const version={id:'v',slot_id:'s',asset_id:'asset',provider:'agy' as const,description:'图',title:'图',requested:{width:1600,height:900},accepted:null,actual:{width:1600,height:900},mime:'image/png',sha256:'a'.repeat(64),size_bytes:10,created_at:'t',job_id:'j',parent_version_id:null,reference_assets:[],actual_verified:true,state:'succeeded',warning:null,error:null,accepted_parameters:{structured_size_parameter:null},document_revision_id:'old-revision',paragraph_id:'p1',placement:'after:p1',operation:'generate' as const};
  const state={...snapshot,slots:[{id:'s',title:'图',description:'图',placement:'after:p1',adopted_version_id:'v',versions:[version]}],recording:{process_record:'/synthetic-fixture/process.md',wiki_confirmation_required:true as const,wiki_record:null}};
  assert.match(studioFinalConfirmationReason(state),/关联旧文章/);state.slots[0]!.versions[0]!.document_revision_id='revision';assert.equal(studioFinalConfirmationReason(state),'');
  state.slots[0]!.versions.push({...version,id:'cancelled',asset_id:'',actual_verified:false,state:'cancelled'});assert.match(studioFinalConfirmationReason(state),/待核对/);
});
test('完整8000字说明可以提交，UI数字提示与两字段边界一致',async()=>{
  const f=fixture();try{
    await f.controller.dispatch('studio-add',action('studio-add'));f.form();await f.controller.dispatch('studio-manual',action('studio-manual'));
    const description='说'.repeat(8000);f.fields.get('studio-description').value=description;f.controller.handleInput({id:'studio-description'} as HTMLInputElement);
    assert.equal(f.fields.get('studio-submit').disabled,false);assert.equal(f.fields.get('studio-brief').disabled,false);
    assert.match(f.fields.get('studio-prompt-budget').textContent,/画面说明 8000 \/ 8000 字/);assert.match(f.fields.get('studio-prompt-budget').textContent,/\/ 16000 字/);assert.equal(f.fields.get('studio-prompt-error').textContent,'');
    assert.doesNotMatch(f.dialogs.at(-1).body, /id="studio-description"[^>]*maxlength/);
    assert.equal(studioSubmit(snapshot,f.internal.draft).description,description);
    const original='  完整说明原文\n  ';assert.equal(studioSubmit(snapshot,{...f.internal.draft,description:original}).description,original);
  }finally{f.controller.dispose();}
});
test('超过说明边界保留原文并禁生成与分析，程序动作也0调用',async()=>{
  const f=fixture();let analyses=0;try{
    await f.controller.dispatch('studio-add',action('studio-add'));f.form();await f.controller.dispatch('studio-manual',action('studio-manual'));f.setBrief(async()=>{analyses++;return brief;});
    const description='说'.repeat(8001);f.fields.get('studio-description').value=description;f.controller.handleInput({id:'studio-description'} as HTMLInputElement);
    assert.equal(f.internal.draft.description,description);assert.equal(f.fields.get('studio-description').value,description);assert.equal(f.fields.get('studio-submit').disabled,true);assert.equal(f.fields.get('studio-brief').disabled,true);assert.match(f.fields.get('studio-prompt-error').textContent,/当前 8001 字/);
    await assert.rejects(f.controller.dispatch('studio-brief',action('studio-brief')),/画面说明最多 8000 字/);await assert.rejects(f.controller.dispatch('studio-submit',action('studio-submit')),/画面说明最多 8000 字/);assert.equal(analyses,0);assert.equal(f.submitted.length,0);
  }finally{f.controller.dispose();}
});
test('过长选段的组合上下文提交前拒绝，修改说明与手动尺寸保留',async()=>{
  const f=fixture();let analyses=0;try{
    f.setSnapshot({...snapshot,paragraphs:[{id:'p1',label:'长段落',text:'段'.repeat(8000)}]});await f.controller.dispatch('studio-add',action('studio-add'));f.form();await f.controller.dispatch('studio-manual',action('studio-manual'));f.setBrief(async()=>{analyses++;return brief;});f.controller.handleInput({id:'studio-description'} as HTMLInputElement);
    assert.equal(f.fields.get('studio-submit').disabled,true);assert.equal(f.fields.get('studio-brief').disabled,true);assert.match(f.fields.get('studio-prompt-error').textContent,/关联段落、标题、品牌与旧版说明/);assert.equal(f.internal.draft.description,'真实说明');assert.deepEqual([f.internal.draft.width,f.internal.draft.height],[1600,900]);
    await assert.rejects(f.controller.dispatch('studio-brief',action('studio-brief')),/合计最多 8000 字/);await assert.rejects(f.controller.dispatch('studio-submit',action('studio-submit')),/合计最多 8000 字/);assert.equal(analyses,0);assert.equal(f.submitted.length,0);
  }finally{f.controller.dispose();}
});
test('8000字成功旧图完整上下文超限时，调尺寸清楚拒绝且旧版保留',()=>{
  const old={id:'old',slot_id:'s',asset_id:'saved-asset',provider:'agy' as const,description:'原'.repeat(8000),title:'旧图',requested:{width:1600,height:900},accepted:null,actual:{width:1600,height:900},mime:'image/png',sha256:'a'.repeat(64),size_bytes:10,created_at:'t',job_id:'job',parent_version_id:null,reference_assets:[],actual_verified:true,state:'succeeded',warning:null,error:null,accepted_parameters:null,document_revision_id:'revision',paragraph_id:'p1',placement:'after:p1',operation:'generate' as const};
  const state={...snapshot,slots:[{id:'s',title:'图',description:old.description,placement:'after:p1',adopted_version_id:'old',versions:[old]}]},draft={...defaultStudioDraft('agy'),slot_id:'s',parent_version_id:'old',paragraph_id:'p1',description:'新的短说明',mode:'manual' as const,width:1080,height:1920};
  assert.match(studioDraftPromptBudget(state,draft).error,/关联段落、标题、品牌与旧版说明合计最多 8000 字/);assert.throws(()=>studioSubmit(state,draft),/选较短段落或新建配图/);assert.equal(state.slots[0]!.versions[0]!.description.length,8000);assert.equal(draft.description,'新的短说明');assert.equal(draft.width,1080);
});
test('画幅选项文案与原型一致：横图/方图/竖图/长图', async ()=>{
 const {studioRatioLabel}=await import('../../apps/web/src/features/media/image-studio/model.ts');
 assert.deepEqual(['16:9','4:3','1:1','3:4','9:16','2:5'].map(studioRatioLabel),['横图 · 16:9','横图 · 4:3','方图 · 1:1','竖图 · 3:4','竖图 · 9:16','长图 · 2:5']);
});
test('公众号平台隐藏通用图像任务入口，其他平台保持可见', async ()=>{
 const {hideGenericImageEntry}=await import('../../apps/web/src/features/media/image-studio/index.ts');
 const classes=new Set<string>(),entry={hidden:false},panel={classList:{toggle:(name:string,on:boolean)=>{if(on)classes.add(name);else classes.delete(name);}}};
 const root={querySelector:(selector:string)=>selector==='.image-generation-panel'?panel:selector==='[data-action="image-task"]'?entry:null} as unknown as ParentNode;
 hideGenericImageEntry(root,'wechat');assert.equal(entry.hidden,true);assert.ok(classes.has('wechat-studio-entry'),'面板重绘后仍由 class 隐藏');
 for(const platform of ['xiaohongshu','x','douyin','bilibili']){hideGenericImageEntry(root,platform);assert.equal(entry.hidden,false,platform);assert.equal(classes.has('wechat-studio-entry'),false,platform);}
 assert.doesNotThrow(()=>hideGenericImageEntry({querySelector:()=>null} as unknown as ParentNode,'wechat'),'面板未挂载时不报错');
});
test('legacy panel: 生成 opens the shared 确认生成 first (channel, model, count); nothing is submitted until confirmed; 返回修改 keeps the form',async()=>{
  const f=fixture();try{await f.controller.dispatch('studio-add',action('studio-add'));f.form();f.internal.draft.mode='manual';const formTitle=f.dialogs.at(-1).title;
    await f.controller.dispatch('studio-submit',action('studio-submit'));assert.equal(f.submitted.length,0,'点生成不直接提交');const d=f.dialogs.at(-1);
    assert.equal(d.title,'公众号配图 · 确认生成');assert.match(d.body,/<dt>生成渠道<\/dt><dd>AGY 生图<\/dd>/);assert.match(d.body,/<dt>生图模型<\/dt>/);assert.match(d.body,/<dt>张数<\/dt><dd>1 张<\/dd>/);assert.match(d.foot,/data-action="studio-submit-confirm"[^>]*disabled data-arming="arm-\d+"/,'确认按钮先冷却');
    await f.controller.dispatch('studio-submit-back',action('studio-submit-back'));assert.equal(f.dialogs.at(-1).title,formTitle,'返回原表单');assert.equal(f.internal.draft.description,'真实说明');assert.equal(f.submitted.length,0);
    await f.controller.dispatch('studio-submit-confirm',action('studio-submit-confirm'));assert.equal(f.submitted.length,0,'没有打开的确认时，确认动作不提交');
    await f.controller.dispatch('studio-submit',action('studio-submit'));await f.controller.dispatch('studio-submit-confirm',action('studio-submit-confirm'));assert.equal(f.submitted.length,1,'确认后才提交');
  }finally{f.controller.dispose();}
});

test('legacy panel: when the live re-read fails on 确认生成, the confirmation stays usable — retry works and 返回修改 still returns to the form',async()=>{
  const f=fixture();try{await f.controller.dispatch('studio-add',action('studio-add'));f.form();f.internal.draft.mode='manual';const formTitle=f.dialogs.at(-1).title;
    await f.controller.dispatch('studio-submit',action('studio-submit'));f.setLoad(async()=>{throw new Error('网络断开');});
    await assert.rejects(f.controller.dispatch('studio-submit-confirm',action('studio-submit-confirm')),/暂时无法确认最新状态（网络断开），可以重试，或返回修改/);
    assert.equal(f.internal.busy,false,'失败后不再锁住');assert.equal(f.submitted.length,0);assert.ok(f.internal.submitConfirm,'确认仍然有效');
    f.setLoad(async()=>structuredClone(snapshot));await f.controller.dispatch('studio-submit-confirm',action('studio-submit-confirm'));assert.equal(f.submitted.length,1,'重试成功提交');
    const g=fixture();try{await g.controller.dispatch('studio-add',action('studio-add'));g.form();g.internal.draft.mode='manual';await g.controller.dispatch('studio-submit',action('studio-submit'));g.setLoad(async()=>{throw new Error('网络断开');});
      await assert.rejects(g.controller.dispatch('studio-submit-confirm',action('studio-submit-confirm')),/无法确认最新状态/);await g.controller.dispatch('studio-submit-back',action('studio-submit-back'));assert.equal(g.dialogs.at(-1).title,formTitle,'返回修改可用');assert.equal(g.submitted.length,0);
    }finally{g.controller.dispose();}
  }finally{f.controller.dispose();}
});
