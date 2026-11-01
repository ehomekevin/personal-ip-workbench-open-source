import type {ArticleLayoutSaveResult} from '../../../contracts/src/article-layout.ts';
import {digest} from '../../../domain/src/article-layout/hash.ts';
import type {ArticleLayoutRecord} from './index.ts';

export type ArticleLayoutOperation='editor'|'confirm'|'adoptImages'|'syncImages'|'syncCheck'|'backfillCredits';
export interface ArticleLayoutCommandIdentity {operation:ArticleLayoutOperation;input_hash:string}

/** Editor receipts retain their original digest format; dedicated actions freeze the caller's command. */
export function articleLayoutCommandIdentity(operation:ArticleLayoutOperation,articleId:string,command:unknown):ArticleLayoutCommandIdentity {
 return {operation,input_hash:operation==='editor'?digest(command):digest({operation,article_id:articleId,command})};
}

export function assertArticleLayoutCommandIdentity(stored:{operation?:ArticleLayoutOperation;input_hash:string},identity:ArticleLayoutCommandIdentity):void {
 if((stored.operation??'editor')!==identity.operation||stored.input_hash!==identity.input_hash)throw new Error('ARTICLE_LAYOUT_IDEMPOTENCY_CONFLICT');
}

export function replayArticleLayoutCommand(record:ArticleLayoutRecord,key:string,identity:ArticleLayoutCommandIdentity):ArticleLayoutSaveResult|null {
 const receipt=record.operations[key];if(!receipt)return null;
 assertArticleLayoutCommandIdentity(receipt,identity);return structuredClone(receipt.result);
}
