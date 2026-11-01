// Own-resource lifecycle used by the admitted port and ordinary delayed-resource fixtures.
export interface FiniteCaptureDependencies<Bundle,UI,Browser,Page>{
 build(signal:AbortSignal):Promise<Bundle>;
 createServer(bundle:Bundle):UI;
 listen(server:UI):Promise<void>;
 launch():Promise<Browser>;
 newPage(browser:Browser):Promise<Page>;
 capture(server:UI,page:Page,index:number,signal:AbortSignal,check:()=>void):Promise<void>;
 closePage(page:Page):Promise<void>;
 closeBrowser(browser:Browser):Promise<void>;
 closeServer(server:UI):Promise<void>;
}
export function managedFiniteCapture<Bundle,UI,Browser,Page>(dependencies:FiniteCaptureDependencies<Bundle,UI,Browser,Page>){
 let generation=0,closeRequested=false,fullyClosed=false,initialization:Promise<void>|undefined,closePromise:Promise<void>|undefined;
 let server:UI|undefined,browser:Browser|undefined,page:Page|undefined;
 const active=new Set<Promise<void>>();
 function check(signal:AbortSignal,epoch:number){signal.throwIfAborted();if(closeRequested||epoch!==generation)throw new Error('Own capture resources are closing');}
 async function dispose(){
  const errors:unknown[]=[];
  // Clear ownership only after each close confirms success; a failed close cannot report local_stop.
  if(page!==undefined)try{await dependencies.closePage(page);page=undefined;}catch(error){errors.push(error);}
  if(browser!==undefined)try{await dependencies.closeBrowser(browser);browser=undefined;}catch(error){errors.push(error);}
  if(server!==undefined)try{await dependencies.closeServer(server);server=undefined;}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,'Own capture resources did not all close');
 }
 async function initialize(signal:AbortSignal,epoch:number){
  try{
   const bundle=await dependencies.build(signal);check(signal,epoch);
   server=dependencies.createServer(bundle);check(signal,epoch);
   await dependencies.listen(server);check(signal,epoch);
   browser=await dependencies.launch();check(signal,epoch);
   page=await dependencies.newPage(browser);check(signal,epoch);
  }catch(error){
   closeRequested=true;generation++;
   try{await dispose();}catch(cleanup){throw new AggregateError([error,cleanup],'Capture initialization and cleanup failed');}
   throw error;
  }
 }
 return{
  capture(index:number,signal:AbortSignal):Promise<void>{
   const epoch=generation;
   const pending=(async()=>{
    check(signal,epoch);initialization??=initialize(signal,epoch);await initialization;check(signal,epoch);
    await dependencies.capture(server!,page!,index,signal,()=>check(signal,epoch));check(signal,epoch);
   })();
   active.add(pending);void pending.then(()=>active.delete(pending),()=>active.delete(pending));return pending;
  },
  close():Promise<void>{
   if(closePromise)return closePromise;
   closeRequested=true;generation++;
   return closePromise=(async()=>{
    // This includes build/listen/launch/newPage that do not accept AbortSignal.
    // A late return is owned and disposed before close resolves.
    await Promise.allSettled([...active,...(initialization?[initialization]:[])]);
    await dispose();fullyClosed=true;
   })();
  },
  snapshot:()=>({close_requested:closeRequested,fully_closed:fullyClosed,in_flight:active.size,owned_resources:{server:server!==undefined,browser:browser!==undefined,page:page!==undefined}})
 };
}
