import { loadConfiguration } from '../../apps/service/src/bootstrap/config.ts';
import { startCollectionSetup } from './collection-setup.ts';
const config=loadConfiguration();if(config.mode!=='real')throw new Error('专属 Key 填写须指向 real 工作区');
const setup=await startCollectionSetup(config.paths.state_root,Number(process.env.WORKBENCH_SETUP_PORT??'5194'),{onlyKind:'ark_agent_plan'});
console.log(JSON.stringify({event:'ark_agent_plan_setup_ready',url:setup.url,storage:'local_private_file',provider_calls:0}));
const stop=()=>{void setup.close();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
