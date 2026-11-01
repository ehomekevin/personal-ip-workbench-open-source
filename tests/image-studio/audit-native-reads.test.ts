import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {imageRpcAudit,imageAuditPath} from '../../packages/adapters/src/media/image/audit.ts';
import type {JsonObject} from '../../packages/contracts/src/index.ts';
import type {ImageProviderInput} from '../../packages/adapters/src/media/image/types.ts';
import {readNativeReadAudit,aggregateNativeReadAudits} from './runtime-native-audit.ts';
const counts=(sends:number|null,responses:number|null,errors:number|null)=>({send_attempts:sends,response_confirmations:responses,response_errors:errors});
test('existing RPC audit separates new-execute completion checks from recovery read sends and responses',()=>{
 const root=mkdtempSync(join(import.meta.dirname,'.studio-audit-'));try{
  const input={work_directory:root} as ImageProviderInput,execute=imageRpcAudit(input,'execute'),recovery=imageRpcAudit(input,'query');
  const emit=(sink:typeof execute,direction:'send'|'receive',message:JsonObject)=>sink({at:new Date().toISOString(),direction,message});
  emit(execute,'send',{id:1,method:'initialize',params:{}});emit(execute,'receive',{id:1,result:{}});
  emit(execute,'send',{id:2,method:'thread/read',params:{threadId:'fixture-thread'}});emit(execute,'receive',{id:2,result:{thread:{id:'fixture-thread'}}});
  // A durable send is an attempt, even if no transport response follows.
  emit(execute,'send',{id:3,method:'thread/read',params:{threadId:'fixture-thread'}});
  emit(recovery,'send',{id:1,method:'thread/read',params:{threadId:'fixture-thread'}});emit(recovery,'receive',{id:1,error:{code:-32000}});
  const report=readNativeReadAudit(imageAuditPath(input));assert.equal(report.audit_status,'present');assert.deepEqual(report.completion_validation,counts(2,1,0));assert.deepEqual(report.recovery_query,counts(1,1,1));
  const summary=aggregateNativeReadAudits([report]);assert.deepEqual(summary.completion_validation,counts(2,1,0));assert.deepEqual(summary.recovery_query,counts(1,1,1));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('missing, malformed and unmatched audit cannot invent zero read counts',()=>{
 const root=mkdtempSync(join(import.meta.dirname,'.studio-audit-'));try{
  const path=join(root,'owned-audit.ndjson'),missing=readNativeReadAudit(path);assert.equal(missing.audit_status,'missing');assert.deepEqual(missing.completion_validation,counts(null,null,null));assert.deepEqual(aggregateNativeReadAudits([]).recovery_query,counts(null,null,null));
  writeFileSync(path,'{partial');assert.equal(readNativeReadAudit(path).audit_status,'invalid');
  writeFileSync(path,JSON.stringify({schema_version:'image-native-rpc.v1',session_id:'fixture',purpose:'execute',direction:'receive',rpc_method:'thread/read',request_id:1,native_error_code:null})+'\n');const invalid=readNativeReadAudit(path);assert.equal(invalid.audit_status,'invalid');assert.deepEqual(invalid.completion_validation,counts(null,null,null));
  writeFileSync(path,'');const present=readNativeReadAudit(path);assert.equal(present.audit_status,'present');assert.deepEqual(present.completion_validation,counts(0,0,0));assert.deepEqual(aggregateNativeReadAudits([present,missing]).recovery_query,counts(null,null,null));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('known recovery sends survive missing or invalid siblings while complete totals remain null',()=>{
 const root=mkdtempSync(join(import.meta.dirname,'.studio-audit-'));try{
  const input={work_directory:root} as ImageProviderInput,sink=imageRpcAudit(input,'query');sink({at:new Date().toISOString(),direction:'send',message:{id:1,method:'thread/read',params:{threadId:'fixture-thread'}}});sink({at:new Date().toISOString(),direction:'receive',message:{id:1,error:{code:-32000}}});
  const known=readNativeReadAudit(imageAuditPath(input)),missing=readNativeReadAudit(join(root,'missing.ndjson'));writeFileSync(join(root,'invalid.ndjson'),'{partial');const invalid=readNativeReadAudit(join(root,'invalid.ndjson'));
  for(const other of [missing,invalid]){const result=aggregateNativeReadAudits([known,other]);assert.deepEqual(result.recovery_query,counts(null,null,null));assert.deepEqual(result.known_lower_bound.recovery_query,counts(1,1,1));assert.equal(result.recovery_violation,true);assert.equal(result.audit_status,'incomplete');}
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('all missing audits and completion-only partial audits keep unknown totals without a recovery violation',()=>{
 const root=mkdtempSync(join(import.meta.dirname,'.studio-audit-'));try{
  const missing=readNativeReadAudit(join(root,'missing.ndjson')),input={work_directory:root} as ImageProviderInput,sink=imageRpcAudit(input,'execute');sink({at:new Date().toISOString(),direction:'send',message:{id:1,method:'thread/read',params:{threadId:'fixture-thread'}}});sink({at:new Date().toISOString(),direction:'receive',message:{id:1,result:{thread:{id:'fixture-thread'}}}});
  for(const result of [aggregateNativeReadAudits([]),aggregateNativeReadAudits([missing,missing])]){assert.deepEqual(result.recovery_query,counts(null,null,null));assert.deepEqual(result.known_lower_bound.recovery_query,counts(0,0,0));assert.equal(result.recovery_violation,false);}
  const partial=aggregateNativeReadAudits([readNativeReadAudit(imageAuditPath(input)),missing]);assert.deepEqual(partial.completion_validation,counts(null,null,null));assert.deepEqual(partial.known_lower_bound.completion_validation,counts(1,1,0));assert.deepEqual(partial.known_lower_bound.recovery_query,counts(0,0,0));assert.equal(partial.recovery_violation,false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('invalid audit tail cannot erase an already validated send but never fabricates a response',()=>{
 const root=mkdtempSync(join(import.meta.dirname,'.studio-audit-'));try{
  const path=join(root,'owned-partial.ndjson'),send={schema_version:'image-native-rpc.v1',session_id:'fixture',purpose:'query',direction:'send',rpc_method:'thread/read',request_id:1,native_error_code:null};writeFileSync(path,JSON.stringify(send)+'\n{partial');
  const invalid=readNativeReadAudit(path);assert.equal(invalid.audit_status,'invalid');assert.deepEqual(invalid.recovery_query,counts(null,null,null));assert.deepEqual(invalid.known_lower_bound.recovery_query,counts(1,0,0));assert.equal(aggregateNativeReadAudits([invalid]).recovery_violation,true);
  writeFileSync(path,JSON.stringify(send)+'\n'+JSON.stringify({...send,direction:'receive',request_id:2})+'\n');const unmatched=readNativeReadAudit(path);assert.equal(unmatched.audit_status,'invalid');assert.deepEqual(unmatched.known_lower_bound.recovery_query,counts(1,0,0));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('only Codex image RPC reports contribute read facts; complete zero stays exact zero',()=>{
 const root=mkdtempSync(join(import.meta.dirname,'.studio-audit-'));try{
  const path=join(root,'empty.ndjson');writeFileSync(path,'');const present=readNativeReadAudit(path),complete=aggregateNativeReadAudits([present]);assert.deepEqual(complete.recovery_query,counts(0,0,0));assert.deepEqual(complete.known_lower_bound.recovery_query,counts(0,0,0));assert.equal(complete.recovery_violation,false);
  const foreign={...present,scope:'agy',recovery_query:counts(8,7,1),known_lower_bound:{completion_validation:counts(0,0,0),recovery_query:counts(8,7,1)}} as any,result=aggregateNativeReadAudits([present,foreign]);assert.equal(result.audit_status,'incomplete');assert.equal(result.audit_files,1);assert.deepEqual(result.recovery_query,counts(null,null,null));assert.deepEqual(result.known_lower_bound.recovery_query,counts(0,0,0));assert.equal(result.recovery_violation,false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
