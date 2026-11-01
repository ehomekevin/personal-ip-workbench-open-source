import type {WorkbenchClient,RequestOptions} from './workbench-client.ts';
import type {FeatureContext,PageFeaturePort} from './feature-ports.ts';

// A scope lasts for one page load/action. It never reuses a previous navigation's
// response, and every mutation invalidates reads before it reaches the service.
export function createReadScope(base:WorkbenchClient,readSignal?:AbortSignal){
  const reads=new Map<string,Promise<unknown>>();let active=true,writes=0;
  const signal=(original?:AbortSignal)=>readSignal?original?AbortSignal.any([original,readSignal]):readSignal:original;
  async function read<T>(path:string,options:RequestOptions,operation:(signal?:AbortSignal)=>Promise<T>):Promise<T>{
    const scopedSignal=signal(options.signal);scopedSignal?.throwIfAborted();
    const url=new URL(path,'http://read-scope.invalid');
    // Foreground jobs/candidates and changing status feeds must reach the
    // service on every poll, even while the enclosing action is still active.
    const snapshot=/^\/api\/v1\/(settings|overview|accounts|topics|assets|works)$/.test(url.pathname)||/^\/api\/v1\/(topics|documents|production-plans|works)\/[^/]+$/.test(url.pathname)||/^\/api\/v1\/documents\/[^/]+\/revisions\/[^/]+$/.test(url.pathname);
    if(!active||writes||!snapshot){const value=await operation(scopedSignal);scopedSignal?.throwIfAborted();return value;}
    url.searchParams.sort();const key=url.pathname+url.search;
    let pending=reads.get(key);
    if(!pending){pending=operation(scopedSignal);reads.set(key,pending);pending.catch(()=>{if(reads.get(key)===pending)reads.delete(key);});}
    const value=await pending;scopedSignal?.throwIfAborted();return structuredClone(value) as T;
  }
  async function mutate<T>(operation:()=>Promise<T>){reads.clear();writes++;try{return await operation();}finally{writes--;reads.clear();}}
  const client:WorkbenchClient={...base,
    invalidateReads(){reads.clear();base.invalidateReads?.();},
    request<T>(method:'GET'|'POST'|'PATCH'|'PUT',path:string,body?:unknown,options:RequestOptions={}){return method==='GET'?read<T>(path,options,scopedSignal=>base.request<T>(method,path,body,{...options,signal:scopedSignal})):mutate(()=>base.request<T>(method,path,body,options));},
    getSettings(original){return read('/api/v1/settings',{signal:original},scopedSignal=>base.getSettings(scopedSignal));},
    getDocument(id,original){return read('/api/v1/documents/'+encodeURIComponent(id),{signal:original},scopedSignal=>base.getDocument(id,scopedSignal));},
    patchSettings(input,options){return mutate(()=>base.patchSettings(input,options));},
    saveDocument(id,input,options){return mutate(()=>base.saveDocument(id,input,options));},
    cancelJob(id,version,options){return mutate(()=>base.cancelJob(id,version,options));},
    ...(base.upload?{upload<T>(path:string,file:File,fields:Readonly<Record<string,string>>,options?:RequestOptions){return mutate(()=>base.upload!<T>(path,file,fields,options));}}:{})
  };
  return {client,close(){active=false;reads.clear();}};
}
export function withReadScope<P extends PageFeaturePort['page']>(feature:PageFeaturePort<P>):PageFeaturePort<P>{
  async function run<T>(context:FeatureContext,operation:(scoped:FeatureContext)=>Promise<T>,navigationReads=true):Promise<T>{
    // Actions keep their original job cancellation/save lifecycle. A late job
    // acceptance must still be readable so the existing handler can cancel it.
    const scope=createReadScope(context.client,navigationReads?context.readSignal:undefined);try{return await operation({...context,client:scope.client});}finally{scope.close();}
  }
  return {...feature,load:context=>run(context,scoped=>feature.load(scoped)),dispatch:(action,context)=>run(context,scoped=>feature.dispatch(action,scoped),false),
    ...(feature.loadMore?{loadMore:(context:FeatureContext)=>run(context,scoped=>feature.loadMore!(scoped))}:{}),
    ...(feature.input?{input:(action:Parameters<NonNullable<typeof feature.input>>[0],context:FeatureContext)=>run(context,scoped=>feature.input!(action,scoped),false)}:{})};
}
