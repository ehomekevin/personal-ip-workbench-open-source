import {ContractError} from '@workbench/contracts';
// This owner tracks the entire brief operation, including the port's own cleanup.
// Aborting observation is not proof that the owned adapter has finished closing.
export class ImageAnalysisCleanupError extends Error {
 constructor(cause:unknown){super('Own image analysis adapter cleanup was not confirmed',{cause});this.name='ImageAnalysisCleanupError';}
}
export class ImageAnalysisLifecycle {
 private closing=false;
 private closed=false;
 private closePromise:Promise<void>|undefined;
 private readonly active=new Map<Promise<unknown>,AbortController>();
 private readonly cleanupErrors:unknown[]=[];
 private readonly timeout_ms:number;
 constructor(timeout_ms=180000){this.timeout_ms=timeout_ms;}
 run<T>(work:(signal:AbortSignal)=>Promise<T>,requestSignal?:AbortSignal):Promise<T>{
  // 关闭期间不再开始新分析；按仓库约定以可重试的 503 返回，本次未提交。
  if(this.closing)return Promise.reject(new ContractError('STORAGE_UNAVAILABLE','服务正在关闭，本次内容分析未开始，请稍后重试',{service_closing:true,pre_submit_failure:true},true));
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(new Error('Own image analysis observation timed out; original result unknown')),this.timeout_ms);
  timeout.unref();
  const signal=requestSignal?AbortSignal.any([controller.signal,requestSignal]):controller.signal;
  const pending=Promise.resolve().then(()=>{signal.throwIfAborted();return work(signal);});
  this.active.set(pending,controller);
  const settled=()=>{clearTimeout(timeout);this.active.delete(pending);};
  void pending.then(settled,error=>{if(error instanceof ImageAnalysisCleanupError)this.cleanupErrors.push(error);settled();});
  return pending;
 }
 beginClose(){
  if(this.closing)return;
  this.closing=true;
  for(const controller of this.active.values())controller.abort(new Error('Own image analysis module is closing; original result unknown'));
 }
 close():Promise<void>{
  if(this.closePromise)return this.closePromise;
  this.beginClose();
  return this.closePromise=(async()=>{await Promise.allSettled([...this.active.keys()]);if(this.cleanupErrors.length)throw new AggregateError(this.cleanupErrors,'Own image analysis cleanup is unconfirmed');this.closed=true;})();
 }
 snapshot(){return{close_requested:this.closing,fully_closed:this.closed,in_flight:this.active.size,...(this.cleanupErrors.length?{cleanup_failures:this.cleanupErrors.length}:{})};}
}
