import { DEFAULT_OPERATING_PREFERENCES,SaveOperatingPreferencesSchema,ContractError,type OperatingPreferences,type SaveOperatingPreferences,type RequestContext,type ConfigurationCheck } from '@workbench/contracts';
import { transaction,type DatabaseSync } from '@workbench/storage/connection';
import { readIdempotent,storeIdempotent } from '@workbench/storage/revisions';
import type { ApplicationContext } from '../ports/index.ts';
import { assertRequestIdentity } from '../documents/index.ts';
interface State {version:number;preferences:OperatingPreferences;checks:Record<string,ConfigurationCheck>}
export const configurationKey=(workspace:string)=>'configuration.v1:'+workspace;
export function readConfiguration(db:DatabaseSync,workspace:string):State {
  const row=db.prepare('SELECT value FROM application_metadata WHERE key=?').get(configurationKey(workspace));
  if(!row)return {version:1,preferences:structuredClone(DEFAULT_OPERATING_PREFERENCES),checks:{}};
  const state=JSON.parse(String(row.value)) as State;SaveOperatingPreferencesSchema.parse({expected_version:state.version,preferences:state.preferences});return structuredClone(state);
}
export function operatingPreferences(db:DatabaseSync,workspace:string):OperatingPreferences{return readConfiguration(db,workspace).preferences;}
export class ConfigurationSettings {
  readonly context:ApplicationContext;
  constructor(context:ApplicationContext){this.context=context;}
  get(request:RequestContext){assertRequestIdentity(this.context,request);return readConfiguration(this.context.db,request.workspace_id);}
  private write(state:State){this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(configurationKey(this.context.identity.workspace_id),JSON.stringify(state));}
  save(request:RequestContext,input:SaveOperatingPreferences){
    assertRequestIdentity(this.context,request);SaveOperatingPreferencesSchema.parse(input);
    return transaction(this.context.db,()=>{const replay=readIdempotent<State>(this.context.db,request,'configuration.preferences',input);if(replay)return replay;const state=this.get(request);if(state.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','设置已由另一入口修改，请核对最新配置');
      const next={...state,version:state.version+1,preferences:structuredClone(input.preferences)};this.write(next);storeIdempotent(this.context.db,request,'configuration.preferences',input,next);return next;});
  }
  record(request:RequestContext,check:ConfigurationCheck,commit?:()=>void){assertRequestIdentity(this.context,request);transaction(this.context.db,()=>{const state=this.get(request);const previous=state.checks[check.tool];if(!previous||previous.checked_at<=check.checked_at)this.write({...state,checks:{...state.checks,[check.tool]:check}});commit?.();});return check;}
}
