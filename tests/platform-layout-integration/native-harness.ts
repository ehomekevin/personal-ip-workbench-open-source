import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,cpSync,chmodSync} from 'node:fs';
import {join,basename} from 'node:path';
import {project,schemaDirectory,executable} from '../platform-original-recovery/native-harness.ts';
export {fixedInput,originalHandle,threadResponse} from '../platform-original-recovery/native-harness.ts';

// 集成测试仅在本任务命名空间落盘；旧harness保持父候选原字节。
export function nativeFixture(){
 const base=join(project,'runtime/platform-layout-integration-r1/native');mkdirSync(base,{recursive:true});
 const root=mkdtempSync(join(base,'case-'));mkdirSync(join(root,'locks'));
 const settings=join(root,'settings.json'),trace=join(root,'wire.jsonl');writeFileSync(settings,'{}',{mode:0o600});
 process.env.WB_RECOVERY_FIXTURE=settings;process.env.WB_RECOVERY_TRACE=trace;
 return {root,settings,trace,options:{workspace_id:randomUUID(),cwd:root,lock_root:join(root,'locks'),schema_directory:schemaDirectory,executable,timeout_ms:1000},set(value:unknown){writeFileSync(settings,JSON.stringify(value),{mode:0o600});},calls(){try{return readFileSync(trace,'utf8').trim().split('\n').map(l=>JSON.parse(l));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}},cleanup(){
  const evidence=process.env.PLATFORM_LAYOUT_INTEGRATION_EVIDENCE;
  if(evidence){
   const archive=join(evidence,'native','control-cases',basename(root));mkdirSync(archive,{recursive:true});
   for(const name of ['settings.json','wire.jsonl','close-failed-stream-observation.json']){try{cpSync(join(root,name),join(archive,name));chmodSync(join(archive,name),0o600);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  }
  delete process.env.WB_RECOVERY_FIXTURE;delete process.env.WB_RECOVERY_TRACE;rmSync(root,{recursive:true,force:true});
 }};
}
