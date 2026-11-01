import type {DatabaseSync} from 'node:sqlite';
import type {ArticleLayoutSnapshot,ArticleLayoutVisualContext,LayoutVisualInput} from '../../../contracts/src/article-layout.ts';
import {digest} from '../../../domain/src/article-layout/index.ts';

export interface ArticleVisualRenderRecord {
 schema_version:'article-layout-render.v2';render_id:string;context:ArticleLayoutVisualContext;context_sha256:string;
 snapshot:ArticleLayoutSnapshot;input:LayoutVisualInput;manifest_sha256:string;created_at:string;
}
export interface ArticleVisualJobRecord {
 schema_version:'article-layout-job.v2';job_id:string;render_id:string;topic_id:string;intent_id:string;
 execution_attempt_id:string|null;execution_generation:number|null;consumed_receipt_id:string|null;
 created_at:string;record_error:string|null;consume_expected_version?:number;
}
export const visualKey=(workspace:string,kind:'render'|'job'|'latest',id:string)=>`article-layout-visual.v2:${workspace}:${kind}:${id}`;
export function readVisualRecord<T>(db:DatabaseSync,workspace:string,kind:'render'|'job'|'latest',id:string):T|null {
 const row=db.prepare('SELECT value FROM application_metadata WHERE key=?').get(visualKey(workspace,kind,id));return row?JSON.parse(String(row.value)) as T:null;
}
export function createVisualRecord(db:DatabaseSync,workspace:string,kind:'render'|'job',id:string,value:unknown):void {
 const key=visualKey(workspace,kind,id),serialized=JSON.stringify(value),old=db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key);
 if(old){if(digest(JSON.parse(String(old.value)))!==digest(value))throw new Error('ARTICLE_VISUAL_ID_REBIND');return;}
 db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?)').run(key,serialized);
}
export function updateVisualJob(db:DatabaseSync,workspace:string,id:string,mutate:(value:ArticleVisualJobRecord)=>ArticleVisualJobRecord):ArticleVisualJobRecord {
 const old=readVisualRecord<ArticleVisualJobRecord>(db,workspace,'job',id);if(!old)throw new Error('ARTICLE_VISUAL_JOB_MISSING');const next=mutate(structuredClone(old));
 if(next.job_id!==old.job_id||next.render_id!==old.render_id||next.topic_id!==old.topic_id||next.intent_id!==old.intent_id||old.execution_attempt_id&&next.execution_attempt_id!==old.execution_attempt_id||old.execution_generation!==null&&next.execution_generation!==old.execution_generation)throw new Error('ARTICLE_VISUAL_JOB_REBIND');
 if(old.consume_expected_version!==undefined&&next.consume_expected_version!==old.consume_expected_version||old.consumed_receipt_id&&next.consumed_receipt_id!==old.consumed_receipt_id)throw new Error('ARTICLE_VISUAL_CONSUME_REBIND');
 const result=db.prepare('UPDATE application_metadata SET value=? WHERE key=? AND value=?').run(JSON.stringify(next),visualKey(workspace,'job',id),JSON.stringify(old));if(result.changes!==1)throw new Error('ARTICLE_VISUAL_JOB_CAS');return next;
}
