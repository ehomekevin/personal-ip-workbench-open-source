import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { ContractError, parseSkillMarkdown, type RequestContext, type SkillLibraryResponse, type LocalSkillView, type SkillSamplePage, type CreateSkillDraftRequest, type JsonObject, type SkillPurpose } from '@workbench/contracts';
import { sha256 } from '@workbench/storage/connection';
import { workspaceSettings } from '@workbench/storage/settings';
import { VaultAdapter, parseVaultMarkdown } from '@workbench/adapters/vault';
import { assertRequestIdentity } from '../documents/index.ts';
import evaluations from './local-evaluation.json' with { type: 'json' };
import type { ApplicationContext } from '../ports/index.ts';

// 按职责筛选当前本地库，版本与正文每次从文件读取；不执行技能脚本。
const entries:Array<{name:string;label:string;purposes:SkillPurpose[];nodes:string[];mode:LocalSkillView['reuse_mode']}>=[
  {name:'personal-ip-writing',label:'个人 IP 写作',purposes:['core','variant'],nodes:['script','spoken'],mode:'derive'},
  {name:'shengcai-essence-writer',label:'生财社区写作',purposes:['core','variant'],nodes:['script'],mode:'derive'},
  {name:'general-video',label:'HyperFrames 综合视频',purposes:[],nodes:['edit'],mode:'workflow'},
  {name:'cheat-on-content',label:'观点视频预测闭环',purposes:[],nodes:['retro'],mode:'workflow'},
  {name:'personal-ip-visuals',label:'个人 IP 配图',purposes:['variant'],nodes:['visual','cover'],mode:'workflow'},
  {name:'personal-ip-operations',label:'个人 IP 运营',purposes:['report','research'],nodes:['strategy','retro'],mode:'derive'},
  {name:'h3-voice-clone',label:'建立本人声音参考',purposes:[],nodes:['voice_reference'],mode:'workflow'},
  {name:'h3-voice-production',label:'H3 口播声音',purposes:[],nodes:['voice'],mode:'workflow'},
  {name:'h3-digital-human',label:'H3 数字人口播',purposes:[],nodes:['avatar'],mode:'workflow'},
  {name:'minimax-broll-generator',label:'补充讲解画面',purposes:[],nodes:['broll'],mode:'workflow'},
  {name:'jianying-ai-tutorial-editor',label:'教程视频剪辑',purposes:[],nodes:['edit','subtitles'],mode:'workflow'},
  {name:'short-video-bgm',label:'口播配乐',purposes:[],nodes:['music'],mode:'workflow'},
  {name:'short-video-review',label:'最终成片审查',purposes:[],nodes:['review'],mode:'workflow'},
  {name:'qiuzhi-cover',label:'真人场景封面',purposes:[],nodes:['cover'],mode:'workflow'},
  ...['draft','brief','revise','review','image-brief','precheck','retro','evolve','flow-spoken-douyin'].map(name=>({name:'ipos-'+name,label:'ipos-'+name,purposes:[] as SkillPurpose[],nodes:[name],mode:'host' as const})),
];
const nodeDefinitions:Array<Omit<SkillLibraryResponse['video_nodes'][number],'default_skill'>>=[
  {id:'script',label:'选题与脚本',skills:['personal-ip-writing','ipos-brief','ipos-draft'],required_input:'主题、本人判断、固定资料与原稿',execution_status:'not_connected'},
  {id:'spoken',label:'口播与断句',skills:['personal-ip-writing','ipos-flow-spoken-douyin'],required_input:'定稿、语义段与拟用语气；实际朗读后核对',execution_status:'not_connected'},
  {id:'voice_reference',label:'本人声音参考（按需）',skills:['h3-voice-clone'],required_input:'本人授权的可用录音；已有有效参考时复用',execution_status:'not_connected'},
  {id:'voice',label:'声音制作',skills:['h3-voice-production'],required_input:'已确认口播稿、本人参考与声音制作节点',execution_status:'not_connected'},
  {id:'avatar',label:'数字人口播',skills:['h3-digital-human'],required_input:'已通过音轨、本人形象参考、动作和 H3 节点',execution_status:'not_connected'},
  {id:'visual',label:'品牌配图',skills:['personal-ip-visuals'],required_input:'对应段落、真实录屏或示意需求、品牌模板',execution_status:'not_connected'},
  {id:'cover',label:'视频独立封面',skills:['qiuzhi-cover','personal-ip-visuals'],required_input:'定稿看点、本人身份参考、平台比例与品牌要求',execution_status:'not_connected'},
  {id:'broll',label:'讲解画面',skills:['minimax-broll-generator','general-video'],required_input:'已确认段落、真实录屏、时间戳与所需素材',execution_status:'not_connected'},
  {id:'music',label:'口播配乐（按需）',skills:['short-video-bgm'],required_input:'完整音轨与配乐方向；按口播节奏处理',execution_status:'not_connected'},
  {id:'edit',label:'字幕、配乐与剪辑',skills:['jianying-ai-tutorial-editor','general-video'],required_input:'已确认素材、真实时间轴与剪辑工程',execution_status:'not_connected'},
  {id:'review',label:'成片复核',skills:['short-video-review','ipos-precheck'],required_input:'最终导出、脚本和可连续看听的媒体',execution_status:'not_connected'},
];
export interface SkillLibraryOptions { roots?:string[] }
interface Source {view:LocalSkillView;directory:string;content:string}
const filenameCache=new Map<string,{expires:number;files:Promise<string[]>}>();
export class SkillLibrary {
  readonly context:ApplicationContext;readonly roots:string[];
  constructor(context:ApplicationContext,options:SkillLibraryOptions={}){this.context=context;this.roots=options.roots??[join(homedir(),'.agents/skills'),join(homedir(),'.codex/skills')];}
  private sources():Source[]{const found:Source[]=[];for(const entry of entries){for(const root of this.roots){const path=join(root,entry.name,'SKILL.md');if(!existsSync(path))continue;try{const directory=realpathSync(join(root,entry.name));if(realpathSync(path)!==join(directory,'SKILL.md'))continue;const content=readFileSync(path,'utf8');const parsed=parseSkillMarkdown(content,'0.1.0'),assessment=(evaluations as Record<string,{sha256:string;selection:string;reason:string}>)[parsed.name],reviewed=assessment?.sha256===sha256(content);const references=[...new Set([...content.matchAll(/\]\(([^)]+)\)/g)].map(match=>match[1]!).filter(ref=>!ref.startsWith('/')&&!/^[a-z]+:/i.test(ref)))];found.push({directory,content,view:{id:sha256(root+':'+entry.name),name:parsed.name,label:entry.label,description:parsed.description,sha256:sha256(content),purposes:entry.purposes,nodes:entry.nodes,reference_count:references.length,reuse_mode:entry.mode,default_selected:reviewed&&assessment.selection==='default',selection_reason:reviewed?assessment.reason:'本地正文已变化或尚未评估，保留手动接入'}});}catch{/* 畸形或超限技能不冒充已可复用。 */}break;}}return found;}
  get(request:RequestContext):SkillLibraryResponse{assertRequestIdentity(this.context,request);const skills=this.sources().map(item=>item.view);return {identity:this.context.identity,skills,vault_root:workspaceSettings(this.context.db,request.workspace_id).paths.source_vault_root,video_nodes:nodeDefinitions.map(node=>{const names=node.skills.filter(name=>skills.some(skill=>skill.name===name));return {...node,execution_status:node.id==='voice'&&skills.some(skill=>skill.name==='h3-voice-production'&&skill.default_selected)?'implemented':'not_connected',skills:names,default_skill:names.includes(node.skills[0]!)&&skills.some(skill=>skill.name===node.skills[0]&&skill.default_selected)?node.skills[0]!:null};})};}
  source(request:RequestContext,id:string):LocalSkillView&{content:string}{assertRequestIdentity(this.context,request);const source=this.sources().find(item=>item.view.id===id);if(!source)throw new ContractError('NOT_FOUND','本地技能未找到或已变化');return {...source.view,content:source.content};}
  private root(request:RequestContext){const root=workspaceSettings(this.context.db,request.workspace_id).paths.source_vault_root;if(!root)throw new ContractError('CAPABILITY_UNVERIFIED','先在设置页连接个人 IP 的 Obsidian 源库');return root;}
  private async filenames(root:string):Promise<string[]>{if(!filenameCache.has(root)||filenameCache.get(root)!.expires<Date.now()){const operation=(async()=>{if(await realpath(root)!==resolve(root)||(await lstat(root)).isSymbolicLink())throw new ContractError('VALIDATION_ERROR','源库必须为已配置的真实只读目录');const files:string[]=[];const walk=async(directory:string)=>{for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.isSymbolicLink()||entry.name.startsWith('.'))continue;const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else if(entry.isFile()&&entry.name.endsWith('.md'))files.push(relative(root,path).split(sep).join('/'));if(files.length>300000)throw new ContractError('VALIDATION_ERROR','源库文件过多，请收窄源库范围');}};for(const part of ['10-sources','40-content','60-retros','00-home']){const path=join(root,part);if(existsSync(path))await walk(path);}return files.sort();})();filenameCache.set(root,{expires:Date.now()+60000,files:operation});operation.catch(()=>{if(filenameCache.get(root)?.files===operation)filenameCache.delete(root);});}return filenameCache.get(root)!.files;}
  async samples(request:RequestContext,query:string):Promise<SkillSamplePage>{assertRequestIdentity(this.context,request);if(query.trim().length<2||query.length>100)throw new ContractError('VALIDATION_ERROR','输入至少两个字，按账号或标题查找样本');const root=this.root(request),files=await this.filenames(root),matching=files.filter(path=>path.toLowerCase().includes(query.trim().toLowerCase())),items:SkillSamplePage['items']=[];for(const path of matching.slice(0,30)){try{const input=await this.readSample(root,path),parsed=parseVaultMarkdown(path,input.bytes),front=parsed.payload.provider_metadata.frontmatter as JsonObject;items.push({id:sha256(root+':'+path),sha256:input.sha256,title:parsed.payload.title,relative_path:path,author:parsed.payload.author_name??null,status:typeof front.status==='string'?front.status:null,source_type:typeof front.source_type==='string'?front.source_type:null,summary:parsed.payload.summary});}catch{/* 跳过正在变化、越界或过大的样本。 */}}return {identity:this.context.identity,items,matched:matching.length,has_more:matching.length>30};}
  private async readSample(root:string,path:string){const absolute=resolve(root,path),stat=await lstat(absolute);if(stat.size>65536)throw new ContractError('VALIDATION_ERROR','样本超过 64 KiB，请选对应的小篇目');return new VaultAdapter(root).read({path:absolute,relative_path:path,size:stat.size,mtime:Math.floor(stat.mtimeMs)});}
  async freeze(request:RequestContext,input:CreateSkillDraftRequest):Promise<JsonObject>{assertRequestIdentity(this.context,request);const result:JsonObject={};if(input.base_local_skill){const source=this.sources().find(item=>item.view.id===input.base_local_skill!.id);if(!source||source.view.sha256!==input.base_local_skill.sha256)throw new ContractError('INPUT_STALE','本地技能已经变化，请重新选择');if(source.view.reuse_mode!=='derive'||!source.view.purposes.includes(input.purpose))throw new ContractError('CAPABILITY_UNVERIFIED','这个技能需要对应工作流或宿主，不能改称普通文字技能');const references:JsonObject[]=[],seen=new Set<string>();for(const match of source.content.matchAll(/\]\(([^)]+)\)/g)){const path=match[1]!;if(seen.has(path))continue;seen.add(path);if(path.startsWith('/')||/^[a-z]+:/i.test(path))continue;const absolute=resolve(source.directory,path);if(!absolute.startsWith(source.directory+sep)||!existsSync(absolute)||realpathSync(absolute)!==absolute||!absolute.endsWith('.md'))continue;const text=await readFile(absolute,'utf8');if(Buffer.byteLength(text)>65536)throw new ContractError('VALIDATION_ERROR','技能参考文件过大');references.push({relative_path:path,sha256:sha256(text),content:text});if(references.length>12)throw new ContractError('VALIDATION_ERROR','技能参考文件过多，请收窄改进范围');}result.base_local_skill={name:source.view.name,sha256:source.view.sha256,content:source.content,references};}
    if(input.sample_selections?.length){const root=this.root(request),files=await this.filenames(root),paths=new Map<string,string>(files.map(path=>[sha256(root+':'+path),path])),samples:JsonObject[]=[];for(const selected of input.sample_selections){const path=paths.get(selected.id);if(!path)throw new ContractError('NOT_FOUND','样本不属于本次源库');const read=await this.readSample(root,path);if(read.sha256!==selected.sha256)throw new ContractError('INPUT_STALE','样本已变化，请重新选择');samples.push({relative_path:path,sha256:read.sha256,polarity:selected.polarity,reason:selected.reason,content:new TextDecoder().decode(read.bytes)});}result.samples=samples;}
    if(Buffer.byteLength(JSON.stringify(result))>524288)throw new ContractError('VALIDATION_ERROR','技能与样本总量超过 512 KiB，请减少样本');return result;}
}
