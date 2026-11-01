import type { SpeechCleanupState,SpeechInputState } from '@workbench/contracts';
// Front-end speech dialog state. The service SpeechInputState stays authoritative for a transcription; this table only adds the local capture and adoption phases.
export const SPEECH_UI_STATES=['idle','permission','connecting','recording','finalizing','transcribed','adopting','adopted','adopt_failed','partially_adopted','cancelled','failed','unknown','cleaning','cleaned','clean_failed','adopted_linked'] as const;
export type SpeechUiState=typeof SPEECH_UI_STATES[number];
export const SPEECH_UI_EVENTS=['start','granted','upload','stop','cancel','abort','reset','session_starting','session_recording','session_finalizing','session_final','session_cancelled','session_failed','session_unknown','adopt','retry_apply','adoption_succeeded','adoption_failed','apply_failed','cleanup_started','cleanup_succeeded','cleanup_failed','recleanup','topic_linked'] as const;
export type SpeechUiEvent=typeof SPEECH_UI_EVENTS[number];
type Table=Readonly<Record<SpeechUiState,Readonly<Partial<Record<SpeechUiEvent,SpeechUiState>>>>>;
// A capture can begin again from any settled state; partially_adopted must finish writing the saved material first, so it has no start/upload.
const restart={start:'permission',upload:'finalizing',reset:'idle'} as const;
const cleanup={cleanup_started:'cleaning',cleanup_succeeded:'cleaned',cleanup_failed:'clean_failed'} as const;
// From idle, a service snapshot (new session, reopened dialog, replay) lands on its mapped state.
const replay={session_starting:'connecting',session_recording:'recording',session_finalizing:'finalizing',session_final:'transcribed',session_cancelled:'cancelled',session_failed:'failed',session_unknown:'unknown'} as const;
export const SPEECH_UI_TRANSITIONS:Table={
  idle:{...restart,...replay},
  permission:{granted:'connecting',cancel:'idle',abort:'idle',reset:'idle'},
  connecting:{session_starting:'connecting',session_recording:'recording',session_final:'transcribed',session_cancelled:'cancelled',session_failed:'failed',session_unknown:'unknown',cancel:'idle',abort:'idle',reset:'idle'},
  recording:{stop:'finalizing',cancel:'unknown',session_recording:'recording',session_finalizing:'finalizing',session_final:'transcribed',session_cancelled:'cancelled',session_failed:'failed',session_unknown:'unknown',reset:'idle'},
  // Local stop or WAV upload keeps showing finalizing while the service still reports recording.
  finalizing:{cancel:'unknown',abort:'idle',session_recording:'finalizing',session_finalizing:'finalizing',session_final:'transcribed',session_cancelled:'cancelled',session_failed:'failed',session_unknown:'unknown'},
  // recleanup: re-run cleanup on the edited text; allowed while the transcript is still an unadopted candidate and the old cleanup is not running (the controller checks the service state).
  transcribed:{...restart,session_final:'transcribed',adopt:'adopting',...cleanup,recleanup:'cleaning'},
  // Cleanup runs beside the transcript: every cleanup state keeps adopt open, so a slow or failed cleanup never blocks adopting the raw text.
  cleaning:{...restart,session_final:'cleaning',adopt:'adopting',...cleanup,recleanup:'cleaning'},
  cleaned:{...restart,session_final:'cleaned',adopt:'adopting',cleanup_succeeded:'cleaned',recleanup:'cleaning'},
  clean_failed:{...restart,session_final:'clean_failed',adopt:'adopting',cleanup_failed:'clean_failed',recleanup:'cleaning'},
  adopting:{adoption_succeeded:'adopted',adoption_failed:'adopt_failed',apply_failed:'partially_adopted',session_final:'adopting',cancel:'transcribed'},
  // Material saved from the plain entry can still be linked to the current topic once; the link is its own settled state so the status line and button follow the table.
  adopted:{...restart,session_final:'adopted',topic_linked:'adopted_linked'},
  adopted_linked:{...restart,session_final:'adopted_linked',topic_linked:'adopted_linked'},
  adopt_failed:{...restart,session_final:'adopt_failed',adopt:'adopting'},
  partially_adopted:{reset:'idle',session_final:'partially_adopted',retry_apply:'adopting'},
  cancelled:{...restart,session_cancelled:'cancelled'},
  failed:{...restart,session_failed:'failed'},
  // Local capture stopped before the service acknowledged; the cancel receipt or a late final still settles it.
  unknown:{...restart,session_recording:'unknown',session_finalizing:'unknown',session_final:'transcribed',session_cancelled:'cancelled',session_failed:'failed',session_unknown:'unknown'},
};
export class IllegalSpeechTransition extends Error {
  readonly state:SpeechUiState;readonly event:SpeechUiEvent;
  constructor(state:SpeechUiState,event:SpeechUiEvent){super('Illegal speech transition '+state+' --'+event+'-->');this.name='IllegalSpeechTransition';this.state=state;this.event=event;}
}
export function canTransition(state:SpeechUiState,event:SpeechUiEvent):boolean{return SPEECH_UI_TRANSITIONS[state][event]!==undefined;}
export function transition(state:SpeechUiState,event:SpeechUiEvent):SpeechUiState{const next=SPEECH_UI_TRANSITIONS[state][event];if(next===undefined)throw new IllegalSpeechTransition(state,event);return next;}
// Controller variant: an illegal event (a late callback racing a newer action) keeps the current state and is recorded instead of breaking the dialog.
export function advance(state:SpeechUiState,event:SpeechUiEvent,record:(illegal:{state:SpeechUiState;event:SpeechUiEvent})=>void):SpeechUiState{const next=SPEECH_UI_TRANSITIONS[state][event];if(next===undefined){record({state,event});return state;}return next;}
export function sessionEvent(state:SpeechInputState):SpeechUiEvent{return ('session_'+state) as SpeechUiEvent;}
// Adoption states (adopting/adopted/...) own the dialog once entered; the controller checks canTransition before replaying cleanup there.
export function cleanupEvent(state:SpeechCleanupState):SpeechUiEvent{return state==='succeeded'?'cleanup_succeeded':state==='failed'?'cleanup_failed':'cleanup_started';}
export function fromSession(state:SpeechInputState,cleanup?:SpeechCleanupState|null):SpeechUiState{const base=replay[sessionEvent(state) as keyof typeof replay];return base==='transcribed'&&cleanup?SPEECH_UI_TRANSITIONS.transcribed[cleanupEvent(cleanup)]!:base;}
// The recorder card keeps its existing data-state vocabulary for CSS and copy.
export type RecorderView=SpeechInputState|'ready'|'permission'|'connecting';
const ADOPTION_STATES:readonly SpeechUiState[]=['transcribed','adopting','adopted','adopt_failed','partially_adopted','cleaning','cleaned','clean_failed','adopted_linked'];
export function recorderView(state:SpeechUiState):RecorderView{return state==='idle'?'ready':ADOPTION_STATES.includes(state)?'final':state as Exclude<SpeechUiState,'idle'|'transcribed'|'adopting'|'adopted'|'adopt_failed'|'partially_adopted'|'cleaning'|'cleaned'|'clean_failed'|'adopted_linked'>;}
// Recorder status line once an adoption has settled; other states keep the per-view labels.
export function adoptionStatus(state:SpeechUiState,viewpoint:boolean):string|undefined{return state==='adopted'?(viewpoint?'已采用到本题观点':'已保存为个人素材'):state==='adopted_linked'?'已保存为个人素材，并关联到当前主题':state==='partially_adopted'?'素材已保存，观点待写入':undefined;}
// Recorder status line while the cleanup draft is pending or settled; queued vs running come from the service job, not a timer.
export function cleanupStatus(state:SpeechUiState,cleanup?:SpeechCleanupState|null):string|undefined{return state==='cleaning'?(cleanup==='running'?'正在整理文字，可先核对原文':cleanup==='waiting'?'整理等待执行器就绪，可先核对原文':'整理稿排队中，可先核对原文'):state==='cleaned'?'整理稿已完成，可切回原文核对':state==='clean_failed'?'整理未完成，可直接采用原文':undefined;}
