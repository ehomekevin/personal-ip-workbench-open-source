// 生图加载态的状态机（不含 React / WebGL）：决定某个槽位此刻画静态占位、跑像素着色器、揭示到真图还是回到失败态，
// 以及底图（中间图 / 噪点）的像素块尺寸与进度文案。进度只来自任务真实信号：中间图张数、执行阶段与耗时；
// 没有中间图时按渠道历史平均耗时估算，封顶 ESTIMATE_CAP 并标「预计」，不显示假的 100%。
// 只在任务真实 running 时跑着色器；排队/等待执行器、失败、降级（无 WebGL、减少动态、库加载失败）不跑着色器，底图照样按进度变清晰。
export type LoaderState='queued'|'running'|'succeeded'|'failed';
export type LoaderPreset='pixels-organic'|'pixels-mechanic'|'sweep-gradient';
export type LoaderMode='static'|'loading'|'shader'|'reveal'|'done'|'failed';
/** 进度阶段：waiting = 等待执行器 / 额度（文案用宿主给的 label）。 */
export type LoaderStage='queued'|'waiting'|'starting'|'generating'|'saving'|'checking';
/** 任务真实进度。totalMs / runningMs 是在客户端时刻 at 观察到的值（之后按本地时钟往前推）；previews 是渠道给出的中间图，按出现顺序。 */
export interface LoaderProgress { stage:LoaderStage; previews:string[]; totalMs:number; runningMs:number|null; typicalMs:number; at:number }
export interface LoaderOptions { state:LoaderState; images:string[]; width:number; height:number; preset?:LoaderPreset; label?:string; onRevealed?():void;
  progress?:LoaderProgress;
  /** 没有中间图时底图噪点的色调种子（一般是提示词）。 */
  seed?:string;
  /** 修改 / 调整画幅 / 参考修改时的原图（同源 URL）：底图从原图像素化开始，不用噪点。 */
  parentImage?:string;
  /** 修改时的阶段文案，例如「正在基于第 2 版修改」。 */
  parentLabel?:string;
  /** 这一轮生成的稳定标识（版本 / 任务 id）：已显示的进度按它保存在模块级，切图或重新挂载组件后不倒退。 */
  runKey?:string }
/** 底图：中间图 / 终图，或按种子色调生成的低饱和噪点。 */
export interface LoaderBase { kind:'preview'|'final'|'parent'|'noise'; src:string|null; hue:number }
/** 进度文案：stage 阶段；detail 预计百分比与已用时间；slow 超过历史均值 2 倍。 */
/** note：finishing = 已超过历史均值但不到 2 倍（快好了）；slow = 超过 2 倍。 */
export interface LoaderReadout { stage:string; detail:string; slow:boolean; note:'finishing'|'slow'|null; estimated:boolean; fraction:number|null; previews:number }
export interface LoaderView { mode:LoaderMode; state:LoaderState; images:string[]; finalImage:string|null; autoReveal:boolean; preset:LoaderPreset; ratio:number; label:string; degraded:boolean;
  base:LoaderBase; block:number; animate:boolean; readout:LoaderReadout }
export interface LoaderEnv {
  webgl():boolean; reducedMotion():boolean;
  /** 动态加载 img-fx（及其 three 依赖）；失败时状态机回退静态，不再重试。 */
  load():Promise<unknown>;
  slots:GpuSlots;
  /** 当前页面 origin；给了就只保留同源 / 本页 blob: 素材。 */
  origin?():string;
  /** 揭示的兜底时长：库没在这段时间内报告「图已完整显示」也直接换成真图，避免卡在动画里。 */
  revealTimeoutMs?:number;
  setTimer?(fn:()=>void,ms:number):unknown; clearTimer?(id:unknown):void;
  /** 本地时钟（毫秒）；用来把服务端观察到的耗时往前推。 */
  now?():number;
}
// 同时最多 N 个着色器实例在跑；超出的槽位排队等名额，期间显示静态占位。
export interface GpuSlots { request(id:object,granted:()=>void):boolean; release(id:object):void; active():number }
export function createGpuSlots(max=4):GpuSlots {
  const holders=new Set<object>(),waiting=new Map<object,()=>void>();
  return {
    request(id,granted){if(holders.has(id))return true;if(holders.size<max){waiting.delete(id);holders.add(id);return true;}waiting.set(id,granted);return false;},
    release(id){waiting.delete(id);if(!holders.delete(id))return;const next=waiting.entries().next();if(next.done)return;const [key,notify]=next.value;waiting.delete(key);holders.add(key);notify();},
    active:()=>holders.size,
  };
}
export const DEFAULT_PRESET:LoaderPreset='pixels-organic';
const LABELS:Record<LoaderState,string>={queued:'排队中',running:'正在生成',succeeded:'已生成',failed:'未成功'};
const STAGE_LABELS:Record<LoaderStage,string>={queued:'排队中',waiting:'等待中',starting:'正在启动',generating:'正在生成',saving:'正在保存',checking:'生成结果待核对'};
/** 没有中间图时估算进度的上限：渠道没给出终态前不逼近完成。 */
export const ESTIMATE_CAP=0.9;
/** 像素块尺寸（CSS px）：最粗与估算最细；每张新中间图至少下降一档（×PREVIEW_STEP），中间图档位下限 MIN_PREVIEW_BLOCK。 */
export const MAX_BLOCK=48, MIN_ESTIMATE_BLOCK=6, MIN_PREVIEW_BLOCK=3, PREVIEW_STEP=0.6;
const PREVIEW_BLOCKS=[24,14,8,5];
/** 减少动态效果时的清晰度档位：只按进度跳档，不做连续动画。 */
export const REDUCED_LEVELS=[48,32,20,12,8,6];
/** 没有中间图时的估算进度（0..ESTIMATE_CAP）：阶段给下限，生成阶段按已运行时间 / 历史均值走指数曲线。 */
export function estimateFraction(p:LoaderProgress,now:number):number{
  const dt=Math.max(0,now-p.at),run=(p.runningMs??0)+dt,typical=Math.max(1000,p.typicalMs),curve=0.08+0.82*(1-Math.exp(-2.2*run/typical));
  const value=p.stage==='queued'||p.stage==='waiting'?0.02:p.stage==='starting'?0.05:p.stage==='generating'?curve:p.stage==='saving'?Math.max(0.86,curve):Math.max(0.88,curve);
  return Math.min(ESTIMATE_CAP,value);
}
/** 估算进度 → 块尺寸：从 MAX_BLOCK 按几何级数缩到 MIN_ESTIMATE_BLOCK；减少动态时落到最近的档位。 */
export function blockForFraction(fraction:number,reduced=false):number{
  const t=Math.max(0,Math.min(1,fraction/ESTIMATE_CAP)),px=MAX_BLOCK*Math.pow(MIN_ESTIMATE_BLOCK/MAX_BLOCK,t);
  return reduced?REDUCED_LEVELS.find(l=>l<=px+0.001)??REDUCED_LEVELS.at(-1)!:px;
}
/** 第 n 张中间图（n≥1）对应的块尺寸档位。 */
export function blockForPreviews(n:number):number{return n<=PREVIEW_BLOCKS.length?PREVIEW_BLOCKS[n-1]!:Math.max(MIN_PREVIEW_BLOCK,PREVIEW_BLOCKS.at(-1)!*Math.pow(PREVIEW_STEP,n-PREVIEW_BLOCKS.length));}
/** 已用时间文案：41 秒 / 1 分 05 秒。 */
export function formatElapsed(ms:number):string{const s=Math.max(0,Math.floor(ms/1000));return s<60?s+' 秒':Math.floor(s/60)+' 分 '+String(s%60).padStart(2,'0')+' 秒';}
/** 提示词 → 底图色相（0..359），同一提示词稳定。 */
export function seedHue(seed:string|undefined):number{let h=2166136261;for(const ch of seed??'')h=Math.imul(h^ch.charCodeAt(0),16777619);return ((h>>>0)%360+360)%360;}
export const BRAND_MOSAIC=['/workbench/avatar.svg','/workbench/icon.svg'];
/** 单个加载器实例传给库的图片上限：库按 URL 永久缓存解码后的 Image，限制数量以约束这部分常驻内存。 */
export const MAX_MOSAIC=4;
// 马赛克素材只收同源：统一按 URL 解析后比较 origin（反斜杠、协议相对等写法都按浏览器规则归一），只接受 http(s) 同源，
// 以及 origin 解析为本页的 blob:（真图是本页对已核对字节创建的 blob URL）；data: 等其他协议一律拒绝。去重后最多保留最后 MAX_MOSAIC 张。
export function sameOriginImages(list:readonly (string|null|undefined)[],origin?:string):string[] {
  const base=origin??'http://same-origin.invalid',out:string[]=[];let expected:string;
  try{expected=new URL(base).origin;}catch{return out;}
  for(const raw of list){if(!raw)continue;let url:URL;try{url=new URL(raw,base+'/');}catch{continue;}
    const ok=url.protocol==='blob:'?!!origin&&url.origin===expected&&raw.startsWith('blob:'+expected+'/'):(url.protocol==='http:'||url.protocol==='https:')&&url.origin===expected;
    const value=origin&&url.protocol!=='blob:'?url.href:raw;
    if(ok&&!out.includes(value))out.push(value);}
  return out.slice(-MAX_MOSAIC);
}
/** 按任务保存的已显示进度（最大估算进度、最细块尺寸、已消化的中间图）；任务到终态时清理。 */
interface RunMemory { maxFraction:number; minBlock:number; previewCount:number; previewBlock:number }
const runMemory=new Map<string,RunMemory>();
/** 测试用：当前保存的任务数。 */
export const loaderRunMemorySize=()=>runMemory.size;
export class LoaderMachine {
  private opts:LoaderOptions; private readonly env:LoaderEnv; private readonly onChange:()=>void;
  private granted=false; private lib:'idle'|'loading'|'ready'|'failed'='idle'; private shaderShown=false; private revealed=false; private disposed=false; private timer:unknown;
  // 底图块尺寸只降不升：minBlock 是到目前为止显示过的最细档位；previewCount / previewBlock 记录已经消化的中间图。
  private minBlock=MAX_BLOCK; private previewCount=0; private previewBlock=Infinity; private lastBase:LoaderBase|undefined;
  // 已显示过的最大估算进度：历史均值随轮询变化时进度也只增不减（新一轮生成时清零）。
  private maxFraction=0;
  constructor(env:LoaderEnv,opts:LoaderOptions,onChange:()=>void){this.env=env;this.opts=opts;this.onChange=onChange;this.restore();this.sync();}
  // 恢复 / 保存 / 清理按任务保存的进度。终态（成功、失败、取消、待核对）后清理条目，避免常驻。
  private restore(){const m=this.opts.runKey?runMemory.get(this.opts.runKey):undefined;if(m){this.maxFraction=m.maxFraction;this.minBlock=m.minBlock;this.previewCount=m.previewCount;this.previewBlock=m.previewBlock;}}
  private remember(){const key=this.opts.runKey;if(!key)return;const s=this.opts.state;if(s==='succeeded'||s==='failed'||this.opts.progress?.stage==='checking'){runMemory.delete(key);return;}
    runMemory.delete(key);if(runMemory.size>=64)runMemory.delete(runMemory.keys().next().value!);
    runMemory.set(key,{maxFraction:this.maxFraction,minBlock:this.minBlock,previewCount:this.previewCount,previewBlock:this.previewBlock});}
  private readonly token={};
  private capable(){return this.lib!=='failed'&&this.env.webgl()&&!this.env.reducedMotion();}
  update(opts:LoaderOptions){if(this.disposed)return;const prev=this.opts.state,prevKey=this.opts.runKey;this.opts=opts;if(prev!==opts.state&&opts.state!=='succeeded')this.revealed=false;
    // 同一槽位开始新一轮生成（上一轮已结束，或换成了另一个任务）：进度从头算，再恢复这个任务已显示过的进度。
    if(((prev==='succeeded'||prev==='failed')&&(opts.state==='queued'||opts.state==='running'))||(opts.runKey!==undefined&&opts.runKey!==prevKey)){this.minBlock=MAX_BLOCK;this.previewCount=0;this.previewBlock=Infinity;this.lastBase=undefined;this.maxFraction=0;this.restore();}
    this.sync();this.onChange();}
  // 状态机核心：只有 running（或 running 之后紧接着的 succeeded 揭示）才占用着色器名额。
  private sync(){
    const s=this.opts.state,wants=this.capable()&&(s==='running'||(s==='succeeded'&&this.shaderShown&&!this.revealed));
    if(!wants){this.releaseSlot();if(s!=='succeeded')this.shaderShown=false;return;}
    if(!this.granted)this.granted=this.env.slots.request(this.token,()=>{if(this.disposed){this.env.slots.release(this.token);return;}this.granted=true;this.sync();this.onChange();});
    if(this.granted&&this.lib==='idle'){this.lib='loading';this.env.load().then(()=>{if(this.disposed)return;this.lib='ready';this.sync();this.onChange();},()=>{if(this.disposed)return;this.lib='failed';this.sync();this.onChange();});}
    if(this.granted&&this.lib==='ready'&&s==='running')this.shaderShown=true;
    if(s==='succeeded'&&this.mode()==='reveal')this.armRevealTimeout();
  }
  /** 成功但没有在跑着色器（静态/降级/排队直接成功）：无需动画，直接视为已揭示。由宿主在 update 之后调用，避免在渲染中重入。 */
  settle(){if(this.opts.state==='succeeded'&&this.mode()==='done'&&!this.revealed)this.revealDone();}
  private releaseSlot(){this.env.slots.release(this.token);this.granted=false;this.clearRevealTimeout();}
  private armRevealTimeout(){if(this.timer!==undefined)return;const set=this.env.setTimer??((fn:()=>void,ms:number)=>setTimeout(fn,ms));this.timer=set(()=>{this.timer=undefined;this.revealDone();},this.env.revealTimeoutMs??6000);}
  private clearRevealTimeout(){if(this.timer===undefined)return;(this.env.clearTimer??((id:unknown)=>clearTimeout(id as ReturnType<typeof setTimeout>)))(this.timer);this.timer=undefined;}
  /** 库报告真图已完整显示（或兜底超时）：换成普通图片、释放着色器名额。 */
  revealDone(){if(this.disposed||this.revealed||this.opts.state!=='succeeded')return;this.revealed=true;this.sync();this.onChange();this.opts.onRevealed?.();}
  /** 渲染期库抛错（如 WebGL 上下文创建失败）：按库加载失败处理，回退静态。 */
  fail(){if(this.disposed||this.lib==='failed')return;this.lib='failed';this.shaderShown=false;this.sync();this.onChange();if(this.opts.state==='succeeded')this.revealDone();}
  mode():LoaderMode{
    const s=this.opts.state;
    if(s==='failed')return 'failed';
    if(s==='succeeded')return this.shaderShown&&!this.revealed&&this.granted&&this.lib==='ready'?'reveal':'done';
    if(s==='queued')return 'static';
    if(!this.capable())return 'static';
    if(!this.granted)return 'static';
    return this.lib==='ready'?'shader':'loading';
  }
  private now(){return this.env.now?.()??Date.now();}
  /** 渠道给出的中间图张数（真实信号，不按同源过滤计数）。 */
  private previewTotal(){return this.opts.progress?.previews.length??0;}
  /** 此刻底图应该收敛到的块尺寸：终图 1；有中间图按张数降档；否则按估算进度；全程只降不升。 */
  /** 估算进度（只增不减）；结果待核对时不再估算。 */
  private fraction(p:LoaderProgress,now:number):number{if(p.stage==='checking')return this.maxFraction;this.maxFraction=Math.max(this.maxFraction,estimateFraction(p,now));return this.maxFraction;}
  private targetBlock(now:number):number{
    const s=this.opts.state,p=this.opts.progress,reduced=this.env.reducedMotion();
    if(s==='succeeded'){this.remember();return 1;}
    if(s==='failed'||p?.stage==='checking'){this.remember();return this.minBlock;}
    const n=this.previewTotal();
    for(let k=this.previewCount+1;k<=n;k++)this.previewBlock=Math.max(MIN_PREVIEW_BLOCK,Math.min(blockForPreviews(k),Math.min(this.previewBlock,this.minBlock)*PREVIEW_STEP));
    if(n>this.previewCount)this.previewCount=n;
    const target=n?this.previewBlock:p?blockForFraction(this.fraction(p,now),reduced):s==='running'?REDUCED_LEVELS[1]!:MAX_BLOCK;
    this.minBlock=Math.min(this.minBlock,target);this.remember();return this.minBlock;
  }
  private base(finalImage:string|null):LoaderBase{
    const hue=seedHue(this.opts.seed);
    if(this.opts.state==='failed'&&this.lastBase)return this.lastBase;
    const preview=sameOriginImages(this.opts.progress?.previews??[],this.env.origin?.()).at(-1)??null;
    const parent=this.opts.parentImage?sameOriginImages([this.opts.parentImage],this.env.origin?.())[0]??null:null;
    const base:LoaderBase=finalImage?{kind:'final',src:finalImage,hue}:preview?{kind:'preview',src:preview,hue}:parent?{kind:'parent',src:parent,hue}:{kind:'noise',src:null,hue};
    this.lastBase=base;return base;
  }
  /** 进度文案：阶段 + 预计百分比（仅无中间图时）+ 已用时间；超过历史均值 2 倍提示比平时慢。 */
  readout(now=this.now()):LoaderReadout{
    const s=this.opts.state,p=this.opts.progress,n=this.previewTotal(),none={detail:'',slow:false,note:null,estimated:false,fraction:null,previews:n};
    if(s==='succeeded')return {...none,stage:LABELS.succeeded};
    if(s==='failed')return {...none,stage:this.opts.label??LABELS.failed};
    if(!p)return {...none,stage:this.opts.label??LABELS[s]};
    if(p.stage==='checking')return {...none,stage:STAGE_LABELS.checking};
    const dt=Math.max(0,now-p.at),total=p.totalMs+dt,run=p.runningMs===null?null:p.runningMs+dt,waiting=p.stage==='queued'||p.stage==='waiting';
    const making=(p.stage==='generating'||p.stage==='starting')&&this.opts.parentLabel?this.opts.parentLabel:null;
    const stage=p.stage==='waiting'?this.opts.label??STAGE_LABELS.waiting:p.stage==='generating'&&n?(making??STAGE_LABELS.generating)+'·已出 '+n+' 张预览':making??STAGE_LABELS[p.stage];
    const estimated=!n&&!waiting,fraction=estimated?this.fraction(p,now):null;
    const detail=(fraction!==null?'预计 '+Math.floor(fraction*100)+'% · ':'')+(waiting?'已等 ':'已用 ')+formatElapsed(total);
    const spent=run??total,typical=Math.max(1000,p.typicalMs),slow=!waiting&&spent>2*typical,note=waiting?null:slow?'slow' as const:spent>typical?'finishing' as const:null;
    return {stage,detail,slow,note,estimated,fraction,previews:n};
  }
  view(now=this.now()):LoaderView{
    const mode=this.mode(),images=sameOriginImages(this.opts.images,this.env.origin?.()),finalImage=this.opts.state==='succeeded'?images.at(-1)??null:null,readout=this.readout(now);
    return {mode,state:this.opts.state,images:mode==='reveal'&&finalImage?[finalImage]:images.length?images:BRAND_MOSAIC,finalImage,autoReveal:false,preset:this.opts.preset??DEFAULT_PRESET,
      ratio:this.opts.width>0&&this.opts.height>0?this.opts.width/this.opts.height:1,label:readout.stage+(readout.detail?' · '+readout.detail:''),degraded:!this.capable(),
      base:this.base(finalImage),block:this.targetBlock(now),animate:!this.env.reducedMotion()&&mode!=='failed',readout};
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.releaseSlot();}
}
