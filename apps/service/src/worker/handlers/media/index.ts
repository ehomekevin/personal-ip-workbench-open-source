import { ArtifactExecution, H3VoiceWorkflow, ImageGenerationWorkflow } from '@workbench/domain/artifact-execution';
import type { ApplicationContext } from '@workbench/domain/ports';
import type { WorkerHandler } from '../../core/index.ts';
export function createMediaHandlers(context:ApplicationContext,options:{image?:ImageGenerationWorkflow}={}):WorkerHandler[]{return[{registration:{kind:'media_generate',execution_mode:'programmatic',recovery:'media'},async execute(execution){
  if(JSON.parse(execution.claim.job.input_manifest).operation==='image_provider'){const output=await (options.image??new ImageGenerationWorkflow(context)).execute(execution.claim,execution.signal,execution.checkpoint);return{documents:[],recommendations:[],generated_assets:[output]};}
  if(JSON.parse(execution.claim.job.input_manifest).operation==='h3_voice'){const output=await new H3VoiceWorkflow(context).execute(execution.claim,execution.signal,execution.checkpoint);return{documents:[],recommendations:[],generated_assets:[output]};}
  const artifacts=await new ArtifactExecution(context).execute(execution.claim,execution.signal,execution.checkpoint);return{documents:[],recommendations:[],artifacts};
}}];}
