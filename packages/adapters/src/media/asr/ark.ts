import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { ContractError } from '@workbench/contracts';
export const ARK_ASR_ENDPOINTS = { live:'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async', recording:'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream' } as const;
export const ARK_ASR_RESOURCE = 'volc.seedasr.sauc.duration';
export interface AsrSocket {
  ready:Promise<void>; logId():string|null; send(data:Uint8Array):void; close():void;
  listen(handler:(event:{type:'data';data:Uint8Array}|{type:'error'|'close'})=>void):()=>void;
}
export type AsrConnector=(url:string,headers:Record<string,string>)=>AsrSocket;
export interface AsrEvent { text:string; final:boolean; log_id:string|null }
export interface AsrStream { requestId:string; logId():string|null; send(pcm:Uint8Array,final:boolean):void; close():void }
export interface AsrProvider { open(mode:'live'|'recording',onEvent:(event:AsrEvent)=>void,onError:()=>void,signal?:AbortSignal):Promise<AsrStream> }
// Agent Plan official binary protocol, v1; never falls back to the paid speech endpoint.
export function asrFrame(type:1|2,sequence:number,bytes:Uint8Array,final=false):Buffer {
  const compressed=gzipSync(bytes),frame=Buffer.alloc(12+compressed.length);
  frame.set([0x11,(type<<4)|(final?3:1),0x11,0]);frame.writeInt32BE(final?-sequence:sequence,4);frame.writeUInt32BE(compressed.length,8);frame.set(compressed,12);return frame;
}
export function parseAsrFrame(bytes:Uint8Array):{text:string;final:boolean;code:number} {
  const data=Buffer.from(bytes);if(data.length<8||data.length>1024*1024||data[0]!>>4!==1)throw new Error('invalid ASR frame');
  const type=data[1]!>>4,flags=data[1]!&15,compression=data[2]!&15,serialization=data[2]!>>4;let at=(data[0]!&15)*4;
  if(at<4||at>data.length)throw new Error('invalid ASR header');
  if(flags&1)at+=4;if(flags&4)at+=4;
  if(at+4>data.length||![9,15].includes(type))throw new Error('invalid ASR response');
  let code=0;if(type===15){code=data.readInt32BE(at);at+=4;}
  if(at+4>data.length)throw new Error('invalid ASR size');const size=data.readUInt32BE(at);at+=4;
  if(size!==data.length-at||![0,1].includes(compression)||serialization!==1)throw new Error('invalid ASR payload');
  const payload=compression===1?gunzipSync(data.subarray(at),{maxOutputLength:1024*1024}):data.subarray(at);
  const body=JSON.parse(payload.toString('utf8'));if(body.code&&body.code!==1000&&body.code!==20000000)code=Number(body.code);
  const text=body.result?.text??'';if(typeof text!=='string'||text.length>100000)throw new Error('invalid ASR text');
  return {text,final:!!(flags&2),code};
}
export class ArkAgentPlanAsr implements AsrProvider {
  private readonly key:()=>string|null;private readonly connect:AsrConnector;
  constructor(key:()=>string|null,connect:AsrConnector){this.key=key;this.connect=connect;}
  async open(mode:'live'|'recording',onEvent:(event:AsrEvent)=>void,onError:()=>void,signal?:AbortSignal):Promise<AsrStream> {
    if(signal?.aborted)throw new ContractError('HOST_INTERRUPTED','语音连接已取消');
    const key=this.key();if(!key)throw new ContractError('AUTH_REQUIRED','请填写 Agent Plan 专属 API Key');
    const requestId=randomUUID(),socket=this.connect(ARK_ASR_ENDPOINTS[mode],{'X-Api-Key':key,'X-Api-Resource-Id':ARK_ASR_RESOURCE,'X-Api-Request-Id':requestId,'X-Api-Connect-Id':requestId,'X-Api-Sequence':'-1'});
    let closed=false,acknowledged=false,sequence=1,resolveAck!:()=>void,rejectAck!:(error?:ContractError)=>void,dispose=()=>{};
    const ack=new Promise<void>((resolve,reject)=>{resolveAck=resolve;rejectAck=error=>reject(error??new ContractError('CAPABILITY_UNVERIFIED','ASR 认证或服务尚未通过，请核对订阅与网络'));});
    const abort=()=>{closed=true;dispose();socket.close();rejectAck(new ContractError('HOST_INTERRUPTED','语音连接已取消'));};
    signal?.addEventListener('abort',abort,{once:true});
    dispose=socket.listen(event=>{
      if(closed)return;
      if(event.type!=='data'){if(!acknowledged)rejectAck();else onError();return;}
      try{const response=parseAsrFrame(event.data);if(response.code)throw new Error('provider error');
        if(!acknowledged){acknowledged=true;resolveAck();}
        if(response.text||response.final)onEvent({...response,log_id:socket.logId()});
      }catch{if(!acknowledged)rejectAck();else onError();}
    });
    const timeout=setTimeout(()=>rejectAck(),8000);
    try{await Promise.race([socket.ready,ack]);if(closed||signal?.aborted)throw new ContractError('HOST_INTERRUPTED','语音连接已取消');socket.send(asrFrame(1,sequence++,Buffer.from(JSON.stringify({user:{uid:'workbench'},audio:{format:'pcm',codec:'raw',rate:16000,bits:16,channel:1},request:{model_name:'bigmodel',enable_itn:true,enable_ddc:true,enable_punc:true,show_utterances:true,enable_nonstream:mode==='recording'}}))));await ack;}
    catch(error){if(!closed){closed=true;dispose();socket.close();}signal?.removeEventListener('abort',abort);throw error instanceof ContractError?error:new ContractError('CAPABILITY_UNVERIFIED','ASR 连接未完成，请核对订阅与网络');}
    finally{clearTimeout(timeout);}
    return {requestId,logId:()=>socket.logId(),send(pcm,final){if(closed)throw new Error('ASR closed');socket.send(asrFrame(2,sequence++,pcm,final));},close(){signal?.removeEventListener('abort',abort);if(closed)return;closed=true;dispose();socket.close();}};
  }
}
