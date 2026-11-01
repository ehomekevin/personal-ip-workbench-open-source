/** Development repair fixture copied from the original QA oracle; not independent acceptance. No CodexNative construction or external calls. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { CodexLayoutCheckAdapter, layoutRenderSnapshotHash, layoutBlockStructureHash, WECHAT_LAYOUT_STANDARD } from '../../../packages/adapters/src/media/layout-check/index.ts';
import { SqliteLayoutCheckJournal } from '../../../packages/storage/src/article-layout/check-journal.ts';
import type { LayoutVisualInput, LayoutNativeClient, LayoutRenderedBlock } from '../../../packages/adapters/src/media/layout-check/index.ts';
import type { LayoutCheckResult } from '../../../packages/contracts/src/article-layout.ts';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const own = fileURLToPath(new URL('.', import.meta.url));
export const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const signal = () => new AbortController().signal;
export const identity = (suffix='case') => ({ id: 'qa-check-'+suffix, job_id: 'qa-job-'+suffix, attempt_id: 'qa-attempt-'+suffix });
export function crc(b:Buffer){let c=0xffffffff;for(const byte of b){c^=byte;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return (c^0xffffffff)>>>0;}
export function chunk(type:string,data:Buffer){const body=Buffer.concat([Buffer.from(type),data]),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(body));return Buffer.concat([len,body,sum]);}
export function png(width:number,height:number){const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;const stride=width*3+1,raw=Buffer.alloc(stride*height,240);for(let row=0;row<height;row++)raw[row*stride]=0;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
export function setup(existingDirectory?:string){
 const directory=realpathSync(existingDirectory??mkdtempSync(join(own,'.repair-fixture-')));
 let db=new DatabaseSync(join(directory,'metadata.sqlite'));
 db.exec('CREATE TABLE IF NOT EXISTS application_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 const blocks:LayoutRenderedBlock[]=[{id:'title',kind:'title',text:'独立 QA fixture',computed_style:{font_size:22,line_height:31.9,font_family:'DingTalkJinBuTi'},bounds:{x:16,y:12,width:358,height:40}},{id:'p1',kind:'paragraph',text:'这是隔离的人工稿。',computed_style:{font_size:15,line_height:27,letter_spacing:0.5,margin_bottom:20},bounds:{x:16,y:90,width:358,height:190}},{id:'image',kind:'image',image:{sha256:sha('fixture-image'),adopted_version:'fixture-v2',decoded_width:800,decoded_height:400,display_width:358},computed_style:{width:358},bounds:{x:16,y:305,width:358,height:179}}];
 const slices=[0,180,360].map((offset,i)=>{const file=join(directory,'slice-'+i+'.png'),bytes=png(390,180);writeFileSync(file,bytes);return {path:file,sha256:sha(bytes),width:390,height:180,offset_y:offset,block_ids:i===0?['title','p1']:i===1?['p1','image']:['image']};});
 const input:LayoutVisualInput={work_directory:directory,render_pngs:slices,blocks,standard_png:{path:resolve(root,'tests/article-layout/visual/fixtures/original-standard.png'),sha256:WECHAT_LAYOUT_STANDARD.png_sha256},standard_html:{path:resolve(root,'tests/article-layout/visual/fixtures/original-standard.html'),sha256:WECHAT_LAYOUT_STANDARD.html_sha256},binding:{article_id:'qa-fixture-article',content_revision_id:'qa-c2',layout_revision_id:'qa-l3',text_hash:sha('qa fixture content canonical hash'),images_hash:sha('qa adopted image canonical hash'),standard_version:WECHAT_LAYOUT_STANDARD.version,standard_png_sha256:WECHAT_LAYOUT_STANDARD.png_sha256,standard_html_sha256:WECHAT_LAYOUT_STANDARD.html_sha256,render_snapshot_sha256:layoutRenderSnapshotHash(slices),block_structure_sha256:layoutBlockStructureHash(blocks)}};
 return {directory,input,get db(){return db;},journal:()=>new SqliteLayoutCheckJournal(db,'qa-fixture-workspace'),reopen:()=>{db.close();db=new DatabaseSync(join(directory,'metadata.sqlite'));},close:()=>db.close(),cleanup:()=>{db.close();rmSync(directory,{recursive:true,force:true});}};
}
export type FixtureMode='complete'|'reply-lost'|'abort'|'stall'|'text-only'|'extra-user'|'wrong-image'|'wrong-binding'|'copy-field'|'uncertain-issue'|'unknown-block'|'tool'|'no-image'|'crash';
export class QAOnlyNative implements LayoutNativeClient{
 version='qa-protocol-fixture-not-native'; mode:FixtureMode; starts=0; threads=0; reads=0; closes=0; denied=0;
 listeners=new Set<(message:any)=>void>(); calls:Array<{method:string,params:any}>=[]; input:any; binding:any; controller?:AbortController;
 constructor(mode:FixtureMode='complete'){this.mode=mode;}
 async initialize(){} async close(){this.closes++;} deny(){this.denied++;}
 observe(listener:(message:any)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 emit(message:any){for(const listener of this.listeners)listener(message);}
 async request(method:string,params:any):Promise<unknown>{
  this.calls.push({method,params:structuredClone(params)});
  if(method==='account/read')return {account:{type:'chatgpt'}};
  if(method==='account/rateLimits/read')return {ordinaryUsageAllowed:true};
  if(method==='model/list')return {data:[{id:'gpt-6.1-sol',inputModalities:this.mode==='no-image'?['text']:['text','image'],supportedReasoningEfforts:[{reasoningEffort:'xhigh'}]}]};
  if(method==='thread/start'){this.threads++;return {thread:{id:'qa-thread'},modelProvider:'openai',model:'gpt-6.1-sol'};}
  if(method==='turn/start'){
   this.starts++;this.input=structuredClone(params.input);this.binding=Object.fromEntries(Object.entries(params.outputSchema.properties.binding.properties).map(([key,value]:[string,any])=>[key,value.const]));
   this.emit({method:'turn/started',params:{threadId:'qa-thread',turn:{id:'qa-turn'}}});
   if(this.mode==='crash'){
    process.stdout.write('QA fixture observed qa-turn; turn/start reply stalled; controlled exit after 25ms\n');
    setTimeout(()=>process.exit(77),25);
    return new Promise(()=>{});
   }
   if(this.mode==='reply-lost')throw new Error('QA fixture: reply lost after turn/started');
   if(this.mode==='abort')this.controller!.abort('QA fixture cancellation');
   if(this.mode==='tool')this.emit({id:42,method:'fixture/forbidden-tool'});
   if(!['stall','abort','tool'].includes(this.mode))this.emit({method:'turn/completed',params:{threadId:'qa-thread',turn:{id:'qa-turn',status:'completed'}}});
   return {turn:{id:'qa-turn'}};
  }
  if(method==='thread/read'){
   this.reads++;
   const result:LayoutCheckResult={binding:structuredClone(this.binding),verdict:'passed',issues:[],uncertainties:[]};
   if(this.mode==='wrong-binding')result.binding.layout_revision_id='qa-older-layout';
   if(this.mode==='copy-field')(result as any).copyReview={rewrite:'fixture forbidden rewrite'};
   if(this.mode==='uncertain-issue'){result.verdict='uncertain';result.issues=[{id:'font-uncertain',block_id:'title',location:'标题',category:'font',problem:'字体无法确认',standard_ref:'WX-Spec.dc.html 标题钉钉进步体',suggestion:'核查实际字体',uncertainty:'像素不足'}];}
   if(this.mode==='unknown-block'){result.verdict='issues';result.issues=[{id:'font-invalid',block_id:'wrong-block',location:'缺失块',category:'font',problem:'fixture',standard_ref:'fixture',suggestion:'fixture',uncertainty:null}];}
   const content=this.mode==='text-only'?this.input.filter((i:any)=>i.type==='text'):structuredClone(this.input);
   if(this.mode==='wrong-image')content[1].path='/qa/not-submitted.png';
   const items:any[]=[{type:'userMessage',content}];
   if(this.mode==='extra-user')items.push({type:'userMessage',content});
   items.push({type:'agentMessage',phase:'final_answer',text:JSON.stringify(result)});
   return {thread:{id:'qa-thread',modelProvider:'openai',model:'gpt-6.1-sol',turns:[{id:'qa-turn',status:'completed',items}]}};
  }
  throw new Error('QA fixture unexpected request: '+method);
 }
}
export function adapter(f:ReturnType<typeof setup>,native:QAOnlyNative){return new CodexLayoutCheckAdapter({workspace_id:'qa-fixture-workspace',cwd:f.directory,lock_root:f.directory,schema_directory:f.directory,journal:f.journal(),fixture:true,native_factory:()=>native,timeout_ms:15});}
