import type { DatabaseSync } from 'node:sqlite';
import type { ArticleLayoutSnapshot, ArticleLayoutSaveResult, ArticleLayoutSourceBinding } from '../../../contracts/src/article-layout.ts';
import type { RequestContext } from '../../../contracts/src/common.ts';
import type {ArticleLayoutOperation} from './commands.ts';
export interface ArticleLayoutSaveIntent {
 id:string; operation_key:string; operation?:ArticleLayoutOperation; input_hash:string; request:RequestContext; expected_version:number;
 expected_document_revision_id:string|null; target:ArticleLayoutSnapshot; phase:'prepared'|'document_saved';
 saved_document_revision_id:string|null; created_at:string;
}
export interface ArticleLayoutRecord {
 snapshot:ArticleLayoutSnapshot; pending:ArticleLayoutSaveIntent|null;
 operations:Record<string,{operation?:ArticleLayoutOperation;input_hash:string;result:ArticleLayoutSaveResult}>;
 conflicts:Array<{id:string;at:string;reason:string;local:ArticleLayoutSnapshot}>;
 /** 公众号排版（C1）：来源平台稿、配图终稿与段落 → 文字块映射。叶子测试记录没有这一项。 */
 source?:ArticleLayoutSourceBinding;
}
export interface ArticleLayoutRepository {
 read(workspaceId:string,articleId:string):Promise<ArticleLayoutRecord|null>;
 create(workspaceId:string,record:ArticleLayoutRecord):Promise<boolean>;
 prepare(workspaceId:string,articleId:string,expectedVersion:number,intent:ArticleLayoutSaveIntent):Promise<boolean>;
 updatePending(workspaceId:string,articleId:string,intent:ArticleLayoutSaveIntent):Promise<void>;
 commit(workspaceId:string,articleId:string,intentId:string,snapshot:ArticleLayoutSnapshot,source?:ArticleLayoutSourceBinding,guard?:()=>void):Promise<ArticleLayoutSnapshot>;
 reject(workspaceId:string,articleId:string,intentId:string,reason:string):Promise<ArticleLayoutSaveResult>;
 updateSource?(workspaceId:string,articleId:string,source:ArticleLayoutSourceBinding):Promise<void>;
}
const key=(workspace:string,article:string)=>'article-layout.v1:'+workspace+':'+article;
/** Reuses the existing metadata table; no new schema or migration. Serial CAS writes. */
export class SqliteArticleLayoutRepository implements ArticleLayoutRepository {
 readonly db:DatabaseSync;constructor(db:DatabaseSync){this.db=db;}
 private readSync(workspace:string,article:string):ArticleLayoutRecord|null{const row=this.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key(workspace,article));return row?JSON.parse(String(row.value)) as ArticleLayoutRecord:null;}
 private write(workspace:string,article:string,value:ArticleLayoutRecord){this.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key(workspace,article),JSON.stringify(value));}
 private transaction<T>(operation:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=operation();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 async read(workspace:string,article:string){return this.readSync(workspace,article);}
 async create(workspace:string,record:ArticleLayoutRecord):Promise<boolean>{return this.transaction(()=>{if(this.readSync(workspace,record.snapshot.article_id))return false;this.write(workspace,record.snapshot.article_id,record);return true;});}
 async prepare(workspace:string,article:string,version:number,intent:ArticleLayoutSaveIntent):Promise<boolean>{return this.transaction(()=>{const record=this.readSync(workspace,article);if(!record||record.snapshot.version!==version||record.pending)return false;record.pending=structuredClone(intent);this.write(workspace,article,record);return true;});}
 async updatePending(workspace:string,article:string,intent:ArticleLayoutSaveIntent):Promise<void>{this.transaction(()=>{const record=this.readSync(workspace,article);if(!record||record.pending?.id!==intent.id)throw new Error('ARTICLE_LAYOUT_SAVE_FENCE');record.pending=structuredClone(intent);this.write(workspace,article,record);});}
 async commit(workspace:string,article:string,intentId:string,snapshot:ArticleLayoutSnapshot,source?:ArticleLayoutSourceBinding,guard?:()=>void):Promise<ArticleLayoutSnapshot>{return this.transaction(()=>{const record=this.readSync(workspace,article);if(!record||record.pending?.id!==intentId||record.snapshot.version!==record.pending.expected_version)throw new Error('ARTICLE_LAYOUT_SAVE_FENCE');guard?.();const committed=structuredClone(snapshot);committed.version=record.snapshot.version+1;const pending=record.pending;record.snapshot=committed;if(source)record.source=structuredClone(source);record.pending=null;record.operations[pending.operation_key]={operation:pending.operation??'editor',input_hash:pending.input_hash,result:{state:'saved',snapshot:committed}};this.write(workspace,article,record);return committed;});}
 async updateSource(workspace:string,article:string,source:ArticleLayoutSourceBinding):Promise<void>{this.transaction(()=>{const record=this.readSync(workspace,article);if(!record)throw new Error('ARTICLE_LAYOUT_NOT_FOUND');record.source=structuredClone(source);this.write(workspace,article,record);});}
 async reject(workspace:string,article:string,intentId:string,reason:string):Promise<ArticleLayoutSaveResult>{return this.transaction(()=>{const record=this.readSync(workspace,article);if(!record||record.pending?.id!==intentId)throw new Error('ARTICLE_LAYOUT_SAVE_FENCE');const pending=record.pending,result:ArticleLayoutSaveResult={state:'conflict',current:record.snapshot,local:pending.target,reason};record.conflicts.push({id:pending.id,at:new Date().toISOString(),reason,local:pending.target});record.operations[pending.operation_key]={operation:pending.operation??'editor',input_hash:pending.input_hash,result};record.pending=null;this.write(workspace,article,record);return result;});}
}
