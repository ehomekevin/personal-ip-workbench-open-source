export type DialogCloseReason = 'user_close' | 'cancel' | 'escape' | 'navigate' | 'completed';
// 页面隐藏（离开、进入 bfcache）按离开页面处理：记录 navigate 并停止跟随；bfcache 恢复后不续跟。
export function bindPageHide(target: EventTarget, onHide: () => void, signal?: AbortSignal): void { target.addEventListener('pagehide', () => onHide(), signal ? { signal } : {}); }

// 关闭是用户动作时先撤销提交资格；completed程序关闭不会发送取消。
export class TaskDialogSession {
  private active=false;
  private cancellation:Promise<void>|null=null;
  private readonly requestCancel:(reason:Exclude<DialogCloseReason,'completed'>)=>Promise<void>;
  constructor(requestCancel:(reason:Exclude<DialogCloseReason,'completed'>)=>Promise<void>){this.requestCancel=requestCancel;}
  begin(){this.active=true;this.cancellation=null;}
  close(reason:DialogCloseReason){
    if(!this.active)return this.cancellation;
    this.active=false;
    if(reason!=='completed')this.cancellation=this.requestCancel(reason);
    return this.cancellation;
  }
  isActive(){return this.active;}
}
