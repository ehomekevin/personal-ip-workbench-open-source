import {lstatSync,readFileSync} from 'node:fs';
export interface NativeReadCounts{send_attempts:number|null;response_confirmations:number|null;response_errors:number|null}
export interface NativeReadLowerBound{send_attempts:number;response_confirmations:number;response_errors:number}
export interface NativeReadKnownBounds{completion_validation:NativeReadLowerBound;recovery_query:NativeReadLowerBound}
export interface NativeReadAudit{scope:'codex_image_rpc';audit_status:'present'|'missing'|'invalid';audit_path:string;completion_validation:NativeReadCounts;recovery_query:NativeReadCounts;known_lower_bound:NativeReadKnownBounds}
const unknown=():NativeReadCounts=>({send_attempts:null,response_confirmations:null,response_errors:null});
const zero=():NativeReadLowerBound=>({send_attempts:0,response_confirmations:0,response_errors:0});
const emptyBounds=():NativeReadKnownBounds=>({completion_validation:zero(),recovery_query:zero()});
export function readNativeReadAudit(path:string):NativeReadAudit{
 const report:NativeReadAudit={scope:'codex_image_rpc',audit_status:'missing',audit_path:path,completion_validation:unknown(),recovery_query:unknown(),known_lower_bound:emptyBounds()};
 let raw:string;
 try{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Audit is not an owned regular file');raw=readFileSync(path,'utf8');}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return report;report.audit_status='invalid';return report;}
 const completion=report.known_lower_bound.completion_validation,recovery=report.known_lower_bound.recovery_query;
 const pending=new Map<string,'execute'|'query'>();
 try{
  for(const line of raw.split('\n').filter(Boolean)){
   const row=JSON.parse(line) as Record<string,unknown>;
   if(row.schema_version!=='image-native-rpc.v1'||typeof row.session_id!=='string'||!['execute','query'].includes(String(row.purpose))||!['send','receive'].includes(String(row.direction))||typeof row.rpc_method!=='string')throw new Error('Incomplete audit metadata');
   if(row.rpc_method!=='thread/read')continue;
   if(typeof row.request_id!=='number'||!Number.isInteger(row.request_id))throw new Error('Read request identity missing');
   const key=row.session_id+':'+row.request_id,purpose=row.purpose as 'execute'|'query',counts=purpose==='execute'?completion:recovery;
   if(row.direction==='send'){
    if(pending.has(key))throw new Error('Read request identity repeated');pending.set(key,purpose);counts.send_attempts++;
   }else{
    if(pending.get(key)!==purpose)throw new Error('Read response has no matching audited send');
    if(row.native_error_code!==null&&typeof row.native_error_code!=='number')throw new Error('Read error status absent');
    pending.delete(key);counts.response_confirmations++;if(typeof row.native_error_code==='number')counts.response_errors++;
   }
  }
  report.audit_status='present';report.completion_validation={...completion};report.recovery_query={...recovery};return report;
 }catch{
  // The remaining file is unknown, but already validated rows cannot be erased by a bad tail.
  report.audit_status='invalid';return report;
 }
}
const countKeys=['send_attempts','response_confirmations','response_errors'] as const;
const groups=['completion_validation','recovery_query'] as const;
const validCount=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
export function aggregateNativeReadAudits(reports:NativeReadAudit[]){
 const scoped=reports.filter(report=>report.scope==='codex_image_rpc'),known=emptyBounds();
 for(const report of scoped)for(const group of groups)for(const field of countKeys){
  const exact=report.audit_status==='present'?report[group][field]:null,bound=report.known_lower_bound?.[group]?.[field];
  // A zero lower bound says no positive fact was established; it never fills an unknown total.
  known[group][field]+=Math.max(validCount(exact)?exact:0,validCount(bound)?bound:0);
 }
 const complete=reports.length>0&&scoped.length===reports.length&&scoped.every(report=>report.audit_status==='present'&&groups.every(group=>countKeys.every(field=>validCount(report[group][field]))));
 function sum(group:typeof groups[number]):NativeReadCounts{
  if(!complete)return unknown();
  return{send_attempts:scoped.reduce((n,row)=>n+row[group].send_attempts!,0),response_confirmations:scoped.reduce((n,row)=>n+row[group].response_confirmations!,0),response_errors:scoped.reduce((n,row)=>n+row[group].response_errors!,0)};
 }
 return{schema_version:'codex-image-rpc-read-summary/2' as const,scope:'codex_image_rpc' as const,audit_files:scoped.length,audit_status:complete?'present':'incomplete',completion_validation:sum('completion_validation'),recovery_query:sum('recovery_query'),known_lower_bound:known,recovery_violation:known.recovery_query.send_attempts>0};
}
