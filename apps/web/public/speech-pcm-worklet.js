// Browser microphone -> 16kHz mono PCM16. No network or credential access.
class SpeechPcmProcessor extends AudioWorkletProcessor {
  constructor(){super();this.pending=[];this.phase=0;this.output=[];this.active=true;this.port.onmessage=event=>{if(event.data==='stop'){this.resample(true);this.flush();this.active=false;this.port.postMessage('stopped');}};}
  flush(){if(!this.output.length)return;const pcm=new Int16Array(this.output.length);this.output.forEach((value,index)=>{const sample=Math.max(-1,Math.min(1,value));pcm[index]=sample<0?sample*32768:sample*32767;});this.output=[];this.port.postMessage(pcm.buffer,[pcm.buffer]);}
  resample(final=false){while(final?this.phase<this.pending.length*16000:Math.floor(this.phase/16000)+1<this.pending.length){const low=Math.floor(this.phase/16000),fraction=(this.phase%16000)/16000,next=Math.min(low+1,this.pending.length-1);this.output.push(this.pending[low]*(1-fraction)+this.pending[next]*fraction);this.phase+=sampleRate;if(this.output.length===3200)this.flush();}
    const consumed=Math.min(Math.floor(this.phase/16000),this.pending.length);this.pending.splice(0,consumed);this.phase-=consumed*16000;}
  process(inputs){if(!this.active)return false;const input=inputs[0]?.[0];if(!input)return true;this.pending.push(...input);this.resample();return true;}
}
registerProcessor('speech-pcm',SpeechPcmProcessor);
