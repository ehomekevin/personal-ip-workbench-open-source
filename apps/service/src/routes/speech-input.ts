import { StartSpeechInputSchema,SpeechInputChunkSchema,SpeechInputBatchSchema,CancelSpeechInputSchema,AdoptSpeechInputSchema,LinkSpeechInputTopicSchema,RecleanupSpeechInputSchema,ConfigureSpeechInputSchema,TranscribeRecordingSchema,SPEECH_INPUT_DERIVED_LIMITS } from '@workbench/contracts';
import type { ApplicationContext,ApplicationModule } from '@workbench/domain/ports';
import { SpeechInputs,decodePcm,wavPcm } from '../../../../packages/domain/src/speech-input/index.ts';
import { speechInputRuntime } from '../bootstrap/speech-input.ts';
import { createHash } from 'node:crypto';
export function createSpeechInputModule(context:ApplicationContext,options:ConstructorParameters<typeof SpeechInputs>[1]=speechInputRuntime(context)):ApplicationModule {
  const speech=new SpeechInputs(context,options),recordings=new Set<string>();
  return {id:'speech-input',close:()=>speech.close(),health:()=>{const c=speech.configuration();return {module:'speech-input',status:!c.credential_present||!c.enabled?'blocked':c.connection==='verified'?'ready':'degraded',details:{provider:'ark_agent_plan',connection:c.connection}};},register(registrar){
    registrar.register({method:'GET',path:'/api/v1/settings/speech-input',owner:'ARK-ASR-01',handle:()=>({body:speech.configuration()})});
    registrar.register({method:'PUT',path:'/api/v1/settings/speech-input',owner:'ARK-ASR-01',mutation:true,idempotent:true,schema:ConfigureSpeechInputSchema,handle:r=>({body:speech.configure(r.context,r.body.enabled)})});
    registrar.register({method:'POST',path:'/api/v1/speech-inputs',owner:'ARK-ASR-01',mutation:true,idempotent:true,schema:StartSpeechInputSchema,handle:async r=>({status:201,body:await speech.start(r.context,r.body)})});
    registrar.register({method:'GET',path:'/api/v1/speech-inputs/{id}',owner:'ARK-ASR-01',handle:r=>({body:speech.get(r.context,r.params.id!)})});
    registrar.register({method:'POST',path:'/api/v1/speech-inputs/{id}/chunks',owner:'ARK-ASR-01',mutation:true,idempotent:true,schema:SpeechInputChunkSchema,handle:r=>({body:speech.chunk(r.context,r.params.id!,r.body)})});
    registrar.register({method:'POST',path:'/api/v1/speech-inputs/{id}/chunk-batches',owner:'ARK-ASR-01',mutation:true,idempotent:true,schema:SpeechInputBatchSchema,handle:r=>({body:speech.batch(r.context,r.params.id!,r.body)})});
    registrar.register({method:'POST',path:'/api/v1/speech-inputs/{id}/cancel',owner:'ARK-ASR-01',mutation:true,idempotent:true,schema:CancelSpeechInputSchema,handle:r=>({body:speech.cancel(r.context,r.params.id!,r.body)})});
    registrar.register({method:'POST',path:'/api/v1/speech-inputs/{id}/adoption',owner:'ARK-ASR-01',mutation:true,idempotent:true,schema:AdoptSpeechInputSchema,handle:r=>({body:speech.adopt(r.context,r.params.id!,r.body)})});
    registrar.register({method:'POST',path:'/api/v1/speech-inputs/{id}/cleanup',owner:'ARK-ASR-01',mutation:true,idempotent:true,schema:RecleanupSpeechInputSchema,handle:r=>({body:speech.recleanup(r.context,r.params.id!,r.body)})});
    registrar.register({method:'POST',path:'/api/v1/speech-inputs/{id}/topic-link',owner:'ARK-ASR-01',mutation:true,idempotent:true,schema:LinkSpeechInputTopicSchema,handle:r=>({body:speech.linkTopic(r.context,r.params.id!,r.body)})});
    // A full-length WAV travels as base64 JSON; allow it plus a small envelope for the other fields.
    registrar.register({method:'POST',path:'/api/v1/speech-recordings',owner:'ARK-ASR-01',mutation:true,idempotent:true,maxJsonBytes:SPEECH_INPUT_DERIVED_LIMITS.max_wav_base64+4096,schema:TranscribeRecordingSchema,handle:async r=>{
      const pcm=wavPcm(decodePcm(r.body.audio_base64,SPEECH_INPUT_DERIVED_LIMITS.max_wav_bytes)),started=await speech.start(r.context,{mode:'recording',capture_id:r.body.capture_id},r.body,createHash('sha256').update(pcm).digest('hex'));if(started.state!=='recording'||recordings.has(started.id))return {status:202,body:started};recordings.add(started.id);
      const send=async()=>{for(let at=0,sequence=1;at<pcm.length;at+=6400,sequence++){if(speech.get(r.context,started.id).state!=='recording')break;const segment=pcm.subarray(at,at+6400);const result=speech.chunk({...r.context,idempotency_key:'recording-chunk:'+started.id+':'+sequence},started.id,{sequence,audio_base64:segment.toString('base64'),final:at+6400>=pcm.length});if(['unknown','failed','cancelled','final'].includes(result.state))break;if(at+6400<pcm.length)await new Promise<void>(resolve=>setTimeout(resolve,200));}};
      void send().catch(()=>speech.cancel(r.context,started.id)).finally(()=>recordings.delete(started.id));return {status:202,body:started};
    }});
  }};
}
