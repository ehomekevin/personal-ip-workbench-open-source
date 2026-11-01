import { studioVersionBlocks, type StudioMark } from '@workbench/contracts';
import type { ImagePlanSnapshot, ImagePlanItemView, ImagePlanStrategy, ImagePlanAspect, ImagePlanBudget } from '@workbench/contracts';
import type { StudioSnapshot, StudioVersion, StudioCapability, StudioSizeChoice, StudioSubmit } from './model.ts';
// 配图工作台的界面投影：只给用户任务需要的标签、状态和动作；任务 ID、槽位 ID、内容指纹等留在服务端与诊断层。
export const STRATEGY_LABELS:Record<ImagePlanStrategy,string>={article_original:'原文 / 官方图',platform_post:'同题帖子图',ai_generate:'AI 生图'};
export const STATUS_LABELS:Record<ImagePlanItemView['status'],string>={skipped:'跳过',filled:'已配',generating:'生成中',awaiting_generation:'待生成',searching:'正在找图',pending:'待定',failed:'未成功'};
export const ASPECT_LABELS:Record<ImagePlanAspect,string>={'16:9':'横图 · 16:9','4:3':'横图 · 4:3','1:1':'方图 · 1:1','3:4':'竖图 · 3:4','9:16':'竖图 · 9:16','2:5':'长图 · 2:5'};
export type StatusTone='done'|'busy'|'wait'|'muted'|'warn';
const TONES:Record<ImagePlanItemView['status'],StatusTone>={filled:'done',generating:'busy',searching:'busy',awaiting_generation:'wait',pending:'wait',failed:'warn',skipped:'muted'};
export interface PlanItemVM {
  id:string; slot_id:string; role:ImagePlanItemView['role']; roleLabel:string; caption:string; prompt:string; strategy:ImagePlanStrategy; strategyLabel:string;
  aspect:ImagePlanAspect; status:ImagePlanItemView['status']; statusLabel:string; tone:StatusTone; excerpt:string; paragraphLabel:string; issue:string|null;
  current:StudioVersion|null; currentIndex:number|null; versions:StudioVersion[]; autoSelected:boolean; credit:string|null; position:ImagePlanItemView['position'];
  placement:string; paragraph_id:string; placement_paragraph_id:string; canMoveUp:boolean; canMoveDown:boolean; canGenerate:boolean; quotaBlocked:boolean;
  /** 有版本还在生成或结果待核对：与服务端同一判定，不能再提交生成或修改。 */ blocked:boolean;
}
export type CanvasBlock={kind:'paragraph';id:string;index:number;text:string}|{kind:'figure';item:PlanItemVM};
export interface WorkbenchVM { state:ImagePlanSnapshot['state']; title:string; items:PlanItemVM[]; canvas:CanvasBlock[]; pendingGenerate:PlanItemVM[]; counts:{total:number;filled:number;skipped:number}; budget:ImagePlanSnapshot['budget']; stale:boolean; runError:string|null; replanning:boolean }
/** 方案项名称：不按列表位置编号（上移/下移后会变），用它说明的那一段命名。上下移只交换插入点，说明的段落不变，名称也不变；本人改插入位置时才跟着变。 */
export function itemName(item:Pick<ImagePlanItemView,'position'|'role'|'paragraph_index'>):string {
  if(item.position==='cover')return '文章封面';
  return (item.role==='manual'?'手动加图':'正文图')+' · '+(item.paragraph_index===null?'原段落已变化':'第 '+(item.paragraph_index+1)+' 段');
}
/** 同名的方案项（例如同一段后连加几张手动图）加「（2）」「（3）」：按方案项编号排序决定后缀，上下移不改变后缀。 */
export function stableNames(items:ReadonlyArray<Pick<ImagePlanItemView,'id'|'position'|'role'|'paragraph_index'>>):Map<string,string> {
  const groups=new Map<string,string[]>();for(const item of items){const name=itemName(item);groups.set(name,[...(groups.get(name)??[]),item.id]);}
  const out=new Map<string,string>();for(const [name,ids] of groups){const sorted=[...ids].sort();sorted.forEach((id,i)=>out.set(id,i===0?name:name+'（'+(i+1)+'）'));}
  return out;
}
const placementOf=(item:Pick<ImagePlanItemView,'position'|'placement_paragraph_id'>)=>item.position==='cover'?'cover':item.position+':'+item.placement_paragraph_id;
/** 方案项 + 已投影的图片版本 → 列表与画布共用的项目视图。quota 是本次「生成全部」里因额度不足没入队的项。 */
export function projectWorkbench(plan:ImagePlanSnapshot,studio:StudioSnapshot,quota:ReadonlySet<string>=new Set()):WorkbenchVM {
  const body=plan.items.filter(i=>i.position!=='cover'),names=stableNames(plan.items);
  const items=plan.items.map(item=>{
    const slot=studio.slots.find(s=>s.id===item.slot_id),versions=slot?.versions??[],current=item.current_version?versions.find(v=>v.id===item.current_version!.id)??null:null,at=body.indexOf(item);
    const roleLabel=names.get(item.id)??itemName(item);
    const blocked=versions.some(v=>studioVersionBlocks({asset_id:v.asset_id||null,state:v.state})),pendingGeneration=!item.skipped&&!current&&['awaiting_generation','failed'].includes(item.status)&&!item.issue?.includes('核对');
    return {id:item.id,slot_id:item.slot_id,role:item.role,roleLabel,caption:item.purpose,prompt:item.prompt_draft,strategy:item.source_strategy,strategyLabel:STRATEGY_LABELS[item.source_strategy],aspect:item.aspect,
      status:item.status,statusLabel:item.status==='filled'&&item.current_version?.auto_selected?'AI 选中，可换':quota.has(item.id)&&pendingGeneration?'额度不足':STATUS_LABELS[item.status],tone:quota.has(item.id)&&pendingGeneration?'warn':TONES[item.status],
      excerpt:item.paragraph_excerpt,paragraphLabel:item.paragraph_index===null?'段落已变化':'第 '+(item.paragraph_index+1)+' 段',issue:item.issue,current,currentIndex:item.current_version?.index??null,versions,autoSelected:!!item.current_version?.auto_selected,
      credit:item.current_version?.credit_label??null,position:item.position,placement:placementOf(item),paragraph_id:item.paragraph_id,placement_paragraph_id:item.placement_paragraph_id,
      canMoveUp:item.position!=='cover'&&at>0,canMoveDown:item.position!=='cover'&&at>=0&&at<body.length-1,canGenerate:!item.skipped&&item.status!=='generating'&&!blocked,quotaBlocked:quota.has(item.id)&&pendingGeneration,blocked} satisfies PlanItemVM;
  });
  const canvas:CanvasBlock[]=[],visible=items.filter(i=>i.status!=='skipped');
  for(const item of visible.filter(i=>i.position==='cover'))canvas.push({kind:'figure',item});
  for(const [index,p] of studio.paragraphs.entries()){
    for(const item of visible.filter(i=>i.position==='before'&&i.placement_paragraph_id===p.id))canvas.push({kind:'figure',item});
    canvas.push({kind:'paragraph',id:p.id,index,text:p.text});
    for(const item of visible.filter(i=>i.position==='after'&&i.placement_paragraph_id===p.id))canvas.push({kind:'figure',item});}
  const pendingGenerate=items.filter(i=>i.strategy==='ai_generate'&&!i.current&&!i.blocked&&i.status!=='skipped'&&i.canGenerate);
  return {state:plan.state,title:plan.topic_title,items,canvas,pendingGenerate,counts:{total:items.length,filled:items.filter(i=>i.status==='filled').length,skipped:items.filter(i=>i.status==='skipped').length},budget:plan.budget,stale:plan.stale,runError:plan.run?.error??null,replanning:plan.state==='planning'&&plan.items.length>0};
}
/** 方案画幅 → 渠道可选构图尺寸（同一比例）；没有同比例时退到第一个。 */
export function sizeForAspect(capability:StudioCapability|undefined,aspect:string):StudioSizeChoice|undefined {return capability?.sizes.find(s=>s.id===aspect)??capability?.sizes[0];}
/** 「生成全部」：按所选渠道剩余额度切分，超出的标「额度不足」、不入队；remaining 为 null（不限次数）时全部入队。 */
export function generateAllPlan(items:PlanItemVM[],remaining:number|null):{queue:PlanItemVM[];blocked:PlanItemVM[]} {const n=remaining===null?items.length:Math.max(0,remaining);return {queue:items.slice(0,n),blocked:items.slice(n)};}
/** 生图剩余次数一行（与规划用的 Codex 区分，生图渠道写「Codex 生图」）：用完的渠道注明可在设置放开。 */
export const budgetLine=(budget:{codex:ImagePlanBudget;agy:ImagePlanBudget})=>([['AGY',budget.agy],['Codex 生图',budget.codex]] as const).map(([name,b])=>b.remaining===null?name+' 不限次数':name+' '+b.remaining+' 次'+(b.remaining<=0?'（已用完，可在设置放开）':'')).join(' · ');
/** 方案项的生成请求：首次生成按方案落点进入预留槽位；修改版以当前图为原图（reference_edit）。 */
export function planGenerationSubmit(input:{studio:StudioSnapshot;item:PlanItemVM;provider:'codex'|'agy';description:string;size:StudioSizeChoice;operation:'generate'|'reference_edit'}):StudioSubmit {
  const {studio,item}=input;if(!input.description.trim())throw new Error(input.operation==='reference_edit'?'先写清楚要怎么改这张图。':'先写这张图的画面说明。');
  if(input.operation==='reference_edit'&&!item.current?.asset_id)throw new Error('这张图还没有可修改的原图。');
  return {topic_id:studio.topic_id,document_revision_id:studio.document_revision_id,expected_version:studio.version,slot_id:item.slot_id,parent_version_id:input.operation==='reference_edit'?item.current!.id:null,provider:input.provider,
    description:input.description.trim(),title:item.caption,placement:item.placement,paragraph_id:item.paragraph_id,reference_assets:[],mode:'manual',requested_size:{width:input.size.width,height:input.size.height},brief_id:null,operation:input.operation};
}
/** 修改要求的快捷短语：已包含时不重复追加。 */
export function appendChip(text:string,chip:string):string {const value=text.trim();if(value.includes(chip))return value;return value?value.replace(/[。.]?$/,'。')+chip+'。':chip+'。';}
export const PLAN_CHIPS:Record<string,string>={marked:'只修改标注区域，其他保持不变',space:'增加留白，让主体更突出',brand:'保留工作台元素（Logo、配色与头像）'};
/** 规划失败或接口错误翻成用户语言；不露错误码、任务标识。 */
export function workbenchErrorCopy(error:unknown):string {
  const code=(error as {response?:{error?:{code?:string}}})?.response?.error?.code,message=error instanceof Error?error.message:'';
  if(code==='VERSION_CONFLICT')return '配图刚有变化，已刷新，请再试一次';
  if(code==='QUOTA_EXHAUSTED')return /渠道真实生图/.test(message)?'本渠道真实生图次数已用完，这张没有入队':message||'额度暂不可用';
  if(code==='RESULT_UNKNOWN')return '这张图上次的任务还在核对，暂不能重复提交';
  if(code==='INPUT_STALE')return '文章已修改，请重新规划后再生成';
  if(code==='CAPABILITY_UNVERIFIED'&&/Codex/.test(message))return 'Codex 生图暂不支持基于原图修改，请换 AGY 生图生成修改版';
  return message&&!/[A-Z_]{6,}|[0-9a-f]{8}-[0-9a-f]{4}/.test(message)?message:'操作没有完成，请稍后再试';
}

// ——— A2-2：位置下拉、标注、版本标签 ———
/** 插入位置选项：封面 + 每段「之前 / 之后」，标签写「第 N 段之后 · 段首摘要」。封面已被别的图占用时不可选。 */
export function positionOptions(paragraphs:ReadonlyArray<{id:string;text:string}>,coverTaken:boolean):Array<{value:string;label:string;disabled:boolean}> {
  const head=(t:string)=>{const x=t.replace(/\s+/g,' ').trim();return x.length>16?x.slice(0,16)+'…':x;};
  return [{value:'cover',label:coverTaken?'封面（已有一张）':'封面',disabled:coverTaken},...paragraphs.flatMap((p,i)=>(['before','after'] as const).map(pos=>({value:pos+':'+p.id,label:'第 '+(i+1)+' 段'+(pos==='before'?'之前':'之后')+' · '+head(p.text),disabled:false})))];
}
export function parsePosition(value:string):{position:'cover'|'before'|'after';paragraph_id:string|null}|null {if(value==='cover')return {position:'cover',paragraph_id:null};const at=value.indexOf(':'),pos=value.slice(0,at);return (pos==='before'||pos==='after')&&at>0?{position:pos,paragraph_id:value.slice(at+1)}:null;}
export const MARK_LABELS:Record<StudioMark['type'],string>={rect:'框选',brush:'涂抹',arrow:'箭头',text:'改文字'};
const pct=(v:number,total:number)=>Math.max(0,Math.min(100,Math.round(v/total*100)));
/** 涂抹路径的外接框（viewBox 坐标）。 */
export function brushBounds(path:string):{x:number;y:number;w:number;h:number} {const n=(path.match(/-?\d+(?:\.\d+)?/g)??[]).map(Number),xs=n.filter((_,i)=>i%2===0),ys=n.filter((_,i)=>i%2===1);if(!xs.length||!ys.length)return {x:0,y:0,w:0,h:0};const x=Math.min(...xs),y=Math.min(...ys);return {x,y,w:Math.max(...xs)-x,h:Math.max(...ys)-y};}
/** 一处标注翻成生图能读懂的文字：位置按图片宽高百分比写（x 横向、y 纵向）。height 为 viewBox 高（1000×h/w）。 */
export function describeMark(m:StudioMark,height:number):string {
  const X=(v:number)=>pct(v,1000),Y=(v:number)=>pct(v,height),range=(a:number,b:number,f:(v:number)=>number)=>f(Math.min(a,b))+'–'+f(Math.max(a,b))+'%';
  if(m.type==='text')return '把标注'+m.id+'处（x '+X(m.x)+'%，y '+Y(m.y)+'%）的文字改为「'+(m.text??'').trim()+'」'+(m.note.trim()?'，'+m.note.trim():'');
  const where=m.type==='arrow'?'箭头，从 x '+X(m.x)+'% y '+Y(m.y)+'% 指向 x '+X(m.ex)+'% y '+Y(m.ey)+'%':(()=>{const b=m.type==='brush'?brushBounds(m.path):{x:m.x,y:m.y,w:m.w,h:m.h};return MARK_LABELS[m.type]+'，x '+range(b.x,b.x+b.w,X)+'，y '+range(b.y,b.y+b.h,Y);})();
  return '标注'+m.id+'（'+where+'）'+(m.note.trim()?'：'+m.note.trim():'：按修改要求调整这里');
}
export const MAX_EDIT_DESCRIPTION=8000;
/** 修改要求 + 标注 → 生成修改版的画面说明；标注只以文字进入说明，不画进成品。超过 8000 字时报错，不截断。 */
export function composeEditDescription(request:string,marks:readonly StudioMark[],height:number):string {
  const text=request.trim(),usable=marks.filter(m=>m.type!=='text'||(m.text??'').trim());
  const notes=usable.length?usable.map(m=>describeMark(m,height)).join('；')+'；未标注区域保持不变':'';
  const out=[text,notes].filter(Boolean).join('\n');
  if(!out)throw new Error('先写修改要求，或在图上标注想修改的地方');
  if(out.length>MAX_EDIT_DESCRIPTION)throw new Error('修改要求和标注说明加起来超过 '+MAX_EDIT_DESCRIPTION+' 字，请精简后再生成');
  return out;
}
/** 画幅调整另存新版本的说明：以当前图为原图，只改画幅。 */
export function resizeDescription(width:number,height:number,label:string):string {return '保持画面内容、文字和品牌风格不变，把画幅调整为'+label+'（'+width+' × '+height+' px），按新画幅重新安排构图与留白，不要拉伸或裁掉主体。';}
/** 版本条上的状态：未出图且结果未知/已取消的写「待核对」，与服务端拒绝再提交的判定一致。 */
export function versionTag(v:Pick<StudioVersion,'asset_id'|'state'|'operation'|'source'|'upload'>):string {
  if(!v.asset_id||!['succeeded','size_mismatch'].includes(v.state))return ['unknown','cancelled'].includes(v.state)?'待核对':['queued','running','reconciling','waiting_input','waiting_quota'].includes(v.state)?'生成中':'未成功';
  return v.source?'网络图':v.operation==='upload'?(v.upload?.name?.startsWith('找回')?'找回的图':'上传的图'):v.operation==='reference_edit'?'修改版':'AI 生图';
}
export const UPLOAD_PURPOSE_LABELS={brand:'品牌元素',person:'人物 / 身份',layout:'构图 / 布局',style:'风格 / 配色',object:'物体 / 素材'} as const;
/** 已删除配图留下的可用版本（素材库里的图）：可在其他图的「换来源」里找回为新一版。 */
export function recoverableVersions(items:readonly PlanItemVM[],studio:StudioSnapshot):Array<{version:StudioVersion;title:string}> {
  const live=new Set(items.map(i=>i.slot_id));
  return studio.slots.filter(s=>!live.has(s.id)).flatMap(s=>s.versions.filter(v=>v.asset_id&&v.actual_verified&&['succeeded','size_mismatch'].includes(v.state)).map(v=>({version:v,title:s.title||v.title||'已删除的配图'})));
}
// ——— 标注调整（拖动移动、拖手柄改大小）：坐标都在 viewBox 里（宽 1000、高 height），结果夹在图片范围内。 ———
export type MarkHandle='move'|'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'start'|'end';
export const RECT_HANDLES:ReadonlyArray<Exclude<MarkHandle,'move'|'start'|'end'>>=['nw','n','ne','e','se','s','sw','w'];
const MIN_MARK=8;
const round1=(n:number)=>Math.round(n*10)/10;
/** 涂抹路径长度上限：生成请求的标注 path 最长 6000 字符，留出余量。 */
export const BRUSH_PATH_LIMIT=5800;
/** 把涂抹路径压到 limit 字符以内：先把坐标取整，仍超长就均匀抽稀（保留起点和终点），形状基本不变。 */
export function fitPath(path:string,limit=BRUSH_PATH_LIMIT):string {
  const n=(path.match(/-?\d+(?:\.\d+)?/g)??[]).map(Number);let pts:Array<[number,number]>=[];for(let i=0;i+1<n.length;i+=2)pts.push([Math.round(n[i]!),Math.round(n[i+1]!)]);
  if(!pts.length)return '';
  const text=(list:Array<[number,number]>)=>list.map(([x,y],i)=>(i?'L':'M')+x+' '+y).join(' ');
  let out=text(pts);while(out.length>limit&&pts.length>2){const last=pts.at(-1)!;pts=pts.filter((_,i)=>i%2===0);if(pts.at(-1)!==last)pts.push(last);out=text(pts);}
  return out;
}
/** 涂抹路径整体平移（路径是「M x y L x y …」的数字对）；结果仍在长度上限内。 */
export function translatePath(path:string,dx:number,dy:number):string {let i=0;const moved=path.replace(/-?\d+(?:\.\d+)?/g,n=>String(round1(Number(n)+(i++%2===0?dx:dy))));return moved.length>BRUSH_PATH_LIMIT?fitPath(moved):moved;}
/** 标注的外接框：框选用自身，涂抹按路径，箭头按两端，改文字是一个点。 */
export function markBounds(m:StudioMark):{x:number;y:number;w:number;h:number} {
  if(m.type==='brush')return brushBounds(m.path);
  if(m.type==='arrow')return {x:Math.min(m.x,m.ex),y:Math.min(m.y,m.ey),w:Math.abs(m.ex-m.x),h:Math.abs(m.ey-m.y)};
  if(m.type==='text')return {x:m.x,y:m.y,w:0,h:0};
  return {x:m.x,y:m.y,w:m.w,h:m.h};
}
/** 按拖动位移调整一处标注：move 整体平移（不出图片边界）；框选拖八个手柄改大小（最小 8，越过对边时翻转）；箭头拖起点/终点。 */
export function adjustMark(m:StudioMark,mode:MarkHandle,dx:number,dy:number,height:number):StudioMark {
  const cx=(n:number)=>Math.max(0,Math.min(1000,n)),cy=(n:number)=>Math.max(0,Math.min(height,n));
  if(mode==='move'){
    const b=markBounds(m),mx=round1(Math.max(-b.x,Math.min(1000-(b.x+b.w),dx))),my=round1(Math.max(-b.y,Math.min(height-(b.y+b.h),dy)));
    return {...m,x:round1(m.x+mx),y:round1(m.y+my),ex:round1(m.ex+mx),ey:round1(m.ey+my),path:m.type==='brush'?translatePath(m.path,mx,my):m.path};
  }
  if(m.type==='arrow'){
    if(mode==='start'){const x=round1(cx(m.x+dx)),y=round1(cy(m.y+dy));return {...m,x,y,w:round1(Math.abs(m.ex-x)),h:round1(Math.abs(m.ey-y))};}
    if(mode==='end'){const ex=round1(cx(m.ex+dx)),ey=round1(cy(m.ey+dy));return {...m,ex,ey,w:round1(Math.abs(ex-m.x)),h:round1(Math.abs(ey-m.y))};}
    return m;
  }
  if(m.type!=='rect'||mode==='start'||mode==='end')return m;
  let x1=m.x,y1=m.y,x2=m.x+m.w,y2=m.y+m.h;
  if(mode.endsWith('w'))x1=cx(x1+dx);if(mode.endsWith('e'))x2=cx(x2+dx);if(mode.startsWith('n'))y1=cy(y1+dy);if(mode.startsWith('s'))y2=cy(y2+dy);
  let x=Math.min(x1,x2),y=Math.min(y1,y2),w=Math.abs(x2-x1),h=Math.abs(y2-y1);
  if(w<MIN_MARK){w=MIN_MARK;x=Math.min(x,1000-MIN_MARK);}if(h<MIN_MARK){h=MIN_MARK;y=Math.min(y,height-MIN_MARK);}
  return {...m,x:round1(x),y:round1(y),w:round1(w),h:round1(h),ex:round1(x+w),ey:round1(y+h)};
}
/** 从本机草稿读回的标注：字段齐全、数值有限才接受（坏数据直接丢掉，不进修改说明）。 */
export function sanitizeMark(v:unknown):StudioMark|null {
  const m=v as Partial<StudioMark>|null;if(!m||typeof m!=='object')return null;
  const num=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
  if(!num(m.id)||!(m.type==='rect'||m.type==='brush'||m.type==='arrow'||m.type==='text')||![m.x,m.y,m.w,m.h,m.ex,m.ey].every(num)||typeof m.path!=='string'||m.path.length>200000||typeof m.note!=='string')return null;
  return {id:m.id,type:m.type,x:m.x!,y:m.y!,w:m.w!,h:m.h!,ex:m.ex!,ey:m.ey!,path:m.path.length>BRUSH_PATH_LIMIT?fitPath(m.path):m.path,note:m.note.slice(0,300),...(m.type==='text'?{text:typeof m.text==='string'?m.text.slice(0,200):''}:{})};
}
