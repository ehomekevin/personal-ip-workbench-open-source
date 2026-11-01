import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEECH_UI_STATES,SPEECH_UI_EVENTS,SPEECH_UI_TRANSITIONS,IllegalSpeechTransition,transition,advance,canTransition,fromSession,sessionEvent,cleanupEvent,cleanupStatus,recorderView,adoptionStatus,type SpeechUiState,type SpeechUiEvent } from '../../apps/web/src/features/speech-input/state-machine.ts';
import type { SpeechCleanupState,SpeechInputState } from '../../packages/contracts/src/index.ts';
const settle='start>permission upload>finalizing reset>idle',clean=' cleanup_started>cleaning cleanup_succeeded>cleaned cleanup_failed>clean_failed';
// Written out by hand so any table change has to be reviewed here.
const LEGAL:Record<SpeechUiState,string>={
  idle:settle+' session_starting>connecting session_recording>recording session_finalizing>finalizing session_final>transcribed session_cancelled>cancelled session_failed>failed session_unknown>unknown',
  permission:'granted>connecting cancel>idle abort>idle reset>idle',
  connecting:'session_starting>connecting session_recording>recording session_final>transcribed session_cancelled>cancelled session_failed>failed session_unknown>unknown cancel>idle abort>idle reset>idle',
  recording:'stop>finalizing cancel>unknown session_recording>recording session_finalizing>finalizing session_final>transcribed session_cancelled>cancelled session_failed>failed session_unknown>unknown reset>idle',
  finalizing:'cancel>unknown abort>idle session_recording>finalizing session_finalizing>finalizing session_final>transcribed session_cancelled>cancelled session_failed>failed session_unknown>unknown',
  transcribed:settle+' session_final>transcribed adopt>adopting recleanup>cleaning'+clean,
  cleaning:settle+' session_final>cleaning adopt>adopting recleanup>cleaning'+clean,
  cleaned:settle+' session_final>cleaned adopt>adopting cleanup_succeeded>cleaned recleanup>cleaning',
  clean_failed:settle+' session_final>clean_failed adopt>adopting cleanup_failed>clean_failed recleanup>cleaning',
  adopting:'adoption_succeeded>adopted adoption_failed>adopt_failed apply_failed>partially_adopted session_final>adopting cancel>transcribed',
  adopted:settle+' session_final>adopted topic_linked>adopted_linked',
  adopted_linked:settle+' session_final>adopted_linked topic_linked>adopted_linked',
  adopt_failed:settle+' session_final>adopt_failed adopt>adopting',
  partially_adopted:'reset>idle session_final>partially_adopted retry_apply>adopting',
  cancelled:settle+' session_cancelled>cancelled',
  failed:settle+' session_failed>failed',
  unknown:settle+' session_recording>unknown session_finalizing>unknown session_final>transcribed session_cancelled>cancelled session_failed>failed session_unknown>unknown',
};
const legal=Object.entries(LEGAL).flatMap(([state,row])=>row.split(' ').map(pair=>{const [event,next]=pair.split('>');return [state,event,next] as [SpeechUiState,SpeechUiEvent,SpeechUiState];}));
test('状态表覆盖全部前端状态；每条合法转移都按表到达目标状态',()=>{
  assert.deepEqual([...SPEECH_UI_STATES].sort(),['adopt_failed','adopted','adopted_linked','adopting','cancelled','clean_failed','cleaned','cleaning','connecting','failed','finalizing','idle','partially_adopted','permission','recording','transcribed','unknown']);
  assert.equal(legal.length,Object.values(SPEECH_UI_TRANSITIONS).reduce((sum,row)=>sum+Object.keys(row).length,0));
  for(const [state,event,next] of legal){assert.ok(SPEECH_UI_EVENTS.includes(event),event);assert.equal(transition(state,event),next,state+' --'+event);assert.equal(canTransition(state,event),true);assert.equal(advance(state,event,()=>assert.fail('legal transition recorded as illegal')),next);}
  for(const state of SPEECH_UI_STATES)for(const event of SPEECH_UI_EVENTS)if(!legal.some(([from,on])=>from===state&&on===event))assert.throws(()=>transition(state,event),IllegalSpeechTransition,state+' --'+event);
});
test('非法转移抛错；控制器用的advance保持原状态并记录',()=>{
  const illegal:[SpeechUiState,SpeechUiEvent][]=[['idle','stop'],['idle','adopt'],['recording','adopt'],['permission','session_recording'],['transcribed','adoption_succeeded'],['adopted','adopt'],['partially_adopted','start'],['partially_adopted','adopt'],['adopting','reset'],['adopting','start'],['finalizing','reset'],['cancelled','stop'],['failed','retry_apply'],['unknown','granted']];
  for(const [state,event] of illegal){assert.throws(()=>transition(state,event),(error:IllegalSpeechTransition)=>error instanceof IllegalSpeechTransition&&error.state===state&&error.event===event);const recorded:{state:SpeechUiState;event:SpeechUiEvent}[]=[];assert.equal(advance(state,event,entry=>recorded.push(entry)),state);assert.deepEqual(recorded,[{state,event}]);assert.equal(canTransition(state,event),false);}
});
test('后端session.state映射进前端状态；录音卡片沿用原data-state词汇',()=>{
  const map:Record<SpeechInputState,SpeechUiState>={starting:'connecting',recording:'recording',finalizing:'finalizing',final:'transcribed',cancelled:'cancelled',failed:'failed',unknown:'unknown'};
  for(const [state,ui] of Object.entries(map) as [SpeechInputState,SpeechUiState][]){assert.equal(fromSession(state),ui);assert.equal(sessionEvent(state),'session_'+state);assert.equal(transition('idle',sessionEvent(state)),ui);}
  assert.deepEqual(SPEECH_UI_STATES.map(state=>recorderView(state)),['ready','permission','connecting','recording','finalizing','final','final','final','final','final','cancelled','failed','unknown','final','final','final','final']);
});
test('典型路径：录音→转写→采用失败→重试→素材已存观点未写→只重试写入→已采用',()=>{
  const path:SpeechUiEvent[]=['start','granted','session_recording','stop','session_finalizing','session_final','adopt','adoption_failed','adopt','apply_failed','retry_apply','adoption_succeeded'];
  assert.deepEqual(path.reduce<SpeechUiState[]>((states,event)=>[...states,transition(states.at(-1)!,event)],['idle']),['idle','permission','connecting','recording','finalizing','finalizing','transcribed','adopting','adopt_failed','adopting','partially_adopted','adopting','adopted']);
});
test('采用落定后的录音卡片状态行由状态推导，其余状态沿用原标签',()=>{
  assert.equal(adoptionStatus('adopted',true),'已采用到本题观点');assert.equal(adoptionStatus('partially_adopted',true),'素材已保存，观点待写入');assert.equal(adoptionStatus('adopted',false),'已保存为个人素材');
  assert.equal(adoptionStatus('adopted_linked',false),'已保存为个人素材，并关联到当前主题');
  for(const state of SPEECH_UI_STATES)if(!['adopted','partially_adopted','adopted_linked'].includes(state))assert.equal(adoptionStatus(state,true),undefined,state);
});
test('整理稿三态与采用主线并行：任一整理态都可采用；整理结果不能越过采用态或回到录音前',()=>{
  for(const state of ['cleaning','cleaned','clean_failed'] as const){assert.equal(transition(state,'adopt'),'adopting');assert.equal(recorderView(state),'final');}
  const illegal:[SpeechUiState,SpeechUiEvent][]=[['idle','cleanup_started'],['recording','cleanup_succeeded'],['finalizing','cleanup_failed'],['adopting','cleanup_succeeded'],['adopted','cleanup_failed'],['partially_adopted','cleanup_started'],['cleaned','cleanup_started'],['cleaned','cleanup_failed'],['clean_failed','cleanup_succeeded'],['clean_failed','cleanup_started'],['cleaning','adoption_succeeded'],['cleaned','topic_linked'],['transcribed','topic_linked'],['adopt_failed','topic_linked'],['adopted_linked','adopt']];
  for(const [state,event] of illegal){assert.throws(()=>transition(state,event),IllegalSpeechTransition,state+' --'+event);const recorded:{state:SpeechUiState;event:SpeechUiEvent}[]=[];assert.equal(advance(state,event,entry=>recorded.push(entry)),state);assert.equal(recorded.length,1);}
  const path:SpeechUiEvent[]=['start','granted','session_recording','stop','session_final','cleanup_started','cleanup_started','cleanup_succeeded','adopt','adoption_failed','adopt','adoption_succeeded'];
  assert.deepEqual(path.reduce<SpeechUiState[]>((states,event)=>[...states,transition(states.at(-1)!,event)],['idle']),['idle','permission','connecting','recording','finalizing','transcribed','cleaning','cleaning','cleaned','adopting','adopt_failed','adopting','adopted']);
  assert.deepEqual(['session_final','cleanup_started','cleanup_failed','adopt','cancel'].reduce<SpeechUiState[]>((states,event)=>[...states,transition(states.at(-1)!,event as SpeechUiEvent)],['idle']),['idle','transcribed','cleaning','clean_failed','adopting','transcribed']);
});
test('后端cleanup_state经fromSession映射；状态行由真实排队/执行状态驱动，失败只提示可采用原文',()=>{
  const map:Record<SpeechCleanupState,SpeechUiState>={queued:'cleaning',running:'cleaning',waiting:'cleaning',succeeded:'cleaned',failed:'clean_failed'};
  for(const [cleanup,ui] of Object.entries(map) as [SpeechCleanupState,SpeechUiState][]){assert.equal(fromSession('final',cleanup),ui);assert.equal(transition('transcribed',cleanupEvent(cleanup)),ui);for(const state of ['recording','cancelled','failed','unknown'] as SpeechInputState[])assert.equal(fromSession(state,cleanup),fromSession(state));}
  assert.equal(fromSession('final'),'transcribed');assert.equal(fromSession('final',null),'transcribed');
  assert.equal(cleanupStatus('cleaning','queued'),'整理稿排队中，可先核对原文');assert.equal(cleanupStatus('cleaning','running'),'正在整理文字，可先核对原文');assert.equal(cleanupStatus('cleaning','waiting'),'整理等待执行器就绪，可先核对原文');assert.equal(cleanupStatus('clean_failed','failed'),'整理未完成，可直接采用原文');assert.match(cleanupStatus('cleaned','succeeded')!,/切回原文/);
  for(const state of SPEECH_UI_STATES)if(!['cleaning','cleaned','clean_failed'].includes(state))assert.equal(cleanupStatus(state,'running'),undefined,state);
});
test('普通入口素材已采用后关联当前主题：adopted→adopted_linked，重复关联保持',()=>{
  assert.deepEqual(['session_final','adopt','adoption_succeeded','topic_linked','topic_linked'].reduce<SpeechUiState[]>((states,event)=>[...states,transition(states.at(-1)!,event as SpeechUiEvent)],['idle']),['idle','transcribed','adopting','adopted','adopted_linked','adopted_linked']);
  assert.equal(recorderView('adopted_linked'),'final');assert.equal(transition('adopted_linked','reset'),'idle');
});
test('重新整理：转写候选、整理中、整理完成、整理失败可回到 cleaning；采用中/已采用/录音中不可重新整理',()=>{
  for(const state of ['transcribed','cleaning','cleaned','clean_failed'] as const)assert.equal(transition(state,'recleanup'),'cleaning');
  for(const state of ['idle','recording','finalizing','adopting','adopted','adopted_linked','adopt_failed','partially_adopted','cancelled','failed','unknown'] as const)assert.equal(canTransition(state,'recleanup'),false,state);
  assert.equal(cleanupStatus(transition('cleaned','recleanup'),'queued'),'整理稿排队中，可先核对原文');
});
