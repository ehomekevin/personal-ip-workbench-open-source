// 配图工作台单元夹具：不挂 DOM（宿主根节点只回空），端口全部注入，记录提交、弹窗与提示。
import {ImageWorkbench,type ImagePlanPort,type ImagePlanLoad,type WorkbenchHost} from '../../apps/web/src/features/media/image-studio/workbench.ts';
import type {ImagePlanSnapshot} from '../../packages/contracts/src/index.ts';
export const deferred=<T>()=>{let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const item=(id:string,extra:Record<string,unknown>={})=>({id,slot_id:'slot-'+id,role:'body',paragraph_id:'p1',placement_paragraph_id:'p1',position:'after',seq:10,purpose:'图注 '+id,source_strategy:'ai_generate',aspect:'16:9',prompt_draft:'画面 '+id,candidate_id:null,skipped:false,auto:{state:'none',candidate_id:null,error:null},current_version_id:null,cleared:false,seen_versions:0,status:'awaiting_generation',paragraph_excerpt:'一',paragraph_index:0,current_version:null,issue:null,...extra});
export function capability(provider:'codex'|'agy',availability?:Record<string,unknown>){return{provider,label:provider==='agy'?'AGY':'Codex',enabled:true,available:availability?availability.selectable===true:true,sizes:[{id:'16:9',label:'横图',width:1600,height:900}],custom:null,reference_limit:1,reference_edit:provider==='agy',mask:false,text_edit:false,limitations:[],models:[provider==='agy'?{id:'gemini-3.1-flash-image',label:'Gemini 3.1 Flash Image（Nano Banana）'}:{id:'codex-builtin-image',label:'Codex 内置生图'}],...(availability?{availability}:{})};}
export function loadValue(state:ImagePlanSnapshot['state']='ready',caps=[capability('agy',{selectable:true,block:null,message:'',detail:null,unverified:true,remaining:2,limit:2})]):ImagePlanLoad{
 const plan={topic_id:'topic',topic_title:'标题',version:2,state,run:state==='planning'?{state:'queued',executor:'codex',error:null,requested_at:'2026-10-14T00:00:00Z',job_id:'j'}:null,stale:false,items:state==='ready'?[item('a'),item('b',{placement_paragraph_id:'p1',position:'before'})]:[],budget:{codex:{used:2,limit:2,remaining:0},agy:{used:0,limit:2,remaining:2}},studio:{} as never} as unknown as ImagePlanSnapshot;
 return{plan,studio:{topic_id:'topic',document_revision_id:'r',version:3,title:'',article:'',paragraphs:[{id:'p1',label:'第 1 段',text:'一'}],slots:[],references:[],capabilities:caps} as never,executors:[],default_executor:'codex'};
}
export function workbench(loads:Array<()=>Promise<ImagePlanLoad>>,extra:Partial<ImagePlanPort>={}){
 const submits:unknown[]=[],dialogs:Array<{title:string;body:string;foot?:string}>=[],toasts:string[]=[];let loadCalls=0;
 const root={querySelector:()=>null,classList:{add(){},remove(){}},ownerDocument:{}} as unknown as HTMLElement;
 const context={identity:{workspace_id:'w',service_instance_id:'s'},ui:{topic:'topic'},signal:new AbortController().signal,surface:{presentDialog:(d:{title:string;body:string;foot?:string})=>dialogs.push(d),dialogBusy(){},closeDialog(){}}} as never;
 const host:WorkbenchHost={root,context:()=>context,active:()=>true,signal:new AbortController().signal,toast:m=>toasts.push(m),submit:async input=>{submits.push(input);return{job_id:'job',input_hash:'h'};},webImport:async()=>{throw new Error('unused');},imageUrl:()=>undefined,setStudio(){},openAdd(){}};
 const port:ImagePlanPort={load:()=>{const next=loads[Math.min(loadCalls,loads.length-1)]!;loadCalls++;return next();},run:async()=>loadValue('planning').plan,update:async()=>loadValue().plan,create:async()=>loadValue().plan,assetVersion:async()=>({slot_id:'slot-a',version_id:'v-new',asset_id:'asset',version:4}),candidates:async()=>({items:[],capture:{refreshing:false,note:'',retry:false,tone:'none' as const}}),...extra};
 return{w:new ImageWorkbench(host,port),submits,dialogs,toasts,get loads(){return loadCalls;}};
}
export const el=(dataset:Record<string,string>={})=>({dataset}) as unknown as HTMLElement;
export const settle=()=>new Promise<void>(r=>setImmediate(r));
