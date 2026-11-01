import { WebSocket,EnvHttpProxyAgent } from 'undici';
import { channel } from 'node:diagnostics_channel';
import { createHash } from 'node:crypto';
import { ArkAgentPlanAsr,ARK_ASR_ENDPOINTS,type AsrConnector } from '../../../../packages/adapters/src/media/asr/ark.ts';
import { readLocalCredential } from './configuration/credentials.ts';
import type { ApplicationContext } from '@workbench/domain/ports';
export function createArkAsrConnector(options:{onFrame?:(bytes:Uint8Array)=>void}={}):AsrConnector {return (url,headers)=>{
  if(!Object.values(ARK_ASR_ENDPOINTS).includes(url as typeof ARK_ASR_ENDPOINTS.live))throw new Error('ASR 仅允许 Agent Plan 专用地址');
  const socket=new WebSocket(url,{headers,...(process.env.HTTPS_PROXY||process.env.HTTP_PROXY||process.env.https_proxy||process.env.http_proxy?{dispatcher:new EnvHttpProxyAgent()}: {})});socket.binaryType='arraybuffer';let logId:string|null=null;
  const opened=channel('undici:websocket:open'),onOpen=(event:unknown)=>{const value=event as {websocket:unknown;handshakeResponse:{headers:Record<string,string>}};if(value.websocket===socket){logId=Object.entries(value.handshakeResponse.headers).find(([name])=>name.toLowerCase()==='x-tt-logid')?.[1]??null;opened.unsubscribe(onOpen);}};
  opened.subscribe(onOpen);
  const ready=new Promise<void>((resolve,reject)=>{socket.addEventListener('open',()=>resolve(),{once:true});socket.addEventListener('error',()=>reject(new Error('ASR connection failed')),{once:true});socket.addEventListener('close',()=>{opened.unsubscribe(onOpen);reject(new Error('ASR closed'));},{once:true});});
  return {ready,logId:()=>logId,send:bytes=>socket.send(bytes),close(){opened.unsubscribe(onOpen);try{socket.close();}catch{/* handshake cleanup */}},listen(handler){const data=(event:Event)=>{const value=(event as MessageEvent).data;if(value instanceof ArrayBuffer){const bytes=new Uint8Array(value);options.onFrame?.(bytes);handler({type:'data',data:bytes});}else handler({type:'error'});},error=()=>handler({type:'error'}),close=()=>handler({type:'close'});socket.addEventListener('message',data);socket.addEventListener('error',error);socket.addEventListener('close',close);return()=>{socket.removeEventListener('message',data);socket.removeEventListener('error',error);socket.removeEventListener('close',close);};}};
};}
export function speechInputRuntime(context:ApplicationContext){const key=()=>{try{return readLocalCredential(context.paths.state_root,'ark_agent_plan',undefined,context.identity.workspace_id);}catch{return null;}};return {provider:new ArkAgentPlanAsr(key,createArkAsrConnector()),credentialPresent:()=>!!key(),credentialFingerprint:()=>{const value=key();return value?createHash('sha256').update(value).digest('hex'):null;},...(process.env.WORKBENCH_COLLECTION_SETUP_ENABLED==='1'?{setupUrl:'http://127.0.0.1:5190/?kind=ark_agent_plan'}:{})};}
