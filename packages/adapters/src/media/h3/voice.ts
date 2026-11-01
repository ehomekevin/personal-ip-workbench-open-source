import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { ContractError, type JsonObject } from '@workbench/contracts';

export interface VoiceProfile { id:string; endpoint:string; reference_filename:string; reference_path:string; reference_sha256:string; skill_path:string; skill_sha256:string; manual_path:string; manual_sha256:string; template_path:string; template_sha256:string }
export interface FrozenVoiceProfile { id:string; endpoint:string; reference_filename:string; reference_sha256:string; skill_name:'h3-voice-production'; skill_sha256:string; skill_content:string; manual_sha256:string; manual_content:string; template_sha256:string; template:JsonObject }
export interface VoiceRemoteFile { filename:string;subfolder:string;type:'output' }
export const digest=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])):value;
const sameGraph=(left:unknown,right:unknown)=>JSON.stringify(stable(left))===JSON.stringify(stable(right));
function endpoint(value:string):string {
  const url=new URL(value),host=url.hostname;
  const privateHost=host==='localhost'||host==='127.0.0.1'||/^10\./.test(host)||/^192\.168\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if(!['http:','https:'].includes(url.protocol)||!privateHost||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new ContractError('VALIDATION_ERROR','H3 地址需要明确的本地或私有网络服务根地址');
  return url.origin;
}
export function freezeVoiceProfile(path=process.env.WORKBENCH_H3_VOICE_PROFILE):FrozenVoiceProfile {
  if(!path)throw new ContractError('CAPABILITY_UNVERIFIED','先配置本地 H3 声音服务与本人参考');
  const p=JSON.parse(readFileSync(path,'utf8')) as VoiceProfile;
  if(typeof p.id!=='string'||!p.id||typeof p.reference_filename!=='string'||!p.reference_filename||/[\\/:\r\n]/.test(p.reference_filename))throw new ContractError('VALIDATION_ERROR','声音配置或参考文件名无效');
  const read=(file:string,hash:string,limit:number)=>{
    if(!file||lstatSync(file).isSymbolicLink()||realpathSync(file)!==file||lstatSync(file).size>limit)throw new ContractError('VALIDATION_ERROR','声音输入必须为有界的真实文件');
    const bytes=readFileSync(file);if(digest(bytes)!==hash)throw new ContractError('INPUT_STALE','声音输入已变化，需要重新核对配置');return bytes;
  };
  read(p.reference_path,p.reference_sha256,32*1024*1024);
  const skill=read(p.skill_path,p.skill_sha256,65536).toString('utf8'),manual=read(p.manual_path,p.manual_sha256,65536).toString('utf8'),template=JSON.parse(read(p.template_path,p.template_sha256,65536).toString('utf8')) as JsonObject;
  if(!/^name: h3-voice-production$/m.test(skill))throw new ContractError('VALIDATION_ERROR','不是当前已选的声音制作技能');
  const node=(id:string)=>template[id] as {class_type?:string;inputs?:JsonObject}|undefined;
  if(node('6')?.class_type!=='MiniMaxH3ReferenceToVideo'||node('5')?.class_type!=='LoadAudio'||node('14')?.class_type!=='SaveAudio'||!String(node('6')?.inputs?.prompt).includes('{{dialogue}}'))throw new ContractError('VALIDATION_ERROR','H3 模板与已通过声音节点不一致');
  return {id:p.id,endpoint:endpoint(p.endpoint),reference_filename:p.reference_filename,reference_sha256:p.reference_sha256,skill_name:'h3-voice-production',skill_sha256:p.skill_sha256,skill_content:skill,manual_sha256:p.manual_sha256,manual_content:manual,template_sha256:p.template_sha256,template};
}
export function voiceGraph(profile:FrozenVoiceProfile,text:string,frames:number,prefix:string):JsonObject {
  if(!text.trim()||text.length>400||/<\/?d>|<\|/.test(text)||!Number.isInteger(frames)||frames<124||frames>362||(frames-5)%17||!/^workbench-voice\/[a-z0-9-]+$/.test(prefix))throw new ContractError('VALIDATION_ERROR','台词、窗口或输出标识无效');
  const graph=structuredClone(profile.template),inputs=(id:string)=>(graph[id] as {inputs:JsonObject}).inputs;
  inputs('6').prompt=String(inputs('6').prompt).replace('{{dialogue}}',()=>text);inputs('6').length=frames;inputs('5').audio=profile.reference_filename;inputs('14').filename_prefix=prefix;
  return graph;
}
export class ComfyVoice {
  readonly base:string;readonly fetcher:typeof fetch;
  constructor(base:string,options:{fetch?:typeof fetch}={}){this.base=endpoint(base);this.fetcher=options.fetch??fetch;}
  private async request(path:string,init:RequestInit={},timeout=5000):Promise<Response>{
    const signal=init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);
    return this.fetcher(this.base+path,{...init,signal,redirect:'error'});
  }
  private async json(path:string,init:RequestInit={}):Promise<JsonObject>{const res=await this.request(path,init);if(!res.ok)throw new ContractError('CAPABILITY_UNVERIFIED','H3 服务返回错误',{http_status:res.status});const text=await res.text();if(Buffer.byteLength(text)>8*1024*1024)throw new ContractError('VALIDATION_ERROR','H3 回应过大');return JSON.parse(text) as JsonObject;}
  async readiness(profile:FrozenVoiceProfile):Promise<{running:number;pending:number}>{
    const [nodes,queue]=await Promise.all([this.json('/object_info'),this.json('/queue')]);
    for(const value of Object.values(profile.template)){
      const node=value as {class_type:string;inputs:JsonObject},definition=nodes[node.class_type] as {input?:{required?:Record<string,unknown[]>}}|undefined;
      if(!definition)throw new ContractError('CAPABILITY_UNVERIFIED','当前 H3 缺少模板节点',{node:node.class_type});
      for(const [name,value]of Object.entries(node.inputs)){const choices=definition.input?.required?.[name]?.[0];if(Array.isArray(choices)&&typeof value==='string'&&!choices.includes(name==='audio'&&node.class_type==='LoadAudio'?profile.reference_filename:value))throw new ContractError('CAPABILITY_UNVERIFIED','当前 H3 模型或本人参考不可用',{node:node.class_type,input:name});}
    }
    const reference=await this.request('/view?'+new URLSearchParams({filename:profile.reference_filename,subfolder:'',type:'input'}));if(!reference.ok||!reference.body)throw new ContractError('CAPABILITY_UNVERIFIED','本人声音参考无法读取');
    const hash=createHash('sha256');let bytes=0;for await(const chunk of reference.body){bytes+=chunk.byteLength;if(bytes>32*1024*1024)throw new ContractError('VALIDATION_ERROR','本人参考超过范围');hash.update(chunk);}
    if(hash.digest('hex')!==profile.reference_sha256)throw new ContractError('INPUT_STALE','远端本人参考与已核对的参考不同');
    return {running:Array.isArray(queue.queue_running)?queue.queue_running.length:0,pending:Array.isArray(queue.queue_pending)?queue.queue_pending.length:0};
  }
  async submit(graph:JsonObject,tag:string,signal:AbortSignal):Promise<string>{
    try{const res=await this.request('/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:graph,client_id:tag,extra_data:{workbench_voice_id:tag}}),signal},20000);const data=await res.json() as {prompt_id?:string;node_errors?:JsonObject};
      if(!res.ok||!data.prompt_id||Object.keys(data.node_errors??{}).length)throw new ContractError('RESULT_UNKNOWN','H3 提交结果需要核对',{http_status:res.status,node_errors:data.node_errors??{}});
      return data.prompt_id;
    }catch(error){if(error instanceof ContractError)throw error;throw new ContractError('RESULT_UNKNOWN','未确认 H3 提交回执；只核对原任务，不重复生成');}
  }
  async find(tag:string,graph:JsonObject):Promise<string|null>{
    const [queue,history]=await Promise.all([this.json('/queue'),this.json('/history?max_items=200')]);
    const rows=[...(queue.queue_running as unknown[][]??[]),...(queue.queue_pending as unknown[][]??[]),...Object.values(history).map(value=>(value as {prompt?:unknown[]}).prompt??[])];
    const matches=rows.filter(row=>(row[3] as {workbench_voice_id?:string})?.workbench_voice_id===tag&&sameGraph(row[2],graph));
    const ids=[...new Set(matches.map(row=>String(row[1])))];if(ids.length>1)throw new ContractError('RESULT_UNKNOWN','同一声音标识存在多个远端任务，需人工核对');return ids[0]??null;
  }
  async query(id:string,tag:string,graph:JsonObject,signal?:AbortSignal):Promise<{state:'running'|'succeeded'|'failed';file?:VoiceRemoteFile}>{
    const data=await this.json('/history/'+encodeURIComponent(id),{signal}),record=data[id] as {prompt?:unknown[];outputs?:Record<string,{audio?:VoiceRemoteFile[]}>;status?:{completed?:boolean;status_str?:string}}|undefined;
    if(!record)return {state:'running'};
    if(String(record.prompt?.[1])!==id||(record.prompt?.[3] as {workbench_voice_id?:string})?.workbench_voice_id!==tag||!sameGraph(record.prompt?.[2],graph))throw new ContractError('RESULT_UNKNOWN','H3 原任务与固定台词/标识不符');
    if(record.status?.status_str==='error')return {state:'failed'};
    const files=Object.values(record.outputs??{}).flatMap(output=>output.audio??[]);
    if(!record.status?.completed)return {state:'running'};
    if(files.length!==1||!files[0])throw new ContractError('RESULT_UNKNOWN','H3 已完成任务没有唯一原始声音文件');
    const file=files[0];if(file.type!=='output'||!file.filename.endsWith('.flac')||/[\\/]/.test(file.filename)||file.subfolder.split('/').some(part=>part==='..'||part==='.'))throw new ContractError('VALIDATION_ERROR','H3 声音资源位置无效');
    return {state:'succeeded',file};
  }
  async *download(file:VoiceRemoteFile,signal:AbortSignal):AsyncIterable<Uint8Array>{
    const res=await this.request('/view?'+new URLSearchParams({...file}),{signal},30000);if(!res.ok||!res.body)throw new ContractError('CAPABILITY_UNVERIFIED','H3 原始音频无法读取');
    let total=0;for await(const chunk of res.body){total+=chunk.byteLength;if(total>32*1024*1024)throw new ContractError('VALIDATION_ERROR','H3 声音文件超过本阶段上限');signal.throwIfAborted();yield chunk;}
  }
}
