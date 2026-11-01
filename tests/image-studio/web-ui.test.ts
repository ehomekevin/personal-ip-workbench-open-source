import test from 'node:test';
import assert from 'node:assert/strict';
import {projectWebCandidates} from '../../apps/web/src/features/media/image-studio/model.ts';
import {imageStudioHttpPort} from '../../apps/web/src/features/media/image-studio/index.ts';
import type {StudioWebImageCandidate} from '../../packages/contracts/src/index.ts';
const base:StudioWebImageCandidate={candidate_id:'a'.repeat(32),image_url:'https://pbs.example/x.png',platform:'x',record_id:'rec-1',page_url:'https://x.com/alice/status/1',availability:'unknown',credit_label:'图源：X @alice'};
test('web candidate view model hides record ids, groups article vs posts and disables expired ones',()=>{
 const views=projectWebCandidates([{...base,page_title:'帖子标题'},{...base,candidate_id:'b'.repeat(32),platform:'douyin',availability:'expired',credit_label:'图源：抖音 @作者',thumb_url:'https://d.example/t.png'},{...base,candidate_id:'c'.repeat(32),platform:'article',page_url:'https://news.example/a',credit_label:'图源：Example',site_name:'Example'}]);
 assert.deepEqual(views.map(v=>[v.group,v.selectable,v.page_label]),[['posts',true,'帖子标题'],['posts',false,'x.com'],['article',true,'Example']]);assert.equal(views[1]!.thumb_url,'https://d.example/t.png');assert.match(views[1]!.note,/过期/);
 assert.equal(JSON.stringify(views).includes('rec-1'),false);
});
test('HTTP port reads candidates per topic and posts one idempotent import per image',async()=>{
 const calls:any[]=[];const context={signal:new AbortController().signal,client:{request:async(method:string,url:string,body:unknown,options:{idempotencyKey?:string})=>{calls.push({method,url,body,key:options?.idempotencyKey});return url.includes('candidates')?{candidates:[base]}:{slot_id:'s',version_id:'v',asset_id:'a',deduplicated:false,version:2};}}} as any;
 const port=imageStudioHttpPort(),views=await port.webCandidates('topic 1',context);assert.equal(calls[0].url,'/api/v1/topics/topic%201/web-image-candidates');assert.equal(views.items[0]!.credit,'图源：X @alice');assert.equal(views.capture.refreshing,false,'旧服务没有 capture 字段时按已读完处理');
 await port.webCandidates('topic 1',context,{refresh:true});assert.equal(calls.at(-1).url,'/api/v1/topics/topic%201/web-image-candidates?refresh=1','重新读取带 refresh=1');calls.splice(1);
 const result=await port.webImport({topic_id:'t',expected_version:1,slot_id:null,candidate:{candidate_id:base.candidate_id,image_url:base.image_url}},'key-1',context);assert.equal(result.version,2);assert.deepEqual([calls[1].method,calls[1].url,calls[1].key],['POST','/api/v1/image-studio/web-imports','key-1']);
});
test('GIF passes the preview format gate like the server whitelist (then hash is still enforced)',async()=>{
 const {verifiedImageUrl}=await import('../../apps/web/src/features/media/image-generation.ts');const blob=new Blob([new Uint8Array([71,73,70,56,57,97,1,0,1,0])],{type:'image/gif'});
 await assert.rejects(verifiedImageUrl(blob,{id:'a',kind:'image',status:'ready',mime:'image/gif',size_bytes:blob.size,sha256:'0'.repeat(64)} as any),/hash/);
 await assert.rejects(verifiedImageUrl(new Blob(['x'],{type:'image/svg+xml'}),{id:'a',kind:'image',status:'ready',mime:'image/svg+xml',size_bytes:1,sha256:'0'.repeat(64)} as any),/格式/);
});
test('per-candidate import key and request are frozen across retries and storage, cleared on success, and only refrozen after a version conflict',async()=>{
 const {WebImportKeys,isVersionConflict}=await import('../../apps/web/src/features/media/image-studio/model.ts');const data=new Map<string,string>(),store={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};let n=0;const next=()=>'key-'+(++n);
 const input={topic_id:'t',expected_version:3,slot_id:null,candidate:{candidate_id:'c1',image_url:'https://pbs.example/x.png'}};
 const keys=new WebImportKeys('ws:svc:t',store),first=keys.freeze('c1',input,next);assert.equal(first.key,'key-1');
 assert.deepEqual(keys.freeze('c1',{...input,expected_version:9},next),first,'响应丢失后重试沿用原键与原请求体');
 const reopened=new WebImportKeys('ws:svc:t',store);assert.deepEqual(reopened.freeze('c1',{...input,expected_version:9},next),first,'刷新页面后仍从 sessionStorage 取回原键');
 reopened.clear('c1');assert.equal(data.size,0);assert.equal(reopened.freeze('c1',{...input,expected_version:9},next).key,'key-2');
 assert.equal(isVersionConflict({response:{error:{code:'VERSION_CONFLICT'}}}),true);assert.equal(isVersionConflict(new Error('x')),false);
});
test('import failure reasons are user language without status codes or error codes',async()=>{
 const {webImportFailureCopy}=await import('../../apps/web/src/features/media/image-studio/model.ts');const err=(message:string,code='VALIDATION_ERROR')=>Object.assign(new Error(message),{status:400,response:{error:{code,message}}});
 const cases:[unknown,string][]=[[err('来源页面已打不开，未取得图片'),'来源页面已打不开，未取得图片'],[err('来源返回 404，未取得内容'),'来源页面已打不开，未取得图片'],[err('来源域名解析到内网或保留地址'),'这张图的地址不是公开网页地址，已拦下，未下载'],[err('来源文件超过大小上限'),'图片太大（超过 15MB），未导入'],[err('图片内容与声明格式不符'),'来源给的不是可用的图片文件，未导入'],[err('来源读取超时'),'来源响应太慢，未取得图片，可稍后再试'],[err('x','VERSION_CONFLICT'),'配图刚有变化，请再点一次导入'],[err('x','NOT_FOUND'),'这张图的来源已变化，请重新打开网络找图'],[new TypeError('Failed to fetch'),'来源页面已打不开，未取得图片']];
 for(const [error,copy] of cases){const text=webImportFailureCopy(error);assert.equal(text,copy);assert.equal(/\d{3}|[A-Z_]{5,}/.test(text),false);}
});
test('background capture status is projected to user language: refreshing is a light hint, failed/stale explain and offer retry, no internal state names',async()=>{
 const {projectWebCapture,webCaptureNextDelay,WEB_CAPTURE_POLL}=await import('../../apps/web/src/features/media/image-studio/model.ts');
 const at=(state:'fresh'|'refreshing'|'stale'|'failed',pages_failed=0)=>projectWebCapture({state,pages_total:2,pages_ready:2-pages_failed,pages_failed,refreshed_at:null});
 assert.deepEqual(at('fresh'),{refreshing:false,note:'',retry:false,tone:'none'});
 const r=at('refreshing');assert.equal(r.refreshing,true);assert.equal(r.retry,false);assert.match(r.note,/正在从资讯原文补充更多图片/);
 const f=at('failed',2);assert.equal(f.retry,true);assert.match(f.note,/有 2 篇资讯原文暂时读不到/);assert.match(at('failed',1).note,/^资讯原文暂时读不到/);
 const st=at('stale');assert.equal(st.retry,true);assert.match(st.note,/先显示上次读到的图片/);
 for(const v of [r,f,st])assert.doesNotMatch(v.note,/fresh|refreshing|stale|failed|capture|\d{3}|http/i);
 let d=WEB_CAPTURE_POLL.first_ms;const seq=[d];for(let i=0;i<6;i++){d=webCaptureNextDelay(d);seq.push(d);}assert.deepEqual(seq,[1000,1500,2250,3375,5000,5000,5000]);
});
