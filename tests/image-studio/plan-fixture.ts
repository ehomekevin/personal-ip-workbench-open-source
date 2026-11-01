// 配图方案（A2）测试夹具：真实服务路由 + 注入式网络 + 内容执行器假适配器（不发真实模型/生图调用）。
import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import type {AgentReadiness,AgentRunInput,AgentRunHandle,AgentResult,JsonObject,ImagePlanFrozenInput,ImagePlanSnapshot,ServiceConfiguration} from '../../packages/contracts/src/index.ts';
import {canonical,hash} from '../../packages/adapters/src/agent/codex/primitives.ts';
import {DurableWorker} from '../../apps/service/src/worker/core/index.ts';
import {createContentAgentHandlers} from '../../apps/service/src/worker/handlers/content/index.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import {startStudioFixture} from './harness.ts';
import {FakeWeb,ARTICLE_URL,ARTICLE_HTML,seedWebSources} from './web-fixture.ts';
// 六段、一千多字的定稿：正文图上限 3 张；第 2 段讲原文官方图，第 3 段提到抖音作品（供关键词匹配），第 4 段是流程。
export const PLAN_ARTICLE=[
 '这篇文章讲我怎样把每天的 AI 资讯接进个人工作台，让选题、写稿、配图和排版都在同一个地方完成，不再在七八个软件之间来回切换。过去一条内容从看到资讯到发出去要折腾大半天，现在大部分步骤都能顺着走下来，人只需要在关键处做判断。',
 '先说资讯本身：这次模型发布的原文里附了一张官方配图，把发布会现场、新模型的关键参数和与上一代的对比放在同一张图里。读者看这张图，比读三段参数说明更快明白这次更新到底改了什么，所以这一段后面最适合直接放原文官方配图，并且注明图源。',
 '同题的抖音作品也很有参考价值。有位作者在抖音作品的封面上用一句话总结了这次发布对普通创作者的影响，画面简单但信息清楚。把这张封面放在这里，可以让读者看到不同平台的创作者是怎么理解同一件事的，也方便我后面展开自己的看法。',
 '接下来是工作台的处理流程：先收集资料，再确认选题，然后写稿、配图、排版和审核，一共六个步骤。每一步都有明确的输入和产出，上一步的结果会自动带到下一步，人只在确认选题、定稿和最终提交时出手。这个流程最适合画成一张从左到右的步骤图。',
 '在这套流程里，配图是最容易被忽略的一步。很多时候文章写完了，配图却是随手找的，和正文讲的内容对不上，读者看完也记不住。所以我让 AI 先读完定稿，规划好哪里需要图、图从哪里来，再由我逐张生成和修改，这样每张图都有明确的用途。',
 '为了让这一步真正省事，我给自己定了几条规矩：能用原文或官方图的地方优先用原文图，并且一定写清图源；同题的平台作品只在确实能补充视角时才引用；其余需要解释结构、流程或对比的地方，再交给 AI 生成示意图。生成之后我还会逐张检查画面里的文字是否准确、配色是否符合品牌、图注是否说清了这张图的用途，不合适就改一版或者换一张。',
 '这样做的好处是，配图不再是写完文章之后的临时补救，而是和正文一起被设计出来的。读者在手机上往下滑的时候，每隔几段就能看到一张和内容紧密相关的图，阅读节奏会更舒服；我自己回头复盘时，也能清楚地知道每张图是从哪里来的、当时为什么这样配，下次遇到类似的文章可以直接沿用。',
 '最后，整套工作台仍然以人工判断为准。AI 负责把重复的整理和初稿做好，我负责判断哪些观点值得讲、哪些图能帮读者理解。下一步我会继续把排版和审核接进来，让一篇公众号文章从定稿到提交草稿都能在一个页面里完成。如果你也在做个人内容，不妨先从一件小事开始：每写完一篇，就回头看看哪几处最需要一张图，再想想这张图应该从哪里来，慢慢就会形成自己的配图习惯。',
].join('\n\n');
export class PlanAdapter {
 starts=0;inputs:JsonObject[]=[];respond:((frozen:ImagePlanFrozenInput)=>unknown)|string=defaultPlan;
 async describe(){return [];}
 async checkReadiness():Promise<AgentReadiness>{return {executor_id:'codex',runtime_version:'internal_rule',auth_state:'fixture',billing_route:null,capabilities:[],limitations:['internal_rule only']};}
 async start(input:AgentRunInput):Promise<AgentRunHandle>{this.starts++;this.inputs.push(input.input_manifest as JsonObject);return {runtime_session_id:randomUUID(),runtime_turn_id:randomUUID(),supports_resume:true,checkpoint:{run_input:input as unknown as JsonObject,input_hash:hash(canonical(input.input_manifest))}};}
 async resume(handle:AgentRunHandle){return this.start(handle.checkpoint.run_input as unknown as AgentRunInput);}
 async *streamEvents(handle:AgentRunHandle):AsyncIterable<AgentResult>{const input=handle.checkpoint.run_input as unknown as AgentRunInput,frozen=input.input_manifest.frozen as JsonObject,value=typeof this.respond==='function'?this.respond(frozen.image_plan as unknown as ImagePlanFrozenInput):this.respond,text=typeof value==='string'?value:JSON.stringify(value),output={documents:(frozen.targets as JsonObject[]).map(target=>({document_id:target.document_id,text})),recommendations:[]};
  yield {status:'completed',candidate_documents:output.documents as JsonObject[],evidence_links:[],asset_candidates:[],actual_usage:{},resume_info:{output:output as JsonObject,output_sha256:hash(canonical(output)),native_status:'completed'}} as unknown as AgentResult;}
 async requestInput(){} async cancel(){return {native_interrupt:'internal_rule'};} async close(){}
}
/** 三种来源各至少一条：封面与流程段 AI 生图；原文段用方案给的原文候选；抖音段不给候选 ID，由服务端按段落关键词选。 */
export function defaultPlan(frozen:ImagePlanFrozenInput){
 const p=frozen.paragraphs,article=frozen.candidates.find(c=>c.group==='article_original');
 return {cover:{paragraph_id:p[0]!.id,position:'cover',purpose:'一篇文章从资讯到成稿都在工作台里完成',source_strategy:'ai_generate',aspect:'16:9',prompt_draft:'深海军蓝背景，左侧大标题“把 AI 资讯接进工作台”，右侧是简洁的工作台界面示意，青柠绿强调线。'},
  slots:[{paragraph_id:p[1]!.id,position:'after',purpose:'官方配图：发布会现场与关键参数对比',source_strategy:'article_original',aspect:'16:9',prompt_draft:'模型发布会现场与参数对比示意图，左右两栏对比新旧版本。',...(article?{candidate_id:article.candidate_id}:{})},
   {paragraph_id:p[2]!.id,position:'after',purpose:'同题抖音作品的封面：一句话总结影响',source_strategy:'platform_post',aspect:'3:4',prompt_draft:'竖版封面，一句话总结这次发布对创作者的影响。'},
   {paragraph_id:p[3]!.id,position:'after',purpose:'从收集资料到审核的六步流程',source_strategy:'ai_generate',aspect:'16:9',prompt_draft:'从左到右六个步骤：收集资料、确认选题、写稿、配图、排版、审核，箭头连接，品牌配色。'}]};
}
export function planNetwork(){const web=new FakeWeb();web.html(ARTICLE_URL,ARTICLE_HTML);web.png('https://news.example/og.png',160,90,[11,31,82]);web.png('https://news.example/tw.png',120,120,[204,248,102]);web.png('https://news.example/in2.png',120,90,[91,95,214]);
 web.png('https://pbs.example/x1.png',96,64,[10,20,30]);web.png('https://pbs.example/q1.png',96,64,[30,20,10]);web.png('https://douyin.example/cover.png?x-expires=4102444800',90,120,[226,227,251]);web.png('https://douyin.example/old.png?x-expires=1000000000');return web;}
export async function startPlanFixture(options:{image_generation_limits?:ServiceConfiguration['image_generation_limits'];seed?:boolean;web?:FakeWeb}={}){
 const web=options.web??planNetwork(),f=await startStudioFixture({auto_worker:false,web:{fetcher:web.fetcher,lookup:web.lookup},...(options.image_generation_limits?{image_generation_limits:options.image_generation_limits}:{})});
 try{
  if(options.seed!==false)seedWebSources(f.app.context,f.request(),f.topic.id,{searchText:'同题帖子：'+f.topic.title+' 的配图做法'});
  const saved=await new Documents(f.app.context).save(f.request(),f.document_id,{expected_revision_id:f.document_revision_id,text:PLAN_ARTICLE,origin:'human'});
  const adapter=new PlanAdapter(),worker=new DurableWorker(f.app.context,createContentAgentHandlers(f.app.context,{staging_root:realpathSync(join(f.app.context.paths.state_root,'generation-staging')),createAdapter:()=>adapter as never}));
  const json=async<T>(response:Response,status=200):Promise<T>=>{const value=await response.json();if(response.status!==status)throw new Error('HTTP '+response.status+' '+JSON.stringify(value));return value as T;};
  const plan=()=>f.call('GET','/api/v1/image-studio/plan?topic_id='+f.topic.id).then(r=>json<ImagePlanSnapshot>(r));
  const run=async(body:{replan:boolean;executor?:'codex'|'claude'},key=randomUUID(),expected?:number)=>f.call('POST','/api/v1/image-studio/plan/runs',{topic_id:f.topic.id,expected_version:expected??(await plan()).version,...body},key);
  const update=async(item:string,body:Record<string,unknown>,key=randomUUID(),expected?:number)=>f.call('POST','/api/v1/image-studio/plan/items/'+item,{topic_id:f.topic.id,expected_version:expected??(await plan()).version,...body},key);
  const planJobs=()=>f.app.context.db.prepare("SELECT * FROM jobs WHERE kind='image_plan' ORDER BY rowid").all() as Array<{id:string;state:string;executor_id:string;execution_mode:string;input_manifest:string}>;
  return {...f,web,adapter,worker,json,plan,run,update,planJobs,article_revision_id:saved.revision_id,async complete(){return worker.runOnce();}};
 }catch(error){await f.close();throw error;}
}
