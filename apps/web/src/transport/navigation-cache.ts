import type {ServiceIdentity} from '@workbench/contracts';
import type {UiState,ViewContext} from '../app/view-model.ts';
import type {WorkbenchClient,RequestOptions} from './workbench-client.ts';

// These are presentation snapshots, never request responses or action inputs.
// Every visit revalidates against the service before enabling decisions/editing.
const selectors:Record<UiState['page'],readonly (keyof UiState)[]>={
  today:['topic'],sources:['sourceTab','sourceFilter','sourceQuery','news'],
  create:['topic','editTab','platform'],knowledge:['knowledge','knowledgeQuery'],
  schedule:['topic','scheduleView','week'],retro:['topic','retroTab','retroPlatform','period'],settings:[]
};
export const READ_ONLY_NAVIGATION_ACTIONS=new Set(['search','global-search','search-knowledge','select-news','read-news','source-tab','source-filter','source-query','knowledge-select','knowledge-query','play-video','slide-next','slide-prev','benchmark-record','benchmark-more','benchmark-list','benchmark-back']);
export function createNavigationCache(base:WorkbenchClient,limit=12){
  const entries=new Map<string,ViewContext>();let currentIdentity='',epoch=0,writes=0,identityChanged=false;
  const identityKey=(identity:ServiceIdentity)=>JSON.stringify([identity.workspace_id,identity.service_instance_id,identity.contract_version]);
  function bind(identity:ServiceIdentity){const next=identityKey(identity);if(currentIdentity!==next){entries.clear();epoch++;currentIdentity=next;}}
  function key(identity:ServiceIdentity,ui:Readonly<UiState>){return identityKey(identity)+':'+JSON.stringify([ui.page,...selectors[ui.page].map(field=>ui[field])]);}
  function clear(){entries.clear();epoch++;}
  function checkIdentity(){if(identityChanged)throw new Error('工作区身份已变化，请刷新工作台重新连接');}
  function operationTopic(path?:string){return path?.match(/^\/api\/v1\/topics\/([^/]+)\/operations\/ensure$/)?.[1];}
  // This ensure only creates/reads the separate viewpoints document. That
  // document is never part of a ViewContext snapshot. Saving it uses the normal
  // document mutation below and invalidates all dependent presentation pages.
  const viewpointEnsure=(path?:string)=>!!path&&/^\/api\/v1\/topics\/[^/]+\/viewpoints$/.test(path);
  function invalidate(path?:string){
    if(viewpointEnsure(path))return;
    // The navigation ensure only changes the operations projection. Retain the
    // saved text/list presentation, but never show its old automation decision.
    const topic=operationTopic(path);if(topic){
      for(const entry of entries.values())if(entry.projections.operations?.topicId===decodeURIComponent(topic)){delete entry.projections.operations;delete entry.projections.operationsError;}return;
    }
    clear();
  }
  async function mutate<T>(path:string|undefined,operation:()=>Promise<T>){checkIdentity();const contentWrite=!operationTopic(path)&&!viewpointEnsure(path);invalidate(path);if(contentWrite)writes++;try{return await operation();}finally{if(contentWrite)writes--;invalidate(path);}}
  const client:WorkbenchClient={...base,
    async identity(signal){checkIdentity();const value=await base.identity(signal);if(currentIdentity&&currentIdentity!==identityKey(value)){identityChanged=true;clear();checkIdentity();}return value;},
    invalidateReads(){clear();base.invalidateReads?.();},
    request<T>(method:'GET'|'POST'|'PATCH'|'PUT',path:string,body?:unknown,options?:RequestOptions){checkIdentity();return method==='GET'?base.request<T>(method,path,body,options):mutate(method==='POST'?path:undefined,()=>base.request<T>(method,path,body,options));},
    getSettings(signal){checkIdentity();return base.getSettings(signal);},
    getDocument(id,signal){checkIdentity();return base.getDocument(id,signal);},
    ...(base.assetContent?{assetContent(id:string,signal?:AbortSignal){checkIdentity();return base.assetContent!(id,signal);}}:{}),
    patchSettings:(input,options)=>mutate(undefined,()=>base.patchSettings(input,options)),
    saveDocument:(id,input,options)=>mutate(undefined,()=>base.saveDocument(id,input,options)),
    cancelJob:(id,version,options)=>mutate(undefined,()=>base.cancelJob(id,version,options)),
    ...(base.upload?{upload<T>(...args:Parameters<NonNullable<WorkbenchClient['upload']>>){return mutate(undefined,()=>base.upload!<T>(...args));}}:{})
  };
  return {client,bind,clear,get epoch(){return epoch;},
    remember(identity:ServiceIdentity,ui:Readonly<UiState>,view:ViewContext,expectedEpoch=epoch){
      bind(identity);if(identityChanged||writes||ui.page==='settings'||view.provenance!=='service'||expectedEpoch!==epoch)return;
      const id=key(identity,ui),snapshot=structuredClone({...view,ui:{...ui,task:null}});
      entries.delete(id);entries.set(id,snapshot);while(entries.size>limit)entries.delete(entries.keys().next().value!);
    },
    recall(identity:ServiceIdentity,ui:Readonly<UiState>){bind(identity);if(identityChanged)return;const id=key(identity,ui),snapshot=entries.get(id);if(!snapshot)return;entries.delete(id);entries.set(id,snapshot);return structuredClone(snapshot);}
  };
}
