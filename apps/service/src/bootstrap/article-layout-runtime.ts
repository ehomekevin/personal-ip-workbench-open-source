import {readFileSync,existsSync,lstatSync} from 'node:fs';
import {join,resolve,isAbsolute,relative} from 'node:path';
import {ContractError} from '@workbench/contracts';
import type {ApplicationContext} from '@workbench/domain/ports';
import {ImageStudio} from '../../../../packages/domain/src/artifact-execution/image-studio/index.ts';
import {ImagePlans} from '../../../../packages/domain/src/artifact-execution/image-studio/plan.ts';
import {ArticleLayoutStudio} from '../../../../packages/domain/src/article-layout/studio.ts';
import {ArticleLayoutVisualWorkflow,type ArticleVisualWorkflowOptions} from '../../../../packages/domain/src/article-layout/workflow.ts';
import {loadCommittedLayoutExecution} from '../../../../packages/domain/src/result-commit/article-layout.ts';
import {digest} from '../../../../packages/domain/src/article-layout/index.ts';
import {createHash} from 'node:crypto';
import type {LayoutCheckAuthorityV2} from '../../../../packages/storage/src/article-layout/check-admission.ts';
import {ArticleLayoutRenderer,ARTICLE_LAYOUT_RENDERER_VERSION} from './article-layout-renderer.ts';

export type ArticleLayoutRuntimeOptions=Partial<ArticleVisualWorkflowOptions>&{web_url?:string;standard_png?:string;standard_html?:string};
function privateJson(path:string):unknown{if(!existsSync(path))return null;const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.size>8_000_000)throw new ContractError('CAPABILITY_UNVERIFIED','排版执行配置不可用');return JSON.parse(readFileSync(path,'utf8'));}
/** Authority is installed by the owner, never supplied through HTTP. No default model permission. */
function authority(context:ApplicationContext):LayoutCheckAuthorityV2|undefined{
 const input=privateJson(join(context.paths.state_root,'article-layout-visual-authority.json')) as {authority?:LayoutCheckAuthorityV2;candidate_manifest_path?:string}|null;if(!input)return undefined;
 if(!input.authority||input.authority.scope!=='production'||input.authority.workspace_id!==context.identity.workspace_id||typeof input.candidate_manifest_path!=='string'||!isAbsolute(input.candidate_manifest_path))throw new ContractError('CAPABILITY_UNVERIFIED','排版候选执行授权不符');
 const candidate=JSON.parse(readFileSync(input.candidate_manifest_path,'utf8'));if(candidate.candidate_hash!=='sha256:'+digest(candidate.manifest)||input.authority.candidate_sha256!==digest(candidate.manifest))throw new ContractError('CAPABILITY_UNVERIFIED','排版候选摘要不符');
 const root=resolve(import.meta.dirname,'../../../..');for(const file of candidate.manifest.source_files??[]){const path=resolve(root,file.path),rel=relative(root,path);if(rel.startsWith('..')||isAbsolute(rel)||lstatSync(path).isSymbolicLink()||createHash('sha256').update(readFileSync(path)).digest('hex')!==file.sha256)throw new ContractError('CAPABILITY_UNVERIFIED','排版已加载源码与执行候选不符');}
 if(!Array.isArray(candidate.manifest.source_files)||!candidate.manifest.source_files.length)throw new ContractError('CAPABILITY_UNVERIFIED','排版候选缺少固定源码');return input.authority;
}
const runtimes=new WeakMap<ApplicationContext,ArticleLayoutRuntime>();
export class ArticleLayoutRuntime {
 readonly context:ApplicationContext;readonly image:ImageStudio;readonly studio:ArticleLayoutStudio;readonly workflow:ArticleLayoutVisualWorkflow;private closing:Promise<void>|null=null;
 constructor(context:ApplicationContext,options:ArticleLayoutRuntimeOptions={}){
  this.context=context;
  const config=privateJson(join(context.paths.state_root,'article-layout-visual-runtime.json')) as {web_url?:string}|null;
  const root=join(context.paths.state_root,'article-layout-visual','standards'),web=options.web_url??config?.web_url;
  const renderer=options.renderer??(web?new ArticleLayoutRenderer(context,{web_url:web,standard_png:options.standard_png??join(root,'standard.png'),standard_html:options.standard_html??join(root,'standard.html')}):{async render():Promise<never>{throw new ContractError('CAPABILITY_UNVERIFIED','排版画面服务尚未配置');},async close(){}});
  const grant=options.record_grant??privateJson(join(context.paths.state_root,'article-layout-visual-record-grant.json')) as ArticleVisualWorkflowOptions['record_grant'];
  if(grant&&resolve(grant.root)!==resolve(context.paths.managed_notes_root))throw new ContractError('CAPABILITY_UNVERIFIED','排版记录根与工作区不符');
  this.image=new ImageStudio(context);this.studio=new ArticleLayoutStudio(context,{image:this.image,plans:new ImagePlans(context,this.image),check_source:{load:async id=>loadCommittedLayoutExecution(context,id)},allow_fixture_checks:options.fixture===true});
  this.workflow=new ArticleLayoutVisualWorkflow(context,this.studio,{...options,renderer,renderer_version:options.renderer_version??ARTICLE_LAYOUT_RENDERER_VERSION,...(grant?{record_grant:grant}:{}),authority:options.authority??authority(context)});
 }
 beginClose(){this.workflow.beginClose();this.image.beginClose();}
 close(){return this.closing??=(async()=>{this.beginClose();await this.workflow.close();await this.image.close();})();}
}
export function getArticleLayoutRuntime(context:ApplicationContext,options?:ArticleLayoutRuntimeOptions):ArticleLayoutRuntime{let runtime=runtimes.get(context);if(!runtime){runtime=new ArticleLayoutRuntime(context,options);runtimes.set(context,runtime);}else if(options)throw new Error('ARTICLE_LAYOUT_RUNTIME_ALREADY_CONFIGURED');return runtime;}
