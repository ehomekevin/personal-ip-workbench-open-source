export interface MicrophoneCapture { stop():Promise<void>;cancel():Promise<void> }
export async function microphoneCapture(context:AudioContext,stream:MediaStream,onChunk:(pcm:ArrayBuffer)=>void):Promise<MicrophoneCapture> {
  try{await context.audioWorklet.addModule('/speech-pcm-worklet.js');await context.resume();
    const source=context.createMediaStreamSource(stream),node=new AudioWorkletNode(context,'speech-pcm'),mute=context.createGain();mute.gain.value=0;source.connect(node);node.connect(mute);mute.connect(context.destination);let stopped=false;
    let flushed:(()=>void)|undefined;node.port.onmessage=event=>{if(event.data instanceof ArrayBuffer)onChunk(event.data);else if(event.data==='stopped')flushed?.();};
    const cleanup=async(flush:boolean)=>{if(stopped)return;stopped=true;if(flush){await new Promise<void>(resolve=>{const timer=setTimeout(resolve,500);flushed=()=>{clearTimeout(timer);resolve();};node.port.postMessage('stop');});}node.port.onmessage=null;source.disconnect();node.disconnect();mute.disconnect();stream.getTracks().forEach(track=>track.stop());await context.close();};
    return {stop:()=>cleanup(true),cancel:()=>cleanup(false)};
  }catch(error){stream.getTracks().forEach(track=>track.stop());await context.close();throw error;}
}
