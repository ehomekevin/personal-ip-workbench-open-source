import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {CONTRACT_VERSION,type ServiceConfiguration} from '../../packages/contracts/src/index.ts';
import {openWorkspaceStorage} from '../../packages/storage/src/connection/index.ts';
import {ResultCommit} from '../../packages/domain/src/result-commit/index.ts';
const config=JSON.parse(readFileSync(process.argv[2]!,'utf8')) as ServiceConfiguration,storage=openWorkspaceStorage(join(config.paths.state_root,'workbench.sqlite'));
try{const context={db:storage.db,identity:{workspace_id:config.workspace_id,service_instance_id:config.service_instance_id,contract_version:CONTRACT_VERSION},config,paths:config.paths,getExecutorHealth:async()=>[]};process.stdout.write(JSON.stringify({pid:process.pid,result:new ResultCommit(context).recover()})+'\n');}finally{storage.close();}
