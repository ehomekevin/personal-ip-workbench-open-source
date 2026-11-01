// 公众号排版 C1 界面投影：大纲名称与说明不露块 ID/哈希；上下移只换显示顺序；版本列表最多 40 个且标出当前；配图同步提示与错误文案。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createArticleLayout,currentArticleBinding,editArticleText,replaceArticleImages,reorderArticleBlocks,updateArticleImageWidth} from '../../packages/domain/src/article-layout/index.ts';
import type {LayoutCheckResult} from '../../packages/contracts/src/article-layout.ts';
import {layoutBlocks,layoutVersions,moveBlock,imageSyncCopy,layoutErrorCopy,visualResultView,LAYOUT_VERSION_LIMIT,SAVE_LABEL} from '../../apps/web/src/features/media/article-layout/c1-model.ts';
const hash='a'.repeat(64),image=(id:string)=>({id,image:{asset_id:'asset-'+id,version_id:'v-'+id,sha256:hash,url:'/api/v1/assets/asset-'+id+'/content',pixel_width:1600,pixel_height:900,source_sha256:hash},caption:'图注 '+id,anchor_block_id:null,position:'before' as const});
function fixture(){let s=createArticleLayout({article_id:'wechat-layout:t',document_id:'d',document_revision_id:'r',text:'# 标题\n\n第一段正文\n\n第二段正文'});const [title,p1]=s.order;s=replaceArticleImages(s,[{...image('cover'),anchor_block_id:title!,position:'after'},{...image('body'),anchor_block_id:p1!,position:'after'}]);return s;}
function visualFixture(){
 const snapshot=fixture();snapshot.active_render={snapshot_sha256:'b'.repeat(64),block_structure_sha256:'c'.repeat(64)};
 const p1=snapshot.order[2]!,p2=snapshot.order[4]!,picture=snapshot.order[3]!;
 const result:LayoutCheckResult={binding:{...currentArticleBinding(snapshot),render_snapshot_sha256:snapshot.active_render.snapshot_sha256,block_structure_sha256:snapshot.active_render.block_structure_sha256},verdict:'issues',issues:[{id:'issue-1',block_id:p1,location:'正文 '+p1+'；另见 '+picture,category:'color',problem:'computed_style.color 为 #777777，宽 358px；'+p2,standard_ref:'standard_html 与标准 PNG',suggestion:'仅在完整发布版使用500字重；不新增正文，保留36px条件。',uncertainty:'computed_style.font_weight 尚未核实；不能据此认定passed。'}],uncertainties:['computed_style.image_rendered_width 为358px；图像不裁剪。']};
 return{snapshot,result,p1,p2,picture};
}
test('outline names blocks in reading order without exposing internal ids',()=>{
 const s=fixture(),blocks=layoutBlocks(s);
 assert.deepEqual(blocks.map(b=>b.name),['文章标题','封面','正文 · 1','配图 1','正文 · 2']);
 assert.equal(blocks[1]!.meta,'1600 × 900 · 显示 100%');assert.equal(blocks[2]!.meta,'原文 · 可直接编辑');
 const edited=layoutBlocks(editArticleText(s,s.order[2]!,'改过的第一段'));assert.equal(edited[2]!.meta,'已修改 · 可直接编辑');
 const text=JSON.stringify(blocks.map(({id:_id,image:_image,...rest})=>rest));assert.doesNotMatch(text,/[0-9a-f]{24}|text-|image-|asset-/,'大纲文案不带块 ID、资产或哈希');
 assert.equal(blocks[0]!.canMoveUp,false);assert.equal(blocks.at(-1)!.canMoveDown,false);
});
test('visual result uses reading-order names and exact rendering labels while preserving the entire immutable input',()=>{
 const {snapshot,result,p1,picture}=visualFixture(),before={snapshot:structuredClone(snapshot),result:structuredClone(result)};
 const freeze=(value:object):void=>{for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);Object.freeze(value);};freeze(snapshot);freeze(result);
 const view=visualResultView(snapshot,result,true);
 assert.equal(view.current,true);assert.equal(view.verdict,'issues');assert.equal(view.issues.length,1);assert.equal(view.issues[0]!.location,'正文 正文 · 1；另见 配图 1');
 assert.equal(view.issues[0]!.problem,'实际文字颜色 为 #777777，宽 358px；正文 · 2');assert.equal(view.issues[0]!.standard_ref,'标准 HTML 与标准 PNG');
 assert.equal(view.issues[0]!.suggestion,result.issues[0]!.suggestion);assert.equal(view.issues[0]!.uncertainty,'实际字重 尚未核实；不能据此认定passed。');assert.deepEqual(view.uncertainties,['实际图片显示宽度 为358px；图像不裁剪。']);
 assert.deepEqual(view.issues[0]!.target,{id:p1,name:'正文 · 1'});assert.equal(view.issues[0]!.block_id,p1);assert.notEqual(view.issues[0]!.target?.id,picture,'prose references do not choose the jump');
 assert.deepEqual(snapshot,before.snapshot);assert.deepEqual(result,before.result);assert.notEqual(view.issues,result.issues);assert.notEqual(view.uncertainties,result.uncertainties);
});
test('visual display replaces complete tokens only and leaves URLs, HTML attributes, similar IDs and unrelated words intact',()=>{
 const {snapshot,result,p1}=visualFixture(),unknown='image-'+'f'.repeat(24);
 const untouched=['prefix'+p1,p1+'-suffix',p1+'a',p1+'.suffix',p1+'1',p1+'_suffix','computed_style.font_weight_extra','computed_style.unknown','recomputed_style','image-rendered-width','constructor','toString','__proto__',`https://example.test/${p1}?field=computed_style.font_weight`,`mailto:${p1}@example.test?subject=computed_style`,`urn:example:${p1}:computed_style`,`custom:${p1}?field=computed_style`,`https:example.test/${p1}`,`/assets/${p1}.png`,`<a href="https://example.test/${p1}" data-field="computed_style">`];
 result.issues[0]!.problem=[...untouched,'('+p1+')','['+unknown+']',p1+'.','computed_style.font_weight.','font-weight:400','computed_style.font_weight:500','color:blue'].join(' | ');
 const output=visualResultView(snapshot,result,true).issues[0]!.problem;
 for(const value of untouched)assert.ok(output.includes(value),'ordinary text preserved: '+value);
 assert.ok(output.includes('(正文 · 1)'));assert.ok(output.includes('[报告提及的图文块（当前无法定位）]'));assert.ok(output.includes('正文 · 1.'));assert.ok(output.includes('实际字重.'));assert.ok(output.includes('字重:400'));assert.ok(output.includes('实际字重:500'));assert.ok(output.includes('color:blue'));
 assert.equal(result.issues[0]!.problem,[...untouched,'('+p1+')','['+unknown+']',p1+'.','computed_style.font_weight.','font-weight:400','computed_style.font_weight:500','color:blue'].join(' | '));
});
test('quoted HTML attribute values keep literal greater-than signs, field keys and known IDs unchanged',()=>{
 const {snapshot,result,p1,picture}=visualFixture();
 const doubleQuoted=`<a title="x > computed_style" data-id="${p1}">`,singleQuoted=`<span title='x > computed_style.font_weight' data-id='${picture}'>`;
 result.issues[0]!.location=doubleQuoted+'链接</a>；'+singleQuoted+'说明</span>；'+p1;
 const before={snapshot:structuredClone(snapshot),result:structuredClone(result)},view=visualResultView(snapshot,result,true);
 assert.equal(view.issues[0]!.location,doubleQuoted+'链接</a>；'+singleQuoted+'说明</span>；正文 · 1','valid quoted > must not end protected HTML attributes early; normal prose after the closing tag still maps');
 assert.deepEqual(snapshot,before.snapshot);assert.deepEqual(result,before.result);
});
test('continuous CSS declarations translate every complete known field and retain literal separators and values',()=>{
 const {snapshot,result}=visualFixture();
 const pairs=[['font-weight','900','字重'],['font-size','18px','字号'],['font-family','DingTalk','字体'],['line-height','1.5','行高'],['letter-spacing','0.5px','字距'],['background-color','#F4F5FC','背景色'],['text-align','center','对齐方式'],['margin-bottom','20px','下边距'],['padding-top','36px','上内边距'],['white-space','pre-wrap','换行方式'],['image_natural_width','1086','图片原始宽度'],['image_natural_height','1448','图片原始高度'],['image_rendered_width','358px','图片显示宽度'],['image_rendered_height','477.33px','图片显示高度'],['computed_style.color','#4B5783','实际文字颜色']];
 for(const separator of ['、',',',';','；',', ','、 ']){
  result.issues[0]!.standard_ref=pairs.map(([key,value])=>key+':'+value).join(separator);const before=structuredClone(result);
  assert.equal(visualResultView(snapshot,result,true).issues[0]!.standard_ref,pairs.map(([,value,label])=>label+':'+value).join(separator),separator);
  assert.equal(visualResultView(snapshot,result,false).issues[0]!.standard_ref,pairs.map(([,value,label])=>label+':'+value).join(separator),'historical '+separator);assert.deepEqual(result,before);
 }
 result.issues[0]!.standard_ref='font-weight:900、font-size:18px';assert.equal(visualResultView(snapshot,result,true).issues[0]!.standard_ref,'字重:900、字号:18px','literal captured deviation standard reference');
});
test('CSS quoted/function/URL values remain opaque while following declarations are readable',()=>{
 const {snapshot,result,p1}=visualFixture();
 const pairs=[
  ['font-family:"font-size:18px,font-weight:900";font-size:20px','字体:"font-size:18px,font-weight:900";字号:20px'],
  ["font-family:'font-size:18px、computed_style';font-size:20px","字体:'font-size:18px、computed_style';字号:20px"],
  ['background-color:rgba(1, 2, 3, 0.5),font-weight:900','背景色:rgba(1, 2, 3, 0.5),字重:900'],
  ['font-family:url("https://example.test/font-size:18px,font-weight:900");font-size:20px','字体:url("https://example.test/font-size:18px,font-weight:900");字号:20px'],
  ['font-family:Noto Sans SC, computed_style; font-size:18px','字体:Noto Sans SC, computed_style; 字号:18px'],
  ['font-size:18px;--unknown:"font-weight:900";line-height:1.8','字号:18px;--unknown:"font-weight:900";行高:1.8'],
  ['--tokens:0 computed_style;font-size:18px','--tokens:0 computed_style;字号:18px'],
  ['line-height:27px/15px,font-size:18px','行高:27px/15px,字号:18px'],
  ['font-size:clamp(12px, calc(100% / 2), 18px)、font-weight:900','字号:clamp(12px, calc(100% / 2), 18px)、字重:900'],
  ['--tokens:0 font-weight:900;font-size:18px','--tokens:0 font-weight:900;字号:18px'],
  ['--tokens:{font-size:18px;font-weight:900};font-size:20px','--tokens:{font-size:18px;font-weight:900};字号:20px'],
  ['27px/15px;font-size:18px','27px/15px;字号:18px'],
  ['assets/font-size:18px,font-weight:900','assets/font-size:18px,font-weight:900'],
  ['--tokens:0 | font-weight:900\ncomputed_style;font-size:18px','--tokens:0 | font-weight:900\ncomputed_style;字号:18px'],
 ];
 const protectedText=[`https://example.test/${p1}?css=font-weight:900,font-size:18px`,`mailto:${p1}@example.test?subject=font-weight:900、font-size:18px`,`urn:example:font-size:18px,font-weight:900`,`custom:font-weight:900;font-size:18px`,`/assets/font-weight:900,font-size:18px`,`<a title="x > font-weight:900,font-size:18px" data-id="${p1}">`];
 for(const [input,expected]of [...pairs,...protectedText.map(text=>[text,text])]){result.issues[0]!.problem=input!;const before=structuredClone(result);assert.equal(visualResultView(snapshot,result,true).issues[0]!.problem,expected);assert.deepEqual(result,before);}
 result.issues[0]!.problem='font-weight-extra:900、font-size-extra:18px';assert.equal(visualResultView(snapshot,result,true).issues[0]!.problem,result.issues[0]!.problem,'unknown keys are not guessed');
});
test('complete known kind descriptions retain real scope, counts and current versus historical target rules',()=>{
 const {snapshot,result,p1,p2}=visualFixture();result.issues[0]!.block_id=null;
 result.issues[0]!.location='__topic_title__、两个 kind=heading 块及全部13个 kind=paragraph 块';
 result.issues[0]!.problem='全部13个 kind=paragraph 块，首块 '+p1+'，末块 '+p2;
 const kinds=['title','lead','heading','paragraph','opinion','image','divider','follow'],labels=['文章标题','导读','小节标题','正文','我的看法','配图','分隔','关注卡'];
 result.issues[0]!.standard_ref=kinds.map(k=>'[kind='+k+']').join('、');result.issues[0]!.suggestion='仅在完整发布稿使用 kind = heading；保留36px、#0B1F52与原有13段。';result.issues[0]!.uncertainty='kind=paragraph 是否适用仍待确认。';result.uncertainties=['(kind=heading).'];const before=structuredClone({snapshot,result});
 for(const current of [true,false]){const view=visualResultView(snapshot,result,current),issue=view.issues[0]!;assert.equal(issue.location,'文章标题、两个 小节标题 块及全部13个 正文 块');assert.equal(issue.problem,current?'全部13个 正文 块，首块 正文 · 1，末块 正文 · 2':'全部13个 正文 块，首块 检查时的图文块（旧版），末块 检查时的图文块（旧版）');assert.equal(issue.standard_ref,labels.map(k=>'['+k+']').join('、'));assert.equal(issue.suggestion,'仅在完整发布稿使用 小节标题；保留36px、#0B1F52与原有13段。');assert.equal(issue.uncertainty,'正文 是否适用仍待确认。');assert.deepEqual(view.uncertainties,['(小节标题).']);assert.equal(issue.target,null);assert.equal(view.verdict,'issues');}
 assert.deepEqual({snapshot,result},before);
});
test('kind markers require exact known identity boundaries and never replace ordinary or similar words',()=>{
 const {snapshot,result}=visualFixture();const untouched=['heading paragraph','unkind=heading','kindness=paragraph','x.kind=heading','kind=heading_extra','kind=heading-suffix','kind=heading.suffix','kind=paragraph2','kind=unknown','kind=constructor','kind=__proto__','KIND=heading','kind=Heading','kind=heading/file.png','kind=heading:foo','kind=heading?mode=paragraph','kind=paragraph=extra'];
 result.issues[0]!.problem=untouched.join(' | ')+' | kind=heading. | 【kind=paragraph】';const view=visualResultView(snapshot,result,true);assert.equal(view.issues[0]!.problem,untouched.join(' | ')+' | 小节标题. | 【正文】');
});
test('kind fragments remain opaque inside URI, paths, quoted HTML and complete CSS values',()=>{
 const {snapshot,result}=visualFixture();const opaque=['https://example.test/kind=heading?q=kind=paragraph','mailto:user@example.test?subject=kind=heading;kind=paragraph','custom:kind=heading;kind=paragraph','custom:kind=heading;font-size:18px','mailto:user@example.test?subject=kind=heading;font-weight:900','mailto:kind=heading@example.test','urn:example:kind=paragraph','/assets/kind=heading.png','./kind=heading','../kind=paragraph','assets/kind=heading','<a title="x > kind=heading" data-kind="kind=paragraph">',"<span title='x > kind=paragraph'>",'font-family:kind=heading','font-family:Noto kind=paragraph Sans SC','font-family:"kind=heading"','font-size:calc(kind=heading + 18px)','background-color:var(--kind=heading)','--tokens:0 kind=paragraph | kind=heading\nopaque','content: "kind=heading"','background-image: url("kind=paragraph")','content: attr(kind=heading)','background-image: none kind=paragraph','content: open-quote "kind=heading" close-quote','list-style: outside url("kind=heading")','content: attr(data-x) "kind=paragraph"','content:open-quote "kind=heading" close-quote','background-image:url(kind=heading) url(kind=paragraph)','background:linear-gradient(red, kind=paragraph)'];
 for(const text of opaque){const expected=text.startsWith('font-family:')?'字体:'+text.slice(12):text.startsWith('font-size:')?'字号:'+text.slice(10):text.startsWith('background-color:')?'背景色:'+text.slice(17):text;result.issues[0]!.problem=text+'; kind=heading';const before=structuredClone(result);assert.equal(visualResultView(snapshot,result,true).issues[0]!.problem,expected+'; 小节标题',text);assert.deepEqual(result,before);}
});
test('all render/article/standard binding mismatches and historical results refuse current names and jumps',()=>{
 const {snapshot,result}=visualFixture();
 for(const key of Object.keys(result.binding) as Array<keyof LayoutCheckResult['binding']>){
  const changed=structuredClone(result);changed.binding[key]=key.endsWith('sha256')||key.endsWith('hash')?'f'.repeat(64):'different-'+key;
  const view=visualResultView(snapshot,changed,true);assert.equal(view.current,false,key);assert.equal(view.issues[0]!.target,null,key);assert.ok(view.issues[0]!.location.includes('检查时的图文块（旧版）'),key);assert.ok(!view.issues[0]!.location.includes('正文 · 1'),key);
 }
 const serverStale=visualResultView(snapshot,result,false);assert.equal(serverStale.current,false);assert.equal(serverStale.issues[0]!.target,null);
 const reordered=reorderArticleBlocks(snapshot,[...snapshot.order].reverse());assert.equal(visualResultView(reordered,result,true).current,false,'new display order cannot borrow old check ordinals');
 const noRender=structuredClone(snapshot);noRender.active_render=null;assert.equal(visualResultView(noRender,result,true).current,false);
});
test('structured unknown, absent and synthetic title targets never acquire a jump from known IDs in prose',()=>{
 const {snapshot,result,p1,picture}=visualFixture();
 result.issues=[
  {...result.issues[0]!,id:'unknown',block_id:'image-'+'f'.repeat(24),location:p1+'与'+picture},
  {...result.issues[0]!,id:'missing',block_id:null,location:p1},
  {...result.issues[0]!,id:'topic',block_id:'__topic_title__',location:'__topic_title__；'+p1},
 ];
 const view=visualResultView(snapshot,result,true);assert.deepEqual(view.issues.map(i=>i.id),['unknown','missing','topic']);assert.deepEqual(view.issues.map(i=>i.target),[null,null,null]);
 assert.equal(view.issues[0]!.location,'正文 · 1与配图 1');assert.match(view.issues[0]!.location_note!,/当前无法定位/);assert.match(view.issues[1]!.location_note!,/未提供具体/);assert.equal(view.issues[2]!.location,'文章标题；正文 · 1');assert.equal(view.issues[2]!.location_note,null);assert.ok(!snapshot.blocks.some(b=>b.id==='__topic_title__'));
});
test('move swaps only neighbours in display order; edges are no-ops',()=>{
 assert.deepEqual(moveBlock(['a','b','c'],'b',-1),['b','a','c']);assert.deepEqual(moveBlock(['a','b','c'],'b',1),['a','c','b']);assert.deepEqual(moveBlock(['a','b'],'a',-1),['a','b']);assert.deepEqual(moveBlock(['a','b'],'x',1),['a','b']);
});
test('version list merges text and layout versions, newest first, at most 40, current marked',()=>{
 let s=fixture();const p1=s.order[2]!,img=s.order[3]!;let tick=Date.parse('2099-01-01T00:00:00Z');const options=()=>({now:()=>new Date(tick+=1000).toISOString()});
 for(let i=0;i<30;i++){s=editArticleText(s,p1,'第 '+i+' 次修改',options());s=updateArticleImageWidth(s,img,i%2?50:75,options());}
 s=reorderArticleBlocks(s,[...s.order].reverse(),options());
 const list=layoutVersions(s);assert.equal(list.length,LAYOUT_VERSION_LIMIT);assert.equal(list[0]!.label,'调整图文顺序');assert.equal(list[0]!.current,true);
 assert.equal(list.filter(v=>v.current).length,2,'文字与排版各一个当前版本');assert.ok(list.some(v=>v.label==='修改文字'&&v.scope==='文字'));assert.ok(list.some(v=>v.label==='调整图片宽度'&&v.scope==='排版'));
 for(let i=1;i<list.length;i++)assert.ok(list[i-1]!.at>=list[i]!.at,'按时间倒序');
});
test('image sync copy and error copy speak user language',()=>{
 assert.equal(imageSyncCopy('synced'),null);assert.equal(imageSyncCopy('final_updated')!.action,'resync');assert.match(imageSyncCopy('final_updated')!.text,/配图已更新/);assert.equal(imageSyncCopy('plan_changed')!.action,'back');
 assert.equal(layoutErrorCopy({response:{error:{code:'VALIDATION_ERROR',message:'还没有确认配图，先在配图里确认'}}}),'还没有确认配图，先在配图里确认');
 assert.equal(layoutErrorCopy(new Error('ARTICLE_LAYOUT_SAVE_FENCE')),'排版暂时读不到，请稍后重试');assert.equal(layoutErrorCopy({response:{error:{message:'job 0a1b2c3d-1111-2222'}}}),'排版暂时读不到，请稍后重试');
 assert.equal(SAVE_LABEL.conflict,'别处有新版本 · 修改已保留');
});
test('a late save receipt from a closed editor never clears the newer editor\'s unsaved local copy',async()=>{
 const {ArticleLayoutController}=await import('../../apps/web/src/features/media/article-layout/controller.ts');
 const store=new Map<string,string>(),cache={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}};
 let server=fixture();server.version=1;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let held=true;
 const port={load:async()=>structuredClone(server),save:async(input:{expected_version:number;snapshot:typeof server})=>{if(held)await gate;if(input.expected_version!==server.version)return{state:'conflict' as const,current:structuredClone(server),local:input.snapshot,reason:'x'};server={...structuredClone(input.snapshot),version:server.version+1};return{state:'saved' as const,snapshot:structuredClone(server)};}};
 const identity={workspace_id:'w',service_instance_id:'s'},p1=server.order[2]!;
 const a=new ArticleLayoutController(structuredClone(server),port,cache,identity);a.editText(p1,'旧编辑器的修改');const pending=a.flush();await new Promise(r=>setImmediate(r));a.dispose();
 const b=new ArticleLayoutController(structuredClone(server),port,cache,identity);held=false;b.editText(p1,'新编辑器还没保存的修改');
 const before=[...store.values()].at(-1)!;assert.match(before,/新编辑器还没保存的修改/);
 release();await pending;assert.equal(store.size,1,'旧回执不删新缓存');assert.match([...store.values()][0]!,/新编辑器还没保存的修改/);
 b.dispose();
});
test('re-sync keeps width and position of existing image blocks, removes dropped ones and inserts new ones at their anchors',()=>{
 let s=fixture();const [title,cover,p1,body,p2]=s.order;s=updateArticleImageWidth(s,body!,50);s=reorderArticleBlocks(s,[title!,cover!,body!,p1!,p2!]);
 const next=replaceArticleImages(s,[{...image('body'),id:body!,image:{...image('body').image,version_id:'v-new'},caption:'新图注'},{...image('new'),anchor_block_id:p2!,position:'after'}]);
 assert.deepEqual(next.order,[title,body,p1,p2,'new'],'封面被移除，正文图保持用户位置，新图在锚点之后');
 const kept=next.blocks.find(b=>b.id===body)! as {display_width_percent:number;caption:string;image:{version_id:string}};assert.equal(kept.display_width_percent,50);assert.equal(kept.image.version_id,'v-new');assert.equal(kept.caption,'新图注');
});
test('leaving sends unsaved edits right away; reopening with a recovered unsaved copy keeps saving it',async()=>{
 const {ArticleLayoutController}=await import('../../apps/web/src/features/media/article-layout/controller.ts');
 const store=new Map<string,string>(),cache={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}};
 let server=fixture();server.version=1;let offline=false;const saves:string[]=[];
 const port={load:async()=>structuredClone(server),save:async(input:{expected_version:number;snapshot:typeof server;idempotency_key:string})=>{saves.push(input.idempotency_key);if(offline)throw new Error('网络断开');if(input.expected_version!==server.version)return{state:'conflict' as const,current:structuredClone(server),local:input.snapshot,reason:'x'};server={...structuredClone(input.snapshot),version:server.version+1};return{state:'saved' as const,snapshot:structuredClone(server)};}};
 const identity={workspace_id:'w',service_instance_id:'s'},p1=server.order[2]!;const text=(s:typeof server)=>(s.blocks.find(b=>b.id===p1) as {text:string}).text;
 const a=new ArticleLayoutController(structuredClone(server),port,cache,identity);a.editText(p1,'离开前改的');await a.leave();
 assert.equal(saves.length,1,'离开时立刻保存，不等 1 秒');assert.equal(text(server),'离开前改的');assert.equal(store.size,0);
 offline=true;const b=new ArticleLayoutController(structuredClone(server),port,cache,identity);b.editText(p1,'断网时改的');await b.leave();assert.equal(store.size,1,'没存上的修改留在本机');
 offline=false;const c=new ArticleLayoutController(structuredClone(server),port,cache,identity);assert.equal(c.state().status,'dirty');await c.resume();
 assert.equal(c.state().status,'saved');assert.equal(text(server),'断网时改的');assert.equal(saves.at(-1),saves.at(-2),'沿用原保存身份重发');assert.equal(store.size,0);c.dispose();
});
test('each browser tab keeps its own unsaved copy; another tab\'s unsaved edits are reported, not overwritten',async()=>{
 const {ArticleLayoutController}=await import('../../apps/web/src/features/media/article-layout/controller.ts');
 const store=new Map<string,string>(),cache={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}};
 const server=fixture();server.version=1;const port={load:async()=>structuredClone(server),save:async()=>{throw new Error('离线');}};const p1=server.order[2]!;
 const id=(tab:string)=>({workspace_id:'w',service_instance_id:'s',tab_id:tab});const text=(c:{state():{snapshot:typeof server}})=>(c.state().snapshot.blocks.find(b=>b.id===p1) as {text:string}).text;
 const a=new ArticleLayoutController(structuredClone(server),port,cache,id('A'));assert.equal(a.state().foreign,false);a.editText(p1,'窗口 A 的修改');
 const b=new ArticleLayoutController(structuredClone(server),port,cache,id('B'));assert.equal(b.state().foreign,true,'提示另一窗口有未保存修改');b.editText(p1,'窗口 B 的修改');
 a.dispose();b.dispose();
 const a2=new ArticleLayoutController(structuredClone(server),port,cache,id('A')),b2=new ArticleLayoutController(structuredClone(server),port,cache,id('B'));
 assert.equal(text(a2),'窗口 A 的修改','刷新 A 恢复 A 自己的草稿');assert.equal(text(b2),'窗口 B 的修改','B 的离线修改没被 A 覆盖');assert.equal(a2.state().foreign,true);a2.dispose();b2.dispose();
});
test('leaving while a save is in flight drains the queue: edits made during the save are submitted, later input is ignored',async()=>{
 const {ArticleLayoutController}=await import('../../apps/web/src/features/media/article-layout/controller.ts');
 const store=new Map<string,string>(),cache={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}};
 let server=fixture();server.version=1;let release!:()=>void;let gate:Promise<void>|null=new Promise<void>(r=>{release=r;});const saved:string[]=[];const p1=server.order[2]!;
 const text=(s:typeof server)=>(s.blocks.find(b=>b.id===p1) as {text:string}).text;
 const port={load:async()=>structuredClone(server),save:async(input:{expected_version:number;snapshot:typeof server})=>{if(gate){const g=gate;gate=null;await g;}if(input.expected_version!==server.version)return{state:'conflict' as const,current:structuredClone(server),local:input.snapshot,reason:'x'};server={...structuredClone(input.snapshot),version:server.version+1};saved.push(text(server));return{state:'saved' as const,snapshot:structuredClone(server)};}};
 const c=new ArticleLayoutController(structuredClone(server),port,cache,{workspace_id:'w',service_instance_id:'s',tab_id:'T'});
 c.editText(p1,'第一次');const first=c.flush();await new Promise(r=>setImmediate(r));c.editText(p1,'保存中又改');
 const leaving=c.leave();c.editText(p1,'离开后的输入');release();await leaving;await first;
 assert.deepEqual(saved,['第一次','保存中又改'],'排空：保存中的修改再提交一次');assert.equal(text(server),'保存中又改','离开后的输入不接受');assert.equal(store.size,0,'全部存上后本地缓存清空');
});

test('known kind descriptions accept fullwidth colon and separated question punctuation in all report fields',()=>{
 const {snapshot,result}=visualFixture(),fields=['location','problem','standard_ref','suggestion','uncertainty'] as const;
 const labels={title:'文章标题',lead:'导读',heading:'小节标题',paragraph:'正文',opinion:'我的看法',image:'配图',divider:'分隔',follow:'关注卡'};
 const exact=[['类型 kind=heading：对应两个小节','类型 小节标题：对应两个小节'],['范围 kind=paragraph：全部13段','范围 正文：全部13段'],['类型 kind=heading? 对应两个小节','类型 小节标题? 对应两个小节'],['类型 kind=heading: 对应两个小节','类型 小节标题: 对应两个小节'],['kind=heading: scope','小节标题: scope']];
 const punctuation=['：全部13段',':',': scope',': 对应两个小节',':\t保留36px',':\n仅当完整发布','?','? 对应两个小节','?\t保留36px','?\n仅当完整发布','?! 条件不变','?）','，','、',';','；','。','！','？','!','.',')','】','”'];
 for(const [identity,label]of Object.entries(labels))for(const suffix of punctuation)exact.push(['范围 kind='+identity+suffix,'范围 '+label+suffix]);
 for(const [input,expected]of exact)for(const current of [true,false]){
  result.issues=[{...result.issues[0]!,block_id:null,...Object.fromEntries(fields.map(k=>[k,input]))}];result.uncertainties=[input!];const before=structuredClone({snapshot,result}),view=visualResultView(snapshot,result,current);
  for(const field of fields)assert.equal(view.issues[0]![field],expected,input+'/'+field);assert.deepEqual(view.uncertainties,[expected]);assert.equal(view.issues[0]!.target,null);assert.equal(view.verdict,result.verdict);assert.deepEqual({snapshot,result},before);
 }
});
test('new punctuation boundaries leave query suffixes, unknown identities and protected values untouched',()=>{
 const {snapshot,result}=visualFixture();const unchanged=['kind=heading?x=1','kind=heading?mode=paragraph','https://example.test/kind=heading?x=1&kind=paragraph','kind=heading??x=1','kind=heading:对应两个小节','kind=heading:custom','kind=heading_extra：全部13段','kind=unknown? 对应两个小节','kind=Heading：两个','x.kind=heading：两个','unkind=heading? 对应两个小节','heading? paragraph：保留英文','https://example.test/kind=heading? 对应两个小节','/assets/kind=paragraph：全部13段','custom:kind=heading? 对应两个小节','<span title="kind=heading? > kind=paragraph：">','content: "kind=heading? 对应两个小节"','content: open-quote "kind=paragraph：全部13段" close-quote','--tokens: kind=heading? 对应两个小节','background-image:url("kind=heading? 对应两个小节")'];
 for(const text of unchanged){result.issues[0]!.problem=text;const before=structuredClone(result);assert.equal(visualResultView(snapshot,result,true).issues[0]!.problem,text,text);assert.deepEqual(result,before);}
});

test('bare compound query spans retain every kind parameter while surrounding report prose remains readable',()=>{
 const {snapshot,result}=visualFixture(),fields=['location','problem','standard_ref','suggestion','uncertainty'] as const;
 const kinds=['title','lead','heading','paragraph','opinion','image','divider','follow'];
 const queries=['kind=heading?x=1&kind=paragraph',...kinds.flatMap(kind=>['kind='+kind+'?x=1&kind=paragraph&kind=heading','resource?kind='+kind+'&x=1&kind=heading','kind=heading?kind='+kind+'&kind=paragraph&x=1','kind=heading??x=1&kind='+kind,'kind=heading?x=&kind='+kind,'?kind='+kind+'&x=1&kind=heading','kind=heading?x=1&kind=paragraph#kind='+kind])];
 for(const query of queries)for(const current of [true,false]){
  const input='kind=title；查询 '+query+' 后续 kind=paragraph: 保留13段、36px及条件。',expected='文章标题；查询 '+query+' 后续 正文: 保留13段、36px及条件。';
  result.issues=[{...result.issues[0]!,block_id:null,...Object.fromEntries(fields.map(field=>[field,input]))}];result.uncertainties=[input];const before=structuredClone({snapshot,result}),view=visualResultView(snapshot,result,current);
  for(const field of fields)assert.equal(view.issues[0]![field],expected,query+'/'+field);assert.deepEqual(view.uncertainties,[expected]);assert.equal(view.issues[0]!.target,null);assert.equal(view.verdict,'issues');assert.deepEqual({snapshot,result},before);
 }
});
test('unknown declarations and Scope values retain literal known kinds under the Root boundary decision',()=>{
 const {snapshot,result}=visualFixture();
 for(const kind of ['title','lead','heading','paragraph','opinion','image','divider','follow'])for(const current of [true,false]){
  const pairs=[['font-size-extra:18px;font-weight:900;kind='+kind,'font-size-extra:18px;font-weight:900;kind='+kind],['Scope: kind='+kind+'; computed_style.font_size 为18px','Scope: kind='+kind+'; 实际字号 为18px']];
  for(const [input,expected]of pairs){result.issues[0]!.problem=input!;const before=structuredClone({snapshot,result}),view=visualResultView(snapshot,result,current);assert.equal(view.issues[0]!.problem,expected,input);assert.deepEqual({snapshot,result},before);}
 }
});
test('all eight kind values stay opaque in URI HTML CSS custom and unknown declaration contexts',()=>{
 const {snapshot,result}=visualFixture();
 for(const kind of ['title','lead','heading','paragraph','opinion','image','divider','follow'])for(const current of [true,false]){
  const opaque=['https://example.test/kind='+kind+'?x=1&kind=paragraph','/assets/kind='+kind,'custom:kind='+kind,'<span title="kind='+kind+': scope > kind=paragraph">','content: "kind='+kind+': scope"','--tokens: kind='+kind+': scope','font-size-extra: kind='+kind+': scope','Scope: kind='+kind+': scope'];
  for(const input of opaque){result.issues[0]!.problem=input;const before=structuredClone({snapshot,result}),view=visualResultView(snapshot,result,current);assert.equal(view.issues[0]!.problem,input,input);assert.deepEqual({snapshot,result},before);}
 }
});

// INTEGRATION-LAYOUT-QUERY-SPAN-P3-01: prose question punctuation cannot borrow a later assignment as a query key.
for(const [input,expected]of [
 ['类型 kind=heading?，范围kind=paragraph。','类型 小节标题?，范围正文。'],
 ['类型(kind=heading?)，范围kind=paragraph。','类型(小节标题?)，范围正文。'],
])test('R2 exact ordinary question regression: '+input,()=>{
 const {snapshot,result}=visualFixture(),fields=['location','problem','standard_ref','suggestion','uncertainty']as const;
 for(const current of[true,false]){result.issues=[{...result.issues[0]!,block_id:null,...Object.fromEntries(fields.map(k=>[k,input]))}];result.uncertainties=[input];const before=structuredClone({snapshot,result}),view=visualResultView(snapshot,result,current);for(const field of fields)assert.equal(view.issues[0]![field],expected,field+'/'+current);assert.deepEqual(view.uncertainties,[expected]);assert.equal(view.issues[0]!.target,null);assert.equal(view.verdict,result.verdict);assert.deepEqual({snapshot,result},before);}
});
test('R2 all known kinds keep ordinary question clauses readable with and without a later assignment',()=>{
 const labels={title:'文章标题',lead:'导读',heading:'小节标题',paragraph:'正文',opinion:'我的看法',image:'配图',divider:'分隔',follow:'关注卡'},fields=['location','problem','standard_ref','suggestion','uncertainty']as const;
 for(const[id,label]of Object.entries(labels))for(const delimiter of[',','，',')，','）。','；','】','、'])for(const later of[true,false])for(const current of[true,false]){
  const {snapshot,result}=visualFixture(),tail=later?'范围kind=paragraph。':'范围保持原条件。',expectedTail=later?'范围正文。':tail,input='类型 kind='+id+'?'+delimiter+tail+' 13段\t36px 仅当条件成立。',expected='类型 '+label+'?'+delimiter+expectedTail+' 13段\t36px 仅当条件成立。';result.issues=[{...result.issues[0]!,block_id:null,...Object.fromEntries(fields.map(k=>[k,input]))}];result.uncertainties=[input];const before=structuredClone({snapshot,result}),view=visualResultView(snapshot,result,current);for(const field of fields)assert.equal(view.issues[0]![field],expected,input+'/'+field);assert.deepEqual(view.uncertainties,[expected]);assert.equal(view.issues[0]!.target,null);assert.equal(view.verdict,result.verdict);assert.deepEqual({snapshot,result},before);
 }
});
test('R2 genuine parameter starts and full resources retain kinds even with the same prose punctuation',()=>{
 const fields=['location','problem','standard_ref','suggestion','uncertainty']as const;
 const queries=['kind=heading?x=1&kind=paragraph','kind=heading??x=1&kind=paragraph','kind=heading?项=1&kind=paragraph','kind=heading?x[]=1&kind=paragraph','resource?kind=heading&kind=paragraph','?kind=heading&x=(a,b)&kind=paragraph','kind=heading?x=1，范围kind=paragraph。'];
 const resources=['https://example.test/kind=heading?，范围kind=paragraph。','https://example.test/kind=heading?)，范围kind=paragraph。','/assets/kind=heading?，范围kind=paragraph。','<span title="kind=heading?，范围kind=paragraph。">','content: "kind=heading?，范围kind=paragraph。"','--tokens: kind=heading?，范围kind=paragraph。','Scope: kind=heading?，范围kind=paragraph。'];
 for(const[current,input,expected]of[true,false].flatMap(current=>[...queries.map(q=>[current,'kind=title；查询 '+q+' 后续 kind=paragraph: 保留13段、36px及条件。','文章标题；查询 '+q+' 后续 正文: 保留13段、36px及条件。']as const),...resources.map(q=>[current,q,q]as const)])){
  const{snapshot,result}=visualFixture();result.issues=[{...result.issues[0]!,block_id:null,...Object.fromEntries(fields.map(k=>[k,input]))}];result.uncertainties=[input];const before=structuredClone({snapshot,result}),view=visualResultView(snapshot,result,current);for(const field of fields)assert.equal(view.issues[0]![field],expected,input+'/'+field);assert.deepEqual(view.uncertainties,[expected]);assert.equal(view.issues[0]!.target,null);assert.deepEqual({snapshot,result},before);
 }
});

test('R3 decomposed Unicode query keys preserve original codepoints in every result field',()=>{
 const fields=['location','problem','standard_ref','suggestion','uncertainty']as const;
 const input='kind=heading?cafe\u0301=1&kind=paragraph';
 assert.deepEqual([...input.slice(input.indexOf('?')+1,input.indexOf('=' ,input.indexOf('?')))].map(c=>c.codePointAt(0)),[0x63,0x61,0x66,0x65,0x301]);
 for(const current of[true,false]){
  const{snapshot,result}=visualFixture();result.issues=[{...result.issues[0]!,block_id:null,...Object.fromEntries(fields.map(k=>[k,input]))}];result.uncertainties=[input];const before=structuredClone({snapshot,result}),view=visualResultView(snapshot,result,current);
  for(const field of fields){assert.equal(view.issues[0]![field],input,field+'/'+current);assert.deepEqual(Buffer.from(view.issues[0]![field]!),Buffer.from(input));}
  assert.deepEqual(view.uncertainties,[input]);assert.equal(view.issues[0]!.target,null);assert.equal(view.verdict,result.verdict);assert.deepEqual({snapshot,result},before);
 }
});
test('R3 combining-mark and array keys keep compound queries intact between readable prose',()=>{
 const fields=['location','problem','standard_ref','suggestion','uncertainty']as const,keys=['cafe\u0301','na\u0308me','a\u0301\u0323','ש\u05b8ם','नाम','cafe\u0301[]','x[cafe\u0301]'];
 const queries=keys.map(key=>'kind=heading?'+key+'=1&kind=paragraph&kind=image');
 queries.push('kind=heading?café=1&kind=paragraph','https://example.test/kind=heading?cafe\u0301=1&kind=paragraph');
 for(const query of queries)for(const current of[true,false]){
  const{snapshot,result}=visualFixture(),input='类型 kind=title；查询 '+query+' 后续 kind=paragraph: 保留13段、36px与条件。',expected='类型 文章标题；查询 '+query+' 后续 正文: 保留13段、36px与条件。';result.issues=[{...result.issues[0]!,block_id:null,...Object.fromEntries(fields.map(k=>[k,input]))}];result.uncertainties=[input];const before=structuredClone({snapshot,result}),view=visualResultView(snapshot,result,current);
  for(const field of fields)assert.equal(view.issues[0]![field],expected,query+'/'+field);assert.deepEqual(view.uncertainties,[expected]);assert.equal(view.issues[0]!.target,null);assert.deepEqual({snapshot,result},before);
 }
});
