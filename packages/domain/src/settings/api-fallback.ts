import type {ApiFallbackConfiguration} from '@workbench/contracts';
import type {DatabaseSync} from '@workbench/storage/connection';
import {workspaceSettings} from '@workbench/storage/settings';
export const apiFallbackKey=(workspace:string)=>'api-fallback.v1:'+workspace;
export function readApiFallback(db:DatabaseSync,workspace:string):ApiFallbackConfiguration {const s=workspaceSettings(db,workspace),row=db.prepare('SELECT value FROM application_metadata WHERE key=?').get(apiFallbackKey(workspace));const value=row?JSON.parse(String(row.value)):{provider:'openai',model:'',max_output_tokens:8192};return {...value,enabled:s.api_fallback_enabled,settings_version:s.version};}
