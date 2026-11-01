import { createTemplateHelpers } from '../../../components/templateHelpers.ts';
// 真实生图前的统一确认（配图工作台的单张生成 / 生成修改版 / 调整画幅另存，以及旧版逐张面板的生成）：
// 写明图片、渠道、模型、张数和剩余次数；确认按钮在弹窗底部，并在弹窗出现后短暂不可点（防双击穿透）。
const {btn,esc}=createTemplateHelpers([]);
export const GENERATE_CONFIRM_TITLE='公众号配图 · 确认生成';
export const GENERATE_ARM_MS=350;
export interface GenerateConfirmFacts {
  lead:string; image:string; provider:string; model:string; count:number;
  /** number=剩余次数；null=不限次数；undefined=读不到，不显示这一行。 */ remaining:number|null|undefined;
  extra?:Array<[string,string]>;
  /** 弹窗标题；默认「公众号配图 · 确认生成」，通用图像面板用自己的标题。 */ title?:string;
  /** 弹窗内可改的渠道 / 模型控件（HTML），放在核对清单之后。 */ choice?:string;
}
export function generateConfirmDialog(f:GenerateConfirmFacts,confirm:{action:string;attrs?:string},cancel:{label:string;action:string}={label:'取消',action:'close-dialog'},arm=''):{title:string;body:string;foot:string}{
  const fact=(k:string,v:string)=>'<div><dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd></div>';
  const limited=typeof f.remaining==='number';
  const body='<div class="iwb-confirm iwb-gen-confirm"><p>'+f.lead+(f.remaining===null?'所选渠道不限次数。':'这会提交一次真实生图'+(limited?'，用掉 '+f.count+' 次生图次数':'')+'。')+'</p>'
    +'<dl class="iwb-gen-facts">'+fact('图片',f.image)+fact('生成渠道',f.provider)+fact('生图模型',f.model)+fact('张数',f.count+' 张')+(limited?fact('本渠道剩余',f.remaining+' 次'):'')+(f.extra??[]).map(([k,v])=>fact(k,v)).join('')+'</dl>'+(f.choice?'<div class="iwb-gen-choice">'+f.choice+'</div>':'')
    +(limited&&(f.remaining as number)<f.count?'<p class="iwb-confirm-warn" role="alert">本渠道生图次数不够，确认后不会入队，可在设置里放开次数。</p>':'')+'</div>';
  return {title:f.title??GENERATE_CONFIRM_TITLE,body,foot:btn(cancel.label,cancel.action)+btn('确认生成 '+f.count+' 张',confirm.action,true,[confirm.attrs??'',arm].filter(Boolean).join(' '))};
}
/**
 * 确认按钮的防穿透冷却，绑定到具体一次弹窗：每次打开生成新 token，计时器只解开带自己 token 的按钮；
 * 同一弹窗冷却期内重绘（例如切换渠道 / 模型）继续沿用同一 token 保持禁用，冷却过后重绘直接可点。旧弹窗的计时器碰不到新弹窗。
 */
// 全局递增：工作台与旧面板各有一个实例，共用同一个 #dialog，token 不能撞。
let armSeq=0;
export class ConfirmArm {
  private current?:{token:string;until:number};
  private readonly doc:()=>Pick<Document,'querySelectorAll'>|undefined; private readonly ms:number;
  constructor(doc:()=>Pick<Document,'querySelectorAll'>|undefined,ms=GENERATE_ARM_MS){this.doc=doc;this.ms=ms;}
  /** 打开一个新的确认弹窗：返回要写在确认按钮上的属性。 */
  open():string{const token='arm-'+(++armSeq),until=Date.now()+this.ms;this.current={token,until};setTimeout(()=>this.release(token),this.ms);return this.attrs();}
  /** 当前弹窗重绘时用：冷却未过返回禁用属性（同一 token），已过返回空。 */
  attrs():string{const c=this.current;return c&&Date.now()<c.until?'disabled data-arming="'+c.token+'"':'';}
  /** 弹窗关闭：作废当前 token。 */
  reset(){this.current=undefined;}
  private release(token:string){if(this.current?.token!==token)return;for(const b of Array.from(this.doc()?.querySelectorAll?.<HTMLButtonElement>('#dialog button[data-arming="'+token+'"]')??[])){b.removeAttribute('data-arming');b.disabled=false;}}
}

type Rect={x:number;y:number;width:number;height:number};
// 最近一次点击的按钮位置（捕获阶段记录，早于各入口的点击处理）：确认弹窗据此避开触发按钮。
let lastClick:{rect:Rect;at:number}|undefined;
if(typeof document!=='undefined'&&typeof document.addEventListener==='function')document.addEventListener('click',e=>{const b=(e.target as Element|null)?.closest?.('button,[role="button"]');const r=b?.getBoundingClientRect?.();if(r)lastClick={rect:{x:r.x,y:r.y,width:r.width,height:r.height},at:Date.now()};},{capture:true});
const overlap=(a:Rect,b:Rect)=>!(a.x>=b.x+b.width||a.x+a.width<=b.x||a.y>=b.y+b.height||a.y+a.height<=b.y);
/**
 * 防误触避让（所有生图确认入口共用）：确认按钮不能落在刚点的触发按钮原位置。打开确认弹窗后检查一次，
 * 之后窗口尺寸、可视区域（小屏键盘弹出）或弹窗内容高度变化时再复核；重叠就把弹窗贴到屏幕另一端，弹窗关闭即停止。
 * 触发位置默认取最近一次点击的按钮（构造时在 document 上以捕获阶段记录），也可以显式传入。
 */
export class TriggerGuard {
  private readonly doc:()=>Document|undefined; private stopper?:()=>void;
  constructor(doc:()=>Document|undefined){this.doc=doc;}
  /** 确认弹窗打开后调用。trigger 不传时用 3 秒内最近一次点击的按钮。 */
  watch(trigger?:Rect){this.stop();const doc=this.doc(),dialog=doc?.getElementById?.('dialog')as HTMLElement|null|undefined,rect=trigger??(lastClick&&Date.now()-lastClick.at<3000?lastClick.rect:undefined);if(!doc||!dialog||!rect)return;
    const check=()=>{dialog.style.margin='';delete dialog.dataset.avoid;const go=dialog.querySelector<HTMLElement>('.dialog-foot .button.primary, .dialog-foot [data-action$="-confirm"]')?.getBoundingClientRect?.();if(!go||!overlap(go,rect))return;
      const view=doc.defaultView?.innerHeight??0,first=rect.y+rect.height/2>view/2?'top':'bottom',place=(where:string)=>{dialog.style.margin=where==='top'?'12px auto auto':'auto auto 12px';dialog.dataset.avoid=where;};
      place(first);const again=dialog.querySelector<HTMLElement>('.dialog-foot .button.primary, .dialog-foot [data-action$="-confirm"]')?.getBoundingClientRect?.();if(again&&overlap(again,rect))place(first==='top'?'bottom':'top');};
    check();const win=doc.defaultView,ac=new AbortController(),opts={signal:ac.signal};win?.addEventListener?.('resize',check,opts);win?.visualViewport?.addEventListener?.('resize',check,opts);
    const ro=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>check()):undefined;ro?.observe(dialog);dialog.addEventListener?.('close',()=>this.stop(),opts);
    this.stopper=()=>{ac.abort();ro?.disconnect();dialog.style.margin='';delete dialog.dataset.avoid;};}
  /** 弹窗关闭或换成别的内容时调用。 */
  stop(){const s=this.stopper;this.stopper=undefined;s?.();}
}
