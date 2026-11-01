import {closeSync,existsSync,fsyncSync,openSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {ArticleLayoutEvent,ArticleLayoutSnapshot,ArticleLayoutSourceBinding} from '../../../contracts/src/article-layout.ts';
import {articleConfirmationIsCurrent,assertArticleSnapshot,canonicalJson,digest,sha256,serializeArticleText,LAYOUT_RULES_VERSION} from '../../../domain/src/article-layout/index.ts';
import type {ArticleLayoutRecord} from './index.ts';
import {ensureManagedDirectory,safeManagedChild} from '../files/index.ts';
export interface ArticleLayoutRecordGrant { root:string; process_root:string; wiki_root:string; owner_registration_ref:string; scope:'fixture'|'production' }
export interface ArticleLayoutRecordReceipt {path:string;sha256:string;scope:'fixture'|'production';written:boolean;owner_registration_ref:string;markdown_path?:string;markdown_sha256?:string;markdown_written?:boolean}
/** Explicit C1 archive path. The original Document-bound default deliberately still rejects null revisions. */
export interface ArticleLayoutOnlyArchiveOptions {mode:'layout_only';db:DatabaseSync;workspace_id:string;source:ArticleLayoutSourceBinding;rules_version:string}
const segment=(value:string)=>{if(!value)throw new Error('ARTICLE_LAYOUT_RECORD_ID_REQUIRED');return encodeURIComponent(value).replaceAll('.','%2E');};
function authorize(grant:ArticleLayoutRecordGrant):void{
 if(!grant.owner_registration_ref||!['fixture','production'].includes(grant.scope)||resolve(grant.process_root)!==join(resolve(grant.root),'process','article-layout')||resolve(grant.wiki_root)!==join(resolve(grant.root),'wiki','article-layout'))throw new Error('ARTICLE_LAYOUT_RECORD_ROOT_NOT_REGISTERED');
 safeManagedChild(grant.root,grant.process_root);safeManagedChild(grant.root,grant.wiki_root);
}
export function articleLayoutRecordPaths(grant:ArticleLayoutRecordGrant,articleId:string,comboHash?:string):{process:string;wiki:string|null}{authorize(grant);if(comboHash&&!/^[a-f0-9]{64}$/.test(comboHash))throw new Error('ARTICLE_LAYOUT_COMBINATION_HASH_INVALID');return{process:safeManagedChild(grant.process_root,join(grant.process_root,segment(articleId),'events.jsonl')),wiki:comboHash?safeManagedChild(grant.wiki_root,join(grant.wiki_root,segment(articleId),comboHash+'.md')):null};}
export function articleLayoutProcessMarkdownPath(grant:ArticleLayoutRecordGrant,articleId:string,eventId:string):string{authorize(grant);if(!eventId)throw new Error('ARTICLE_LAYOUT_PROCESS_EVENT_REQUIRED');return safeManagedChild(grant.process_root,join(grant.process_root,segment(articleId),'events',sha256(eventId)+'.md'));}
function locked<T>(grant:ArticleLayoutRecordGrant,path:string,operation:()=>T):T{
 const root=path.startsWith(resolve(grant.process_root))?grant.process_root:grant.wiki_root;ensureManagedDirectory(dirname(path));safeManagedChild(root,path);const lock=safeManagedChild(root,path+'.lock'),fd=openSync(lock,'wx',0o600);try{return operation();}finally{closeSync(fd);unlinkSync(lock);}
}
type ArticleLayoutProcessInput={id:string;at:string;kind:string;payload:unknown};
const asObject=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function fenced(value:string,language='text'):string{let size=3;for(const match of value.matchAll(/`+/g))size=Math.max(size,match[0].length+1);const fence='`'.repeat(size);return fence+language+'\n'+value+'\n'+fence+'\n';}
function processMarkdown(grant:ArticleLayoutRecordGrant,articleId:string,input:ArticleLayoutProcessInput,event:unknown):string{
 const labels:Record<string,string>={article_import:'原始稿保存',manual_text:'手动修改文字',style:'调整排版样式',reorder:'调整图文顺序',image_width:'调整图片显示宽度',image_adoption:'采用图片',content_restore:'回退文字版本',layout_restore:'回退排版版本',human_combination_decision:'本人确认图文组合',confirmed_combination_archived:'确认组合存档'};
 const title=labels[input.kind]??(input.kind.startsWith('layout_check_')?'AI 排版检查':'公众号排版过程');
 const metadata={schema_version:'article-layout-process-markdown.v1',scope:grant.scope,owner_registration_ref:grant.owner_registration_ref,article_id:articleId,event_id:input.id,event_sha256:digest(event),occurred_at:input.at,event_kind:input.kind};
 let body='---\n'+Object.entries(metadata).map(([key,value])=>key+': '+JSON.stringify(value)).join('\n')+'\n---\n\n# '+title+'\n\n';
 body+=grant.scope==='fixture'?'记录范围：隔离验证。这条记录不能证明生产 Obsidian 已接通或真人已批准。\n\n':'记录用途：公众号排版过程。\n\n';
 body+='记录时间：'+JSON.stringify(input.at)+'\n\n[查看完整机器记录](../events.jsonl)\n\n';const payload=asObject(input.payload);
 for(const [key,label] of [['content','原始正文'],['before_content','修改前的文字'],['after_content','修改后的文字']] as const){const content=asObject(payload[key]);if(typeof content.source_text==='string'){body+='## '+label+'\n\n'+fenced(content.source_text)+'\n';if(typeof content.id==='string')body+='文字版本：'+JSON.stringify(content.id)+'\n\n';if(Array.isArray(content.captions)&&content.captions.length)body+='图注：\n\n'+fenced(content.captions.map(c=>{const caption=asObject(c);return String(caption.block_id)+': '+String(caption.caption);}).join('\n'))+'\n';}}
 const beforeLayout=asObject(payload.before_layout),afterLayout=asObject(payload.after_layout);if(Object.keys(beforeLayout).length||Object.keys(afterLayout).length){body+='## 排版调整\n\n';for(const [layout,label] of [[beforeLayout,'调整前'],[afterLayout,'调整后']] as const)if(Object.keys(layout).length)body+='### '+label+'\n\n排版版本：'+JSON.stringify(layout.id)+'\n\n'+fenced(JSON.stringify({style:layout.style,order:layout.order,images:layout.images},null,2),'json')+'\n';}
 const result=asObject(payload.result);if(typeof result.verdict==='string'){body+='## 排版检查结果\n\n结论：'+(({passed:'通过',issues:'发现排版问题',uncertain:'存在不确定项'} as Record<string,string>)[result.verdict]??result.verdict)+'\n\n';if(Array.isArray(result.issues))for(const [index,value] of result.issues.entries()){const issue=asObject(value);body+='### 问题 '+(index+1)+'\n\n'+fenced(['位置：'+String(issue.location),'问题：'+String(issue.problem),'对应规范：'+String(issue.standard_ref),'建议：'+String(issue.suggestion),...(issue.uncertainty?['不确定说明：'+String(issue.uncertainty)]:[])].join('\n'))+'\n';}if(Array.isArray(result.uncertainties)&&result.uncertainties.length)body+='不确定说明：\n\n'+fenced(result.uncertainties.map(String).join('\n'))+'\n';}
 const decision=payload.human_decision_ref?payload:asObject(payload.confirmation);if(typeof decision.human_decision_ref==='string')body+='## 本人决定\n\n'+fenced('确认人：'+String(decision.actor)+'\n原始决定引用：'+decision.human_decision_ref)+'\n';
 return body+'## 完整过程数据\n\n'+fenced(JSON.stringify(event,null,2),'json');
}
function writeProcessMarkdown(grant:ArticleLayoutRecordGrant,articleId:string,input:ArticleLayoutProcessInput,event:unknown):{path:string;sha256:string;written:boolean}{
 const path=articleLayoutProcessMarkdownPath(grant,articleId,input.id),body=processMarkdown(grant,articleId,input,event);let written=false;
 locked(grant,path,()=>{if(existsSync(path)){if(readFileSync(path,'utf8')!==body)throw new Error('ARTICLE_LAYOUT_PROCESS_MARKDOWN_IMMUTABLE_CONFLICT');return;}const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,body);fsyncSync(fd);written=true;}finally{closeSync(fd);}});return{path,sha256:sha256(body),written};
}
/** The caller supplies the explicitly registered new record roots. Fixtures retain an explicit scope tag. */
export function appendArticleLayoutProcess(grant:ArticleLayoutRecordGrant,articleId:string,input:ArticleLayoutProcessInput):ArticleLayoutRecordReceipt{
 authorize(grant);if(!input.id||!input.at||!input.kind)throw new Error('ARTICLE_LAYOUT_PROCESS_EVENT_REQUIRED');const path=articleLayoutRecordPaths(grant,articleId).process;
 const event={schema_version:'article-layout-process.v1',scope:grant.scope,owner_registration_ref:grant.owner_registration_ref,article_id:articleId,...input};const line=canonicalJson(event)+'\n';let written=false;
 locked(grant,path,()=>{const existing=existsSync(path)?readFileSync(path,'utf8'):'';if(existing&&!existing.endsWith('\n'))throw new Error('ARTICLE_LAYOUT_PROCESS_PARTIAL_RECORD');const rows=existing.split('\n').filter(Boolean).map(raw=>JSON.parse(raw) as {id:string});const prior=rows.find(row=>row.id===input.id);if(prior){if(canonicalJson(prior)!==line.trimEnd())throw new Error('ARTICLE_LAYOUT_PROCESS_EVENT_CONFLICT');return;}const fd=openSync(path,'a',0o600);try{writeFileSync(fd,line);fsyncSync(fd);written=true;}finally{closeSync(fd);}});
 const markdown=writeProcessMarkdown(grant,articleId,input,event);
 return{path,sha256:sha256(readFileSync(path,'utf8')),scope:grant.scope,written:written||markdown.written,owner_registration_ref:grant.owner_registration_ref,markdown_path:markdown.path,markdown_sha256:markdown.sha256,markdown_written:markdown.written};
}
function eventPayload(snapshot:ArticleLayoutSnapshot,event:ArticleLayoutEvent){return{event,before_content:snapshot.content_history.find(r=>r.id===event.before_content_revision_id)??null,after_content:snapshot.content_history.find(r=>r.id===event.after_content_revision_id)??null,before_layout:snapshot.layout_history.find(r=>r.id===event.before_layout_revision_id)??null,after_layout:snapshot.layout_history.find(r=>r.id===event.after_layout_revision_id)??null};}
export function recordArticleLayoutSnapshot(grant:ArticleLayoutRecordGrant,snapshot:ArticleLayoutSnapshot):ArticleLayoutRecordReceipt[]{
 assertArticleSnapshot(snapshot);const results:ArticleLayoutRecordReceipt[]=[];const imported=snapshot.content_history[0]!;results.push(appendArticleLayoutProcess(grant,snapshot.article_id,{id:'import:'+imported.id,at:imported.created_at,kind:'article_import',payload:{content:imported,original_text:snapshot.original_text,upstream_review:snapshot.upstream_review}}));
 for(const event of snapshot.events){const payload=eventPayload(snapshot,event);results.push(appendArticleLayoutProcess(grant,snapshot.article_id,{id:event.id+':'+digest(payload),at:event.at,kind:event.kind,payload}));}
 for(const check of snapshot.checks)results.push(appendArticleLayoutProcess(grant,snapshot.article_id,{id:'check:'+check.id+':'+digest(check),at:check.updated_at,kind:'layout_check_'+check.state,payload:check}));
 if(snapshot.confirmation)results.push(appendArticleLayoutProcess(grant,snapshot.article_id,{id:'confirmation:'+snapshot.confirmation.id,at:snapshot.confirmation.confirmed_at,kind:'human_combination_decision',payload:snapshot.confirmation}));return results;
}
/** Writes only a saved, specifically human-confirmed combination; it never publishes to WeChat. */
export function writeConfirmedArticleLayoutWiki(grant:ArticleLayoutRecordGrant,snapshot:ArticleLayoutSnapshot,options?:ArticleLayoutOnlyArchiveOptions):ArticleLayoutRecordReceipt{
 if(options&&!options.db.isTransaction){options.db.exec('BEGIN IMMEDIATE');try{const receipt=writeConfirmedArticleLayoutWiki(grant,snapshot,options);options.db.exec('COMMIT');return receipt;}catch(error){options.db.exec('ROLLBACK');throw error;}}
 authorize(grant);assertArticleSnapshot(snapshot);if(!articleConfirmationIsCurrent(snapshot)||snapshot.document_revision_id===null&&options?.mode!=='layout_only')throw new Error('ARTICLE_LAYOUT_WIKI_CONFIRMATION_REQUIRED');
 if(options)assertLayoutOnlyArchive(grant,snapshot,options);
 const confirmation=snapshot.confirmation!,comboHash=digest(confirmation.binding),path=articleLayoutRecordPaths(grant,snapshot.article_id,comboHash).wiki!;
 const provenance=options?{archive_mode:'layout_only',document_revision_id:snapshot.document_revision_id,source_document_revision_id:options.source.document_revision_id,source_binding_sha256:digest(options.source),source:options.source,rules_version:options.rules_version,confirmation_scope:grant.scope==='fixture'?'synthetic_fixture':'human'}:{};
 const body='---\n'+Object.entries({schema_version:'article-layout-wiki.v1',scope:grant.scope,owner_registration_ref:grant.owner_registration_ref,document_id:snapshot.document_id,combination_sha256:comboHash,...confirmation.binding,...provenance}).map(([key,value])=>key+': '+JSON.stringify(value)).join('\n')+'\n---\n\n'+(options&&grant.scope==='fixture'?'记录范围：隔离验证；当前确认为 synthetic fixture，不代表本人批准或生产 Wiki 接通。\n\n':'')+serializeArticleText(snapshot)+'\n\n## 已确认的图文与版式\n\n'+JSON.stringify({order:snapshot.order,style:snapshot.style,images:snapshot.blocks.filter(b=>b.kind==='image'),upstream_review:snapshot.upstream_review},null,2)+'\n';let written=false;
 locked(grant,path,()=>{if(existsSync(path)){if(readFileSync(path,'utf8')!==body)throw new Error('ARTICLE_LAYOUT_WIKI_IMMUTABLE_CONFLICT');return;}const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,body);fsyncSync(fd);written=true;}finally{closeSync(fd);}});
 appendArticleLayoutProcess(grant,snapshot.article_id,{id:'wiki:'+comboHash+':'+confirmation.id,at:confirmation.confirmed_at,kind:'confirmed_combination_archived',payload:{combination_sha256:comboHash,path,confirmation,...(options?{provenance}:{})}});
 return{path,sha256:sha256(body),scope:grant.scope,written,owner_registration_ref:grant.owner_registration_ref};
}
function assertLayoutOnlyArchive(grant:ArticleLayoutRecordGrant,snapshot:ArticleLayoutSnapshot,options:ArticleLayoutOnlyArchiveOptions):void{
 if(options.mode!=='layout_only'||!options.workspace_id||options.rules_version!==LAYOUT_RULES_VERSION||snapshot.confirmation?.binding.rules_version!==options.rules_version)throw new Error('ARTICLE_LAYOUT_WIKI_RULES_FENCE');
 // This explicit path currently accepts only the separately registered isolated fixture roots.
 let registered:ArticleLayoutRecordGrant;
 try{registered=JSON.parse(readFileSync(grant.owner_registration_ref,'utf8')) as ArticleLayoutRecordGrant;}catch{throw new Error('ARTICLE_LAYOUT_RECORD_GRANT_REQUIRED');}
 if(grant.scope!=='fixture'||['root','process_root','wiki_root','owner_registration_ref','scope'].some(key=>registered[key as keyof ArticleLayoutRecordGrant]!==grant[key as keyof ArticleLayoutRecordGrant]))throw new Error('ARTICLE_LAYOUT_RECORD_GRANT_MISMATCH');
 const source=options.source;
 if(!source||[source.topic_id,source.document_id,source.document_revision_id,source.final_id,source.synced_at].some(value=>typeof value!=='string'||!value)||source.document_id!==snapshot.document_id||!snapshot.content_history.some(revision=>revision.document_revision_id===source.document_revision_id))throw new Error('ARTICLE_LAYOUT_WIKI_SOURCE_PROVENANCE_FENCE');
 const row=options.db.prepare('SELECT value FROM application_metadata WHERE key=?').get('article-layout.v1:'+options.workspace_id+':'+snapshot.article_id);
 const saved=row?JSON.parse(String(row.value)) as ArticleLayoutRecord:null;
 if(!saved||saved.pending!==null||snapshot.version<1||digest(saved.snapshot)!==digest(snapshot)||!saved.source||digest(saved.source)!==digest(source))throw new Error('ARTICLE_LAYOUT_WIKI_SAVED_COMBINATION_REQUIRED');
 assertArticleSnapshot(saved.snapshot);
 if(!articleConfirmationIsCurrent(saved.snapshot)||!saved.snapshot.confirmation?.actor||!saved.snapshot.confirmation.human_decision_ref)throw new Error('ARTICLE_LAYOUT_WIKI_CONFIRMATION_REQUIRED');
}
