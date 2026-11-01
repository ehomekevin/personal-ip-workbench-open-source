import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DurableWorker } from '../../apps/service/src/worker/core/index.ts';
import { createServiceAgentHandlers } from '../../apps/service/src/worker/handlers/agent/index.ts';
const scenario=JSON.parse(readFileSync(process.argv[2],'utf8')),db=new DatabaseSync(scenario.database,{timeout:5000});db.exec('PRAGMA foreign_keys=ON');
const context={db,config:scenario.config,identity:scenario.identity,paths:scenario.config.paths,getExecutorHealth:async()=>[]};
const adapter={async describe(){return[];},async checkReadiness(){throw Error('unused');},async start(){throw Error('must resume');},async resume(){writeFileSync(scenario.observation,'resume_may_submit');process.kill(process.pid,'SIGKILL');await new Promise(()=>{});},async *streamEvents(){},async cancel(){return{};},async requestInput(){},async close(){}};
await new DurableWorker(context,createServiceAgentHandlers(context,{staging_root:scenario.staging,createAdapter:()=>adapter})).runOnce();
