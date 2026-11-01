// Keep ownership of an asynchronous service start until its eventual result is closed.
export function managedFiniteSetup<App>(dependencies:{start(signal:AbortSignal):Promise<App>;initialize(app:App,signal:AbortSignal,check:()=>void):Promise<void>;beforeClose(app:App):Promise<void>;close(app:App):Promise<void>}){
 let app:App|undefined,generation=0,closeRequested=false,fullyClosed=false,starting:Promise<void>|undefined,closing:Promise<void>|undefined;
 function check(signal:AbortSignal,epoch:number){signal.throwIfAborted();if(closeRequested||epoch!==generation)throw new Error('Own service setup is closing');}
 return{
  setup(signal:AbortSignal):Promise<void>{
   if(starting)return Promise.reject(new Error('Own service setup was already started'));
   const epoch=generation;
   return starting=(async()=>{check(signal,epoch);app=await dependencies.start(signal);check(signal,epoch);await dependencies.initialize(app,signal,()=>check(signal,epoch));check(signal,epoch);})();
  },
  close():Promise<void>{
   if(closing)return closing;closeRequested=true;generation++;
   return closing=(async()=>{
    await Promise.allSettled(starting?[starting]:[]);const errors:unknown[]=[];
    if(app!==undefined){try{await dependencies.beforeClose(app);}catch(error){errors.push(error);}try{await dependencies.close(app);app=undefined;}catch(error){errors.push(error);}}
    if(errors.length)throw new AggregateError(errors,'Own service setup resources did not all close');fullyClosed=true;
   })();
  },
  snapshot:()=>({close_requested:closeRequested,fully_closed:fullyClosed,owned_app:app!==undefined})
 };
}
