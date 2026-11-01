import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {CONTRACT_VERSION,type RequestContext,type ServiceConfiguration,type ImageGenerationRequest,type JsonObject} from '../../packages/contracts/src/index.ts';
import {openWorkspaceStorage} from '../../packages/storage/src/connection/index.ts';
import type {ApplicationContext} from '../../packages/domain/src/ports/index.ts';
import {Topics} from '../../packages/domain/src/topics/index.ts';
import {ImageProviderSettings} from '../../packages/domain/src/settings/image-providers.ts';
import type {ImageProviderPort,ImageProviderInput,ImageProviderResult} from '../../packages/adapters/src/media/image/index.ts';
import {baseCheckpoint} from '../../packages/adapters/src/media/image/common.ts';
import {writeSolidPng} from '../helpers/png.ts';
export function fixture(keep=false){const root=mkdtempSync(join(resolve(import.meta.dirname),'.integration-')),paths={source_vault_root:null,managed_notes_root:join(root,'notes'),state_root:join(root,'state'),media_root:join(root,'media')};for(const p of Object.values(paths))if(p)mkdirSync(p,{recursive:true});
  const config:ServiceConfiguration={workspace_id:randomUUID(),service_instance_id:randomUUID(),title:'隔离图像工作台',mode:'real',timezone:'America/Los_Angeles',paths,listen:{host:'127.0.0.1',port:0},default_executor:'codex',api_fallback_enabled:false},configPath=join(root,'config.json');writeFileSync(configPath,JSON.stringify(config));
  const storage=openWorkspaceStorage(join(paths.state_root,'workbench.sqlite'));storage.db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,?,?,?,?,1)').run(config.workspace_id,config.workspace_id,config.title,config.timezone,JSON.stringify(paths),config.mode);
  const identity={workspace_id:config.workspace_id,service_instance_id:config.service_instance_id,contract_version:CONTRACT_VERSION},context:ApplicationContext={db:storage.db,identity,config,paths,getExecutorHealth:async()=>[]};
  return{root,config,configPath,context,request:(key:string=randomUUID()):RequestContext=>({...identity,request_id:randomUUID(),idempotency_key:key,request_identity_ref:'image-integration-test'}),cleanup(){storage.close();if(!keep)rmSync(root,{recursive:true,force:true});}};
}
export async function seeded(f:ReturnType<typeof fixture>){const topic=await new Topics(f.context).create(f.request(),{title:'图像渠道隔离验证',category:'AI实践',audience:'AI使用者',source_ids:[]});const settings=new ImageProviderSettings(f.context);settings.save(f.request(),{expected_version:1,default_provider:'agy',enabled:{agy:true,codex:true}});return{topic,input:{generator:'image',provider:'agy',operation:'generate',topic_id:topic.id,purpose:'图像能力验证',prompt:'A lime ceramic cube on a navy desk.',input_asset_ids:[],parent_asset_id:null,document_revision_id:null,plan_revision_id:null} as ImageGenerationRequest};}
export class FakeImageProvider implements ImageProviderPort {
  readonly id='agy' as const;submits=0;queries=0;hold:Promise<void>|null=null;disconnect=false;noId=false;last:ImageProviderInput|null=null;
  describe(){return Promise.resolve({configured:true});}
  async execute(input:ImageProviderInput,options:{signal:AbortSignal;checkpoint:(value:JsonObject)=>void}):Promise<ImageProviderResult>{this.submits++;this.last=input;const cp={...baseCheckpoint(input),conversation_id:'fixture-'+input.binding.job_id};if(!this.noId)options.checkpoint(cp);if(this.hold)await this.hold;if(this.disconnect||this.noId)throw new Error('fixture submit result unknown');return this.output(input,cp);}
  async query(input:ImageProviderInput,checkpoint:JsonObject):Promise<ImageProviderResult>{this.queries++;if(!checkpoint.conversation_id||checkpoint.input_hash!==input.binding.input_hash)throw new Error('fixture no original identity');return this.output(input,checkpoint);}
  output(input:ImageProviderInput,checkpoint:JsonObject={...baseCheckpoint(input),conversation_id:'fixture-'+input.binding.job_id}):ImageProviderResult{mkdirSync(input.output_directory,{recursive:true});const path=join(input.output_directory,'fixture.png');writeSolidPng(path,32,32);const bytes=readFileSync(path);return{file_path:path,mime:'image/png',width:32,height:32,sha256:createHash('sha256').update(bytes).digest('hex'),size_bytes:bytes.length,model:'gemini-3.1-flash-image',native:structuredClone(checkpoint),usage:null};}
}
