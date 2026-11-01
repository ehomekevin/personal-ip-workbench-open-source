export type {ArtifactManifest,ArtifactOutput} from '@workbench/contracts';
export interface RenderRequest {revision_id:string;preset:string;mode:'preview'|'export'}
export interface MediaProgress {phase:string;completed:number;total:number|null;unit:'bytes'|'steps';elapsed_ms:number}
export interface MediaImportMetadata {kind:string;mime:string;topic_id?:string|null;purpose?:string;source_kind?:'user_uploaded'|'web_reference'|(string&{});origin?:'import'|'web';is_user_footage?:boolean;expected_sha256?:string;total_bytes?:number|null}
