import type { ApiError, DocumentSnapshot, HostBridge, PatchSettingsRequest, SaveRevisionRequest, SaveRevisionResponse, ServiceIdentity, SettingsResponse } from '@workbench/contracts';

export interface RequestOptions { signal?:AbortSignal; idempotencyKey?:string }
export interface WorkbenchClient {
  invalidateReads?():void;
  assetContent?(id:string,signal?:AbortSignal):Promise<Blob>;
  upload?<T>(path:string,file:File,fields:Readonly<Record<string,string>>,options?:RequestOptions):Promise<T>;
  identity(signal?:AbortSignal):Promise<ServiceIdentity>;
  getSettings(signal?:AbortSignal):Promise<SettingsResponse>;
  patchSettings(input:PatchSettingsRequest,options?:RequestOptions):Promise<SettingsResponse>;
  getDocument(id:string,signal?:AbortSignal):Promise<DocumentSnapshot>;
  saveDocument(id:string,input:SaveRevisionRequest,options?:RequestOptions):Promise<SaveRevisionResponse>;
  cancelJob(id:string,expectedVersion:number,options?:RequestOptions):Promise<unknown>;
  request<T>(method:'GET'|'POST'|'PATCH'|'PUT',path:string,body?:unknown,options?:RequestOptions):Promise<T>;
}
export class WorkbenchTransportError extends Error {
  readonly status:number;
  readonly response:ApiError;
  constructor(status:number,response:ApiError){super(response.error.message);this.status=status;this.response=response;}
}
export function createHttpClient(baseUrl='',expectedIdentity?:ServiceIdentity,fetcher:typeof fetch=fetch):WorkbenchClient {
  let identity:ServiceIdentity|undefined;
  async function handshake(signal?:AbortSignal){
    const response=await fetcher(baseUrl+'/api/v1/identity',{signal});
    if(!response.ok)throw new Error('无法读取工作区身份');
    const value=await response.json() as ServiceIdentity;
    if(expectedIdentity&&(value.workspace_id!==expectedIdentity.workspace_id||value.service_instance_id!==expectedIdentity.service_instance_id))throw new Error('WORKSPACE_INSTANCE_MISMATCH');
    identity=value;return value;
  }
  async function request<T>(method:'GET'|'POST'|'PATCH'|'PUT',path:string,body?:unknown,options:RequestOptions={}):Promise<T>{
    const context=identity??await handshake(options.signal);
    const headers:Record<string,string>={'Content-Type':'application/json','X-Workspace-Id':context.workspace_id,'X-Service-Instance-Id':context.service_instance_id,'X-Request-Id':crypto.randomUUID()};
    if(options.idempotencyKey)headers['Idempotency-Key']=options.idempotencyKey;
    const response=await fetcher(baseUrl+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:options.signal});
    const value:unknown=await response.json();
    if(!response.ok)throw new WorkbenchTransportError(response.status,value as ApiError);
    return value as T;
  }
  async function upload<T>(path:string,file:File,fields:Readonly<Record<string,string>>,options:RequestOptions={}):Promise<T>{
    const context=identity??await handshake(options.signal),headers:Record<string,string>={'X-Workspace-Id':context.workspace_id,'X-Service-Instance-Id':context.service_instance_id,'X-Request-Id':crypto.randomUUID(),'Idempotency-Key':options.idempotencyKey??crypto.randomUUID()},body=new FormData();
    body.append('file',file);for(const [key,value] of Object.entries(fields))body.append(key,value);
    const response=await fetcher(baseUrl+path,{method:'POST',headers,body,signal:options.signal}),value:unknown=await response.json();if(!response.ok)throw new WorkbenchTransportError(response.status,value as ApiError);return value as T;
  }
  async function assetContent(id:string,signal?:AbortSignal):Promise<Blob>{
    const context=identity??await handshake(signal),response=await fetcher(baseUrl+'/api/v1/assets/'+encodeURIComponent(id)+'/content',{signal,headers:{'X-Workspace-Id':context.workspace_id,'X-Service-Instance-Id':context.service_instance_id,'X-Request-Id':crypto.randomUUID()}});
    if(!response.ok)throw new Error('声音素材暂不可读');
    if(!response.body)throw new Error('声音素材没有内容');
    const parts:Uint8Array<ArrayBuffer>[]=[],reader=response.body.getReader();let size=0;
    try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>32*1024*1024)throw new Error('试听素材超过 32 MiB');parts.push(new Uint8Array(chunk.value));}}finally{await reader.cancel();reader.releaseLock();}
    return new Blob(parts,{type:response.headers.get('content-type')??'audio/flac'});
  }
  return {identity:handshake,request,upload,assetContent,getSettings:signal=>request('GET','/api/v1/settings',undefined,{signal}),patchSettings:(input,options)=>request('PATCH','/api/v1/settings',input,options),getDocument:(id,signal)=>request('GET','/api/v1/documents/'+encodeURIComponent(id),undefined,{signal}),saveDocument:(id,input,options)=>request('POST','/api/v1/documents/'+encodeURIComponent(id)+'/revisions',input,options),cancelJob:(id,expected_version,options)=>request('POST','/api/v1/jobs/'+encodeURIComponent(id)+'/cancel',{expected_version},options)};
}
// 宿主注入时走共享桥接；不拥有存储，也不触发原生执行器的安装或设置。
export interface HostToolRequest { name:string; input:import('@workbench/contracts').JsonObject }
export type HostRouteMapper=(method:'GET'|'POST'|'PATCH'|'PUT',path:string,body:unknown,options?:RequestOptions)=>HostToolRequest;
export function createHostClient(bridge:HostBridge,resolveTool:HostRouteMapper):WorkbenchClient {
  // WP-23按已注册工具schema提供映射；这里不建立任意HTTP代理工具。
  const request:WorkbenchClient['request']=async<T>(method:'GET'|'POST'|'PATCH'|'PUT',path:string,body?:unknown,options?:RequestOptions):Promise<T>=>{const tool=resolveTool(method,path,body,options);return await bridge.callTool(tool.name,tool.input) as T;};
  return {identity:async()=> (await bridge.describeCapabilities()).identity,request,getSettings:()=>request('GET','/api/v1/settings'),patchSettings:(input,options)=>request('PATCH','/api/v1/settings',input,options),getDocument:id=>request('GET','/api/v1/documents/'+encodeURIComponent(id)),saveDocument:(id,input,options)=>request('POST','/api/v1/documents/'+encodeURIComponent(id)+'/revisions',input,options),cancelJob:(id,expected_version,options)=>request('POST','/api/v1/jobs/'+encodeURIComponent(id)+'/cancel',{expected_version},options)};
}
