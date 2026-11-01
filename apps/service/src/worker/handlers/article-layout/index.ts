import type {ApplicationContext} from '@workbench/domain/ports';
import type {WorkerHandler} from '../../core/index.ts';
import {getArticleLayoutRuntime} from '../../../bootstrap/article-layout-runtime.ts';
export function createArticleLayoutHandlers(context:ApplicationContext):WorkerHandler[]{
 return[{registration:{kind:'article_layout_check',execution_mode:'programmatic',recovery:'media'},async execute({claim,signal,checkpoint}){const workflow=getArticleLayoutRuntime(context).workflow;try{const layout_check=await workflow.execute(claim,signal,checkpoint);return{documents:[],recommendations:[],layout_check};}catch(error){await workflow.failUnsubmitted(claim,error);throw error;}}}];
}
